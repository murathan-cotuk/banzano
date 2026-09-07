'use strict'
const { Router } = require('express')
const { appendBonusLedger } = require('./store-checkout')
const { sqlOrderOwnedBySeller } = require('../seller-scope')

const adminHubAbandonedCartsGET = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    // Every cart that ever had an item added — including ones that later converted to an order
    // (status: purchased) or had all their items removed (status: deleted) — so the sellercentral
    // page can show all three states instead of only "still sitting in the cart".
    const r = await client.query(`
      SELECT c.id, c.created_at, c.updated_at,
        c.email, c.first_name, c.last_name, c.phone,
        COALESCE(
          json_agg(json_build_object('id',ci.id,'title',ci.title,'quantity',ci.quantity,'unit_price_cents',ci.unit_price_cents,'thumbnail',ci.thumbnail,'product_handle',ci.product_handle))
            FILTER (WHERE ci.id IS NOT NULL AND ci.removed_at IS NULL),
          '[]'
        ) as items,
        COUNT(ci.id) FILTER (WHERE ci.removed_at IS NULL)::int as item_count,
        COALESCE(SUM(ci.unit_price_cents * ci.quantity) FILTER (WHERE ci.removed_at IS NULL), 0) as cart_total,
        o.id as order_id
      FROM store_carts c
      JOIN store_cart_items ci ON ci.cart_id = c.id
      LEFT JOIN store_orders o ON o.cart_id = c.id
      GROUP BY c.id, c.created_at, c.updated_at, c.email, c.first_name, c.last_name, c.phone, o.id
      ORDER BY c.updated_at DESC
      LIMIT 500
    `)
    const carts = (r.rows || []).map((row) => ({
      ...row,
      status: row.order_id ? 'purchased' : (Number(row.item_count) > 0 ? 'in_cart' : 'deleted'),
    }))
    await client.end()
    res.json({ carts })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.json({ carts: [] })
  }
}

// POST /admin-hub/v1/abandoned-carts/:id/mark-removed — soft-removes all remaining items on one
// cart (status becomes "deleted" / "Aus Warenkorb entfernt"), which also drops it out of the
// abandoned_cart flow scanner's WHERE/HAVING (see runAbandonedCartScan) so no further emails go out.
const adminHubAbandonedCartMarkRemovedPOST = async (req, res) => {
  const id = (req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(
      `UPDATE store_cart_items SET removed_at = now() WHERE cart_id = $1::uuid AND removed_at IS NULL RETURNING id`,
      [id],
    )
    await client.end()
    res.json({ success: true, items_removed: r.rowCount || 0 })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// POST /admin-hub/v1/abandoned-carts/bulk-mark-removed — marks every still-"in_cart" checkout as
// removed in one go (used to clear a backlog of stale carts that would otherwise re-trigger the
// abandoned_cart flow on every scan).
const adminHubAbandonedCartsBulkMarkRemovedPOST = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(`
      UPDATE store_cart_items ci SET removed_at = now()
      WHERE ci.removed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM store_orders o WHERE o.cart_id = ci.cart_id)
      RETURNING ci.id, ci.cart_id
    `)
    await client.end()
    const cartIds = new Set((r.rows || []).map((row) => row.cart_id))
    res.json({ success: true, items_removed: r.rowCount || 0, carts_affected: cartIds.size })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const adminHubReturnsGET = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const isSuperuser = req.sellerUser?.is_superuser === true
    const jwtSellerId = String(req.sellerUser?.seller_id || '').trim()
    // Non-superusers are forced to their JWT seller — never trust query, never fail-open.
    const sellerId = isSuperuser
      ? String(req.query.seller_id || '').trim()
      : jwtSellerId
    if (!isSuperuser && !sellerId) {
      await client.end()
      return res.status(403).json({ message: 'Forbidden' })
    }
    const params = []
    let where = ''
    if (sellerId) {
      params.push(sellerId)
      const n = params.length
      where = `WHERE (
        NULLIF(TRIM(COALESCE(r.seller_id, '')), '') = $${n}
        OR ${sqlOrderOwnedBySeller('o', `$${n}`)}
      )`
    }
    const r = await client.query(`SELECT r.*, o.order_number, o.email, o.first_name, o.last_name, o.total_cents, o.payment_method, o.seller_id FROM store_returns r LEFT JOIN store_orders o ON o.id = r.order_id ${where} ORDER BY r.created_at DESC LIMIT 100`, params)
    await client.end()
    res.json({ returns: (r.rows || []).map(row => ({ ...row, return_number: row.return_number ? Number(row.return_number) : null, order_number: row.order_number ? Number(row.order_number) : null })) })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.json({ returns: [] })
  }
}

const adminHubReturnsPOST = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const { order_id, reason, notes, items } = req.body || {}
  if (!order_id) return res.status(400).json({ message: 'order_id required' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query('INSERT INTO store_returns (order_id, reason, notes, items) VALUES ($1::uuid, $2, $3, $4) RETURNING *', [order_id, reason || null, notes || null, items ? JSON.stringify(items) : null])
    const row = r.rows && r.rows[0]
    await client.end()
    res.status(201).json({ return: { ...row, return_number: row?.return_number ? Number(row.return_number) : null } })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const adminHubReturnPATCH = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const id = (req.params.id || '').trim()
  const { status, notes, refund_amount_cents, refund_status, refund_note } = req.body || {}
  const allowedStatus = new Set(['offen', 'genehmigt', 'abgelehnt', 'eingegangen', 'abgeschlossen'])
  const sets = []; const params = []
  if (status) {
    if (!allowedStatus.has(status)) return res.status(400).json({ message: 'Invalid status' })
    params.push(status); sets.push(`status = $${params.length}`)
    if (status === 'genehmigt') { sets.push('approved_at = now()') }
    if (status === 'abgelehnt') { sets.push('rejected_at = now()') }
    if (status === 'eingegangen') { sets.push('received_at = now()') }
  }
  if (notes !== undefined) { params.push(notes); sets.push(`notes = $${params.length}`) }
  if (refund_amount_cents !== undefined) { params.push(refund_amount_cents); sets.push(`refund_amount_cents = $${params.length}`) }
  if (refund_status !== undefined) { params.push(refund_status); sets.push(`refund_status = $${params.length}`) }
  if (refund_note !== undefined) { params.push(refund_note); sets.push(`refund_note = $${params.length}`) }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' })
  sets.push('updated_at = now()')
  params.push(id)
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const isSuperuser = req.sellerUser?.is_superuser === true
    const jwtSellerId = String(req.sellerUser?.seller_id || '').trim()
    if (!isSuperuser) {
      if (!jwtSellerId) { await client.end(); return res.status(403).json({ message: 'Forbidden' }) }
      const own = await client.query(
        `SELECT r.id FROM store_returns r
         LEFT JOIN store_orders o ON o.id = r.order_id
         WHERE r.id = $1::uuid AND (
           NULLIF(TRIM(COALESCE(r.seller_id, '')), '') = $2
           OR ${sqlOrderOwnedBySeller('o', '$2')}
         )`,
        [id, jwtSellerId],
      )
      if (!own.rows.length) { await client.end(); return res.status(403).json({ message: 'Forbidden' }) }
    }
    await client.query(`UPDATE store_returns SET ${sets.join(', ')} WHERE id = $${params.length}::uuid`, params)
    if (status === 'genehmigt') {
      await client.query(
        `UPDATE store_orders SET order_status = 'retoure', updated_at = now() WHERE id = (SELECT order_id FROM store_returns WHERE id = $1::uuid)`,
        [id],
      ).catch(() => {})
    }
    if (status === 'abgelehnt') {
      await client.query(
        `UPDATE store_orders SET order_status = CASE
           WHEN payment_status = 'bezahlt' AND delivery_status = 'zugestellt' THEN 'abgeschlossen'
           ELSE order_status
         END, updated_at = now()
         WHERE id = (SELECT order_id FROM store_returns WHERE id = $1::uuid)`,
        [id],
      ).catch(() => {})
    }
    // If refund processed, also mark order as refunded
    if (refund_status === 'erstattet') {
      await client.query(
        `UPDATE store_orders SET order_status = 'refunded', updated_at = now() WHERE id = (SELECT order_id FROM store_returns WHERE id = $1::uuid)`,
        [id]
      ).catch(() => {})
      // docs/affiliate.md PR 4 — claw back any not-yet-paid affiliate commission on this order.
      try {
        const { clawbackAffiliateCommissionsForOrder } = require('../modules/affiliate-platform/workers/commission-clawback')
        const orderIdRow = await client.query(`SELECT order_id FROM store_returns WHERE id = $1::uuid`, [id])
        const refundedOrderId = orderIdRow.rows[0]?.order_id
        if (refundedOrderId) await clawbackAffiliateCommissionsForOrder(client, refundedOrderId)
      } catch (cbErr) {
        console.warn('clawbackAffiliateCommissionsForOrder:', cbErr?.message || cbErr)
      }
      // Auto-reverse bonus points on refund, proportional to how much of the order this specific
      // return actually refunded (BonusPunkte.md §3.4). Idempotency is scoped to THIS return
      // (return_id), not the whole order, so a second/third partial refund on the same order still
      // gets its own reversal instead of being silently skipped because *some* return already ran.
      try {
        const retRow = await client.query(
          `SELECT r.order_id, r.refund_amount_cents, o.customer_id, o.order_number,
                  COALESCE(o.bonus_points_redeemed, 0)::int AS bonus_points_redeemed,
                  COALESCE(o.subtotal_cents, 0)::int AS subtotal_cents,
                  COALESCE(o.shipping_cents, 0)::int AS shipping_cents,
                  COALESCE(o.discount_cents, 0)::int AS discount_cents,
                  o.total_cents AS order_total_cents
           FROM store_returns r
           LEFT JOIN store_orders o ON o.id = r.order_id
           WHERE r.id = $1::uuid`,
          [id]
        )
        const rr = retRow.rows[0]
        if (rr?.customer_id && rr?.order_id) {
          const alreadyEarnedDone = await client.query(
            `SELECT id FROM store_customer_bonus_ledger WHERE return_id = $1::uuid AND source = 'order_return_earn' LIMIT 1`,
            [id]
          )
          const alreadyRedeemDone = await client.query(
            `SELECT id FROM store_customer_bonus_ledger WHERE return_id = $1::uuid AND source = 'order_return_redeem' LIMIT 1`,
            [id]
          )
          // orderPaidTotalCents — same computation as order-money.js's resolveOrderPaidTotalCents,
          // duplicated here (small pure calc) rather than requiring store-checkout.js's whole
          // route module just for this one helper.
          const orderPaidTotalCents = Math.max(
            0,
            (Number(rr.subtotal_cents) + Number(rr.shipping_cents)) - Number(rr.discount_cents),
          ) || Math.max(0, Number(rr.order_total_cents) || 0)
          const thisRefundCents = Math.max(0, Number(rr.refund_amount_cents) || 0)
          // Ratio of THIS refund against what the customer actually paid. Clamped to [0,1] — a
          // ratio of 1 (full refund) reproduces the pre-§3.4 full-reversal behavior exactly.
          const refundRatio = orderPaidTotalCents > 0
            ? Math.min(1, thisRefundCents / orderPaidTotalCents)
            : 0

          if (refundRatio > 0) {
            if (!alreadyEarnedDone.rows.length) {
              const earned = await client.query(
                `SELECT COALESCE(SUM(points_delta), 0)::int AS total FROM store_customer_bonus_ledger WHERE order_id = $1::uuid AND source = 'order_earn'`,
                [rr.order_id]
              )
              const earnedPts = Number(earned.rows[0]?.total || 0)
              const earnedReversal = Math.round(earnedPts * refundRatio)
              if (earnedReversal > 0) {
                await appendBonusLedger(client, {
                  customerId: rr.customer_id, pointsDelta: -earnedReversal,
                  description: `Retoure Bestellung #${rr.order_number} — Punkte zurückgebucht (−${earnedReversal} Punkte, ${Math.round(refundRatio * 100)}% der Bestellung)`,
                  source: 'order_return_earn', orderId: rr.order_id, returnId: id,
                })
              }
            }
            if (!alreadyRedeemDone.rows.length) {
              const redeemedFromOrder = Number(rr.bonus_points_redeemed || 0)
              const pointsToGiveBack = Math.round(redeemedFromOrder * refundRatio)
              if (pointsToGiveBack > 0) {
                await appendBonusLedger(client, {
                  customerId: rr.customer_id, pointsDelta: pointsToGiveBack,
                  description: `Retoure Bestellung #${rr.order_number} — eingelöste Punkte zurückgegeben (+${pointsToGiveBack} Punkte, ${Math.round(refundRatio * 100)}% der Bestellung)`,
                  source: 'order_return_redeem', orderId: rr.order_id, returnId: id,
                })
              }
            }
          }
        }
      } catch (bonusErr) {
        console.warn('bonus reversal on return:', bonusErr?.message)
      }
    }
    const r = await client.query(`SELECT r.*, o.order_number, o.email, o.first_name, o.last_name, o.total_cents, o.payment_method FROM store_returns r LEFT JOIN store_orders o ON o.id = r.order_id WHERE r.id = $1::uuid`, [id])
    await client.end()
    const row = r.rows && r.rows[0]
    res.json({ return: { ...row, return_number: row?.return_number ? Number(row.return_number) : null, order_number: row?.order_number ? Number(row.order_number) : null } })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// POST /admin-hub/v1/returns/:id/send-label — mark label sent + send email to customer
const adminHubReturnSendLabelPOST = async (req, res) => {
  const id = (req.params.id || '').trim()
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(
      `SELECT r.*, o.order_number, o.email, o.first_name, o.last_name, o.total_cents, o.payment_method
       FROM store_returns r LEFT JOIN store_orders o ON o.id = r.order_id WHERE r.id = $1::uuid`,
      [id]
    )
    const row = r.rows && r.rows[0]
    if (!row) { await client.end(); return res.status(404).json({ message: 'Return not found' }) }
    await client.query(`UPDATE store_returns SET label_sent_at = now(), updated_at = now() WHERE id = $1::uuid`, [id])
    await client.end()

    let emailSent = false
    if (row.email && process.env.SMTP_HOST) {
      try {
        const nodemailer = require('nodemailer')
        const transport = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT || '587'),
          secure: process.env.SMTP_SECURE === 'true',
          auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        })
        const customerName = [row.first_name, row.last_name].filter(Boolean).join(' ') || row.email
        const fmtDate = (d) => d ? new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—'
        const labelHtml = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8"><title>Retoureschein</title></head><body style="font-family:Arial,sans-serif;margin:40px;color:#111">
<h1 style="font-size:22px">Retoureschein</h1>
<p style="color:#6b7280;font-size:13px;margin-bottom:24px">Retoure-Nr.: <strong>R-${row.return_number || '—'}</strong> · Bestellung: <strong>#${row.order_number || '—'}</strong></p>
<div style="border:2px dashed #e5e7eb;border-radius:8px;padding:20px;text-align:center;margin:24px 0">
  <div style="font-size:32px;font-weight:800;letter-spacing:4px">R-${row.return_number || '—'}</div>
  <small style="color:#6b7280;font-size:11px">Retoure-Nummer – bitte gut sichtbar auf das Paket kleben</small>
</div>
<p><strong>Rückgabegrund:</strong> ${row.reason || 'Kein Grund angegeben'}</p>
${row.notes ? `<p style="color:#6b7280;font-size:13px">${row.notes}</p>` : ''}
<p style="margin-top:32px;font-size:11px;color:#9ca3af;border-top:1px solid #e5e7eb;padding-top:16px">
  Erstellt am ${fmtDate(row.created_at)} · Bitte legen Sie diesen Schein dem Paket bei.
</p>
</body></html>`
        await transport.sendMail({
          from: process.env.SMTP_FROM || '"Andertal Shop" <noreply@andertal.de>',
          to: row.email,
          subject: `Ihr Retoureschein R-${row.return_number} – Bestellung #${row.order_number}`,
          html: `<p>Hallo ${customerName},</p><p>Ihre Retouranfrage wurde genehmigt. Anbei finden Sie Ihren Retoureschein.</p><p>Bitte legen Sie den Retoureschein dem Paket bei und senden Sie es an uns zurück.</p>${labelHtml}`,
        })
        emailSent = true
      } catch (emailErr) {
        console.error('Return label email error:', emailErr?.message)
      }
    }
    res.json({ success: true, emailSent, label_sent_at: new Date().toISOString() })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// GET/PATCH /admin-hub/v1/return-settings — seller return address (used for customer_ships emails)
const adminHubReturnSettingsGET = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const isSuperuser = req.sellerUser?.is_superuser === true
  const sellerId = isSuperuser
    ? String(req.query.seller_id || req.sellerUser?.seller_id || 'default').trim()
    : String(req.sellerUser?.seller_id || '').trim()
  if (!sellerId) return res.status(403).json({ message: 'Forbidden' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    // Prefer dedicated returns location from Settings → Locations
    const locR = await client.query(
      `SELECT name, address_line1, address_line2, city, postal_code, country
         FROM seller_locations
        WHERE seller_id = $1 AND is_returns_to = true
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 1`,
      [sellerId],
    ).catch(() => ({ rows: [] }))
    const loc = locR.rows?.[0]
    if (loc && String(loc.address_line1 || '').trim()) {
      await client.end()
      const countryRaw = String(loc.country || 'DE').trim()
      const country = /^[a-z]{2}$/i.test(countryRaw)
        ? countryRaw.toUpperCase()
        : (/deutschland|germany|almanya/i.test(countryRaw) ? 'DE' : countryRaw.slice(0, 2).toUpperCase() || 'DE')
      return res.json({
        return_address: {
          name: String(loc.name || '').trim(),
          street: [loc.address_line1, loc.address_line2].filter(Boolean).map((x) => String(x).trim()).join(', '),
          zip: String(loc.postal_code || '').trim(),
          city: String(loc.city || '').trim(),
          country,
        },
      })
    }
    const r = await client.query(
      `SELECT return_address FROM admin_hub_seller_settings WHERE seller_id = $1 LIMIT 1`,
      [sellerId],
    )
    await client.end()
    const addr = r.rows[0]?.return_address && typeof r.rows[0].return_address === 'object'
      ? r.rows[0].return_address
      : {}
    res.json({ return_address: {
      name: String(addr.name || ''),
      street: String(addr.street || ''),
      zip: String(addr.zip || ''),
      city: String(addr.city || ''),
      country: String(addr.country || 'DE'),
    } })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const adminHubReturnSettingsPATCH = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const isSuperuser = req.sellerUser?.is_superuser === true
  const sellerId = isSuperuser
    ? String(req.body?.seller_id || req.sellerUser?.seller_id || 'default').trim()
    : String(req.sellerUser?.seller_id || '').trim()
  if (!sellerId) return res.status(403).json({ message: 'Forbidden' })
  const raw = req.body?.return_address && typeof req.body.return_address === 'object' ? req.body.return_address : {}
  const return_address = {
    name: String(raw.name || '').trim(),
    street: String(raw.street || '').trim(),
    zip: String(raw.zip || '').trim(),
    city: String(raw.city || '').trim(),
    country: String(raw.country || 'DE').trim().toUpperCase().slice(0, 2) || 'DE',
  }
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    await client.query(
      `INSERT INTO admin_hub_seller_settings (seller_id, return_address, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (seller_id) DO UPDATE SET
         return_address = $2::jsonb,
         updated_at = now()`,
      [sellerId, JSON.stringify(return_address)],
    )
    await client.end()
    res.json({ return_address })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

module.exports = function createReturnsRouter() {
  const router = Router()

  router.get('/admin-hub/v1/abandoned-carts', adminHubAbandonedCartsGET)
  router.post('/admin-hub/v1/abandoned-carts/bulk-mark-removed', adminHubAbandonedCartsBulkMarkRemovedPOST)
  router.post('/admin-hub/v1/abandoned-carts/:id/mark-removed', adminHubAbandonedCartMarkRemovedPOST)
  router.get('/admin-hub/v1/returns', adminHubReturnsGET)
  router.post('/admin-hub/v1/returns', adminHubReturnsPOST)
  router.patch('/admin-hub/v1/returns/:id', adminHubReturnPATCH)
  router.post('/admin-hub/v1/returns/:id/send-label', adminHubReturnSendLabelPOST)
  router.get('/admin-hub/v1/return-settings', adminHubReturnSettingsGET)
  router.patch('/admin-hub/v1/return-settings', adminHubReturnSettingsPATCH)

  return router
}
