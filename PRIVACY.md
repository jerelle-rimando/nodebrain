# Privacy

NodeBrain runs on your machine. Your agents, credentials, task history, RAG memory, and the SQLite database are stored locally and are never sent to NodeBrain.

NodeBrain has optional, anonymous usage telemetry. It is **off by default**. Nothing is sent unless you turn it on.

---

## Usage telemetry

### Consent

Telemetry is sent only after you grant consent, either in the setup wizard or in **Settings → Share anonymous usage data**. Until you choose, nothing is sent.

Some events are recorded before the wizard's consent step: the first launch, the launch itself, and any early setup failure. They are held in memory only. If you grant consent, they are queued. If you decline, or close the wizard without finishing, they are discarded.

### What is sent

Each event contains:

- **Event name**, for example `app_launched`, `task_completed`, `onboarding_step`
- **Timestamp** of the event
- **Anonymous install ID**: a random UUID generated on first launch. It is not derived from your hardware, account, or any personal information.
- **App version**
- **OS and OS release**, for example `win32` and `10.0.26200`
- **Event properties**: counts, durations, true/false flags, and short category codes. Examples:
  - task duration and number of tool calls
  - number of agents, and number of runs in the last 7 days
  - names of connected integration types (for example `telegram`, `github`) and model provider type
  - whether a task ran in Dry-Run or Approval Mode
  - onboarding step reached, and days since install
  - error categories, sent as reason codes and setup stage. Error messages are never sent.

### What is never sent

- Prompts, task input, or task output
- Agent names, descriptions, or system prompts
- File paths
- Message contents
- API keys, tokens, or anything stored in the credential vault
- Integration configuration
- RAG memory or anything from the SQLite database

### How this is enforced

All events pass through a scrubbing layer in the app before they are written to the queue:

- Each event type has an allowlist of property keys. Keys not on the allowlist are dropped.
- Keys such as `input`, `output`, `message`, `name`, `description`, `systemPrompt`, and `config` are blocked even if they are on an allowlist.
- Only primitive values are kept: numbers, booleans, and short strings. The one exception is a single key that may hold a short list of short strings (connected integration types).
- Strings are dropped if they are longer than 100 characters or look like a file path, URL, email address, token, or opaque key.
- Dropped keys are recorded in the local log file (`nodebrain-log.txt`), and are not sent.

The receiving server repeats these shape and size checks and rejects anything outside them.

### When it is sent

Events are written to a queue file on disk (`telemetry-queue.jsonl` in the app data folder) and sent in batches:

- once about 1 minute after launch
- then every 30 minutes while the app is running

Nothing is sent when the app quits. Events that have not been sent stay on disk until the next launch. Consent is checked again before each batch is sent.

### Where it goes

Events go over HTTPS to a Cloudflare Worker and are stored in a Cloudflare D1 database. NodeBrain controls both. They are not shared with or sold to anyone else.

Your IP address is visible to Cloudflare as part of any HTTPS request. The Worker uses it only for rate limiting and does not store it in the database.

### Turning it off

Turn off **Settings → Share anonymous usage data**. Doing this:

- stops all sending
- deletes the local queue, including events that have not been sent yet

Events that were already sent are not deleted from the server. **Settings → Reset all data** also deletes the queue and sets consent back to "not chosen".

---

## AI inference

Agents send prompts to the model provider you configure in the vault. With a hosted provider (OpenAI, Anthropic, Groq, Gemini, Mistral, Together, Fireworks, or a custom endpoint), your prompts and the content your agents process are sent to that provider's API. That provider's privacy policy applies. NodeBrain does not receive this data.

With Ollama, inference runs locally and no prompt data leaves your machine.

## Integrations

Integrations send data to their own services when an agent uses them. For example, a Telegram message goes to Telegram's API, and a GitHub issue goes to GitHub. They use the credentials you provide. Custom MCP servers you add may run on a remote host if you give them an HTTP(S) URL.

## Other network connections

NodeBrain also makes these connections. They do not include your data:

- checking GitHub Releases for app updates
- downloading the local embedding model on first launch
- downloading integration MCP server packages from npm on first use
- downloading the Ollama engine and local model, if you set up local inference
