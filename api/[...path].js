const crypto = require('node:crypto');
const { neon } = require('@neondatabase/serverless');

const MAX_BODY_BYTES = 1_000_000;
const MAX_METRICS = 5_000;
const metricBuffer = [];
const eventBuffer = [];
const seenEventIds = new Set();
const db = process.env.DATABASE_URL ? neon(process.env.DATABASE_URL) : null;

const demoPayments = [
  { id: 'pi_demo_7K2W1M', amount: 4890, currency: 'usd', status: 'succeeded', created: 1792510500, lastPaymentError: null },
  { id: 'pi_demo_6R8D4P', amount: 12900, currency: 'usd', status: 'requires_payment_method', created: 1792510140, lastPaymentError: { code: 'card_declined', declineCode: 'insufficient_funds' } },
  { id: 'pi_demo_5A3N9C', amount: 2450, currency: 'usd', status: 'requires_action', created: 1792509780, lastPaymentError: null },
  { id: 'pi_demo_4F1J8T', amount: 8250, currency: 'usd', status: 'processing', created: 1792509420, lastPaymentError: null },
  { id: 'pi_demo_3C7H2Q', amount: 6800, currency: 'usd', status: 'requires_payment_method', created: 1792509060, lastPaymentError: { code: 'processing_error', declineCode: null } },
  { id: 'pi_demo_2P5L6V', amount: 3290, currency: 'usd', status: 'canceled', created: 1792508700, lastPaymentError: null }
];

const demoEvents = [
  { id: 'evt_demo_01', type: 'payment_intent.succeeded', paymentIntentId: 'pi_demo_7K2W1M', created: 1792510501, receivedAt: 1792510502, duplicate: false },
  { id: 'evt_demo_02', type: 'payment_intent.payment_failed', paymentIntentId: 'pi_demo_6R8D4P', created: 1792510141, receivedAt: 1792510142, duplicate: false },
  { id: 'evt_demo_03', type: 'payment_intent.requires_action', paymentIntentId: 'pi_demo_5A3N9C', created: 1792509781, receivedAt: 1792509782, duplicate: false },
  { id: 'evt_demo_04', type: 'payment_intent.processing', paymentIntentId: 'pi_demo_4F1J8T', created: 1792509421, receivedAt: 1792509422, duplicate: false }
];

const recoveryPolicies = {
  network_timeout: {
    category: 'Transport uncertainty',
    automaticRetry: false,
    recommendation: 'First retrieve the PaymentIntent or inspect the webhook inbox. If the outcome is still unknown, retry the same operation with the same idempotency key and unchanged parameters.',
    backoff: 'After state check; bounded exponential backoff',
    action: 'reconcile_then_same_key'
  },
  network_error: {
    category: 'Transport uncertainty',
    automaticRetry: false,
    recommendation: 'The request may have reached Stripe even though the response did not. Reconcile by PaymentIntent or idempotency key before retrying; reuse the same key if a retry is needed.',
    backoff: 'After state check; bounded exponential backoff',
    action: 'reconcile_then_same_key'
  },
  rate_limit: {
    category: 'Rate limit',
    automaticRetry: true,
    recommendation: 'Back off with jitter, respect Retry-After when present, and retry the same request with its original idempotency key.',
    backoff: 'Exponential backoff with jitter',
    action: 'retry_same_key'
  },
  provider_error: {
    category: 'Provider error',
    automaticRetry: false,
    recommendation: 'Check the PaymentIntent state first. Retry only when the result is known and safe; keep the original idempotency key and parameters for a request retry.',
    backoff: 'Reconcile first; bounded backoff if retrying',
    action: 'reconcile_then_same_key'
  },
  card_declined: {
    category: 'Issuer decline',
    automaticRetry: false,
    recommendation: 'Do not automatically retry a declined card. Ask the customer to use another payment method or contact their issuer, then let them confirm a new attempt.',
    backoff: 'No automatic retry',
    action: 'customer_action'
  },
  authentication_required: {
    category: 'Customer authentication',
    automaticRetry: false,
    recommendation: 'Return the customer to the authentication step and let Stripe.js complete the required action. Do not create a second PaymentIntent.',
    backoff: 'Wait for customer action',
    action: 'complete_authentication'
  },
  invalid_request: {
    category: 'Request validation',
    automaticRetry: false,
    recommendation: 'Fix the request parameters or account configuration. Repeating the same invalid request will not resolve it.',
    backoff: 'No retry until corrected',
    action: 'fix_request'
  },
  already_processing: {
    category: 'Payment in progress',
    automaticRetry: false,
    recommendation: 'Wait for the PaymentIntent state or webhook update. Avoid creating another intent while the existing payment is processing.',
    backoff: 'Poll with a bounded interval',
    action: 'wait_for_state'
  }
};

function configuration() {
  const secret = process.env.STRIPE_SECRET_KEY || '';
  const publishable = process.env.STRIPE_PUBLISHABLE_KEY || '';
  const stripeReady = secret.startsWith('sk_test_') && publishable.startsWith('pk_test_');
  return {
    mode: stripeReady ? 'stripe_test' : 'simulator',
    stripeReady,
    publishableKey: publishable.startsWith('pk_test_') ? publishable : null,
    webhookReady: Boolean(process.env.STRIPE_WEBHOOK_SECRET && process.env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')),
    durableStorage: Boolean(db)
  };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.end(JSON.stringify(body));
}

async function rawBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('Request body exceeds the 1 MB limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function jsonBody(req) {
  const raw = await rawBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new Error('Request body must be valid JSON');
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

async function recordMetric(route, latencyMs, status, requestId) {
  const sample = { route, latencyMs: Math.round(latencyMs * 100) / 100, status, requestId: requestId || null, at: Date.now() };
  metricBuffer.push(sample);
  if (metricBuffer.length > MAX_METRICS) metricBuffer.splice(0, metricBuffer.length - MAX_METRICS);
  if (db) {
    await db.query(
      'INSERT INTO request_metrics (route, latency_ms, status_code, stripe_request_id) VALUES ($1, $2, $3, $4)',
      [route, sample.latencyMs, status, requestId || null]
    );
  }
}

async function summarizeMetrics() {
  if (db) {
    const result = await db.query(
      "SELECT COUNT(*)::int AS count, percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95, percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99, AVG(latency_ms) AS average FROM request_metrics WHERE route LIKE 'stripe.%' AND created_at > NOW() - INTERVAL '24 hours'",
      []
    );
    const row = result[0] || {};
    const numberOrNull = value => value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10;
    return {
      count: Number(row.count || 0),
      p50: numberOrNull(row.p50),
      p95: numberOrNull(row.p95),
      p99: numberOrNull(row.p99),
      average: numberOrNull(row.average),
      window: '24h',
      source: 'database'
    };
  }
  const values = metricBuffer.filter(x => x.route.startsWith('stripe.')).map(x => x.latencyMs).sort((a, b) => a - b);
  return {
    count: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    average: values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : null,
    window: 'process lifetime',
    source: 'process'
  };
}

function normalizePayment(intent) {
  return {
    id: intent.id,
    amount: intent.amount,
    currency: intent.currency,
    status: intent.status,
    created: intent.created,
    lastPaymentError: intent.last_payment_error ? {
      code: intent.last_payment_error.code || intent.last_payment_error.type || 'payment_error',
      declineCode: intent.last_payment_error.decline_code || null
    } : null
  };
}

async function stripeRequest(route, url, init = {}) {
  const key = process.env.STRIPE_SECRET_KEY || '';
  if (!key.startsWith('sk_test_')) {
    throw Object.assign(new Error('Stripe test mode is not configured. Add a test-mode STRIPE_SECRET_KEY.'), { status: 503, code: 'stripe_test_key_missing' });
  }
  const started = performance.now();
  let response;
  let result;
  try {
    response = await fetch(url, {
      ...init,
      headers: { authorization: 'Bearer ' + key, ...(init.headers || {}) },
      signal: AbortSignal.timeout(15_000)
    });
    result = await response.json();
  } catch (error) {
    const elapsed = performance.now() - started;
    await recordMetric(route, elapsed, 0, null).catch(() => {});
    throw Object.assign(new Error(error.name === 'TimeoutError' ? 'Stripe request timed out. Check the PaymentIntent before retrying.' : 'Could not reach Stripe. Check the PaymentIntent before retrying.'), {
      status: 502,
      code: error.name === 'TimeoutError' ? 'network_timeout' : 'network_error',
      latencyMs: Math.round(elapsed * 10) / 10
    });
  }
  const elapsed = performance.now() - started;
  const requestId = response.headers.get('request-id');
  await recordMetric(route, elapsed, response.status, requestId).catch(() => {});
  if (!response.ok) {
    const stripeError = result.error || {};
    throw Object.assign(new Error(stripeError.message || 'Stripe API request failed'), {
      status: response.status >= 400 && response.status < 500 ? response.status : 502,
      code: stripeError.code || stripeError.type || 'stripe_api_error',
      declineCode: stripeError.decline_code || null,
      requestId,
      latencyMs: Math.round(elapsed * 10) / 10
    });
  }
  return { data: result, requestId, latencyMs: Math.round(elapsed * 10) / 10 };
}

async function savePaymentAttempt(intent, idempotencyKey, requestId, latencyMs) {
  if (!db) return;
  await db.query(
    'INSERT INTO payment_attempts (stripe_payment_intent_id, idempotency_key, amount, currency, status, stripe_request_id, stripe_api_latency_ms) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET status = EXCLUDED.status, stripe_request_id = EXCLUDED.stripe_request_id, stripe_api_latency_ms = EXCLUDED.stripe_api_latency_ms, updated_at = NOW()',
    [intent.id, idempotencyKey, intent.amount, intent.currency, intent.status, requestId, latencyMs]
  );
}

function simulateLatency(scenario) {
  const ranges = {
    network_timeout: [850, 1400], network_error: [220, 800], rate_limit: [120, 420],
    provider_error: [300, 1100], card_declined: [170, 620], authentication_required: [180, 500],
    invalid_request: [45, 180], already_processing: [60, 260]
  };
  const [low, high] = ranges[scenario] || ranges.invalid_request;
  return Math.round((low + crypto.randomInt(Math.max(1, high - low + 1))) * 10) / 10;
}

async function listEvents() {
  if (db) {
    const rows = await db.query(
      'SELECT event_id AS id, event_type AS type, payment_intent_id AS "paymentIntentId", EXTRACT(EPOCH FROM stripe_created_at)::bigint AS created, EXTRACT(EPOCH FROM received_at)::bigint AS "receivedAt" FROM stripe_events ORDER BY received_at DESC LIMIT 50',
      []
    );
    return { events: rows.map(row => ({ ...row, duplicate: false })), demo: false, durable: true };
  }
  return { events: eventBuffer.length ? eventBuffer.slice(0, 50) : demoEvents, demo: eventBuffer.length === 0, durable: false };
}

async function storeEvent(event) {
  const object = event.data && event.data.object ? event.data.object : {};
  const paymentIntentId = object.object === 'payment_intent' ? object.id : (object.payment_intent || null);
  const row = {
    id: event.id, type: event.type, paymentIntentId,
    created: event.created, receivedAt: Math.floor(Date.now() / 1000), duplicate: false
  };
  if (db) {
    const inserted = await db.query(
      'INSERT INTO stripe_events (event_id, event_type, payment_intent_id, stripe_created_at) VALUES ($1, $2, $3, TO_TIMESTAMP($4)) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
      [event.id, event.type, paymentIntentId, event.created]
    );
    if (!inserted.length) return { ...row, duplicate: true };
    if (paymentIntentId && object.object === 'payment_intent') {
      await db.query(
        'INSERT INTO payment_attempts (stripe_payment_intent_id, amount, currency, status, last_event_created) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET amount = EXCLUDED.amount, currency = EXCLUDED.currency, status = EXCLUDED.status, last_event_created = EXCLUDED.last_event_created, updated_at = NOW() WHERE payment_attempts.last_event_created <= EXCLUDED.last_event_created',
        [object.id, object.amount || 0, object.currency || 'usd', object.status || 'unknown', event.created]
      );
    }
    return row;
  }
  if (seenEventIds.has(event.id)) return { ...row, duplicate: true };
  seenEventIds.add(event.id);
  eventBuffer.unshift(row);
  if (eventBuffer.length > 500) eventBuffer.length = 500;
  return row;
}

function safeEqualHex(expected, actual) {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifySignature(raw, header, secret) {
  if (!header || !secret) return false;
  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const [key, value] = part.split('=');
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(timestamp + '.').update(raw).digest('hex');
  return signatures.some(signature => safeEqualHex(expected, signature));
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const route = url.pathname.replace(/^\/api\/?/, '');
  try {
    if (req.method === 'GET' && route === 'health') {
      return send(res, 200, { ok: true, mode: configuration().mode, durableStorage: Boolean(db), now: Date.now() });
    }
    if (req.method === 'GET' && route === 'config') return send(res, 200, configuration());
    if (req.method === 'GET' && route === 'payments') {
      if (!configuration().stripeReady) return send(res, 200, { payments: demoPayments, demo: true });
      const result = await stripeRequest('stripe.list_payment_intents', 'https://api.stripe.com/v1/payment_intents?limit=50');
      return send(res, 200, { payments: (result.data.data || []).map(normalizePayment), demo: false });
    }
    if (req.method === 'GET' && route === 'events') return send(res, 200, await listEvents());
    if (req.method === 'GET' && route === 'metrics') return send(res, 200, await summarizeMetrics());
    if (req.method === 'POST' && route === 'payment-intents') {
      const input = await jsonBody(req);
      const amount = Number(input.amount);
      const currency = String(input.currency || 'usd').toLowerCase();
      const idempotencyKey = String(req.headers['idempotency-key'] || '');
      if (!Number.isInteger(amount) || amount < 50 || amount > 500000) return send(res, 400, { error: 'Amount must be between 50 and 500,000 minor units.' });
      if (!/^[a-z]{3}$/.test(currency)) return send(res, 400, { error: 'Currency must be a three-letter code.' });
      if (idempotencyKey.length < 16 || idempotencyKey.length > 255) return send(res, 400, { error: 'Send a stable Idempotency-Key of 16–255 characters.' });
      if (!configuration().stripeReady) return send(res, 503, { error: 'Stripe test mode is not ready. Configure both STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY with test-mode keys.' });
      const form = new URLSearchParams({
        amount: String(amount), currency,
        'automatic_payment_methods[enabled]': 'true',
        'metadata[application]': 'pulsepay-reliability-desk'
      });
      const result = await stripeRequest('stripe.create_payment_intent', 'https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idempotencyKey },
        body: form
      });
      await savePaymentAttempt(result.data, idempotencyKey, result.requestId, result.latencyMs);
      return send(res, 201, {
        id: result.data.id, status: result.data.status,
        clientSecret: result.data.client_secret,
        requestId: result.requestId, latencyMs: result.latencyMs
      });
    }
    if (req.method === 'GET' && route.startsWith('payment-intents/')) {
      const id = decodeURIComponent(route.slice('payment-intents/'.length));
      if (!/^pi_[a-zA-Z0-9]+$/.test(id)) return send(res, 400, { error: 'PaymentIntent ID is invalid.' });
      const result = await stripeRequest('stripe.retrieve_payment_intent', 'https://api.stripe.com/v1/payment_intents/' + encodeURIComponent(id));
      return send(res, 200, normalizePayment(result.data));
    }
    if (req.method === 'POST' && route === 'recovery/evaluate') {
      const input = await jsonBody(req);
      const scenario = String(input.scenario || '');
      return send(res, 200, { scenario, ...(recoveryPolicies[scenario] || recoveryPolicies.invalid_request) });
    }
    if (req.method === 'POST' && route === 'recovery/simulate') {
      const input = await jsonBody(req);
      const scenario = String(input.scenario || 'network_timeout');
      const count = Math.max(10, Math.min(1000, Math.floor(Number(input.count) || 100)));
      const values = Array.from({ length: count }, () => simulateLatency(scenario)).sort((a, b) => a - b);
      return send(res, 200, {
        scenario, count, synthetic: true,
        p50: percentile(values, 0.5), p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
        average: Math.round(values.reduce((sum, value) => sum + value, 0) / count * 10) / 10,
        policy: recoveryPolicies[scenario] || recoveryPolicies.invalid_request
      });
    }
    if (req.method === 'POST' && route === 'webhooks/stripe') {
      const raw = await rawBody(req);
      const secret = process.env.STRIPE_WEBHOOK_SECRET || '';
      if (!secret.startsWith('whsec_') || !verifySignature(raw, req.headers['stripe-signature'], secret)) {
        return send(res, 400, { error: 'Invalid Stripe test webhook signature.' });
      }
      let event;
      try {
        event = JSON.parse(raw.toString('utf8'));
      } catch {
        return send(res, 400, { error: 'Webhook body must be valid JSON.' });
      }
      if (event.livemode === true) return send(res, 400, { error: 'Live-mode webhook events are not accepted by this test-mode app.' });
      const stored = await storeEvent(event);
      return send(res, 200, { received: true, duplicate: stored.duplicate, eventId: stored.id });
    }
    return send(res, 404, { error: 'API route not found.' });
  } catch (error) {
    return send(res, Number(error.status) || (db ? 503 : 500), {
      error: error.message || 'Request failed.',
      code: error.code || 'request_failed',
      requestId: error.requestId || null,
      latencyMs: error.latencyMs || null
    });
  }
};

module.exports.config = { api: { bodyParser: false } };
