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
      process.env.JWT_SECRET || 'fallback_secret_do_not_use_in_prod',
      { expiresIn: '7d' }
    );

    // 4. SECURE TOKEN VAULT (Audit Fix AH-SEC-04)
    // The browser automatically stores this and sends it with future requests. JavaScript cannot read it.
    res.cookie('token', token, {
      httpOnly: true,
      secure: true,        // Enforces HTTPS
      sameSite: 'none',    // Required since frontend is Vercel and backend is Render
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    });

    // 5. Return success payload (Token is safely omitted from the body)
    return res.status(200).json({
      message: 'Authentication successful',
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

// POST /api/auth/logout (New route to clear the secure cookie)
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: true,
    sameSite: 'none'
  });
  return res.status(200).json({ message: 'Logged out successfully' });
});

module.exports = router;
