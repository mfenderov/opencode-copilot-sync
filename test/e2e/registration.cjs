const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');

exports.run = async function () {
  await vscode.workspace.getConfiguration('opencode').update('autoSyncOnStartup', false, vscode.ConfigurationTarget.Global);
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.OPENCODE_API_KEY;
  process.env.OPENCODE_API_KEY = 'sk-isolated-registration-test';
  const requests = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/models')) {
      return new Response(JSON.stringify({ data: url.pathname.includes('/go/') ? [{ id: 'registration-test-model' }] : [] }));
    }
    if (url.hostname === 'models.opencode.ai' || url.hostname === 'models.dev') {
      return new Response(JSON.stringify({
        'opencode-go': { models: { 'registration-test-model': {
          provider: { npm: '@ai-sdk/openai' },
          limit: { context: 128000, output: 16000 },
          modalities: { input: ['text'], output: ['text'] }, reasoning: false,
        } } },
      }));
    }
    if (url.pathname.endsWith('/usage')) return new Response('{}', { status: 403 });
    if (url.pathname.endsWith('/responses')) {
      const headers = new Headers(init.headers);
      assert.ok(headers.get('x-opencode-session'), 'Go requires a session ID');
      requests.push({ session: headers.get('x-opencode-session'), body: JSON.parse(init.body) });
      const events = [
        { type: 'response.created', response: { id: 'resp_smoke', created_at: 1, model: 'registration-test-model' } },
        { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_smoke', role: 'assistant', content: [] } },
        { type: 'response.output_text.delta', item_id: 'msg_smoke', output_index: 0, content_index: 0, delta: 'Header received' },
        { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_smoke', role: 'assistant', content: [{ type: 'output_text', text: 'Header received', annotations: [] }] } },
        { type: 'response.completed', response: { id: 'resp_smoke', status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`Unexpected network access during isolated registration test: ${url.origin}${url.pathname}`);
  };
  try {
    const extension = vscode.extensions.getExtension('mfenderov.opencode-copilot-sync');
    assert.ok(extension);
    const api = await extension.activate();
    await api.performSync(false);

    const configPath = path.join(process.env.OPENCODE_REGISTRATION_TEST_USER_DATA, 'User', 'chatLanguageModels.json');
    const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '[]';
    assert.ok(!raw.includes('sk-isolated-registration-test'));
    assert.ok(!JSON.parse(raw).some((entry) => entry.name === 'OpenCode' && entry.vendor === 'customendpoint'), 'primary picker must not retain the headerless experiment');

    const models = await vscode.lm.selectChatModels({ vendor: 'opencode' });
    const model = models.find((entry) => entry.id === 'registration-test-model');
    assert.ok(model, `native model must be discoverable; got ${models.map((entry) => entry.id).join(', ')}`);
    assert.equal(model.maxInputTokens, 112000);
    assert.equal(api.chatProvider.provideLanguageModelChatInformation()[0].maxOutputTokens, 16000);
    const history = [vscode.LanguageModelChatMessage.User('first turn')];
    const cancel = new vscode.CancellationTokenSource();
    try {
      for (let i = 0; i < 2; i++) {
        const response = await model.sendRequest(history, {}, cancel.token);
        let text = '';
        for await (const part of response.text) text += part;
        assert.equal(text, 'Header received');
        history.push(vscode.LanguageModelChatMessage.Assistant(text), vscode.LanguageModelChatMessage.User('continue'));
      }
      const response = await model.sendRequest([vscode.LanguageModelChatMessage.User('a different chat')], {}, cancel.token);
      for await (const _part of response.text) { /* consume the response */ }
    } finally { cancel.dispose(); }
    assert.equal(requests.length, 3);
    assert.equal(requests[0].session, requests[1].session);
    assert.notEqual(requests[1].session, requests[2].session);
    console.log('[Registration E2E] PASS: model discovered, SDK text forwarded, conversation header stable across turns and different across chats.');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = originalKey;
  }
};
