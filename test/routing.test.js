import { test } from 'node:test';
import assert from 'node:assert/strict';
import { enrichModel } from '../out/models/infrastructure/model-enricher.js';
import {
  isResponsesModel,
  isZenModel,
} from '../out/chat/infrastructure/request-factory.js';
import {
  normalizeReasoningEffort,
  isStaleReasoningInput,
} from '../out/chat/infrastructure/reasoning-controls.js';
import {
  sanitizeResponsesInput,
  buildResponsesInput,
} from '../out/chat/infrastructure/message-mapper.js';

test('muse-* models MUST have apiType === "responses" and url ending with /zen/go/v1 or /zen/v1', () => {
  const museModels = [
    'muse-spark-1.3-contributor-free',
    'muse-spark-1.2-contributor-free',
    'muse-creative',
  ];

  for (const modelId of museModels) {
    // Go catalog variant
    const goModel = enrichModel(modelId, { isGo: true });
    assert.equal(goModel.apiType, 'responses', `${modelId} (Go) must have apiType === 'responses'`);
    assert.ok(
      goModel.url.endsWith('/zen/go/v1'),
      `${modelId} (Go) url must end with /zen/go/v1, got: ${goModel.url}`
    );
    assert.ok(
      !goModel.url.includes('/chat/completions'),
      `${modelId} (Go) url must not contain /chat/completions`
    );

    // Zen catalog variant
    const zenModel = enrichModel(modelId, { isGo: false });
    assert.equal(zenModel.apiType, 'responses', `${modelId} (Zen) must have apiType === 'responses'`);
    assert.ok(
      zenModel.url.endsWith('/zen/v1'),
      `${modelId} (Zen) url must end with /zen/v1, got: ${zenModel.url}`
    );
    assert.ok(
      !zenModel.url.includes('/chat/completions'),
      `${modelId} (Zen) url must not contain /chat/completions`
    );
  }
});

test('gpt-* models MUST have apiType === "responses" and base url without /chat/completions', () => {
  const gptModels = [
    'gpt-5.5',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    'gpt-5-mini',
    'gpt-5.4',
    'gpt-5.3-codex',
  ];

  for (const modelId of gptModels) {
    const goModel = enrichModel(modelId, { isGo: true });
    assert.equal(goModel.apiType, 'responses', `${modelId} must have apiType === 'responses'`);
    assert.ok(
      goModel.url.endsWith('/zen/go/v1'),
      `${modelId} url must end with /zen/go/v1, got: ${goModel.url}`
    );
    assert.ok(
      !goModel.url.includes('/chat/completions'),
      `${modelId} url must not contain /chat/completions`
    );

    const zenModel = enrichModel(modelId, { isGo: false });
    assert.equal(zenModel.apiType, 'responses', `${modelId} (Zen) must have apiType === 'responses'`);
    assert.ok(
      zenModel.url.endsWith('/zen/v1'),
      `${modelId} (Zen) url must end with /zen/v1, got: ${zenModel.url}`
    );
    assert.ok(
      !zenModel.url.includes('/chat/completions'),
      `${modelId} (Zen) url must not contain /chat/completions`
    );
  }
});

test('grok-* models MUST have apiType === "responses" and base url without /chat/completions', () => {
  const grokModels = [
    'grok-4.6',
    'grok-4.5',
  ];

  for (const modelId of grokModels) {
    const goModel = enrichModel(modelId, { isGo: true });
    assert.equal(goModel.apiType, 'responses', `${modelId} must have apiType === 'responses'`);
    assert.ok(
      goModel.url.endsWith('/zen/go/v1'),
      `${modelId} url must end with /zen/go/v1, got: ${goModel.url}`
    );
    assert.ok(
      !goModel.url.includes('/chat/completions'),
      `${modelId} url must not contain /chat/completions`
    );

    const zenModel = enrichModel(modelId, { isGo: false });
    assert.equal(zenModel.apiType, 'responses', `${modelId} (Zen) must have apiType === 'responses'`);
    assert.ok(
      zenModel.url.endsWith('/zen/v1'),
      `${modelId} (Zen) url must end with /zen/v1, got: ${zenModel.url}`
    );
    assert.ok(
      !zenModel.url.includes('/chat/completions'),
      `${modelId} (Zen) url must not contain /chat/completions`
    );
  }
});

test('claude-* models MUST have apiType === "messages" and url ending with /zen/go/v1 or /zen/v1', () => {
  const claudeModels = [
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-opus-4.8',
    'claude-haiku-4.5',
  ];

  for (const modelId of claudeModels) {
    const goModel = enrichModel(modelId, { isGo: true });
    assert.equal(goModel.apiType, 'messages', `${modelId} must have apiType === 'messages'`);
    assert.ok(
      goModel.url.endsWith('/zen/go/v1'),
      `${modelId} url must end with /zen/go/v1, got: ${goModel.url}`
    );
    assert.ok(
      !goModel.url.includes('/chat/completions'),
      `${modelId} url must not contain /chat/completions`
    );

    const zenModel = enrichModel(modelId, { isGo: false });
    assert.equal(zenModel.apiType, 'messages', `${modelId} (Zen) must have apiType === 'messages'`);
    assert.ok(
      zenModel.url.endsWith('/zen/v1'),
      `${modelId} (Zen) url must end with /zen/v1, got: ${zenModel.url}`
    );
    assert.ok(
      !zenModel.url.includes('/chat/completions'),
      `${modelId} (Zen) url must not contain /chat/completions`
    );
  }
});

test('deepseek-*, kimi-*, glm-*, mimo-*, qwen-* MUST have apiType === "chat-completions"', () => {
  const chatCompletionsModels = [
    'deepseek-v4.1-flash',
    'deepseek-v4-pro',
    'deepseek-flash',
    'kimi-k3',
    'kimi-k2.7-code',
    'kimi-k2.6',
    'glm-5.3',
    'glm-5.3-flash',
    'glm-5.2',
    'glm-5.1',
    'mimo-v2.5',
    'mimo-v2.5-pro',
    'qwen3.8-flash',
    'qwen3.8-max',
    'qwen3.7-max',
    'qwen3.6-plus',
  ];

  for (const modelId of chatCompletionsModels) {
    const goModel = enrichModel(modelId, { isGo: true });
    assert.equal(
      goModel.apiType,
      'chat-completions',
      `${modelId} must have apiType === 'chat-completions'`
    );
    assert.ok(
      goModel.url.endsWith('/chat/completions'),
      `${modelId} url must end with /chat/completions, got: ${goModel.url}`
    );

    const zenModel = enrichModel(modelId, { isGo: false });
    assert.equal(
      zenModel.apiType,
      'chat-completions',
      `${modelId} (Zen) must have apiType === 'chat-completions'`
    );
    assert.ok(
      zenModel.url.endsWith('/chat/completions'),
      `${modelId} (Zen) url must end with /chat/completions, got: ${zenModel.url}`
    );
  }
});

test('enriched models carry no fake session headers (honest client)', () => {
  const representativeModels = [
    'muse-spark-1.3-contributor',
    'gpt-5.5',
    'deepseek-v4.1-flash',
    'kimi-k3',
    'big-pickle',
  ];

  for (const id of representativeModels) {
    const model = enrichModel(id, { isGo: true });
    assert.equal(
      model.requestHeaders,
      undefined,
      `Model ${id} must not carry fake session headers`
    );
  }
});

test('isResponsesModel returns true for responses models and false for others', () => {
  // Required true assertions
  assert.equal(isResponsesModel('muse-spark-1.3-contributor-free'), true);
  assert.equal(isResponsesModel('gpt-5.5'), true);
  assert.equal(isResponsesModel('grok-4.6'), true);

  // Additional responses models
  assert.equal(isResponsesModel('muse-spark-1.2-contributor-free'), true);
  assert.equal(isResponsesModel('gpt-5.6-terra'), true);
  assert.equal(isResponsesModel('gpt-5-mini'), true);
  assert.equal(isResponsesModel('grok-4.5'), true);

  // Required false assertions
  assert.equal(isResponsesModel('deepseek-v4.1-flash'), false);
  assert.equal(isResponsesModel('kimi-k3'), false);

  // Additional chat-completions / messages models
  assert.equal(isResponsesModel('claude-sonnet-5'), false);
  assert.equal(isResponsesModel('glm-5.3'), false);
  assert.equal(isResponsesModel('mimo-v2.5'), false);
  assert.equal(isResponsesModel('qwen3.8-flash'), false);
});

test('isResponsesModel prioritizes an explicit apiType hint over the substring heuristic', () => {
  // A future/unknown model ID that doesn't match the muse/gpt-/grok- substrings must
  // still route correctly when the catalog already computed its real apiType.
  assert.equal(isResponsesModel('some-new-model-9000', 'responses'), true);
  // Conversely, a model ID that WOULD false-positive the heuristic (e.g. contains
  // "gpt-" as a coincidental substring) must be overridden by an authoritative
  // chat-completions/messages apiType rather than misrouted to Responses.
  assert.equal(isResponsesModel('legacy-gpt-4-compat-wrapper', 'chat-completions'), false);
  assert.equal(isResponsesModel('claude-opus-5', 'messages'), false);
  // No hint provided (undefined) still falls back to the substring heuristic.
  assert.equal(isResponsesModel('muse-spark-1.3'), true);
});

test('All Muse models MUST have thinking === true and valid supportsReasoningEffort without "max"', () => {
  const museVariants = [
    'muse-spark-1.3',
    'muse-spark-1.3-contributor',
    'muse-spark-1.3-contributor-free',
    'muse-spark-1.2-contributor-free',
  ];

  for (const id of museVariants) {
    const model = enrichModel(id);
    assert.equal(model.thinking, true, `${id} must have thinking === true`);
    assert.ok(Array.isArray(model.supportsReasoningEffort), `${id} must have supportsReasoningEffort array`);
    assert.ok(!model.supportsReasoningEffort.includes('max'), `${id} must never include 'max' effort`);
    assert.ok(model.supportsReasoningEffort.includes('high'), `${id} must include 'high' effort`);
  }
});

test('VERIFIED_OPENCODE_MODELS static fallback includes all Muse models with thinking: true', async () => {
  const { VERIFIED_OPENCODE_MODELS } = await import('../out/models/infrastructure/verified-catalog.js');
  const museIds = [
    'muse-spark-1.3',
    'muse-spark-1.3-contributor',
  ];
  for (const id of museIds) {
    const found = VERIFIED_OPENCODE_MODELS.find(m => m.id === id);
    assert.ok(found, `VERIFIED_OPENCODE_MODELS must include ${id}`);
    assert.equal(found.thinking, true, `${id} must have thinking: true in static fallback`);
    assert.ok(Array.isArray(found.supportsReasoningEffort), `${id} must have supportsReasoningEffort array`);
    assert.ok(!found.supportsReasoningEffort.includes('max'), `${id} must not include max in static fallback`);
  }
  assert.equal(isResponsesModel('big-pickle'), false);
});

test('isZenModel matches only -free suffixed IDs without metadata', () => {
  assert.equal(isZenModel('freeform-9000'), false, 'contains free but is not a Zen -free ID');
  assert.equal(isZenModel('freedom-1'), false, 'contains free but is not a Zen -free ID');
  assert.equal(isZenModel('mimo-v2.5-free'), true, '-free suffix still falls back to Zen');
});

test('isZenModel routes by catalog, with -free IDs falling back to Zen', () => {
  assert.equal(isZenModel('muse-spark-1.3-contributor', { catalog: 'go' }), false);
  assert.equal(isZenModel('deepseek-v4-pro', { catalog: 'go' }), false);
  assert.equal(isZenModel('qwen3.7-max', { catalog: 'go' }), false);

  assert.equal(isZenModel('muse-spark-1.3-contributor-free', { catalog: 'zen' }), true);
  assert.equal(isZenModel('muse-spark-1.3-contributor-free'), true);
  assert.equal(isZenModel('mimo-v2.5-free'), true);
  assert.equal(isZenModel('big-pickle'), true);
  assert.equal(isZenModel('claude-sonnet-4-6', { catalog: 'zen' }), true);

  // Zen IDs keep the Zen suffix with no tier concept
  const grok = enrichModel('grok-code', { isGo: false });
  assert.ok(grok.name.includes('(OpenCode Zen)'), `got: ${grok.name}`);
});

test('normalizeReasoningEffort correctly normalizes "max" to "high" and handles all valid efforts', () => {
  // Responses API (Muse, GPT, Grok) format: { reasoning: { effort: '...' } }
  assert.deepEqual(normalizeReasoningEffort('max', true), { reasoning: { effort: 'high' } });
  assert.deepEqual(normalizeReasoningEffort('MAX', true), { reasoning: { effort: 'high' } });
  assert.deepEqual(normalizeReasoningEffort('high', true), { reasoning: { effort: 'high' } });
  assert.deepEqual(normalizeReasoningEffort('medium', true), { reasoning: { effort: 'medium' } });
  assert.deepEqual(normalizeReasoningEffort('low', true), { reasoning: { effort: 'low' } });
  assert.deepEqual(normalizeReasoningEffort('minimal', true), { reasoning: { effort: 'minimal' } });
  assert.deepEqual(normalizeReasoningEffort('xhigh', true), { reasoning: { effort: 'xhigh' } });

  // Chat Completions format: { reasoning_effort: '...' }
  assert.deepEqual(normalizeReasoningEffort('max', false), { reasoning_effort: 'high' });
  assert.deepEqual(normalizeReasoningEffort('high', false), { reasoning_effort: 'high' });

  // Discard none, off, undefined, or unrecognized garbage values
  assert.deepEqual(normalizeReasoningEffort('none', true), {});
  assert.deepEqual(normalizeReasoningEffort('off', true), {});
  assert.deepEqual(normalizeReasoningEffort(undefined, true), {});
  assert.deepEqual(normalizeReasoningEffort('ultra', true), {});
  assert.deepEqual(normalizeReasoningEffort('extreme', true), {});
});

test('isStaleReasoningInput correctly identifies stale reasoning and encrypted content', () => {
  // Stale reasoning items
  assert.equal(isStaleReasoningInput({ type: 'reasoning', id: 'r_1' }), true);
  assert.equal(isStaleReasoningInput({ type: 'thought', text: 'thinking...' }), true);
  assert.equal(isStaleReasoningInput({ type: 'thinking', text: 'thinking...' }), true);
  assert.equal(isStaleReasoningInput({ encrypted_content: 'opaque_token_123' }), true);
  assert.equal(
    isStaleReasoningInput({
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'internal plan' }],
    }),
    true
  );
  assert.equal(
    isStaleReasoningInput({
      role: 'assistant',
      content: [{ encrypted_content: 'opaque_token_456' }],
    }),
    true
  );

  // Valid user and assistant messages
  assert.equal(isStaleReasoningInput({ role: 'user', content: 'hello' }), false);
  assert.equal(
    isStaleReasoningInput({
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Here is the answer' }],
    }),
    false
  );
  assert.equal(
    isStaleReasoningInput({
      type: 'function_call',
      id: 'call_1',
      call_id: 'call_1',
      name: 'read_file',
      arguments: '{}',
    }),
    false
  );
  assert.equal(
    isStaleReasoningInput({
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'file contents',
    }),
    false
  );
  assert.equal(isStaleReasoningInput(null), false);
  assert.equal(isStaleReasoningInput('string'), false);
});

test('sanitizeResponsesInput purges stale reasoning and retains clean content parts', () => {
  const dirtyInput = [
    { role: 'user', content: 'What is in file.txt?' },
    { type: 'reasoning', id: 'r_stale_1', text: 'secret thoughts' },
    { encrypted_content: 'caller_unissued_token' },
    {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'intermediate thinking' },
        { type: 'output_text', text: 'Let me read that file for you.' },
      ],
    },
    {
      type: 'function_call',
      id: 'call_1',
      call_id: 'call_1',
      name: 'read',
      arguments: '{"path":"file.txt"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_1',
      output: 'file content here',
    },
  ];

  const cleaned = sanitizeResponsesInput(dirtyInput);
  assert.equal(cleaned.length, 4);
  assert.equal(cleaned[0].role, 'user');
  assert.equal(cleaned[1].role, 'assistant');
  // Content array in assistant message must retain output_text and have dropped reasoning part
  assert.deepEqual(cleaned[1].content, [{ type: 'output_text', text: 'Let me read that file for you.' }]);
  assert.equal(cleaned[2].type, 'function_call');
  assert.equal(cleaned[3].type, 'function_call_output');
});

test('buildResponsesInput pairs function_call and function_call_output properly with matching IDs and string outputs', () => {
  const formattedMessages = [
    { role: 'user', content: 'Run calculations' },
    {
      role: 'assistant',
      content: 'I will calculate 2+2 and format the result.',
      tool_calls: [
        {
          id: 'call_calc_99',
          type: 'function',
          function: { name: 'calculator', arguments: '{"expr":"2+2"}' },
        },
      ],
    },
    // Tool result as an object that was stringified
    {
      role: 'tool',
      tool_call_id: 'call_calc_99',
      content: '{"result":4}',
    },
    // Another tool result where content might have been non-string
    {
      role: 'tool',
      tool_call_id: 'call_calc_100',
      content: undefined,
    },
    {
      role: 'assistant',
      content: 'The calculation result is 4.',
    },
    {
      role: 'user',
      content: 'Great, thanks!',
    },
  ];

  const responsesInput = buildResponsesInput(formattedMessages);

  // User turn 0
  assert.deepEqual(responsesInput[0], { role: 'user', content: 'Run calculations' });

  // Assistant turn 1 (text + function_call)
  assert.deepEqual(responsesInput[1], {
    role: 'assistant',
    content: [{ type: 'output_text', text: 'I will calculate 2+2 and format the result.' }],
  });
  const fnCall = responsesInput[2];
  assert.equal(fnCall.type, 'function_call');
  assert.equal(fnCall.id, 'call_calc_99');
  assert.equal(fnCall.call_id, 'call_calc_99');
  assert.equal(fnCall.name, 'calculator');
  assert.equal(fnCall.arguments, '{"expr":"2+2"}');

  // Tool output turn 2
  const fnOutput1 = responsesInput[3];
  assert.equal(fnOutput1.type, 'function_call_output');
  assert.equal(fnOutput1.call_id, 'call_calc_99');
  assert.equal(typeof fnOutput1.output, 'string');
  assert.equal(fnOutput1.output, '{"result":4}');

  // Tool output turn 3 with undefined content -> must be string ""
  const fnOutput2 = responsesInput[4];
  assert.equal(fnOutput2.type, 'function_call_output');
  assert.equal(fnOutput2.call_id, 'call_calc_100');
  assert.equal(typeof fnOutput2.output, 'string');
  assert.equal(fnOutput2.output, '');

  // Assistant turn 4
  assert.deepEqual(responsesInput[5], {
    role: 'assistant',
    content: [{ type: 'output_text', text: 'The calculation result is 4.' }],
  });

  // User turn 5
  assert.deepEqual(responsesInput[6], { role: 'user', content: 'Great, thanks!' });
});


