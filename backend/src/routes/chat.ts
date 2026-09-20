import { parseNaturalSchedule } from '../utils/parseSchedule';
import { getCredentialForProvider, getBaseUrlForProvider } from '../vault/credentialVault';
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbRun, dbAll } from '../db/database';
import { BASE_URLS, parseAgentFromChat, executeAgentTask, agentEvents, resolveAgentModel, resolveDefaultProvider, DEFAULT_MODELS } from '../agents/agentEngine';
import type { HistoryTurn } from '../agents/agentEngine';
import { getAllAgents, createAgent } from '../db/agentRepository';
import { createConnection } from '../db/agentConnectionRepository';
import { scheduleAgent } from '../scheduler/scheduler';
import type { Agent, ChatMessage, ModelProvider } from '../../shared-types';
import { deriveAgentEmoji } from '../../shared-types';

const router = Router();

// Generous enough to cover a cold Ollama model load (llama-server alone took
// ~6s to start in testing, before inference began). Exceeding it still falls
// back to plain chat.
const CLASSIFIER_TIMEOUT_MS = 30_000;

// Cheap creation-intent classifier — the fallback for when the isCreateIntent
// keyword match misses (e.g. "watch a folder and tell me when new files show
// up" contains none of the trigger words). Kept to a single-word answer and a
// short prompt so it stays fast even on a local 4B model, and is bounded by a
// timeout so a slow/hung provider can never block the message. Any failure or
// unparseable output falls back to plain chat rather than creating an agent.
async function classifyCreateIntent(params: {
  content: string;
  provider: string;
  model: string;
  apiKey: string;
}): Promise<boolean> {
  const { content, provider, model, apiKey } = params;
  const classifierSystemPrompt =
    'Classify the user message for an AI agent-building app. Reply with exactly one word.\n' +
    'CREATE - the message asks to set up an agent that performs a recurring or automated task ' +
    '(examples: watching a folder, monitoring a feed, sending scheduled messages, reacting to an event).\n' +
    'CHAT - the message is a question, a request for information, or general conversation.\n' +
    'Reply with only CREATE or CHAT. No punctuation, no explanation.';
  const classifierUserPrompt = `Message: "${content.slice(0, 500)}"`;

  try {
    let raw: string | undefined;
    if (provider === 'anthropic') {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey });
      const response = await anthropic.messages.create(
        {
          model,
          max_tokens: 5,
          temperature: 0,
          system: classifierSystemPrompt,
          messages: [{ role: 'user', content: classifierUserPrompt }],
        },
        { signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS) },
      );
      const block = response.content.find((b) => b.type === 'text');
      raw = block && block.type === 'text' ? block.text : undefined;
    } else {
      const customBaseUrl = getBaseUrlForProvider(provider);
      const { default: OpenAI } = await import('openai');
      const client = new OpenAI({
        apiKey: apiKey || 'ollama',
        baseURL: customBaseUrl || (BASE_URLS[provider] ?? BASE_URLS.openai),
      });
      const completion = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: 'system', content: classifierSystemPrompt },
            { role: 'user', content: classifierUserPrompt },
          ],
          temperature: 0,
          max_tokens: 5,
        },
        { signal: AbortSignal.timeout(CLASSIFIER_TIMEOUT_MS) },
      );
      raw = completion.choices[0]?.message?.content ?? undefined;
    }

    const verdict = raw?.trim().toUpperCase();
    return verdict?.startsWith('CREATE') ?? false;
  } catch (err) {
    console.log(
      `[ChatRoute] classifier threw (falling back to chat): ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

interface ChatRow {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  agent_id: string | null;
}

function saveChatMessage(msg: ChatMessage): void {
  dbRun(
    'INSERT INTO chat_messages (id, role, content, timestamp, agent_id) VALUES (?, ?, ?, ?, ?)',
    [msg.id, msg.role, msg.content, msg.timestamp, msg.agentId ?? null],
  );
}

function getChatHistory(limit = 50): ChatMessage[] {
  const rows = dbAll<ChatRow>(
    `SELECT * FROM (SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    role: r.role as ChatMessage['role'],
    content: r.content,
    timestamp: r.timestamp,
    agentId: r.agent_id ?? undefined,
  }));
}

// Strips the "ask <agent> to" routing phrase so the agent sees just the task.
const AGENT_TASK_PREFIX_RE = /(?:ask|tell|use|run|execute)\s+["']?[^"']+?["']?\s+(?:to|agent)\s*/i;
const AGENT_COMPLETED_PREFIX_RE = /^⚡ \*\*.+?\*\* completed the task:\n\n/;

// chat_messages is one global stream: user rows carry no agent_id, only the
// agent's reply does. So an agent's conversation is rebuilt from its own
// completed replies plus the user message that immediately preceded each.
// Failures and "task sent" placeholders are skipped — they carry no real output.
// Rows are taken strictly before `beforeTimestamp` so the message being answered
// (already saved) isn't duplicated as history.
function getAgentConversationHistory(agentId: string, beforeTimestamp: string, scanLimit = 200): HistoryTurn[] {
  const rows = dbAll<ChatRow>(
    `SELECT * FROM (SELECT * FROM chat_messages WHERE timestamp < ? ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC`,
    [beforeTimestamp, scanLimit],
  );
  const turns: HistoryTurn[] = [];
  let lastUser: string | undefined;
  for (const r of rows) {
    if (r.role === 'user') {
      lastUser = r.content.replace(AGENT_TASK_PREFIX_RE, '').trim();
    } else if (r.role === 'assistant' && r.agent_id === agentId && lastUser) {
      if (AGENT_COMPLETED_PREFIX_RE.test(r.content)) {
        turns.push({ role: 'user', content: lastUser });
        turns.push({ role: 'assistant', content: r.content.replace(AGENT_COMPLETED_PREFIX_RE, '').trim() });
      }
      lastUser = undefined;
    }
  }
  return turns;
}

router.get('/history', (_req, res) => {
  try {
    res.json({ success: true, data: getChatHistory() });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.post('/save', (req, res) => {
  try {
    const { messages } = req.body as { messages?: ChatMessage[] };
    if (!messages?.length) return res.status(400).json({ success: false, error: 'messages required' });
    messages.forEach(saveChatMessage);
    res.json({ success: true, data: { saved: messages.length } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

router.post('/message', async (req, res) => {
  let chosenProviderForError: string | undefined;
  try {
    const { content, requestId, mode, provider: requestedProvider, model: requestedModel } = req.body as {
      content?: string;
      requestId?: string;
      mode?: 'chat' | 'agent';
      provider?: string;
      model?: string;
    };
    if (!content?.trim()) {
      return res.status(400).json({ success: false, error: 'content is required' });
    }
    const isAgentMode = mode !== 'chat';

    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: content.trim(),
      timestamp: new Date().toISOString(),
    };
    saveChatMessage(userMsg);

    const safeContent = content.slice(0, 1000);
    const lowerContent = safeContent.toLowerCase();
    const trimmedLowerContent = lowerContent.trim();

    // Question words that signal "asking about" rather than "asking for".
    // "can" is deliberately excluded: "Can you create an agent that..." is a
    // common polite phrasing for a genuine creation request, not a question
    // about capabilities. This means a bare "can"-led question without a "?"
    // (e.g. "Can agents send emails") slips past this specific check, but the
    // trailing "?" check below catches the overwhelming majority of those.
    const QUESTION_STARTERS = [
      'what', 'which', 'how', 'why', 'when', 'where', 'who',
      'could', 'do', 'does', 'is', 'are', 'should', 'would',
    ];
    const ASKING_ABOUT_PHRASES = [
      'what kind of', 'what type of', 'tell me about', 'explain', 'list the', 'can you tell',
    ];
    const isQuestion =
      trimmedLowerContent.endsWith('?') ||
      QUESTION_STARTERS.some((w) => trimmedLowerContent.startsWith(`${w} `)) ||
      ASKING_ABOUT_PHRASES.some((p) => trimmedLowerContent.includes(p));

    const isCreateIntent =
      !isQuestion &&
      ['create', 'make', 'build', 'set up', 'new agent', 'i need', 'i want'].some((w) =>
        lowerContent.includes(w),
      );
    const agentMatch = safeContent.match(
      /(?:ask|tell|use|run|execute)\s+["']?([^"']+?)["']?\s+(?:to|agent)/i,
    );
    const targetAgentName = agentMatch?.[1]?.trim();

    let assistantContent = '';
    let agentId: string | undefined;

    // Resolve provider/model/credentials up front — needed both for the
    // plain-chat fallback below and, in Agent mode, for the cheap
    // creation-intent classifier that runs when the keyword fast path misses.
    const providerPriority = ['openai', 'groq', 'mistral', 'together', 'fireworks', 'ollama'];

    let apiKey = '';
    let chosenProvider = 'openai';
    let chosenModel = '';

    // Only honor an explicitly requested provider when it's actually usable
    // (has a stored credential, or is ollama which needs none). Otherwise a
    // stale/default picker selection with no matching credential would hard-fail
    // chat instead of falling back to whatever the user does have configured.
    const requestedApiKey = requestedProvider ? getCredentialForProvider(requestedProvider) : undefined;
    if (requestedProvider && (requestedApiKey || requestedProvider === 'ollama')) {
      chosenProvider = requestedProvider;
      apiKey = requestedApiKey ?? '';
      chosenModel = requestedModel || DEFAULT_MODELS[chosenProvider] || 'gpt-4o-mini';
    } else {
      ({ provider: chosenProvider, apiKey } = await resolveDefaultProvider(providerPriority));
      chosenModel = DEFAULT_MODELS[chosenProvider] || 'gpt-4o-mini';
    }
    chosenProviderForError = chosenProvider;

    // Keyword match is the fast path. When it misses in Agent mode — and the
    // message isn't a question and isn't addressed to an existing agent — ask
    // the model instead of falling straight through to plain chat, since the
    // keyword list can't cover every phrasing of an agent request ("watch a
    // folder...", "summarize my PDFs daily...", "text me when X happens...").
    let shouldCreateAgent = isCreateIntent;
    const hasUsableCredential = Boolean(apiKey || chosenProvider === 'ollama');
    const classifierGateOpen =
      isAgentMode && !isCreateIntent && !isQuestion && !targetAgentName && hasUsableCredential;
    if (classifierGateOpen) {
      shouldCreateAgent = await classifyCreateIntent({
        content: safeContent,
        provider: chosenProvider,
        model: chosenModel,
        apiKey,
      });
    }

    if (isAgentMode && shouldCreateAgent) {
      // Tell the client this request was routed to agent creation so it can
      // show "Creating…" instead of the generic "Thinking…" placeholder while
      // parseAgentFromChat runs. Streamed log lines (if any) still take
      // precedence over this label on the client.
      if (requestId) {
        agentEvents.emit('chat:phase', { requestId, phase: 'creating' });
      }
      const agentConfigs = await parseAgentFromChat(content);
      const validConfigs = (agentConfigs ?? []).filter((c) => c.name);
      if (validConfigs.length > 0) {
        const now = new Date().toISOString();

        // Pass 1: create every agent. parseAgentFromChat already resolved the
        // provider (local engine first, else first credentialed cloud provider)
        // and validated the model against it; createAgent re-checks as a backstop.
        const createdAgents: Agent[] = validConfigs.map((cfg) => {
          const provider = (cfg.provider ?? 'openai') as ModelProvider;
          return {
            id: uuidv4(),
            name: cfg.name!,
            description: (cfg.description ?? '').slice(0, 80),
            provider,
            model: resolveAgentModel(provider, cfg.model, `chat create "${cfg.name}"`),
            systemPrompt: cfg.systemPrompt ?? 'You are a helpful AI assistant.',
            schedule: cfg.schedule
              ? (parseNaturalSchedule(cfg.schedule).cron ?? cfg.schedule)
              : undefined,
            emoji: cfg.emoji ?? deriveAgentEmoji(cfg.name, cfg.description),
            toolPermissions: cfg.toolPermissions ?? [],
            status: 'idle' as const,
            config: {},
            createdAt: now,
            updatedAt: now,
          };
        });
        createdAgents.forEach(createAgent);
        createdAgents.filter((a) => a.schedule).forEach(scheduleAgent);

        // Pass 2: resolve connectsTo by case-insensitive name within this batch
        const madeConnections: string[] = [];
        for (let i = 0; i < validConfigs.length; i++) {
          const connectsTo = (validConfigs[i] as Record<string, unknown>).connectsTo as string[] | undefined;
          if (!connectsTo?.length) continue;
          for (const targetName of connectsTo) {
            const target = createdAgents.find(
              (a) => a.name.toLowerCase() === targetName.toLowerCase(),
            );
            if (target) {
              createConnection(createdAgents[i].id, target.id);
              madeConnections.push(`${createdAgents[i].name} → ${target.name}`);
            }
          }
        }

        const agentLines = createdAgents
          .map((a) => `- **${a.name}**: ${a.description}${a.schedule ? ` _(${a.schedule})_` : ''}`)
          .join('\n');
        const connectionLines = madeConnections.map((c) => `- ${c}`).join('\n');
        assistantContent = [
          `✅ **${createdAgents.length === 1 ? 'Agent' : `${createdAgents.length} Agents`} Created:**`,
          agentLines,
          ...(madeConnections.length ? ['\n**Connections:**', connectionLines] : []),
        ].join('\n');
      } else {
        assistantContent = `I couldn't parse an agent configuration from that. Try: "Create an agent that summarizes news articles and sends it to me every morning in Telegram."`;
      }
    } else if (isAgentMode && targetAgentName) {
      const agents = getAllAgents();
      const targetAgent = agents.find((a) =>
        a.name.toLowerCase().includes(targetAgentName.toLowerCase()),
      );

      if (targetAgent) {
        const taskInput = safeContent.replace(AGENT_TASK_PREFIX_RE, '');
        agentId = targetAgent.id;

        // Await the task so we can show the output in chat. This is the only
        // caller that passes conversation history (capped/trimmed in the engine).
        const history = getAgentConversationHistory(targetAgent.id, userMsg.timestamp);
        const task = await executeAgentTask(targetAgent, taskInput, 0, history);

        if (task.status === 'completed' && task.output) {
          assistantContent = `⚡ **${targetAgent.name}** completed the task:\n\n${task.output}`;
        } else if (task.status === 'failed') {
          assistantContent = `❌ **${targetAgent.name}** failed: ${task.error ?? 'Unknown error'}`;
        } else {
          assistantContent = `⚡ Task sent to **"${targetAgent.name}"**. Check the Logs panel for updates.`;
        }
      } else {
        assistantContent = `I couldn't find an agent named "${targetAgentName}". Available agents: ${getAllAgents().map((a) => a.name).join(', ') || 'none yet'}.`;
      }
    } else {
      // Fall back to actual AI conversation
      if (!apiKey && chosenProvider !== 'ollama') {
        assistantContent = `No API key found. Add one in the Credential Vault to get started.`;
      } else {
        const agents = getAllAgents();
        const agentContext =
          agents.length > 0
            ? `The user has these agents: ${agents.map((a) => a.name).join(', ')}.`
            : 'The user has no agents yet.';

        // Keep replies short — a local 4B model defaults to essay-length
        // answers (headers, code, a recap section) even for simple questions,
        // which is unusably slow on local inference. Applies to both modes.
        const concisenessInstruction =
          'Answer concisely: a few sentences by default. Use lists or code blocks only when the user asks for them or the answer genuinely requires them. Do not add a recap or summary of what you just said, and do not end with a menu of follow-up questions.';

        // Chat mode is conversational only — it never builds anything. Without
        // this framing the model reads "create a filesystem agent" as a coding
        // request and dumps an implementation. Prepended to every Chat-mode
        // request, so keep it to one tight paragraph.
        const chatModeFraming = !isAgentMode
          ? `You're NodeBrain's built-in assistant. NodeBrain is a local-first desktop app for building and running AI agents. People create agents just by describing what they want in plain language while in Agent mode — they never write code to make one. So when someone asks you to create an agent, don't write implementation code for it: instead, explain in plain language what that agent would do and which integrations or credentials it would need, then tell them to switch to Agent mode and send the request again. Keep your usual warm, friendly tone and feel free to use emoji. 🧠 `
          : '';

        // Agent mode reaches this branch once the keyword/classifier pair
        // above has already decided this particular message isn't a creation
        // request. Without this framing the model has no idea it's inside
        // NodeBrain at all, and (as seen with "watch a folder...") answers
        // like a generic coding assistant instead — e.g. writing a Python
        // tutorial. Give it the same app context Chat mode gets.
        const agentModeFraming = isAgentMode
          ? `You're NodeBrain's built-in assistant, currently in Agent mode. NodeBrain is a local-first desktop app for building and running AI agents. Users build agents by describing what they want in plain language — they never write code. This particular message was not detected as a request to create or run an agent, so just respond to it conversationally; only bring up agent creation if it's actually relevant. Keep your usual warm, friendly tone and feel free to use emoji. 🧠 `
          : '';

        const systemPrompt = `${chatModeFraming}${agentModeFraming}You are NodeBrain, a helpful AI assistant that helps users build and manage AI agents. ${agentContext} You can help create agents, answer questions, and assist with tasks. ${concisenessInstruction}`;

        if (chosenProvider === 'anthropic') {
          const { default: Anthropic } = await import('@anthropic-ai/sdk');
          const anthropic = new Anthropic({ apiKey });

          if (requestId) {
            const anthropicStream = anthropic.messages.stream({
              model: chosenModel,
              max_tokens: 1000,
              system: systemPrompt,
              messages: [{ role: 'user', content: content.trim() }],
            });
            let accumulated = '';
            anthropicStream.on('text', (delta) => {
              accumulated += delta;
              agentEvents.emit('chat:token', { requestId, token: delta });
            });
            await anthropicStream.finalMessage();
            assistantContent = accumulated || 'No response received.';
          } else {
            const response = await anthropic.messages.create({
              model: chosenModel,
              max_tokens: 1000,
              system: systemPrompt,
              messages: [{ role: 'user', content: content.trim() }],
            });
            const textBlock = response.content.find((b) => b.type === 'text');
            assistantContent = textBlock && textBlock.type === 'text' ? textBlock.text : 'No response received.';
          }
        } else {
          const customBaseUrl = getBaseUrlForProvider(chosenProvider);
          const { default: OpenAI } = await import('openai');
          const client = new OpenAI({
            apiKey: apiKey || 'ollama',
            baseURL: customBaseUrl || (BASE_URLS[chosenProvider] ?? BASE_URLS.openai),
          });

          if (requestId) {
            const stream = await client.chat.completions.create({
              model: chosenModel,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: content.trim() },
              ],
              temperature: 0.7,
              max_tokens: 1000,
              stream: true,
            });

            let accumulated = '';
            for await (const chunk of stream) {
              const delta = chunk.choices[0]?.delta?.content ?? '';
              if (delta) {
                accumulated += delta;
                agentEvents.emit('chat:token', { requestId, token: delta });
              }
            }
            assistantContent = accumulated || 'No response received.';
          } else {
            const completion = await client.chat.completions.create({
              model: chosenModel,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: content.trim() },
              ],
              temperature: 0.7,
              max_tokens: 1000,
            });

            assistantContent = completion.choices[0]?.message?.content ?? 'No response received.';
          }
        }
      }
    }

    const assistantMsg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: assistantContent,
      timestamp: new Date().toISOString(),
      agentId,
    };
    saveChatMessage(assistantMsg);

    // Chat mode is deliberately non-acting, so a creation request here got a
    // plain conversational reply. Flag it (using the same isCreateIntent gate,
    // question guard included) so the client can nudge the user toward Agent
    // mode. We do NOT create the agent.
    const suggestAgentMode = !isAgentMode && isCreateIntent;

    res.json({
      success: true,
      data: { userMessage: userMsg, assistantMessage: assistantMsg, suggestAgentMode },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isConnectionFailure = /ECONNREFUSED|connection error|fetch failed/i.test(message);
    const friendlyMessage =
      isConnectionFailure && chosenProviderForError === 'ollama'
        ? "Your local AI isn't running. Try restarting NodeBrain."
        : message;
    res.status(500).json({ success: false, error: friendlyMessage });
  }
});

export default router;
