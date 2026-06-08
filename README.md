# 🧠 NodeBrain — AI Agent Command Center
<img width="3174" height="633" alt="Transparent_Github_Readme_Logo" src="https://github.com/user-attachments/assets/60c2952b-3f3d-4a88-83e3-2d23e7765fcd" />

NodeBrain™ is a local-first (with potential for web deployment) system for building and running AI agents that actually do things.

> ⚠️ **Windows users:** NodeBrain is currently unsigned. Windows SmartScreen may show a warning on first install. Click "More info" → "Run anyway" to proceed. NodeBrain is fully open source — you can review every line of code on GitHub.

Agents are created from chat and turned into persistent nodes in a visual graph. They can execute tasks on schedule, interact with external tools, and run structured workflows while you monitor everything in real time.

---

## Overview 🔎

NodeBrain is designed to act as a **command center for AI-driven automation**.

Instead of opaque assistants or autonomous systems you cannot inspect, NodeBrain provides **transparent, controllable workflows** where every task, dependency, and integration is visible.

The system revolves around persistent AI agents that can:

- execute scheduled tasks using natural language (e.g. "every morning at 9am")
- interact with external APIs and tools via MCP (Model Context Protocol)
- remember context across tasks using local RAG (Retrieval-Augmented Generation)
- run structured workflows
- be monitored and modified in real time
- delegate tasks to other connected agents (up to 3 levels deep, unlimited width)
- pause before destructive actions when Approval Mode is enabled
- run in Dry-Run mode to simulate tool calls without side effects

**What "local-first" means here:** the NodeBrain app, your agent definitions, your encrypted credentials, your task history, and your RAG memory all live on your machine — there is no NodeBrain server in the middle. However, the *AI reasoning itself* runs on whichever model provider you configure. If you use a hosted provider (OpenAI, Groq, Anthropic, Gemini, Mistral, Together, Fireworks), your prompts and any file or task content the agent processes are sent to that provider's API to be processed, exactly as if you used their app directly. If you want inference to stay entirely on your machine, use **Ollama**, which runs locally with no external API calls. See [Security & Architecture Philosophy](#security--architecture-philosophy-) for the full data-flow picture.

---

## Getting Started

### Prerequisites

- Node.js v18 or higher — download from [nodejs.org](https://nodejs.org) (LTS version)
- An API key from any supported provider (OpenAI, Groq, Anthropic, Gemini, Mistral, etc.), or [Ollama](https://ollama.com) for fully local inference

### Installation (Recommended)
NodeBrain is currently unsigned. Windows may show a SmartScreen warning — click "More info" → "Run anyway" to proceed. The full source code is on GitHub if you want to verify it yourself. Download from the **Releases** tab.

- **NodeBrain Setup 0.3.5.exe**  
  Installs NodeBrain on your system.

- **NodeBrain-0.3.5-portable.exe**  
  Run instantly without installation.

### Installation (Development)

Clone the repository and install dependencies for all three parts of the project.
```bash
git clone https://github.com/jerelle-rimando/nodebrain.git
cd nodebrain
```
```bash
npm install
npm install --prefix backend
npm install --prefix frontend
```

### Configuration

Copy the example environment file.

**Mac/Linux:**
```bash
cp backend/.env.example backend/.env
```

**Windows:**
```bash
copy backend\.env.example backend\.env
```

> ✅ `VAULT_SECRET` is auto-generated on first run and saved to your `.env` automatically. You do not need to set it manually.

### Running
```bash
npm run dev
```

This starts both the backend (port 3001) and frontend (port 5173) simultaneously.

Open your browser and go to:

http://localhost:5173

### First Time Setup

> ⏳ **First run note:** NodeBrain downloads a ~25MB local embedding model in the background on first launch. The app starts immediately — the model loads quietly behind the scenes. This only happens once.
> MCP integrations also download their servers from npm on first use, which may take a moment and requires an internet connection the first time each integration is used.

1. Click the **Vault** tab (shield icon) and add your API key for your preferred provider
2. Click the **Integrations** tab (plug icon) to connect external services like Telegram, GitHub, Slack, Notion, and more
3. Go to the **Dashboard** tab and type something like "Create an agent that summarizes news every morning"
4. Click your agent in the Active Agents list to chat with it directly
5. Switch to the **NodeGraph** tab to see your agent as a node, view task history, and run tasks visually

> 💡 **Note on running actions:** NodeBrain currently performs tool actions (sending messages, reading files, etc.) through **agents**. Create an agent for the task, or open an existing agent and give it the task directly. Typing a one-off command into the general Dashboard chat will hold a conversation but does not yet execute tools on its own — this is a known limitation being addressed in an upcoming release.

### Supported AI Providers

NodeBrain is model-agnostic and works with any of the following out of the box:

- OpenAI (GPT-4o, GPT-4o-mini, etc.)
- Groq (Llama, Mixtral, Gemma)
- Google Gemini (Gemini 2.0 Flash, etc.)
- Anthropic (Claude Sonnet, Claude Haiku, etc.)
- Mistral
- Together AI
- Fireworks AI
- Ollama (fully local, no API key needed)

> 💡 **For best tool calling performance**, OpenAI GPT-4o or Anthropic Claude are recommended.
> Groq works but may require more explicit prompts for complex tool use.

### Security Notes

- `VAULT_SECRET` is auto-generated with 32 cryptographically random bytes on first run
- All API keys are encrypted with AES-256 before being stored locally
- Your agent definitions, credentials, task history, and RAG memory are stored only on your machine. The one exception is the AI inference itself: when you use a hosted provider, the content your agents process is sent to that provider's API. Integrations also send data outward to their own services (e.g. a Telegram message goes to Telegram's API). Use Ollama if you need inference to stay fully local.
- The database is stored at `%APPDATA%\NodeBrain\data\nodebrain.db` (Windows) or `~/Library/Application Support/NodeBrain/data/nodebrain.db` (Mac). It is never inside the install directory.
- Never commit your `.env` file — it is already in `.gitignore`

### ⚠️ Local Filesystem Integration Warning

The Local Filesystem integration gives agents direct read and write access to a folder on your machine. **Only point it at a specific folder you intend agents to access** — never use a root path like `C:\`, `C:\Windows`, or `~`. Agents operating on system directories can cause irreversible damage. You are solely responsible for the path you configure.

### Disclaimer

NodeBrain is provided **as-is** with no warranty of any kind, express or implied. The authors and contributors are not liable for any damages, data loss, or unintended consequences arising from the use of this software. You are responsible for your own API keys, credentials, and the actions your agents take. Use at your own risk.

---

## Core Interface 🤖

NodeBrain is built around several primary systems:

### Dashboard ⚙️
Create and control agents through chat. Click any agent in the Active Agents list to open a dedicated chat with that agent directly — no need to reference it by name.

### NodeGraph 🌐
Visualize agents and their execution status in a live graph interface. Click any node to open a detail panel showing agent configuration, task history, and a direct run interface. Node border colors reflect live status — purple for running, red for error.

### Credential Vault 🔒
Securely store and manage encrypted API keys for AI providers and integrations. Use the Settings section at the bottom to enable launch at startup or reset all data.

### Integrations 🔌
Connect external services so your agents can take action in the world. Each integration shows connection status, what tools it unlocks, and step-by-step setup instructions.

### Templates 📋
Install curated agent teams with one click, or import your own agent configurations as JSON files. Export any agent or team from the NodeGraph as a shareable template.

### Analytics 📊
Track token usage, estimated cost per agent, task success rates, and activity over time. Helps you monitor spend and identify which agents run most frequently.

---

## Integrations

NodeBrain supports the following integrations and their agent-accessible tools:

| Integration | Tools | Status |
|---|---|---|
| Telegram | Send messages, photos, documents, get chat info | Ready |
| GitHub | List repos, create issues, open PRs, read files | Ready |
| Slack | Send messages, list channels, upload files | Ready |
| Notion | Read/write pages, query databases | Ready |
| Brave Search | Web search, news search, image search | Ready |
| Local Filesystem | Read/write files, list directories | Ready |
| Gmail | Read and send email | Requires Google Cloud setup |
| Google Drive | List and manage files | Requires Google Cloud setup |
| Google Docs | Create and edit documents | Requires Google Cloud setup |
| Google Sheets | Read and write spreadsheets | Requires Google Cloud setup |
| Google Calendar | Create and manage events | Requires Google Cloud setup |

You can also connect **any custom MCP server** via the Integrations tab by providing its install command.

> Google Workspace integrations require setting up your own Google Cloud project and OAuth credentials. See [docs/google-oauth-setup.md](docs/google-oauth-setup.md) for instructions.

> ⚠️ **Windows note:** When an integration connects, its MCP server starts as a child process and may briefly open a console window. **Do not close these windows** — closing one terminates that integration's server, and the integration will stop working until you reconnect it or restart NodeBrain. Hiding these windows automatically is a known issue being worked on.

---

## RAG Memory

Every agent has access to a local vector memory system powered by `@xenova/transformers` and `vectra`. Embeddings are generated entirely on your machine using the `all-MiniLM-L6-v2` model — no API calls, no cost.

When an agent runs a task, relevant context is automatically retrieved from its memory and injected into the system prompt. This means agents remember previous context without you having to repeat yourself.

---

## MCP Tool Calling

NodeBrain implements the **Model Context Protocol (MCP)** for tool execution. When an integration is connected, NodeBrain spawns the MCP server as a local child process (over stdio) and discovers its available tools automatically. The MCP transport is entirely local — servers run on your machine, not on any remote host.

When an agent runs a task, it executes in an agentic loop:
1. Query local RAG for relevant context
2. Call the configured AI model with the available tools listed
3. Execute any tool calls the model requests, via the local MCP server
4. Feed results back to the model
5. Repeat until the model returns a final answer

This loop supports a maximum of 15 tool iterations per task to prevent runaway execution.

---

## Natural Language Scheduling

Agents can be scheduled using plain English. NodeBrain converts natural language to cron expressions automatically:

- "every morning at 9am" → `0 9 * * *`
- "every hour" → `0 * * * *`
- "every Monday" → `0 9 * * 1`
- "every weekday at 8am" → `0 8 * * 1-5`
- "every 30 minutes" → `*/30 * * * *`

Scheduled agents run only while NodeBrain is running. Use the "Launch at startup" toggle in Vault settings so agents resume automatically after a reboot.

---

## Who NodeBrain Is For 👤

NodeBrain is designed primarily for:

- solo developers
- technical builders
- automation enthusiasts
- AI workflow designers

If you want an AI system that behaves more like a **command center for automation** than a black-box assistant, NodeBrain is built for that.

---

## Why NodeBrain Is Open Source 🌎

Open sourcing the project provides several important benefits:

- **Community contributions** – developers can improve the system through fixes, features, and documentation.
- **Easy experimentation** – anyone can run NodeBrain locally without relying on a central server.
- **Demand validation** – community activity shows how people use and value the tool.
- **Finding collaborators** – active contributors often become long-term collaborators or maintainers.

---

## Local-First Architecture 📍

NodeBrain's orchestration runs entirely on your machine and does not require a hosted NodeBrain service: your agents, credentials, task history, scheduling, MCP servers, and RAG memory are all local. What is *not* necessarily local is AI inference — that runs on whichever model provider you connect in the Credential Vault. With a hosted provider, prompt and task content is sent to that provider; with Ollama, inference stays on your machine too.

Future versions may support web or hosted environments — see [Security & Architecture Philosophy](#security--architecture-philosophy-) for the reasoning behind starting local-first.

---

## Known Limitations 🚧

- **Direct chat actions** — tool actions currently run through agents (created or directly invoked). One-off commands typed into the general Dashboard chat do not yet trigger tools on their own. Use an agent for action tasks. This is being addressed in an upcoming release.
- **Windows console windows** — connecting an integration may open a console window for its MCP server process; closing it stops that integration. Automatic hiding of these windows is not yet implemented.
- **Google Workspace** — requires manual setup of a Google Cloud project and the `@googleworkspace/cli` installed globally. Not recommended for non-technical users yet. See [docs/google-oauth-setup.md](docs/google-oauth-setup.md).
- **Tool calling reliability** — varies by AI provider. OpenAI GPT-4o and Anthropic Claude have the most reliable tool calling. Groq works but may need explicit prompts for complex tool use.
- **Agent delegation depth** — agents can delegate to sub-agents up to 3 levels deep. Wider delegation (1 parent to many children) is unlimited.
- **Local only** — no cloud deployment, no mobile, no collaboration features yet. Cloud version is planned.
- **Scheduled agents require the app to be running** — use the "Launch at startup" toggle in Vault settings so agents run automatically after reboot.
- **Dependency and supply-chain risk** — NodeBrain relies on third-party npm packages (including the MCP SDK, OpenAI SDK, and Anthropic SDK) and launches integration MCP servers via `npx`, which fetches packages from npm. A compromise of any upstream package could expose data or credentials. If you ever suspect a dependency has been compromised, rotate all credentials stored in the Vault immediately, and keep dependencies updated and monitored (e.g. via Dependabot and npm advisories).
- **Deprecated Slack package** — still works but will be replaced when Slack's official stdio MCP server is available.

---

## Security & Architecture Philosophy 🔐

MCP introduces real security concerns in centralized deployments — unauthorized access, over-privileged servers, and prompt injection are legitimate risks when multiple users share infrastructure.

NodeBrain's local-first architecture mitigates many of these risks by design:

- Every MCP server runs on your own machine with your own credentials, over a local stdio connection — there is no remote MCP host
- There is no central NodeBrain server or shared infrastructure, significantly reducing the external attack surface
- Your agents only have access to what you explicitly connect in the Vault
- CORS restricts browser-based access to localhost only (any port) — no external origins can reach the backend, adding an additional layer of protection

**Where your data goes (be aware):**

- **AI inference** — with a hosted provider, your prompts and the content your agents process are sent to that provider's API. With Ollama, inference is fully local.
- **Integrations** — by design, integrations send data outward to their own services (Telegram messages to Telegram, commits to GitHub, etc.) using the tokens you provide.
- **Integration servers** — integration MCP servers are downloaded and run from npm via `npx` on first use. NodeBrain ships integrations from well-known publishers, but these are third-party packages executing on your machine with access to the environment they're given. Only connect integrations you intend to use, and only add custom MCP servers from sources you trust.

This isn't just a v0.1 limitation — it's a deliberate architectural choice. MCP is still evolving, and the security model for multi-user, web-based deployments is not yet fully mature.

By building local-first, NodeBrain avoids many server-side and multi-tenant risks that centralized agent platforms face today, while keeping control in the hands of the user.

When MCP security patterns for web deployments mature, NodeBrain is designed to evolve in that direction — but starting local-first ensures a stronger foundation rather than retrofitting security later.

For now, local-first prioritizes control and safety: your keys, your machine, your agents.

> ⚠️ **Third-party MCP servers:** NodeBrain only ships integrations from well-known publishers (Anthropic, Notion, GitHub, IQAi, Brave). Third-party MCP servers added by users or contributors are not audited. Only use MCP servers from sources you trust.

> ⚠️ **Network deployment:** NodeBrain is designed for localhost use only. Deploying to a networked environment without authentication, rate limiting, and input sanitization introduces significant security risks.

---

## License 🛡️

This project is licensed under the **GNU Affero General Public License v3 (AGPL-3.0)**.

### Why AGPL?

The AGPL ensures that improvements to the software remain open and benefit the community, even when the software is run as a hosted service.

In simple terms:

If you modify NodeBrain and make it available over a network (for example as a SaaS), those modifications must also be made open source.

This keeps the ecosystem fair while still allowing anyone to:

- use the software
- study the code
- modify it
- contribute improvements

---

## Commercial Licensing 💼

NodeBrain is licensed under AGPL-3.0 for open source use. This means you can use, modify, and distribute NodeBrain freely as long as you open source your modifications under the same license.

If you want to use NodeBrain in a commercial product or hosted service without open sourcing your modifications, a separate commercial license is available.

Contact Jerelle Rimando at **https://www.linkedin.com/in/jerellerimando/** for commercial licensing inquiries.

---

## Contributing 🤝

Contributions are welcome.

If you'd like to help improve NodeBrain:

- open an issue for bugs or ideas
- submit pull requests for improvements
- help expand documentation

Community collaboration is a core part of how this project evolves.

---

## Legal ⚖️

This software is provided without warranty. The developers of NodeBrain accept no liability for damages, data loss, security breaches, or unintended agent behavior. By using NodeBrain you agree that you are solely responsible for how you configure and run it, including any API costs incurred, any data accessed by agents, and any actions taken by integrations you connect.
