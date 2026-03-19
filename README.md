# 🧠 NodeBrain — AI Agent Command Center
<img width="3174" height="633" alt="Github Readme Logo" src="https://github.com/user-attachments/assets/7b8e79d9-cf2e-49aa-bfcf-c10dddd5c0c8" />
NodeBrain™ is a local-first (with potential for web deployment) system for building and running AI agents that actually do things.
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

Everything runs **locally by default**, giving users full control over their environment and data.

---

## Getting Started

### Prerequisites

- Node.js v18 or higher — download from [nodejs.org](https://nodejs.org) (LTS version)
- An API key from any supported provider (OpenAI, Groq, Anthropic, Gemini, Mistral, etc.)

### Installation

Clone the repository and install dependencies for all three parts of the project.
```bash
git clone https://github.com/YOURUSERNAME/nodebrain.git
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
```
http://localhost:5173
```

### First Time Setup

> ⏳ **First run note:** NodeBrain downloads a ~25MB local embedding model on startup. 
> This only happens once. If the backend seems slow to start, wait 30-60 seconds — it's normal.
> MCP integrations also download their servers on first use, which may take a moment.

1. Click the **Vault** tab (shield icon) and add your API key for your preferred provider
2. Click the **Integrations** tab (plug icon) to connect external services like Telegram, GitHub, Slack, Notion, and more
3. Go to the **Dashboard** tab and type something like "Create an agent that summarizes news every morning"
4. Click your agent in the Active Agents list to chat with it directly
5. Switch to the **NodeGraph** tab to see your agent as a node, view task history, and run tasks visually

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

> 💡 **For best tool calling performance**, OpenAI GPT-4o or Anthropic Claude Opus 4.6 are recommended. 
> Groq works but may require more explicit prompts for complex tool use.

### Security Notes

- `VAULT_SECRET` is auto-generated with 32 cryptographically random bytes on first run
- All API keys are encrypted with AES-256 before being stored locally
- No data ever leaves your machine except for the API calls you explicitly make
- The database is stored at `backend/data/nodebrain.db` and is excluded from git
- Never commit your `.env` file — it is already in `.gitignore`

### ⚠️ Local Filesystem Integration Warning

The Local Filesystem integration gives agents direct read and write access to a folder on your machine. **Only point it at a specific folder you intend agents to access** — never use a root path like `C:\`, `C:\Windows`, or `~`. Agents operating on system directories can cause irreversible damage. You are solely responsible for the path you configure.

### Disclaimer

NodeBrain is provided **as-is** with no warranty of any kind, express or implied. The authors and contributors are not liable for any damages, data loss, or unintended consequences arising from the use of this software. You are responsible for your own API keys, credentials, and the actions your agents take. Use at your own risk.

---

## Core Interface 🤖

NodeBrain is built around four primary systems:

### Dashboard ⚙️
Create and control agents through chat. Click any agent in the Active Agents list to open a dedicated chat with that agent directly — no need to reference it by name.

### NodeGraph 🌐
Visualize agents and their execution status in a live graph interface. Click any node to open a detail panel showing agent configuration, task history, and a direct run interface. Node border colors reflect live status — purple for running, red for error.

### Credential Vault 🔒
Securely store and manage encrypted API keys for AI providers and integrations.

### Integrations 🔌
Connect external services so your agents can take action in the world. Each integration shows connection status, what tools it unlocks, and step-by-step setup instructions.

---

## Integrations

NodeBrain supports **11 integrations** with **50+ agent-accessible tools**:

| Integration | Tools |
|---|---|
| Telegram | Send messages, photos, documents, get chat info |
| GitHub | List repos, create issues, open PRs, read files |
| Slack | Send messages, list channels, upload files |
| Notion | Read/write pages, query databases |
| Brave Search | Web search, news search, image search |
| Local Filesystem | Read/write files, list directories |
| Gmail | Read and send email |
| Google Drive | List and manage files |
| Google Docs | Create and edit documents |
| Google Sheets | Read and write spreadsheets |
| Google Calendar | Create and manage events |

> Google Workspace integration requires setting up your own Google Cloud project. See [docs/google-oauth-setup.md](docs/google-oauth-setup.md) for instructions.

---

## RAG Memory

Every agent has access to a local vector memory system powered by `@xenova/transformers` and `vectra`. Embeddings are generated entirely on your machine using the `all-MiniLM-L6-v2` model — no API calls, no cost.

When an agent runs a task, relevant context is automatically retrieved from its memory and injected into the system prompt. This means agents remember previous context without you having to repeat yourself.

---

## MCP Tool Calling

NodeBrain implements the **Model Context Protocol (MCP)** for tool execution. When an integration is connected, NodeBrain spawns the MCP server as a child process and discovers its available tools automatically.

During task execution, the agent runs in an agentic loop:
1. Query RAG for relevant context
2. Call the AI model with available tools listed
3. Execute any tool calls the model requests via MCP
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

NodeBrain runs entirely on your machine and does not require a hosted service. Users connect their preferred AI models via the Credential Vault and choose their own infrastructure.

Future versions may support web or hosted environments — see [Security & Architecture Philosophy](#security--architecture-philosophy) for the reasoning behind starting local-first.

---

## Known Limitations 🚧

- **Google Workspace** — requires manual setup of a Google Cloud project and the `@googleworkspace/cli` installed globally. Not recommended for non-technical users yet. See [docs/google-oauth-setup.md](docs/google-oauth-setup.md).
- **Brave Search and Slack** — currently use deprecated npm packages that still work but may break in a future update. Replacements planned for v0.2.
- **Tool calling reliability** — varies by AI provider. OpenAI GPT-4o and Anthropic Claude have the most reliable tool calling. Groq works but may need explicit prompts for complex tool use.
- **No multi-agent coordination yet** — agents cannot communicate with or spawn each other. Planned for a future version.
- **Local only** — no cloud deployment, no mobile, no collaboration features yet.

---

## Security & Architecture Philosophy 🔐

MCP introduces real security concerns in centralized deployments — unauthorized access, over-privileged servers, and prompt injection are legitimate risks when multiple users share infrastructure.

NodeBrain's local-first architecture mitigates many of these risks by design:

- Every MCP server runs on your own machine with your own credentials
- There is no central server or shared infrastructure, significantly reducing the external attack surface
- Your agents only have access to what you explicitly connect in the Vault
- CORS restricts browser-based access to localhost, adding an additional layer of protection

This isn't just a v0.1 limitation — it's a deliberate architectural choice. MCP is still evolving, and the security model for multi-user, web-based deployments is not yet fully mature.

By building local-first, NodeBrain avoids many server-side and multi-tenant risks that centralized agent platforms face today, while keeping control in the hands of the user.

When MCP security patterns for web deployments mature, NodeBrain is designed to evolve in that direction — but starting local-first ensures a stronger foundation rather than retrofitting security later.

For now, local-first prioritizes control and safety: your keys, your machine, your agents.

> ⚠️ **Third party MCP servers:** NodeBrain only ships integrations from verified publishers (Anthropic, Notion, GitHub, IQAi). Third party MCP servers added by users or contributors are not audited. Only use MCP servers from sources you trust.

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

Contact **jerellerimando.dev@gmail.com** for commercial licensing inquiries.

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
