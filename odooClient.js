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

// ── Promisify xmlrpc call, with a hard timeout ─────────────
// CRITICAL: the xmlrpc library's methodCall() has no built-in timeout —
// it relies entirely on the underlying TCP connection. If Odoo hangs,
// becomes unresponsive, or a connection silently stalls (common with
// self-hosted instances under load), the callback simply never fires
// and this Promise would hang FOREVER with no timeout. Since every
// supplier's sync eventually calls into Odoo, this single hang point
// was capable of freezing all suppliers simultaneously and indefinitely
// — the is_syncing lock never gets released because .catch()/.finally()
// in server.js/syncEngine.js only run once the Promise actually settles,
// which it never did. Racing against a timer guarantees this always
// settles within RPC_TIMEOUT_MS, so a hung Odoo connection becomes a
// clear, recoverable error instead of a silent, permanent freeze.
const RPC_TIMEOUT_MS = 45000;

function call(client, method, params) {
  return Promise.race([
    new Promise((resolve, reject) => {
      client.methodCall(method, params, (err, val) => {
        if (err) reject(err);
        else resolve(val);
      });
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Odoo XML-RPC call '${method}' timed out after ${RPC_TIMEOUT_MS / 1000}s — Odoo may be unresponsive or unreachable`)), RPC_TIMEOUT_MS)
    ),
  ]);
}

// SEPARATE PRE-EXISTING BUG, also fixed here: 'xmlrpcCall' is referenced in
// ~15 places throughout this file (updateOrderTracking, createPurchaseOrder,
// createVendorBill, createInboundReceipt, etc.) and is even imported by
// odooCompat.js — but was never actually defined or exported anywhere.
// Every function using it would throw "ReferenceError: xmlrpcCall is not
// defined" the instant it ran. This wrapper matches the exact signature
// those call sites already use — (config, clientType, method, params) —
// resolving the right XML-RPC client from config.url and delegating to
// the timeout-protected call() above, so those call sites also gain the
// same hang-proof timeout protection.
function xmlrpcCall(config, clientType, method, params) {
  const clients = getClients(config.url);
  const client  = clients[clientType];
  if (!client) throw new Error(`xmlrpcCall: unknown client type '${clientType}' (expected 'object' or 'common')`);
  return call(client, method, params);
}

// ── SANITIZE TEXT FOR XML-RPC ──────────────────────────────────
// XML 1.0 only allows a specific character range — most control
// characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F) are simply illegal in
// an XML document and will break the ENTIRE request if present
// anywhere in the payload, not just the field that contains them.
// Supplier feeds (especially messier ones) occasionally carry stray
// control characters or corrupted encoding in free-text fields like
// name/description — this strips anything outside the valid XML
// range before it ever reaches the XML-RPC layer, rather than
// discovering it product-by-product via "Invalid XML-RPC message"
// errors with no indication of which field or product caused it.
function sanitizeXmlText(str) {
  if (str == null) return str;
  let s = String(str);
  // Strip ASCII control characters — illegal in XML 1.0.
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  // Strip LONE (unpaired) UTF-16 surrogates — invisible in normal text
  // display, but invalid in well-formed UTF-8/XML output. These can end
  // up in a JS string when source text had corrupted or mismatched
  // encoding — plausible for a large, messy international feed like
  // DCS's 180k+ row CSV. A valid surrogate pair (high followed by low,
  // e.g. an emoji) is left completely untouched; only an unpaired one
  // is removed. The capture group + $1 replacement is required to avoid
  // accidentally deleting the valid character preceding a lone low
  // surrogate — verified against test cases before shipping.
  s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|([^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/g, '$1');
  // NEW (Aug 2026): U+FFFE and U+FFFF are explicitly excluded from XML
  // 1.0's valid Char production (spec range is [#xE000-#xFFFD], NOT
  // ...-#xFFFF) — these aren't control characters, so the strip above
  // never touched them. They show up from corrupted/mismatched-encoding
  // source text (e.g. a stray BOM/replacement leftover) same as the lone
  // surrogates above, and previously reached Odoo's XML-RPC layer
  // untouched, causing a bare "Invalid XML-RPC message" with no
  // indication of which field/character caused it.
  s = s.replace(/[\uFFFE\uFFFF]/g, '');
  return s;
}

// Guards against NaN/Infinity, which are also invalid in XML-RPC.
function safeNumber(n, fallback = 0) {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
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

  // ── Step 1: Find which products already exist — by SKU AND by barcode ────
  // Matching only by SKU (default_code) misses products that already exist
  // in Odoo from a DIFFERENT source under a different SKU but the SAME
  // real-world EAN/barcode — e.g. a product already imported via the
  // ITscope Catalog module. Odoo enforces barcode uniqueness, so trying to
  // create/update a "new" product with a barcode that's already claimed
  // fails outright ("Barcode(s) already assigned"). Searching by both in
  // one combined query lets a barcode match serve as a fallback: if we
  // don't recognise the SKU but the EAN already exists, we update that
  // existing record instead of colliding with it.
  const skus = products.map(p => p.sku).filter(Boolean);
  const eans = products.map(p => p.ean).filter(Boolean);
  const domain = eans.length
    ? ['|', ['default_code', 'in', skus], ['barcode', 'in', eans]]
    : [['default_code', 'in', skus]];

  const existing = await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'product.template', 'search_read',
    [domain],
    { fields: ['id', 'default_code', 'barcode'], limit: skus.length + eans.length }
  ]);

  const existingBySku     = Object.fromEntries(existing.filter(r => r.default_code).map(r => [r.default_code, r.id]));
  const existingByBarcode = Object.fromEntries(existing.filter(r => r.barcode).map(r => [r.barcode, r.id]));
  const existingBarcodeById = Object.fromEntries(existing.map(r => [r.id, r.barcode || false]));

  const toCreate = [];
  const toUpdate = []; // [{ odoo_id, values }]
  // Tracks the redirect target for the cross-record collision case above —
  // applied to skuToOdooId AFTER it's built from toUpdate, so it correctly
  // overrides the (wrong) skuMatchId-based mapping. See
  // crossRecordBarcodeCollision below for why this redirect exists.
  const crossRecordRedirects = {};

  // ── ODOO 17+ SCHEMA CHANGE ────────────────────────────────────
  // Odoo <17: product.template.type accepted 'product' (storable),
  // 'consu' (consumable), 'service'.
  // Odoo 17+/19: 'product' was removed. Storable tracking is now a
  // separate boolean field `is_storable` on top of type: 'consu'.
  // Sending type: 'product' on v17+ throws:
  //   ValueError: Wrong value for product.template.type: 'product'
  const odooVersion = config.detected_version || 17;
  const typeFields = odooVersion >= 17
    ? { type: 'consu', is_storable: true }
    : { type: 'product' };

  for (const product of products) {
    const values = {
      default_code:     sanitizeXmlText(product.sku),
      barcode:          sanitizeXmlText(product.ean) || false,
      list_price:       safeNumber(product.sale_price, 0),
      standard_price:   safeNumber(product.cost_price, 0),
      ...typeFields,
      // Native Odoo product category (product.category, hierarchical) —
      // resolved once per unique "My Category" path via
      // getOrCreateCategoryHierarchy() and attached to each product as
      // odoo_category_id before this function is called.
      ...(product.odoo_category_id ? { categ_id: product.odoo_category_id } : {}),
      // Supplier availability (cross-dock model) — NOT physical on-hand stock.
      // Requires custom Integer field x_supplier_qty on product.template in Odoo.
      ...(product.stock_qty != null ? { x_supplier_qty: safeNumber(product.stock_qty, 0) } : {}),
      // Image stored as URL, not Base64 binary — prevents database bloat.
      // Requires custom Char field x_image_url on product.template in Odoo.
      ...(product.image_url ? { x_image_url: sanitizeXmlText(product.image_url) } : {}),
      // Human-readable spec summary built from mapped My Attributes (e.g.
      // "Product Type: Smartphone | Condition: New | Warranty: 24 months").
      // ONE generic field for ALL mapped attributes, deliberately — a
      // separate custom Odoo field per attribute doesn't scale, since
      // every new attribute mapped in Syncflow would require another trip
      // into Odoo Studio. This field just grows richer automatically as
      // more attributes get mapped, no Odoo-side changes ever needed again.
      // Requires custom Text field x_specifications on product.template in Odoo.
      ...(product.specs_summary ? { x_specifications: sanitizeXmlText(product.specs_summary) } : {}),
      // Brand/manufacturer — confirmed (Aug 2026, Odoo field list) that no
      // Syncflow-specific brand field exists, but itscope_manufacturer
      // (Char, product.template) already does — created for the separate
      // ITscope module.
      // CORRECTION (Aug 24 2026): the original assumption here — "Syncflow
      // vs ITscope products are entirely separate records, no collision
      // risk" — was WRONG. Barcode-matching (matchedViaBarcodeOnly /
      // crossRecordBarcodeCollision above) can and does match a Syncflow
      // product onto a record ITscope actually created, exactly like it
      // correctly merges two Syncflow suppliers onto one record. That's
      // fine for price/stock — but it means a bare numeric FALLBACK brand
      // value (e.g. AB.pl's raw producer_id, used when that producer's
      // real name is blank upstream) could silently overwrite ITscope's
      // own correctly-resolved manufacturer name with a meaningless
      // number like "4320". Guard against writing anything that's purely
      // numeric — a real brand name is never just digits — so only
      // genuinely-resolved names ever reach this shared field.
      ...(product.brand && !/^\d+$/.test(String(product.brand).trim())
        ? { itscope_manufacturer: sanitizeXmlText(product.brand) } : {}),
    };

    // Prefer an exact SKU match (this is definitely "our" product from a
    // prior sync). Fall back to a barcode match only if the SKU is
    // unrecognised — that means a different source (e.g. ITscope) already
    // created this exact real-world product under its own SKU.
    const skuMatchId     = existingBySku[product.sku];
    const barcodeMatchId = product.ean ? existingByBarcode[product.ean] : null;
    const matchedId      = skuMatchId || barcodeMatchId;
    const matchedViaBarcodeOnly = !skuMatchId && !!barcodeMatchId;

    // REAL FIX (Aug 24 2026), not a cleanup task: this is why barcode
    // collisions like the Ryzen 5600G / Oral-B pairs kept failing on
    // EVERY sync forever, never resolving on their own. This supplier
    // already has ITS OWN separate product.template record (skuMatchId,
    // matched by SKU from an earlier sync) — but its own barcode/EAN
    // already legitimately belongs to a DIFFERENT existing record
    // (barcodeMatchId, e.g. one DCS created). SKU-match always won
    // before, so every sync kept trying to write that barcode onto
    // skuMatchId's record and failing — the SAME doomed write, forever,
    // because nothing ever changed which record was being targeted.
    // Two records sharing a real-world EAN this way IS the signal they're
    // the same product — exactly the case that already works correctly
    // when SKU is unrecognised (matchedViaBarcodeOnly above, e.g. the
    // WiFi Adapter: DCS creates it, AB's barcode-only match finds and
    // adds a second vendor line to the SAME record, no collision at
    // all). This just extends that same successful pattern to the case
    // where a stale/redundant SKU-matched record also happens to exist.
    const crossRecordBarcodeCollision = skuMatchId && barcodeMatchId && skuMatchId !== barcodeMatchId;

    if (matchedViaBarcodeOnly) {
      // Don't touch default_code here — overwriting the other system's own
      // SKU/reference on their product could break their ability to find
      // and re-sync it later. We still update price/stock/description/etc.
      delete values.default_code;
    }

    // FIX (Aug 2026): Odoo's barcode-uniqueness constraint re-validates the
    // WHOLE record on every write() call, not just changed fields. Because
    // this update unconditionally re-sent `barcode` even when it already
    // matched what's stored, every product whose barcode happens to
    // collide with a genuinely-duplicate value on some OTHER record
    // (an old, separate data-quality issue — two records independently
    // holding the same real-world EAN) failed on every single sync run,
    // forever — not because anything was actually changing, but because
    // reasserting an already-correct value still re-triggers the
    // constraint check against the other record. Skipping the field when
    // it's unchanged removes this entire recurring-failure class; a
    // genuinely NEW or DIFFERENT barcode still gets sent and can still
    // legitimately fail if it collides with another record, which is
    // correct — that's a real, currently-unresolved duplicate worth
    // seeing, not one to hide.
    if (matchedId && existingBarcodeById[matchedId] === values.barcode) {
      delete values.barcode;
    }

    // Cross-record collision: never attempt this write at all — it would
    // always fail, and skuMatchId's record isn't where this supplier's
    // data belongs anyway (see crossRecordBarcodeCollision above). Drop
    // the doomed barcode field so the rest of this record's fields
    // (name/price/stock/etc.) can still update cleanly without erroring.
    if (crossRecordBarcodeCollision) {
      delete values.barcode;
      // Redirect this supplier's vendor/pricing line to the record that
      // actually owns the barcode, not the stale SKU-matched one — same
      // successful pattern as matchedViaBarcodeOnly (the WiFi Adapter
      // case) above, just reached from the other direction.
      crossRecordRedirects[product.sku] = barcodeMatchId;
    }

    if (matchedId) {
      toUpdate.push({ odoo_id: matchedId, values, sku: product.sku });
    } else {
      toCreate.push(values);
    }
  }

  // ── Step 2: Create all new products in one call ──────────────────────────
  const skuToOdooId = {};
  for (const { odoo_id, sku } of toUpdate) {
    skuToOdooId[sku] = odoo_id;
  }
  // Apply cross-record redirects AFTER the above — must override, not be
  // overridden by, the (wrong) skuMatchId-based mapping for these SKUs.
  Object.assign(skuToOdooId, crossRecordRedirects);

  if (toCreate.length) {
    try {
      const newIds = await call(object, 'execute_kw', [
        config.database, uid, config.api_key,
        'product.template', 'create',
        [toCreate]
      ]);
      // Odoo's create() returns new IDs in the same order as the input list —
      // zip them back to the SKUs that were just created.
      newIds.forEach((id, i) => { skuToOdooId[toCreate[i].default_code] = id; });
    } catch (bulkErr) {
      // FIX (Aug 2026): this bulk create() previously had NO error handling
      // at all. Odoo's create([...]) with multiple records runs as ONE
      // transaction — a single barcode collision (or any other constraint
      // violation) among brand-new products throws for the WHOLE batch,
      // silently discarding every other legitimately-new product in it,
      // with none of the diagnostic logging the update path already has.
      // Fall back to creating one at a time so a single bad record can't
      // block the rest, with the same concurrency pattern and barcode
      // diagnostics used for updates below.
      console.warn(`[ODOO] Bulk create failed for ${toCreate.length} new product(s), falling back to one-at-a-time: ${bulkErr.message}`);
      const CREATE_CONCURRENCY = 15;
      for (let i = 0; i < toCreate.length; i += CREATE_CONCURRENCY) {
        const window = toCreate.slice(i, i + CREATE_CONCURRENCY);
        await Promise.all(window.map(values =>
          call(object, 'execute_kw', [
            config.database, uid, config.api_key,
            'product.template', 'create',
            [[values]]
          ]).then(([newId]) => { skuToOdooId[values.default_code] = newId; })
            .catch(e => {
              if (/Barcode\(s\) already assigned/i.test(e.message || '')) {
                console.error(`[ODOO] create failed for sku ${values.default_code}: ${e.message} — attempted barcode: ${JSON.stringify(values.barcode)}`);
              } else {
                console.error(`[ODOO] create failed for sku ${values.default_code}:`, e.message);
              }
            })
        ));
      }
    }
  }

  // ── Step 3: Update existing products ────────────────────────────────────
  // Previously one write() call per product, fully sequential — fine for a
  // few thousand products, but for a large catalogue that's almost entirely
  // updates (e.g. DCS's 177k+ products after the first sync), one XML-RPC
  // round-trip at a time could take many HOURS wall-clock. Now runs with
  // bounded concurrency instead — same total number of calls, but many in
  // flight at once rather than waiting for each one before starting the next.
  const WRITE_CONCURRENCY = 15;
  for (let i = 0; i < toUpdate.length; i += WRITE_CONCURRENCY) {
    const window = toUpdate.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(window.map(({ odoo_id, values, sku }) =>
      call(object, 'execute_kw', [
        config.database, uid, config.api_key,
        'product.template', 'write',
        [[odoo_id], values]
      ]).catch(async e => {
        // RECOVERY (Aug 24 2026): rather than pattern-match error text to
        // guess whether this specific failure means "record vanished
        // mid-sync" (we don't know the exact wording Odoo's XML-RPC layer
        // produces for that case — possibly this exact "Invalid XML-RPC
        // message" if the underlying MissingError doesn't serialize
        // cleanly as a proper fault), check ground truth directly instead:
        // does this id still exist at all? search_read safely returns an
        // empty list for a missing id rather than throwing (unlike
        // read/write, which raise MissingError on a nonexistent id).
        //
        // Confirmed (chat, Aug 24 2026): Syncflow itself never
        // deletes/archives product.template records — grepped the whole
        // codebase, zero unlink/archive calls on Odoo products. So a
        // genuinely-vanished record means something EXTERNAL removed it
        // between when this sync's search_read found it and when this
        // write executed moments later — ITscope's own module is the
        // leading suspect, given the affected products' pattern (Polish
        // names, numeric SKUs) doesn't match any Syncflow supplier.
        //
        // If it's really gone, recreate it fresh instead of logging the
        // same opaque error every single sync forever — self-healing,
        // same philosophy as the barcode-collision fix above.
        let recovered = false;
        try {
          const stillExists = await call(object, 'execute_kw', [
            config.database, uid, config.api_key,
            'product.template', 'search_read',
            [[['id', '=', odoo_id]]],
            { fields: ['id'] }
          ]);
          if (stillExists.length === 0) {
            console.warn(`[ODOO] id ${odoo_id} (sku ${sku}) no longer exists in Odoo — recreating as a new product.`);
            const recreateValues = { ...values, default_code: sku };
            const [newId] = await call(object, 'execute_kw', [
              config.database, uid, config.api_key,
              'product.template', 'create',
              [[recreateValues]]
            ]);
            skuToOdooId[sku] = newId; // overwrite the stale pre-write mapping
            console.log(`[ODOO] Recreated sku ${sku} as new id ${newId}.`);
            recovered = true;
          }
        } catch (checkErr) {
          console.error(`[ODOO] Existence check / recreate failed for id ${odoo_id} (sku ${sku}):`, checkErr.message);
        }
        if (recovered) return;

        // DIAGNOSTIC (Aug 2026): "Invalid XML-RPC message" gives no
        // indication of which field/character caused it — recurring
        // despite sanitizeXmlText already handling known bad-char
        // classes (control chars, lone surrogates, now U+FFFE/FFFF too).
        // Log enough of the actual payload to spot the next bad pattern
        // immediately instead of guessing blind from the bare error.
        if (/Invalid XML-RPC message/i.test(e.message || '')) {
          // WIDENED (Aug 24 2026, second pass): the string-field preview
          // showed nothing suspicious across ~40 failures spanning wildly
          // different products/suppliers/languages — no bad Unicode, no
          // obviously malformed text anywhere. That points away from text
          // content entirely and toward a NUMERIC field carrying something
          // XML-RPC can't serialize (NaN, Infinity, a stray string where a
          // number's expected, etc.) — none of which the string-only
          // preview would ever have caught. Adding the numeric fields too.
          const suspect = ['name', 'description_sale', 'x_specifications', 'default_code', 'itscope_manufacturer', 'barcode', 'x_image_url']
            .map(f => `${f}=${JSON.stringify(String(values[f] ?? '').slice(0, 80))}`)
            .join(' | ');
          const numericPreview = ['list_price', 'standard_price', 'x_supplier_qty', 'categ_id']
            .map(f => `${f}=${JSON.stringify(values[f])}`)
            .join(' | ');
          console.error(`[ODOO] write failed for id ${odoo_id}: ${e.message} — field preview: ${suspect} — numeric preview: ${numericPreview}`);
        } else if (/Barcode\(s\) already assigned/i.test(e.message || '')) {
          // DIAGNOSTIC (Aug 2026): added after the "don't resend an
          // unchanged barcode" fix above — this error is STILL occurring
          // on some products even with that fix deployed, and we need to
          // see whether `barcode` was actually included in THIS specific
          // failing payload (the fix should have omitted it) or whether
          // it was included with a value that didn't match what was
          // already stored (meaning this is a genuine still-unresolved
          // duplicate, which is expected/correct to fail) — can't tell
          // which without this.
          const sentBarcode = 'barcode' in values ? JSON.stringify(values.barcode) : '<omitted — fix worked, real duplicate>';
          const storedBarcode = JSON.stringify(existingBarcodeById[odoo_id] ?? '<unknown — not in this batch\'s existing lookup>');
          console.error(`[ODOO] write failed for id ${odoo_id}: ${e.message} — sent barcode: ${sentBarcode} | this record's stored barcode: ${storedBarcode}`);
        } else {
          console.error(`[ODOO] write failed for id ${odoo_id}:`, e.message);
        }
      })
    ));
  }

  return { created: toCreate.length, updated: toUpdate.length, skuToOdooId };
}

// ── VENDOR (SUPPLIER) TRACKING — Odoo's native mechanism ──────
// Instead of a custom text field, this uses Odoo's built-in Vendor
// system: each Syncflow supplier becomes a real res.partner marked as
// a vendor, and each product gets a product.supplierinfo line linking
// it to that vendor with the current cost price. This shows up
// natively in the product's "Purchase" tab and plugs into Odoo's own
// vendor pricing / RFQ features — not just a display label.

// Finds an existing vendor contact by name, or creates one if it
// doesn't exist yet. Call once per supplier and cache the returned id
// (e.g. on the suppliers table) — no need to look this up every sync.
async function getOrCreateVendorPartner(config, supplierName) {
  const uid = await authenticate(config);
  const { object } = getClients(config.url);

  const existing = await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'res.partner', 'search_read',
    [[['name', '=', supplierName], ['supplier_rank', '>', 0]]],
    { fields: ['id'], limit: 1 }
  ]);
  if (existing.length) return existing[0].id;

  const [newId] = await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'res.partner', 'create',
    [[{ name: supplierName, company_type: 'company', supplier_rank: 1 }]]
  ]);
  return newId;
}

// Upserts a product.supplierinfo record (product_tmpl_id + partner_id)
// for each product, setting its current cost price. Idempotent — an
// existing line for the same product+vendor gets its price updated
// rather than a duplicate line being created every sync.
//   items: [{ odoo_id, cost_price, sku }]
async function syncVendorPricing(config, partnerId, items) {
  if (!partnerId || !items.length) return { created: 0, updated: 0 };
  const uid = await authenticate(config);
  const { object } = getClients(config.url);

  const templateIds = items.map(i => i.odoo_id).filter(Boolean);
  if (!templateIds.length) return { created: 0, updated: 0 };

  const existing = await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'product.supplierinfo', 'search_read',
    [[['partner_id', '=', partnerId], ['product_tmpl_id', 'in', templateIds]]],
    { fields: ['id', 'product_tmpl_id'] }
  ]);
  // search_read returns product_tmpl_id as [id, display_name] — flatten to id
  const existingByTemplateId = Object.fromEntries(
    existing.map(r => [Array.isArray(r.product_tmpl_id) ? r.product_tmpl_id[0] : r.product_tmpl_id, r.id])
  );

  let created = 0, updated = 0;
  const toCreate = [];
  const toWrite  = []; // { supplierinfoId, price }

  for (const item of items) {
    if (!item.odoo_id) continue;
    const price = safeNumber(item.cost_price, 0);
    const supplierinfoId = existingByTemplateId[item.odoo_id];

    if (supplierinfoId) {
      toWrite.push({ supplierinfoId, price });
    } else {
      toCreate.push({ partner_id: partnerId, product_tmpl_id: item.odoo_id, price, min_qty: 1 });
    }
  }

  // Bounded concurrency instead of one write() at a time — same fix
  // already applied to the main product update loop, needed here too
  // since most products already have a vendor-price record after the
  // first sync, meaning nearly the whole batch went through this loop
  // sequentially every single time.
  const WRITE_CONCURRENCY = 15;
  for (let i = 0; i < toWrite.length; i += WRITE_CONCURRENCY) {
    const window = toWrite.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(window.map(({ supplierinfoId, price }) =>
      call(object, 'execute_kw', [
        config.database, uid, config.api_key,
        'product.supplierinfo', 'write',
        [[supplierinfoId], { price }]
      ]).catch(e => {
        // NOTE (Aug 2026): this write only ever sends a plain number
        // (price) — no text field at all. If this fails with the SAME
        // "Invalid XML-RPC message" error as the main product.template
        // write in the same batch window, that's a signal the bad
        // character is corrupting something shared (the XML-RPC
        // transport/connection for the whole concurrent window), not
        // this call's own payload — worth checking whether these
        // failures always cluster with a product.template failure at
        // the same timestamp before assuming this call itself is at fault.
        console.error(`[ODOO] supplierinfo write failed for template (price=${price}):`, e.message);
      })
    ));
    updated += window.length;
  }

  if (toCreate.length) {
    await call(object, 'execute_kw', [
      config.database, uid, config.api_key,
      'product.supplierinfo', 'create',
      [toCreate]
    ]).catch(e => console.error('[ODOO] supplierinfo create failed:', e.message));
    created = toCreate.length;
  }

  return { created, updated };
}

// ── VIRTUAL INVENTORY (opt-in, per supplier) ───────────────────
// Writes REAL stock.quant records at a dedicated internal location, so
// Odoo's own qty_available / website "in stock" logic treats supplier
// stock as genuine available inventory — not just an informational
// custom field like x_supplier_qty. This is a bigger commitment than
// x_supplier_qty: it touches Odoo's actual inventory core (stock
// valuation, moves, availability checks across sales/website/POS).
//
// The location MUST be usage:'internal' for qty_available to count it
// at all — Odoo only sums internal-type locations. Naming it clearly
// ("Virtual Dropship Stock") keeps it visually distinct from a real
// physical warehouse when anyone inspects stock moves, even though
// technically Odoo treats it as an ordinary internal location.
//
// For an EXISTING quant, we use inventory_quantity + action_apply_inventory
// (the same mechanism Odoo's own manual "Update Quantity" UI uses) rather
// than writing quantity directly — this generates a proper stock.move
// and preserves stock valuation/audit history. For a brand-new quant
// (no prior record), Odoo lets you set quantity directly on create() —
// the standard pattern used for initial/bulk stock seeding.

async function getOrCreateVirtualLocation(config, locationName = 'Virtual Dropship Stock') {
  const uid = await authenticate(config);
  const { object } = getClients(config.url);

  const existing = await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'stock.location', 'search_read',
    [[['name', '=', locationName], ['usage', '=', 'internal']]],
    { fields: ['id'], limit: 1 }
  ]);
  if (existing.length) return existing[0].id;

  // Nest it under the default warehouse's view location, same as any
  // other internal location, so it shows up naturally in Odoo's
  // location hierarchy rather than floating unattached.
  let parentId = null;
  const warehouses = await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'stock.warehouse', 'search_read', [[]],
    { fields: ['id', 'view_location_id'], limit: 1 }
  ]);
  if (warehouses.length) parentId = warehouses[0].view_location_id[0];

  const [newId] = await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'stock.location', 'create',
    [[{ name: locationName, usage: 'internal', location_id: parentId }]]
  ]);
  console.log(`[ODOO] Created virtual inventory location #${newId} ("${locationName}")`);
  return newId;
}

// items: [{ odoo_id (product.template id), stock_qty, sku }]
async function syncVirtualStock(config, locationId, items) {
  if (!locationId || !items.length) return { created: 0, updated: 0 };
  const uid = await authenticate(config);
  const { object } = getClients(config.url);

  const templateIds = items.map(i => i.odoo_id).filter(Boolean);
  if (!templateIds.length) return { created: 0, updated: 0 };

  // stock.quant.product_id refers to product.product (the VARIANT), not
  // product.template — resolve variant ids in one batched search, not
  // per-product. For simple/non-variant products (the norm here), each
  // template has exactly one variant.
  const variants = await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'product.product', 'search_read',
    [[['product_tmpl_id', 'in', templateIds]]],
    { fields: ['id', 'product_tmpl_id'] }
  ]);
  const variantIdByTemplateId = {};
  for (const v of variants) {
    const tmplId = Array.isArray(v.product_tmpl_id) ? v.product_tmpl_id[0] : v.product_tmpl_id;
    variantIdByTemplateId[tmplId] = v.id;
  }

  const variantIds = Object.values(variantIdByTemplateId);
  const existingQuants = await call(object, 'execute_kw', [
    config.database, uid, config.api_key,
    'stock.quant', 'search_read',
    [[['location_id', '=', locationId], ['product_id', 'in', variantIds]]],
    { fields: ['id', 'product_id'] }
  ]);
  const quantIdByVariantId = {};
  for (const q of existingQuants) {
    const vId = Array.isArray(q.product_id) ? q.product_id[0] : q.product_id;
    quantIdByVariantId[vId] = q.id;
  }

  let created = 0, updated = 0;
  const toCreate = [];
  const toAdjust = []; // { quantId, qty }

  for (const item of items) {
    const variantId = variantIdByTemplateId[item.odoo_id];
    if (!variantId) continue;
    const qty = safeNumber(item.stock_qty, 0);
    const quantId = quantIdByVariantId[variantId];

    if (quantId) {
      toAdjust.push({ quantId, qty });
    } else {
      toCreate.push({ product_id: variantId, location_id: locationId, quantity: qty });
    }
  }

  // Existing quants: set inventory_quantity then apply — bounded
  // concurrency, same pattern as the vendor-pricing/product-write fixes.
  const WRITE_CONCURRENCY = 15;
  for (let i = 0; i < toAdjust.length; i += WRITE_CONCURRENCY) {
    const window = toAdjust.slice(i, i + WRITE_CONCURRENCY);
    await Promise.all(window.map(async ({ quantId, qty }) => {
      try {
        await call(object, 'execute_kw', [
          config.database, uid, config.api_key,
          'stock.quant', 'write',
          [[quantId], { inventory_quantity: qty }]
        ]);
        await call(object, 'execute_kw', [
          config.database, uid, config.api_key,
          'stock.quant', 'action_apply_inventory',
          [[quantId]]
        ]);
      } catch (e) {
        console.error(`[ODOO] virtual stock adjust failed for quant ${quantId}:`, e.message);
      }
    }));
    updated += window.length;
  }

  // New quants: quantity can be set directly on create — the standard
  // pattern for initial/bulk stock seeding.
  if (toCreate.length) {
    await call(object, 'execute_kw', [
      config.database, uid, config.api_key,
      'stock.quant', 'create',
      [toCreate]
    ]).catch(e => console.error('[ODOO] virtual stock create failed:', e.message));
    created = toCreate.length;
  }

  return { created, updated };
}

// ── PRODUCT CATEGORIES (Odoo native product.category, hierarchical) ──
// Resolves our "Parent / Child" My Category paths into real Odoo
// product.category records, matching Odoo's own hierarchy model
// (parent_id). Takes a batch of paths at once and caches each segment
// as it goes, so a shared parent (e.g. "Computing" under both
// "Computing / Laptops" and "Computing / Servers") only gets
// searched/created once per call, not once per path.
// Returns a Map of the original full path string -> leaf category id.
async function getOrCreateCategoryHierarchy(config, categoryPaths) {
  const uid = await authenticate(config);
  const { object } = getClients(config.url);

  const segmentCache = new Map(); // "segment path so far" -> odoo category id
  const result = new Map();       // original full path -> leaf id

  for (const path of categoryPaths) {
    if (!path) continue;
    const segments = path.split('/').map(s => s.trim()).filter(Boolean);
    let parentId = false;
    let pathSoFar = '';

    for (const segment of segments) {
      pathSoFar = pathSoFar ? `${pathSoFar} / ${segment}` : segment;

      if (segmentCache.has(pathSoFar)) {
        parentId = segmentCache.get(pathSoFar);
        continue;
      }

      const domain = parentId
        ? [['name', '=', segment], ['parent_id', '=', parentId]]
        : [['name', '=', segment], ['parent_id', '=', false]];

      const existing = await call(object, 'execute_kw', [
        config.database, uid, config.api_key,
        'product.category', 'search_read',
        [domain], { fields: ['id'], limit: 1 }
      ]);

      let id;
      if (existing.length) {
        id = existing[0].id;
      } else {
        [id] = await call(object, 'execute_kw', [
          config.database, uid, config.api_key,
          'product.category', 'create',
          [[{ name: segment, parent_id: parentId }]]
        ]);
      }
      segmentCache.set(pathSoFar, id);
      parentId = id;
    }
    result.set(path, parentId);
  }

  return result;
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


// ── CREATE PURCHASE ORDER IN ODOO ─────────────────────────────
// Called when SyncFlow places an order with TD Baltic.
// Creates a purchase.order in Odoo linked to the supplier.
// Returns the Odoo PO id and name (e.g. "P00001")
async function createPurchaseOrder(config, { odoo_sale_ref, supplier_name, lines, warehouse_address }) {
  const uid = await authenticate(config);

  // Find or create the supplier (res.partner)
  let partnerIds = await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'res.partner', 'search',
    [[['name', 'ilike', supplier_name], ['supplier_rank', '>', 0]]],
    { limit: 1 },
  ]);

  if (!partnerIds?.length) {
    // Create supplier partner
    const partnerId = await xmlrpcCall(config, 'object', 'execute_kw', [
      config.database, uid, config.api_key,
      'res.partner', 'create',
      [{ name: supplier_name, supplier_rank: 1, is_company: true }],
    ]);
    partnerIds = [partnerId];
  }

  // Build PO lines
  const orderLines = (lines || []).map(l => [0, 0, {
    name:          l.product_name || l.sku,
    product_qty:   l.quantity || 1,
    price_unit:    l.unit_price || 0,
    product_uom:   1, // Unit
    // Link by internal reference (default_code = SKU)
    // product_id resolved below if found
  }]);

  // Create the PO
  const poId = await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'purchase.order', 'create',
    [{
      partner_id:  partnerIds[0],
      origin:      odoo_sale_ref,   // Reference to the sale order
      notes:       `Auto-created by SyncFlow for sale order ${odoo_sale_ref}`,
      order_line:  orderLines,
    }],
  ]);

  // Read back the PO name
  const [po] = await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'purchase.order', 'read',
    [[poId], ['name', 'state']],
  ]);

  // Confirm PO (set to purchase state so receipt is created)
  await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'purchase.order', 'button_confirm',
    [[poId]],
  ]);

  console.log(`[ODOO] Purchase order created: ${po?.name} (id=${poId}) for ${odoo_sale_ref}`);
  return { poId, poName: po?.name };
}

// ── CREATE VENDOR BILL FROM TD BALTIC INVOICE ─────────────────
// Called when TD Baltic INVOIC is fetched after shipment.
// Creates a draft vendor bill linked to the PO.
async function createVendorBill(config, { odoo_sale_ref, odoo_po_id, invoice }) {
  const uid = await authenticate(config);

  // Find supplier partner
  let partnerIds = await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'res.partner', 'search',
    [[['name', 'ilike', 'TD Baltic'], ['supplier_rank', '>', 0]]],
    { limit: 1 },
  ]);

  // Build invoice lines from TD Baltic INVOIC data
  const invLines = (invoice.lines || []).map(l => [0, 0, {
    name:       l.description || l.item_id,
    quantity:   parseFloat(l.qty) || 1,
    price_unit: parseFloat(l.price) || 0,
  }]);

  // Create vendor bill (account.move type=in_invoice)
  const billId = await xmlrpcCall(config, 'object', 'execute_kw', [
    config.database, uid, config.api_key,
    'account.move', 'create',
    [{
      move_type:       'in_invoice',
      partner_id:      partnerIds?.[0] || false,
      invoice_date:    invoice.invoice_date || null,
      ref:             invoice.invoice_number || odoo_sale_ref,
      narration:       `TD Baltic invoice for ${odoo_sale_ref}. PO: ${odoo_po_id || '—'}`,
      invoice_line_ids: invLines,
      // Link to PO if available
      ...(odoo_po_id ? { purchase_id: odoo_po_id } : {}),
    }],
  ]);

  console.log(`[ODOO] Vendor bill created: id=${billId} for ${odoo_sale_ref}, invoice ${invoice.invoice_number}`);
  return { billId };
}

// ── CREATE / UPDATE INBOUND RECEIPT WITH WAYBILL ──────────────
// Creates or updates the incoming stock.picking with the waybill number.
// The receipt is left in 'ready' state — warehouse staff confirm on arrival.
async function createInboundReceipt(config, { odoo_sale_ref, odoo_po_id, waybill, carrier, lines }) {
  const uid = await authenticate(config);

  // Find incoming picking linked to the PO
  let pickingIds = [];
  if (odoo_po_id) {
    pickingIds = await xmlrpcCall(config, 'object', 'execute_kw', [
      config.database, uid, config.api_key,
      'stock.picking', 'search',
      [[['purchase_id', '=', odoo_po_id], ['picking_type_code', '=', 'incoming']]],
    ]);
  }

  // Fallback: find by origin (sale ref)
  if (!pickingIds?.length) {
    pickingIds = await xmlrpcCall(config, 'object', 'execute_kw', [
      config.database, uid, config.api_key,
      'stock.picking', 'search',
      [[['origin', 'ilike', odoo_sale_ref], ['picking_type_code', '=', 'incoming']]],
    ]);
  }

  const trackingData = {
    carrier_tracking_ref: waybill,
    ...(carrier ? { carrier_id: false } : {}), // carrier_id requires lookup; skip for now
  };

  if (pickingIds?.length) {
    // Update existing receipt with waybill
    await xmlrpcCall(config, 'object', 'execute_kw', [
      config.database, uid, config.api_key,
      'stock.picking', 'write',
      [pickingIds, trackingData],
    ]);
    console.log(`[ODOO] Inbound receipt updated with waybill ${waybill} for ${odoo_sale_ref}`);
    return { pickingIds };
  } else {
    console.warn(`[ODOO] No incoming receipt found for ${odoo_sale_ref} — waybill ${waybill} not written`);
    return { pickingIds: [] };
  }
}

module.exports = { testConnection, upsertBatch, authenticate, updateOrderTracking, updateInboundTracking, createPurchaseOrder, createVendorBill, createInboundReceipt, getOrCreateVendorPartner, syncVendorPricing, xmlrpcCall, getOrCreateVirtualLocation, syncVirtualStock, getOrCreateCategoryHierarchy };
