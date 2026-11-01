import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { toSDKPrompt } from '../out/infrastructure/vscode/open-code-chat-adapter.js';

function toolOutput(content) {
  const prompt = toSDKPrompt([
    { role: vscode.LanguageModelChatMessageRole.Assistant, content: [
      new vscode.LanguageModelToolCallPart('call-1', 'lookup', {}),
    ] },
    { role: vscode.LanguageModelChatMessageRole.User, content: [
      new vscode.LanguageModelToolResultPart('call-1', content),
    ] },
  ]);
  return prompt.find((message) => message.role === 'tool').content[0].output;
}

test('tool results omit actual cache-control data parts but retain real text and JSON data', () => {
  const result = toolOutput([
    new vscode.LanguageModelTextPart('visible'),
    vscode.LanguageModelDataPart.json({ type: 'ephemeral' }, 'cache_control'),
    vscode.LanguageModelDataPart.json({ answer: 42 }),
  ]);
  assert.deepEqual(result, { type: 'text', value: 'visible\n{"answer":42}' });
});

test('tool results omit marshalled VS Code cache-control markers', () => {
  let result;
  assert.doesNotThrow(() => {
    result = toolOutput([
      { $mid: 24, mimeType: 'cache_control', data: 'ZXBoZW1lcmFs' },
      new vscode.LanguageModelTextPart('visible'),
    ]);
  });
  assert.deepEqual(result, { type: 'text', value: 'visible' });
});

test('tool results decode marshalled text and JSON data parts', () => {
  let result;
  assert.doesNotThrow(() => {
    result = toolOutput([
      { $mid: 24, mimeType: 'text/plain', data: 'aGVsbG8=' },
      { $mid: 24, mimeType: 'application/json', data: 'eyJhbnN3ZXIiOjQyfQ==' },
    ]);
  });
  assert.deepEqual(result, { type: 'text', value: 'hello\n{"answer":42}' });
});

test('tool results preserve image and PDF data for native SDK providers', () => {
  const result = toolOutput([
    new vscode.LanguageModelTextPart('read'),
    new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
    new vscode.LanguageModelDataPart(new Uint8Array([4, 5, 6]), 'application/pdf'),
  ]);
  assert.deepEqual(result, {
    type: 'content',
    value: [
      { type: 'text', text: 'read' },
      { type: 'image-data', mediaType: 'image/png', data: 'AQID' },
      { type: 'file-data', mediaType: 'application/pdf', data: 'BAUG' },
    ],
  });
});

test('tool results pass other binary media to the SDK instead of guessing provider support', () => {
  let result;
  assert.doesNotThrow(() => {
    result = toolOutput([new vscode.LanguageModelDataPart(new Uint8Array([1, 2]), 'audio/wav')]);
  });
  assert.deepEqual(result, {
    type: 'content', value: [{ type: 'file-data', mediaType: 'audio/wav', data: 'AQI=' }],
  });
});

test('ordinary objects named cache_control remain tool output', () => {
  const value = { mimeType: 'cache_control', data: { userValue: 'keep' } };
  let result;
  assert.doesNotThrow(() => { result = toolOutput([value]); });
  assert.deepEqual(result, { type: 'text', value: '{"mimeType":"cache_control","data":{"userValue":"keep"}}' });
});

test('tool results preserve Prompt TSX content instead of rejecting the request', () => {
  const part = new vscode.LanguageModelPromptTsxPart({ type: 'text', value: 'rendered content' });
  let result;
  assert.doesNotThrow(() => { result = toolOutput([part]); });
  assert.match(result.value, /rendered content/);
});

test('parallel tool results merge into one tool message for strict native providers', () => {
  const prompt = toSDKPrompt([
    { role: vscode.LanguageModelChatMessageRole.Assistant, content: [
      new vscode.LanguageModelToolCallPart('call-1', 'lookup', { key: 'x' }),
      new vscode.LanguageModelToolCallPart('call-2', 'lookup', { key: 'y' }),
    ] },
    { role: vscode.LanguageModelChatMessageRole.User, content: [
      new vscode.LanguageModelToolResultPart('call-1', [new vscode.LanguageModelTextPart('first')]),
      new vscode.LanguageModelToolResultPart('call-2', [new vscode.LanguageModelTextPart('second')]),
    ] },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(prompt)), [
    { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: { key: 'x' } },
      { type: 'tool-call', toolCallId: 'call-2', toolName: 'lookup', input: { key: 'y' } },
    ] },
    { role: 'tool', content: [
      { type: 'tool-result', toolCallId: 'call-1', toolName: 'lookup', output: { type: 'text', value: 'first' } },
      { type: 'tool-result', toolCallId: 'call-2', toolName: 'lookup', output: { type: 'text', value: 'second' } },
    ] },
  ]);
});

test('user messages preserve text, JSON, images and PDFs through the SDK prompt', () => {
  let prompt;
  assert.doesNotThrow(() => {
    prompt = toSDKPrompt([{
      role: vscode.LanguageModelChatMessageRole.User,
      content: [
        new vscode.LanguageModelDataPart(new TextEncoder().encode('hello'), 'text/plain'),
        vscode.LanguageModelDataPart.json({ answer: 42 }),
        new vscode.LanguageModelDataPart(new Uint8Array([1, 2, 3]), 'image/png'),
        new vscode.LanguageModelDataPart(new Uint8Array([4, 5, 6]), 'application/pdf'),
      ],
    }]);
  });
  assert.deepEqual(prompt, [{
    role: 'user',
    content: [
      { type: 'text', text: 'hello' },
      { type: 'text', text: '{"answer":42}' },
      { type: 'file', data: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
      { type: 'file', data: new Uint8Array([4, 5, 6]), mediaType: 'application/pdf' },
    ],
  }]);
});

test('assistant usage and cache-control data parts are not replayed as message content', () => {
  let prompt;
  assert.doesNotThrow(() => {
    prompt = toSDKPrompt([{
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelTextPart('visible'),
        vscode.LanguageModelDataPart.json({ input_tokens: 10 }, 'usage'),
        vscode.LanguageModelDataPart.json({ type: 'ephemeral' }, 'cache_control'),
      ],
    }]);
  });
  assert.deepEqual(prompt, [{ role: 'assistant', content: [{ type: 'text', text: 'visible' }] }]);
});
