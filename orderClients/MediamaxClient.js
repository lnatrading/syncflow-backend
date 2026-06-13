// ============================================================
//  SyncFlow — orderClients/MediamaxClient.js
//  Mediamax API v1.6.2 — order placement & tracking
// ============================================================
const axios = require('axios');

const BASE  = 'https://api.mediamax.es/api';
const TOKEN = process.env.MEDIAMAX_TOKEN || '';

// NOTE: Mediamax requires the billing email to match the API account email.
// Set MEDIAMAX_ACCOUNT_EMAIL in your environment variables.
const ACCOUNT_EMAIL = process.env.MEDIAMAX_ACCOUNT_EMAIL || '';

function headers() {
  return {
    // Mediamax authenticates via the HTTP-API-KEY header with the raw token
    // (NOT Authorization: Bearer, despite what the PDF docs state — confirmed
    // by Mediamax IT).
    'HTTP-API-KEY':  TOKEN,
    'Content-Type':  'application/json',
  };
}

// Helper: split a full name into first name + lastname
function splitName(fullName) {
  const parts = (fullName || '').trim().split(' ');
  const name     = parts[0] || 'LNA';
  const lastname = parts.slice(1).join(' ') || 'Trading';
  return { name, lastname };
}

// ── PLACE ORDER ───────────────────────────────────────────────
// POST /order
// Mediamax API requires exact field names as per docs v1.6.2:
//   order_billing_address, order_shipping_address, order_lines, b2b_reference
async function placeOrder(order) {
  const billing  = order.billing_address  || order.shipping_address || {};
  const shipping = order.shipping_address || order.billing_address  || {};

  const billName = splitName(billing.name);
  const shipName = splitName(shipping.name);

  const payload = {
    b2b_reference: order.odoo_sale_ref,

    order_billing_address: {
      name:     billName.name,
      lastname: billName.lastname,
      company:  billing.company  || '',
      email:    ACCOUNT_EMAIL,           // Must match API account email
      phone:    billing.phone    || shipping.phone || '',
      mobile:   billing.mobile   || '',
      street:   billing.street   || '',
      postcode: billing.zip      || '',
      city:     billing.city     || '',
      region_id: billing.region_id || '',
      country:  billing.country  || 'PL',
    },

    order_shipping_address: {
      name:     shipName.name,
      lastname: shipName.lastname,
      company:  shipping.company  || '',
      email:    ACCOUNT_EMAIL,           // Must match API account email
      phone:    shipping.phone    || billing.phone || '',
      mobile:   shipping.mobile   || '',
      street:   shipping.street   || '',
      postcode: shipping.zip      || '',
      city:     shipping.city     || '',
      region_id: shipping.region_id || '',
      country:  shipping.country  || 'PL',
      express:  shipping.express  || false,
    },

    order_lines: order.lines.map(l => ({
      sku:      l.sku,
      quantity: l.quantity,
    })),
  };

  const res = await axios.post(`${BASE}/order`, payload, {
    headers: headers(),
    timeout: 15000,
  });

  // Mediamax returns { code, message, status, data: { id, attributes: {...} } }
  const data      = res.data;
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

// ── GET TRACKING (single order) ────────────────────────────────
// 1. GET /order/reference/:reference  → order status + tracking_number if shipped
// 2. GET /packing/show/order/odoo/:reference → delivery notes with tracking URL
async function getTracking(supplierOrderRef) {
  // 1. Fetch order status
  const orderRes = await axios.get(
    `${BASE}/order/reference/${supplierOrderRef}`,
    { headers: headers(), timeout: 10000 }
  );
  const orderData = orderRes.data?.data || {};
  const attrs     = orderData.attributes || {};
  const mmStatus  = attrs.status;

  let trackingNumber = attrs.tracking_number || null;
  let trackingUrl    = null;
  let carrier        = attrs.transporter     || null;

  // 2. If no tracking yet, try delivery notes endpoint
  if (!trackingNumber) {
    try {
      const packRes = await axios.get(
        `${BASE}/packing/show/order/odoo/${supplierOrderRef}`,
        { headers: headers(), timeout: 10000 }
      );
      // Response: { data: [[{id, attributes:{tracking, tracking_url, ...}}]] }
      const outer   = packRes.data?.data || [];
      const inner   = Array.isArray(outer[0]) ? outer[0] : outer;
      const first   = Array.isArray(inner) ? inner[0] : inner;
      const pAttrs  = first?.attributes || {};
      trackingNumber = pAttrs.tracking     || null;
      trackingUrl    = pAttrs.tracking_url || null;
    } catch (_) { /* no delivery note yet — that's fine */ }
  }

  return {
    status:          mapMediamaxStatus(mmStatus),
    tracking_number: trackingNumber,
    tracking_url:    trackingUrl,
    carrier,
    raw:             orderData,
  };
}

// Map Mediamax order statuses → SyncFlow normalised statuses
// Possible values: null, "sale_order" (not yet imported), "no_stock", "cancel", "done"
function mapMediamaxStatus(s) {
  if (!s) return 'placed';
  const v = String(s).toLowerCase();
  if (v === 'done')       return 'shipped';
  if (v === 'cancel')     return 'cancelled';
  if (v === 'no_stock')   return 'error';
  if (v === 'sale_order') return 'placed';
  return 'placed';
}

// ── GET TRACKING (batch — up to 50 orders) ────────────────────
// GET /batch/reference  (per Spanish docs v1.6.2 §2.2.3)
// Body: JSON array of b2b_reference strings
// Returns same order structure as single order query.
// Used by trackingPoller to check multiple Mediamax orders in one call
// instead of one API call per order.
async function getBatchTracking(supplierOrderRefs) {
  if (!supplierOrderRefs?.length) return [];

  // Mediamax caps batch at 50 per page — chunk if needed
  const results = [];
  const BATCH   = 50;

  for (let i = 0; i < supplierOrderRefs.length; i += BATCH) {
    const chunk = supplierOrderRefs.slice(i, i + BATCH);

    const res = await axios.get(`${BASE}/batch/reference`, {
      headers: { ...headers(), 'Content-Type': 'application/json' },
      data:    JSON.stringify(chunk),   // axios GET with body
      timeout: 15000,
    });

    const items = res.data?.data || [];
    for (const item of Array.isArray(items) ? items : []) {
      const attrs    = item.attributes || {};
      const mmStatus = attrs.status;

      results.push({
        supplierOrderRef: attrs.b2b_reference,
        status:           mapMediamaxStatus(mmStatus),
        tracking_number:  attrs.tracking_number || null,
        carrier:          attrs.transporter     || null,
        tracking_url:     null,   // batch endpoint doesn't return tracking URL
        raw:              item,
      });
    }
  }

  return results;
}

module.exports = { placeOrder, getTracking, getBatchTracking };
