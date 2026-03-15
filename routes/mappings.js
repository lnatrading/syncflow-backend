const express = require('express');
const router  = express.Router();

// ── MARKUP RULES (must be before /:id to avoid conflict) ──────
router.get('/markup', async (req, res) => {
  let q = req.sb.from('markup_rules').select('*').order('created_at');
  if (req.query.supplier_id) q = q.eq('supplier_id', req.query.supplier_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/markup', async (req, res) => {
  const { data, error } = await req.sb.from('markup_rules').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/markup/:id', async (req, res) => {
  const { data, error } = await req.sb.from('markup_rules')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/markup/:id', async (req, res) => {
  const { error } = await req.sb.from('markup_rules').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── SHIPPING TIERS (must be before /:id to avoid conflict) ────
router.get('/shipping', async (req, res) => {
  let q = req.sb.from('shipping_tiers').select('*').order('priority');
  if (req.query.supplier_id) q = q.eq('supplier_id', req.query.supplier_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/shipping', async (req, res) => {
  const { data, error } = await req.sb.from('shipping_tiers').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.get('/shipping/:id', async (req, res) => {
  const { data, error } = await req.sb.from('shipping_tiers')
    .select('*').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

router.put('/shipping/:id', async (req, res) => {
  const { data, error } = await req.sb.from('shipping_tiers')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/shipping/:id', async (req, res) => {
  const { error } = await req.sb.from('shipping_tiers').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── FIELD MAPPINGS (generic /:id must be LAST) ────────────────
router.get('/', async (req, res) => {
  let q = req.sb.from('field_mappings').select('*').order('created_at');
  if (req.query.supplier_id) q = q.eq('supplier_id', req.query.supplier_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/', async (req, res) => {
  const { data, error } = await req.sb.from('field_mappings').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.put('/:id', async (req, res) => {
  const { data, error } = await req.sb.from('field_mappings')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.delete('/:id', async (req, res) => {
  const { error } = await req.sb.from('field_mappings').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = router;
