'use strict'

/**
 * Periodic job (docs/affiliate.md: "Daily cron: confirmable_at <= now AND status='pending' →
 * confirmed") — promotes commissions past their 30-day hold to 'confirmed', making them eligible
 * for the next monthly payout run (PR 7). Registered as a setInterval in server.js, matching the
 * house pattern for every other periodic job here (runAbandonedCartScan, runWinBackScan, etc.) —
 * no external cron system in this codebase.
 */

const { ensureAffiliateTables } = require('../schema')

const getDbClient = () => require('../../../db-pool').getPooledClient()

/** @returns {Promise<number>} number of commissions confirmed this run */
async function confirmDueAffiliateCommissions() {
  const client = getDbClient()
  if (!client) return 0
  try {
    await client.connect()
    await ensureAffiliateTables(client)
    const r = await client.query(
      `UPDATE affiliate_commissions
          SET status = 'confirmed', updated_at = now()
        WHERE status = 'pending' AND confirmable_at <= now()
        RETURNING id`,
    )
    return r.rows.length
  } catch (e) {
    console.warn('confirmDueAffiliateCommissions:', e?.message || e)
    return 0
  } finally {
    try { await client.end() } catch (_) {}
  }
}

module.exports = { confirmDueAffiliateCommissions }
