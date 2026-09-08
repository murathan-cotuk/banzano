'use strict'

/**
 * Storefront category tree: slim payload + accurate has_products.
 *
 * The old path loaded every TypeORM column (including long_content) for 10k+
 * categories, then fetched up to 10k full product objects just to mark which
 * categories have shop-visible products. That produced multi-MB JSON, OOM
 * crashes, and a shop menu that fell back to a single CMS item with no image.
 */

const { mapAdminHubCategoryPgRow, buildAdminHubCategoryTreeFromFlat } = require('./categories-helpers')

function unwrapCategoryImageValue(raw, depth = 0) {
  if (raw == null || raw === '' || depth > 4) return ''
  if (Array.isArray(raw)) return unwrapCategoryImageValue(raw[0], depth + 1)
  if (typeof raw === 'object') {
    return unwrapCategoryImageValue(raw.url || raw.src || raw.path || '', depth + 1)
  }
  const s = String(raw).trim()
  if (!s || s === '[object Object]') return ''
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed) && parsed[0]) return unwrapCategoryImageValue(parsed[0], depth + 1)
    } catch (_) {}
  }
  return s
}

function pickCategoryImageRaw(node) {
  if (!node) return ''
  const meta = node.metadata && typeof node.metadata === 'object' ? node.metadata : {}
  const candidates = [
    node.image_url,
    meta.image_url,
    meta.imageUrl,
    node.banner_image_url,
    meta.banner_image_url,
  ]
  for (const c of candidates) {
    const parsed = unwrapCategoryImageValue(c)
    if (parsed) return parsed
  }
  return ''
}

function productCoverFromMetadata(meta) {
  if (!meta || typeof meta !== 'object') return ''
  const fromThumb = unwrapCategoryImageValue(meta.thumbnail)
  if (fromThumb) return fromThumb
  const media = meta.media
  if (Array.isArray(media) && media[0]) {
    const m = media[0]
    const url = typeof m === 'string' ? m : unwrapCategoryImageValue(m)
    if (url) return url
  } else if (typeof media === 'string') {
    const url = unwrapCategoryImageValue(media)
    if (url) return url
  }
  return unwrapCategoryImageValue(meta.image_url || meta.image)
}

function pushCategoryId(ids, value) {
  if (value == null) return
  const s = String(value).trim().toLowerCase()
  if (s) ids.add(s)
}

function collectRefsFromProductMetadata(meta, ids, slugs, thumbsByCatId) {
  const m = meta && typeof meta === 'object' ? meta : {}
  const cover = productCoverFromMetadata(m)
  const localIds = new Set()
  pushCategoryId(localIds, m.admin_category_id)
  pushCategoryId(localIds, m.category_id)
  if (Array.isArray(m.category_ids)) {
    m.category_ids.forEach((x) => pushCategoryId(localIds, x))
  } else if (typeof m.category_ids === 'string' && m.category_ids.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(m.category_ids)
      if (Array.isArray(parsed)) parsed.forEach((x) => pushCategoryId(localIds, x))
    } catch (_) {}
  }
  for (const id of localIds) {
    ids.add(id)
    if (cover && !thumbsByCatId.has(id)) thumbsByCatId.set(id, cover)
  }
  const slug = String(m.category_slug || '').trim().toLowerCase().replace(/^\//, '')
  if (slug) {
    slugs.add(slug)
    if (cover && !thumbsByCatId.has(`slug:${slug}`)) thumbsByCatId.set(`slug:${slug}`, cover)
  }
}

const PUBLISHED_PRODUCTS_SQL = `
  SELECT seller_id, metadata
  FROM admin_hub_products
  WHERE LOWER(TRIM(COALESCE(status, ''))) IN ('published', 'active')
    AND LOWER(TRIM(COALESCE(metadata->>'_catalog_approval_pending', ''))) NOT IN ('true', 't')
    AND NOT (
      jsonb_typeof(metadata->'_pending_catalog_metafields') = 'array'
      AND jsonb_array_length(COALESCE(metadata->'_pending_catalog_metafields', '[]'::jsonb)) > 0
    )
`

const VISIBLE_SELLER_SQL = `
  AND (
    COALESCE(NULLIF(TRIM(seller_id), ''), 'default') IN ('', 'default')
    OR EXISTS (
      SELECT 1 FROM seller_users su
      WHERE TRIM(su.seller_id) = TRIM(admin_hub_products.seller_id)
        AND LENGTH(TRIM(su.seller_id)) > 0
        AND LOWER(COALESCE(su.approval_status, '')) NOT IN ('rejected', 'suspended')
    )
  )
`

async function collectPublishedProductCategoryRefs(queryFn) {
  const ids = new Set()
  const slugs = new Set()
  const thumbsByCatId = new Map()
  let rows = []
  try {
    const res = await queryFn(`${PUBLISHED_PRODUCTS_SQL} ${VISIBLE_SELLER_SQL}`)
    rows = res?.rows || []
  } catch (_) {
    try {
      const res = await queryFn(PUBLISHED_PRODUCTS_SQL)
      rows = res?.rows || []
    } catch (__) {
      return { ids, slugs, thumbsByCatId }
    }
  }
  for (const row of rows) {
    collectRefsFromProductMetadata(row.metadata, ids, slugs, thumbsByCatId)
  }
  return { ids, slugs, thumbsByCatId }
}

function annotateCategoryTreeHasProducts(tree, refs) {
  const ids = refs?.ids instanceof Set ? refs.ids : new Set()
  const slugs = refs?.slugs instanceof Set ? refs.slugs : new Set()
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (!n) continue
      walk(n.children)
      const idHit = ids.has(String(n.id || '').trim().toLowerCase())
      const slugHit = slugs.has(String(n.slug || n.handle || '').trim().toLowerCase().replace(/^\//, ''))
      const childHit = (n.children || []).some((c) => c && c.has_products)
      n.has_products = !!(idHit || slugHit || childHit)
    }
  }
  walk(tree)
  return tree
}

function pruneEmptyCategoryTree(nodes) {
  const out = []
  for (const n of nodes || []) {
    if (!n || !n.has_products) continue
    out.push({ ...n, children: pruneEmptyCategoryTree(n.children) })
  }
  return out
}

function applyProductImageFallback(tree, thumbsByCatId) {
  if (!thumbsByCatId || thumbsByCatId.size === 0) return tree
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (!n) continue
      walk(n.children)
      if (pickCategoryImageRaw(n)) continue
      const idKey = String(n.id || '').trim().toLowerCase()
      const slugKey = `slug:${String(n.slug || n.handle || '').trim().toLowerCase().replace(/^\//, '')}`
      const direct = thumbsByCatId.get(idKey) || thumbsByCatId.get(slugKey)
      if (direct) {
        n.image_url = direct
        continue
      }
      const child = (n.children || []).find((c) => c && pickCategoryImageRaw(c))
      if (child) n.image_url = pickCategoryImageRaw(child)
    }
  }
  walk(tree)
  return tree
}

function slimStoreCategoryNode(node, resolveUploadUrl) {
  if (!node) return null
  const metaIn = node.metadata && typeof node.metadata === 'object' ? node.metadata : {}
  const imageRaw = pickCategoryImageRaw(node)
  const bannerRaw = unwrapCategoryImageValue(node.banner_image_url || metaIn.banner_image_url)
  const resolvedImage = (typeof resolveUploadUrl === 'function' ? resolveUploadUrl(imageRaw) : imageRaw) || imageRaw || null
  const resolvedBanner = (typeof resolveUploadUrl === 'function' ? resolveUploadUrl(bannerRaw) : bannerRaw) || bannerRaw || null
  const translations = metaIn.translations && typeof metaIn.translations === 'object' ? metaIn.translations : undefined
  const children = Array.isArray(node.children)
    ? node.children.map((c) => slimStoreCategoryNode(c, resolveUploadUrl)).filter(Boolean)
    : []
  return {
    id: node.id,
    name: node.name,
    slug: node.slug,
    title: node.name,
    handle: node.slug,
    parent_id: node.parent_id || null,
    active: node.active,
    is_visible: node.is_visible,
    sort_order: node.sort_order,
    has_products: !!node.has_products,
    banner_image_url: resolvedBanner || null,
    image_url: resolvedImage || null,
    metadata: {
      ...(resolvedImage ? { image_url: resolvedImage } : {}),
      ...(resolvedBanner ? { banner_image_url: resolvedBanner } : {}),
      ...(translations ? { translations } : {}),
    },
    children,
  }
}

function slimStoreCategoryTree(tree, resolveUploadUrl) {
  return (tree || []).map((n) => slimStoreCategoryNode(n, resolveUploadUrl)).filter(Boolean)
}

const STORE_TREE_SQL = `
  SELECT id, name, slug, parent_id, active, is_visible, has_collection, sort_order,
         banner_image_url, metadata
  FROM admin_hub_categories
  WHERE active = true
  ORDER BY sort_order ASC, name ASC
`

async function loadSlimStoreCategoryTree({ query, resolveUploadUrl }) {
  const catRes = await query(STORE_TREE_SQL)
  let flat = (catRes?.rows || []).map(mapAdminHubCategoryPgRow)
  flat = flat.filter((c) => c && c.is_visible !== false)
  const tree = buildAdminHubCategoryTreeFromFlat(flat)
  const refs = await collectPublishedProductCategoryRefs(query)
  annotateCategoryTreeHasProducts(tree, refs)
  const pruned = pruneEmptyCategoryTree(tree)
  applyProductImageFallback(pruned, refs.thumbsByCatId)
  return slimStoreCategoryTree(pruned, resolveUploadUrl)
}

module.exports = {
  unwrapCategoryImageValue,
  pickCategoryImageRaw,
  productCoverFromMetadata,
  collectRefsFromProductMetadata,
  collectPublishedProductCategoryRefs,
  annotateCategoryTreeHasProducts,
  pruneEmptyCategoryTree,
  applyProductImageFallback,
  slimStoreCategoryNode,
  slimStoreCategoryTree,
  loadSlimStoreCategoryTree,
  STORE_TREE_SQL,
}
