const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 3000);
const root = path.join(__dirname, 'public');
const samples = [];
const MAX_SAMPLES = 3000;
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };

function record(ms, kind = 'simulation') {
  samples.push({ ms, kind, at: Date.now() });
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}
function percentile(values, p) { return values.length ? values[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)] : 0; }
function summarize() {
  const values = samples.map(x => x.ms).sort((a, b) => a - b);
  return { count: values.length, p50: Math.round(percentile(values, .5)), p95: Math.round(percentile(values, .95)), p99: Math.round(percentile(values, .99)), avg: values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0, samples: samples.slice(-120), stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_')) };
}
function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': 'same-origin' });
  res.end(JSON.stringify(body));
}
async function bodyOf(req, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error('Request body too large'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function timingSafeHex(a, b) {
  const aa = Buffer.from(a || '', 'hex'); const bb = Buffer.from(b || '', 'hex');
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function verifyStripeSignature(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(item => item.split('=')));
  if (!parts.t || !parts.v1) return false;
  const age = Math.abs(Date.now() / 1000 - Number(parts.t));
  if (!Number.isFinite(age) || age > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${parts.t}.`).update(raw).digest('hex');
  return timingSafeHex(expected, parts.v1);
}

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true, now: Date.now() });
    if (req.method === 'GET' && url.pathname === '/api/metrics') return send(res, 200, summarize());
    if (req.method === 'POST' && url.pathname === '/api/simulate') {
      const input = JSON.parse((await bodyOf(req)).toString() || '{}');
      const count = Math.max(1, Math.min(250, Number(input.count) || 1));
      const delay = Math.max(0, Math.min(500, Number(input.delayMs) || 0));
      const batch = [];
      for (let i = 0; i < count; i++) {
        const t = process.hrtime.bigint();
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        record(ms); batch.push(Math.round(ms * 10) / 10);
      }
      return send(res, 200, { accepted: count, durationMs: Math.round(Number(process.hrtime.bigint() - started) / 1e6), latenciesMs: batch, metrics: summarize() });
    }
    if (req.method === 'POST' && url.pathname === '/api/checkout') {
      const raw = await bodyOf(req); const input = JSON.parse(raw.toString() || '{}');
      const secret = process.env.STRIPE_SECRET_KEY;
      if (!secret?.startsWith('sk_test_')) return send(res, 503, { error: 'Stripe test mode is not configured. Add STRIPE_SECRET_KEY to your environment.' });
      const amount = Math.round(Math.max(1, Math.min(500, Number(input.amount) || 24.99)) * 100);
      const idempotencyKey = crypto.randomUUID();
      const form = new URLSearchParams({ mode: 'payment', success_url: `${url.origin}/?checkout=success`, cancel_url: `${url.origin}/?checkout=cancelled`, 'line_items[0][price_data][currency]': 'usd', 'line_items[0][price_data][unit_amount]': String(amount), 'line_items[0][price_data][product_data][name]': 'PulsePay demo payment' });
      const stripeStarted = process.hrtime.bigint();
      const response = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/x-www-form-urlencoded', 'idempotency-key': idempotencyKey }, body: form });
      const elapsed = Number(process.hrtime.bigint() - stripeStarted) / 1e6; record(elapsed, 'stripe');
      const result = await response.json();
      if (!response.ok) return send(res, response.status, { error: result.error?.message || 'Stripe request failed', latencyMs: Math.round(elapsed) });
      return send(res, 200, { url: result.url, sessionId: result.id, latencyMs: Math.round(elapsed) });
    }
    if (req.method === 'POST' && url.pathname === '/api/webhooks/stripe') {
      const raw = await bodyOf(req);
      if (!verifyStripeSignature(raw, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) return send(res, 400, { error: 'Invalid Stripe webhook signature' });
      const event = JSON.parse(raw.toString());
      if (event.type === 'checkout.session.completed') console.log(`Stripe test checkout completed: ${event.data.object.id}`);
      return send(res, 200, { received: true });
    }
    if (req.method === 'GET') {
      const requested = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(root, requested);
      if (!file.startsWith(root + path.sep) && file !== path.join(root, 'index.html')) return send(res, 403, { error: 'Forbidden' });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'content-type': mime[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(error);
    if (!res.headersSent) send(res, 400, { error: error.message || 'Bad request' });
    else res.destroy();
  }
});
server.listen(PORT, () => console.log(`PulsePay running at http://localhost:${PORT}`));
