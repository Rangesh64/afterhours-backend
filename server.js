const express = require('express');
const cors = require('cors');
require('dotenv').config();
const db = require('./db');
const authRoutes = require('./auth');
const dashboardRoutes = require('./dashboard');
const webhookRoutes = require('./webhooks');
const { deductClientCredits } = require('./credits');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Register API Routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/webhooks', webhookRoutes);

// Credit Deduction Route
app.post('/api/credits/deduct', async (req, res) => {
  const { userEmail, actionType, meta } = req.body;

  if (!userEmail || !actionType) {
    return res.status(400).json({ 
      success: false, 
      message: 'userEmail and actionType are required' 
    });
  }

  const result = await deductClientCredits(userEmail, actionType, meta);

  if (!result.success) {
    return res.status(400).json(result);
  }

  return res.status(200).json(result);
});

// Health Check Route
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'OK', message: 'AfterHours Backend Engine Online 🚀' });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Server running smoothly on port ${PORT}`);
});
