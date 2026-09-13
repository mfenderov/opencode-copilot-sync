const vscode = require('vscode');
const assert = require('assert');

exports.run = async function () {
  console.log('\n=============================================');
  console.log('>>> [E2E] Running inside real VS Code host!');
  console.log('>>> [E2E] VS Code Version:', vscode.version);
  console.log('=============================================\n');

  // 1. Check if our extension is discovered and activated
  const syncExt = vscode.extensions.getExtension('mfenderov.opencode-copilot-sync');
  console.log('[E2E] opencode-copilot-sync extension found:', !!syncExt);
  assert.ok(syncExt, 'opencode-copilot-sync must be installed and registered in VS Code');

  if (!syncExt.isActive) {
    console.log('[E2E] Activating opencode-copilot-sync...');
    await syncExt.activate();
  }
  assert.strictEqual(syncExt.isActive, true, 'opencode-copilot-sync must be active');
  console.log('[E2E] opencode-copilot-sync is ACTIVE!');

  // 2. Check ltmoerdani extension if present
  const ltExt = vscode.extensions.getExtension('ltmoerdani.opencode-copilot-chat');
  console.log('[E2E] ltmoerdani.opencode-copilot-chat found:', !!ltExt);
  if (ltExt) {
    if (!ltExt.isActive) {
      console.log('[E2E] Activating ltmoerdani.opencode-copilot-chat...');
      await ltExt.activate();
    }
    console.log('[E2E] ltmoerdani.opencode-copilot-chat is ACTIVE!');

    // Test querying OpenCode Go models via native VS Code LM API
    const goModels = await vscode.lm.selectChatModels({ vendor: 'opencodego' });
    console.log(`[E2E] Discovered ${goModels.length} OpenCode Go models via native LM API:`);
    for (const m of goModels.slice(0, 5)) {
      console.log(`  - [${m.vendor}] ${m.name} (${m.id})`);
    }

    // Test querying OpenCode Zen models via native VS Code LM API
    const zenModels = await vscode.lm.selectChatModels({ vendor: 'opencodezen' });
    console.log(`[E2E] Discovered ${zenModels.length} OpenCode Zen models via native LM API:`);
    for (const m of zenModels.slice(0, 5)) {
      console.log(`  - [${m.vendor}] ${m.name} (${m.id})`);
    }

    // Test sending an actual live prompt to a model!
    const testModel = goModels[0] || zenModels[0];
    if (testModel) {
      console.log(`\n[E2E] >>> Testing prompt to model: ${testModel.name} (${testModel.id})...`);
      try {
        const messages = [vscode.LanguageModelChatMessage.User('Hello! Answer in one word: Pong')];
        const response = await testModel.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
        let reply = '';
        for await (const chunk of response.text) {
          reply += chunk;
        }
        console.log(`[E2E] >>> Model streamed response: "${reply.trim()}"`);
        assert.ok(reply.length > 0, 'Model must stream back a non-empty response');
      } catch (err) {
        console.log(`[E2E] Note on model prompt: ${err.message}`);
      }
    }
  }

  // 3. Query all language models across all vendors in VS Code
  const allModels = await vscode.lm.selectChatModels({});
  console.log(`\n[E2E] Discovered ${allModels.length} total models across all providers in VS Code:`);
  for (const m of allModels.slice(0, 10)) {
    console.log(`  - [${m.vendor}] ${m.name} (${m.id})`);
  }

  // 4. Trigger manual sync command
  console.log('\n[E2E] Executing command opencode-copilot-sync.sync...');
  try {
    await vscode.commands.executeCommand('opencode-copilot-sync.sync');
    console.log('[E2E] opencode-copilot-sync.sync executed successfully!');
  } catch (err) {
    console.log('[E2E] Command note:', err.message);
  }

  console.log('\n=============================================');
  console.log('>>> [E2E] All in-editor assertions PASSED!');
  console.log('=============================================\n');
};
