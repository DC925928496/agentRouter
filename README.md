# agentRouter

Agent Router is a Windows desktop app for switching local AI coding-agent
configuration between OpenAI-compatible, Anthropic-compatible, Gemini-compatible,
and custom provider profiles.

It is built with Electron, electron-vite, React, and TypeScript.

## Features

- Manage separate provider profiles for Codex, Claude Code, and Gemini.
- Switch base URL, API key, model, reasoning effort, and prompt settings per agent.
- Render editable templates into each agent's local config file.
- Preserve existing config files with timestamped backups before writing changes.
- Read and watch current config/prompt files so external edits are reflected in the UI.
- Fetch model lists from compatible provider endpoints.

## Requirements

- Windows 11
- Node.js
- pnpm

## Development

Install dependencies:

```bash
pnpm install
```

Start the desktop app in development mode:

```bash
pnpm dev
```

Run the production build check:

```bash
pnpm build
```

Create a Windows package:

```bash
pnpm dist
```

## Project Structure

```text
src/main/       Electron main process and config file operations
src/preload/    Safe bridge exposed to the renderer
src/renderer/   React UI
src/shared/     Shared TypeScript types
```

## How It Works

Provider profiles are stored in Electron user data. Each agent target has a
config file path and a template. When you apply a target, Agent Router renders
the template with the selected provider and global prompt, then writes the
result to the target file.

Existing config files are copied to `*.bak-<timestamp>` before overwrite. The
backup retention count is configurable in the app.

Available template variables include:

```text
{{provider.name}}
{{provider.baseUrl}}
{{provider.apiKey}}
{{provider.defaultModel}}
{{provider.smallFastModel}}
{{provider.reasoningEffortConfig}}
{{provider.contextWindowConfig}}
{{globalPrompt}}
{{json.globalPrompt}}
{{globalTemplate}}
{{isoDate}}
```

Default target paths:

```text
%USERPROFILE%/.codex/config.toml
%USERPROFILE%/.codex/AGENTS.md
%USERPROFILE%/.claude/settings.json
%USERPROFILE%/.claude/CLAUDE.md
%USERPROFILE%/.gemini/settings.json
%USERPROFILE%/.gemini/GEMINI.md
```

## Security Notes

This app writes local agent configuration files that may contain API keys. Do
not commit generated config files, `.env` files, packaged builds, caches, or
Electron user-data state to a public repository.
