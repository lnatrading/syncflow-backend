// ============================================================
//  SyncFlow — orderClients/DCSClient.js
//  DCS ApS XML API — order placement & tracking
//  Docs: https://dcs.dk/xml/ (XML Delivery)
//  Endpoints:
//    Order:       POST https://dcs.dk/xml/xmlOrder/
//    Track&Trace: POST https://dcs.dk/xml/xmlTracktrace/
//    Item lookup: POST https://dcs.dk/xml/xmlVare/  (not used here)
// ============================================================
const axios = require('axios');

const ORDER_URL = 'https://dcs.dk/xml/xmlOrder/';
const TRACK_URL = 'https://dcs.dk/xml/xmlTracktrace/';

const CUSTOMER_NR = process.env.DCS_CUSTOMER_NR || '';
const PASSWORD    = process.env.DCS_PASSWORD    || '';

// ── BUILD XML ────────────────────────────────────────────────
// DCS expects raw XML POST, Content-Type: text/xml
function escapeXml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildOrderXml(order) {
  const shipping = order.shipping_address || order.billing_address || {};

  const itemsXml = order.lines.map(l => `
    <item>
      <vare_nr>${escapeXml(l.sku)}</vare_nr>
      <quantity>${parseInt(l.quantity, 10)}</quantity>
    </item>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<order>
  <customer_nr>${escapeXml(CUSTOMER_NR)}</customer_nr>
  <password>${escapeXml(PASSWORD)}</password>
  <reference>${escapeXml(order.odoo_sale_ref)}</reference>
  <delivery>
    <name>${escapeXml(shipping.name || shipping.company || 'LNA Trading')}</name>
    <att>${escapeXml(shipping.att || shipping.name || '')}</att>
    <address>${escapeXml(shipping.street || '')}</address>
    <address2>${escapeXml(shipping.street2 || '')}</address2>
    <zip>${escapeXml(shipping.zip || '')}</zip>
    <city>${escapeXml(shipping.city || '')}</city>
    <country>${escapeXml(shipping.country || 'PL')}</country>
    <phone>${escapeXml(shipping.phone || '')}</phone>
    <email>${escapeXml(shipping.email || '')}</email>
  </delivery>${itemsXml}
</order>`;
}

function buildTrackXml(orderNr) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<tracktrace>
  <customer_nr>${escapeXml(CUSTOMER_NR)}</customer_nr>
  <password>${escapeXml(PASSWORD)}</password>
  <order_nr>${escapeXml(orderNr)}</order_nr>
</tracktrace>`;
}

// ── PARSE XML RESPONSE ───────────────────────────────────────
// DCS returns simple XML — parse with regex rather than pulling
// in a full XML parser just for flat responses.
function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const m  = xml.match(re);
  return m ? m[1].trim() : null;
}

// ── PLACE ORDER ──────────────────────────────────────────────
async function placeOrder(order) {
  const xml = buildOrderXml(order);

  const res = await axios.post(ORDER_URL, xml, {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
    timeout: 30000,
    // DCS returns XML, not JSON
    responseType: 'text',
  });

  const body      = res.data;
  const orderNr   = extractTag(body, 'order_nr');
  const errorText = extractTag(body, 'errorTekst');
  const code      = extractTag(body, 'code');

  // DCS returns errorTekst + code on failure
  if (errorText && !orderNr) {
    const err = new Error(`DCS order error (code ${code}): ${errorText}`);
    err.response = { data: body };
    throw err;
  }

  return {
    supplierOrderRef: order.odoo_sale_ref,
    supplierOrderId:  orderNr || '',
    subtotal:         null,  // DCS doesn't return pricing in order response
    shipping:         null,
    total:            null,
    raw:              body,
  };
}

// ── GET TRACKING (single order) ──────────────────────────────
async function getTracking(supplierOrderRef) {
  // DCS Track&Trace uses order_nr (their internal number), but
  // we store our odoo_sale_ref as supplierOrderRef — and the DCS
  // order_nr as supplierOrderId.  The trackingPoller passes
  // supplier_order_ref, so we need the DCS order number.
  // If supplierOrderRef is our ref, we'd need the DCS order_nr
  // from the DB.  For now, try it directly — DCS may accept
  // either their order_nr or the reference field.
  const xml = buildTrackXml(supplierOrderRef);

  const res = await axios.post(TRACK_URL, xml, {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
    timeout: 15000,
    responseType: 'text',
  });

  const body       = res.data;
  const status     = extractTag(body, 'status');
  const trackingNr = extractTag(body, 'tracking_nr') || extractTag(body, 'trackingnr');
  const trackUrl   = extractTag(body, 'tracking_url') || extractTag(body, 'trackingurl');
  const carrier    = extractTag(body, 'carrier') || extractTag(body, 'fragtmand');

  return {
    status:          mapDcsStatus(status),
    tracking_number: trackingNr,
    tracking_url:    trackUrl,
    carrier,
    raw:             body,
  };
}

// Map DCS order statuses → SyncFlow normalised statuses
function mapDcsStatus(s) {
  if (!s) return 'placed';
  const v = String(s).toLowerCase();
  if (v.includes('ship') || v.includes('sent') || v.includes('afsendt'))  return 'shipped';
  if (v.includes('cancel') || v.includes('annuller'))                     return 'cancelled';
  if (v.includes('error') || v.includes('fejl'))                          return 'error';
  if (v.includes('deliver') || v.includes('leveret'))                     return 'delivered';
  if (v.includes('process') || v.includes('behandl'))                     return 'processing';
  return 'placed';
}

module.exports = { placeOrder, getTracking };
