-- Lockouts and pauses that must survive a restart (spec 02 §5.6, §13.4, [DA-16]). Counting
-- itself is on P0-E's UNLOGGED ops.rate_window; a lockout recorded here outlives a crash that
-- empties it, so a paused address stays paused (T-SAT-33). Keys are keyed hashes, never an
-- address or a token in clear.
SET lock_timeout = '5s';
SET statement_timeout = '60s';

CREATE TABLE ops.lockout (
  key text PRIMARY KEY CHECK (char_length(key) BETWEEN 1 AND 200),
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  locked_until timestamptz NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lockout_locked_until ON ops.lockout (locked_until) WHERE locked_until IS NOT NULL;
