// ============================================================
//  SyncFlow — syncEngine.js  (v3 — scale-ready)
// ============================================================
const axios       = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { parse: csvParse } = require('csv-parse/sync');
const odooClient  = require('./odooClient');
const { loadFilterTree, evaluateProduct } = require('./filterEngine');
const versionResolver = require('./apiVersionResolver');
const { withRetry, sleep } = require('./retry');

// ── CHUNK SIZES ───────────────────────────────────────────────
// Supabase upsert: 500 rows — good balance of throughput vs payload size.
// At 500k SKUs this means 1000 DB round-trips total — acceptable.
// Odoo XML-RPC: 100 per call — Odoo rejects larger payloads.
// Odoo concurrency: 5 parallel batches — saturates Odoo without overloading.
const SUPABASE_CHUNK = 500;
const ODOO_CHUNK     = 100;
const ODOO_CONCURRENCY = 5;

// ── MAIN ENTRY POINT ────────────────────────────────────────
async function runSupplierSync(supabase, supplier) {
  const jobStart = new Date();

  const { data: job } = await supabase.from('sync_jobs').insert({
    supplier_id:   supplier.id,
    supplier_name: supplier.name,
    status:        'running',
    triggered_by:  'scheduler',
    started_at:    jobStart,
  }).select().single();

  const jobId = job?.id;

  try {
    // 1. Load all active endpoints for this supplier, sorted by sort_order.
    //    When called from the cron scheduler the supplier object already has
    //    supplier_endpoints embedded (joined in server.js). The manual sync
    //    route fetches without the join, so we fall back to a DB query.
    let endpoints = supplier.supplier_endpoints?.filter(e => e.active) || null;
    if (!endpoints) {
      const { data } = await supabase
        .from('supplier_endpoints')
        .select('*')
        .eq('supplier_id', supplier.id)
        .eq('active', true)
        .order('sort_order', { ascending: true });
      endpoints = data;
    } else {
      endpoints = endpoints.sort((a, b) => a.sort_order - b.sort_order);
    }

    if (!endpoints || !endpoints.length) {
      throw new Error('No active endpoints configured for this supplier.');
    }

    // Build auth config once — used by every fetchEndpoint call
    const auth = buildAuth(supplier);

    // 1b. Load active API version for this supplier (if any)
    //     Applies field renames + endpoint URL overrides transparently.
    const activeVersion = await versionResolver.getActiveVersion(supabase, supplier.id);
    if (activeVersion) {
      console.log(`[SYNC] ${supplier.name} — using API version: ${activeVersion.version_label}`);
    }

    // 2. Fetch the products endpoint (always required, role = 'products')
    const productsEndpoint = endpoints.find(e => e.role === 'products');
    if (!productsEndpoint) throw new Error('No endpoint with role "products" found.');

    // Apply version endpoint override if present
    const productsUrl = versionResolver.resolveEndpointUrl(productsEndpoint, activeVersion);
    console.log(`[SYNC] ${supplier.name} — fetching products: ${productsUrl}`);
    let rawProducts = await fetchEndpoint(productsUrl, productsEndpoint.format, auth);

    // Apply field renames from active API version
    rawProducts = versionResolver.transformProducts(rawProducts, activeVersion);

    // 3. Fetch the categories endpoint if present and merge into products
    const categoriesEndpoint = endpoints.find(e => e.role === 'categories');
    if (categoriesEndpoint) {
      console.log(`[SYNC] ${supplier.name} — fetching categories`);
      const catUrl = versionResolver.resolveEndpointUrl(categoriesEndpoint, activeVersion);
      const rawCategories = await fetchEndpoint(catUrl, categoriesEndpoint.format, auth)
        .catch(e => { console.warn('[SYNC] Categories fetch failed:', e.message); return []; });
      rawProducts = mergeCategories(rawProducts, rawCategories);
    }

    // 4. Fetch static (non-parameterised) secondary endpoints and merge
    const staticSecondary = endpoints.filter(e =>
      !['products', 'categories'].includes(e.role) && !e.is_parameterised
    );
    for (const ep of staticSecondary) {
      console.log(`[SYNC] ${supplier.name} — fetching ${ep.role}`);
      const epUrl = versionResolver.resolveEndpointUrl(ep, activeVersion);
      const data = await fetchEndpoint(epUrl, ep.format, auth)
        .catch(e => { console.warn(`[SYNC] ${ep.role} fetch failed:`, e.message); return []; });
      if (data.length > 0) {
        console.log(`[SYNC] ${ep.role} sample keys: ${JSON.stringify(Object.keys(data[0]))}`);
        console.log(`[SYNC] ${ep.role} sample: ${JSON.stringify(data[0]).slice(0,300)}`);
      }
      rawProducts = mergeEndpointData(rawProducts, data, ep.role);
      const matched = rawProducts.filter(p => p[`_${ep.role}Data`]).length;
      console.log(`[SYNC] ${ep.role} merged: ${data.length} records, ${matched} products matched`);
    }

    // 5. Load field mappings and markup rules
    const { data: mappings }    = await supabase.from('field_mappings').select('*')
      .eq('supplier_id', supplier.id).eq('active', true);
    const { data: markupRules } = await supabase.from('markup_rules').select('*')
      .eq('supplier_id', supplier.id);

    // 6. Normalise all products
    let normalised = rawProducts.map(raw =>
      normaliseProduct(raw, mappings || [], markupRules || [])
    ).filter(p => p.sku); // drop any product with no SKU
    if (rawProducts.length > 0) {
      console.log(`[SYNC] Sample raw product keys: ${JSON.stringify(Object.keys(rawProducts[0]))}`);
      console.log(`[SYNC] Sample raw product: ${JSON.stringify(rawProducts[0]).slice(0,400)}`);
    }

    // 6a. Discover & upsert supplier attributes (top-level field names)
    //     Runs async in background — does not block or affect sync counts.
    discoverAttributes(supabase, supplier.id, rawProducts).catch(e =>
      console.warn('[SYNC] Attribute discovery failed:', e.message)
    );

    // 6a-2. Update category product counts based on normalised products
    // TD Baltic ClassCode (e.g. "UPS") matches category external_id and name
    if (normalised.length > 0) {
      try {
        const catCounts = {};
        for (const p of normalised) {
          if (p.category) catCounts[p.category] = (catCounts[p.category] || 0) + 1;
        }
        // Fetch existing categories for this supplier to match by name/external_id
        const { data: existingCats } = await supabase.from('supplier_categories')
          .select('id, name, external_id, path').eq('supplier_id', supplier.id);
        if (existingCats) {
          for (const cat of existingCats) {
            // Match: cat.name = "UPS", cat.external_id = "UPS"
            // Product category = "UPS" (ClassCode) or "UPS > UPS" (ClassCode > SubClassCode)
            const count = catCounts[cat.name]
                       || catCounts[cat.external_id]
                       || catCounts[cat.path]
                       || 0;
            await supabase.from('supplier_categories')
              .update({ product_count: count }).eq('id', cat.id);
          }
        }
      } catch(e) { console.warn('[SYNC] Category count update failed:', e.message); }
    }

    // 6b. Discover & upsert supplier categories from the categories endpoint
    if (categoriesEndpoint) {
      try {
        const catUrl = versionResolver.resolveEndpointUrl(categoriesEndpoint, activeVersion);
        const catResponse = await withRetry(() => axios.get(catUrl, { timeout: 60000, responseType: 'text' }));
        const rawXml = catResponse.data;
        console.log(`[SYNC] Categories XML preview: ${typeof rawXml === 'string' ? rawXml.slice(0, 400).replace(/\n/g,' ') : '[non-string]'}`);
        const catParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_',
          isArray: (name) => ['Class','SubClass'].includes(name) });
        const catParsed = catParser.parse(rawXml);
        // Walk tree to find Class array (TD Baltic: FamilyClass > Class[] > SubClass[])
        let classArr = [];
        function findClasses(obj) {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) { obj.forEach(findClasses); return; }
          if (obj.Class) { classArr = Array.isArray(obj.Class) ? obj.Class : [obj.Class]; return; }
          for (const val of Object.values(obj)) { if (classArr.length === 0) findClasses(val); }
        }
        findClasses(catParsed);
        console.log(`[SYNC] Categories: found ${classArr.length} top-level classes`);
        if (classArr.length) {
          await discoverCategories(supabase, supplier.id, classArr);
        }
      } catch(e) {
        console.warn('[SYNC] Categories fetch failed:', e.message);
      }
    }

    // 7. Fetch parameterised endpoints (e.g. Elko per-product description URLs).
    //    These are called once per product using the product's own field value.
    //    We do this after normalisation so we have the resolved SKU / code to use.
    const paramEndpoints = endpoints.filter(e => e.is_parameterised);
    if (paramEndpoints.length) {
      console.log(`[SYNC] ${supplier.name} — fetching ${paramEndpoints.length} parameterised endpoint(s) for ${normalised.length} products`);
      normalised = await enrichWithParamEndpoints(normalised, paramEndpoints, auth, supplier.name);
    }

    // 8. Load Odoo config
    const { data: odooConfig } = await supabase.from('odoo_config').select('*').limit(1).single();

    // 8b. PRICE SANITY CHECK — runs before any writes to Supabase or Odoo.
    //     Compares incoming prices against stored prices and aborts the sync
    //     if the change looks like a data feed error rather than real price movement.
    //
    //     Thresholds (configurable via PRICE_CHANGE_PCT and PRICE_AFFECTED_PCT env vars):
    //       PRICE_CHANGE_PCT   = 50  — flag if a product price changes by >50%
    //       PRICE_AFFECTED_PCT = 10  — abort if >10% of products trigger that flag
    //
    //     Examples of what this catches:
    //       • Supplier feed sends 0.00 for all prices (division by zero in their system)
    //       • Currency conversion bug multiplies all prices by 100
    //       • Feed truncated mid-file — 40k products sent as 4k, all priced at 0
    //       • Test data accidentally pushed to production feed
    const sanity = await checkPriceSanity(supabase, supplier.id, normalised);
    if (sanity.aborted) {
      const msg = `Price sanity check FAILED for ${supplier.name}: ${sanity.affectedPct}% of products have price changes >${sanity.changeThreshold}% (${sanity.affected}/${sanity.checked} checked). Sync aborted — no data written. Manual review required.`;
      console.error(`[SANITY] ${msg}`);
      await supabase.from('activity_log').insert({
        type:        'price_anomaly',
        title:       `⚠ Sync aborted — suspicious price changes detected`,
        detail:      msg,
        supplier_id: supplier.id,
      });
      await supabase.from('sync_jobs').update({
        status: 'error', finished_at: new Date(),
        products_errors: normalised.length,
      }).eq('id', jobId);
      return; // bail — nothing was written
    }
    if (sanity.warnings > 0) {
      console.warn(`[SANITY] ${supplier.name} — ${sanity.warnings} product(s) have large price changes (within acceptable threshold)`);
    }

    // 9. SCALE-SAFE UPSERT into Supabase in chunks of 500
    //    Uses upsert with onConflict so we never need a pre-fetch to decide
    //    insert vs update — single round-trip per 500 products.
    let created = 0, updated = 0, errors = 0;
    const stockAlerts = [];

    console.log(`[SYNC] ${supplier.name} — upserting ${normalised.length} products into Supabase (${SUPABASE_CHUNK}/chunk)`);
    if (normalised.length > 0) {
      const sample = normalised[0];
      console.log(`[SYNC] Sample normalised product keys: ${JSON.stringify(Object.keys(sample))}`);
      console.log(`[SYNC] Sample EAN: ${sample.ean}, Category: ${sample.category}, Brand: ${sample.brand}`);
    }

    for (let i = 0; i < normalised.length; i += SUPABASE_CHUNK) {
      const chunk = normalised.slice(i, i + SUPABASE_CHUNK);

      const rows = chunk.map(product => ({
        supplier_id: supplier.id,
        sku:         product.sku,
        ean:         product.ean || product.barcode || product.gtin || null,
        name:        product.name,
        description: product.description || null,
        category:    product.category    || null,
        cost_price:  product.cost_price  || 0,
        sale_price:  product.sale_price  || 0,
        stock_qty:   product.stock_qty   || 0,
        image_url:   product.image_url   || null,
        images_all:  product.images_all   || null,
        subcategory: product.subcategory  || null,
        specs:       product.specs        || null,
        status:      product.stock_qty <= 0 ? 'unavailable' : product.stock_qty <= 5 ? 'low' : 'active',
        last_synced: new Date(),
      }));

      const { error: e } = await supabase
        .from('products')
        .upsert(rows, { onConflict: 'supplier_id,sku', ignoreDuplicates: false });

      if (e) {
        console.error('[SUPABASE] upsert error:', e.message);
        errors += chunk.length;
      } else {
        updated += chunk.length; // we can't tell insert vs update with upsert — treat as updated
      }

      // Collect stock alerts (out-of-stock items)
      for (const product of chunk) {
        if (product.stock_qty <= 0) {
          stockAlerts.push({
            type:        'stock_alert',
            title:       `Supplier unavailable: ${product.name}`,
            detail:      `SKU ${product.sku} — ${supplier.name} reports 0 available to order`,
            supplier_id: supplier.id,
          });
        }
      }
    }

    if (stockAlerts.length) {
      for (let i = 0; i < stockAlerts.length; i += 500) {
        try {
          await supabase.from('activity_log').insert(stockAlerts.slice(i, i + 500));
        } catch(e) { console.error('[SUPABASE] stock alert error:', e.message); }
      }
    }

    // 10. Apply export filters — only push products that pass all rules to Odoo.
    //     The filter tree is loaded once per sync run, not per product.
    //     Products that fail the filter are still saved in Supabase (local catalog
    //     is always complete); they are just skipped for the Odoo push.
    const filterTree    = await loadFilterTree(supabase);
    const toExport      = normalised.filter(p => evaluateProduct(p, filterTree));
    const filteredOut   = normalised.length - toExport.length;
    if (filteredOut > 0) {
      console.log(`[FILTER] ${supplier.name} — ${filteredOut} products blocked by export filter, ${toExport.length} will be pushed to Odoo`);
    }

    // 11. PARALLEL ODOO PUSH — 5 concurrent batches of 100, with retry
    //     Each batch retries up to 3 times (5s → 15s) before giving up.
    //     Promise.allSettled ensures one failed batch never blocks others.
    let odooBatchErrors = 0;
    if (odooConfig?.url && toExport.length) {
      console.log(`[ODOO] ${supplier.name} — pushing ${toExport.length} products (${ODOO_CHUNK}/batch, concurrency=${ODOO_CONCURRENCY})`);

      const batches = [];
      for (let i = 0; i < toExport.length; i += ODOO_CHUNK) {
        batches.push(toExport.slice(i, i + ODOO_CHUNK));
      }

      for (let i = 0; i < batches.length; i += ODOO_CONCURRENCY) {
        const window = batches.slice(i, i + ODOO_CONCURRENCY);
        const results = await Promise.allSettled(
          window.map((batch, wi) =>
            withRetry(
              () => odooClient.upsertBatch(odooConfig, batch),
              {
                maxAttempts: 3,
                baseDelayMs: 5000,
                multiplier:  3,
                label: `Odoo batch ${i + wi} (${batch.length} products)`,
              }
            )
          )
        );
        for (const r of results) {
          if (r.status === 'rejected') {
            odooBatchErrors++;
            console.error(`[ODOO] Batch permanently failed after retries:`, r.reason?.message);
          }
        }
      }

      if (odooBatchErrors > 0) {
        await supabase.from('activity_log').insert({
          type:        'odoo_warning',
          title:       `Odoo push: ${odooBatchErrors} batch(es) failed`,
          detail:      `${odooBatchErrors} of ${Math.ceil(toExport.length / ODOO_CHUNK)} batches failed after 3 retries for ${supplier.name}. Products in failed batches were NOT updated in Odoo. Will retry on next sync.`,
          supplier_id: supplier.id,
        });
      }
    }

    // 12. Finalise
    await supabase.from('suppliers').update({
      last_sync:     new Date(),
      last_status:   errors > 0 && updated + created === 0 ? 'error' : errors > 0 ? 'partial' : 'success',
      product_count: normalised.length,
    }).eq('id', supplier.id);

    await supabase.from('sync_jobs').update({
      status:           errors > 0 && created + updated === 0 ? 'error' : errors > 0 ? 'partial' : 'success',
      products_total:   normalised.length,
      products_updated: updated,
      products_created: created,
      products_errors:  errors,
      finished_at:      new Date(),
    }).eq('id', jobId);

    await supabase.from('activity_log').insert({
      type:        'sync_complete',
      title:       `Sync completed — ${supplier.name}`,
      detail:      `${normalised.length} products | +${created} new | ${updated} updated | ${errors} errors${filteredOut > 0 ? ` | ${filteredOut} filtered` : ''}`,
      supplier_id: supplier.id,
    });

    console.log(`[SYNC] Done: ${supplier.name} — ${created} created, ${updated} updated, ${errors} errors`);

  } catch (err) {
    console.error(`[SYNC] Fatal error for ${supplier.name}:`, err.message);
    await supabase.from('suppliers').update({ last_sync: new Date(), last_status: 'error' }).eq('id', supplier.id);
    await supabase.from('sync_jobs').update({ status: 'error', error_message: err.message, finished_at: new Date() }).eq('id', jobId);
    await supabase.from('activity_log').insert({
      type: 'sync_error', title: `Sync failed — ${supplier.name}`,
      detail: err.message, supplier_id: supplier.id,
    });
  }
}

// ── BUILD AUTH CONFIG ────────────────────────────────────────
// Returns an object that fetchEndpoint uses to attach credentials.
// Keeps all auth logic in one place so fetchEndpoint stays clean.
function buildAuth(supplier) {
  const type = supplier.auth_type || 'none';
  switch (type) {

    case 'basic':
      // HTTP Basic Auth header — Elko pattern
      return {
        type: 'basic',
        username: supplier.auth_username,
        password: supplier.auth_password,
      };

    case 'header':
      // API key sent as a named request header — BigBuy pattern
      return {
        type: 'header',
        headerName:  supplier.auth_header_name || 'X-AUTH-TOKEN',
        headerValue: supplier.auth_key,
      };

    case 'api_key_url':
      // Key already baked into the URL template by the user — Mobilux pattern.
      // The URL stored in supplier_endpoints already contains the key literally
      // (e.g. /key-atesodbghgsfrbcgkmcqstaugybgzr). Nothing to inject at runtime.
      return { type: 'api_key_url' };

    case 'query_params':
      // Extra params appended to every URL as query string — TD Baltic pattern.
      // auth_username, auth_password, plus any keys in auth_extra (e.g. orgnum).
      return {
        type:     'query_params',
        username: supplier.auth_username,
        password: supplier.auth_password,
        extra:    supplier.auth_extra || {},
      };

    default:
      return { type: 'none' };
  }
}

// ── FETCH A SINGLE ENDPOINT ──────────────────────────────────
async function fetchEndpoint(urlTemplate, format, auth, templateValues = {}) {
  // Substitute any {placeholder} tokens in the URL (parameterised endpoints)
  let url = urlTemplate.replace(/\{(\w+)\}/g, (_, key) =>
    encodeURIComponent(templateValues[key] ?? '')
  );

  const headers = { 'User-Agent': 'SyncFlow/1.0' };
  const axiosOpts = { timeout: 30000, responseType: 'text', headers };

  switch (auth.type) {
    case 'basic':
      axiosOpts.auth = { username: auth.username, password: auth.password };
      break;

    case 'header':
      headers[auth.headerName] = auth.headerValue;
      break;

    case 'query_params': {
      // Append credentials + any extra params as query string
      const sep = url.includes('?') ? '&' : '?';
      const params = new URLSearchParams({
        username: auth.username || '',
        pwd:      auth.password || '',
        ...auth.extra,
      });
      url = `${url}${sep}${params.toString()}`;
      break;
    }

    // 'api_key_url' and 'none' need no modification
  }

  // Retry logic: 3 attempts with exponential backoff (5s → 15s → 45s).
  // Handles transient network errors, 429 rate limits, 5xx server errors.
  // Does NOT retry 4xx auth errors (retrying with wrong credentials is pointless).
  const response = await withRetry(
    () => axios.get(url, axiosOpts),
    {
      maxAttempts: 3,
      baseDelayMs: 5000,
      multiplier:  3,
      label: `fetchEndpoint(${url.split('?')[0]})`,
      onRetry: async (attempt, err) => {
        // Don't retry auth failures — they will never succeed
        const status = err?.response?.status;
        if (status === 401 || status === 403) {
          throw Object.assign(err, { noRetry: true });
        }
      },
    }
  );
  return parseResponse(response.data, format);
}

// ── PARSE RAW RESPONSE ───────────────────────────────────────
// Wraps all parsing in try/catch — supplier APIs sometimes return
// HTML error pages with a 200 OK status. Without this, XMLParser
// throws an unhandled exception that kills the entire sync job.
function parseResponse(raw, format) {
  try {
    // Guard: detect HTML error page returned with 200 OK.
    // This is a common API gateway failure mode (e.g. Cloudflare, nginx).
    if (typeof raw === 'string' && raw.trimStart().startsWith('<html')) {
      throw new Error('Supplier returned an HTML page instead of data — likely a gateway error or auth redirect. Check the endpoint URL and credentials.');
    }

    if (format === 'json') {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return Array.isArray(parsed)
        ? parsed
        : parsed.products || parsed.items || parsed.data ||
          Object.values(parsed).find(v => Array.isArray(v)) || [];
    }

    if (format === 'csv') {
      return csvParse(raw, { columns: true, skip_empty_lines: true, trim: true });
    }

    // XML (default)
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const result = parser.parse(raw);

    // TD Baltic returns auth/service errors as valid XML with <Exception> tag
    // e.g. <PriceList><Exception ID="10" Message="Invalid Authentication Information" /></PriceList>
    const topVal = result && Object.values(result)[0];
    if (topVal && topVal.Exception) {
      const ex = topVal.Exception;
      const msg = ex['@_Message'] || ex.Message || 'Unknown error';
      const id  = ex['@_ID']      || ex.ID      || '?';
      throw new Error(`Supplier returned error (ID ${id}): ${msg}`);
    }

    for (const key of Object.keys(result)) {
      const section = result[key];
      if (Array.isArray(section)) return section;
      if (typeof section === 'object') {
        for (const inner of Object.keys(section)) {
          if (Array.isArray(section[inner])) return section[inner];
        }
      }
    }
    return [];

  } catch (err) {
    // Re-throw with format context so the caller's error message is useful
    const preview = typeof raw === 'string' ? raw.slice(0, 120).replace(/\n/g, ' ') : '[non-string]';
    throw new Error(`Failed to parse ${format} response: ${err.message} | Response preview: ${preview}`);
  }
}

// ── MERGE CATEGORIES INTO PRODUCTS ──────────────────────────
// Tries to match on common category ID fields. If no match found,
// products keep whatever category they already have (or none).
function mergeCategories(products, categories) {
  if (!categories.length) return products;

  // Build lookup by category id (try common field names)
  const catById = {};
  for (const cat of categories) {
    const id = cat.id || cat.categoryId || cat.cat_id || cat.code;
    if (id != null) catById[String(id)] = cat.name || cat.title || cat.label || String(id);
  }

  return products.map(p => {
    const rawCatId = p.categoryId || p.cat_id || p.category_id || p.categ_id;
    if (rawCatId != null && catById[String(rawCatId)]) {
      return { ...p, _resolvedCategory: catById[String(rawCatId)] };
    }
    return p;
  });
}

// ── MERGE SECONDARY ENDPOINT DATA ───────────────────────────
// For non-parameterised secondary feeds (stock, images, etc.),
// try to match records by SKU / id and attach extra fields.
function mergeEndpointData(products, secondaryData, role) {
  if (!secondaryData.length) return products;

  // Build lookup by SKU (try common field names including TD Baltic TDPartNbr)
  const byId = {};
  for (const item of secondaryData) {
    const key = item.TDPartNbr || item['@_TDPartNbr'] || item.sku || item.ref || item.code || item.id || item.productId;
    if (key != null) byId[String(key)] = item;
  }

  return products.map(p => {
    const key = p.TDPartNbr || p.sku || p.ref || p.code || p.id;
    const match = key != null ? byId[String(key)] : null;
    if (!match) return p;

    // Merge relevant fields depending on role
    switch (role) {
      case 'stock':
        return { ...p, _stockData: match };
      case 'images':
        return { ...p, _imageData: match };
      case 'attributes':
        return { ...p, _attributeData: match };
      case 'variations':
        return { ...p, _variationData: match };
      default:
        return { ...p, [`_${role}Data`]: match };
    }
  });
}

// ── ENRICH WITH PARAMETERISED ENDPOINTS ─────────────────────
// Fetches one URL per product for each parameterised endpoint
// (e.g. Elko's per-product description URL).
// Batches with a small concurrency limit to avoid rate-limiting.
// ── PRICE SANITY CHECK ───────────────────────────────────────
// Fetches existing prices from Supabase for this supplier and
// compares them to the incoming normalised products.
// Returns { aborted, affectedPct, affected, checked, warnings, changeThreshold }.
//
// Only runs the check when there are existing prices to compare against
// (first sync for a supplier is always allowed through).
//
// Configurable via environment variables:
//   PRICE_CHANGE_PCT   (default 50)  — % change per product to flag
//   PRICE_AFFECTED_PCT (default 10)  — % of products flagged to abort
async function checkPriceSanity(supabase, supplierId, incoming) {
  const CHANGE_THRESHOLD   = Number(process.env.PRICE_CHANGE_PCT)   || 50;  // 50% per product
  const AFFECTED_THRESHOLD = Number(process.env.PRICE_AFFECTED_PCT) || 10;  // 10% of catalog

  // Only check products that have a real price in the incoming feed
  const withPrice = incoming.filter(p => p.cost_price > 0);
  if (!withPrice.length) return { aborted: false, warnings: 0, checked: 0, affected: 0 };

  // Fetch existing prices for this supplier in batches (avoid URL-length limits)
  const skus = withPrice.map(p => p.sku);
  const CHUNK = 500;
  const existingMap = new Map();

  for (let i = 0; i < skus.length; i += CHUNK) {
    const { data } = await supabase
      .from('products')
      .select('sku, cost_price')
      .eq('supplier_id', supplierId)
      .in('sku', skus.slice(i, i + CHUNK));
    if (data) data.forEach(r => existingMap.set(r.sku, r.cost_price));
  }

  // First sync — no existing prices to compare against, always allow
  if (existingMap.size === 0) return { aborted: false, warnings: 0, checked: 0, affected: 0 };

  let affected = 0;
  let warnings = 0;
  const examples = []; // collect a few examples for the alert message

  for (const p of withPrice) {
    const existing = existingMap.get(p.sku);
    if (!existing || existing <= 0) continue; // new product — skip

    const changePct = Math.abs((p.cost_price - existing) / existing) * 100;
    if (changePct > CHANGE_THRESHOLD) {
      affected++;
      warnings++;
      if (examples.length < 5) {
        examples.push(`${p.sku}: ${existing} → ${p.cost_price} (${changePct.toFixed(0)}%)`);
      }
    }
  }

  const checked     = existingMap.size;
  const affectedPct = checked > 0 ? (affected / checked) * 100 : 0;
  const aborted     = affectedPct > AFFECTED_THRESHOLD;

  if (aborted && examples.length) {
    console.error(`[SANITY] Example price changes: ${examples.join(' | ')}`);
  }

  return { aborted, affectedPct: affectedPct.toFixed(1), affected, checked, warnings, changeThreshold: CHANGE_THRESHOLD };
}

// ── PARAMETERISED ENDPOINT ENRICHMENT ────────────────────────
async function enrichWithParamEndpoints(products, paramEndpoints, auth, supplierName) {
  const CONCURRENCY    = 5;    // max parallel requests per batch
  const BATCH_DELAY_MS = 500;  // wait 500ms between batches — prevents rate limiting
  // At 5 req/batch with 500ms pause: 10 req/s sustained.
  // Most supplier APIs allow 10-60 req/s. Adjust BATCH_DELAY_MS up if you see 429s.

  for (const ep of paramEndpoints) {
    console.log(`[SYNC] ${supplierName} — enriching via ${ep.role} (${ep.url_template}), ${products.length} products at ${1000 / BATCH_DELAY_MS * CONCURRENCY} req/s`);
    const enriched = [...products];

    for (let i = 0; i < products.length; i += CONCURRENCY) {
      const batch = products.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (product, idx) => {
          const sourceValue = product[ep.param_source_field] || product.sku;
          if (!sourceValue) return;

          const data = await fetchEndpoint(
            ep.url_template,
            ep.format,
            auth,
            { [ep.param_source_field]: sourceValue }
          );

          const text = extractText(data);
          if (text) enriched[i + idx] = { ...enriched[i + idx], [`_${ep.role}`]: text };
        })
      );

      results.forEach((r, idx) => {
        if (r.status === 'rejected') {
          console.warn(`[SYNC] ${ep.role} fetch failed for product ${i + idx}:`, r.reason?.message);
        }
      });

      // Polite pause between batches — gives the supplier API breathing room.
      // Skipped after the last batch (no point waiting when there's nothing next).
      if (i + CONCURRENCY < products.length) {
        await sleep(BATCH_DELAY_MS);
      }
    }

    // Merge enriched data into normalised fields
    return enriched.map(p => {
      if (ep.role === 'descriptions' && p._descriptions) {
        return { ...p, description: p._descriptions };
      }
      return p;
    });
  }

  return products;
}

// Helper: extract a text string from various response shapes
function extractText(data) {
  if (typeof data === 'string') return data;
  if (Array.isArray(data) && data.length) {
    const first = data[0];
    return first.description || first.text || first.content || first.value || JSON.stringify(first);
  }
  if (typeof data === 'object' && data !== null) {
    return data.description || data.text || data.content || data.value || null;
  }
  return null;
}

// ── NORMALISE PRODUCT ────────────────────────────────────────
function normaliseProduct(raw, mappings, markupRules) {
  const product = {};

  const internalKeyMap = {
    name:             'name',
    default_code:     'sku',
    list_price:       'sale_price',
    standard_price:   'cost_price',
    // Cross-dock model: supplier qty = available to order, not physical on-hand.
    // Pushed to Odoo's custom x_supplier_qty field, never to qty_available.
    qty_available:    'stock_qty',
    description_sale: 'description',
    // Image stored as URL, pushed to Odoo's custom x_image_url field.
    image_1920:       'image_url',
  };

  for (const mapping of mappings) {
    const rawValue = raw[mapping.supplier_field];
    if (rawValue !== undefined) {
      const internalKey = internalKeyMap[mapping.odoo_field] || mapping.odoo_field;
      product[internalKey] = rawValue;
    }
  }

  // Fallbacks for common field names
  // Note: XML parsed with attributeNamePrefix '@_', so TD Baltic fields come as @_TDPartNbr etc.
  if (!product.sku)        product.sku        = raw.sku || raw.ref || raw.code || raw.id || raw.elkoCode
                                               || raw['@_TDPartNbr'] || raw.TDPartNbr || '';
  if (!product.name)       product.name       = raw.name || raw.title || raw.product_name
                                               || raw['@_ProdDesc'] || raw.ProdDesc || 'Unknown';
  if (!product.cost_price) product.cost_price = parseFloat(raw.cost || raw.cost_price || raw.wholesale_price
                                               || raw['@_Price'] || raw.Price || 0);
  if (!product.sale_price) product.sale_price = parseFloat(raw.price || raw.sale_price || raw.list_price
                                               || raw['@_Price'] || raw.Price || 0);
  if (!product.stock_qty)  product.stock_qty  = parseInt(raw.qty || raw.stock || raw.quantity || raw.qty_available || raw.availableQty
                                               || raw['@_Stock'] || raw.Stock || 0, 10);
  if (!product.image_url)  product.image_url  = raw.image || raw.image_url || raw.img || raw.imageUrl || null;
  if (!product.category)   product.category   = raw._resolvedCategory || raw.category || raw.categ || raw.categoryName
                                               || raw['@_ClassCode'] || raw.ClassCode || null;
  if (!product.description) product.description = raw._descriptions || raw.description || raw.desc
                                               || raw._datasheetsData?.LongDesc || raw._datasheetsData?.ShortDesc || null;
  // Extract full datasheet data (TD Baltic IceCat format)
  if (raw._datasheetsData) {
    const ds = raw._datasheetsData;

    // --- Images: collect all ProductPicture URLs ---
    const imgUrls = [];
    for (const key of ['ProductPicture','ProductPicture1','ProductPicture2','ProductPicture3','ProductPicture4','ProductPicture5','ProductPicture6']) {
      const pic = ds[key];
      if (!pic) continue;
      const url = typeof pic === 'string' ? pic : (pic['#text'] || null);
      if (url && url.trim().startsWith('http')) imgUrls.push(url.trim());
    }
    if (!product.image_url && imgUrls.length)  product.image_url  = imgUrls[0];
    if (imgUrls.length > 1)                    product.images_all = imgUrls.join('|');

    // --- Description: prefer LongDesc, fall back to ShortDesc ---
    if (!product.description) {
      const long  = typeof ds.LongDesc  === 'string' ? ds.LongDesc.trim()  : '';
      const short = typeof ds.ShortDesc === 'string' ? ds.ShortDesc.trim() : '';
      product.description = long || short || null;
    }

    // --- Specs: extract all attributes with descr+value structure ---
    // Skip known non-attribute keys
    const SKIP_KEYS = new Set([
      'LongDesc','ShortDesc','ManufLogo','HighLights','ProductHighLights',
      'ProductPicture','ProductPicture1','ProductPicture2','ProductPicture3',
      'ProductPicture4','ProductPicture5','ProductPicture6',
      '@_TDPartNbr','TDPartNbr','ManufDatasheet','EUEnergyLabel',
      'Warrantyandmisc','Warranty','Productcondition',
    ]);
    const specs = {};
    for (const [key, val] of Object.entries(ds)) {
      if (SKIP_KEYS.has(key) || !val) continue;
      // IceCat attribute format: { descr: "Label", groupheading: "N", value: "..." }
      // OR { "#text": "...", "@_descr": "...", "@_groupheading": "N" }
      if (typeof val === 'object' && !Array.isArray(val)) {
        const label = val['@_descr'] || val.descr || key;
        const value = val['#text']   || val.value || null;
        const isHeader = (val['@_groupheading'] || val.groupheading) === 'Y';
        if (isHeader || !value || String(value).trim() === '') continue;
        specs[label] = String(value).trim();
      }
    }
    if (Object.keys(specs).length) product.specs = specs;
  }

  // TD Baltic extras — store for reference / Odoo push
  if (!product.brand)        product.brand        = raw['@_Manuf']           || raw.Manuf           || raw.brand    || null;
  if (!product.ean)          product.ean          = raw['@_Ean']             || raw.Ean             || raw.ean      || null;
  if (!product.subcategory)  product.subcategory  = raw['@_SubClassCode']    || raw.SubClassCode    || null;
  // Warranty: may be a string or an object {value: "24 months"}
  if (!product.warranty) {
    const w = raw['@_Warranty'] || raw.Warranty;
    product.warranty = w ? (typeof w === 'object' ? (w.value || w['#text'] || null) : String(w)) : null;
  }

  // Markup rules
  if (markupRules.length && product.cost_price) {
    const rule = markupRules.find(r =>
      r.category && product.category &&
      product.category.toLowerCase().includes(r.category.toLowerCase())
    ) || markupRules.find(r => !r.category);

    if (rule) {
      product.sale_price = parseFloat((product.cost_price * (1 + parseFloat(rule.markup_pct) / 100)).toFixed(2));
    }
  }

  return product;
}

// ── DISCOVER SUPPLIER ATTRIBUTES ────────────────────────────
// Scans top-level keys across all raw products. Counts how many products
// have each field non-null/non-empty, then upserts into supplier_attributes.
// Skips internal fields prefixed with _ and any key whose value is an object/array
// (we only want scalar fields per user preference — no nested paths).
async function discoverAttributes(supabase, supplierId, rawProducts) {
  if (!rawProducts.length) return;

  const SKIP = new Set(['_resolvedCategory','_descriptions','_stockData','_imageData',
    '_attributeData','_variationData']);

  const counts = {};
  for (const product of rawProducts) {
    for (const [key, val] of Object.entries(product)) {
      if (SKIP.has(key) || key.startsWith('_')) continue;
      if (val === null || val === undefined || val === '') continue;
      if (typeof val === 'object') continue;
      // Normalise @_FieldName → FieldName for display
      const displayKey = key.startsWith('@_') ? key.slice(2) : key;
      counts[displayKey] = (counts[displayKey] || 0) + 1;
    }
  }

  if (!Object.keys(counts).length) return;

  const rows = Object.entries(counts).map(([name, product_count]) => ({
    supplier_id: supplierId,
    name,
    product_count,
  }));

  await supabase.from('supplier_attributes')
    .upsert(rows, { onConflict: 'supplier_id,name', ignoreDuplicates: false });
}

// ── DISCOVER SUPPLIER CATEGORIES ────────────────────────────
// Parses the raw categories feed and upserts into supplier_categories.
// Handles both flat arrays, nested tree structures, and TD Baltic's
// Class/SubClass XML format (parsed as @_Code, @_Name attributes).
async function discoverCategories(supabase, supplierId, rawCategories) {
  if (!rawCategories.length) return;

  const flat = [];

  function extractCat(item, parentPath = '') {
    // TD Baltic XML: attributes come as @_Code, @_Name; children as SubClass array
    const id       = item['@_Code'] || item.id || item.categoryId || item.cat_id || item.code || null;
    const name     = item['@_Name'] || item.name || item.title || item.label || String(id) || 'Unknown';
    // TD Baltic SubClass, or generic children
    const children = item.SubClass  || item.children || item.subcategories || item.subCategories || [];
    const path     = parentPath ? `${parentPath} > ${name}` : name;

    flat.push({ external_id: id ? String(id) : null, path, name });

    const childArr = Array.isArray(children) ? children : [children];
    for (const child of childArr) {
      if (child && typeof child === 'object') extractCat(child, path);
    }
  }

  for (const item of rawCategories) extractCat(item);

  if (!flat.length) return;

  const rows = flat.map(c => ({
    supplier_id:   supplierId,
    external_id:   c.external_id,
    path:          c.path,
    name:          c.name,
    product_count: 0,
  }));

  await supabase.from('supplier_categories')
    .upsert(rows, { onConflict: 'supplier_id,path', ignoreDuplicates: false });
}

module.exports = { runSupplierSync };
