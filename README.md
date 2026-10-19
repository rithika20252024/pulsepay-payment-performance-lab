# PulsePay — Payment Performance Lab

**A production-inspired payment operations dashboard for exploring API latency, Stripe Checkout, and webhook verification.**

[**Open the live demo →**](https://pulsepay-payment-performance-lab.vercel.app) · [Source code](https://github.com/rithika20252024/pulsepay-payment-performance-lab)

## Project description

PulsePay is a portfolio project that demonstrates how a small payment service can expose useful performance signals alongside checkout and webhook flows. It pairs a responsive operations dashboard with a Node.js API for synthetic latency benchmarks, Stripe test-mode Checkout, and signed webhook verification.

The project is designed for learning and demonstration. Dashboard overview figures and sample activity are illustrative; benchmark results are measured by the running API process. This is not a payment processor, production monitoring service, or load-testing tool.

## What’s included

- **Payment operations UI** with overview metrics, activity examples, a latency workbench, and a Stripe Checkout panel.
- **Latency benchmark API** that measures configurable synthetic requests and reports p50, p95, p99, and average latency.
- **Stripe Checkout example** that creates a hosted Checkout Session only when a Stripe **test-mode** secret is configured. Requests use an idempotency key.
- **Webhook signature verification** using Stripe’s timestamped HMAC SHA-256 signature and a five-minute tolerance.
- **CSV export** for the current benchmark summary.
- **Vercel deployment support** through a serverless API handler and static frontend.

## Live demo

[https://pulsepay-payment-performance-lab.vercel.app](https://pulsepay-payment-performance-lab.vercel.app)

Checkout is available only when `STRIPE_SECRET_KEY` is configured for the deployment with a Stripe test-mode key. No live payment keys should be used.

## Run locally

**Requirements:** Node.js 20 or newer. The project has no runtime npm dependencies.

```sh
git clone https://github.com/rithika20252024/pulsepay-payment-performance-lab.git
cd pulsepay-payment-performance-lab
npm start
```

Open [http://localhost:3000](http://localhost:3000). Use **Run benchmark** to send synthetic requests to the local API.

To use Stripe Checkout locally, set a test key in your shell before starting the server:

```sh
export STRIPE_SECRET_KEY=sk_test_your_key
npm start
```

For local webhook testing, install and authenticate the [Stripe CLI](https://docs.stripe.com/stripe-cli), then run:

```sh
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Set the signing secret printed by the CLI as `STRIPE_WEBHOOK_SECRET` in the server environment. The server does not load a local `.env` file automatically. Never commit real credentials; `.env.example` contains placeholders only.

## Deploy to Vercel

The repository is configured for Vercel with `vercel.json` and the serverless handler at `api/[...path].js`.

1. Import this GitHub repository into Vercel.
2. Keep the repository root as the project root; no build command is required.
3. Add `STRIPE_SECRET_KEY` as a Vercel environment variable if you want to enable test Checkout.
4. Configure a Stripe webhook endpoint and add its signing secret as `STRIPE_WEBHOOK_SECRET`.
5. Deploy, then point the Stripe test webhook at `https://<your-domain>/api/webhooks/stripe`.

Use Stripe test-mode credentials only. Vercel functions can run across multiple instances and may be ephemeral, so the in-memory benchmark results are not durable or aggregated across instances.

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Returns a basic process health response. |
| `GET` | `/api/metrics` | Returns in-memory sample count, average, p50, p95, and p99 latency. |
| `POST` | `/api/simulate` | Measures 1–250 synthetic requests using the requested local delay. |
| `POST` | `/api/checkout` | Creates a Stripe Checkout Session in test mode. |
| `POST` | `/api/webhooks/stripe` | Verifies a Stripe signature and acknowledges the event. |

Example benchmark request:

```sh
curl -X POST http://localhost:3000/api/simulate \
  -H 'content-type: application/json' \
  -d '{"count":25,"delayMs":20}'
```

## Measurement notes and limitations

- Synthetic samples time an awaited local delay using Node.js `process.hrtime.bigint()`.
- Percentiles use the nearest-rank method.
- Checkout latency records the duration of the outbound Stripe API request.
- Benchmark samples are held in process memory and reset when that process restarts.
- The dashboard’s overview totals, history chart, and example activity feed are illustrative UI content. Workbench metrics and the exported report come from the API.
- Results describe this demo environment; they are not production traffic, a load test, or a service-level objective.
- Before adapting the example for real payments, add durable storage, robust idempotent webhook processing, operational monitoring, and a production security review.

## Tech stack

- Node.js built-in HTTP server and APIs
- HTML, CSS, and browser JavaScript
- Stripe Checkout and Stripe webhook signatures
- Vercel serverless functions and static hosting

## License

See [LICENSE](LICENSE).
