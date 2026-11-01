const assert = require('node:assert/strict');
const vscode = require('vscode');

async function selectModel(id) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const model = (await vscode.lm.selectChatModels({ vendor: 'opencode' })).find((item) => item.id === id);
    if (model) return model;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Native test model ${id} was not registered.`);
}

function googleStreams() {
  return [
    [{ candidates: [{ content: { role: 'model', parts: [
      { functionCall: { name: 'lookup', args: { key: 'x' } }, thoughtSignature: 'google-signature' },
      { functionCall: { name: 'lookup', args: { key: 'y' } } },
    ] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }],
    [{ candidates: [{ content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }],
  ];
}

function anthropicStreams() {
  return [
    [
      { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
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
      { type: 'message_start', message: { id: 'm2', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ],
  ];
}

async function verifyProtocol(provider, apiType, token) {
  const google = apiType === 'google';
  const model = {
    id: google ? 'gemini-3.8-flash' : 'claude-sonnet-5',
    name: 'Native host test', family: 'native-host-test', catalog: 'zen',
    providerPackage: google ? '@ai-sdk/google' : '@ai-sdk/anthropic',
    apiType, url: google ? 'https://opencode.ai/inference/google/v1beta' : 'https://opencode.ai/inference/anthropic/v1',
    contextWindow: 100000, maxInputTokens: 90000, maxOutputTokens: 10000,
    vision: true, thinking: true, toolCalling: true,
  };
  const streams = google ? googleStreams() : anthropicStreams();
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname !== 'opencode.ai') return new Response('Network disabled for host test', { status: 401 });
    requests.push(JSON.parse(init.body));
    const events = streams.shift();
    assert.ok(events, 'unexpected upstream request');
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200, headers: { 'content-type': 'text/event-stream' },
    });
  };
  provider.updateModels([model]);
  const selected = await selectModel(model.id);
  const tools = [{ name: 'lookup', description: 'Read an item', inputSchema: { type: 'object', properties: {} } }];
  const initial = vscode.LanguageModelChatMessage.User('Find both');
  const response = await selected.sendRequest([initial], { tools }, token);
  const parts = [];
  for await (const part of response.stream) parts.push(part);
  const calls = parts.filter((part) => part instanceof vscode.LanguageModelToolCallPart);
  assert.equal(calls.length, 2, 'parallel tool calls must cross the VS Code host');
  const replay = parts.filter((part) => part.metadata?.opencodeNativeReplay).at(-1);
  assert.ok(replay, 'native replay metadata must cross the VS Code host');
  const assistant = parts.filter((part) => !part.metadata?.opencodeNativeReplay || part === replay);
  const result = calls.map((call, index) => new vscode.LanguageModelToolResultPart(call.callId, index === 0 ? [
    new vscode.LanguageModelTextPart('visible'),
    vscode.LanguageModelDataPart.json({ answer: 42 }),
    vscode.LanguageModelDataPart.json({ type: 'ephemeral' }, 'cache_control'),
  ] : [new vscode.LanguageModelTextPart('second')]));
  const next = await selected.sendRequest([
    initial,
    vscode.LanguageModelChatMessage.Assistant(assistant),
    vscode.LanguageModelChatMessage.User(result),
  ], { tools }, token);
  for await (const _part of next.stream) { /* drain */ }
  if (google) {
    assert.equal(requests[1].contents[1].parts[0].thoughtSignature, 'google-signature');
  } else {
    assert.equal(requests[1].messages[1].content[0].signature, 'anthropic-signature');
  }
  assert.match(JSON.stringify(requests[1]), /answer/);
  assert.doesNotMatch(JSON.stringify(requests[1]), /ephemeral|cache_control/);
  console.log(`[Registration E2E] ${apiType} signed parallel tool replay and cache-control filtering passed.`);
}

module.exports = async function verifyNativeProtocols(provider) {
  assert.ok(vscode.LanguageModelThinkingPart, 'host must support native replay metadata');
  const previous = {
    fetch: globalThis.fetch,
    noProxy: process.env.NO_PROXY,
    models: provider.provideLanguageModelChatInformation(),
  };
  const cancellation = new vscode.CancellationTokenSource();
  process.env.NO_PROXY = '*';
  try {
    await verifyProtocol(provider, 'google', cancellation.token);
    await verifyProtocol(provider, 'messages', cancellation.token);
  } finally {
    globalThis.fetch = previous.fetch;
    if (previous.noProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = previous.noProxy;
    provider.updateModels(previous.models);
    cancellation.dispose();
  }
};
