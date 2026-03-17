// ============================================================
//  SyncFlow — orderRouter.js
//  Routes incoming Odoo sale order lines to the correct
//  supplier(s) using "lowest price wins" logic.
//  Then places orders and stores results in Supabase.
// ============================================================
const ElkoClient    = require('./orderClients/ElkoClient');
const BigBuyClient  = require('./orderClients/BigBuyClient');
const MediamaxClient= require('./orderClients/MediamaxClient');
const TDBalticClient= require('./orderClients/TDBaltcClient');
const { withRetry } = require('./retry');

// ── RETRY SCHEDULE ─────────────────────────────────────────────
// How long to wait before re-attempting a failed placement.
// After MAX_ORDER_RETRIES attempts, the order becomes a dead letter.
const MAX_ORDER_RETRIES = 4;
const RETRY_DELAYS_MS   = [
  5  * 60 * 1000,   // After 1st failure: wait 5 min
  15 * 60 * 1000,   // After 2nd failure: wait 15 min
  60 * 60 * 1000,   // After 3rd failure: wait 1 hour
];
const retryAfterMs = count =>
  RETRY_DELAYS_MS[Math.min(count, RETRY_DELAYS_MS.length - 1)];

// ── CLIENT REGISTRY ───────────────────────────────────────────
// Maps supplier name (lowercase, partial match) → client module
const CLIENTS = [
  { match: ['elko'],            client: ElkoClient     },
  { match: ['bigbuy','big buy'],client: BigBuyClient   },
  { match: ['mediamax'],        client: MediamaxClient },
  { match: ['tdbaltic','td baltic','td_baltic'], client: TDBalticClient },
];

function getClient(supplierName) {
  const n = (supplierName || '').toLowerCase();
  for (const { match, client } of CLIENTS) {
    if (match.some(m => n.includes(m))) return client;
  }
  return null;
}

// ── MAIN ENTRY POINT ──────────────────────────────────────────
// Called from the webhook receiver and the Odoo poller.
// odooOrder shape:
// {
//   odoo_sale_ref:  "S00042",
//   odoo_sale_id:   1234,
//   lines: [{ sku, product_name, quantity, unit_price? }],
//   shipping_address: { name, street, city, zip, country, phone, email },
//   billing_address:  { ... same ... },
// }
async function routeAndPlace(supabase, odooOrder) {
  console.log(`[ROUTER] Processing order ${odooOrder.odoo_sale_ref} — ${odooOrder.lines?.length} lines`);

  // 1. Load warehouse address — suppliers always ship to warehouse (cross-dock model)
  const { data: warehouse } = await supabase
    .from('warehouse_config').select('*').eq('id', 1).single();

  if (!warehouse?.street) {
    const err = 'Warehouse address not configured. Go to Settings → Warehouse to set it up.';
    console.error('[ROUTER]', err);
    await supabase.from('odoo_incoming_orders').update({
      status: 'error', routing_error: err, processed_at: new Date(),
    }).eq('odoo_sale_ref', odooOrder.odoo_sale_ref);
    return { results: [], routingErrors: [err] };
  }

  const warehouseAddress = {
    name:    warehouse.company_name || warehouse.name || 'LNA Trading',
    street:  warehouse.street,
    city:    warehouse.city,
    zip:     warehouse.zip,
    country: warehouse.country_code || 'PL',
    phone:   warehouse.phone  || '',
    email:   warehouse.email  || '',
    vat:     warehouse.vat_number || '',
  };

  // Customer address stored for reference only — not sent to supplier
  const customerAddress = odooOrder.shipping_address || odooOrder.billing_address;

  // Mark as routing
  await supabase.from('odoo_incoming_orders')
    .update({ status: 'routing' })
    .eq('odoo_sale_ref', odooOrder.odoo_sale_ref);

  // 2. For each line: find cheapest supplier that carries the SKU
  const routingErrors = [];
  const supplierBuckets = {};  // supplierId → { supplier, lines[], fulfillment_model }

  for (const line of odooOrder.lines) {
    const { data: candidates } = await supabase
      .from('products')
      .select('supplier_id, cost_price, stock_qty, suppliers(id, name, active, fulfillment_model)')
      .eq('sku', line.sku)
      .gt('stock_qty', 0)
      .order('cost_price', { ascending: true })
      .limit(10);

    if (!candidates?.length) {
      routingErrors.push(`SKU ${line.sku}: no supplier has stock`);
      console.warn(`[ROUTER] No stock for SKU ${line.sku}`);
      continue;
    }

    // Pick cheapest supplier that has a known order client
    let chosen = null;
    for (const c of candidates) {
      if (!c.suppliers?.active) continue;
      const client = getClient(c.suppliers.name);
      if (client) { chosen = c; break; }
    }

    if (!chosen) {
      // Fallback: pick cheapest regardless of client (will error at placement)
      chosen = candidates[0];
      console.warn(`[ROUTER] SKU ${line.sku}: no API client for any supplier, using cheapest anyway`);
    }

    const sid = chosen.supplier_id;
    if (!supplierBuckets[sid]) {
      supplierBuckets[sid] = { supplier: chosen.suppliers, lines: [] };
    }
    supplierBuckets[sid].lines.push({
      ...line,
      unit_price: line.unit_price || chosen.cost_price,
    });
  }

  // 3. Create supplier_order rows and place each one (cross-dock: always ship to warehouse)
  const results = [];
  for (const [supplierId, bucket] of Object.entries(supplierBuckets)) {
    const result = await placeSingleSupplierOrder(supabase, {
      ...odooOrder,
      shipping_address: warehouseAddress,
      billing_address:  warehouseAddress,
      customer_address: customerAddress,
    }, supplierId, bucket);
    results.push(result);
  }

  // 4. Finalise incoming order status
  const hasErrors = routingErrors.length > 0 || results.some(r => r.status === 'error');
  const allOk     = !hasErrors && results.every(r => r.status === 'placed');

  await supabase.from('odoo_incoming_orders').update({
    status:        allOk ? 'routed' : hasErrors ? 'error' : 'partial',
    routing_error: routingErrors.join('; ') || null,
    processed_at:  new Date(),
  }).eq('odoo_sale_ref', odooOrder.odoo_sale_ref);

  console.log(`[ROUTER] Order ${odooOrder.odoo_sale_ref} done — ${results.length} supplier order(s), ${routingErrors.length} routing error(s)`);

  // Create Purchase Orders in Odoo for each supplier bucket (cross-dock model)
  // Done after placement so we have the supplier order refs
  try {
    const { data: odooConfig } = await supabase.from('odoo_config').select('*').limit(1).single();
    if (odooConfig?.url) {
      const odooClient = require('./odooClient');
      for (const result of results.filter(r => r.status === 'placed')) {
        try {
          const { poId, poName } = await odooClient.createPurchaseOrder(odooConfig, {
            odoo_sale_ref:    odooOrder.odoo_sale_ref,
            supplier_name:    result.supplierName || 'TD Baltic',
            lines:            result.lines || [],
            warehouse_address: warehouseAddress,
          });
          // Store PO id on the supplier_order row for later invoice linking
          if (poId && result.supplierOrderDbId) {
            await supabase.from('supplier_orders')
              .update({ odoo_po_id: poId, odoo_po_name: poName })
              .eq('id', result.supplierOrderDbId);
          }
          console.log(`[ROUTER] Odoo PO created: ${poName} for ${odooOrder.odoo_sale_ref}`);
        } catch(poErr) {
          console.warn(`[ROUTER] Failed to create Odoo PO for ${odooOrder.odoo_sale_ref}: ${poErr.message}`);
        }
      }
    }
  } catch(e) {
    console.warn(`[ROUTER] Odoo PO creation skipped: ${e.message}`);
  }

  return { results, routingErrors };
}

// ── PLACE ONE SUPPLIER ORDER ──────────────────────────────────
async function placeSingleSupplierOrder(supabase, odooOrder, supplierId, bucket) {
  const supplierName = bucket.supplier?.name || `Supplier #${supplierId}`;
  const client       = getClient(supplierName);

  // Insert pending row
  const { data: soRow } = await supabase.from('supplier_orders').insert({
    supplier_id:      supplierId,
    odoo_sale_ref:    odooOrder.odoo_sale_ref,
    odoo_sale_id:     odooOrder.odoo_sale_id || null,
    status:           'placing',
    placement_request:{ lines: bucket.lines, addresses: { shipping: odooOrder.shipping_address, billing: odooOrder.billing_address } },
  }).select().single();

  // Insert order lines
  await supabase.from('supplier_order_lines').insert(
    bucket.lines.map(l => ({
      supplier_order_id: soRow.id,
      sku:               l.sku,
      product_name:      l.product_name || null,
      quantity:          l.quantity,
      unit_price:        l.unit_price   || null,
      line_total:        l.unit_price   ? l.unit_price * l.quantity : null,
    }))
  );

  if (!client) {
    await supabase.from('supplier_orders').update({
      status:     'error',
      last_error: `No order API client configured for supplier "${supplierName}"`,
      updated_at: new Date(),
    }).eq('id', soRow.id);
    return { supplierId, supplierName, status: 'error' };
  }

  // Place the order — with immediate in-call retry (3 attempts, 5s/15s backoff)
  // This handles transient network blips at placement time.
  // Longer-horizon retries (5 min, 15 min, 1 hr) are handled by retryFailedOrders().
  try {
    const placed = await withRetry(
      () => client.placeOrder({ ...odooOrder, lines: bucket.lines }),
      {
        maxAttempts: 3,
        baseDelayMs: 5000,
        multiplier:  3,
        label: `placeOrder(${supplierName}, ${odooOrder.odoo_sale_ref})`,
      }
    );

    await supabase.from('supplier_orders').update({
      status:             'placed',
      supplier_order_ref: placed.supplierOrderRef,
      supplier_order_id:  placed.supplierOrderId,
      subtotal:           placed.subtotal,
      shipping_cost:      placed.shipping,
      total:              placed.total,
      placement_response: placed.raw,
      retry_after:        null,  // clear any previous retry schedule
      updated_at:         new Date(),
    }).eq('id', soRow.id);

    await supabase.from('activity_log').insert({
      type:        'order_placed',
      title:       `Order placed — ${supplierName}`,
      detail:      `Odoo: ${odooOrder.odoo_sale_ref} → Supplier ref: ${placed.supplierOrderRef} (${bucket.lines.length} line(s))`,
      supplier_id: supplierId,
    });

    console.log(`[ROUTER] ✓ Placed with ${supplierName}: ref=${placed.supplierOrderRef}`);
    return { supplierId, supplierName, status: 'placed', ref: placed.supplierOrderRef };

  } catch (err) {
    const errMsg      = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    const newRetryCount = (soRow.retry_count || 0) + 1;
    const isDeadLetter  = newRetryCount >= MAX_ORDER_RETRIES;
    const retryAt       = isDeadLetter ? null : new Date(Date.now() + retryAfterMs(newRetryCount));

    console.error(`[ROUTER] ✗ Failed to place with ${supplierName} (attempt ${newRetryCount}/${MAX_ORDER_RETRIES}): ${errMsg}`);

    await supabase.from('supplier_orders').update({
      status:             'error',
      last_error:         errMsg,
      placement_response: err.response?.data || null,
      retry_count:        newRetryCount,
      retry_after:        retryAt,
      updated_at:         new Date(),
    }).eq('id', soRow.id);

    if (isDeadLetter) {
      // All retries exhausted — alert visibly on the dashboard
      await supabase.from('activity_log').insert({
        type:        'order_dead_letter',
        title:       `⚠ Order permanently failed — manual action required`,
        detail:      `Odoo: ${odooOrder.odoo_sale_ref} | Supplier: ${supplierName} | ${newRetryCount} attempts exhausted | Last error: ${errMsg}`,
        supplier_id: supplierId,
      });
      console.error(`[ROUTER] ☠ DEAD LETTER: ${odooOrder.odoo_sale_ref} — ${supplierName} — manual action required`);
    } else {
      await supabase.from('activity_log').insert({
        type:        'order_error',
        title:       `Order placement failed — will retry (${newRetryCount}/${MAX_ORDER_RETRIES})`,
        detail:      `Odoo: ${odooOrder.odoo_sale_ref} | ${supplierName} | Retry in ${retryAfterMs(newRetryCount) / 60000} min | Error: ${errMsg}`,
        supplier_id: supplierId,
      });
    }

    return { supplierId, supplierName, status: 'error', error: errMsg, isDeadLetter };
  }
}

// ============================================================
//  RETRY QUEUE — called by the tracking cron every 30 minutes
//  Finds orders in status=error with retry_after <= now
//  and re-attempts placement. Dead letters are skipped.
// ============================================================
async function retryFailedOrders(supabase) {
  const { data: retryable } = await supabase
    .from('supplier_orders')
    .select('*, supplier_order_lines(*)')
    .eq('status', 'error')
    .lt('retry_after', new Date().toISOString())   // retry_after has passed
    .lt('retry_count', MAX_ORDER_RETRIES)          // not yet a dead letter
    .not('retry_after', 'is', null)               // has a scheduled retry (not a no-client error)
    .order('retry_after', { ascending: true })
    .limit(20);                                    // process max 20 per cron tick

  if (!retryable?.length) return;

  console.log(`[RETRY QUEUE] ${retryable.length} order(s) due for retry`);

  for (const order of retryable) {
    // Reconstruct the odooOrder shape needed by placeSingleSupplierOrder
    const odooOrder = {
      odoo_sale_ref:    order.odoo_sale_ref,
      odoo_sale_id:     order.odoo_sale_id,
      shipping_address: order.placement_request?.addresses?.shipping,
      billing_address:  order.placement_request?.addresses?.billing,
    };

    // Load supplier for bucket reconstruction
    const { data: supplier } = await supabase
      .from('suppliers')
      .select('id, name')
      .eq('id', order.supplier_id)
      .single()
      .catch(() => ({ data: null }));

    if (!supplier) {
      console.warn(`[RETRY QUEUE] Supplier ${order.supplier_id} not found for order ${order.id}`);
      continue;
    }

    const bucket = {
      supplier,
      lines: (order.supplier_order_lines || []).map(l => ({
        sku:          l.sku,
        product_name: l.product_name,
        quantity:     l.quantity,
        unit_price:   l.unit_price,
      })),
    };

    console.log(`[RETRY QUEUE] Retrying order ${order.odoo_sale_ref} with ${supplier.name} (attempt ${order.retry_count + 1}/${MAX_ORDER_RETRIES})`);

    // Reset to 'placing' so UI shows it's being retried
    await supabase.from('supplier_orders')
      .update({ status: 'placing', retry_after: null, updated_at: new Date() })
      .eq('id', order.id);

    await placeSingleSupplierOrder(supabase, odooOrder, order.supplier_id, bucket);
  }
}

module.exports = { routeAndPlace, retryFailedOrders };
