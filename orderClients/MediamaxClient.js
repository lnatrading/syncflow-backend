// ============================================================
//  SyncFlow — orderClients/MediamaxClient.js
//  Mediamax API v1.6.2 — order placement & tracking
//  Based on translated API docs (English PDF)
// ============================================================
const axios = require('axios');

const BASE  = 'https://api.mediamax.es/api';
const TOKEN = process.env.MEDIAMAX_TOKEN || '';

function headers() {
  return {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type':  'application/json',
  };
}

// ── PLACE ORDER ───────────────────────────────────────────────
// POST /order
async function placeOrder(order) {
  const payload = {
    b2b_reference: order.odoo_sale_ref,
    products: order.lines.map(l => ({
      sku:      l.sku,
      quantity: l.quantity,
    })),
    billing_address: {
      name:     order.billing_address?.name    || order.shipping_address?.name,
      address:  order.billing_address?.street  || order.shipping_address?.street,
      city:     order.billing_address?.city    || order.shipping_address?.city,
      postcode: order.billing_address?.zip     || order.shipping_address?.zip,
      country:  order.billing_address?.country || order.shipping_address?.country || 'PL',
      phone:    order.billing_address?.phone   || '',
      email:    order.billing_address?.email   || '',
    },
    shipping_address: {
      name:     order.shipping_address?.name    || order.billing_address?.name,
      address:  order.shipping_address?.street  || order.billing_address?.street,
      city:     order.shipping_address?.city    || order.billing_address?.city,
      postcode: order.shipping_address?.zip     || order.billing_address?.zip,
      country:  order.shipping_address?.country || order.billing_address?.country || 'PL',
      phone:    order.shipping_address?.phone   || '',
      email:    order.shipping_address?.email   || '',
    },
  };

  const res = await axios.post(`${BASE}/order`, payload, {
    headers: headers(),
    timeout: 15000,
  });

  const data = res.data;
  // Mediamax returns { code, message, status, data: { id, attributes: {...} } }
  const orderData = data.data || data;
  const attrs     = orderData.attributes || {};

  return {
    supplierOrderRef: attrs.b2b_reference || order.odoo_sale_ref,
    supplierOrderId:  String(orderData.id || ''),
    subtotal:         parseFloat(attrs.subtotal) || null,
    shipping:         parseFloat(attrs.shipping) || null,
    total:            parseFloat(attrs.total)    || null,
    raw:              data,
  };
}

// ── GET TRACKING ───────────────────────────────────────────────
// GET /order/reference/:reference
// GET /packing/show/order/odoo/:reference  ← preferred for tracking
async function getTracking(supplierOrderRef) {
  // First fetch order status
  const orderRes = await axios.get(
    `${BASE}/order/reference/${supplierOrderRef}`,
    { headers: headers(), timeout: 10000 }
  );
  const orderData = orderRes.data?.data || {};
  const attrs     = orderData.attributes || {};
  const mmStatus  = attrs.status;

  // Then fetch delivery notes for tracking number
  let trackingNumber = attrs.tracking_number || null;
  let trackingUrl    = null;
  let carrier        = attrs.transporter     || null;

  if (!trackingNumber) {
    try {
      const packRes = await axios.get(
        `${BASE}/packing/show/order/odoo/${supplierOrderRef}`,
        { headers: headers(), timeout: 10000 }
      );
      const packings = packRes.data?.data || [];
      const first    = Array.isArray(packings) ? packings[0] : packings;
      const pAttrs   = first?.attributes || {};
      trackingNumber = pAttrs.tracking     || null;
      trackingUrl    = pAttrs.tracking_url || null;
    } catch (_) { /* no packing yet — that's fine */ }
  }

  return {
    status:          mapMediamaxStatus(mmStatus),
    tracking_number: trackingNumber,
    tracking_url:    trackingUrl,
    carrier,
    raw:             orderData,
  };
}

function mapMediamaxStatus(s) {
  if (!s) return 'placed';
  const v = String(s).toLowerCase();
  if (v === 'done') return 'shipped';
  if (v === 'cancel') return 'cancelled';
  if (v === 'no_stock') return 'error';
  return 'placed';
}

module.exports = { placeOrder, getTracking };
