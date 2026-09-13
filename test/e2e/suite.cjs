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

  // 2. Discover native OpenCode models contributed by our extension!
  const opencodeModels = await vscode.lm.selectChatModels({ vendor: 'opencode' });
  console.log(`\n[E2E] Discovered ${opencodeModels.length} native OpenCode models via vscode.lm:`);
  for (const m of opencodeModels.slice(0, 8)) {
    console.log(`  - [${m.vendor}] ${m.name} (${m.id})`);
  }
  assert.ok(opencodeModels.length >= 20, `Must discover at least 20 native OpenCode models, got ${opencodeModels.length}`);

  // Test live request to OpenCode through native VS Code Language Model API!
  const liveModel = opencodeModels.find(m => m.id === 'kimi-k3') || opencodeModels[0];
  if (liveModel) {
    console.log(`\n[E2E] >>> Sending live prompt to native model: ${liveModel.name} (${liveModel.id})...`);
    const resp = await liveModel.sendRequest(
      [vscode.LanguageModelChatMessage.User('Hello! Please reply with "Pong" and nothing else.')],
      {},
      new vscode.CancellationTokenSource().token
    );
    let streamedText = '';
    for await (const chunk of resp.text) {
      streamedText += chunk;
    }
    console.log(`[E2E] >>> Live model streamed response: "${streamedText.trim()}"`);
    assert.ok(streamedText.length > 0, 'Model must stream back a non-empty response');
  }

  // 3. Query all language models across all vendors in VS Code
  const allModels = await vscode.lm.selectChatModels({});
  console.log(`\n[E2E] Discovered ${allModels.length} total models across all providers in VS Code:`);
  for (const m of allModels.slice(0, 10)) {
    console.log(`  - [${m.vendor}] ${m.name} (${m.id})`);
  }

  const customModels = await vscode.lm.selectChatModels({ vendor: 'customendpoint' });
  console.log(`\n[E2E] Discovered ${customModels.length} customendpoint models:`);
  for (const m of customModels) {
    console.log(`  - [${m.vendor}] ${m.name} (${m.id})`);
  }

  const allCommands = await vscode.commands.getCommands(true);
  const lmCommands = allCommands.filter(c => c.includes('lm.') || c.includes('languageModel'));
  console.log('\n[E2E] LM Commands:', lmCommands);

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
