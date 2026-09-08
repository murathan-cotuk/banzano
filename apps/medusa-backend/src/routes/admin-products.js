'use strict'
const { Router } = require('express')
const { applyEuOriginMetadataPolicy, registerEuOriginRoutes } = require('../eu-origin')
const { buildCatalogMaps, scanProductCatalogPending } = require('../catalog-metafield-pending')
const {
  isPlaceholderHandle,
  parseProductUrlHandle,
  resolveNonPlaceholderHandle,
  patchPlaceholderTranslationHandles,
} = require('../product-url-handle')

// ── Utilities ─────────────────────────────────────────────────────────────────

const slugifyTitle = (str) => {
  if (!str || typeof str !== 'string') return ''
  const map = { ü: 'u', Ü: 'u', ö: 'o', Ö: 'o', ı: 'i', I: 'i', İ: 'i', ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ä: 'ae', Ä: 'ae', ß: 'ss' }
  let s = str.trim()
  for (const [from, to] of Object.entries(map)) s = s.split(from).join(to)
  return s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
}

const normalizeStoreEan = (raw) => {
  if (raw == null || raw === '') return ''
  const d = String(raw).replace(/\D/g, '')
  return d.length >= 8 ? d : ''
}

const parseVariantsArray = (p) => {
  const v = p && p.variants
  if (Array.isArray(v)) return v
  if (typeof v === 'string' && v) {
    try { const j = JSON.parse(v); return Array.isArray(j) ? j : [] } catch (_) { return [] }
  }
  return []
}

const extractEanFromHubProductRow = (p) => {
  if (!p) return ''
  const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {}
  let e = normalizeStoreEan(meta.ean)
  if (e) return e
  for (const row of parseVariantsArray(p)) {
    e = normalizeStoreEan(row && row.ean)
    if (e) return e
  }
  return ''
}

// Unlike extractEanFromHubProductRow (which returns a single *representative* EAN — the
// parent's own EAN takes priority — used for grouping/dedup UIs), this checks whether a
// SPECIFIC target EAN appears ANYWHERE on the product: its own metadata.ean (parent/grouping
// EAN for variant products) OR any variants[].ean (the sellable child EANs). Needed because a
// variant product's parent EAN and child EANs are all distinct and must each be independently
// searchable (Amazon-style: children are the sellable items when variants exist).
const productHasEan = (p, targetEan) => {
  if (!p || !targetEan) return false
  const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {}
  if (normalizeStoreEan(meta.ean) === targetEan) return true
  for (const row of parseVariantsArray(p)) {
    if (normalizeStoreEan(row && row.ean) === targetEan) return true
  }
  return false
}

// Among rows matching the same EAN, the true "master" is the oldest one that
// already has an owner; an unowned row only wins if no owned row exists.
// (Mirrors the `ORDER BY (seller_id IS NULL) DESC, created_at ASC` used by the
// primary direct-SQL master lookup — keeps every EAN-dedup path consistent so a
// later duplicate listing can never displace the original owner.)
const pickCanonicalEanMatch = (matches) => {
  if (!matches || !matches.length) return null
  const sorted = [...matches].sort((a, b) => {
    const aOwned = a && a.seller_id ? 0 : 1
    const bOwned = b && b.seller_id ? 0 : 1
    if (aOwned !== bOwned) return aOwned - bOwned
    return new Date(a?.created_at || 0) - new Date(b?.created_at || 0)
  })
  return sorted[0]
}

// ── Auth ──────────────────────────────────────────────────────────────────────

const _SELLER_JWT_SECRET = (() => {
  const s = process.env.SELLER_JWT_SECRET || process.env.JWT_SECRET || ''
  return s || 'dev-only-seller-secret-do-not-use-in-prod'
})()

const verifySellerToken = (token) => {
  if (!token) return null
  try {
    const _c = require('crypto')
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, body, sig] = parts
    const expected = _c.createHmac('sha256', _SELLER_JWT_SECRET).update(`${header}.${body}`).digest('base64url')
    if (sig !== expected) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null
    return payload
  } catch { return null }
}

const requireSuperuser = (req, res, next) => {
  if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser access required' })
  next()
}

// requireSellerAuth is redundant here (global middleware at /admin-hub already runs),
// but eu-origin routes accept it as middleware so provide a compatible version.
const requireSellerAuth = (req, res, next) => {
  if (!req.sellerUser) return res.status(401).json({ message: 'Unauthorized' })
  next()
}

// ── DB helpers ────────────────────────────────────────────────────────────────

// Görev 25: pooled connection (see src/db-pool.js) — this factory backs both the public
// shop product listing (via store-products.js) and Sellercentral's product management,
// the two highest-traffic product read paths, so pooling it here has broad impact without
// touching every one of the backend's ~190 other per-request pg.Client call sites.
const getProductsDbClient = () => require('../db-pool').getPooledClient()

const dbQ = async (sql, params = []) => {
  const client = getProductsDbClient()
  if (!client) return { rows: [] }
  try {
    await client.connect()
    const r = await client.query(sql, params)
    await client.end()
    return r
  } catch (e) {
    try { await client.end() } catch (_) {}
    throw e
  }
}

const listAdminHubProductsDb = async (query = {}) => {
  const client = getProductsDbClient()
  if (!client) return []
  try {
    await client.connect()
    const categoryQ = (query.category || query.category_slug || '').toString().trim()
    const collScope = (query.collection_id || '').toString().trim()
    const hasScope = !!(categoryQ || collScope)
    const rawLimit = parseInt(query.limit, 10) || (hasScope ? 3000 : 100)
    const maxCap = hasScope || rawLimit > 200 ? 5000 : 200
    const limit = Math.min(Math.max(rawLimit, 1), maxCap)
    const offset = parseInt(query.offset, 10) || 0
    const sellerId = (query.seller_id || query.seller || '').trim()
    const status = (query.status || '').trim()
    const collectionId = (query.collection_id || '').toString().trim()
    const skuFilter = (query.sku || '').toString().trim()
    // When scoped to a seller, a product they listed (but didn't create — e.g. an already-
    // existing catalog product) has a `created_at` from the ORIGINAL owner, not from when
    // this seller added it. `seller_listing_created_at` exposes that seller's own listing
    // date so the frontend can sort "my most recently added" correctly for non-owners too.
    let sql = 'SELECT id, title, handle, sku, description, status, seller_id, collection_id, price_cents, inventory, metadata, variants, created_at, updated_at' +
      (sellerId ? ', (SELECT MAX(_sl2.created_at) FROM admin_hub_seller_listings _sl2 WHERE _sl2.product_id = admin_hub_products.id AND TRIM(_sl2.seller_id) = $1) AS seller_listing_created_at' : '') +
      ' FROM admin_hub_products'
    const params = []
    const where = []
    if (sellerId) {
      params.push(sellerId)
      const p = params.length
      where.push(
        '(' +
          'seller_id = $' + p +
          ' OR COALESCE(NULLIF(TRIM(metadata->>\'seller_id\'), \'\'), NULL) = $' + p +
          ' OR COALESCE(NULLIF(TRIM(metadata->>\'seller\'), \'\'), NULL) = $' + p +
          ' OR EXISTS (' +
            'SELECT 1 FROM admin_hub_seller_listings _sl' +
            ' WHERE _sl.product_id = admin_hub_products.id AND TRIM(_sl.seller_id) = $' + p +
          ')' +
        ')'
      )
    }
    if (status) { where.push('status = $' + (params.length + 1)); params.push(status) }
    if (collectionId) {
      where.push(
        '(' +
          'LOWER(COALESCE(collection_id::text, \'\')) = LOWER($' + (params.length + 1) + ')' +
          ' OR EXISTS (' +
            'SELECT 1 FROM jsonb_array_elements_text(COALESCE(metadata->\'collection_ids\', \'[]\'::jsonb)) AS cid(val) ' +
            'WHERE LOWER(cid.val) = LOWER($' + (params.length + 1) + ')' +
          ')' +
        ')'
      )
      params.push(collectionId)
    }
    if (skuFilter) { where.push('LOWER(TRIM(COALESCE(sku,\'\'))) = LOWER($' + (params.length + 1) + ')'); params.push(skuFilter) }
    if (where.length) sql += ' WHERE ' + where.join(' AND ')
    sql += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2)
    params.push(limit, offset)
    const res = await client.query(sql, params)
    await client.end()
    return (res.rows || []).map((r) => {
      const meta = r.metadata || {}
      const mediaArr = Array.isArray(meta.media) ? meta.media : (meta.media ? [meta.media] : [])
      const ownThumbnail = meta.thumbnail || (mediaArr[0] ? (typeof mediaArr[0] === 'string' ? mediaArr[0] : (mediaArr[0]?.url || null)) : null)
      // A product with variants is an umbrella row — show the first variant's own image,
      // falling back to the row's own image only when that variant has none of its own.
      let thumbnail = ownThumbnail
      if (Array.isArray(r.variants) && r.variants.length > 0) {
        const v = r.variants[0]
        const vMeta = v && v.metadata && typeof v.metadata === 'object' ? v.metadata : {}
        const vImg = (Array.isArray(vMeta.media) && vMeta.media.length > 0 ? vMeta.media[0] : null) || v.image_url || v.image || null
        const resolvedVImg = vImg ? (typeof vImg === 'string' ? vImg : (vImg?.url || null)) : null
        if (resolvedVImg) thumbnail = resolvedVImg
      }
      return {
        id: r.id, title: r.title, handle: r.handle, slug: r.handle, sku: r.sku,
        description: r.description, status: r.status, seller_id: r.seller_id, seller: r.seller_id,
        collection_id: r.collection_id, price: r.price_cents != null ? r.price_cents / 100 : 0,
        price_cents: r.price_cents, inventory: r.inventory != null ? r.inventory : 0,
        thumbnail, metadata: r.metadata, variants: r.variants,
        created_at: r.created_at, updated_at: r.updated_at,
        seller_listing_created_at: r.seller_listing_created_at || null,
      }
    })
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.warn('listAdminHubProductsDb:', e && e.message)
    return []
  }
}

const BULLET_POINT_MAX_LEN = 120
const normalizeEanValue = (v) => {
  if (v == null) return ''
  const s = String(v).trim()
  const digitsOnly = normalizeStoreEan(s)
  return digitsOnly || s
}
const collectVariantEans = (variants) => {
  const out = []
  if (!Array.isArray(variants)) return out
  for (const v of variants) { const e = normalizeEanValue(v && v.ean); if (e) out.push(e) }
  return out
}

const validateProductEansDb = async (client, parentEan, variantEans, excludeProductIdOrIds) => {
  const values = []
  const seen = new Set()
  const p = normalizeEanValue(parentEan)
  if (p) { seen.add(p); values.push(p) }
  for (const ve of variantEans || []) {
    const e = normalizeEanValue(ve)
    if (!e) continue
    if (p && e === p) return { ok: false, message: 'Variant EAN must be different from parent EAN' }
    if (seen.has(e)) return { ok: false, message: `Duplicate EAN in request payload: ${e}` }
    seen.add(e); values.push(e)
  }
  if (!values.length) return { ok: true }
  const excludeIds = new Set(
    (Array.isArray(excludeProductIdOrIds) ? excludeProductIdOrIds : [excludeProductIdOrIds])
      .map((id) => String(id || '').trim())
      .filter(Boolean)
  )
  const res = await client.query('SELECT id, sku, metadata, variants, status FROM admin_hub_products')
  const dbEans = new Set()
  for (const row of (res.rows || [])) {
    if (excludeIds.has(String(row.id))) continue
    if (String(row.status || '') === 'merged') continue
    const pm = row && row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const pe = normalizeEanValue(pm.ean)
    if (pe) dbEans.add(pe)
    const vv = Array.isArray(row && row.variants) ? row.variants : []
    for (const ve of collectVariantEans(vv)) dbEans.add(ve)
  }
  for (const e of values) {
    if (dbEans.has(e)) return { ok: false, message: `EAN already exists: ${e}` }
  }
  return { ok: true }
}

const normalizeProductMetadata = (meta) => {
  if (!meta || typeof meta !== 'object') return meta
  const out = { ...meta }
  if (Array.isArray(out.bullet_points)) {
    out.bullet_points = out.bullet_points.map((b) => String(b || '').slice(0, BULLET_POINT_MAX_LEN))
  }
  return out
}

const queueMetafieldSuggestionsAndSanitizePayload = async (body, sellerId) => {
  const result = { body: body && typeof body === 'object' ? { ...body } : {}, queued: 0 }
  const sid = String(sellerId || '').trim()
  if (!sid) return result
  let definitionRows
  try {
    definitionRows = await dbQ('SELECT key, label, values, label_i18n FROM admin_hub_metafield_definitions')
  } catch (_) {
    definitionRows = { rows: [] }
  }
  const maps = buildCatalogMaps(definitionRows.rows)
  const scanned = scanProductCatalogPending(result.body.metadata, result.body.variants, maps)
  result.body.metadata = scanned.metadata
  if (scanned.variants) result.body.variants = scanned.variants
  if (scanned.pendingByKey.size > 0) {
    try {
      const existingPending = await dbQ(
        `SELECT id, key, label, proposed_values FROM admin_hub_metafield_pending WHERE seller_id = $1 AND status = 'pending'`,
        [sid]
      )
      const existingByKey = new Map((existingPending.rows || []).map((r) => [r.key, r]))
      for (const [key, rec] of scanned.pendingByKey.entries()) {
        const vals = Array.from(rec.values)
        const label = rec.label || maps.labelByKey.get(key) || key
        const existing = existingByKey.get(key)
        if (existing) {
          const merged = [...new Set([...(Array.isArray(existing.proposed_values) ? existing.proposed_values : []), ...vals])]
          await dbQ(
            `UPDATE admin_hub_metafield_pending SET proposed_values = $1, label = COALESCE(NULLIF($2, ''), label), created_at = now() WHERE id = $3::uuid`,
            [JSON.stringify(merged), label, existing.id]
          )
        } else {
          await dbQ(
            `INSERT INTO admin_hub_metafield_pending (key, label, seller_id, proposed_values) VALUES ($1, $2, $3, $4)`,
            [key, label, sid, JSON.stringify(vals)]
          )
        }
        result.queued++
      }
    } catch (_) {}
  }
  return result
}

const validateRequiredGpsrMetadata = (meta) => {
  const m = meta && typeof meta === 'object' ? meta : {}
  const hasManufacturer = String(m.hersteller || '').trim().length > 0
  const hasManufacturerInfo = String(m.hersteller_information || '').trim().length > 0
  const hasResponsiblePerson = String(m.verantwortliche_person_information || '').trim().length > 0
  if (hasManufacturer && hasManufacturerInfo && hasResponsiblePerson) return { ok: true }
  const missing = []
  if (!hasManufacturer) missing.push('hersteller')
  if (!hasManufacturerInfo) missing.push('hersteller_information')
  if (!hasResponsiblePerson) missing.push('verantwortliche_person_information')
  return { ok: false, message: `GPSR required fields missing: ${missing.join(', ')}` }
}

/**
 * Each variant is its own product for compliance purposes (docs/HUKUKI.md) — when a product
 * has real variants, GPSR fields are checked per variant instead of on the shared parent
 * metadata, since sellercentral now collects hersteller/hersteller_information/
 * verantwortliche_person_information on each variant individually.
 */
const validateRequiredGpsrForProduct = (metadataObj, variantsArr) => {
  const realVariants = Array.isArray(variantsArr) ? variantsArr.filter((v) => Array.isArray(v?.option_values) && v.option_values.length > 0) : []
  if (realVariants.length === 0) return validateRequiredGpsrMetadata(metadataObj || {})
  const failing = []
  for (const v of realVariants) {
    const check = validateRequiredGpsrMetadata(v && typeof v.metadata === 'object' ? v.metadata : {})
    if (!check.ok) failing.push(Array.isArray(v.option_values) ? v.option_values.join(' / ') : (v.title || v.sku || '—'))
  }
  if (failing.length === 0) return { ok: true }
  return { ok: false, message: `GPSR required fields missing for variant(s): ${failing.join(', ')}` }
}

/**
 * Brand authorization publish gate (docs/BRAND.md Faz 4/2).
 * Only enforced when the product is being PUBLISHED and carries a brand_id.
 * Draft/archived products are never blocked so sellers can keep working.
 * Uses the already-connected pg client to avoid a second connection.
 */
const validateBrandForPublish = async (client, meta, status) => {
  try {
    if (String(status || '').toLowerCase() !== 'published') return { ok: true }
    const m = meta && typeof meta === 'object' ? meta : {}
    const brandId = String(m.brand_id || '').trim()
    if (!brandId) return { ok: true }
    const r = await client.query('SELECT status, name FROM admin_hub_brands WHERE id = $1', [brandId])
    const row = r.rows && r.rows[0]
    if (!row) return { ok: true } // unknown/deleted brand ref → don't block on brand grounds
    if (String(row.status || 'active') === 'active') return { ok: true }
    return { ok: false, message: `Brand authorization pending: "${row.name || brandId}" is not approved yet (status: ${row.status}).` }
  } catch (_) {
    // Fail open: if the brand table/columns are not migrated yet, do not block publishing
    return { ok: true }
  }
}

/**
 * Non-blocking compliance advisory (docs/HUKUKI.md Faz 2, "needs_compliance_review"
 * rollout — never blocks a save/publish). Fire-and-forget: resolves the product's
 * first category to a compliance profile (assign-compliance-profiles.js output) and
 * stamps metadata.compliance_review with what's missing, purely for superuser visibility.
 * Any failure here is silently swallowed — this must never affect the caller's save.
 */
const stampComplianceReviewAsync = async (productId, metadata) => {
  try {
    const meta = metadata && typeof metadata === 'object' ? metadata : {}
    const categoryIds = Array.isArray(meta.category_ids) ? meta.category_ids : []
    const categoryId = categoryIds[0]
    if (!productId || !categoryId) return
    const { resolveCategoryComplianceProfileId } = require('../compliance/category-profile-lookup')
    const { validateProductCompliance, DEFAULT_PROFILE_ID } = require('../compliance/resolve-compliance')
    const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
    const { Client } = require('pg')
    const client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const profileId = await resolveCategoryComplianceProfileId(client, categoryId)
    const result = validateProductCompliance(meta, profileId || DEFAULT_PROFILE_ID, 'DE', { forPublish: false })
    await client.query(
      `UPDATE admin_hub_products SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('compliance_review', $1::jsonb) WHERE id = $2`,
      [JSON.stringify({ profile_id: result.resolved.profile_id, ok: result.ok, missing_fields: result.missing, checked_at: new Date().toISOString() }), productId]
    )
    await client.end()
  } catch (_) {
    // Fail silently and completely — this is advisory-only, never allowed to affect a save.
  }
}

/**
 * GET /admin-hub/v1/compliance-review — superuser only (docs/HUKUKI.md Faz 2 "sıradaki adım" #4).
 * Lists products stampComplianceReviewAsync flagged as ok=false, so a superuser can actually see
 * what needs attention instead of the data just accumulating unseen in metadata.compliance_review.
 */
const adminHubComplianceReviewGET = async (req, res) => {
  const client = getProductsDbClient()
  if (!client) return res.status(503).json({ message: 'Database unavailable' })
  try {
    await client.connect()
    const r = await client.query(`
      SELECT id, title, handle, seller_id, status,
             metadata->'compliance_review' AS compliance_review
        FROM admin_hub_products
       WHERE metadata->'compliance_review'->>'ok' = 'false'
       ORDER BY (metadata->'compliance_review'->>'checked_at') DESC
       LIMIT 500
    `)
    const sellerIds = [...new Set(r.rows.map((row) => row.seller_id).filter(Boolean))]
    const storeNameById = {}
    if (sellerIds.length) {
      const nameRes = await client.query(
        'SELECT seller_id, store_name FROM admin_hub_seller_settings WHERE seller_id = ANY($1)',
        [sellerIds],
      )
      for (const row of nameRes.rows) {
        if (row.store_name != null && String(row.store_name).trim() !== '') {
          storeNameById[row.seller_id] = String(row.store_name).trim()
        }
      }
    }
    await client.end()
    const { resolveComplianceProfile } = require('../compliance/resolve-compliance')
    res.json({
      products: r.rows.map((row) => {
        const profileId = row.compliance_review?.profile_id || null
        const missingFields = Array.isArray(row.compliance_review?.missing_fields) ? row.compliance_review.missing_fields : []
        let profileLabelI18n = {}
        let missingFieldLabels = missingFields.map((key) => ({ key, label_i18n: {} }))
        if (profileId) {
          try {
            const resolved = resolveComplianceProfile(profileId)
            profileLabelI18n = resolved.profile_label_i18n || {}
            missingFieldLabels = missingFields.map((key) => ({ key, label_i18n: resolved.field_definitions[key]?.label_i18n || {} }))
          } catch (_) { /* fall back to raw keys below */ }
        }
        return {
          id: row.id,
          title: row.title,
          handle: row.handle,
          seller_id: row.seller_id,
          seller_name: row.seller_id ? (storeNameById[row.seller_id] || null) : null,
          status: row.status,
          profile_id: profileId,
          profile_label_i18n: profileLabelI18n,
          missing_fields: missingFieldLabels,
          checked_at: row.compliance_review?.checked_at || null,
        }
      }),
    })
  } catch (err) {
    try { await client.end() } catch (_) {}
    console.error('compliance-review GET error:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

const createAdminHubProductDb = async (body) => {
  const client = getProductsDbClient()
  if (!client) return null
  try {
    await client.connect()
    let title = (body.title || '').trim() || 'Untitled'
    let handle = (body.handle || body.slug || '').trim()
    const price = typeof body.price === 'number' ? Math.round(body.price * 100) : parseInt(body.price, 10) || 0
    const inventory = parseInt(body.inventory, 10) || 0
    let metaObj = body.metadata && typeof body.metadata === 'object' ? normalizeProductMetadata(body.metadata) : null
    let description = (body.description || '').trim() || null
    let autoTranslatedLocales = []
    if (body.auto_translate !== false) {
      try {
        const { applyProductAutoTranslate } = require('../product-auto-translate')
        const applied = await applyProductAutoTranslate(
          { metadata: metaObj || {}, title, description: description || '' },
          { sourceLocale: body.source_locale },
        )
        metaObj = applied.metadata
        autoTranslatedLocales = applied.translatedLocales || []
        if (applied.title) title = applied.title
        if (applied.description != null) description = applied.description
      } catch (e) {
        console.warn('createAdminHubProductDb auto-translate:', e && e.message)
      }
    }
    handle = resolveNonPlaceholderHandle(handle, slugifyTitle(title))
    if (isPlaceholderHandle(handle)) handle = slugifyTitle(title) || ('product-' + Date.now())
    if (metaObj) patchPlaceholderTranslationHandles(metaObj, handle, slugifyTitle)
    const variantsArr = body.variants && Array.isArray(body.variants) ? body.variants : null
    const gpsrValidation = validateRequiredGpsrForProduct(metaObj || {}, variantsArr)
    if (!gpsrValidation.ok) { await client.end(); return { __error: gpsrValidation.message || 'GPSR validation failed' } }
    const metadata = metaObj ? JSON.stringify(metaObj) : null
    const variants = variantsArr ? JSON.stringify(variantsArr) : null
    const eanValidation = await validateProductEansDb(client, metaObj && metaObj.ean, collectVariantEans(variantsArr || []), null)
    if (!eanValidation.ok) { await client.end(); return { __error: eanValidation.message || 'EAN validation failed' } }
    const brandGate = await validateBrandForPublish(client, metaObj || {}, (body.status || 'draft').trim())
    if (!brandGate.ok) { await client.end(); return { __error: brandGate.message || 'Brand authorization pending' } }
    const res = await client.query(
      `INSERT INTO admin_hub_products (title, handle, sku, description, status, seller_id, collection_id, price_cents, inventory, metadata, variants)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id, title, handle, sku, description, status, seller_id, collection_id, price_cents, inventory, metadata, variants, created_at, updated_at`,
      [
        title, handle, (body.sku || '').trim() || null, description,
        (body.status || 'draft').trim() || 'draft', (body.seller || body.seller_id || '').trim() || null,
        body.collection_id || null, price, inventory, metadata, variants,
      ]
    )
    await client.end()
    const r = res.rows && res.rows[0]
    if (!r) return null
    stampComplianceReviewAsync(r.id, r.metadata).catch(() => {})
    return {
      id: r.id, title: r.title, handle: r.handle, slug: r.handle, sku: r.sku,
      description: r.description, status: r.status, seller_id: r.seller_id, seller: r.seller_id,
      collection_id: r.collection_id, price: r.price_cents != null ? r.price_cents / 100 : 0,
      price_cents: r.price_cents, inventory: r.inventory != null ? r.inventory : 0,
      metadata: r.metadata, variants: r.variants, created_at: r.created_at, updated_at: r.updated_at,
      ...(autoTranslatedLocales.length ? { auto_translated_locales: autoTranslatedLocales } : {}),
    }
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.warn('createAdminHubProductDb:', e && e.message)
    return null
  }
}

const getAdminHubProductByIdOrHandleDb = async (idOrHandle) => {
  const client = getProductsDbClient()
  if (!client) return null
  try {
    await client.connect()
    const val = String(idOrHandle || '').trim()
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val)
    const hubCols = 'id, title, handle, sku, description, status, seller_id, collection_id, price_cents, inventory, metadata, variants, created_at, updated_at'
    let res
    if (isUuid) {
      res = await client.query(
        `SELECT ${hubCols} FROM admin_hub_products WHERE id = $1`,
        [val]
      )
    } else {
      const parsed = parseProductUrlHandle(val)
      const attempts = []
      // Shop URLs are {handle}-a-{8chars} of the UUID. Resolve by suffix first so
      // leftover placeholder handles like "untitled" cannot collide or go stale.
      if (parsed.shortCode) {
        attempts.push([
          `SELECT ${hubCols} FROM admin_hub_products
           WHERE RIGHT(REPLACE(LOWER(id::text), '-', ''), 8) = $1
           ORDER BY CASE WHEN LOWER(COALESCE(handle, '')) = LOWER($2) THEN 0 ELSE 1 END, updated_at DESC NULLS LAST
           LIMIT 1`,
          [parsed.shortCode, parsed.base || ''],
        ])
      }
      attempts.push([
        `SELECT ${hubCols} FROM admin_hub_products WHERE LOWER(handle) = LOWER($1)`,
        [val],
      ])
      if (parsed.base && parsed.base.toLowerCase() !== val.toLowerCase()) {
        attempts.push([
          `SELECT ${hubCols} FROM admin_hub_products WHERE LOWER(handle) = LOWER($1) ORDER BY updated_at DESC LIMIT 1`,
          [parsed.base],
        ])
      }
      attempts.push([
        `SELECT ${hubCols} FROM admin_hub_products WHERE EXISTS (SELECT 1 FROM jsonb_each(COALESCE(metadata->'translations', '{}'::jsonb)) AS tr(locale_key, tr_data) WHERE tr_data ? 'handle' AND LENGTH(TRIM(COALESCE(tr_data->>'handle', ''))) > 0 AND LOWER(TRIM(tr_data->>'handle')) = LOWER($1)) LIMIT 1`,
        [parsed.base || val],
      ])
      for (const [sql, params] of attempts) {
        res = await client.query(sql, params)
        if (res.rows && res.rows[0]) break
      }
    }
    await client.end()
    const r = res.rows && res.rows[0]
    if (!r) return null
    return {
      id: r.id, title: r.title, handle: r.handle, slug: r.handle, sku: r.sku,
      description: r.description, status: r.status, seller_id: r.seller_id, seller: r.seller_id,
      collection_id: r.collection_id, price: r.price_cents != null ? r.price_cents / 100 : 0,
      inventory: r.inventory != null ? r.inventory : 0, metadata: r.metadata, variants: r.variants,
      created_at: r.created_at, updated_at: r.updated_at,
    }
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.warn('getAdminHubProductByIdOrHandleDb:', e && e.message)
    return null
  }
}

const updateAdminHubProductDb = async (id, body) => {
  const client = getProductsDbClient()
  if (!client) return null
  try {
    const existing = await getAdminHubProductByIdOrHandleDb(id)
    if (!existing) return null
    const uuid = existing.id
    await client.connect()
    let title = body.title !== undefined ? String(body.title).trim() || existing.title : existing.title
    let handle = body.handle !== undefined ? String(body.handle).trim() || existing.handle : existing.handle
    const sku = body.sku !== undefined ? (body.sku === '' ? null : String(body.sku).trim()) : existing.sku
    let description = body.description !== undefined ? (body.description === '' ? null : String(body.description)) : existing.description
    const status = body.status !== undefined ? String(body.status).trim() || 'draft' : existing.status
    const price = body.price !== undefined ? Math.round(Number(body.price) * 100) : (existing.price != null ? Math.round(Number(existing.price) * 100) : 0)
    const inventory = body.inventory !== undefined ? parseInt(body.inventory, 10) || 0 : (existing.inventory ?? 0)
    let metadataObj = existing.metadata && typeof existing.metadata === 'object' ? { ...existing.metadata } : {}
    if (body.metadata !== undefined && body.metadata && typeof body.metadata === 'object') {
      metadataObj = normalizeProductMetadata({ ...metadataObj, ...body.metadata })
    }
    const bodyKeys = Object.keys(body || {})
    const onlyVariantPatch = bodyKeys.length > 0 && bodyKeys.every((k) => k === 'variants')
    const metadataKeysInBody = body.metadata && typeof body.metadata === 'object' ? Object.keys(body.metadata) : []
    // Adding/removing a product from a collection only ever touches metadata.collection_ids
    // (+ the collection_id mirror column) — it must not be blocked by GPSR/brand gates that
    // are meant to guard real product edits/publishes.
    const onlyCollectionPatch = bodyKeys.length > 0 &&
      bodyKeys.every((k) => k === 'metadata' || k === 'collection_id') &&
      metadataKeysInBody.every((k) => k === 'collection_ids')
    const skipComplianceGates = onlyVariantPatch || onlyCollectionPatch
    const nextVariantsArr = body.variants !== undefined
      ? (Array.isArray(body.variants) ? body.variants : [])
      : (Array.isArray(existing.variants) ? existing.variants : [])
    let autoTranslatedLocales = []
    if (!skipComplianceGates && body.auto_translate !== false) {
      try {
        const { applyProductAutoTranslate } = require('../product-auto-translate')
        const existingTr = existing.metadata && typeof existing.metadata === 'object' ? existing.metadata.translations : {}
        const applied = await applyProductAutoTranslate(
          { metadata: metadataObj || {}, title, description: description || '' },
          { sourceLocale: body.source_locale, previousTranslations: existingTr },
        )
        metadataObj = applied.metadata
        autoTranslatedLocales = applied.translatedLocales || []
        if (applied.title) title = applied.title
        if (applied.description != null) description = applied.description
      } catch (e) {
        console.warn('updateAdminHubProductDb auto-translate:', e && e.message)
      }
    }
    handle = resolveNonPlaceholderHandle(handle, slugifyTitle(title))
    if (metadataObj) patchPlaceholderTranslationHandles(metadataObj, handle, slugifyTitle)
    if (!skipComplianceGates) {
      const gpsrValidation = validateRequiredGpsrForProduct(metadataObj || {}, nextVariantsArr)
      if (!gpsrValidation.ok) { await client.end(); return { __error: gpsrValidation.message || 'GPSR validation failed' } }
    }
    const eanValidation = await validateProductEansDb(client, metadataObj && metadataObj.ean, collectVariantEans(nextVariantsArr), uuid)
    if (!eanValidation.ok) { await client.end(); return { __error: eanValidation.message || 'EAN validation failed' } }
    if (!skipComplianceGates) {
      const brandGate = await validateBrandForPublish(client, metadataObj || {}, status)
      if (!brandGate.ok) { await client.end(); return { __error: brandGate.message || 'Brand authorization pending' } }
    }
    const metadata = Object.keys(metadataObj).length ? JSON.stringify(metadataObj) : null
    const variants = body.variants !== undefined ? (Array.isArray(body.variants) ? JSON.stringify(body.variants) : null) : (existing.variants ? JSON.stringify(existing.variants) : null)
    const collection_id = body.collection_id !== undefined ? body.collection_id || null : existing.collection_id
    await client.query(
      `UPDATE admin_hub_products SET title = $1, handle = $2, sku = $3, description = $4, status = $5, price_cents = $6, inventory = $7, metadata = $8, variants = $9, collection_id = $10, updated_at = now() WHERE id = $11`,
      [title, handle, sku, description, status, price, inventory, metadata, variants, collection_id, uuid]
    )
    await client.end()
    stampComplianceReviewAsync(uuid, metadataObj).catch(() => {})
    const saved = await getAdminHubProductByIdOrHandleDb(uuid)
    if (saved && autoTranslatedLocales.length) saved.auto_translated_locales = autoTranslatedLocales
    return saved
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.warn('updateAdminHubProductDb:', e && e.message)
    return null
  }
}

// ── Handlers ──────────────────────────────────────────────────────────────────

const adminHubProductsGET = async (req, res) => {
  try {
    const q = { ...(req.query || {}) }
    const isSuperuser = req.sellerUser?.is_superuser === true
    const sellerId = String(req.sellerUser?.seller_id || '').trim()
    if (!isSuperuser) {
      if (!sellerId) return res.status(403).json({ message: 'Forbidden' })
      q.seller_id = sellerId
    }
    const products = await listAdminHubProductsDb(q)
    res.json({ products, count: products.length })
  } catch (err) {
    console.error('Admin Hub products GET error:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

const adminHubProductsPOST = async (req, res) => {
  try {
    let body = { ...(req.body || {}) }
    const isSuperuserCaller = req.sellerUser?.is_superuser || false
    // Every seller_users row — including superuser accounts — has its own real seller_id
    // (own_seller_id, assigned at registration). A superuser is also a selling entity in
    // their own right, so a product they create must stay attributed to THEM, not become
    // ownerless — otherwise a later seller listing the same EAN visually "takes over" the
    // product (wrong section in Inventory, missing from the shop BuyBox). `isSuperuserCaller`
    // is still used below to bypass ownership *restrictions* (ability to edit shared fields
    // directly instead of via change-request) — that is a separate concern from attribution.
    const callerSellerId = req.sellerUser?.seller_id ? String(req.sellerUser.seller_id).trim() : null
    if (callerSellerId) {
      body.seller_id = callerSellerId; body.seller = callerSellerId
      body.metadata = body.metadata && typeof body.metadata === 'object' ? { ...body.metadata } : {}
      body.metadata.seller_id = callerSellerId
    }
    let queuedMetaSuggestionCount = 0
    if (callerSellerId && !isSuperuserCaller) {
      const sanitized = await queueMetafieldSuggestionsAndSanitizePayload(body, callerSellerId)
      body = sanitized.body; queuedMetaSuggestionCount = sanitized.queued
    }

    const incomingMeta = body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
    const incomingEan = normalizeStoreEan(incomingMeta.ean || body.ean || '')
    let masterProduct = null
    let isNewMaster = true

    if (incomingEan) {
      const dbUrlEan = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      const { Client: EanCl } = require('pg')
      const eanCl = new EanCl({ connectionString: dbUrlEan, ssl: dbUrlEan.includes('render.com') ? { rejectUnauthorized: false } : false })
      let eanDirectFound = false
      try {
        await eanCl.connect()
        const eanSql = `
          SELECT id, title, handle, sku, description, status, seller_id, collection_id,
                 price_cents, inventory, metadata, variants, created_at, updated_at
          FROM admin_hub_products
          WHERE (
            REGEXP_REPLACE(TRIM(COALESCE(metadata->>'ean', '')), '[^0-9]', '', 'g') = $1
            OR EXISTS (
              SELECT 1 FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(COALESCE(variants, 'null'::jsonb)) = 'array'
                  THEN variants ELSE '[]'::jsonb END
              ) AS v
              WHERE REGEXP_REPLACE(TRIM(COALESCE(v->>'ean', '')), '[^0-9]', '', 'g') = $1
            )
          )
          ORDER BY (seller_id IS NULL) DESC, created_at ASC
          LIMIT 1`
        const eanRes = await eanCl.query(eanSql, [incomingEan])
        if (eanRes.rows[0]) {
          const r = eanRes.rows[0]
          masterProduct = {
            id: r.id, title: r.title, handle: r.handle, slug: r.handle, sku: r.sku,
            description: r.description, status: r.status, seller_id: r.seller_id,
            seller: r.seller_id, collection_id: r.collection_id,
            price: r.price_cents != null ? r.price_cents / 100 : 0,
            price_cents: r.price_cents, inventory: r.inventory != null ? r.inventory : 0,
            metadata: r.metadata, variants: r.variants,
            created_at: r.created_at, updated_at: r.updated_at,
          }
          eanDirectFound = true
        }
      } catch (eanLookupErr) {
        console.warn('EAN direct SQL lookup failed, falling back to full scan:', eanLookupErr && eanLookupErr.message)
      } finally {
        try { await eanCl.end() } catch (_) {}
      }
      if (!eanDirectFound) {
        const allProds = await listAdminHubProductsDb({ limit: 5000 })
        masterProduct = pickCanonicalEanMatch(allProds.filter((p) => productHasEan(p, incomingEan)))
      }
    }

    if (masterProduct) {
      isNewMaster = false
      const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      const { Client } = require('pg')
      const lc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
      await lc.connect()
      const effectiveSellerId = callerSellerId || null
      let listing = null
      let newListingCreated = false
      if (effectiveSellerId) {
        const existListing = await lc.query(
          'SELECT id, price_cents, inventory, status FROM admin_hub_seller_listings WHERE product_id = $1 AND seller_id = $2',
          [masterProduct.id, effectiveSellerId]
        )
        if (existListing.rows[0]) {
          listing = existListing.rows[0]
        } else {
          const priceCents = typeof body.price === 'number' ? Math.round(body.price * 100) : parseInt(body.price, 10) || 0
          const inventory = parseInt(body.inventory, 10) || 0
          // Price/inventory/SKU are seller-owned listing fields (see SELLER_LISTING_FIELDS
          // below) — they must never require superuser approval. sku used to be dropped here
          // silently (missing from this INSERT) even though the seller entered one.
          const skuVal = (body.sku || '').toString().trim() || null
          // New cross-seller listings start as 'draft' so they never appear live/in the buy box
          // until the seller (or superuser review) activates them explicitly.
          // Scope the listing to the EAN the seller actually joined with (variant child vs
          // whole family). Otherwise "Andere Verkäufer" shows them under every sibling.
          const matchedOnParentEan = normalizeStoreEan(masterProduct?.metadata?.ean) === incomingEan
          const listingSellerMeta = incomingEan
            ? JSON.stringify(matchedOnParentEan ? { covers_all: true } : { ean: incomingEan })
            : null
          const lr = await lc.query(
            'INSERT INTO admin_hub_seller_listings (product_id, seller_id, price_cents, inventory, status, sku, seller_metadata) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *',
            [masterProduct.id, effectiveSellerId, priceCents, inventory, 'draft', skuVal, listingSellerMeta]
          )
          listing = lr.rows[0]
          newListingCreated = true
        }
      }
      if (newListingCreated && effectiveSellerId) {
        try {
          const sellerNameR = await lc.query(
            `SELECT s.store_name AS settings_store_name, u.store_name AS user_store_name, u.company_name, u.email
             FROM seller_users u
             LEFT JOIN admin_hub_seller_settings s ON s.seller_id = u.seller_id
             WHERE u.seller_id = $1 AND u.sub_of_seller_id IS NULL LIMIT 1`,
            [effectiveSellerId]
          )
          const sRow = sellerNameR.rows[0] || {}
          const sellerDisplayName = (sRow.settings_store_name && String(sRow.settings_store_name).trim()) || (sRow.user_store_name && String(sRow.user_store_name).trim()) || (sRow.company_name && String(sRow.company_name).trim()) || sRow.email || effectiveSellerId
          await lc.query(
            `INSERT INTO admin_hub_notifications (type, title, body, seller_id, reference_id)
             VALUES ('seller_listing_pending', $1, $2, $3, $4)`,
            [
              `Neuer Verkäufer für vorhandenes Produkt: ${masterProduct.title || masterProduct.id}`,
              `${sellerDisplayName} hat "${masterProduct.title || masterProduct.id}" (bereits vorhandene EAN) zu seinem/ihrem Bestand hinzugefügt. Der Eintrag ist als Entwurf gespeichert und muss vor Veröffentlichung freigegeben/aktiviert werden.`,
              effectiveSellerId,
              masterProduct.id,
            ],
          ).catch(() => {})
        } catch (_) {}
      }
      await lc.end()

      if (callerSellerId) {
        const masterMeta = masterProduct.metadata && typeof masterProduct.metadata === 'object' ? masterProduct.metadata : {}
        const LISTING_ONLY_META = [
          'shipping_group_id', 'brand_id', 'publish_date', 'seller_name', 'shop_name', 'seller_id', 'seller',
          // Per-seller commercial fields — must not create product change-requests / overwrite master
          'sku', 'prices', 'uvp_cents', 'rabattpreis_cents', 'related_product_ids',
        ]
        const crFields = []
        const fillFields = {}

        const masterTitle = (masterProduct.title || '').trim()
        const incomingTitle = (body.title || '').trim()
        if (incomingTitle && !masterTitle) { fillFields.title = incomingTitle }
        else if (incomingTitle && masterTitle && incomingTitle !== masterTitle) {
          // Superuser has direct edit authority over shared/master fields — applying it
          // straight away instead of filing a change-request avoids them having to
          // approve their own suggestion (mirrors adminHubProductByIdPUT's ownership gate).
          if (isSuperuserCaller) fillFields.title = incomingTitle
          else crFields.push({ field: 'title', old: masterTitle, val: incomingTitle })
        }

        const masterDesc = (masterProduct.description || '').trim()
        const incomingDesc = (body.description || '').trim()
        if (incomingDesc && !masterDesc) { fillFields.description = incomingDesc }
        else if (incomingDesc && masterDesc && incomingDesc !== masterDesc) {
          if (isSuperuserCaller) fillFields.description = incomingDesc
          else crFields.push({ field: 'description', old: masterDesc, val: incomingDesc })
        }

        for (const mk of Object.keys(incomingMeta).filter((k) => !LISTING_ONLY_META.includes(k))) {
          const masterVal = masterMeta[mk]
          const incomingVal = incomingMeta[mk]
          const masterEmpty = masterVal == null || (typeof masterVal === 'string' && masterVal.trim() === '')
          const incomingStr = JSON.stringify(incomingVal ?? null)
          const masterStr = JSON.stringify(masterVal ?? null)
          if (masterEmpty && incomingVal != null) { fillFields[`metadata.${mk}`] = incomingVal }
          else if (!masterEmpty && incomingStr !== masterStr) {
            if (isSuperuserCaller) fillFields[`metadata.${mk}`] = incomingVal
            else crFields.push({ field: `metadata.${mk}`, old: masterVal == null ? null : JSON.stringify(masterVal), val: incomingVal == null ? '' : JSON.stringify(incomingVal) })
          }
        }

        if (Object.keys(fillFields).length > 0) {
          const dbUrlFill = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
          const { Client: ClientFill } = require('pg')
          const lcFill = new ClientFill({ connectionString: dbUrlFill, ssl: dbUrlFill.includes('render.com') ? { rejectUnauthorized: false } : false })
          try {
            await lcFill.connect()
            const setClause = []
            const fillParams = []
            if (fillFields.title) { setClause.push(`title = $${fillParams.length + 1}`); fillParams.push(fillFields.title) }
            if (fillFields.description) { setClause.push(`description = $${fillParams.length + 1}`); fillParams.push(fillFields.description) }
            const metaFillKeys = Object.keys(fillFields).filter((k) => k.startsWith('metadata.'))
            if (metaFillKeys.length > 0) {
              let metaPatch = {}
              for (const k of metaFillKeys) metaPatch[k.replace('metadata.', '')] = fillFields[k]
              setClause.push(`metadata = metadata || $${fillParams.length + 1}::jsonb`)
              fillParams.push(JSON.stringify(metaPatch))
            }
            if (setClause.length > 0) {
              setClause.push(`updated_at = now()`)
              fillParams.push(masterProduct.id)
              const upRes = await lcFill.query(
                `UPDATE admin_hub_products SET ${setClause.join(', ')} WHERE id = $${fillParams.length} RETURNING title, description, metadata`,
                fillParams
              )
              if (upRes.rows[0]) {
                masterProduct = { ...masterProduct, title: upRes.rows[0].title, description: upRes.rows[0].description, metadata: upRes.rows[0].metadata }
              }
            }
          } finally { try { await lcFill.end() } catch (_) {} }
        }

        if (crFields.length > 0) {
          const dbUrlCr = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
          const { Client: ClientCr } = require('pg')
          const qcr = new ClientCr({ connectionString: dbUrlCr, ssl: dbUrlCr.includes('render.com') ? { rejectUnauthorized: false } : false })
          try {
            await qcr.connect()
            for (const { field, old: oldVal, val: newVal } of crFields) {
              await qcr.query(
                `INSERT INTO admin_hub_product_change_requests (product_id, seller_id, status, field_name, old_value, new_value) VALUES ($1,$2,'pending',$3,$4,$5)`,
                [masterProduct.id, callerSellerId, field, oldVal, newVal]
              )
            }
          } finally { try { await qcr.end() } catch (_) {} }
          queuedMetaSuggestionCount += crFields.length
        }
      }

      const sellerViewProduct = {
        ...masterProduct, status: 'draft', sku: null, price: 0, inventory: 0,
        metadata: (() => {
          const m = masterProduct.metadata && typeof masterProduct.metadata === 'object' ? { ...masterProduct.metadata } : {}
          for (const k of ['sku', 'prices', 'uvp_cents', 'rabattpreis_cents', 'publish_date', 'seller_name', 'shop_name', 'brand_id', 'shipping_group_id', 'related_product_ids', 'seller_id', 'seller']) {
            delete m[k]
          }
          return m
        })(),
        variants: Array.isArray(masterProduct.variants)
          ? masterProduct.variants.map((v) => ({
              ...(v || {}), sku: null, price: undefined, price_cents: 0,
              compare_at_price: undefined, compare_at_price_cents: undefined,
              sale_price: undefined, sale_price_cents: undefined,
              inventory: 0, inventory_quantity: 0,
              metadata: { ...(v?.metadata && typeof v.metadata === 'object' ? v.metadata : {}), brand_id: null, shipping_group_id: null, sku: null, prices: undefined },
            }))
          : [],
      }
      return res.status(200).json({ product: sellerViewProduct, listing, deduplicated: true, is_new_master: false, metafield_suggestions_submitted: queuedMetaSuggestionCount > 0 })
    }

    const row = await createAdminHubProductDb(body)
    if (row && row.__error) {
      if (callerSellerId && typeof row.__error === 'string' && row.__error.startsWith('EAN already exists:')) {
        const eanFromErr = normalizeStoreEan(row.__error.replace('EAN already exists:', '').trim()) || row.__error.replace('EAN already exists:', '').trim()
        let fallbackMaster = null
        try {
          const dbUrlFb = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
          const { Client: FbCl } = require('pg')
          const fbCl = new FbCl({ connectionString: dbUrlFb, ssl: dbUrlFb.includes('render.com') ? { rejectUnauthorized: false } : false })
          try {
            await fbCl.connect()
            const fbSql = `
              SELECT id, title, handle, sku, description, status, seller_id, collection_id,
                     price_cents, inventory, metadata, variants, created_at, updated_at
              FROM admin_hub_products
              WHERE (
                REGEXP_REPLACE(TRIM(COALESCE(metadata->>'ean', '')), '[^0-9]', '', 'g') = $1
                OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(
                    CASE WHEN jsonb_typeof(COALESCE(variants, 'null'::jsonb)) = 'array'
                      THEN variants ELSE '[]'::jsonb END
                  ) AS v
                  WHERE REGEXP_REPLACE(TRIM(COALESCE(v->>'ean', '')), '[^0-9]', '', 'g') = $1
                )
              )
              ORDER BY (seller_id IS NULL) DESC, created_at ASC
              LIMIT 1`
            const fbRes = await fbCl.query(fbSql, [eanFromErr])
            if (fbRes.rows[0]) {
              const r = fbRes.rows[0]
              fallbackMaster = {
                id: r.id, title: r.title, handle: r.handle, slug: r.handle, sku: r.sku,
                description: r.description, status: r.status, seller_id: r.seller_id,
                seller: r.seller_id, collection_id: r.collection_id,
                price: r.price_cents != null ? r.price_cents / 100 : 0,
                price_cents: r.price_cents, inventory: r.inventory != null ? r.inventory : 0,
                metadata: r.metadata, variants: r.variants,
                created_at: r.created_at, updated_at: r.updated_at,
              }
            }
          } finally { try { await fbCl.end() } catch (_) {} }
        } catch (_) {}
        if (fallbackMaster) {
          const dbUrl2 = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
          const { Client: Client2 } = require('pg')
          const lc2 = new Client2({ connectionString: dbUrl2, ssl: dbUrl2.includes('render.com') ? { rejectUnauthorized: false } : false })
          try {
            await lc2.connect()
            const existL = await lc2.query(
              'SELECT id FROM admin_hub_seller_listings WHERE product_id = $1 AND seller_id = $2',
              [fallbackMaster.id, callerSellerId]
            )
            let fallbackListing = existL.rows[0] || null
            if (!fallbackListing) {
              const priceCentsFb = typeof body.price === 'number' ? Math.round(body.price * 100) : parseInt(body.price, 10) || 0
              const inventoryFb = parseInt(body.inventory, 10) || 0
              // New cross-seller listings start as 'draft' so they never appear live/in the buy box
              // until the seller (or superuser review) activates them explicitly.
              const eanFb = normalizeStoreEan(eanFromErr || incomingMeta?.ean || body?.ean || '')
              const matchedParentFb = eanFb && normalizeStoreEan(fallbackMaster?.metadata?.ean) === eanFb
              const metaFb = eanFb ? JSON.stringify(matchedParentFb ? { covers_all: true } : { ean: eanFb }) : null
              const lrFb = await lc2.query(
                'INSERT INTO admin_hub_seller_listings (product_id, seller_id, price_cents, inventory, status, seller_metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *',
                [fallbackMaster.id, callerSellerId, priceCentsFb, inventoryFb, 'draft', metaFb]
              )
              fallbackListing = lrFb.rows[0] || null
              try {
                const sellerNameR = await lc2.query(
                  `SELECT s.store_name AS settings_store_name, u.store_name AS user_store_name, u.company_name, u.email
                   FROM seller_users u
                   LEFT JOIN admin_hub_seller_settings s ON s.seller_id = u.seller_id
                   WHERE u.seller_id = $1 AND u.sub_of_seller_id IS NULL LIMIT 1`,
                  [callerSellerId]
                )
                const sRow = sellerNameR.rows[0] || {}
                const sellerDisplayName = (sRow.settings_store_name && String(sRow.settings_store_name).trim()) || (sRow.user_store_name && String(sRow.user_store_name).trim()) || (sRow.company_name && String(sRow.company_name).trim()) || sRow.email || callerSellerId
                await lc2.query(
                  `INSERT INTO admin_hub_notifications (type, title, body, seller_id, reference_id)
                   VALUES ('seller_listing_pending', $1, $2, $3, $4)`,
                  [
                    `Neuer Verkäufer für vorhandenes Produkt: ${fallbackMaster.title || fallbackMaster.id}`,
                    `${sellerDisplayName} hat "${fallbackMaster.title || fallbackMaster.id}" (bereits vorhandene EAN) zu seinem/ihrem Bestand hinzugefügt. Der Eintrag ist als Entwurf gespeichert und muss vor Veröffentlichung freigegeben/aktiviert werden.`,
                    callerSellerId,
                    fallbackMaster.id,
                  ],
                ).catch(() => {})
              } catch (_) {}
            }
            await lc2.end()
            return res.status(200).json({ product: fallbackMaster, listing: fallbackListing, deduplicated: true, is_new_master: false, metafield_suggestions_submitted: queuedMetaSuggestionCount > 0 })
          } catch (_fb) { try { await lc2.end() } catch (__) {} }
        }
      }
      return res.status(400).json({ message: row.__error })
    }
    if (!row) return res.status(503).json({ message: 'Database not configured or insert failed' })

    let listing = null
    if (callerSellerId && row.id) {
      const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      const { Client } = require('pg')
      const lc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
      try {
        await lc.connect()
        const lr = await lc.query(
          'INSERT INTO admin_hub_seller_listings (product_id, seller_id, price_cents, inventory, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *',
          [row.id, callerSellerId, row.price_cents || 0, row.inventory || 0, 'active']
        )
        listing = lr.rows[0] || null
        await lc.end()
      } catch (_) { try { await lc.end() } catch (__) {} }
    }
    res.status(201).json({ product: row, listing, deduplicated: false, is_new_master: true, metafield_suggestions_submitted: queuedMetaSuggestionCount > 0 })
  } catch (err) {
    console.error('Admin Hub products POST error:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

const adminHubProductByIdGET = async (req, res) => {
  try {
    const product = await getAdminHubProductByIdOrHandleDb(req.params.id)
    if (!product) { res.status(404).json({ message: 'Product not found' }); return }
    let seller_listings = []
    try {
      const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      const { Client } = require('pg')
      const lc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
      await lc.connect()
      const lr = await lc.query(
        `SELECT sl.id, sl.seller_id, sl.price_cents, sl.inventory, sl.status, sl.sku, sl.created_at,
                su.first_name, su.last_name, su.email,
                COALESCE(su.store_name, su.shop_name) AS shop_name
         FROM admin_hub_seller_listings sl
         LEFT JOIN seller_users su ON TRIM(su.seller_id) = TRIM(sl.seller_id)
         WHERE sl.product_id = $1
         ORDER BY sl.created_at ASC`,
        [product.id]
      )
      seller_listings = lr.rows || []
      await lc.end()
    } catch (_) {}
    res.json({ product, seller_listings })
  } catch (err) {
    console.error('Admin Hub product GET error:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

const adminHubProductByIdPUT = async (req, res) => {
  try {
    let body = req.body || {}
    const isSuperuserCaller = req.sellerUser?.is_superuser || false
    const callerSellerId = (!isSuperuserCaller && req.sellerUser?.seller_id) ? String(req.sellerUser.seller_id).trim() : null
    let queuedMetaSuggestionCount = 0
    if (callerSellerId && !isSuperuserCaller) {
      const sanitized = await queueMetafieldSuggestionsAndSanitizePayload(body, callerSellerId)
      body = sanitized.body; queuedMetaSuggestionCount = sanitized.queued
    }
    const existing = await getAdminHubProductByIdOrHandleDb(req.params.id)

    if (existing) {
      const normalizeEan = (v) => { if (v == null) return ''; return String(v).trim() }
      const existingMeta = existing && existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}
      const existingVariants = Array.isArray(existing?.variants) ? existing.variants : []
      const incomingMeta = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {}
      const incomingVariants = Array.isArray(body?.variants) ? body.variants : []
      const exMetaEan = normalizeEan(existingMeta?.ean)
      const inMetaEan = normalizeEan(incomingMeta?.ean)
      if (inMetaEan && exMetaEan && inMetaEan !== exMetaEan) {
        return res.status(400).json({ message: 'EAN cannot be changed.' })
      }
      const exBySku = new Map(
        existingVariants.filter((v) => v && String(v.sku || '').trim()).map((v) => [String(v.sku || '').trim(), v])
      )
      for (const iv of incomingVariants) {
        const sku = String(iv?.sku || '').trim()
        const inEan = normalizeEan(iv?.ean)
        if (!sku || !inEan) continue
        const ev = exBySku.get(sku)
        if (!ev) continue
        const exEan = normalizeEan(ev?.ean)
        if (exEan && inEan !== exEan) return res.status(400).json({ message: 'EAN cannot be changed.' })
      }
    }

    const SELLER_LISTING_FIELDS = ['price', 'inventory', 'status', 'sku']
    const SELLER_LISTING_META_FIELDS = [
      'shipping_group_id', 'brand_id', 'publish_date', 'seller_name', 'shop_name',
      // Seller commercial data — not shared catalog / not a change-request
      'sku', 'prices', 'uvp_cents', 'rabattpreis_cents', 'related_product_ids',
      // Listed child EAN lives on seller_listings.seller_metadata, never on the master row
      'ean',
    ]

    if (callerSellerId && existing && existing.seller_id && String(existing.seller_id).trim() !== callerSellerId && !isSuperuserCaller) {
      const existingMeta = existing && existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}
      const incomingMeta = body?.metadata && typeof body.metadata === 'object' ? body.metadata : {}
      const stringifyVal = (v) => { if (v == null) return ''; if (typeof v === 'object') return JSON.stringify(v); return String(v) }
      const mergePrices = (a, b) => { const out = { ...(a || {}) }; for (const [country, val] of Object.entries((b && typeof b === 'object') ? b : {})) out[country] = { ...(out[country] || {}), ...(val && typeof val === 'object' ? val : {}) }; return out }
      const mergeTranslations = (a, b) => { const out = { ...(a || {}) }; for (const [lang, val] of Object.entries((b && typeof b === 'object') ? b : {})) out[lang] = { ...(out[lang] || {}), ...(val && typeof val === 'object' ? val : {}) }; return out }
      const sharedMetaKeys = Object.keys(incomingMeta).filter((k) => !SELLER_LISTING_META_FIELDS.includes(k))
      const sharedTitleChanged = body?.title !== undefined && String(body.title || '').trim() !== String(existing?.title || '').trim()
      const sharedDescChanged = body?.description !== undefined && String(body.description || '') !== String(existing?.description || '')
      const sharedMetaKeysChanged = sharedMetaKeys.filter((metaKey) => {
        const oldVal = existingMeta?.[metaKey]
        let newVal = incomingMeta?.[metaKey]
        if (metaKey === 'prices') newVal = mergePrices(existingMeta?.prices, newVal)
        if (metaKey === 'translations') newVal = mergeTranslations(existingMeta?.translations, newVal)
        return stringifyVal(oldVal) !== stringifyVal(newVal)
      })
      const wantsSharedChange = sharedTitleChanged || sharedDescChanged || sharedMetaKeysChanged.length > 0
      if (wantsSharedChange) {
        const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
        const { Client } = require('pg')
        const qc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
        try {
          await qc.connect()
          if (sharedTitleChanged) await qc.query(`INSERT INTO admin_hub_product_change_requests (product_id, seller_id, status, field_name, old_value, new_value) VALUES ($1,$2,'pending','title',$3,$4)`, [existing.id, callerSellerId, existing.title || null, body.title || ''])
          if (sharedDescChanged) await qc.query(`INSERT INTO admin_hub_product_change_requests (product_id, seller_id, status, field_name, old_value, new_value) VALUES ($1,$2,'pending','description',$3,$4)`, [existing.id, callerSellerId, existing.description || null, body.description || ''])
          for (const metaKey of sharedMetaKeysChanged) {
            const oldVal = existingMeta?.[metaKey]
            let newVal = incomingMeta?.[metaKey]
            if (metaKey === 'prices') newVal = mergePrices(existingMeta?.prices, newVal)
            if (metaKey === 'translations') newVal = mergeTranslations(existingMeta?.translations, newVal)
            await qc.query(`INSERT INTO admin_hub_product_change_requests (product_id, seller_id, status, field_name, old_value, new_value) VALUES ($1,$2,'pending',$3,$4,$5)`, [
              existing.id, callerSellerId, `metadata.${metaKey}`,
              oldVal == null ? null : String(typeof oldVal === 'object' ? JSON.stringify(oldVal) : oldVal),
              newVal == null ? '' : String(typeof newVal === 'object' ? JSON.stringify(newVal) : newVal),
            ])
          }
        } finally { try { await qc.end() } catch (_) {} }
        // Do NOT return here: a request can carry both a shared-field change proposal
        // AND the caller's own price/inventory/status/sku — both must be persisted below,
        // otherwise the seller-specific fields from this same request are silently lost.
      }

      const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      const { Client } = require('pg')
      const lc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
      await lc.connect()
      const existingListing = await lc.query('SELECT id FROM admin_hub_seller_listings WHERE product_id = $1 AND seller_id = $2 LIMIT 1', [existing.id, callerSellerId])
      const priceCents = body.price !== undefined ? Math.max(0, Math.round(Number(body.price || 0) * 100)) : null
      const inventory = body.inventory !== undefined ? Math.max(0, parseInt(body.inventory, 10) || 0) : null
      const status = body.status !== undefined ? String(body.status || 'active') : null
      const skuVal = body.sku !== undefined ? (body.sku || null) : null
      const meta = body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
      const shippingGroupId = meta.shipping_group_id !== undefined ? (meta.shipping_group_id || null) : null
      const brandId = meta.brand_id !== undefined ? (meta.brand_id || null) : null
      const publishDate = meta.publish_date !== undefined ? (meta.publish_date || null) : null
      const listedEan = normalizeStoreEan(meta.ean || body.ean || '')
      const matchedOnParentEan = listedEan && normalizeStoreEan(existing?.metadata?.ean) === listedEan
      const listingSellerMeta = listedEan
        ? (matchedOnParentEan ? { covers_all: true, ean: listedEan } : { ean: listedEan })
        : null
      let listing = null
      if (existingListing.rows[0]) {
        const lid = existingListing.rows[0].id
        const ur = await lc.query(
          `UPDATE admin_hub_seller_listings SET price_cents = COALESCE($1, price_cents), inventory = COALESCE($2, inventory), status = COALESCE($3, status), sku = COALESCE($4, sku), shipping_group_id = COALESCE($5, shipping_group_id), brand_id = COALESCE($6, brand_id), publish_date = COALESCE($7, publish_date), seller_metadata = CASE WHEN $8::jsonb IS NULL THEN seller_metadata ELSE COALESCE(seller_metadata, '{}'::jsonb) || $8::jsonb END, updated_at = now() WHERE id = $9 RETURNING *`,
          [priceCents, inventory, status, skuVal, shippingGroupId, brandId, publishDate, listingSellerMeta ? JSON.stringify(listingSellerMeta) : null, lid]
        )
        listing = ur.rows[0] || null
      } else {
        const ir = await lc.query(
          `INSERT INTO admin_hub_seller_listings (product_id, seller_id, price_cents, inventory, status, sku, shipping_group_id, brand_id, publish_date, seller_metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
          [existing.id, callerSellerId, priceCents || 0, inventory || 0, status || 'draft', skuVal, shippingGroupId, brandId, publishDate, listingSellerMeta ? JSON.stringify(listingSellerMeta) : null]
        )
        listing = ir.rows[0] || null
        try {
          const sellerNameR = await lc.query(
            `SELECT s.store_name AS settings_store_name, u.store_name AS user_store_name, u.company_name, u.email
             FROM seller_users u
             LEFT JOIN admin_hub_seller_settings s ON s.seller_id = u.seller_id
             WHERE u.seller_id = $1 AND u.sub_of_seller_id IS NULL LIMIT 1`,
            [callerSellerId]
          )
          const sRow = sellerNameR.rows[0] || {}
          const sellerDisplayName = (sRow.settings_store_name && String(sRow.settings_store_name).trim()) || (sRow.user_store_name && String(sRow.user_store_name).trim()) || (sRow.company_name && String(sRow.company_name).trim()) || sRow.email || callerSellerId
          await lc.query(
            `INSERT INTO admin_hub_notifications (type, title, body, seller_id, reference_id)
             VALUES ('seller_listing_pending', $1, $2, $3, $4)`,
            [
              `Neuer Verkäufer für vorhandenes Produkt: ${existing.title || existing.id}`,
              `${sellerDisplayName} hat "${existing.title || existing.id}" (bereits vorhandene EAN) zu seinem/ihrem Bestand hinzugefügt. Der Eintrag ist als Entwurf gespeichert und muss vor Veröffentlichung freigegeben/aktiviert werden.`,
              callerSellerId,
              existing.id,
            ],
          ).catch(() => {})
        } catch (_) {}
      }
      await lc.end()
      return res.json({
        product: {
          ...existing,
          price: (listing?.price_cents || 0) / 100, price_cents: listing?.price_cents || 0,
          inventory: listing?.inventory || 0, status: listing?.status || existing.status, sku: listing?.sku || null,
          metadata: { ...(existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}), ...(listing?.shipping_group_id ? { shipping_group_id: listing.shipping_group_id } : {}), ...(listing?.brand_id ? { brand_id: listing.brand_id } : {}), ...(listing?.publish_date ? { publish_date: listing.publish_date } : {}) },
        },
        listing, listing_saved: true, shared_change_blocked: true,
        suggestion_submitted: wantsSharedChange,
        metafield_suggestions_submitted: queuedMetaSuggestionCount > 0,
        message: wantsSharedChange
          ? (queuedMetaSuggestionCount > 0
              ? 'Fiyat/stok bilgileriniz kaydedildi. Ortak ürün bilgisi değişiklik öneriniz (metafield önerileriyle birlikte) superuser onayına gönderildi.'
              : 'Fiyat/stok bilgileriniz kaydedildi. Ortak ürün bilgisi değişiklik öneriniz superuser onayına gönderildi.')
          : undefined,
      })
    }

    if (callerSellerId && existing && !existing.seller_id) {
      const bodyKeys = Object.keys(body).filter((k) => k !== 'metadata')
      const metaKeys = body.metadata && typeof body.metadata === 'object' ? Object.keys(body.metadata).filter((k) => k !== 'translations') : []
      const hasSharedBodyChange = bodyKeys.some((k) => !SELLER_LISTING_FIELDS.includes(k))
      const hasSharedMetaChange = metaKeys.some((k) => !SELLER_LISTING_META_FIELDS.includes(k))
      const wantsSharedChange = hasSharedBodyChange || hasSharedMetaChange
      if (wantsSharedChange) {
        const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
        const { Client } = require('pg')
        const qc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
        try {
          await qc.connect()
          const sharedKeys = Object.keys(body || {}).filter((k) => !['price', 'inventory', 'status'].includes(k))
          for (const key of sharedKeys) {
            const oldVal = existing && existing[key] !== undefined ? existing[key] : (existing?.metadata && existing.metadata[key] !== undefined ? existing.metadata[key] : null)
            await qc.query(
              `INSERT INTO admin_hub_product_change_requests (product_id, seller_id, status, field_name, old_value, new_value) VALUES ($1,$2,'pending',$3,$4,$5)`,
              [existing.id, callerSellerId, String(key), oldVal == null ? null : String(typeof oldVal === 'object' ? JSON.stringify(oldVal) : oldVal), body[key] == null ? '' : String(typeof body[key] === 'object' ? JSON.stringify(body[key]) : body[key])]
            )
          }
          await qc.end()
        } catch (_) { try { await qc.end() } catch (__) {} }
        // Do NOT return here: the caller's own price/inventory/status/sku from this same
        // request must still be saved below, in addition to the change-request rows above.
      }
      const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      const { Client } = require('pg')
      const lc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
      await lc.connect()
      const existingListing = await lc.query('SELECT id FROM admin_hub_seller_listings WHERE product_id = $1 AND seller_id = $2 LIMIT 1', [existing.id, callerSellerId])
      const priceCents = body.price !== undefined ? Math.max(0, Math.round(Number(body.price || 0) * 100)) : null
      const inventory = body.inventory !== undefined ? Math.max(0, parseInt(body.inventory, 10) || 0) : null
      const status = body.status !== undefined ? String(body.status || 'active') : null
      const skuVal = body.sku !== undefined ? (body.sku || null) : null
      const meta = body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
      const shippingGroupId = meta.shipping_group_id !== undefined ? (meta.shipping_group_id || null) : null
      const brandId = meta.brand_id !== undefined ? (meta.brand_id || null) : null
      const publishDate = meta.publish_date !== undefined ? (meta.publish_date || null) : null
      const listedEan = normalizeStoreEan(meta.ean || body.ean || '')
      const matchedOnParentEan = listedEan && normalizeStoreEan(existing?.metadata?.ean) === listedEan
      const listingSellerMeta = listedEan
        ? (matchedOnParentEan ? { covers_all: true, ean: listedEan } : { ean: listedEan })
        : null
      let listing = null
      if (existingListing.rows[0]) {
        const lid = existingListing.rows[0].id
        const ur = await lc.query(
          `UPDATE admin_hub_seller_listings SET price_cents = COALESCE($1, price_cents), inventory = COALESCE($2, inventory), status = COALESCE($3, status), sku = COALESCE($4, sku), shipping_group_id = COALESCE($5, shipping_group_id), brand_id = COALESCE($6, brand_id), publish_date = COALESCE($7, publish_date), seller_metadata = CASE WHEN $8::jsonb IS NULL THEN seller_metadata ELSE COALESCE(seller_metadata, '{}'::jsonb) || $8::jsonb END, updated_at = now() WHERE id = $9 RETURNING *`,
          [priceCents, inventory, status, skuVal, shippingGroupId, brandId, publishDate, listingSellerMeta ? JSON.stringify(listingSellerMeta) : null, lid]
        )
        listing = ur.rows[0] || null
      } else {
        const ir = await lc.query(
          `INSERT INTO admin_hub_seller_listings (product_id, seller_id, price_cents, inventory, status, sku, shipping_group_id, brand_id, publish_date, seller_metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING *`,
          [existing.id, callerSellerId, priceCents || 0, inventory || 0, status || 'draft', skuVal, shippingGroupId, brandId, publishDate, listingSellerMeta ? JSON.stringify(listingSellerMeta) : null]
        )
        listing = ir.rows[0] || null
        try {
          const sellerNameR = await lc.query(
            `SELECT s.store_name AS settings_store_name, u.store_name AS user_store_name, u.company_name, u.email
             FROM seller_users u
             LEFT JOIN admin_hub_seller_settings s ON s.seller_id = u.seller_id
             WHERE u.seller_id = $1 AND u.sub_of_seller_id IS NULL LIMIT 1`,
            [callerSellerId]
          )
          const sRow = sellerNameR.rows[0] || {}
          const sellerDisplayName = (sRow.settings_store_name && String(sRow.settings_store_name).trim()) || (sRow.user_store_name && String(sRow.user_store_name).trim()) || (sRow.company_name && String(sRow.company_name).trim()) || sRow.email || callerSellerId
          await lc.query(
            `INSERT INTO admin_hub_notifications (type, title, body, seller_id, reference_id)
             VALUES ('seller_listing_pending', $1, $2, $3, $4)`,
            [
              `Neuer Verkäufer für vorhandenes Produkt: ${existing.title || existing.id}`,
              `${sellerDisplayName} hat "${existing.title || existing.id}" (bereits vorhandene EAN) zu seinem/ihrem Bestand hinzugefügt. Der Eintrag ist als Entwurf gespeichert und muss vor Veröffentlichung freigegeben/aktiviert werden.`,
              callerSellerId,
              existing.id,
            ],
          ).catch(() => {})
        } catch (_) {}
      }
      await lc.end()
      const productWithListingData = {
        ...existing,
        price: (listing?.price_cents || 0) / 100, price_cents: listing?.price_cents || 0,
        inventory: listing?.inventory || 0, status: listing?.status || existing.status, sku: listing?.sku || null,
        metadata: { ...(existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}), ...(listing?.shipping_group_id ? { shipping_group_id: listing.shipping_group_id } : {}), ...(listing?.brand_id ? { brand_id: listing.brand_id } : {}), ...(listing?.publish_date ? { publish_date: listing.publish_date } : {}) },
      }
      res.json({
        product: productWithListingData,
        listing, listing_saved: true, shared_change_blocked: false,
        suggestion_submitted: wantsSharedChange,
        metafield_suggestions_submitted: queuedMetaSuggestionCount > 0,
        message: wantsSharedChange
          ? (queuedMetaSuggestionCount > 0
              ? 'Fiyat/stok bilgileriniz kaydedildi. Ortak ürün bilgisi değişiklik öneriniz (metafield önerileriyle birlikte) superuser onayına gönderildi.'
              : 'Fiyat/stok bilgileriniz kaydedildi. Ortak ürün bilgisi değişiklik öneriniz superuser onayına gönderildi.')
          : undefined,
      })
      return
    }

    if (body.metadata && typeof body.metadata === 'object' && existing) {
      const existingMeta = existing.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}
      const merged = normalizeProductMetadata({ ...existingMeta, ...body.metadata })
      body.metadata = applyEuOriginMetadataPolicy(merged, existingMeta, { isSuperuser: isSuperuserCaller })
    }
    const product = await updateAdminHubProductDb(req.params.id, body)
    if (product && product.__error) { res.status(400).json({ message: product.__error }); return }
    if (!product) { res.status(404).json({ message: 'Product not found' }); return }
    if (!isSuperuserCaller && product) {
      const { pickEuOriginFields } = require('../eu-origin')
      const { enqueueEuOriginPending } = require('../eu-origin/queue')
      const candidates = []
      if (product.metadata && typeof product.metadata === 'object') candidates.push(product.metadata)
      if (Array.isArray(product.variants)) {
        for (const v of product.variants) {
          if (v?.metadata && typeof v.metadata === 'object') candidates.push(v.metadata)
        }
      }
      const filled = candidates.find((m) => {
        const f = pickEuOriginFields(m)
        return !!(f.eu_origin_registry_id || f.eu_origin_document_url || f.eu_origin_country)
      })
      if (filled) {
        enqueueEuOriginPending(dbQ, {
          productId: product.id,
          sellerId: callerSellerId,
          meta: filled,
          note: 'Seller filled EU origin badge fields',
        }).catch((e) => console.error('[eu-origin] enqueue after product PUT:', e?.message || e))
      }
    }
    res.json({ product, metafield_suggestions_submitted: queuedMetaSuggestionCount > 0 })
  } catch (err) {
    console.error('Admin Hub product PUT error:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

const adminHubProductByIdDELETE = async (req, res) => {
  const client = getProductsDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    const existing = await getAdminHubProductByIdOrHandleDb(req.params.id)
    if (!existing) return res.status(404).json({ message: 'Product not found' })
    await client.connect()
    await client.query(
      `UPDATE admin_hub_products
         SET metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb),
           '{related_product_ids}',
           COALESCE(
             (SELECT jsonb_agg(to_jsonb(v)) FROM (SELECT elem AS v FROM jsonb_array_elements_text(COALESCE(metadata->'related_product_ids', '[]'::jsonb)) AS elem WHERE LOWER(elem) <> LOWER($1::text)) t),
             '[]'::jsonb
           ), true
         ), updated_at = now()
       WHERE id <> $2 AND COALESCE(metadata->'related_product_ids', '[]'::jsonb) @> to_jsonb(ARRAY[$1::text])`,
      [existing.id, existing.id]
    )
    await client.query('DELETE FROM admin_hub_products WHERE id = $1', [existing.id])
    await client.end()
    res.status(200).json({ deleted: true })
  } catch (err) {
    try { await client.end() } catch (_) {}
    console.error('Admin Hub product DELETE error:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = function createAdminProductsRouter() {
  const router = Router()

  router.get('/admin-hub/products', adminHubProductsGET)
  router.post('/admin-hub/products', adminHubProductsPOST)

  // EAN lookup
  router.get('/admin-hub/products/ean-lookup', async (req, res) => {
    try {
      const ean = String(req.query.ean || '').trim()
      if (!ean) return res.status(400).json({ message: 'ean query param required' })
      const normEan = normalizeStoreEan(ean)
      const allProds = await listAdminHubProductsDb({ limit: 5000 })
      // Matches on the parent's own EAN OR any child/variant EAN — a variant product's
      // sellable items are its children, so their EANs must be searchable too.
      const master = pickCanonicalEanMatch(allProds.filter((p) => productHasEan(p, normEan)))
      if (!master) return res.status(404).json({ message: 'No product found with this EAN' })
      const masterMeta = master.metadata && typeof master.metadata === 'object' ? master.metadata : {}
      const matchedOnParent = normalizeStoreEan(masterMeta.ean) === normEan
      const matchedVariant = matchedOnParent
        ? null
        : parseVariantsArray(master).find((v) => normalizeStoreEan(v && v.ean) === normEan) || null
      // Strip seller-owned commercial fields so another seller never sees SKU/price/shipping
      const SELLER_OWNED_META = [
        'sku', 'prices', 'uvp_cents', 'rabattpreis_cents',
        'shipping_group_id', 'brand_id', 'publish_date',
        'seller_id', 'seller', 'seller_name', 'shop_name', 'related_product_ids',
      ]
      const safeMeta = { ...masterMeta }
      for (const k of SELLER_OWNED_META) delete safeMeta[k]
      const sanitizeVariant = (v) => {
        const vm = v?.metadata && typeof v.metadata === 'object' ? { ...v.metadata } : {}
        delete vm.shipping_group_id
        delete vm.brand_id
        delete vm.sku
        delete vm.prices
        return {
          ...v,
          sku: undefined,
          ean: (v && v.ean) || undefined,
          price: undefined,
          price_cents: 0,
          compare_at_price: undefined,
          compare_at_price_cents: undefined,
          sale_price: undefined,
          sale_price_cents: undefined,
          inventory: 0,
          inventory_quantity: 0,
          metadata: vm,
        }
      }
      const catalogProduct = {
        id: master.id, title: master.title, handle: master.handle, description: master.description,
        metadata: safeMeta,
        variants: Array.isArray(master.variants) ? master.variants.map(sanitizeVariant) : [],
      }
      res.json({
        product: catalogProduct,
        found: true,
        matched_ean: normEan,
        matched_on: matchedOnParent ? 'parent' : 'variant',
        matched_variant_ean: matchedVariant ? normalizeStoreEan(matchedVariant.ean) : null,
      })
    } catch (err) { res.status(500).json({ message: err?.message || 'Lookup failed' }) }
  })

  router.get('/admin-hub/products/:id', adminHubProductByIdGET)
  router.put('/admin-hub/products/:id', adminHubProductByIdPUT)
  router.delete('/admin-hub/products/:id', adminHubProductByIdDELETE)

  // Seller listings map
  router.get('/admin-hub/products/:id/listings', async (req, res) => {
    try {
      if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser only' })
      const productId = String(req.params.id || '').trim()
      if (!productId) return res.status(400).json({ message: 'Product ID required' })
      const dbUrlL = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      const { Client: ListCl } = require('pg')
      const listCl = new ListCl({ connectionString: dbUrlL, ssl: dbUrlL.includes('render.com') ? { rejectUnauthorized: false } : false })
      try {
        await listCl.connect()
        const lr = await listCl.query(
          `SELECT sl.id, sl.seller_id, sl.price_cents, sl.inventory, sl.status, sl.created_at, COALESCE(su.store_name, su.shop_name) AS store_name, su.email
           FROM admin_hub_seller_listings sl LEFT JOIN seller_users su ON TRIM(su.seller_id) = TRIM(sl.seller_id)
           WHERE sl.product_id = $1 ORDER BY sl.created_at ASC`,
          [productId]
        )
        await listCl.end()
        return res.json({ listings: lr.rows || [] })
      } catch (e) { try { await listCl.end() } catch (_) {}; throw e }
    } catch (err) {
      console.error('product listings GET error:', err)
      res.status(500).json({ message: (err && err.message) || 'Internal server error' })
    }
  })

  // Product listings map (superuser)
  router.get('/admin-hub/product-listings-map', async (req, res) => {
    try {
      if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser only' })
      const dbUrlMap = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      const { Client: MapCl } = require('pg')
      const mapCl = new MapCl({ connectionString: dbUrlMap, ssl: dbUrlMap.includes('render.com') ? { rejectUnauthorized: false } : false })
      try {
        await mapCl.connect()
        const mr = await mapCl.query(
          `SELECT sl.product_id, array_agg(sl.seller_id ORDER BY sl.created_at ASC) AS seller_ids
           FROM admin_hub_seller_listings sl JOIN admin_hub_products p ON p.id = sl.product_id AND p.seller_id IS NULL
           GROUP BY sl.product_id`
        )
        await mapCl.end()
        const map = {}
        for (const row of (mr.rows || [])) map[row.product_id] = row.seller_ids || []
        return res.json({ map })
      } catch (e) { try { await mapCl.end() } catch (_) {}; throw e }
    } catch (err) {
      console.error('product-listings-map error:', err)
      res.status(500).json({ message: (err && err.message) || 'Internal server error' })
    }
  })

  // Duplicate-EAN detection & merge (Görev: multi-seller ownership reconciliation).
  // A weak EAN-normalization bug (fixed above, see normalizeEanValue) previously let a
  // second seller's "add existing product" create a brand-new admin_hub_products row
  // instead of a listing on the original, making the original owner's product appear
  // to "move" to the newer seller. This tool finds any such already-existing duplicate
  // rows and lets a superuser merge them back into the true (oldest-owned) master.
  router.get('/admin-hub/v1/compliance-review', requireSuperuser, adminHubComplianceReviewGET)
  router.get('/admin-hub/v1/products/duplicate-eans', requireSuperuser, async (req, res) => {
    try {
      const allProds = await listAdminHubProductsDb({ limit: 5000 })
      const groups = new Map()
      for (const p of allProds) {
        if (String(p.status || '') === 'merged') continue
        const ean = extractEanFromHubProductRow(p)
        if (!ean) continue
        if (!groups.has(ean)) groups.set(ean, [])
        groups.get(ean).push(p)
      }
      const duplicateGroups = []
      for (const [ean, rows] of groups) {
        if (rows.length < 2) continue
        const master = pickCanonicalEanMatch(rows)
        const duplicates = rows.filter((r) => r.id !== master.id)
        duplicateGroups.push({
          ean,
          master: { id: master.id, title: master.title, seller_id: master.seller_id, created_at: master.created_at },
          duplicates: duplicates.map((d) => ({
            id: d.id, title: d.title, seller_id: d.seller_id, created_at: d.created_at,
            price_cents: d.price_cents, inventory: d.inventory, sku: d.sku, status: d.status,
          })),
        })
      }
      res.json({ groups: duplicateGroups })
    } catch (err) {
      console.error('duplicate-eans GET error:', err)
      res.status(500).json({ message: (err && err.message) || 'Internal server error' })
    }
  })

  router.post('/admin-hub/v1/products/duplicate-eans/:masterId/merge', requireSuperuser, async (req, res) => {
    const masterId = String(req.params.masterId || '').trim()
    const duplicateProductId = String(req.body?.duplicateProductId || '').trim()
    if (!masterId || !duplicateProductId) return res.status(400).json({ message: 'masterId and duplicateProductId required' })
    if (masterId === duplicateProductId) return res.status(400).json({ message: 'masterId and duplicateProductId must differ' })
    const client = getProductsDbClient()
    if (!client) return res.status(503).json({ message: 'Database not configured' })
    try {
      await client.connect()
      await client.query('BEGIN')

      const dupRes = await client.query('SELECT * FROM admin_hub_products WHERE id = $1 FOR UPDATE', [duplicateProductId])
      const dup = dupRes.rows[0]
      const masterRes = await client.query('SELECT * FROM admin_hub_products WHERE id = $1 FOR UPDATE', [masterId])
      const master = masterRes.rows[0]
      if (!dup || !master) { await client.query('ROLLBACK'); return res.status(404).json({ message: 'Product not found' }) }

      // 1) The duplicate row's own seller/price/inventory data becomes a normal listing
      // on the master, if that seller doesn't already have one.
      if (dup.seller_id) {
        await client.query(
          `INSERT INTO admin_hub_seller_listings (product_id, seller_id, price_cents, inventory, status, sku)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (product_id, seller_id) DO NOTHING`,
          [masterId, dup.seller_id, dup.price_cents || 0, dup.inventory || 0, dup.status || 'active', dup.sku || null]
        )
      }

      // 2) Re-point any real listing rows the duplicate already accumulated, skipping
      // ones that would collide with a listing the master already has for that seller.
      await client.query(
        `DELETE FROM admin_hub_seller_listings sl
         WHERE sl.product_id = $1
           AND EXISTS (SELECT 1 FROM admin_hub_seller_listings m WHERE m.product_id = $2 AND m.seller_id = sl.seller_id)`,
        [duplicateProductId, masterId]
      )
      await client.query('UPDATE admin_hub_seller_listings SET product_id = $1 WHERE product_id = $2', [masterId, duplicateProductId])

      // 3) Re-point dependent rows that have no seller-collision risk.
      await client.query('UPDATE admin_hub_product_change_requests SET product_id = $1 WHERE product_id = $2', [masterId, duplicateProductId])
      await client.query('UPDATE admin_hub_eu_origin_pending SET product_id = $1 WHERE product_id = $2', [masterId, duplicateProductId])
      await client.query(
        `DELETE FROM store_customer_wishlist w
         WHERE w.product_id = $1
           AND EXISTS (SELECT 1 FROM store_customer_wishlist m WHERE m.product_id = $2 AND m.customer_id = w.customer_id)`,
        [duplicateProductId, masterId]
      )
      await client.query('UPDATE store_customer_wishlist SET product_id = $1 WHERE product_id = $2', [masterId, duplicateProductId])

      // 4) Never hard-delete (child rows CASCADE) — archive instead, preserving order/audit history.
      await client.query(
        `UPDATE admin_hub_products
         SET status = 'merged', metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('merged_into_id', $1::text), updated_at = now()
         WHERE id = $2`,
        [masterId, duplicateProductId]
      )

      await client.query('COMMIT')
      res.json({ merged: true, master_id: masterId, duplicate_product_id: duplicateProductId })
    } catch (err) {
      try { await client.query('ROLLBACK') } catch (_) {}
      console.error('duplicate-eans merge error:', err)
      res.status(500).json({ message: (err && err.message) || 'Internal server error' })
    } finally {
      try { await client.end() } catch (_) {}
    }
  })

  // Repair for rows already broken by the callerSellerId-forced-to-null bug (fixed above,
  // see adminHubProductsPOST): only ever allowed on a currently-unowned row, so it can assign
  // a missing owner but can never reassign one that already exists.
  // Fold N standalone products into one parent's variants[] (TASK 22).
  // Soft-archives absorbed rows (status=merged) — never hard-deletes.
  router.post('/admin-hub/v1/products/combine-as-variants', async (req, res) => {
    const { buildCombineAsVariantsPlan } = require('../combine-as-variants-core')
    const parentId = String(req.body?.parent_id || '').trim()
    const productIds = Array.isArray(req.body?.product_ids)
      ? [...new Set(req.body.product_ids.map((id) => String(id || '').trim()).filter(Boolean))]
      : []
    const optionName = String(req.body?.option_name || '').trim()
    const optionValues =
      req.body?.option_values && typeof req.body.option_values === 'object' && !Array.isArray(req.body.option_values)
        ? req.body.option_values
        : {}

    if (!parentId) return res.status(400).json({ message: 'parent_id required' })
    if (!productIds.includes(parentId)) productIds.unshift(parentId)
    if (productIds.length < 2) return res.status(400).json({ message: 'At least 2 product_ids required' })

    const isSuperuser = req.sellerUser?.is_superuser === true
    const callerSellerId = req.sellerUser?.seller_id ? String(req.sellerUser.seller_id).trim() : null
    if (!isSuperuser && !callerSellerId) return res.status(403).json({ message: 'Forbidden' })

    const client = getProductsDbClient()
    if (!client) return res.status(503).json({ message: 'Database not configured' })

    try {
      await client.connect()
      await client.query('BEGIN')

      const loaded = []
      for (const id of productIds) {
        const r = await client.query(
          `SELECT id, title, handle, sku, description, status, seller_id, collection_id,
                  price_cents, inventory, metadata, variants, created_at, updated_at
           FROM admin_hub_products WHERE id = $1 FOR UPDATE`,
          [id]
        )
        if (!r.rows[0]) {
          await client.query('ROLLBACK')
          return res.status(404).json({ message: `Product not found: ${id}` })
        }
        loaded.push(r.rows[0])
      }

      if (!isSuperuser) {
        for (const p of loaded) {
          const owner = String(p.seller_id || (p.metadata && p.metadata.seller_id) || '').trim()
          if (owner && owner !== callerSellerId) {
            await client.query('ROLLBACK')
            return res.status(403).json({ message: `Not allowed to combine product: ${p.title || p.id}` })
          }
        }
      }

      const plan = buildCombineAsVariantsPlan({
        parentId,
        products: loaded,
        optionName,
        optionValues,
      })
      if (!plan.ok) {
        await client.query('ROLLBACK')
        return res.status(400).json({ message: plan.message })
      }

      const parentRow = loaded.find((p) => String(p.id) === plan.parentId)
      const parentMeta =
        parentRow.metadata && typeof parentRow.metadata === 'object' ? { ...parentRow.metadata } : {}
      Object.assign(parentMeta, plan.parent_metadata_patch)
      if (plan.parent_metadata_patch.ean === null) delete parentMeta.ean

      const eanValidation = await validateProductEansDb(
        client,
        parentMeta.ean,
        collectVariantEans(plan.variants),
        [plan.parentId, ...plan.source_ids_to_archive]
      )
      if (!eanValidation.ok) {
        await client.query('ROLLBACK')
        return res.status(400).json({ message: eanValidation.message })
      }

      // Clear parent-level SKU when folding the parent's own sellable into a variant —
      // SKU lives on the variant now.
      const nextSku = plan.convertParentSelf ? null : parentRow.sku
      const invSum = plan.variants.reduce((s, v) => s + (Number(v.inventory) || 0), 0)
      const firstPrice = Number(plan.variants[0]?.price_cents) || Number(parentRow.price_cents) || 0

      await client.query(
        `UPDATE admin_hub_products
         SET sku = $1,
             price_cents = $2,
             inventory = $3,
             metadata = $4::jsonb,
             variants = $5::jsonb,
             updated_at = now()
         WHERE id = $6`,
        [
          nextSku,
          firstPrice,
          invSum,
          JSON.stringify(parentMeta),
          JSON.stringify(plan.variants),
          plan.parentId,
        ]
      )

      for (const sourceId of plan.source_ids_to_archive) {
        // Listings / wishlist / change-requests → parent (same pattern as duplicate-ean merge).
        // Carry the source product's sellable EAN into seller_metadata so multi-offer stays
        // scoped to that child after fold-into-parent.
        const sourceRow = await client.query(
          `SELECT metadata, variants FROM admin_hub_products WHERE id = $1 LIMIT 1`,
          [sourceId]
        )
        const src = sourceRow.rows[0] || {}
        const srcMeta = src.metadata && typeof src.metadata === 'object' ? src.metadata : {}
        let srcEan = normalizeStoreEan(srcMeta.ean)
        if (!srcEan) {
          const srcVars = Array.isArray(src.variants) ? src.variants : (typeof src.variants === 'string' ? (() => { try { const j = JSON.parse(src.variants); return Array.isArray(j) ? j : [] } catch (_) { return [] } })() : [])
          for (const v of srcVars) {
            srcEan = normalizeStoreEan(v && v.ean)
            if (srcEan) break
          }
        }
        const srcListingMeta = srcEan ? JSON.stringify({ ean: srcEan }) : null
        await client.query(
          `INSERT INTO admin_hub_seller_listings (product_id, seller_id, price_cents, inventory, status, sku, seller_metadata)
           SELECT $1, seller_id, price_cents, inventory, status, sku, COALESCE(seller_metadata, $3::jsonb) FROM admin_hub_seller_listings
           WHERE product_id = $2
           ON CONFLICT (product_id, seller_id) DO NOTHING`,
          [plan.parentId, sourceId, srcListingMeta]
        )
        // Existing rows that moved via UPDATE below also get EAN if still empty
        if (srcListingMeta) {
          await client.query(
            `UPDATE admin_hub_seller_listings
             SET seller_metadata = COALESCE(seller_metadata, '{}'::jsonb) || $3::jsonb
             WHERE product_id = $2
               AND (seller_metadata IS NULL OR seller_metadata->>'ean' IS NULL OR TRIM(COALESCE(seller_metadata->>'ean','')) = '')`,
            [plan.parentId, sourceId, srcListingMeta]
          )
        }
        await client.query(
          `DELETE FROM admin_hub_seller_listings sl
           WHERE sl.product_id = $1
             AND EXISTS (SELECT 1 FROM admin_hub_seller_listings m WHERE m.product_id = $2 AND m.seller_id = sl.seller_id)`,
          [sourceId, plan.parentId]
        )
        await client.query('UPDATE admin_hub_seller_listings SET product_id = $1 WHERE product_id = $2', [
          plan.parentId,
          sourceId,
        ])
        await client.query(
          'UPDATE admin_hub_product_change_requests SET product_id = $1 WHERE product_id = $2',
          [plan.parentId, sourceId]
        )
        try {
          await client.query('UPDATE admin_hub_eu_origin_pending SET product_id = $1 WHERE product_id = $2', [
            plan.parentId,
            sourceId,
          ])
        } catch (_) { /* table may not exist in older envs */ }
        try {
          await client.query(
            `DELETE FROM store_customer_wishlist w
             WHERE w.product_id = $1
               AND EXISTS (SELECT 1 FROM store_customer_wishlist m WHERE m.product_id = $2 AND m.customer_id = w.customer_id)`,
            [sourceId, plan.parentId]
          )
          await client.query('UPDATE store_customer_wishlist SET product_id = $1 WHERE product_id = $2', [
            plan.parentId,
            sourceId,
          ])
        } catch (_) { /* wishlist table may not exist */ }

        await client.query(
          `UPDATE admin_hub_products
           SET status = 'merged',
               metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('merged_into_id', $1::text),
               updated_at = now()
           WHERE id = $2`,
          [plan.parentId, sourceId]
        )
      }

      await client.query('COMMIT')
      const product = await getAdminHubProductByIdOrHandleDb(plan.parentId)
      res.json({
        combined: true,
        parent_id: plan.parentId,
        archived_ids: plan.source_ids_to_archive,
        variant_count: plan.variants.length,
        product,
      })
    } catch (err) {
      try { await client.query('ROLLBACK') } catch (_) {}
      console.error('combine-as-variants error:', err)
      res.status(500).json({ message: (err && err.message) || 'Internal server error' })
    } finally {
      try { await client.end() } catch (_) {}
    }
  })

  router.post('/admin-hub/v1/products/:id/claim-owner', requireSuperuser, async (req, res) => {
    const productId = String(req.params.id || '').trim()
    const sellerId = String(req.body?.seller_id || req.sellerUser?.seller_id || '').trim()
    if (!productId || !sellerId) return res.status(400).json({ message: 'seller_id required' })
    const client = getProductsDbClient()
    if (!client) return res.status(503).json({ message: 'Database not configured' })
    try {
      await client.connect()
      // Don't reuse $1 as both column value and jsonb_build_object arg — Postgres
      // then fails with "inconsistent types deduced for parameter $1".
      const r = await client.query(
        `UPDATE admin_hub_products
         SET seller_id = $1,
             metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
             updated_at = now()
         WHERE id = $2::uuid AND seller_id IS NULL
         RETURNING id, seller_id`,
        [sellerId, productId, JSON.stringify({ seller_id: sellerId })]
      )
      if (!r.rows[0]) return res.status(409).json({ message: 'Product already has an owner' })
      res.json({ claimed: true, product_id: productId, seller_id: sellerId })
    } catch (err) {
      console.error('claim-owner error:', err)
      res.status(500).json({ message: (err && err.message) || 'Internal server error' })
    } finally {
      try { await client.end() } catch (_) {}
    }
  })

  // EU-origin routes (registered directly on router)
  registerEuOriginRoutes(router, {
    requireSellerAuth,
    requireSuperuser,
    verifySellerToken,
    getAdminHubProductByIdOrHandleDb,
    updateAdminHubProductDb,
    getDbQ: () => dbQ,
  })

  // Bulk import
  router.post('/admin-hub/v1/products/bulk-import', async (req, res) => {
    const callerSellerId = req.sellerUser?.seller_id ? String(req.sellerUser.seller_id).trim() : null
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : []
    if (!rows.length) return res.status(400).json({ message: 'rows array required' })
    if (rows.length > 500) return res.status(400).json({ message: 'Max 500 rows per request' })
    // Görev 30: the "category"/"brand" CSV columns used to be written into unused
    // metadata.category_name/brand_name strings — adminHubProductsPOST only ever reads
    // metadata.category_id/brand_id, so imported products silently ended up with no
    // category or brand at all. Resolve names to real ids up front (one query each,
    // not per row) the same way the sellercentral Excel importer does.
    const categoryIdByLowerName = new Map()
    const brandIdByLowerName = new Map()
    try {
      const lookupClient = getProductsDbClient()
      if (lookupClient) {
        await lookupClient.connect()
        const catRes = await lookupClient.query(`SELECT id, name FROM admin_hub_categories WHERE active = true`)
        for (const r of catRes.rows || []) {
          const k = String(r.name || '').trim().toLowerCase()
          if (k) categoryIdByLowerName.set(k, r.id)
        }
        const brandRes = await lookupClient.query(`SELECT id, name FROM admin_hub_brands WHERE status = 'active'`)
        for (const r of brandRes.rows || []) {
          const k = String(r.name || '').trim().toLowerCase()
          if (k) brandIdByLowerName.set(k, r.id)
        }
        await lookupClient.end()
      }
    } catch (_) { /* lookups are best-effort — import still proceeds without category/brand linking */ }
    const results = []
    for (const row of rows) {
      try {
        const title = String(row.title || row.Title || row.name || '').trim()
        if (!title) { results.push({ title: '', status: 'skipped', reason: 'Missing title' }); continue }
        const price = parseFloat(String(row.price || row.Price || row['Preis'] || '0').replace(',', '.')) || 0
        const inventory = parseInt(String(row.inventory || row.Inventory || row['Bestand'] || row['inventory_quantity'] || '0'), 10) || 0
        const sku = String(row.sku || row.SKU || '').trim() || null
        const description = String(row.description || row.Description || row['Beschreibung'] || '').trim() || null
        const status = String(row.status || row.Status || 'draft').toLowerCase()
        const categoryName = String(row.category || row.Category || row['Kategorie'] || '').trim() || null
        const brandName = String(row.brand || row.Brand || row['Marke'] || '').trim() || null
        const weight = parseFloat(String(row.weight || row.Weight || row['Gewicht'] || '0').replace(',', '.')) || null
        const ean = String(row.ean || row.EAN || '').trim() || null
        const imageUrls = [row['image_url_1'] || row['Image URL 1'] || row['image1'] || '', row['image_url_2'] || row['Image URL 2'] || row['image2'] || '', row['image_url_3'] || row['Image URL 3'] || row['image3'] || ''].map((u) => String(u || '').trim()).filter(Boolean)
        const categoryId = categoryName ? categoryIdByLowerName.get(categoryName.toLowerCase()) || null : null
        const brandId = brandName ? brandIdByLowerName.get(brandName.toLowerCase()) || null : null
        const unmatchedNames = []
        if (categoryName && !categoryId) unmatchedNames.push(`category "${categoryName}" not found`)
        if (brandName && !brandId) unmatchedNames.push(`brand "${brandName}" not found`)
        const productPayload = {
          title, sku, description,
          status: ['published', 'draft', 'archived'].includes(status) ? status : 'draft',
          price, inventory, seller_id: callerSellerId,
          metadata: { ...(ean ? { ean } : {}), ...(brandId ? { brand_id: brandId } : {}), ...(categoryId ? { category_id: categoryId, category_ids: [categoryId] } : {}), ...(weight ? { weight } : {}), ...(imageUrls.length ? { media: imageUrls.map((url) => ({ url, type: 'image' })) } : {}), seller_id: callerSellerId },
        }
        const backendBase = `http://localhost:${process.env.PORT || 9000}`
        const authHeader = req.headers.authorization || ''
        const createRes = await fetch(`${backendBase}/admin-hub/products`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authHeader }, body: JSON.stringify(productPayload) })
        const createData = await createRes.json().catch(() => ({}))
        if (!createRes.ok) { results.push({ title, status: 'error', reason: createData?.message || `HTTP ${createRes.status}` }) }
        else { results.push({ title, status: 'created', id: createData?.product?.id || createData?.id || null, reason: unmatchedNames.length ? unmatchedNames.join('; ') : undefined }) }
      } catch (e) { results.push({ title: String(row.title || row.Title || ''), status: 'error', reason: e?.message || 'Unknown error' }) }
    }
    const created = results.filter((r) => r.status === 'created').length
    const errors = results.filter((r) => r.status === 'error').length
    const skipped = results.filter((r) => r.status === 'skipped').length
    res.json({ results, summary: { total: rows.length, created, errors, skipped } })
  })

  // Variant-only PATCH
  router.patch('/admin-hub/products/:id/variants', async (req, res) => {
    try {
      const body = req.body || {}
      if (!Array.isArray(body.variants)) return res.status(400).json({ message: 'variants array required' })
      const existing = await getAdminHubProductByIdOrHandleDb(req.params.id)
      if (!existing) return res.status(404).json({ message: 'Product not found' })
      const isSuperuser = req.sellerUser?.is_superuser || false
      const callerSellerId = (!isSuperuser && req.sellerUser?.seller_id) ? String(req.sellerUser.seller_id).trim() : null
      if (callerSellerId && existing.seller_id && String(existing.seller_id).trim() !== callerSellerId) return res.status(403).json({ message: 'Forbidden' })
      const normalizeEan = (v) => { if (v == null) return ''; return String(v).trim() }
      const existingVariants = Array.isArray(existing?.variants) ? existing.variants : []
      const incomingVariants = Array.isArray(body?.variants) ? body.variants : []
      const existingBySku = new Map(existingVariants.filter((v) => v && String(v?.sku || '').trim()).map((v) => [String(v.sku || '').trim(), v]))
      for (const iv of incomingVariants) {
        const sku = String(iv?.sku || '').trim()
        const inEan = normalizeEan(iv?.ean)
        if (!sku || !inEan) continue
        const ev = existingBySku.get(sku)
        if (!ev) continue
        const exEan = normalizeEan(ev?.ean)
        if (exEan && inEan !== exEan) return res.status(400).json({ message: 'EAN cannot be changed.' })
      }
      const client = getProductsDbClient()
      if (!client) return res.status(503).json({ message: 'Database not configured' })
      await client.connect()
      await client.query('UPDATE admin_hub_products SET variants = $1, updated_at = now() WHERE id = $2', [JSON.stringify(body.variants), existing.id])
      await client.end()
      const updated = await getAdminHubProductByIdOrHandleDb(existing.id)
      res.json({ product: updated })
    } catch (err) {
      console.error('PATCH product variants error:', err)
      res.status(500).json({ message: (err && err.message) || 'Internal server error' })
    }
  })

  return router
}

module.exports.getAdminHubProductByIdOrHandleDb = getAdminHubProductByIdOrHandleDb
module.exports.updateAdminHubProductDb = updateAdminHubProductDb
module.exports.getProductsDbClient = getProductsDbClient
module.exports.listAdminHubProductsDb = listAdminHubProductsDb
