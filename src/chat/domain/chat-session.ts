// Chat domain: conversation identity (fingerprint chains, session cache).
import type * as vscode from 'vscode';
import { LanguageModelTextPart } from 'vscode';

export interface ConversationSession {
  sessionId: string;
  lastUsedAt: number;
  chain: string[];
}

/** Cheap, dependency-free string hash (djb2) used to key conversation buckets and fork entries. */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0; // hash * 33 + c
  }
  return (hash >>> 0).toString(36);
}

/**
 * Fingerprints a message's role + text content so the same opening message always
 * produces the same key, without retaining the full message text in memory.
 */
function fingerprintMessage(msg: vscode.LanguageModelChatRequestMessage | undefined): string {
  if (!msg) return 'empty';
  let text = '';
  try {
    for (const part of msg.content) {
      if (part instanceof LanguageModelTextPart) {
        text += part.value;
      } else if (part && typeof part === 'object') {
        text += JSON.stringify(part);
      }
    }
  } catch {
    // Malformed content: fall back to hashing the text collected so far.
  }
  return `${msg.role}:${djb2Hash(text)}`;
}

/**
 * Fingerprints a full turn's message history as a per-message chain so a
 * conversation's growth can be prefix-matched (see `getConversationSessionId`).
 */
function fingerprintConversation(messages: readonly vscode.LanguageModelChatRequestMessage[]): string[] {
  return messages.map((msg) => fingerprintMessage(msg));
}

/**
 * True when the incoming chain continues the cached one: the cached chain is a
 * prefix of (or equal to) the incoming chain. The conversation grew by
 * appending turns. A shared root with a different next fingerprint means a
 * distinct chat that happens to share an opener — not a continuation.
 */
function isChainContinuation(cachedChain: readonly string[], incomingChain: readonly string[]): boolean {
  if (cachedChain.length > incomingChain.length) return false;
  for (let i = 0; i < cachedChain.length; i++) {
    if (cachedChain[i] !== incomingChain[i]) return false;
  }
  return true;
}

const OPENCODE_ID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Generates an OpenCode descending identifier (12 hex chars timestamp prefix + 14 base62 chars)
 * matching OpenCode client's `Identifier.descending()` format: `^[0-9a-f]{12}[0-9A-Za-z]{14}$`.
 */
export function generateOpenCodeDescendingId(): string {
  const now = Date.now();
  const counter = Math.floor(Math.random() * 0xfff) + 1;
  const val = (~(BigInt(now) * 4096n + BigInt(counter))) & 0xffffffffffffn;
  const hexPrefix = val.toString(16).padStart(12, '0');
  let randSuffix = '';
  for (let i = 0; i < 14; i++) {
    randSuffix += OPENCODE_ID_ALPHABET[Math.floor(Math.random() * OPENCODE_ID_ALPHABET.length)];
  }
  return `${hexPrefix}${randSuffix}`;
}

export function generateOpenCodeSessionId(): string {
  return `ses_${generateOpenCodeDescendingId()}`;
}

export function generateOpenCodeRequestId(): string {
  return `msg_${generateOpenCodeDescendingId()}`;
}

/**
 * Bounded conversation cache that maps Copilot's full-history message arrays to
 * stable OpenCode session ids. Copilot resends full conversation history each turn,
 * so a conversation's first message stays constant across its turns. Conversations
 * are bucketed by a fingerprint of that first message, since VS Code's chat
 * provider API exposes no native conversation/session id.
 *
 * Same-opener chats fork on divergence: entries track the longest fingerprint chain
 * seen so far, and a new chain that extends a different branch of the same root
 * gets its own session instead of bleeding into the first chat's upstream context.
 */
export class ChatSessionCache {
  private readonly sessions = new Map<string, ConversationSession>();
  static readonly MAX_SIZE = 50;
  static readonly TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

  private get(key: string): ConversationSession | undefined {
    const entry = this.sessions.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.lastUsedAt >= ChatSessionCache.TTL_MS) {
      this.sessions.delete(key);
      return undefined;
    }
    return entry;
  }

  private set(key: string, value: ConversationSession, now: number): void {
    this.evictStaleSessions(now);
    this.evictSessionIfFull();
    this.sessions.set(key, value);
  }

  /**
   * Returns a stable x-opencode-session id for this conversation, reused across all
   * turns so OpenCode's routing/prompt caching sees one session instead of a fresh
   * one per request. Conversations are bucketed by the fingerprint of their first
   * message and continued by full-chain prefix match (see `fingerprintConversation`),
   * since VS Code's API exposes no session id.
   *
   * Same-opener chats fork on divergence: when the incoming fingerprint chain
   * extends the cached chain it is a continuation; when it shares only the root
   * (or a shorter common prefix) with a different next fingerprint it is a
   * distinct chat that happens to share an opener, and it gets its own session.
   */
  getConversationSessionId(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
    const chain = fingerprintConversation(messages);
    const rootKey = chain[0] ?? 'empty';
    const now = Date.now();

    const cached = this.get(rootKey);
    if (cached) {
      if (isChainContinuation(cached.chain, chain)) {
        return ChatSessionCache.trackContinuation(cached, chain, now);
      }
      // Same opener, diverged history: look for an existing fork whose chain
      // this request continues; otherwise mint a new forked session.
      const forkedSessionId = this.findContinuingFork(rootKey, chain, now);
      if (forkedSessionId !== undefined) {
        return forkedSessionId;
      }
      const sessionId = generateOpenCodeSessionId();
      this.set(`${rootKey}::${djb2Hash(chain.join('|'))}`, { sessionId, lastUsedAt: now, chain }, now);
      return sessionId;
    }

    const sessionId = generateOpenCodeSessionId();
    this.set(rootKey, { sessionId, lastUsedAt: now, chain }, now);
    return sessionId;
  }

  /**
   * Records a continued conversation: extends the cached chain and refreshes
   * last use. Returns the reused session id.
   */
  private static trackContinuation(entry: ConversationSession, chain: string[], now: number): string {
    entry.lastUsedAt = now;
    entry.chain = chain;
    return entry.sessionId;
  }

  /**
   * Finds the forked session under `rootKey` with the longest fingerprint chain
   * that the incoming chain continues. Expired forks are deleted on sight.
   * Returns its session id, or undefined when no fork matches (caller mints
   * a new forked session).
   */
  private findContinuingFork(rootKey: string, chain: string[], now: number): string | undefined {
    const prefix = `${rootKey}::`;
    let best: ConversationSession | undefined;
    for (const [forkKey, fork] of this.sessions) {
      if (!forkKey.startsWith(prefix)) {
        continue;
      }
      if (now - fork.lastUsedAt >= ChatSessionCache.TTL_MS) {
        this.sessions.delete(forkKey);
        continue;
      }
      if (isChainContinuation(fork.chain, chain) && (best === undefined || fork.chain.length > best.chain.length)) {
        best = fork;
      }
    }
    if (best === undefined) {
      return undefined;
    }
    return ChatSessionCache.trackContinuation(best, chain, now);
  }

  private evictStaleSessions(now: number): void {
    // Drops entries older than the session TTL.
    for (const [k, v] of this.sessions) {
      if (now - v.lastUsedAt >= ChatSessionCache.TTL_MS) {
        this.sessions.delete(k);
      }
    }
  }

  private evictSessionIfFull(): void {
    if (this.sessions.size >= ChatSessionCache.MAX_SIZE) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [k, v] of this.sessions) {
        if (v.lastUsedAt < oldestAt) {
          oldestAt = v.lastUsedAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) {
        this.sessions.delete(oldestKey);
      }
    }
  }
}
