import { Router } from 'express';
import { dbRun, dbAll } from '../db/database';
import type { ChatMessage } from '../../shared-types';

// Stored chat threads with individual agents (opened from an agent's panel on
// the NodeGraph). The client runs the agent itself (POST /agents/:id/execute)
// and saves both turns here. There is no general chat that creates agents:
// agents come from templates or the agents API.

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

export default router;
