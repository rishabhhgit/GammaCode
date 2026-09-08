# Gamma Code

An AI-powered desktop code editor built with Electron, React, and Node.js. Think Cursor or Windsurf — but open source and self-hosted.

![Gamma Code](https://img.shields.io/badge/status-active-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

## About

Gamma Code is a local-first, AI-native code editor that lets you chat with AI models to read, write, and execute code directly in your workspace. Unlike cloud-based AI tools, Gamma Code runs entirely on your machine — your code never leaves your computer unless you choose to send it to an AI provider.

### Why Gamma Code?

- **Privacy first** — All file operations happen locally. Only the prompts you send to AI providers leave your machine.
- **Multi-model** — Use GitHub Copilot, OpenAI, Anthropic Claude, Google Gemini, OpenRouter, or local Ollama models. Switch between them instantly.
- **Tool calling** — AI can actually *do* things: read files, write files, run shell commands, list directories — with permission gates so you stay in control.
- **Real terminal** — Full PTY terminal emulation via xterm.js and node-pty. Not a toy — a real shell.
- **Git aware** — Branch switching, diffs, and commit history built in.
- **Session history** — Every AI conversation is saved. Revert any AI change with checkpoint/restore.
- **Extensible** — Custom AI agents, plugin system, and skill-based workflows.

## Features

### AI Integration
- **6 AI providers** — Copilot (OAuth), OpenAI, Anthropic, Google Gemini, OpenRouter, Ollama
- **Dynamic model list** — Fetches available models from each provider's API
- **Tool execution** — AI can read/write files and run commands with your approval
- **Streaming responses** — Real-time token-by-token output
- **Session checkpoints** — Revert any AI-made file changes

### Editor
- **Monaco Editor** — The same editor powering VS Code
- **File explorer** — Browse your workspace with syntax highlighting
- **Multi-tab** — Open multiple files simultaneously
- **Context awareness** — AI sees which file you have open

### Terminal
- **Full PTY** — node-pty powered terminal with xterm.js
- **256-color** — Full color support
- **Multi-shell** — Uses your system shell (zsh, bash, fish, etc.)

### Git
- **Branch switching** — Change branches from the UI
- **Status indicators** — See modified files at a glance
- **Commit history** — Browse recent commits

### Configuration
- **Global config** — `~/.config/gamma-code/gamma-code.jsonc`
- **Project config** — `gamma-code.jsonc` in your workspace root
- **Permission system** — Control what AI can do (allow/ask/deny per tool)
- **Custom agents** — Define specialized AI assistants with custom system prompts
- **Skills** — Extend AI capabilities with skill files

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Vite 7, Monaco Editor, xterm.js |
| Backend | Node.js, TypeScript, WebSocket, node-pty |
| Desktop | Electron 36 |
| AI | OpenAI API, Anthropic API, Gemini API, Copilot OAuth |
| Validation | Zod |
| Build | pnpm, Turborepo |
| Packaging | electron-builder |

## Getting Started

### Prerequisites

- Node.js >= 20
- pnpm (via corepack)

### Installation

```bash
# Clone the repo
git clone https://github.com/rishabhhgit/GammaCode.git
cd GammaCode

# Install dependencies
corepack enable
corepack prepare pnpm@10.4.1 --activate
pnpm install
```

### Environment Setup

Create `apps/server/.env`:

```env
# AI Provider API Keys (at least one required for AI features)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
GITHUB_TOKEN=ghp_...        # For Copilot fallback
OPENROUTER_API_KEY=sk-or-...

# Optional
GAMMA_CODE_MASTER_KEY=      # Encrypt stored auth tokens
GAMMA_CODE_LOG_LEVEL=info   # debug, info, warn, error
```

Or add keys at runtime via the **Settings** UI in the app.

### Development

```bash
# Run everything (web + server + Electron)
pnpm dev

# Run individual services
pnpm dev:web       # Vite dev server on http://localhost:3000
pnpm dev:server    # API server on http://localhost:3030
pnpm dev:desktop   # Electron app (requires web build first)
```

### Build & Package

```bash
# Build for your platform
pnpm dist:mac      # macOS (.zip)
pnpm dist:win      # Windows (NSIS installer)
pnpm dist:linux    # Linux (AppImage)
```

## Project Structure

```
GammaCode/
├── apps/
│   ├── web/              # React frontend (Vite)
│   │   └── src/
│   │       ├── App.tsx
│   │       └── components/
│   │           ├── Dock/          # Input area + model selector
│   │           ├── MessageTimeline/ # Chat messages
│   │           └── Sidebar/       # File tree + sessions
│   ├── server/           # Node.js backend
│   │   └── src/
│   │       ├── index.ts   # Main server (API + WebSocket)
│   │       ├── config.ts  # Config loading
│   │       ├── crypto.ts  # Encryption utils
│   │       └── ...
│   └── desktop/          # Electron shell
│       └── src/
│           └── main.ts    # Electron main process
├── packages/
│   └── shared/           # Shared types & Zod schemas
└── package.json
```

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/workspace` | Workspace snapshot (files, sessions, providers) |
| GET | `/api/auth/status` | Provider authentication status |
| POST | `/api/auth/keys` | Save an API key |
| DELETE | `/api/auth/keys/:provider` | Remove a stored key |
| POST | `/api/sessions` | Create a new AI session |
| POST | `/api/sessions/:id/messages` | Send a message to AI |
| GET | `/api/sessions/:id` | Get session detail |
| POST | `/api/runs` | Execute a shell command |
| GET | `/api/git/status` | Git branch and status |
| GET | `/api/provider-usage` | API usage per provider |

## Configuration

### gamma-code.jsonc

```jsonc
{
  "permissions": {
    "tools": {
      "run_command": "ask",    // "allow" | "ask" | "deny"
      "read_file": "allow",
      "write_file": "ask",
      "list_files": "allow"
    }
  },
  "agents": {
    "enabled": true,
    "list": [
      {
        "id": "reviewer",
        "label": "Code Reviewer",
        "description": "Reviews code for bugs and improvements",
        "systemPrompt": "You are a senior code reviewer..."
      }
    ]
  }
}
```

## License

MIT
