const crypto = require('node:crypto');

const samples = [];
const MAX_SAMPLES = 3000;

function record(ms, kind = 'simulation') {
  samples.push({ ms, kind, at: Date.now() });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}

function percentile(values, p) {
  return values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : 0;
}

function summarize() {
  const values = samples.map(x => x.ms).sort((a, b) => a - b);
  return {
    count: values.length,
    p50: Math.round(percentile(values, .5)),
    p95: Math.round(percentile(values, .95)),
    p99: Math.round(percentile(values, .99)),
    avg: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0,
    samples: samples.slice(-120),
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_'))
  };
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

async function rawBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function verifyStripeSignature(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(item => item.split('=')));
  if (!parts.t || !parts.v1) return false;
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(parts.t + '.').update(raw).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  const started = process.hrtime.bigint();
  const route = new URL(req.url, 'http://localhost').pathname.replace(/^\/api\/?/, '');
  try {
    if (req.method === 'GET' && route === 'health') return json(res, 200, { ok: true, now: Date.now() });
    if (req.method === 'GET' && route === 'metrics') return json(res, 200, summarize());
    if (req.method === 'POST' && route === 'simulate') {
      const input = JSON.parse((await rawBody(req)).toString() || '{}');
      const count = Math.max(1, Math.min(250, Number(input.count) || 1));
      const delay = Math.max(0, Math.min(500, Number(input.delayMs) || 0));
      const batch = [];
      for (let i = 0; i < count; i++) {
        const t = process.hrtime.bigint();
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        record(ms);
        batch.push(Math.round(ms * 10) / 10);
      }
      return json(res, 200, { accepted: count, durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6), latenciesMs: batch, metrics: summarize() });
    }
    if (req.method === 'POST' && route === 'checkout') {
      const input = JSON.parse((await rawBody(req)).toString() || '{}');
      const secret = process.env.STRIPE_SECRET_KEY;
      if (!secret?.startsWith('sk_test_')) return json(res, 503, { error: 'Stripe test mode is not configured. Add STRIPE_SECRET_KEY to your environment.' });
      const amount = Math.round(Math.max(1, Math.min(500, Number(input.amount) || 24.99)) * 100);
      const idempotencyKey = crypto.randomUUID();
      const origin = req.headers.origin || `https://${req.headers.host}`;
      const form = new URLSearchParams({ mode: 'payment', success_url: `${origin}/?checkout=success`, cancel_url: `${origin}/?checkout=cancelled`, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(amount), 'line_items[0][price_data][product_data][name]': 'PulsePay demo payment' });
      const stripeStarted = process.hrtime.bigint();
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idempotencyKey }, body: form });
      const elapsed = Number(process.hrtime.bigint() - stripeStarted) / 1e6;
      record(elapsed, 'stripe');
      const result = await response.json();
      if (!response.ok) return json(res, response.status, { error: result.error?.message || 'Stripe request failed', latencyMs: Math.round(elapsed) });
      return json(res, 200, { url: result.url, sessionId: result.id, latencyMs: Math.round(elapsed) });
    }
    if (req.method === 'POST' && route === 'webhooks/stripe') {
      const raw = await rawBody(req);
      if (!verifyStripeSignature(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) return json(res, 400, { error: 'Invalid Stripe webhook signature' });
      const event = JSON.parse(raw.toString());
      if (event.type === 'checkout.session.completed') console.log(`Stripe test checkout completed: ${event.data.object.id}`);
      return json(res, 200, { received: true });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    return json(res, 400, { error: error.message || 'Bad request' });
  }
};

module.exports.config = { api: { bodyParser: false } };
