const express = require('express');
const router = express.Router();
const https = require('https');
const { google } = require('googleapis');
const db = require('./db');

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

// Helper to fetch Google Sheets via Direct Public CSV (bypasses Google Workspace/Cloud service account blocks)
function fetchPublicSheetCSV(sheetId) {
  return new Promise((resolve) => {
    if (!sheetId) return resolve([]);
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

    https.get(csvUrl, (res) => {
      // Follow redirect if Google responds with 301/302/307
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, (redirectRes) => {
          let data = '';
          redirectRes.on('data', (chunk) => { data += chunk; });
          redirectRes.on('end', () => {
            try {
              const rows = parseCSVText(data);
              resolve(rows);
            } catch (err) {
              resolve([]);
            }
          });
        }).on('error', () => resolve([]));
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

// Live Dashboard Data Endpoint
router.get('/data', async (req, res) => {
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
      // Supabase-JS Client syntax
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
      // PostgreSQL Pool syntax
      try {
        const subRes = await db.query('SELECT * FROM subscriptions WHERE LOWER(user_email) = $1 LIMIT 1', [userEmail]);
        if (subRes.rows.length > 0) subData = subRes.rows[0];

        const logsRes = await db.query('SELECT * FROM activity_logs WHERE LOWER(user_email) = $1 ORDER BY created_at DESC LIMIT 10', [userEmail]);
        logsData = logsRes.rows;

        const integRes = await db.query('SELECT * FROM integrations WHERE LOWER(user_email) = $1', [userEmail]);
        integData = integRes.rows;

        const transRes = await db.query('SELECT * FROM credit_transactions WHERE LOWER(user_email) = $1 ORDER BY created_at DESC LIMIT 10', [userEmail]);
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
          const type = (integ.type || '').toLowerCase(); // 'voice', 'email', or 'whatsapp'
          let rows = [];

          // Try 1: Direct Public CSV Fetch (works immediately if link sharing is set to Viewer)
          try {
            rows = await fetchPublicSheetCSV(integ.sheet_id);
          } catch (csvErr) {
            rows = [];
          }

          // Try 2: Google Sheets Service Account API Fallback
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

    // 3. Default Fallback Subscriptions based on email if DB row not present
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

    // 4. Return complete dashboard data payload
    res.json({
      totalLeads: logsData.length,
      activeIntercepts: logsData.length,
      pipelineValue: 0,
      creditsBalance: subData.credits_balance ?? 5000,
      client: {
        companyName: 'AfterHours Executive',
        email: userEmail,
      },
      subscription: subData,
      recentIntercepts: logsData,
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
    const { client_email, caller_phone, dispatched_via, outcome } = req.body;

    if (!client_email || !caller_phone) {
      return res.status(400).json({ error: 'Missing client_email or caller_phone' });
    }

    const email = client_email.toLowerCase().trim();
    const channels = dispatched_via || 'WhatsApp + Email';
    const statusOutcome = outcome || 'RECOVERED';
    const createdAt = new Date().toISOString();

    if (db && db.from) {
      const { data, error } = await db
        .from('activity_logs')
        .insert([
          {
            user_email: email,
            contact: caller_phone,
            channels: channels,
            outcome: statusOutcome,
            created_at: createdAt,
          },
        ]);

      if (error) throw error;
      return res.status(200).json({ success: true, message: 'Call log saved to client dashboard', data });
    } else if (db && db.query) {
      const insertQuery = `
        INSERT INTO activity_logs (user_email, contact, channels, outcome, created_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
      `;
      const { rows } = await db.query(insertQuery, [email, caller_phone, channels, statusOutcome, createdAt]);
      return res.status(200).json({ success: true, message: 'Call log saved to client dashboard', data: rows[0] });
    } else {
      return res.status(500).json({ error: 'Database instance not initialized' });
    }
  } catch (err) {
    console.error('[CALL LOG ERROR]', err);
    return res.status(500).json({ error: err.message });
  }
});

module.exports = router;
