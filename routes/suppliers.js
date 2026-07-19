// ============================================================
//  SyncFlow — routes/suppliers.js  (v2 — multi-endpoint)
// ============================================================
const express    = require('express');
const router     = express.Router();
const syncEngine = require('../syncEngine');

// GET all suppliers — include endpoint count in response
router.get('/', async (req, res) => {
  const { data, error } = await req.sb
    .from('suppliers')
    .select('*, supplier_endpoints(id)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: error.message });

  const result = (data || []).map(s => ({
    ...s,
    endpoint_count: Array.isArray(s.supplier_endpoints) ? s.supplier_endpoints.length : 0,
    supplier_endpoints: undefined,
  }));

  res.json(result);
});

// GET one supplier with all its endpoints
router.get('/:id', async (req, res) => {
  const { data, error } = await req.sb
    .from('suppliers')
    .select('*, supplier_endpoints(*)')
    .eq('id', req.params.id)
    .single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// POST create supplier + endpoints in one transaction
router.post('/', async (req, res) => {
  const {
    name, sync_freq,
    auth_type, auth_username, auth_password,
    auth_key, auth_header_name, auth_extra,
    endpoints = [],
  } = req.body;

  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!endpoints.length) return res.status(400).json({ error: 'at least one endpoint is required' });
  if (!endpoints.find(e => e.role === 'products')) {
    return res.status(400).json({ error: 'a "products" endpoint is required' });
  }

  const supplierPayload = {
    name,
    sync_freq:        sync_freq || 30,
    auth_type:        auth_type || 'none',
    auth_username:    auth_username    || null,
    auth_password:    auth_password    || null,
    auth_key:         auth_key         || null,
    auth_header_name: auth_header_name || null,
    auth_extra:       auth_extra       || null,
    notes:            req.body.notes   || null,
  };

  const endpointPayload = endpoints.map((ep, i) => ({
    role:               ep.role,
    url_template:       ep.url_template,
    format:             ep.format             || 'json',
    is_parameterised:   ep.is_parameterised   || false,
    param_source_field: ep.param_source_field || null,
    sync_freq_minutes:  ep.sync_freq_minutes  || null,
    active:             true,
    sort_order:         i,
  }));

  const { data: result, error: rpcErr } = await req.sb.rpc('create_supplier_with_endpoints', {
    p_supplier:  supplierPayload,
    p_endpoints: endpointPayload,
  });

  if (rpcErr) return res.status(500).json({ error: rpcErr.message });

  const supplier = result;

  try { await req.sb.rpc('seed_default_mappings', { p_supplier_id: supplier.id }); } catch (_) {}

  await req.sb.from('activity_log').insert({
    type:        'config_change',
    title:       `Supplier added: ${name}`,
    detail:      `${endpointPayload.length} endpoint(s), auth: ${auth_type || 'none'} (atomic)`,
    supplier_id: supplier.id,
  });

  res.json(supplier);
});

// PUT update supplier metadata (auth, sync_freq etc.) — not endpoints
router.put('/:id', async (req, res) => {
  const { endpoints, ...supplierFields } = req.body;
  const { data, error } = await req.sb
    .from('suppliers')
    .update(supplierFields).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT replace all endpoints for a supplier
router.put('/:id/endpoints', async (req, res) => {
  const supplierId = parseInt(req.params.id);
  const { endpoints = [] } = req.body;

  await req.sb.from('supplier_endpoints').delete().eq('supplier_id', supplierId);

  if (endpoints.length) {
    const rows = endpoints.map((ep, i) => ({
      supplier_id:        supplierId,
      role:               ep.role,
      label:              ep.label              || null,
      url_template:       ep.url_template,
      format:             ep.format             || 'json',
      is_parameterised:   ep.is_parameterised   || false,
      param_source_field: ep.param_source_field || null,
      sync_freq_minutes:  ep.sync_freq_minutes  || null,
      active:             ep.active !== false,
      sort_order:         i,
    }));
    const { error } = await req.sb.from('supplier_endpoints').insert(rows);
    if (error) return res.status(500).json({ error: error.message });
  }

  res.json({ success: true, count: endpoints.length });
});

// DELETE supplier (cascades to endpoints, products, etc.)
router.delete('/:id', async (req, res) => {
  const { error } = await req.sb.from('suppliers').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST trigger manual sync for one supplier
router.post('/:id/sync', async (req, res) => {
  const { data: supplier, error } = await req.sb
    .from('suppliers')
    .select('*, supplier_endpoints(*)')
    .eq('id', req.params.id)
    .single();
  if (error || !supplier) return res.status(404).json({ error: 'Supplier not found' });

  if (supplier.is_syncing) {
    return res.status(409).json({ error: `${supplier.name} is already syncing — wait for it to finish before triggering another run.` });
  }

  // Acquire the same distributed lock the cron scheduler uses. Without
  // this, this route never set is_syncing, so the cron job (which checks
  // is_syncing before launching) couldn't see a manual sync in progress —
  // it would happily start a SECOND, fully concurrent sync on its next
  // tick, both racing to upsert the same rows and causing Supabase
  // statement-timeout errors from lock contention.
  const { error: lockErr } = await req.sb
    .from('suppliers')
    .update({ is_syncing: true, last_sync: new Date() })
    .eq('id', supplier.id)
    .eq('is_syncing', false); // conditional — avoids a race with a cron tick firing at the same instant

  if (lockErr) {
    return res.status(500).json({ error: `Could not lock ${supplier.name} for sync: ${lockErr.message}` });
  }

  // Mark as manual so syncEngine bypasses the per-endpoint frequency gate
  supplier._force = true;
  supplier.is_syncing = true;
  syncEngine.runSupplierSync(req.sb, supplier)
    .catch(console.error)
    .finally(async () => {
      await req.sb.from('suppliers').update({ is_syncing: false }).eq('id', supplier.id);
    });

  res.json({ message: `Sync started for ${supplier.name}` });
});

module.exports = router;
