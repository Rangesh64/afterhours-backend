const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('./db');

// Razorpay Webhook Endpoint
router.post('/razorpay', async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    const signature = req.headers['x-razorpay-signature'];

    if (!secret || !signature) {
      return res.status(400).json({ status: 'Missing signature or secret configuration' });
    }

    // Verify Webhook Signature safely
    const bodyData = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(bodyData)
      .digest('hex');

    const digestBuffer = Buffer.from(expectedSignature, 'utf8');
    const signatureBuffer = Buffer.from(signature, 'utf8');

    if (digestBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(digestBuffer, signatureBuffer)) {
      console.warn('[RAZORPAY WEBHOOK] Invalid signature match attempt.');
      return res.status(400).json({ status: 'Invalid signature' });
    }

    const event = req.body.event;

    if (event === 'payment.captured') {
      const payment = req.body.payload.payment.entity;
      const clientEmail = payment.email;
      const amount = payment.amount / 100;

      // Calculate 30-day subscription window
      const renewalDate = new Date();
      renewalDate.setDate(renewalDate.getDate() + 30);
      const formattedRenewal = renewalDate.toISOString().split('T')[0];

      const planName = amount >= 4999 ? 'Enterprise Unlimited Mesh' : 'Pro Voice AI Protocol';

      // Upsert Subscription into Supabase/DB
      if (db.from) {
        await db.from('subscriptions').upsert({
          user_email: clientEmail,
          plan_name: planName,
          billing_cycle: 'Monthly Recurring',
          renewal_date: formattedRenewal,
          days_remaining: 30,
          capacity: 'Unlimited Multi-Channel Routes'
        }, { onConflict: 'user_email' });

        // Insert Activity Log
        await db.from('activity_logs').insert({
          user_email: clientEmail,
          contact_id: payment.contact || '+1 (555) 019-2831',
          channels: 'Razorpay Payment + WhatsApp',
          outcome: 'SUBSCRIPTION ACTIVE'
        });
      }

      console.log(`[PAYMENT SUCCESS] Auto-activated plan for: ${clientEmail}`);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[RAZORPAY WEBHOOK ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
