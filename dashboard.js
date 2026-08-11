const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('./db');

// Middleware to verify JWT token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
    req.user = user;
    next();
  });
};

// GET /api/dashboard/data
router.get('/data', async (req, res) => {
  try {
    const clientId = req.user ? req.user.userId : null;

    // Fetch leads for this client (or all leads if unauthenticated)
    const leadsQuery = clientId
      ? await db.query('SELECT * FROM leads WHERE client_id = $1 ORDER BY created_at DESC', [clientId])
      : await db.query('SELECT * FROM leads ORDER BY created_at DESC');

    // Fetch activity logs for this client (or all logs if unauthenticated)
    const logsQuery = clientId
      ? await db.query('SELECT * FROM activity_logs WHERE client_id = $1 ORDER BY created_at DESC LIMIT 10', [clientId])
      : await db.query('SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 10');

    return res.status(200).json({
      client: req.user || { email: 'rangeshmishra9@gmail.com' },
      leads: leadsQuery.rows,
      logs: logsQuery.rows
    });
  } catch (error) {
    console.error('Dashboard data error:', error);
    return res.status(500).json({ error: 'Failed to fetch dashboard data.' });
  }
});

module.exports = router;
