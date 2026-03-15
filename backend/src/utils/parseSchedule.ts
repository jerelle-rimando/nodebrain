import * as chrono from 'chrono-node';

interface ScheduleResult {
  cron: string | null;
  human: string | null;
}

export function parseNaturalSchedule(input: string): ScheduleResult {
  const lower = input.toLowerCase();

  // Common patterns — check these first before chrono
  const patterns: Array<{ match: RegExp; cron: string; human: string }> = [
    { match: /every\s+minute/i, cron: '* * * * *', human: 'Every minute' },
    { match: /every\s+hour/i, cron: '0 * * * *', human: 'Every hour' },
    { match: /every\s+day|daily/i, cron: '0 9 * * *', human: 'Daily at 9am' },
    { match: /every\s+morning/i, cron: '0 9 * * *', human: 'Every morning at 9am' },
    { match: /every\s+night|nightly/i, cron: '0 21 * * *', human: 'Every night at 9pm' },
    { match: /every\s+monday/i, cron: '0 9 * * 1', human: 'Every Monday at 9am' },
    { match: /every\s+tuesday/i, cron: '0 9 * * 2', human: 'Every Tuesday at 9am' },
    { match: /every\s+wednesday/i, cron: '0 9 * * 3', human: 'Every Wednesday at 9am' },
    { match: /every\s+thursday/i, cron: '0 9 * * 4', human: 'Every Thursday at 9am' },
    { match: /every\s+friday/i, cron: '0 9 * * 5', human: 'Every Friday at 9am' },
    { match: /every\s+saturday/i, cron: '0 9 * * 6', human: 'Every Saturday at 9am' },
    { match: /every\s+sunday/i, cron: '0 9 * * 0', human: 'Every Sunday at 9am' },
    { match: /every\s+weekday|weekdays/i, cron: '0 9 * * 1-5', human: 'Every weekday at 9am' },
    { match: /every\s+weekend/i, cron: '0 9 * * 0,6', human: 'Every weekend at 9am' },
    { match: /every\s+(\d+)\s+hours?/i, cron: '', human: '' }, // handled below
    { match: /every\s+(\d+)\s+minutes?/i, cron: '', human: '' }, // handled below
  ];

  // Every N hours
  const everyNHours = lower.match(/every\s+(\d+)\s+hours?/i);
  if (everyNHours) {
    const n = parseInt(everyNHours[1]);
    if (n >= 1 && n <= 23) {
      return { cron: `0 */${n} * * *`, human: `Every ${n} hours` };
    }
  }

  // Every N minutes
  const everyNMinutes = lower.match(/every\s+(\d+)\s+minutes?/i);
  if (everyNMinutes) {
    const n = parseInt(everyNMinutes[1]);
    if (n >= 1 && n <= 59) {
      return { cron: `*/${n} * * * *`, human: `Every ${n} minutes` };
    }
  }

  // Check fixed patterns
  for (const pattern of patterns) {
    if (pattern.cron && pattern.match.test(lower)) {
      // Check for specific time like "every morning at 8am"
      const timeMatch = lower.match(/at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
      if (timeMatch) {
        let hour = parseInt(timeMatch[1]);
        const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
        const meridiem = timeMatch[3]?.toLowerCase();
        if (meridiem === 'pm' && hour !== 12) hour += 12;
        if (meridiem === 'am' && hour === 12) hour = 0;
        const adjustedCron = pattern.cron.replace(/^0 \d+/, `${minute} ${hour}`);
        return { cron: adjustedCron, human: pattern.human.replace('9am', `${timeMatch[1]}${meridiem ?? 'am'}`) };
      }
      return { cron: pattern.cron, human: pattern.human };
    }
  }

  // Fall back to chrono-node for more complex expressions
  const parsed = chrono.parseDate(input);
  if (parsed) {
    const hour = parsed.getHours();
    const minute = parsed.getMinutes();
    return { cron: `${minute} ${hour} * * *`, human: `Daily at ${hour}:${minute.toString().padStart(2, '0')}` };
  }

  return { cron: null, human: null };
}