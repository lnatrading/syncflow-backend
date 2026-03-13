// ============================================================
//  SyncFlow — apiVersionResolver.js
//  At sync time, loads the active API version for a supplier
//  and applies field renames + endpoint overrides transparently.
//  The sync engine calls this; supplier clients are unaware.
// ============================================================

// ── LOAD ACTIVE VERSION ───────────────────────────────────────
// Returns null if no active version (use defaults).
async function getActiveVersion(supabase, supplierId) {
  const { data } = await supabase
    .from('supplier_api_versions')
    .select('*')
    .eq('supplier_id', supplierId)
    .eq('is_active', true)
    .single()
    .catch(() => ({ data: null }));
  return data || null;
}

// ── APPLY FIELD RENAMES TO A SINGLE PRODUCT OBJECT ───────────
// field_renames shape: { "supplierOldName": "ourNewName", ... }
// Works recursively — handles nested objects one level deep.
function applyFieldRenames(obj, fieldRenames) {
  if (!fieldRenames || !Object.keys(fieldRenames).length) return obj;
  if (Array.isArray(obj)) return obj.map(item => applyFieldRenames(item, fieldRenames));
  if (typeof obj !== 'object' || obj === null) return obj;

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const mappedKey = fieldRenames[key] || key;
    result[mappedKey] = value;
  }
  return result;
}

// ── APPLY VERSION TO AN ENDPOINT ─────────────────────────────
// If the active version has an endpoint override for a given role,
// return the override URL instead of the stored endpoint URL.
function resolveEndpointUrl(endpoint, activeVersion) {
  if (!activeVersion?.endpoint_overrides) return endpoint.url_template;
  const override = activeVersion.endpoint_overrides[endpoint.role];
  return override || endpoint.url_template;
}

// ── APPLY VERSION TO BASE URL ─────────────────────────────────
function resolveBaseUrl(supplier, activeVersion) {
  if (activeVersion?.base_url) return activeVersion.base_url;
  return null; // use supplier's own base URL
}

// ── TRANSFORM A BATCH OF RAW PRODUCTS ────────────────────────
// Called by syncEngine after fetching, before normalisation.
function transformProducts(rawProducts, activeVersion) {
  if (!activeVersion?.field_renames || !Object.keys(activeVersion.field_renames).length) {
    return rawProducts; // nothing to do
  }
  return rawProducts.map(p => applyFieldRenames(p, activeVersion.field_renames));
}

module.exports = {
  getActiveVersion,
  applyFieldRenames,
  resolveEndpointUrl,
  resolveBaseUrl,
  transformProducts,
};
