# Changelog
All notable changes to this project will be documented in this file. See [conventional commits](https://www.conventionalcommits.org/) for commit guidelines.

- - -
## v0.16.3 - 2026-09-15
#### Bug Fixes
- (**quality**) buffer coverage/CRAP thresholds for cross-platform variance - (89f67d2) - Mark Fenderov
#### Tests
- (**quality**) add strict lint, coverage/CRAP gates, and split chaos suite - (f822434) - Mark Fenderov

- - -

## v0.16.2 - 2026-09-15
#### Bug Fixes
- (**robustness**) harden network, provider, sync, and auth across platforms - (3d87e14) - Mark Fenderov

- - -

## v0.16.1 - 2026-09-15
#### Tests
- (**thinking**) add 19-case thinking serialization matrix and E2E verification - (ca33985) - Mark Fenderov

- - -

## v0.16.0 - 2026-09-15
#### Features
- (**provider**) stream reasoning on Responses API and guard tool call flush - (e0fdb55) - Mark Fenderov

- - -

## v0.15.1 - 2026-09-15
#### Bug Fixes
- (**wsl**) harden UNC file sync and support UI extensionKind for Remote-WSL - (f5ae83d) - Mark Fenderov

- - -

## v0.15.0 - 2026-09-15
#### Features
- (**provider**) dynamically restrict thinking effort to model capabilities - (de14f5b) - Mark Fenderov

- - -

## v0.14.2 - 2026-09-15
#### Bug Fixes
- (**provider**) normalize reasoning effort to prevent 400 parameter errors - (e886d22) - Mark Fenderov

- - -

## v0.14.1 - 2026-09-15
#### Bug Fixes
- (**provider**) map flat tool definitions for OpenAI Responses API format - (575783f) - Mark Fenderov

- - -

## v0.14.0 - 2026-09-14
#### Features
- multi-transport routing, dynamic models.dev metadata, and enterprise testing pyramid - (003423b) - Mark Fenderov
#### Bug Fixes
- (**ci**) simulate WSL_DISTRO_NAME when running remote test on Linux CI runner - (e9d7ea4) - Mark Fenderov
- (**provider**) cleanly handle fetch AbortError during token cancellation - (5df26ad) - Mark Fenderov
- (**test**) safely handle non-root /mnt permissions in CI environments - (271f5f2) - Mark Fenderov
- (**test**) guard live chatLanguageModels assertion in keyless CI environment - (4e6df98) - Mark Fenderov
#### Miscellaneous Chores
- sync package-lock.json with vscode devDependency - (f1bd134) - Mark Fenderov

- - -

## v0.13.0 - 2026-09-14
#### Features
- fix remote-wsl extensionKind, upstream 500 fail-fast, and thinking streaming - (af554b2) - Mark Fenderov

- - -

## v0.12.1 - 2026-09-14
#### Tests
- add WSL reproduction test script demonstrating failure modes - (d9eb86c) - Mark Fenderov

- - -

## v0.12.0 - 2026-09-14
#### Features
- pull all models dynamically and label with (OpenCode Go) / (OpenCode Zen) / (OpenCode Free) - (9f94bfe) - Mark Fenderov

- - -

## v0.11.0 - 2026-09-14
#### Features
- restore thinking UI via configurationSchema, add all free models including Muse 1.3, and robust streaming - (8ee4094) - Mark Fenderov

- - -

## v0.10.2 - 2026-09-14
#### Bug Fixes
- harden cross-platform file locking, Insiders paths, and remote diagnostics - (5f19672) - Mark Fenderov

- - -

## v0.10.1 - 2026-09-14
#### Bug Fixes
- restore thinking stream, retain free models, and enable cross-platform WSL extensionKind - (8a0ec12) - Mark Fenderov

- - -

## v0.10.0 - 2026-09-14
#### Features
- migrate to native LanguageModelChatProvider and add WSL remote E2E pipeline - (ee38724) - Mark Fenderov
#### Bug Fixes
- prevent interactive input prompts from blocking automated CI test runner - (f5225b6) - Mark Fenderov

- - -

## v0.9.2 - 2026-09-14
#### Bug Fixes
- agent mode tool limits, missing api key on windows, and isBYOK enablement - (8497792) - Mark Fenderov

- - -

## v0.9.1 - 2026-09-14
#### Bug Fixes
- add `isBYOK: true` to native LanguageModelChatProvider models so they appear and work in Agent Mode
- set `family: "gpt-5-5"` on customendpoint models to bypass Copilot's 128-tool limit check in Agent Mode
- auto-seed API key from `chatLanguageModels.json` and local configs into SecretStorage on activation to prevent missing API key errors

- - -
## v0.9.0 - 2026-09-13
#### Features
- first-class native LanguageModelChatProvider for permanent model availability - (ebd7e01) - Mark Fenderov

- - -

## v0.8.0 - 2026-09-13
#### Features
- first-class native Language Model Chat Provider: registers `vendor: "opencode"` directly via `vscode.lm.registerLanguageModelChatProvider`
- permanent model availability: models no longer depend on Copilot's `customendpoint` BYOK policy gate and never disappear after window loading
- cross-platform native streaming: works seamlessly on macOS, Windows, and Remote-WSL with streaming SSE and tool calling

- - -
## v0.7.2 - 2026-09-13
#### Bug Fixes
- (**release**) specify tag_name in softprops/action-gh-release - (ee81edc) - Mark Fenderov

- - -
## v0.7.1 - 2026-09-13
#### Bug Fixes
- filter defunct `muse-*` models returning HTTP 500 to prevent retry timeouts
- bi-directional multi-distro WSL sync across all `.vscode-server` User and Machine directories
- clean up legacy `Customprovider` and `Custom Endpoint` entries while preserving SecretStorage references
- change `extensionKind` to `["ui", "workspace"]` for reliable activation in Remote-WSL

- - -
## v0.7.0 - 2026-09-13
#### Features
- automated WSL mirror: syncs `chatLanguageModels.json` directly into WSL `.vscode-server` locations with zero manual copying
- health & credit validation: checks Zen credits balance and filters unavailable models to eliminate 401/400/500 retry timeouts
- lightweight package bundling: ignores test runner cache artifacts

- - -
## v0.6.1 - 2026-09-13
#### Bug Fixes
- (**ci**) add retry loop to vsce publish to handle transient gallery timeouts - (ceadd07) - Mark Fenderov

- - -
## v0.6.0 - 2026-09-13
#### Features
- add in-editor @vscode/test-electron E2E testing suite - (a63803a) - Mark Fenderov
#### Bug Fixes
- update engines.vscode and @types/vscode to ^1.125.0 to pass vsce package gate - (57a3396) - Mark Fenderov

- - -

## v0.5.0 - 2026-09-12
#### Features
- add live status bar usage quota meter and hover tooltip - (af262cf) - Mark Fenderov

- - -

## v0.4.0 - 2026-09-12
#### Features
- automatically enable chat.agentHost.byokModels.enabled for Agent Mode - (70216da) - Mark Fenderov

- - -

## v0.3.4 - 2026-09-12
#### Bug Fixes
- remove proposed API editTools which caused runtime rejection and model disappearance - (d4d7af6) - Mark Fenderov

- - -

## v0.3.3 - 2026-09-12
#### Bug Fixes
- set extensionKind to workspace-first for Remote-WSL and sync .vscode-server paths - (07907d1) - Mark Fenderov

- - -

## v0.3.2 - 2026-09-12
#### Continuous Integration
- add cross-platform test matrix (linux, windows, macos), docker verification, and integration tests - (ae0f3ca) - Mark Fenderov

- - -

## v0.3.1 - 2026-09-12
#### Bug Fixes
- prevent model list erasure on empty fetch, add config key fallback and Windows paths - (9a96363) - Mark Fenderov

- - -

## v0.3.0 - 2026-09-12
#### Features
- accurate 1M model context limits, editTools capabilities, and Windows/WSL cross-profile sync - (e9b0884) - Mark Fenderov

- - -

## v0.2.1 - 2026-09-12
#### Bug Fixes
- add maxInputTokens and modelOptions to models for Copilot selection - (5d43a81) - Mark Fenderov

- - -

## v0.2.0 - 2026-09-12
#### Features
- (**ci**) automate versioning on push to main via cocogitto - (7ab0e6b) - Mark Fenderov
#### Continuous Integration
- remove obsolete verify-pat step from release workflow - (ed75363) - Mark Fenderov

- - -

Changelog generated by [cocogitto](https://github.com/cocogitto/cocogitto).