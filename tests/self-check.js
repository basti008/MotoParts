const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const base = process.env.BASE_URL || 'http://localhost:3000';
const results = [];
let primaryServer = null;
let mockProvider = null;

async function req(method, url, body) {
  const started = Date.now();
  const r = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, data, ms: Date.now() - started };
}
function record(id, ok, detail) { results.push({ id, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}\t${id}\t${detail}`); }
function assert(id, condition, detail) { record(id, !!condition, detail); }
function checkoutPayload() { return {
  customer: { name: 'Self Check Customer', phone: '09171234567', address: '123 Test Street, Barangay Test', province: 'Metro Manila', city: 'Manila' },
  payment: 'Cash on Delivery',
  items: [{ id: 1, type: 'Standard', motor: 'NMAX', qty: 1 }]
}; }

async function startPrimaryIfNeeded() {
  if (process.env.BASE_URL) return;
  mockProvider = http.createServer((req, res) => {
    if (req.url.startsWith('/v1/search')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ results: [{ name: 'Manila', latitude: 14.5995, longitude: 120.9842, country: 'Philippines', admin1: 'Metro Manila', timezone: 'Asia/Manila' }] }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'mock endpoint not found' }));
  });
  await new Promise((resolve, reject) => { mockProvider.listen(3200, '127.0.0.1', resolve); mockProvider.on('error', reject); });
  primaryServer = spawn(process.execPath, [path.join(__dirname, '..', 'app.js')], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '3000', OPEN_METEO_GEOCODING_URL: 'http://127.0.0.1:3200/v1/search' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Primary server did not start within 3 seconds.')), 3000); primaryServer.stdout.on('data', b => { if (String(b).includes('MotoParts running')) { clearTimeout(timer); resolve(); } }); primaryServer.on('error', reject); });
}

async function main() {
  try {
    await startPrimaryIfNeeded();
    let r = await req('GET', '/api/health'); assert('FR-01 health', r.status === 200 && r.data.status === 'ok', `HTTP ${r.status}`);
    r = await req('GET', '/api/parts'); assert('FR-01 catalog', r.status === 200 && Array.isArray(r.data.items), `HTTP ${r.status}`);
    r = await req('GET', '/api/parts?model=NMAX'); assert('FR-02 filter', r.status === 200 && r.data.items.every(p => String(p.model).toUpperCase().includes('NMAX')), `HTTP ${r.status}, count=${r.data.count}`);
    r = await req('GET', '/api/parts/1'); assert('FR-03 get part', r.status === 200 && r.data.id === 1, `HTTP ${r.status}`);
    r = await req('GET', '/api/parts/999999'); assert('FR-03 missing part', r.status === 404 && r.data.error, `HTTP ${r.status}`);

    const testPart = { name: 'Self Check Temporary Part', model: 'NMAX', category: 'Accessories', price: 1234, tag: 'TEST', desc: 'Temporary automated test part.' };
    r = await req('POST', '/api/parts', testPart); assert('FR-04 create', r.status === 201 && r.data.id, `HTTP ${r.status}`);
    const testId = r.data.id;
    r = await req('POST', '/api/parts', { ...testPart, price: -1 }); assert('FR-04 invalid create', r.status === 400, `HTTP ${r.status}`);
    r = await req('PUT', `/api/parts/${testId}`, { ...testPart, name: 'Self Check Updated Part', price: 1500 }); assert('FR-05 update', r.status === 200 && r.data.name === 'Self Check Updated Part', `HTTP ${r.status}`);
    r = await req('PUT', '/api/parts/999999', { ...testPart }); assert('FR-05 missing update', r.status === 404, `HTTP ${r.status}`);
    r = await req('DELETE', `/api/parts/${testId}`); assert('FR-06 delete', r.status === 200, `HTTP ${r.status}`);
    r = await req('DELETE', '/api/parts/999999'); assert('FR-06 missing delete', r.status === 404, `HTTP ${r.status}`);

    r = await req('GET', '/api/delivery/lookup?city=Manila&province=Metro%20Manila'); assert('FR-07 verify delivery', r.status === 200 && r.data.location?.officialName, `HTTP ${r.status}`);
    r = await req('POST', '/api/orders/checkout', checkoutPayload()); assert('FR-08 save order', r.status === 201 && r.data.order?.orderNo && r.data.integration?.localSaved, `HTTP ${r.status}`);
    const orderNo = r.data.order.orderNo;
    r = await req('GET', `/api/orders/${orderNo}`); assert('FR-09 get order', r.status === 200 && r.data.orderNo === orderNo, `HTTP ${r.status}`);
    r = await req('PATCH', `/api/orders/${orderNo}`, { status: 'CONFIRMED' }); assert('FR-10 update order', r.status === 200 && r.data.status === 'CONFIRMED', `HTTP ${r.status}`);
    r = await req('PATCH', `/api/orders/${orderNo}`, { status: 'NOT_A_STATUS' }); assert('FR-10 invalid status', r.status === 400, `HTTP ${r.status}`);
    r = await req('DELETE', `/api/orders/${orderNo}`); assert('FR-11 delete order', r.status === 200, `HTTP ${r.status}`);

    // FR-12: start a second instance with an intentionally unreachable provider URL.
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'app.js')], {
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, PORT: '3101', OPEN_METEO_GEOCODING_URL: 'http://127.0.0.1:9/unreachable', PROVIDER_TIMEOUT_MS: '1000' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1200); child.stdout.on('data', b => { if (String(b).includes('MotoParts running')) { clearTimeout(timer); resolve(); } }); child.on('error', reject); });
    try {
      const failureBase = 'http://localhost:3101';
      const oldBase = globalThis.__base; globalThis.__base = base;
      const r2 = await fetch(failureBase + '/api/orders/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(checkoutPayload()) });
      const d2 = await r2.json(); assert('FR-12 provider failure', r2.status === 503 && d2.error && /unavailable|temporarily/i.test(d2.error), `HTTP ${r2.status}`);
      globalThis.__base = oldBase;
    } finally { child.kill(); }
  } catch (e) { record('SELF-CHECK', false, e.message); process.exitCode = 1; }
  const failed = results.filter(x => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (primaryServer) primaryServer.kill();
  if (mockProvider) mockProvider.close();
  if (failed.length) process.exitCode = 1;
}
main();
