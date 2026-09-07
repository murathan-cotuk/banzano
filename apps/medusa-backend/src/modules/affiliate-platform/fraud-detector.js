'use strict'

/**
 * Fraud detection (docs/affiliate.md PR 8). Only self-referral is implemented — the check that's
 * cheap, deterministic, and cited by the doc as SELF_REFERRAL_AUTO_BLOCK: true (config.js), so it
 * runs inline in commission-recalc.js rather than as a separate scan. IP match / velocity /
 * pattern / brand-bid detection need click-level analysis and monitoring infrastructure this PR
 * doesn't build yet — left as later work, not silently implied by this file's existence.
 */

const config = require('./config')

/**
 * @param {{ email?: string }} affiliate
 * @param {{ email?: string }} order the order's contact email
 * @returns {boolean}
 */
function isSelfReferral(affiliate, order) {
  const affEmail = String(affiliate?.email || '').trim().toLowerCase()
  const orderEmail = String(order?.email || '').trim().toLowerCase()
  if (!affEmail || !orderEmail) return false
  return affEmail === orderEmail
}

/**
 * @param {import('pg').Client} client
 * @param {string} affiliateId
 * @param {string} flagType
 * @param {'low'|'medium'|'high'} severity
 * @param {object} [details]
 */
async function recordFraudFlag(client, affiliateId, flagType, severity, details = {}) {
  await client.query(
    `INSERT INTO affiliate_fraud_flags (affiliate_id, flag_type, severity, details) VALUES ($1,$2,$3,$4)`,
    [affiliateId, flagType, severity, JSON.stringify(details)],
  )
  if (config.FRAUD_FLAGS_AUTO_SUSPEND_THRESHOLD > 0) {
    const countRes = await client.query(
      `SELECT COUNT(*)::int AS n FROM affiliate_fraud_flags WHERE affiliate_id = $1 AND resolved_at IS NULL`,
      [affiliateId],
    )
    if (countRes.rows[0].n >= config.FRAUD_FLAGS_AUTO_SUSPEND_THRESHOLD) {
      await client.query(`UPDATE affiliates SET status = 'suspended', updated_at = now() WHERE id = $1 AND status = 'active'`, [affiliateId])
    }
  }
}

module.exports = { isSelfReferral, recordFraudFlag }
