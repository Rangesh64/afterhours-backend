const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const db = require('./db');
const authRoutes = require('./auth');
const dashboardRoutes = require('./dashboard');
const webhookRoutes = require('./webhooks');
const paymentRoutes = require('./payment');
const { deductClientCredits } = require('./credits');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: true,       // Allows your Vercel frontend to connect dynamically
  credentials: true   // Crucial: This allows the secure HttpOnly cookies to pass through
}));
app.use(express.json());
app.use(cookieParser());

// Register API Routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/payment', paymentRoutes);

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
