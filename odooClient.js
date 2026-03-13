// ============================================================
//  SyncFlow — odooClient.js
//  Communicates with Odoo via XML-RPC (standard Odoo API)
// ============================================================
const xmlrpc = require('xmlrpc');
const axios  = require('axios');

// ── Build XML-RPC clients ──────────────────────────────────
function getClients(odooUrl) {
  const url   = new URL(odooUrl);
  const isSSL = url.protocol === 'https:';
  const opts  = { host: url.hostname, port: url.port || (isSSL ? 443 : 80), path: '' };

  const create = (path) => isSSL
    ? xmlrpc.createSecureClient({ ...opts, path })
    : xmlrpc.createClient({ ...opts, path });

  return {
    common: create('/xmlrpc/2/common'),
    object: create('/xmlrpc/2/object'),
  };
}

// ── Promisify xmlrpc call ──────────────────────────────────
function call(client, method, params) {
  return new Promise((resolve, reject) => {
    client.methodCall(method, params, (err, val) => {
      if (err) reject(err);
      else resolve(val);
    });
  });
}

// ── Test connection ────────────────────────────────────────
async function testConnection(config) {
  const { common } = getClients(config.url);
  const uid = await call(common, 'authenticate', [
    config.database, config.username, config.api_key, {}
  ]);
  if (!uid) throw new Error('Authentication failed — check your credentials');

  // Get Odoo version info
  const info = await call(common, 'version', []);

  // Detect major version for compatibility layer
  const compat = require('./odooCompat');
  const detectedVersion = await compat.detectOdooVersion(config);

  return {
    uid,
    server_version:   info.server_version,
    detected_version: detectedVersion,
    product_count:    await countProducts(config, uid),
  };
}

// ── Count products in Odoo ─────────────────────────────────
async function countProducts(config, uid) {
  const { object } = getClients(config.url);
  return await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'product.template', 'search_count', [[]]
  ]);
}

// ── Authenticate once and return uid ──────────────────────
async function authenticate(config) {
  const { common } = getClients(config.url);
  const uid = await call(common, 'authenticate', [
    config.database, config.username, config.api_key, {}
  ]);
  if (!uid) throw new Error('Odoo authentication failed');
  return uid;
}

// ── Upsert a BATCH of products into Odoo ──────────────────
//
// Cross-docking / dropship model (Poland):
//   stock_qty from the supplier feed = supplier availability to order,
//   NOT physical goods in our warehouse. Therefore:
//
//   - We never write to stock.quant or qty_available (physical on-hand).
//   - Supplier availability is stored in a custom Integer field x_supplier_qty
//     on product.template. Create it in Odoo:
//     Settings → Technical → Fields → product.template → Add Field
//     (type: Integer, Field Name: x_supplier_qty, String: "Supplier Qty Available")
//   - x_supplier_qty is informational only — it tells your sales team how many
//     the supplier can ship, not how many are sitting in your warehouse.
//   - Physical stock remains 0 (or reflects only in-transit goods).
//   - Replenishment is handled via Odoo's Dropship route on the product,
//     which raises a PO to the supplier when a sales order is confirmed.
//
// Batching strategy (no N+1):
//   1 search_read to find existing SKUs → 1 create() for all new → 1 write() per update.
//   Bounded by batch size (100), not catalog size (50k).
async function upsertBatch(config, products) {
  const uid = await authenticate(config);
  const { object } = getClients(config.url);

  // ── Step 1: Find which SKUs already exist (1 query for the whole batch) ──
  const skus = products.map(p => p.sku).filter(Boolean);
  const existing = await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'product.template', 'search_read',
    [[['default_code', 'in', skus]]],
    { fields: ['id', 'default_code'], limit: skus.length }
  ]);

  const existingBySku = Object.fromEntries(existing.map(r => [r.default_code, r.id]));

  const toCreate = [];
  const toUpdate = []; // [{ odoo_id, values }]

  for (const product of products) {
    const values = {
      name:             product.name,
      default_code:     product.sku,
      list_price:       product.sale_price  || 0,
      standard_price:   product.cost_price  || 0,
      description_sale: product.description || '',
      type:             'product',
      // Supplier availability (cross-dock model) — NOT physical on-hand stock.
      // Requires custom Integer field x_supplier_qty on product.template in Odoo.
      ...(product.stock_qty != null ? { x_supplier_qty: product.stock_qty } : {}),
      // Image stored as URL, not Base64 binary — prevents database bloat.
      // Requires custom Char field x_image_url on product.template in Odoo.
      ...(product.image_url ? { x_image_url: product.image_url } : {}),
    };

    if (existingBySku[product.sku]) {
      toUpdate.push({ odoo_id: existingBySku[product.sku], values });
    } else {
      toCreate.push(values);
    }
  }

  // ── Step 2: Create all new products in one call ──────────────────────────
  if (toCreate.length) {
    await call(object, 'execute_kw', [
      config.database, uid, config.api_key,
      'product.template', 'create',
      [toCreate]
    ]);
  }

  // ── Step 3: Update existing products ────────────────────────────────────
  // write() per product — creates are already batched so total calls = batch size.
  for (const { odoo_id, values } of toUpdate) {
    await call(object, 'execute_kw', [
      config.database, uid, config.api_key,
      'product.template', 'write',
      [[odoo_id], values]
    ]).catch(e => console.error(`[ODOO] write failed for id ${odoo_id}:`, e.message));
  }

  return { created: toCreate.length, updated: toUpdate.length };
}

// ── PUSH TRACKING NUMBER TO ODOO SALE ORDER ───────────────────
// Finds the sale order by name (e.g. "S00042") and writes the
// tracking number to the delivery (stock.picking) record.
async function updateOrderTracking(config, { odoo_sale_ref, tracking_number, tracking_url, carrier }) {
  const uid = await authenticate(config);

  // 1. Find the sale order by name
  const [saleId] = await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'sale.order', 'search',
    [[['name', '=', odoo_sale_ref]]],
    { limit: 1 },
  ]);
  if (!saleId) throw new Error(`Sale order ${odoo_sale_ref} not found in Odoo`);

  // 2. Find related stock.picking (delivery order)
  const pickingIds = await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'stock.picking', 'search',
    [[['sale_id', '=', saleId], ['picking_type_code', '=', 'outgoing']]],
  ]);
  if (!pickingIds?.length) {
    console.warn(`[ODOO] No delivery found for sale order ${odoo_sale_ref}`);
    return;
  }

  // 3. Write tracking to first delivery
  const updateData = { carrier_tracking_ref: tracking_number };
  if (carrier) updateData.carrier_id_name = carrier;
  if (tracking_url) updateData.x_tracking_url = tracking_url;

  await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'stock.picking', 'write',
    [pickingIds, updateData],
  ]);

  console.log(`[ODOO] Tracking written for ${odoo_sale_ref}: ${tracking_number}`);
}

// ── PUSH INBOUND TRACKING TO ODOO INCOMING SHIPMENT ──────────
// Cross-dock: tracking goes on the receipt (stock.picking type=incoming)
// linked to the purchase order created for this sale order.
// The outbound delivery to the customer is handled separately in Odoo.
// ── VERSION-AWARE INBOUND TRACKING ───────────────────────────
// Delegates to odooCompat which handles v16/v17/v18/v19+ differences.
async function updateInboundTracking(config, { odoo_sale_ref, tracking_number, tracking_url, carrier }) {
  const compat = require('./odooCompat');
  const uid    = await authenticate(config);
  const odooVersion = config.detected_version || 17;

  await compat.ensureCustomFields(config, uid);

  // Find the sale order
  const saleIds = await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'sale.order', 'search',
    [[['name', '=', odoo_sale_ref]]],
    { limit: 1 },
  ]);
  if (!saleIds?.length) {
    console.warn(`[ODOO] Sale order ${odoo_sale_ref} not found`);
    return;
  }

  // Find incoming pickings using version-appropriate strategy
  const incomingPickingIds = await compat.findIncomingPickings(
    config, uid, odooVersion, saleIds[0], odoo_sale_ref
  );

  if (!incomingPickingIds?.length) {
    // Fallback: write as a chatter note on the sale order
    await xmlrpcCall(config, 'object', 'execute_kw', [
      config.database, uid, config.api_key,
      'sale.order', 'write',
      [saleIds, {
        note: `Inbound tracking: ${tracking_number}${carrier ? ' (' + carrier + ')' : ''}${tracking_url ? ' — ' + tracking_url : ''}`,
      }],
    ]);
    console.warn(`[ODOO v${odooVersion}] No incoming picking found for ${odoo_sale_ref} — wrote tracking to sale note`);
    return;
  }

  // Write tracking using version-appropriate field names
  await compat.writeTrackingToPickings(
    config, uid, odooVersion, incomingPickingIds,
    { tracking_number, tracking_url, carrier }
  );

  console.log(`[ODOO v${odooVersion}] Inbound tracking written for ${odoo_sale_ref}: ${tracking_number}`);
}

module.exports = { testConnection, upsertBatch, authenticate, updateOrderTracking, updateInboundTracking };
