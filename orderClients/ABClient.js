// ============================================================
//  SyncFlow — orderClients/ABClient.js
//  AB S.A. (AB.pl) XML Gateway — order placement, address caching,
//  tracking/status lookup.
//  Docs source: AB Online → Administration → XML Gateway (dealer portal).
//
//  ⚠ VERIFY BEFORE PRODUCTION — root shape and error format ARE now
//  confirmed via Postman (Aug 2026): every response is
//    <gateway><timestamp>...</timestamp><...request-specific data...></gateway>
//  errors are <gateway><error><code>N</code><message>text</message></error></gateway>.
//  STILL UNCONFIRMED: the request-specific wrapper tag names for
//  products_all/product/stocks/regaddr/checkticket/orders (only pterms
//  has been checked so far — see AB_PL_SETUP.md for the checklist of
//  remaining calls to run). Places still relying on the generic
//  tree-search fallback rather than a confirmed exact path are marked
//  "VERIFY:" below — tighten each one as you check it in Postman.
// ============================================================
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { XMLParser } = require('fast-xml-parser');
const { withRetry } = require('../retry');

// Optional forward proxy for AB.pl calls specifically — set AB_PROXY_URL
// to route around Railway's rotating outbound IP (e.g.
// https://user:pass@your-vm-ip:8888). Uses a proper HTTPS CONNECT
// tunnel via https-proxy-agent, so the proxy only relays encrypted
// bytes — it never sees the actual request body (credentials, order
// contents, etc.), same principle as a commercial static-IP proxy
// service. Leave AB_PROXY_URL unset to call AB.pl directly (Railway's
// own IP, whatever it is at the time).
const AB_PROXY_URL = process.env.AB_PROXY_URL || null;
const abProxyAgent = AB_PROXY_URL ? new HttpsProxyAgent(AB_PROXY_URL) : null;

const GATEWAY_URL = process.env.AB_GATEWAY_URL || 'https://xml.ab.pl/gateway.php';

// AB requires the customer code zero-padded — store it in env exactly as
// AB Online displays it; do not strip leading zeros.
const CLIENT_CODE = process.env.AB_CLIENT_CODE || '';
const LOGIN       = process.env.AB_LOGIN       || '';
const PASSWORD    = process.env.AB_PASSWORD    || '';

// Set to '1' to keep every order visible-but-not-processed in AB Online
// while this integration is being verified. Flip to unset/'0' only once
// placeOrder()'s response parsing has been confirmed against real XML.
const FORCE_TEST_ORDERS = process.env.AB_FORCE_TEST_ORDERS === '1';

// ── FULL ERROR CODE TABLE (from AB's XML Gateway docs) ─────────
const ERROR_CODES = {
  1:  'Service temporarily unavailable (nightly data-replication window)',
  2:  'Missing auth data',
  3:  'Access denied (bad password / no price authority / service not activated)',
  4:  'Required request param missing',
  5:  'Bad request (unknown req value)',
  6:  'Required request param missing',
  7:  'Bad request param',
  8:  'Excessive usage (rate limit) — confirmed in production: this is a BANDWIDTH limit specifically; caching (use_cache/cache_refresh) is the actual mitigation, not just call frequency',
  9:  'Account locked',
  10: 'Unknown error',
  11: 'Order item price mismatch',
  12: 'Bad payment_term',
  13: 'Order is empty',
  14: 'Order item qty <= 0',
  15: 'Order item qty exceeds available stock',
  16: 'No order-placement privilege on this login',
  17: 'Order not found',
  18: 'Order not ready (still processing)',
  19: "Order can't be modified (wrong status)",
  20: 'Invalid/unknown zipcode',
  21: 'No such ticket_id',
  22: 'Cache-only request had no cached response',
  44: 'Duplicate own_number (unichk=1)',
  // Confirmed via Postman (Aug 2026) — not in the originally documented
  // table: address creation still in progress (checkticket, expected
  // while the ticket is unresolved — see RETRYABLE_CODES).
  60: 'Address creation is in progress',
  // Confirmed via Postman (Aug 2026) — not in the originally documented
  // table: IP not on the account's XML Gateway allowlist.
  59: 'IP without login permission (IP not added under AB Online → Administration → XML Gateway IPs)',
};

// Codes that mean "try again later, this is expected" — not a bug in our
// request. Safeguard #7 (error 1 nightly window) and #8-adjacent (rate
// limiting) both fall here.
const RETRYABLE_CODES = new Set([1, 8, 60]);

// ============================================================
//  LOW-LEVEL REQUEST HELPERS
// ============================================================

// Builds an application/x-www-form-urlencoded body. AB's gateway is a
// classic PHP endpoint — POST arrays (e.g. `contents`) are sent as the
// same key repeated with a `[]` suffix, which is what PHP's $_POST
// array parsing expects.
function buildFormBody(params) {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) usp.append(`${key}[]`, String(v));
    } else {
      usp.append(key, String(value));
    }
  }
  return usp;
}

// CONFIRMED (Postman, Aug 2026): AB's actual error shape is
//   <gateway><error><code>2</code><message>missing authentication data [c=0;l=10]</message></error></gateway>
// i.e. root <gateway>, error nested one level under <error>, both
// <code> and <message> as child elements (not attributes). Checked
// directly first; the old speculative fallbacks are kept underneath
// in case a different req= call ever returns a different shape.
function extractAbError(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  const direct = parsed.gateway?.error;
  if (direct && (direct.code !== undefined)) {
    const code = parseInt(typeof direct.code === 'object' ? direct.code['#text'] : direct.code, 10);
    if (code) {
      const message = direct.message || ERROR_CODES[code] || 'Unknown AB.pl error';
      return { code, message: String(message) };
    }
  }

  // Fallback for any req= call that doesn't match the confirmed shape above.
  const candidates = [parsed, ...Object.values(parsed).filter(v => v && typeof v === 'object')];
  for (const node of candidates) {
    if (!node || typeof node !== 'object') continue;
    const rawCode = node.error ?? node.code ?? node['@_error'] ?? node['@_code'];
    if (rawCode === undefined || rawCode === null || rawCode === '') continue;
    const code = parseInt(typeof rawCode === 'object' ? (rawCode['#text'] ?? rawCode.code) : rawCode, 10);
    if (!code || Number.isNaN(code)) continue;
    const message = node.message || node.errorTekst || node.msg || ERROR_CODES[code] || 'Unknown AB.pl error';
    return { code, message: String(message) };
  }
  return null;
}

async function postAb(reqName, extraParams = {}, { timeoutMs = 30000, label } = {}) {
  const body = buildFormBody({
    req:    reqName,
    client: CLIENT_CODE,
    login:  LOGIN,
    pass:   PASSWORD,
    // CONFIRMED (production, Aug 2026): sending cache_refresh=1 on every
    // call was wrong — real error hit on the sync side: "error 8,
    // excessive BANDWIDTH usage, cache the damn thing yourself". Unlike
    // the bulk products_all feed (see syncEngine.js's xml_post_abpl
    // branch, which now defaults to use_cache=2), these order-side calls
    // are small single-item lookups where freshness genuinely matters
    // (a stale cached price during the safeguard #3 price-mismatch retry
    // would defeat its whole purpose) — so keep use_cache=1 (cache only
    // as an error-8 fallback, not proactively) but stop forcing a refresh
    // on every call.
    use_cache:     extraParams.use_cache     ?? 1,
    cache_refresh: extraParams.cache_refresh ?? 0,
    ...extraParams,
  });

  const doPost = async () => {
    const res = await axios.post(GATEWAY_URL, body, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: timeoutMs,
      responseType: 'text',
      ...(abProxyAgent ? { httpsAgent: abProxyAgent, proxy: false } : {}),
    });
    return res.data;
  };

  const raw = await withRetry(doPost, {
    maxAttempts: 3,
    baseDelayMs: 5000,
    multiplier:  3,
    label: label || `AB ${reqName}`,
    onRetry: async (attempt, err) => {
      // Auth failures (error 2/3/9) will never succeed on retry.
      const parsed = tryParseAbXml(err?.response?.data);
      const abErr  = parsed && extractAbError(parsed);
      if (abErr && [2, 3, 9, 16].includes(abErr.code)) {
        throw Object.assign(err, { noRetry: true, abErrorCode: abErr.code });
      }
    },
  });

  const parsed = tryParseAbXml(raw);
  const abErr  = parsed && extractAbError(parsed);
  if (abErr) {
    const err = new Error(`AB.pl ${reqName} error ${abErr.code}: ${abErr.message}`);
    err.abErrorCode = abErr.code;
    err.retryable    = RETRYABLE_CODES.has(abErr.code);
    // Safeguard #7: error 1 (nightly unavailability) is expected/routine,
    // not an alert-worthy failure — callers check err.expected before
    // logging at a "warning" vs "info" level.
    err.expected     = abErr.code === 1;
    err.raw          = raw;
    throw err;
  }

  return { parsed, raw };
}

function tryParseAbXml(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    return parser.parse(raw);
  } catch {
    return null;
  }
}

// Restricted own_number charset per AB's docs: invalid characters must
// be replaced with spaces, not stripped or escaped.
function sanitiseOwnNumber(str) {
  return String(str || '').replace(/[^A-Za-z0-9\-_ ]/g, ' ').trim().slice(0, 40);
}

// ============================================================
//  PRODUCT LOOKUP (req=stocks) — used for safeguard #3
//  (re-fetch live price on an error-11 price mismatch)
// ============================================================
async function getLiveStockAndPrice(abpns) {
  const list = Array.isArray(abpns) ? abpns : [abpns];
  const { parsed } = await postAb('stocks', { pid: list.join(';'), ignore_missing: 1 }, { label: 'AB stocks lookup' });

  // VERIFY: root element / array wrapper for req=stocks response.
  const items = findProductArray(parsed);
  return items.map(i => ({
    abpn:  i.abpn ?? i['@_abpn'],
    price: parseFloat(i.price ?? i['@_price']) || null,
    instock: parseInstock(i.instock),
  }));
}

// Best-effort: search a parsed XML tree for the first array of
// product-like objects (has an abpn/id field). Handles the case where
// AB nests results under different wrapper tags than assumed.
function findProductArray(parsed, depth = 0) {
  if (!parsed || typeof parsed !== 'object' || depth > 4) return [];
  for (const val of Object.values(parsed)) {
    if (Array.isArray(val)) {
      if (val.some(v => v && typeof v === 'object' && ('abpn' in v || 'id' in v))) return val;
    } else if (val && typeof val === 'object') {
      const found = findProductArray(val, depth + 1);
      if (found.length) return found;
    }
  }
  return [];
}

// instock may come back as a bare number or a per-site breakdown object
// (per the docs' "instock-specific per site/division" note). Sum
// whatever numeric leaves are present.
function parseInstock(instock) {
  if (instock == null) return 0;
  if (typeof instock === 'number') return instock;
  if (typeof instock === 'string') return parseInt(instock, 10) || 0;
  if (typeof instock === 'object') {
    return Object.values(instock).reduce((sum, v) => {
      const n = typeof v === 'object' ? parseInstock(v) : parseInt(v, 10) || 0;
      return sum + (Number.isFinite(n) ? n : 0);
    }, 0);
  }
  return 0;
}

// ============================================================
//  ADDRESS CACHE (safeguard #5)
//  regaddr is async (ticket_id → poll checkticket → address_code),
//  which doesn't fit inline into a synchronous order-placement call.
//  Addresses are pre-registered ahead of time (warehouse address at
//  minimum) and looked up from the ab_addresses cache table here.
//  See migrations/001_ab_addresses.sql for the table definition.
//  pollPendingAddresses() (exported below) is run every 5 min from a
//  cron tick in server.js — see the "AB ADDRESS POLL" cron block.
// ============================================================
const crypto = require('crypto');

function hashAddress(addr) {
  const key = [addr.name, addr.street, addr.zip, addr.city, addr.country, addr.email, addr.phone]
    .map(v => String(v || '').trim().toLowerCase()).join('|');
  return crypto.createHash('sha256').update(key).digest('hex');
}

// Looks up a cached, ready address_code. Does NOT block on regaddr —
// if the address isn't cached (or is still pending), throws a clear
// error telling the caller to pre-register it via registerAddress().
async function resolveAddressCode(supabase, address) {
  const hash = hashAddress(address);
  const { data: row } = await supabase
    .from('ab_addresses')
    .select('*')
    .eq('address_hash', hash)
    .maybeSingle();

  if (row?.status === 'ready' && row.address_code) return row.address_code;

  if (!row) {
    // Kick off registration for next time, but don't block this call on it.
    await registerAddress(supabase, address).catch(e =>
      console.warn(`[AB] Background address registration failed: ${e.message}`)
    );
  }

  const err = new Error(
    `AB.pl shipping address not yet cached (status=${row?.status || 'not registered'}). ` +
    `Addresses must be pre-registered via regaddr ahead of time — call registerAddress() ` +
    `for this address and wait for the background poller to mark it ready before placing this order.`
  );
  err.addressNotReady = true;
  throw err;
}

// Kicks off req=regaddr for a new address and stores the returned
// ticket_id as 'pending'. The server.js "AB ADDRESS POLL" cron tick
// calls pollPendingAddresses() every 5 min to resolve pending tickets
// into address_code.
async function registerAddress(supabase, address, { label = null, temporary = 1 } = {}) {
  const hash = hashAddress(address);

  const { data: existing } = await supabase
    .from('ab_addresses').select('id, status').eq('address_hash', hash).maybeSingle();
  if (existing) return existing;

  const { parsed } = await postAb('regaddr', {
    name:      address.name,
    address:   address.street,
    zip:       address.zip,
    city:      address.city,
    contact:   address.attention || address.name,
    phone:     address.phone,
    email:     address.email,
    country:   (address.country || 'pl').toLowerCase(),
    temporary,
  }, { label: 'AB regaddr' });

  // VERIFY: exact tag name for ticket_id in the regaddr response.
  const ticketId = findFirstValue(parsed, ['ticket_id', 'ticketId', 'ticket']);
  if (!ticketId) throw new Error('AB.pl regaddr did not return a ticket_id — check response shape (see VERIFY comments in ABClient.js)');

  const { data: row, error } = await supabase.from('ab_addresses').insert({
    address_hash: hash,
    label,
    ticket_id:    String(ticketId),
    status:       'pending',
    raw_address:  address,
  }).select().single();
  if (error) throw new Error(`Failed to store AB address ticket: ${error.message}`);

  console.log(`[AB] Registered address (ticket ${ticketId}) — will be polled to ready by ab-address-poller.js`);
  return row;
}

// Called by scripts/ab-address-poller.js on a schedule. Resolves any
// 'pending' rows whose ticket is done (checkticket status=1).
async function pollPendingAddresses(supabase) {
  const { data: pending } = await supabase
    .from('ab_addresses').select('*').eq('status', 'pending').limit(50);
  if (!pending?.length) return { checked: 0, resolved: 0 };

  let resolved = 0;
  for (const row of pending) {
    try {
      // CONFIRMED (Postman, Aug 2026): a not-yet-ready ticket comes back
      // as an ERROR (code 60 "address creation is in progress"), not a
      // success response with a status=0 field as originally guessed —
      // postAb() throws in that case, caught below and treated as a
      // quiet no-op, not a failure.
      const { parsed } = await postAb('checkticket', { ticket_id: row.ticket_id }, { label: 'AB checkticket' });
      // VERIFY: exact tag name for address_code on a resolved ticket —
      // not yet seen, since ticket 3569898 was still processing as of
      // the last check. Confirm this the next time a ticket completes.
      const addressCode = findFirstValue(parsed, ['address_code', 'addressCode']);
      if (addressCode) {
        await supabase.from('ab_addresses').update({
          status: 'ready', address_code: String(addressCode), updated_at: new Date(),
        }).eq('id', row.id);
        resolved++;
      } else {
        console.warn(`[AB] Ticket ${row.ticket_id} resolved with no address_code found — response shape needs checking`);
      }
    } catch (err) {
      if (err.abErrorCode === 60) {
        // Still generating — expected, not an error. Leave as pending,
        // poll again next tick. No log spam, no row.error write.
        continue;
      }
      console.warn(`[AB] checkticket failed for ticket ${row.ticket_id}: ${err.message}`);
      await supabase.from('ab_addresses').update({
        error: err.message, updated_at: new Date(),
      }).eq('id', row.id);
    }
  }
  return { checked: pending.length, resolved };
}

function findFirstValue(obj, keys, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return null;
  for (const k of keys) {
    if (obj[k] !== undefined) return typeof obj[k] === 'object' ? (obj[k]['#text'] ?? null) : obj[k];
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findFirstValue(val, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

// CONFIRMED (Postman, Aug 2026): despite the docs listing several
// placeorder params as optional (comment, concat_last_order, etc.),
// the gateway actually rejects the call with error 6 ("request
// parameter missing") if they're absent — it wants them present even
// when empty/zero. Send every documented placeorder param explicitly
// rather than omitting "optional" ones.

// order shape (matches orderRouter.js's bucket → placeOrder contract):
//   odoo_sale_ref, lines: [{ sku (=abpn), quantity, unit_price?, is_external? }],
//   shipping_address: { name, street, zip, city, country, phone, email, attention? }
//
// `sku` is expected to be AB's `abpn`. `is_external` should be set true
// for lines where the synced product's specs.ab_ep_id is non-zero
// (Syncflow's normaliseProduct stores this — see syncEngine.js AB block).
async function placeOrder(order) {
  if (!order.lines?.length) throw new Error('ABClient.placeOrder: order has no lines');

  // Safeguard #2: normal products and "external" (ep_id != 0) products
  // cannot share one order — split at cart-build time.
  const normalLines   = order.lines.filter(l => !l.is_external);
  const externalLines = order.lines.filter(l => l.is_external);

  if (normalLines.length && externalLines.length) {
    console.log(`[AB] Order ${order.odoo_sale_ref} mixes normal + external products — placing as two separate AB orders`);
  }

  const results = [];
  if (normalLines.length) {
    results.push(await placeSingleAbOrder(order, normalLines, 'N'));
  }
  if (externalLines.length) {
    results.push(await placeSingleAbOrder(order, externalLines, 'E'));
  }

  // orderRouter.js expects one result object per supplier_orders row.
  // Combine multi-order results into one, keeping full detail in `raw`.
  const combined = {
    supplierOrderRef: results.map(r => r.supplierOrderRef).join(' + '),
    supplierOrderId:  results[0].supplierOrderId,
    subtotal:         parseFloat(results.reduce((s, r) => s + r.subtotal, 0).toFixed(2)),
    shipping:         parseFloat(results.reduce((s, r) => s + r.shipping, 0).toFixed(2)),
    total:            parseFloat(results.reduce((s, r) => s + r.total, 0).toFixed(2)),
    raw: JSON.stringify(results.map(r => ({ ref: r.supplierOrderRef, id: r.supplierOrderId, raw: r.raw }))),
  };
  if (results.length > 1) {
    console.log(`[AB] Order ${order.odoo_sale_ref} → AB order IDs: ${results.map(r => r.supplierOrderId).join(', ')} (split: normal + external)`);
  }
  return combined;
}

async function placeSingleAbOrder(order, lines, splitSuffix) {
  const addr = order.shipping_address || {};
  if (!addr.name || !addr.street || !addr.zip || !addr.city) {
    throw new Error('ABClient.placeOrder: shipping_address must include name, street, zip, city');
  }

  // Safeguard #5: resolved from the pre-registered address cache, never
  // via a blocking inline regaddr call.
  const shippingAddressCode = await resolveAddressCode(order._supabase, addr);

  const ownNumberBase = order.lines.length !== lines.length
    ? `${order.odoo_sale_ref}-${splitSuffix}`
    : order.odoo_sale_ref;
  const ownNumber = sanitiseOwnNumber(ownNumberBase);

  const buildContents = priceOverrides =>
    lines.map(l => {
      const price = priceOverrides?.[l.sku] ?? (parseFloat(l.unit_price) || 0);
      return `${l.sku};${parseInt(l.quantity, 10)};${price}`;
    });

  const placeParams = {
    shipping_address:      shippingAddressCode,
    invoice_address:       order.invoice_address_code || shippingAddressCode,
    delivery_method:       order.ab_delivery_method || 2, // 2 = courier (default; 1 = Wrocław city delivery only)
    payment_term:          order.ab_payment_term || process.env.AB_DEFAULT_PAYMENT_TERM || 'DH-P-01', // CONFIRMED active on this account via req=pterms (Aug 2026) — "PRZELEW 1 DZIEŃ" (transfer, 1 day)
    allow_addition:        1,
    allow_multiple_divisions: 1,
    require_contact:       0,
    comment:                order.comment || '',
    own_number:             ownNumber,
    // CONFIRMED (Postman, Aug 2026): despite being documented as
    // optional, AB rejects placeorder with error 6 if these are simply
    // absent — send them explicitly with safe defaults every time.
    concat_last_order:      0,
    cod_amt:                order.ab_cod_amt || 0,
    aon:                    order.ab_all_or_nothing ? 1 : 0,
    proforma_em:            order.ab_proforma_email || '',
    wz_cmmt:                order.ab_wz_comment || '',
    // Safeguard #4: idempotency — reject a duplicate own_number outright
    // rather than silently double-placing on a retried call.
    unichk:                1,
    test_order:            FORCE_TEST_ORDERS ? 1 : (order.ab_test_order ? 1 : 0),
    contents:              buildContents(),
  };

  let placed;
  try {
    placed = await postAb('placeorder', placeParams, { label: `AB placeorder(${ownNumber})` });
  } catch (err) {
    // Safeguard #3: error 11 (order item price mismatch) — re-fetch AB's
    // current live price and retry exactly once with corrected prices,
    // rather than treating it as a hard failure.
    if (err.abErrorCode === 11) {
      console.warn(`[AB] Order ${ownNumber} — price mismatch (error 11), re-fetching live prices and retrying once`);
      const live = await getLiveStockAndPrice(lines.map(l => l.sku));
      const liveBySku = Object.fromEntries(live.map(i => [i.abpn, i.price]));
      placeParams.contents = buildContents(liveBySku);
      placed = await postAb('placeorder', placeParams, { label: `AB placeorder(${ownNumber}) retry-after-price-mismatch` });
    } else if (err.abErrorCode === 44) {
      // Duplicate own_number — this exact order was already placed
      // (e.g. a prior attempt succeeded but the response was lost).
      // Surface a distinct, recognisable error so orderRouter's retry
      // queue doesn't keep hammering a call that will never succeed
      // with the same own_number, and a human can reconcile it.
      const dupErr = new Error(`AB.pl rejected own_number "${ownNumber}" as a duplicate (error 44) — this order may have already been placed successfully on a prior attempt. Check AB Online before retrying.`);
      dupErr.noRetry = true;
      dupErr.duplicateOwnNumber = true;
      throw dupErr;
    } else {
      throw err;
    }
  }

  // VERIFY: exact tag name for the returned order id (docs say success
  // response is <neworderid>, used as-is here).
  const neworderid = findFirstValue(placed.parsed, ['neworderid', 'orderid', 'order_id']);
  if (!neworderid) {
    throw new Error(`AB.pl placeorder returned no neworderid — response shape needs verifying. Raw: ${placed.raw?.slice(0, 300)}`);
  }

  const subtotal = lines.reduce((sum, l) => sum + (parseFloat(l.unit_price) || 0) * (parseInt(l.quantity, 10) || 0), 0);
  // Shipping cost isn't returned by placeorder itself in the docs — call
  // req=calculate-shipment-cost beforehand if an accurate figure is
  // needed pre-order; treated as 0 here (informational field only).
  return {
    supplierOrderRef: ownNumber,
    supplierOrderId:  String(neworderid),
    subtotal:         parseFloat(subtotal.toFixed(2)),
    shipping:         0,
    total:            parseFloat(subtotal.toFixed(2)),
    raw:              placed.raw,
  };
}

// ============================================================
//  SHIPMENT COST PRE-CHECK (req=calculate-shipment-cost)
//  Optional — call before placeOrder if an accurate shipping quote is
//  needed ahead of checkout (e.g. to show the customer a total).
// ============================================================
async function calculateShipmentCost(lines) {
  const contents = lines.map(l => `${l.sku};${parseInt(l.quantity, 10)}`);
  const { parsed } = await postAb('calculate-shipment-cost', { contents }, { label: 'AB calculate-shipment-cost' });
  // VERIFY: exact tag name for the returned cost.
  const cost = findFirstValue(parsed, ['shipment_cost', 'cost']);
  return parseFloat(cost) || 0;
}

// ============================================================
//  TRACKING (req=orders)
//  Interface matches what trackingPoller.js expects.
// ============================================================
// CONFIRMED (Postman, Aug 2026) against real order 15259967: the
// request param is own_number (already correct below), but the
// RESPONSE field is own_nbr — a different name, not a typo on our
// side. status is the numeric order-status code already documented
// elsewhere (1=new, 2=realization in progress, 3=realized, 4=canceled,
// 5=contact required, 24=processing/internal) — NOT the NEW/PEND/DONE
// string set, which belongs to a different endpoint (req=shipments,
// not yet exercised). Tracking number lives in speditor_waybill, not
// a plain waybill field.
const ORDER_STATUS_MAP = {
  1:  'placed',   // new
  2:  'placed',   // realization in progress
  3:  'shipped',  // realized — best-available mapping; AB doesn't
                  // document a distinct "delivered" code, so this is
                  // the most advanced state inferable from status alone
  4:  'error',    // canceled
  5:  'error',    // contact required — needs a human, surfaced as error
  24: 'placed',   // processing (internal)
};

async function getBatchTracking(ownNumbers) {
  const list = Array.isArray(ownNumbers) ? ownNumbers : [ownNumbers];
  const results = [];
  // req=orders doesn't document a bulk own_number filter — poll individually.
  // AB rate limits don't restrict order-status calls ("order placement no
  // limit" per the rate table), so this is safe to do per-order.
  for (const ownNumber of list) {
    try {
      results.push(await getTracking(ownNumber));
      results[results.length - 1].supplierOrderRef = ownNumber;
    } catch (err) {
      console.warn(`[AB] Tracking lookup failed for ${ownNumber}: ${err.message}`);
    }
  }
  return results;
}

async function getTracking(ownNumber) {
  const { parsed } = await postAb('orders', { own_number: ownNumber, onlymine: 1, showdetails: 0 }, { label: 'AB orders lookup' });
  const orderNode = findOrderNode(parsed, ownNumber);
  if (!orderNode) return { status: 'placed', tracking_number: null, tracking_url: null, carrier: null };

  const statusCode = parseInt(findFirstValue(orderNode, ['status']), 10);
  const trackingNumber = findFirstValue(orderNode, ['speditor_waybill']) || null;
  // A real waybill is a stronger signal than the numeric status alone —
  // promote to 'shipped' whenever one is present, regardless of status.
  const status = trackingNumber ? 'shipped' : (ORDER_STATUS_MAP[statusCode] || 'placed');

  return {
    status,
    tracking_number: trackingNumber,
    tracking_url:    null, // AB doesn't document a direct tracking URL
    carrier:          findFirstValue(orderNode, ['speditor']) || null,
  };
}

function findOrderNode(parsed, ownNumber) {
  const nodes = [];
  (function walk(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 5) return;
    if (Array.isArray(obj)) { obj.forEach(o => walk(o, depth + 1)); return; }
    if ('own_nbr' in obj) nodes.push(obj);
    for (const v of Object.values(obj)) if (v && typeof v === 'object') walk(v, depth + 1);
  })(parsed);
  return nodes.find(n => String(n.own_nbr) === String(ownNumber)) || nodes[0] || null;
}

module.exports = {
  placeOrder,
  getTracking,
  getBatchTracking,
  getLiveStockAndPrice,
  calculateShipmentCost,
  registerAddress,
  resolveAddressCode,
  pollPendingAddresses,
  // exported for the outbound-IP check script / manual testing
  postAb,
};
