const pool = require('./db');

/**
 * Deduct credits based on action type
 * @param {string} userEmail - Client's account email
 * @param {string} actionType - 'VOICE_CALL', 'WHATSAPP_FLOW', or 'ADVANCE_CONFIRMATION'
 * @param {object} meta - Extra info (e.g. { durationSeconds: 65 })
 */
async function deductClientCredits(userEmail, actionType, meta = {}) {
  let creditsToDeduct = 0;
  let description = '';

  switch (actionType) {
    case 'VOICE_CALL':
      const durationSeconds = meta.durationSeconds || 60;
      // 25 credits per 60 seconds (pro-rated by second)
      creditsToDeduct = Math.ceil((durationSeconds / 60) * 25);
      description = `Inbound Voice Call - ${durationSeconds}s duration`;
      break;

    case 'WHATSAPP_FLOW':
      creditsToDeduct = 10;
      description = `WhatsApp Automated Booking Flow`;
      break;

    case 'ADVANCE_CONFIRMATION':
      creditsToDeduct = 15;
      description = `Advance Booking Deposit Verified`;
      break;

    default:
      console.error(`Unknown action type: ${actionType}`);
      return { success: false, message: 'Invalid action type' };
  }

  try {
    const query = 'SELECT deduct_credits($1, $2, $3, $4) AS result;';
    const values = [userEmail, creditsToDeduct, actionType, description];
    const { rows } = await pool.query(query, values);

    return rows[0].result;
  } catch (error) {
    console.error('Error executing deductClientCredits:', error);
    return { success: false, error: error.message };
  }
}

module.exports = { deductClientCredits };
