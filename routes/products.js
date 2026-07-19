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
//
// Deletes in small chunks rather than one giant DELETE statement —
// a single statement against thousands of rows was hitting Supabase's
// statement timeout, the same failure mode we saw on the sync upsert.
router.delete('/bulk/zero-stock', async (req, res) => {
  const supplierId = req.query.supplier_id || req.body?.supplier_id;
  const CHUNK = 300;
  let totalDeleted = 0;

  try {
    while (true) {
      let selQ = req.sb.from('products').select('id').lte('stock_qty', 0).limit(CHUNK);
      if (supplierId) selQ = selQ.eq('supplier_id', supplierId);
      const { data: rows, error: selErr } = await selQ;
      if (selErr) throw selErr;
      if (!rows || rows.length === 0) break;

      const ids = rows.map(r => r.id);
      const { error: delErr } = await req.sb.from('products').delete().in('id', ids);
      if (delErr) throw delErr;

      totalDeleted += ids.length;
      if (rows.length < CHUNK) break; // reached the last page

      // Small pause between chunks, same reasoning as the sync upsert —
      // avoids hammering Supabase with back-to-back write statements.
      await new Promise(r => setTimeout(r, 150));
    }
    res.json({ success: true, deleted: totalDeleted });
  } catch (err) {
    // Report partial progress — useful if a very large cleanup dies partway
    res.status(500).json({ error: err.message, deleted: totalDeleted });
  }
});

module.exports = router;
