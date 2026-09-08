'use strict'
const { Router } = require('express')
const {
  resolveAdminHub,
  mapAdminHubCategoryPgRow,
  localizeCategoriesForRequest,
  localizeSingleCategoryForRequest,
  resolveCategoryRequestLocale,
} = require('../categories-helpers')
const { getProductsDbClient } = require('./admin-products')
const { resolveUploadUrl } = require('./store-products')
const { loadSlimStoreCategoryTree } = require('../store-category-tree')
const { resolveMenuService } = require('./menus')
const { applyMenuLocale, normalizeMenuLocale } = require('../menu-auto-translate')
const { getPooledClient } = require('../db-pool')

// These storefront routes are hit on nearly every page load — pooled to avoid a fresh
// Postgres TCP+TLS handshake per request (see src/db-pool.js).
const getDbClient = () => getPooledClient()

const storeCollectionsGET = async (req, res) => {
  const handleQuery = (req.query.handle || req.query.slug || '').toString().trim()
  let client
  try {
    client = getPooledClient()
    if (!client) return res.json({ collections: [] })
    await client.connect()
    if (handleQuery) {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(handleQuery.trim())
      let r = await client.query('SELECT id, title, handle, metadata FROM admin_hub_collections WHERE LOWER(handle) = LOWER($1)', [handleQuery])
      if ((!r.rows || !r.rows[0]) && isUuid) {
        r = await client.query('SELECT id, title, handle, metadata FROM admin_hub_collections WHERE id = $1::uuid', [handleQuery.trim().toLowerCase()])
      }
      const row = r.rows && r.rows[0]
      if (!row) {
        try { await client.end() } catch (_) {}
        return res.status(404).json({ message: 'Collection not found' })
      }
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
      const bannerResolved = resolveUploadUrl(meta.banner_image_url || meta.image_url || null)
      const collection = {
        id: row.id,
        title: row.title,
        handle: row.handle,
        display_title: meta.display_title || row.title,
        meta_title: meta.meta_title || null,
        meta_description: meta.meta_description || null,
        banner: bannerResolved,
        banner_image_url: meta.banner_image_url || null,
        image_url: meta.image_url || null,
        description: meta.richtext || meta.description_html || null,
        recommended_product_ids: Array.isArray(meta.recommended_product_ids) ? meta.recommended_product_ids : [],
      }
      try { await client.end() } catch (_) {}
      return res.json({ collection })
    }
    const r = await client.query('SELECT id, title, handle, metadata FROM admin_hub_collections ORDER BY title')
    const collections = (r.rows || []).map((row) => {
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
      return {
        id: row.id,
        title: row.title,
        handle: row.handle,
        display_title: meta.display_title || row.title,
        banner: resolveUploadUrl(meta.banner_image_url || meta.image_url || null),
        banner_image_url: meta.banner_image_url || null,
        image_url: meta.image_url || null,
        description: meta.richtext || meta.description_html || null,
        recommended_product_ids: Array.isArray(meta.recommended_product_ids) ? meta.recommended_product_ids : [],
      }
    })
    res.json({ collections })
  } catch (e) {
    if (handleQuery) return res.status(500).json({ message: (e && e.message) || 'Internal server error' })
    res.json({ collections: [] })
  } finally {
    try { if (client) await client.end() } catch (_) {}
  }
}

// GET /store/menus – Public menüler (Shop). Her menü SADECE kendi menu_id'sine ait item'ları alır (raw DB).
let storeCategoriesTreeCache = new Map()
const STORE_CATEGORIES_TREE_TTL_MS = 45_000
// In-flight promise per cache key: without this, every concurrent request that
// lands while the 45s cache is cold independently re-runs the same tree build.
const storeCategoriesTreeInFlight = new Map()
const storeCategoriesGET = async (req, res) => {
  const adminHubService = resolveAdminHub()
  const requestLocale = resolveCategoryRequestLocale(req) || 'en'
  try {
    const slug = (req.query.slug || '').toString().trim()
    if (slug) {
      if (adminHubService) {
        const category = await adminHubService.getCategoryBySlug(slug)
        if (!category || category.active === false || category.is_visible === false) return res.status(404).json({ message: 'Category not found' })
        await localizeSingleCategoryForRequest(category, req, null)
        const meta = category.metadata && typeof category.metadata === 'object' ? category.metadata : {}
        const collectionId = category.has_collection && meta.collection_id ? meta.collection_id : null
        const rawBanner = category.banner_image_url != null ? category.banner_image_url : meta.banner_image_url
        const cat = {
          id: category.id, name: category.name, slug: category.slug,
          title: category.name, handle: category.slug,
          description: category.description || null,
          long_content: category.long_content || null,
          banner_image_url: resolveUploadUrl(rawBanner) || null,
          has_collection: category.has_collection,
          collection_id: collectionId || null,
          seo_title: category.seo_title || null,
          seo_description: category.seo_description || null,
          metadata: meta,
        }
        return res.json({ category: cat, categories: [cat], count: 1 })
      }
      // DB fallback
      const client = getProductsDbClient()
      if (!client) return res.status(404).json({ message: 'Category not found' })
      await client.connect()
      const r = await client.query(`SELECT * FROM admin_hub_categories WHERE slug = $1 AND active = true LIMIT 1`, [slug])
      if (!r.rows[0]) {
        await client.end()
        return res.status(404).json({ message: 'Category not found' })
      }
      const category = mapAdminHubCategoryPgRow(r.rows[0])
      await localizeSingleCategoryForRequest(category, req, client)
      await client.end()
      const meta = category.metadata && typeof category.metadata === 'object' ? category.metadata : {}
      const rawBanner = category.banner_image_url != null ? category.banner_image_url : meta.banner_image_url
      const cat = {
        id: category.id, name: category.name, slug: category.slug,
        title: category.name, handle: category.slug,
        description: category.description || null,
        long_content: category.long_content || null,
        banner_image_url: resolveUploadUrl(rawBanner) || null,
        has_collection: category.has_collection,
        collection_id: category.has_collection && meta.collection_id ? meta.collection_id : null,
        seo_title: category.seo_title || null,
        seo_description: category.seo_description || null,
        metadata: meta,
      }
      return res.json({ category: cat, categories: [cat], count: 1 })
    }

    const cacheKey = requestLocale
    const now = Date.now()
    const cachedEntry = storeCategoriesTreeCache.get(cacheKey)
    if (cachedEntry && now - cachedEntry.at < STORE_CATEGORIES_TREE_TTL_MS) {
      return res.json(cachedEntry.payload)
    }

    // Share one in-flight computation across all requests for this locale that
    // land while the cache is cold. Tree is loaded via slim SQL (no long_content,
    // no 10k full-product fetch) so the 12k-category catalog cannot OOM the shop menu.
    let payloadPromise = storeCategoriesTreeInFlight.get(cacheKey)
    if (!payloadPromise) {
      payloadPromise = (async () => {
        const client = getPooledClient()
        if (!client) return { categories: [], tree: [], count: 0 }
        await client.connect()
        try {
          const tree = await loadSlimStoreCategoryTree({
            query: (sql, params) => client.query(sql, params),
            resolveUploadUrl,
          })
          await localizeCategoriesForRequest(tree, req, client)
          const categories = (tree || []).map((c) => ({ id: c.id, name: c.name, slug: c.slug, title: c.name, handle: c.slug }))
          return { categories, tree, count: categories.length }
        } finally {
          try { await client.end() } catch (_) {}
        }
      })()
        .then((result) => {
          storeCategoriesTreeCache.set(cacheKey, { at: Date.now(), payload: result })
          return result
        })
        .finally(() => {
          storeCategoriesTreeInFlight.delete(cacheKey)
        })
      storeCategoriesTreeInFlight.set(cacheKey, payloadPromise)
    }

    const payload = await payloadPromise
    res.json(payload)
  } catch (err) {
    console.error('Store categories GET error:', err)
    res.status(200).json({ categories: [], tree: [], count: 0 })
  }
}

const getStoreMenusFromDb = async () => {
  try {
    // /store/menus is fetched on every storefront page load — pooled to avoid a fresh
    // Postgres TCP+TLS handshake per request (see src/db-pool.js).
    const client = getPooledClient()
    if (!client) return null
    await client.connect()
    const menusRes = await client.query('SELECT id, name, slug, location, categories_with_products, name_i18n FROM admin_hub_menus ORDER BY name')
    const menus = (menusRes.rows || []).map((r) => ({
      id: r.id,
      name: r.name,
      slug: r.slug,
      // null/'' → '' (unassigned). Only explicitly set 'main' is treated as main.
      location: (r.location === null || r.location === undefined || String(r.location).trim() === '') ? '' : String(r.location).trim().toLowerCase(),
      categories_with_products: Boolean(r.categories_with_products),
      name_i18n: r.name_i18n && typeof r.name_i18n === 'object' ? r.name_i18n : null,
    }))
    const menusWithItems = []
    const collectionKeys = new Set() // handle or id from link_value
    const collectionIds = new Set()
    const categoryKeys = new Set() // slug or id for link_type=category
    for (const menu of menus) {
      const itemsRes = await client.query(
        'SELECT id, menu_id, label, slug, link_type, link_value, parent_id, sort_order, label_i18n FROM admin_hub_menu_items WHERE menu_id = $1 ORDER BY sort_order ASC, label ASC',
        [menu.id]
      )
      const rows = itemsRes.rows || []
      for (const r of rows) {
        const lt = (r.link_type || 'url').toLowerCase()
        if (lt === 'collection' && r.link_value) {
          let h = (r.link_value || '').toString().trim()
          let parsedId = null
          if (h.startsWith('{')) {
            try {
              const p = JSON.parse(h)
              h = p.handle || p.slug || p.id || h
              if (p.id) parsedId = String(p.id).trim()
            } catch (_) {}
          }
          if (h) collectionKeys.add(h)
          if (parsedId) collectionIds.add(parsedId)
        }
        if (lt === 'category' && r.link_value) {
          let v = (r.link_value || '').toString().trim()
          if (v.startsWith('{')) {
            try {
              const p = JSON.parse(v)
              v = p.slug || p.handle || p.id || v
            } catch (_) {}
          }
          if (v) categoryKeys.add(v)
        }
      }
      const items = rows.map((r) => ({
        id: r.id,
        menu_id: r.menu_id,
        label: r.label,
        slug: r.slug,
        link_type: r.link_type || 'url',
        link_value: r.link_value,
        parent_id: r.parent_id,
        sort_order: r.sort_order != null ? r.sort_order : 0,
        label_i18n: r.label_i18n && typeof r.label_i18n === 'object' ? r.label_i18n : null,
      }))
      menusWithItems.push({ ...menu, items, _rows: rows })
    }
    const handleToBanner = {}
    const idToCollection = {}
    const idToBanner = {} // collection id -> banner url (for category->collection lookup)
    const categoryToCollectionId = {} // category slug/id -> collection id
    const handlesList = Array.from(collectionKeys).filter((k) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(k))
    const idsList = Array.from(collectionIds)
    if (handlesList.length > 0) {
      const collRes = await client.query(
        'SELECT id, title, handle, metadata FROM admin_hub_collections WHERE LOWER(handle) = ANY($1)',
        [handlesList.map((h) => h.toLowerCase())]
      )
      for (const row of collRes.rows || []) {
        const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
        const url = resolveUploadUrl(meta.banner_image_url || meta.image_url || null)
        if (url) {
          handleToBanner[(row.handle || '').toLowerCase()] = url
          idToBanner[String(row.id)] = url
        }
        idToCollection[String(row.id)] = { id: row.id, title: row.title, handle: row.handle }
      }
    }
    if (idsList.length > 0) {
      const byIdRes = await client.query(
        'SELECT id, title, handle, metadata FROM admin_hub_collections WHERE id = ANY($1)',
        [idsList]
      )
      for (const row of byIdRes.rows || []) {
        const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
        const url = resolveUploadUrl(meta.banner_image_url || meta.image_url || null)
        if (url) {
          handleToBanner[(row.handle || '').toLowerCase()] = url
          idToBanner[String(row.id)] = url
        }
        idToCollection[String(row.id)] = { id: row.id, title: row.title, handle: row.handle }
      }
    }
    // Resolve category -> collection_id for menu items with link_type=category (collection banner in menu)
    if (categoryKeys.size > 0) {
      const catSlugs = Array.from(categoryKeys).filter((k) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(k))
      const catIds = Array.from(categoryKeys).filter((k) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(k))
      const categoryCollectionIds = new Set()
      if (catSlugs.length > 0) {
        const catRes = await client.query(
          'SELECT id, slug, metadata FROM admin_hub_categories WHERE LOWER(slug) = ANY($1)',
          [catSlugs.map((s) => s.toLowerCase())]
        )
        for (const row of catRes.rows || []) {
          const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
          const cid = meta.collection_id
          if (cid) {
            categoryToCollectionId[(row.slug || '').toLowerCase()] = String(cid)
            categoryToCollectionId[String(row.id)] = String(cid)
            categoryCollectionIds.add(String(cid))
          }
        }
      }
      if (catIds.length > 0) {
        const catByIdRes = await client.query(
          'SELECT id, slug, metadata FROM admin_hub_categories WHERE id = ANY($1)',
          [catIds]
        )
        for (const row of catByIdRes.rows || []) {
          const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
          const cid = meta.collection_id
          if (cid) {
            categoryToCollectionId[(row.slug || '').toLowerCase()] = String(cid)
            categoryToCollectionId[String(row.id)] = String(cid)
            categoryCollectionIds.add(String(cid))
          }
        }
      }
      const collIdsToFetch = Array.from(categoryCollectionIds).filter((id) => !idToBanner[id])
      if (collIdsToFetch.length > 0) {
        const collByCatRes = await client.query(
          'SELECT id, title, handle, metadata FROM admin_hub_collections WHERE id = ANY($1)',
          [collIdsToFetch]
        )
        for (const row of collByCatRes.rows || []) {
          const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
          const url = resolveUploadUrl(meta.banner_image_url || meta.image_url || null)
          if (url) idToBanner[String(row.id)] = url
        }
      }
    }
    for (const m of menusWithItems) {
      const rows = m._rows || []
      delete m._rows
      m.items = m.items.map((it, idx) => {
        const r = rows[idx]
        if (!r) return it
        const lt = (r.link_type || 'url').toLowerCase()
        let banner_url = null
        if (lt === 'collection' && r.link_value) {
          let h = (r.link_value || '').toString().trim()
          let parsed = null
          if (h.startsWith('{')) {
            try {
              parsed = JSON.parse(h)
              h = parsed.handle || parsed.slug || parsed.id || h
            } catch (_) {}
          }
          const resolved = (parsed && parsed.id && idToCollection[String(parsed.id)]) ? idToCollection[String(parsed.id)] : null
          const resolvedHandle = resolved ? resolved.handle : (h && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(h) ? h : null)
          banner_url = resolvedHandle ? (handleToBanner[resolvedHandle.toLowerCase()] || null) : null
          const linkValueForShop = resolvedHandle
            ? JSON.stringify({ id: resolved?.id || parsed?.id, title: resolved?.title || parsed?.title, handle: resolvedHandle })
            : it.link_value
          return { ...it, ...(linkValueForShop !== it.link_value ? { link_value: linkValueForShop } : {}), ...(banner_url ? { banner_url } : {}) }
        }
        if (lt === 'category' && r.link_value) {
          let v = (r.link_value || '').toString().trim()
          let key = v
          if (v.startsWith('{')) {
            try {
              const p = JSON.parse(v)
              key = p.slug || p.handle || p.id || v
            } catch (_) {}
          }
          const collectionId = key ? (categoryToCollectionId[key.toLowerCase()] || categoryToCollectionId[String(key)]) : null
          banner_url = collectionId ? (idToBanner[collectionId] || null) : null
          return { ...it, ...(banner_url ? { banner_url } : {}) }
        }
        return it
      })
    }
    await client.end()
    return menusWithItems
  } catch (e) {
    console.warn('Store menus from DB:', e && e.message)
    return null
  }
}
const storeMenusGET = async (req, res) => {
  try {
    const location = (req.query.location || '').trim()
    let menusWithItems = await getStoreMenusFromDb()
    if (!menusWithItems) {
      const svc = resolveMenuService()
      if (!svc) return res.status(200).json({ menus: [], count: 0 })
      let menus = await svc.listMenus()
      if (location) menus = menus.filter((m) => m.location === location)
      menusWithItems = await Promise.all(
        menus.map(async (menu) => {
          const items = await svc.listMenuItems(menu.id).catch(() => [])
          return { ...menu, items: items || [] }
        })
      )
    } else {
      if (location) menusWithItems = menusWithItems.filter((m) => m.location === location)
    }
    const locale = normalizeMenuLocale(req.query.locale || req.headers['x-shop-locale'] || '')
    if (locale) {
      try {
        await applyMenuLocale(menusWithItems, locale)
      } catch (e) {
        console.warn('Store menus locale translate:', e && e.message)
      }
    }
    res.json({ menus: menusWithItems, count: menusWithItems.length })
  } catch (err) {
    console.error('Store menus GET error:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

// GET /store/page-by-label-slug/:slug — finds a page linked to a menu item by label_slug
const pageByLabelSlugGET = async (req, res) => {
  const client = getDbClient()
  if (!client) return res.status(404).json({ message: 'Not found' })
  try {
    await client.connect()
    const slug = req.params.slug
    const r = await client.query(
      `SELECT link_value FROM admin_hub_menu_items WHERE link_type = 'page' AND link_value::text LIKE $1`,
      [`%"label_slug":"${slug}"%`]
    )
    if (!r.rows[0]) return res.status(404).json({ message: 'Not found' })
    const lv = JSON.parse(r.rows[0].link_value)
    if (!lv?.id) return res.status(404).json({ message: 'Not found' })
    const pr = await client.query(
      `SELECT id, title, slug, body, featured_image, excerpt, page_type, meta_title, meta_description, meta_keywords FROM admin_hub_pages WHERE id = $1`,
      [lv.id]
    )
    if (!pr.rows[0]) return res.status(404).json({ message: 'Not found' })
    res.json(pr.rows[0])
  } catch { res.status(404).json({ message: 'Not found' }) } finally { await client.end().catch(() => {}) }
}

module.exports = function createStorePublicRouter() {
  const router = Router()

  router.get('/store/collections', storeCollectionsGET)
  router.get('/store/categories', storeCategoriesGET)
  router.get('/store/menus', storeMenusGET)
  router.get('/store/page-by-label-slug/:slug', pageByLabelSlugGET)

  return router
}
