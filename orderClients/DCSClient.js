// ============================================================
//  SyncFlow — orderClients/DCSClient.js
//  DCS ApS XML API — order placement, reservation, tracking, item lookup
//  Docs: https://dcs.dk/xml/ (XML Delivery)
//
//  Endpoints (all flat-tag XML POST, Content-Type: text/xml):
//    Order (immediate):        https://dcs.dk/xml/xmlOrder/
//    Reserve order:             https://dcs.dk/xml/reserveOrder/
//    Track & Trace:              https://dcs.dk/xml/tt/
//    Item lookup (price/stock):  https://dcs.dk/xml/xmlVare/
//
//  IMPORTANT — this is a rewrite of an earlier draft that was written
//  before the full DCS PDF spec was available and got several things
//  wrong: it used a made-up <reference> tag instead of the required
//  <rekvisition>, wrapped delivery fields in a non-existent <delivery>
//  nested element (DCS uses flat top-level tags like <deliveryname>),
//  omitted the REQUIRED <deliverytype> field entirely, and pointed
//  tracking at the wrong URL (xmlTracktrace instead of the real /tt/).
// ============================================================
const axios = require('axios');

const ORDER_URL   = 'https://dcs.dk/xml/xmlOrder/';
const RESERVE_URL = 'https://dcs.dk/xml/reserveOrder/';
const TRACK_URL   = 'https://dcs.dk/xml/tt/';
const ITEM_URL    = 'https://dcs.dk/xml/xmlVare/';

const CUSTOMER_NR = process.env.DCS_CUSTOMER_NR || '';
const PASSWORD    = process.env.DCS_PASSWORD    || '';

// Not every delivery type is enabled on every DCS account — confirm
// with DCS/Rasmus which of these are actually active for lna_trade
// before relying on this default in production. PostDanmarkEx is a
// reasonable default for cross-border shipping (e.g. to Poland);
// PostDanmark is DK-domestic only.
const DEFAULT_DELIVERY_TYPE_DK    = 'PostDanmark';
const DEFAULT_DELIVERY_TYPE_OTHER = 'PostDanmarkEx';

// ── XML HELPERS ──────────────────────────────────────────────
function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function tag(name, value, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new Error(`DCSClient: required field <${name}> is missing`);
    return '';
  }
  return `<${name}>${escapeXml(value)}</${name}>`;
}

// DCS's responses are flat and small — a simple regex is enough,
// not worth pulling in a full XML parser for this.
function extractTag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
}

function extractAllTags(xml, name) {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1].trim());
  return out;
}

async function postXml(url, xml, timeoutMs = 30000) {
  const res = await axios.post(url, xml, {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
    timeout: timeoutMs,
    responseType: 'text',
  });
  return res.data;
}

// ── ITEM LOOKUP (xmlVare) — price + stock for one or more SKUs ──
// Used both standalone (pre-order price/stock check) and internally
// by placeOrder() to fetch DCS's current price before ordering, since
// DCS rejects an order line if your submitted price is lower than
// their current price (error 285).
async function getItemInfo(vareNrs) {
  const list = Array.isArray(vareNrs) ? vareNrs : [vareNrs];
  const itemsXml = list.map(v => `<item>${tag('vare_nr', v, true)}</item>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<pnarequest>
  ${tag('customer_nr', CUSTOMER_NR, true)}
  ${tag('password', PASSWORD, true)}
  ${itemsXml}
</pnarequest>`;

  const body = await postXml(ITEM_URL, xml);

  const errorText = extractTag(body, 'errorTekst');
  if (errorText) {
    const err = new Error(`DCS item lookup error (code ${extractTag(body, 'code')}): ${errorText}`);
    err.response = { data: body };
    throw err;
  }

  // Multiple <item> blocks in the response — split and parse each
  const itemBlocks = body.match(/<item>[\s\S]*?<\/item>/g) || [];
  return itemBlocks.map(block => ({
    vare_nr:  extractTag(block, 'vare_nr'),
    quantity: parseInt(extractTag(block, 'quantity'), 10) || 0,
    price:    parseFloat(extractTag(block, 'price')) || 0,
  }));
}

// ── PLACE ORDER (immediate, ships now) ───────────────────────
// order shape expected (matches what orderRouter.js builds):
//   odoo_sale_ref, lines: [{ sku, quantity, unit_price? }],
//   shipping_address: { name, street, street2?, zip, city, country,
//                        phone, email, attention? },
//   from_address?: { name, street, street2?, zip, city, country, attention?, email? }
async function placeOrder(order) {
  const addr = order.shipping_address || {};
  if (!addr.name || !addr.street || !addr.zip || !addr.city) {
    throw new Error('DCSClient.placeOrder: shipping_address must include name, street, zip, city');
  }

  const deliveryType = order.dcs_delivery_type
    || ((addr.country || '').toUpperCase() === 'DK' ? DEFAULT_DELIVERY_TYPE_DK : DEFAULT_DELIVERY_TYPE_OTHER);

  // DCS rejects a line if the submitted price is lower than their
  // current price — look up current prices first and use whichever is
  // higher (submitted cost estimate vs. DCS's live price) to avoid a
  // spurious rejection on a stale cached price.
  const skus = order.lines.map(l => l.sku);
  let liveInfo = [];
  try {
    liveInfo = await getItemInfo(skus);
  } catch (e) {
    console.warn(`[DCS] Could not pre-fetch live prices, falling back to submitted prices: ${e.message}`);
  }
  const liveByVareNr = Object.fromEntries(liveInfo.map(i => [i.vare_nr, i.price]));

  const itemsXml = order.lines.map(l => {
    const submitted = parseFloat(l.unit_price) || 0;
    const live      = liveByVareNr[l.sku] || 0;
    const price     = Math.max(submitted, live);
    return `<item>
      ${tag('vare_nr', l.sku, true)}
      ${tag('quantity', parseInt(l.quantity, 10), true)}
      ${tag('price', price.toFixed(2), true)}
    </item>`;
  }).join('');

  const from = order.from_address || {};

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<order>
  ${tag('customer_nr', CUSTOMER_NR, true)}
  ${tag('password', PASSWORD, true)}
  ${tag('rekvisition', order.odoo_sale_ref, true)}
  ${tag('ignoreRekvisitionCheck', 'true')}
  ${tag('comment', order.comment)}
  ${tag('deliverytype', deliveryType, true)}
  ${tag('glspakkeshopid', order.gls_pakkeshop_id)}
  ${tag('servicepointid', order.service_point_id)}
  ${tag('deliveryname', addr.name, true)}
  ${tag('deliveryaddress1', addr.street, true)}
  ${tag('deliveryaddress2', addr.street2)}
  ${tag('deliveryzip', addr.zip, true)}
  ${tag('deliverycity', addr.city, true)}
  ${tag('deliverycountry', addr.country)}
  ${tag('deliveryattention', addr.attention || addr.name)}
  ${tag('deliverymobile', addr.phone)}
  ${tag('deliveryphone', addr.phone)}
  ${tag('deliveryemail', addr.email)}
  ${tag('fromname', from.name)}
  ${tag('fromaddress1', from.street)}
  ${tag('fromaddress2', from.street2)}
  ${tag('fromzip', from.zip)}
  ${tag('fromcity', from.city)}
  ${tag('fromcountry', from.country)}
  ${tag('fromattention', from.attention)}
  ${tag('fromemail', from.email)}
  <orderlines>
    ${itemsXml}
  </orderlines>
</order>`;

  const body = await postXml(ORDER_URL, xml);

  const errorText = extractTag(body, 'errorTekst');
  const code      = extractTag(body, 'code');
  const orderNr   = extractTag(body, 'orderNumber');

  if (errorText && !orderNr) {
    const err = new Error(`DCS order error (code ${code}): ${errorText}`);
    err.response = { data: body };
    throw err;
  }

  const partDeliveryBlock = body.match(/<partDelivery>[\s\S]*?<\/partDelivery>/);
  const partDelivery = partDeliveryBlock ? {
    orderNumber:  extractTag(partDeliveryBlock[0], 'orderNumber'),
    freightCosts: parseFloat(extractTag(partDeliveryBlock[0], 'freightCosts')) || 0,
  } : null;

  const freightCost = parseFloat(extractTag(body, 'freightCost')) || 0;
  const subtotal = order.lines.reduce((sum, l) => {
    const submitted = parseFloat(l.unit_price) || 0;
    const live      = liveByVareNr[l.sku] || 0;
    return sum + Math.max(submitted, live) * (parseInt(l.quantity, 10) || 0);
  }, 0);

  return {
    supplierOrderRef: order.odoo_sale_ref,
    supplierOrderId:  orderNr,
    freightCost,
    subtotal:         parseFloat(subtotal.toFixed(2)),
    shipping:          freightCost,
    total:             parseFloat((subtotal + freightCost).toFixed(2)),
    partDelivery,
    raw: body,
  };
}

// ── RESERVE ORDER (batched — add throughout the day, invoiced together) ──
// Same item shape as placeOrder, but no delivery fields at all: DCS
// ships reserved items to your standard address on file and invoices
// your standard invoice address, so none of the address tags apply.
async function reserveOrder(order) {
  const skus = order.lines.map(l => l.sku);
  let liveInfo = [];
  try {
    liveInfo = await getItemInfo(skus);
  } catch (e) {
    console.warn(`[DCS] Could not pre-fetch live prices for reserve order, falling back to submitted prices: ${e.message}`);
  }
  const liveByVareNr = Object.fromEntries(liveInfo.map(i => [i.vare_nr, i.price]));

  const itemsXml = order.lines.map(l => {
    const submitted = parseFloat(l.unit_price) || 0;
    const live      = liveByVareNr[l.sku] || 0;
    const price     = Math.max(submitted, live);
    return `<item>
      ${tag('vare_nr', l.sku, true)}
      ${tag('quantity', parseInt(l.quantity, 10), true)}
      ${tag('price', price.toFixed(2), true)}
    </item>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<reserveinfo>
  ${tag('customer_nr', CUSTOMER_NR, true)}
  ${tag('password', PASSWORD, true)}
  ${tag('rekvisition', order.odoo_sale_ref, true)}
  ${tag('ignoreRekvisitionCheck', 'true')}
  ${tag('comment', order.comment)}
  <orderlines>
    ${itemsXml}
  </orderlines>
</reserveinfo>`;

  const body = await postXml(RESERVE_URL, xml);

  const errorText = extractTag(body, 'errorTekst');
  if (errorText) {
    const err = new Error(`DCS reserve order error (code ${extractTag(body, 'code')}): ${errorText}`);
    err.response = { data: body };
    throw err;
  }

  return {
    supplierOrderRef: order.odoo_sale_ref,
    message: extractTag(body, 'orderNumber'), // DCS returns a confirmation string here, not a real order number
    raw: body,
  };
}

// ── TRACK & TRACE ─────────────────────────────────────────────
// Accepts one or more DCS order numbers (the orderNumber returned by
// placeOrder, NOT your own odoo_sale_ref).
async function getBatchTracking(dcsOrderNumbers) {
  const list = Array.isArray(dcsOrderNumbers) ? dcsOrderNumbers : [dcsOrderNumbers];
  const itemsXml = list.map(n => `<item>${tag('ordernumber', n, true)}</item>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tracking>
  ${tag('customer_nr', CUSTOMER_NR, true)}
  ${tag('password', PASSWORD, true)}
  <ordernumbers>
    ${itemsXml}
  </ordernumbers>
</tracking>`;

  const body = await postXml(TRACK_URL, xml, 15000);

  const errorText = extractTag(body, 'errorTekst');
  if (errorText) {
    const err = new Error(`DCS tracking error (code ${extractTag(body, 'code')}): ${errorText}`);
    err.response = { data: body };
    throw err;
  }

  const orderInfoBlocks = body.match(/<orderInfo>[\s\S]*?<\/orderInfo>/g) || [];
  return orderInfoBlocks.map(block => ({
    orderNumber:     extractTag(block, 'orderNumber'),
    carrier:         extractTag(block, 'carrier'),
    trackingNumbers: extractAllTags(block, 'item'), // <trackingNumbers><item>...</item></trackingNumbers>
  }));
}

// Single-order convenience wrapper, matching the shape trackingPoller.js
// expects from client.getTracking(supplierOrderRef).
async function getTracking(dcsOrderNumber) {
  const [result] = await getBatchTracking([dcsOrderNumber]);
  if (!result) return { status: 'placed', tracking_number: null, tracking_url: null, carrier: null };

  return {
    status:          result.trackingNumbers?.length ? 'shipped' : 'placed',
    tracking_number: result.trackingNumbers?.[0] || null,
    tracking_numbers_all: result.trackingNumbers || [],
    tracking_url:    null, // DCS doesn't return a direct tracking URL, only carrier + numbers
    carrier:         result.carrier,
  };
}

module.exports = {
  placeOrder,
  reserveOrder,
  getTracking,
  getBatchTracking,
  getItemInfo,
};
