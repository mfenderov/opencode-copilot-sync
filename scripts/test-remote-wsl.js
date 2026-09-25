import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import testRuntime from "./test-runtime.cjs";

const {
  createRemoteWslSandbox,
  getExplicitApiKey,
  isOfflineTestRun,
  shouldRunLiveChecks,
} = testRuntime;

console.log("\n=============================================");
console.log(">>> [Remote-WSL E2E] Initializing Remote Backend Test...");
console.log("=============================================\n");

const isLinux = process.platform === "linux";
const forceOffline = isOfflineTestRun();

async function withRetry(fn, { attempts = 3, delayMs = 1500, label = "operation" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) {
        console.warn(
          "[Remote-WSL E2E] >>> " + label + " failed on attempt " + attempt + "/" + attempts + ": " + err.message + ". Retrying in " + delayMs + "ms..."
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        delayMs *= 2;
      }
    }
  }
  throw new Error(label + " failed after " + attempts + " attempts: " + lastErr.message);
}

if (isLinux) {
  process.env.WSL_DISTRO_NAME = process.env.WSL_DISTRO_NAME || "Ubuntu";
  console.log("[Remote-WSL E2E] Running directly on Linux/WSL environment (simulated distro: " + process.env.WSL_DISTRO_NAME + ").");
  runRemoteAssertions({ forceOffline }).catch((err) => {
    console.error("[Remote-WSL E2E] Assertion failed:", err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
  });
} else {
  console.log("[Remote-WSL E2E] Running on host (" + process.platform + "). Dispatching inside Linux container simulating WSL...");

  const workspaceMount = `${process.cwd()}:/workspace`;
  console.log("[Remote-WSL E2E] --- Phase 1: Validating WSL filesystem behavior in OFFLINE mode ---");
  let offlinePassed = false;
  try {
    cp.execFileSync(
      "docker",
      [
        "run",
        "--rm",
        "-e",
        "WSL_DISTRO_NAME=Ubuntu",
        "-e",
        "OPENCODE_OFFLINE=1",
        "-v",
        workspaceMount,
        "-w",
        "/workspace",
        "node:20-bookworm",
        "node",
        "scripts/test-remote-wsl.js",
        "--offline",
      ],
      { stdio: "inherit" }
    );
    offlinePassed = true;
    console.log("[Remote-WSL E2E] Offline topology, mirror, permissions, and schema checks PASSED.\n");
  } catch (err) {
    console.error("[Remote-WSL E2E] Error running offline container test:", err.message);
    process.exitCode = 1;
  }

  if (offlinePassed && shouldRunLiveChecks()) {
    console.log("[Remote-WSL E2E] --- Phase 2: Explicit OPENCODE_API_KEY supplied. Testing live network completions ---");
    try {
      cp.execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-e",
          "WSL_DISTRO_NAME=Ubuntu",
          "-e",
          "OPENCODE_API_KEY",
          "-v",
          workspaceMount,
          "-w",
          "/workspace",
          "node:20-bookworm",
          "node",
          "scripts/test-remote-wsl.js",
        ],
        { stdio: "inherit" }
      );
      console.log(">>> [Remote-WSL E2E] All Remote backend container tests (Offline + Live) completed successfully!\n");
    } catch (err) {
      console.error("[Remote-WSL E2E] Error running live container test:", err.message);
      process.exitCode = 1;
    }
  } else if (offlinePassed) {
    const reason = forceOffline ? "--offline flag provided." : "No explicit OPENCODE_API_KEY provided.";
    console.log("[Remote-WSL E2E] Note: Skipping Phase 2 (Live network calls). Reason: " + reason);
    console.log(">>> [Remote-WSL E2E] Remote backend container test completed successfully!\n");
  }
}

async function runRemoteAssertions({ forceOffline: offlineRequested = false } = {}) {
  const {
    isWSL,
    getChatLanguageModelsPath,
    getAllChatLanguageModelsPaths,
  } = await import("../out/sync-targets.js");
  const {
    safeWriteFileSync,
    createBackup,
    readChatLanguageModels,
  } = await import("../out/sync-files.js");
  const {
    writeProvidersToConfig,
  } = await import("../out/sync-writer.js");
  const { buildProviderEntry } = await import("../out/config.js");
  const sandbox = createRemoteWslSandbox();
  const home = sandbox.homeDir;
  const activeStoragePath = path.join(
    home,
    ".vscode-server",
    "data",
    "User",
    "globalStorage",
    "mfenderov.opencode-copilot-sync"
  );
  const primaryPath = path.join(home, ".vscode-server", "data", "User", "chatLanguageModels.json");
  const associatedWslConfigPath = path.join(
    sandbox.associatedWslHome,
    ".vscode-server",
    "data",
    "User",
    "chatLanguageModels.json"
  );
  const windowsProfileConfigPath = path.join(
    sandbox.windowsProfile,
    "AppData",
    "Roaming",
    "Code",
    "User",
    "chatLanguageModels.json"
  );
  const siblingWslConfigPath = path.join(
    sandbox.siblingWslHome,
    ".vscode-server",
    "data",
    "User",
    "chatLanguageModels.json"
  );
  const discoveryContext = {
    platform: "linux",
    homeDir: home,
    isWsl: true,
    associatedWslHome: sandbox.associatedWslHome,
  };

  try {
    fs.mkdirSync(activeStoragePath, { recursive: true });
    for (const dir of [
      path.join(home, ".vscode-server", "data", "User"),
      path.join(home, ".vscode-server", "data", "Machine"),
      path.join(home, ".vscode-server-insiders", "data", "User"),
      path.join(home, ".vscode-server-insiders", "data", "Machine"),
      path.join(sandbox.associatedWslHome, ".vscode-server", "data", "User"),
      path.dirname(windowsProfileConfigPath),
      path.dirname(siblingWslConfigPath),
      path.join(sandbox.root, "home", "other-user", ".vscode-server", "data", "User"),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    console.log("[Remote-WSL E2E] Platform:", process.platform);
    console.log("[Remote-WSL E2E] isWSL():", isWSL());
    assert.equal(isWSL(), true, "Expected isWSL() to return true in WSL environment");

    console.log("\n[Remote-WSL E2E] >>> [1/4] Testing isolated WSL path discovery and resolution...");
    const candidatePaths = getAllChatLanguageModelsPaths(activeStoragePath, discoveryContext);
    const expectedServerPaths = [
      path.join(home, ".vscode-server", "data", "User", "chatLanguageModels.json"),
      path.join(home, ".vscode-server", "data", "Machine", "chatLanguageModels.json"),
      path.join(home, ".vscode-server-insiders", "data", "User", "chatLanguageModels.json"),
      path.join(home, ".vscode-server-insiders", "data", "Machine", "chatLanguageModels.json"),
    ];
    for (const expectedPath of expectedServerPaths) {
      assert.ok(candidatePaths.includes(expectedPath), "Expected current-user target: " + expectedPath);
    }
    assert.ok(candidatePaths.includes(associatedWslConfigPath), "Expected associated WSL target to be discovered.");
    assert.ok(!candidatePaths.includes(siblingWslConfigPath), "Sibling WSL distro must not be discovered by default.");
    assert.ok(
      !candidatePaths.some((candidate) => candidate.startsWith(path.join(sandbox.root, "home", "other-user"))),
      "Another user's home must not be discovered."
    );

    const pathCases = [
      {
        storage: activeStoragePath,
        expected: primaryPath,
        label: ".vscode-server User",
      },
      {
        storage: path.join(home, ".vscode-server", "data", "Machine", "globalStorage", "mfenderov.opencode-copilot-sync"),
        expected: path.join(home, ".vscode-server", "data", "Machine", "chatLanguageModels.json"),
        label: ".vscode-server Machine",
      },
      {
        storage: path.join(home, ".vscode-server-insiders", "data", "User", "globalStorage", "mfenderov.opencode-copilot-sync"),
        expected: path.join(home, ".vscode-server-insiders", "data", "User", "chatLanguageModels.json"),
        label: ".vscode-server-insiders User",
      },
      {
        storage: path.join(home, ".vscode-server-insiders", "data", "Machine", "globalStorage", "mfenderov.opencode-copilot-sync"),
        expected: path.join(home, ".vscode-server-insiders", "data", "Machine", "chatLanguageModels.json"),
        label: ".vscode-server-insiders Machine",
      },
    ];
    for (const testCase of pathCases) {
      assert.equal(getChatLanguageModelsPath(testCase.storage), testCase.expected, `Failed path resolution for ${testCase.label}`);
    }
    assert.equal(
      getChatLanguageModelsPath(undefined, discoveryContext),
      primaryPath,
      "Default WSL path must resolve under this run's isolated home."
    );
    console.log("[Remote-WSL E2E] ✓ WSL and Insiders paths remain inside the isolated current-user fixture.");

    console.log("\n[Remote-WSL E2E] >>> [2/4] Testing target-local secret references and per-target merge behavior...");
    const secretReference = "${input:chat.lm.secret.7f3a2c91}";
    const sourceOnlyKey = "sk-source-only-mirror-test";
    const primaryInitial = [
      { name: "HF Router", vendor: "customendpoint", models: [{ id: "hf-model" }] },
      { name: "OpenCode", vendor: "customendpoint", apiKey: "sk-old-primary-test-key", models: [{ id: "old-model" }] },
    ];
    const mirrorInitial = [
      { name: "HF Router", vendor: "customendpoint", models: [{ id: "hf-model" }] },
      { name: "OpenCode", vendor: "customendpoint", apiKey: secretReference, models: [{ id: "old-model" }] },
    ];
    fs.writeFileSync(primaryPath, JSON.stringify(primaryInitial, null, 2), "utf-8");
    fs.writeFileSync(associatedWslConfigPath, JSON.stringify(mirrorInitial, null, 2), "utf-8");
    fs.writeFileSync(windowsProfileConfigPath, JSON.stringify(mirrorInitial, null, 2), "utf-8");
    fs.writeFileSync(siblingWslConfigPath, JSON.stringify(mirrorInitial, null, 2), "utf-8");
    const siblingOriginal = fs.readFileSync(siblingWslConfigPath, "utf-8");

    const provider = buildProviderEntry("OpenCode", sourceOnlyKey, ["kimi-k3"], { isGo: true });
    const mirrorResult = writeProvidersToConfig([provider], primaryPath, activeStoragePath, {
      additionalTargetPaths: [associatedWslConfigPath, windowsProfileConfigPath],
      discoveryContext,
    });
    assert.deepEqual(mirrorResult.warnings, []);

    const primaryConfig = readChatLanguageModels(primaryPath);
    assert.deepEqual(primaryConfig.map((entry) => entry.name), ["HF Router"]);
    for (const mirrorPath of [associatedWslConfigPath, windowsProfileConfigPath]) {
      const mirrored = readChatLanguageModels(mirrorPath);
      assert.deepEqual(mirrored.map((entry) => entry.name), ["HF Router", "OpenCode"]);
      assert.deepEqual(mirrored[0].models, [{ id: "hf-model" }]);
      assert.equal(mirrored[1].apiKey, secretReference);
      assert.equal(mirrored[1].models[0].id, "kimi-k3");
      assert.doesNotMatch(fs.readFileSync(mirrorPath, "utf-8"), new RegExp(sourceOnlyKey));
    }
    assert.equal(fs.readFileSync(siblingWslConfigPath, "utf-8"), siblingOriginal);
    console.log("[Remote-WSL E2E] ✓ Mirrors merge only OpenCode, preserve unrelated providers and target-local secrets.");

    console.log("\n[Remote-WSL E2E] >>> [3/4] Testing permissions, atomic writes, and backup rotation...");
    const scratchDir = path.join(sandbox.root, "file-tests");
    fs.mkdirSync(scratchDir, { recursive: true });
    const securePath = path.join(scratchDir, "secure-credentials.json");
    safeWriteFileSync(securePath, "{\"key\": \"secret\"}", 0o600);
    assert.equal(fs.statSync(securePath).mode & 0o777, 0o600);

    const publicPath = path.join(scratchDir, "public-config.json");
    safeWriteFileSync(publicPath, "{\"public\": true}", 0o644);
    assert.equal(fs.statSync(publicPath).mode & 0o777, 0o644);

    const nestedFile = path.join(scratchDir, "sub", "nested", "models.json");
    safeWriteFileSync(nestedFile, "{\"version\": 1}", 0o644);
    safeWriteFileSync(nestedFile, "{\"version\": 2}", 0o644);
    assert.equal(fs.readFileSync(nestedFile, "utf-8"), "{\"version\": 2}");
    assert.equal(fs.readdirSync(path.dirname(nestedFile)).filter((file) => file.includes(".tmp")).length, 0);

    const backupTarget = path.join(scratchDir, "backup-subject.json");
    fs.writeFileSync(backupTarget, "initial content", "utf-8");
    const firstBackup = createBackup(backupTarget);
    assert.ok(firstBackup && fs.existsSync(firstBackup));
    assert.equal(fs.readFileSync(firstBackup, "utf-8"), "initial content");
    for (let index = 1; index <= 5; index++) {
      fs.writeFileSync(backupTarget, "content generation " + index, "utf-8");
      createBackup(backupTarget);
    }
    assert.equal(
      fs.readdirSync(scratchDir).filter((file) => file.startsWith("backup-subject.json.bak-")).length,
      3
    );
    console.log("[Remote-WSL E2E] ✓ File permissions, atomic writes, and backup rotation validated.");

    console.log("\n[Remote-WSL E2E] >>> [4/4] Testing provider schema and protocol mappings...");
    const modelIds = [
      "muse-spark-1.3-contributor-free",
      "deepseek-v4-flash",
      "kimi-k3",
      "claude-sonnet-4-6",
    ];
    const generatedProvider = buildProviderEntry("OpenCode", "sk-wsl-schema-test", modelIds, { isGo: true });
    const schemaPath = path.join(sandbox.root, "schema-target", "chatLanguageModels.json");
    fs.mkdirSync(path.dirname(schemaPath), { recursive: true });
    fs.writeFileSync(
      schemaPath,
      JSON.stringify(
        [{ name: "OpenCode", vendor: "customendpoint", apiKey: secretReference, models: [] }],
        null,
        2
      ),
      "utf-8"
    );
    writeProvidersToConfig([generatedProvider], schemaPath, activeStoragePath);

    const parsedConfig = readChatLanguageModels(schemaPath);
    assert.equal(parsedConfig.length, 1);
    const openCodeProvider = parsedConfig[0];
    assert.equal(openCodeProvider.name, "OpenCode");
    assert.equal(openCodeProvider.vendor, "customendpoint");
    assert.equal(openCodeProvider.apiKey, secretReference);
    assert.doesNotMatch(fs.readFileSync(schemaPath, "utf-8"), /sk-wsl-schema-test/);
    assert.equal(openCodeProvider.apiType, "chat-completions");

    const museModel = openCodeProvider.models.find((model) => model.id === "muse-spark-1.3-contributor-free");
    assert.ok(museModel, "Muse model not found in OpenCode models");
    assert.equal(museModel.apiType, "responses");
    assert.equal(museModel.url, "https://opencode.ai/zen/go/v1");
    assert.equal(museModel.toolCalling, true);

    const deepseekModel = openCodeProvider.models.find((model) => model.id === "deepseek-v4-flash");
    assert.ok(deepseekModel, "DeepSeek model not found in OpenCode models");
    assert.equal(deepseekModel.apiType, "chat-completions");
    assert.equal(deepseekModel.url, "https://opencode.ai/zen/go/v1/chat/completions");
    assert.equal(deepseekModel.thinking, true);

    const kimiModel = openCodeProvider.models.find((model) => model.id === "kimi-k3");
    assert.ok(kimiModel, "Kimi model not found in OpenCode models");
    assert.equal(kimiModel.apiType, "chat-completions");
    assert.equal(kimiModel.url, "https://opencode.ai/zen/go/v1/chat/completions");
    assert.equal(kimiModel.vision, true);

    const claudeModel = openCodeProvider.models.find((model) => model.id === "claude-sonnet-4-6");
    assert.ok(claudeModel, "Claude model not found");
    assert.equal(claudeModel.apiType, "messages");
    assert.equal(claudeModel.url, "https://opencode.ai/zen/go/v1");

    for (const model of openCodeProvider.models) {
      assert.deepEqual(model.requestHeaders, { "x-opencode-session": "vscode-copilot" });
      assert.ok(typeof model.contextWindow === "number" && model.contextWindow > 0);
      assert.ok(typeof model.maxInputTokens === "number" && model.maxInputTokens > 0);
      assert.ok(typeof model.maxOutputTokens === "number" && model.maxOutputTokens > 0);
    }
    console.log("[Remote-WSL E2E] ✓ Provider protocols, model options, and target-local secret references validated.");
  } finally {
    sandbox.cleanup();
  }

  const liveApiKey = getExplicitApiKey();
  if (offlineRequested || forceOffline || !shouldRunLiveChecks() || !liveApiKey) {
    console.log("[Remote-WSL E2E] [OFFLINE MODE] No explicit live API request was enabled.");
    console.log("[Remote-WSL E2E] [OFFLINE MODE] Skipping live network calls. All offline assertions PASSED.");
    return;
  }

  await runLiveNetworkAssertions(liveApiKey);
}

async function runLiveNetworkAssertions(liveApiKey) {
  console.log("[Remote-WSL E2E] >>> [5/5] Explicit API key detected. Testing live model requests from remote Linux backend...");
  const authHeader = "Bearer " + liveApiKey;

  console.log("[Remote-WSL E2E] >>> [CHAT MODE] Sending prompt to Kimi K3 from remote backend...");
  await withRetry(
    async () => {
      const chatRes = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          "User-Agent": "opencode/1.18.30",
          "x-opencode-session": "vscode-copilot",
        },
        body: JSON.stringify({
          model: "kimi-k3",
          messages: [{ role: "user", content: "What is 15 + 25? Answer with only the number." }],
          stream: false,
        }),
      });
      const chatData = await chatRes.json();
      const chatContent = chatData.choices?.[0]?.message?.content?.trim() || chatData.choices?.[0]?.message?.reasoning_content?.trim();
      if (!chatContent || !chatContent.includes("40")) {
        throw new Error("Chat Mode failed to return 40, got: " + chatContent);
      }
    },
    { label: "Chat Mode (Kimi K3)" }
  );

  const dummyTools = [
    {
      type: "function",
      function: {
        name: "calculator",
        description: "Perform arithmetic calculation",
        parameters: {
          type: "object",
          properties: { expression: { type: "string" } },
          required: ["expression"],
        },
      },
    },
  ];
  for (let index = 1; index <= 130; index++) {
    dummyTools.push({
      type: "function",
      function: {
        name: "workspace_op_" + index,
        description: "Workspace operation " + index,
        parameters: { type: "object", properties: { q: { type: "string" } } },
      },
    });
  }

  const toolCall = await withRetry(
    async () => {
      const response = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          "User-Agent": "opencode/1.18.30",
          "x-opencode-session": "vscode-copilot",
        },
        body: JSON.stringify({
          model: "kimi-k3",
          messages: [{ role: "user", content: "Calculate 33 * 33 using calculator tool." }],
          tools: dummyTools,
          stream: false,
        }),
      });
      const data = await response.json();
      const call = data.choices?.[0]?.message?.tool_calls?.[0];
      if (!call) throw new Error("Agent Mode failed to generate tool call");
      return call;
    },
    { label: "Agent Mode Turn 1 (tool call)" }
  );

  await withRetry(
    async () => {
      const response = await fetch("https://opencode.ai/zen/go/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          "User-Agent": "opencode/1.18.30",
          "x-opencode-session": "vscode-copilot",
        },
        body: JSON.stringify({
          model: "kimi-k3",
          messages: [
            { role: "user", content: "Calculate 33 * 33 using calculator tool." },
            { role: "assistant", tool_calls: [toolCall] },
            { role: "tool", tool_call_id: toolCall.id, content: "1089" },
          ],
          tools: dummyTools,
          stream: false,
        }),
      });
      const data = await response.json();
      const answer = data.choices?.[0]?.message?.content?.trim();
      if (!answer || !answer.includes("1089")) {
        throw new Error("Agent Mode failed to return 1089, got: " + answer);
      }
    },
    { label: "Agent Mode Turn 2 (final answer)" }
  );

  await withRetry(
    async () => {
      const response = await fetch("https://opencode.ai/zen/v1/responses", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
          "User-Agent": "opencode/1.18.30",
          "x-opencode-session": "vscode-copilot",
        },
        body: JSON.stringify({
          model: "muse-spark-1.3-contributor-free",
          input: [{ role: "user", content: "What is 5 + 7? Give only the number." }],
          stream: false,
        }),
      });
      const data = await response.json();
      const message = data.output?.find((item) => item.type === "message");
      const text = message?.content?.[0]?.text?.trim();
      if (!text || !text.includes("12")) {
        throw new Error("Responses API failed to return 12, got: " + text);
      }
    },
    { label: "Responses API (Muse Spark 1.3)" }
  );

  console.log("\n=============================================");
  console.log(">>> [Remote-WSL E2E] Live network assertions PASSED!");
  console.log("=============================================\n");
}
