import { useState, useEffect } from 'react';
import { DollarSign, Cpu, Activity, CheckCircle, Loader2 } from 'lucide-react';
import { api } from '../../utils/api';
import { useStore } from '../../stores/appStore';

// ─── Types ────────────────────────────────────────────────────────────────────

type AnalyticsData = Awaited<ReturnType<typeof api.getAnalytics>>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.0001) return `$${n.toFixed(8)}`;
  if (n < 0.01) return `$${n.toFixed(6)}`;
  return `$${n.toFixed(4)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// ─── StatCard ─────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  iconBg: string;
}

function StatCard({ label, value, sub, icon: Icon, iconBg }: StatCardProps) {
  return (
    <div className="bg-brain-surface border border-brain-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}`}>
          <Icon size={14} className="text-white" />
        </div>
        <span className="text-xs text-brain-text-dim truncate">{label}</span>
      </div>
      <div className="text-xl font-bold text-brain-text font-mono">{value}</div>
      {sub && <div className="text-xs text-brain-text-dim mt-1">{sub}</div>}
    </div>
  );
}

// ─── BarChart (CSS, horizontal) ───────────────────────────────────────────────

interface BarItem { label: string; value: number; display: string }

function BarChart({ items }: { items: BarItem[] }) {
  const max = Math.max(...items.map(i => i.value), Number.EPSILON);

  if (items.length === 0) {
    return <Empty />;
  }

  return (
    <div className="space-y-3">
      {items.map((item, i) => (
        <div key={i}>
          <div className="flex justify-between text-xs mb-1">
            <span className="text-brain-text truncate max-w-[60%]">{item.label}</span>
            <span className="text-brain-text-dim font-mono">{item.display}</span>
          </div>
          <div className="h-1.5 bg-brain-border rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width: `${(item.value / max) * 100}%`,
                background: 'linear-gradient(90deg, #6366f1, #818cf8)',
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── LineChart (SVG) ──────────────────────────────────────────────────────────

function LineChart({ data }: { data: { date: string; count: number }[] }) {
  if (data.length === 0) return <Empty />;

  const W = 500, H = 130;
  const L = 28, R = 10, T = 8, B = 30;
  const plotW = W - L - R;
  const plotH = H - T - B;
  const maxVal = Math.max(...data.map(d => d.count), 1);

  const toX = (i: number) =>
    L + (data.length > 1 ? (i / (data.length - 1)) * plotW : plotW / 2);
  const toY = (v: number) => T + plotH - (v / maxVal) * plotH;

  const linePts = data.map((d, i) => `${toX(i)},${toY(d.count)}`).join(' ');
  const areaPts = [
    `${toX(0)},${T + plotH}`,
    ...data.map((d, i) => `${toX(i)},${toY(d.count)}`),
    `${toX(data.length - 1)},${T + plotH}`,
  ].join(' ');

  const step = Math.max(1, Math.floor(data.length / 6));
  const labelIdxs = [
    ...data.map((_, i) => i).filter(i => i % step === 0),
    data.length - 1,
  ].filter((v, i, a) => a.indexOf(v) === i);

  const yTicks = [0, Math.round(maxVal / 2), maxVal];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
      {/* Grid lines */}
      {yTicks.map(v => (
        <line
          key={v}
          x1={L} y1={toY(v)} x2={W - R} y2={toY(v)}
          stroke="rgba(255,255,255,0.05)" strokeWidth="1"
        />
      ))}
      {/* Y labels */}
      {yTicks.map(v => (
        <text
          key={v} x={L - 4} y={toY(v) + 4}
          textAnchor="end" fontSize="9" fill="#64748b"
        >
          {v}
        </text>
      ))}
      {/* Area fill */}
      <polygon points={areaPts} fill="rgba(99,102,241,0.1)" />
      {/* Line */}
      <polyline
        points={linePts}
        fill="none" stroke="#6366f1" strokeWidth="1.5" strokeLinejoin="round"
      />
      {/* Dots */}
      {data.map((d, i) => (
        <circle key={i} cx={toX(i)} cy={toY(d.count)} r="2" fill="#6366f1" />
      ))}
      {/* X labels */}
      {labelIdxs.map(i => (
        <text
          key={i} x={toX(i)} y={H - 8}
          textAnchor="middle" fontSize="9" fill="#64748b"
        >
          {data[i].date.slice(5)}
        </text>
      ))}
    </svg>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function Empty() {
  return (
    <div className="flex items-center justify-center py-10 text-brain-text-dim text-sm">
      No data yet
    </div>
  );
}

// ─── AnalyticsPage ────────────────────────────────────────────────────────────

export function AnalyticsPage() {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [loading, setLoading] = useState(true);
  const { agents } = useStore();

  useEffect(() => {
    api.getAnalytics()
      .then(setData)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const agentName = (id: string | null) => {
    if (!id) return '—';
    return agents.find(a => a.id === id)?.name ?? `${id.slice(0, 8)}…`;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-brain-text-dim gap-2">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Loading analytics…</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-brain-text-dim text-sm">
        Failed to load analytics.
      </div>
    );
  }

  const successColor =
    data.successRate >= 0.8 ? 'bg-brain-success' :
    data.successRate >= 0.5 ? 'bg-brain-warning' : 'bg-brain-error';

  const barItems: BarItem[] = data.costByAgent.map(a => ({
    label: agentName(a.agentId),
    value: a.totalCostUsd,
    display: fmtCost(a.totalCostUsd),
  }));

  const pricingDate = new Date(data.pricingLastVerified + 'T00:00:00').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
  });

  return (
    <div className="h-full overflow-y-auto p-5 space-y-4">

      <p className="text-xs text-brain-text-dim">
        Costs are local estimates based on token counts × pricing table. Prices last verified {pricingDate}.
      </p>

      {/* ── Stat Cards ─────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard
          label="Total Spent This Month"
          value={fmtCost(data.totalCostThisMonth)}
          sub={`${fmtCost(data.totalCost)} all time`}
          icon={DollarSign}
          iconBg="bg-brain-success"
        />
        <StatCard
          label="Total Tokens"
          value={fmtTokens(data.totalTokens)}
          icon={Cpu}
          iconBg="bg-brain-info"
        />
        <StatCard
          label="Total Tasks"
          value={data.totalTasks.toLocaleString()}
          icon={Activity}
          iconBg="bg-brain-accent"
        />
        <StatCard
          label="Success Rate"
          value={`${(data.successRate * 100).toFixed(1)}%`}
          sub={`${data.totalTasks} tasks total`}
          icon={CheckCircle}
          iconBg={successColor}
        />
      </div>

      {/* ── Charts ─────────────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="bg-brain-surface border border-brain-border rounded-xl p-4">
          <h3 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider mb-4">
            Cost by Agent
          </h3>
          <BarChart items={barItems} />
        </div>

        <div className="bg-brain-surface border border-brain-border rounded-xl p-4">
          <h3 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider mb-4">
            Tasks per Day — last 30 days
          </h3>
          <LineChart data={data.tasksPerDay} />
        </div>
      </div>

      {/* ── Top Expensive Tasks ─────────────────────────────────────────────── */}
      <div className="bg-brain-surface border border-brain-border rounded-xl p-4">
        <h3 className="text-xs font-semibold text-brain-text-dim uppercase tracking-wider mb-4">
          Most Expensive Tasks
        </h3>

        {data.topExpensiveTasks.length === 0 ? (
          <Empty />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-brain-border">
                  {['Task', 'Agent', 'Model', 'Cost', 'Tokens', 'Date'].map(h => (
                    <th
                      key={h}
                      className={`py-2 pb-3 text-brain-text-dim font-medium ${
                        h === 'Task' || h === 'Agent' || h === 'Model'
                          ? 'text-left pr-4'
                          : 'text-right pr-4 last:pr-0'
                      }`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.topExpensiveTasks.map(t => (
                  <tr
                    key={t.taskId}
                    className="border-b border-brain-border/40 hover:bg-brain-border/20 transition-colors"
                  >
                    <td className="py-2.5 pr-4 text-brain-text max-w-xs">
                      <span
                        className="block truncate"
                        title={t.input ?? undefined}
                      >
                        {t.input
                          ? t.input.length > 55 ? t.input.slice(0, 55) + '…' : t.input
                          : '—'}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-brain-text-dim whitespace-nowrap">
                      {agentName(t.agentId)}
                    </td>
                    <td className="py-2.5 pr-4 text-brain-text-dim font-mono whitespace-nowrap">
                      {t.model ?? '—'}
                    </td>
                    <td className="py-2.5 pr-4 text-right text-brain-text font-mono whitespace-nowrap">
                      {fmtCost(t.cost)}
                    </td>
                    <td className="py-2.5 pr-4 text-right text-brain-text-dim font-mono whitespace-nowrap">
                      {fmtTokens(t.tokens)}
                    </td>
                    <td className="py-2.5 text-right text-brain-text-dim whitespace-nowrap">
                      {t.createdAt
                        ? new Date(t.createdAt).toLocaleDateString(undefined, {
                            month: 'short', day: 'numeric',
                          })
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
