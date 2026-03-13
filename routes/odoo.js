const express    = require('express');
const router     = express.Router();
const odooClient = require('../odooClient');

router.get('/config', async (req, res) => {
  const { data, error } = await req.sb.from('odoo_config').select('*').limit(1).single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json(data || {});
});

router.post('/config', async (req, res) => {
  const { url, database, username, api_key, auto_create, sync_images, sync_stock, price_only } = req.body;
  if (!url || !database || !username || !api_key)
    return res.status(400).json({ error: 'url, database, username, api_key required' });
  const { data: existing } = await req.sb.from('odoo_config').select('id').limit(1).single();
  let data, error;
  if (existing?.id) {
    ({ data, error } = await req.sb.from('odoo_config')
      .update({ url, database, username, api_key, auto_create, sync_images, sync_stock, price_only, updated_at: new Date() })
      .eq('id', existing.id).select().single());
  } else {
    ({ data, error } = await req.sb.from('odoo_config')
      .insert({ url, database, username, api_key, auto_create, sync_images, sync_stock, price_only })
      .select().single());
  }
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.post('/test', async (req, res) => {
  try {
    const { data: config } = await req.sb.from('odoo_config').select('*').limit(1).single();
    if (!config) return res.status(400).json({ error: 'No Odoo config saved yet' });
    const result = await odooClient.testConnection(config);
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
