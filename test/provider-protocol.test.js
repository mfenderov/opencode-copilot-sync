import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  createOpenCodeRequestHeaders,
  createProviderRequest,
  formatProviderMessages,
  formatProviderTools,
  getReasoningEffort,
  isSyntheticVerificationTool,
  resolveModelTokenLimits,
} from '../out/provider-protocol.js';
import { isSyntheticVerificationTool as providerSyntheticToolFilter } from '../out/provider.js';

test('resolveModelTokenLimits rejects metadata that cannot preserve a positive input budget', () => {
  const cases = [
    {
      input: [0.5, 0.5],
      expected: { contextWindow: 1048576, maxInputTokens: 983040, maxOutputTokens: 65536 },
    },
    {
      input: [1, 1],
      expected: { contextWindow: 1048576, maxInputTokens: 1048575, maxOutputTokens: 1 },
    },
    {
      input: [2, 2],
      expected: { contextWindow: 1048576, maxInputTokens: 1048574, maxOutputTokens: 2 },
    },
    {
      input: [3, 3],
      expected: { contextWindow: 1048576, maxInputTokens: 1048573, maxOutputTokens: 3 },
    },
    {
      input: [1048576, 0.5],
      expected: { contextWindow: 1048576, maxInputTokens: 983040, maxOutputTokens: 65536 },
    },
  ];

  for (const { input, expected } of cases) {
    assert.deepEqual(resolveModelTokenLimits(...input), expected);
  }
});

test('formats chat messages while omitting prior reasoning and preserving tool results', () => {
  const messages = formatProviderMessages([
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelTextPart('question')],
    },
    {
      role: vscode.LanguageModelChatMessageRole.Assistant,
      content: [
        new vscode.LanguageModelThinkingPart('stale reasoning', 'thinking-1'),
        new vscode.LanguageModelTextPart('answer'),
        new vscode.LanguageModelToolCallPart('call-1', 'lookup', { key: 'value' }),
      ],
    },
    {
      role: vscode.LanguageModelChatMessageRole.User,
      content: [new vscode.LanguageModelToolResultPart('call-1', ['first', { value: 'second' }])],
    },
  ]);

  assert.deepEqual(messages, [
    { role: 'user', content: 'question' },
    {
      role: 'assistant',
      content: 'answer',
      tool_calls: [{
        id: 'call-1',
        type: 'function',
        function: { name: 'lookup', arguments: '{"key":"value"}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'first\nsecond' },
  ]);
});

test('formats Chat Completions tools with clamped names and caller schemas', () => {
  const longName = 'x'.repeat(70);
  const schema = { type: 'object', properties: { value: { type: 'string' } } };

  assert.deepEqual(
    formatProviderTools([{ name: longName, description: 'A tool', inputSchema: schema }], false, false),
    [{
      type: 'function',
      function: { name: 'x'.repeat(64), description: 'A tool', parameters: schema },
    }]
  );
});

test('formats Responses tools and adds verification tools only when requested', () => {
  const schema = { type: 'object', properties: {} };
  const tools = formatProviderTools([{ name: 'search', description: 'Search', inputSchema: schema }], true, false);
  assert.deepEqual(tools, [{
    type: 'function',
    name: 'search',
    description: 'Search',
    parameters: schema,
  }]);

  const verified = formatProviderTools(undefined, true, true);
  assert.deepEqual(verified?.map((tool) => tool.name), ['bash', 'read']);
  assert.equal(formatProviderTools(undefined, false, false), undefined);
});

test('preserves the provider export for filtering synthetic verification calls', () => {
  assert.equal(isSyntheticVerificationTool('bash', undefined), true);
  assert.equal(isSyntheticVerificationTool('calculator', undefined), false);
  assert.equal(providerSyntheticToolFilter('read', [{ name: 'read' }]), false);
});

test('builds protocol-specific URLs and request bodies while sanitizing reasoning input', () => {
  const formattedMessages = [{ role: 'user', content: 'hello' }];
  const responses = createProviderRequest({
    modelId: 'muse-spark-1.3',
    isResponses: true,
    isFreeOrZen: true,
    formattedMessages,
    toolsPayload: undefined,
    responsesInput: [
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'stale reasoning' },
          { type: 'output_text', text: 'answer' },
        ],
      },
      { type: 'reasoning', encrypted_content: 'stale reasoning' },
    ],
    reasoningEffort: ' MAX ',
  });

  assert.equal(responses.url, 'https://opencode.ai/zen/v1/responses');
  assert.deepEqual(responses.body, {
    model: 'muse-spark-1.3',
    input: [{
      role: 'assistant',
      content: [{ type: 'output_text', text: 'answer' }],
    }],
    tools: undefined,
    stream: true,
    reasoning: { effort: 'high' },
  });

  const chat = createProviderRequest({
    modelId: 'deepseek-v4-pro',
    isResponses: false,
    isFreeOrZen: false,
    formattedMessages,
    toolsPayload: undefined,
    responsesInput: [],
    reasoningEffort: 'medium',
  });
  assert.equal(chat.url, 'https://opencode.ai/zen/go/v1/chat/completions');
  assert.deepEqual(chat.body, {
    model: 'deepseek-v4-pro',
    messages: formattedMessages,
    tools: undefined,
    stream: true,
    reasoning_effort: 'medium',
  });
});

test('reads the first configured reasoning level and formats client headers', () => {
  assert.equal(
    getReasoningEffort({
      modelConfiguration: { thinkingLevel: 'high' },
      configuration: { reasoningEffort: 'low' },
    }),
    'high'
  );
  assert.deepEqual(createOpenCodeRequestHeaders('test-key', 'ses_test', 'msg_test'), {
    Authorization: 'Bearer test-key',
    'Content-Type': 'application/json',
    'User-Agent': 'opencode/1.18.31',
    'x-opencode-client': 'cli',
    'x-opencode-session': 'ses_test',
    'x-opencode-request': 'msg_test',
  });
});
