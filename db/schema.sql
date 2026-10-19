-- Metadata only. Never store card numbers, CVCs, or raw webhook payloads here.
CREATE TABLE IF NOT EXISTS payment_attempts (
  stripe_payment_intent_id TEXT PRIMARY KEY,
  idempotency_key TEXT,
  amount INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'unknown',
  stripe_request_id TEXT,
  stripe_api_latency_ms DOUBLE PRECISION,
  last_event_created BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  payment_intent_id TEXT,
  stripe_created_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS stripe_events_received_at_idx ON stripe_events(received_at DESC);

CREATE TABLE IF NOT EXISTS request_metrics (
  id BIGSERIAL PRIMARY KEY,
  route TEXT NOT NULL,
  latency_ms DOUBLE PRECISION NOT NULL,
  status_code INTEGER NOT NULL,
  stripe_request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS request_metrics_route_created_at_idx ON request_metrics(route, created_at DESC);
