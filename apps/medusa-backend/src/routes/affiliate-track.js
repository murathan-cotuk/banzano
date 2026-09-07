'use strict'

/**
 * Public affiliate tracking endpoints (docs/affiliate.md PR 2) — called by the shop's /r/[code]
 * redirect route and by its client-side ref-capture bootstrap (for direct ?ref= landings on
 * product/category/storefront pages, which don't go through /r/). No auth: these are hit by
 * anonymous visitors.
 *
 * GDPR: raw IPs are never stored, only a SHA-256 hash (ip_hash) — see hashIp(). Consent gating
 * happens entirely on the caller's side (shop reads its own cookie-consent state and passes
 * consent_marketing here); this route just trusts and records what it's told, same as any other
 * server that can't independently verify a client's cookie-consent UI state.
 */

const { Router } = require('express')
const crypto = require('crypto')
const { ensureAffiliateTables } = require('../modules/affiliate-platform/schema')
const config = require('../modules/affiliate-platform/config')
const { applyClickToAttribution, isExpired } = require('../modules/affiliate-platform/attribution-engine')
const { isValidAffiliateCode } = require('../modules/affiliate-platform/codes')

const getDbClient = () => require('../db-pool').getPooledClient()

function hashIp(ip) {
  const raw = String(ip || '').trim()
  if (!raw) return null
  return crypto.createHash('sha256').update(raw).digest('hex')
}

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return fwd || req.socket?.remoteAddress || ''
}

async function resolveActiveAffiliateByCode(client, code) {
  if (!isValidAffiliateCode(code)) return null
  const r = await client.query(
    `SELECT id, code, status FROM affiliates WHERE code = $1 AND status = 'active' LIMIT 1`,
    [code],
  )
  return r.rows[0] || null
}

/**
 * @param {import('pg').Client} client
 * @param {{ affiliateId: string, cookieId: string, sourceType: string, productId: string|null }} params
 */
async function upsertAttribution(client, { affiliateId, cookieId, sourceType, productId }) {
  const existingRes = await client.query(
    `SELECT * FROM affiliate_attributions
      WHERE cookie_id = $1 AND source_type = $2
        AND (product_id = $3 OR ($3::uuid IS NULL AND product_id IS NULL))
        AND resolved_at IS NULL
      ORDER BY last_click_at DESC LIMIT 1`,
    [cookieId, sourceType, productId],
  )
  const existing = existingRes.rows[0] || null
  const now = new Date()
  const next = applyClickToAttribution({ existing, affiliateId, cookieId, sourceType, productId, now })

  const reuseExisting = existing && existing.resolved_at == null && !isExpired(existing, now)
  if (reuseExisting) {
    await client.query(
      `UPDATE affiliate_attributions
         SET affiliate_id = $1, last_click_at = $2, expires_at = $3, updated_at = now()
       WHERE id = $4`,
      [next.affiliate_id, next.last_click_at, next.expires_at, existing.id],
    )
    return existing.id
  }
  const insertRes = await client.query(
    `INSERT INTO affiliate_attributions
       (affiliate_id, cookie_id, source_type, product_id, first_click_at, last_click_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [next.affiliate_id, next.cookie_id, next.source_type, next.product_id, next.first_click_at, next.last_click_at, next.expires_at],
  )
  return insertRes.rows[0].id
}

module.exports = function createAffiliateTrackRouter() {
  const router = Router()

  // GET /public/affiliate-track/resolve/:shortCode — /r/[code] calls this first to find out
  // where to redirect (and which affiliate/link/product the click belongs to) before it knows
  // anything about consent.
  router.get('/public/affiliate-track/resolve/:shortCode', async (req, res) => {
    const shortCode = String(req.params.shortCode || '').trim()
    if (!shortCode) return res.status(400).json({ message: 'short code required' })
    const client = getDbClient()
    if (!client) return res.status(503).json({ message: 'Database unavailable' })
    try {
      await client.connect()
      await ensureAffiliateTables(client)
      const r = await client.query(
        `SELECT l.id AS link_id, l.type, l.target_url, l.product_id, l.disabled_at,
                a.id AS affiliate_id, a.code AS affiliate_code, a.status AS affiliate_status
           FROM affiliate_links l
           JOIN affiliates a ON a.id = l.affiliate_id
          WHERE l.short_code = $1
          LIMIT 1`,
        [shortCode],
      )
      const row = r.rows[0]
      if (!row || row.disabled_at || row.affiliate_status !== 'active') {
        return res.status(404).json({ message: 'Link not found' })
      }
      res.json({
        link_id: row.link_id,
        type: row.type,
        target_url: row.target_url,
        product_id: row.product_id,
        affiliate_code: row.affiliate_code,
      })
    } catch (e) {
      console.error('affiliate-track resolve:', e)
      res.status(500).json({ message: e?.message || 'Internal server error' })
    } finally {
      try { await client.end() } catch (_) {}
    }
  })

  // POST /public/affiliate-track/click — records the click (always) and, only when
  // consent_marketing is true, upserts the attribution row that later commission calculation
  // reads (docs/affiliate.md "Cookie Set Akışı").
  router.post('/public/affiliate-track/click', async (req, res) => {
    const body = req.body || {}
    const affiliateCode = String(body.affiliate_code || '').trim()
    const sourceType = config.ATTRIBUTION_SOURCE_TYPES.includes(body.source_type) ? body.source_type : 'storefront'
    const consentMarketing = body.consent_marketing === true
    const productId = sourceType === 'product' && body.product_id ? String(body.product_id) : null
    // Only meaningful (and only ever generated by the caller) when consent is true — see
    // apps/shop's /r/[code] route and affiliate-track API route for where this value comes from.
    const cookieId = consentMarketing && body.cookie_id ? String(body.cookie_id) : null

    const client = getDbClient()
    if (!client) return res.status(503).json({ message: 'Database unavailable' })
    try {
      await client.connect()
      await ensureAffiliateTables(client)

      const affiliate = await resolveActiveAffiliateByCode(client, affiliateCode)
      if (!affiliate) return res.status(404).json({ message: 'Unknown or inactive affiliate code' })

      const linkId = body.link_id ? String(body.link_id) : null
      await client.query(
        `INSERT INTO affiliate_clicks
           (link_id, affiliate_id, ip_hash, user_agent, referer, country, cookie_id, consent_marketing)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          linkId,
          affiliate.id,
          hashIp(clientIp(req)),
          String(req.headers['user-agent'] || '').slice(0, 500),
          String(body.referer || req.headers['referer'] || '').slice(0, 1000),
          String(body.country || '').slice(0, 2).toUpperCase() || null,
          cookieId,
          consentMarketing,
        ],
      )

      let attributionId = null
      if (consentMarketing && cookieId) {
        attributionId = await upsertAttribution(client, { affiliateId: affiliate.id, cookieId, sourceType, productId })
      }
      res.json({ ok: true, attributed: !!attributionId })
    } catch (e) {
      console.error('affiliate-track click:', e)
      res.status(500).json({ message: e?.message || 'Internal server error' })
    } finally {
      try { await client.end() } catch (_) {}
    }
  })

  return router
}
