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

  if (search) q = q.or(`name.ilike.%${search}%,sku.ilike.%${search}%`);
  if (status) q = q.eq('status', status);

  const { data, error, count } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ data, total: count, page, limit });
});

router.get('/:id', async (req, res) => {
  const { data, error } = await req.sb.from('products')
    .select('*, suppliers(name)').eq('id', req.params.id).single();
  if (error) return res.status(404).json({ error: error.message });
  res.json(data);
});

module.exports = router;
