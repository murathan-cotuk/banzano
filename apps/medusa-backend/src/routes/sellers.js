'use strict'
const { Router } = require('express')

const getDbClient = () => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return null
  const { Client } = require('pg')
  const isRender = dbUrl.includes('render.com')
  return new Client({ connectionString: dbUrl, ssl: isRender ? { rejectUnauthorized: false } : false })
}

module.exports = function createSellersRouter({ getSellerDbClient, signSellerToken, createSellerSession }) {
    // ── SELLER MANAGEMENT (superuser) ─────────────────────────────────────────
    const SELLER_SELECT = `
      id, email, store_name, seller_id, is_superuser, created_at, updated_at,
      iban, commission_rate, first_name, last_name,
      approval_status, company_name, authorized_person_name, tax_id, vat_id,
      business_address, warehouse_address, phone, website,
      lucid_number, epr_document_url,
      documents, rejection_reason, approved_at, approved_by,
      agreement_accepted, agreement_accepted_at, agreement_version, agreement_ip,
      signature_at, signature_ip, signature_data
    `

    // GET /admin-hub/v1/sellers — list all sellers (superuser only)
    const adminHubSellersGET = async (req, res) => {
      if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser access required' })
      const client = getDbClient ? getDbClient() : getSellerDbClient()
      if (!client) return res.status(503).json({ message: 'DB not configured' })
      try {
        await client.connect()
        const r = await client.query(
          `SELECT ${SELLER_SELECT} FROM seller_users WHERE sub_of_seller_id IS NULL ORDER BY created_at DESC`
        )
        // For each seller, count products and aggregate revenue
        const sellerIds = r.rows.map(s => s.seller_id).filter(Boolean)
        let productCounts = {}
        let revenueTotals = {}
        if (sellerIds.length > 0) {
          // product counts (Sellercentral ürünleri admin_hub_products'ta; eski `product` tablosu bu akışta kullanılmıyor)
          try {
            const pc = await client.query(
              `SELECT seller_id, COUNT(*)::int as cnt FROM admin_hub_products WHERE seller_id = ANY($1) GROUP BY seller_id`,
              [sellerIds]
            )
            pc.rows.forEach(row => { productCounts[row.seller_id] = parseInt(row.cnt, 10) })
          } catch (_) {}
          // revenue totals (paid orders)
          try {
            const rv = await client.query(
              `SELECT seller_id, SUM(subtotal_cents) AS total_cents, COUNT(*) AS order_cnt
               FROM store_orders WHERE seller_id = ANY($1) AND payment_status = 'bezahlt'
               GROUP BY seller_id`,
              [sellerIds]
            )
            rv.rows.forEach(row => {
              revenueTotals[row.seller_id] = {
                total_cents: parseInt(row.total_cents) || 0,
                order_count: parseInt(row.order_cnt) || 0,
              }
            })
          } catch (_) {}
        }
        await client.end()
        const sellers = r.rows.map(s => ({
          ...s,
          product_count: productCounts[s.seller_id] || 0,
          revenue_cents: revenueTotals[s.seller_id]?.total_cents || 0,
          order_count: revenueTotals[s.seller_id]?.order_count || 0,
          commission_cents: Math.round((revenueTotals[s.seller_id]?.total_cents || 0) * (parseFloat(s.commission_rate) || 0.12)),
        }))
        res.json({ sellers, count: sellers.length })
      } catch (e) {
        try { await client.end() } catch (_) {}
        res.status(500).json({ message: e?.message || 'Error' })
      }
    }

    // GET /admin-hub/v1/sellers/:id — single seller detail (superuser only)
    const adminHubSellerByIdGET = async (req, res) => {
      if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser access required' })
      const { id } = req.params
      const client = getDbClient ? getDbClient() : getSellerDbClient()
      if (!client) return res.status(503).json({ message: 'DB not configured' })
      try {
        await client.connect()
        const r = await client.query(`SELECT ${SELLER_SELECT} FROM seller_users WHERE id = $1`, [id])
        if (!r.rows[0]) { await client.end(); return res.status(404).json({ message: 'Seller not found' }) }
        const seller = r.rows[0]
        const sellerId = seller.seller_id

        // Products by category (admin_hub_products; slug veya kategori UUID üzerinden etiket)
        let productsByCategory = []
        try {
          const pc = await client.query(
            `WITH base AS (
               SELECT id,
                 NULLIF(TRIM(COALESCE(metadata->>'category_slug', '')), '') AS slug_direct,
                 NULLIF(TRIM(COALESCE(metadata->>'admin_category_id', metadata->>'category_id', '')), '') AS cat_id_ref
               FROM admin_hub_products
               WHERE seller_id = $1
             ),
             resolved AS (
               SELECT b.id,
                 COALESCE(
                   b.slug_direct,
                   c.slug,
                   CASE WHEN b.cat_id_ref IS NOT NULL THEN b.cat_id_ref END,
                   'Unkategorisiert'
                 ) AS category
               FROM base b
               LEFT JOIN admin_hub_categories c ON c.id::text = b.cat_id_ref
             )
             SELECT category, COUNT(*)::int AS cnt
             FROM resolved
             GROUP BY category
             ORDER BY cnt DESC`,
            [sellerId]
          )
          productsByCategory = pc.rows.map((r) => ({ category: r.category, count: parseInt(r.cnt, 10) || 0 }))
        } catch (_) {}

        // Monthly revenue (last 12 months)
        let monthlyRevenue = []
        try {
          const mv = await client.query(
            `SELECT DATE_TRUNC('month', created_at) AS month, SUM(subtotal_cents) AS total_cents, COUNT(*) AS order_cnt
             FROM store_orders WHERE seller_id = $1 AND payment_status = 'bezahlt'
             AND created_at >= NOW() - INTERVAL '12 months'
             GROUP BY 1 ORDER BY 1`,
            [sellerId]
          )
          monthlyRevenue = mv.rows.map(r => ({
            month: r.month,
            total_cents: parseInt(r.total_cents) || 0,
            order_count: parseInt(r.order_cnt) || 0,
          }))
        } catch (_) {}

        // Payout summary
        let payoutSummary = { total_paid_cents: 0, total_pending_cents: 0 }
        try {
          const ps = await client.query(
            `SELECT status, SUM(payout_cents) as total FROM seller_payouts WHERE seller_id = $1 GROUP BY status`,
            [sellerId]
          )
          ps.rows.forEach(r => {
            if (r.status === 'bezahlt') payoutSummary.total_paid_cents += parseInt(r.total) || 0
            else payoutSummary.total_pending_cents += parseInt(r.total) || 0
          })
        } catch (_) {}

        // Recent payouts
        let payouts = []
        try {
          const po = await client.query(
            `SELECT * FROM seller_payouts WHERE seller_id = $1 ORDER BY period_start DESC LIMIT 12`,
            [sellerId]
          )
          payouts = po.rows
        } catch (_) {}

        // Required setup flags (locations / card / IBAN) — for admin review checklist
        let setup = {
          has_iban: !!(seller.iban && String(seller.iban).replace(/\s+/g, "").length >= 15),
          has_card: false,
          has_shipping_from: false,
          has_returns_to: false,
          has_billing: false,
          locations: [],
        }
        try {
          const cardR = await client.query(
            `SELECT stripe_payment_method_id, stripe_card_last4
             FROM seller_users
             WHERE id::text = $1 OR seller_id = $2
             ORDER BY CASE WHEN COALESCE(stripe_payment_method_id, '') <> '' THEN 0 ELSE 1 END, created_at ASC
             LIMIT 1`,
            [id, sellerId],
          )
          setup.has_card = !!(cardR.rows[0]?.stripe_payment_method_id || cardR.rows[0]?.stripe_card_last4)
        } catch (_) {}
        try {
          const locR = await client.query(
            `SELECT id, name, type, address_line1, address_line2, city, postal_code, country,
                    is_shipping_from, is_returns_to, is_billing, is_primary
               FROM seller_locations
              WHERE seller_id = $1
              ORDER BY is_primary DESC, created_at ASC`,
            [sellerId],
          )
          setup.locations = locR.rows || []
          for (const loc of setup.locations) {
            const hasStreet = !!(loc.address_line1 && String(loc.address_line1).trim())
            if (loc.is_shipping_from && hasStreet) setup.has_shipping_from = true
            if (loc.is_returns_to && hasStreet) setup.has_returns_to = true
            if (loc.is_billing && hasStreet) setup.has_billing = true
          }
        } catch (_) {}

        await client.end()
        res.json({ seller: { ...seller, products_by_category: productsByCategory, monthly_revenue: monthlyRevenue, payout_summary: payoutSummary, payouts, setup } })
      } catch (e) {
        try { await client.end() } catch (_) {}
        res.status(500).json({ message: e?.message || 'Error' })
      }
    }

    // PATCH /admin-hub/v1/sellers/:id — update seller fields (superuser only)
    const adminHubSellerPATCH = async (req, res) => {
      if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser access required' })
      const { id } = req.params
      const body = req.body || {}
      const allowed = ['commission_rate', 'iban', 'store_name', 'company_name', 'tax_id', 'vat_id',
        'business_address', 'warehouse_address', 'phone', 'website', 'documents', 'rejection_reason',
        'lucid_number', 'epr_document_url']
      const updates = []; const params = []; let n = 1
      for (const key of allowed) {
        if (body[key] !== undefined) { updates.push(`${key} = $${n}`); params.push(body[key]); n++ }
      }
      if (updates.length === 0) return res.status(400).json({ message: 'No fields to update' })
      updates.push(`updated_at = now()`)
      params.push(id)
      const client = getDbClient ? getDbClient() : getSellerDbClient()
      if (!client) return res.status(503).json({ message: 'DB not configured' })
      try {
        await client.connect()
        const r = await client.query(`UPDATE seller_users SET ${updates.join(', ')} WHERE id = $${n} RETURNING ${SELLER_SELECT}`, params)
        await client.end()
        if (!r.rows[0]) return res.status(404).json({ message: 'Seller not found' })
        res.json({ seller: r.rows[0] })
      } catch (e) {
        try { await client.end() } catch (_) {}
        res.status(500).json({ message: e?.message || 'Error' })
      }
    }

    // PATCH /admin-hub/v1/sellers/:id/approve — approve or reject seller (superuser only)
    const adminHubSellerApprovePATCH = async (req, res) => {
      if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser access required' })
      const { id } = req.params
      const { status, rejection_reason } = req.body || {}
      const validStatuses = ['registered', 'documents_submitted', 'pending_approval', 'approved', 'rejected', 'suspended', 'documents_required']
      if (!validStatuses.includes(status)) return res.status(400).json({ message: `status must be one of: ${validStatuses.join(', ')}` })
      const client = getDbClient ? getDbClient() : getSellerDbClient()
      if (!client) return res.status(503).json({ message: 'DB not configured' })
      try {
        await client.connect()
        const extraSets = []
        const extraParams = []
        if (status === 'approved') {
          extraSets.push(`approved_at = now()`, `approved_by = '${req.sellerUser.seller_id}'`)
        }
        if (status === 'rejected' && rejection_reason) {
          extraSets.push(`rejection_reason = $${extraParams.length + 3}`)
          extraParams.push(rejection_reason)
        }
        const allSets = [`approval_status = $1`, `updated_at = now()`, ...extraSets].join(', ')
        const r = await client.query(
          `UPDATE seller_users SET ${allSets} WHERE id = $2 RETURNING ${SELLER_SELECT}`,
          [status, id, ...extraParams]
        )
        if (!r.rows[0]) { await client.end(); return res.status(404).json({ message: 'Seller not found' }) }
        const seller = r.rows[0]

        // If approved: publish all their draft products
        if (status === 'approved' && seller.seller_id) {
          try {
            await client.query(
              `UPDATE product SET status = 'published' WHERE seller_id = $1 AND status = 'draft'`,
              [seller.seller_id]
            )
          } catch (e2) {
            console.warn('Could not auto-publish products for seller:', e2?.message)
          }
        }
        // docs/affiliate.md PR 6 — Model 1: create the commission-generating seller_referrals row
        // at APPROVAL time (not at signup). shouldCreateSellerReferral encodes the "first
        // attribute wins, never reassigned" lock-in rule (attribution-engine.js) — the actual
        // enforcement is seller_referrals.seller_id being UNIQUE, this is just the pure-logic
        // mirror of that constraint so the check reads the same everywhere it's used.
        if (status === 'approved' && seller.seller_id) {
          try {
            const { ensureAffiliateTables } = require('../modules/affiliate-platform/schema')
            const { shouldCreateSellerReferral } = require('../modules/affiliate-platform/attribution-engine')
            await ensureAffiliateTables(client)
            const suRow = await client.query('SELECT referred_by_affiliate_id FROM seller_users WHERE id = $1', [id])
            const referredByAffiliateId = suRow.rows[0]?.referred_by_affiliate_id
            if (referredByAffiliateId) {
              const existing = await client.query('SELECT id FROM seller_referrals WHERE seller_id = $1', [seller.seller_id])
              if (shouldCreateSellerReferral(existing.rows[0] || null)) {
                await client.query(
                  `INSERT INTO seller_referrals (affiliate_id, seller_id) VALUES ($1, $2)`,
                  [referredByAffiliateId, seller.seller_id],
                )
              }
            }
          } catch (e3) {
            console.warn('Could not create seller_referrals row on approval:', e3?.message)
          }
        }
        // If rejected/suspended: unpublish their products
        if ((status === 'rejected' || status === 'suspended') && seller.seller_id) {
          try {
            await client.query(
              `UPDATE product SET status = 'draft' WHERE seller_id = $1 AND status = 'published'`,
              [seller.seller_id]
            )
          } catch (e2) {
            console.warn('Could not unpublish products for seller:', e2?.message)
          }
        }

        await client.end()
        res.json({ seller })
        const triggerByStatus = {
          approved: 'seller_verification_approved',
          rejected: 'seller_verification_rejected',
          documents_required: 'seller_documents_required',
        }
        const flowTrigger = triggerByStatus[status]
        if (flowTrigger) {
          setImmediate(() => {
            try { require('../flow-automation').runAutomationFlowsForSellerEvent({ triggerKey: flowTrigger, sellerUserId: id }).catch(() => {}) } catch (_) {}
          })
        }
      } catch (e) {
        try { await client.end() } catch (_) {}
        res.status(500).json({ message: e?.message || 'Error' })
      }
    }

    // PATCH /admin-hub/v1/seller/company-info — seller updates own company info
    const adminHubSellerCompanyInfoPATCH = async (req, res) => {
      const sellerId = req.sellerUser?.seller_id
      if (!sellerId) return res.status(401).json({ message: 'Unauthorized' })
      const body = req.body || {}
      const allowed = ['company_name', 'authorized_person_name', 'tax_id', 'vat_id', 'business_address', 'warehouse_address', 'phone', 'website', 'payment_account_holder', 'payment_bic', 'payment_bank_name', 'lucid_number', 'epr_document_url']
      const updates = []; const params = []; let n = 1
      const toJsonOrNull = (val) => {
        if (val === undefined) return undefined
        if (val === null) return null
        if (typeof val === 'string') return val
        try { return JSON.stringify(val) } catch (_) { return null }
      }
      for (const key of allowed) {
        if (body[key] !== undefined) {
          const isJsonField = key === 'business_address' || key === 'warehouse_address'
          const nextVal = isJsonField ? toJsonOrNull(body[key]) : body[key]
          updates.push(`${key} = $${n}`)
          params.push(nextVal)
          n++
        }
      }
      // Allow submitting documents
      if (body.documents !== undefined) {
        if (body.documents !== null && !Array.isArray(body.documents)) {
          return res.status(400).json({ message: 'documents must be an array (or null).' })
        }
        updates.push(`documents = $${n}`)
        params.push(toJsonOrNull(body.documents))
        n++
      }
      // Auto-advance status if submitting docs
      if (body.documents !== undefined) {
        updates.push(`approval_status = CASE WHEN approval_status = 'registered' THEN 'documents_submitted' ELSE approval_status END`)
      }
      if (updates.length === 0) return res.status(400).json({ message: 'No fields to update' })
      updates.push(`updated_at = now()`)
      params.push(sellerId)
      const client = getDbClient ? getDbClient() : getSellerDbClient()
      if (!client) return res.status(503).json({ message: 'DB not configured' })
      try {
        await client.connect()
        const prevRes = await client.query(`SELECT ${SELLER_SELECT} FROM seller_users WHERE seller_id = $1 LIMIT 1`, [sellerId])
        const prevRow = prevRes.rows[0] || {}
        const wasRegistered = String(prevRow.approval_status || 'registered') === 'registered'
        const r = await client.query(
          `UPDATE seller_users SET ${updates.join(', ')} WHERE seller_id = $${n} RETURNING ${SELLER_SELECT}`,
          params
        )
        await client.end()
        if (!r.rows[0]) return res.status(404).json({ message: 'Seller not found' })
        const seller = r.rows[0]
        res.json({ seller })
        if (body.documents !== undefined && wasRegistered && seller.approval_status === 'documents_submitted') {
          setImmediate(() => {
            try { require('../flow-automation').runAutomationFlowsForSellerEvent({ triggerKey: 'seller_docs_submitted', sellerUserId: seller.id }).catch(() => {}) } catch (_) {}
          })
        }
        const storeName = seller.store_name || seller.email || sellerId || 'Ein Verkäufer'
        const sameJson = (a, b) => {
          try { return JSON.stringify(a ?? null) === JSON.stringify(b ?? null) } catch (_) { return a === b }
        }
        const docsChanged = body.documents !== undefined
          && Array.isArray(body.documents)
          && body.documents.length > 0
          && !sameJson(prevRow.documents, body.documents)
        const changedInfoKeys = allowed.filter((key) => body[key] !== undefined && !sameJson(prevRow[key], body[key]))
        if (docsChanged || changedInfoKeys.length) {
          setImmediate(() => {
            const { insertAdminHubNotificationSafe } = require('../admin-hub-notify')
            if (docsChanged) {
              insertAdminHubNotificationSafe({
                type: 'verification_submitted',
                title: `${storeName} — Evrak eingereicht`,
                body: `${storeName} hat Verifizierungsdokumente eingereicht. Bitte prüfen.`,
                sellerId: sellerId || null,
                referenceId: seller.id,
              })
            }
            if (changedInfoKeys.length) {
              insertAdminHubNotificationSafe({
                type: 'seller_info_change',
                title: `${storeName} — Unternehmensdaten geändert`,
                body: `${storeName} hat Stammdaten aktualisiert (${changedInfoKeys.join(', ')}). Bitte prüfen.`,
                sellerId: sellerId || null,
                referenceId: seller.id,
              })
            }
          })
        }
      } catch (e) {
        try { await client.end() } catch (_) {}
        if (String(e?.message || '').toLowerCase().includes('invalid input syntax for type json')) {
          return res.status(400).json({ message: 'Invalid verification data format. Please check address/documents fields.' })
        }
        res.status(500).json({ message: e?.message || 'Error' })
      }
    }

    // POST /admin-hub/v1/sellers/:id/impersonate — generate a token for a seller (superuser only)
    const adminHubSellerImpersonatePOST = async (req, res) => {
      if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser access required' })
      const { id } = req.params
      const c = getSellerDbClient()
      if (!c) return res.status(503).json({ message: 'Database not configured' })
      try {
        await c.connect()
        const r = await c.query(
          `SELECT su.id, su.email, su.seller_id, su.is_superuser, ss.store_name
           FROM seller_users su
           LEFT JOIN admin_hub_seller_settings ss ON ss.seller_id = su.seller_id
           WHERE su.id::text = $1 OR su.seller_id = $1
           LIMIT 1`,
          [id]
        )
        if (!r.rows.length) {
          await c.end()
          return res.status(404).json({ message: 'Seller not found' })
        }
        const u = r.rows[0]
        let sessionId = null
        if (typeof createSellerSession === 'function') {
          sessionId = await createSellerSession(c, {
            userId: u.id,
            sellerId: u.seller_id,
            req,
          }).catch((e) => {
            console.error('createSellerSession (impersonate) failed:', e?.message || e)
            return null
          })
        }
        await c.end()
        const token = signSellerToken({
          id: u.id,
          email: u.email,
          seller_id: u.seller_id,
          is_superuser: u.is_superuser,
          store_name: u.store_name || '',
          sid: sessionId || undefined,
          impersonated: true,
        })
        res.json({ token, seller: { id: u.id, email: u.email, seller_id: u.seller_id, store_name: u.store_name || '', is_superuser: u.is_superuser } })
      } catch (e) {
        try { await c.end() } catch (_) {}
        res.status(500).json({ message: e?.message || 'Error' })
      }
    }

  const router = Router()

    router.get('/admin-hub/v1/sellers', adminHubSellersGET)
    router.get('/admin-hub/v1/sellers/:id', adminHubSellerByIdGET)
    router.patch('/admin-hub/v1/sellers/:id', adminHubSellerPATCH)
    router.patch('/admin-hub/v1/sellers/:id/approve', adminHubSellerApprovePATCH)
    router.post('/admin-hub/v1/sellers/:id/impersonate', adminHubSellerImpersonatePOST)
    router.patch('/admin-hub/v1/seller/company-info', adminHubSellerCompanyInfoPATCH)


  return router
}
