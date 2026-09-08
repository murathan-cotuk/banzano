'use strict'
/**
 * Affiliate Portal API — /affiliate-api/v1/ (docs/affiliate.md PR 3: signup/login/dashboard/links
 * skeleton — no reports/payouts/settings/resources/terms yet, those are later PRs).
 * Auth: affiliate JWT (aff_token), separate from seller/developer JWTs.
 * Public: POST /auth/signup, POST /auth/login
 */
const { Router } = require('express')
const config = require('../modules/affiliate-platform/config')
const { ensureAffiliateTables } = require('../modules/affiliate-platform/schema')
const { generateAffiliateCode } = require('../modules/affiliate-platform/codes')
const {
  hashPassword, verifyPassword, validatePasswordStrength,
  signAffiliateToken, verifyAffiliateToken,
} = require('../modules/affiliate-platform/auth')
const {
  isStorePublishedStatus, isStoreVisibleSellerProduct, storePublishedStatusSql, getApprovedSellerIdsSet,
} = require('./seller-settings')
const { loadPlatformCheckoutRow, resolveStripeSecretKeyFromPlatform } = require('./platform-checkout')

const getDbClient = () => require('../db-pool').getPooledClient()

const AFFILIATE_PORTAL_URL = (process.env.AFFILIATE_PORTAL_URL || process.env.NEXT_PUBLIC_AFFILIATE_PORTAL_URL || 'http://localhost:3004').replace(/\/$/, '')

async function loadPlatformStripeSecretKey() {
  const client = getDbClient()
  if (!client) return ''
  try {
    await client.connect()
    const row = await loadPlatformCheckoutRow(client)
    return resolveStripeSecretKeyFromPlatform(row)
  } catch (_) {
    return ''
  } finally {
    try { await client.end() } catch (_) {}
  }
}

function requireAffiliateAuth(req, res, next) {
  const auth = req.headers.authorization || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return res.status(401).json({ message: 'Affiliate token required' })
  const payload = verifyAffiliateToken(token)
  if (!payload) return res.status(401).json({ message: 'Invalid or expired token' })
  req.affiliate = payload
  next()
}

function publicAffiliate(row) {
  if (!row) return null
  const { password_hash, ...rest } = row
  return rest
}

async function generateUniqueCode(client) {
  for (let i = 0; i < 10; i++) {
    const code = generateAffiliateCode()
    const existing = await client.query('SELECT id FROM affiliates WHERE code = $1', [code])
    if (!existing.rows.length) return code
  }
  throw new Error('Could not generate a unique affiliate code')
}

module.exports = function createAffiliateApiRouter() {
  const router = Router()

  // Every handler needs the tables to exist and a live client — small shared wrapper so each
  // route body only has its own logic, matching the other extracted routers' shape closely
  // enough while cutting the repeated connect/ensure/error boilerplate.
  function withClient(handler) {
    return async (req, res) => {
      const client = getDbClient()
      if (!client) return res.status(503).json({ message: 'Database unavailable' })
      try {
        await client.connect()
        await ensureAffiliateTables(client)
        await handler(req, res, client)
      } catch (e) {
        console.error('affiliate-api:', e)
        if (!res.headersSent) res.status(500).json({ message: e?.message || 'Internal server error' })
      } finally {
        try { await client.end() } catch (_) {}
      }
    }
  }

  // ── POST /auth/signup ─────────────────────────────────────────────────────────
  router.post('/auth/signup', withClient(async (req, res, client) => {
    const { email, password, full_name, company_name, country, vat_number, terms_accepted } = req.body || {}
    if (!email || !password) return res.status(400).json({ message: 'email and password are required' })
    if (!full_name) return res.status(400).json({ message: 'full_name is required' })
    const pwError = validatePasswordStrength(password)
    if (pwError) return res.status(400).json({ message: pwError })
    if (!terms_accepted) return res.status(400).json({ message: 'You must accept the affiliate terms to register' })
    const normCountry = String(country || '').trim().toUpperCase()
    if (!config.ALLOWED_COUNTRIES.includes(normCountry)) {
      return res.status(400).json({ message: `Affiliate signups are only open in: ${config.ALLOWED_COUNTRIES.join(', ')}` })
    }
    const normEmail = String(email).toLowerCase().trim()
    const existing = await client.query('SELECT id FROM affiliates WHERE email = $1', [normEmail])
    if (existing.rows.length) return res.status(409).json({ message: 'Email already registered' })

    const code = await generateUniqueCode(client)
    const passwordHash = hashPassword(password)
    // Manual approval for the first N (config.MANUAL_APPROVAL_FIRST_N_AFFILIATES) — trust-score
    // auto-approve after that is not implemented in this PR, so every signup starts 'pending'
    // regardless of count; a superuser approval flow lands in PR 8 (affiliate-admin panel).
    const r = await client.query(
      `INSERT INTO affiliates (code, email, password_hash, full_name, company_name, country, vat_number, status, terms_accepted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',now())
       RETURNING id, code, email, full_name, company_name, country, status, created_at`,
      [code, normEmail, passwordHash, full_name.trim(), company_name?.trim() || null, normCountry, vat_number?.trim() || null],
    )
    const affiliate = r.rows[0]
    const token = signAffiliateToken({ id: affiliate.id, email: affiliate.email, status: affiliate.status })
    res.status(201).json({ token, affiliate })
  }))

  // ── POST /auth/login ──────────────────────────────────────────────────────────
  router.post('/auth/login', withClient(async (req, res, client) => {
    const { email, password } = req.body || {}
    if (!email || !password) return res.status(400).json({ message: 'email and password are required' })
    const normEmail = String(email).toLowerCase().trim()
    const r = await client.query('SELECT * FROM affiliates WHERE email = $1', [normEmail])
    const affiliate = r.rows[0]
    if (!affiliate || !verifyPassword(password, affiliate.password_hash)) {
      return res.status(401).json({ message: 'Invalid email or password' })
    }
    if (affiliate.status === 'banned' || affiliate.status === 'closed') {
      return res.status(403).json({ message: `This account is ${affiliate.status}.` })
    }
    const token = signAffiliateToken({ id: affiliate.id, email: affiliate.email, status: affiliate.status })
    res.json({ token, affiliate: publicAffiliate(affiliate) })
  }))

  // ── GET /auth/me ───────────────────────────────────────────────────────────────
  router.get('/auth/me', requireAffiliateAuth, withClient(async (req, res, client) => {
    const r = await client.query('SELECT * FROM affiliates WHERE id = $1', [req.affiliate.id])
    if (!r.rows[0]) return res.status(404).json({ message: 'Affiliate not found' })
    res.json({ affiliate: publicAffiliate(r.rows[0]) })
  }))

  // ── GET /links — own links, most recent first ──────────────────────────────────
  router.get('/links', requireAffiliateAuth, withClient(async (req, res, client) => {
    const r = await client.query(
      `SELECT id, type, target_url, short_code, product_id, label, disabled_at, created_at
         FROM affiliate_links WHERE affiliate_id = $1 ORDER BY created_at DESC`,
      [req.affiliate.id],
    )
    res.json({ links: r.rows })
  }))

  // ── POST /links — create a link. Model 2: any catalog product, no seller enrollment gate. ──
  router.post('/links', requireAffiliateAuth, withClient(async (req, res, client) => {
    const { type, target_url, product_id, label } = req.body || {}
    if (!config.LINK_TYPES.includes(type)) {
      return res.status(400).json({ message: `type must be one of: ${config.LINK_TYPES.join(', ')}` })
    }
    if (!target_url || typeof target_url !== 'string') {
      return res.status(400).json({ message: 'target_url is required' })
    }
    if (type === 'product' && !product_id) {
      return res.status(400).json({ message: 'product_id is required for type=product' })
    }

    let shortCode = null
    for (let i = 0; i < 10; i++) {
      const candidate = require('crypto').randomBytes(5).toString('hex')
      const exists = await client.query('SELECT id FROM affiliate_links WHERE short_code = $1', [candidate])
      if (!exists.rows.length) { shortCode = candidate; break }
    }
    if (!shortCode) return res.status(500).json({ message: 'Could not generate a unique short code' })

    const r = await client.query(
      `INSERT INTO affiliate_links (affiliate_id, type, target_url, short_code, product_id, label)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, type, target_url, short_code, product_id, label, created_at`,
      [req.affiliate.id, type, target_url, shortCode, type === 'product' ? product_id : null, label?.trim() || null],
    )
    res.status(201).json({ link: r.rows[0] })
  }))

  // ── GET /products/search — catalog search for the link-generator's product picker. Model 2
  // has no enrollment gate, so this is just "any product a customer could actually buy" (same
  // published + seller-approved visibility rules store-products.js applies), never scoped to a
  // seller who opted in — there is no such opt-in. ──
  router.get('/products/search', requireAffiliateAuth, withClient(async (req, res, client) => {
    const q = String(req.query.q || '').trim()
    if (q.length < 2) return res.json({ products: [] })
    const r = await client.query(
      `SELECT id, title, handle, status, seller_id, metadata
         FROM admin_hub_products
        WHERE ${storePublishedStatusSql('status')} AND title ILIKE $1
        ORDER BY title ASC
        LIMIT 40`,
      [`%${q}%`],
    )
    const approvedSellerIds = await getApprovedSellerIdsSet()
    const visible = r.rows
      .filter((p) => isStorePublishedStatus(p.status) && isStoreVisibleSellerProduct(p, approvedSellerIds))
      .slice(0, 8)
      .map((p) => ({ id: p.id, title: p.title, handle: p.handle }))
    res.json({ products: visible })
  }))

  // ── GET /dashboard — summary counters; commission totals are 0 until PR 4 exists ──
  router.get('/dashboard', requireAffiliateAuth, withClient(async (req, res, client) => {
    const affiliateId = req.affiliate.id
    const [links, clicks, referrals, commissions] = await Promise.all([
      client.query('SELECT COUNT(*)::int AS n FROM affiliate_links WHERE affiliate_id = $1 AND disabled_at IS NULL', [affiliateId]),
      client.query('SELECT COUNT(*)::int AS n FROM affiliate_clicks WHERE affiliate_id = $1', [affiliateId]),
      client.query('SELECT COUNT(*)::int AS n FROM seller_referrals WHERE affiliate_id = $1', [affiliateId]),
      client.query(
        `SELECT
           COALESCE(SUM(commission_cents) FILTER (WHERE status = 'pending'), 0)::int AS pending_cents,
           COALESCE(SUM(commission_cents) FILTER (WHERE status IN ('confirmed','paid')), 0)::int AS confirmed_or_paid_cents
         FROM affiliate_commissions WHERE affiliate_id = $1`,
        [affiliateId],
      ),
    ])
    res.json({
      active_links: links.rows[0].n,
      total_clicks: clicks.rows[0].n,
      referred_sellers: referrals.rows[0].n,
      pending_commission_cents: commissions.rows[0].pending_cents,
      confirmed_commission_cents: commissions.rows[0].confirmed_or_paid_cents,
      currency: config.CURRENCY,
    })
  }))

  // ── GET /commissions — own commission history for the Reports page (docs/affiliate.md PR 10).
  // Optional ?status= filter; capped at 500 rows (a full export/pagination UI is future work,
  // this is a first-cut report, not a general-purpose ledger API). ──
  router.get('/commissions', requireAffiliateAuth, withClient(async (req, res, client) => {
    const status = String(req.query.status || '').trim()
    const validStatuses = ['pending', 'confirmed', 'clawed_back', 'paid', 'forfeited']
    const params = [req.affiliate.id]
    let where = 'affiliate_id = $1'
    if (validStatuses.includes(status)) {
      params.push(status)
      where += ` AND status = $${params.length}`
    }
    const r = await client.query(
      `SELECT id, source_type, order_id, product_id, gross_amount_cents, platform_commission_cents,
              rate_pct, commission_cents, currency, status, earned_at, confirmable_at, payout_id
         FROM affiliate_commissions
        WHERE ${where}
        ORDER BY earned_at DESC
        LIMIT 500`,
      params,
    )
    res.json({ commissions: r.rows, currency: config.CURRENCY })
  }))

  // ── Stripe Connect (docs/affiliate.md: affiliate/settings — Stripe Connect onboarding).
  // Mirrors routes/stripe-connect.js's seller onboarding flow exactly (Express account, manual
  // payout schedule since Andertal-initiated transfers drive payouts, not Stripe's own schedule),
  // just scoped to the affiliates table instead of seller_users. Without this, stripe_account_id
  // can never be populated and payout-scheduler.js's runMonthlyAffiliatePayouts() would skip every
  // affiliate forever (skipped_no_stripe_account). ──
  router.post('/stripe-connect/onboard', requireAffiliateAuth, withClient(async (req, res, client) => {
    const secretKey = await loadPlatformStripeSecretKey()
    if (!secretKey) return res.status(503).json({ message: 'Stripe is not configured on the platform yet.' })

    const r = await client.query('SELECT email, stripe_account_id FROM affiliates WHERE id = $1', [req.affiliate.id])
    const affiliate = r.rows[0]
    if (!affiliate) return res.status(404).json({ message: 'Affiliate not found' })

    const stripe = new (require('stripe'))(secretKey)
    let stripeAccountId = affiliate.stripe_account_id

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: affiliate.email,
        capabilities: { transfers: { requested: true } },
        settings: { payouts: { schedule: { interval: 'manual' } } },
        metadata: { affiliate_id: req.affiliate.id },
      })
      stripeAccountId = account.id
      await client.query(
        `UPDATE affiliates SET stripe_account_id = $1, updated_at = now() WHERE id = $2`,
        [stripeAccountId, req.affiliate.id],
      )
    }

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${AFFILIATE_PORTAL_URL}/en/settings?refresh=true`,
      return_url: `${AFFILIATE_PORTAL_URL}/en/settings?connected=true`,
      type: 'account_onboarding',
    })
    res.json({ url: accountLink.url, stripe_account_id: stripeAccountId })
  }))

  // ── GET /stripe-connect/status — current Connect status; syncs onboarding_complete from Stripe
  // the same way stripe-connect.js does for sellers. ──
  router.get('/stripe-connect/status', requireAffiliateAuth, withClient(async (req, res, client) => {
    const r = await client.query(
      'SELECT stripe_account_id, stripe_onboarding_complete FROM affiliates WHERE id = $1',
      [req.affiliate.id],
    )
    const row = r.rows[0] || {}
    const stripeAccountId = row.stripe_account_id || null
    let onboardingComplete = !!row.stripe_onboarding_complete

    if (stripeAccountId && !onboardingComplete) {
      const secretKey = await loadPlatformStripeSecretKey()
      if (secretKey) {
        try {
          const stripe = new (require('stripe'))(secretKey)
          const account = await stripe.accounts.retrieve(stripeAccountId)
          onboardingComplete = !!(account.details_submitted && account.payouts_enabled)
          if (onboardingComplete) {
            await client.query(
              `UPDATE affiliates SET stripe_onboarding_complete = true, updated_at = now() WHERE id = $1`,
              [req.affiliate.id],
            )
          }
        } catch (_) {}
      }
    }

    res.json({ connected: !!stripeAccountId, onboarding_complete: onboardingComplete, stripe_account_id: stripeAccountId })
  }))

  // ── GET /stripe-connect/dashboard-link — one-time Express dashboard URL, same as sellers get. ──
  router.get('/stripe-connect/dashboard-link', requireAffiliateAuth, withClient(async (req, res, client) => {
    const r = await client.query('SELECT stripe_account_id FROM affiliates WHERE id = $1', [req.affiliate.id])
    const stripeAccountId = r.rows[0]?.stripe_account_id
    if (!stripeAccountId) return res.status(404).json({ message: 'No Stripe account connected yet.' })

    const secretKey = await loadPlatformStripeSecretKey()
    if (!secretKey) return res.status(503).json({ message: 'Stripe is not configured on the platform yet.' })

    const stripe = new (require('stripe'))(secretKey)
    const loginLink = await stripe.accounts.createLoginLink(stripeAccountId)
    res.json({ url: loginLink.url })
  }))

  // ── GET /referrals — sellers this affiliate referred (Model 1), anonymized per docs/affiliate.md
  // ("S-1234", not the seller's real name) plus this-month / lifetime earnings from their
  // seller_referral commissions. ──
  router.get('/referrals', requireAffiliateAuth, withClient(async (req, res, client) => {
    const r = await client.query(
      `SELECT sr.id, sr.seller_id, sr.referred_at, sr.commission_tier_active, sr.current_rate_pct,
              COALESCE(SUM(ac.commission_cents) FILTER (
                WHERE ac.status IN ('confirmed','paid') AND ac.earned_at >= date_trunc('month', now())
              ), 0)::int AS this_month_cents,
              COALESCE(SUM(ac.commission_cents) FILTER (WHERE ac.status IN ('confirmed','paid')), 0)::int AS lifetime_cents
         FROM seller_referrals sr
         LEFT JOIN affiliate_commissions ac
           ON ac.affiliate_id = sr.affiliate_id AND ac.seller_id = sr.seller_id AND ac.source_type = 'seller_referral'
        WHERE sr.affiliate_id = $1
        GROUP BY sr.id
        ORDER BY sr.referred_at DESC`,
      [req.affiliate.id],
    )
    const referrals = r.rows.map((row, i) => ({
      label: `S-${String(row.seller_id || '').slice(-4).padStart(4, '0') || (1000 + i)}`,
      referred_at: row.referred_at,
      active: row.commission_tier_active,
      rate_pct: row.current_rate_pct,
      this_month_cents: row.this_month_cents,
      lifetime_cents: row.lifetime_cents,
    }))
    res.json({ referrals, currency: config.CURRENCY })
  }))

  // ── GET /payouts — this affiliate's own payout history (PR 10's affiliate portal Payouts page;
  // previously only exposed to superusers via affiliate-admin.js). ──
  router.get('/payouts', requireAffiliateAuth, withClient(async (req, res, client) => {
    const r = await client.query(
      `SELECT id, amount_cents, currency, status, stripe_transfer_id, period_start, period_end, created_at, paid_at
         FROM affiliate_payouts WHERE affiliate_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.affiliate.id],
    )
    const pendingRes = await client.query(
      `SELECT COALESCE(SUM(commission_cents), 0)::int AS cents
         FROM affiliate_commissions WHERE affiliate_id = $1 AND status = 'confirmed' AND payout_id IS NULL`,
      [req.affiliate.id],
    )
    res.json({ payouts: r.rows, next_estimated_cents: pendingRes.rows[0].cents, currency: config.CURRENCY })
  }))

  return router
}
