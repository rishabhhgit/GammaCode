# Gamma Code

An AI-powered desktop code editor built with Electron, React, and Node.js. Think Cursor or Windsurf — but open source and self-hosted.

![Gamma Code](https://img.shields.io/badge/status-active-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue) ![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)

## About Gamma Code

Gamma Code is a local-first, open-source AI code editor designed for developers who want the fluidity of AI-assisted engineering without sacrificing code privacy, software freedom, or tool control.

Unlike proprietary tools that tunnel your entire codebase through remote cloud servers, Gamma Code operates strictly on your machine. Your files, workspaces, git repositories, and shell commands stay local. Only the explicit context and prompts you choose to send are dispatched to your preferred AI provider — whether that is GitHub Copilot, Anthropic Claude, OpenAI, Google Gemini, OpenRouter, or completely offline local models via Ollama.

### Core Philosophy

- **Local-First & Private** — Your source code never leaves your computer. File reads, writes, AST searches, and terminal commands execute in a sandboxed local Node.js process.
- **Provider Agnostic** — Seamlessly switch between cutting-edge frontier models (Claude 3.7 Sonnet, GPT-4o, Gemini 2.0 Flash) and local offline LLMs (Llama 3, DeepSeek-Coder, Qwen) with zero lock-in.
- **Autonomous Yet Safe** — Powerful tool execution loop allowing AI to read files, write changes, and verify code with build/test commands — gated by customizable permission policies (`allow`, `ask`, `deny`).
- **True Development Environment** — Built on VS Code's battle-tested Monaco Editor and native hardware-accelerated PTY terminal emulation (xterm.js + node-pty).
- **Session Reversibility** — Full conversation state and file checkpoints allow instant one-click diff reviews and rollback of any AI modifications.

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

Copy the example env file and add at least one provider key:

```bash
cp apps/server/.env.example apps/server/.env
```

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
# Health-check your machine first (Node/pnpm/builds/ports/keys)
pnpm doctor

# If a previous server instance is still holding ports 3000/3030/3031
pnpm stop

# Run everything (web + server + Electron)
pnpm dev

# Run individual services
pnpm dev:web       # Vite dev server on http://127.0.0.1:3000
pnpm dev:server    # API server on http://127.0.0.1:3030
pnpm dev:desktop   # Electron app (requires web build first)
```

Open http://127.0.0.1:3000 in a browser, or launch the desktop app. The API
server binds `127.0.0.1:3030` only — always use `127.0.0.1` (not `localhost`)
in URLs on Windows, where `localhost` can resolve to IPv6 `::1` first.

### Tuning large tasks

Long agentic tasks are bounded by three tunables (set in `apps/server/.env`):

| Variable | Default | Meaning |
|----------|---------|---------|
| `GAMMA_CODE_MAX_TOOL_ROUNDS` | `50` | Tool-call rounds per user message (max 200) |
| `GAMMA_CODE_COMMAND_TIMEOUT_MS` | `300000` | Timeout for AI-run shell commands (5 min) |
| `GAMMA_CODE_STREAM_IDLE_TIMEOUT_MS` | `180000` | Abort a provider stream after this much silence |

### Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Port 3030 is already in use` | `pnpm stop`, then `pnpm dev` again |
| `Shared package not built` | `pnpm --filter @gamma-code/shared build` (or just `pnpm dev` — it builds deps first) |
| `node-pty failed to load` | `pnpm rebuild node-pty` (needs C++ build tools on Windows) |
| Every AI call says "No API key" | Add a key in Settings, or create `apps/server/.env` from the example |
| Web UI can't reach the API | Use `http://127.0.0.1:3000` / `http://127.0.0.1:3030`, not `localhost` |
| Anything else | Run `pnpm doctor` — it prints PASS/WARN/FAIL for every common failure |


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
| POST | `/api/messages` | Send a message to AI (starts the agentic run) |
| GET | `/api/sessions/:id/stream` | SSE stream for live tokens/tool events |
| POST | `/api/sessions/:id/abort` | Abort an in-flight AI run |
| GET | `/api/sessions/:id` | Get session detail |
| POST | `/api/permissions/approve` | Approve a pending tool permission |
| GET | `/api/git/status` | Git branch and status |
| GET | `/api/provider-usage` | API usage per provider |
| WS | `ws://127.0.0.1:3031` | PTY terminal |

## License

MIT
