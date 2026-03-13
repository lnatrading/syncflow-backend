// ============================================================
//  SyncFlow Backend — server.js
//  Express API + Cron sync scheduler
// ============================================================
const express = require('express');
const cors    = require('cors');
const cron    = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const syncEngine        = require('./syncEngine');
const odooClient        = require('./odooClient');
const { pollTracking }  = require('./trackingPoller');
const { retryFailedOrders } = require('./orderRouter');
const { requireApiKey } = require('./middleware/auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Supabase client (service role — bypasses RLS) ──────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
}));
app.options('*', cors()); // handle preflight requests for all routes
app.use(express.json());

// ── Attach supabase to every request ───────────────────────
app.use((req, _res, next) => { req.sb = supabase; next(); });

// ── PUBLIC: health check (no auth — Railway needs this) ────
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date() }));

// ── AUTH: protect all /api/* routes ───────────────────────
// Set SYNCFLOW_API_KEY in Railway environment variables.
// Without it, this middleware passes through (dev/unprotected mode).
app.use('/api', requireApiKey);

// ── ROUTES ─────────────────────────────────────────────────
app.use('/api/suppliers',  require('./routes/suppliers'));
app.use('/api/products',   require('./routes/products'));
app.use('/api/sync',       require('./routes/sync'));
app.use('/api/odoo',       require('./routes/odoo'));
app.use('/api/mappings',   require('./routes/mappings'));
app.use('/api/activity',   require('./routes/activity'));
app.use('/api/dashboard',  require('./routes/dashboard'));
app.use('/api/attributes', require('./routes/attributes'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/filters',    require('./routes/filters'));
app.use('/api/orders',      require('./routes/orders'));
app.use('/api/warehouse',   require('./routes/warehouse'));
app.use('/api/api-versions',require('./routes/apiVersions'));

// ── STARTUP: clear any stuck is_syncing locks from previous crashes
supabase.from('suppliers')
  .update({ is_syncing: false })
  .eq('is_syncing', true)
  .then(({ data, error }) => {
    if (error) console.warn('[STARTUP] Could not reset stuck sync locks:', error.message);
    else console.log('[STARTUP] Sync locks reset (crash recovery complete)');
  });

// ── CRON: run sync every minute — with distributed lock to prevent overlap
cron.schedule('* * * * *', async () => {
  try {
    // Fetch suppliers with their endpoints and lock status
    const { data: suppliers } = await supabase
      .from('suppliers')
      .select('*, supplier_endpoints(*)')
      .eq('active', true);

    if (!suppliers) return;

    const now = Date.now();
    for (const supplier of suppliers) {
      const lastSync = supplier.last_sync ? new Date(supplier.last_sync).getTime() : 0;
      const freqMs   = (supplier.sync_freq || 30) * 60 * 1000;

      // ── DISTRIBUTED LOCK CHECK ───────────────────────────
      // Skip if a sync is already running for this supplier.
      // is_syncing is set true BEFORE launch and false in the finally block.
      // This prevents overlap even at 500k SKUs where a single sync
      // can take 30-60 minutes — far longer than the 1-minute cron interval.
      if (supplier.is_syncing) {
        console.log(`[CRON] Skipping ${supplier.name} — sync already in progress`);
        continue;
      }

      if ((now - lastSync) >= freqMs) {
        console.log(`[CRON] Triggering sync for: ${supplier.name}`);

        // 1. Immediately lock + update last_sync in DB before launching.
        //    This prevents the next cron tick (1 min later) from also triggering.
        const { error: lockErr } = await supabase
          .from('suppliers')
          .update({ is_syncing: true, last_sync: new Date() })
          .eq('id', supplier.id)
          .eq('is_syncing', false); // conditional update — prevents race condition

        if (lockErr) {
          console.warn(`[CRON] Could not lock ${supplier.name}, skipping:`, lockErr.message);
          continue;
        }

        // 2. Launch sync — unlock in finally so it always runs even on error
        syncEngine.runSupplierSync(supabase, supplier)
          .catch(err => console.error(`[CRON] Sync failed for ${supplier.name}:`, err.message))
          .finally(async () => {
            await supabase
              .from('suppliers')
              .update({ is_syncing: false })
              .eq('id', supplier.id);
          });
      }
    }
  } catch (err) {
    console.error('[CRON] Error:', err.message);
  }
});

// ── CRON: poll supplier tracking every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  try {
    // Run tracking poll and retry queue concurrently — they are independent
    await Promise.allSettled([
      pollTracking(supabase),
      retryFailedOrders(supabase),
    ]);
  } catch (err) {
    console.error('[TRACKING CRON] Error:', err.message);
  }
});

app.listen(PORT, () => console.log(`SyncFlow backend running on port ${PORT}`));
