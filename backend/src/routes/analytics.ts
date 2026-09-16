import { Router } from 'express';
import { dbGet, dbAll } from '../db/database';
import {
  getTotalCost,
  getCostByProvider,
  getCostByAgent,
  getTasksPerDay,
} from '../db/usageRepository';
import { PRICING_LAST_VERIFIED } from '../agents/agentEngine';

const router = Router();

// Reused by both the /api/analytics route and the telemetry usage snapshot
// (usageSnapshot.ts) so there's one definition of "success rate" in the app.
export function getSuccessRate(): number {
  const taskRow = dbGet<{ total: number; completed: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
     FROM tasks`,
  );
  const totalTasks = taskRow?.total ?? 0;
  return totalTasks > 0 ? (taskRow?.completed ?? 0) / totalTasks : 0;
}

// Agents that have never had a task run against them — same LEFT JOIN shape
// as topExpensiveTasks below (tasks joined onto the owning row), just with
// the direction flipped: rows with no matching task at all.
export function getAgentsNeverRunCount(): number {
  const row = dbGet<{ count: number }>(
    `SELECT COUNT(*) AS count
     FROM agents a
     LEFT JOIN tasks t ON t.agent_id = a.id
     WHERE t.id IS NULL`,
  );
  return row?.count ?? 0;
}

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

    const taskRow = dbGet<{ total: number }>('SELECT COUNT(*) AS total FROM tasks');
    const totalTasks = taskRow?.total ?? 0;
    const successRate = getSuccessRate();

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
        pricingLastVerified: PRICING_LAST_VERIFIED,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err) });
  }
});

export default router;
