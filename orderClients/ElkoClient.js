// ============================================================
//  SyncFlow — orderClients/ElkoClient.js
//  Places orders and fetches tracking via Elko Cloud API v3
// ============================================================
const axios = require('axios');

const BASE = 'https://api.elko.cloud/v3.0/api';
const AUTH = {
  username: 'ahmed.bayoumi',
  password: 'ME04me09me1984*'
};

// ── PLACE ORDER ───────────────────────────────────────────────
// Elko order payload: POST /Order
// Lines: [{ elkoCode, quantity }]
// Returns: { supplierOrderRef, supplierId, raw }
async function placeOrder(order) {
  const lines = order.lines.map(l => ({
    elkoCode:  l.sku,
    quantity:  l.quantity,
    unitPrice: l.unit_price,
  }));

  const payload = {
    customerOrderReference: order.odoo_sale_ref,
    deliveryAddress: {
      name:       order.shipping_address?.name    || order.billing_address?.name,
      street:     order.shipping_address?.street  || order.billing_address?.street,
      city:       order.shipping_address?.city    || order.billing_address?.city,
      postalCode: order.shipping_address?.zip     || order.billing_address?.zip,
      countryCode:order.shipping_address?.country || order.billing_address?.country || 'PL',
    },
    lines,
  };

  const res = await axios.post(`${BASE}/Order`, payload, {
    auth: AUTH,
    timeout: 15000,
  });

  const data = res.data;
  return {
    supplierOrderRef: data.orderNumber || data.orderId || String(data.id),
    supplierOrderId:  String(data.id || data.orderNumber),
    subtotal:         data.totalNet   || null,
    shipping:         data.freight    || 0,
    total:            data.totalGross || null,
    raw:              data,
  };
}

// ── GET ORDER STATUS / TRACKING ───────────────────────────────
// GET /Order/:orderNumber
async function getTracking(supplierOrderRef) {
  const res = await axios.get(`${BASE}/Order/${supplierOrderRef}`, {
    auth: AUTH,
    timeout: 10000,
  });
  const data = res.data;

  // Elko returns shipments array; grab first tracking number
  const shipment = data.shipments?.[0] || data.shipment || {};
  return {
    status:          mapElkoStatus(data.status),
    tracking_number: shipment.trackingNumber || shipment.trackNo || null,
    tracking_url:    shipment.trackingUrl    || null,
    carrier:         shipment.carrier        || shipment.transporterName || null,
    raw:             data,
  };
}

function mapElkoStatus(s) {
  if (!s) return 'placed';
  const v = String(s).toLowerCase();
  if (v.includes('ship') || v.includes('sent') || v.includes('dispatch')) return 'shipped';
  if (v.includes('deliver') || v.includes('complete')) return 'delivered';
  if (v.includes('cancel')) return 'cancelled';
  if (v.includes('error') || v.includes('fail')) return 'error';
  return 'placed';
}

module.exports = { placeOrder, getTracking };
