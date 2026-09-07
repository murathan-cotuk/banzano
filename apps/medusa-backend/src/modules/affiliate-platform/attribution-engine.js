'use strict'

/**
 * Pure attribution logic — no DB, no network. The DB write path (fetching/upserting
 * affiliate_attributions rows) is PR 2's tracking middleware; this module only decides WHAT the
 * next state should be given the current state and a new click/order, so the decision can be unit
 * tested without a database.
 *
 * Model reconciliation (docs/affiliate.md lists both "Attribution modeli: Last-click" AND
 * "Çoklu affiliate çakışması: Lock-in, ilk attribute'ı oluşturan değişmez" — these read as
 * contradictory until split by what they each govern):
 *   - PRE-conversion click tracking (this file, `applyClickToAttribution`) is last-click for
 *     every source type: a visitor can click several affiliates' links before actually buying or
 *     signing up, and whoever's link they clicked LAST is who's currently in line for credit.
 *   - The Model 1 (seller referral) "lock-in, never reassigned" rule is enforced only once an
 *     actual signup happens, via `seller_referrals.seller_id` being UNIQUE — see
 *     `shouldCreateSellerReferral` below. A seller_signup attribution row can still flip between
 *     affiliates on repeat clicks right up until the seller actually registers; after that, the
 *     seller_referrals row is permanent regardless of any later clicks.
 *   - Model 2 (product referral) has no such lock — genuinely last-click at time of purchase,
 *     every time, for every order.
 */

const config = require('./config')

/** @param {'product'|'seller_signup'|'storefront'} sourceType */
function attributionWindowMs(sourceType) {
  if (sourceType === 'seller_signup') return config.SELLER_SIGNUP_ATTRIBUTION_WINDOW_HOURS * 60 * 60 * 1000
  // 'product' and 'storefront' (general/homepage links) share the longer product window —
  // docs/affiliate.md doesn't define a separate storefront window.
  return config.PRODUCT_ATTRIBUTION_WINDOW_DAYS * 24 * 60 * 60 * 1000
}

/**
 * @param {'product'|'seller_signup'|'storefront'} sourceType
 * @param {Date} fromDate anchor point — the click this expiry is computed from
 * @returns {Date}
 */
function computeExpiresAt(sourceType, fromDate = new Date()) {
  return new Date(fromDate.getTime() + attributionWindowMs(sourceType))
}

/**
 * @param {{ expires_at: Date|string, resolved_at?: Date|string|null }} attribution
 * @param {Date} now
 */
function isExpired(attribution, now = new Date()) {
  if (!attribution) return true
  const expiresAt = attribution.expires_at instanceof Date ? attribution.expires_at : new Date(attribution.expires_at)
  return expiresAt.getTime() <= now.getTime()
}

/**
 * Given the current (possibly null) unresolved attribution row for a cookie_id + source_type
 * (+ product_id, when source_type='product'), and a new qualifying click, return the row's next
 * state. Last-click: a new click always wins, even from a different affiliate, as long as the
 * existing row hasn't already converted (`resolved_at` set — a resolved row is history, a fresh
 * click starts a brand new attribution rather than mutating it).
 *
 * @param {object} params
 * @param {object|null} params.existing current attribution row, or null/undefined if none yet
 * @param {string} params.affiliateId
 * @param {string} params.cookieId
 * @param {'product'|'seller_signup'|'storefront'} params.sourceType
 * @param {string|null} [params.productId]
 * @param {Date} [params.now]
 * @returns {object} the attribution row's next state (caller upserts this)
 */
function applyClickToAttribution({ existing, affiliateId, cookieId, sourceType, productId = null, now = new Date() }) {
  const startFresh = !existing || existing.resolved_at != null || isExpired(existing, now)
  const firstClickAt = startFresh ? now : (existing.first_click_at instanceof Date ? existing.first_click_at : new Date(existing.first_click_at))
  return {
    affiliate_id: affiliateId,
    cookie_id: cookieId,
    source_type: sourceType,
    product_id: sourceType === 'product' ? productId : null,
    first_click_at: firstClickAt,
    last_click_at: now,
    expires_at: computeExpiresAt(sourceType, now),
    resolved_order_id: startFresh ? null : (existing.resolved_order_id ?? null),
    resolved_seller_id: startFresh ? null : (existing.resolved_seller_id ?? null),
    resolved_at: startFresh ? null : (existing.resolved_at ?? null),
  }
}

/**
 * Model 1 lock-in: once a seller has ANY seller_referrals row, a later signup attempt (even from
 * a different affiliate's link, even if that affiliate's click is more recent) must never create
 * a second one or reassign it — `seller_referrals.seller_id` is UNIQUE precisely so a duplicate
 * insert fails closed. This function is the pure-logic mirror of that constraint, so the "first
 * attribute wins" rule is documented and testable independent of the DB.
 *
 * @param {object|null} existingReferral seller_referrals row for this seller_id, or null
 * @returns {boolean} true if a new seller_referrals row should be created
 */
function shouldCreateSellerReferral(existingReferral) {
  return existingReferral == null
}

/**
 * Order-paid time: among several product attribution rows for the same visitor (cookie_id and/or
 * customer_id resolved upstream to the same set of rows by the caller), pick the one that should
 * get commission credit — the most recently clicked one that hasn't expired and hasn't already
 * been resolved to a different order.
 *
 * @param {object[]} attributions candidate affiliate_attributions rows, same cookie/customer
 * @param {Date} [now]
 * @returns {object|null}
 */
function findApplicableAttribution(attributions, now = new Date()) {
  const eligible = (attributions || []).filter((a) => a.source_type === 'product' && a.resolved_at == null && !isExpired(a, now))
  if (!eligible.length) return null
  return eligible.reduce((latest, a) => {
    const aTime = (a.last_click_at instanceof Date ? a.last_click_at : new Date(a.last_click_at)).getTime()
    const latestTime = (latest.last_click_at instanceof Date ? latest.last_click_at : new Date(latest.last_click_at)).getTime()
    return aTime > latestTime ? a : latest
  }, eligible[0])
}

module.exports = {
  attributionWindowMs,
  computeExpiresAt,
  isExpired,
  applyClickToAttribution,
  shouldCreateSellerReferral,
  findApplicableAttribution,
}
