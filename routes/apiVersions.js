// ============================================================
//  SyncFlow — routes/apiVersions.js
//  Manage supplier API versions from the UI — no redeploy needed
// ============================================================
const express = require('express');
const router  = express.Router();

// GET all versions for a supplier
router.get('/supplier/:supplierId', async (req, res) => {
  const { data, error } = await req.sb
    .from('supplier_api_versions')
    .select('*')
    .eq('supplier_id', req.params.supplierId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET single version
router.get('/:id', async (req, res) => {
  const { data, error } = await req.sb
    .from('supplier_api_versions').select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// CREATE version
router.post('/', async (req, res) => {
  const { supplier_id, version_label, base_url, field_renames, endpoint_overrides, notes } = req.body;
  if (!supplier_id || !version_label) return res.status(400).json({ error: 'supplier_id and version_label required' });
  const { data, error } = await req.sb.from('supplier_api_versions').insert({
    supplier_id, version_label, base_url: base_url || null,
    field_renames:        field_renames       || {},
    endpoint_overrides:   endpoint_overrides  || {},
    notes: notes || null,
    is_active: false,
  }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// UPDATE version
router.put('/:id', async (req, res) => {
  const { version_label, base_url, field_renames, endpoint_overrides, notes } = req.body;
  const { data, error } = await req.sb.from('supplier_api_versions')
    .update({ version_label, base_url, field_renames, endpoint_overrides, notes, updated_at: new Date() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ACTIVATE a version (deactivates all others for that supplier)
router.post('/:id/activate', async (req, res) => {
  const { data: ver, error: fetchErr } = await req.sb
    .from('supplier_api_versions').select('supplier_id').eq('id', req.params.id).single();
  if (fetchErr) return res.status(404).json({ error: fetchErr.message });

  // Deactivate all versions for this supplier first
  await req.sb.from('supplier_api_versions')
    .update({ is_active: false })
    .eq('supplier_id', ver.supplier_id);

  // Activate the chosen one
  const { data, error } = await req.sb.from('supplier_api_versions')
    .update({ is_active: true, updated_at: new Date() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  await req.sb.from('activity_log').insert({
    type: 'api_version_changed',
    title: `API version activated — ${data.version_label}`,
    detail: `Supplier ID ${ver.supplier_id} now using version: ${data.version_label}`,
    supplier_id: ver.supplier_id,
  });

  res.json(data);
});

// DEACTIVATE (revert to default — no version override)
router.post('/:id/deactivate', async (req, res) => {
  const { data, error } = await req.sb.from('supplier_api_versions')
    .update({ is_active: false, updated_at: new Date() })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE version
router.delete('/:id', async (req, res) => {
  const { error } = await req.sb.from('supplier_api_versions').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ deleted: true });
});

module.exports = router;
