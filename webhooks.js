const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('./db');
const { deductClientCredits } = require('./credits');

// ============================================================================
// 1. RAZORPAY WEBHOOK ENDPOINT
// ============================================================================
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

      const planName = amount >= 20000 
        ? 'Enterprise Scale' 
        : (amount >= 10000 ? 'Growth Pro' : 'Starter Mesh');

      // Credit allocation matching our pricing structure
      let creditsToAdd = 5000;
      if (amount >= 20000) creditsToAdd = 20000;
      else if (amount >= 10000) creditsToAdd = 10000;

      // Upsert Subscription into Supabase/DB
      if (db.from) {
        await db.from('subscriptions').upsert({
          user_email: clientEmail,
          plan_name: planName,
          billing_cycle: 'Monthly Recurring',
          renewal_date: formattedRenewal,
          days_remaining: 30,
          capacity: 'Unlimited Multi-Channel Routes',
          credits_balance: creditsToAdd
        }, { onConflict: 'user_email' });

        // Insert Activity Log
        await db.from('activity_logs').insert({
          user_email: clientEmail,
          contact: payment.contact || '+1 (555) 019-2831',
          channels: 'Razorpay Payment Captured',
          outcome: 'SUBSCRIPTION ACTIVE'
        });
      } else if (db.query) {
        const upsertQuery = `
          INSERT INTO subscriptions (user_email, plan_name, billing_cycle, renewal_date, days_remaining, capacity, credits_balance)
          VALUES ($1, $2, $3, $4, 30, 'Unlimited Multi-Channel Routes', $5)
          ON CONFLICT (user_email)
          DO UPDATE SET 
            plan_name = EXCLUDED.plan_name,
            credits_balance = subscriptions.credits_balance + EXCLUDED.credits_balance,
            renewal_date = EXCLUDED.renewal_date;
        `;
        await db.query(upsertQuery, [clientEmail, planName, 'Monthly Recurring', formattedRenewal, creditsToAdd]);

        await db.query(
          `INSERT INTO activity_logs (user_email, contact, channels, outcome, created_at)
           VALUES ($1, $2, 'Razorpay Payment Captured', 'SUBSCRIPTION ACTIVE', NOW());`,
          [clientEmail, payment.contact || '+1 (555) 019-2831']
        );
      }

      console.log(`[PAYMENT SUCCESS] Auto-activated ${planName} (${creditsToAdd} Credits) for: ${clientEmail}`);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[RAZORPAY WEBHOOK ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// 2. VAPI END-OF-CALL WEBHOOK ENDPOINT
// ============================================================================
router.post('/vapi', async (req, res) => {
  try {
    const payload = req.body;
    const message = payload.message || payload;

    // We only process when the call actually ends
    if (message.type === 'end-of-call-report' || message.status === 'ended') {
      const call = message.call || {};
      const customer = call.customer || {};
      
      // Extract call duration in seconds
      const durationSeconds = Math.round(message.durationSeconds || call.duration || 0);
      const callerPhone = customer.number || message.customer?.number || 'Unknown Caller';
      
      // Get the client email associated with this phone line (or default fallback)
      const clientEmail = (
        call.assistant?.metadata?.clientEmail || 
        payload.clientEmail || 
        'rangeshmishra9@gmail.com'
      ).toLowerCase().trim();

      // Log into activity_logs
      const outcome = message.analysis?.summary || 'Call Completed by Voice AI';
      const createdAt = new Date().toISOString();

      if (db.query) {
        await db.query(
          `INSERT INTO activity_logs (user_email, contact, channels, outcome, created_at)
           VALUES ($1, $2, 'Voice AI Inbound', $3, $4);`,
          [clientEmail, callerPhone, outcome, createdAt]
        );
      } else if (db.from) {
        await db.from('activity_logs').insert({
          user_email: clientEmail,
          contact: callerPhone,
          channels: 'Voice AI Inbound',
          outcome: outcome,
          created_at: createdAt
        });
      }

      // Execute credit deduction using our tiered rules (5 credits <=25s, 25 credits base, pro-rated beyond)
      const deductionResult = await deductClientCredits(clientEmail, 'VOICE_CALL', {
        durationSeconds: durationSeconds,
        phone: callerPhone
      });

      console.log(`[VAPI CALL PROCESSED] Duration: ${durationSeconds}s | Caller: ${callerPhone} | Deduction:`, deductionResult);
    }

    // Always return 200 OK so the provider knows the message was delivered
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('[VAPI WEBHOOK ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
