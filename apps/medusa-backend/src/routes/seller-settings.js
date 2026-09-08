'use strict'
const { Router } = require('express')
const { getPooledClient } = require('../db-pool')
const { productHasPendingCatalogMetafields } = require('../catalog-metafield-pending')

const _log = { info: (...a) => { if (process.env.NODE_ENV !== 'production') console.log(...a) } }

// Branding/settings are fetched on every page load in shop + Sellercentral — pooled to
// avoid a fresh Postgres TCP+TLS handshake per request (see src/db-pool.js).
const getDbClient = () => getPooledClient()

// ── Utilities (also exported for store-products and other modules) ─────────────

const normalizeHubCountryCode = (code) => {
  if (code == null || code === '') return ''
  const s = String(code).trim().toUpperCase()
  if (s === 'UK') return 'GB'
  return /^[A-Z]{2}$/.test(s) ? s : ''
}

const normalizeThresholdsObject = (raw) => {
  if (!raw || typeof raw !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(raw)) {
    const nk = normalizeHubCountryCode(k)
    if (!nk) continue
    out[nk] = v
  }
  return out
}

const STORE_PUBLISHED_STATUSES = new Set(['published', 'active'])
const isStorePublishedStatus = (status) => STORE_PUBLISHED_STATUSES.has(String(status || '').trim().toLowerCase())
const storePublishedStatusSql = (col) => `LOWER(TRIM(COALESCE(${col}, ''))) IN ('published', 'active')`

/** All shop storefront UI locales. null/empty in DB = all enabled. */
const ALL_SHOP_LOCALES = ['en', 'de', 'tr', 'fr', 'it', 'es']
const normalizeEnabledShopLocales = (raw) => {
  if (raw == null) return null
  let list = raw
  if (typeof list === 'string') {
    try { list = JSON.parse(list) } catch (_) { return null }
  }
  if (!Array.isArray(list)) return null
  const out = []
  const seen = new Set()
  for (const item of list) {
    const code = String(item || '').trim().toLowerCase()
    if (!ALL_SHOP_LOCALES.includes(code) || seen.has(code)) continue
    seen.add(code)
    out.push(code)
  }
  if (!out.length) return null
  // Prefer stable order matching ALL_SHOP_LOCALES
  return ALL_SHOP_LOCALES.filter((c) => out.includes(c))
}
const parseEnabledShopLocalesRow = (rowVal) => {
  if (rowVal == null) return null
  return normalizeEnabledShopLocales(rowVal)
}

const getSellerStoreName = async (sellerId) => {
  const id = (sellerId || 'default').toString().trim() || 'default'
  const client = getDbClient()
  if (!client) return null
  try {
    await client.connect()
    const res = await client.query('SELECT store_name FROM admin_hub_seller_settings WHERE seller_id = $1', [id])
    await client.end()
    const row = res.rows && res.rows[0]
    return row && row.store_name != null && String(row.store_name).trim() !== '' ? String(row.store_name).trim() : null
  } catch (e) {
    try { await client.end() } catch (_) {}
    return null
  }
}

const getApprovedSellerIdsSet = async () => {
  const client = getDbClient()
  if (!client) return new Set()
  try {
    await client.connect()
    const res = await client.query(
      `SELECT seller_id FROM seller_users WHERE seller_id IS NOT NULL AND LENGTH(TRIM(seller_id)) > 0 AND LOWER(COALESCE(approval_status, '')) NOT IN ('rejected', 'suspended')`
    )
    await client.end()
    return new Set((res.rows || []).map((r) => String(r.seller_id || '').trim()).filter(Boolean))
  } catch (_) {
    try { await getDbClient()?.end() } catch (__) {}
    return new Set()
  }
}

const isStoreVisibleSellerProduct = (product, approvedSellerIds) => {
  if (productHasPendingCatalogMetafields(product)) return false
  const sid = String(product?.seller_id || '').trim()
  if (!sid || sid === 'default') return true
  return approvedSellerIds.has(sid)
}

// ── Handlers ──────────────────────────────────────────────────────────────────

const approvedSellerIdsStoreGET = async (_req, res) => {
  try {
    const approvedSellerIds = await getApprovedSellerIdsSet()
    return res.json({ seller_ids: [...approvedSellerIds] })
  } catch (_) {
    return res.json({ seller_ids: [] })
  }
}

const sellerSettingsGET = async (req, res) => {
  const sellerId = (req.query.seller_id || 'default').toString().trim() || 'default'
  const client = getDbClient()
  if (!client) return res.json({ store_name: '' })
  try {
    await client.connect()
    try {
      const r = await client.query(
        `SELECT store_name, free_shipping_thresholds, shop_logo_url, shop_favicon_url, sellercentral_logo_url, sellercentral_favicon_url,
                shop_logo_height, sellercentral_logo_height, platform_name, support_email, admin_notification_email, storefront_url,
                announcement_bar_items, logo_config, barcode_scanner_config, enabled_shop_locales, locale,
                legal_company_name, legal_representative, legal_street, legal_city,
                legal_trade_register, legal_register_court, legal_vat_id, legal_tax_id, legal_email
         FROM admin_hub_seller_settings WHERE seller_id = $1`,
        [sellerId],
      )
      // Platform-wide maintenance mode always lives on seller_id='default', same convention as
      // enabled_shop_locales — read it separately so it's correct even when viewing a specific
      // seller's own settings row.
      let maintenance_mode_enabled = false
      let maintenance_mode_image_url = ''
      try {
        const mm = await client.query(
          `SELECT maintenance_mode_enabled, maintenance_mode_image_url FROM admin_hub_seller_settings WHERE seller_id = 'default'`,
        )
        maintenance_mode_enabled = !!mm.rows?.[0]?.maintenance_mode_enabled
        maintenance_mode_image_url = mm.rows?.[0]?.maintenance_mode_image_url || ''
      } catch (_) {}
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
      const platform_name = row && row.platform_name ? String(row.platform_name) : ''
      const support_email = row && row.support_email ? String(row.support_email) : ''
      const admin_notification_email = row && row.admin_notification_email ? String(row.admin_notification_email) : ''
      const storefront_url = row && row.storefront_url ? String(row.storefront_url) : ''
      let announcement_bar_items = row && row.announcement_bar_items != null ? row.announcement_bar_items : []
      if (typeof announcement_bar_items === 'string') {
        try { announcement_bar_items = JSON.parse(announcement_bar_items) } catch (_) { announcement_bar_items = [] }
      }
      if (!Array.isArray(announcement_bar_items)) announcement_bar_items = []
      let logo_config = null
      if (row && row.logo_config != null) {
        if (typeof row.logo_config === 'string') {
          try { logo_config = JSON.parse(row.logo_config) } catch (_) { logo_config = null }
        } else if (typeof row.logo_config === 'object') {
          logo_config = row.logo_config
        }
      }
      let barcode_scanner_config = null
      if (row && row.barcode_scanner_config != null) {
        if (typeof row.barcode_scanner_config === 'string') {
          try { barcode_scanner_config = JSON.parse(row.barcode_scanner_config) } catch (_) { barcode_scanner_config = null }
        } else if (typeof row.barcode_scanner_config === 'object') {
          barcode_scanner_config = row.barcode_scanner_config
        }
      }
      const enabled_shop_locales = parseEnabledShopLocalesRow(row?.enabled_shop_locales)
      const rawLocale = String(row?.locale || '').trim().toLowerCase()
      const locale = ALL_SHOP_LOCALES.includes(rawLocale) ? rawLocale : 'de'
      res.json({
        store_name, free_shipping_thresholds, shop_logo_url, shop_favicon_url,
        sellercentral_logo_url, sellercentral_favicon_url, shop_logo_height, sellercentral_logo_height,
        platform_name, support_email, admin_notification_email, storefront_url, announcement_bar_items, logo_config, barcode_scanner_config,
        enabled_shop_locales,
        locale,
        maintenance_mode_enabled,
        maintenance_mode_image_url,
        legal_company_name: row?.legal_company_name || '',
        legal_representative: row?.legal_representative || '',
        legal_street: row?.legal_street || '',
        legal_city: row?.legal_city || '',
        legal_trade_register: row?.legal_trade_register || '',
        legal_register_court: row?.legal_register_court || '',
        legal_vat_id: row?.legal_vat_id || '',
        legal_tax_id: row?.legal_tax_id || '',
        legal_email: row?.legal_email || '',
      })
    } finally {
      await client.end().catch(() => {})
    }
  } catch (err) {
    console.error('sellerSettingsGET:', err)
    res.json({
      store_name: '', shop_logo_url: '', shop_favicon_url: '', sellercentral_logo_url: '',
      sellercentral_favicon_url: '', shop_logo_height: 34, sellercentral_logo_height: 30,
      announcement_bar_items: [], logo_config: null,
    })
  }
}

const sellerSettingsPATCH = async (req, res) => {
  try {
    const body = req.body || {}
    const store_name = (body.store_name != null ? String(body.store_name) : '').trim()
    const isSuperuser = req.sellerUser?.is_superuser === true
    const jwtSellerId = String(req.sellerUser?.seller_id || '').trim()
    const requestedId = (body.seller_id || req.query.seller_id || '').toString().trim()
    // Non-superusers may only write their own settings. Platform `default` is superuser-only.
    let sellerId
    if (isSuperuser) {
      sellerId = requestedId || 'default'
    } else {
      if (!jwtSellerId) return res.status(403).json({ message: 'Forbidden' })
      if (requestedId && requestedId !== jwtSellerId) {
        return res.status(403).json({ message: 'Cannot modify another seller\'s settings' })
      }
      sellerId = jwtSellerId
    }
    let free_shipping_thresholds = (body.free_shipping_thresholds && typeof body.free_shipping_thresholds === 'object')
      ? body.free_shipping_thresholds : null
    const shop_logo_url = body.shop_logo_url !== undefined ? (body.shop_logo_url ? String(body.shop_logo_url).trim() : null) : undefined
    const shop_favicon_url = body.shop_favicon_url !== undefined ? (body.shop_favicon_url ? String(body.shop_favicon_url).trim() : null) : undefined
    const sellercentral_logo_url = body.sellercentral_logo_url !== undefined ? (body.sellercentral_logo_url ? String(body.sellercentral_logo_url).trim() : null) : undefined
    const sellercentral_favicon_url = body.sellercentral_favicon_url !== undefined ? (body.sellercentral_favicon_url ? String(body.sellercentral_favicon_url).trim() : null) : undefined
    const shop_logo_height = body.shop_logo_height !== undefined && body.shop_logo_height !== null
      ? Math.max(20, Math.min(120, Number(body.shop_logo_height) || 34)) : undefined
    const sellercentral_logo_height = body.sellercentral_logo_height !== undefined && body.sellercentral_logo_height !== null
      ? Math.max(20, Math.min(120, Number(body.sellercentral_logo_height) || 30)) : undefined
    const platform_name = body.platform_name !== undefined ? (body.platform_name ? String(body.platform_name).trim() : null) : undefined
    const support_email = body.support_email !== undefined ? (body.support_email ? String(body.support_email).trim() : null) : undefined
    const admin_notification_email = body.admin_notification_email !== undefined ? (body.admin_notification_email ? String(body.admin_notification_email).trim() : null) : undefined
    const storefront_url = body.storefront_url !== undefined ? (body.storefront_url ? String(body.storefront_url).trim().replace(/\/$/, '') : null) : undefined
    const announcement_bar_items = body.announcement_bar_items !== undefined
      ? (Array.isArray(body.announcement_bar_items) ? body.announcement_bar_items : null) : undefined
    const logoConfigProvided = Object.prototype.hasOwnProperty.call(body, 'logo_config')
    const logo_config = logoConfigProvided ? (body.logo_config && typeof body.logo_config === 'object' ? body.logo_config : null) : undefined
    const barcodeConfigProvided = Object.prototype.hasOwnProperty.call(body, 'barcode_scanner_config')
    const barcode_scanner_config = barcodeConfigProvided ? (body.barcode_scanner_config && typeof body.barcode_scanner_config === 'object' ? body.barcode_scanner_config : null) : undefined
    const legalStr = (k) => body[k] !== undefined ? (body[k] ? String(body[k]).trim() : null) : undefined
    const legal_company_name = legalStr('legal_company_name')
    const legal_representative = legalStr('legal_representative')
    const legal_street = legalStr('legal_street')
    const legal_city = legalStr('legal_city')
    const legal_trade_register = legalStr('legal_trade_register')
    const legal_register_court = legalStr('legal_register_court')
    const legal_vat_id = legalStr('legal_vat_id')
    const legal_tax_id = legalStr('legal_tax_id')
    const legal_email = legalStr('legal_email')
    let enabledLocalesJson = undefined
    let enabled_shop_locales = undefined
    if (Object.prototype.hasOwnProperty.call(body, 'enabled_shop_locales')) {
      if (!isSuperuser) {
        return res.status(403).json({ message: 'Only superuser can change shop languages' })
      }
      // Platform-wide setting — always stored on seller_id = default
      sellerId = 'default'
      const normalized = normalizeEnabledShopLocales(body.enabled_shop_locales)
      // Require at least one language; fall back to all if empty
      enabled_shop_locales = normalized && normalized.length ? normalized : [...ALL_SHOP_LOCALES]
      enabledLocalesJson = JSON.stringify(enabled_shop_locales)
    }
    let maintenanceModeEnabled = undefined
    let maintenanceModeImageUrl = undefined
    if (Object.prototype.hasOwnProperty.call(body, 'maintenance_mode_enabled') || Object.prototype.hasOwnProperty.call(body, 'maintenance_mode_image_url')) {
      if (!isSuperuser) {
        return res.status(403).json({ message: 'Only superuser can change maintenance mode' })
      }
      // Platform-wide setting — always stored on seller_id = default, same as enabled_shop_locales.
      sellerId = 'default'
      if (Object.prototype.hasOwnProperty.call(body, 'maintenance_mode_enabled')) {
        maintenanceModeEnabled = body.maintenance_mode_enabled === true
      }
      if (Object.prototype.hasOwnProperty.call(body, 'maintenance_mode_image_url')) {
        maintenanceModeImageUrl = body.maintenance_mode_image_url ? String(body.maintenance_mode_image_url).trim() : null
      }
    }
    let uiLocale = undefined
    if (Object.prototype.hasOwnProperty.call(body, 'locale')) {
      const raw = String(body.locale || '').trim().toLowerCase()
      uiLocale = ALL_SHOP_LOCALES.includes(raw) ? raw : 'de'
    }
    if (free_shipping_thresholds) {
      free_shipping_thresholds = normalizeThresholdsObject(free_shipping_thresholds)
    }
    const client = getDbClient()
    if (!client) return res.status(500).json({ message: 'Database unavailable' })
    await client.connect()
    const thresholdsJson = free_shipping_thresholds ? JSON.stringify(free_shipping_thresholds) : null
    _log.info('[sellerSettingsPATCH] saving free_shipping_thresholds:', thresholdsJson)
    const announcementJson = announcement_bar_items !== undefined ? JSON.stringify(announcement_bar_items) : undefined
    const logoConfigJson = logoConfigProvided ? JSON.stringify(logo_config) : undefined
    const barcodeConfigJson = barcodeConfigProvided ? JSON.stringify(barcode_scanner_config) : undefined
    await client.query(
      `INSERT INTO admin_hub_seller_settings (
         seller_id, store_name, free_shipping_thresholds, shop_logo_url, shop_favicon_url, sellercentral_logo_url, sellercentral_favicon_url, shop_logo_height, sellercentral_logo_height, platform_name, support_email, announcement_bar_items, storefront_url, logo_config,
         legal_company_name, legal_representative, legal_street, legal_city, legal_trade_register, legal_register_court, legal_vat_id, legal_tax_id, legal_email, barcode_scanner_config, admin_notification_email, enabled_shop_locales,
         maintenance_mode_enabled, maintenance_mode_image_url,
         updated_at
       ) VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14::jsonb, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24::jsonb, $25, $26::jsonb, $27, $28, now())
       ON CONFLICT (seller_id) DO UPDATE SET
         store_name = COALESCE($2, admin_hub_seller_settings.store_name),
         free_shipping_thresholds = COALESCE($3::jsonb, admin_hub_seller_settings.free_shipping_thresholds),
         shop_logo_url = COALESCE($4, admin_hub_seller_settings.shop_logo_url),
         shop_favicon_url = COALESCE($5, admin_hub_seller_settings.shop_favicon_url),
         sellercentral_logo_url = COALESCE($6, admin_hub_seller_settings.sellercentral_logo_url),
         sellercentral_favicon_url = COALESCE($7, admin_hub_seller_settings.sellercentral_favicon_url),
         shop_logo_height = COALESCE($8, admin_hub_seller_settings.shop_logo_height),
         sellercentral_logo_height = COALESCE($9, admin_hub_seller_settings.sellercentral_logo_height),
         platform_name = COALESCE($10, admin_hub_seller_settings.platform_name),
         support_email = COALESCE($11, admin_hub_seller_settings.support_email),
         announcement_bar_items = COALESCE($12::jsonb, admin_hub_seller_settings.announcement_bar_items),
         storefront_url = COALESCE($13, admin_hub_seller_settings.storefront_url),
         logo_config = COALESCE($14::jsonb, admin_hub_seller_settings.logo_config),
         legal_company_name = COALESCE($15, admin_hub_seller_settings.legal_company_name),
         legal_representative = COALESCE($16, admin_hub_seller_settings.legal_representative),
         legal_street = COALESCE($17, admin_hub_seller_settings.legal_street),
         legal_city = COALESCE($18, admin_hub_seller_settings.legal_city),
         legal_trade_register = COALESCE($19, admin_hub_seller_settings.legal_trade_register),
         legal_register_court = COALESCE($20, admin_hub_seller_settings.legal_register_court),
         legal_vat_id = COALESCE($21, admin_hub_seller_settings.legal_vat_id),
         legal_tax_id = COALESCE($22, admin_hub_seller_settings.legal_tax_id),
         legal_email = COALESCE($23, admin_hub_seller_settings.legal_email),
         barcode_scanner_config = COALESCE($24::jsonb, admin_hub_seller_settings.barcode_scanner_config),
         admin_notification_email = COALESCE($25, admin_hub_seller_settings.admin_notification_email),
         enabled_shop_locales = COALESCE($26::jsonb, admin_hub_seller_settings.enabled_shop_locales),
         maintenance_mode_enabled = COALESCE($27, admin_hub_seller_settings.maintenance_mode_enabled),
         maintenance_mode_image_url = COALESCE($28, admin_hub_seller_settings.maintenance_mode_image_url),
         updated_at = now()`,
      [sellerId, store_name || null, thresholdsJson, shop_logo_url, shop_favicon_url, sellercentral_logo_url, sellercentral_favicon_url, shop_logo_height, sellercentral_logo_height, platform_name, support_email, announcementJson !== undefined ? announcementJson : null, storefront_url, logoConfigJson !== undefined ? logoConfigJson : null,
       legal_company_name, legal_representative, legal_street, legal_city, legal_trade_register, legal_register_court, legal_vat_id, legal_tax_id, legal_email, barcodeConfigJson !== undefined ? barcodeConfigJson : null, admin_notification_email,
       enabledLocalesJson !== undefined ? enabledLocalesJson : null,
       maintenanceModeEnabled !== undefined ? maintenanceModeEnabled : null,
       maintenanceModeImageUrl !== undefined ? maintenanceModeImageUrl : null]
    )
    if (uiLocale !== undefined) {
      // Persist Sellercentral UI language on the acting seller's settings row (not platform `default`
      // when a superuser toggles shop languages).
      const localeSellerId = String(jwtSellerId || sellerId || '').trim() || 'default'
      await client.query(
        `INSERT INTO admin_hub_seller_settings (seller_id, locale, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (seller_id) DO UPDATE SET locale = $2, updated_at = now()`,
        [localeSellerId, uiLocale],
      )
    }
    await client.end()
    _log.info('[sellerSettingsPATCH] saved OK')
    res.json({
      store_name: store_name || '',
      free_shipping_thresholds,
      shop_logo_url: shop_logo_url || '',
      shop_favicon_url: shop_favicon_url || '',
      sellercentral_logo_url: sellercentral_logo_url || '',
      sellercentral_favicon_url: sellercentral_favicon_url || '',
      shop_logo_height: shop_logo_height != null ? shop_logo_height : 34,
      sellercentral_logo_height: sellercentral_logo_height != null ? sellercentral_logo_height : 30,
      enabled_shop_locales: enabled_shop_locales !== undefined ? enabled_shop_locales : undefined,
      locale: uiLocale !== undefined ? uiLocale : undefined,
      maintenance_mode_enabled: maintenanceModeEnabled !== undefined ? maintenanceModeEnabled : undefined,
      maintenance_mode_image_url: maintenanceModeImageUrl !== undefined ? maintenanceModeImageUrl : undefined,
    })
  } catch (err) {
    console.error('sellerSettingsPATCH:', err)
    res.status(500).json({ message: err && err.message })
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = function createSellerSettingsRouter() {
  const router = Router()
  router.get('/store/approved-seller-ids', approvedSellerIdsStoreGET)
  router.get('/admin-hub/seller-settings', sellerSettingsGET)
  router.patch('/admin-hub/seller-settings', sellerSettingsPATCH)
  return router
}

module.exports.normalizeHubCountryCode = normalizeHubCountryCode
module.exports.normalizeThresholdsObject = normalizeThresholdsObject
module.exports.ALL_SHOP_LOCALES = ALL_SHOP_LOCALES
module.exports.normalizeEnabledShopLocales = normalizeEnabledShopLocales
module.exports.STORE_PUBLISHED_STATUSES = STORE_PUBLISHED_STATUSES
module.exports.isStorePublishedStatus = isStorePublishedStatus
module.exports.storePublishedStatusSql = storePublishedStatusSql
module.exports.getSellerStoreName = getSellerStoreName
module.exports.getApprovedSellerIdsSet = getApprovedSellerIdsSet
module.exports.isStoreVisibleSellerProduct = isStoreVisibleSellerProduct
