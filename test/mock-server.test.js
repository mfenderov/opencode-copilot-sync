import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startMockServer } from './helpers/mock-opencode-server.js';

let mockServer;

before(async () => {
  mockServer = await startMockServer(0);
});

after(async () => {
  if (mockServer) {
    await mockServer.close();
  }
});

beforeEach(() => {
  mockServer.resetScenarios();
  mockServer.clearRequests();
});

// Helper to send HTTP requests to mock server and collect response
async function requestMock(pathname, { method = 'POST', headers = {}, body = null } = {}) {
  const url = `${mockServer.url}${pathname}`;
  const options = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body) {
    options.body = typeof body === 'string' ? body : JSON.stringify(body);
  }
  return fetch(url, options);
}

// Helper to read SSE chunks from a readable stream response
async function readSseLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const lines = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      lines.push(part);
    }
  }
  if (buffer) {
    lines.push(buffer);
  }
  return lines;
}

test('MockServer: start and cleanly close', async () => {
  const ephemeral = await startMockServer();
  assert.ok(ephemeral.url.startsWith('http://127.0.0.1:'));
  assert.ok(typeof ephemeral.port === 'number');
  await ephemeral.close();
});

test('MockServer: records incoming request headers, body, and method', async () => {
  const payload = { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'ping' }] };
  const res = await requestMock('/zen/v1/chat/completions', {
    headers: {
      Authorization: 'Bearer sk-mock-key-123',
      'x-opencode-session': 'ses_test_abc',
    },
    body: payload,
  });

  assert.equal(res.status, 200);
  const requests = mockServer.getRequests();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].pathname, '/zen/v1/chat/completions');
  assert.equal(requests[0].headers['authorization'], 'Bearer sk-mock-key-123');
  assert.equal(requests[0].headers['x-opencode-session'], 'ses_test_abc');
  assert.equal(requests[0].body.model, 'deepseek-v4-pro');
});

test('MockServer: returns 404 for unknown endpoint', async () => {
  const res = await requestMock('/unknown/endpoint', { body: {} });
  assert.equal(res.status, 404);
  const json = await res.json();
  assert.equal(json.error.code, 404);
  assert.match(json.error.message, /Endpoint not found/);
});

test('MockServer: endpoints support zen and zen/go for chat and responses', async () => {
  const endpoints = [
    '/zen/v1/chat/completions',
    '/zen/go/v1/chat/completions',
    '/zen/v1/responses',
    '/zen/go/v1/responses',
  ];

  for (const ep of endpoints) {
    const res = await requestMock(ep, { body: { model: 'test' } });
    assert.equal(res.status, 200, `Expected 200 for endpoint ${ep}`);
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  }
});

test('MockServer [mode: standard]: streams standard chat completions SSE chunks', async () => {
  mockServer.setScenario({ mode: 'standard' });
  const res = await requestMock('/zen/v1/chat/completions', {
    body: { model: 'deepseek-v4-pro' },
  });

  assert.equal(res.status, 200);
  const lines = await readSseLines(res);
  const dataLines = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));

  assert.ok(dataLines.includes('[DONE]'));
  const parsedChunks = dataLines.filter((l) => l !== '[DONE]').map((l) => JSON.parse(l));

  assert.ok(parsedChunks.length >= 2);
  const fullContent = parsedChunks.map((c) => c.choices[0]?.delta?.content || '').join('');
  assert.match(fullContent, /Hello from mock OpenCode server!/);
  assert.equal(parsedChunks[parsedChunks.length - 1].choices[0]?.finish_reason, 'stop');
});

test('MockServer [mode: standard]: streams standard responses API SSE chunks', async () => {
  mockServer.setScenario({ mode: 'standard' });
  const res = await requestMock('/zen/v1/responses', {
    body: { model: 'gpt-5.5' },
  });

  assert.equal(res.status, 200);
  const lines = await readSseLines(res);
  const dataLines = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));

  assert.ok(dataLines.includes('[DONE]'));
  const parsedChunks = dataLines.filter((l) => l !== '[DONE]').map((l) => JSON.parse(l));

  const textDeltas = parsedChunks.filter((c) => c.type === 'response.output_text.delta').map((c) => c.delta).join('');
  assert.match(textDeltas, /Hello from mock OpenCode server!/);
  assert.ok(parsedChunks.some((c) => c.type === 'response.completed'));
});

test('MockServer [mode: thinking]: streams reasoning_content on chat completions', async () => {
  mockServer.setScenario({
    mode: 'thinking',
    reasoning: 'Calculated step 1 thoroughly.',
    content: 'Answer is 42.',
  });

  const res = await requestMock('/zen/go/v1/chat/completions', {
    body: { model: 'deepseek-v4-pro' },
  });

  assert.equal(res.status, 200);
  const lines = await readSseLines(res);
  const dataLines = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  const parsedChunks = dataLines.filter((l) => l !== '[DONE]').map((l) => JSON.parse(l));

  const reasoningChunk = parsedChunks.find((c) => c.choices[0]?.delta?.reasoning_content);
  assert.ok(reasoningChunk, 'Expected chunk with reasoning_content');
  assert.equal(reasoningChunk.choices[0].delta.reasoning_content, 'Calculated step 1 thoroughly.');

  const contentChunk = parsedChunks.find((c) => c.choices[0]?.delta?.content === 'Answer is 42.');
  assert.ok(contentChunk, 'Expected chunk with final content');
});

test('MockServer [mode: thinking]: streams item: { type: "reasoning" } on responses API', async () => {
  mockServer.setScenario({
    mode: 'thinking',
    reasoning: 'Reasoning about prompt...',
    content: 'Done reasoning.',
  });

  const res = await requestMock('/zen/go/v1/responses', {
    body: { model: 'gpt-5.5' },
  });

  assert.equal(res.status, 200);
  const lines = await readSseLines(res);
  const dataLines = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  const parsedChunks = dataLines.filter((l) => l !== '[DONE]').map((l) => JSON.parse(l));

  const itemAdded = parsedChunks.find((c) => c.type === 'response.output_item.added');
  assert.ok(itemAdded, 'Expected response.output_item.added');
  assert.equal(itemAdded.item.type, 'reasoning');

  const reasoningDelta = parsedChunks.find((c) => c.type === 'response.reasoning_text.delta');
  assert.ok(reasoningDelta);
  assert.equal(reasoningDelta.delta, 'Reasoning about prompt...');

  const itemDone = parsedChunks.find((c) => c.type === 'response.output_item.done');
  assert.ok(itemDone);
  assert.equal(itemDone.item.type, 'reasoning');
});

test('MockServer [mode: tool-call]: streams calculator function call on chat completions', async () => {
  mockServer.setScenario({
    mode: 'tool-call',
    toolName: 'calculator',
    toolCallId: 'call_calc_42',
    toolArgsPart1: '{"expression":',
    toolArgsPart2: ' "2 + 2"}',
  });

  const res = await requestMock('/zen/v1/chat/completions', {
    body: { model: 'deepseek-v4-pro' },
  });

  assert.equal(res.status, 200);
  const lines = await readSseLines(res);
  const dataLines = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  const parsedChunks = dataLines.filter((l) => l !== '[DONE]').map((l) => JSON.parse(l));

  const initialCall = parsedChunks.find((c) => c.choices[0]?.delta?.tool_calls?.[0]?.function?.name === 'calculator');
  assert.ok(initialCall, 'Expected tool_calls delta with calculator name');
  assert.equal(initialCall.choices[0].delta.tool_calls[0].id, 'call_calc_42');

  const finishChunk = parsedChunks.find((c) => c.choices[0]?.finish_reason === 'tool_calls');
  assert.ok(finishChunk, 'Expected finish_reason to be tool_calls');
});

test('MockServer [mode: tool-call]: streams calculator function call on responses API', async () => {
  mockServer.setScenario({
    mode: 'tool-call',
    toolName: 'calculator',
    toolCallId: 'call_calc_99',
  });

  const res = await requestMock('/zen/v1/responses', {
    body: { model: 'gpt-5.5' },
  });

  assert.equal(res.status, 200);
  const lines = await readSseLines(res);
  const dataLines = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  const parsedChunks = dataLines.filter((l) => l !== '[DONE]').map((l) => JSON.parse(l));

  const itemAdded = parsedChunks.find((c) => c.type === 'response.output_item.added');
  assert.ok(itemAdded);
  assert.equal(itemAdded.item.type, 'function_call');
  assert.equal(itemAdded.item.name, 'calculator');

  const argsDelta = parsedChunks.filter((c) => c.type === 'response.function_call_arguments.delta');
  assert.ok(argsDelta.length >= 2);

  const itemDone = parsedChunks.find((c) => c.type === 'response.output_item.done');
  assert.ok(itemDone);
  assert.equal(itemDone.item.name, 'calculator');
});

test('MockServer [mode: fault]: injects 500, 502, 503, 401, 404', async () => {
  const faultCodes = [500, 502, 503, 401, 404];

  for (const status of faultCodes) {
    mockServer.setScenario({ mode: 'fault', status });
    const res = await requestMock('/zen/v1/chat/completions', { body: {} });
    assert.equal(res.status, status);
    const json = await res.json();
    assert.equal(json.error.code, status);
    assert.ok(json.error.message);
  }
});

test('MockServer [mode: drop]: abruptly closes socket midway through SSE streaming', async () => {
  mockServer.setScenario({ mode: 'drop' });

  await assert.rejects(
    async () => {
      const res = await requestMock('/zen/v1/chat/completions', { body: {} });
      assert.equal(res.status, 200);
      await readSseLines(res);
    },
    (err) => {
      // Fetch stream will throw on premature socket destruction
      return err instanceof Error;
    }
  );
});

test('MockServer [mode: keep-alive]: sends : keep-alive comment lines before answering', async () => {
  mockServer.setScenario({ mode: 'keep-alive', keepAliveCount: 3 });
  const res = await requestMock('/zen/v1/chat/completions', { body: {} });

  assert.equal(res.status, 200);
  const lines = await readSseLines(res);

  const keepAliveLines = lines.filter((l) => l.trim() === ': keep-alive');
  assert.equal(keepAliveLines.length, 3, 'Expected 3 keep-alive comment lines');

  // Verify response continues with standard SSE payload
  const dataLines = lines.filter((l) => l.startsWith('data: ')).map((l) => l.slice(6));
  assert.ok(dataLines.includes('[DONE]'));
});

test('MockServer: scenario queue supports ordered sequential states', async () => {
  mockServer.setScenario([
    { mode: 'fault', status: 502 },
    { mode: 'standard' },
  ]);

  // Request 1: should receive 502 fault
  const res1 = await requestMock('/zen/v1/chat/completions', { body: {} });
  assert.equal(res1.status, 502);

  // Request 2: should receive 200 standard
  const res2 = await requestMock('/zen/v1/chat/completions', { body: {} });
  assert.equal(res2.status, 200);
});

test('MockServer: models endpoint returns mock model catalog', async () => {
  const res = await requestMock('/zen/v1/models', { method: 'GET' });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(Array.isArray(json.data));
  assert.ok(json.data.some((m) => m.id === 'deepseek-v4-pro'));
});
