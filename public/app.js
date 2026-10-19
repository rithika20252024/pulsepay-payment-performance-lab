const $ = (selector) => document.querySelector(selector);
const toast = (message) => { const el = $('#toast'); el.textContent = message; el.classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => el.classList.remove('show'), 2600); };
function paintSpark(samples) {
  if (!samples?.length) return;
  const values = samples.map(x => Math.max(1, x.ms)); const min = Math.min(...values); const max = Math.max(...values); const span = Math.max(1, max - min);
  const points = values.map((value, i) => `${Math.round(i / Math.max(1, values.length - 1) * 640)},${Math.round(64 - ((value - min) / span) * 47)}`);
  $('#sparkPath').setAttribute('d', `M${points.join(' L')}`); $('#sparkFill').setAttribute('d', `M${points.join(' L')} L640 72 L0 72Z`);
  $('#sparkCount').textContent = `${values.length} recent samples`;
}
async function refreshMetrics() {
  try {
    const response = await fetch('/api/metrics'); const data = await response.json();
    $('#p50Lab').innerHTML = `${data.p50}<em>ms</em>`; $('#p95Lab').innerHTML = `${data.p95}<em>ms</em>`; $('#p99Lab').innerHTML = `${data.p99}<em>ms</em>`; $('#samplesLab').textContent = data.count;
    if (data.count) $('#p95Value').textContent = data.p95;
    paintSpark(data.samples);
  } catch { /* dashboard still renders when the API is unavailable */ }
}
$('#runBenchmark').addEventListener('click', async (event) => {
  const button = event.currentTarget; button.disabled = true; button.innerHTML = '<span>◌</span> Measuring…';
  try {
    const response = await fetch('/api/simulate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: Number($('#requestCount').value), delayMs: Number($('#requestDelay').value) }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Benchmark failed');
    await refreshMetrics(); toast(`${data.accepted} requests measured in ${data.durationMs} ms`);
    const row = document.createElement('div'); row.className = 'activity-row';
    row.innerHTML = `<div class="activity-icon success">⌁</div><div class="activity-copy"><b>Latency benchmark completed</b><small>${data.accepted} synthetic requests · p95 ${data.metrics.p95} ms</small></div><span class="activity-time">just now</span>`;
    $('#activityList').prepend(row);
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.innerHTML = '<span>▶</span> Run benchmark'; }
});
$('#checkoutBtn').addEventListener('click', async () => {
  const button = $('#checkoutBtn'); const message = $('#checkoutMessage'); button.disabled = true; button.textContent = 'Connecting to Stripe…'; message.className = 'checkout-message';
  try {
    const response = await fetch('/api/checkout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: 24.99 }) }); const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Checkout could not be started');
    message.textContent = `Checkout created · ${data.latencyMs} ms`; message.className = 'checkout-message success'; window.location.assign(data.url);
  } catch (error) { message.textContent = error.message; message.className = 'checkout-message error'; }
  finally { button.disabled = false; button.innerHTML = '<span>↗</span> Continue to checkout'; }
});
$('#exportBtn').addEventListener('click', async () => {
  const response = await fetch('/api/metrics'); const data = await response.json();
  const csv = ['metric,value,unit', `samples,${data.count},requests`, `p50,${data.p50},ms`, `p95,${data.p95},ms`, `p99,${data.p99},ms`, `average,${data.avg},ms`, `stripe_test_mode_configured,${data.stripeConfigured},boolean`].join('\n');
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); link.download = 'pulsepay-performance.csv'; link.click(); URL.revokeObjectURL(link.href); toast('Performance report exported');
});
document.querySelectorAll('.chart-controls button[data-range]').forEach(button => button.addEventListener('click', () => { document.querySelectorAll('.chart-controls button[data-range]').forEach(item => item.classList.remove('active')); button.classList.add('active'); }));
const checkoutState = new URLSearchParams(location.search).get('checkout');
if (checkoutState === 'success') { $('#checkoutMessage').textContent = 'Checkout complete in Stripe test mode.'; $('#checkoutMessage').classList.add('success'); }
if (checkoutState === 'cancelled') { $('#checkoutMessage').textContent = 'Checkout cancelled. No payment was created.'; }
refreshMetrics(); setInterval(refreshMetrics, 5000);
