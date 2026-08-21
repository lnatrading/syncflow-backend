// ============================================================
//  scripts/check-ab-outbound-ip.js
//  Safeguard #6 — AB.pl requires the calling IP to be allowlisted
//  (AB Online -> Administration -> XML Gateway IPs). Run this ON
//  RAILWAY (e.g. `railway run node scripts/check-ab-outbound-ip.js`,
//  or temporarily as a one-off Railway shell command) to print the
//  actual outbound IP Syncflow calls AB from, and confirm it's static
//  before going live — a rotating egress IP causes intermittent
//  error 3 (access denied) failures that are hard to diagnose from
//  the AB side alone.
//
//  Run it more than once across a few minutes/hours — if the
//  reported IP changes between runs, Railway's egress for this
//  service isn't static and needs a fixed egress IP (e.g. Railway's
//  paid static-IP add-on, or an outbound proxy) before AB.pl orders
//  can be trusted in production.
// ============================================================
const axios = require('axios');

(async () => {
  try {
    const res = await axios.get('https://api.ipify.org?format=json', { timeout: 10000 });
    console.log(`Outbound IP right now: ${res.data.ip}`);
    console.log('Add this to AB Online -> Administration -> XML Gateway IPs.');
    console.log('Re-run this script at a few different times before relying on it being static.');
  } catch (err) {
    console.error('Could not determine outbound IP:', err.message);
    process.exit(1);
  }
})();
