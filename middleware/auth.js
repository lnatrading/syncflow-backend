// ============================================================
//  SyncFlow — middleware/auth.js
//  API key authentication for all /api/* routes.
//
//  Setup:
//    1. Set SYNCFLOW_API_KEY in Railway environment variables
//       (generate a long random string, e.g. 48+ characters)
//    2. Frontend reads it from login form and sends it on every
//       request as: Authorization: Bearer <key>
//
//  /health is always public (Railway health check needs it).
//  Everything else requires the key.
// ============================================================

const API_KEY = process.env.SYNCFLOW_API_KEY;

if (!API_KEY) {
  console.warn('⚠  WARNING: SYNCFLOW_API_KEY is not set — /api/* routes are publicly accessible');
}

function requireApiKey(req, res, next) {
  // No key configured = dev/unprotected mode, pass through
  if (!API_KEY) return next();

  const authHeader = req.headers['authorization'] || '';
  const xApiKey    = req.headers['x-api-key']     || '';

  const provided =
    authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() :
    authHeader.trim() || xApiKey.trim();

  if (!provided) {
    return res.status(401).json({
      error: 'Unauthorised',
      hint:  'Include: Authorization: Bearer <your-api-key>',
    });
  }

  if (!safeCompare(provided, API_KEY)) {
    console.warn(`[AUTH] Rejected invalid API key from ${req.ip}`);
    return res.status(403).json({ error: 'Forbidden — invalid API key' });
  }

  next();
}

// Constant-time comparison — prevents timing attacks
function safeCompare(a, b) {
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

module.exports = { requireApiKey };
