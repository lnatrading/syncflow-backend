const express = require('express');
const router  = express.Router();

router.get('/', async (req, res) => {
  const page   = parseInt(req.query.page  || 1);
  const limit  = parseInt(req.query.limit || 50);
  const search = req.query.search || '';
  const status = req.query.status || '';

  let q = req.sb.from('products')
    .select('*, suppliers(name)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (search)      q = q.or(`name.ilike.%${search}%,sku.ilike.%${search}%,ean.ilike.%${search}%`);
  if (status)      q = q.eq('status', status);
  if (req.query.supplier_id) q = q.eq('supplier_id', req.query.supplier_id);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, count, total: count, page, limit });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await req.sb.from('products')
    .select('*, suppliers(name)').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

// DELETE a single product — the frontend's ✕ button already calls this,
// but the route never existed on the backend until now.
router.delete('/:id', async (req, res) => {
  const { error } = await req.sb.from('products').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// DELETE all zero-stock products, optionally scoped to one supplier.
// Meant for one-off cleanup of the stale zero-stock rows that
// accumulated before we started skipping new zero-stock imports —
// existing zero-stock rows still get upserted normally by the sync
// engine, they just never get inserted fresh anymore.
router.delete('/bulk/zero-stock', async (req, res) => {
  const supplierId = req.query.supplier_id || req.body?.supplier_id;

  let q = req.sb.from('products').delete({ count: 'exact' }).lte('stock_qty', 0);
  if (supplierId) q = q.eq('supplier_id', supplierId);

  const { error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, deleted: count ?? 0 });
});

module.exports = router;
