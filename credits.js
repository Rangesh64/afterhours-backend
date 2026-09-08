const db = require('./db');

const MINIMUM_ACTIVE_THRESHOLD = 20;

/**
 * Calculates credit cost for voice call duration:
 * - <= 20 seconds: 5 Credits (Fast drop / wrong number)
 * - > 20 seconds: 25 Credits per minute block (e.g., 21s-60s = 25 credits, 61s-120s = 50 credits)
 */
function calculateVoiceCallCredits(durationSeconds) {
  const duration = Math.max(0, parseInt(durationSeconds, 10) || 0);

  if (duration <= 20) {
    return 5;
  }

  // Billed at 25 credits per 60-second block once past the 20s mark
  const billedMinutes = Math.ceil(duration / 60);
  return billedMinutes * 25;
}

/**
 * Verifies whether a client has sufficient balance (at least 20 credits)
 * to initiate any voice call, WhatsApp flow, or lead service.
 */
async function hasActiveServiceAccess(userEmail) {
  const email = (userEmail || '').toLowerCase().trim();
  if (!email) return false;

  let balance = 0;

  if (db && db.from) {
    const { data } = await db
      .from('subscriptions')
      .select('credits_balance')
      .eq('user_email', email)
      .maybeSingle();

    balance = data?.credits_balance ?? 0;
  } else if (db && db.query) {
    const res = await db.query(
      'SELECT credits_balance FROM subscriptions WHERE LOWER(user_email) = $1 LIMIT 1',
      [email]
    );
    balance = res.rows[0]?.credits_balance ?? 0;
  }

  return balance >= MINIMUM_ACTIVE_THRESHOLD;
}

/**
 * Deducts credits atomically.
 * Automatically halts any deduction if credits_balance drops below 20.
 */
async function deductClientCredits(userEmail, actionType, meta = {}) {
  const email = (userEmail || '').toLowerCase().trim();
  if (!email) {
    throw new Error('userEmail is required for credit deduction');
  }

  // 1. Check if user meets the minimum 20 credit safety threshold
  const canOperate = await hasActiveServiceAccess(email);
  if (!canOperate) {
    return {
      success: false,
      blocked: true,
      reason: 'INSUFFICIENT_BALANCE_BELOW_THRESHOLD',
      message: `Account suspended: credit balance is below the ${MINIMUM_ACTIVE_THRESHOLD} minimum floor. Top up required.`,
      actionType
    };
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

  // 2. Execute Atomic Stored Function in PostgreSQL / Supabase
  if (db && db.rpc) {
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
    const callRpc = `
      SELECT deduct_credits($1, $2, $3, $4) AS result;
    `;
    const { rows } = await db.query(callRpc, [email, amount, actionType, description]);
    deductionResult = rows[0]?.result;
  }

  // 3. Log entry to activity_logs with event_text included
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
  hasActiveServiceAccess,
  deductClientCredits,
  MINIMUM_ACTIVE_THRESHOLD
};
