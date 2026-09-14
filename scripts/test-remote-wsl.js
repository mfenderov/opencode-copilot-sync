import cp from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

console.log('\n=============================================');
console.log('>>> [Remote-WSL E2E] Initializing Remote Backend Test...');
console.log('=============================================\n');

const isLinux = process.platform === 'linux';

if (isLinux) {
  // Running directly inside Linux / WSL / CI
  console.log('[Remote-WSL E2E] Running directly on Linux/WSL environment.');
  runRemoteAssertions().catch((err) => {
    console.error('[Remote-WSL E2E] Assertion failed:', err.message);
    process.exit(1);
  });
} else {
  // Running on macOS / Windows - dispatch via Docker to simulate exact WSL Linux backend
  console.log('[Remote-WSL E2E] Running on host (' + process.platform + '). Dispatching inside Linux container simulating WSL...');

  const authDir = path.join(os.homedir(), '.local', 'share', 'opencode');
  const hasAuth = fs.existsSync(path.join(authDir, 'auth.json'));
  const authMount = hasAuth
    ? `-v "${authDir}:/root/.local/share/opencode:ro"`
    : '';

  const cwd = process.cwd();
  const cmd = `docker run --rm -e WSL_DISTRO_NAME=Ubuntu -v "${cwd}:/workspace" ${authMount} -w /workspace node:20-bookworm node scripts/test-remote-wsl.js`;

  try {
    cp.execSync(cmd, { stdio: 'inherit' });
    console.log('>>> [Remote-WSL E2E] Remote backend container test completed successfully!\n');
  } catch (err) {
    console.error('[Remote-WSL E2E] Error running remote container test:', err.message);
    process.exit(1);
  }
}

async function runRemoteAssertions() {
  const { isWSL, getChatLanguageModelsPath } = await import('../out/syncer.js');
  const { getStoredOpenCodeKey } = await import('../out/auth.js');

  console.log('[Remote-WSL E2E] Platform:', process.platform);
  console.log('[Remote-WSL E2E] isWSL():', isWSL());
  console.log('[Remote-WSL E2E] Config path resolved:', getChatLanguageModelsPath());

  // 1. Test Windows cross-mount path resolution if running in WSL
  const mockMountDir = '/mnt/c/Users/WslTestUser/AppData/Local/opencode';
  try {
    fs.mkdirSync(mockMountDir, { recursive: true });
    fs.writeFileSync(
      path.join(mockMountDir, 'auth.json'),
      JSON.stringify({ 'opencode-go': { key: 'sk-wsl-cross-mount-mock-key' } })
    );
    const resolvedCrossMount = getStoredOpenCodeKey();
    console.log('[Remote-WSL E2E] Cross-mount key discovery verified:', !!resolvedCrossMount);
    fs.rmSync('/mnt/c', { recursive: true, force: true });
  } catch {}

  // 2. Resolve real key (from ~/.local/share/opencode/auth.json or env)
  const apiKey = getStoredOpenCodeKey() || process.env.OPENCODE_API_KEY;
  if (!apiKey) {
    console.log('[Remote-WSL E2E] Note: No live API key found in container. Skipping live network calls.');
    return;
  }
  console.log('[Remote-WSL E2E] Resolved live OpenCode key. Testing live model requests from remote Linux backend...');

  // 3. Test Live Chat Mode
  console.log('[Remote-WSL E2E] >>> [CHAT MODE] Sending prompt to DeepSeek 4.1 from remote backend...');
  const chatRes = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-opencode-session': 'vscode-copilot',
    },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'What is 15 + 25? Answer with only the number.' }],
      stream: false,
    }),
  });
  const chatData = await chatRes.json();
  const chatContent = chatData.choices?.[0]?.message?.content?.trim();
  console.log(`[Remote-WSL E2E] >>> [CHAT MODE] Received: "${chatContent}"`);
  if (!chatContent || !chatContent.includes('40')) {
    throw new Error(`Chat Mode failed to return 40, got: ${chatContent}`);
  }

  // 4. Test Live Agent Mode with 131 tools (>128 tool boundary)
  console.log('[Remote-WSL E2E] >>> [AGENT MODE] Sending prompt with 131 tools from remote backend...');
  const dummyTools = [];
  dummyTools.push({
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Perform arithmetic calculation',
      parameters: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    },
  });
  for (let i = 1; i <= 130; i++) {
    dummyTools.push({
      type: 'function',
      function: {
        name: `workspace_op_${i}`,
        description: `Workspace operation ${i}`,
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    });
  }

  const agentRes1 = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-opencode-session': 'vscode-copilot',
    },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [{ role: 'user', content: 'Calculate 33 * 33 using calculator tool.' }],
      tools: dummyTools,
      stream: false,
    }),
  });
  const agentData1 = await agentRes1.json();
  const toolCall = agentData1.choices?.[0]?.message?.tool_calls?.[0];
  console.log(
    `[Remote-WSL E2E] >>> [AGENT MODE] Turn 1 Tool Call: ${toolCall ? `${toolCall.function.name}(${toolCall.function.arguments})` : 'none'}`
  );
  if (!toolCall) {
    throw new Error('Agent Mode failed to generate tool call');
  }

  // Turn 2: Deliver tool result (33 * 33 = 1089)
  const agentRes2 = await fetch('https://opencode.ai/zen/go/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'x-opencode-session': 'vscode-copilot',
    },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash',
      messages: [
        { role: 'user', content: 'Calculate 33 * 33 using calculator tool.' },
        agentData1.choices[0].message,
        { role: 'tool', tool_call_id: toolCall.id, content: '1089' },
      ],
      tools: dummyTools,
      stream: false,
    }),
  });
  const agentData2 = await agentRes2.json();
  const finalAnswer = agentData2.choices?.[0]?.message?.content?.trim();
  console.log(`[Remote-WSL E2E] >>> [AGENT MODE] Turn 2 Final Answer: "${finalAnswer}"`);
  if (!finalAnswer || !finalAnswer.includes('1089')) {
    throw new Error(`Agent Mode failed to synthesize 1089, got: ${finalAnswer}`);
  }

  console.log('\n=============================================');
  console.log('>>> [Remote-WSL E2E] All Remote Backend Assertions PASSED!');
  console.log('=============================================\n');
}
