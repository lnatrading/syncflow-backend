// ============================================================
//  SyncFlow — routes/orders.js
//  Handles:
//    • GET  /api/orders                — list supplier orders
//    • GET  /api/orders/:id            — order detail
//    • POST /api/orders/retry/:id      — retry failed placement
//    • POST /api/orders/webhook        — Odoo calls this when sale confirmed
//    • POST /api/orders/manual         — manually submit an order for routing
// ============================================================
const express       = require('express');
const router        = express.Router();
const { routeAndPlace } = require('../orderRouter');
const { pollTracking }  = require('../trackingPoller');

// ── LIST SUPPLIER ORDERS ──────────────────────────────────────
router.get('/', async (req, res) => {
  const page   = parseInt(req.query.page  || 1);
  const limit  = parseInt(req.query.limit || 50);
  const status = req.query.status || '';
  const search = req.query.search || '';

  let q = req.sb
    .from('supplier_orders')
    .select(`
      *,
      suppliers(name),
      supplier_order_lines(*)
    `, { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (status) q = q.eq('status', status);
  if (search) q = q.or(`odoo_sale_ref.ilike.%${search}%,supplier_order_ref.ilike.%${search}%`);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page, limit });
});

// ── ORDER DETAIL ──────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const { data, error } = await req.sb
    .from('supplier_orders')
    .select('*, suppliers(name), supplier_order_lines(*)')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// ── ODOO WEBHOOK RECEIVER ─────────────────────────────────────
// Odoo Automation Rule calls: POST /api/orders/webhook
// with the sale order payload in body.
//
// Expected body (Odoo sends this via "Call a URL" action):
// {
//   "id":            1234,
//   "name":          "S00042",
//   "partner_id":    [45, "Customer Name"],
//   "order_line":    [
//     { "product_id": [99, "SKU123 - Product Name"], "product_uom_qty": 2, "price_unit": 10.0 }
//   ],
//   "partner_shipping_id": { "name":..., "street":..., "city":..., "zip":..., "country_id":[1,"Poland"] }
// }
router.post('/webhook', async (req, res) => {
  const body = req.body;

  // Accept both direct Odoo format and a wrapped { order: {...} }
  const raw     = body?.order || body;

  // ── PAYLOAD VALIDATION ────────────────────────────────────
  // Guard against null/malformed payloads before any DB work.
  // Odoo occasionally sends empty pings or partial payloads.
  if (!raw || typeof raw !== 'object') {
    return res.status(400).json({ error: 'Empty or non-object payload' });
  }

  const saleRef = raw.name || raw.sale_ref || raw.reference;
  if (!saleRef || typeof saleRef !== 'string' || saleRef.trim() === '') {
    return res.status(400).json({ error: 'Missing or invalid order name/reference in payload' });
  }

  // Must have at least one order line, or an id
  const hasLines = Array.isArray(raw.order_line) && raw.order_line.length > 0;
  const hasId    = raw.id != null;
  if (!hasLines && !hasId) {
    return res.status(400).json({
      error: `Payload for ${saleRef} has no order lines and no Odoo ID — cannot route`
    });
  }

  // Deduplicate — don't process the same order twice
  const { data: existing } = await req.sb
    .from('odoo_incoming_orders')
    .select('id, status')
    .eq('odoo_sale_ref', saleRef)
    .single()
    .then(r => r.data)
    .catch(() => null);

  if (existing && ['routed','routing'].includes(existing.status)) {
    return res.json({ message: `Order ${saleRef} already processed`, status: existing.status });
  }

  // Store raw payload
  await req.sb.from('odoo_incoming_orders').upsert({
    odoo_sale_ref: saleRef,
    odoo_sale_id:  raw.id || null,
    raw_payload:   raw,
    status:        'received',
    received_at:   new Date(),
  }, { onConflict: 'odoo_sale_ref' });

  console.log(`[WEBHOOK] Received Odoo order: ${saleRef}`);

  // Parse into our normalised shape
  const odooOrder = parseOdooPayload(saleRef, raw);

  // Fire and forget — respond immediately so Odoo doesn't time out
  res.json({ message: `Order ${saleRef} received, routing in progress` });

  // Route asynchronously
  routeAndPlace(req.sb, odooOrder).catch(err => {
    console.error(`[WEBHOOK] Routing failed for ${saleRef}:`, err.message);
    req.sb.from('odoo_incoming_orders').update({
      status: 'error', routing_error: err.message, processed_at: new Date()
    }).eq('odoo_sale_ref', saleRef);
  });
});

// ── MANUAL ORDER SUBMISSION ───────────────────────────────────
// For testing or manual override — submit an order directly from SyncFlow UI
router.post('/manual', async (req, res) => {
  const odooOrder = req.body;
  if (!odooOrder.odoo_sale_ref || !odooOrder.lines?.length) {
    return res.status(400).json({ error: 'odoo_sale_ref and lines[] required' });
  }

  await req.sb.from('odoo_incoming_orders').upsert({
    odoo_sale_ref: odooOrder.odoo_sale_ref,
    raw_payload:   odooOrder,
    status:        'received',
    received_at:   new Date(),
  }, { onConflict: 'odoo_sale_ref' });

  try {
    const result = await routeAndPlace(req.sb, odooOrder);
    res.json({ message: 'Order routed', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── RETRY FAILED ORDER ────────────────────────────────────────
router.post('/retry/:id', async (req, res) => {
  const { data: order } = await req.sb
    .from('supplier_orders')
    .select('*, suppliers(name), supplier_order_lines(*)')
    .eq('id', req.params.id).single();

  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'error') return res.status(400).json({ error: 'Only error orders can be retried' });

  // Reset to pending and re-route
  await req.sb.from('supplier_orders').update({ status: 'placing', last_error: null }).eq('id', order.id);

  const odooOrder = {
    odoo_sale_ref: order.odoo_sale_ref,
    lines: (order.supplier_order_lines || []).map(l => ({
      sku: l.sku, product_name: l.product_name, quantity: l.quantity, unit_price: l.unit_price
    })),
  };

  try {
    const result = await routeAndPlace(req.sb, odooOrder);
    res.json({ message: 'Retry completed', result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── TRIGGER TRACKING POLL ─────────────────────────────────────
router.post('/poll-tracking', async (req, res) => {
  res.json({ message: 'Tracking poll started' });
  pollTracking(req.sb).catch(console.error);
});

// ── INCOMING ORDERS LOG ───────────────────────────────────────
router.get('/incoming/log', async (req, res) => {
  const { data, error } = await req.sb
    .from('odoo_incoming_orders')
    .select('*')
    .order('received_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── HELPERS ───────────────────────────────────────────────────
function parseOdooPayload(saleRef, raw) {
  // Parse Odoo order lines — handle both RPC format and simple format
  const lines = (raw.order_line || raw.lines || []).map(l => {
    // Odoo RPC format: { product_id: [id, "SKU - Name"], product_uom_qty: 2, price_unit: 10 }
    const productField = l.product_id || l.product || {};
    const productStr   = Array.isArray(productField) ? productField[1] : String(productField);
    // SKU is often the part before " - " in the product name
    const sku = l.sku || l.default_code || (productStr.includes(' - ') ? productStr.split(' - ')[0].trim() : productStr);
    return {
      sku:          sku,
      product_name: l.name || l.product_name || productStr,
      quantity:     parseInt(l.product_uom_qty || l.quantity || l.qty || 1),
      unit_price:   parseFloat(l.price_unit || l.unit_price || 0) || null,
    };
  }).filter(l => l.sku && l.quantity > 0);

  // Parse addresses
  const ship = raw.partner_shipping_id || raw.shipping_address || {};
  const bill = raw.partner_invoice_id  || raw.billing_address  || raw.partner_id || {};

  function parseAddress(addr) {
    if (!addr || typeof addr !== 'object') return {};
    return {
      name:    addr.name    || (Array.isArray(addr) ? addr[1] : ''),
      street:  addr.street  || addr.street1 || '',
      city:    addr.city    || '',
      zip:     addr.zip     || addr.postcode || '',
      country: addr.country_code || (Array.isArray(addr.country_id) ? null : addr.country_id) || 'PL',
      phone:   addr.phone   || addr.mobile || '',
      email:   addr.email   || '',
    };
  }

  return {
    odoo_sale_ref:    saleRef,
    odoo_sale_id:     raw.id || null,
    lines,
    shipping_address: parseAddress(ship),
    billing_address:  parseAddress(bill),
  };
}

module.exports = router;
