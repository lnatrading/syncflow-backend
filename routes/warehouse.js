// ============================================================
//  SyncFlow — routes/warehouse.js
//  GET / POST warehouse address config
// ============================================================
const express = require('express');
const router  = express.Router();

router.get('/', async (req, res) => {
  const { data, error } = await req.sb
    .from('warehouse_config').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || {});
});

router.post('/', async (req, res) => {
  const { name, company_name, street, city, zip, country_code, phone, email, vat_number, notes } = req.body;
  if (!street || !city || !zip) return res.status(400).json({ error: 'street, city, zip required' });
  const { data, error } = await req.sb.from('warehouse_config')
    .update({ name, company_name, street, city, zip, country_code: country_code || 'PL',
              phone, email, vat_number, notes, updated_at: new Date() })
    .eq('id', 1).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
