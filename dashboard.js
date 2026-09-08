const express = require('express');
const router = express.Router();
const https = require('https');
const { google } = require('googleapis');
const db = require('./db');
const { deductClientCredits, hasActiveServiceAccess, MINIMUM_ACTIVE_THRESHOLD } = require('./credits');

// Helper to initialize Google Sheets API using your service account key
function getSheetsClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY is not defined in environment variables');
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return google.sheets({ version: 'v4', auth });
}

// Helper to fetch Google Sheets via Direct Public CSV with CACHE-BUSTING
function fetchPublicSheetCSV(sheetId) {
  return new Promise((resolve) => {
    if (!sheetId) return resolve([]);

    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&_t=${Date.now()}`;

    const makeRequest = (url) => {
      https.get(url, {
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          makeRequest(res.headers.location);
          return;
        }

        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const rows = parseCSVText(data);
            resolve(rows);
          } catch (err) {
            resolve([]);
          }
        });
      }).on('error', () => resolve([]));
    };

    makeRequest(csvUrl);
  });
}

function parseCSVText(text) {
  if (!text || text.includes('<!DOCTYPE html>') || text.includes('<html')) return [];
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) =>
      line
        .split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)
        .map((val) => val.replace(/^"|"$/g, '').trim())
    );
}

// Pre-call & Channel Eligibility Status Check
router.get('/status', async (req, res) => {
  try {
    const userEmail = (
      req.headers['x-user-email'] ||
      req.query.email ||
      req.user?.email ||
      'rangeshmishra9@gmail.com'
    ).toLowerCase().trim();

    const isAllowed = await hasActiveServiceAccess(userEmail);

    let currentBalance = 0;
    if (db && db.from) {
      const { data } = await db
        .from('subscriptions')
        .select('credits_balance')
        .eq('user_email', userEmail)
        .maybeSingle();
      currentBalance = data?.credits_balance ?? 0;
    } else if (db && db.query) {
      const result = await db.query(
        'SELECT credits_balance FROM subscriptions WHERE LOWER(user_email) = $1 LIMIT 1',
        [userEmail]
      );
      currentBalance = result.rows[0]?.credits_balance ?? 0;
    }

    return res.json({
      client_email: userEmail,
      allowService: isAllowed,
      creditsBalance: currentBalance,
      minimumThreshold: MINIMUM_ACTIVE_THRESHOLD,
      status: isAllowed ? 'ACTIVE' : 'SUSPENDED_LOW_BALANCE'
    });
  } catch (err) {
    console.error('[STATUS CHECK ERROR]', err);
    return res.status(500).json({ error: err.message });
  }
});

// Live Dashboard Data Endpoint
router.get('/data', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  try {
    const userEmail = (
      req.headers['x-user-email'] ||
      req.query.email ||
      req.user?.email ||
      'rangeshmishra9@gmail.com'
    ).toLowerCase().trim();

    let subData = null;
    let logsData = [];
    let integData = [];
    let creditLogs = [];
    const sheetData = { voice: [], email: [], whatsapp: [] };

    // 1. Fetch live data from Database
    if (db && db.from) {
      try {
        const { data: sub } = await db
          .from('subscriptions')
          .select('*')
          .eq('user_email', userEmail)
          .maybeSingle();

        if (sub) subData = sub;

        const { data: logs } = await db
          .from('activity_logs')
          .select('*')
          .eq('user_email', userEmail)
          .order('created_at', { ascending: false })
          .limit(10);

        if (logs) logsData = logs;

        const { data: integs } = await db
          .from('integrations')
          .select('*')
          .eq('user_email', userEmail);

        if (integs) integData = integs;

        const { data: transactions } = await db
          .from('credit_transactions')
          .select('*')
          .eq('user_email', userEmail)
          .order('created_at', { ascending: false })
          .limit(10);

        if (transactions) creditLogs = transactions;
      } catch (dbErr) {
        console.warn('[DASHBOARD SUPABASE-JS FETCH WARNING]', dbErr.message);
      }
    } else if (db && db.query) {
      try {
        const subRes = await db.query('SELECT * FROM subscriptions WHERE LOWER(user_email) = $1 LIMIT 1', [userEmail]);
        if (subRes.rows.length > 0) subData = subRes.rows[0];

        const logsRes = await db.query('SELECT * FROM activity_logs WHERE LOWER(user_email) = $1 ORDER BY created_at DESC LIMIT 10', [userEmail]);
        logsData = logsRes.rows;

        const integRes = await db.query('SELECT * FROM integrations WHERE LOWER(user_email) = $1', [userEmail]);
        integData = integRes.rows;

        const transRes = await db.query('SELECT * FROM credit_transactions WHERE LOWER(user_email) = $1 ORDER BY created_at DESC LIMIT 20', [userEmail]);
        creditLogs = transRes.rows;
      } catch (pgErr) {
        console.warn('[DASHBOARD PG FETCH WARNING]', pgErr.message);
      }
    }

    // 2. Fetch live data from Google Sheets for connected integrations
    if (integData.length > 0) {
      let sheetsApi = null;
      if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
        try {
          sheetsApi = getSheetsClient();
        } catch (authErr) {
          console.warn('[GOOGLE AUTH WARNING]', authErr.message);
        }
      }

      for (const integ of integData) {
        if (integ.sheet_id && integ.status === 'ACTIVE') {
          const type = (integ.type || '').toLowerCase();
          let rows = [];

          try {
            rows = await fetchPublicSheetCSV(integ.sheet_id);
          } catch (csvErr) {
            rows = [];
          }

          if ((!rows || rows.length === 0) && sheetsApi) {
            try {
              const sheetRes = await sheetsApi.spreadsheets.values.get({
                spreadsheetId: integ.sheet_id,
                range: 'Sheet1',
              });
              rows = sheetRes.data.values || [];
            } catch (sheetErr) {
              console.warn(`[SHEET FETCH WARNING for ${integ.name}]:`, sheetErr.message);
              rows = [];
            }
          }

          sheetData[type] = rows;
        }
      }
    }

    const voiceRows = Array.isArray(sheetData.voice) && sheetData.voice.length > 1 ? sheetData.voice.slice(1) : [];
    const whatsappRows = Array.isArray(sheetData.whatsapp) && sheetData.whatsapp.length > 1 ? sheetData.whatsapp.slice(1) : [];
    const emailRows = Array.isArray(sheetData.email) && sheetData.email.length > 1 ? sheetData.email.slice(1) : [];

    const computedTotalLeads = logsData.length > 0 ? logsData.length : (voiceRows.length + whatsappRows.length);
    const computedActiveIntercepts = logsData.length > 0 ? logsData.length : voiceRows.length;
    const computedPipelineValue = computedTotalLeads * 250;

    let computedRecentIntercepts = logsData;
    if (computedRecentIntercepts.length === 0 && voiceRows.length > 0) {
      computedRecentIntercepts = voiceRows.slice(0, 10).map((row, idx) => ({
        id: `INT-${idx + 101}`,
        contact: row[0] || 'Unknown Contact',
        intercept_time: row[1] || 'Real-Time',
        channels: 'Voice AI + WhatsApp',
        outcome: row[2] ? 'RECOVERED' : 'RESOLVED',
        created_at: new Date().toISOString()
      }));
    }

    if (!subData) {
      if (userEmail === 'rangeshmishra9@gmail.com' || userEmail === 'afterhoursautomation714@gmail.com' || userEmail === 'mahmiasubham@gmail.com') {
        subData = {
          plan_name: 'Lifetime Founder Mesh',
          billing_cycle: 'Lifetime Unlimited',
          renewal_date: '2099-12-31',
          days_remaining: 9999,
          capacity: 'Unlimited Multi-Channel Routes',
          credits_balance: 50000,
        };
      } else {
        subData = {
          plan_name: 'Enterprise Unlimited Mesh',
          billing_cycle: 'Monthly Recurring',
          renewal_date: '2026-09-13',
          days_remaining: 30,
          capacity: 'Unlimited Multi-Channel Routes',
          credits_balance: 5000,
        };
      }
    }

    res.json({
      totalLeads: computedTotalLeads,
      activeIntercepts: computedActiveIntercepts,
      pipelineValue: computedPipelineValue,
      inquiriesIntercepted: voiceRows.length,
      whatsappDispatched: whatsappRows.length,
      emailDispatched: emailRows.length,
      creditsBalance: subData.credits_balance ?? 5000,
      client: {
        companyName: 'AfterHours Executive',
        email: userEmail,
      },
      subscription: subData,
      recentIntercepts: computedRecentIntercepts,
      creditTransactions: creditLogs,
      sheets: sheetData,
      connectors: integData.length > 0 ? integData : [
        { name: 'Live Voice Listener Gateway', type: 'voice', status: 'ACTIVE' },
        { name: 'WhatsApp Business API', type: 'whatsapp', status: 'ACTIVE' },
        { name: 'Salesforce / HubSpot CRM', type: 'crm', status: 'SYNC ON' },
      ],
    });
  } catch (err) {
    console.error('[DASHBOARD DATA ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/calls/log
router.post('/calls/log', async (req, res) => {
  try {
    const { 
      client_email, 
      caller_phone, 
      dispatched_via, 
      outcome, 
      durationSeconds, 
      isDirectWhatsAppBooking, 
      isAdvanceVerified 
    } = req.body;

    if (!client_email || !caller_phone) {
      return res.status(400).json({ error: 'Missing client_email or caller_phone' });
    }

    const email = client_email.toLowerCase().trim();

    // Enforce 20-credit safety cutoff before processing
    const hasAccess = await hasActiveServiceAccess(email);
    if (!hasAccess) {
      return res.status(403).json({
        success: false,
        blocked: true,
        error: `Action blocked: Credit balance is below the ${MINIMUM_ACTIVE_THRESHOLD} minimum floor. Please recharge.`
      });
    }

    const channels = dispatched_via || 'Voice AI + WhatsApp';
    const statusOutcome = outcome || 'RECOVERED';
    const createdAt = new Date().toISOString();
    const duration = parseInt(durationSeconds, 10) || 0;
    const eventDescription = `Inbound Voice Call Intercepted (${duration}s) - Status: ${statusOutcome}`;

    let savedData = null;

    // 1. Save Call to Database with event_text populated
    if (db && db.from) {
      const { data, error } = await db
        .from('activity_logs')
        .insert([
          {
            user_email: email,
            contact: caller_phone,
            channels: channels,
            outcome: statusOutcome,
            event_text: eventDescription,
            created_at: createdAt,
          },
        ]);

      if (error) throw error;
      savedData = data;
    } else if (db && db.query) {
      const insertQuery = `
        INSERT INTO activity_logs (user_email, contact, channels, outcome, event_text, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING *;
      `;
      const { rows } = await db.query(insertQuery, [email, caller_phone, channels, statusOutcome, eventDescription, createdAt]);
      savedData = rows[0];
    } else {
      return res.status(500).json({ error: 'Database instance not initialized' });
    }

    // 2. Deduct Voice Call Credits based on duration (<=20s = 5 credits, >20s = 25/min)
    const voiceDeduction = await deductClientCredits(email, 'VOICE_CALL', {
      durationSeconds: duration,
      phone: caller_phone
    });

    // 3. Deduct 10 credits ONLY if this was a Direct Inbound WhatsApp AI Booking session
    let whatsappDeduction = null;
    if (isDirectWhatsAppBooking) {
      whatsappDeduction = await deductClientCredits(email, 'WHATSAPP_FLOW', {
        phone: caller_phone
      });
    }

    // 4. Deduct 15 credits ONLY if an advance booking deposit / fake lead verification occurred
    let advanceDeduction = null;
    if (isAdvanceVerified) {
      advanceDeduction = await deductClientCredits(email, 'ADVANCE_CONFIRMATION', {
        phone: caller_phone
      });
    }

    return res.status(200).json({ 
      success: true, 
      message: 'Call log saved and credits processed successfully', 
      data: savedData,
      deductions: {
        voice: voiceDeduction,
        whatsapp: whatsappDeduction,
        advance: advanceDeduction
      }
    });
  } catch (err) {
    console.error('[CALL LOG ERROR]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
