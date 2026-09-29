import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import {
  createOpenCodeRequestHeaders,
  createProviderRequest,
} from '../out/chat/infrastructure/request-factory.js';
import { formatProviderMessages } from '../out/chat/infrastructure/message-mapper.js';
import {
  formatProviderTools,
  isSyntheticVerificationTool,
  isSyntheticVerificationTool as providerSyntheticToolFilter,
} from '../out/chat/infrastructure/tool-mapper.js';
import { getReasoningEffort } from '../out/chat/infrastructure/reasoning-controls.js';
import { resolveModelTokenLimits } from '../out/models/domain/token-budget.js';

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

// ============================================================================
// Oversized enum clamping (OpenCode gateway: >250 values / >15000 chars per enum)
// ============================================================================

const manyValues = (n) => Array.from({ length: n }, (_, i) => `value-${i}`);

function parametersOf(tools, isResponses) {
  return tools[0].parameters ?? tools[0].function.parameters;
}

test('strips oversized enums in BOTH wire shapes, not just one branch', () => {
  for (const isResponses of [true, false]) {
    const schema = {
      type: 'object',
      properties: { mode: { type: 'string', enum: manyValues(300) } },
    };
    const tools = formatProviderTools(
      [{ name: 'picker', description: 'Pick', inputSchema: schema }],
      isResponses,
      false
    );
    const params = parametersOf(tools, isResponses);
    assert.equal(
      params.properties.mode.enum,
      undefined,
      `oversized enum survived on the ${isResponses ? 'Responses' : 'Chat Completions'} branch`
    );
    assert.equal(params.properties.mode.type, 'string', 'property degrades to a free string');
  }
});

test('drops an enum that breaches the character limit even under the count limit', () => {
  // 60 values x 300 chars = 18000 chars, comfortably past the gateway's 15000 ceiling.
  const long = manyValues(60).map((v) => v.repeat(60));
  const tools = formatProviderTools(
    [{ name: 'picker', description: 'Pick', inputSchema: { type: 'object', properties: { m: { enum: long } } } }],
    true,
    false
  );
  assert.equal(parametersOf(tools, true).properties.m.enum, undefined);
  assert.equal(parametersOf(tools, true).properties.m.type, 'string');
});

test('pins the enum limits at their boundary', () => {
  const atLimit = (n) =>
    parametersOf(
      formatProviderTools(
        [{ name: 'p', description: 'P', inputSchema: { type: 'object', properties: { v: { enum: manyValues(n) } } } }],
        true,
        false
      ),
      true
    ).properties.v;

  assert.ok(Array.isArray(atLimit(200).enum), '200 values is within the limit and must be kept');
  assert.equal(atLimit(201).enum, undefined, '201 values exceeds the limit and must be dropped');

  // Char boundary: 100 values x 100 chars = 10000 (under), 120 x 110 = 13200 (over).
  const under = Array.from({ length: 100 }, (_, i) => `v${i}`.padEnd(100, 'x'));
  const over = Array.from({ length: 120 }, (_, i) => `v${i}`.padEnd(110, 'x'));
  assert.equal(under.reduce((a, v) => a + v.length, 0), 10000);
  assert.ok(over.reduce((a, v) => a + v.length, 0) > 12000);

  const charLimited = (values) =>
    parametersOf(
      formatProviderTools(
        [{ name: 'p', description: 'P', inputSchema: { type: 'object', properties: { v: { enum: values } } } }],
        true,
        false
      ),
      true
    ).properties.v;

  assert.ok(Array.isArray(charLimited(under).enum), 'under the char limit and must be kept');
  assert.equal(charLimited(over).enum, undefined, 'over the char limit and must be dropped');
});

test('preserves legal enums and never aliases the caller schema', () => {
  const schema = { type: 'object', properties: { v: { type: 'string', enum: ['a', 'b', 'c'] } } };
  const tools = formatProviderTools([{ name: 'p', description: 'P', inputSchema: schema }], true, false);
  const params = parametersOf(tools, true);

  assert.deepEqual(params.properties.v.enum, ['a', 'b', 'c'], 'legal enum is preserved');
  assert.notStrictEqual(params, schema, 'payload must not alias VS Code\'s inputSchema object');
  assert.notStrictEqual(params.properties.v, schema.properties.v, 'nested nodes must be fresh too');
});

test('strips oversized enums at any nesting depth', () => {
  const big = manyValues(300);
  const schema = {
    type: 'object',
    properties: {
      direct: { enum: big },
      inItems: { type: 'array', items: { enum: big } },
      inAnyOf: { anyOf: [{ enum: big }, { type: 'string' }] },
    },
    $defs: { hidden: { enum: big } },
  };

  const params = parametersOf(formatProviderTools([{ name: 'p', description: 'P', inputSchema: schema }], true, false), true);

  assert.equal(params.properties.direct.enum, undefined);
  assert.equal(params.properties.inItems.items.enum, undefined);
  assert.equal(params.properties.inAnyOf.anyOf[0].enum, undefined);
  assert.equal(params.$defs.hidden.enum, undefined);
  // A sibling that never breached is left intact.
  assert.equal(params.properties.inAnyOf.anyOf[1].type, 'string');
});

test('does not inject a type into ancestors that only lost a descendant enum', () => {
  // `changed` propagates from children, so keying the type-injection off it would add
  // `type: 'string'` to every untyped ancestor — turning $defs entries and untyped
  // combinator branches into falsely-typed string constraints.
  const schema = {
    $defs: { wrapper: { properties: { inner: { enum: manyValues(300) } } } },
    anyOf: [{ properties: { v: { enum: manyValues(300) } } }],
  };
  const params = parametersOf(formatProviderTools([{ name: 'p', description: 'P', inputSchema: schema }], true, false), true);

  assert.equal('$defs' in params, true);
  assert.equal(params.$defs.wrapper.type, undefined, 'an ancestor did not lose its own enum, so it gains no type');
  assert.equal(params.anyOf[0].type, undefined, 'same for an untyped combinator branch');
  assert.equal(params.$defs.wrapper.properties.inner.type, 'string', 'only the node that lost its enum gains a type');
});

test('does not descend into data keywords that merely contain an "enum" key', () => {
  const big = manyValues(300);
  const schema = {
    type: 'object',
    properties: { v: { type: 'string' } },
    examples: [{ enum: big }],
    default: { enum: big },
    description: 'A tool',
  };
  const params = parametersOf(formatProviderTools([{ name: 'p', description: 'P', inputSchema: schema }], true, false), true);

  assert.equal(params.examples[0].enum.length, 300, 'examples is data, not schema');
  assert.equal(params.default.enum.length, 300, 'default is data, not schema');
});

test('strips only the breaching property and logs every drop', () => {
  const logs = [];
  const schema = {
    type: 'object',
    properties: {
      bad: { type: 'string', enum: manyValues(300) },
      good: { type: 'string', enum: ['keep', 'me'] },
    },
  };
  const params = parametersOf(
    formatProviderTools([{ name: 'picker', description: 'Pick', inputSchema: schema }], true, false, (m) => logs.push(m)),
    true
  );

  assert.equal(params.properties.bad.enum, undefined);
  assert.deepEqual(params.properties.good.enum, ['keep', 'me']);
  assert.equal(logs.length, 1, 'exactly one drop should be reported');
  assert.match(logs[0], /schema relaxed: dropped oversized enum on picker/);
});

test('falls back to the caller schema and logs when sanitization throws', () => {
  const logs = [];
  const throwing = {
    type: 'object',
    get properties() {
      throw new Error('boom');
    },
  };
  const params = parametersOf(
    formatProviderTools([{ name: 'bad', description: 'Bad', inputSchema: throwing }], true, false, (m) => logs.push(m)),
    true
  );

  assert.strictEqual(params, throwing, 'degrades to exactly the pre-change payload, not an empty schema');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /schema sanitization failed for bad: boom; sending caller schema unchanged/);
});

test('survives a cyclic schema without hanging or throwing', () => {
  const node = { type: 'string', enum: manyValues(300) };
  const cyclic = { type: 'object', properties: { self: node } };
  node.properties = { back: cyclic };

  const params = parametersOf(
    formatProviderTools([{ name: 'cyc', description: 'Cyc', inputSchema: cyclic }], true, false),
    true
  );

  assert.ok(params && typeof params === 'object');
  assert.equal(params.properties.self.enum, undefined, 'the reachable oversized enum is still stripped');
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
