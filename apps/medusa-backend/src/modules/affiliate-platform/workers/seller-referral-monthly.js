'use strict'

/**
 * Model 1 (seller referral) monthly commission — docs/affiliate.md: "cron, ayın 1'i — platform_fee
 * × 5%, sabit". For every active seller_referrals row, sums that seller's own platform commission
 * (Andertal's cut, same stripe_application_fee_cents-with-12%-fallback logic seller-billing.js
 * already uses for seller invoicing — not reinvented here, just mirrored) over the previous
 * calendar month, then credits the referring affiliate 5% of that sum as one affiliate_commissions
 * row. Refunded orders are excluded — no per-order clawback exists for this source_type since it's
 * a monthly aggregate, not a single order, so simply not counting refunded revenue in the sum is
 * the accurate treatment (docs/affiliate.md has no explicit rule for seller_referral refunds).
 *
 * Idempotent: re-running for a month that's already been credited for a given seller is a no-op
 * (checked via an existing affiliate_commissions row with earned_at inside that period) — safe to
 * call from a periodic setInterval rather than needing a precise once-a-month cron trigger.
 */

const { ensureAffiliateTables } = require('../schema')
const { computeAffiliateCommissionCents } = require('../commission-calculator')
const config = require('../config')

const getDbClient = () => require('../../../db-pool').getPooledClient()

/** Previous full calendar month in UTC, as [start, end) */
function previousMonthRange(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  return { start, end }
}

/**
 * @param {{ start: Date, end: Date }} [period] defaults to the previous calendar month
 * @returns {Promise<number>} number of affiliate_commissions rows created
 */
async function runSellerReferralMonthly(period) {
  const { start, end } = period || previousMonthRange()
  const client = getDbClient()
  if (!client) return 0
  let created = 0
  try {
    await client.connect()
    await ensureAffiliateTables(client)

    const referrals = await client.query(
      `SELECT id, affiliate_id, seller_id, current_rate_pct FROM seller_referrals WHERE commission_tier_active = true`,
    )

    for (const ref of referrals.rows) {
      const already = await client.query(
        `SELECT id FROM affiliate_commissions
          WHERE seller_id = $1 AND source_type = 'seller_referral' AND earned_at >= $2 AND earned_at < $3
          LIMIT 1`,
        [ref.seller_id, start, end],
      )
      if (already.rows.length) continue // already credited for this period

      const ordersRes = await client.query(
        `SELECT COALESCE(SUM(
                  CASE WHEN stripe_application_fee_cents IS NOT NULL AND stripe_application_fee_cents > 0
                       THEN stripe_application_fee_cents
                       ELSE ROUND(COALESCE(subtotal_cents, 0) * 0.12)
                  END
                ), 0)::int AS platform_commission_cents
           FROM store_orders
          WHERE seller_id = $1 AND payment_status = 'bezahlt' AND order_status <> 'refunded'
            AND created_at >= $2 AND created_at < $3`,
        [ref.seller_id, start, end],
      )
      const platformCommissionCents = ordersRes.rows[0]?.platform_commission_cents || 0
      if (platformCommissionCents <= 0) continue

      const { rate_pct, commission_cents } = computeAffiliateCommissionCents(platformCommissionCents, 'seller_referral')
      if (commission_cents <= 0) continue

      // earned_at must land inside [start, end) — the idempotency check above filters on that
      // range, so anchoring it to `end` (outside the range) would defeat re-run safety.
      const confirmableAt = new Date(end.getTime() + config.CONFIRMATION_HOLD_DAYS * 86400 * 1000)
      await client.query(
        `INSERT INTO affiliate_commissions
           (affiliate_id, source_type, seller_id, gross_amount_cents, platform_commission_cents,
            rate_pct, commission_cents, earned_at, confirmable_at)
         VALUES ($1,'seller_referral',$2,$3,$3,$4,$5,$6,$7)`,
        [ref.affiliate_id, ref.seller_id, platformCommissionCents, rate_pct, commission_cents, start, confirmableAt],
      )
      created += 1
    }
    return created
  } catch (e) {
    console.warn('runSellerReferralMonthly:', e?.message || e)
    return created
  } finally {
    try { await client.end() } catch (_) {}
  }
}

module.exports = { runSellerReferralMonthly, previousMonthRange }
