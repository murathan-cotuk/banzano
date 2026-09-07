'use strict'
const { Router } = require('express')
const categoryAutoTranslate = require('../category-auto-translate')
const {
  resolveAdminHub,
  localizeCategoriesForRequest,
  localizeSingleCategoryForRequest,
  mapAdminHubCategoryPgRow,
  buildAdminHubCategoryTreeFromFlat,
  getCategoriesPgClient,
  categoriesPgUnavailable,
} = require('../categories-helpers')
const { updateAdminHubCollectionDb } = require('../collections-db')
const { invalidateCategoryTreeCache } = require('../category-tree-cache')

const requireSuperuser = (req, res, next) => {
  if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser access required' })
  next()
}

const slugFromImportKeyPg = (key) =>
  (String(key || '').toLowerCase().trim()
    .replace(/\|/g, '-').replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-').replace(/^-|-$/g, '') || 'category').slice(0, 255)

async function syncCategoryCmsToCollectionFromBody(body) {
  try {
    const meta = (body && typeof body.metadata === 'object' && body.metadata) || {}
    const linkedId = (meta.collection_id || '').toString().trim()
    if (!linkedId) return
    const patchMeta = {
      ...(meta.display_title !== undefined ? { display_title: meta.display_title || null } : {}),
      ...(meta.meta_title !== undefined ? { meta_title: meta.meta_title || null } : {}),
      ...(meta.meta_description !== undefined ? { meta_description: meta.meta_description || null } : {}),
      ...(meta.keywords !== undefined ? { keywords: meta.keywords || null } : {}),
      ...(meta.richtext !== undefined ? { richtext: meta.richtext || null } : {}),
      ...(meta.image_url !== undefined ? { image_url: meta.image_url || null } : {}),
      ...(meta.banner_image_url !== undefined ? { banner_image_url: meta.banner_image_url || null } : {}),
    }
    if (Object.keys(patchMeta).length === 0) return
    await updateAdminHubCollectionDb(linkedId, null, null, patchMeta)
  } catch (e) {
    console.warn('syncCategoryCmsToCollectionFromBody:', e && e.message)
  }
}

// ── Fallback PG handlers ──────────────────────────────────────────────────────

const adminHubCategoriesGET_fallbackPg = async (req, res) => {
  const client = getCategoriesPgClient()
  if (!client) return categoriesPgUnavailable(res)
  try {
    await client.connect()
    const { active, parent_id, tree, is_visible, slug } = req.query

    if (slug && typeof slug === 'string') {
      const r = await client.query(`SELECT * FROM admin_hub_categories WHERE slug = $1 LIMIT 1`, [slug])
      if (!r.rows[0]) return res.status(404).json({ message: 'Category not found' })
      const category = mapAdminHubCategoryPgRow(r.rows[0])
      await localizeSingleCategoryForRequest(category, req, client)
      return res.json({ category, categories: [category], count: 1 })
    }

    if (tree === 'true') {
      const r = await client.query(
        `SELECT * FROM admin_hub_categories WHERE active = true ORDER BY sort_order ASC, name ASC`
      )
      let filtered = r.rows.map(mapAdminHubCategoryPgRow)
      if (is_visible !== undefined) {
        const vis = is_visible === 'true'
        filtered = filtered.filter((c) => c.is_visible === vis)
      }
      const categoryTree = buildAdminHubCategoryTreeFromFlat(filtered)
      await localizeCategoriesForRequest(categoryTree, req, client)
      return res.json({ tree: categoryTree, categories: categoryTree, count: categoryTree.length })
    }

    let sql = `SELECT * FROM admin_hub_categories WHERE 1=1`
    const params = []
    let i = 1
    if (active !== undefined) { sql += ` AND active = $${i++}`; params.push(active === 'true') }
    if (parent_id !== undefined) {
      if (parent_id === 'null' || parent_id === '') { sql += ` AND parent_id IS NULL` }
      else { sql += ` AND parent_id = $${i++}`; params.push(parent_id) }
    }
    if (is_visible !== undefined) { sql += ` AND is_visible = $${i++}`; params.push(is_visible === 'true') }
    sql += ` ORDER BY sort_order ASC, name ASC`
    const r = await client.query(sql, params)
    const categories = r.rows.map(mapAdminHubCategoryPgRow)
    await localizeCategoriesForRequest(categories, req, client)
    return res.json({ categories, count: categories.length })
  } catch (e) {
    const msg = e && e.message ? String(e.message) : ''
    if (msg.includes('does not exist') || msg.includes('admin_hub_categories')) {
      console.warn('Admin Hub Categories GET (PG fallback): table missing?', msg)
      return res.json({ categories: [], count: 0 })
    }
    console.error('Admin Hub Categories GET (PG fallback) error:', e)
    return res.status(500).json({ message: msg || 'Internal server error' })
  } finally {
    await client.end().catch(() => {})
  }
}

const adminHubCategoriesPOST_fallbackPg = async (req, res) => {
  const client = getCategoriesPgClient()
  if (!client) return categoriesPgUnavailable(res)
  const b = req.body || {}
  const name = b.name
  const slug = b.slug
  if (!name || !slug) return res.status(400).json({ message: 'name ve slug zorunludur' })
  try {
    await client.connect()
    const dup = await client.query(`SELECT id FROM admin_hub_categories WHERE LOWER(TRIM(slug)) = LOWER(TRIM($1)) LIMIT 1`, [String(slug).trim()])
    if (dup.rows[0]) {
      await client.end()
      return res.status(409).json({ message: 'Bu slug zaten kullanılıyor' })
    }
    const metaVal = b.metadata !== undefined && b.metadata !== null && typeof b.metadata === 'object' ? JSON.stringify(b.metadata) : null
    const ir = await client.query(
      `INSERT INTO admin_hub_categories
        (name, slug, description, parent_id, active, is_visible, has_collection, sort_order, seo_title, seo_description, long_content, banner_image_url, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CASE WHEN $13::text IS NULL THEN NULL ELSE $13::jsonb END)
       RETURNING *`,
      [
        String(name).trim(),
        String(slug).trim(),
        b.description != null ? String(b.description) : null,
        b.parent_id || null,
        b.active !== undefined ? !!b.active : true,
        b.is_visible !== undefined ? !!b.is_visible : true,
        b.has_collection !== undefined ? !!b.has_collection : false,
        parseInt(b.sort_order, 10) || 0,
        b.seo_title != null ? String(b.seo_title) : null,
        b.seo_description != null ? String(b.seo_description) : null,
        b.long_content != null ? String(b.long_content) : null,
        b.banner_image_url != null ? String(b.banner_image_url) : null,
        metaVal,
      ]
    )
    await client.end()
    const category = mapAdminHubCategoryPgRow(ir.rows[0])
    await syncCategoryCmsToCollectionFromBody(b)
    invalidateCategoryTreeCache().catch(() => {})
    return res.status(201).json({ category })
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.error('Admin Hub Categories POST (PG fallback):', e)
    return res.status(500).json({ message: (e && e.message) || 'Internal server error' })
  }
}

const adminHubCategoryByIdGET_fallbackPg = async (req, res) => {
  const client = getCategoriesPgClient()
  if (!client) return categoriesPgUnavailable(res)
  const id = (req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })
  try {
    await client.connect()
    const r = await client.query(`SELECT * FROM admin_hub_categories WHERE id = $1::uuid`, [id])
    if (!r.rows[0]) {
      await client.end()
      return res.status(404).json({ message: 'Category not found' })
    }
    const category = mapAdminHubCategoryPgRow(r.rows[0])
    await localizeSingleCategoryForRequest(category, req, client)
    await client.end()
    return res.json({ category })
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.error('Admin Hub Category GET (PG fallback):', e)
    return res.status(500).json({ message: (e && e.message) || 'Internal server error' })
  }
}

const adminHubCategoryByIdPUT_fallbackPg = async (req, res) => {
  const client = getCategoriesPgClient()
  if (!client) return categoriesPgUnavailable(res)
  const id = (req.params.id || '').trim()
  const body = req.body || {}
  if (!id) return res.status(400).json({ message: 'id required' })
  try {
    await client.connect()
    const ex = await client.query(`SELECT * FROM admin_hub_categories WHERE id = $1::uuid`, [id])
    if (!ex.rows[0]) {
      await client.end()
      return res.status(404).json({ message: 'Category not found' })
    }
    const row = ex.rows[0]
    if (body.slug != null && String(body.slug).trim() !== String(row.slug || '').trim()) {
      const dup = await client.query(
        `SELECT id FROM admin_hub_categories WHERE LOWER(TRIM(slug)) = LOWER(TRIM($1)) AND id <> $2::uuid LIMIT 1`,
        [String(body.slug).trim(), id]
      )
      if (dup.rows[0]) {
        await client.end()
        return res.status(409).json({ message: 'Bu slug zaten kullanılıyor' })
      }
    }
    let mergedMeta = row.metadata && typeof row.metadata === 'object' ? { ...row.metadata } : {}
    if (body.metadata !== undefined && body.metadata !== null && typeof body.metadata === 'object') {
      mergedMeta = { ...mergedMeta, ...body.metadata }
    }
    const next = {
      name: body.name !== undefined ? String(body.name).trim() : row.name,
      slug: body.slug !== undefined ? String(body.slug).trim() : row.slug,
      description: body.description !== undefined ? (body.description === '' ? null : String(body.description)) : row.description,
      parent_id: body.parent_id !== undefined ? body.parent_id || null : row.parent_id,
      active: body.active !== undefined ? !!body.active : row.active,
      is_visible: body.is_visible !== undefined ? !!body.is_visible : row.is_visible,
      has_collection: body.has_collection !== undefined ? !!body.has_collection : row.has_collection,
      sort_order: body.sort_order !== undefined ? parseInt(body.sort_order, 10) || 0 : row.sort_order,
      seo_title: body.seo_title !== undefined ? (body.seo_title === '' ? null : String(body.seo_title)) : row.seo_title,
      seo_description: body.seo_description !== undefined ? (body.seo_description === '' ? null : String(body.seo_description)) : row.seo_description,
      long_content: body.long_content !== undefined ? (body.long_content === '' ? null : String(body.long_content)) : row.long_content,
      banner_image_url: body.banner_image_url !== undefined ? (body.banner_image_url === '' ? null : String(body.banner_image_url)) : row.banner_image_url,
      metadata: Object.keys(mergedMeta).length ? mergedMeta : null,
    }
    const ur = await client.query(
      `UPDATE admin_hub_categories SET
        name = $1, slug = $2, description = $3, parent_id = $4, active = $5, is_visible = $6, has_collection = $7,
        sort_order = $8, seo_title = $9, seo_description = $10, long_content = $11, banner_image_url = $12,
        metadata = CASE WHEN $13::text IS NULL THEN NULL ELSE $13::jsonb END, updated_at = now()
       WHERE id = $14::uuid RETURNING *`,
      [
        next.name, next.slug, next.description, next.parent_id, next.active, next.is_visible, next.has_collection,
        next.sort_order, next.seo_title, next.seo_description, next.long_content, next.banner_image_url,
        next.metadata ? JSON.stringify(next.metadata) : null,
        id,
      ]
    )
    await client.end()
    const category = mapAdminHubCategoryPgRow(ur.rows[0])
    try {
      const meta = (body.metadata && typeof body.metadata === 'object' && body.metadata) || {}
      const categoryMeta = category.metadata && typeof category.metadata === 'object' ? category.metadata : {}
      const linkedId = (meta.collection_id || categoryMeta.collection_id || '').toString().trim()
      if (linkedId) {
        const patchMeta = {
          ...(meta.display_title !== undefined ? { display_title: meta.display_title || null } : {}),
          ...(meta.meta_title !== undefined ? { meta_title: meta.meta_title || body.seo_title || null } : {}),
          ...(meta.meta_description !== undefined ? { meta_description: meta.meta_description || body.seo_description || null } : {}),
          ...(meta.keywords !== undefined ? { keywords: meta.keywords || null } : {}),
          ...(meta.richtext !== undefined ? { richtext: meta.richtext || body.long_content || null } : {}),
          ...(meta.image_url !== undefined ? { image_url: meta.image_url || null } : {}),
          ...(meta.banner_image_url !== undefined ? { banner_image_url: meta.banner_image_url || body.banner_image_url || null } : {}),
        }
        if (Object.keys(patchMeta).length > 0) {
          await updateAdminHubCollectionDb(linkedId, null, null, patchMeta)
        }
      }
    } catch (cmsErr) {
      console.warn('syncCategoryCmsToCollection (PUT PG):', cmsErr && cmsErr.message)
    }
    invalidateCategoryTreeCache().catch(() => {})
    return res.json({ category })
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.error('Admin Hub Category PUT (PG fallback):', e)
    return res.status(500).json({ message: (e && e.message) || 'Internal server error' })
  }
}

const adminHubCategoryByIdDELETE_fallbackPg = async (req, res) => {
  const client = getCategoriesPgClient()
  if (!client) return categoriesPgUnavailable(res)
  const id = (req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'id required' })
  try {
    await client.connect()
    const ch = await client.query(`SELECT COUNT(*)::int AS n FROM admin_hub_categories WHERE parent_id = $1::uuid`, [id])
    if (Number(ch.rows[0]?.n || 0) > 0) {
      await client.end()
      return res.status(400).json({ message: 'Alt kategoriler varken silinemez. Önce alt kategorileri taşıyın veya silin.' })
    }
    const dr = await client.query(`DELETE FROM admin_hub_categories WHERE id = $1::uuid RETURNING id`, [id])
    await client.end()
    if (!dr.rows[0]) return res.status(404).json({ message: 'Category not found' })
    invalidateCategoryTreeCache().catch(() => {})
    return res.status(200).json({ deleted: true })
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.error('Admin Hub Category DELETE (PG fallback):', e)
    return res.status(500).json({ message: (e && e.message) || 'Internal server error' })
  }
}

const adminHubCategoriesImportPOST_fallbackPg = async (req, res) => {
  const client = getCategoriesPgClient()
  if (!client) return categoriesPgUnavailable(res)
  const { items } = req.body || {}
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items array is required and must not be empty' })
  }
  const idByKey = new Map()
  const slugCount = new Map()
  const categories = []
  try {
    await client.connect()
    for (const item of items) {
      const key = String(item.key || '').trim()
      const label = String(item.label || '').trim()
      if (!key || !label) continue
      let baseSlug = slugFromImportKeyPg(key)
      const sc = (slugCount.get(baseSlug) || 0) + 1
      slugCount.set(baseSlug, sc)
      const slug = sc === 1 ? baseSlug : `${baseSlug}-${sc - 1}`
      const parent_id = item.parentKey === '' || item.parentKey == null ? null : idByKey.get(String(item.parentKey).trim()) || null
      const sort_order = Number(item.sortOrder) || 0
      const ir = await client.query(
        `INSERT INTO admin_hub_categories
          (name, slug, description, parent_id, active, is_visible, has_collection, sort_order, metadata)
         VALUES ($1,$2,NULL,$3,true,true,false,$4,NULL)
         RETURNING *`,
        [label, slug, parent_id, sort_order]
      )
      const row = ir.rows[0]
      idByKey.set(key, row.id)
      categories.push(mapAdminHubCategoryPgRow(row))
    }
    await client.end()
    invalidateCategoryTreeCache().catch(() => {})
    return res.status(201).json({ imported: categories.length, categories })
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.error('Admin Hub Categories import (PG fallback):', e)
    return res.status(500).json({ message: (e && e.message) || 'Import failed' })
  }
}

// ── Main handlers ─────────────────────────────────────────────────────────────

const adminHubCategoriesGET = async (req, res) => {
  const adminHubService = resolveAdminHub()
  if (adminHubService) {
    try {
      const { active, parent_id, tree, is_visible, slug } = req.query
      if (slug && typeof slug === 'string') {
        const category = await adminHubService.getCategoryBySlug(slug)
        if (!category) return res.status(404).json({ message: 'Category not found' })
        await localizeSingleCategoryForRequest(category, req, null)
        return res.json({ category, categories: [category], count: 1 })
      }
      if (tree === 'true') {
        const filters = {}
        if (is_visible !== undefined) filters.is_visible = is_visible === 'true'
        const categoryTree = await adminHubService.getCategoryTree(filters)
        await localizeCategoriesForRequest(categoryTree, req, null)
        return res.json({ tree: categoryTree, categories: categoryTree, count: categoryTree.length })
      }
      const filters = {}
      if (active !== undefined) filters.active = active === 'true'
      if (parent_id !== undefined) filters.parent_id = parent_id === 'null' ? null : parent_id
      if (is_visible !== undefined) filters.is_visible = is_visible === 'true'
      const categories = await adminHubService.listCategories(filters)
      await localizeCategoriesForRequest(categories, req, null)
      return res.json({ categories, count: categories.length })
    } catch (err) {
      console.warn('Admin Hub Categories GET (service) failed, PG fallback:', err && err.message)
    }
  } else {
    console.warn('Admin Hub Categories GET: adminHubService not loaded — PG fallback')
  }
  return adminHubCategoriesGET_fallbackPg(req, res)
}

const adminHubCategoriesPOST = async (req, res) => {
  const adminHubService = resolveAdminHub()
  const b = req.body || {}
  const name = b.name
  const slug = b.slug
  if (!name || !slug) return res.status(400).json({ message: 'name ve slug zorunludur' })
  if (adminHubService) {
    try {
      const category = await adminHubService.createCategory({
        name,
        slug,
        description: b.description || undefined,
        parent_id: b.parent_id || null,
        active: b.active !== undefined ? b.active : true,
        is_visible: b.is_visible !== undefined ? b.is_visible : true,
        has_collection: b.has_collection !== undefined ? b.has_collection : false,
        sort_order: b.sort_order || 0,
        seo_title: b.seo_title || null,
        seo_description: b.seo_description || null,
        long_content: b.long_content || null,
        banner_image_url: b.banner_image_url || null,
        metadata: b.metadata,
      })
      await syncCategoryCmsToCollectionFromBody(b)
      invalidateCategoryTreeCache().catch(() => {})
      return res.status(201).json({ category })
    } catch (err) {
      console.warn('Admin Hub Categories POST (service) failed, PG fallback:', err && err.message)
    }
  } else {
    console.warn('Admin Hub Categories POST: adminHubService not loaded — PG fallback')
  }
  return adminHubCategoriesPOST_fallbackPg(req, res)
}

const adminHubCategoriesImportPOST = async (req, res) => {
  const { items } = req.body || {}
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ message: 'items array is required and must not be empty' })
  }
  const adminHubService = resolveAdminHub()
  if (adminHubService) {
    try {
      const { imported, categories } = await adminHubService.importCategories(items)
      invalidateCategoryTreeCache().catch(() => {})
      return res.status(201).json({ imported, categories })
    } catch (err) {
      console.warn('Admin Hub Categories import (service) failed, PG fallback:', err && err.message)
    }
  } else {
    console.warn('Admin Hub Categories import: adminHubService not loaded — PG fallback')
  }
  return adminHubCategoriesImportPOST_fallbackPg(req, res)
}

const adminHubCategoryByIdGET = async (req, res) => {
  const adminHubService = resolveAdminHub()
  if (adminHubService) {
    try {
      const category = await adminHubService.getCategoryById(req.params.id)
      if (!category) return res.status(404).json({ message: 'Category not found' })
      await localizeSingleCategoryForRequest(category, req, null)
      return res.json({ category })
    } catch (err) {
      console.warn('Admin Hub Category GET (service) failed, PG fallback:', err && err.message)
    }
  } else {
    console.warn('Admin Hub Category GET: adminHubService not loaded — PG fallback')
  }
  return adminHubCategoryByIdGET_fallbackPg(req, res)
}

const adminHubCategoryByIdPUT = async (req, res) => {
  const adminHubService = resolveAdminHub()
  const body = req.body || {}
  if (adminHubService) {
    try {
      const category = await adminHubService.updateCategory(req.params.id, body)
      try {
        const meta = (body && typeof body.metadata === 'object' && body.metadata) || {}
        const categoryMeta = category && category.metadata && typeof category.metadata === 'object' ? category.metadata : {}
        const linkedId = (meta.collection_id || categoryMeta.collection_id || '').toString().trim()
        if (linkedId) {
          const patchMeta = {
            ...(meta.display_title !== undefined ? { display_title: meta.display_title || null } : {}),
            ...(meta.meta_title !== undefined ? { meta_title: meta.meta_title || body.seo_title || null } : {}),
            ...(meta.meta_description !== undefined ? { meta_description: meta.meta_description || body.seo_description || null } : {}),
            ...(meta.keywords !== undefined ? { keywords: meta.keywords || null } : {}),
            ...(meta.richtext !== undefined ? { richtext: meta.richtext || body.long_content || null } : {}),
            ...(meta.image_url !== undefined ? { image_url: meta.image_url || null } : {}),
            ...(meta.banner_image_url !== undefined ? { banner_image_url: meta.banner_image_url || body.banner_image_url || null } : {}),
          }
          if (Object.keys(patchMeta).length > 0) {
            await updateAdminHubCollectionDb(linkedId, null, null, patchMeta)
          }
        }
      } catch (e) {
        console.warn('syncCategoryCmsToCollection (PUT):', e && e.message)
      }
      invalidateCategoryTreeCache().catch(() => {})
      return res.json({ category })
    } catch (err) {
      console.warn('Admin Hub Category PUT (service) failed, PG fallback:', err && err.message)
    }
  } else {
    console.warn('Admin Hub Category PUT: adminHubService not loaded — PG fallback')
  }
  return adminHubCategoryByIdPUT_fallbackPg(req, res)
}

const adminHubCategoryByIdDELETE = async (req, res) => {
  const adminHubService = resolveAdminHub()
  if (adminHubService) {
    try {
      await adminHubService.deleteCategory(req.params.id)
      invalidateCategoryTreeCache().catch(() => {})
      return res.status(200).json({ deleted: true })
    } catch (err) {
      console.warn('Admin Hub Category DELETE (service) failed, PG fallback:', err && err.message)
    }
  } else {
    console.warn('Admin Hub Category DELETE: adminHubService not loaded — PG fallback')
  }
  return adminHubCategoryByIdDELETE_fallbackPg(req, res)
}

const adminHubCategoriesWarmTranslationsPOST = async (req, res) => {
  const locale = categoryAutoTranslate.normalizeCategoryLocale(
    (req.body && req.body.locale) || req.query.locale || '',
  )
  if (!locale) return res.status(400).json({ message: 'locale query/body required (de, en, tr, fr, es, it)' })
  try {
    const result = await categoryAutoTranslate.warmAllCategoryNames(locale)
    return res.json({ ok: true, ...result })
  } catch (e) {
    console.error('categories warm-translations:', e)
    return res.status(500).json({ message: (e && e.message) || 'warm failed' })
  }
}

// ── Compliance schema (docs/HUKUKI.md Faz 2 step 2) ───────────────────────────
// Read-only: resolves which product fields are required/optional for a category,
// merging inheritance (compliance-profiles.json) + marketplace overlay
// (marketplace-overlays.json). Does NOT change any validation behavior — nothing
// calls this to block a save yet. Safe to ship ahead of the actual gate.
const adminHubCategoryComplianceSchemaGET = async (req, res) => {
  const id = (req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'category id required' })
  const marketplace = String(req.query.marketplace || 'DE').toUpperCase()
  const client = getCategoriesPgClient()
  if (!client) return categoriesPgUnavailable(res)
  try {
    const { resolveComplianceProfile, DEFAULT_PROFILE_ID } = require('../compliance/resolve-compliance')
    const { resolveCategoryComplianceProfileId } = require('../compliance/category-profile-lookup')
    await client.connect()
    const exists = await client.query('SELECT id, metadata, parent_id, name FROM admin_hub_categories WHERE id = $1', [id])
    const own = exists.rows[0]
    if (!own) { await client.end(); return res.status(404).json({ message: 'Category not found' }) }
    const ownMeta = own.metadata && typeof own.metadata === 'object' ? own.metadata : {}
    const profileId = await resolveCategoryComplianceProfileId(client, id)
    await client.end()

    const resolved = resolveComplianceProfile(profileId || DEFAULT_PROFILE_ID, marketplace)
    res.json({
      category_id: id,
      category_name: own.name || null,
      // own_profile_id: set directly on THIS category (vs. resolved via a parent). ComplianceProfilesPage
      // uses this to show "explicit" vs "inherited from an ancestor" in the override editor.
      own_profile_id: ownMeta.compliance_profile_id || null,
      resolved_from: profileId ? 'category_or_ancestor' : 'default_fallback',
      ...resolved,
    })
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.error('Category compliance-schema GET:', e)
    res.status(500).json({ message: (e && e.message) || 'Internal server error' })
  }
}

// GET /admin-hub/v1/compliance-profiles — superuser only. The full profile catalog, for the
// ComplianceProfilesPage picker (docs/HUKUKI.md "en iyisi" follow-up — per-category override UI).
const adminHubComplianceProfilesGET = (req, res) => {
  try {
    const { listProfiles } = require('../compliance/resolve-compliance')
    res.json({ profiles: listProfiles() })
  } catch (e) {
    res.status(500).json({ message: (e && e.message) || 'Internal server error' })
  }
}

// GET /admin-hub/v1/categories/compliance-overview — superuser only. Every category's effective
// compliance profile (own override vs. inherited vs. default fallback) in one call, for
// ComplianceProfilesPage's overview table — resolving all categories one-by-one via
// resolveCategoryComplianceProfileId would be N ancestor-walk queries; this does a single
// SELECT and walks parent_id chains in memory instead.
const adminHubComplianceOverviewGET = async (req, res) => {
  const client = getCategoriesPgClient()
  if (!client) return categoriesPgUnavailable(res)
  try {
    const { resolveComplianceProfile, DEFAULT_PROFILE_ID } = require('../compliance/resolve-compliance')
    await client.connect()
    const r = await client.query('SELECT id, name, slug, parent_id, metadata FROM admin_hub_categories ORDER BY sort_order ASC, name ASC')
    await client.end()

    const byId = new Map(r.rows.map((row) => [row.id, row]))
    const resolvedCache = new Map()
    const resolveOwnProfileId = (row) => {
      const meta = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
      return meta.compliance_profile_id || null
    }
    const resolveForId = (id) => {
      if (resolvedCache.has(id)) return resolvedCache.get(id)
      const chain = []
      let cursorId = id
      const seen = new Set()
      let found = null
      while (cursorId && !seen.has(cursorId)) {
        seen.add(cursorId)
        const row = byId.get(cursorId)
        if (!row) break
        chain.push(cursorId)
        const own = resolveOwnProfileId(row)
        if (own) { found = { profileId: own, fromId: cursorId }; break }
        cursorId = row.parent_id || null
      }
      for (const chainId of chain) resolvedCache.set(chainId, found)
      if (!resolvedCache.has(id)) resolvedCache.set(id, found)
      return found
    }

    const categories = r.rows.map((row) => {
      const ownProfileId = resolveOwnProfileId(row)
      const found = resolveForId(row.id)
      const effectiveProfileId = found?.profileId || DEFAULT_PROFILE_ID
      const resolvedFrom = ownProfileId ? 'own' : found ? 'inherited' : 'default'
      let profileLabelI18n = {}
      try {
        profileLabelI18n = resolveComplianceProfile(effectiveProfileId).profile_label_i18n || {}
      } catch (_) { /* unknown profile id — leave label empty, id still shown */ }
      return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        parent_id: row.parent_id,
        own_profile_id: ownProfileId,
        effective_profile_id: effectiveProfileId,
        effective_profile_label_i18n: profileLabelI18n,
        resolved_from: resolvedFrom,
      }
    })
    res.json({ categories })
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.error('Category compliance-overview GET:', e)
    res.status(500).json({ message: (e && e.message) || 'Internal server error' })
  }
}

// PATCH /admin-hub/v1/categories/:id/compliance-profile — superuser only. Sets or clears
// (profile_id: null) this category's OWN compliance_profile_id override. Clearing makes it fall
// back to whatever its nearest ancestor (or the default profile) resolves to — see
// resolveCategoryComplianceProfileId. Deliberately its own tiny endpoint rather than reusing the
// general category PUT, since that expects a full category payload and isn't superuser-gated.
const adminHubCategoryComplianceProfilePATCH = async (req, res) => {
  const id = (req.params.id || '').trim()
  if (!id) return res.status(400).json({ message: 'category id required' })
  const rawProfileId = req.body?.profile_id
  const profileId = rawProfileId == null ? null : String(rawProfileId).trim() || null
  if (profileId) {
    const { listProfiles } = require('../compliance/resolve-compliance')
    if (!listProfiles().some((p) => p.id === profileId)) {
      return res.status(400).json({ message: `Unknown compliance profile: ${profileId}` })
    }
  }
  const client = getCategoriesPgClient()
  if (!client) return categoriesPgUnavailable(res)
  try {
    await client.connect()
    const exists = await client.query('SELECT id FROM admin_hub_categories WHERE id = $1', [id])
    if (!exists.rows[0]) { await client.end(); return res.status(404).json({ message: 'Category not found' }) }
    if (profileId) {
      await client.query(
        `UPDATE admin_hub_categories SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('compliance_profile_id', $1::text) WHERE id = $2`,
        [profileId, id],
      )
    } else {
      await client.query(
        `UPDATE admin_hub_categories SET metadata = COALESCE(metadata, '{}'::jsonb) - 'compliance_profile_id' WHERE id = $1`,
        [id],
      )
    }
    await client.end()
    res.json({ success: true, category_id: id, own_profile_id: profileId })
  } catch (e) {
    try { await client.end() } catch (_) {}
    console.error('Category compliance-profile PATCH:', e)
    res.status(500).json({ message: (e && e.message) || 'Internal server error' })
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = function createCategoriesRouter() {
  const router = Router()

  router.get('/admin-hub/categories', (req, res) => adminHubCategoriesGET(req, res))
  router.post('/admin-hub/categories', (req, res) => adminHubCategoriesPOST(req, res))
  router.post('/admin-hub/categories/import', (req, res) => adminHubCategoriesImportPOST(req, res))
  router.get('/admin-hub/categories/:id/compliance-schema', (req, res) => adminHubCategoryComplianceSchemaGET(req, res))
  router.get('/admin-hub/categories/:id', (req, res) => adminHubCategoryByIdGET(req, res))
  router.put('/admin-hub/categories/:id', (req, res) => adminHubCategoryByIdPUT(req, res))
  router.delete('/admin-hub/categories/:id', (req, res) => adminHubCategoryByIdDELETE(req, res))

  router.get('/admin-hub/v1/categories', (req, res) => adminHubCategoriesGET(req, res))
  router.post('/admin-hub/v1/categories', (req, res) => adminHubCategoriesPOST(req, res))
  router.get('/admin-hub/v1/categories/:id/compliance-schema', (req, res) => adminHubCategoryComplianceSchemaGET(req, res))
  router.get('/admin-hub/v1/categories/compliance-overview', requireSuperuser, adminHubComplianceOverviewGET)
  router.get('/admin-hub/v1/categories/:id', (req, res) => adminHubCategoryByIdGET(req, res))
  router.put('/admin-hub/v1/categories/:id', (req, res) => adminHubCategoryByIdPUT(req, res))
  router.delete('/admin-hub/v1/categories/:id', (req, res) => adminHubCategoryByIdDELETE(req, res))

  router.post('/admin-hub/v1/categories/warm-translations', requireSuperuser, adminHubCategoriesWarmTranslationsPOST)
  router.get('/admin-hub/v1/compliance-profiles', requireSuperuser, adminHubComplianceProfilesGET)
  router.patch('/admin-hub/v1/categories/:id/compliance-profile', requireSuperuser, adminHubCategoryComplianceProfilePATCH)

  return router
}
