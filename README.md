# PulsePay — Payment Performance Lab

PulsePay is a portfolio project for exploring payment API design and latency measurement. It includes a responsive payment operations dashboard, a Stripe Checkout integration that is disabled until a **test-mode** secret is configured, a Stripe webhook signature verifier, and an in-memory latency workbench with p50/p95/p99 reporting.

## Run locally

Requires Node.js 20 or newer. There are no runtime dependencies.

```sh
npm start
```

Then open http://localhost:3000. Click **Run benchmark** to create synthetic requests. The benchmark waits for the selected local delay per request and measures the elapsed time with Node's high-resolution monotonic clock. Metrics live in process memory and reset on restart. They measure this demo server, not Stripe or production traffic.

The dashboard's overview totals, history chart, and sample event feed are illustrative UI data. The workbench counters and exported report use live measurements from the API process.

## Stripe test-mode setup

1. Copy `.env.example` values into your shell or a local `.env` file (the server does not load `.env` automatically).
2. Export `STRIPE_SECRET_KEY=sk_test_...` and start the server. Never use or commit a live key.
3. Click **Continue to checkout**. The server creates a Checkout Session with a per-request idempotency key, records Stripe API elapsed time and redirects to Stripe-hosted checkout.
4. For local webhooks, run the Stripe CLI listener and set the signing secret it prints as `STRIPE_WEBHOOK_SECRET`:

```sh
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

The webhook endpoint validates Stripe's timestamped HMAC SHA-256 signature with a five-minute tolerance before accepting events. The sample acknowledges completed Checkout sessions; add durable storage and idempotent event handling before adapting it for real users.

## Deploy on Vercel

The repository includes a Vercel serverless API handler at `api/[...path].js`; it supports the same API routes as the local Node server. Deploy this directory as the project root with no build step and `public` as the static output directory. Configure `STRIPE_SECRET_KEY` as a Vercel environment variable using a test key. Add `STRIPE_WEBHOOK_SECRET` after configuring a Stripe webhook endpoint. Vercel functions are ephemeral and can run in multiple instances, so the in-memory benchmark measurements are per instance and are not durable or globally aggregated.

## API

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Process health check |
| `GET /api/metrics` | In-memory sample count, average and p50/p95/p99 latency |
| `POST /api/simulate` | Generate 1–250 synthetic measured requests |
| `POST /api/checkout` | Create a Stripe Checkout Session in test mode |
| `POST /api/webhooks/stripe` | Verify and acknowledge Stripe webhook events |

## Measurement methodology

Each benchmark sample times an awaited local delay using `process.hrtime.bigint()`. Percentiles use the nearest-rank method. Stripe checkout latency times the outbound Stripe API call only. Metrics are process-local and are not a load-test, payment-volume claim, or production SLO. For meaningful comparisons, record environment, Node version, concurrency, warmup, and request count; repeat runs and compare percentiles rather than single requests.

## Resume-safe project summary

After running benchmarks and saving your actual results, you can describe the work accurately, for example:

> Built PulsePay, a Node.js payment performance lab with Stripe test-mode Checkout, request idempotency, signed webhook validation, and p50/p95/p99 latency instrumentation; measured [your observed result] across [your request count] local synthetic requests.

Replace the bracketed values only with numbers you personally measured. Do not describe the local synthetic benchmark as production-scale payment traffic.

## Suggested open-source follow-up

GitHub surfaced a relevant Stripe Node SDK reliability issue: [stripe/stripe-node #2897](https://github.com/stripe/stripe-node/issues/2897) describes a request timeout left armed when a failed response is retried, which can keep a short-lived process alive after the request has succeeded. A focused regression test for retry-timeout cleanup would connect this project’s latency/reliability theme to a real payment SDK. This project does not include an upstream contribution or claim that issue as fixed.

## Design notes

The interface is an original payment-operations dashboard with a calm neutral canvas, emerald status accents, compact metric cards, transaction activity, and a dedicated latency workbench. Responsive layouts collapse from a two-column dashboard to a single column on narrow screens.
