'use strict'
const { Router } = require('express')
const { normalizeThresholdsObject, storePublishedStatusSql } = require('./seller-settings')
const { getSellerDbClient } = require('./seller-auth')

const STRIPE_PM_TYPES = [
  'card','paypal','klarna','sepa_debit','ideal','bancontact','eps','p24','giropay',
  'sofort','link','affirm','afterpay_clearpay','blik','cashapp','mobilepay',
  'multibanco','oxxo','paynow','pix','promptpay','revolut_pay','swish','twint',
  'us_bank_account','wechat_pay','zip','amazon_pay','au_becs_debit','bacs_debit',
  'boleto','fpx','konbini','acss_debit',
]

const loadPlatformCheckoutRow = async (pgClient) => {
  const r = await pgClient.query(
    `SELECT stripe_publishable_key, stripe_secret_key, pay_card, pay_paypal, pay_klarna, paypal_client_id, paypal_client_secret, payment_method_layout, payment_method_types_json FROM store_platform_checkout WHERE id = 1`,
  )
  return r.rows?.[0] || null
}

const resolveStripeSecretKeyFromPlatform = (row) => row ? (row.stripe_secret_key || '').toString().trim() : ''
const resolveStripePublishableFromPlatform = (row) => row ? (row.stripe_publishable_key || '').toString().trim() : ''

const paymentMethodTypesFromPlatformRow = (row) => {
  if (Array.isArray(row?.payment_method_types_json) && row.payment_method_types_json.length > 0) return row.payment_method_types_json
  const payCard = !row || row.pay_card !== false
  const payPaypal = row && row.pay_paypal === true
  const payKlarna = row && row.pay_klarna === true
  const types = []
  if (payCard) types.push('card')
  if (payPaypal) types.push('paypal')
  if (payKlarna) types.push('klarna')
  if (!types.length) types.push('card')
  return types
}

const { getPooledClient } = require('../db-pool')

// Includes /store/seller-settings, fetched on every page load — pooled to avoid a fresh
// Postgres TCP+TLS handshake per request (see src/db-pool.js).
const getDbClient = () => getPooledClient()

// ── Handlers ──────────────────────────────────────────────────────────────────

const stripePaymentMethodsGET = async (req, res) => {
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  let dbClient
  try {
    dbClient = client
    await dbClient.connect()
    const row = await loadPlatformCheckoutRow(dbClient)
    await dbClient.end()
    const sk = resolveStripeSecretKeyFromPlatform(row)
    if (!sk) return res.json({ available: [], selected: paymentMethodTypesFromPlatformRow(row) })
    const stripe = new (require('stripe'))(sk)
    let available = []
    try {
      const configs = await stripe.paymentMethodConfigurations.list({ limit: 100 })
      const root = configs.data.find((c) => !c.parent) || configs.data[0]
      if (root) {
        for (const pmType of STRIPE_PM_TYPES) {
          const cfg = root[pmType]
          if (cfg && cfg.available === true) available.push(pmType)
        }
      }
    } catch (_) { available = [] }
    res.json({ available, selected: paymentMethodTypesFromPlatformRow(row) })
  } catch (err) {
    try { if (dbClient) await dbClient.end() } catch (_) {}
    console.error('stripePaymentMethodsGET:', err)
    res.status(500).json({ message: err?.message || 'Error' })
  }
}

const platformCheckoutSettingsGET = async (req, res) => {
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    const row = await loadPlatformCheckoutRow(client)
    await client.end()
    const sk = (row?.stripe_secret_key || '').toString()
    const pk = (row?.stripe_publishable_key || '').toString()
    const psec = (row?.paypal_client_secret || '').toString()
    const envSk = !!(process.env.STRIPE_SECRET_KEY || '').toString().trim()
    const envPk = !!(process.env.STRIPE_PUBLISHABLE_KEY || '').toString().trim()
    res.json({
      stripe_publishable_key: pk,
      stripe_secret_key_set: sk.length > 0,
      stripe_secret_key_hint: sk.length >= 4 ? `…${sk.slice(-4)}` : '',
      pay_card: row?.pay_card !== false,
      pay_paypal: row?.pay_paypal === true,
      pay_klarna: row?.pay_klarna === true,
      paypal_client_id: (row?.paypal_client_id || '').toString(),
      paypal_client_secret_set: psec.length > 0,
      paypal_client_secret_hint: psec.length >= 4 ? `…${psec.slice(-4)}` : '',
      payment_method_layout: (row?.payment_method_layout || 'grid').toString(),
      payment_method_types_json: Array.isArray(row?.payment_method_types_json) ? row.payment_method_types_json : null,
      env_stripe_secret: envSk,
      env_stripe_publishable: envPk,
    })
  } catch (err) {
    try { await client.end() } catch (_) {}
    console.error('platformCheckoutSettingsGET:', err)
    res.status(500).json({ message: (err && err.message) || 'Error' })
  }
}

const platformCheckoutSettingsPUT = async (req, res) => {
  const body = req.body || {}
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    const cur = (await loadPlatformCheckoutRow(client)) || {}
    const nextPk = body.stripe_publishable_key !== undefined
      ? (body.stripe_publishable_key || '').toString().trim()
      : (cur?.stripe_publishable_key || '').toString()
    let nextSk = (cur?.stripe_secret_key || '').toString()
    if (Object.prototype.hasOwnProperty.call(body, 'stripe_secret_key')) {
      const inc = (body.stripe_secret_key || '').toString().trim()
      if (inc) nextSk = inc
    }
    const pay_card = body.pay_card !== undefined ? !!body.pay_card : cur?.pay_card !== false
    const pay_paypal = body.pay_paypal !== undefined ? !!body.pay_paypal : cur?.pay_paypal === true
    const pay_klarna = body.pay_klarna !== undefined ? !!body.pay_klarna : cur?.pay_klarna === true
    let paypal_client_id = body.paypal_client_id !== undefined ? (body.paypal_client_id || '').toString().trim() : (cur?.paypal_client_id || '').toString()
    let paypal_client_secret = (cur?.paypal_client_secret || '').toString()
    if (Object.prototype.hasOwnProperty.call(body, 'paypal_client_secret')) {
      const inc = (body.paypal_client_secret || '').toString().trim()
      if (inc) paypal_client_secret = inc
    }
    const payment_method_layout = body.payment_method_layout === 'list' ? 'list' : (body.payment_method_layout === 'grid' ? 'grid' : (cur?.payment_method_layout || 'grid'))
    let payment_method_types_json = Array.isArray(cur?.payment_method_types_json) ? cur.payment_method_types_json : null
    if (Array.isArray(body.payment_method_types) && body.payment_method_types.length > 0) {
      payment_method_types_json = body.payment_method_types.filter((t) => typeof t === 'string' && t.length > 0)
    }
    await client.query(
      `INSERT INTO store_platform_checkout (id, stripe_publishable_key, stripe_secret_key, pay_card, pay_paypal, pay_klarna, paypal_client_id, paypal_client_secret, payment_method_layout, payment_method_types_json, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (id) DO UPDATE SET
         stripe_publishable_key = EXCLUDED.stripe_publishable_key,
         stripe_secret_key = EXCLUDED.stripe_secret_key,
         pay_card = EXCLUDED.pay_card,
         pay_paypal = EXCLUDED.pay_paypal,
         pay_klarna = EXCLUDED.pay_klarna,
         paypal_client_id = EXCLUDED.paypal_client_id,
         paypal_client_secret = EXCLUDED.paypal_client_secret,
         payment_method_layout = EXCLUDED.payment_method_layout,
         payment_method_types_json = EXCLUDED.payment_method_types_json,
         updated_at = now()`,
      [nextPk || null, nextSk || null, pay_card, pay_paypal, pay_klarna, paypal_client_id || null, paypal_client_secret || null, payment_method_layout, payment_method_types_json ? JSON.stringify(payment_method_types_json) : null],
    )
    await client.end()
    res.json({ ok: true })
  } catch (err) {
    try { await client.end() } catch (_) {}
    console.error('platformCheckoutSettingsPUT:', err)
    res.status(500).json({ message: (err && err.message) || 'Error' })
  }
}

const platformCheckoutTestStripePOST = async (req, res) => {
  const body = req.body || {}
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ ok: false, message: 'Database not configured' })
  try {
    await client.connect()
    const row = await loadPlatformCheckoutRow(client)
    await client.end()
    const pkForm = (body.stripe_publishable_key || '').toString().trim()
    const skForm = (body.stripe_secret_key || '').toString().trim()
    const pkDb = (row?.stripe_publishable_key || '').toString().trim()
    const skDb = (row?.stripe_secret_key || '').toString().trim()
    const pk = pkForm || pkDb
    const sk = skForm || skDb
    if (!sk) return res.json({ ok: false, message: 'Kein Secret Key — bitte im Formular eintragen oder zuerst mit „Speichern" in der Datenbank speichern.' })
    const stripeModeFromKey = (k) => {
      if (!k || typeof k !== 'string') return null
      if (k.includes('_test_')) return 'test'
      if (k.includes('_live_')) return 'live'
      return null
    }
    const skMode = stripeModeFromKey(sk)
    const pkMode = stripeModeFromKey(pk)
    if (pk && skMode && pkMode && skMode !== pkMode) {
      return res.json({ ok: false, message: 'Publishable Key und Secret Key passen nicht zum selben Modus (einer ist Test, der andere Live). Beide müssen aus demselben Stripe-Konto und derselben Umgebung stammen.' })
    }
    const stripe = new (require('stripe'))(sk)
    await stripe.balance.retrieve()
    return res.json({ ok: true, message: 'Verbindung erfolgreich — Stripe hat den Secret Key akzeptiert.', mode: skMode || undefined })
  } catch (err) {
    const raw = err && err.raw && typeof err.raw === 'object' ? err.raw : {}
    const msg = raw.message || err.message || String(err)
    return res.json({ ok: false, message: msg, stripe_type: raw.type || err.type, stripe_code: raw.code || err.code })
  }
}

const storeSellerSettingsGET = async (req, res) => {
  try {
    const sellerId = (req.query.seller_id || 'default').toString().trim() || 'default'
    const client = getDbClient()
    if (!client) return res.json({ store_name: '', free_shipping_thresholds: null, shop_logo_url: '', shop_favicon_url: '', sellercentral_logo_url: '', sellercentral_favicon_url: '', shop_logo_height: 34, sellercentral_logo_height: 30, enabled_shop_locales: null, maintenance_mode_enabled: false, maintenance_mode_image_url: '' })
    await client.connect()
    const r = await client.query(
      'SELECT store_name, free_shipping_thresholds, shop_logo_url, shop_favicon_url, sellercentral_logo_url, sellercentral_favicon_url, shop_logo_height, sellercentral_logo_height, announcement_bar_items, logo_config, enabled_shop_locales FROM admin_hub_seller_settings WHERE seller_id = $1',
      [sellerId],
    )
    // Platform-wide "coming soon" mode always lives on seller_id='default', same convention as
    // enabled_shop_locales — resolved separately so it's correct regardless of which seller_id
    // was requested.
    let maintenance_mode_enabled = false
    let maintenance_mode_image_url = ''
    try {
      const mm = await client.query(
        `SELECT maintenance_mode_enabled, maintenance_mode_image_url FROM admin_hub_seller_settings WHERE seller_id = 'default'`,
      )
      maintenance_mode_enabled = !!mm.rows?.[0]?.maintenance_mode_enabled
      maintenance_mode_image_url = mm.rows?.[0]?.maintenance_mode_image_url || ''
    } catch (_) {}
    // Platform language list always lives on seller_id=default
    let enabled_shop_locales = null
    if (sellerId === 'default') {
      const raw = r.rows?.[0]?.enabled_shop_locales
      if (raw != null) {
        let list = raw
        if (typeof list === 'string') {
          try { list = JSON.parse(list) } catch (_) { list = null }
        }
        if (Array.isArray(list)) {
          const ALL = ['en', 'de', 'tr', 'fr', 'it', 'es']
          enabled_shop_locales = ALL.filter((c) => list.map((x) => String(x || '').toLowerCase()).includes(c))
          if (!enabled_shop_locales.length) enabled_shop_locales = null
        }
      }
    } else {
      try {
        const plat = await client.query(
          'SELECT enabled_shop_locales FROM admin_hub_seller_settings WHERE seller_id = $1',
          ['default'],
        )
        const raw = plat.rows?.[0]?.enabled_shop_locales
        if (raw != null) {
          let list = raw
          if (typeof list === 'string') {
            try { list = JSON.parse(list) } catch (_) { list = null }
          }
          if (Array.isArray(list)) {
            const ALL = ['en', 'de', 'tr', 'fr', 'it', 'es']
            enabled_shop_locales = ALL.filter((c) => list.map((x) => String(x || '').toLowerCase()).includes(c))
            if (!enabled_shop_locales.length) enabled_shop_locales = null
          }
        }
      } catch (_) {}
    }
    await client.end()
    const row = r.rows && r.rows[0]
    const store_name = row && row.store_name != null ? String(row.store_name) : ''
    let free_shipping_thresholds = (row && row.free_shipping_thresholds) || null
    if (free_shipping_thresholds && typeof free_shipping_thresholds === 'object') {
      free_shipping_thresholds = normalizeThresholdsObject(free_shipping_thresholds)
    }
    const shop_logo_url = row && row.shop_logo_url ? String(row.shop_logo_url) : ''
    const shop_favicon_url = row && row.shop_favicon_url ? String(row.shop_favicon_url) : ''
    const sellercentral_logo_url = row && row.sellercentral_logo_url ? String(row.sellercentral_logo_url) : ''
    const sellercentral_favicon_url = row && row.sellercentral_favicon_url ? String(row.sellercentral_favicon_url) : ''
    const shop_logo_height = row && row.shop_logo_height != null ? Number(row.shop_logo_height) : 34
    const sellercentral_logo_height = row && row.sellercentral_logo_height != null ? Number(row.sellercentral_logo_height) : 30
    const announcement_bar_items = Array.isArray(row && row.announcement_bar_items) ? row.announcement_bar_items : []
    let logo_config = null
    if (row && row.logo_config != null) {
      logo_config = typeof row.logo_config === 'string' ? JSON.parse(row.logo_config) : row.logo_config
    }
    res.json({ store_name, free_shipping_thresholds, shop_logo_url, shop_favicon_url, sellercentral_logo_url, sellercentral_favicon_url, shop_logo_height, sellercentral_logo_height, announcement_bar_items, logo_config, enabled_shop_locales, maintenance_mode_enabled, maintenance_mode_image_url })
  } catch (err) {
    console.error('[storeSellerSettingsGET] error:', err && err.message)
    res.json({ store_name: '', free_shipping_thresholds: null, shop_logo_url: '', shop_favicon_url: '', sellercentral_logo_url: '', sellercentral_favicon_url: '', shop_logo_height: 34, sellercentral_logo_height: 30, logo_config: null, enabled_shop_locales: null, maintenance_mode_enabled: false, maintenance_mode_image_url: '' })
  }
}

const storeSellerProfileGET = async (req, res) => {
  const seller_id = (req.params.seller_id || 'default').toString().trim() || 'default'
  let client
  try {
    client = getDbClient()
    if (!client) return res.json({ seller: null, reviews: [], products: [] })
    await client.connect()
    const sellerR = await client.query(
      `SELECT store_name, shop_logo_url, shop_logo_height, review_avg, review_count FROM admin_hub_seller_settings WHERE seller_id = $1`,
      [seller_id]
    )
    const sellerRow = sellerR.rows[0] || null
    const distR = await client.query(
      `SELECT rating, COUNT(*)::int as cnt FROM store_product_reviews WHERE seller_id = $1 GROUP BY rating ORDER BY rating DESC`,
      [seller_id]
    )
    const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
    for (const row of distR.rows) dist[row.rating] = row.cnt
    const revR = await client.query(
      `SELECT r.id, r.rating, r.comment, r.customer_name, r.created_at, p.title as product_title, p.handle as product_handle
       FROM store_product_reviews r LEFT JOIN admin_hub_products p ON p.id::text = r.product_id
       WHERE r.seller_id = $1 ORDER BY r.created_at DESC LIMIT 30`,
      [seller_id]
    )
    const prodR = await client.query(
      `SELECT id, title, handle, price_cents, metadata FROM admin_hub_products WHERE seller_id = $1 AND ${storePublishedStatusSql('status')} ORDER BY created_at DESC LIMIT 16`,
      [seller_id]
    )
    await client.end()
    res.json({
      seller: sellerRow ? {
        seller_id, store_name: sellerRow.store_name || '', shop_logo_url: sellerRow.shop_logo_url || '',
        shop_logo_height: sellerRow.shop_logo_height || 34,
        review_avg: sellerRow.review_avg != null ? parseFloat(sellerRow.review_avg) : null,
        review_count: sellerRow.review_count != null ? Number(sellerRow.review_count) : 0,
        rating_distribution: dist,
      } : { seller_id, store_name: '', shop_logo_url: '', shop_logo_height: 34, review_avg: null, review_count: 0, rating_distribution: dist },
      reviews: revR.rows || [],
      products: (prodR.rows || []).map((p) => ({ id: p.id, title: p.title, handle: p.handle, price_cents: p.price_cents, metadata: p.metadata || {} })),
    })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = function createPlatformCheckoutRouter(deps = {}) {
  const { requireSuperuser } = deps
  const router = Router()

  router.get('/admin-hub/v1/platform-checkout-settings', requireSuperuser, platformCheckoutSettingsGET)
  router.put('/admin-hub/v1/platform-checkout-settings', requireSuperuser, platformCheckoutSettingsPUT)
  router.get('/admin-hub/v1/stripe-payment-methods', requireSuperuser, stripePaymentMethodsGET)
  router.post('/admin-hub/v1/platform-checkout-settings/test-stripe', requireSuperuser, platformCheckoutTestStripePOST)
  router.get('/store/seller-settings', storeSellerSettingsGET)
  router.get('/store/seller-profile/:seller_id', storeSellerProfileGET)

  return router
}

module.exports.loadPlatformCheckoutRow = loadPlatformCheckoutRow
module.exports.resolveStripeSecretKeyFromPlatform = resolveStripeSecretKeyFromPlatform
module.exports.resolveStripePublishableFromPlatform = resolveStripePublishableFromPlatform
module.exports.paymentMethodTypesFromPlatformRow = paymentMethodTypesFromPlatformRow
