import './tab-scoped-auth-storage';
import { formatApiError, getClientLocale } from './api-error-messages';
import { reportSellerClientError } from './report-seller-client-error';

/**
 * Medusa Admin API Client for Sellercentral
 * 
 * Sellercentral'dan Medusa backend'e product eklemek için REST API client
 */

/** Andertal production backend — used when NEXT_PUBLIC_MEDUSA_BACKEND_URL is unset. Local: set .env to http://localhost:9000 */
const DEFAULT_PUBLIC_MEDUSA_URL = 'https://api.andertal.com';

const getDefaultBaseUrl = () => {
  const env = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || '';
  const url = (typeof env === 'string' ? env : '').trim();
  if (url) return url.replace(/\/$/, '');
  return DEFAULT_PUBLIC_MEDUSA_URL.replace(/\/$/, '');
};

const MEDUSA_BACKEND_URL = getDefaultBaseUrl();

class MedusaAdminClient {
  constructor(baseURL = MEDUSA_BACKEND_URL, overrideToken = null) {
    this.baseURL = (baseURL || MEDUSA_BACKEND_URL).replace(/\/$/, '');
    this.overrideToken = overrideToken || null;
    this._uiLocale = null;
  }

  /** Panel shop locale for auto-translated category names (de, en, tr, …). */
  setUiLocale(locale) {
    const l = String(locale || '').slice(0, 2).toLowerCase();
    this._uiLocale = l || null;
  }

  _categoryLocaleParam(extraLocale) {
    const loc = extraLocale || this._uiLocale;
    return loc ? `locale=${encodeURIComponent(String(loc).slice(0, 2).toLowerCase())}` : '';
  }

  /**
   * Generic API request helper
   */
  async request(endpoint, options = {}) {
    const base = (typeof getDefaultBaseUrl === 'function' ? getDefaultBaseUrl() : null) || this.baseURL;
    const url = `${base}${endpoint}`;

    if (!url || url.startsWith('undefined')) {
      const err = new Error('Backend URL is not set. Set NEXT_PUBLIC_MEDUSA_BACKEND_URL (e.g. https://api.andertal.com).');
      console.error('Medusa Admin API Error:', err.message);
      throw err;
    }

    // Use override token (impersonation) or fall back to localStorage
    const token = this.overrideToken || (typeof window !== 'undefined' ? localStorage.getItem('sellerToken') : null);
    const config = {
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...options.headers,
      },
      ...options,
    };

    try {
      const response = await fetch(url, config);

      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({ message: response.statusText }));
        const msg = errorBody?.message || errorBody?.error || response.statusText;
        const rawMsg = typeof msg === 'string' ? msg : `HTTP ${response.status}`;
        const err = new Error(formatApiError({ message: rawMsg }, getClientLocale()));
        err.originalMessage = rawMsg;
        err.statusCode = response.status;
        err.code = errorBody?.code || null;
        err.evaluation = errorBody?.evaluation || null;
        err.body = errorBody;
        throw err;
      }

      return await response.json();
    } catch (error) {
      const isNetworkError = error?.message === 'Failed to fetch' || error?.name === 'TypeError' || error?.code === 'ECONNREFUSED';
      const method = (options?.method || 'GET').toUpperCase();
      const rawFriendly = isNetworkError
        ? `Backend unreachable (${method} ${endpoint}). Set NEXT_PUBLIC_MEDUSA_BACKEND_URL to your backend URL (e.g. https://api.andertal.com) and ensure the backend is running.`
        : (error?.message || 'Request failed');
      const out = new Error(formatApiError({ message: rawFriendly }, getClientLocale()));
      out.originalMessage = rawFriendly;
      out.statusCode = error?.statusCode;
      out.code = error?.code || null;
      out.evaluation = error?.evaluation || null;
      out.body = error?.body || null;
      out.cause = error;
      if (error?.statusCode === 404 || error?.statusCode === 503 || isNetworkError) {
        console.warn(`Medusa Admin API (${endpoint}):`, error?.message || error?.statusCode);
      } else {
        const errMsg = error?.message ?? (typeof error === 'string' ? error : 'Request failed');
        console.warn(`Medusa Admin API (${endpoint}):`, errMsg);
      }
      const statusCode = out.statusCode || error?.statusCode;
      if (statusCode === 429 || statusCode >= 500 || isNetworkError) {
        reportSellerClientError({
          errorCode: statusCode ? `HTTP_${statusCode}` : 'NETWORK_ERROR',
          errorMessage: out.originalMessage || rawFriendly,
          context: `${method} ${endpoint}`,
          terminalOutput: isNetworkError ? String(error?.message || '') : null,
        }).catch(() => {});
      }
      throw out;
    }
  }

  /**
   * Products (returns { products, count }; on 404/5xx returns empty list so Dashboard/Inventory don't break)
   */
  async getProducts(params = {}) {
    const queryParams = new URLSearchParams(params).toString()
    try {
      return await this.request(`/admin/products${queryParams ? `?${queryParams}` : ''}`)
    } catch (err) {
      const code = err?.statusCode
      const msg = (err?.message || '').toLowerCase()
      if (code === 404 || code === 500 || code === 503 || msg.includes('404') || msg.includes('not found') || msg.includes('500') || msg.includes('503')) {
        return { products: [], count: 0 }
      }
      throw err
    }
  }

  async getProduct(id) {
    return this.request(`/admin/products/${id}`)
  }

  async createProduct(data) {
    return this.request('/admin/products', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  /**
   * Admin Hub Products (DB: admin_hub_products – collections/menus gibi veritabanına bağlı)
   * Backend erişilemezse boş liste döner, sayfa çökmez.
   */
  async getAdminHubProducts(params = {}) {
    // Non-superusers only see their own products
    const isSuperuser = typeof window !== 'undefined' && localStorage.getItem('sellerIsSuperuser') === 'true';
    const sellerId = typeof window !== 'undefined' ? localStorage.getItem('sellerId') : null;
    const filteredParams = { ...params };
    if (!isSuperuser && sellerId && !filteredParams.seller_id) {
      filteredParams.seller_id = sellerId;
    }
    const queryParams = new URLSearchParams(filteredParams).toString();
    try {
      const data = await this.request(`/admin-hub/products${queryParams ? `?${queryParams}` : ''}`);
      return { products: data?.products ?? [], count: data?.count ?? data?.products?.length ?? 0 };
    } catch (err) {
      const code = err?.statusCode;
      const msg = (err?.message || '').toLowerCase();
      if (code === 404 || code === 500 || code === 503 || msg.includes('unreachable') || msg.includes('fetch')) {
        return { products: [], count: 0 };
      }
      throw err;
    }
  }

  /** Returns { product, matched_on: "parent"|"variant", matched_variant_ean } or null if no catalog match. */
  async lookupProductByEan(ean) {
    try {
      const res = await this.request(`/admin-hub/products/ean-lookup?ean=${encodeURIComponent(ean)}`);
      if (!res?.product) return null;
      return { product: res.product, matched_on: res.matched_on || "parent", matched_variant_ean: res.matched_variant_ean || null };
    } catch (err) {
      if (err?.statusCode === 404) return null;
      return null;
    }
  }

  async createAdminHubProduct(data) {
    // Always tag the product with the current seller's ID (spread first so callers cannot overwrite seller_id)
    const sellerId = typeof window !== 'undefined' ? localStorage.getItem('sellerId') : null;
    const merged = { ...(data && typeof data === 'object' ? data : {}) };
    if (sellerId) {
      merged.seller_id = sellerId;
      merged.seller = sellerId;
    }
    const res = await this.request('/admin-hub/products', {
      method: 'POST',
      body: JSON.stringify(merged),
    });
    return res?.product ?? res;
  }

  // Like createAdminHubProduct but returns full response including deduplicated flag
  async createAdminHubProductRaw(data) {
    const sellerId = typeof window !== 'undefined' ? localStorage.getItem('sellerId') : null;
    const merged = { ...(data && typeof data === 'object' ? data : {}) };
    if (sellerId) {
      merged.seller_id = sellerId;
      merged.seller = sellerId;
    }
    return this.request('/admin-hub/products', { method: 'POST', body: JSON.stringify(merged) });
  }

  /** GET /admin-hub/products/:id – id (UUID) veya handle ile tek ürün (kısa URL için handle kullan) */
  async getAdminHubProduct(idOrHandle) {
    const res = await this.request(`/admin-hub/products/${encodeURIComponent(idOrHandle)}`);
    return res?.product ?? res;
  }

  /** GET /admin-hub/products/:id – returns { product, seller_listings } */
  async getAdminHubProductFull(idOrHandle) {
    const res = await this.request(`/admin-hub/products/${encodeURIComponent(idOrHandle)}`);
    return { product: res?.product ?? null, seller_listings: res?.seller_listings ?? [] };
  }

  /** PUT /admin-hub/products/:id – ürün güncelle (id veya handle) */
  async updateAdminHubProduct(idOrHandle, data) {
    const res = await this.request(`/admin-hub/products/${encodeURIComponent(idOrHandle)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    // Return full response object so caller can inspect suggestion_submitted / listing_saved flags
    return res;
  }

  /** GET /admin-hub/product-listings-map — { [product_id]: seller_id[] } for master products (superuser) */
  async getProductListingsMap() {
    const res = await this.request('/admin-hub/product-listings-map');
    return res?.map ?? {};
  }

  /** PATCH /admin-hub/products/:id/variants — variant-only update, no GPSR validation */
  async patchProductVariants(idOrHandle, variants) {
    return this.request(`/admin-hub/products/${encodeURIComponent(idOrHandle)}/variants`, {
      method: 'PATCH',
      body: JSON.stringify({ variants }),
    });
  }

  /**
   * POST /admin-hub/v1/products/combine-as-variants
   * Fold standalone products into one parent's variants[]; archives absorbed rows as merged.
   */
  async combineProductsAsVariants({ parentId, productIds, optionName, optionValues } = {}) {
    return this.request('/admin-hub/v1/products/combine-as-variants', {
      method: 'POST',
      body: JSON.stringify({
        parent_id: parentId,
        product_ids: productIds,
        option_name: optionName,
        option_values: optionValues || {},
      }),
    });
  }

  /** DELETE /admin-hub/products/:id */
  async deleteAdminHubProduct(idOrHandle) {
    return this.request(`/admin-hub/products/${encodeURIComponent(idOrHandle)}`, { method: 'DELETE' });
  }

  /** POST /admin-hub/products/:id/eu-origin/verify — Phase 1: manual superuser or stub provider queue */
  async verifyEuOrigin(productId, { manual = false, provider = null, pendingQueueId = null, variantOptionValues = null } = {}) {
    return this.request(`/admin-hub/products/${encodeURIComponent(productId)}/eu-origin/verify`, {
      method: 'POST',
      body: JSON.stringify({
        manual,
        provider,
        pending_queue_id: pendingQueueId,
        ...(Array.isArray(variantOptionValues) ? { variant_option_values: variantOptionValues } : {}),
      }),
    });
  }

  /** GET /admin-hub/eu-origin/pending — superuser document review queue */
  async listEuOriginPending(status = 'pending') {
    return this.request(`/admin-hub/eu-origin/pending?status=${encodeURIComponent(status)}`);
  }

  /** GET /admin-hub/eu-origin/providers */
  async listEuOriginProviders() {
    return this.request('/admin-hub/eu-origin/providers');
  }

  /** GET /admin-hub/metafield-definitions */
  async getMetafieldDefinitions() {
    return this.request('/admin-hub/metafield-definitions');
  }

  /** PUT /admin-hub/metafield-definitions/:key */
  async putMetafieldDefinition(key, data) {
    return this.request(`/admin-hub/metafield-definitions/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  /** DELETE /admin-hub/metafield-definitions/:key */
  async deleteMetafieldDefinition(key) {
    return this.request(`/admin-hub/metafield-definitions/${encodeURIComponent(key)}`, { method: 'DELETE' });
  }

  /** GET /admin-hub/metafield-definitions/pending — superuser only */
  async getMetafieldPendingProposals() {
    return this.request('/admin-hub/metafield-definitions/pending');
  }

  /** POST — seller: queue for approval; superuser: apply to catalog immediately */
  async submitMetafieldCatalogProposal(body) {
    return this.request('/admin-hub/metafield-definitions/proposals', {
      method: 'POST',
      body: JSON.stringify(body || {}),
    });
  }

  async approveMetafieldProposal(id, body = null) {
    return this.request(`/admin-hub/metafield-definitions/pending/${encodeURIComponent(id)}/approve`, {
      method: 'POST',
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  async rejectMetafieldProposal(id) {
    return this.request(`/admin-hub/metafield-definitions/pending/${encodeURIComponent(id)}/reject`, { method: 'POST' });
  }

  /** GET /admin-hub/landing-page/:pageId */
  async getLandingPageContainers(pageId) {
    return this.request(`/admin-hub/landing-page/${encodeURIComponent(pageId)}`);
  }

  /** PUT /admin-hub/landing-page/:pageId — body: { containers, settings? } */
  async saveLandingPageContainers(pageId, payload) {
    const body =
      payload && typeof payload === 'object' && !Array.isArray(payload) && 'containers' in payload
        ? payload
        : { containers: payload, settings: {} };
    return this.request(`/admin-hub/landing-page/${encodeURIComponent(pageId)}`, {
      method: 'PUT',
      body: JSON.stringify({
        containers: body.containers || [],
        settings: body.settings && typeof body.settings === 'object' ? body.settings : {},
      }),
    });
  }

  /** GET /admin-hub/landing-page/category/:categoryId */
  async getLandingPageCategoryContainers(categoryId) {
    return this.request(`/admin-hub/landing-page/category/${encodeURIComponent(categoryId)}`);
  }

  /** PUT /admin-hub/landing-page/category/:categoryId — body: { containers, settings } */
  async saveLandingPageCategoryContainers(categoryId, payload) {
    return this.request(`/admin-hub/landing-page/category/${encodeURIComponent(categoryId)}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  /** GET /admin-hub/styles */
  async getStyles() {
    return this.request('/admin-hub/styles');
  }

  /** PUT /admin-hub/styles */
  async saveStyles(styles) {
    return this.request('/admin-hub/styles', {
      method: 'PUT',
      body: JSON.stringify({ styles }),
    });
  }

  /** GET /admin-hub/seller-settings – pass sellerIdOverride='default' for platform-wide settings */
  async getSellerSettings(sellerIdOverride = null) {
    const sellerId = sellerIdOverride || (typeof window !== 'undefined' ? localStorage.getItem('sellerId') : null);
    const params = sellerId ? `?seller_id=${encodeURIComponent(sellerId)}` : '';
    const res = await this.request(`/admin-hub/seller-settings${params}`).catch(() => ({ store_name: '' }));
    return {
      store_name: res?.store_name ?? '',
      free_shipping_threshold_cents: res?.free_shipping_threshold_cents ?? null,
      free_shipping_thresholds: res?.free_shipping_thresholds ?? null,
      shop_logo_url: res?.shop_logo_url ?? '',
      shop_favicon_url: res?.shop_favicon_url ?? '',
      sellercentral_logo_url: res?.sellercentral_logo_url ?? '',
      sellercentral_favicon_url: res?.sellercentral_favicon_url ?? '',
      shop_logo_height: res?.shop_logo_height != null ? Number(res.shop_logo_height) : 34,
      sellercentral_logo_height: res?.sellercentral_logo_height != null ? Number(res.sellercentral_logo_height) : 30,
      storefront_url: res?.storefront_url ?? '',
      announcement_bar_items: Array.isArray(res?.announcement_bar_items) ? res.announcement_bar_items : [],
      logo_config: res?.logo_config && typeof res.logo_config === 'object' ? res.logo_config : null,
      barcode_scanner_config: res?.barcode_scanner_config && typeof res.barcode_scanner_config === 'object' ? res.barcode_scanner_config : null,
      legal_company_name: res?.legal_company_name ?? '',
      legal_representative: res?.legal_representative ?? '',
      legal_street: res?.legal_street ?? '',
      legal_city: res?.legal_city ?? '',
      legal_trade_register: res?.legal_trade_register ?? '',
      legal_register_court: res?.legal_register_court ?? '',
      legal_vat_id: res?.legal_vat_id ?? '',
      legal_tax_id: res?.legal_tax_id ?? '',
      legal_email: res?.legal_email ?? '',
      enabled_shop_locales: Array.isArray(res?.enabled_shop_locales) ? res.enabled_shop_locales : null,
      locale: ['en', 'de', 'tr', 'fr', 'it', 'es'].includes(String(res?.locale || '').toLowerCase())
        ? String(res.locale).toLowerCase()
        : 'de',
    };
  }

  /** PATCH /admin-hub/seller-settings – save store name to DB */
  async updateSellerSettings(data) {
    const explicitId = data?.seller_id != null ? String(data.seller_id).trim() : '';
    const sellerId =
      explicitId ||
      (typeof window !== 'undefined' ? localStorage.getItem('sellerId') : null) ||
      'default';
    const body = { ...data, seller_id: sellerId };
    const res = await this.request('/admin-hub/seller-settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    return res;
  }

  async updateProduct(id, data) {
    return this.request(`/admin/products/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deleteProduct(id) {
    return this.request(`/admin/products/${id}`, {
      method: 'DELETE',
    })
  }

  /**
   * Admin Hub Categories (Platform owner managed)
   * Backend: GET /admin-hub/categories veya GET /admin-hub/v1/categories
   * Production: NEXT_PUBLIC_MEDUSA_BACKEND_URL = https://api.andertal.com
   */
  async getAdminHubCategories(filters = {}) {
    const { all, locale, ...rest } = filters
    const params = { ...(all ? rest : { active: 'true', ...rest }) }
    const loc = locale || this._uiLocale
    if (loc) params.locale = String(loc).slice(0, 2).toLowerCase()
    const queryParams = new URLSearchParams(params).toString()
    const paths = [
      `/admin-hub/categories?${queryParams}`,
      `/admin-hub/v1/categories?${queryParams}`,
    ]
    let lastErr = null
    for (const path of paths) {
      try {
        const data = await this.request(path)
        if (data.categories != null) return data
        if (Array.isArray(data.tree)) return { categories: data.tree, count: data.tree.length }
        return { categories: [], count: 0 }
      } catch (err) {
        lastErr = err
        const code = err?.statusCode
        const msg = (err?.message || '').toLowerCase()
        if (code === 503 || msg.includes('admin hub service not available')) {
          console.warn('getAdminHubCategories: Admin Hub unavailable — empty list')
          return { categories: [], count: 0 }
        }
        if (!err.message || !err.message.includes('404')) throw err
      }
    }
    throw lastErr
  }

  /**
   * @deprecated Use getAdminHubCategories() instead
   * Medusa product-categories endpoint (read-only, deprecated)
   */
  async getCategories() {
    console.warn('⚠️  getCategories() is deprecated. Use getAdminHubCategories() instead.')
    return this.request('/admin/product-categories')
  }

  /**
   * Resolved compliance schema (required/optional fields) for a category + marketplace
   * (docs/HUKUKI.md). Read-only — not wired into any save/publish flow yet.
   */
  async getCategoryComplianceSchema(categoryId, marketplace = 'DE') {
    if (!categoryId) return null
    return this.request(`/admin-hub/categories/${categoryId}/compliance-schema?marketplace=${encodeURIComponent(marketplace)}`)
  }

  /** Superuser: full compliance profile catalog, for the per-category override picker. */
  async getComplianceProfiles() {
    const data = await this.request('/admin-hub/v1/compliance-profiles').catch(() => ({ profiles: [] }))
    return { profiles: data.profiles || [] }
  }

  /** Superuser: every category's effective compliance profile (own/inherited/default) in one call. */
  async getComplianceOverview() {
    const data = await this.request('/admin-hub/v1/categories/compliance-overview').catch(() => ({ categories: [] }))
    return { categories: data.categories || [] }
  }

  /** Superuser: set (profileId) or clear (null) a category's own compliance profile override. */
  async setCategoryComplianceProfile(categoryId, profileId) {
    return this.request(`/admin-hub/v1/categories/${categoryId}/compliance-profile`, {
      method: 'PATCH',
      body: JSON.stringify({ profile_id: profileId || null }),
    })
  }

  /**
   * Bulk import Admin Hub categories (POST /admin-hub/categories/import)
   * Body: { items: [ { key, label, parentKey, sortOrder } ] }
   */
  async importAdminHubCategories(items) {
    return this.request('/admin-hub/categories/import', {
      method: 'POST',
      body: JSON.stringify({ items }),
    })
  }

  /**
   * Create Admin Hub category (POST)
   */
  async createAdminHubCategory(data) {
    const opts = { method: 'POST', body: JSON.stringify(data) }
    try {
      return await this.request('/admin-hub/v1/categories', opts)
    } catch (err) {
      if (err?.message?.includes('404')) {
        return await this.request('/admin-hub/categories', opts)
      }
      throw err
    }
  }

  /**
   * Get single Admin Hub category by ID
   */
  async getAdminHubCategory(id, locale) {
    const locQ = this._categoryLocaleParam(locale)
    const data = await this.request(`/admin-hub/v1/categories/${id}${locQ ? `?${locQ}` : ''}`)
    return data?.category || null
  }

  /**
   * Update Admin Hub category (PUT)
   */
  async updateAdminHubCategory(id, data) {
    return this.request(`/admin-hub/v1/categories/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  /**
   * Delete Admin Hub category (DELETE)
   */
  async deleteAdminHubCategory(id) {
    return this.request(`/admin-hub/v1/categories/${id}`, {
      method: 'DELETE',
    })
  }

  /**
   * Get collections with collection pages (has_collection = true)
   */
  async getCollections() {
    const data = await this.request('/admin-hub/v1/categories?active=true')
    const collections = (data.categories || []).filter(cat => cat.has_collection === true)
    return { collections, count: collections.length }
  }

  /**
   * List collections. For Products > Collections page use adminHub: true (our endpoint, no 503).
   * For category form "Link to existing" use getMedusaCollections({ medusa_only: true }) with adminHub: false.
   */
  async getMedusaCollections(params = {}) {
    const q = params.medusa_only ? '?medusa_only=true' : ''
    const base = params.adminHub === true ? '/admin-hub/collections' : '/admin/collections'
    const data = await this.request(`${base}${q}`)
    return { collections: data.collections || [], count: data.count || 0 }
  }

  async getBrands() {
    const data = await this.request('/admin-hub/brands').catch(() => ({ brands: [] }))
    return { brands: data.brands || [] }
  }

  async createBrand(body) {
    const res = await this.request('/admin-hub/brands', { method: 'POST', body: JSON.stringify(body || {}) })
    return res.brand ?? res
  }

  async updateBrand(id, body) {
    const res = await this.request(`/admin-hub/brands/${id}`, { method: 'PATCH', body: JSON.stringify(body || {}) })
    return res.brand ?? res
  }

  async deleteBrand(id) {
    return this.request(`/admin-hub/brands/${id}`, { method: 'DELETE' })
  }

  /** Upload a brand authorization document (trademark certificate, invoice, distribution agreement...) */
  async uploadBrandAuthDocument(brandId, body) {
    const res = await this.request(`/admin-hub/brands/${brandId}/authorization-documents`, { method: 'POST', body: JSON.stringify(body || {}) })
    return res.document ?? res
  }

  /** Superuser: products flagged needs_compliance_review (metadata.compliance_review.ok === false) */
  async getComplianceReviewProducts() {
    const data = await this.request('/admin-hub/v1/compliance-review').catch(() => ({ products: [] }))
    return { products: data.products || [] }
  }

  /** Superuser: sellers with money owed (14d+ delivered, unrefunded) but no valid IBAN on file —
   * runSellerIbanPayoutsIfDue silently skips these on every payout run, so without this list a
   * seller's earned money can sit unpaid indefinitely with nobody noticing. */
  async getSellersMissingIban() {
    const data = await this.request('/admin-hub/v1/sellers-missing-iban').catch(() => ({ sellers: [] }))
    return { sellers: data.sellers || [] }
  }

  /** Superuser: list brands pending authorization review (own_registered / authorized_reseller), with their documents */
  async getPendingBrandAuthorizations() {
    const data = await this.request('/admin-hub/brands/pending-authorizations').catch(() => ({ brands: [] }))
    return { brands: data.brands || [] }
  }

  /** Superuser: approve a pending brand authorization claim */
  async approveBrandAuthorization(brandId) {
    const res = await this.request(`/admin-hub/brands/${brandId}/authorization/approve`, { method: 'POST', body: JSON.stringify({}) })
    return res.brand ?? res
  }

  /** Superuser: reject a pending brand authorization claim */
  async rejectBrandAuthorization(brandId, rejection_reason) {
    const res = await this.request(`/admin-hub/brands/${brandId}/authorization/reject`, { method: 'POST', body: JSON.stringify({ rejection_reason: rejection_reason || '' }) })
    return res.brand ?? res
  }

  /** Get single collection by id (standalone admin_hub_collections only) */
  async getCollection(id) {
    if (!id) return null
    try {
      const data = await this.request(`/admin-hub/collections/${id}`)
      return data.collection || null
    } catch {
      return null
    }
  }

  async createCollection(data) {
    const body = { title: data.title, handle: data.handle }
    if (data.standalone === true) body.standalone = true
    if (data.category_id) body.category_id = data.category_id
    const endpoint = '/admin-hub/collections'
    const res = await this.request(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return res.collection
  }

  async updateCollection(id, data) {
    const body = {}
    if (data.title !== undefined) body.title = data.title
    if (data.handle !== undefined) body.handle = data.handle
    if (Object.prototype.hasOwnProperty.call(data, 'category_id')) body.category_id = data.category_id
    if (data.display_title !== undefined) body.display_title = data.display_title
    if (data.meta_title !== undefined) body.meta_title = data.meta_title
    if (data.meta_description !== undefined) body.meta_description = data.meta_description
    if (data.keywords !== undefined) body.keywords = data.keywords
    if (data.richtext !== undefined) body.richtext = data.richtext
    if (data.image_url !== undefined) body.image_url = data.image_url
    if (data.banner_image_url !== undefined) body.banner_image_url = data.banner_image_url
    if (data.recommended_product_ids !== undefined) body.recommended_product_ids = data.recommended_product_ids
    const res = await this.request(`/admin-hub/collections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    })
    return res.collection
  }

  async deleteCollection(id) {
    return this.request(`/admin-hub/collections/${id}`, { method: 'DELETE' })
  }

  /**
   * Menu locations (where menus can appear: main, subnav, footer columns). Used for Location dropdown.
   */
  async getMenuLocations() {
    const data = await this.request('/admin-hub/menu-locations')
    return { locations: data.locations || [] }
  }

  /**
   * Admin Hub Menus – on 503 or any error returns empty list so menu page always loads.
   */
  async getMenus() {
    try {
      const data = await this.request('/admin-hub/menus')
      return { menus: data.menus || [], count: data.count ?? (data.menus || []).length }
    } catch (_) {
      return { menus: [], count: 0 }
    }
  }

  async getMenu(id) {
    const data = await this.request(`/admin-hub/menus/${id}`)
    return data.menu
  }

  async createMenu(body) {
    const data = await this.request('/admin-hub/menus', { method: 'POST', body: JSON.stringify(body) })
    return data.menu
  }

  async updateMenu(id, body) {
    const data = await this.request(`/admin-hub/menus/${id}`, { method: 'PUT', body: JSON.stringify(body) })
    return data.menu
  }

  async deleteMenu(id) {
    return this.request(`/admin-hub/menus/${id}`, { method: 'DELETE' })
  }

  async getMenuItems(menuId) {
    try {
      const data = await this.request(`/admin-hub/menus/${menuId}/items`)
      return { items: data.items || [], count: data.count ?? (data.items || []).length }
    } catch (_) {
      return { items: [], count: 0 }
    }
  }

  async createMenuItem(menuId, body) {
    const data = await this.request(`/admin-hub/menus/${menuId}/items`, { method: 'POST', body: JSON.stringify(body) })
    return data.item
  }

  async updateMenuItem(menuId, itemId, body) {
    const data = await this.request(`/admin-hub/menus/${menuId}/items/${itemId}`, { method: 'PUT', body: JSON.stringify(body) })
    return data.item
  }

  async deleteMenuItem(menuId, itemId) {
    return this.request(`/admin-hub/menus/${menuId}/items/${itemId}`, { method: 'DELETE' })
  }

  /**
   * Admin Hub Banners
   */
  async getBanners(params = {}) {
    const queryParams = new URLSearchParams(params).toString()
    return this.request(`/admin-hub/v1/banners${queryParams ? `?${queryParams}` : ''}`)
  }

  async getBanner(id) {
    return this.request(`/admin-hub/v1/banners/${id}`)
  }

  async createBanner(data) {
    return this.request('/admin-hub/v1/banners', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateBanner(id, data) {
    return this.request(`/admin-hub/v1/banners/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deleteBanner(id) {
    return this.request(`/admin-hub/v1/banners/${id}`, {
      method: 'DELETE',
    })
  }

  /**
   * Admin Hub Media (v1)
   */
  async getMedia(params = {}) {
    const p = { limit: 500, ...params }
    const queryParams = new URLSearchParams(p).toString()
    return this.request(`/admin-hub/v1/media${queryParams ? `?${queryParams}` : ''}`)
  }

  async getMediaItem(id) {
    return this.request(`/admin-hub/v1/media/${id}`)
  }

  async uploadMedia(formData, opts = {}) {
    const base = this.baseURL || getDefaultBaseUrl()
    const qs = new URLSearchParams()
    if (opts.purpose) qs.set('purpose', String(opts.purpose))
    const q = qs.toString()
    const url = `${base}/admin-hub/v1/media${q ? `?${q}` : ''}`
    const token = typeof window !== 'undefined' ? localStorage.getItem('sellerToken') : null
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }))
      throw new Error(err.message || `HTTP ${res.status}`)
    }
    return res.json()
  }

  async registerMediaUrl(data) {
    const base = (typeof getDefaultBaseUrl === 'function' ? getDefaultBaseUrl() : null) || this.baseURL
    const token = typeof window !== 'undefined' ? localStorage.getItem('sellerToken') : null
    const res = await fetch(`${base}/admin-hub/v1/media/add-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(data),
    })
    if (!res.ok) { const e = await res.json().catch(() => ({ message: res.statusText })); throw new Error(e.message || `HTTP ${res.status}`) }
    return res.json()
  }

  async deleteMedia(id) {
    return this.request(`/admin-hub/v1/media/${id}`, { method: 'DELETE' })
  }

  async getMediaFolders() {
    const base = (typeof getDefaultBaseUrl === 'function' ? getDefaultBaseUrl() : null) || this.baseURL
    const token = typeof window !== 'undefined' ? localStorage.getItem('sellerToken') : null
    const res = await fetch(`${base}/admin-hub/v1/media/folders`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok) return { folders: [] }
    return res.json()
  }

  async createMediaFolder(name) {
    const base = (typeof getDefaultBaseUrl === 'function' ? getDefaultBaseUrl() : null) || this.baseURL
    const token = typeof window !== 'undefined' ? localStorage.getItem('sellerToken') : null
    const res = await fetch(`${base}/admin-hub/v1/media/folders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) { const e = await res.json().catch(() => ({ message: res.statusText })); throw new Error(e.message || `HTTP ${res.status}`) }
    return res.json()
  }

  async deleteMediaFolder(id) {
    return this.request(`/admin-hub/v1/media/folders/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async updateMedia(id, data) {
    return this.request(`/admin-hub/v1/media/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) })
  }

  async addMediaByUrl(data) {
    return this.request('/admin-hub/v1/media/add-url', { method: 'POST', body: JSON.stringify(data) })
  }

  /**
   * Admin Hub Pages (v1)
   */
  async getPages(params = {}) {
    const sp = new URLSearchParams();
    if (params.limit != null && params.limit !== '') sp.set('limit', String(params.limit));
    if (params.offset != null && params.offset !== '') sp.set('offset', String(params.offset));
    if (params.status) sp.set('status', String(params.status));
    if (params.page_type) sp.set('page_type', String(params.page_type));
    if (params.sort) sp.set('sort', String(params.sort));
    const qs = sp.toString();
    return this.request(`/admin-hub/v1/pages${qs ? `?${qs}` : ''}`)
  }

  async getPage(id) {
    return this.request(`/admin-hub/v1/pages/${id}`)
  }

  /** Settings for a hardcoded API-driven storefront page (/bestsellers, /sales) — not a CMS container page. */
  async getApiPageSettings(slug) {
    return this.request(`/admin-hub/v1/api-page-settings/${encodeURIComponent(slug)}`)
  }

  async updateApiPageSettings(slug, data) {
    return this.request(`/admin-hub/v1/api-page-settings/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async createPage(data) {
    return this.request('/admin-hub/v1/pages', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updatePage(id, data) {
    return this.request(`/admin-hub/v1/pages/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deletePage(id) {
    return this.request(`/admin-hub/v1/pages/${id}`, { method: 'DELETE' })
  }

  /**
   * Orders (admin)
   */
  async getOrders(params = {}) {
    // Non-superusers only see their own orders
    const isSuperuser = typeof window !== 'undefined' && localStorage.getItem('sellerIsSuperuser') === 'true';
    const sellerId = typeof window !== 'undefined' ? localStorage.getItem('sellerId') : null;
    const filteredParams = { ...params };
    if (!isSuperuser && sellerId && !filteredParams.seller_id) {
      filteredParams.seller_id = sellerId;
    }
    const queryParams = new URLSearchParams(filteredParams).toString()
    try {
      return await this.request(`/admin-hub/v1/orders${queryParams ? `?${queryParams}` : ''}`)
    } catch (err) {
      if (err?.statusCode === 429) {
        return { orders: [], count: 0, rateLimited: true }
      }
      if (err?.statusCode >= 500 || err?.statusCode === 503) {
        return { orders: [], count: 0, serverError: true }
      }
      throw err
    }
  }

  async getOrder(id) {
    return this.request(`/admin-hub/v1/orders/${id}`)
  }

  async updateOrder(id, data) {
    return this.request(`/admin-hub/v1/orders/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
  }

  async deleteOrder(id) {
    return this.request(`/admin-hub/v1/orders/${id}`, { method: 'DELETE' })
  }

  /** Add a real catalog product as a new line item on an existing order (order detail "Hinzufügen"). */
  async addOrderItem(id, { product_id, quantity = 1 }) {
    return this.request(`/admin-hub/v1/orders/${id}/items`, { method: 'POST', body: JSON.stringify({ product_id, quantity }) })
  }

  /** Superuser: which flow emails fired for this order and whether they actually sent. */
  async getOrderFlowLogs(id) {
    return this.request(`/admin-hub/v1/orders/${id}/flow-logs`)
  }

  /** Superuser: aktive Shop-Besucher (Live View) */
  async getLiveVisitors(params = {}) {
    const queryParams = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
    ).toString();
    return this.request(`/admin-hub/v1/live-visitors${queryParams ? `?${queryParams}` : ''}`);
  }

  async getShipmentEvents(orderId) {
    return this.request(`/admin-hub/v1/orders/${encodeURIComponent(orderId)}/shipment-events`)
  }

  async addShipmentEvent(orderId, data) {
    return this.request(`/admin-hub/v1/orders/${encodeURIComponent(orderId)}/shipment-events`, { method: 'POST', body: JSON.stringify(data) })
  }

  async deleteShipmentEvent(eventId) {
    return this.request(`/admin-hub/v1/shipment-events/${encodeURIComponent(eventId)}`, { method: 'DELETE' })
  }

  async refreshTracking(orderId) {
    return this.request(`/admin-hub/v1/orders/${encodeURIComponent(orderId)}/refresh-tracking`, { method: 'POST' })
  }

  async getCustomers(params = {}) {
    const queryParams = new URLSearchParams(params).toString()
    return this.request(`/admin-hub/v1/customers${queryParams ? `?${queryParams}` : ''}`)
  }

  async getCustomerById(id) {
    return this.request(`/admin-hub/v1/customers/${encodeURIComponent(id)}`)
  }

  async createCustomer(data) {
    return this.request('/admin-hub/v1/customers', { method: 'POST', body: JSON.stringify(data) })
  }

  async updateCustomer(id, data) {
    return this.request(`/admin-hub/v1/customers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) })
  }

  async deleteCustomer(id) {
    return this.request(`/admin-hub/v1/customers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async createCustomerDiscount(customerId, data) {
    return this.request(`/admin-hub/v1/customers/${encodeURIComponent(customerId)}/discounts`, {
      method: 'POST', body: JSON.stringify(data)
    })
  }

  async deleteCustomerDiscount(customerId, discountId) {
    return this.request(`/admin-hub/v1/customers/${encodeURIComponent(customerId)}/discounts/${encodeURIComponent(discountId)}`, {
      method: 'DELETE'
    })
  }

  async addCustomerBonusLedgerEntry(customerId, data) {
    return this.request(`/admin-hub/v1/customers/${encodeURIComponent(customerId)}/bonus-ledger`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    })
  }

  async updateCustomerBonusLedgerEntry(customerId, entryId, data) {
    return this.request(
      `/admin-hub/v1/customers/${encodeURIComponent(customerId)}/bonus-ledger/${encodeURIComponent(entryId)}`,
      { method: 'PATCH', body: JSON.stringify(data || {}) },
    )
  }

  async deleteCustomerBonusLedgerEntry(customerId, entryId) {
    return this.request(
      `/admin-hub/v1/customers/${encodeURIComponent(customerId)}/bonus-ledger/${encodeURIComponent(entryId)}`,
      { method: 'DELETE' },
    )
  }

  async createOrder(data) {
    return this.request('/admin-hub/v1/orders', { method: 'POST', body: JSON.stringify(data) })
  }

  async getCarriers() {
    return this.request('/admin-hub/v1/shipping-carriers').catch(() => ({ carriers: [] }))
  }

  async createCarrier(data) {
    return this.request('/admin-hub/v1/shipping-carriers', { method: 'POST', body: JSON.stringify(data) })
  }

  async updateCarrier(id, data) {
    return this.request(`/admin-hub/v1/shipping-carriers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) })
  }

  async deleteCarrier(id) {
    return this.request(`/admin-hub/v1/shipping-carriers/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async getIntegrations() {
    return this.request('/admin-hub/v1/integrations').catch(() => ({ integrations: [] }))
  }

  async saveIntegration(data) {
    return this.request('/admin-hub/v1/integrations', { method: 'POST', body: JSON.stringify(data) })
  }

  async updateIntegration(id, data) {
    return this.request(`/admin-hub/v1/integrations/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) })
  }

  async deleteIntegration(id) {
    return this.request(`/admin-hub/v1/integrations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  /** Superuser: Trustpilot Business Unit ID for storefront TrustBox (slug trustpilot). */
  async getTrustpilotIntegration() {
    return this.request('/admin-hub/v1/integrations/trustpilot')
  }

  async saveTrustpilotIntegration(data) {
    return this.request('/admin-hub/v1/integrations/trustpilot', { method: 'PUT', body: JSON.stringify(data) })
  }

  async getSendcloudIntegration() {
    return this.request('/admin-hub/v1/integrations/sendcloud')
  }
  async saveSendcloudIntegration(data) {
    return this.request('/admin-hub/v1/integrations/sendcloud', { method: 'PUT', body: JSON.stringify(data) })
  }
  async testSendcloudIntegration(data) {
    return this.request('/admin-hub/v1/integrations/sendcloud/test', { method: 'POST', body: JSON.stringify(data) })
  }

  async getResendIntegration() {
    return this.request('/admin-hub/v1/integrations/resend')
  }
  async saveResendIntegration(data) {
    return this.request('/admin-hub/v1/integrations/resend', { method: 'PUT', body: JSON.stringify(data) })
  }
  async testResendIntegration(data) {
    return this.request('/admin-hub/v1/integrations/resend/test', { method: 'POST', body: JSON.stringify(data) })
  }

  async getLabelRates(orderId, body) {
    return this.request(`/admin-hub/v1/orders/${encodeURIComponent(orderId)}/label/rates`, { method: 'POST', body: JSON.stringify(body) })
  }
  /** Buys the label synchronously — charges seller balance/card, no Stripe Checkout redirect. */
  async purchaseLabel(orderId, body) {
    return this.request(`/admin-hub/v1/orders/${encodeURIComponent(orderId)}/label/purchase`, { method: 'POST', body: JSON.stringify(body) })
  }

  async testBillbeeIntegration(data) {
    return this.request('/admin-hub/v1/integrations/billbee/test', {
      method: 'POST',
      body: JSON.stringify(data || {}),
    })
  }

  async getBillbeeCredentials() {
    return this.request('/admin-hub/v1/integrations/billbee/credentials')
  }

  async patchBillbeeCredentials(data) {
    return this.request('/admin-hub/v1/integrations/billbee/credentials', {
      method: 'PATCH',
      body: JSON.stringify(data || {}),
    })
  }

  async regenerateBillbeeCredentials() {
    return this.request('/admin-hub/v1/integrations/billbee/credentials', {
      method: 'POST',
      body: JSON.stringify({ regenerate: true }),
    })
  }

  async getBillbeeWebhookUrl() {
    return this.request('/admin-hub/v1/integrations/billbee/webhook-url')
  }

  /** Andertal-issued Billbee marketplace API (GET /api/billbee/*) connection strings */
  async getBillbeeMarketplaceConnection() {
    return this.request('/admin-hub/v1/billbee/connection')
  }

  async rotateBillbeeMarketplaceSecret() {
    return this.request('/admin-hub/v1/billbee/connection/rotate-secret', { method: 'POST' })
  }

  async getAbandonedCarts() {
    return this.request('/admin-hub/v1/abandoned-carts')
  }

  async markAbandonedCartRemoved(id) {
    return this.request(`/admin-hub/v1/abandoned-carts/${encodeURIComponent(id)}/mark-removed`, { method: 'POST' })
  }

  async bulkMarkAbandonedCartsRemoved() {
    return this.request('/admin-hub/v1/abandoned-carts/bulk-mark-removed', { method: 'POST' })
  }

  async getReturns(params = {}) {
    const isSuperuser = typeof window !== 'undefined' && localStorage.getItem('sellerIsSuperuser') === 'true';
    const sellerId = typeof window !== 'undefined' ? localStorage.getItem('sellerId') : null;
    const p = { ...params };
    if (!isSuperuser && sellerId && !p.seller_id) p.seller_id = sellerId;
    const qs = Object.keys(p).length ? '?' + new URLSearchParams(p).toString() : '';
    return this.request(`/admin-hub/v1/returns${qs}`)
  }

  async createReturn(data) {
    return this.request('/admin-hub/v1/returns', { method: 'POST', body: JSON.stringify(data) })
  }

  async updateReturn(id, data) {
    return this.request(`/admin-hub/v1/returns/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
  }

  async approveReturn(id) {
    return this.updateReturn(id, { status: 'genehmigt' })
  }

  async rejectReturn(id) {
    return this.updateReturn(id, { status: 'abgelehnt' })
  }

  async refundReturn(id, { refund_amount_cents, refund_note }) {
    return this.updateReturn(id, { refund_amount_cents, refund_note, refund_status: 'erstattet' })
  }

  async sendReturnLabel(id) {
    return this.request(`/admin-hub/v1/returns/${id}/send-label`, { method: 'POST' })
  }

  async getDocumentSources() {
    return this.request('/admin-hub/v1/document-sources')
  }
  async updateDocumentSources(sources) {
    return this.request('/admin-hub/v1/document-sources', { method: 'PATCH', body: JSON.stringify(sources) })
  }

  async getNotificationsUnread() {
    return this.request('/admin-hub/v1/notifications/unread')
  }
  async markNotificationsSeen() {
    return this.request('/admin-hub/v1/notifications/mark-seen', { method: 'POST' })
  }
  async getNotificationsFeed(params = {}) {
    const qs = new URLSearchParams(params).toString()
    return this.request(`/admin-hub/v1/notifications/feed${qs ? `?${qs}` : ''}`)
  }
  async deleteNotifications(payload) {
    return this.request('/admin-hub/v1/notifications/delete', { method: 'POST', body: JSON.stringify(payload) })
  }
  async getNewsletterSubscribers(params = {}) {
    // URLSearchParams stringifies `undefined` values as the literal text "undefined",
    // which the backend then treats as a real search term (matches nothing) — strip them first.
    const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''))
    const qs = new URLSearchParams(clean).toString()
    return this.request(`/admin-hub/v1/newsletter-subscribers${qs ? `?${qs}` : ''}`)
  }
  async getNewsletterSubscriber(id) {
    return this.request(`/admin-hub/v1/newsletter-subscribers/${encodeURIComponent(id)}`)
  }
  async createNewsletterSubscriber(data = {}) {
    return this.request('/admin-hub/v1/newsletter-subscribers', {
      method: 'POST',
      body: JSON.stringify(data || {}),
    })
  }
  async updateNewsletterSubscriber(id, data = {}) {
    return this.request(`/admin-hub/v1/newsletter-subscribers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data || {}),
    })
  }
  async deleteNewsletterSubscriber(id) {
    return this.request(`/admin-hub/v1/newsletter-subscribers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    })
  }
  async getMessages(params = {}) {
    const isSuperuser = typeof window !== 'undefined' && localStorage.getItem('sellerIsSuperuser') === 'true';
    const sellerId = typeof window !== 'undefined' ? localStorage.getItem('sellerId') : null;
    const p = { ...params };
    if (!isSuperuser && sellerId && !p.seller_id) p.seller_id = sellerId;
    const qs = Object.keys(p).length ? '?' + new URLSearchParams(p).toString() : '';
    return this.request(`/admin-hub/v1/messages${qs}`)
  }
  async getSupportMessages(params = {}) {
    const isSuperuser = typeof window !== 'undefined' && localStorage.getItem('sellerIsSuperuser') === 'true';
    const sellerId = typeof window !== 'undefined' ? localStorage.getItem('sellerId') : null;
    const p = { ...params, channel: 'support' };
    if (!isSuperuser && sellerId && !p.seller_id) p.seller_id = sellerId;
    const qs = Object.keys(p).length ? '?' + new URLSearchParams(p).toString() : '';
    return this.request(`/admin-hub/v1/messages${qs}`)
  }
  async sendMessage(data) {
    return this.request('/admin-hub/v1/messages', { method: 'POST', body: JSON.stringify(data) })
  }
  async sendSupportMessage(data) {
    return this.request('/admin-hub/v1/messages', { method: 'POST', body: JSON.stringify({ ...data, channel: 'support' }) })
  }
  async markMessageRead(id) {
    return this.request(`/admin-hub/v1/messages/${id}/read`, { method: 'PATCH' })
  }
  async markSupportMessagesRead(seller_id, mark_as, subject_thread) {
    const payload = { seller_id, mark_as };
    if (subject_thread !== undefined) payload.subject_thread = subject_thread;
    return this.request('/admin-hub/v1/messages/support/mark-read', { method: 'PATCH', body: JSON.stringify(payload) })
  }
  async getSupportCases(params = {}) {
    const clean = Object.fromEntries(Object.entries(params).filter(([, value]) => value != null && value !== ''))
    const qs = new URLSearchParams(clean).toString()
    return this.request(`/admin-hub/v1/support-cases${qs ? `?${qs}` : ''}`)
  }
  async getSupportCase(id) {
    return this.request(`/admin-hub/v1/support-cases/${encodeURIComponent(id)}`)
  }
  async sendSupportCaseMessage(id, data) {
    return this.request(`/admin-hub/v1/support-cases/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    })
  }
  async closeSupportCase(id, resolutionNote = '') {
    return this.request(`/admin-hub/v1/support-cases/${encodeURIComponent(id)}/close`, {
      method: 'POST',
      body: JSON.stringify({ resolution_note: resolutionNote }),
    })
  }
  async reopenSupportCase(id) {
    return this.request(`/admin-hub/v1/support-cases/${encodeURIComponent(id)}/reopen`, { method: 'POST' })
  }
  async markSupportCaseRead(id) {
    return this.request(`/admin-hub/v1/support-cases/${encodeURIComponent(id)}/read`, { method: 'POST' })
  }
  async reassignSupportCase(id, sellerId) {
    return this.request(`/admin-hub/v1/support-cases/${encodeURIComponent(id)}/reassign`, {
      method: 'PATCH',
      body: JSON.stringify({ seller_id: sellerId || null }),
    })
  }
  async uploadSupportCaseAttachments(files) {
    const base = (typeof getDefaultBaseUrl === 'function' ? getDefaultBaseUrl() : null) || this.baseURL
    const token = this.overrideToken || (typeof window !== 'undefined' ? localStorage.getItem('sellerToken') : null)
    const formData = new FormData()
    for (const file of files || []) formData.append('files', file)
    const response = await fetch(`${base}/admin-hub/v1/support-cases/attachments/upload`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: formData,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => ({ message: response.statusText }))
      const error = new Error(formatApiError({ message: body?.message || response.statusText }, getClientLocale()))
      error.originalMessage = body?.message || response.statusText
      error.statusCode = response.status
      error.code = body?.code || null
      throw error
    }
    return response.json()
  }
  async getMessageTemplates() {
    return this.request('/admin-hub/v1/message-templates')
  }
  async createMessageTemplate(data) {
    return this.request('/admin-hub/v1/message-templates', {
      method: 'POST',
      body: JSON.stringify(data || {}),
    })
  }
  async updateMessageTemplate(id, data) {
    return this.request(`/admin-hub/v1/message-templates/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(data || {}),
    })
  }
  async deleteMessageTemplate(id) {
    return this.request(`/admin-hub/v1/message-templates/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  // ── Ranking ──────────────────────────────────────────────────────────────
  async getRankingConfig() {
    return this.request('/admin-hub/v1/ranking/config')
  }
  async updateRankingConfig(strategy, config) {
    return this.request('/admin-hub/v1/ranking/config', { method: 'PATCH', body: JSON.stringify({ strategy, config }) })
  }
  async getRankingProducts(params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    return this.request(`/admin-hub/v1/ranking/products${qs}`)
  }
  async getRankingBreakdown(productId, strategy = 'default') {
    return this.request(`/admin-hub/v1/ranking/products/${productId}/breakdown?strategy=${strategy}`)
  }
  async triggerRankingCompute() {
    return this.request('/admin-hub/v1/ranking/compute', { method: 'POST' })
  }
  // ─────────────────────────────────────────────────────────────────────────
  async getSmtpSettings() {
    return this.request('/admin-hub/v1/smtp-settings')
  }
  async updateSmtpSettings(data) {
    return this.request('/admin-hub/v1/smtp-settings', { method: 'PATCH', body: JSON.stringify(data) })
  }
  async testSmtpSettings() {
    return this.request('/admin-hub/v1/smtp-settings/test', { method: 'POST' })
  }
  async createSmtpSender(data) {
    return this.request('/admin-hub/v1/smtp-senders', { method: 'POST', body: JSON.stringify(data) })
  }
  async updateSmtpSender(id, data) {
    return this.request(`/admin-hub/v1/smtp-senders/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) })
  }
  async deleteSmtpSender(id) {
    return this.request(`/admin-hub/v1/smtp-senders/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  async setDefaultSmtpSender(id) {
    return this.request(`/admin-hub/v1/smtp-senders/${encodeURIComponent(id)}/set-default`, { method: 'POST' })
  }
  async testSmtpSender(id, data) {
    return this.request(`/admin-hub/v1/smtp-senders/${encodeURIComponent(id)}/test`, { method: 'POST', body: JSON.stringify(data) })
  }

  /** Automation flows (Content → Flows; superuser). */
  async getFlows() {
    return this.request('/admin-hub/v1/flows')
  }
  async getFlow(id) {
    return this.request(`/admin-hub/v1/flows/${encodeURIComponent(id)}`)
  }
  async createFlow(data) {
    return this.request('/admin-hub/v1/flows', { method: 'POST', body: JSON.stringify(data) })
  }
  async updateFlow(id, data) {
    return this.request(`/admin-hub/v1/flows/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) })
  }
  async deleteFlow(id) {
    return this.request(`/admin-hub/v1/flows/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  /** Merge-field catalog for flow email templates ({FIRST_NAME}, …). Optional trigger filters relevant tokens. */
  async getFlowEmailMergeFields(locale = 'en', trigger = '') {
    const qs = new URLSearchParams({ locale: String(locale || 'en').slice(0, 5) })
    if (trigger) qs.set('trigger', String(trigger))
    return this.request(`/admin-hub/v1/flows/email-merge-fields?${qs}`)
  }
  /** Send a test email using flow template (HTML + placeholders); superuser + SMTP required. */
  async sendFlowTestEmail(flowId, data) {
    return this.request(`/admin-hub/v1/flows/${encodeURIComponent(flowId)}/test-email`, {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }
  /** DeepL translation when DEEPL_AUTH_KEY is set on the backend. */
  async translateFlowEmail(data) {
    return this.request('/admin-hub/v1/flows/translate', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  /** Flow email execution log (store_flow_execution_logs). Superuser: all rows; sellers: rows linked to own orders only. */
  async getFlowExecutionLogs(params = {}) {
    const qs = new URLSearchParams()
    if (params.limit != null && params.limit !== '') qs.set('limit', String(params.limit))
    if (params.offset != null && params.offset !== '') qs.set('offset', String(params.offset))
    if (params.status) qs.set('status', String(params.status))
    if (params.trigger_key) qs.set('trigger_key', String(params.trigger_key))
    if (params.flow_id) qs.set('flow_id', String(params.flow_id))
    const q = qs.toString()
    return this.request(`/admin-hub/v1/flow-execution-logs${q ? `?${q}` : ''}`)
  }

  async getFlowExecutionLog(id) {
    return this.request(`/admin-hub/v1/flow-execution-logs/${encodeURIComponent(id)}`)
  }

  async getFlowExecutionLogStats(params = {}) {
    const qs = new URLSearchParams()
    if (params.days != null && params.days !== '') qs.set('days', String(params.days))
    const q = qs.toString()
    return this.request(`/admin-hub/v1/flow-execution-logs/stats${q ? `?${q}` : ''}`)
  }

  async getFlowSnapshots(flowId, params = {}) {
    const qs = new URLSearchParams()
    if (params.limit != null) qs.set('limit', String(params.limit))
    if (params.full) qs.set('full', '1')
    const q = qs.toString()
    return this.request(`/admin-hub/v1/flows/${encodeURIComponent(flowId)}/snapshots${q ? `?${q}` : ''}`)
  }

  async getTransactions(params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    return this.request(`/admin-hub/v1/transactions${qs}`)
  }
  async createManualAdjustment(data) {
    return this.request('/admin-hub/v1/transactions/manual-adjustment', { method: 'POST', body: JSON.stringify(data) })
  }
  async deleteManualAdjustment(id) {
    return this.request(`/admin-hub/v1/transactions/manual-adjustment/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  async getPayouts(params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    return this.request(`/admin-hub/v1/payouts${qs}`)
  }
  async getPayoutSummary(params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    return this.request(`/admin-hub/v1/payout-summary${qs}`)
  }
  async getSellerLedger(params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    return this.request(`/admin-hub/v1/seller-ledger${qs}`)
  }
  async getAdminPayoutOverview(params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    return this.request(`/admin-hub/v1/payout-overview${qs}`)
  }
  async markPayoutPaid(data) {
    return this.request('/admin-hub/v1/payouts/mark-paid', { method: 'POST', body: JSON.stringify(data) })
  }
  async createPayout(data) {
    return this.request('/admin-hub/v1/payouts', { method: 'POST', body: JSON.stringify(data) })
  }
  async updatePayout(id, data) {
    return this.request(`/admin-hub/v1/payouts/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
  }
  async getCoupons(params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    return this.request(`/admin-hub/v1/coupons${qs}`)
  }
  async createCoupon(data) {
    return this.request('/admin-hub/v1/coupons', { method: 'POST', body: JSON.stringify(data) })
  }
  async updateCoupon(id, data) {
    return this.request(`/admin-hub/v1/coupons/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
  }
  async deleteCoupon(id) {
    return this.request(`/admin-hub/v1/coupons/${id}`, { method: 'DELETE' })
  }
  async getSellerProfile() {
    return this.request('/admin-hub/v1/seller/profile')
  }

  /** Eingeloggter Benutzer (eine Zeile in seller_users — auch Team-Accounts) */
  async getSellerAccount() {
    return this.request('/admin-hub/v1/seller/account')
  }

  async changeSellerPassword({ current_password, new_password }) {
    return this.request('/admin-hub/v1/seller/password', {
      method: 'PATCH',
      body: JSON.stringify({ current_password, new_password }),
    })
  }

  async updateSellerIban(iban) {
    return this.request('/admin-hub/v1/seller/iban', { method: 'PATCH', body: JSON.stringify({ iban }) })
  }

  /** Devices/sessions for the logged-in account — Settings → Security. */
  async getSellerSessions() {
    return this.request('/admin-hub/v1/sessions')
  }
  async revokeSellerSession(id) {
    return this.request(`/admin-hub/v1/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }
  async revokeAllSellerSessions({ includeCurrent = false } = {}) {
    const qs = includeCurrent ? '?include_current=1' : ''
    return this.request(`/admin-hub/v1/sessions${qs}`, { method: 'DELETE' })
  }
  async inviteUser(data) {
    return this.request('/admin-hub/users/invite', { method: 'POST', body: JSON.stringify(data) })
  }
  async getSubusers() {
    return this.request('/admin-hub/v1/subusers')
  }
  async updateSubuser(userId, data) {
    return this.request(`/admin-hub/v1/subusers/${userId}`, { method: 'PATCH', body: JSON.stringify(data) })
  }
  async deleteSubuser(userId) {
    return this.request(`/admin-hub/v1/subusers/${userId}`, { method: 'DELETE' })
  }
  async deletePendingInvite(inviteId) {
    return this.request(`/admin-hub/v1/pending-invites/${inviteId}`, { method: 'DELETE' })
  }

  // ── Seller Auth ─────────────────────────────────────────────────────────────
  async loginSeller(email, password, extra = {}) {
    return this.request('/admin-hub/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, ...extra }),
    });
  }

  async registerSeller(email, password, storeName, extra = {}) {
    return this.request('/admin-hub/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, store_name: storeName, ...extra }),
    });
  }

  async getSellerMe() {
    return this.request('/admin-hub/auth/me');
  }

  // ── 2FA / TOTP ───────────────────────────────────────────────────────────────
  async get2faStatus() {
    return this.request('/admin-hub/auth/2fa/status');
  }

  async setup2fa() {
    return this.request('/admin-hub/auth/2fa/setup', { method: 'POST' });
  }

  async verify2fa(code) {
    return this.request('/admin-hub/auth/2fa/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  async disable2fa({ code, password } = {}) {
    return this.request('/admin-hub/auth/2fa/disable', {
      method: 'POST',
      body: JSON.stringify({ code, password }),
    });
  }

  /** Superuser: Shop-Checkout (Stripe-Keys, Zahlarten) */
  async getPlatformCheckoutSettings() {
    return this.request('/admin-hub/v1/platform-checkout-settings');
  }

  async updatePlatformCheckoutSettings(data) {
    return this.request('/admin-hub/v1/platform-checkout-settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async getStripePaymentMethods() {
    return this.request('/admin-hub/v1/stripe-payment-methods');
  }

  /** Superuser: Stripe Secret testen (optional aktuelle Formularwerte); siehe Backend balance.retrieve */
  async testPlatformStripeConnection(data = {}) {
    return this.request('/admin-hub/v1/platform-checkout-settings/test-stripe', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getSellerUsers() {
    return this.request('/admin-hub/users');
  }

  async createSellerUser(data) {
    return this.request('/admin-hub/users', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateSellerUser(userId, data) {
    return this.request(`/admin-hub/users/${userId}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async deleteSellerUser(userId) {
    return this.request(`/admin-hub/users/${userId}`, { method: 'DELETE' });
  }

  async setSellerUserSuperuser(userId, isSuperuser) {
    return this.request(`/admin-hub/users/${userId}/superuser`, {
      method: 'PATCH',
      body: JSON.stringify({ is_superuser: isSuperuser }),
    });
  }

  // ── Seller Management (superuser) ─────────────────────────────────────────
  async getSellers(params = {}) {
    const qs = Object.keys(params).length ? '?' + new URLSearchParams(params).toString() : ''
    return this.request(`/admin-hub/v1/sellers${qs}`)
  }

  async getSellerById(id) {
    return this.request(`/admin-hub/v1/sellers/${id}`)
  }

  async updateSellerById(id, data) {
    return this.request(`/admin-hub/v1/sellers/${id}`, { method: 'PATCH', body: JSON.stringify(data) })
  }

  async approveSellerById(id, status, rejectionReason) {
    return this.request(`/admin-hub/v1/sellers/${id}/approve`, {
      method: 'PATCH',
      body: JSON.stringify({ status, rejection_reason: rejectionReason }),
    })
  }

  async impersonateSeller(id) {
    return this.request(`/admin-hub/v1/sellers/${id}/impersonate`, { method: 'POST' })
  }

  async updateSellerCompanyInfo(data) {
    return this.request('/admin-hub/v1/seller/company-info', { method: 'PATCH', body: JSON.stringify(data) })
  }

  // ── Stripe Connect ──────────────────────────────────────────────────────────
  async stripeConnectOnboard() {
    return this.request('/admin-hub/v1/stripe-connect/onboard', { method: 'POST', body: JSON.stringify({}) })
  }
  async stripeConnectStatus() {
    return this.request('/admin-hub/v1/stripe-connect/status')
  }
  async stripeConnectDashboardLink() {
    return this.request('/admin-hub/v1/stripe-connect/dashboard-link')
  }
  async stripeConnectDisconnect(seller_id) {
    return this.request('/admin-hub/v1/stripe-connect/disconnect', { method: 'POST', body: JSON.stringify({ seller_id }) })
  }

  /** Run the verification pipeline for the logged-in seller */
  async startVerification() {
    return this.request('/admin-hub/v1/verification/start', { method: 'POST', body: JSON.stringify({}) })
  }

  // ── Seller Credit Card ───────────────────────────────────────────────────
  async getStripePublishableKey() {
    return this.request('/admin-hub/v1/stripe-publishable-key')
  }
  async getSellerCard() {
    return this.request('/admin-hub/v1/seller/card')
  }
  async deleteSellerCard() {
    return this.request('/admin-hub/v1/seller/card', { method: 'DELETE' })
  }
  async createSellerCardSetupIntent() {
    return this.request('/admin-hub/v1/seller/card/setup-intent', { method: 'POST', body: JSON.stringify({}) })
  }
  async confirmSellerCard(payment_method_id) {
    return this.request('/admin-hub/v1/seller/card/confirm', { method: 'POST', body: JSON.stringify({ payment_method_id }) })
  }
  async getSellerCardByAdmin(sellerId) {
    return this.request(`/admin-hub/v1/sellers/${sellerId}/card`)
  }
  async deleteSellerCardByAdmin(sellerId) {
    return this.request(`/admin-hub/v1/sellers/${sellerId}/card`, { method: 'DELETE' })
  }

  /** Create a sign token + QR code for agreement signing */
  async createSignToken(locale) {
    return this.request('/admin-hub/v1/seller/sign-token', { method: 'POST', body: JSON.stringify({ locale }) })
  }

  /** Poll for signature completion */
  async getSignStatus() {
    return this.request('/admin-hub/v1/seller/sign-status')
  }

  /** Fetch the signed agreement PDF as a Blob (for download triggers) */
  async downloadAgreementPdf(sellerId) {
    const base = (typeof getDefaultBaseUrl === 'function' ? getDefaultBaseUrl() : null) || this.baseURL
    const token = typeof window !== 'undefined' ? (localStorage.getItem('sellerToken') || '') : ''
    const qs = sellerId ? `?seller_id=${encodeURIComponent(sellerId)}` : ''
    const url = `${base}/admin-hub/v1/seller/agreement-pdf${qs}`
    const resp = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!resp.ok) throw new Error(`PDF download failed: ${resp.status}`)
    return resp.blob()
  }

  /**
   * Fetch an order PDF (invoice / lieferschein / …) as a Blob with Bearer auth.
   * opts: { carrier?, tracking? } — optional Lieferschein overrides.
   */
  async downloadOrderPdf(orderId, kind = 'invoice', locale = 'de', opts = {}) {
    const base = (typeof getDefaultBaseUrl === 'function' ? getDefaultBaseUrl() : null) || this.baseURL
    const token = typeof window !== 'undefined' ? (localStorage.getItem('sellerToken') || '') : ''
    const params = new URLSearchParams({ locale: String(locale || 'de').slice(0, 2).toLowerCase() })
    if (opts.carrier) params.set('carrier', String(opts.carrier))
    if (opts.tracking) params.set('tracking', String(opts.tracking))
    const url = `${base}/admin-hub/v1/orders/${encodeURIComponent(orderId)}/pdf/${encodeURIComponent(kind || 'invoice')}?${params}`
    const resp = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!resp.ok) throw new Error(`Order PDF download failed: ${resp.status}`)
    return resp.blob()
  }

  /** DAC7 — superuser: fetch reportable sellers for a given year */
  async getDac7Report(year) {
    return this.request(`/admin-hub/v1/dac7/report?year=${encodeURIComponent(year)}`)
  }

  /** DAC7 — superuser: download BZSt XML file */
  async downloadDac7Xml(year) {
    const base = (typeof getDefaultBaseUrl === 'function' ? getDefaultBaseUrl() : null) || this.baseURL
    const token = typeof window !== 'undefined' ? (localStorage.getItem('sellerToken') || '') : ''
    const url = `${base}/admin-hub/v1/dac7/export?year=${encodeURIComponent(year)}`
    const resp = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
    if (!resp.ok) throw new Error(`DAC7 export failed: ${resp.status}`)
    return resp.blob()
  }

  /** Get verification status (seller: own, superuser: pass seller_id query param) */
  async getVerificationStatus(sellerId) {
    const qs = sellerId ? `?seller_id=${encodeURIComponent(sellerId)}` : ''
    return this.request(`/admin-hub/v1/verification/status${qs}`)
  }

  /** Superuser manual review action */
  async reviewVerification(seller_id, action, note) {
    return this.request('/admin-hub/v1/verification/review', {
      method: 'POST',
      body: JSON.stringify({ seller_id, action, note }),
    })
  }

  // ── Product Groups ──────────────────────────────────────────────────────────

  async getProductGroups() {
    return this.request('/admin-hub/v1/product-groups')
  }

  async createProductGroup(data) {
    return this.request('/admin-hub/v1/product-groups', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateProductGroup(id, data) {
    return this.request(`/admin-hub/v1/product-groups/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deleteProductGroup(id) {
    return this.request(`/admin-hub/v1/product-groups/${id}`, { method: 'DELETE' })
  }

  // ── Product Badges ───────────────────────────────────────────────────────────

  async getProductBadges() {
    return this.request('/admin-hub/v1/product-badges')
  }

  async createProductBadge(data) {
    return this.request('/admin-hub/v1/product-badges', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateProductBadge(id, data) {
    return this.request(`/admin-hub/v1/product-badges/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deleteProductBadge(id) {
    return this.request(`/admin-hub/v1/product-badges/${id}`, { method: 'DELETE' })
  }

  // ── Campaigns ───────────────────────────────────────────────────────────────

  async getCampaigns() {
    return this.request('/admin-hub/v1/campaigns')
  }

  async getCampaign(id) {
    return this.request(`/admin-hub/v1/campaigns/${encodeURIComponent(id)}`)
  }

  async createCampaign(data) {
    return this.request('/admin-hub/v1/campaigns', {
      method: 'POST',
      body: JSON.stringify(data),
    })
  }

  async updateCampaign(id, data) {
    return this.request(`/admin-hub/v1/campaigns/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    })
  }

  async deleteCampaign(id) {
    return this.request(`/admin-hub/v1/campaigns/${id}`, { method: 'DELETE' })
  }

  async publishCampaign(id) {
    return this.request(`/admin-hub/v1/campaigns/${id}/publish`, { method: 'POST' })
  }

  async pauseCampaign(id) {
    return this.request(`/admin-hub/v1/campaigns/${id}/pause`, { method: 'POST' })
  }

  async resumeCampaign(id) {
    return this.request(`/admin-hub/v1/campaigns/${id}/resume`, { method: 'POST' })
  }

  async createCampaignCheckout(id, { success_url, cancel_url } = {}) {
    return this.request(`/admin-hub/v1/campaigns/${id}/checkout`, { method: 'POST', body: JSON.stringify({ success_url, cancel_url }) })
  }

  async getCampaignAttribution(params = {}) {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.campaign_id) qs.set("campaign_id", params.campaign_id);
    if (params.model) qs.set("model", params.model);
    const q = qs.toString();
    return this.request(`/admin-hub/v1/campaigns/attribution${q ? "?" + q : ""}`);
  }

  /** Read-only affiliate summary for the logged-in seller's own products (docs/affiliate.md PR 5). */
  async getAffiliateMarketingSummary() {
    return this.request(`/admin-hub/v1/affiliate-marketing/summary`);
  }

  // ── Affiliate admin (superuser only, docs/affiliate.md PR 8) ─────────────────
  async getAffiliateAdminPending() {
    return this.request(`/admin-hub/v1/affiliate-admin/pending`);
  }
  async approveAffiliate(id) {
    return this.request(`/admin-hub/v1/affiliate-admin/${id}/approve`, { method: "POST" });
  }
  async rejectAffiliate(id, reason) {
    return this.request(`/admin-hub/v1/affiliate-admin/${id}/reject`, { method: "POST", body: JSON.stringify({ reason }) });
  }
  async getAffiliateFraudQueue(severity) {
    const qs = severity ? `?severity=${encodeURIComponent(severity)}` : "";
    return this.request(`/admin-hub/v1/affiliate-admin/fraud${qs}`);
  }
  async resolveAffiliateFraudFlag(id, action) {
    return this.request(`/admin-hub/v1/affiliate-admin/fraud/${id}/resolve`, { method: "POST", body: JSON.stringify({ action }) });
  }
  async getAffiliatePayoutHistory() {
    return this.request(`/admin-hub/v1/affiliate-admin/payouts`);
  }
  async logAffiliateManualFraudFlag({ affiliate_code, flag_type, severity, notes }) {
    return this.request(`/admin-hub/v1/affiliate-admin/fraud`, {
      method: "POST",
      body: JSON.stringify({ affiliate_code, flag_type, severity, notes }),
    });
  }

  async getMarketingAnalytics(params = {}) {
    const qs = new URLSearchParams();
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    const q = qs.toString();
    try {
      return await this.request(`/admin-hub/v1/analytics/marketing${q ? "?" + q : ""}`);
    } catch (err) {
      if (err?.statusCode === 429 || err?.statusCode >= 500 || err?.statusCode === 503) {
        return null
      }
      throw err
    }
  }

  // ── Platform Marketing Accounts (superuser) ─────────────────────────────────
  async getMarketingAccounts() {
    return this.request('/admin-hub/v1/marketing-accounts')
  }

  async updateMarketingAccount(platform, data) {
    return this.request('/admin-hub/v1/marketing-accounts', {
      method: 'PATCH',
      body: JSON.stringify({ platform, ...data }),
    })
  }

  // ── SEO Hub (superuser) ─────────────────────────────────────────────────────
  async getSeoRules() {
    return this.request('/admin-hub/v1/seo/rules')
  }

  async getSeoEntities({
    type,
    q = '',
    limit = 40,
    offset = 0,
    seller_id = '',
    category_id = '',
    score = '',
    sort = '',
  } = {}) {
    const params = new URLSearchParams()
    if (type) params.set('type', type)
    if (q) params.set('q', q)
    params.set('limit', String(limit))
    params.set('offset', String(offset))
    if (seller_id) params.set('seller_id', String(seller_id))
    if (category_id) params.set('category_id', String(category_id))
    if (score) params.set('score', String(score))
    if (sort) params.set('sort', String(sort))
    return this.request(`/admin-hub/v1/seo/entities?${params.toString()}`)
  }

  async getSeoEntity(type, id) {
    return this.request(`/admin-hub/v1/seo/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`)
  }

  async patchSeoEntity(type, id, body) {
    return this.request(`/admin-hub/v1/seo/entities/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body || {}),
    })
  }

  async analyzeSeo(body) {
    return this.request('/admin-hub/v1/seo/analyze', {
      method: 'POST',
      body: JSON.stringify(body || {}),
    })
  }

  async autoGenerateProductSeo(body = {}) {
    return this.request('/admin-hub/v1/seo/products/auto-generate', {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  // ── Stripe Connect ───────────────────────────────────────────────────────────
  async stripeConnectOnboard() {
    return this.request('/admin-hub/v1/stripe-connect/onboard', { method: 'POST' })
  }

  async stripeConnectStatus() {
    return this.request('/admin-hub/v1/stripe-connect/status')
  }

  async stripeConnectDashboardLink() {
    return this.request('/admin-hub/v1/stripe-connect/dashboard-link')
  }

  async stripeConnectDisconnect(sellerId) {
    return this.request('/admin-hub/v1/stripe-connect/disconnect', {
      method: 'POST',
      body: JSON.stringify({ seller_id: sellerId }),
    })
  }

  async triggerStripeTransfer(orderId) {
    return this.request(`/admin-hub/v1/stripe-connect/transfer/${orderId}`, { method: 'POST' })
  }
}

// Singleton instance
let medusaAdminClient = null

export function getMedusaAdminClient() {
  if (!medusaAdminClient) {
    medusaAdminClient = new MedusaAdminClient()
  }
  return medusaAdminClient
}

export function createImpersonationClient(token) {
  return new MedusaAdminClient(undefined, token)
}

export default MedusaAdminClient
