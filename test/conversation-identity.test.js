import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { ConversationIdentity } from '../out/infrastructure/vscode/conversation-identity.js';

function message(role, text) {
  return { role, content: [new vscode.LanguageModelTextPart(text)] };
}

test('regenerating a shared prefix starts a stable independent conversation', async () => {
  const identity = new ConversationIdentity();
  const user = (text) => message(vscode.LanguageModelChatMessageRole.User, text);
  const assistant = (text) => message(vscode.LanguageModelChatMessageRole.Assistant, text);
  const root = [user('same opener')];
  const branchA = [...root, assistant('answer A'), user('follow-up A')];
  const branchB = [...root, assistant('answer B'), user('follow-up B')];
  const branchC = [...root, assistant('answer C'), user('follow-up C')];

  const first = await identity.resolve(root);
  assert.equal(await identity.resolve(branchA), first);
  const second = await identity.resolve(branchB);
  assert.notEqual(second, first);
  const regenerated = await identity.resolve(root);
  assert.notEqual(regenerated, first);
  assert.notEqual(regenerated, second);
  assert.equal(await identity.resolve(branchA), first);
  assert.equal(await identity.resolve(branchC), regenerated);
  assert.equal(await identity.resolve(branchA), first);
});
