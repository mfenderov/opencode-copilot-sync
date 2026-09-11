# OpenCode Models for Copilot (`opencode-copilot-sync`)

A lightweight VS Code extension that automatically synchronizes model definitions from **OpenCode Go** (and OpenCode Zen) into GitHub Copilot in VS Code via `chatLanguageModels.json`.

## Features

- **Seamless Auto-Sync**: Activates on `onStartupFinished` when VS Code loads or window reloads.
- **Zero API Key Entry Friction**: Automatically discovers your OpenCode credentials from `~/.local/share/opencode/auth.json`. If missing, prompts securely and saves to VS Code SecretStorage.
- **Automatic Model Enrichment**: Fetches live models from `https://opencode.ai/zen/go/v1/models`, formats capabilities (vision, reasoning effort, tool calling), and attaches the required `x-opencode-session` header.
- **Safe & Non-Destructive**: Merges the `OpenCode Go` provider block into `chatLanguageModels.json` while maintaining existing providers (e.g. `HF Router`) and creating timestamped backups.

## Commands

- `OpenCode: Sync Models to Copilot` (`opencode-copilot-sync.sync`)
- `OpenCode: Set API Key` (`opencode-copilot-sync.setApiKey`)
