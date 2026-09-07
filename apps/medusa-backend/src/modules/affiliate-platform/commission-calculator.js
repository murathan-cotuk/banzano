'use strict'

/**
 * Pure commission math — docs/affiliate.md's "Ortak kasa kuralı" formula, split into its two
 * steps so each is independently testable:
 *   1. platform_commission_cents = merchandise basis × Andertal's own commission rate (unrelated
 *      to affiliates — this is what Andertal already earns regardless of any affiliate).
 *   2. affiliate commission = a fixed % OF that platform commission (5% for seller_referral,
 *      8% for product_sale) — never a % of the sale price itself, and never charged to the
 *      seller on top of their existing commission_rate.
 *
 * Full order-event wiring (order.paid → commission-recalc worker, refund → clawback) is PR 4;
 * this file only has the math both that worker and the seller-referral-monthly worker (PR 6)
 * will call.
 */

const config = require('./config')

const RATE_BY_SOURCE_TYPE = {
  seller_referral: config.SELLER_REFERRAL_OF_PLATFORM_PCT,
  product_sale: config.PRODUCT_REFERRAL_OF_PLATFORM_PCT,
}

/**
 * @param {number} merchandiseBasisCents
 * @param {number} [commissionRate] fraction (0.12 = 12%) — defaults to config.DEFAULT_PLATFORM_COMMISSION_RATE,
 *   pass the seller's own seller_users.commission_rate when it's set.
 * @returns {number} rounded integer cents
 */
function computePlatformCommissionCents(merchandiseBasisCents, commissionRate = config.DEFAULT_PLATFORM_COMMISSION_RATE) {
  return Math.round(Number(merchandiseBasisCents || 0) * Number(commissionRate || 0))
}

/**
 * @param {number} platformCommissionCents Andertal's own cut (from computePlatformCommissionCents)
 * @param {'seller_referral'|'product_sale'} sourceType
 * @returns {{ rate_pct: number, commission_cents: number }}
 */
function computeAffiliateCommissionCents(platformCommissionCents, sourceType) {
  const ratePct = RATE_BY_SOURCE_TYPE[sourceType]
  if (ratePct == null) throw new Error(`Unknown affiliate commission source_type: ${sourceType}`)
  return {
    rate_pct: ratePct,
    commission_cents: Math.round(Number(platformCommissionCents || 0) * ratePct / 100),
  }
}

module.exports = { computePlatformCommissionCents, computeAffiliateCommissionCents, RATE_BY_SOURCE_TYPE }
