const express = require('express');
const router = express.Router();
const db = require('./db');

// POST /api/webhooks/incoming-lead
// This is the endpoint your WhatsApp / Email automation team will ping
router.post('/incoming-lead', async (req, res) => {
  const { clientId, contactId, channel, eventText } = req.body;

  if (!clientId || !contactId) {
    return res.status(400).json({ error: 'clientId and contactId are required.' });
  }

  try {
    // 1. Insert new lead into database
    const newLead = await db.query(
      'INSERT INTO leads (client_id, contact_id, intercept_channel, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [clientId, contactId, channel || 'WhatsApp + Email', 'PROCESSING']
    );

    // 2. Log activity for dashboard feed
    await db.query(
      'INSERT INTO activity_logs (client_id, event_text) VALUES ($1, $2)',
      [clientId, eventText || `New lead intercepted: ${contactId}`]
    );

    return res.status(201).json({
      message: 'Lead received and logged successfully',
      lead: newLead.rows[0]
    });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: 'Failed to process incoming webhook.' });
  }
});

module.exports = router;