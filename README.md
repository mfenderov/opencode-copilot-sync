# OpenCode Models for Copilot (`opencode-copilot-sync`)

[![CI](https://github.com/mfenderov/opencode-copilot-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/mfenderov/opencode-copilot-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/mfenderov/opencode-copilot-sync)](https://github.com/mfenderov/opencode-copilot-sync/releases)

A lightweight (7 KB, zero runtime dependencies) VS Code extension that automatically synchronizes model catalogs from **OpenCode Go** and **OpenCode Zen Free** directly into GitHub Copilot in VS Code.

---

## ✨ Features

- **🔄 Automatic Background Sync**: Activates seamlessly on `onStartupFinished` when VS Code opens or window reloads.
- **🔑 Zero Key-Entry Friction**: Auto-imports your existing credentials from `~/.local/share/opencode/auth.json`. If missing, prompts securely and stores the token in VS Code's credential vault.
- **📦 Dual Catalog Support**:
  - **OpenCode Go**: 37 models included in the $10/mo flat subscription (DeepSeek V4, GLM-5.3, Kimi K3, Qwen 3.8, MiniMax M3, etc.).
  - **OpenCode Zen Free**: Free-tier models (DeepSeek V4 Flash Free, MiMo V2.5 Free, Nemotron 3 Ultra Free, etc.).
- **⚡ Enriched Capabilities**: Configures each model with token limits, vision flags, tool calling, and thinking/reasoning effort levels (`low`, `medium`, `high`, `xhigh`, `max`).
- **🛡️ Router Compliance**: Injects the required `x-opencode-session: vscode-copilot` header to ensure OpenCode's routing and prompt caching function correctly without `MissingSessionID` errors.
- **🔒 Safe & Non-Destructive**: Merges into `chatLanguageModels.json` while preserving your other custom endpoints (like internal gateways or LiteLLM) and creating rolling timestamped backups.
- **💻 Cross-Platform**: Works on macOS, Linux, Windows, and Windows WSL (configured with `extensionKind: ["ui", "workspace"]`).

---

## 🚀 Quick Install

### Option A: Install from GitHub Release (Recommended)
1. Download `opencode-copilot-sync-0.1.0.vsix` from the [Latest Release](https://github.com/mfenderov/opencode-copilot-sync/releases/latest).
2. Install via terminal:
   ```bash
   code --install-extension opencode-copilot-sync-0.1.0.vsix
   ```
   Or in VS Code: Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`) → `...` menu → **Install from VSIX...**

### Option B: Build from Source
```bash
git clone https://github.com/mfenderov/opencode-copilot-sync.git
cd opencode-copilot-sync
npm install
npm run package
code --install-extension opencode-copilot-sync-0.1.0.vsix
```

---

## ⚙️ Configuration Settings

Customize behavior via VS Code Settings (`Cmd+,` / `Ctrl+,` search for `opencode`):

| Setting | Default | Description |
| :--- | :--- | :--- |
| `opencode.autoSyncOnStartup` | `true` | Automatically sync models on VS Code launch or window reload. |
| `opencode.includeGoModels` | `true` | Include models from the OpenCode Go subscription catalog. |
| `opencode.includeFreeModels` | `true` | Include free-tier models from the OpenCode Zen catalog. |

---

## 🕹️ Commands & Status Bar

- **Status Bar Indicator**: Click `$(hubot) OpenCode` in the bottom-right status bar to trigger a live sync.
- **Command Palette** (`Cmd+Shift+P` / `Ctrl+Shift+P`):
  - `OpenCode: Sync Models to Copilot`: Manually fetch models and refresh Copilot.
  - `OpenCode: Set API Key`: Update your OpenCode API key securely.
  - `OpenCode: Open Copilot Models Config`: Open `chatLanguageModels.json` in editor.

---

## 🪟 Windows & WSL Usage

- **VS Code Remote - WSL**: Because GitHub Copilot runs on the Windows UI side, the extension is registered to run on the UI host and updates Windows `%APPDATA%\Code\User\chatLanguageModels.json`.
- If your OpenCode key is stored inside WSL, you can simply run **`OpenCode: Set API Key`** once in VS Code to save it to your Windows credential vault.

---

## 🛠️ How It Works Under the Hood

VS Code Copilot natively reads custom OpenAI-compatible models from `chatLanguageModels.json` under the `customendpoint` vendor. VS Code file-watches this JSON and immediately updates Copilot's model picker whenever the file changes.

This extension connects to OpenCode's catalog APIs (`/zen/go/v1/models` and `/zen/v1/models`), transforms them into valid `customendpoint` specs with the proper `x-opencode-session` header, and atomically merges them into your User configuration.

---

## 📄 License

MIT © Mark Fenderov
