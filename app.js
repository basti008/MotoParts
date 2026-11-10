const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const PARTS_FILE = path.join(DATA_DIR, 'parts.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const PROVIDER_TIMEOUT_MS = Number(process.env.PROVIDER_TIMEOUT_MS || 5000);
const GEOCODING_BASE_URL = process.env.OPEN_METEO_GEOCODING_URL || 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_BASE_URL = process.env.OPEN_METEO_FORECAST_URL || 'https://api.open-meteo.com/v1/forecast';

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Correlation Identifier pattern: one request ID follows the request through every service call.
app.use((req, res, next) => {
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);
  console.log(JSON.stringify({ requestId: req.requestId, method: req.method, path: req.path }));
  next();
});

function ensureDataFiles() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PARTS_FILE)) fs.writeFileSync(PARTS_FILE, '[]');
  if (!fs.existsSync(ORDERS_FILE)) fs.writeFileSync(ORDERS_FILE, '[]');
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function readParts() { return readJson(PARTS_FILE); }
function writeParts(items) { writeJson(PARTS_FILE, items); }
function readOrders() { return readJson(ORDERS_FILE); }
function writeOrders(items) { writeJson(ORDERS_FILE, items); }
function sendError(res, status, message, details) {
  return res.status(status).json({ error: message, ...(details ? { details } : {}) });
}
function normalizeModel(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, ' ');
}
function compatibleWith(part, requestedModel) {
  if (!requestedModel) return true;
  const target = normalizeModel(requestedModel);
  return String(part.model || '').split('/').map(normalizeModel).some(m => m === target) ||
    String(part.model || '').toUpperCase().includes(target);
}
function validatePart(body) {
  const { name, model, category, price } = body || {};
  if (!name || !model || !category || !Number.isFinite(Number(price)) || Number(price) < 0) {
    return 'Name, model, category, and a non-negative price are required.';
  }
  const allowed = ['MIO SPORTY', 'HONDA CLICK', 'NMAX', 'AEROX', 'PCX'];
  const models = String(model).split('/').map(normalizeModel);
  if (models.some(m => !allowed.includes(m))) return 'Model must use only Mio Sporty, Honda Click, NMAX, Aerox, or PCX.';
  return null;
}

// Adapter pattern: all Open-Meteo communication is isolated here.
const onlineAdapter = {
  async geocodeCity(city, province) {
    // Open-Meteo's `name` parameter works more reliably with the locality
    // name itself than with a full `City of ...` string. The PSGC dropdown
    // can return names such as `City of Lucena`, so try normalized variants
    // and then prefer a result whose province matches the selected province.
    const rawCity = String(city || '').trim();
    const rawProvince = String(province || '').trim();
    const cityVariants = [...new Set([
      rawCity,
      rawCity.replace(/^city of\s+/i, ''),
      rawCity.replace(/^municipality of\s+/i, ''),
      rawCity.replace(/\s+city$/i, ''),
      rawCity.replace(/^city of\s+/i, '').replace(/\s+city$/i, '')
    ].map(x => x.trim()).filter(Boolean))];

    const normalizePlace = value => String(value || '')
      .toLowerCase()
      .replace(/^city of\s+/i, '')
      .replace(/^municipality of\s+/i, '')
      .replace(/\s+city$/i, '')
      .replace(/\s+province$/i, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();

    const targetProvince = normalizePlace(rawProvince);
    let lastResponseError = null;

    for (const cityName of cityVariants) {
      // Open-Meteo's geocoder expects the locality in `name`. Passing a
      // compound value such as `Lucena, Quezon, Philippines` can return no
      // results even when the locality exists. Search by the city/municipality
      // name, then validate the returned province/country below.
      const query = cityName;
      const url = `${GEOCODING_BASE_URL}?name=${encodeURIComponent(query)}&count=10&language=en&format=json&countryCode=PH`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`Geocoding provider returned ${response.status}`);
        const raw = await response.json();
        const results = Array.isArray(raw.results) ? raw.results : [];
        if (!results.length) continue;

        const exactCity = normalizePlace(cityName);
        const inProvince = results.filter(result => {
          const resultProvince = normalizePlace(result.admin1);
          return !targetProvince || !resultProvince || resultProvince === targetProvince;
        });
        const result = (inProvince.find(r => normalizePlace(r.name) === exactCity) || inProvince[0] || results[0]);
        if (!result) continue;

        return {
          provider: 'Open-Meteo Geocoding',
          officialName: result.name,
          latitude: result.latitude,
          longitude: result.longitude,
          country: result.country,
          province: result.admin1,
          timezone: result.timezone
        };
      } catch (error) {
        lastResponseError = error;
        // If one query variant fails, try the normalized city variant before
        // returning a provider-unavailable response to the checkout flow.
      } finally { clearTimeout(timer); }
    }

    if (lastResponseError) throw lastResponseError;
    return null;
  },
  async forecast(latitude, longitude) {
    const url = `${FORECAST_BASE_URL}?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}&current=temperature_2m,weather_code,wind_speed_10m&timezone=auto`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Forecast provider returned ${response.status}`);
      return await response.json();
    } finally { clearTimeout(timer); }
  }
};

// Canonical Data Model pattern: online location data is translated into our deliveryLocation shape.
function canonicalDeliveryLocation(geo) {
  return {
    officialName: geo.officialName,
    province: geo.province,
    country: geo.country,
    latitude: geo.latitude,
    longitude: geo.longitude,
    timezone: geo.timezone,
    source: geo.provider
  };
}

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'MotoParts API', requestId: req.requestId }));

// Local CRUD: list parts.
app.get('/api/parts', (req, res) => {
  let items = readParts();
  if (req.query.model) items = items.filter(p => compatibleWith(p, req.query.model));
  if (req.query.category) items = items.filter(p => normalizeModel(p.category) === normalizeModel(req.query.category));
  res.json({ items, count: items.length, requestId: req.requestId });
});

// Local CRUD: get one.
app.get('/api/parts/:id', (req, res) => {
  const part = readParts().find(x => x.id === Number(req.params.id));
  if (!part) return sendError(res, 404, 'Part not found');
  res.json({ ...part, requestId: req.requestId });
});

// Local CRUD: create.
app.post('/api/parts', (req, res) => {
  const validation = validatePart(req.body);
  if (validation) return sendError(res, 400, validation);
  const items = readParts();
  const part = {
    id: Math.max(0, ...items.map(x => Number(x.id) || 0)) + 1,
    name: String(req.body.name).trim(), model: String(req.body.model).trim(), category: String(req.body.category).trim(),
    price: Number(req.body.price), old: Number(req.body.old || 0), tag: req.body.tag || 'NEW',
    rating: String(req.body.rating || '0.0'), reviews: Number(req.body.reviews || 0),
    img: req.body.img || '/assets/product-placeholder.svg', desc: req.body.desc || 'Motorcycle part.',
    types: Array.isArray(req.body.types) ? req.body.types : ['Standard'], source: 'local'
  };
  items.push(part); writeParts(items);
  res.status(201).json(part);
});

// Local CRUD: update.
app.put('/api/parts/:id', (req, res) => {
  const validation = validatePart(req.body);
  if (validation) return sendError(res, 400, validation);
  const items = readParts();
  const index = items.findIndex(x => x.id === Number(req.params.id));
  if (index < 0) return sendError(res, 404, 'Part not found');
  items[index] = {
    ...items[index], name: String(req.body.name).trim(), model: String(req.body.model).trim(), category: String(req.body.category).trim(),
    price: Number(req.body.price), old: Number(req.body.old || items[index].old || 0), tag: req.body.tag || items[index].tag,
    rating: String(req.body.rating || items[index].rating), reviews: Number(req.body.reviews || items[index].reviews || 0),
    img: req.body.img || items[index].img, desc: req.body.desc || items[index].desc,
    types: Array.isArray(req.body.types) ? req.body.types : items[index].types
  };
  writeParts(items); res.json(items[index]);
});

// Local CRUD: delete.
app.delete('/api/parts/:id', (req, res) => {
  const items = readParts();
  const filtered = items.filter(x => x.id !== Number(req.params.id));
  if (filtered.length === items.length) return sendError(res, 404, 'Part not found');
  writeParts(filtered); res.json({ message: 'Part deleted', id: Number(req.params.id) });
});

// Online + local integration workflow: verify delivery location online, canonicalize it, then save the order locally.
app.post('/api/orders/checkout', async (req, res) => {
  const { customer, payment, items } = req.body || {};
  if (!customer?.name || !customer?.phone || !customer?.address || !customer?.barangay || !customer?.city || !customer?.province || !Array.isArray(items) || !items.length) {
    return sendError(res, 400, 'Complete customer, address, province, city, barangay, and cart information are required.');
  }
  if (!/^09\d{9}$/.test(String(customer.phone))) return sendError(res, 400, 'Enter a valid Philippine mobile number (09XXXXXXXXX).');
  if (String(customer.name).trim().length < 2 || String(customer.address).trim().length < 8) return sendError(res, 400, 'Please enter a valid customer name and complete delivery address.');
  const catalog = readParts();
  let calculatedTotal = 0;
  const normalizedItems = [];
  for (const item of items) {
    const part = catalog.find(p => Number(p.id) === Number(item.id));
    const qty = Number(item.qty);
    if (!part || !Number.isInteger(qty) || qty < 1 || qty > 99) return sendError(res, 400, 'Cart contains an invalid product or quantity.');
    calculatedTotal += Number(part.price) * qty;
    normalizedItems.push({ id: part.id, name: part.name, model: part.model, category: part.category, img: part.img || '/assets/product-placeholder.svg', price: Number(part.price), type: String(item.type || 'Standard'), motor: String(item.motor || part.model), qty });
  }
  try {
    const geo = await onlineAdapter.geocodeCity(customer.city, customer.province);
    if (!geo) return sendError(res, 404, 'Delivery city or municipality was not found online. Please check the address.');
    const orders = readOrders();
    const order = {
      id: crypto.randomUUID(), orderNo: `MP${Date.now().toString().slice(-8)}`,
      customer: { name: String(customer.name).trim(), email: String(customer.email || '').trim().toLowerCase(), phone: String(customer.phone).trim(), address: String(customer.address).trim(), province: String(customer.province).trim(), city: String(customer.city).trim(), barangay: String(customer.barangay).trim(), note: String(customer.note || '').trim() }, payment: payment || 'Cash on Delivery', items: normalizedItems, total: calculatedTotal,
      deliveryLocation: canonicalDeliveryLocation(geo), createdAt: new Date().toISOString(), status: 'PENDING', requestId: req.requestId
    };
    orders.push(order); writeOrders(orders);
    return res.status(201).json({ order, integration: { onlineVerified: true, source: 'Open-Meteo Geocoding', localSaved: true } });
  } catch (error) {
    console.error(req.requestId, error.message);
    return sendError(res, 503, 'Delivery verification service is temporarily unavailable. Your order was not saved. Please try again.');
  }
});

app.get('/api/orders', (req, res) => {
  let items = readOrders();
  const email = String(req.query.email || '').trim().toLowerCase();
  if (email) items = items.filter(o => String(o.customer?.email || '').toLowerCase() === email);
  res.json({ items, count: items.length, requestId: req.requestId });
});
app.get('/api/orders/:id', (req, res) => {
  const order = readOrders().find(o => o.id === req.params.id || o.orderNo === req.params.id);
  if (!order) return sendError(res, 404, 'Order not found');
  res.json(order);
});
app.patch('/api/orders/:id', (req, res) => {
  const orders = readOrders(); const i = orders.findIndex(o => o.id === req.params.id || o.orderNo === req.params.id);
  if (i < 0) return sendError(res, 404, 'Order not found');
  const allowed = ['PENDING', 'CONFIRMED', 'PACKED', 'SHIPPED', 'DELIVERED', 'CANCELLED'];
  if (!allowed.includes(req.body.status)) return sendError(res, 400, `Status must be one of: ${allowed.join(', ')}`);
  orders[i].status = req.body.status; orders[i].updatedAt = new Date().toISOString(); writeOrders(orders); res.json(orders[i]);
});
app.delete('/api/orders/:id', (req, res) => {
  const orders = readOrders(); const filtered = orders.filter(o => o.id !== req.params.id && o.orderNo !== req.params.id);
  if (filtered.length === orders.length) return sendError(res, 404, 'Order not found');
  writeOrders(filtered); res.json({ message: 'Order deleted' });
});

// Separate online API endpoint used for research/demo evidence.
app.get('/api/delivery/lookup', async (req, res) => {
  if (!req.query.city || !req.query.province) return sendError(res, 400, 'city and province query parameters are required.');
  try {
    const geo = await onlineAdapter.geocodeCity(req.query.city, req.query.province);
    if (!geo) return sendError(res, 404, 'Location not found.');
    res.json({ location: canonicalDeliveryLocation(geo), requestId: req.requestId });
  } catch (error) {
    return sendError(res, 503, 'Online location service unavailable.');
  }
});

app.get('/api/delivery/weather', async (req, res) => {
  const lat = Number(req.query.latitude), lon = Number(req.query.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return sendError(res, 400, 'Valid latitude and longitude are required.');
  try {
    const weather = await onlineAdapter.forecast(lat, lon);
    res.json({ provider: 'Open-Meteo Forecast', current: weather.current, timezone: weather.timezone, requestId: req.requestId });
  } catch (error) {
    return sendError(res, 503, 'Online weather service unavailable.');
  }
});

// Integration aggregation endpoint: local catalog + online delivery-service capability.
app.get('/api/catalog/integration-summary', async (req, res) => {
  const local = readParts();
  let onlineStatus = 'available';
  try { await onlineAdapter.geocodeCity('Manila', 'Metro Manila'); } catch (_) { onlineStatus = 'unavailable'; }
  res.json({ localCatalogCount: local.length, supportedModels: ['Mio Sporty', 'Honda Click', 'NMAX', 'Aerox', 'PCX'], onlineLocationProvider: 'Open-Meteo', onlineStatus, patterns: ['Adapter', 'Canonical Data Model', 'Content Enricher', 'API Gateway'], requestId: req.requestId });
});

app.use((req, res) => sendError(res, 404, 'Endpoint not found'));
app.use((err, req, res, next) => {
  console.error(req.requestId, err.message);
  res.status(500).json({ error: 'Unexpected server error', requestId: req.requestId });
});

ensureDataFiles();
app.listen(PORT, () => console.log(`MotoParts running at http://localhost:${PORT}`));
