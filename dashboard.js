const express = require('express');
const router = express.Router();
const db = require('./db');

// Live Dashboard Data Endpoint
router.get('/data', async (req, res) => {
  try {
    const userEmail = req.user?.email || req.headers['x-user-email'] || 'rangeshmishra9@gmail.com';

    let subData = null;
    let logsData = [];
    let integData = [];

    if (db.from) {
      // Fetch Subscription
      const { data: sub } = await db
        .from('subscriptions')
        .select('*')
        .eq('user_email', userEmail)
        .single();
      subData = sub;

      // Fetch Activity Logs
      const { data: logs } = await db
        .from('activity_logs')
        .select('*')
        .eq('user_email', userEmail)
        .order('created_at', { ascending: false })
        .limit(10);
      logsData = logs || [];

      // Fetch Integrations
      const { data: integs } = await db
        .from('integrations')
        .select('*')
        .eq('user_email', userEmail);
      integData = integs || [];
    }

    res.json({
      totalLeads: logsData.length,
      activeIntercepts: logsData.length,
      pipelineValue: 0,
      client: {
        companyName: 'AfterHours Executive',
        email: userEmail
      },
      subscription: subData || {
        plan_name: 'Enterprise Unlimited Mesh',
        billing_cycle: 'Annual Enterprise',
        renewal_date: '2027-04-12',
        days_remaining: 242,
        capacity: 'Unlimited Multi-Channel Routes'
      },
      recentIntercepts: logsData,
      connectors: integData.length > 0 ? integData : [
        { name: 'Omni-Channel Listener Mesh', type: 'Sub-Second Gateway', status: 'ACTIVE' },
        { name: 'WhatsApp Business API', type: 'Direct Interactive Message Bridge', status: 'ACTIVE' },
        { name: 'Salesforce / HubSpot CRM', type: 'Real-Time Webhook Pipeline', status: 'SYNC ON' }
      ]
    });
  } catch (err) {
    console.error('[DASHBOARD DATA ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
