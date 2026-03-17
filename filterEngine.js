// ============================================================
//  SyncFlow — filterEngine.js
//  Evaluates the export filter rule tree against a product.
//  Called from syncEngine before pushing to Odoo.
// ============================================================

// ── LOAD FILTER TREE FROM DB ─────────────────────────────────
// Returns { rootGroup, groups, rules } — everything needed to evaluate.
// Cached per sync run (pass the result around, don't re-fetch per product).
async function loadFilterTree(supabase) {
  const [{ data: groups }, { data: rules }] = await Promise.all([
    supabase.from('export_filter_groups').select('*').order('sort_order'),
    supabase.from('export_filter_rules').select('*').order('sort_order'),
  ]);

  if (!groups?.length) return null; // no filter configured — pass everything

  // Index groups and rules for fast lookup
  const groupMap = Object.fromEntries((groups || []).map(g => [g.id, { ...g, rules: [], children: [] }]));
  for (const rule of (rules || [])) {
    if (groupMap[rule.group_id]) groupMap[rule.group_id].rules.push(rule);
  }
  for (const group of Object.values(groupMap)) {
    if (group.parent_group_id && groupMap[group.parent_group_id]) {
      groupMap[group.parent_group_id].children.push(group);
    }
  }

  const rootGroup = groupMap[1] || Object.values(groupMap).find(g => !g.parent_group_id);
  return rootGroup ? { rootGroup, groupMap } : null;
}

// ── EVALUATE ONE PRODUCT ─────────────────────────────────────
// Returns true if the product passes all filters (should be exported to Odoo).
// Returns true if no filter tree is configured.
function evaluateProduct(product, filterTree) {
  if (!filterTree) return true;
  return evaluateGroup(product, filterTree.rootGroup);
}

// ── EVALUATE A GROUP ─────────────────────────────────────────
function evaluateGroup(product, group) {
  const op   = (group.logic_op || 'AND').toUpperCase();
  const items = [
    ...group.rules.map(rule  => evaluateRule(product, rule)),
    ...group.children.map(child => evaluateGroup(product, child)),
  ];

  if (!items.length) return true; // empty group passes everything

  return op === 'OR'
    ? items.some(Boolean)
    : items.every(Boolean);
}

// ── EVALUATE ONE RULE ────────────────────────────────────────
function evaluateRule(product, rule) {
  const raw = getProductField(product, rule.field);

  switch (rule.operator) {

    // ── Numeric comparisons ───────────────────────────────────
    case 'gt':  return toNum(raw) >  toNum(rule.value);
    case 'gte': return toNum(raw) >= toNum(rule.value);
    case 'lt':  return toNum(raw) <  toNum(rule.value);
    case 'lte': return toNum(raw) <= toNum(rule.value);

    // ── Equality ─────────────────────────────────────────────
    // For numeric fields use epsilon comparison to avoid float precision bugs
    // (e.g. 19.99 stored as 19.990000000001 failing === 19.99)
    case 'eq': {
      const ruleNum = parseFloat(rule.value);
      const rawNum  = parseFloat(raw);
      if (!isNaN(ruleNum) && !isNaN(rawNum)) {
        return Math.abs(rawNum - ruleNum) < 0.0001;
      }
      return String(raw ?? '').toLowerCase() === String(rule.value ?? '').toLowerCase();
    }
    case 'neq': {
      const ruleNum = parseFloat(rule.value);
      const rawNum  = parseFloat(raw);
      if (!isNaN(ruleNum) && !isNaN(rawNum)) {
        return Math.abs(rawNum - ruleNum) >= 0.0001;
      }
      return String(raw ?? '').toLowerCase() !== String(rule.value ?? '').toLowerCase();
    }

    // ── Text ─────────────────────────────────────────────────
    case 'contains':
      return String(raw ?? '').toLowerCase().includes(String(rule.value ?? '').toLowerCase());
    case 'not_contains':
      return !String(raw ?? '').toLowerCase().includes(String(rule.value ?? '').toLowerCase());

    // ── Set membership (category "in", multi-value) ───────────
    // values_json is an array of my_category labels or raw values.
    // SAFETY: empty list = false (fail-closed).
    // Rationale: a user who forgets to fill in the list should NOT
    // accidentally pass all 500k products through to Odoo.
    case 'in': {
      const haystack = parseValues(rule.values_json);
      if (!haystack.length) return false; // fail-closed: empty list blocks everything
      const fieldVal = String(raw ?? '').toLowerCase();
      return haystack.some(v => fieldVal.includes(v.toLowerCase()) || v.toLowerCase().includes(fieldVal));
    }
    case 'not_in': {
      const haystack = parseValues(rule.values_json);
      if (!haystack.length) return true; // empty exclusion list = exclude nothing = pass
      const fieldVal = String(raw ?? '').toLowerCase();
      return !haystack.some(v => fieldVal.includes(v.toLowerCase()) || v.toLowerCase().includes(fieldVal));
    }

    default:
      console.warn(`[FILTER] Unknown operator: ${rule.operator} — treating as pass`);
      return true;
  }
}

// ── HELPERS ──────────────────────────────────────────────────

// Extract a field value from a normalised product.
// Supports core fields and arbitrary attribute names.
function getProductField(product, field) {
  switch (field) {
    case 'price':          return product.sale_price;
    case 'cost_price':     return product.cost_price;
    case 'stock_qty':
    case 'qty':            return product.stock_qty;
    case 'category':       return product.category;
    case 'subcategory':    return product.subcategory;
    case 'name':           return product.name;
    case 'description':    return product.description;
    case 'sku':            return product.sku;
    case 'ean':            return product.ean || product.barcode || product.gtin || null;
    case 'brand':          return product.brand;
    case 'shipping_class': return product.shipping_class;
    case 'weight_kg':      return product.weight_kg;
    case 'width_cm':       return product.width_cm;
    case 'height_cm':      return product.height_cm;
    case 'depth_cm':       return product.depth_cm;
    default:
      return product[field] ?? null;
  }
}

function toNum(val) {
  const n = parseFloat(val);
  return isNaN(n) ? 0 : n;
}

function parseValues(valuesJson) {
  if (!valuesJson) return [];
  if (Array.isArray(valuesJson)) return valuesJson.map(String);
  try { return JSON.parse(valuesJson).map(String); }
  catch { return []; }
}

module.exports = { loadFilterTree, evaluateProduct };
