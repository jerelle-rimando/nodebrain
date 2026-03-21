import { parseNaturalSchedule } from '../utils/parseSchedule';
import { getCredentialForProvider } from '../vault/credentialVault';
import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbRun, dbAll } from '../db/database';
import { parseAgentFromChat, executeAgentTask } from '../agents/agentEngine';
import { getAllAgents, createAgent } from '../db/agentRepository';
import type { Agent, ChatMessage, ModelProvider } from '../../shared-types';

const router = Router();

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
  try {
    const { content } = req.body as { content?: string };
    if (!content?.trim()) {
      return res.status(400).json({ success: false, error: 'content is required' });
    }

    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: content.trim(),
      timestamp: new Date().toISOString(),
    };
    saveChatMessage(userMsg);

    const safeContent = content.slice(0, 1000);
    const lowerContent = safeContent.toLowerCase();
    const isCreateIntent = ['create', 'make', 'build', 'set up', 'new agent'].some((w) =>
      lowerContent.includes(w),
    );
    const agentMatch = safeContent.match(
      /(?:ask|tell|use|run|execute)\s+["']?([^"']+?)["']?\s+(?:to|agent)/i,
    );
    const targetAgentName = agentMatch?.[1]?.trim();

    let assistantContent = '';
    let agentId: string | undefined;

    if (isCreateIntent) {
      const agentConfig = await parseAgentFromChat(content);
      if (agentConfig?.name) {
        const now = new Date().toISOString();

        // Detect provider from available credentials
        const providerPriority = ['openai', 'groq', 'gemini', 'mistral', 'together', 'fireworks', 'anthropic', 'ollama'];
        let detectedProvider = 'openai';
        for (const p of providerPriority) {
          const key = getCredentialForProvider(p);
          if (key || p === 'ollama') { detectedProvider = p; break; }
        }

        const agent: Agent = {
          id: uuidv4(),
          name: agentConfig.name,
          description: agentConfig.description ?? '',
          provider: detectedProvider as ModelProvider,
          model: agentConfig.model ?? 'gpt-4o-mini',
          systemPrompt: agentConfig.systemPrompt ?? 'You are a helpful AI assistant.',
          schedule: agentConfig.schedule
            ? (parseNaturalSchedule(agentConfig.schedule).cron ?? agentConfig.schedule)
            : undefined,
          toolPermissions: agentConfig.toolPermissions ?? [],
          status: 'idle',
          config: {},
          createdAt: now,
          updatedAt: now,
        };
        createAgent(agent);
        assistantContent = `✅ **Agent Created: "${agent.name}"**\n\n${agent.description}\n\n**Model:** ${agent.model}${agent.schedule ? `\n**Schedule:** ${agent.schedule}` : ''}\n\nThe agent is ready. Say "Ask ${agent.name} to [task]" to run it.`;
      } else {
        assistantContent = `I couldn't parse an agent configuration from that. Try: "Create an agent that summarizes news articles and sends it to me every morning in Telegram."`;
      }
    } else if (targetAgentName) {
      const agents = getAllAgents();
      const targetAgent = agents.find((a) =>
        a.name.toLowerCase().includes(targetAgentName.toLowerCase()),
      );

      if (targetAgent) {
        const taskInput = safeContent.replace(
          /(?:ask|tell|use|run|execute)\s+["']?[^"']+?["']?\s+(?:to|agent)\s*/i,
          '',
        );
        agentId = targetAgent.id;

        // Await the task so we can show the output in chat
        const task = await executeAgentTask(targetAgent, taskInput);

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
      const providerPriority = ['openai', 'groq', 'mistral', 'together', 'fireworks', 'ollama'];
      let apiKey = '';
      let chosenProvider = 'openai';

      for (const p of providerPriority) {
        const key = getCredentialForProvider(p);
        if (key) { apiKey = key; chosenProvider = p; break; }
      }

      if (!apiKey) {
        assistantContent = `No API key found. Add one in the Credential Vault to get started.`;
      } else {
        const baseURLs: Record<string, string> = {
          openai: 'https://api.openai.com/v1',
          groq: 'https://api.groq.com/openai/v1',
          ollama: 'http://localhost:11434/v1',
          mistral: 'https://api.mistral.ai/v1',
          together: 'https://api.together.xyz/v1',
          fireworks: 'https://api.fireworks.ai/inference/v1',
        };
        const defaultModels: Record<string, string> = {
          openai: 'gpt-4o-mini',
          groq: 'llama-3.3-70b-versatile',
          ollama: 'llama3.2',
          mistral: 'mistral-small-latest',
          together: 'meta-llama/Llama-3-70b-chat-hf',
          fireworks: 'accounts/fireworks/models/llama-v3-70b-instruct',
        };

        const { default: OpenAI } = await import('openai');
        const client = new OpenAI({
          apiKey,
          baseURL: baseURLs[chosenProvider] ?? baseURLs.openai,
        });

        const agents = getAllAgents();
        const agentContext =
          agents.length > 0
            ? `The user has these agents: ${agents.map((a) => a.name).join(', ')}.`
            : 'The user has no agents yet.';

        const completion = await client.chat.completions.create({
          model: defaultModels[chosenProvider] ?? 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `You are NodeBrain, a helpful AI assistant that helps users build and manage AI agents. ${agentContext} You can help create agents, answer questions, and assist with tasks.`,
            },
            { role: 'user', content: content.trim() },
          ],
          temperature: 0.7,
          max_tokens: 1000,
        });

        assistantContent = completion.choices[0]?.message?.content ?? 'No response received.';
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

    res.json({ success: true, data: { userMessage: userMsg, assistantMessage: assistantMsg } });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;
