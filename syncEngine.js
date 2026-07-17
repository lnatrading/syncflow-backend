// ============================================================
//  SyncFlow — syncEngine.js  (v3 — scale-ready)
// ============================================================
const axios       = require('axios');
const { XMLParser } = require('fast-xml-parser');
const { parse: csvParse } = require('csv-parse/sync');
const odooClient  = require('./odooClient');
const { loadFilterTree, evaluateProduct, getFilterBreakdown } = require('./filterEngine');
const versionResolver = require('./apiVersionResolver');
const { withRetry, sleep } = require('./retry');

// ── CHUNK SIZES ───────────────────────────────────────────────
// Supabase upsert: 500 rows — good balance of throughput vs payload size.
// At 500k SKUs this means 1000 DB round-trips total — acceptable.
// Odoo XML-RPC: 100 per call — Odoo rejects larger payloads.
// Odoo concurrency: 5 parallel batches — saturates Odoo without overloading.
const SUPABASE_CHUNK = 100; // Reduced from 500 — Supabase free/small plans hit statement
                             // timeouts on large upserts when the products table is big.
                             // 100 rows/chunk with a small delay keeps each statement fast.
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

    // ── PER-ENDPOINT FREQUENCY CHECK ─────────────────────────────
    // Endpoints can opt into their own minimum interval via sync_freq_minutes.
    // Used by suppliers like Mediamax that publish a heavy daily catalog feed
    // plus a lightweight fast feed for stock/price updates every 30 min.
    //
    // If the main 'products' endpoint isn't due yet AND a 'fast_update'
    // endpoint exists, run the lightweight stock+price refresh instead of
    // pulling the full catalog. This respects supplier infrastructure limits.
    const productsEndpoint   = endpoints.find(e => e.role === 'products');
    const fastUpdateEndpoint = endpoints.find(e => e.role === 'fast_update');

    if (!productsEndpoint) throw new Error('No endpoint with role "products" found.');

    const productsDue = isEndpointDue(productsEndpoint);
    // Manual syncs (force=true) always run the full products fetch —
    // the frequency gate only applies to scheduled/cron-triggered syncs.
    const force = supplier._force === true;
    if (!productsDue && !force && fastUpdateEndpoint) {
      console.log(`[SYNC] ${supplier.name} — products endpoint not due (sync_freq_minutes=${productsEndpoint.sync_freq_minutes}, last_synced_at=${productsEndpoint.last_synced_at}). Running fast update only.`);
      await runFastUpdate(supabase, supplier, fastUpdateEndpoint, auth, jobId, activeVersion);
      return;
    }
    if (force && !productsDue) {
      console.log(`[SYNC] ${supplier.name} — manual sync: forcing full products fetch (ignoring frequency gate).`);
    }

    // 2. Fetch the products endpoint (always required, role = 'products')

    // Apply version endpoint override if present
    const productsUrl = versionResolver.resolveEndpointUrl(productsEndpoint, activeVersion);
    console.log(`[SYNC] ${supplier.name} — fetching products: ${productsUrl}`);
    let rawProducts = await fetchEndpoint(productsUrl, productsEndpoint.format, auth);
    console.log(`[SYNC] ${supplier.name} — parsed ${rawProducts.length} product record(s)`);
    if (rawProducts.length === 0) {
      console.warn(`[SYNC] ${supplier.name} — 0 records after parsing. Check that the feed URL returns actual data (not an empty/placeholder file).`);
    } else {
      console.log(`[SYNC] ${supplier.name} — sample record keys: ${JSON.stringify(Object.keys(rawProducts[0]))}`);
    }

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
      // Per-endpoint frequency check:
      // If sync_freq_minutes is set, only fetch when its own schedule is due.
      // This allows a "catalog" endpoint to run once a day while the "products"
      // fast feed runs every 30 min on the parent supplier's schedule.
      if (ep.sync_freq_minutes > 0) {
        const lastFetched = ep.last_synced_at ? new Date(ep.last_synced_at).getTime() : 0;
        const freqMs      = ep.sync_freq_minutes * 60 * 1000;
        if ((Date.now() - lastFetched) < freqMs) {
          console.log(`[SYNC] ${supplier.name} — skipping ${ep.role} endpoint (not due yet, freq=${ep.sync_freq_minutes}min)`);
          continue;
        }
      }
      console.log(`[SYNC] ${supplier.name} — fetching ${ep.role}`);
      const epUrl = versionResolver.resolveEndpointUrl(ep, activeVersion);
      const data = await fetchEndpoint(epUrl, ep.format, auth)
        .catch(e => { console.warn(`[SYNC] ${ep.role} fetch failed:`, e.message); return []; });
      // Update last_synced_at so the per-endpoint frequency check works next run
      if (data.length > 0 && ep.sync_freq_minutes > 0) {
        try {
          await supabase.from('supplier_endpoints')
            .update({ last_synced_at: new Date() })
            .eq('id', ep.id);
        } catch (e) {
          console.warn(`[SYNC] Could not update last_synced_at for endpoint ${ep.id}:`, e.message);
        }
      }
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
    const { data: markupRules }   = await supabase.from('markup_rules').select('*')
      .eq('supplier_id', supplier.id);
    const { data: _shippingRaw } = await supabase.from('shipping_tiers').select('*')
      .eq('supplier_id', supplier.id).order('priority');
    const shippingTiers = _shippingRaw || [];

    // 6. Normalise all products
    let normalised = rawProducts.map(raw =>
      normaliseProduct(raw, mappings || [], markupRules || [], shippingTiers || [])
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
          // Count total subcategories
          let totalSubs = 0;
          for (const cls of classArr) {
            const subs = cls.SubClass || [];
            totalSubs += Array.isArray(subs) ? subs.length : 1;
          }
          console.log(`[SYNC] Categories: ${totalSubs} total subcategories across all classes`);
          // Log first class to verify structure
          console.log(`[SYNC] First class sample: ${JSON.stringify(classArr[0]).slice(0,200)}`);
          await discoverCategories(supabase, supplier.id, classArr);
        }
      } catch(e) {
        console.warn('[SYNC] Categories fetch failed:', e.message);
      }
    }

    // 6c. Update category product counts — runs AFTER discoverCategories to avoid being overwritten
    if (normalised.length > 0) {
      try {
        const catCounts = {};
        for (const p of normalised) {
          if (p.category) catCounts[p.category] = (catCounts[p.category] || 0) + 1;
        }
        const { data: existingCats } = await supabase.from('supplier_categories')
          .select('id, name, external_id').eq('supplier_id', supplier.id);
        if (existingCats) {
          const catCountsLower = {};
          for (const [k,v] of Object.entries(catCounts)) catCountsLower[k.toLowerCase()] = v;
          let updated = 0;
          const BATCH = 50;
          for (let i = 0; i < existingCats.length; i += BATCH) {
            const batch = existingCats.slice(i, i + BATCH);
            await Promise.all(batch.map(cat => {
              const count = catCounts[cat.name] || catCounts[cat.external_id]
                         || catCountsLower[cat.name?.toLowerCase()] || catCountsLower[cat.external_id?.toLowerCase()]
                         || 0;
              if (count > 0) updated++;
              return supabase.from('supplier_categories')
                .update({ product_count: count }).eq('id', cat.id);
            }));
          }
          console.log(`[SYNC] Category counts updated: ${updated}/${existingCats.length} with product counts`);
        }
      } catch(e) { console.warn('[SYNC] Category count update failed:', e.message); }
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

    // 8c. Detect absent products — in DB with stock > 0 but missing from current feed
    // If missing for > 24 hours → zero stock in Supabase + Odoo
    try {
      const syncedSkus = new Set(normalised.map(p => p.sku).filter(Boolean));
      const { data: dbProducts } = await supabase
        .from('products')
        .select('id, sku, stock_qty, last_synced')
        .eq('supplier_id', supplier.id)
        .gt('stock_qty', 0);

      if (dbProducts?.length) {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const absentIds  = [];
        const absentSkus = [];

        for (const dbProd of dbProducts) {
          if (!syncedSkus.has(dbProd.sku)) {
            const lastSeen = dbProd.last_synced ? new Date(dbProd.last_synced) : null;
            if (!lastSeen || lastSeen < cutoff) {
              absentIds.push(dbProd.id);
              absentSkus.push(dbProd.sku);
            }
          }
        }

        if (absentIds.length) {
          await supabase.from('products')
            .update({ stock_qty: 0, status: 'outofstock' })
            .in('id', absentIds);
          console.log(`[SYNC] ${supplier.name} — ${absentIds.length} absent products zeroed (24h+ missing): ${absentSkus.slice(0,5).join(', ')}${absentIds.length > 5 ? '...' : ''}`);

          // Push zero stock to Odoo for each absent SKU
          if (odooConfig?.url) {
            try {
              const odooClient = require('./odooClient');
              // Build minimal update payloads — only update x_supplier_qty
              const absentPayloads = absentSkus.map(sku => ({
                sku, name: sku, stock_qty: 0,
                sale_price: null, cost_price: null,
                _absent: true, // flag to skip non-stock fields
              }));
              await odooClient.upsertBatch(odooConfig, absentPayloads);
              console.log(`[SYNC] Zeroed Odoo stock for ${absentIds.length} absent products`);
            } catch(e) {
              console.warn(`[SYNC] Odoo absent stock push failed: ${e.message}`);
            }
          }
        }
      }
    } catch(e) {
      console.warn(`[SYNC] Absent product detection failed: ${e.message}`);
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
      // Debug shipping
      const _sampleDims = extractDimensions(sample.specs);
      console.log(`[SYNC] Sample specs keys: ${sample.specs ? JSON.stringify(Object.keys(sample.specs).slice(0,8)) : 'null'}`);
      console.log(`[SYNC] Sample dims: ${JSON.stringify(_sampleDims)}`);
      const _classRules = shippingTiers.filter(r => r.rule_type === 'class' || !r.rule_type);
      const _rateRules  = shippingTiers.filter(r => r.rule_type === 'rate');
      console.log(`[SYNC] Shipping: ${_classRules.length} class rules, ${_rateRules.length} inbound rates`);
      if (_classRules.length > 0) {
        console.log(`[SYNC] First class rule: ${JSON.stringify(_classRules[0])}`);
      }
      if (shippingTiers.length && _sampleDims) {
        const _sr = applyShippingTiers(_sampleDims, shippingTiers);
        console.log(`[SYNC] Sample shipping result: class=${_sr.shippingClass}, cost=${_sr.shippingCost}`);
      }
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
        shipping_cost:  product.shipping_cost  || null,
        shipping_class: product.shipping_class || null,
        weight_kg:      product._dims?.weightKg  || null,
        width_cm:       product._dims?.widthCm   || null,
        height_cm:      product._dims?.heightCm  || null,
        depth_cm:       product._dims?.lengthCm  || null,
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

      // Small delay between chunks to avoid overwhelming Supabase with
      // concurrent write load — especially important for large catalogues
      // (12k+ products) that take many chunks to upsert.
      await new Promise(r => setTimeout(r, 200));

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
      // Diagnostic: show which specific rule is doing the blocking,
      // since the aggregate count alone doesn't say whether it's stock,
      // price, or shipping class that's filtering out most products.
      const breakdown = getFilterBreakdown(normalised, filterTree);
      for (const b of breakdown) {
        console.log(`[FILTER]   rule ${b.field} ${b.operator} ${JSON.stringify(b.value)} — fails ${b.failCount}, passes ${b.passCount}`);
      }
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

    // 12. Absent product detection
    //     Products missing from the supplier feed for > 24h get stock zeroed in Odoo.
    //     This prevents selling items that are no longer available.
    try {
      const currentSkus = new Set(normalised.map(p => p.sku).filter(Boolean));
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      // Find products that were last synced > 24h ago (absent from current feed)
      const { data: absentProducts } = await supabase
        .from('products')
        .select('id, sku, ean, name, stock_qty')
        .eq('supplier_id', supplier.id)
        .gt('stock_qty', 0)           // only ones still showing stock
        .lt('last_synced', cutoff);   // not updated in last 24h

      if (absentProducts?.length) {
        const absentFromFeed = absentProducts.filter(p => !currentSkus.has(p.sku));
        if (absentFromFeed.length) {
          console.log(`[SYNC] ${supplier.name} — ${absentFromFeed.length} products absent >24h, zeroing stock`);

          // Zero stock in Supabase
          const absentIds = absentFromFeed.map(p => p.id);
          await supabase.from('products')
            .update({ stock_qty: 0, status: 'outofstock' })
            .in('id', absentIds);

          // Zero stock in Odoo if connected
          if (odooConfig?.url && absentFromFeed.length) {
            try {
              const zeroProducts = absentFromFeed.map(p => ({
                ...p, stock_qty: 0, sale_price: p.sale_price, cost_price: p.cost_price,
              }));
              // Push in small batches — just updating x_supplier_qty to 0
              for (let i = 0; i < zeroProducts.length; i += 50) {
                const chunk = zeroProducts.slice(i, i + 50);
                await odooClient.upsertBatch(odooConfig, chunk).catch(e =>
                  console.warn(`[SYNC] Failed to zero absent products in Odoo:`, e.message)
                );
              }
              console.log(`[SYNC] Zeroed ${absentFromFeed.length} absent products in Odoo`);
            } catch(e) {
              console.warn(`[SYNC] Odoo absent product zero failed:`, e.message);
            }
          }

          await supabase.from('activity_log').insert({
            type:        'stock_zeroed',
            title:       `${absentFromFeed.length} products absent >24h — stock zeroed`,
            detail:      `Products absent from ${supplier.name} feed for over 24 hours. SKUs: ${absentFromFeed.slice(0,5).map(p => p.sku).join(', ')}${absentFromFeed.length > 5 ? '...' : ''}`,
            supplier_id: supplier.id,
          });
        }
      }
    } catch(e) {
      console.warn(`[SYNC] Absent product check failed:`, e.message);
    }

    // 13. Finalise
    // Mark products endpoint as fetched (used by per-endpoint frequency gating)
    if (productsEndpoint?.id) {
      await supabase.from('supplier_endpoints')
        .update({ last_synced_at: new Date() })
        .eq('id', productsEndpoint.id);
    }

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

// ── ENDPOINT FREQUENCY GATE ──────────────────────────────────
// Returns true if the endpoint is due for a fresh fetch:
//   • sync_freq_minutes is null/zero → always fetch (default behaviour)
//   • last_synced_at is null        → never fetched, always due
//   • elapsed >= sync_freq_minutes   → due
function isEndpointDue(endpoint) {
  if (!endpoint) return false;
  const freq = endpoint.sync_freq_minutes;
  if (!freq) return true;
  if (!endpoint.last_synced_at) return true;
  const elapsedMin = (Date.now() - new Date(endpoint.last_synced_at).getTime()) / 60000;
  return elapsedMin >= freq;
}

// ── FAST UPDATE MODE ─────────────────────────────────────────
// Lightweight stock + price refresh. Used when the main products
// endpoint isn't due yet but a fast_update endpoint is configured.
// Designed for supplier feed patterns like Mediamax:
//   • Complete catalog feed → heavy, daily
//   • Fast feed (SKU, price, qty, qty2) → light, every 15–30 min
//
// What it does:
//   • Fetches only the fast feed
//   • Applies markup rules to derive sale_price from cost_price
//   • Bulk-updates existing rows in products by SKU (NOT a full upsert)
//   • Pushes the stock/price changes to Odoo via the same upsertBatch path
//   • Skips: catalog/attribute discovery, parameterised endpoints, filters,
//     full upsert, full activity logging
//
// What it does NOT do:
//   • Add new SKUs (they appear on the next full catalog sync)
//   • Update name/desc/images/category (those come from the catalog)
async function runFastUpdate(supabase, supplier, endpoint, auth, jobId, activeVersion) {
  const startTs = Date.now();

  // 1. Fetch the fast feed
  const url = versionResolver.resolveEndpointUrl(endpoint, activeVersion);
  console.log(`[FAST-SYNC] ${supplier.name} — fetching ${url}`);
  let rawItems = await fetchEndpoint(url, endpoint.format, auth);
  rawItems = versionResolver.transformProducts(rawItems, activeVersion);

  if (!Array.isArray(rawItems) || !rawItems.length) {
    console.warn(`[FAST-SYNC] ${supplier.name} — empty feed, nothing to update`);
    await supabase.from('sync_jobs').update({
      status: 'success', products_total: 0, products_updated: 0,
      products_created: 0, products_errors: 0, finished_at: new Date(),
    }).eq('id', jobId);
    return;
  }

  // 2. Load existing products for this supplier (sku → row)
  const { data: existing } = await supabase
    .from('products')
    .select('id, sku, cost_price, sale_price, category, shipping_cost')
    .eq('supplier_id', supplier.id);
  const bySku = new Map((existing || []).map(p => [p.sku, p]));
  console.log(`[FAST-SYNC] ${supplier.name} — ${existing?.length || 0} known SKUs in DB, ${rawItems.length} in feed`);

  // 3. Load markup rules (so we can recompute sale_price)
  const { data: markupRules } = await supabase.from('markup_rules')
    .select('*').eq('supplier_id', supplier.id);

  // 4. Build incoming updates — only for SKUs we already know
  const incoming = [];     // for sanity check + Odoo push
  let unknownSkus = 0;
  for (const item of rawItems) {
    const sku = item.sku || item.SKU || item.ref || item.code;
    if (!sku) continue;
    const existingRow = bySku.get(String(sku));
    if (!existingRow) { unknownSkus++; continue; }

    const cost_price = parseFloat(item.price || item.cost || item.cost_price || 0);
    const stock_qty  = parseInt(item.qty || item.quantity || item.stock || 0, 10);

    // Apply markup rule (category-specific first, then default)
    let sale_price = cost_price;
    if (markupRules?.length && cost_price > 0) {
      const rule = markupRules.find(r =>
        r.category && existingRow.category &&
        existingRow.category.toLowerCase().includes(r.category.toLowerCase())
      ) || markupRules.find(r => !r.category);
      if (rule) sale_price = parseFloat((cost_price * (1 + parseFloat(rule.markup_pct) / 100)).toFixed(2));
    }
    // Preserve any baked-in inbound shipping cost from the last full sync
    if (existingRow.shipping_cost) sale_price = parseFloat((sale_price + existingRow.shipping_cost).toFixed(2));

    incoming.push({
      id:          existingRow.id,
      sku:         String(sku),
      cost_price,
      sale_price,
      stock_qty,
      status:      stock_qty <= 0 ? 'unavailable' : stock_qty <= 5 ? 'low' : 'active',
      // Forecast 24h availability (Mediamax qty2) — stored for visibility
      _qty2:       item.qty2 != null ? parseInt(item.qty2, 10) : null,
    });
  }

  if (unknownSkus > 0) {
    console.warn(`[FAST-SYNC] ${supplier.name} — ${unknownSkus} SKUs in feed not yet in DB (will be added on next full catalog sync)`);
  }

  // 5. Price sanity check — same thresholds as full sync
  const sanity = await checkPriceSanity(supabase, supplier.id,
    incoming.map(i => ({ sku: i.sku, cost_price: i.cost_price })));
  if (sanity.aborted) {
    const msg = `Fast update price sanity check FAILED for ${supplier.name}: ${sanity.affectedPct}% of products have price changes >${sanity.changeThreshold}% (${sanity.affected}/${sanity.checked}). Update aborted.`;
    console.error(`[FAST-SYNC] ${msg}`);
    await supabase.from('activity_log').insert({
      type: 'price_anomaly', title: '⚠ Fast update aborted — suspicious price changes',
      detail: msg, supplier_id: supplier.id,
    });
    await supabase.from('sync_jobs').update({
      status: 'error', error_message: msg, finished_at: new Date(),
      products_errors: incoming.length,
    }).eq('id', jobId);
    return;
  }

  // 6. Bulk-update Supabase rows (in chunks of 500)
  let updated = 0, errors = 0;
  for (let i = 0; i < incoming.length; i += SUPABASE_CHUNK) {
    const chunk = incoming.slice(i, i + SUPABASE_CHUNK);
    // Supabase has no true "update many by primary key in one call",
    // so we upsert with id present — fast enough at this batch size.
    const rows = chunk.map(c => ({
      id:          c.id,
      supplier_id: supplier.id,
      sku:         c.sku,
      cost_price:  c.cost_price,
      sale_price:  c.sale_price,
      stock_qty:   c.stock_qty,
      status:      c.status,
      last_synced: new Date(),
    }));
    const { error } = await supabase
      .from('products')
      .upsert(rows, { onConflict: 'id', ignoreDuplicates: false });
    if (error) {
      console.error('[FAST-SYNC] Supabase upsert error:', error.message);
      errors += chunk.length;
    } else {
      updated += chunk.length;
    }
  }

  // 7. Push stock + price changes to Odoo using existing upsertBatch path
  const { data: odooConfig } = await supabase.from('odoo_config').select('*').limit(1).single();
  let odooBatchErrors = 0;
  if (odooConfig?.url && incoming.length) {
    console.log(`[FAST-SYNC] ${supplier.name} — pushing ${incoming.length} stock/price updates to Odoo`);
    // Hydrate with the minimum payload odooClient.upsertBatch needs
    const skuToRow = new Map((existing || []).map(p => [p.sku, p]));
    const odooBatch = incoming.map(c => {
      const r = skuToRow.get(c.sku) || {};
      return {
        sku:        c.sku,
        name:       r.name || c.sku,
        cost_price: c.cost_price,
        sale_price: c.sale_price,
        stock_qty:  c.stock_qty,
      };
    });
    const batches = [];
    for (let i = 0; i < odooBatch.length; i += ODOO_CHUNK) {
      batches.push(odooBatch.slice(i, i + ODOO_CHUNK));
    }
    for (let i = 0; i < batches.length; i += ODOO_CONCURRENCY) {
      const window = batches.slice(i, i + ODOO_CONCURRENCY);
      const results = await Promise.allSettled(window.map((batch, wi) =>
        withRetry(() => odooClient.upsertBatch(odooConfig, batch),
          { maxAttempts: 3, baseDelayMs: 5000, multiplier: 3,
            label: `Odoo fast batch ${i + wi} (${batch.length} products)` })
      ));
      for (const r of results) {
        if (r.status === 'rejected') {
          odooBatchErrors++;
          console.error('[FAST-SYNC] Odoo batch failed:', r.reason?.message);
        }
      }
    }
  }

  // 8. Mark the fast endpoint as freshly fetched (used by isEndpointDue gating)
  if (endpoint.id) {
    await supabase.from('supplier_endpoints')
      .update({ last_synced_at: new Date() })
      .eq('id', endpoint.id);
  }

  // 9. Update supplier + sync_jobs status
  const finalStatus = errors > 0 && updated === 0 ? 'error' : errors > 0 ? 'partial' : 'success';
  await supabase.from('suppliers').update({
    last_sync: new Date(), last_status: finalStatus,
  }).eq('id', supplier.id);

  await supabase.from('sync_jobs').update({
    status:           finalStatus,
    products_total:   incoming.length,
    products_updated: updated,
    products_created: 0,
    products_errors:  errors,
    finished_at:      new Date(),
  }).eq('id', jobId);

  const elapsedSec = ((Date.now() - startTs) / 1000).toFixed(1);
  console.log(`[FAST-SYNC] ${supplier.name} — done in ${elapsedSec}s | ${updated} updated | ${unknownSkus} unknown | ${odooBatchErrors} Odoo batch errors`);

  await supabase.from('activity_log').insert({
    type:        'sync_complete',
    title:       `Fast update — ${supplier.name}`,
    detail:      `${updated} stock/price refreshes in ${elapsedSec}s${unknownSkus ? ` | ${unknownSkus} unknown SKUs (await full sync)` : ''}${odooBatchErrors ? ` | ${odooBatchErrors} Odoo batch errors` : ''}`,
    supplier_id: supplier.id,
  });
}

// ── FETCH A SINGLE ENDPOINT ──────────────────────────────────
async function fetchEndpoint(urlTemplate, format, auth, templateValues = {}) {
  // Substitute any {placeholder} tokens in the URL (parameterised endpoints)
  let url = urlTemplate.replace(/\{(\w+)\}/g, (_, key) =>
    encodeURIComponent(templateValues[key] ?? '')
  );

  const headers = { 'User-Agent': 'SyncFlow/1.0' };
  // 90s timeout — some supplier CSV feeds (e.g. Mediamax's full catalogue,
  // ~1.5MB+) can legitimately take 20-30s+ to generate/transfer, especially
  // from cloud-hosting IP ranges. 30s was too tight and caused false timeouts.
  const axiosOpts = { timeout: 90000, responseType: 'text', headers };

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

  // ── Mediamax paginated JSON catalogue ────────────────────────
  // GET /product/all?pag=N&max=50
  // Each page returns { code, data: [{ id, attributes:{...} }] }
  // We loop until a page returns fewer items than requested (last page),
  // flatten each item's `attributes` into the root, and return the full array.
  if (format === 'json_paged_mediamax') {
    const PAGE_SIZE = 50;
    const allItems  = [];
    let   page      = 1;
    let   hasMore   = true;

    while (hasMore) {
      const sep     = url.includes('?') ? '&' : '?';
      const pageUrl = `${url}${sep}pag=${page}&max=${PAGE_SIZE}`;

      const res = await withRetry(
        () => axios.get(pageUrl, axiosOpts),
        {
          maxAttempts: 3, baseDelayMs: 5000, multiplier: 3,
          label: `fetchEndpoint mediamax page ${page}`,
          onRetry: async (attempt, err) => {
            const status = err?.response?.status;
            if (status === 401 || status === 403) throw Object.assign(err, { noRetry: true });
          },
        }
      );

      let parsed;
      try { parsed = typeof res.data === 'string' ? JSON.parse(res.data) : res.data; }
      catch { break; }

      const items = parsed?.data || [];
      if (!Array.isArray(items) || items.length === 0) break;

      // Flatten: { id, attributes: { sku, name, price, ... } } → { id, sku, name, price, ... }
      for (const item of items) {
        allItems.push({ id: item.id, ...(item.attributes || {}), links: item.links });
      }

      // If we got fewer items than the page size, this was the last page
      hasMore = items.length >= PAGE_SIZE;
      page++;

      // Safety cap: max 500 pages = 25,000 products
      if (page > 500) {
        console.warn(`[SYNC] Mediamax fetchEndpoint: reached page safety cap (${page}). Stopping pagination.`);
        break;
      }
    }

    console.log(`[SYNC] Mediamax fetchEndpoint: fetched ${allItems.length} products across ${page - 1} page(s)`);
    return allItems;
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
    // Some servers (e.g. DCS) return "<!DOCTYPE html>" prefixed pages rather
    // than starting directly with "<html" — check for both.
    if (typeof raw === 'string') {
      const head = raw.trimStart().slice(0, 20).toLowerCase();
      if (head.startsWith('<html') || head.startsWith('<!doctype html')) {
        throw new Error('Supplier returned an HTML page instead of data — likely a gateway error or auth redirect. Check the endpoint URL and credentials.');
      }
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

    // DCS (and other EU suppliers): semicolon-separated CSV
    // Common in Danish/European feeds where comma is the decimal separator
    if (format === 'csv_semicolon') {
      return csvParse(raw, {
        columns:               true,
        skip_empty_lines:      true,
        trim:                  true,
        delimiter:             ';',
        relax_column_count:    true,
        skip_records_with_error: true,
      });
    }

    // Mediamax B2B feeds: pipe-separated, single-quote string delimiter
    // e.g. 'SKU'|'price'|'qty'|'qty2'
    if (format === 'csv_pipe') {
      // Try double-quote first (Mediamax "Feed de actualización lenta" uses "field"|"field")
      // then fall back to single-quote (Mediamax fast feeds use 'field'|'field')
      const firstLine = raw.split('\n')[0] || '';
      const quoteChar = firstLine.startsWith('"') ? '"' : "'";
      return csvParse(raw, {
        columns:           true,
        skip_empty_lines:  true,
        trim:              true,
        delimiter:         '|',
        quote:             quoteChar,
        relax_quotes:      true,
        skip_records_with_error: true,
      });
    }

    // ── ITscope tab-separated export ──────────────────────────
    // api.itscope.com/2.1/t/<token> returns a tab-delimited CSV
    // with a header row and no quoting. The token is embedded in
    // the URL — no separate auth header needed.
    if (format === 'csv_tab_itscope') {
      return csvParse(raw, {
        columns:               true,
        skip_empty_lines:      true,
        trim:                  true,
        delimiter:             '\t',
        relax_column_count:    true,
        skip_records_with_error: true,
      });
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

  // Build lookup by SKU (try common field names including TD Baltic TDPartNbr and Mediamax uppercase SKU)
  // Mediamax's EAN-lookup feed keys by sku_parent (the base SKU), not sku
  // (its own 'sku' column has a variant suffix like "_1"/"_2" for multiple
  // barcodes per parent — e.g. XIAREDBUDS8GR_1 / sku_parent: XIAREDBUDS8GR).
  // Group all rows per parent (arrays) so alternate barcodes aren't lost —
  // the first row is used as the primary match, the rest are kept as alts.
  const byId = {};
  for (const item of secondaryData) {
    const key = item.sku_parent || item.TDPartNbr || item['@_TDPartNbr'] || item.SKU || item.sku || item.ref || item.code || item.id || item.productId;
    if (key == null) continue;
    const k = String(key);
    if (!byId[k]) byId[k] = [];
    byId[k].push(item);
  }

  return products.map(p => {
    const key = p.TDPartNbr || p.SKU || p.sku || p.ref || p.code || p.id;
    const rows = key != null ? byId[String(key)] : null;
    if (!rows || !rows.length) return p;

    const match = rows[0];
    // Any additional rows sharing this key are alternates (e.g. a second
    // valid EAN/barcode for the same parent SKU) — kept, not discarded.
    const alts = rows.length > 1 ? rows.slice(1) : null;

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
      case 'catalog':
        // Catalog provides full product details (name, EAN, desc, images, category, brand).
        // Spread catalog fields as base, then let the fast feed's fresher stock/price win.
        // Normalise Mediamax's uppercase/spaced field names to lowercase.
        // eslint-disable-next-line no-case-declarations
        const normCat = {};
        for (const [k, v] of Object.entries(match)) {
          normCat[k.toLowerCase().replace(/\s+/g, '_')] = v;
        }
        return { ...normCat, ...p }; // p (fast feed) overrides catalog stock/price
      default:
        return alts
          ? { ...p, [`_${role}Data`]: match, [`_${role}DataAlts`]: alts }
          : { ...p, [`_${role}Data`]: match };
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

// ── UNIT NORMALISATION ───────────────────────────────────────
// Parses dimension/weight strings from any supplier format into
// standard units: cm for dimensions, kg for weight.
// Handles: "598 mm", "45 cm", "1.2 kg", "1200 g", "42.5kg", "598mm"
function parseUnit(str) {
  if (str === null || str === undefined) return null;
  const s = String(str).trim().toLowerCase();
  const num = parseFloat(s);
  if (isNaN(num)) return null;
  if (s.includes('mm'))  return { value: num / 10,    unit: 'cm' };
  if (s.includes('cm'))  return { value: num,          unit: 'cm' };
  if (s.includes('m') && !s.includes('mm') && !s.includes('cm')) return { value: num * 100, unit: 'cm' };
  if (s.includes('kg'))  return { value: num,          unit: 'kg' };
  if (s.includes(' g') || s.endsWith('g')) return { value: num / 1000, unit: 'kg' };
  if (s.includes('lb'))  return { value: num * 0.453592, unit: 'kg' };
  return { value: num, unit: 'raw' }; // unknown unit, return raw number
}

// Extract and normalise product dimensions from specs jsonb
// Returns { weightKg, lengthCm, widthCm, heightCm, volWeightKg } or null
function extractDimensions(specs) {
  if (!specs || typeof specs !== 'object') return null;

  // Common label variations across suppliers
  const weightLabels  = ['weight','Weight','Gewicht','Masa','waga'];
  const lengthLabels  = ['length','Length','depth','Depth','Tiefe','Länge'];
  const widthLabels   = ['width','Width','Breite','Szerokość'];
  const heightLabels  = ['height','Height','Höhe','Wysokość'];

  function findVal(labels) {
    for (const l of labels) {
      if (specs[l] !== undefined && specs[l] !== null && specs[l] !== '') {
        const parsed = parseUnit(specs[l]);
        if (parsed) return parsed.value * (parsed.unit === 'raw' ? 1 : 1);
        // Already normalized above — just return the normalized value
      }
    }
    return null;
  }

  // Normalize all values
  function findNorm(labels, targetUnit) {
    for (const l of labels) {
      const raw = specs[l];
      if (raw === undefined || raw === null || raw === '') continue;
      const p = parseUnit(raw);
      if (!p) continue;
      if (targetUnit === 'cm') {
        if (p.unit === 'cm')  return p.value;
        if (p.unit === 'raw') return p.value; // assume cm
      }
      if (targetUnit === 'kg') {
        if (p.unit === 'kg')  return p.value;
        if (p.unit === 'raw') return p.value; // assume kg
      }
      return p.value;
    }
    return null;
  }

  const weightKg = findNorm(weightLabels, 'kg');
  const lengthCm = findNorm(lengthLabels, 'cm');
  const widthCm  = findNorm(widthLabels,  'cm');
  const heightCm = findNorm(heightLabels, 'cm');

  if (!weightKg && !lengthCm) return null;

  // Volumetric weight: L × W × H / 5000 (standard courier formula)
  const volWeightKg = (lengthCm && widthCm && heightCm)
    ? (lengthCm * widthCm * heightCm) / 5000
    : null;

  // Longest side
  const longestSideCm = Math.max(lengthCm || 0, widthCm || 0, heightCm || 0) || null;

  return { weightKg, lengthCm, widthCm, heightCm, volWeightKg, longestSideCm };
}

// Evaluate a single condition against product dimensions
function evalShipCondition(cond, dims) {
  const fieldMap = {
    Weight:     dims.weightKg    || 0,
    Width:      dims.widthCm     || 0,
    Height:     dims.heightCm    || 0,
    Depth:      dims.lengthCm    || 0,
    vol_weight: dims.volWeightKg || 0,
  };
  const actual = fieldMap[cond.field];
  if (actual === undefined) return true;
  const v = parseFloat(cond.value);
  if (isNaN(v)) return true;
  switch (cond.operator) {
    case 'lt':  return actual <  v;
    case 'lte': return actual <= v;
    case 'gt':  return actual >  v;
    case 'gte': return actual >= v;
    case 'eq':  return actual === v;
    default:    return true;
  }
}

// Step 1: Classify product into a parcel class (XS/S/M/L/XL/etc.)
// Classification rules sorted by priority — first match wins
// Returns class label string or null if no match
function classifyParcel(dims, classRules) {
  if (!dims || !classRules || !classRules.length) return null;
  const sorted = [...classRules].sort((a, b) => (a.priority || 1) - (b.priority || 1));
  for (const rule of sorted) {
    const conditions = rule.conditions || [];
    if (!conditions.length) return rule.class_label || null; // catch-all
    const logicOp = (rule.logic_op || 'AND').toUpperCase();
    const results = conditions.map(c => evalShipCondition(c, dims));
    const matched = logicOp === 'OR' ? results.some(Boolean) : results.every(Boolean);
    if (matched) return rule.class_label || null;
  }
  return null;
}

// Step 2: Look up inbound shipping cost from class label + inbound rates table
function getInboundCost(classLabel, inboundRates) {
  if (!classLabel || !inboundRates || !inboundRates.length) return 0;
  const rate = inboundRates.find(r => r.class_label === classLabel);
  return rate ? Number(rate.cost) || 0 : 0;
}

// Combined: classify then cost — returns { shippingClass, shippingCost }
function applyShippingTiers(dims, rules) {
  if (!dims || !rules || !rules.length) return { shippingClass: null, shippingCost: 0 };

  // Separate classification rules from inbound rate rows
  const classRules   = rules.filter(r => r.rule_type === 'class' || !r.rule_type);
  const inboundRates = rules.filter(r => r.rule_type === 'rate');

  const shippingClass = classifyParcel(dims, classRules);
  const shippingCost  = getInboundCost(shippingClass, inboundRates);

  return { shippingClass, shippingCost };
}

// ── PRICING RULE HELPERS ─────────────────────────────────────
// Category filter: matches any category if the rule has none set.
function matchesCategoryFilter(product, rule) {
  if (!rule.category) return true;
  return !!(product.category && product.category.toLowerCase().includes(rule.category.toLowerCase()));
}

// Condition evaluation for the IF side of a pricing rule.
function matchesMarkupCondition(product, rule) {
  const field = rule.condition_field || 'always';
  if (field === 'always') return true;

  const op  = rule.condition_op || 'gt';
  const val = rule.condition_value;

  const raw = field === 'category'   ? product.category
            : field === 'cost_price' ? product.cost_price
            : field === 'stock_qty'  ? product.stock_qty
            : field === 'brand'      ? product.brand
            : field === 'name'       ? product.name
            : product[field];

  switch (op) {
    case 'gt':  return toNumSafe(raw) >  toNumSafe(val);
    case 'lt':  return toNumSafe(raw) <  toNumSafe(val);
    case 'gte': return toNumSafe(raw) >= toNumSafe(val);
    case 'lte': return toNumSafe(raw) <= toNumSafe(val);
    case 'eq': {
      const a = parseFloat(raw), b = parseFloat(val);
      if (!isNaN(a) && !isNaN(b)) return Math.abs(a - b) < 0.0001;
      return String(raw ?? '').toLowerCase() === String(val ?? '').toLowerCase();
    }
    case 'contains':
      return String(raw ?? '').toLowerCase().includes(String(val ?? '').toLowerCase());
    default:
      return true;
  }
}

function toNumSafe(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}

// Action evaluation for the THEN side of a pricing rule.
// action_value / markup_pct hold the numeric input depending on the field
// the UI wrote to (older rows use markup_pct even for non-% actions).
function applyPricingAction(product, rule) {
  const cost   = product.cost_price || 0;
  const action = rule.action_type || 'markup_pct';
  const value  = parseFloat(rule.markup_pct ?? rule.action_value ?? 0) || 0;

  let price;
  switch (action) {
    case 'markup_pct':
      price = cost * (1 + value / 100);
      break;
    case 'markup_fixed':
      price = cost + value;
      break;
    case 'set_price':
      price = value;
      break;
    case 'round_to': {
      // Round the current computed price (or cost, if none yet) up to the
      // nearest multiple of `value` — e.g. round_to 5 → nearest €5;
      // round_to 0.99 → psychological pricing (X9.99 style needs a
      // separate offset, this covers plain rounding).
      const base = product.sale_price || cost;
      const step = value > 0 ? value : 1;
      price = Math.ceil(base / step) * step;
      break;
    }
    default:
      price = cost * (1 + value / 100);
  }

  if (rule.shipping_add) price += parseFloat(rule.shipping_add) || 0;

  return parseFloat(price.toFixed(2));
}

function normaliseProduct(raw, mappings, markupRules, shippingTiers = []) {
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
  if (!product.sku)        product.sku        = raw.SKU || raw.sku || raw.ref || raw.code || raw.id || raw.elkoCode
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

  // ── ITscope export fields ─────────────────────────────────────
  // Tab-separated export from api.itscope.com/2.1/t/<token>
  // Fields: puid, ean, manufacturerSKU, manufacturerName, productName,
  //         price, stock, aggregatedStock, productTypeName, productTypeGroupName,
  //         imageHighRes1..5, image2..5, standardPdfDatasheet, shortDescription,
  //         longDescription, netWeight, netDimX/Y/Z, warrantyText,
  //         priceSupplierName, marketingText, keySellingPoints, deeplink
  if (!product.sku)         product.sku         = raw.manufacturerSKU  || raw.puid            || product.sku  || '';
  if (!product.name)        product.name        = raw.productName       || product.name        || 'Unknown';
  if (!product.ean)         product.ean         = raw.ean               || product.ean         || null;
  if (!product.brand)       product.brand       = raw.manufacturerName  || product.brand       || null;
  if (!product.category)    product.category    = raw.productTypeGroupName || raw.productTypeName || product.category || null;
  if (!product.subcategory) product.subcategory = raw.productTypeName   || product.subcategory || null;
  if (!product.cost_price || product.cost_price === 0) {
    product.cost_price = parseFloat(raw.price || raw.priceCalc || 0) || 0;
  }
  if (!product.stock_qty || product.stock_qty === 0) {
    product.stock_qty = parseInt(raw.stock || raw.aggregatedStock || 0, 10) || 0;
  }

  // Images: ITscope provides up to 5 hi-res images
  if (!product.image_url) {
    product.image_url = raw.imageHighRes1 || raw.imageThumb || null;
  }
  const itscopeImages = [raw.imageHighRes1, raw.image2, raw.image3, raw.image4, raw.image5]
    .filter(Boolean);
  if (itscopeImages.length > 1 && !product.images_all) {
    product.images_all = itscopeImages.join('|');
  }

  // Descriptions: prefer longDescription, fall back to shortDescription / marketingText
  if (!product.description) {
    product.description = raw.longDescription || raw.shortDescription || raw.marketingText || null;
  }

  // Specs: store useful fields for shipping tiers, Icecat enrichment, and BIGhub feed
  if (raw.netWeight || raw.netDimX || raw.warrantyText || raw.keySellingPoints || raw.standardPdfDatasheet) {
    product.specs = product.specs || {};
    if (raw.netWeight)            product.specs.weight          = raw.netWeight;
    if (raw.netDimX)              product.specs.width           = raw.netDimX;
    if (raw.netDimY)              product.specs.height          = raw.netDimY;
    if (raw.netDimZ)              product.specs.depth           = raw.netDimZ;
    if (raw.warrantyText)         product.specs.warranty        = raw.warrantyText;
    if (raw.keySellingPoints)     product.specs.key_features    = raw.keySellingPoints;
    if (raw.standardPdfDatasheet) product.specs.datasheet_url   = raw.standardPdfDatasheet;
    if (raw.deeplink)             product.specs.itscope_url     = raw.deeplink;
    if (raw.priceSupplierName)    product.specs.itscope_supplier = raw.priceSupplierName;
    if (raw.energyEfficiencyClass) product.specs.energy_class   = raw.energyEfficiencyClass;
  }

  // Mediamax "Clientes con Catálogo Ampliado por EAN" endpoint — configure
  // this secondary endpoint with role: 'other' in the Suppliers dashboard
  // (the dashboard's role dropdown has no dedicated 'ean' option, so
  // 'other' is the generic catch-all role to use here).
  // mergeEndpointData() attaches its matched row as raw._otherData (matched
  // on sku_parent, since that feed's own 'sku' has a variant suffix).
  if (!product.ean && raw._otherData?.ean) product.ean = raw._otherData.ean;

  // Alternate EANs — when the same parent SKU has more than one valid
  // barcode in the feed (e.g. regional variants), the extras are attached
  // as raw._otherDataAlts. Keep them for reference rather than discarding.
  if (Array.isArray(raw._otherDataAlts) && raw._otherDataAlts.length) {
    const altEans = raw._otherDataAlts
      .map(r => r.ean)
      .filter(e => e && e !== product.ean);
    if (altEans.length) {
      product.specs = product.specs || {};
      product.specs.alt_ean = altEans.join('|');
    }
  }

  // TD Baltic extras — store for reference / Odoo push
  if (!product.brand)        product.brand        = raw['@_Manuf']           || raw.Manuf           || raw.brand    || product.brand || null;
  if (!product.ean)          product.ean          = raw['@_Ean']             || raw.Ean             || raw.ean      || raw.EAN   || raw.first_ean || raw.EAN1 || product.ean || null;
  if (!product.subcategory)  product.subcategory  = raw['@_SubClassCode']    || raw.SubClassCode    || raw.product_type || product.subcategory || null;

  // ── Mediamax Complete Catalog fields ──────────────────────────────
  // image1…image5: up to 5 separate image columns (CSV feeds)
  if (!product.image_url) {
    product.image_url = raw.image1 || raw.image || raw.image_url || null;
  }
  const mmImages = [raw.image1, raw.image2, raw.image3, raw.image4, raw.image5]
    .filter(Boolean);
  if (mmImages.length > 1 && !product.images_all) {
    product.images_all = mmImages.join('|');
  }

  // short_description → description fallback (CSV feeds + JSON API)
  if (!product.description) {
    product.description = raw.short_description || raw.market_description || raw.description || null;
  }

  // Mediamax JSON API uses 'cost' for cost price and 'qty_available' for stock
  // Real "Feed de actualización lenta" uses precio_mediamax_b for cost price
  if (!product.cost_price && (raw.cost || raw.precio_mediamax_b)) {
    product.cost_price = parseFloat(raw.cost || raw.precio_mediamax_b) || null;
  }
  if (product.stock_qty == null && raw.qty_available != null) {
    product.stock_qty = parseInt(raw.qty_available, 10) || 0;
  }
  // Real feed uses 'quantity' as the stock field name
  if ((product.stock_qty == null || product.stock_qty === 0) && raw.quantity != null) {
    product.stock_qty = parseInt(raw.quantity, 10) || 0;
  }
  // Real feed uses tipo_producto for sub-category (final category level)
  if (!product.subcategory && raw.tipo_producto) {
    product.subcategory = raw.tipo_producto;
  }

  // weight → stored in specs so shipping tiers can use it
  if (raw.weight && !product.specs?.weight) {
    product.specs = product.specs || {};
    product.specs.weight = raw.weight;
  }

  // product_status (New / Open Box / Refurbished / Like New) + outlet flag
  // Real Mediamax "Feed de actualización lenta" uses estado_producto, not product_status
  if (raw.product_status || raw.estado_producto) {
    product.specs = product.specs || {};
    product.specs.product_status = raw.product_status || raw.estado_producto;
  }
  if (raw.outlet) {
    product.specs = product.specs || {};
    product.specs.outlet = raw.outlet;
  }

  // qty2 / qty_2 (Mediamax 24h forecast stock) — store for reference
  const qty2 = raw.qty2 ?? raw.qty_2;
  if (qty2 !== undefined) {
    product.specs = product.specs || {};
    product.specs.qty2_forecast = qty2;
  }

  // Mediamax deeplink + stock-status flag (Feed de actualización lenta)
  if (raw.link) {
    product.specs = product.specs || {};
    product.specs.mediamax_url = raw.link;
  }
  if (raw.is_in_stock !== undefined) {
    product.specs = product.specs || {};
    product.specs.is_in_stock = raw.is_in_stock;
  }

  // EPREL energy label fields (from single-product JSON endpoint)
  if (raw.eficiencia_energetica || raw.eprel_model_identifier) {
    product.specs = product.specs || {};
    if (raw.eficiencia_energetica)  product.specs.energy_class       = raw.eficiencia_energetica;
    if (raw.eprel_model_identifier) product.specs.eprel_model_id     = raw.eprel_model_identifier;
    if (raw.fiche_url)              product.specs.eprel_fiche_url    = raw.fiche_url;
    if (raw.label_url)              product.specs.eprel_label_url    = raw.label_url;
  }
  // Warranty: may be a string or an object {value: "24 months"}
  if (!product.warranty) {
    const w = raw['@_Warranty'] || raw.Warranty;
    product.warranty = w ? (typeof w === 'object' ? (w.value || w['#text'] || null) : String(w)) : null;
  }

  // ── PRICING RULES ENGINE ─────────────────────────────────────
  // Honors the full IF/THEN rule builder from the UI:
  //   condition_field ('always'|'category'|'cost_price'|'stock_qty'|'brand'|'name')
  //   condition_op     ('gt'|'lt'|'gte'|'lte'|'eq'|'contains')
  //   condition_value
  //   action_type      ('markup_pct'|'markup_fixed'|'set_price'|'round_to')
  //   markup_pct / action_value, shipping_add
  // Previously only `category` (plain substring) + `markup_pct` were read —
  // everything else saved fine in the UI but was silently ignored here.
  if (markupRules.length && product.cost_price) {
    const specificRule = markupRules.find(r =>
      (r.category || (r.condition_field && r.condition_field !== 'always')) &&
      matchesCategoryFilter(product, r) &&
      matchesMarkupCondition(product, r)
    );
    const fallbackRule = markupRules.find(r =>
      !r.category && (!r.condition_field || r.condition_field === 'always')
    );
    const rule = specificRule || fallbackRule;

    if (rule) {
      product.sale_price = applyPricingAction(product, rule);
    }
  }

  // Extract and store dimensions for filtering + shipping
  const _dims = extractDimensions(product.specs);
  if (_dims) product._dims = _dims; // store for upsert
  if (_dims && shippingTiers.length) {
    const { shippingClass, shippingCost } = applyShippingTiers(_dims, shippingTiers);
    if (shippingClass)  product.shipping_class = shippingClass;
    if (shippingCost > 0) {
      product.shipping_cost = parseFloat(shippingCost.toFixed(2));
      product.sale_price    = parseFloat((product.sale_price + shippingCost).toFixed(2));
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
    supplier_id: supplierId,
    external_id: c.external_id,
    path:        c.path,
    name:        c.name,
    // product_count intentionally omitted — updated separately after sync
    // ignoreDuplicates: true ensures existing counts are never overwritten
  }));

  await supabase.from('supplier_categories')
    .upsert(rows, { onConflict: 'supplier_id,path', ignoreDuplicates: true });
}

module.exports = { runSupplierSync };
