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

  // Group orders by supplier so we can use batch APIs where available
  const bySupplier = new Map();
  for (const order of orders) {
    const name = order.suppliers?.name || '';
    if (!bySupplier.has(name)) bySupplier.set(name, []);
    bySupplier.get(name).push(order);
  }

  for (const [supplierName, supplierOrders] of bySupplier) {
    const client = getClient(supplierName);
    if (!client) {
      console.warn(`[TRACKING] No client for supplier "${supplierName}" — skipping`);
      continue;
    }

    // Use batch polling if the client supports it (e.g. Mediamax)
    if (typeof client.getBatchTracking === 'function') {
      await pollBatch(supabase, supplierOrders, client);
    } else {
      for (const order of supplierOrders) {
        await pollOne(supabase, order);
        await sleep(500);
      }
    }
  }
}

// ── BATCH POLL (for suppliers that support bulk tracking queries) ──
async function pollBatch(supabase, orders, client) {
  const refs = orders
    .filter(o => o.supplier_order_ref)
    .map(o => o.supplier_order_ref);

  if (!refs.length) return;

  let batchResults;
  try {
    batchResults = await client.getBatchTracking(refs);
  } catch (err) {
    console.error(`[TRACKING] Batch poll failed: ${err.message} — falling back to one-by-one`);
    for (const order of orders) {
      await pollOne(supabase, order);
      await sleep(500);
    }
    return;
  }

  // Index results by supplierOrderRef for fast lookup
  const byRef = new Map(batchResults.map(r => [r.supplierOrderRef, r]));

  for (const order of orders) {
    if (!order.supplier_order_ref) continue;
    const info = byRef.get(order.supplier_order_ref);
    if (!info) continue;

    try {
      await applyTrackingUpdate(supabase, order, info, order.suppliers?.name || '');
    } catch (err) {
      console.error(`[TRACKING] Error applying batch update for order #${order.id}: ${err.message}`);
      await supabase.from('supplier_orders').update({
        retry_count: (order.retry_count || 0) + 1,
        last_error:  err.message,
        updated_at:  new Date(),
      }).eq('id', order.id);
    }
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
    await applyTrackingUpdate(supabase, order, info, supplierName);

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

// ── SHARED: APPLY A TRACKING UPDATE TO ONE ORDER ─────────────
async function applyTrackingUpdate(supabase, order, info, supplierName) {
  const updates = {
    updated_at:      new Date(),
    last_tracked_at: new Date(),
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

    // If order just shipped and is TD Baltic, fetch invoice
    if (updates.status === 'shipped' && supplierName.toLowerCase().includes('tdbaltic')) {
      await fetchInvoiceAndPushToOdoo(supabase, order, updates);
    }
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

// ── FETCH TD BALTIC INVOICE AND PUSH TO ODOO ──────────────────
// Called when a TD Baltic order status changes to "shipped".
// Fetches INVOIC from TD Baltic, then:
//   1. Creates a draft Vendor Bill in Odoo
//   2. Updates the inbound Receipt with waybill number
async function fetchInvoiceAndPushToOdoo(supabase, order, updates) {
  try {
    const { data: config } = await supabase
      .from('odoo_config').select('*').limit(1).single();
    if (!config?.url) return;

    // Fetch invoice from TD Baltic INVOIC endpoint
    const axios = require('axios');
    const { XMLParser } = require('fast-xml-parser');
    const parser = new XMLParser({
      ignoreAttributes: false, attributeNamePrefix: '@_',
      isArray: (name) => ['Invoice','Line','Parcel','Serial'].includes(name),
    });

    const invRes = await axios.get(
      'https://tdonline.tdbaltic.net/pls/PROD/ixml.invoic',
      {
        params: {
          orgnum:     '276054',
          username:   'ABAYOUMI-XML',
          pwd:        'CT04ct09ct1984*',
          origdocref: order.odoo_sale_ref,
        },
        timeout: 15000,
      }
    );

    const invParsed = parser.parse(invRes.data);
    const invoices  = invParsed?.InvoiceList?.Invoice || [];
    const inv       = Array.isArray(invoices) ? invoices[0] : invoices;

    if (!inv) {
      console.log(`[INVOICE] No invoice yet for ${order.odoo_sale_ref} — will retry on next poll`);
      return;
    }

    const head = inv.Head || {};
    const invoiceNumber = head.InvoiceNumber || order.odoo_sale_ref;
    const invoiceDate   = head.InvoiceDate
      ? `${head.InvoiceDate}`.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
      : null;

    // Extract lines and waybill
    const invLines = (inv.Body?.Line || []).map(l => ({
      item_id:     l.ItemID || '',
      description: l.ItemText || l.ItemID || '',
      qty:         parseFloat(l.Qty) || 1,
      price:       parseFloat(l.Price) || 0,
    }));

    // Waybill from first line
    const lineArr = Array.isArray(inv.Body?.Line) ? inv.Body.Line : [inv.Body?.Line].filter(Boolean);
    const firstLine = lineArr[0] || {};
    const waybill   = updates.tracking_number || firstLine.Waybill
      || (firstLine.ParcelList?.Parcel?.[0]) || null;

    // Get Odoo PO id if stored
    const odoo_po_id = order.odoo_po_id || null;

    // 1. Create vendor bill in Odoo
    await odooClient.createVendorBill(config, {
      odoo_sale_ref: order.odoo_sale_ref,
      odoo_po_id,
      invoice: {
        invoice_number: invoiceNumber,
        invoice_date:   invoiceDate,
        lines:          invLines,
        total:          parseFloat(head.InvoiceTotalAmount?.find?.(a => a['@_Type'] === 'Total')?.['#text'] || head.InvoiceTotalAmount) || 0,
      },
    });

    // 2. Update inbound receipt with waybill
    if (waybill) {
      await odooClient.createInboundReceipt(config, {
        odoo_sale_ref: order.odoo_sale_ref,
        odoo_po_id,
        waybill,
        carrier: 'TD Baltic',
        lines:   invLines,
      });
    }

    // Mark invoice as fetched on the order
    await supabase.from('supplier_orders')
      .update({ invoice_fetched: true, invoice_number: invoiceNumber })
      .eq('id', order.id);

    await supabase.from('activity_log').insert({
      type:        'invoice_created',
      title:       `Vendor bill created — ${order.odoo_sale_ref}`,
      detail:      `TD Baltic invoice ${invoiceNumber} imported to Odoo. Waybill: ${waybill || '—'}`,
      supplier_id: order.supplier_id,
    });

    console.log(`[INVOICE] Created vendor bill for ${order.odoo_sale_ref}, invoice ${invoiceNumber}, waybill ${waybill}`);

  } catch (err) {
    console.error(`[INVOICE] Failed to fetch/push invoice for ${order.odoo_sale_ref}: ${err.message}`);
  }
}

module.exports = { pollTracking };
