// ============================================================
//  SyncFlow — routes/sync.js
// ============================================================
const express    = require('express');
const router     = express.Router();
const syncEngine = require('../syncEngine');

// GET recent sync jobs
router.get('/jobs', async (req, res) => {
  const { data, error } = await req.sb.from('sync_jobs')
    .select('*').order('started_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST trigger sync for ALL active suppliers
router.post('/all', async (req, res) => {
  const { data: suppliers } = await req.sb.from('suppliers').select('*').eq('active', true);
  if (!suppliers || suppliers.length === 0) return res.json({ message: 'No active suppliers' });

  suppliers.forEach(s => syncEngine.runSupplierSync(req.sb, s).catch(console.error));
  res.json({ message: `Sync started for ${suppliers.length} suppliers` });
});

module.exports = router;


// ============================================================
//  routes/odoo.js
// ============================================================
const odooRouter  = express.Router();
const odooClient  = require('../odooClient');

// GET odoo config
odooRouter.get('/config', async (req, res) => {
  const { data } = await req.sb.from('odoo_config').select('*').limit(1).single();
  // Never return api_key to client
  if (data) { const { api_key, ...safe } = data; return res.json(safe); }
  res.json(null);
});

// POST save/update odoo config
odooRouter.post('/config', async (req, res) => {
  const { url, database, username, api_key, auto_create, sync_images, sync_stock, price_only } = req.body;

  const { data: existing } = await req.sb.from('odoo_config').select('id').limit(1).single();

  const payload = { url, database, username, api_key, auto_create, sync_images, sync_stock, price_only, updated_at: new Date() };

  if (existing) {
    const { data, error } = await req.sb.from('odoo_config').update(payload).eq('id', existing.id).select().single();
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  }

  const { error } = await req.sb.from('odoo_config').insert(payload);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// POST test odoo connection
odooRouter.post('/test', async (req, res) => {
  const { url, database, username, api_key } = req.body;
  try {
    const result = await odooClient.testConnection({ url, database, username, api_key });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

module.exports = { syncRouter: router, odooRouter };


// ============================================================
//  routes/mappings.js
// ============================================================
const mappingsRouter = express.Router();

mappingsRouter.get('/', async (req, res) => {
  const { supplier_id } = req.query;
  let query = req.sb.from('field_mappings').select('*').order('id');
  if (supplier_id) query = query.eq('supplier_id', supplier_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

mappingsRouter.post('/', async (req, res) => {
  const { data, error } = await req.sb.from('field_mappings').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

mappingsRouter.put('/:id', async (req, res) => {
  const { data, error } = await req.sb.from('field_mappings').update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

mappingsRouter.delete('/:id', async (req, res) => {
  const { error } = await req.sb.from('field_mappings').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// Markup rules
mappingsRouter.get('/markup', async (req, res) => {
  const { supplier_id } = req.query;
  let query = req.sb.from('markup_rules').select('*');
  if (supplier_id) query = query.eq('supplier_id', supplier_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

mappingsRouter.post('/markup', async (req, res) => {
  const { data, error } = await req.sb.from('markup_rules').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

mappingsRouter.delete('/markup/:id', async (req, res) => {
  const { error } = await req.sb.from('markup_rules').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = { mappingsRouter };


// ============================================================
//  routes/activity.js
// ============================================================
const activityRouter = express.Router();

activityRouter.get('/', async (req, res) => {
  const { data, error } = await req.sb.from('activity_log')
    .select('*').order('created_at', { ascending: false }).limit(100);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

activityRouter.delete('/', async (req, res) => {
  const { error } = await req.sb.from('activity_log').delete().neq('id', 0);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

module.exports = { activityRouter };


// ============================================================
//  routes/dashboard.js
// ============================================================
const dashRouter = express.Router();

dashRouter.get('/', async (req, res) => {
  const [products, outofstock, recentJobs, activity] = await Promise.all([
    req.sb.from('products').select('id', { count: 'exact', head: true }),
    req.sb.from('products').select('id', { count: 'exact', head: true }).eq('status', 'outofstock'),
    req.sb.from('sync_jobs').select('*').order('started_at', { ascending: false }).limit(10),
    req.sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(8),
  ]);

  // Price updates in last 24h (products updated recently)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { count: priceUpdates } = await req.sb.from('products')
    .select('id', { count: 'exact', head: true })
    .gte('last_synced', since);

  // Error count from recent sync jobs
  const errorCount = (recentJobs.data || []).reduce((sum, j) => sum + (j.products_errors || 0), 0);

  res.json({
    total_products:  products.count    || 0,
    out_of_stock:    outofstock.count  || 0,
    price_updates:   priceUpdates      || 0,
    sync_errors:     errorCount,
    recent_jobs:     recentJobs.data   || [],
    activity:        activity.data     || [],
  });
});

module.exports = { dashRouter };
