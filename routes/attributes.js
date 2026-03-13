// ============================================================
//  SyncFlow — routes/attributes.js
// ============================================================
const express = require('express');
const router  = express.Router();

// ── MY ATTRIBUTES ────────────────────────────────────────────

// GET all my attributes
router.get('/my', async (req, res) => {
  const { data, error } = await req.sb
    .from('my_attributes').select('*').order('label');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST create my attribute
router.post('/my', async (req, res) => {
  const { name, label, attr_type, options, unit } = req.body;
  if (!name || !label) return res.status(400).json({ error: 'name and label required' });
  const { data, error } = await req.sb.from('my_attributes')
    .insert({ name, label, attr_type: attr_type || 'select', options: options || null, unit: unit || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT update my attribute
router.put('/my/:id', async (req, res) => {
  const { data, error } = await req.sb.from('my_attributes')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE my attribute
router.delete('/my/:id', async (req, res) => {
  const { error } = await req.sb.from('my_attributes').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── SUPPLIER ATTRIBUTES ───────────────────────────────────────

// GET supplier attributes — optionally filtered by supplier_id
router.get('/supplier', async (req, res) => {
  let q = req.sb.from('supplier_attributes')
    .select('*, my_attributes(id,name,label,attr_type)')
    .order('product_count', { ascending: false });
  if (req.query.supplier_id) q = q.eq('supplier_id', req.query.supplier_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH map a supplier attribute to a my_attribute
router.patch('/supplier/:id/map', async (req, res) => {
  const { my_attribute_id } = req.body; // null = unmap
  const { data, error } = await req.sb.from('supplier_attributes')
    .update({ my_attribute_id: my_attribute_id || null })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
