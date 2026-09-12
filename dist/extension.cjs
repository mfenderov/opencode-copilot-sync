"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/extension.ts
var extension_exports = {};
__export(extension_exports, {
  activate: () => activate,
  deactivate: () => deactivate
});
module.exports = __toCommonJS(extension_exports);
var vscode = __toESM(require("vscode"), 1);

// src/auth.ts
var fs = __toESM(require("node:fs"), 1);
var path = __toESM(require("node:path"), 1);
var os = __toESM(require("node:os"), 1);
var SECRET_KEY = "opencode_api_key";
function getStoredOpenCodeKey(customPath) {
  if (customPath) {
    try {
      if (fs.existsSync(customPath)) {
        const raw = fs.readFileSync(customPath, "utf-8");
        const data = JSON.parse(raw);
        const key = data["opencode-go"]?.key || data["opencode"]?.key;
        if (typeof key === "string" && key.trim().length > 0) {
          return key.trim();
        }
      }
    } catch {
    }
    return null;
  }
  const candidatePaths = [];
  candidatePaths.push(path.join(os.homedir(), ".local", "share", "opencode", "auth.json"));
  if (process.platform === "win32") {
    for (const prefix of ["\\\\wsl.localhost", "\\\\wsl$"]) {
      try {
        if (fs.existsSync(prefix)) {
          const distros = fs.readdirSync(prefix);
          for (const distro of distros) {
            const homeDir = path.join(prefix, distro, "home");
            if (fs.existsSync(homeDir)) {
              for (const u of fs.readdirSync(homeDir)) {
                candidatePaths.push(path.join(homeDir, u, ".local", "share", "opencode", "auth.json"));
              }
            }
          }
        }
      } catch {
      }
    }
  }
  if (process.platform === "linux" && fs.existsSync("/mnt/c/Users")) {
    try {
      for (const u of fs.readdirSync("/mnt/c/Users")) {
        candidatePaths.push(path.join("/mnt/c/Users", u, ".local", "share", "opencode", "auth.json"));
      }
    } catch {
    }
  }
  for (const authPath of candidatePaths) {
    try {
      if (fs.existsSync(authPath)) {
        const raw = fs.readFileSync(authPath, "utf-8");
        const data = JSON.parse(raw);
        const key = data["opencode-go"]?.key || data["opencode"]?.key;
        if (typeof key === "string" && key.trim().length > 0) {
          return key.trim();
        }
      }
    } catch {
    }
  }
  return null;
}
async function resolveApiKey(secrets, promptIfMissing = true, vscodeWindow) {
  const stored = await secrets.get(SECRET_KEY);
  if (stored && stored.trim().length > 0) {
    return stored.trim();
  }
  const autoFound = getStoredOpenCodeKey();
  if (autoFound) {
    await secrets.store(SECRET_KEY, autoFound);
    return autoFound;
  }
  if (promptIfMissing && vscodeWindow) {
    const entered = await vscodeWindow.showInputBox({
      title: "OpenCode API Key",
      prompt: "Enter your OpenCode API Key (starts with sk-)",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (!value || value.trim().length === 0) {
          return "API Key cannot be empty";
        }
        if (!value.trim().startsWith("sk-")) {
          return "OpenCode API keys typically start with sk-";
        }
        return null;
      }
    });
    if (entered && entered.trim().length > 0) {
      const cleanKey = entered.trim();
      await secrets.store(SECRET_KEY, cleanKey);
      return cleanKey;
    }
  }
  return void 0;
}
async function promptAndSetApiKey(secrets, vscodeWindow) {
  const currentKey = await secrets.get(SECRET_KEY);
  const entered = await vscodeWindow.showInputBox({
    title: "OpenCode API Key",
    prompt: "Enter your OpenCode API Key (starts with sk-)",
    value: currentKey || "",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => {
      if (!value || value.trim().length === 0) {
        return "API Key cannot be empty";
      }
      return null;
    }
  });
  if (entered && entered.trim().length > 0) {
    const cleanKey = entered.trim();
    await secrets.store(SECRET_KEY, cleanKey);
    return cleanKey;
  }
  return void 0;
}

// src/syncer.ts
var fs2 = __toESM(require("node:fs"), 1);
var path2 = __toESM(require("node:path"), 1);
var os2 = __toESM(require("node:os"), 1);

// src/enricher.ts
function formatModelName(id, suffix = "(OpenCode)") {
  const parts = id.split(/[-_]/);
  const title = parts.map((p) => {
    const lower = p.toLowerCase();
    if (lower === "glm") return "GLM";
    if (lower === "gpt") return "GPT";
    if (lower === "mimo") return "MiMo";
    if (lower === "qwen") return "Qwen";
    if (lower === "kimi") return "Kimi";
    if (lower === "minimax") return "MiniMax";
    if (lower === "deepseek") return "DeepSeek";
    if (/^v\d+/i.test(p)) return p.toUpperCase();
    return p.charAt(0).toUpperCase() + p.slice(1);
  }).join(" ");
  return `${title} ${suffix}`;
}
function enrichModel(modelId, options = {}) {
  const isGo = options.isGo ?? true;
  const isFree = options.isFree ?? false;
  const baseUrl = isGo ? "https://opencode.ai/zen/go/v1/chat/completions" : "https://opencode.ai/zen/v1/chat/completions";
  const suffix = isFree ? "(Zen Free)" : "(OpenCode)";
  const name = formatModelName(modelId, suffix);
  const lower = modelId.toLowerCase();
  let contextWindow = 1048576;
  let maxOutputTokens = 65536;
  let vision = false;
  let thinking = true;
  if (lower.includes("deepseek")) {
    contextWindow = 1048576;
    maxOutputTokens = 131072;
    vision = lower.includes("vision");
  } else if (lower.includes("glm")) {
    contextWindow = 1048576;
    maxOutputTokens = 131072;
    vision = true;
  } else if (lower.includes("kimi")) {
    contextWindow = 1048576;
    maxOutputTokens = 65536;
    vision = true;
  } else if (lower.includes("qwen")) {
    contextWindow = 1e6;
    maxOutputTokens = 131072;
    vision = true;
  } else if (lower.includes("minimax")) {
    contextWindow = 1048576;
    maxOutputTokens = 131072;
    vision = false;
  } else if (lower.includes("claude")) {
    if (lower.includes("haiku")) {
      contextWindow = 2e5;
      maxOutputTokens = 64e3;
      thinking = false;
    } else {
      contextWindow = 1e6;
      maxOutputTokens = 128e3;
    }
    vision = true;
  } else if (lower.includes("gpt")) {
    if (lower.includes("mini") || lower.includes("nano")) {
      contextWindow = 128e3;
      maxOutputTokens = 16384;
    } else {
      contextWindow = 1e6;
      maxOutputTokens = 128e3;
    }
    vision = true;
  } else if (lower.includes("mimo")) {
    contextWindow = 1048576;
    maxOutputTokens = 65536;
    vision = lower.includes("omni");
  } else if (lower.includes("nemotron")) {
    contextWindow = 1e6;
    maxOutputTokens = 128e3;
    vision = false;
  } else if (lower.includes("muse")) {
    contextWindow = 1e6;
    maxOutputTokens = 65536;
    vision = false;
  } else if (lower.includes("longcat")) {
    contextWindow = 1048576;
    maxOutputTokens = 65536;
    vision = false;
  }
  const maxInputTokens = contextWindow - maxOutputTokens;
  const model = {
    id: modelId,
    name,
    url: baseUrl,
    apiType: "chat-completions",
    toolCalling: true,
    vision,
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
    editTools: ["find-replace", "multi-find-replace", "apply-patch", "code-rewrite"],
    thinking,
    supportsReasoningEffort: thinking ? ["low", "medium", "high", "xhigh", "max"] : void 0,
    reasoningEffortFormat: thinking ? "chat-completions" : void 0,
    modelOptions: {
      temperature: null,
      top_p: null
    }
  };
  if (isGo || isFree) {
    model.requestHeaders = {
      "x-opencode-session": "vscode-copilot"
    };
  }
  return model;
}

// src/config.ts
function mergeChatLanguageModels(existingConfig, newProviders) {
  const addingUnifiedOpenCode = newProviders.some((p) => p.name === "OpenCode");
  const result = existingConfig.filter((entry) => {
    if (addingUnifiedOpenCode && (entry?.name === "OpenCode Go" || entry?.name === "OpenCode Zen Free")) {
      return false;
    }
    return true;
  });
  for (const newProvider of newProviders) {
    const idx = result.findIndex(
      (entry) => entry && entry.name === newProvider.name && entry.vendor === newProvider.vendor
    );
    if (idx >= 0) {
      result[idx] = {
        ...result[idx],
        ...newProvider
      };
    } else {
      result.push(newProvider);
    }
  }
  return result;
}

// src/fetcher.ts
async function fetchOpenCodeModels(apiKey, catalog = "go") {
  const url = catalog === "go" ? "https://opencode.ai/zen/go/v1/models" : "https://opencode.ai/zen/v1/models";
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "vscode-copilot/1.0"
    }
  });
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch models (${res.status} ${res.statusText}): ${errorText}`);
  }
  const json = await res.json();
  if (!json.data || !Array.isArray(json.data)) {
    throw new Error("Invalid response structure: expected data array");
  }
  return json.data.map((m) => m.id).filter(Boolean);
}
function filterFreeModels(modelIds) {
  return modelIds.filter((id) => id.includes("free") || id === "big-pickle");
}

// src/syncer.ts
function getChatLanguageModelsPath() {
  const platform = process.platform;
  if (platform === "darwin") {
    return path2.join(os2.homedir(), "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path2.join(os2.homedir(), "AppData", "Roaming");
    return path2.join(appData, "Code", "User", "chatLanguageModels.json");
  }
  return path2.join(os2.homedir(), ".config", "Code", "User", "chatLanguageModels.json");
}
function isWSL() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    const v = fs2.readFileSync("/proc/version", "utf-8");
    return v.toLowerCase().includes("microsoft") || v.toLowerCase().includes("wsl");
  } catch {
    return false;
  }
}
function getAllChatLanguageModelsPaths() {
  const paths = [getChatLanguageModelsPath()];
  if (isWSL()) {
    try {
      const mntCUsers = "/mnt/c/Users";
      if (fs2.existsSync(mntCUsers)) {
        for (const user of fs2.readdirSync(mntCUsers)) {
          if (["Public", "Default", "Default User", "All Users"].includes(user) || user.startsWith(".")) continue;
          const winPath = path2.join(mntCUsers, user, "AppData", "Roaming", "Code", "User", "chatLanguageModels.json");
          if (fs2.existsSync(path2.dirname(winPath)) && !paths.includes(winPath)) {
            paths.push(winPath);
          }
        }
      }
    } catch {
    }
  }
  return paths;
}
function readChatLanguageModels(targetPath) {
  const filePath = targetPath || getChatLanguageModelsPath();
  if (!fs2.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs2.readFileSync(filePath, "utf-8");
    if (!raw.trim()) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}
function createBackup(filePath) {
  if (!fs2.existsSync(filePath)) {
    return null;
  }
  const dir = path2.dirname(filePath);
  const baseName = path2.basename(filePath);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = path2.join(dir, `${baseName}.bak-${timestamp}`);
  fs2.copyFileSync(filePath, backupPath);
  try {
    const files = fs2.readdirSync(dir);
    const backups = files.filter((f) => f.startsWith(`${baseName}.bak-`)).sort().reverse();
    if (backups.length > 3) {
      for (const old of backups.slice(3)) {
        try {
          fs2.unlinkSync(path2.join(dir, old));
        } catch {
        }
      }
    }
  } catch {
  }
  return backupPath;
}
function writeProvidersToConfig(providers, targetPath) {
  const filePaths = targetPath ? [targetPath] : getAllChatLanguageModelsPaths();
  let primaryBackup = null;
  for (const filePath of filePaths) {
    try {
      const existingConfig = readChatLanguageModels(filePath);
      const mergedConfig = mergeChatLanguageModels(existingConfig, providers);
      const backupPath = createBackup(filePath);
      if (!primaryBackup) {
        primaryBackup = backupPath;
      }
      const dir = path2.dirname(filePath);
      if (!fs2.existsSync(dir)) {
        fs2.mkdirSync(dir, { recursive: true });
      }
      fs2.writeFileSync(filePath, JSON.stringify(mergedConfig, null, 4), "utf-8");
    } catch (err) {
      console.error(`Failed writing to ${filePath}: ${err.message}`);
    }
  }
  return { targetPath: filePaths[0], backupPath: primaryBackup };
}
async function syncOpenCodeModels(apiKey, options = {}) {
  const includeGo = options.includeGo ?? true;
  const includeZen = options.includeZen ?? true;
  let goModelIds = [];
  let zenModelIds = [];
  if (includeGo) {
    try {
      goModelIds = await fetchOpenCodeModels(apiKey, "go");
    } catch (err) {
      console.error(`Failed to fetch Go models: ${err.message}`);
    }
  }
  if (includeZen) {
    try {
      zenModelIds = await fetchOpenCodeModels(apiKey, "zen");
    } catch (err) {
      console.error(`Failed to fetch Zen models: ${err.message}`);
    }
  }
  const goSet = new Set(goModelIds);
  const models = [];
  for (const id of goModelIds) {
    models.push(enrichModel(id, { isGo: true }));
  }
  let zenCount = 0;
  for (const id of zenModelIds) {
    if (!goSet.has(id)) {
      const isFree = filterFreeModels([id]).length > 0;
      models.push(enrichModel(id, { isGo: false, isFree }));
      zenCount++;
    }
  }
  const unifiedProvider = {
    name: "OpenCode",
    vendor: "customendpoint",
    apiKey,
    apiType: "chat-completions",
    models
  };
  const { targetPath, backupPath } = writeProvidersToConfig([unifiedProvider], options.targetPath);
  return {
    goCount: goModelIds.length,
    zenCount,
    totalCount: models.length,
    targetPath,
    backupPath
  };
}

// src/extension.ts
async function activate(context) {
  const outputChannel = vscode.window.createOutputChannel("OpenCode Copilot Sync");
  context.subscriptions.push(outputChannel);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
  statusBarItem.text = "$(hubot) OpenCode";
  statusBarItem.tooltip = "Click to sync OpenCode models to Copilot";
  statusBarItem.command = "opencode-copilot-sync.sync";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  async function performSync(interactive) {
    try {
      const config2 = vscode.workspace.getConfiguration("opencode");
      const includeGo = config2.get("includeGoModels", true);
      const includeZen = config2.get("includeZenModels", true);
      const apiKey = await resolveApiKey(context.secrets, interactive, vscode.window);
      if (!apiKey) {
        if (interactive) {
          vscode.window.showWarningMessage("OpenCode sync cancelled: No API key provided.");
        } else {
          vscode.window.showInformationMessage(
            "OpenCode Copilot Sync: Set your API key to sync OpenCode models to Copilot.",
            "Set API Key"
          ).then((choice) => {
            if (choice === "Set API Key") {
              vscode.commands.executeCommand("opencode-copilot-sync.setApiKey");
            }
          });
        }
        return;
      }
      statusBarItem.text = "$(sync~spin) OpenCode";
      statusBarItem.tooltip = "Syncing OpenCode models...";
      if (interactive) {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "OpenCode: Fetching models and syncing to Copilot...",
            cancellable: false
          },
          async () => {
            const result = await syncOpenCodeModels(apiKey, { includeGo, includeZen });
            outputChannel.appendLine(
              `Synced ${result.totalCount} unified OpenCode models (${result.goCount} Go + ${result.zenCount} Zen) to ${result.targetPath}`
            );
            vscode.window.showInformationMessage(
              `Synced ${result.totalCount} OpenCode models (${result.goCount} Go flat-rate + ${result.zenCount} Zen exclusive) to Copilot!`,
              "Open Models File"
            ).then((choice) => {
              if (choice === "Open Models File") {
                vscode.workspace.openTextDocument(result.targetPath).then((doc) => {
                  vscode.window.showTextDocument(doc);
                });
              }
            });
          }
        );
      } else {
        const result = await syncOpenCodeModels(apiKey, { includeGo, includeZen });
        outputChannel.appendLine(
          `[Startup] Synced ${result.totalCount} unified OpenCode models (${result.goCount} Go + ${result.zenCount} Zen) to ${result.targetPath}`
        );
      }
    } catch (err) {
      outputChannel.appendLine(`Sync error: ${err.message}`);
      if (interactive) {
        vscode.window.showErrorMessage(`OpenCode sync failed: ${err.message}`);
      }
    } finally {
      statusBarItem.text = "$(hubot) OpenCode";
      statusBarItem.tooltip = "OpenCode models synced with Copilot (click to re-sync)";
    }
  }
  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-copilot-sync.sync", () => performSync(true)),
    vscode.commands.registerCommand("opencode-copilot-sync.setApiKey", async () => {
      const key = await promptAndSetApiKey(context.secrets, vscode.window);
      if (key) {
        vscode.window.showInformationMessage("OpenCode API Key updated! Syncing models now...");
        await performSync(true);
      }
    }),
    vscode.commands.registerCommand("opencode-copilot-sync.openConfig", async () => {
      const p = getChatLanguageModelsPath();
      try {
        const doc = await vscode.workspace.openTextDocument(p);
        await vscode.window.showTextDocument(doc);
      } catch (err) {
        vscode.window.showErrorMessage(`Unable to open config: ${err.message}`);
      }
    })
  );
  const config = vscode.workspace.getConfiguration("opencode");
  const autoSync = config.get("autoSyncOnStartup", true);
  if (autoSync) {
    setTimeout(() => {
      performSync(false);
    }, 1e3);
  }
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
