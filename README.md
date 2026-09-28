<p align="center">
  <img src="icon.png" width="96" height="96" alt="OpenCode Copilot Sync Icon" />
</p>

# OpenCode Models for Copilot (`opencode-copilot-sync`)

[![CI](https://github.com/mfenderov/opencode-copilot-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/mfenderov/opencode-copilot-sync/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![GitHub Release](https://img.shields.io/github/v/release/mfenderov/opencode-copilot-sync)](https://github.com/mfenderov/opencode-copilot-sync/releases)

A lightweight VS Code extension that automatically synchronizes model catalogs from **OpenCode Go** and **OpenCode Zen** into GitHub Copilot in VS Code under a **single unified provider** with **smart cost-optimized routing**. Its HTTP client is bundled into the extension package.

---

## ✨ Features

- **Unified model catalog:** Automatically syncs OpenCode Go and Zen models under one **OpenCode** provider, preferring the Go flat subscription when a model is covered.
- **Secure credentials:** Stores API keys in VS Code's encrypted SecretStorage and supports `OPENCODE_API_KEY` for automation.
- **Reliable requests:** Supports tools, vision, and reasoning controls, and recovers automatically from stalled streams.
- **Usage at a glance:** Shows Go subscription quotas and reset timers in the OpenCode sidebar.
- **Safe mirroring:** Preserves unrelated providers and destination-local secrets when syncing VS Code profiles and the associated WSL distro.

---

## 🚀 Quick Install

### Install from the VS Code Marketplace (Recommended)

Search for **OpenCode Models for Copilot** in the Extensions view, or run:

```bash
code --install-extension mfenderov.opencode-copilot-sync
```

For a manual install, download a `.vsix` from the [Latest Release](https://github.com/mfenderov/opencode-copilot-sync/releases/latest) and choose **Install from VSIX...** in the Extensions view.

### Build from Source

```bash
git clone https://github.com/mfenderov/opencode-copilot-sync.git
cd opencode-copilot-sync
npm ci
npm run package
code --install-extension opencode-copilot-sync-*.vsix
```

### Dependencies

- Requires VS Code `1.125` or later.
- Building, testing, and packaging from source requires Node.js and npm. `npm ci` installs the locked runtime and development dependencies, including `undici` and the build/test tools.
- `npm run package` bundles the HTTP client into the VSIX; end users do not need to install a separate runtime package.

---

## ⚙️ Configuration Settings

Customize behavior via VS Code Settings (`Cmd+,` / `Ctrl+,` search for `opencode`):

| Setting | Default | Description |
| :--- | :--- | :--- |
| `opencode.autoSyncOnStartup` | `true` | Automatically sync models on VS Code launch or window reload. |
| `opencode.includeGoModels` | `true` | Include models from the OpenCode Go subscription catalog. |
| `opencode.includeZenModels` | `true` | Include Zen models (Free tier + Zen exclusive models). |
| `opencode.additionalSyncTargets` | `[]` | Additional absolute `chatLanguageModels.json` paths to mirror to. Use this to opt in to another user profile or a sibling WSL distro. |
| `opencode.streamIdleTimeoutSeconds` | `90` | Watchdog timeout in seconds before auto-recovering or alerting on an idle stream. |

---

## 🕹️ Commands, Status Bar & Sidebar

- **Activity Bar View**: Click the **OpenCode** hubot icon in the left Activity Bar to see:
  - 📊 Real-time Go subscription quotas (rolling 5-hour, weekly, monthly limits & reset timers)
  - 🏷️ Active model counts (OpenCode Go flat-rate vs Zen Free tier)
  - ⚡ Quick actions to sync models, update API key, and open config
- **Status Bar Indicator**: Click `$(hubot) OpenCode` in the bottom-right status bar to trigger a live sync with spin animation.
- **Command Palette** (`Cmd+Shift+P` / `Ctrl+Shift+P`):
  - `OpenCode: Sync Models to Copilot`: Manually fetch models and refresh Copilot.
  - `OpenCode: Refresh Usage`: Refresh Go subscription limits in status bar and sidebar view.
  - `OpenCode: Set API Key`: Update your OpenCode API key securely.
  - `OpenCode: Open Copilot Models Config`: Open `chatLanguageModels.json` in editor.

---

## 🪟 Windows & WSL Usage

- The active extension stores its API key in that VS Code extension host's encrypted `SecretStorage`. An explicitly supplied `OPENCODE_API_KEY` environment variable is also supported (commonly for CI); the extension and E2E tests do not scan OpenCode `auth.json` files.
- Automatic compatibility targets are limited to the current OS user's existing VS Code profiles and the WSL distro explicitly associated with the current VS Code remote window. Other user homes and sibling distros are not discovered. Add exact absolute config-file paths to `opencode.additionalSyncTargets` to opt in to more targets.
- A compatibility mirror never receives the extension's raw API key. VS Code resolves custom endpoint keys through a target-local SecretStorage reference such as `${input:chat.lm.secret.<id>}`. A profile without its own VS Code-generated reference is skipped and reported in the **OpenCode Copilot Sync** output channel. To enable that mirror, configure OpenCode in that profile through **Manage Language Models** and enter the key there; the next sync will preserve and reuse that profile's reference.

### Remote-SSH, Dev Containers & GitHub Codespaces

The extension's `extensionKind: ["ui", "workspace"]` setting asks VS Code to activate it on the same host as Copilot Chat in every remote topology, so Remote-SSH, Dev Containers, and Codespaces are expected to work the same way as WSL. These topologies aren't part of the automated test matrix yet (only WSL is), so treat them as **best-effort**: if sync doesn't pick up your models, run **`OpenCode: Sync Models to Copilot`** manually and check the **OpenCode Copilot Sync** output channel (`View → Output → OpenCode Copilot Sync`) for the logged `Remote: <name>` line, which confirms which host the extension actually activated on.

### Known limitation: Agents window under Remote-WSL

OpenCode models show up correctly in **Manage Language Models** and work fine in the regular **Copilot Chat view** under Remote-WSL. However, they currently do **not** appear in the model picker inside the **Agents window** (the standalone agentic session UI) when the workspace is opened via Remote-WSL.

This is a confirmed upstream VS Code limitation, not a bug in this extension: under Remote-WSL, the Agent Host process communicates over a remote path where the BYOK (Bring-Your-Own-Key) bridge is currently hardcoded as unavailable, regardless of which extension registers the model. It affects **every** BYOK/custom-endpoint provider under WSL, not just OpenCode. Tracked upstream in [microsoft/vscode#332085](https://github.com/microsoft/vscode/issues/332085) — a VS Code team member confirmed "Support for WSL is added to the backlog," with no ETA. Plain Windows and Dev Containers are unaffected.

---

## 🛠️ How It Works Under the Hood

The extension registers a native **OpenCode** chat provider for requests and maintains optional `chatLanguageModels.json` mirrors for profile compatibility. It fetches OpenCode's model catalogs, sends the required session header with chat requests, and merges only its own entries; unrelated providers are preserved, and raw API keys are never copied between profiles.

---

## Insiders spike: OpenCode Session Target
Requires VS Code Insiders sideload (`code-insiders --install-extension *.vsix`). Uses proposed `chatSessionsProvider`; will not pass stable Marketplace validation. Needs `opencode` CLI on PATH (`opencode acp --help` prints ACP server help). Select OpenCode in Agent Session Target to run prompts on the local harness.

Known server limitation (opencode v2.0.16): the ACP server ignores per-prompt and per-session `model`/`mode` params, so the input-bar Model/Mode pickers show the session's actual current values as read-only status instead of switching controls. Per-context model control today = opencode config files (global `~/.config/opencode/opencode.jsonc` `"model"`, or project-local config in the workspace cwd, which applies since sessions spawn with the workspace cwd).

---

## 📄 License

MIT © Mark Fenderov
