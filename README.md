# agentRouter

Agent Router 是一个 Windows 桌面应用，用来在 OpenAI 兼容、Anthropic 兼容、Gemini 兼容以及自定义服务商配置之间切换本地 AI 编程 Agent 的配置。

项目基于 Electron、electron-vite、React 和 TypeScript 构建。

![Agent Router 首页](docs/assets/home.png)

## 功能

- 分别管理 Codex、Claude Code 和 Gemini 的服务商配置。
- 为每个 Agent 切换 Base URL、API Key、模型、思维强度和提示词设置。
- 将可编辑模板渲染到各 Agent 的本地配置文件中。
- 写入前自动用时间戳备份已有配置文件。
- 读取并监听当前配置文件和提示词文件，外部修改会同步反映到界面。
- 从兼容服务商接口获取模型列表。

## 环境要求

- Windows 11
- Node.js
- pnpm

## 开发

安装依赖：

```bash
pnpm install
```

以开发模式启动桌面应用：

```bash
pnpm dev
```

运行生产构建检查：

```bash
pnpm build
```

创建 Windows 安装包：

```bash
pnpm dist
```

## 项目结构

```text
src/main/       Electron 主进程和配置文件操作
src/preload/    暴露给渲染进程的安全桥接层
src/renderer/   React 界面
src/shared/     共享 TypeScript 类型
```

## 工作方式

服务商配置保存在 Electron user data 中。每个 Agent 目标都有一个配置文件路径和一个模板。应用目标时，Agent Router 会使用当前选中的服务商和全局提示词渲染模板，然后写入目标文件。

覆盖已有配置文件前，会先复制为 `*.bak-<timestamp>` 备份文件。备份保留数量可以在应用中配置。

可用模板变量：

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

默认目标路径：

```text
%USERPROFILE%/.codex/config.toml
%USERPROFILE%/.codex/AGENTS.md
%USERPROFILE%/.claude/settings.json
%USERPROFILE%/.claude/CLAUDE.md
%USERPROFILE%/.gemini/settings.json
%USERPROFILE%/.gemini/GEMINI.md
```

## 安全说明

本应用会写入本地 Agent 配置文件，其中可能包含 API Key。不要把生成的配置文件、`.env` 文件、打包产物、缓存或 Electron user-data 状态提交到公开仓库。
