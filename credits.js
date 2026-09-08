const db = require('./db');

/**
 * Calculates credit cost for voice call duration based on pricing rules:
 * - <= 25 seconds: 5 Credits (Fast drop / wrong number)
 * - 26 to 60 seconds: 25 Credits (Full single-minute tier)
 * - > 60 seconds: Pro-rated dynamically at 25 Credits per 60 seconds (ceiling)
 */
function calculateVoiceCallCredits(durationSeconds) {
  const duration = Math.max(0, parseInt(durationSeconds, 10) || 0);

  if (duration <= 25) {
    return 5;
  }

  if (duration <= 60) {
    return 25;
  }

  // Above 60 seconds: pro-rated per minute block (e.g. 61s-120s = 50 credits)
  const billedMinutes = Math.ceil(duration / 60);
  return billedMinutes * 25;
}

/**
 * Deducts credits atomically using the Supabase deduct_credits function
 * and logs the entry to activity_logs with event_text populated.
 */
async function deductClientCredits(userEmail, actionType, meta = {}) {
  const email = (userEmail || '').toLowerCase().trim();
  if (!email) {
    throw new Error('userEmail is required for credit deduction');
  }

  let amount = 0;
  let description = '';

  switch (actionType) {
    case 'VOICE_CALL': {
      const duration = meta.durationSeconds || 0;
      amount = calculateVoiceCallCredits(duration);
      description = `Inbound Voice Call (${duration}s) - Intercepted & Resolved`;
      break;
    }

    case 'WHATSAPP_FLOW': {
      amount = 10;
      description = `Direct Inbound WhatsApp AI Booking Flow`;
      break;
    }

    case 'ADVANCE_CONFIRMATION': {
      amount = 15;
      description = `Verified Advance Booking Deposit Link Dispatched`;
      break;
    }

    default:
      amount = parseInt(meta.customAmount, 10) || 5;
      description = meta.customDescription || `Standard Action: ${actionType}`;
  }

  let deductionResult = null;

  // 1. Execute Atomic Stored Function in PostgreSQL / Supabase
  if (db && db.rpc) {
    // Using Supabase client RPC
    const { data, error } = await db.rpc('deduct_credits', {
      p_user_email: email,
      p_amount: amount,
      p_action_type: actionType,
      p_description: description,
    });

    if (error) {
      console.error('[CREDITS RPC ERROR]', error);
      throw new Error(`Credit deduction failed: ${error.message}`);
    }
    deductionResult = data;
  } else if (db && db.query) {
    // Using pg / node-postgres pool
    const callRpc = `
      SELECT deduct_credits($1, $2, $3, $4) AS result;
    `;
    const { rows } = await db.query(callRpc, [email, amount, actionType, description]);
    deductionResult = rows[0]?.result;
  }

  if (deductionResult && deductionResult.success === false) {
    console.warn(`[CREDITS WARNING] ${deductionResult.message} for ${email}`);
  }

  // 2. Log entry to activity_logs with event_text included
  try {
    const logText = description || `Action: ${actionType} - Deducted ${amount} Credits`;
    const channels = meta.channels || (actionType === 'WHATSAPP_FLOW' ? 'WhatsApp Business' : 'Voice AI + WhatsApp');
    const contact = meta.phone || 'Anonymous Caller';

    if (db && db.from) {
      await db.from('activity_logs').insert([
        {
          user_email: email,
          contact: contact,
          channels: channels,
          outcome: 'RESOLVED',
          event_text: logText,
          created_at: new Date().toISOString(),
        },
      ]);
    } else if (db && db.query) {
      await db.query(
        `INSERT INTO activity_logs (user_email, contact, channels, outcome, event_text, created_at)
         VALUES ($1, $2, $3, $4, $5, $6);`,
        [email, contact, channels, 'RESOLVED', logText, new Date().toISOString()]
      );
    }
  } catch (logErr) {
    console.warn('[ACTIVITY LOG INSERT WARNING]', logErr.message);
  }

  return {
    success: deductionResult?.success ?? true,
    amountDeducted: amount,
    remainingBalance: deductionResult?.remaining_balance ?? null,
    actionType,
    description,
  };
}

module.exports = {
  calculateVoiceCallCredits,
  deductClientCredits,
};
