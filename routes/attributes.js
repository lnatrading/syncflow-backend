// ============================================================
//  SyncFlow — routes/attributes.js
// ============================================================
const express = require('express');
const router  = express.Router();

// ── MY ATTRIBUTES ────────────────────────────────────────────

// GET all my attributes
router.get('/my', async (req, res) => {
  const { data, error } = await req.sb
    .from('my_attributes').select('*').order('label');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST create my attribute
router.post('/my', async (req, res) => {
  const { name, label, attr_type, options, unit } = req.body;
  if (!name || !label) return res.status(400).json({ error: 'name and label required' });
  const { data, error } = await req.sb.from('my_attributes')
    .insert({ name, label, attr_type: attr_type || 'select', options: options || null, unit: unit || null })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PUT update my attribute
router.put('/my/:id', async (req, res) => {
  const { data, error } = await req.sb.from('my_attributes')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE my attribute
router.delete('/my/:id', async (req, res) => {
  const { error } = await req.sb.from('my_attributes').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── SUPPLIER ATTRIBUTES ───────────────────────────────────────

// GET supplier attributes — optionally filtered by supplier_id
router.get('/supplier', async (req, res) => {
  let q = req.sb.from('supplier_attributes')
    .select('*, my_attributes(id,name,label,attr_type)')
    .order('product_count', { ascending: false });
  if (req.query.supplier_id) q = q.eq('supplier_id', req.query.supplier_id);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH map a supplier attribute to a my_attribute
router.patch('/supplier/:id/map', async (req, res) => {
  const { my_attribute_id } = req.body; // null = unmap
  const { data, error } = await req.sb.from('supplier_attributes')
    .update({ my_attribute_id: my_attribute_id || null })
    .eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── CSV EXPORT / IMPORT (bulk mapping via spreadsheet) ─────────
// Same workflow as the Categories bulk-mapping tool: download every
// supplier attribute as a CSV, fill in the "my_attribute" column in
// Excel, re-upload to apply it all in one shot — much faster than
// mapping each raw column one at a time in the UI, especially for
// suppliers with 15-20+ discovered columns.
const { parse: csvParse } = require('csv-parse/sync');

router.get('/supplier/export', async (req, res) => {
  const supplierId = req.query.supplier_id;
  if (!supplierId) return res.status(400).json({ error: 'supplier_id required' });

  const { data, error } = await req.sb
    .from('supplier_attributes')
    .select('id, name, product_count, my_attributes(label)')
    .eq('supplier_id', supplierId)
    .order('product_count', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  const escapeCsv = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const rows = [['id', 'name', 'product_count', 'my_attribute']];
  for (const a of data || []) {
    rows.push([a.id, a.name, a.product_count ?? 0, a.my_attributes?.label || '']);
  }
  const csv = rows.map(r => r.map(escapeCsv).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attributes_supplier_${supplierId}.csv"`);
  res.send(csv);
});

// POST bulk import — body: { supplier_id, csv_text, dry_run? }
// Same matching rules as the categories importer: 'id' column preferred
// (reliable), falls back to 'name'. Blank my_attribute cells are
// skipped, not cleared. A My Attribute name that doesn't exist yet is
// auto-created as a plain 'text' attribute (the safest generic default
// since a CSV column alone can't tell us whether it should be a
// select/number/boolean type — adjust the type afterward in the My
// Attributes panel if needed).
router.post('/supplier/import', async (req, res) => {
  const { supplier_id, csv_text, dry_run } = req.body;
  if (!supplier_id || !csv_text) return res.status(400).json({ error: 'supplier_id and csv_text required' });

  let rows;
  try {
    rows = csvParse(csv_text, { columns: true, skip_empty_lines: true, trim: true });
  } catch (e) {
    return res.status(400).json({ error: `Could not parse CSV: ${e.message}` });
  }

  const { data: existingMyAttrs } = await req.sb.from('my_attributes').select('id, name, label');
  const byLabel = new Map((existingMyAttrs || []).map(a => [a.label.toLowerCase().trim(), a.id]));

  let existingById = new Map(), existingByName = new Map();
  if (dry_run) {
    const { data: supAttrs } = await req.sb.from('supplier_attributes')
      .select('id, name').eq('supplier_id', supplier_id);
    for (const a of supAttrs || []) {
      existingById.set(String(a.id), a);
      existingByName.set(a.name, a);
    }
  }

  let updated = 0, createdAttributes = 0, skipped = 0, notFound = 0;
  const errors = [];
  const newAttributeNames = []; // dry run only
  const sample = [];            // dry run only
  const seenNewLabels = new Set();

  for (const row of rows) {
    const label = (row.my_attribute || '').trim();
    if (!label) { skipped++; continue; }

    let myAttrId = byLabel.get(label.toLowerCase());
    const willCreate = !myAttrId;

    if (willCreate) {
      if (dry_run) {
        if (!seenNewLabels.has(label.toLowerCase())) {
          seenNewLabels.add(label.toLowerCase());
          newAttributeNames.push(label);
        }
        myAttrId = `__pending__${label.toLowerCase()}`;
        byLabel.set(label.toLowerCase(), myAttrId);
      } else {
        const name = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `attr_${Date.now()}`;
        const { data: newAttr, error: createErr } = await req.sb.from('my_attributes')
          .insert({ name, label, attr_type: 'text' }).select().single();
        if (createErr) {
          errors.push(`"${row.name || row.id}": could not create attribute "${label}": ${createErr.message}`);
          continue;
        }
        myAttrId = newAttr.id;
        byLabel.set(label.toLowerCase(), myAttrId);
        createdAttributes++;
      }
    }

    if (dry_run) {
      const exists = row.id ? existingById.has(String(row.id))
                    : row.name ? existingByName.has(row.name)
                    : false;
      if (!row.id && !row.name) { skipped++; continue; }
      if (!exists) { notFound++; continue; }
      updated++;
      if (sample.length < 12) sample.push({ name: row.name, my_attribute: label, isNewAttribute: willCreate });
      continue;
    }

    let updateQuery = req.sb.from('supplier_attributes').update({ my_attribute_id: myAttrId }).eq('supplier_id', supplier_id);
    if (row.id)        updateQuery = updateQuery.eq('id', row.id);
    else if (row.name) updateQuery = updateQuery.eq('name', row.name);
    else { skipped++; continue; }

    const { data: updRows, error: updErr } = await updateQuery.select('id');
    if (updErr)                       { errors.push(`"${row.name || row.id}": ${updErr.message}`); continue; }
    if (!updRows || !updRows.length)  { notFound++; continue; }
    updated += updRows.length;
  }

  res.json({
    success: true,
    dry_run: !!dry_run,
    updated,
    createdAttributes: dry_run ? newAttributeNames.length : createdAttributes,
    newAttributeNames: dry_run ? newAttributeNames : undefined,
    sample: dry_run ? sample : undefined,
    skipped,
    notFound,
    errors: errors.slice(0, 20),
  });
});

module.exports = router;
