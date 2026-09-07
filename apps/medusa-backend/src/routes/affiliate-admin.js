'use strict'

/**
 * SellerCentral /affiliate-admin — superuser-only (docs/affiliate.md PR 8). Mounted under
 * /admin-hub, so the existing gatekeeper in server.js already requires a seller bearer token;
 * every handler here additionally checks req.sellerUser.is_superuser itself.
 */
const { Router } = require('express')
const { ensureAffiliateTables } = require('../modules/affiliate-platform/schema')
const { recordFraudFlag } = require('../modules/affiliate-platform/fraud-detector')

const MANUAL_FLAG_TYPES = new Set(['brand_bid', 'manual'])
const SEVERITIES = new Set(['low', 'medium', 'high'])

const getDbClient = () => require('../db-pool').getPooledClient()

function requireSuperuserLocal(req, res, next) {
  if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser access required' })
  next()
}

module.exports = function createAffiliateAdminRouter() {
  const router = Router()

  function withClient(handler) {
    return async (req, res) => {
      const client = getDbClient()
      if (!client) return res.status(503).json({ message: 'Database unavailable' })
      try {
        await client.connect()
        await ensureAffiliateTables(client)
        await handler(req, res, client)
      } catch (e) {
        console.error('affiliate-admin:', e)
        if (!res.headersSent) res.status(500).json({ message: e?.message || 'Internal server error' })
      } finally {
        try { await client.end() } catch (_) {}
      }
    }
  }

  // ── Pending affiliate signups ───────────────────────────────────────────────
  router.get('/admin-hub/v1/affiliate-admin/pending', requireSuperuserLocal, withClient(async (req, res, client) => {
    const r = await client.query(
      `SELECT id, code, email, full_name, company_name, country, vat_number, tax_id, created_at
         FROM affiliates WHERE status = 'pending' ORDER BY created_at ASC`,
    )
    res.json({ affiliates: r.rows })
  }))

  router.post('/admin-hub/v1/affiliate-admin/:id/approve', requireSuperuserLocal, withClient(async (req, res, client) => {
    const r = await client.query(
      `UPDATE affiliates SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id, email, status`,
      [req.params.id],
    )
    if (!r.rows[0]) return res.status(404).json({ message: 'Pending affiliate not found' })
    res.json({ affiliate: r.rows[0] })
  }))

  router.post('/admin-hub/v1/affiliate-admin/:id/reject', requireSuperuserLocal, withClient(async (req, res, client) => {
    const reason = (req.body?.reason || 'rejected_at_signup').toString().slice(0, 200)
    const r = await client.query(
      `UPDATE affiliates SET status = 'banned', ban_reason = $2, updated_at = now() WHERE id = $1 AND status = 'pending' RETURNING id, email, status`,
      [req.params.id, reason],
    )
    if (!r.rows[0]) return res.status(404).json({ message: 'Pending affiliate not found' })
    res.json({ affiliate: r.rows[0] })
  }))

  // ── Fraud queue ──────────────────────────────────────────────────────────────
  router.get('/admin-hub/v1/affiliate-admin/fraud', requireSuperuserLocal, withClient(async (req, res, client) => {
    const severity = req.query.severity
    const params = []
    let where = 'f.resolved_at IS NULL'
    if (severity && ['low', 'medium', 'high'].includes(severity)) {
      params.push(severity)
      where += ` AND f.severity = $${params.length}`
    }
    const r = await client.query(
      `SELECT f.id, f.affiliate_id, f.flag_type, f.severity, f.details, f.created_at,
              a.code AS affiliate_code, a.email AS affiliate_email, a.status AS affiliate_status
         FROM affiliate_fraud_flags f
         JOIN affiliates a ON a.id = f.affiliate_id
        WHERE ${where}
        ORDER BY f.created_at DESC LIMIT 200`,
      params,
    )
    res.json({ flags: r.rows })
  }))

  // Manual fraud flag entry — used by the periodic brand-bid monitoring check (docs/affiliate.md
  // PR 9: since there's no ad-network API integration, a superuser periodically searches the
  // brand's own name on Google/Bing and, if they find a paid ad bidding on it that leads through
  // an affiliate tracking link, looks up the offending affiliate by code and logs it here.
  router.post('/admin-hub/v1/affiliate-admin/fraud', requireSuperuserLocal, withClient(async (req, res, client) => {
    const code = (req.body?.affiliate_code || '').toString().trim().toUpperCase()
    const flagType = (req.body?.flag_type || '').toString().trim()
    const severity = (req.body?.severity || 'medium').toString().trim()
    const notes = (req.body?.notes || '').toString().slice(0, 2000)
    if (!code) return res.status(400).json({ message: 'affiliate_code is required' })
    if (!MANUAL_FLAG_TYPES.has(flagType)) return res.status(400).json({ message: `flag_type must be one of: ${[...MANUAL_FLAG_TYPES].join(', ')}` })
    if (!SEVERITIES.has(severity)) return res.status(400).json({ message: `severity must be one of: ${[...SEVERITIES].join(', ')}` })

    const affRes = await client.query('SELECT id FROM affiliates WHERE code = $1', [code])
    if (!affRes.rows[0]) return res.status(404).json({ message: 'No affiliate with that code' })

    await recordFraudFlag(client, affRes.rows[0].id, flagType, severity, {
      notes,
      logged_by: req.sellerUser.email || req.sellerUser.id || 'superuser',
      source: 'manual_brand_bid_monitoring',
    })
    res.status(201).json({ ok: true })
  }))

  router.post('/admin-hub/v1/affiliate-admin/fraud/:id/resolve', requireSuperuserLocal, withClient(async (req, res, client) => {
    const action = req.body?.action // 'resolve' | 'suspend' | 'ban'
    const flagRes = await client.query('SELECT affiliate_id FROM affiliate_fraud_flags WHERE id = $1', [req.params.id])
    if (!flagRes.rows[0]) return res.status(404).json({ message: 'Flag not found' })
    const affiliateId = flagRes.rows[0].affiliate_id

    await client.query(
      `UPDATE affiliate_fraud_flags SET resolved_by = $1, resolved_at = now() WHERE id = $2`,
      [req.sellerUser.email || req.sellerUser.id || 'superuser', req.params.id],
    )
    if (action === 'suspend') {
      await client.query(`UPDATE affiliates SET status = 'suspended', updated_at = now() WHERE id = $1`, [affiliateId])
    } else if (action === 'ban') {
      await client.query(`UPDATE affiliates SET status = 'banned', ban_reason = 'fraud', updated_at = now() WHERE id = $1`, [affiliateId])
    }
    res.json({ ok: true })
  }))

  // ── Payout history ───────────────────────────────────────────────────────────
  router.get('/admin-hub/v1/affiliate-admin/payouts', requireSuperuserLocal, withClient(async (req, res, client) => {
    const r = await client.query(
      `SELECT p.id, p.affiliate_id, p.amount_cents, p.currency, p.status, p.stripe_transfer_id,
              p.period_start, p.period_end, p.created_at, p.paid_at,
              a.code AS affiliate_code, a.email AS affiliate_email
         FROM affiliate_payouts p
         JOIN affiliates a ON a.id = p.affiliate_id
        ORDER BY p.created_at DESC LIMIT 200`,
    )
    res.json({ payouts: r.rows })
  }))

  return router
}
