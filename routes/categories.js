// ============================================================
//  SyncFlow — routes/categories.js
// ============================================================
const express = require('express');
const router  = express.Router();

// ── MY CATEGORIES ─────────────────────────────────────────────

router.get('/my', async (req, res) => {
  const { data, error } = await req.sb
    .from('my_categories').select('*').order('label');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/my', async (req, res) => {
  const { name, label } = req.body;
  if (!name || !label) return res.status(400).json({ error: 'name and label required' });
  const { data, error } = await req.sb.from('my_categories')
    .insert({ name, label }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/my/:id', async (req, res) => {
  const { data, error } = await req.sb.from('my_categories')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/my/:id', async (req, res) => {
  const { error } = await req.sb.from('my_categories').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── SUPPLIER CATEGORIES ───────────────────────────────────────

// GET supplier categories — filter by supplier_id, optional search
router.get('/supplier', async (req, res) => {
  let q = req.sb.from('supplier_categories')
    .select('*, my_categories(id,name,label)')
    .order('product_count', { ascending: false });
  if (req.query.supplier_id) q = q.eq('supplier_id', req.query.supplier_id);
  if (req.query.search)      q = q.ilike('path', `%${req.query.search}%`);
  if (req.query.unmapped === 'true') q = q.is('my_category_id', null);
  // Pagination
  const page  = parseInt(req.query.page  || 1);
  const limit = parseInt(req.query.limit || 50);
  q = q.range((page - 1) * limit, page * limit - 1);
  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count });
});

// PATCH map a supplier category to a my_category
router.patch('/supplier/:id/map', async (req, res) => {
  const { my_category_id } = req.body;
  const { data, error } = await req.sb.from('supplier_categories')
    .update({ my_category_id: my_category_id || null })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST bulk-map: apply one my_category to many supplier categories
router.post('/supplier/bulk-map', async (req, res) => {
  const { supplier_category_ids, my_category_id } = req.body;
  if (!supplier_category_ids?.length) return res.status(400).json({ error: 'supplier_category_ids required' });
  const { error } = await req.sb.from('supplier_categories')
    .update({ my_category_id: my_category_id || null })
    .in('id', supplier_category_ids);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, updated: supplier_category_ids.length });
});

module.exports = router;
