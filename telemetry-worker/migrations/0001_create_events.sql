-- One row per accepted telemetry event.
--
-- Write cost is the constraint that shapes this table. D1 bills one row write
-- for the table plus one per secondary index touched by each insert, and the
-- free tier allows 100k row writes/day. So there are deliberately NO secondary
-- indexes: the table is WITHOUT ROWID, which makes the composite primary key
-- the table's own clustered B-tree. Every insert costs exactly 1 row write, and
-- the key order (day, event, install_id, ...) is the index all queries need:
--
--   * DAU/WAU/MAU         -> range on day, COUNT(DISTINCT install_id)
--   * onboarding funnel   -> day range + event = 'onboarding_step', group by step
--   * time-to-first-run   -> day range + event = 'first_agent_run'
--   * setup failures      -> day range + event = 'setup_failed', group by stage, reason_code
--   * retention           -> day range + event = 'app_launched', days_since_install
--
-- The trailing (ts, dedup) columns make the key unique per event, so a batch
-- that is re-sent after a lost response is absorbed by INSERT OR IGNORE
-- instead of double-counting.
CREATE TABLE events (
  day                   TEXT    NOT NULL, -- 'YYYY-MM-DD' (UTC), from the client's ts
  event                 TEXT    NOT NULL,
  install_id            TEXT    NOT NULL,
  ts                    TEXT    NOT NULL, -- client ISO-8601 timestamp, ms precision
  dedup                 TEXT    NOT NULL, -- 16 hex chars of SHA-256(properties JSON)
  received_at           TEXT    NOT NULL, -- server time the batch landed
  app_version           TEXT    NOT NULL,
  platform              TEXT    NOT NULL,
  os_release            TEXT    NOT NULL,
  -- Promoted out of `properties` for the core dashboards. Not indexed (indexes
  -- cost writes); queries reach these rows through the (day, event) key prefix.
  step                  TEXT,    -- onboarding_step.step
  stage                 TEXT,    -- setup_failed.stage
  reason_code           TEXT,    -- setup_failed.reasonCode
  days_since_install    INTEGER, -- app_launched.daysSinceInstall
  minutes_since_install INTEGER, -- first_agent_run.minutesSinceInstall
  properties            TEXT    NOT NULL, -- full scrubbed properties object as JSON
  PRIMARY KEY (day, event, install_id, ts, dedup)
) WITHOUT ROWID;
