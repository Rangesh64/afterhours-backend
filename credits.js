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

  const normalizedEmail = (userEmail || '').toLowerCase().trim();

  switch (actionType) {
    case 'VOICE_CALL':
      const durationSeconds = meta.durationSeconds || 0;

      if (durationSeconds <= 25) {
        // Tier 1: Quick drop / connection activation (<25s)
        creditsToDeduct = 5;
        description = `Inbound Voice Call Drop (${durationSeconds}s) - Activation Fee`;
      } else if (durationSeconds <= 60) {
        // Tier 2: Standard base call threshold (26s - 60s)
        creditsToDeduct = 25;
        description = `Inbound Voice Call (${durationSeconds}s) - Base Minute`;
      } else {
        // Tier 3: Beyond 1 minute - 25 credits base + pro-rated 25 credits/min for additional seconds
        const extraSeconds = durationSeconds - 60;
        creditsToDeduct = 25 + Math.ceil((extraSeconds / 60) * 25);
        description = `Inbound Voice Call (${durationSeconds}s) - Extended Duration`;
      }
      break;

    case 'WHATSAPP_FLOW':
      // 10 credits for direct WhatsApp AI booking confirmation
      creditsToDeduct = 10;
      description = `WhatsApp Direct AI Booking Confirmation`;
      break;

    case 'ADVANCE_CONFIRMATION':
      // 15 credits for advance deposit / fake lead filter verification
      creditsToDeduct = 15;
      description = `Advance Booking Verification & Fake Lead Filter`;
      break;

    default:
      console.error(`Unknown action type: ${actionType}`);
      return { success: false, message: 'Invalid action type' };
  }

  try {
    const query = 'SELECT deduct_credits($1, $2, $3, $4) AS result;';
    const values = [normalizedEmail, creditsToDeduct, actionType, description];
    const { rows } = await pool.query(query, values);

    return rows[0].result;
  } catch (error) {
    console.error('Error executing deductClientCredits:', error);
    return { success: false, error: error.message };
  }
}

module.exports = { deductClientCredits };
