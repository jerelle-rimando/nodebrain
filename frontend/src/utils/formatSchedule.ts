// DOW_LABELS only covers the exact formats emitted by parseNaturalSchedule and the
// LLM agent-creation prompt. Non-matching DOW values fall through to the raw expr,
// which is acceptable — never misleading, just unstyled.
const DOW_LABELS: Record<string, string> = {
  '0': 'Sun', '1': 'Mon', '2': 'Tue', '3': 'Wed',
  '4': 'Thu', '5': 'Fri', '6': 'Sat',
  '1-5': 'Weekdays', '0,6': 'Weekends',
};

export function formatCronSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hr, , , dow] = parts;

  // Every minute: * * * * *
  if (min === '*' && hr === '*') return 'Every minute';

  // Every N minutes: */N * * * *
  const minStep = min.match(/^\*\/(\d+)$/);
  if (minStep && hr === '*') return `Every ${minStep[1]} min`;

  // Every hour: 0 * * * *
  if (min === '0' && hr === '*') return 'Every hour';

  // Every N hours: 0 */N * * *
  const hrStep = hr.match(/^\*\/(\d+)$/);
  if (hrStep && min === '0') return `Every ${hrStep[1]}h`;

  // Fixed time: M H * * [DOW]
  const m = parseInt(min, 10);
  const h = parseInt(hr, 10);
  if (!isNaN(m) && !isNaN(h)) {
    const d = new Date();
    d.setHours(h, m, 0, 0);
    const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
    if (dow === '*') return t;
    const dayLabel = DOW_LABELS[dow];
    return dayLabel ? `${dayLabel} · ${t}` : expr;
  }

  return expr;
}
