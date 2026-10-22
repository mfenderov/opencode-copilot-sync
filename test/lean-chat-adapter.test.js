import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as vscode from 'vscode';

const messages = (text) => [{ role: vscode.LanguageModelChatMessageRole.User, content: [new vscode.LanguageModelTextPart(text)] }];
const token = () => ({ isCancellationRequested: false, onCancellationRequested: new vscode.EventEmitter().event });

function sendResponses(res, model, text = 'Hello from upstream') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  emit({ type: 'response.created', response: { id: 'resp_test', created_at: 1, model } });
  emit({ type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_test', role: 'assistant', content: [] } });
  emit({ type: 'response.output_text.delta', item_id: 'msg_test', output_index: 0, content_index: 0, delta: text });
  emit({ type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_test', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] } });
  emit({ type: 'response.completed', response: { id: 'resp_test', status: 'completed', usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } });
  res.end();
}

async function setup(t, handler) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let data = '';
    for await (const chunk of req) data += chunk;
    const request = { headers: req.headers, body: JSON.parse(data), path: req.url };
    requests.push(request);
    handler(request, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const { OpenCodeChatAdapter } = await import('../out/infrastructure/vscode/open-code-chat-adapter.js');
  const provider = new OpenCodeChatAdapter({ secrets: { get: async () => 'sk-local-test' } });
  const model = {
    id: 'new-model-with-no-known-prefix', name: 'New model', family: 'new-model-with-no-known-prefix',
    apiType: 'responses', url: `http://127.0.0.1:${server.address().port}/v1`,
    maxInputTokens: 112000, maxOutputTokens: 16000, contextWindow: 128000,
    vision: false, thinking: false, toolCalling: true,
  };
  provider.updateModels([model]);
  const run = async (session, text = 'hello', extra = {}) => {
    const parts = [];
    await provider.provideLanguageModelChatResponse(model, messages(text), {
      modelOptions: { _conversationId: session }, toolMode: vscode.LanguageModelChatToolMode.Auto, ...extra,
    }, { report: (part) => parts.push(part) }, token());
    return parts;
  };
  return { provider, model, requests, run, sendResponses };
}

test('host conversation ID reaches Go unchanged and is stable across turns, retries and adapter restarts', async (t) => {
  const { run, requests, model } = await setup(t, (req, res) => sendResponses(res, req.body.model));
  await run('conversation-a', 'first turn');
  await run('conversation-a', 'follow-up turn');
  await run('conversation-b', 'separate conversation');
  await run('conversation-a', 'replayed request');
  assert.deepEqual(requests.map((req) => req.headers['x-opencode-session']), ['conversation-a', 'conversation-a', 'conversation-b', 'conversation-a']);
  assert.ok(requests.every((req) => req.path === '/v1/responses'));
  assert.ok(requests.every((req) => req.headers['x-opencode-client'] === undefined));
  assert.equal(requests[0].body.model, 'new-model-with-no-known-prefix');
  assert.equal(requests[0].body.store, false);
  const { OpenCodeChatAdapter } = await import('../out/infrastructure/vscode/open-code-chat-adapter.js');
  const restored = new OpenCodeChatAdapter({ secrets: { get: async () => 'sk-local-test' } });
  restored.updateModels([model]);
  await restored.provideLanguageModelChatResponse(model, messages('after reload'), {
    modelOptions: { _conversationId: 'conversation-a' }, toolMode: vscode.LanguageModelChatToolMode.Auto,
  }, { report() {} }, token());
  assert.equal(requests.at(-1).headers['x-opencode-session'], 'conversation-a');
});

test('stable VS Code reuses a history-based ID and separates divergent conversations', async (t) => {
  const { provider, model, requests } = await setup(t, (req, res) => sendResponses(res, req.body.model));
  const send = (history) => provider.provideLanguageModelChatResponse(model, history, {
    toolMode: vscode.LanguageModelChatToolMode.Auto,
  }, { report() {} }, token());
  const opener = messages('shared opening');
  await send(opener);
  const branchA = [...opener, { role: 2, content: [new vscode.LanguageModelTextPart('answer A')] }, ...messages('follow-up A')];
  await send(branchA);
  await send(branchA);
  const branchB = [...opener, { role: 2, content: [new vscode.LanguageModelTextPart('answer B')] }, ...messages('follow-up B')];
  await send(branchB);
  await send([...branchB, { role: 2, content: [new vscode.LanguageModelTextPart('answer B2')] }, ...messages('continue B')]);
  await send(messages('unrelated opening'));
  const ids = requests.map((req) => req.headers['x-opencode-session']);
  ids.forEach((id) => assert.match(id, /^[0-9a-f-]{36}$/));
  assert.equal(ids[0], ids[1]);
  assert.equal(ids[1], ids[2]);
  assert.notEqual(ids[2], ids[3]);
  assert.equal(ids[3], ids[4]);
  assert.notEqual(ids[4], ids[5]);
});

test('fallback ID survives adapter recreation without persisting message text', async (t) => {
  const { OpenCodeChatAdapter } = await import('../out/infrastructure/vscode/open-code-chat-adapter.js');
  const { model, requests } = await setup(t, (req, res) => sendResponses(res, req.body.model));
  const values = new Map();
  const context = {
    secrets: { get: async () => 'sk-local-test' },
    globalState: { get: (key, fallback) => values.get(key) ?? fallback, update: async (key, value) => { values.set(key, value); } },
  };
  for (let i = 0; i < 2; i++) {
    const provider = new OpenCodeChatAdapter(context);
    provider.updateModels([model]);
    await provider.provideLanguageModelChatResponse(model, messages('private-message-that-must-not-be-stored'), {
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    }, { report() {} }, token());
  }
  assert.equal(requests[0].headers['x-opencode-session'], requests[1].headers['x-opencode-session']);
  assert.doesNotMatch(JSON.stringify([...values]), /private-message-that-must-not-be-stored/);
});

test('system instructions changing do not reset fallback conversation identity', async (t) => {
  const { provider, model, requests } = await setup(t, (req, res) => sendResponses(res, req.body.model));
  for (const text of ['system at time one', 'system at time two']) {
    await provider.provideLanguageModelChatResponse(model, [{ role: 0, content: [new vscode.LanguageModelTextPart(text)] }, ...messages('same chat')], {
      toolMode: vscode.LanguageModelChatToolMode.Auto,
    }, { report() {} }, token());
  }
  assert.equal(requests[0].headers['x-opencode-session'], requests[1].headers['x-opencode-session']);
});

test('SDK streamed text is forwarded once without waiting for another request', async (t) => {
  const { run, requests } = await setup(t, (req, res) => sendResponses(res, req.body.model));
  const parts = await run('text-session');
  assert.equal(parts.filter((part) => part instanceof vscode.LanguageModelTextPart).map((part) => part.value).join(''), 'Hello from upstream');
  assert.equal(requests.length, 1);
});

test('reasoning metadata and selected effort reach upstream for arbitrary Responses model IDs', async (t) => {
  const { provider, model, requests, run } = await setup(t, (req, res) => sendResponses(res, req.body.model));
  provider.updateModels([{ ...model, thinking: true, supportsReasoningEffort: ['low', 'high'] }]);
  await run('reasoning-session', 'think', { modelConfiguration: { reasoningEffort: 'high' } });
  assert.deepEqual(requests[0].body.reasoning, { effort: 'high' });
  const info = provider.provideLanguageModelChatInformation()[0];
  assert.deepEqual(info.configurationSchema.properties.reasoningEffort.enum, ['low', 'high']);
});

test('HTTP errors are surfaced without provider retries', async (t) => {
  const { run, requests } = await setup(t, (_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'upstream temporarily overloaded' } }));
  });
  await assert.rejects(run('error-session'), /overloaded/);
  assert.equal(requests.length, 1);
});

test('oversized enum values are removed from SDK tool schemas before sending', async (t) => {
  const { run, requests } = await setup(t, (req, res) => sendResponses(res, req.body.model));
  const oversized = Array.from({ length: 251 }, (_, index) => `model-${index}`);
  const oversizedByLength = Array.from({ length: 100 }, () => 'x'.repeat(130));
  const retained = ['small-a', 'small-b'];
  await run('schema-session', 'choose a model', {
    tools: [{
      name: 'select_model',
      description: 'Select a model',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', enum: oversized },
          options: {
            type: 'object',
            properties: { route: { enum: oversizedByLength } },
          },
          mode: { type: 'string', enum: retained },
        },
      },
    }],
  });

  const schema = requests[0].body.tools[0].parameters;
  assert.equal(schema.properties.model.enum, undefined);
  assert.equal(schema.properties.model.type, 'string');
  assert.equal(schema.properties.options.properties.route.enum, undefined);
  assert.equal(schema.properties.options.properties.route.type, 'string');
  assert.deepEqual(schema.properties.mode.enum, retained);
});

test('Responses tool calls are forwarded once and the next turn preserves their results', async (t) => {
  const { run, requests, provider, model } = await setup(t, (req, res) => {
    if (requests.length > 1) return sendResponses(res, req.body.model, 'The answer is 4');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    const item = { type: 'function_call', id: 'fc_test', call_id: 'call_test', name: 'calculator', arguments: '{"value":4}', status: 'completed' };
    emit({ type: 'response.created', response: { id: 'resp_tool', created_at: 1, model: req.body.model } });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } });
    emit({ type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc_test', delta: '{"value":4}' });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { id: 'resp_tool', status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } });
    res.end();
  });
  const parts = await run('tool-session', 'calculate', {
    tools: [{ name: 'calculator', description: 'calculate', inputSchema: { type: 'object', properties: { value: { type: 'number' } } } }],
    toolMode: vscode.LanguageModelChatToolMode.Required,
  });
  const calls = parts.filter((part) => part instanceof vscode.LanguageModelToolCallPart);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].callId, 'call_test');
  assert.deepEqual(calls[0].input, { value: 4 });
  assert.equal(requests[0].body.tool_choice, 'required');
  const output = [];
  await provider.provideLanguageModelChatResponse(model, [
    { role: 0, content: [new vscode.LanguageModelTextPart('Keep the real system role')] },
    ...messages('calculate'),
    { role: 2, content: calls },
    { role: 1, content: [new vscode.LanguageModelToolResultPart('call_test', [new vscode.LanguageModelTextPart('4')])] },
  ], { modelOptions: { _conversationId: 'tool-session' }, toolMode: 1 }, { report: (part) => output.push(part) }, token());
  assert.equal(requests[1].headers['x-opencode-session'], 'tool-session');
  assert.ok(requests[1].body.input.some((part) => part.role === 'system'));
  assert.ok(requests[1].body.input.some((part) => part.type === 'function_call_output' && part.call_id === 'call_test' && part.output === '4'));
  assert.equal(output.filter((part) => part instanceof vscode.LanguageModelTextPart).map((part) => part.value).join(''), 'The answer is 4');
});

for (const apiType of ['chat-completions', 'messages']) {
  test(`${apiType} metadata selects the SDK transport without model-name guesses`, async (t) => {
    const { provider, model, requests } = await setup(t, (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (apiType === 'messages') {
        emit({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: req.body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SDK mapped text' } });
        emit({ type: 'content_block_stop', index: 0 });
        emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
        emit({ type: 'message_stop' });
      } else {
        emit({ id: 'cmpl_1', object: 'chat.completion.chunk', created: 1, model: req.body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'SDK mapped text' }, finish_reason: null }] });
        emit({ id: 'cmpl_1', object: 'chat.completion.chunk', created: 1, model: req.body.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } });
        res.write('data: [DONE]\n\n');
      }
      res.end();
    });
    provider.updateModels([{ ...model, apiType }]);
    const parts = [];
    await provider.provideLanguageModelChatResponse(model, messages('hi'), { modelOptions: { _conversationId: 'protocol-session' }, toolMode: 1 }, { report: (part) => parts.push(part) }, token());
    assert.equal(requests[0].path, apiType === 'messages' ? '/v1/messages' : '/v1/chat/completions');
    assert.equal(requests[0].headers['x-opencode-session'], 'protocol-session');
    assert.equal(parts.filter((part) => part instanceof vscode.LanguageModelTextPart).map((part) => part.value).join(''), 'SDK mapped text');
  });
}

test('cancellation during credential lookup prevents an upstream request', async (t) => {
  const { model, requests } = await setup(t, (req, res) => sendResponses(res, req.body.model));
  const { OpenCodeChatAdapter } = await import('../out/infrastructure/vscode/open-code-chat-adapter.js');
  let releaseKey;
  let markLookupStarted;
  const key = new Promise((resolve) => { releaseKey = resolve; });
  const lookupStarted = new Promise((resolve) => { markLookupStarted = resolve; });
  const provider = new OpenCodeChatAdapter({ secrets: { get: () => { markLookupStarted(); return key; } } });
  provider.updateModels([model]);
  const emitter = new vscode.EventEmitter();
  const cancel = { isCancellationRequested: false, onCancellationRequested: emitter.event };
  const parts = [];
  t.after(() => { provider.dispose(); emitter.dispose(); });
  const pending = provider.provideLanguageModelChatResponse(model, messages('cancel before sending'), {
    modelOptions: { _conversationId: 'cancel-before-send' }, toolMode: 1,
  }, { report: (part) => parts.push(part) }, cancel);
  await lookupStarted;
  cancel.isCancellationRequested = true;
  emitter.fire();
  releaseKey('sk-local-test');
  await pending;
  assert.equal(requests.length, 0, 'a canceled request must never reach upstream');
  assert.deepEqual(parts, []);
});

test('host cancellation aborts the pending stream without replaying the request', async (t) => {
  let started;
  const requestStarted = new Promise((resolve) => { started = resolve; });
  const { provider, model, requests } = await setup(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    started();
  });
  const emitter = new vscode.EventEmitter();
  const cancel = { isCancellationRequested: false, onCancellationRequested: emitter.event };
  const promise = provider.provideLanguageModelChatResponse(model, messages('hi'), {
    modelOptions: { _conversationId: 'cancel-session' }, toolMode: 1,
  }, { report() {} }, cancel);
  const settled = promise.then(() => 'resolved', (error) => { assert.match(error.name, /Abort/); return 'aborted'; });
  await requestStarted;
  cancel.isCancellationRequested = true;
  emitter.fire();
  await settled;
  assert.equal(requests.length, 1);
});
