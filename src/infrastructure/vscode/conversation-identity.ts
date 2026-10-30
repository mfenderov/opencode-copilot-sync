import { createHash, randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';

interface StoredSession { id: string; chain: string[] }

function userAssistant(role: number): boolean {
  return role === 1 || role === 2;
}

function messageFingerprint(message: vscode.LanguageModelChatRequestMessage): string {
  const content = message.content.filter((part) => {
    return !part || typeof part !== 'object' || part.constructor.name !== 'LanguageModelThinkingPart';
  });
  return createHash('sha256').update(JSON.stringify([message.role, content])).digest('hex');
}

function chainFingerprint(messages: readonly vscode.LanguageModelChatRequestMessage[]): string[] {
  return messages.filter((message) => userAssistant(message.role)).map(messageFingerprint);
}

function longestContinuation(
  sessions: StoredSession[],
  chain: readonly string[]
): StoredSession | undefined {
  let best: StoredSession | undefined;
  for (let index = sessions.length - 1; index >= 0; index--) {
    const candidate = sessions[index];
    const longer = !best || candidate.chain.length > best.chain.length;
    if (continuation(candidate.chain, chain) && longer) best = candidate;
  }
  return best;
}
const STORAGE_KEY = 'opencode.conversation-identities';
const MAX_SESSIONS = 50;

function continuation(a: readonly string[], b: readonly string[]): boolean {
  return a.length <= b.length && a.every((value, i) => value === b[i]);
}

export class ConversationIdentity {
  private readonly sessions: StoredSession[];

  constructor(private readonly storage?: vscode.Memento) {
    this.sessions = storage?.get<StoredSession[]>(STORAGE_KEY, []) ?? [];
  }

  async resolve(
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    hostId: unknown
  ): Promise<string> {
    if (typeof hostId === 'string' && hostId.trim()) return hostId;
    const chain = chainFingerprint(messages);
    if (!chain.length) throw new Error('Cannot identify a conversation with no user or assistant messages.');

    const best = longestContinuation(this.sessions, chain);
    const session = best ?? { id: randomUUID(), chain };
    if (best) this.sessions.splice(this.sessions.indexOf(best), 1);
    if (chain.length > session.chain.length) session.chain = chain;
    this.sessions.push(session);
    if (this.sessions.length > MAX_SESSIONS) this.sessions.shift();
    await this.storage?.update(STORAGE_KEY, this.sessions);
    return session.id;
  }
}
