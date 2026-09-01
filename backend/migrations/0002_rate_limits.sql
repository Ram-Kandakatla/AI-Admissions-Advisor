-- Rate-limit counters.
--
-- On Express this was express-rate-limit's in-process memory, which a Worker
-- cannot have: there is no long-lived process to hold a Map between requests.
-- The counter has to live somewhere both requests can see, and D1 is already
-- bound here.
--
-- One row per (bucket, client, window). `window_start` in the key is what
-- makes expiry free — a new window is simply a different row, so nothing has
-- to be reset on a timer. Old rows are swept opportunistically on write.

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket       TEXT    NOT NULL,
  client       TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, client, window_start)
);

-- Supports the sweep, which deletes by age across every bucket at once.
CREATE INDEX IF NOT EXISTS rate_limits_by_window ON rate_limits(window_start);
