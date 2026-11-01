import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as vscode from 'vscode';
import { OpenCodeChatAdapter } from '../out/infrastructure/vscode/open-code-chat-adapter.js';

const tool = { name: 'lookup', description: 'Read an item', inputSchema: { type: 'object', properties: {} } };
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const user = (value) => ({ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart(value)] });

function googleStreams() {
  return [
    [{ candidates: [{ content: { role: 'model', parts: [
      { functionCall: { name: 'lookup', args: { key: 'x' } }, thoughtSignature: 'google-signature' },
      { functionCall: { name: 'lookup', args: { key: 'y' } } },
      { inlineData: { mimeType: 'image/png', data: 'AQID' }, thoughtSignature: 'image-signature' },
    ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }],
    [{ candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }],
  ];
}

function anthropicStreams() {
  return [
    [
      { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'replay-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Check both.' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'anthropic-signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"key":"x"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-2', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"key":"y"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ],
    [
      { type: 'message_start', message: { id: 'msg-2', type: 'message', role: 'assistant', model: 'replay-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ],
  ];
}

async function setup(t, apiType, streamOverride) {
  const streams = streamOverride ?? (apiType === 'google' ? googleStreams() : anthropicStreams());
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const events = streams.shift();
    assert.ok(events, 'unexpected upstream request');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const model = {
    id: 'replay-model', name: 'Replay model', family: 'replay-model', catalog: 'zen',
    providerPackage: apiType === 'google' ? '@ai-sdk/google' : '@ai-sdk/anthropic',
    apiType, url: `http://127.0.0.1:${server.address().port}/v1`,
    contextWindow: 100000, maxInputTokens: 90000, maxOutputTokens: 10000,
    vision: true, thinking: true, toolCalling: true,
  };
  const makeProvider = () => {
    const provider = new OpenCodeChatAdapter({ secrets: { get: async () => 'sk-local-test' } });
    provider.updateModels([model]);
    return provider;
  };
  const send = async (provider, messages) => {
    const parts = [];
    await provider.provideLanguageModelChatResponse(model, messages, {
      tools: [tool], modelOptions: { _conversationId: 'native-replay-session' },
    }, { report: (part) => parts.push(part) }, token);
    return parts;
  };
  return { requests, makeProvider, send };
}

for (const [apiType, events] of [
  ['google', [{ candidates: [{ content: { role: 'model', parts: [
    { functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'signature' },
  ] } }] }]],
  ['messages', [
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'replay-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} } },
    { type: 'content_block_stop', index: 0 },
  ]],
]) {
  test(`${apiType} incomplete streams never execute tool calls`, async (t) => {
    const { makeProvider, send } = await setup(t, apiType, [events]);
    const parts = await send(makeProvider(), [user('Find something')]);
    assert.equal(parts.filter((part) => part instanceof vscode.LanguageModelToolCallPart).length, 0);
    assert.match(parts.map((part) => part.value ?? '').join(''), /incomplete|interrupted/i);
  });
}

for (const apiType of ['google', 'messages']) {
  test(`${apiType} signed parallel tool calls survive provider recreation`, async (t) => {
    const { requests, makeProvider, send } = await setup(t, apiType);
    const first = await send(makeProvider(), [user('Find both')]);
    const calls = first.filter((part) => part instanceof vscode.LanguageModelToolCallPart);
    assert.equal(calls.length, 2);
    const replay = first.filter((part) => part.metadata?.opencodeNativeReplay).at(-1);
    assert.ok(replay, 'a replay marker must preserve provider signatures');
    const assistant = first.filter((part) => !part.metadata?.opencodeNativeReplay || part === replay);
    await send(makeProvider(), [
      user('Find both'),
      { role: vscode.LanguageModelChatMessageRole.Assistant, content: assistant },
      { role: vscode.LanguageModelChatMessageRole.User, content: calls.map((call) =>
        new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart('result')])) },
    ]);
    if (apiType === 'google') {
      const parts = requests[1].contents[1].parts;
      assert.equal(parts.find((part) => part.functionCall?.name === 'lookup')?.thoughtSignature, 'google-signature');
      const image = parts.find((part) => part.inlineData?.mimeType === 'image/png');
      assert.equal(image?.thoughtSignature, 'image-signature');
    } else {
      assert.equal(requests[1].messages[1].content[0].signature, 'anthropic-signature');
      assert.equal(requests[1].messages[1].content[0].thinking, 'Check both.');
    }
  });
}

test('native replay rejects modified tool arguments before sending another request', async (t) => {
  const { requests, makeProvider, send } = await setup(t, 'google');
  const first = await send(makeProvider(), [user('Find both')]);
  const calls = first.filter((part) => part instanceof vscode.LanguageModelToolCallPart);
  const replay = first.find((part) => part.metadata?.opencodeNativeReplay);
  assert.ok(replay);
  const modified = [
    new vscode.LanguageModelToolCallPart(calls[0].callId, calls[0].name, { key: 'changed' }),
    calls[1],
    replay,
  ];
  await assert.rejects(send(makeProvider(), [
    user('Find both'),
    { role: vscode.LanguageModelChatMessageRole.Assistant, content: modified },
    { role: vscode.LanguageModelChatMessageRole.User, content: calls.map((call) =>
      new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart('result')])) },
  ]), /assistant message was changed/i);
  assert.equal(requests.length, 1);
});

test('Google preserves a text signature when a response also contains a tool call', async (t) => {
  const streams = [
    [{ candidates: [{ content: { role: 'model', parts: [
      { functionCall: { name: 'lookup', args: {} } },
      { text: 'Checking.', thoughtSignature: 'text-signature' },
    ] }, finishReason: 'STOP' }] }],
    [{ candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }],
  ];
  const { requests, makeProvider, send } = await setup(t, 'google', streams);
  const first = await send(makeProvider(), [user('Find it')]);
  const call = first.find((part) => part instanceof vscode.LanguageModelToolCallPart);
  assert.ok(call);
  await send(makeProvider(), [
    user('Find it'),
    { role: vscode.LanguageModelChatMessageRole.Assistant, content: first },
    { role: vscode.LanguageModelChatMessageRole.User, content: [
      new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart('result')]),
    ] },
  ]);
  const replayed = requests[1].contents[1].parts;
  assert.equal(replayed.find((part) => part.text === 'Checking.').thoughtSignature, 'text-signature');
  assert.ok(replayed.some((part) => part.functionCall?.name === 'lookup'));
});

test('Google generated images reach VS Code as data parts', async (t) => {
  const streams = [[{ candidates: [{ content: { role: 'model', parts: [
    { inlineData: { mimeType: 'image/png', data: 'AQID' } },
  ] }, finishReason: 'STOP' }] }]];
  const { makeProvider, send } = await setup(t, 'google', streams);
  const parts = await send(makeProvider(), [user('Generate an image')]);
  const image = parts.find((part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === 'image/png');
  assert.ok(image);
  assert.deepEqual([...image.data], [1, 2, 3]);
});
