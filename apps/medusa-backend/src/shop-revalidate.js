'use strict'

/**
 * Fire-and-forget: tell the shop to drop storefront caches after admin-hub writes.
 * Env: STOREFRONT_PUBLIC_URL / SHOP_PUBLIC_URL / PUBLIC_SHOP_URL
 *      REVALIDATE_SECRET / SHOP_REVALIDATE_SECRET (optional but recommended in prod)
 */

let debounceTimer = null
let pendingScopes = new Set()

function shopBaseUrl() {
  const candidates = [
    process.env.STOREFRONT_PUBLIC_URL,
    process.env.SHOP_PUBLIC_URL,
    process.env.PUBLIC_SHOP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_SHOP_URL,
  ]
  for (const raw of candidates) {
    const s = String(raw || '')
      .trim()
      .replace(/\/$/, '')
    if (s && /^https?:\/\//i.test(s)) return s
  }
  return 'https://www.andertal.com'
}

function scopesForAdminPath(pathname) {
  const p = String(pathname || '').toLowerCase()
  const scopes = new Set()
  if (p.includes('/product')) scopes.add('products')
  if (p.includes('/categor')) scopes.add('categories')
  if (p.includes('/menu')) {
    scopes.add('menus')
    scopes.add('menu-locations')
  }
  if (p.includes('/page') || p.includes('/landing')) {
    scopes.add('pages')
    scopes.add('landing')
  }
  if (p.includes('/brand')) scopes.add('brands')
  if (p.includes('/collection')) scopes.add('collections')
  if (p.includes('/seller-setting') || p.includes('/style')) scopes.add('seller-settings')
  if (p.includes('/metafield') || p.includes('/metaobject')) scopes.add('metafields')
  if (scopes.size === 0) scopes.add('*')
  return [...scopes]
}

async function flushNotify() {
  const scopes = pendingScopes.has('*') ? ['*'] : [...pendingScopes]
  pendingScopes = new Set()
  const base = shopBaseUrl()
  const secret = String(process.env.REVALIDATE_SECRET || process.env.SHOP_REVALIDATE_SECRET || '').trim()
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (secret) {
    headers['X-Revalidate-Secret'] = secret
    headers.Authorization = `Bearer ${secret}`
  }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 4000)
    const res = await fetch(`${base}/api/revalidate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ scopes }),
      signal: ctrl.signal,
    })
    clearTimeout(t)
    if (!res.ok && process.env.NODE_ENV !== 'production') {
      console.warn('[shop-revalidate] shop answered', res.status, await res.text().catch(() => ''))
    }
  } catch (e) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[shop-revalidate]', e?.message || e)
    }
  }
}

/**
 * @param {{ scopes?: string[] | string, path?: string }} [opts]
 */
function notifyShopRevalidate(opts = {}) {
  const fromPath = opts.path ? scopesForAdminPath(opts.path) : []
  const raw = opts.scopes
  const list = Array.isArray(raw) ? raw : raw ? [raw] : fromPath.length ? fromPath : ['*']
  for (const s of list) pendingScopes.add(String(s || '*'))
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    flushNotify().catch(() => {})
  }, 250)
}

/**
 * Express middleware: after successful admin-hub mutating responses, notify the shop.
 */
function shopRevalidateAdminWriteMiddleware(req, res, next) {
  const method = String(req.method || '').toUpperCase()
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return next()
  const path = String(req.originalUrl || req.url || req.path || '').split('?')[0]
  const isAdminHub = path.includes('/admin-hub')
  const isCatalogAdmin =
    path.includes('/admin/products') ||
    path.includes('/admin/collections') ||
    path.includes('/admin/product-categories')
  if (!isAdminHub && !isCatalogAdmin) return next()
  // Skip pure auth / session noise
  if (/\/admin-hub\/(auth|login|logout|session|me)(\/|$)/i.test(path)) return next()
  if (/\/admin\/auth(\/|$)/i.test(path)) return next()

  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      notifyShopRevalidate({ path })
    }
  })
  next()
}

module.exports = {
  notifyShopRevalidate,
  shopRevalidateAdminWriteMiddleware,
  scopesForAdminPath,
  shopBaseUrl,
}
