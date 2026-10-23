import { createHash, randomUUID } from 'node:crypto';
import type * as vscode from 'vscode';

interface StoredSession { id: string; chain: string[] }
const STORAGE_KEY = 'opencode.conversation-identities';
const MAX_SESSIONS = 50;

function continuation(a: readonly string[], b: readonly string[]): boolean {
  return a.slice(0, Math.min(a.length, b.length)).every((value, i) => value === b[i]);
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
    const chain = messages.filter((message) => {
      const role: number = message.role;
      return role === 1 || role === 2;
    }).map((message) => {
      const content = message.content.filter((part) => {
        return !part || typeof part !== 'object' || part.constructor.name !== 'LanguageModelThinkingPart';
      });
      return createHash('sha256').update(JSON.stringify([message.role, content])).digest('hex');
    });
    if (!chain.length) throw new Error('Cannot identify a conversation with no user or assistant messages.');

    // Identical histories cannot be distinguished until they diverge on hosts without a conversation ID.
    const reverseIndex = [...this.sessions].reverse().findIndex((session) => continuation(session.chain, chain));
    const index = reverseIndex < 0 ? -1 : this.sessions.length - 1 - reverseIndex;
    const session = index < 0 ? { id: randomUUID(), chain } : this.sessions.splice(index, 1)[0];
    if (chain.length > session.chain.length) session.chain = chain;
    this.sessions.push(session);
    if (this.sessions.length > MAX_SESSIONS) this.sessions.shift();
    await this.storage?.update(STORAGE_KEY, this.sessions);
    return session.id;
  }
}
