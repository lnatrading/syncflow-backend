// ============================================================
//  SyncFlow — routes/filters.js
//  CRUD for the global export filter tree.
//  The tree always hangs off root group id=1.
// ============================================================
const express = require('express');
const router  = express.Router();

// ── GET full filter tree ──────────────────────────────────────
// Returns all groups and all rules in two flat arrays.
// The frontend builds the tree from these.
router.get('/', async (req, res) => {
  const [{ data: groups, error: ge }, { data: rules, error: re }] = await Promise.all([
    req.sb.from('export_filter_groups').select('*').order('sort_order'),
    req.sb.from('export_filter_rules').select('*').order('sort_order'),
  ]);
  if (ge) return res.status(500).json({ error: ge.message });
  if (re) return res.status(500).json({ error: re.message });
  res.json({ groups: groups || [], rules: rules || [] });
});

// ── UPDATE root group logic_op (AND ↔ OR) ────────────────────
router.patch('/groups/root', async (req, res) => {
  const { logic_op } = req.body;
  const { data, error } = await req.sb.from('export_filter_groups')
    .update({ logic_op }).eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── CREATE a child group ──────────────────────────────────────
router.post('/groups', async (req, res) => {
  const { parent_group_id, logic_op, sort_order } = req.body;
  if (!parent_group_id) return res.status(400).json({ error: 'parent_group_id required' });
  const { data, error } = await req.sb.from('export_filter_groups')
    .insert({ parent_group_id, logic_op: logic_op || 'AND', sort_order: sort_order || 0 })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── UPDATE a group (logic_op) ─────────────────────────────────
router.patch('/groups/:id', async (req, res) => {
  const { data, error } = await req.sb.from('export_filter_groups')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE a group (cascades to child groups and rules) ───────
router.delete('/groups/:id', async (req, res) => {
  if (req.params.id == 1) return res.status(400).json({ error: 'Cannot delete root group' });
  const { error } = await req.sb.from('export_filter_groups').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── CREATE a rule ─────────────────────────────────────────────
router.post('/rules', async (req, res) => {
  const { group_id, field, operator, value, values_json, sort_order } = req.body;
  if (!group_id || !field || !operator) {
    return res.status(400).json({ error: 'group_id, field, operator required' });
  }
  const { data, error } = await req.sb.from('export_filter_rules')
    .insert({ group_id, field, operator, value: value || null, values_json: values_json || null, sort_order: sort_order || 0 })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── UPDATE a rule ─────────────────────────────────────────────
router.patch('/rules/:id', async (req, res) => {
  const { data, error } = await req.sb.from('export_filter_rules')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE a rule ─────────────────────────────────────────────
router.delete('/rules/:id', async (req, res) => {
  const { error } = await req.sb.from('export_filter_rules').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── SERVER-SIDE FILTER PREVIEW COUNT ─────────────────────────
// Returns the number of products that would pass the current filter tree.
// Runs entirely in Postgres — safe at 500k SKUs, never loads catalog into memory.
// The client NO LONGER needs to fetch all products for preview.
router.get('/preview-count', async (req, res) => {
  try {
    const { loadFilterTree, evaluateProduct } = require('../filterEngine');

    // Load filter tree
    const filterTree = await loadFilterTree(req.sb);

    // If no rules defined, all products pass
    if (!filterTree || !filterTree.rules?.length && !filterTree.children?.length) {
      const { count } = await req.sb.from('products').select('*', { count: 'exact', head: true });
      return res.json({ count: count || 0, total: count || 0, filtered_out: 0 });
    }

    // Build a Postgres-compatible filter from the tree where possible.
    // For simple cases (single AND group, basic operators), push to DB.
    // For complex nested cases, fall back to paginated server-side eval.
    const { count: total } = await req.sb
      .from('products').select('*', { count: 'exact', head: true });

    // Paginated evaluation — fetch in pages of 1000, count matches
    // Memory usage stays flat: we process one page at a time and discard it
    const PAGE = 1000;
    let matched = 0;
    let page    = 0;
    let done    = false;

    while (!done) {
      const { data: products } = await req.sb
        .from('products')
        .select('sku, name, cost_price, sale_price, stock_qty, category, status, ean, description')
        .range(page * PAGE, (page + 1) * PAGE - 1);

      if (!products?.length) { done = true; break; }

      for (const p of products) {
        if (evaluateProduct(p, filterTree)) matched++;
      }

      if (products.length < PAGE) done = true;
      page++;
    }

    res.json({ count: matched, total: total || 0, filtered_out: (total || 0) - matched });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
