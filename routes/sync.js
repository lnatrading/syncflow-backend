// ============================================================
//  SyncFlow — routes/sync.js
//  Manual sync triggers with is_syncing lock guards.
// ============================================================
const express    = require('express');
const router     = express.Router();
const syncEngine = require('../syncEngine');

// ── Helper: acquire lock + run sync ──────────────────────────
async function launchWithLock(supabase, supplier) {
  if (supplier.is_syncing) return { skipped: true, reason: 'already running' };

  const { error: lockErr } = await supabase
    .from('suppliers')
    .update({ is_syncing: true, last_sync: new Date() })
    .eq('id', supplier.id)
    .eq('is_syncing', false); // conditional update prevents race condition

  if (lockErr) return { skipped: true, reason: lockErr.message };

  syncEngine.runSupplierSync(supabase, supplier)
    .catch(err => console.error(`[MANUAL SYNC] Failed for ${supplier.name}:`, err.message))
    .finally(async () => {
      await supabase.from('suppliers').update({ is_syncing: false }).eq('id', supplier.id);
    });

  return { started: true };
}

// POST /api/sync/all — trigger all active suppliers
router.post('/all', async (req, res) => {
  try {
    const { data: suppliers } = await req.sb
      .from('suppliers')
      .select('*, supplier_endpoints(*)')
      .eq('active', true);

    if (!suppliers?.length) return res.json({ message: 'No active suppliers' });

    const results = await Promise.all(suppliers.map(s => launchWithLock(req.sb, s)));
    const started = results.filter(r => r.started).length;
    const skipped = results.filter(r => r.skipped).length;

    res.json({
      message: `Sync started for ${started} supplier(s)${skipped ? `, ${skipped} skipped (already running)` : ''}`
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/sync/:supplierId — trigger one supplier
router.post('/:supplierId', async (req, res) => {
  try {
    const { data: supplier } = await req.sb
      .from('suppliers')
      .select('*, supplier_endpoints(*)')
      .eq('id', req.params.supplierId)
      .single();

    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    if (!supplier.active) return res.status(400).json({ error: 'Supplier is not active' });

    const result = await launchWithLock(req.sb, supplier);
    if (result.skipped) {
      return res.status(409).json({
        message: `Sync already running for ${supplier.name} — skipped`,
        reason: result.reason,
      });
    }
    res.json({ message: `Sync started for ${supplier.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET sync jobs log
router.get('/jobs', async (req, res) => {
  const limit = parseInt(req.query.limit || 20);
  const { data, error } = await req.sb
    .from('sync_jobs').select('*')
    .order('started_at', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
