// ============================================================
//  SyncFlow — odooCompat.js
//  Detects the live Odoo version on connection and provides
//  compatibility shims for APIs that changed between versions.
//
//  Supported: Odoo 16, 17, 18, 19+
//  XML-RPC core (authenticate, execute_kw) is stable across all.
//  What changes:
//    - Cross-dock procurement group field path (v17+)
//    - stock.picking field names for tracking (v18+)
//    - ir.model structure queries (minor, handled internally)
// ============================================================

const { xmlrpcCall, authenticate } = require('./odooClient');

// ── DETECT VERSION ────────────────────────────────────────────
// Queries ir.module.module for the 'base' module version string.
// Returns integer major version: 16, 17, 18, 19, etc.
async function detectOdooVersion(config) {
  try {
    const uid = await authenticate(config);
    const rows = await xmlrpcCall(config, 'object', 'execute_kw', [
      config.database, uid, config.api_key,
      'ir.module.module', 'search_read',
      [[['name', '=', 'base'], ['state', '=', 'installed']]],
      { fields: ['latest_version'], limit: 1 },
    ]);
    const raw = rows?.[0]?.latest_version || '';
    // latest_version format: "16.0.1.3.0" or "17.0.1.0.0"
    const major = parseInt(raw.split('.')[0]);
    if (major >= 14) return major;
    return 17; // safe default
  } catch (err) {
    console.warn('[ODOO COMPAT] Could not detect version, assuming v17:', err.message);
    return 17;
  }
}

// ── STORE DETECTED VERSION IN SUPABASE ───────────────────────
async function detectAndStore(supabase, config) {
  const version = await detectOdooVersion(config);
  await supabase.from('odoo_config')
    .update({ detected_version: version })
    .eq('id', config.id || 1);
  console.log(`[ODOO COMPAT] Detected Odoo v${version}`);
  return version;
}

// ── INBOUND TRACKING COMPAT SHIM ─────────────────────────────
// Finds the incoming stock.picking for a sale order.
// Strategy varies by Odoo version.
async function findIncomingPickings(config, uid, odooVersion, saleId, saleRef) {

  // ── v16 / v17: procurement_group_id on sale.order links to group ──
  // group links to stock.picking via group_id field
  if (odooVersion <= 17) {
    const saleData = await xmlrpcCall(config, 'object', 'execute_kw', [
      config.database, uid, config.api_key,
      'sale.order', 'read',
      [[saleId], ['procurement_group_id']],
    ]);
    const groupId = saleData?.[0]?.procurement_group_id?.[0];
    if (groupId) {
      const ids = await xmlrpcCall(config, 'object', 'execute_kw', [
        config.database, uid, config.api_key,
        'stock.picking', 'search',
        [[['group_id', '=', groupId], ['picking_type_code', '=', 'incoming']]],
      ]);
      if (ids?.length) return ids;
    }
  }

  // ── v18+: Odoo may use purchase.order as the bridge ──────────
  // sale.order → purchase.order (via cross-dock route) → stock.picking
  if (odooVersion >= 18) {
    try {
      // Find purchase orders originated from this sale
      const purchaseIds = await xmlrpcCall(config, 'object', 'execute_kw', [
        config.database, uid, config.api_key,
        'purchase.order', 'search',
        [[['origin', 'ilike', saleRef]]],
      ]);
      if (purchaseIds?.length) {
        const ids = await xmlrpcCall(config, 'object', 'execute_kw', [
          config.database, uid, config.api_key,
          'stock.picking', 'search',
          [[['purchase_id', 'in', purchaseIds], ['picking_type_code', '=', 'incoming']]],
        ]);
        if (ids?.length) return ids;
      }
    } catch (_) { /* purchase module may not be installed */ }
  }

  // ── Universal fallback: search by origin field ────────────────
  const ids = await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'stock.picking', 'search',
    [[['origin', 'ilike', saleRef], ['picking_type_code', '=', 'incoming']]],
  ]);
  return ids || [];
}

// ── WRITE TRACKING — VERSION-AWARE ───────────────────────────
// The tracking field name changed in v18:
//   v16/v17: carrier_tracking_ref  on stock.picking
//   v18+:    tracking_number       on stock.picking (carrier_tracking_ref still exists as alias)
async function writeTrackingToPickings(config, uid, odooVersion, pickingIds, trackingData) {
  const { tracking_number, tracking_url, carrier } = trackingData;

  const updateData = {};

  // carrier_tracking_ref exists in all versions; tracking_number added in v18 as alias
  updateData.carrier_tracking_ref = tracking_number;
  if (odooVersion >= 18) {
    updateData.tracking_number = tracking_number; // explicit v18+ field
  }
  if (tracking_url) {
    // x_tracking_url is a custom field — safe to attempt, silent on failure
    updateData.x_inbound_tracking_url = tracking_url;
  }

  await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'stock.picking', 'write',
    [pickingIds, updateData],
  ]);
}

// ── UPSERT PRODUCTS — VERSION-AWARE ──────────────────────────
// The main product fields are stable. Custom x_ fields need to
// exist in Odoo before writing; we check once and cache.
let _customFieldsVerified = false;

async function ensureCustomFields(config, uid, supabase = null) {
  if (_customFieldsVerified) return;
  try {
    const fields = await xmlrpcCall(config, 'object', 'execute_kw', [
      config.database, uid, config.api_key,
      'product.template', 'fields_get',
      [['x_supplier_qty', 'x_image_url', 'x_inbound_tracking_url']],
      { attributes: ['string', 'type'] },
    ]);
    const missing = ['x_supplier_qty', 'x_image_url'].filter(f => !fields[f]);
    if (missing.length) {
      const msg = `Missing custom fields on Odoo product.template: ${missing.join(', ')}. Create them in Odoo: Settings → Technical → Fields → product.template`;
      console.warn('[ODOO COMPAT]', msg);

      // Write to activity_log so it appears on the dashboard — not just buried in Railway logs
      if (supabase) {
        await supabase.from('activity_log').insert({
          type:   'odoo_warning',
          title:  'Odoo custom fields missing',
          detail: msg,
        });
      }
    }
    _customFieldsVerified = true;
  } catch (_) { /* non-fatal */ }
}

module.exports = {
  detectOdooVersion,
  detectAndStore,
  findIncomingPickings,
  writeTrackingToPickings,
  ensureCustomFields,
};
