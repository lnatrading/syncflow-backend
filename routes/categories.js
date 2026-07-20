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

// ── CSV EXPORT / IMPORT (bulk mapping via spreadsheet) ─────────
// Lets you download every supplier category as a CSV, fill in the
// "my_category" column in Excel (much faster for granular, marketplace-
// commission-driven mapping than clicking through 50+ rows in the UI),
// and re-upload it to apply everything in one shot.
const { parse: csvParse } = require('csv-parse/sync');

router.get('/supplier/export', async (req, res) => {
  const supplierId = req.query.supplier_id;
  if (!supplierId) return res.status(400).json({ error: 'supplier_id required' });

  const { data, error } = await req.sb
    .from('supplier_categories')
    .select('id, path, product_count, my_categories(label)')
    .eq('supplier_id', supplierId)
    .order('product_count', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const escapeCsv = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = [['id', 'path', 'product_count', 'my_category']];
  for (const c of data || []) {
    rows.push([c.id, c.path, c.product_count ?? 0, c.my_categories?.label || '']);
  }
  const csv = rows.map(r => r.map(escapeCsv).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="categories_supplier_${supplierId}.csv"`);
  res.send(csv);
});

// POST bulk import — body: { supplier_id, csv_text, dry_run? }
// The 'id' column (from the exported template) is used to match rows
// reliably; falls back to matching by 'path' if a row has no id (e.g.
// a hand-built sheet rather than the downloaded template). Blank
// my_category cells are skipped (left unmapped), not cleared — clearing
// an existing mapping still requires the explicit unmap action in the UI.
// Typing a My Category name that doesn't exist yet auto-creates it.
//
// dry_run: true runs the exact same matching logic but writes nothing —
// used to show a preview (which categories would be newly created, how
// many rows would match) before committing, so a typo doesn't silently
// create a duplicate category.
router.post('/supplier/import', async (req, res) => {
  const { supplier_id, csv_text, dry_run } = req.body;
  if (!supplier_id || !csv_text) return res.status(400).json({ error: 'supplier_id and csv_text required' });

  let rows;
  try {
    rows = csvParse(csv_text, { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: `Could not parse CSV: ${e.message}` });
  }

  const { data: existingMyCats } = await req.sb.from('my_categories').select('id, name, label');
  const byLabel = new Map((existingMyCats || []).map(c => [c.label.toLowerCase().trim(), c.id]));

  // For dry runs we never write, so existence of the target supplier_category
  // row is checked against one prefetched set instead of a live UPDATE.
  let existingById = new Map(), existingByPath = new Map();
  if (dry_run) {
    const { data: supCats } = await req.sb.from('supplier_categories')
      .select('id, path').eq('supplier_id', supplier_id);
    for (const c of supCats || []) {
      existingById.set(String(c.id), c);
      existingByPath.set(c.path, c);
    }
  }

  let updated = 0, createdCategories = 0, skipped = 0, notFound = 0;
  const errors = [];
  const newCategoryNames = []; // dry run only
  const sample = [];           // dry run only — first few rows, for a human-readable preview
  const seenNewLabels = new Set();

  for (const row of rows) {
    const label = (row.my_category || '').trim();
    if (!label) { skipped++; continue; }

    let myCatId = byLabel.get(label.toLowerCase());
    const willCreate = !myCatId;

    if (willCreate) {
      if (dry_run) {
        if (!seenNewLabels.has(label.toLowerCase())) {
          seenNewLabels.add(label.toLowerCase());
          newCategoryNames.push(label);
        }
        myCatId = `__pending__${label.toLowerCase()}`; // placeholder so later rows reuse it, not re-flag as new
        byLabel.set(label.toLowerCase(), myCatId);
      } else {
        const name = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `cat_${Date.now()}`;
        const { data: newCat, error: createErr } = await req.sb.from('my_categories')
          .insert({ name, label }).select().single();
        if (createErr) {
          errors.push(`"${row.path || row.id}": could not create category "${label}": ${createErr.message}`);
          continue;
        }
        myCatId = newCat.id;
        byLabel.set(label.toLowerCase(), myCatId);
        createdCategories++;
      }
    }

    if (dry_run) {
      const exists = row.id ? existingById.has(String(row.id))
                    : row.path ? existingByPath.has(row.path)
                    : false;
      if (!row.id && !row.path) { skipped++; continue; }
      if (!exists) { notFound++; continue; }
      updated++;
      if (sample.length < 12) sample.push({ path: row.path, my_category: label, isNewCategory: willCreate });
      continue;
    }

    let updateQuery = req.sb.from('supplier_categories').update({ my_category_id: myCatId }).eq('supplier_id', supplier_id);
    if (row.id)        updateQuery = updateQuery.eq('id', row.id);
    else if (row.path) updateQuery = updateQuery.eq('path', row.path);
    else { skipped++; continue; }

    const { data: updRows, error: updErr } = await updateQuery.select('id');
    if (updErr)                       { errors.push(`"${row.path || row.id}": ${updErr.message}`); continue; }
    if (!updRows || !updRows.length)  { notFound++; continue; }
    updated += updRows.length;
  }

  res.json({
    success: true,
    dry_run: !!dry_run,
    updated,
    createdCategories: dry_run ? newCategoryNames.length : createdCategories,
    newCategoryNames: dry_run ? newCategoryNames : undefined,
    sample: dry_run ? sample : undefined,
    skipped,
    notFound,
    errors: errors.slice(0, 20),
  });
});

module.exports = router;
