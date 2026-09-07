'use strict'

/**
 * Andertal treasury → affiliate Stripe Connect payout (docs/affiliate.md PR 7).
 *
 * ⚠️ COMPLIANCE GATE (docs/affiliate.md "Compliance Gate'leri"): "PR 7 (Payout) merge öncesi:
 * Steuerberater vergi modülü review'u + DAC7 raporlama logic doğrulaması." This file moves real
 * money via real Stripe transfers. It is implemented and tested (against Stripe TEST mode) but
 * stays OFF by default — AFFILIATE_PAYOUTS_ENABLED must be explicitly set to 'true' for it to do
 * anything, checked both where it would be scheduled AND inside runMonthlyAffiliatePayouts itself
 * (defense in depth: a direct call without the env var is still a safe no-op). Do not flip that
 * env var on before the Steuerberater review described above has actually happened — this comment
 * is not a formality, it is the actual gate.
 */

const { ensureAffiliateTables } = require('./schema')
const config = require('./config')

const getDbClient = () => require('../../db-pool').getPooledClient()

const PAYOUTS_ENABLED = process.env.AFFILIATE_PAYOUTS_ENABLED === 'true'

/**
 * @returns {Promise<{ ran: boolean, paid: number, skipped_no_stripe_account: number, skipped_below_minimum: number, failed: number }>}
 */
async function runMonthlyAffiliatePayouts() {
  const summary = { ran: false, paid: 0, skipped_no_stripe_account: 0, skipped_below_minimum: 0, failed: 0 }
  if (!PAYOUTS_ENABLED) {
    console.warn('runMonthlyAffiliatePayouts: AFFILIATE_PAYOUTS_ENABLED is not "true" — skipping (see payout-scheduler.js compliance gate comment)')
    return summary
  }

  const client = getDbClient()
  if (!client) return summary
  try {
    await client.connect()
    await ensureAffiliateTables(client)

    const { loadPlatformCheckoutRow, resolveStripeSecretKeyFromPlatform } = require('../../routes/platform-checkout')
    const platformRow = await loadPlatformCheckoutRow(client)
    const secretKey = resolveStripeSecretKeyFromPlatform(platformRow)
    if (!secretKey) {
      console.warn('runMonthlyAffiliatePayouts: no platform Stripe secret key configured')
      return summary
    }
    const stripe = new (require('stripe'))(secretKey)

    const dueRes = await client.query(
      `SELECT a.id AS affiliate_id, a.status, a.stripe_account_id,
              SUM(c.commission_cents)::int AS due_cents,
              array_agg(c.id) AS commission_ids
         FROM affiliate_commissions c
         JOIN affiliates a ON a.id = c.affiliate_id
        WHERE c.status = 'confirmed' AND c.payout_id IS NULL
        GROUP BY a.id, a.status, a.stripe_account_id`,
    )

    const minCents = config.MIN_PAYOUT_EUR * 100
    const periodEnd = new Date()
    const periodStart = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() - 1, 1))

    for (const row of dueRes.rows) {
      if (row.status !== 'active') continue // suspended/banned/closed/pending affiliates are never paid automatically
      if (row.due_cents < minCents) { summary.skipped_below_minimum += 1; continue } // carry-over: stays unlinked, picked up next run
      if (!row.stripe_account_id) { summary.skipped_no_stripe_account += 1; continue } // KYC incomplete

      try {
        const payoutIns = await client.query(
          `INSERT INTO affiliate_payouts (affiliate_id, amount_cents, currency, status, period_start, period_end)
           VALUES ($1,$2,'EUR','processing',$3,$4) RETURNING id`,
          [row.affiliate_id, row.due_cents, periodStart, periodEnd],
        )
        const payoutId = payoutIns.rows[0].id

        const transfer = await stripe.transfers.create({
          amount: row.due_cents,
          currency: 'eur',
          destination: row.stripe_account_id,
          description: `Andertal affiliate commission ${periodStart.toISOString().slice(0, 7)}`,
        })

        await client.query(
          `UPDATE affiliate_payouts SET status = 'paid', stripe_transfer_id = $1, paid_at = now() WHERE id = $2`,
          [transfer.id, payoutId],
        )
        await client.query(
          `UPDATE affiliate_commissions SET status = 'paid', payout_id = $1, updated_at = now() WHERE id = ANY($2::uuid[])`,
          [payoutId, row.commission_ids],
        )
        summary.paid += 1
      } catch (transferErr) {
        console.error(`runMonthlyAffiliatePayouts: transfer failed for affiliate ${row.affiliate_id}:`, transferErr?.message || transferErr)
        await client.query(
          `UPDATE affiliate_payouts SET status = 'failed' WHERE affiliate_id = $1 AND status = 'processing'`,
          [row.affiliate_id],
        ).catch(() => {})
        summary.failed += 1
      }
    }
    summary.ran = true
    return summary
  } catch (e) {
    console.error('runMonthlyAffiliatePayouts:', e?.message || e)
    return summary
  } finally {
    try { await client.end() } catch (_) {}
  }
}

module.exports = { runMonthlyAffiliatePayouts, PAYOUTS_ENABLED }
