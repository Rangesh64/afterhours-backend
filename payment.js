const express = require('express');
const router = express.Router();
const Razorpay = require('razorpay');
const crypto = require('crypto');

// Initialize Razorpay with your exact Key ID
const razorpay = new Razorpay({
  key_id: 'rzp_live_TaO8Lf925G4J84',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'dummy_secret_to_prevent_crashes',
});

// 1. Create Order (Secure backend price generation)
router.post('/create-order', async (req, res) => {
  try {
    const { sku } = req.body; 

    // Determine price securely on the backend (amount in paise)
    let baseAmount = 0;

    switch (sku) {
      // Top-Up Packages
      case 'topup_1k': baseAmount = 1000; break;
      case 'topup_2k5': baseAmount = 2500; break;
      case 'topup_5k': baseAmount = 5000; break;
      // Subscription Deployments
      case 'sub_starter': baseAmount = 8000; break;
      case 'sub_growth': baseAmount = 16000; break;
      case 'sub_enterprise': baseAmount = 28000; break;
      default: 
        return res.status(400).json({ error: 'Invalid package selected.' });
    }

    // Add the 2.4% convenience fee exactly as required
    const fee = Math.round(baseAmount * 0.024);
    const totalAmount = (baseAmount + fee) * 100; // Convert total to paise

    const options = {
      amount: totalAmount,
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
    };

    const order = await razorpay.orders.create(options);
    res.status(200).json(order);
  } catch (err) {
    console.error('[RAZORPAY CREATE ORDER ERROR]', err);
    res.status(500).json({ error: 'Failed to create order securely' });
  }
});

// 2. Verify Payment mathematically
router.post('/verify', async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    
    // Use the environment variable if available, otherwise use the dummy to avoid crashing
    const secret = process.env.RAZORPAY_KEY_SECRET || 'dummy_secret_to_prevent_crashes';
    
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(body.toString())
      .digest('hex');

    const isAuthentic = expectedSignature === razorpay_signature;

    if (isAuthentic) {
      res.status(200).json({ success: true, message: 'Payment verified mathematically.' });
    } else {
      res.status(400).json({ success: false, error: 'Invalid payment signature. Potential tampering detected.' });
    }
  } catch (err) {
    console.error('[RAZORPAY VERIFY ERROR]', err);
    res.status(500).json({ error: 'Payment verification failed' });
  }
});

module.exports = router;
