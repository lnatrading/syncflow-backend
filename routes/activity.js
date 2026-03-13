const express = require('express');
const router  = express.Router();

router.get('/', async (req, res) => {
  const limit = parseInt(req.query.limit || 50);
  const { data, error } = await req.sb.from('activity_log')
    .select('*').order('created_at', { ascending: false }).limit(limit);
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

module.exports = router;
