'use strict'

/**
 * order.refunded → clawback (docs/affiliate.md PR 4).
 *
 * Scope: 'pending' and 'confirmed' commissions on the refunded order become 'clawed_back'
 * outright. Commissions already 'paid' are deliberately left alone here — docs/affiliate.md
 * wants those deducted from the affiliate's NEXT payout (negative-balance carryover), which
 * needs the payout scheduler itself (PR 7) to exist first; clawing back money already paid out
 * with no payout-side accounting for it would just make the ledger wrong. Until PR 7 lands,
 * paid commissions on a later-refunded order are an accepted gap, not silently "handled".
 * emergency_protected rows are never touched by any status here.
 *
 * Called from routes/returns.js at the same `refund_status === 'erstattet'` point that already
 * reverses bonus points — reuses that request's own already-open client (unlike commission-
 * recalc.js, this runs inside the live request, not fire-and-forget after the response).
 */

const { ensureAffiliateTables } = require('../schema')

/**
 * @param {import('pg').Client} client already-connected, caller owns its lifecycle
 * @param {string} orderId
 * @returns {Promise<number>} number of commission rows clawed back
 */
async function clawbackAffiliateCommissionsForOrder(client, orderId) {
  if (!orderId) return 0
  await ensureAffiliateTables(client)
  const r = await client.query(
    `UPDATE affiliate_commissions
        SET status = 'clawed_back', updated_at = now()
      WHERE order_id = $1
        AND status IN ('pending', 'confirmed')
        AND emergency_protected = false
      RETURNING id`,
    [orderId],
  )
  return r.rows.length
}

module.exports = { clawbackAffiliateCommissionsForOrder }
