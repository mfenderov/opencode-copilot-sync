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
var vscode2 = __toESM(require("vscode"), 1);

// src/auth.ts
var fs2 = __toESM(require("node:fs"), 1);
var path2 = __toESM(require("node:path"), 1);
var os2 = __toESM(require("node:os"), 1);

// src/syncer.ts
var fs = __toESM(require("node:fs"), 1);
var path = __toESM(require("node:path"), 1);
var os = __toESM(require("node:os"), 1);
var cp = __toESM(require("node:child_process"), 1);

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
    family: "gpt-5-5",
    url: baseUrl,
    apiType: "chat-completions",
    toolCalling: true,
    vision,
    contextWindow,
    maxInputTokens,
    maxOutputTokens,
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
function isOpenCodeLegacyOrCustomEntry(entry) {
  if (!entry || entry.vendor !== "customendpoint") {
    return false;
  }
  const name = typeof entry.name === "string" ? entry.name.trim() : "";
  if (name === "OpenCode Go" || name === "OpenCode Zen Free") {
    return true;
  }
  const hasOpenCodeModels = Array.isArray(entry.models) && entry.models.some((m) => typeof m?.url === "string" && m.url.includes("opencode.ai"));
  if (hasOpenCodeModels) {
    return true;
  }
  if (/^(customprovider|custom endpoint|customendpoint)$/i.test(name)) {
    if (typeof entry.apiKey === "string" && entry.apiKey.trim().startsWith("sk-")) {
      return true;
    }
  }
  return false;
}
function purgeOpenCodeFromChatLanguageModels(existingConfig) {
  if (!Array.isArray(existingConfig)) return [];
  return existingConfig.filter((entry) => {
    if (!entry) return false;
    return !isOpenCodeLegacyOrCustomEntry(entry) && entry.name !== "OpenCode";
  });
}
function mergeChatLanguageModels(existingConfig, newProviders) {
  const addingUnifiedOpenCode = newProviders.some((p) => p.name === "OpenCode");
  const result = existingConfig.filter((entry) => {
    if (addingUnifiedOpenCode && isOpenCodeLegacyOrCustomEntry(entry) && entry?.name !== "OpenCode") {
      return false;
    }
    return true;
  });
  for (const newProvider of newProviders) {
    const idx = result.findIndex(
      (entry) => entry && entry.name === newProvider.name && entry.vendor === newProvider.vendor
    );
    if (idx >= 0) {
      const existingModels = result[idx].models || [];
      const incomingModels = newProvider.models || [];
      const modelsToKeep = incomingModels.length > 0 ? incomingModels : existingModels;
      const existingApiKey = result[idx].apiKey;
      const apiKey = typeof existingApiKey === "string" && existingApiKey.startsWith("${input:") ? existingApiKey : newProvider.apiKey;
      result[idx] = {
        ...result[idx],
        ...newProvider,
        apiKey,
        models: modelsToKeep
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
var KNOWN_UNAVAILABLE_MODELS = /* @__PURE__ */ new Set([
  "gpt-5.6-luna",
  "grok-4.5",
  "grok-4.6",
  "muse-spark-1.3",
  "muse-spark-1.2",
  "muse-spark-1.3-contributor",
  "muse-spark-1.2-contributor",
  "muse-spark-1.3-contributor-free",
  "muse-spark-1.2-contributor-free",
  "kimi-k2.5",
  "glm-5",
  "qwen3.7-plus",
  "qwen3.5-plus",
  "mimo-v2-pro",
  "mimo-v2-omni",
  "hy3-preview",
  "minimax-m2.7",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "deepseek-v4-flash-free",
  "ling-3.0-flash-fin-free"
]);
function filterAvailableGoModels(modelIds) {
  return modelIds.filter((id) => !KNOWN_UNAVAILABLE_MODELS.has(id) && !id.startsWith("muse-"));
}
async function checkZenBalance(apiKey) {
  try {
    const res = await fetch("https://opencode.ai/zen/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1
      }),
      signal: AbortSignal.timeout(3e3)
    });
    if (res.status === 401) {
      const text = await res.text();
      if (text.includes("Insufficient balance") || text.includes("CreditsError")) {
        return false;
      }
    }
    return res.status === 200 || res.status === 400;
  } catch {
    return false;
  }
}

// src/syncer.ts
function getChatLanguageModelsPath(activeExtensionStoragePath) {
  if (activeExtensionStoragePath) {
    try {
      const derived = path.resolve(activeExtensionStoragePath, "..", "..", "chatLanguageModels.json");
      if (fs.existsSync(path.dirname(derived)) || activeExtensionStoragePath.includes(".vscode-server") || activeExtensionStoragePath.includes("Code")) {
        return derived;
      }
    } catch {
    }
  }
  const platform = process.platform;
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "Code", "User", "chatLanguageModels.json");
  }
  const serverDir = path.join(os.homedir(), ".vscode-server");
  const serverPath = path.join(serverDir, "data", "User", "chatLanguageModels.json");
  if (fs.existsSync(serverDir) || fs.existsSync(path.dirname(serverPath))) {
    return serverPath;
  }
  const serverInsidersDir = path.join(os.homedir(), ".vscode-server-insiders");
  const serverInsidersPath = path.join(serverInsidersDir, "data", "User", "chatLanguageModels.json");
  if (fs.existsSync(serverInsidersDir) || fs.existsSync(path.dirname(serverInsidersPath))) {
    return serverInsidersPath;
  }
  if (isWSL()) {
    return serverPath;
  }
  return path.join(os.homedir(), ".config", "Code", "User", "chatLanguageModels.json");
}
function isWSL() {
  if (process.platform !== "linux") return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    const v = fs.readFileSync("/proc/version", "utf-8");
    return v.toLowerCase().includes("microsoft") || v.toLowerCase().includes("wsl");
  } catch {
    return false;
  }
}
function syncWslMirror(sourceFilePath) {
  if (process.platform !== "win32") {
    if (isWSL()) {
      try {
        const potentialUserRoots = [
          "/mnt/c/Users",
          "/mnt/d/Users",
          "/mnt/e/Users",
          "/c/Users",
          "/d/Users"
        ];
        for (const mntUsers of potentialUserRoots) {
          if (fs.existsSync(mntUsers)) {
            let userDirs = [];
            try {
              userDirs = fs.readdirSync(mntUsers);
            } catch {
            }
            for (const user of userDirs) {
              if (["Public", "Default", "Default User", "All Users"].includes(user) || user.startsWith(".")) continue;
              for (const variant of ["Code", "Code - Insiders"]) {
                const winDest = path.join(mntUsers, user, "AppData", "Roaming", variant, "User", "chatLanguageModels.json");
                const winDir = path.dirname(winDest);
                if (!fs.existsSync(winDir)) {
                  fs.mkdirSync(winDir, { recursive: true });
                }
                fs.copyFileSync(sourceFilePath, winDest);
              }
            }
          }
        }
      } catch {
      }
    }
    return;
  }
  try {
    const driveMatch = sourceFilePath.match(/^([A-Za-z]):\\(.*)$/);
    if (!driveMatch) return;
    const driveLetter = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, "/");
    const wslSourcePath = `/mnt/${driveLetter}/${rest}`;
    const subDirs = [
      ".vscode-server/data/User",
      ".vscode-server/data/Machine",
      ".vscode-server-insiders/data/User",
      ".vscode-server-insiders/data/Machine",
      ".config/Code/User",
      ".config/Code - Insiders/User"
    ];
    const mkdirCommands = subDirs.map((d) => `mkdir -p ~/"${d}"`).join(" && ");
    const cpCommands = subDirs.map((d) => `cp "${wslSourcePath}" ~/"${d}/chatLanguageModels.json"`).join(" && ");
    const fullCmd = `${mkdirCommands} && ${cpCommands}`;
    try {
      cp.exec("wsl.exe -l -q", { encoding: "buffer", timeout: 5e3 }, (err, stdout) => {
        const distros = [];
        if (!err && stdout) {
          const text = stdout.toString("utf16le").includes("\0") ? stdout.toString("utf8") : stdout.toString("utf16le");
          const clean = text.replace(/\0/g, "").split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0 && !s.includes("Windows Subsystem") && !s.startsWith("-"));
          for (const d of clean) {
            if (!distros.includes(d)) distros.push(d);
          }
        }
        if (distros.length > 0) {
          for (const distro of distros) {
            cp.exec(`wsl.exe -d "${distro}" -e bash -c "${fullCmd}"`, () => {
            });
          }
        }
        cp.exec(`wsl.exe -e bash -c "${fullCmd}"`, () => {
        });
      });
    } catch {
      cp.exec(`wsl.exe -e bash -c "${fullCmd}"`, () => {
      });
    }
  } catch {
  }
}
function getAllChatLanguageModelsPaths(activeExtensionStoragePath) {
  const paths = [];
  const primary = getChatLanguageModelsPath(activeExtensionStoragePath);
  paths.push(primary);
  if (process.platform === "linux") {
    const serverCandidates = [
      path.join(os.homedir(), ".vscode-server", "data", "User", "chatLanguageModels.json"),
      path.join(os.homedir(), ".vscode-server", "data", "Machine", "chatLanguageModels.json"),
      path.join(os.homedir(), ".vscode-server-insiders", "data", "User", "chatLanguageModels.json"),
      path.join(os.homedir(), ".vscode-server-insiders", "data", "Machine", "chatLanguageModels.json"),
      path.join(os.homedir(), ".config", "Code", "User", "chatLanguageModels.json"),
      path.join(os.homedir(), ".config", "Code - Insiders", "User", "chatLanguageModels.json")
    ];
    for (const sc of serverCandidates) {
      if (!paths.includes(sc)) {
        paths.push(sc);
      }
    }
  }
  if (isWSL()) {
    try {
      const potentialUserRoots = [
        "/mnt/c/Users",
        "/mnt/d/Users",
        "/mnt/e/Users",
        "/c/Users",
        "/d/Users"
      ];
      for (const mntUsers of potentialUserRoots) {
        if (fs.existsSync(mntUsers)) {
          let userDirs = [];
          try {
            userDirs = fs.readdirSync(mntUsers);
          } catch {
          }
          for (const user of userDirs) {
            if (["Public", "Default", "Default User", "All Users"].includes(user) || user.startsWith(".")) continue;
            for (const variant of ["Code", "Code - Insiders"]) {
              const winPath = path.join(mntUsers, user, "AppData", "Roaming", variant, "User", "chatLanguageModels.json");
              if (!paths.includes(winPath)) {
                paths.push(winPath);
              }
            }
          }
        }
      }
    } catch {
    }
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    const winVariants = [
      path.join(appData, "Code", "User", "chatLanguageModels.json"),
      path.join(appData, "Code - Insiders", "User", "chatLanguageModels.json")
    ];
    for (const wv of winVariants) {
      if (!paths.includes(wv)) {
        paths.push(wv);
      }
    }
    for (const prefix of ["\\\\wsl.localhost", "\\\\wsl$"]) {
      try {
        if (fs.existsSync(prefix)) {
          let distros = [];
          try {
            distros = fs.readdirSync(prefix);
          } catch {
          }
          for (const distro of distros) {
            const userHomes = [];
            const home = path.join(prefix, distro, "home");
            if (fs.existsSync(home)) {
              try {
                for (const u of fs.readdirSync(home)) {
                  userHomes.push(path.join(home, u));
                }
              } catch {
              }
            }
            const rootHome = path.join(prefix, distro, "root");
            if (fs.existsSync(rootHome)) {
              userHomes.push(rootHome);
            }
            for (const h of userHomes) {
              const wslPaths = [
                path.join(h, ".vscode-server", "data", "User", "chatLanguageModels.json"),
                path.join(h, ".vscode-server", "data", "Machine", "chatLanguageModels.json"),
                path.join(h, ".vscode-server-insiders", "data", "User", "chatLanguageModels.json"),
                path.join(h, ".vscode-server-insiders", "data", "Machine", "chatLanguageModels.json"),
                path.join(h, ".config", "Code", "User", "chatLanguageModels.json"),
                path.join(h, ".config", "Code - Insiders", "User", "chatLanguageModels.json")
              ];
              for (const wp of wslPaths) {
                if (!paths.includes(wp)) {
                  paths.push(wp);
                }
              }
            }
          }
        }
      } catch {
      }
    }
  }
  return paths;
}
function readChatLanguageModels(targetPath) {
  const filePath = targetPath || getChatLanguageModelsPath();
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
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
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath);
  const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(dir, `${baseName}.bak-${timestamp}`);
  fs.copyFileSync(filePath, backupPath);
  try {
    const files = fs.readdirSync(dir);
    const backups = files.filter((f) => f.startsWith(`${baseName}.bak-`)).sort().reverse();
    if (backups.length > 3) {
      for (const old of backups.slice(3)) {
        try {
          fs.unlinkSync(path.join(dir, old));
        } catch {
        }
      }
    }
  } catch {
  }
  return backupPath;
}
function cleanupLegacyOpenCodeCustomEndpoints(storagePath) {
  const filePaths = getAllChatLanguageModelsPaths(storagePath);
  const cleaned = [];
  for (const filePath of filePaths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const existing = readChatLanguageModels(filePath);
      const purged = purgeOpenCodeFromChatLanguageModels(existing);
      if (purged.length !== existing.length) {
        createBackup(filePath);
        fs.writeFileSync(filePath, JSON.stringify(purged, null, 4), "utf-8");
        cleaned.push(filePath);
      }
    } catch (err) {
      console.error(`Failed cleaning legacy customendpoints in ${filePath}: ${err.message}`);
    }
  }
  return cleaned;
}
function writeProvidersToConfig(providers, targetPath, storagePath) {
  const filePaths = targetPath ? [targetPath] : getAllChatLanguageModelsPaths(storagePath);
  let primaryBackup = null;
  for (const filePath of filePaths) {
    try {
      const existingConfig = readChatLanguageModels(filePath);
      const mergedConfig = mergeChatLanguageModels(existingConfig, providers);
      const backupPath = createBackup(filePath);
      if (!primaryBackup) {
        primaryBackup = backupPath;
      }
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(mergedConfig, null, 4), "utf-8");
    } catch (err) {
      console.error(`Failed writing to ${filePath}: ${err.message}`);
    }
  }
  if (filePaths.length > 0) {
    syncWslMirror(filePaths[0]);
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
      const rawGoIds = await fetchOpenCodeModels(apiKey, "go");
      goModelIds = filterAvailableGoModels(rawGoIds);
    } catch (err) {
      console.error(`Failed to fetch Go models: ${err.message}`);
    }
  }
  let hasZenCredits = false;
  if (includeZen) {
    try {
      hasZenCredits = await checkZenBalance(apiKey);
      if (hasZenCredits) {
        const rawZenIds = await fetchOpenCodeModels(apiKey, "zen");
        zenModelIds = filterAvailableGoModels(rawZenIds);
      } else {
        console.log("No active Zen credit balance detected. Skipping paid Zen catalog to avoid 401 retry timeouts.");
      }
    } catch (err) {
      console.error(`Failed to check/fetch Zen models: ${err.message}`);
    }
  }
  const goSet = new Set(goModelIds);
  const models = [];
  for (const id of goModelIds) {
    models.push(enrichModel(id, { isGo: true }));
  }
  let zenCount = 0;
  for (const id of zenModelIds) {
    if (!goSet.has(id) && !KNOWN_UNAVAILABLE_MODELS.has(id) && !id.startsWith("muse-")) {
      const isFree = filterFreeModels([id]).length > 0;
      models.push(enrichModel(id, { isGo: false, isFree }));
      zenCount++;
    }
  }
  if (models.length === 0) {
    throw new Error("No models were fetched from OpenCode API. Preserving existing configuration to prevent accidental erasure.");
  }
  let targetPath = options.targetPath || getChatLanguageModelsPath(options.storagePath);
  let backupPath = null;
  if (options.targetPath) {
    const unifiedProvider = {
      name: "OpenCode",
      vendor: "customendpoint",
      apiKey,
      apiType: "chat-completions",
      models
    };
    const res = writeProvidersToConfig([unifiedProvider], options.targetPath, options.storagePath);
    targetPath = res.targetPath;
    backupPath = res.backupPath;
  } else {
    const cleaned = cleanupLegacyOpenCodeCustomEndpoints(options.storagePath);
    if (cleaned.length > 0) {
      backupPath = createBackup(cleaned[0]);
    }
  }
  return {
    goCount: goModelIds.length,
    zenCount,
    totalCount: models.length,
    models,
    targetPath,
    backupPath
  };
}

// src/auth.ts
var SECRET_KEY = "opencode_api_key";
function getStoredOpenCodeKey(customPath) {
  if (process.env.OPENCODE_API_KEY && process.env.OPENCODE_API_KEY.trim().length > 0) {
    return process.env.OPENCODE_API_KEY.trim();
  }
  if (customPath) {
    try {
      if (fs2.existsSync(customPath)) {
        const raw = fs2.readFileSync(customPath, "utf-8");
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
  const home = os2.homedir();
  candidatePaths.push(path2.join(home, ".local", "share", "opencode", "auth.json"));
  candidatePaths.push(path2.join(home, ".config", "opencode", "auth.json"));
  if (process.env.LOCALAPPDATA) {
    candidatePaths.push(path2.join(process.env.LOCALAPPDATA, "opencode", "auth.json"));
  }
  if (process.env.APPDATA) {
    candidatePaths.push(path2.join(process.env.APPDATA, "opencode", "auth.json"));
  }
  if (process.env.USERPROFILE) {
    candidatePaths.push(path2.join(process.env.USERPROFILE, ".local", "share", "opencode", "auth.json"));
    candidatePaths.push(path2.join(process.env.USERPROFILE, ".config", "opencode", "auth.json"));
  }
  if (process.platform === "win32") {
    for (const prefix of ["\\\\wsl.localhost", "\\\\wsl$"]) {
      try {
        if (fs2.existsSync(prefix)) {
          let distros = [];
          try {
            distros = fs2.readdirSync(prefix);
          } catch {
          }
          for (const distro of distros) {
            const homeDir = path2.join(prefix, distro, "home");
            if (fs2.existsSync(homeDir)) {
              let users = [];
              try {
                users = fs2.readdirSync(homeDir);
              } catch {
              }
              for (const u of users) {
                candidatePaths.push(path2.join(homeDir, u, ".local", "share", "opencode", "auth.json"));
                candidatePaths.push(path2.join(homeDir, u, ".config", "opencode", "auth.json"));
              }
            }
            const rootDir = path2.join(prefix, distro, "root");
            if (fs2.existsSync(rootDir)) {
              candidatePaths.push(path2.join(rootDir, ".local", "share", "opencode", "auth.json"));
              candidatePaths.push(path2.join(rootDir, ".config", "opencode", "auth.json"));
            }
          }
        }
      } catch {
      }
    }
  }
  if (process.platform === "linux") {
    const userRoots = ["/mnt/c/Users", "/mnt/d/Users", "/mnt/e/Users", "/c/Users", "/d/Users"];
    for (const root of userRoots) {
      if (fs2.existsSync(root)) {
        let users = [];
        try {
          users = fs2.readdirSync(root);
        } catch {
        }
        for (const u of users) {
          if (["Public", "Default", "Default User", "All Users"].includes(u) || u.startsWith(".")) continue;
          candidatePaths.push(path2.join(root, u, "AppData", "Local", "opencode", "auth.json"));
          candidatePaths.push(path2.join(root, u, "AppData", "Roaming", "opencode", "auth.json"));
          candidatePaths.push(path2.join(root, u, ".local", "share", "opencode", "auth.json"));
          candidatePaths.push(path2.join(root, u, ".config", "opencode", "auth.json"));
        }
      }
    }
  }
  for (const authPath of candidatePaths) {
    try {
      if (fs2.existsSync(authPath)) {
        const raw = fs2.readFileSync(authPath, "utf-8");
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
function getKeyFromExistingConfig(customPath) {
  const pathsToCheck = [];
  if (customPath) {
    pathsToCheck.push(customPath);
  } else {
    try {
      pathsToCheck.push(...getAllChatLanguageModelsPaths());
    } catch {
      const fallback = process.platform === "darwin" ? path2.join(os2.homedir(), "Library", "Application Support", "Code", "User", "chatLanguageModels.json") : process.platform === "win32" ? path2.join(process.env.APPDATA || path2.join(os2.homedir(), "AppData", "Roaming"), "Code", "User", "chatLanguageModels.json") : path2.join(os2.homedir(), ".config", "Code", "User", "chatLanguageModels.json");
      pathsToCheck.push(fallback);
    }
  }
  for (const configPath of pathsToCheck) {
    try {
      if (fs2.existsSync(configPath)) {
        const raw = fs2.readFileSync(configPath, "utf-8");
        const data = JSON.parse(raw);
        if (Array.isArray(data)) {
          const entry = data.find(
            (e) => e && (e.name === "OpenCode" || e.name === "OpenCode Go" || e.name === "OpenCode Zen Free" || /^(customprovider|custom endpoint|customendpoint)$/i.test(e.name || "") || Array.isArray(e.models) && e.models.some((m) => typeof m?.url === "string" && m.url.includes("opencode.ai")))
          );
          if (entry?.apiKey && typeof entry.apiKey === "string" && entry.apiKey.trim().startsWith("sk-")) {
            return entry.apiKey.trim();
          }
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
  const fromExisting = getKeyFromExistingConfig();
  if (fromExisting) {
    await secrets.store(SECRET_KEY, fromExisting);
    return fromExisting;
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

// src/usage.ts
var OPENCODE_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
async function fetchOpenCodeUsage(apiKey, fetchFn = fetch) {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, reason: "no-key" };
  }
  try {
    const res = await fetchFn(OPENCODE_USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        "x-opencode-session": "vscode-copilot",
        "User-Agent": "vscode-copilot/1.0"
      }
    });
    if (res.status === 401) return { ok: false, reason: "unauthorized" };
    if (res.status === 403) return { ok: false, reason: "no-subscription" };
    if (!res.ok) return { ok: false, reason: "network" };
    const json = await res.json();
    if (!json?.usage?.rolling || !json?.usage?.weekly || !json?.usage?.monthly) {
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, usage: json.usage };
  } catch {
    return { ok: false, reason: "network" };
  }
}
function formatStatusBarText(usage) {
  const maxPercent = Math.max(usage.rolling.percent, usage.weekly.percent);
  const isRateLimited = usage.rolling.status === "rate-limited" || usage.weekly.status === "rate-limited" || usage.monthly.status === "rate-limited";
  const icon = isRateLimited ? "$(warning)" : "$(hubot)";
  return `${icon} OpenCode ${maxPercent}%`;
}
function formatRelativeTime(isoDateStr) {
  try {
    const target = new Date(isoDateStr).getTime();
    const now = Date.now();
    const diffMs = target - now;
    if (diffMs <= 0) return "now";
    const diffMins = Math.round(diffMs / 6e4);
    if (diffMins < 60) return `in ${diffMins}m`;
    const diffHours = Math.round(diffMins / 60);
    if (diffHours < 24) return `in ${diffHours}h`;
    const diffDays = Math.round(diffHours / 24);
    return `in ${diffDays}d`;
  } catch {
    return isoDateStr;
  }
}
function formatUsageTooltip(usage) {
  return [
    "### OpenCode Go Usage",
    "",
    "| Quota Window | Used | Status | Resets |",
    "|:---|:---:|:---:|:---|",
    `| **5h Rolling** | \`${usage.rolling.percent}%\` | ${usage.rolling.status === "ok" ? "\u{1F7E2} OK" : "\u{1F534} Limited"} | ${formatRelativeTime(usage.rolling.resetsAt)} |`,
    `| **Weekly Quota** | \`${usage.weekly.percent}%\` | ${usage.weekly.status === "ok" ? "\u{1F7E2} OK" : "\u{1F534} Limited"} | ${formatRelativeTime(usage.weekly.resetsAt)} |`,
    `| **Monthly Quota** | \`${usage.monthly.percent}%\` | ${usage.monthly.status === "ok" ? "\u{1F7E2} OK" : "\u{1F534} Limited"} | ${formatRelativeTime(usage.monthly.resetsAt)} |`,
    "",
    "---",
    "_Click to sync models & refresh usage quota._"
  ].join("\n");
}

// src/provider.ts
var vscode = __toESM(require("vscode"), 1);
var VERIFIED_OPENCODE_MODELS = [
  { id: "minimax-m3", name: "MiniMax M3 (OpenCode)", family: "minimax-m3", contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: "minimax-m2.5", name: "MiniMax M2.5 (OpenCode)", family: "minimax-m2.5", contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: "kimi-k3", name: "Kimi K3 (OpenCode)", family: "kimi-k3", contextWindow: 1048576, maxOutputTokens: 65536, vision: true },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code (OpenCode)", family: "kimi-k2.7-code", contextWindow: 1048576, maxOutputTokens: 65536, vision: true },
  { id: "kimi-k2.6", name: "Kimi K2.6 (OpenCode)", family: "kimi-k2.6", contextWindow: 1048576, maxOutputTokens: 65536, vision: true },
  { id: "longcat-2.0", name: "Longcat 2.0 (OpenCode)", family: "longcat-2.0", contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
  { id: "glm-5.2", name: "GLM 5.2 (OpenCode)", family: "glm-5.2", contextWindow: 1048576, maxOutputTokens: 131072, vision: true },
  { id: "glm-5.3-flash", name: "GLM 5.3 Flash (OpenCode)", family: "glm-5.3-flash", contextWindow: 1048576, maxOutputTokens: 131072, vision: true },
  { id: "glm-5.3", name: "GLM 5.3 (OpenCode)", family: "glm-5.3", contextWindow: 1048576, maxOutputTokens: 131072, vision: true },
  { id: "glm-5.1", name: "GLM 5.1 (OpenCode)", family: "glm-5.1", contextWindow: 1048576, maxOutputTokens: 131072, vision: true },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro (OpenCode)", family: "deepseek-v4-pro", contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (OpenCode)", family: "deepseek-v4-flash", contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: "deepseek-flash", name: "DeepSeek Flash (OpenCode)", family: "deepseek-flash", contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (OpenCode)", family: "deepseek-v4.1-flash", contextWindow: 1048576, maxOutputTokens: 131072, vision: false },
  { id: "deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision Exp (OpenCode)", family: "deepseek-v4-flash-vision-exp", contextWindow: 1048576, maxOutputTokens: 131072, vision: true },
  { id: "qwen3.7-max", name: "Qwen3.7 Max (OpenCode)", family: "qwen3.7-max", contextWindow: 1e6, maxOutputTokens: 131072, vision: true },
  { id: "qwen3.8-max", name: "Qwen3.8 Max (OpenCode)", family: "qwen3.8-max", contextWindow: 1e6, maxOutputTokens: 131072, vision: true },
  { id: "qwen3.8-flash", name: "Qwen3.8 Flash (OpenCode)", family: "qwen3.8-flash", contextWindow: 1e6, maxOutputTokens: 131072, vision: true },
  { id: "qwen3.6-plus", name: "Qwen3.6 Plus (OpenCode)", family: "qwen3.6-plus", contextWindow: 1e6, maxOutputTokens: 131072, vision: true },
  { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro (OpenCode)", family: "mimo-v2.5-pro", contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
  { id: "mimo-v2.5", name: "MiMo V2.5 (OpenCode)", family: "mimo-v2.5", contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
  { id: "hy4-preview", name: "Hy4 Preview (OpenCode)", family: "hy4-preview", contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
  { id: "hy3", name: "Hy3 (OpenCode)", family: "hy3", contextWindow: 1048576, maxOutputTokens: 65536, vision: false },
  { id: "omen-alpha", name: "Omen Alpha (OpenCode)", family: "omen-alpha", contextWindow: 1048576, maxOutputTokens: 65536, vision: false }
];
var OpenCodeChatProvider = class {
  constructor(context) {
    this.context = context;
  }
  _onDidChange = new vscode.EventEmitter();
  onDidChangeLanguageModelChatInformation = this._onDidChange.event;
  _models = [...VERIFIED_OPENCODE_MODELS];
  refresh() {
    this._onDidChange.fire();
  }
  updateModels(models) {
    if (Array.isArray(models) && models.length > 0) {
      this._models = models;
      this.refresh();
    }
  }
  async provideLanguageModelChatInformation(_options, _token) {
    return this._models.map((m) => ({
      id: m.id,
      name: m.name,
      family: m.family,
      version: "1.0.0",
      maxInputTokens: m.contextWindow - m.maxOutputTokens,
      maxOutputTokens: m.maxOutputTokens,
      capabilities: {
        imageInput: m.vision,
        toolCalling: true
      },
      isBYOK: true
    }));
  }
  async provideLanguageModelChatResponse(model, messages, options, progress, token) {
    const apiKey = await this.context.secrets.get("opencode_api_key") || getStoredOpenCodeKey(this.context.globalStorageUri?.fsPath) || getStoredOpenCodeKey() || getKeyFromExistingConfig(this.context.globalStorageUri?.fsPath) || getKeyFromExistingConfig();
    if (!apiKey) {
      throw new Error(
        'OpenCode API key not found. Please run "OpenCode: Set API Key" command to configure your key.'
      );
    }
    this.context.secrets.get("opencode_api_key").then((stored) => {
      if (!stored && apiKey) {
        this.context.secrets.store("opencode_api_key", apiKey).then(void 0, () => {
        });
      }
    });
    const formattedMessages = [];
    for (const msg of messages) {
      const role = msg.role === vscode.LanguageModelChatMessageRole.User ? "user" : "assistant";
      let textContent = "";
      const toolCalls = [];
      for (const part of msg.content) {
        if (part instanceof vscode.LanguageModelTextPart) {
          textContent += part.value;
        } else if (part instanceof vscode.LanguageModelToolCallPart) {
          toolCalls.push({
            id: part.callId,
            type: "function",
            function: {
              name: part.name,
              arguments: typeof part.input === "string" ? part.input : JSON.stringify(part.input)
            }
          });
        } else if (part instanceof vscode.LanguageModelToolResultPart) {
          let resultStr = "";
          if (typeof part.content === "string") {
            resultStr = part.content;
          } else if (Array.isArray(part.content)) {
            resultStr = part.content.map((p) => p.value || JSON.stringify(p)).join("\n");
          } else {
            resultStr = JSON.stringify(part.content);
          }
          formattedMessages.push({
            role: "tool",
            tool_call_id: part.callId,
            content: resultStr
          });
        }
      }
      if (textContent || toolCalls.length > 0) {
        const entry = { role, content: textContent };
        if (toolCalls.length > 0) {
          entry.tool_calls = toolCalls;
        }
        formattedMessages.push(entry);
      }
    }
    let toolsPayload = void 0;
    if (options.tools && options.tools.length > 0) {
      toolsPayload = options.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema || { type: "object", properties: {} }
        }
      }));
    }
    const abortController = new AbortController();
    token.onCancellationRequested(() => abortController.abort());
    const url = "https://opencode.ai/zen/go/v1/chat/completions";
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "x-opencode-session": "vscode-copilot"
      },
      body: JSON.stringify({
        model: model.id,
        messages: formattedMessages,
        tools: toolsPayload,
        stream: true
      }),
      signal: abortController.signal
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`OpenCode API error (${res.status} ${res.statusText}): ${errText}`);
    }
    if (!res.body) {
      throw new Error("OpenCode API returned empty body");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const pendingToolCalls = /* @__PURE__ */ new Map();
    try {
      while (true) {
        if (token.isCancellationRequested) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(":")) continue;
          if (trimmed === "data: [DONE]") continue;
          if (trimmed.startsWith("data: ")) {
            try {
              const data = JSON.parse(trimmed.slice(6));
              const choice = data.choices?.[0];
              if (!choice) continue;
              if (choice.delta?.content) {
                progress.report(new vscode.LanguageModelTextPart(choice.delta.content));
              }
              if (choice.delta?.tool_calls) {
                for (const tc of choice.delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  const current = pendingToolCalls.get(idx) || { id: "", name: "", args: "" };
                  if (tc.id) current.id = tc.id;
                  if (tc.function?.name) current.name += tc.function.name;
                  if (tc.function?.arguments) current.args += tc.function.arguments;
                  pendingToolCalls.set(idx, current);
                }
              }
              if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop" && pendingToolCalls.size > 0) {
                for (const [, call] of pendingToolCalls) {
                  let parsedArgs = {};
                  try {
                    parsedArgs = JSON.parse(call.args);
                  } catch {
                    parsedArgs = { raw: call.args };
                  }
                  progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedArgs));
                }
                pendingToolCalls.clear();
              }
            } catch {
            }
          }
        }
      }
    } finally {
      if (pendingToolCalls.size > 0) {
        for (const [, call] of pendingToolCalls) {
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(call.args);
          } catch {
            parsedArgs = { raw: call.args };
          }
          progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, parsedArgs));
        }
        pendingToolCalls.clear();
      }
    }
  }
  provideTokenCount(_model, text, _token) {
    const raw = typeof text === "string" ? text : JSON.stringify(text);
    return Promise.resolve(Math.ceil(raw.length / 4));
  }
};

// src/extension.ts
async function activate(context) {
  const outputChannel = vscode2.window.createOutputChannel("OpenCode Copilot Sync");
  context.subscriptions.push(outputChannel);
  const chatProvider = new OpenCodeChatProvider(context);
  context.subscriptions.push(
    vscode2.lm.registerLanguageModelChatProvider("opencode", chatProvider)
  );
  outputChannel.appendLine("Registered native OpenCode LanguageModelChatProvider with VS Code.");
  try {
    const storedSecret = await context.secrets.get("opencode_api_key");
    if (!storedSecret) {
      const discoveredKey = await resolveApiKey(context.secrets, false);
      if (discoveredKey) {
        await context.secrets.store("opencode_api_key", discoveredKey);
        outputChannel.appendLine("Seeded OpenCode API key into SecretStorage.");
      }
    }
  } catch {
  }
  try {
    const cleaned = cleanupLegacyOpenCodeCustomEndpoints(context.globalStorageUri?.fsPath);
    if (cleaned.length > 0) {
      outputChannel.appendLine(`Purged legacy OpenCode customendpoint entries from: ${cleaned.join(", ")}`);
    }
  } catch {
  }
  try {
    const agentHostCfg = vscode2.workspace.getConfiguration("chat.agentHost");
    if (!agentHostCfg.get("byokModels.enabled", false)) {
      await agentHostCfg.update("byokModels.enabled", true, vscode2.ConfigurationTarget.Global);
      outputChannel.appendLine("Enabled chat.agentHost.byokModels.enabled for Agent Mode support.");
    }
  } catch (err) {
    outputChannel.appendLine(`Note: Could not set chat.agentHost.byokModels.enabled: ${err.message}`);
  }
  const statusBarItem = vscode2.window.createStatusBarItem(vscode2.StatusBarAlignment.Right, 99);
  statusBarItem.text = "$(hubot) OpenCode";
  statusBarItem.tooltip = "Click to sync OpenCode models & refresh usage";
  statusBarItem.command = "opencode-copilot-sync.sync";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);
  async function updateUsageMeter(apiKey) {
    try {
      const key = apiKey || await resolveApiKey(context.secrets, false);
      if (!key) return;
      const res = await fetchOpenCodeUsage(key);
      if (res.ok) {
        statusBarItem.text = formatStatusBarText(res.usage);
        const md = new vscode2.MarkdownString(formatUsageTooltip(res.usage));
        md.isTrusted = true;
        statusBarItem.tooltip = md;
      } else if (res.reason === "no-subscription") {
        statusBarItem.text = "$(hubot) OpenCode (Zen)";
        statusBarItem.tooltip = "OpenCode Zen (Pay-as-you-go / Free tier). Click to sync models.";
      }
    } catch {
    }
  }
  async function performSync(interactive) {
    try {
      const config2 = vscode2.workspace.getConfiguration("opencode");
      const includeGo = config2.get("includeGoModels", true);
      const includeZen = config2.get("includeZenModels", true);
      const apiKey = await resolveApiKey(context.secrets, interactive, vscode2.window);
      if (!apiKey) {
        if (interactive) {
          vscode2.window.showWarningMessage("OpenCode sync cancelled: No API key provided.");
        } else {
          vscode2.window.showInformationMessage(
            "OpenCode Copilot Sync: Set your API key to sync OpenCode models to Copilot.",
            "Set API Key"
          ).then((choice) => {
            if (choice === "Set API Key") {
              vscode2.commands.executeCommand("opencode-copilot-sync.setApiKey");
            }
          });
        }
        return;
      }
      statusBarItem.text = "$(sync~spin) OpenCode";
      statusBarItem.tooltip = "Syncing OpenCode models...";
      const storagePath = context.globalStorageUri?.fsPath;
      let syncResult = null;
      if (interactive) {
        await vscode2.window.withProgress(
          {
            location: vscode2.ProgressLocation.Notification,
            title: "OpenCode: Fetching models and syncing to Copilot...",
            cancellable: false
          },
          async () => {
            syncResult = await syncOpenCodeModels(apiKey, { includeGo, includeZen, storagePath });
            outputChannel.appendLine(
              `Synced ${syncResult.totalCount} unified OpenCode models (${syncResult.goCount} Go + ${syncResult.zenCount} Zen) to native provider.`
            );
            vscode2.window.showInformationMessage(
              `Synced ${syncResult.totalCount} OpenCode models (${syncResult.goCount} Go flat-rate + ${syncResult.zenCount} Zen exclusive) to Copilot!`
            );
          }
        );
      } else {
        syncResult = await syncOpenCodeModels(apiKey, { includeGo, includeZen, storagePath });
        outputChannel.appendLine(
          `[Startup] Synced ${syncResult.totalCount} unified OpenCode models (${syncResult.goCount} Go + ${syncResult.zenCount} Zen) to native provider.`
        );
      }
      if (syncResult?.models && syncResult.models.length > 0) {
        chatProvider.updateModels(
          syncResult.models.map((m) => ({
            id: m.id,
            name: m.name,
            family: m.family || m.id,
            contextWindow: m.contextWindow || 1048576,
            maxOutputTokens: m.maxOutputTokens || 65536,
            vision: !!m.vision
          }))
        );
      } else {
        chatProvider.refresh();
      }
      await updateUsageMeter(apiKey);
    } catch (err) {
      outputChannel.appendLine(`[Sync Error] ${err.message}`);
      if (interactive) {
        vscode2.window.showErrorMessage(`OpenCode sync failed: ${err.message}`);
      }
      statusBarItem.text = "$(hubot) OpenCode";
      statusBarItem.tooltip = "OpenCode models synced with Copilot (click to re-sync)";
    }
  }
  context.subscriptions.push(
    vscode2.commands.registerCommand("opencode-copilot-sync.sync", () => performSync(true)),
    vscode2.commands.registerCommand("opencode-copilot-sync.refreshUsage", () => updateUsageMeter()),
    vscode2.commands.registerCommand("opencode-copilot-sync.setApiKey", async () => {
      const key = await promptAndSetApiKey(context.secrets, vscode2.window);
      if (key) {
        vscode2.window.showInformationMessage("OpenCode API Key updated! Syncing models now...");
        await performSync(true);
      }
    }),
    vscode2.commands.registerCommand("opencode-copilot-sync.openConfig", async () => {
      const p = getChatLanguageModelsPath(context.globalStorageUri?.fsPath);
      try {
        const doc = await vscode2.workspace.openTextDocument(p);
        await vscode2.window.showTextDocument(doc);
      } catch (err) {
        vscode2.window.showErrorMessage(`Unable to open config: ${err.message}`);
      }
    })
  );
  const config = vscode2.workspace.getConfiguration("opencode");
  const autoSync = config.get("autoSyncOnStartup", true);
  if (autoSync) {
    setTimeout(() => {
      performSync(false);
    }, 3e3);
  }
  const usageTimer = setInterval(() => {
    updateUsageMeter();
  }, 6e4);
  context.subscriptions.push({ dispose: () => clearInterval(usageTimer) });
  return {
    chatProvider,
    statusBarItem,
    performSync
  };
}
function deactivate() {
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  activate,
  deactivate
});
