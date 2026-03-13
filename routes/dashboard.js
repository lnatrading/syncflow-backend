const express = require('express');
const router  = express.Router();

router.get('/', async (req, res) => {
  try {
    const [products, outOfStock, syncErrors, recentJobs, recentActivity] = await Promise.all([
      req.sb.from('products').select('id', { count: 'exact', head: true }),
      req.sb.from('products').select('id', { count: 'exact', head: true }).eq('status', 'unavailable'),
      req.sb.from('sync_jobs').select('id', { count: 'exact', head: true }).eq('status', 'error')
        .gte('started_at', new Date(Date.now() - 24*60*60*1000).toISOString()),
      req.sb.from('sync_jobs').select('*').order('started_at', { ascending: false }).limit(10),
      req.sb.from('activity_log').select('*').order('created_at', { ascending: false }).limit(20),
    ]);

    const priceUpdates = await req.sb.from('products').select('id', { count: 'exact', head: true })
      .gte('last_synced', new Date(Date.now() - 24*60*60*1000).toISOString());

    res.json({
      total_products: products.count || 0,
      price_updates:  priceUpdates.count || 0,
      out_of_stock:   outOfStock.count || 0,
      sync_errors:    syncErrors.count || 0,
      recent_jobs:    recentJobs.data || [],
      recent_activity: recentActivity.data || [],
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
