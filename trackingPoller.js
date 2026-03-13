// ============================================================
//  SyncFlow — trackingPoller.js
//  Runs every 30 minutes (via cron in server.js).
//  Polls supplier APIs for tracking updates on "placed" orders,
//  then pushes tracking numbers back to Odoo.
// ============================================================
const ElkoClient     = require('./orderClients/ElkoClient');
const BigBuyClient   = require('./orderClients/BigBuyClient');
const MediamaxClient = require('./orderClients/MediamaxClient');
const TDBalticClient = require('./orderClients/TDBaltcClient');
const odooClient     = require('./odooClient');

const CLIENTS = [
  { match: ['elko'],                          client: ElkoClient     },
  { match: ['bigbuy','big buy'],              client: BigBuyClient   },
  { match: ['mediamax'],                      client: MediamaxClient },
  { match: ['tdbaltic','td baltic','td_baltic'], client: TDBalticClient },
];

function getClient(supplierName) {
  const n = (supplierName || '').toLowerCase();
  for (const { match, client } of CLIENTS) {
    if (match.some(m => n.includes(m))) return client;
  }
  return null;
}

// ── MAIN POLL FUNCTION ────────────────────────────────────────
async function pollTracking(supabase) {
  console.log('[TRACKING] Polling supplier orders for tracking updates...');

  // Fetch all "placed" orders (not yet shipped/delivered), max 50 at a time
  const { data: orders } = await supabase
    .from('supplier_orders')
    .select('*, suppliers(name)')
    .in('status', ['placed', 'shipped'])   // also re-check shipped (might become delivered)
    .lt('retry_count', 10)                  // give up after 10 failed polls
    .order('created_at', { ascending: true })
    .limit(50);

  if (!orders?.length) {
    console.log('[TRACKING] No orders to poll.');
    return;
  }

  console.log(`[TRACKING] Polling ${orders.length} orders...`);

  for (const order of orders) {
    await pollOne(supabase, order);
    await sleep(500); // be polite to supplier APIs
  }
}

async function pollOne(supabase, order) {
  const supplierName = order.suppliers?.name || '';
  const client       = getClient(supplierName);

  if (!client) {
    console.warn(`[TRACKING] No client for supplier "${supplierName}" — skipping`);
    return;
  }

  if (!order.supplier_order_ref) {
    console.warn(`[TRACKING] Order #${order.id} has no supplier_order_ref yet — skipping`);
    return;
  }

  try {
    const info = await client.getTracking(order.supplier_order_ref);

    const updates = {
      updated_at:     new Date(),
      last_tracked_at:new Date(),
    };

    let changed = false;

    if (info.status && info.status !== order.status) {
      updates.status = info.status;
      changed = true;
    }
    if (info.tracking_number && info.tracking_number !== order.tracking_number) {
      updates.tracking_number = info.tracking_number;
      updates.tracking_url    = info.tracking_url || order.tracking_url;
      updates.carrier         = info.carrier      || order.carrier;
      changed = true;
    }

    if (changed) {
      await supabase.from('supplier_orders').update(updates).eq('id', order.id);
      console.log(`[TRACKING] Updated order #${order.id} (${order.odoo_sale_ref}): status=${updates.status || order.status}, tracking=${updates.tracking_number || order.tracking_number}`);

      // Push tracking to Odoo if we have a tracking number
      if (updates.tracking_number) {
        await pushTrackingToOdoo(supabase, order, updates);
      }
    }

    // Reset retry count on success
    if (order.retry_count > 0) {
      await supabase.from('supplier_orders')
        .update({ retry_count: 0 }).eq('id', order.id);
    }

  } catch (err) {
    console.error(`[TRACKING] Error polling order #${order.id}: ${err.message}`);
    await supabase.from('supplier_orders').update({
      retry_count: (order.retry_count || 0) + 1,
      last_error:  err.message,
      updated_at:  new Date(),
    }).eq('id', order.id);
  }
}

// ── PUSH INBOUND TRACKING TO ODOO ────────────────────────────
// Cross-dock model: supplier ships to our warehouse.
// Tracking goes on the INCOMING stock.picking (receipt),
// linked to the purchase order — NOT the outgoing delivery.
// The outbound leg is handled manually in Odoo by the warehouse team.
async function pushTrackingToOdoo(supabase, order, updates) {
  try {
    const { data: config } = await supabase
      .from('odoo_config').select('*').limit(1).single();
    if (!config?.url) return;

    await odooClient.updateInboundTracking(config, {
      odoo_sale_ref:   order.odoo_sale_ref,
      tracking_number: updates.tracking_number,
      tracking_url:    updates.tracking_url,
      carrier:         updates.carrier,
    });

    console.log(`[TRACKING] Pushed inbound tracking to Odoo for ${order.odoo_sale_ref}: ${updates.tracking_number}`);

    await supabase.from('activity_log').insert({
      type:        'tracking_updated',
      title:       `Inbound tracking updated — ${order.odoo_sale_ref}`,
      detail:      `${updates.carrier || 'Carrier'}: ${updates.tracking_number} (supplier → warehouse)`,
      supplier_id: order.supplier_id,
    });

  } catch (err) {
    console.error(`[TRACKING] Failed to push inbound tracking to Odoo for ${order.odoo_sale_ref}: ${err.message}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { pollTracking };
