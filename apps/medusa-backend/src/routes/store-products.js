'use strict'
const { Router } = require('express')
const { resolveAdminHub, mapAdminHubCategoryPgRow, buildAdminHubCategoryTreeFromFlat, getCategoriesPgClient } = require('../categories-helpers')
const { getAdminHubProductByIdOrHandleDb, listAdminHubProductsDb, getProductsDbClient } = require('./admin-products')
const { getSellerStoreName, getApprovedSellerIdsSet, isStorePublishedStatus, isStoreVisibleSellerProduct, storePublishedStatusSql } = require('./seller-settings')
const { isEuOriginVerified } = require('../eu-origin')
const { createTieredCache } = require('../tiered-cache')

// ── DB ────────────────────────────────────────────────────────────────────────
// Görev 25: shared pool (src/db-pool.js) instead of a fresh Client per call — this
// file backs the public shop's product listing/search/detail pages, its single
// highest-traffic read path.
const getDbClient = () => require('../db-pool').getPooledClient()

// Brands use same DATABASE_URL as other tables
const getBrandsDbClient = () => getDbClient()

// ── URL resolver ──────────────────────────────────────────────────────────────
const _SERVER_URL = (() => (process.env.SERVER_URL || `http://localhost:${process.env.PORT || 9000}`).replace(/\/$/, ''))

const resolveUploadUrl = (url) => {
  if (url == null || url === '') return null
  if (typeof url === 'object' && url !== null) {
    const nested = url.url != null ? url.url : url.src != null ? url.src : url.path != null ? url.path : null
    if (nested != null && nested !== url) return resolveUploadUrl(nested)
    return null
  }
  const s = typeof url === 'string' ? url : String(url)
  const t = s.trim()
  if (!t) return null
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t)
      if (Array.isArray(arr) && arr[0]) return resolveUploadUrl(arr[0])
    } catch (_) {}
    return null
  }
  if (t.startsWith('http') || t.startsWith('//')) return t
  return `${_SERVER_URL()}${t.startsWith('/') ? '' : '/'}${t}`
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const isUuidLike = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((s || '').trim())

const getBrandById = async (brandId) => {
  if (!brandId) return null
  const client = getBrandsDbClient()
  if (!client) return null
  try {
    await client.connect()
    const r = await client.query('SELECT id, name, handle, logo_image, banner_image FROM admin_hub_brands WHERE id = $1', [brandId])
    await client.end()
    return r.rows && r.rows[0] ? r.rows[0] : null
  } catch (e) {
    try { await client.end() } catch (_) {}
    return null
  }
}

const getCategoryById = async (categoryId) => {
  const id = (categoryId || '').toString().trim()
  if (!id) return null
  const client = getBrandsDbClient()
  if (!client) return null
  try {
    await client.connect()
    const r = await client.query('SELECT id, name, slug, parent_id, active, is_visible FROM admin_hub_categories WHERE id = $1::uuid', [id])
    await client.end()
    return r.rows && r.rows[0] ? r.rows[0] : null
  } catch (e) {
    try { await client.end() } catch (_) {}
    return null
  }
}

const getAdminHubCollectionById = async (collectionId) => {
  if (!collectionId) return null
  let client
  try {
    client = getDbClient()
    if (!client) return null
    await client.connect()
    const res = await client.query('SELECT id, title, handle FROM admin_hub_collections WHERE id = $1', [collectionId])
    const r = res.rows && res.rows[0]
    await client.end()
    return r ? { id: r.id, title: r.title, handle: r.handle } : null
  } catch (e) {
    try { if (client) await client.end() } catch (_) {}
    return null
  }
}

const getAdminHubCollectionIdByHandle = async (handle) => {
  if (!handle) return null
  let client
  try {
    client = getDbClient()
    if (!client) return null
    await client.connect()
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(handle.trim())
    const res = isUuid
      ? await client.query('SELECT id FROM admin_hub_collections WHERE id = $1::uuid', [handle])
      : await client.query('SELECT id FROM admin_hub_collections WHERE LOWER(handle) = LOWER($1)', [handle])
    await client.end()
    return res.rows && res.rows[0] ? res.rows[0].id : null
  } catch (e) {
    try { if (client) await client.end() } catch (_) {}
    return null
  }
}

const BESTSELLER_CACHE_TTL_MS = 5 * 60 * 1000
let bestsellerCache = { expiresAt: 0, ids: new Set(), scoresById: new Map() }
// Redis mirror of bestsellerCache — Set/Map aren't JSON-serializable, so the shared value is a
// plain [id, score] entries array; each instance rebuilds its own Set/Map from it. Sharing this
// avoids every Render instance re-scanning the full orders+products tables every 5 minutes.
const bestsellerRedisCache = createTieredCache('bestseller-scores', BESTSELLER_CACHE_TTL_MS / 1000)

const salesScoreFromMetadata = (metadata) => {
  const m = metadata && typeof metadata === 'object' ? metadata : {}
  const soldLastMonth = Number(m.sold_last_month ?? 0)
  const salesCount = Number(m.sales_count ?? 0)
  return Math.max(soldLastMonth, salesCount)
}

const getBestsellerProductIds = async () => {
  const now = Date.now()
  if (bestsellerCache.expiresAt > now && bestsellerCache.ids && bestsellerCache.ids.size > 0) return bestsellerCache.ids

  const sharedEntries = await bestsellerRedisCache.get('entries')
  if (Array.isArray(sharedEntries)) {
    const allScoresById = new Map(sharedEntries)
    const ids = new Set([...allScoresById.entries()].filter(([, s]) => s >= 1).map(([id]) => id))
    bestsellerCache = { expiresAt: now + BESTSELLER_CACHE_TTL_MS, ids, scoresById: allScoresById }
    return ids
  }

  const realSalesById = new Map()
  const dbSalesClient = getProductsDbClient()
  if (dbSalesClient) {
    try {
      await dbSalesClient.connect()
      const res = await dbSalesClient.query(`
        SELECT oi.product_id, SUM(oi.quantity)::int AS total_sold
        FROM store_order_items oi JOIN store_orders o ON o.id = oi.order_id
        WHERE o.payment_status = 'bezahlt' AND oi.product_id IS NOT NULL AND oi.product_id <> ''
        GROUP BY oi.product_id
      `)
      for (const row of res.rows) {
        if (row.product_id && Number(row.total_sold) > 0) realSalesById.set(String(row.product_id).trim(), Number(row.total_sold))
      }
      await dbSalesClient.end()
    } catch (_) { try { await dbSalesClient.end() } catch (__) {} }
  }
  const metaClient = getProductsDbClient()
  const allScoresById = new Map(realSalesById)
  if (metaClient) {
    try {
      await metaClient.connect()
      const res = await metaClient.query('SELECT id, metadata FROM admin_hub_products WHERE metadata IS NOT NULL')
      for (const row of res.rows) {
        const metaScore = salesScoreFromMetadata(row.metadata)
        const pid = String(row.id).trim()
        const real = realSalesById.get(pid) || 0
        if (metaScore > 0 || real > 0) allScoresById.set(pid, Math.max(metaScore, real))
      }
      await metaClient.end()
    } catch (_) { try { await metaClient.end() } catch (__) {} }
  }
  const threshold = 1
  const ids = new Set([...allScoresById.entries()].filter(([, s]) => s >= threshold).map(([id]) => id))
  bestsellerCache = { expiresAt: now + BESTSELLER_CACHE_TTL_MS, ids, scoresById: allScoresById }
  bestsellerRedisCache.set('entries', [...allScoresById.entries()]).catch(() => {})
  return ids
}

/** Stamp listing/detail product with is_bestseller + sales_count from the shared cache. */
const applyBestsellerFlagsToMappedProduct = async (mapped, productId) => {
  if (!mapped || !productId) return mapped
  const pid = String(productId).trim()
  const bsIds = await getBestsellerProductIds()
  const score = bestsellerCache.scoresById?.get(pid) || 0
  const meta = { ...(mapped.metadata || {}) }
  if (score > 0) meta.sales_count = score
  if (bsIds.has(pid)) meta.is_bestseller = true
  mapped.metadata = meta
  return mapped
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

/** True if parent metadata.ean OR any variants[].ean equals target. */
const productHasEan = (p, targetEan) => {
  const want = normalizeStoreEan(targetEan)
  if (!p || !want) return false
  const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {}
  if (normalizeStoreEan(meta.ean) === want) return true
  for (const row of parseVariantsArray(p)) {
    if (normalizeStoreEan(row && row.ean) === want) return true
  }
  return false
}

/** All distinct sellable EANs on a product (parent + variants). */
const collectProductEans = (p) => {
  const out = []
  const seen = new Set()
  const add = (raw) => {
    const e = normalizeStoreEan(raw)
    if (!e || seen.has(e)) return
    seen.add(e)
    out.push(e)
  }
  if (!p) return out
  const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {}
  add(meta.ean)
  for (const row of parseVariantsArray(p)) add(row && row.ean)
  return out
}

/**
 * Whether a seller_listing applies to the given EAN.
 * - seller_metadata.covers_all → every EAN on the parent
 * - seller_metadata.ean → only that child EAN (seller joined via variant barcode)
 * - empty metadata on multi-EAN parents → treat as covers_all for backward compat of
 *   old full-product listings; new variant joins always write ean (see admin-products).
 */
const listingCoversEan = (listing, targetEan, productRow) => {
  const want = normalizeStoreEan(targetEan)
  if (!want) return false
  const sm = listing && listing.seller_metadata && typeof listing.seller_metadata === 'object'
    ? listing.seller_metadata
    : {}
  if (sm.covers_all === true) return true
  const listed = normalizeStoreEan(sm.ean || sm.listed_ean || '')
  if (listed) return listed === want
  const all = collectProductEans(productRow)
  if (all.length <= 1) return true
  // Legacy listing with no EAN scope on a multi-variant parent: pin to the
  // representative (first) EAN only so siblings don't inherit "Andere Verkäufer".
  // New joins always persist seller_metadata.ean for the exact child barcode.
  return extractEanFromHubProductRow(productRow) === want
}

const primaryPriceCentsHubProduct = (p) => {
  const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {}
  const prices = meta.prices && typeof meta.prices === 'object' ? meta.prices : {}
  const pick = prices.DE || prices.AT || prices.CH || Object.values(prices)[0]
  if (pick && typeof pick === 'object') {
    const sale = pick.sale_cents != null ? Number(pick.sale_cents) : null
    const brut = pick.brutto_cents != null ? Number(pick.brutto_cents) : null
    const c = sale != null && sale > 0 ? sale : brut
    if (c != null && c > 0) return Math.round(c)
  }
  for (const v of parseVariantsArray(p)) {
    if (v && v.price_cents != null && Number(v.price_cents) > 0) return Math.round(Number(v.price_cents))
  }
  if (p.price_cents != null && Number(p.price_cents) > 0) return Math.round(Number(p.price_cents))
  if (p.price != null && Number(p.price) > 0) return Math.round(Number(p.price) * 100)
  return 0
}

const totalInventoryHubProduct = (p) => {
  const vars = parseVariantsArray(p)
  if (vars.length) return vars.reduce((s, v) => s + (parseInt(v && v.inventory, 10) || 0), 0)
  return parseInt(p.inventory, 10) || 0
}

const computeBuyBoxScore = (priceCents, sellerAvg, sellerCount, inv) => {
  const p = Number(priceCents) || 0
  return (p > 0 ? 10000000 / p : 0) + (Number(sellerAvg) || 0) * 2500 + Math.log1p(Math.max(0, Number(sellerCount) || 0)) * 200 + (inv > 0 ? 1200 : -8000)
}

const loadSellerReviewStatsBatch = async (sellerIds) => {
  const ids = [...new Set((sellerIds || []).map((s) => String(s || '').trim()).filter(Boolean))]
  if (!ids.length) return new Map()
  let client
  try {
    client = getDbClient()
    if (!client) return new Map()
    await client.connect()
    const r = await client.query(
      `SELECT seller_id, ROUND(AVG(rating)::numeric, 2)::float AS avg, COUNT(*)::int AS cnt FROM store_product_reviews WHERE seller_id = ANY($1::text[]) GROUP BY seller_id`,
      [ids]
    )
    await client.end()
    const m = new Map()
    for (const row of r.rows || []) m.set(String(row.seller_id).trim(), { avg: parseFloat(row.avg || 0), count: row.cnt || 0 })
    for (const id of ids) { if (!m.has(id)) m.set(id, { avg: 0, count: 0 }) }
    return m
  } catch (_) {
    try { if (client) await client.end() } catch (__) {}
    return new Map()
  }
}

const findEanOffersFromHub = async (canonicalEan, approvedSellerIds, preloadedList = null) => {
  const ean = normalizeStoreEan(canonicalEan)
  if (!ean) return []
  let list = preloadedList
  if (!list) {
    list = await listAdminHubProductsDb({ limit: 5000 })
    list = list.filter((row) => isStorePublishedStatus(row.status) && isStoreVisibleSellerProduct(row, approvedSellerIds))
  }
  // Match any product that carries this EAN on parent OR a variant — not only the
  // "first representative" EAN (extractEanFromHubProductRow), which hid sibling EANs.
  const matchingRows = list.filter((row) => productHasEan(row, ean))
  const legacyOffers = matchingRows.filter((row) => row.seller_id)
  const masterRow = matchingRows.find((row) => !row.seller_id) || null
  const allEanPublishedRows = masterRow ? [masterRow, ...legacyOffers] : legacyOffers
  let listingOffers = []
  const productIdsForListings = [...new Set(allEanPublishedRows.map((r) => String(r.id)))]
  if (productIdsForListings.length > 0) {
    const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
    if (dbUrl && dbUrl.startsWith('postgres')) {
      try {
        const lc = require('../db-pool').getPooledClient()
        await lc.connect()
        const lr = await lc.query(
          `SELECT seller_id, price_cents, inventory, status, orders_count, product_id::text AS product_id, seller_metadata
           FROM admin_hub_seller_listings WHERE product_id = ANY($1::uuid[]) AND status = 'active'`,
          [productIdsForListings]
        )
        await lc.end()
        const productById = new Map(allEanPublishedRows.map((r) => [String(r.id), r]))
        listingOffers = (lr.rows || [])
          .filter((l) => !approvedSellerIds || approvedSellerIds.size === 0 || approvedSellerIds.has(l.seller_id))
          .filter((l) => {
            const baseRow = productById.get(String(l.product_id)) || masterRow || legacyOffers[0]
            return listingCoversEan(l, ean, baseRow)
          })
          .map((l) => {
            const baseRow = productById.get(String(l.product_id)) || masterRow || legacyOffers[0]
            return { ...baseRow, id: String(l.product_id) + '-listing-' + l.seller_id, _listing_id: String(l.product_id), seller_id: l.seller_id, price_cents: l.price_cents, inventory: l.inventory, _orders_count: l.orders_count, _listing_ean: normalizeStoreEan(l.seller_metadata?.ean) || ean }
          })
      } catch (_) {}
    }
  }
  const sellersCoveredByListings = new Set(listingOffers.map((o) => o.seller_id))
  return [...listingOffers, ...legacyOffers.filter((o) => !sellersCoveredByListings.has(o.seller_id))]
}

const scoreEanOffers = async (offers) => {
  if (!offers.length) return []
  const sellerKeys = offers.map((p) => String(p.seller_id || 'default').trim() || 'default')
  const statsMap = await loadSellerReviewStatsBatch(sellerKeys)
  const scored = offers.map((p) => {
    const sid = String(p.seller_id || 'default').trim() || 'default'
    const st = statsMap.get(sid) || { avg: 0, count: 0 }
    const price = primaryPriceCentsHubProduct(p)
    const inv = totalInventoryHubProduct(p)
    return { p, score: computeBuyBoxScore(price, st.avg, st.count, inv), price, inv, stats: st, sid }
  })
  scored.sort((a, b) => {
    const diff = b.score - a.score
    return diff !== 0 ? diff : new Date(a.p.created_at || 0) - new Date(b.p.created_at || 0)
  })
  return scored
}

const mapOtherSellersFromScored = (scored, storeNames) =>
  scored.slice(1).map(({ p, price, stats, sid }) => {
    const realProductId = p._listing_id || String(p.id)
    const masterP = p._listing_id ? (scored.find((x) => String(x.p.id) === p._listing_id)?.p || p) : p
    const m = masterP.metadata && typeof masterP.metadata === 'object' ? masterP.metadata : {}
    const rawMediaList = Array.isArray(m.media) ? m.media : (typeof m.media === 'string' && m.media ? [m.media] : [])
    const thumb = resolveUploadUrl((typeof rawMediaList[0] === 'string' ? rawMediaList[0] : (rawMediaList[0] && rawMediaList[0].url) || null) || m.thumbnail || null)
    return {
      product_id: realProductId,
      handle: masterP.handle || p.handle,
      title: masterP.title || p.title || '',
      seller_id: sid,
      store_name: storeNames[sid] || sid,
      price_cents: price,
      seller_review_avg: stats.avg,
      seller_review_count: stats.count,
      in_stock: (p.inventory != null ? p.inventory : totalInventoryHubProduct(p)) > 0,
      thumbnail: thumb || null,
      ean: p._listing_ean || null,
    }
  })

const mapAdminHubToStoreProduct = (p, marketCountry = 'DE') => {
  const meta = p.metadata && typeof p.metadata === 'object' ? p.metadata : {}
  const media = meta.media
  // "Own" media = this product row's own fields. When the row has variants, this row is
  // purely the umbrella/parent record grouping them — its own image is only a last-resort
  // fallback (below, once variants[] is built) for when the display variant has no image
  // of its own, never the first thing shown for a variant product.
  const ownRawMediaList = Array.isArray(media) ? media : (typeof media === 'string' && media ? [media] : [])
  if (ownRawMediaList.length === 0 && (meta.image_url || meta.image)) ownRawMediaList.push(meta.image_url || meta.image)
  const country = String(marketCountry || 'DE').toUpperCase()
  const parentPriceByCountry = (meta.prices && typeof meta.prices === 'object')
    ? (meta.prices[country] || meta.prices.DE || null)
    : null
  const priceCents = parentPriceByCountry && parentPriceByCountry.brutto_cents != null
    ? Number(parentPriceByCountry.brutto_cents)
    : (p.price != null ? Math.round(Number(p.price) * 100) : 0)
  const rawVariants = parseVariantsArray(p)
  const variationGroups = Array.isArray(meta.variation_groups) ? meta.variation_groups : null
  const variants = rawVariants.length > 0
    ? rawVariants.map((v, i) => {
        const vMeta = v.metadata && typeof v.metadata === 'object' ? v.metadata : {}
        const vPriceByCountry = (vMeta.prices && typeof vMeta.prices === 'object')
          ? (vMeta.prices[country] || vMeta.prices.DE || null)
          : null
        const vPriceCents = vPriceByCountry && vPriceByCountry.brutto_cents != null
          ? Number(vPriceByCountry.brutto_cents)
          : (v.price_cents != null ? Number(v.price_cents) : (v.price != null ? Math.round(Number(v.price) * 100) : priceCents))
        const vCompareCents = vPriceByCountry && vPriceByCountry.uvp_cents != null
          ? Number(vPriceByCountry.uvp_cents)
          : (v.compare_at_price_cents != null ? Number(v.compare_at_price_cents) : null)
        const optionValues = Array.isArray(v.option_values) ? v.option_values : (v.value != null ? [v.value] : null)
        let image_urls = null
        if (v.image_urls && typeof v.image_urls === 'object' && !Array.isArray(v.image_urls)) {
          const m = {}
          for (const [k, u] of Object.entries(v.image_urls)) {
            const rk = (k || '').toString().toLowerCase().trim()
            if (!rk) continue
            const resolved = resolveUploadUrl(u || null)
            if (resolved) m[rk] = resolved
          }
          if (Object.keys(m).length > 0) image_urls = m
        }
        const rawVMedia = Array.isArray(vMeta.media)
          ? vMeta.media
          : (Array.isArray(v.media) ? v.media : (Array.isArray(v.images) ? v.images : []))
        const vImages = rawVMedia.map((u) => resolveUploadUrl(u)).filter(Boolean)
        // Prefer explicit cover image first when gallery media is empty.
        const coverUrl = resolveUploadUrl(v.image_url || v.image || null)
        if (coverUrl && !vImages.includes(coverUrl)) vImages.unshift(coverUrl)
        // Locale override map: if gallery still empty, use first available locale cover.
        if (!vImages.length && image_urls) {
          const preferred = image_urls.de || image_urls.en || Object.values(image_urls).find(Boolean)
          if (preferred) vImages.push(preferred)
        }
        const translations = vMeta.translations && typeof vMeta.translations === 'object'
          ? Object.fromEntries(
              Object.entries(vMeta.translations).map(([loc, tr]) => {
                const trOut = { ...(tr && typeof tr === 'object' ? tr : {}) }
                if (Array.isArray(tr.media)) trOut.media = tr.media.map((u) => resolveUploadUrl(u)).filter(Boolean)
                return [loc, trOut]
              })
            )
          : undefined
        const optionLabels = variationGroups && variationGroups[i] ? variationGroups[i].labels || null : null
        return {
          id: v.id || `${p.id}-variant-${i}`,
          title: v.title || v.label
            || (vMeta.translations && vMeta.translations.de && vMeta.translations.de.title)
            || (optionValues && optionValues.length > 0 ? optionValues.join(' / ') : v.value)
            || `Option ${i + 1}`,
          sku: v.sku || null,
          ean: v.ean || null,
          price_cents: vPriceCents,
          compare_at_price_cents: vCompareCents,
          inventory_quantity: parseInt(v.inventory, 10) || 0,
          option_values: optionValues,
          option_labels: optionLabels,
          image_url: coverUrl || null,
          swatch_image_url: resolveUploadUrl(v.swatch_image_url || v.swatch_image || null) || null,
          image_urls,
          images: vImages,
          weight: v.weight || vMeta.weight || null,
          metadata: { ...(vMeta || {}), ...(translations ? { translations } : {}) },
        }
      })
    : []
  const compareCents = parentPriceByCountry && parentPriceByCountry.uvp_cents != null
    ? Number(parentPriceByCountry.uvp_cents)
    : null
  // Display resolution: a product WITH variants is purely an umbrella row grouping its
  // children — the card/listing must show the first variant's own image, never the
  // umbrella row's own metadata.media. The row's own image is kept only as a last-resort
  // fallback for when that first variant itself has no image of its own.
  // Price/compare-price are deliberately NOT swapped to the variant here: this row's
  // top-level price_cents/price is read by non-display consumers (isDiscountedProduct's
  // legacy metadata.rabattpreis_cents comparison, price-range sorting, structured data)
  // that expect it to stay the family's canonical price. The frontend (ProductCard /
  // ProductTemplate) already resolves the variant's own price independently via
  // variant.metadata.prices, so no product-family consumer needs this field to change.
  const firstVariant = variants[0] || null
  const ownThumb = resolveUploadUrl(ownRawMediaList[0] || null)
  const ownImagesResolved = ownRawMediaList.map((m) => resolveUploadUrl(typeof m === 'string' ? m : (m && m.url) || null)).filter(Boolean)
  const variantImagesResolved = firstVariant
    ? (firstVariant.images && firstVariant.images.length > 0 ? firstVariant.images : (firstVariant.image_url ? [firstVariant.image_url] : []))
    : []
  let thumb = variantImagesResolved[0] || ownThumb || null
  let imagesResolved = variantImagesResolved.length > 0 ? variantImagesResolved : ownImagesResolved
  if (!thumb || imagesResolved.length === 0) {
    const trMap = meta.translations && typeof meta.translations === 'object' ? meta.translations : {}
    const fallbackMedia = []
    for (const loc of ['de', 'en', 'tr', 'fr', 'es', 'it']) {
      const list = Array.isArray(trMap[loc]?.media) ? trMap[loc].media : []
      for (const item of list) {
        const resolved = resolveUploadUrl(typeof item === 'string' ? item : (item && item.url) || null)
        if (resolved && !fallbackMedia.includes(resolved)) fallbackMedia.push(resolved)
      }
    }
    if (!thumb && fallbackMedia[0]) thumb = fallbackMedia[0]
    if (imagesResolved.length === 0 && fallbackMedia.length) imagesResolved = fallbackMedia
  }
  const metaTranslations = meta.translations && typeof meta.translations === 'object'
    ? Object.fromEntries(
        Object.entries(meta.translations).map(([loc, tr]) => {
          const trOut = { ...(tr && typeof tr === 'object' ? tr : {}) }
          if (Array.isArray(tr && tr.media)) trOut.media = tr.media.map((u) => resolveUploadUrl(u)).filter(Boolean)
          delete trOut._auto
          return [loc, trOut]
        })
      )
    : undefined
  const variantOptionKeys = variationGroups
    ? variationGroups.map((g) => g?.key || g?.option_key || null).filter(Boolean)
    : null
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    slug: p.handle,
    description: p.description,
    sku: p.sku || null,
    ean: extractEanFromHubProductRow(p) || null,
    status: p.status,
    seller_id: p.seller_id || null,
    collection_id: p.collection_id || null,
    thumbnail: thumb || null,
    images: imagesResolved,
    price_cents: priceCents,
    compare_at_price_cents: compareCents,
    price: priceCents > 0 ? priceCents / 100 : 0,
    inventory_quantity: parseInt(p.inventory, 10) || (variants.reduce((s, v) => s + (v.inventory_quantity || 0), 0)),
    variants,
    variant_option_keys: variantOptionKeys,
    variation_groups: variationGroups,
    metadata: { ...meta, ...(metaTranslations ? { translations: metaTranslations } : {}), thumbnail: thumb || meta.thumbnail || null, images: imagesResolved },
    created_at: p.created_at,
    updated_at: p.updated_at,
  }
}

const collectCategorySubtreeIdsBySlug = (tree, slug) => {
  const norm = (s) => String(s || '').replace(/^\//, '').toLowerCase().trim()
  const target = norm(slug)
  const findNode = (nodes) => {
    for (const n of nodes || []) {
      if (!n) continue
      if (norm(n.slug) === target || norm(n.handle) === target) return n
      const x = findNode(n.children)
      if (x) return x
    }
    return null
  }
  const ids = new Set()
  const addTree = (n) => {
    if (!n || n.id == null) return
    ids.add(String(n.id).trim().toLowerCase())
    for (const c of n.children || []) addTree(c)
  }
  const node = findNode(Array.isArray(tree) ? tree : [])
  if (!node) return null
  addTree(node)
  return ids
}

const storeProductCategoryIds = (p) => {
  const meta = p?.metadata && typeof p.metadata === 'object' ? p.metadata : {}
  const out = []
  const push = (x) => { if (x == null) return; const s = String(x).trim().toLowerCase(); if (s) out.push(s) }
  push(meta.admin_category_id)
  push(meta.category_id)
  if (Array.isArray(meta.category_ids)) {
    meta.category_ids.forEach(push)
  } else if (typeof meta.category_ids === 'string' && meta.category_ids.trim().startsWith('[')) {
    try { const parsed = JSON.parse(meta.category_ids); if (Array.isArray(parsed)) parsed.forEach(push) } catch (_) {}
  }
  if (Array.isArray(p?.categories)) p.categories.forEach((c) => push(c?.id))
  return out
}

// ── Product Badges (superuser-managed text badges: Sale, Bestseller, etc.) ────

let categoryTopSellerCache = { expiresAt: 0, topIdSet: new Set() }
const categoryTopSellerRedisCache = createTieredCache('category-top-seller', BESTSELLER_CACHE_TTL_MS / 1000)

const {
  getActiveProductBadges: getActiveProductBadgesCached,
} = require('../product-badges-cache')

const getActiveProductBadges = () => getActiveProductBadgesCached(getDbClient)

/** No admin category-picker needed — the single top-selling product within EACH of its own
 * categories, catalog-wide. Backs the "bestseller_category" Product Badge rule: one active
 * rule, and every category's own #1 seller gets the badge (not top-5, no per-category rule
 * duplication). */
const getCategoryTopSellerIds = async () => {
  const now = Date.now()
  if (categoryTopSellerCache.expiresAt > now) return categoryTopSellerCache.topIdSet

  const sharedIds = await categoryTopSellerRedisCache.get('ids')
  if (Array.isArray(sharedIds)) {
    const topIdSet = new Set(sharedIds)
    categoryTopSellerCache = { expiresAt: now + BESTSELLER_CACHE_TTL_MS, topIdSet }
    return topIdSet
  }

  await getBestsellerProductIds() // ensures bestsellerCache.scoresById is populated/fresh
  const scoresById = bestsellerCache.scoresById || new Map()
  const bestByCategory = new Map() // categoryId -> [productId, score]
  const client = getProductsDbClient()
  if (client) {
    try {
      await client.connect()
      const res = await client.query('SELECT id, metadata FROM admin_hub_products WHERE metadata IS NOT NULL')
      for (const row of res.rows) {
        const pid = String(row.id).trim()
        const score = scoresById.get(pid) || 0
        if (score <= 0) continue
        const catIds = storeProductCategoryIds({ metadata: row.metadata })
        for (const catId of catIds) {
          const key = String(catId).toLowerCase()
          const cur = bestByCategory.get(key)
          if (!cur || score > cur[1]) bestByCategory.set(key, [pid, score])
        }
      }
      await client.end()
    } catch (_) { try { await client.end() } catch (__) {} }
  }
  const topIdSet = new Set([...bestByCategory.values()].map(([pid]) => pid))
  categoryTopSellerCache = { expiresAt: now + BESTSELLER_CACHE_TTL_MS, topIdSet }
  categoryTopSellerRedisCache.set('ids', [...topIdSet]).catch(() => {})
  return topIdSet
}

const getGroupProductIdSets = async (groupIds) => {
  const map = new Map()
  const ids = [...new Set((groupIds || []).filter(Boolean).map(String))]
  if (ids.length === 0) return map
  const client = getDbClient()
  if (!client) return map
  try {
    await client.connect()
    const r = await client.query('SELECT id, product_ids FROM seller_product_groups WHERE id = ANY($1::uuid[])', [ids])
    for (const row of r.rows || []) {
      const pids = Array.isArray(row.product_ids) ? row.product_ids.map((x) => String(x)) : []
      map.set(String(row.id), new Set(pids))
    }
    await client.end()
  } catch (_) { try { await client.end() } catch (__) {} }
  return map
}

const hasSaleFromMapped = (mapped) => {
  const meta = mapped?.metadata || {}
  const prices = meta.prices && typeof meta.prices === 'object' ? meta.prices : {}
  for (const entry of Object.values(prices)) {
    if (!entry || typeof entry !== 'object') continue
    const base = entry.brutto_cents != null ? Number(entry.brutto_cents) : null
    const sale = entry.sale_cents != null ? Number(entry.sale_cents) : null
    if (Number.isFinite(base) && Number.isFinite(sale) && sale > 0 && sale < base) return true
  }
  const priceCents = Number(mapped?.price_cents || 0)
  const legacySale = meta.rabattpreis_cents != null ? Number(meta.rabattpreis_cents) : null
  if (legacySale != null && Number.isFinite(legacySale) && legacySale > 0) {
    if (!(priceCents > 0) || legacySale < priceCents) return true
  }
  const deSale = meta.prices?.DE?.sale_cents != null ? Number(meta.prices.DE.sale_cents) : null
  const deBase = meta.prices?.DE?.brutto_cents != null ? Number(meta.prices.DE.brutto_cents) : priceCents
  return deSale != null && deSale > 0 && Number.isFinite(deBase) && deSale < deBase
}

// "Neu" is active for this many days after a product's publish date (falls back to its
// creation date) — algorithmic only, kept in sync with apps/shop/src/lib/bestseller.js's
// NEW_BADGE_WINDOW_DAYS. No manual metadata.badge override anymore.
const NEW_BADGE_WINDOW_DAYS = 15

const isNewFromMapped = (mapped) => {
  const meta = mapped?.metadata || {}
  if (meta.is_new === true || meta.is_new === 'true') return true
  const raw = meta.publish_date || mapped?.created_at
  if (!raw) return false
  const d = new Date(raw)
  if (Number.isNaN(d.getTime())) return false
  const ageMs = Date.now() - d.getTime()
  return ageMs >= 0 && ageMs <= NEW_BADGE_WINDOW_DAYS * 24 * 60 * 60 * 1000
}

const buildProductBadgeContext = async () => {
  const badges = await getActiveProductBadges()
  const groupIds = badges.filter((b) => b.target_type === 'group' && b.group_id).map((b) => b.group_id)
  const groupProductIdsByGroup = await getGroupProductIdSets(groupIds)
  const needsCategoryTopSellers = badges.some((b) => b.target_type === 'api' && b.api_rule === 'bestseller_category')
  const categoryTopSellerIds = needsCategoryTopSellers ? await getCategoryTopSellerIds() : new Set()
  return { badges, groupProductIdsByGroup, categoryTopSellerIds }
}

const badgeToPayload = (b) => ({
  id: b.id,
  label: b.label,
  position: b.position,
  bg_color: b.bg_color,
  text_color: b.text_color,
  font_size: b.font_size,
  border_width: b.border_width,
  border_color: b.border_color,
  border_radius: b.border_radius,
  offset_x: b.offset_x,
  offset_y: b.offset_y,
  badge_type: b.badge_type,
  image_url: b.image_url,
  image_width: b.image_width,
  image_height: b.image_height,
  i18n: b.i18n,
})

/** Real catalog UUID — seller listing rows use synthetic ids like `{uuid}-listing-{seller}`. */
const canonicalProductId = (productRowOrId) => {
  if (productRowOrId == null) return ''
  if (typeof productRowOrId === 'object') {
    const listing = productRowOrId._listing_id != null ? String(productRowOrId._listing_id).trim() : ''
    if (listing) return listing
    const raw = String(productRowOrId.id || '').trim()
    const m = raw.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-listing-/i)
    return m ? m[1] : raw
  }
  const raw = String(productRowOrId).trim()
  const m = raw.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-listing-/i)
  return m ? m[1] : raw
}

const resolveCustomBadgesForProduct = (productIdOrIds, mapped, ctx) => {
  const ids = [...new Set(
    (Array.isArray(productIdOrIds) ? productIdOrIds : [productIdOrIds])
      .flatMap((x) => {
        const raw = String(x || '').trim()
        const canon = canonicalProductId(x)
        return [raw, canon].filter(Boolean)
      })
  )]
  if (ids.length === 0) return mapped
  const matched = []
  const seen = new Set()
  for (const b of ctx.badges) {
    let hit = false
    if (b.target_type === 'product') {
      hit = ids.some((pid) => String(b.product_id) === pid)
    } else if (b.target_type === 'group') {
      const set = ctx.groupProductIdsByGroup.get(String(b.group_id))
      hit = !!set && ids.some((pid) => set.has(pid))
    } else if (b.target_type === 'api') {
      if (b.api_rule === 'bestseller_category') hit = ids.some((pid) => ctx.categoryTopSellerIds.has(pid))
      else if (b.api_rule === 'sale') hit = hasSaleFromMapped(mapped)
      else if (b.api_rule === 'new') hit = isNewFromMapped(mapped)
      else if (b.api_rule === 'made_in_europe') hit = isEuOriginVerified(mapped?.metadata)
    }
    if (!hit) continue
    const key = String(b.id || `${b.label}-${b.position}-${b.api_rule || b.target_type}`)
    if (seen.has(key)) continue
    seen.add(key)
    matched.push(badgeToPayload(b))
  }
  if (matched.length > 0) mapped.metadata = { ...(mapped.metadata || {}), custom_badges: matched }
  return mapped
}

const enrichMappedStoreProduct = async (productRow, mapped, { alsoMatchIds = [] } = {}) => {
  const existingSeller = (mapped.metadata && (mapped.metadata.seller_name || mapped.metadata.shop_name)) || ''
  if (!existingSeller && productRow.seller_id) {
    const storeName = await getSellerStoreName(productRow.seller_id)
    if (storeName) mapped.metadata = { ...(mapped.metadata || {}), seller_name: storeName, shop_name: storeName }
  }
  const metaIn = mapped.metadata && typeof mapped.metadata === 'object' ? mapped.metadata : {}
  const categoryId = (metaIn.admin_category_id || metaIn.category_id || '').toString().trim()
  if (categoryId) {
    const category = await getCategoryById(categoryId)
    if (category && category.slug) {
      mapped.metadata = { ...(mapped.metadata || {}), admin_category_id: category.id, category_id: category.id, category_slug: String(category.slug).replace(/^\//, ''), category_name: category.name || metaIn.category_name || null }
    }
  }
  const brandId = mapped.metadata && mapped.metadata.brand_id
  if (brandId) {
    const brand = await getBrandById(brandId)
    if (brand) mapped.metadata = { ...(mapped.metadata || {}), brand_name: brand.name, brand_logo: brand.logo_image || null, brand_handle: brand.handle || null }
  }
  const realId = canonicalProductId(productRow)
  const matchIds = [...new Set([
    productRow.id,
    productRow._listing_id,
    realId,
    ...alsoMatchIds,
  ].map((x) => String(x || '').trim()).filter(Boolean))]
  const bsIds = await getBestsellerProductIds()
  const realSalesScore = matchIds.reduce((best, id) => {
    const s = bestsellerCache.scoresById?.get(String(id).trim()) || 0
    return s > best ? s : best
  }, 0)
  if (realSalesScore > 0) mapped.metadata = { ...(mapped.metadata || {}), sales_count: realSalesScore }
  if (matchIds.some((id) => bsIds.has(String(id)))) mapped.metadata = { ...(mapped.metadata || {}), is_bestseller: true }
  const badgeCtx = await buildProductBadgeContext()
  resolveCustomBadgesForProduct(matchIds, mapped, badgeCtx)
  const sid = String(productRow.seller_id || '').trim()
  if (sid) {
    let client
    try {
      client = getDbClient()
      if (client) {
        await client.connect()
        const sr = await client.query('SELECT review_avg, review_count FROM admin_hub_seller_settings WHERE seller_id = $1', [sid])
        await client.end()
        const row = sr.rows && sr.rows[0]
        if (row && (Number(row.review_count) > 0 || row.review_avg != null)) {
          mapped.metadata = { ...(mapped.metadata || {}), seller_review_avg: row.review_avg != null ? parseFloat(row.review_avg) : null, seller_review_count: row.review_count != null ? Number(row.review_count) : 0 }
        }
      }
    } catch (_) { try { if (client) await client.end() } catch (__) {} }
  }
  return mapped
}

// ── Handlers ──────────────────────────────────────────────────────────────────

const storeProductsFromAdminHubGET = async (req, res) => {
  try {
    const query = req.query || {}
    const searchQ = (query.q || '').toString().trim().toLowerCase()
    const limitForSearch = searchQ ? 8 : (parseInt(query.limit, 10) || 100)
    const categorySlugFilter = (query.category || query.category_slug || '').toString().trim()
    let allowedCategoryIds = null
    // "all" is a reserved slug meaning no category filter — return every product
    if (categorySlugFilter && categorySlugFilter.toLowerCase() !== 'all') {
      const subtreeIdsForSlug = (tree) => collectCategorySubtreeIdsBySlug(tree, categorySlugFilter)
      const ah = resolveAdminHub()
      if (ah) {
        try { allowedCategoryIds = subtreeIdsForSlug(await ah.getCategoryTree({ is_visible: true })) } catch (_) { allowedCategoryIds = null }
      }
      if (!allowedCategoryIds || allowedCategoryIds.size === 0) {
        let fbClient
        try {
          fbClient = getProductsDbClient()
          if (fbClient) {
            await fbClient.connect()
            const cr = await fbClient.query(`SELECT * FROM admin_hub_categories WHERE active = true ORDER BY sort_order ASC, name ASC`)
            await fbClient.end()
            fbClient = null
            const flat = (cr.rows || []).map(mapAdminHubCategoryPgRow).filter((c) => c && c.is_visible !== false)
            allowedCategoryIds = subtreeIdsForSlug(buildAdminHubCategoryTreeFromFlat(flat))
          }
        } catch (__) { try { if (fbClient) await fbClient.end() } catch (___) {} }
      }
    }
    let collectionId = (query.collection_id || '').toString().trim()
    const collectionHandle = (query.collection_handle || query.collection || '').toString().trim()
    if (collectionId && !isUuidLike(collectionId)) {
      const resolvedId = await getAdminHubCollectionIdByHandle(collectionId)
      if (resolvedId) collectionId = resolvedId
    }
    if (!collectionId && collectionHandle) {
      const resolvedId = await getAdminHubCollectionIdByHandle(collectionHandle)
      if (resolvedId) collectionId = resolvedId
    }
    const queryWithId = collectionId ? { ...query, collection_id: collectionId } : query
    const categoryIdAllowlist = allowedCategoryIds && allowedCategoryIds.size > 0 ? [...allowedCategoryIds] : undefined
    let list = await listAdminHubProductsDb({ ...queryWithId, limit: searchQ ? 200 : (categorySlugFilter ? Math.max(parseInt(query.limit, 10) || 3000, 500) : (query.limit || 100)), category: categorySlugFilter || undefined, category_id_allowlist: categoryIdAllowlist })
    if (collectionId) {
      const norm = (s) => (s || '').toString().trim().toLowerCase()
      const cidNorm = norm(collectionId)
      list = list.filter((p) => {
        const primaryMatch = norm(p.collection_id) === cidNorm
        const metaIds = Array.isArray(p?.metadata?.collection_ids) ? p.metadata.collection_ids.map((x) => norm(x)) : []
        return primaryMatch || metaIds.includes(cidNorm)
      })
    }
    const approvedSellerIds = await getApprovedSellerIdsSet()
    list = list.filter((p) => isStorePublishedStatus(p.status) && isStoreVisibleSellerProduct(p, approvedSellerIds))
    if (searchQ) {
      list = list.filter((p) => {
        const t = (p.title || '').toLowerCase(), d = (p.description || '').toLowerCase()
        const h = (p.handle || '').toLowerCase(), sku = (p.sku || '').toLowerCase()
        const ean = (p.metadata?.ean != null ? String(p.metadata.ean) : '').toLowerCase()
        if (t.includes(searchQ) || d.includes(searchQ) || h.includes(searchQ) || sku.includes(searchQ) || ean.includes(searchQ)) return true
        return Array.isArray(p.variants) && p.variants.some((v) =>
          (v.sku || '').toLowerCase().includes(searchQ) || (v.ean != null ? String(v.ean) : '').toLowerCase().includes(searchQ)
        )
      }).slice(0, limitForSearch)
    }
    const sellerIds = [...new Set(list.map((p) => (p.seller_id || 'default').toString().trim() || 'default').filter(Boolean))]
    const storeNamesBySeller = {}
    await Promise.all(sellerIds.map(async (id) => { storeNamesBySeller[id] = await getSellerStoreName(id) }))
    const brandIds = [...new Set(list.map((p) => (p.metadata && p.metadata.brand_id) || null).filter(Boolean))]
    const brandsById = {}
    await Promise.all(brandIds.map(async (bid) => { const b = await getBrandById(bid); if (b) brandsById[bid] = b }))
    const collIds = [...new Set(list.flatMap((p) => {
      const ids = []
      if (p.collection_id) ids.push(String(p.collection_id).trim())
      const m = Array.isArray(p?.metadata?.collection_ids) ? p.metadata.collection_ids : []
      for (const x of m) { if (x != null && String(x).trim()) ids.push(String(x).trim()) }
      return ids
    }))].filter((id) => id && isUuidLike(id))
    const collToLinkedCat = new Map()
    if (collIds.length > 0) {
      const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      if (dbUrl && dbUrl.startsWith('postgres')) {
        let cClient
        try {
          cClient = require('../db-pool').getPooledClient()
          await cClient.connect()
          const cr = await cClient.query('SELECT id, metadata FROM admin_hub_collections WHERE id = ANY($1::uuid[])', [collIds])
          await cClient.end()
          cClient = null
          for (const row of cr.rows || []) {
            const cmeta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
            const lc = cmeta.linked_category_id != null ? String(cmeta.linked_category_id).trim() : ''
            if (lc) collToLinkedCat.set(String(row.id).trim().toLowerCase(), lc.trim().toLowerCase())
          }
        } catch (e) { try { if (cClient) await cClient.end() } catch (_) {}; console.warn('Store products: linked_category:', e?.message) }
      }
    }
    const mergeCategoryIdsFromCollections = (p, mapped) => {
      if (!collToLinkedCat.size) return
      const linked = []
      const addColl = (cid) => { if (!cid) return; const catId = collToLinkedCat.get(String(cid).trim().toLowerCase()); if (catId && !linked.includes(catId)) linked.push(catId) }
      if (p.collection_id) addColl(p.collection_id)
      if (Array.isArray(p?.metadata?.collection_ids)) for (const c of p.metadata.collection_ids) addColl(c)
      if (!linked.length) return
      const meta = { ...(mapped.metadata || {}) }
      const existingArr = Array.isArray(meta.category_ids) ? meta.category_ids.map((x) => String(x).trim().toLowerCase()) : []
      for (const catId of linked) { if (!existingArr.includes(catId)) existingArr.push(catId) }
      meta.category_ids = existingArr
      const primary = linked[0]
      if (!meta.admin_category_id) meta.admin_category_id = primary
      if (!meta.category_id) meta.category_id = primary
      mapped.metadata = meta
    }
    const badgeCtx = await buildProductBadgeContext()
    let products = []
    for (const p of list) {
      const mapped = mapAdminHubToStoreProduct(p, query.country || 'DE')
      mergeCategoryIdsFromCollections(p, mapped)
      const existingSeller = (mapped.metadata && (mapped.metadata.seller_name || mapped.metadata.shop_name)) || ''
      if (!existingSeller && p.seller_id && storeNamesBySeller[(p.seller_id || 'default').toString().trim()]) {
        const storeName = storeNamesBySeller[(p.seller_id || 'default').toString().trim()]
        mapped.metadata = { ...(mapped.metadata || {}), seller_name: storeName, shop_name: storeName }
      }
      const brandId = mapped.metadata && mapped.metadata.brand_id
      if (brandId && brandsById[brandId]) {
        const b = brandsById[brandId]
        mapped.metadata = { ...(mapped.metadata || {}), brand_name: b.name, brand_logo: b.logo_image || null, brand_handle: b.handle || null }
      }
      await applyBestsellerFlagsToMappedProduct(mapped, canonicalProductId(p) || p.id)
      resolveCustomBadgesForProduct([p.id, p._listing_id, canonicalProductId(p)], mapped, badgeCtx)
      products.push(mapped)
    }
    if (categorySlugFilter) {
      if (!allowedCategoryIds || allowedCategoryIds.size === 0) {
        products = []
      } else {
        products = products.filter((p) => { const ids = storeProductCategoryIds(p); return ids.some((id) => allowedCategoryIds.has(id)) })
      }
    }
    res.json({ products, count: products.length })
  } catch (err) {
    console.error('Store products GET (admin hub):', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

const storeProductByIdFromAdminHubGET = async (req, res) => {
  try {
    const idOrHandle = (req.params.idOrHandle || req.params.id || '').toString().trim()
    if (!idOrHandle) return res.status(400).json({ message: 'Product id or handle required' })
    const landed = await getAdminHubProductByIdOrHandleDb(idOrHandle)
    const approvedSellerIds = await getApprovedSellerIdsSet()
    if (!landed || !isStorePublishedStatus(landed.status) || !isStoreVisibleSellerProduct(landed, approvedSellerIds)) {
      return res.status(404).json({ message: 'Product not found' })
    }
    const productEans = collectProductEans(landed)
    const canonicalEan = extractEanFromHubProductRow(landed) || productEans[0] || ''
    let winnerRow = landed, multiOffer = null
    if (canonicalEan || productEans.length) {
      let publishedList = await listAdminHubProductsDb({ limit: 5000 })
      publishedList = publishedList.filter((row) => isStorePublishedStatus(row.status) && isStoreVisibleSellerProduct(row, approvedSellerIds))
      const eansToBuild = productEans.length ? productEans : (canonicalEan ? [canonicalEan] : [])
      const byEan = {}
      let primaryScored = null
      const allSellerIds = new Set()
      const offersByEan = {}
      for (const ean of eansToBuild) {
        const offers = await findEanOffersFromHub(ean, approvedSellerIds, publishedList)
        offersByEan[ean] = offers
        for (const o of offers) allSellerIds.add(String(o.seller_id || 'default').trim() || 'default')
      }
      const storeNames = {}
      await Promise.all([...allSellerIds].map(async (sid) => { storeNames[sid] = (await getSellerStoreName(sid)) || sid }))
      for (const ean of eansToBuild) {
        const scored = await scoreEanOffers(offersByEan[ean] || [])
        if (!scored.length) {
          byEan[ean] = { other_sellers: [], buy_box_product_id: null }
          continue
        }
        byEan[ean] = {
          other_sellers: mapOtherSellersFromScored(scored, storeNames),
          buy_box_product_id: String(scored[0].p._listing_id || scored[0].p.id),
        }
        if (ean === canonicalEan) primaryScored = scored
      }
      if (!primaryScored && eansToBuild[0]) primaryScored = await scoreEanOffers(offersByEan[eansToBuild[0]] || [])
      if (primaryScored && primaryScored.length) {
        winnerRow = primaryScored[0].p
        const reviewProductIds = [...new Set(
          eansToBuild.flatMap((ean) => (offersByEan[ean] || []).map((p) => String(p._listing_id || p.id)))
        )]
        const primaryEan = canonicalEan || eansToBuild[0]
        const primaryOther = (byEan[primaryEan] && byEan[primaryEan].other_sellers) || []
        const anyOther = primaryOther.length > 0 || Object.values(byEan).some((b) => (b.other_sellers || []).length > 0)
        if (anyOther || (offersByEan[primaryEan] || []).length > 1) {
          multiOffer = {
            canonical_ean: primaryEan,
            review_product_ids: reviewProductIds,
            landed_product_id: String(landed.id),
            buy_box_product_id: String(winnerRow._listing_id || winnerRow.id),
            other_sellers: primaryOther,
            // Per-variant EAN map so the shop can swap "Andere Verkäufer" when the
            // customer changes size/color without refetching the product.
            by_ean: byEan,
          }
        }
      }
    }
    if (winnerRow.collection_id) {
      const collection = await getAdminHubCollectionById(winnerRow.collection_id)
      if (collection) winnerRow.collection = collection
    }
    const mapped = mapAdminHubToStoreProduct(winnerRow, (req.query && req.query.country) || 'DE')
    await enrichMappedStoreProduct(winnerRow, mapped, {
      alsoMatchIds: [landed.id, winnerRow._listing_id, canonicalProductId(winnerRow), canonicalProductId(landed)],
    })
    res.json({ product: mapped, multi_offer: multiOffer })
  } catch (err) {
    console.error('Store product by id GET (admin hub):', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = function createStoreProductsRouter() {
  const router = Router()

  router.get('/store/products', storeProductsFromAdminHubGET)
  router.get('/store/products/:idOrHandle', storeProductByIdFromAdminHubGET)

  router.get('/store/brands', async (_req, res) => {
    const client = getBrandsDbClient()
    if (!client) return res.status(500).json({ message: 'Database unavailable' })
    try {
      await client.connect()
      // Only surface approved brands in the shop (docs/BRAND.md Faz 4).
      // NULL status = legacy brand (pre-migration) → treated as active.
      const r = await client.query(`SELECT id, name, handle, logo_image, banner_image, address, created_at FROM admin_hub_brands WHERE status IS NULL OR status = 'active' ORDER BY created_at DESC NULLS LAST, LOWER(name)`)
      await client.end()
      const brands = (r.rows || []).map((row) => {
        const rawHandle = (row.handle || '').trim()
        const handle = rawHandle || ('brand-' + String(row.id || '').replace(/-/g, '').slice(0, 12))
        return { id: row.id, name: row.name, handle, logo_image: row.logo_image || null, banner_image: row.banner_image || null, address: row.address || null, created_at: row.created_at || null }
      }).filter((b) => b && b.handle)
      res.json({ brands, count: brands.length })
    } catch (e) {
      try { await client.end() } catch (_) {}
      console.error('Store brands list GET:', e)
      res.status(500).json({ message: (e && e.message) || 'Internal server error' })
    }
  })

  router.get('/store/brands/:handle', async (req, res) => {
    const handle = (req.params.handle || '').trim().toLowerCase()
    if (!handle) return res.status(400).json({ message: 'handle required' })
    const client = getBrandsDbClient()
    if (!client) return res.status(500).json({ message: 'Database unavailable' })
    try {
      await client.connect()
      const br = await client.query(
        `SELECT id, name, handle, logo_image, banner_image, address FROM admin_hub_brands WHERE LOWER(TRIM(COALESCE(handle,''))) = $1 OR id::text = $1 LIMIT 1`,
        [handle]
      )
      const brand = br.rows && br.rows[0]
      if (!brand) { await client.end(); return res.status(404).json({ message: 'Brand not found' }) }
      await client.end()
      const approvedSellerIds = await getApprovedSellerIdsSet()
      let list = await listAdminHubProductsDb({ limit: 3000 })
      list = list.filter((p) => isStorePublishedStatus(p.status) && isStoreVisibleSellerProduct(p, approvedSellerIds) && (p.metadata && p.metadata.brand_id) === brand.id)
      const sellerIds = [...new Set(list.map((p) => (p.seller_id || 'default').toString().trim() || 'default').filter(Boolean))]
      const storeNamesBySeller = {}
      await Promise.all(sellerIds.map(async (id) => { storeNamesBySeller[id] = await getSellerStoreName(id) }))
      const badgeCtx = await buildProductBadgeContext()
      const products = []
      for (const p of list) {
        const mapped = mapAdminHubToStoreProduct(p, (req.query && req.query.country) || 'DE')
        const existingSeller = (mapped.metadata && (mapped.metadata.seller_name || mapped.metadata.shop_name)) || ''
        if (!existingSeller && p.seller_id && storeNamesBySeller[(p.seller_id || 'default').toString().trim()]) {
          const storeName = storeNamesBySeller[(p.seller_id || 'default').toString().trim()]
          mapped.metadata = { ...(mapped.metadata || {}), seller_name: storeName, shop_name: storeName }
        }
        mapped.metadata = { ...(mapped.metadata || {}), brand_name: brand.name, brand_logo: brand.logo_image || null, brand_handle: brand.handle || null }
        await applyBestsellerFlagsToMappedProduct(mapped, canonicalProductId(p) || p.id)
        resolveCustomBadgesForProduct([p.id, p._listing_id, canonicalProductId(p)], mapped, badgeCtx)
        products.push(mapped)
      }
      res.json({ brand, products, count: products.length })
    } catch (e) {
      console.error('Store brands GET:', e)
      res.status(500).json({ message: (e && e.message) || 'Internal server error' })
    }
  })

  return router
}

module.exports.mapAdminHubToStoreProduct = mapAdminHubToStoreProduct
module.exports.resolveUploadUrl = resolveUploadUrl
module.exports.extractEanFromHubProductRow = extractEanFromHubProductRow
module.exports.normalizeStoreEan = normalizeStoreEan
module.exports.parseVariantsArray = parseVariantsArray
module.exports.getBestsellerProductIds = getBestsellerProductIds
module.exports.applyBestsellerFlagsToMappedProduct = applyBestsellerFlagsToMappedProduct
module.exports.buildProductBadgeContext = buildProductBadgeContext
module.exports.resolveCustomBadgesForProduct = resolveCustomBadgesForProduct
module.exports.canonicalProductId = canonicalProductId
module.exports.isUuidLike = isUuidLike
module.exports.getAdminHubCollectionIdByHandle = getAdminHubCollectionIdByHandle
module.exports.storeProductCategoryIds = storeProductCategoryIds
