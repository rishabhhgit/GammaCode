# Gamma Code

AI-powered desktop code editor.

## Features

- Multi-model AI chat (Copilot, OpenAI, Anthropic, OpenRouter, Ollama, custom endpoints)
- AI reads, writes, and runs code with permission gates
- Monaco editor with file explorer and tabs
- Integrated terminal with full PTY support
- Git integration with branch switching and diffs
- Session checkpoint/restore to revert AI changes
- Custom AI agents and plugin system
- Cross-platform (macOS, Windows, Linux)

## Tech Stack

- **Frontend:** React 19, Vite, Monaco Editor, xterm.js
- **Backend:** Node.js, WebSocket, node-pty
- **Desktop:** Electron
- **AI:** OpenAI-compatible API, Anthropic API, GitHub Copilot OAuth
- **Tooling:** TypeScript, pnpm, Turborepo, Zod

## Development

```bash
pnpm install
pnpm dev
```

## Build

```bash
pnpm dist:mac   # macOS
pnpm dist:win   # Windows
pnpm dist:linux # Linux
```
