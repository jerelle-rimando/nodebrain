import { Router } from 'express';
import { dbGet, dbAll } from '../db/database';
import {
  getTotalCost,
  getCostByProvider,
  getCostByAgent,
  getTasksPerDay,
} from '../db/usageRepository';

const router = Router();

// GET /api/analytics
router.get('/', (_req, res) => {
  try {
    const totalCost = getTotalCost();

    const monthRow = dbGet<{ total: number }>(
      `SELECT COALESCE(SUM(estimated_cost_usd), 0) AS total
       FROM usage_records
       WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now')`,
    );
    const totalCostThisMonth = monthRow?.total ?? 0;

    const tokenRow = dbGet<{ total_tokens: number }>(
      'SELECT COALESCE(SUM(total_tokens), 0) AS total_tokens FROM usage_records',
    );
    const totalTokens = tokenRow?.total_tokens ?? 0;

    const taskRow = dbGet<{ total: number; completed: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
       FROM tasks`,
    );
    const totalTasks = taskRow?.total ?? 0;
    const successRate = totalTasks > 0 ? (taskRow?.completed ?? 0) / totalTasks : 0;

    const topExpensiveTasks = dbAll<{
      task_id: string;
      input: string | null;
      status: string | null;
      created_at: string | null;
      cost: number;
      tokens: number;
      agent_id: string | null;
      model: string | null;
    }>(
      `SELECT u.task_id,
              MAX(t.input)              AS input,
              MAX(t.status)             AS status,
              MAX(t.created_at)         AS created_at,
              SUM(u.estimated_cost_usd) AS cost,
              SUM(u.total_tokens)       AS tokens,
              MAX(u.agent_id)           AS agent_id,
              MAX(u.model)              AS model
       FROM usage_records u
       LEFT JOIN tasks t ON t.id = u.task_id
       WHERE u.task_id IS NOT NULL
       GROUP BY u.task_id
       ORDER BY cost DESC
       LIMIT 10`,
    ).map(r => ({
      taskId: r.task_id,
      input: r.input,
      status: r.status,
      createdAt: r.created_at,
      cost: r.cost,
      tokens: r.tokens,
      agentId: r.agent_id,
      model: r.model,
    }));

    const costByProvider = getCostByProvider();
    const costByAgent = getCostByAgent();
    const tasksPerDay = getTasksPerDay();

    res.json({
      success: true,
      data: {
        totalCost,
        totalCostThisMonth,
        totalTokens,
        totalTasks,
        successRate,
        costByProvider,
        costByAgent,
        tasksPerDay,
        topExpensiveTasks,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;
