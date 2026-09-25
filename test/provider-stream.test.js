import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { consumeProviderStream } from '../out/chat/application/send-chat-message.js';

function createProgress() {
  const parts = [];
  return { parts, report(part) { parts.push(part); } };
}

function createToken(isCancellationRequested = false) {
  return { isCancellationRequested };
}

function createResponse(chunks) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  }));
}

function sse(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

test('streams Chat Completions text and chunk-split inline thinking tags', async () => {
  const progress = createProgress();
  const result = await consumeProviderStream({
    response: createResponse([
      sse({ choices: [{ delta: { content: 'Before <thi' }, finish_reason: null }] }),
      sse({ choices: [{ delta: { content: 'nk>private thoughts</think> after' }, finish_reason: null }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]),
    modelId: 'deepseek-v4-pro',
    tools: undefined,
    progress,
    token: createToken(),
    abortSignal: new AbortController().signal,
    idleTimeoutMs: 1000,
    stallAttempt: 0,
    maxStallRetries: 1,
    log() {},
  });

  assert.equal(result, 'done');
  assert.deepEqual(
    progress.parts.filter((part) => part instanceof vscode.LanguageModelTextPart).map((part) => part.value),
    ['Before ', ' after']
  );
  assert.deepEqual(
    progress.parts.filter((part) => part instanceof vscode.LanguageModelThinkingPart).map((part) => part.value),
    ['private thoughts']
  );
});

test('streams Responses reasoning and output text through their respective part types', async () => {
  const progress = createProgress();
  const result = await consumeProviderStream({
    response: createResponse([
      sse({ type: 'response.output_item.added', item: { id: 'reasoning-1', type: 'reasoning' } }),
      sse({ type: 'response.reasoning_text.delta', delta: 'working through the problem' }),
      sse({ type: 'response.output_item.done', item: { id: 'reasoning-1', type: 'reasoning' } }),
      sse({ type: 'response.output_text.delta', delta: 'the answer' }),
      sse({ type: 'response.completed', response: { output: [] } }),
    ]),
    modelId: 'muse-spark-1.3',
    tools: undefined,
    progress,
    token: createToken(),
    abortSignal: new AbortController().signal,
    idleTimeoutMs: 1000,
    stallAttempt: 0,
    maxStallRetries: 1,
    log() {},
  });

  assert.equal(result, 'done');
  assert.ok(
    progress.parts.some((part) => part instanceof vscode.LanguageModelThinkingPart && part.value === 'working through the problem')
  );
  assert.deepEqual(
    progress.parts.filter((part) => part instanceof vscode.LanguageModelTextPart).map((part) => part.value),
    ['the answer']
  );
});

test('forwards one Responses usage payload for VS Code Agent Mode', async () => {
  const progress = createProgress();
  const result = await consumeProviderStream({
    response: createResponse([
      sse({
        type: 'response.completed',
        response: {
          output: [],
          usage: {
            input_tokens: 1234,
            output_tokens: 56,
            output_tokens_details: { reasoning_tokens: 7 },
          },
        },
      }),
      sse({
        type: 'response.completed',
        response: {
          output: [],
          usage: { input_tokens: 9999, output_tokens: 99 },
        },
      }),
    ]),
    modelId: 'muse-spark-1.3-contributor',
    tools: undefined,
    progress,
    token: createToken(),
    abortSignal: new AbortController().signal,
    idleTimeoutMs: 1000,
    stallAttempt: 0,
    maxStallRetries: 1,
    log() {},
  });

  assert.equal(result, 'done');
  const usageParts = progress.parts.filter(
    (part) => part instanceof vscode.LanguageModelDataPart && part.mimeType === 'usage'
  );
  assert.equal(usageParts.length, 1);
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(usageParts[0].data)),
    {
      prompt_tokens: 1234,
      completion_tokens: 56,
      completion_tokens_details: { reasoning_tokens: 7 },
    }
  );
});

test('retries an idle stream only before the configured stall-retry budget is exhausted', async () => {
  const logs = [];
  const progress = createProgress();
  const options = {
    modelId: 'deepseek-v4-pro',
    tools: undefined,
    progress,
    token: createToken(),
    abortSignal: new AbortController().signal,
    idleTimeoutMs: 1,
    maxStallRetries: 1,
    log(message) { logs.push(message); },
  };
  const createIdleResponse = () => new Response(new ReadableStream({ start() {} }));

  assert.equal(
    await consumeProviderStream({ ...options, response: createIdleResponse(), stallAttempt: 0 }),
    'retry'
  );
  assert.match(logs[0], /automatic recovery retry \(1\/1\)/);

  assert.equal(
    await consumeProviderStream({ ...options, response: createIdleResponse(), stallAttempt: 1 }),
    'done'
  );
  assert.ok(progress.parts.some((part) => /Response stream interrupted: Stream idle for over/.test(part.value)));
});

test('does not report cancellation as a stream interruption', async () => {
  const progress = createProgress();
  const result = await consumeProviderStream({
    response: createResponse([]),
    modelId: 'deepseek-v4-pro',
    tools: undefined,
    progress,
    token: createToken(true),
    abortSignal: new AbortController().signal,
    idleTimeoutMs: 1000,
    stallAttempt: 0,
    maxStallRetries: 1,
    log() {},
  });

  assert.equal(result, 'done');
  assert.deepEqual(progress.parts, []);
});
