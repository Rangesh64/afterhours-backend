const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const db = require('./db');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    // 1. Query client from database
    const userQuery = await db.query(
      'SELECT id, company_name, email, password_hash, subscription_tier FROM clients WHERE LOWER(email) = LOWER($1)',
      [email.trim()]
    );

    if (userQuery.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const user = userQuery.rows[0];

    // 2. Verify password
    if (password !== user.password_hash) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // 3. Generate JWT Token
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        companyName: user.company_name,
        tier: user.subscription_tier
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 4. Return success payload
    return res.status(200).json({
      message: 'Authentication successful',
      token,
      user: {
        id: user.id,
        companyName: user.company_name,
        email: user.email,
        tier: user.subscription_tier
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal server error during authentication.' });
  }
});

module.exports = router;