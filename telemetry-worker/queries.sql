-- Reference queries for the questions the events table is built around.
-- Run with:  wrangler d1 execute nodebrain-telemetry --remote --file queries.sql
-- (or paste one at a time with --command). Every query bounds `day` first so
-- it reads through the primary key's leading column instead of scanning the
-- whole table — D1 bills rows read, too.

-- Daily active installs, last 30 days.
SELECT day, COUNT(DISTINCT install_id) AS active_installs
FROM events
WHERE day >= date('now', '-30 days')
GROUP BY day
ORDER BY day;

-- Weekly active installs (ISO-ish weeks starting Monday), last 12 weeks.
SELECT date(day, 'weekday 1', '-7 days') AS week_start,
       COUNT(DISTINCT install_id) AS active_installs
FROM events
WHERE day >= date('now', '-84 days')
GROUP BY week_start
ORDER BY week_start;

-- Onboarding funnel: how many installs reached each wizard step, last 30 days.
SELECT step, COUNT(DISTINCT install_id) AS installs
FROM events
WHERE day >= date('now', '-30 days') AND event = 'onboarding_step'
GROUP BY step
ORDER BY installs DESC;

-- ...and how many of those finished onboarding.
SELECT COUNT(DISTINCT install_id) AS completed
FROM events
WHERE day >= date('now', '-30 days') AND event = 'onboarding_completed';

-- Time to first agent run (minutes since install), last 90 days.
SELECT COUNT(*)                                        AS installs,
       MIN(minutes_since_install)                      AS min_minutes,
       CAST(AVG(minutes_since_install) AS INTEGER)     AS avg_minutes,
       SUM(minutes_since_install <= 10)                AS within_10_min,
       SUM(minutes_since_install <= 60)                AS within_1_hour,
       SUM(minutes_since_install <= 1440)              AS within_1_day
FROM events
WHERE day >= date('now', '-90 days') AND event = 'first_agent_run'
  AND minutes_since_install IS NOT NULL;

-- Setup failures by stage and reason code, last 30 days.
SELECT stage, reason_code,
       COUNT(*)                   AS failures,
       COUNT(DISTINCT install_id) AS installs_affected
FROM events
WHERE day >= date('now', '-30 days') AND event = 'setup_failed'
GROUP BY stage, reason_code
ORDER BY failures DESC;

-- Retention: of installs whose day-0 launch fell in the last 60 days, how many
-- launched again on day 1, in days 7-13, and in days 30+ (daysSinceInstall
-- comes from the client, so no install table or join on first_launch needed).
WITH launches AS (
  SELECT install_id,
         date(day, '-' || days_since_install || ' days') AS cohort_day,
         days_since_install
  FROM events
  WHERE day >= date('now', '-90 days') AND event = 'app_launched'
    AND days_since_install IS NOT NULL
),
cohort AS (
  SELECT DISTINCT install_id FROM launches
  WHERE days_since_install = 0 AND cohort_day >= date('now', '-60 days')
)
SELECT COUNT(*) AS cohort_size,
       SUM(EXISTS (SELECT 1 FROM launches l WHERE l.install_id = c.install_id AND l.days_since_install = 1))              AS d1,
       SUM(EXISTS (SELECT 1 FROM launches l WHERE l.install_id = c.install_id AND l.days_since_install BETWEEN 7 AND 13)) AS d7,
       SUM(EXISTS (SELECT 1 FROM launches l WHERE l.install_id = c.install_id AND l.days_since_install >= 30))             AS d30
FROM cohort c;

-- Daily write volume — compare against the free tier's 100k row writes/day.
SELECT date(received_at) AS received_day, COUNT(*) AS rows_written
FROM events
WHERE day >= date('now', '-14 days')
GROUP BY received_day
ORDER BY received_day;
