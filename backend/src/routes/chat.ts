import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbRun, dbAll } from '../db/database';
import { parseAgentFromChat, executeAgentTask } from '../agents/agentEngine';
import { getAllAgents, createAgent } from '../db/agentRepository';
import type { Agent, ChatMessage } from '../../shared-types';

const router = Router();

interface ChatRow {
  id: string; role: string; content: string; timestamp: string; agent_id: string | null;
}

function saveChatMessage(msg: ChatMessage): void {
  dbRun('INSERT INTO chat_messages (id, role, content, timestamp, agent_id) VALUES (?, ?, ?, ?, ?)',
    [msg.id, msg.role, msg.content, msg.timestamp, msg.agentId ?? null]);
}

function getChatHistory(limit = 50): ChatMessage[] {
  const rows = dbAll<ChatRow>(`SELECT * FROM (SELECT * FROM chat_messages ORDER BY timestamp DESC LIMIT ?) ORDER BY timestamp ASC`, [limit]);
  return rows.map(r => ({ id: r.id, role: r.role as ChatMessage['role'], content: r.content, timestamp: r.timestamp, agentId: r.agent_id ?? undefined }));
}

router.get('/history', (_req, res) => {
  try {
    res.json({ success: true, data: getChatHistory() });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

router.post('/message', async (req, res) => {
  try {
    const { content } = req.body as { content?: string };
    if (!content?.trim()) return res.status(400).json({ success: false, error: 'content is required' });

    const userMsg: ChatMessage = { id: uuidv4(), role: 'user', content: content.trim(), timestamp: new Date().toISOString() };
    saveChatMessage(userMsg);

    const lowerContent = content.toLowerCase();
    const isCreateIntent = ['create', 'make', 'build', 'set up', 'new agent'].some(w => lowerContent.includes(w));
    const agentMatch = content.match(/(?:ask|tell|use|run|execute)\s+["']?([^"']+?)["']?\s+(?:to|agent)/i);
    const targetAgentName = agentMatch?.[1]?.trim();

    let assistantContent = '';
    let agentId: string | undefined;

    if (isCreateIntent) {
      const agentConfig = await parseAgentFromChat(content);
      if (agentConfig?.name) {
        const now = new Date().toISOString();
        const agent: Agent = {
          id: uuidv4(), name: agentConfig.name, description: agentConfig.description ?? '',
          provider: 'openai', model: agentConfig.model ?? 'gpt-4o-mini',
          systemPrompt: agentConfig.systemPrompt ?? 'You are a helpful AI assistant.',
          schedule: agentConfig.schedule, toolPermissions: agentConfig.toolPermissions ?? [],
          status: 'idle', config: {}, createdAt: now, updatedAt: now,
        };
        createAgent(agent);
        agentId = agent.id;
        assistantContent = `✅ **Agent Created: "${agent.name}"**\n\n${agent.description}\n\n**Model:** ${agent.model}${agent.schedule ? `\n**Schedule:** ${agent.schedule}` : ''}\n\nThe agent has been added to your NodeGraph. You can execute tasks by saying "Ask ${agent.name} to [task]".`;
      } else {
        assistantContent = `I couldn't parse an agent configuration from that. Try: "Create an agent that summarizes news articles every morning."`;
      }
    } else if (targetAgentName) {
      const agents = getAllAgents();
      const targetAgent = agents.find(a => a.name.toLowerCase().includes(targetAgentName.toLowerCase()));
      if (targetAgent) {
        const taskInput = content.replace(/(?:ask|tell|use|run|execute)\s+["']?[^"']+?["']?\s+(?:to|agent)\s*/i, '');
        agentId = targetAgent.id;
        executeAgentTask(targetAgent, taskInput).catch(console.error);
        assistantContent = `⚡ Task sent to **"${targetAgent.name}"**. Check the Logs panel for real-time updates.`;
      } else {
        assistantContent = `I couldn't find an agent named "${targetAgentName}".`;
      }
    } else {
      const agents = getAllAgents();
      const agentList = agents.length > 0 ? agents.map(a => `• **${a.name}** — ${a.description}`).join('\n') : 'No agents created yet.';
      assistantContent = `I can help you create agents or execute tasks!\n\n**Your agents:**\n${agentList}\n\n**Try:**\n• "Create an agent that monitors RSS feeds"\n• "Ask [agent name] to summarize today's tech news"`;
    }

    const assistantMsg: ChatMessage = { id: uuidv4(), role: 'assistant', content: assistantContent, timestamp: new Date().toISOString(), agentId };
    saveChatMessage(assistantMsg);

    res.json({ success: true, data: { userMessage: userMsg, assistantMessage: assistantMsg } });
  } catch (err) { res.status(500).json({ success: false, error: String(err) }); }
});

export default router;
