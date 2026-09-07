'use strict'

/**
 * order.paid → affiliate commission (Model 2, product referral). docs/affiliate.md PR 4.
 *
 * Called fire-and-forget from routes/store-checkout.js right after a new order is inserted
 * (store_orders is only ever inserted with payment_status='bezahlt' — order creation IS
 * "order.paid" in this codebase, there's no separate unpaid-order state to watch for).
 * Self-contained (opens its own DB connection) because the checkout request's own client is
 * already closed and the response already sent by the time this fires — same pattern as the
 * existing dispatchOrderFlowEvent/runAutomationFlowsForOrder call right next to it.
 */

const { ensureAffiliateTables } = require('../schema')
const config = require('../config')
const { findApplicableAttribution } = require('../attribution-engine')
const { computeAffiliateCommissionCents } = require('../commission-calculator')
const { isSelfReferral, recordFraudFlag } = require('../fraud-detector')

const getDbClient = () => require('../../../db-pool').getPooledClient()

/**
 * @param {object} params
 * @param {string} params.orderId
 * @param {string|null} params.cookieId the __atrl cookie value the shop's checkout page forwarded, if any
 * @param {string} params.sellerId marketplace seller_id (text)
 * @param {number} params.platformCommissionCents Andertal's own commission on this order (already computed by store-checkout.js)
 * @param {number} params.grossAmountCents merchandise basis the platform commission was computed from
 * @param {string} [params.customerEmail] order contact email — used only for the self-referral check
 * @returns {Promise<string|null>} the created affiliate_commissions id, or null if nothing was attributed
 */
async function recalcAffiliateCommissionForOrder({ orderId, cookieId, sellerId, platformCommissionCents, grossAmountCents, customerEmail }) {
  if (!cookieId || !orderId) return null
  if (!Number.isFinite(platformCommissionCents) || platformCommissionCents <= 0) return null

  const client = getDbClient()
  if (!client) return null
  try {
    await client.connect()
    await ensureAffiliateTables(client)

    const attrRes = await client.query(
      `SELECT * FROM affiliate_attributions
        WHERE cookie_id = $1 AND source_type = 'product' AND resolved_at IS NULL`,
      [cookieId],
    )
    const applicable = findApplicableAttribution(attrRes.rows, new Date())
    if (!applicable) return null

    // docs/affiliate.md: self-referral -> "otomatik reject + high fraud flag". Never create the
    // commission, but still resolve the attribution (so the same click doesn't get re-evaluated
    // against a future, legitimate order).
    if (config.SELF_REFERRAL_AUTO_BLOCK) {
      const affRes = await client.query('SELECT email FROM affiliates WHERE id = $1', [applicable.affiliate_id])
      if (isSelfReferral(affRes.rows[0], { email: customerEmail })) {
        await client.query(
          `UPDATE affiliate_attributions SET resolved_order_id = $1, resolved_seller_id = $2, resolved_at = now(), updated_at = now() WHERE id = $3`,
          [orderId, sellerId, applicable.id],
        )
        await recordFraudFlag(client, applicable.affiliate_id, 'self_referral', 'high', { order_id: orderId })
        return null
      }
    }

    const { rate_pct, commission_cents } = computeAffiliateCommissionCents(platformCommissionCents, 'product_sale')
    if (commission_cents <= 0) return null

    const confirmableAt = new Date(Date.now() + config.CONFIRMATION_HOLD_DAYS * 86400 * 1000)
    const ins = await client.query(
      `INSERT INTO affiliate_commissions
         (affiliate_id, source_type, order_id, seller_id, product_id,
          gross_amount_cents, platform_commission_cents, rate_pct, commission_cents, confirmable_at)
       VALUES ($1,'product_sale',$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        applicable.affiliate_id, orderId, sellerId, applicable.product_id,
        Math.round(grossAmountCents || 0), Math.round(platformCommissionCents), rate_pct, commission_cents, confirmableAt,
      ],
    )
    await client.query(
      `UPDATE affiliate_attributions SET resolved_order_id = $1, resolved_seller_id = $2, resolved_at = now(), updated_at = now() WHERE id = $3`,
      [orderId, sellerId, applicable.id],
    )
    return ins.rows[0].id
  } catch (e) {
    console.warn('recalcAffiliateCommissionForOrder:', e?.message || e)
    return null
  } finally {
    try { await client.end() } catch (_) {}
  }
}

module.exports = { recalcAffiliateCommissionForOrder }
