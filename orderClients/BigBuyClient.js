// ============================================================
//  SyncFlow — orderClients/BigBuyClient.js
//  BigBuy REST API — order placement & tracking
//  Docs: https://api.bigbuy.eu/doc
// ============================================================
const axios = require('axios');

const BASE    = 'https://api.bigbuy.eu/rest';
const API_KEY = process.env.BIGBUY_API_KEY || '';

function headers() {
  return {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type':  'application/json',
  };
}

// ── PLACE ORDER ───────────────────────────────────────────────
// POST /order/create.json
async function placeOrder(order) {
  const payload = {
    order: {
      internalReference: order.odoo_sale_ref,
      language:          'en',
      paymentMethod:     'moneyTransfer',
      carriers: [{ name: 'CORREOS' }],   // BigBuy selects cheapest if not found
      shippingAddress: {
        firstName:   order.shipping_address?.name?.split(' ')[0] || 'Customer',
        lastName:    order.shipping_address?.name?.split(' ').slice(1).join(' ') || '-',
        country:     order.shipping_address?.country || 'PL',
        postcode:    order.shipping_address?.zip     || '',
        town:        order.shipping_address?.city    || '',
        address:     order.shipping_address?.street  || '',
        phone:       order.shipping_address?.phone   || '',
        email:       order.shipping_address?.email   || '',
        vatNumber:   order.vat_number || '',
      },
      products: order.lines.map(l => ({
        reference: l.sku,
        quantity:  l.quantity,
      })),
    },
  };

  const res = await axios.post(`${BASE}/order/create.json`, payload, {
    headers: headers(),
    timeout: 15000,
  });

  const data = res.data;
  return {
    supplierOrderRef: data.id ? String(data.id) : data.internalReference,
    supplierOrderId:  data.id ? String(data.id) : null,
    subtotal:         null,   // BigBuy doesn't return totals at creation
    shipping:         null,
    total:            null,
    raw:              data,
  };
}

// ── GET TRACKING ───────────────────────────────────────────────
// GET /order/{id}/tracking.json
async function getTracking(supplierOrderRef) {
  const res = await axios.get(
    `${BASE}/order/${supplierOrderRef}/tracking.json`,
    { headers: headers(), timeout: 10000 }
  );
  const data = res.data;

  const track = Array.isArray(data) ? data[0] : data;
  return {
    status:          mapBigBuyStatus(track?.status || track?.orderStatus),
    tracking_number: track?.trackingNumber || track?.code || null,
    tracking_url:    track?.trackingUrl    || null,
    carrier:         track?.carrier        || track?.shippingService || null,
    raw:             data,
  };
}

function mapBigBuyStatus(s) {
  if (!s) return 'placed';
  const v = String(s).toLowerCase();
  if (v.includes('ship') || v.includes('sent')) return 'shipped';
  if (v.includes('deliver') || v.includes('complete')) return 'delivered';
  if (v.includes('cancel')) return 'cancelled';
  if (v.includes('error') || v.includes('fail') || v.includes('problem')) return 'error';
  return 'placed';
}

module.exports = { placeOrder, getTracking };
