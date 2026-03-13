# 🧠 NodeBrain — AI Agent Command Center
<img width="3174" height="633" alt="Github Readme Logo" src="https://github.com/user-attachments/assets/7b8e79d9-cf2e-49aa-bfcf-c10dddd5c0c8" />
NodeBrain™ is a local-first (with potential for web deployment) system for building and running AI agents that actually do things.
Agents are created from chat and turned into persistent nodes in a visual graph. They can execute tasks on time, interact with external tools, and run structured workflows while you monitor everything in real time.

---

## Overview 🔎

NodeBrain is designed to act as a **command center for AI-driven automation**.

Instead of opaque assistants or autonomous systems you cannot inspect, NodeBrain provides **transparent, controllable workflows** where every task, dependency, and integration is visible.

The system revolves around persistent AI agents that can:

- execute scheduled tasks  
- interact with external APIs and tools  
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

Copy the example environment file and optionally edit it to set a custom vault encryption secret.

**Mac/Linux:**
```bash
cp backend/.env.example backend/.env
```

**Windows:**
```bash
copy backend\.env.example backend\.env
```
⚠️ IMPORTANT ⚠️
Open `backend/.env` and change `VAULT_SECRET` to any long random string. This is used to encrypt your stored API keys — keep it private and never commit it.

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

1. Click the **Vault** tab (shield icon in the sidebar)
2. Add your API key — select your provider (OpenAI, Groq, Gemini, etc.) and paste your key
3. Go back to the **Dashboard** tab
4. Type something like "Create an agent that answers questions about science"
5. Switch to the **NodeGraph** tab to see your agent appear as a node
6. Click **Run** on the node and give it a task

### Supported Providers

NodeBrain is model-agnostic and works with any of the following out of the box:

- OpenAI (GPT-4o, GPT-4o-mini, etc.)
- Groq (Llama, Mixtral, Gemma)
- Google Gemini (Gemini 2.0 Flash, etc.)
- Anthropic (Claude Sonnet, Claude Haiku, etc.)
- Mistral
- Together AI
- Fireworks AI
- Ollama (fully local, no API key needed)

### Notes

- All API keys are encrypted with AES-256 before being stored locally
- No data ever leaves your machine except for the API calls you explicitly make
- The database is stored at `backend/data/nodebrain.db` and is excluded from git
- Never commit your `.env` file — it is already in `.gitignore`

---

## Core Interface 🤖

NodeBrain is built around three primary systems:

### Dashboard ⚙️
Create, control, and modify agents through natural language chat.

### NodeGraph 🌐
Visualize tasks, dependencies, and execution status in a live graph interface.

### Credential Vault 🔒
Securely store and manage encrypted API keys for models and integrations.

---

## Local-First Architecture 📍

NodeBrain runs locally and does not require a hosted service.

Users can connect their preferred AI models by adding API keys inside the **Credential Vault**.

This allows developers to choose their own infrastructure while maintaining full control over:

- data
- models
- integrations
- execution

Future deployments may support **web or hosted environments**, but the core philosophy remains **local-first and transparent**.

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

## Contributing 🤝

Contributions are welcome.

If you'd like to help improve NodeBrain:

- open an issue for bugs or ideas  
- submit pull requests for improvements  
- help expand documentation

Community collaboration is a core part of how this project evolves.
