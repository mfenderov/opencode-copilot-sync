import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as vscode from 'vscode';
import { OpenCodeChatAdapter } from '../out/infrastructure/vscode/open-code-chat-adapter.js';

async function setup(t, overrides) {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url.includes(':streamGenerateContent')) {
      res.end(`data: ${JSON.stringify({
        candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      })}\n\n`);
      return;
    }
    if (req.url.endsWith('/messages')) {
      res.end([
        { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', model: 'new-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    if (req.url.endsWith('/responses')) {
      res.end([
        { type: 'response.created', response: { id: 'resp-1', created_at: 1, model: 'new-model' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg-1', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', item_id: 'msg-1', output_index: 0, content_index: 0, delta: 'hello' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg-1', role: 'assistant', content: [{ type: 'output_text', text: 'hello', annotations: [] }] } },
        { type: 'response.completed', response: { id: 'resp-1', status: 'completed', usage: { input_tokens: 1, output_tokens: 1 } } },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
      return;
    }
    res.end([
      `data: ${JSON.stringify({ id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'new-model', choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: 'chat-1', object: 'chat.completion.chunk', created: 1, model: 'new-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const model = {
    id: 'new-model', name: 'New model', family: 'new-model', catalog: 'zen',
    url: `http://127.0.0.1:${server.address().port}/v1beta`,
    contextWindow: 100000, maxInputTokens: 90000, maxOutputTokens: 10000,
    vision: true, thinking: false, toolCalling: true,
    ...overrides,
  };
  const provider = new OpenCodeChatAdapter({ secrets: { get: async () => 'sk-local-test' } });
  provider.updateModels([model]);
  const parts = [];
  const request = (modelOptions = {}) => provider.provideLanguageModelChatResponse(model, [{
    role: vscode.LanguageModelChatMessageRole.User,
    content: [new vscode.LanguageModelTextPart('Hi')],
  }], { modelOptions: { _conversationId: 'session-1', ...modelOptions } }, { report: (part) => parts.push(part) }, {
    isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }),
  });
  return { requests, parts, request };
}

test('Google metadata selects the Google SDK endpoint even for an unfamiliar model ID', async (t) => {
  const { requests, parts, request } = await setup(t, {
    providerPackage: '@ai-sdk/google', apiType: 'google',
  });
  await request();
  assert.match(requests[0].path, /^\/v1beta\/models\/new-model:streamGenerateContent\?alt=sse$/);
  assert.equal(requests[0].headers['x-opencode-session'], 'session-1');
  assert.equal(requests[0].headers.authorization, 'Bearer sk-local-test');
  assert.equal(requests[0].headers['x-goog-api-key'], undefined);
  assert.equal(parts.filter((part) => part instanceof vscode.LanguageModelTextPart).map((part) => part.value).join(''), 'hello');
});

for (const [providerPackage, apiType, path] of [
  ['@ai-sdk/openai-compatible', 'chat-completions', '/v1beta/chat/completions'],
  ['@ai-sdk/openai', 'responses', '/v1beta/responses'],
  ['@ai-sdk/anthropic', 'messages', '/v1beta/messages'],
  ['@ai-sdk/mistral', 'chat-completions', '/v1beta/chat/completions'],
]) {
  test(`${providerPackage} routes and streams with its declared SDK`, async (t) => {
    const { requests, parts, request } = await setup(t, { providerPackage, apiType });
    await request();
    assert.equal(requests[0].path, path);
    assert.equal(requests[0].headers['x-opencode-session'], 'session-1');
    assert.equal(parts.filter((part) => part instanceof vscode.LanguageModelTextPart).map((part) => part.value).join(''), 'hello');
  });
}

test('unsupported provider packages fail before sending credentials', async (t) => {
  const { requests, request } = await setup(t, {
    providerPackage: '@ai-sdk/unknown', apiType: 'chat-completions',
  });
  await assert.rejects(request(), /unsupported.*provider/i);
  assert.equal(requests.length, 0);
});

test('off reasoning is omitted instead of being sent as an invalid SDK value', async (t) => {
  const { requests, request } = await setup(t, {
    providerPackage: '@ai-sdk/openai', apiType: 'chat-completions',
  });
  await assert.doesNotReject(request({ reasoningEffort: 'off' }));
  assert.equal(requests[0].body.reasoning_effort, undefined);
});

for (const [providerPackage, apiType, effort] of [
  ['@ai-sdk/openai-compatible', 'chat-completions', 'max'],
  ['@ai-sdk/mistral', 'chat-completions', 'high'],
  ['@ai-sdk/google', 'google', 'high'],
]) {
  test(`${providerPackage} forwards the metadata-declared reasoning effort`, async (t) => {
    const { requests, request } = await setup(t, {
      providerPackage, apiType, thinking: true, supportsReasoningEffort: [effort],
    });
    await request({ reasoningEffort: effort });
    const body = requests[0].body;
    assert.equal(apiType === 'google' ? body.generationConfig?.thinkingConfig?.thinkingLevel : body.reasoning_effort, effort);
  });
}

test('reasoning effort not declared by the model is rejected before the request', async (t) => {
  const { requests, request } = await setup(t, {
    providerPackage: '@ai-sdk/openai-compatible', apiType: 'chat-completions',
    thinking: true, supportsReasoningEffort: ['low', 'high'],
  });
  await assert.rejects(request({ reasoningEffort: 'max' }), /unsupported.*effort/i);
  assert.equal(requests.length, 0);
});

test('fallback token estimates do not depend on a hardcoded model-name list', async () => {
  const provider = new OpenCodeChatAdapter({ secrets: { get: async () => 'sk-local-test' } });
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const text = 'x'.repeat(360);
  const first = await provider.provideTokenCount({ id: 'gpt-test' }, text, token);
  const second = await provider.provideTokenCount({ id: 'claude-test' }, text, token);
  assert.equal(first, second);
  assert.equal(first, 90);
});
