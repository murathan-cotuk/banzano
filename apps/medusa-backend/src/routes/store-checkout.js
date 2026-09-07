'use strict'
const { Router } = require('express')
const { resolveOrderPaidTotalCents, orderBonusDiscountCents, orderCouponDiscountCents } = require('../order-money')
const { loadPlatformCheckoutRow, resolveStripeSecretKeyFromPlatform, resolveStripePublishableFromPlatform, paymentMethodTypesFromPlatformRow } = require('./platform-checkout')
const { getBestsellerProductIds, mapAdminHubToStoreProduct } = require('./store-products')
const { getAdminHubProductByIdOrHandleDb } = require('./admin-products')
const { normalizeHubCountryCode } = require('./seller-settings')
const { requireSellerAuth, requireSuperuser } = require('./seller-auth')
const { runAutomationFlowsForOrder } = require('../flow-automation')
const { enqueueFlowEvent } = require('../flow-queue')
const { renderInvoicePdfDocument, renderRetourenscheinPdfDocument, querySellerInfoForOrderDocuments } = require('../order-pdf-buffers')
const { getOrderPdfFilename } = require('../order-pdf-i18n')
const { resolveLocaleFromCountry } = require('../locale-from-country')
const { createReturnLabelForOrder } = require('../return-label')
const { pickCountryMerchandiseCents, normalizeCountryCode, isValidEuVatIdFormat } = require('../goods-vat')
const { checkVatIdViaVies } = require('../vies-check')

/**
 * Runs the live VIES lookup for a 'gewerbe' customer's VAT-ID and returns the row values to
 * snapshot alongside it. Never throws: VIES being slow/down just means "not verified yet"
 * (columns stay null), it must never block registration/profile-save/checkout.
 */
async function resolveViesVerification(vatNumber) {
  const v = String(vatNumber || '').trim().toUpperCase().replace(/[\s-]/g, '')
  if (!isValidEuVatIdFormat(v)) return { vies_valid: null, vies_checked_at: null, vies_company_name: null }
  const result = await checkVatIdViaVies({ countryCode: v.slice(0, 2), vatNumber: v.slice(2) }).catch(() => ({ ok: false }))
  if (!result.ok) return { vies_valid: null, vies_checked_at: null, vies_company_name: null }
  return { vies_valid: result.valid, vies_checked_at: new Date().toISOString(), vies_company_name: result.name }
}

const dispatchOrderFlowEvent = async (triggerKey, orderId) => {
  const tk = String(triggerKey || '').trim()
  const oid = String(orderId || '').trim()
  if (!tk || !oid) return
  try {
    const queued = await enqueueFlowEvent('order-flow-event', { triggerKey: tk, orderId: oid })
    if (queued) return
  } catch (qe) {
    console.warn('[flow-queue] enqueue order event failed, fallback immediate:', qe?.message || qe)
  }
  setImmediate(() => {
    runAutomationFlowsForOrder({ triggerKey: tk, orderId: oid }).catch((fe) => {
      console.warn(`runAutomationFlowsForOrder ${tk}:`, fe?.message || fe)
    })
  })
}

// ── DB ────────────────────────────────────────────────────────────────────────
const { z } = require('zod')
const zEmail = z.string().email('Invalid email address').max(254)
const zPassword = z.string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
function validate(schema, body, res) {
  const result = schema.safeParse(body)
  if (!result.success) {
    const first = result.error.errors[0]
    const msg = first ? `${first.path.join('.') || 'field'}: ${first.message}` : 'Invalid input'
    res.status(400).json({ message: msg })
    return null
  }
  return result.data
}

// ── Campaign helpers (needed by cart line-items POST) ─────────────────────────
const applySellerCampaignToPriceCents = (priceCents, camp) => {
  const p = Math.max(0, Number(priceCents || 0))
  if (!camp || p <= 0) return p
  const t = String(camp.discount_type || 'percentage').toLowerCase()
  const v = Number(camp.discount_value || 0)
  if (t === 'fixed') {
    const off = Math.round(v * 100)
    return Math.max(0, p - off)
  }
  const pct = Math.min(100, Math.max(0, v))
  return Math.round(p * (1 - pct / 100))
}

const parseJsonbArray = (raw) => {
  if (raw == null) return []
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === 'string') {
    try {
      const x = JSON.parse(raw)
      return Array.isArray(x) ? x.map(String) : []
    } catch (_) {
      return []
    }
  }
  return []
}

async function sellerCampaignCoversProductVariant(c, camp, productId, variantId) {
  const pid = String(productId || '').trim()
  const vid = String(variantId || '').trim()
  const targetType = String(camp.target_type || 'products').toLowerCase()
  const variantIdsList = parseJsonbArray(camp.variant_ids)

  let productMatch = false
  if (targetType === 'all') {
    productMatch = true
  } else if (targetType === 'groups') {
    const groupIds = parseJsonbArray(camp.group_ids)
    for (const gid of groupIds) {
      const gr = await c.query(`SELECT product_ids FROM seller_product_groups WHERE id=$1`, [gid]).catch(() => ({ rows: [] }))
      const gProds = parseJsonbArray(gr.rows[0]?.product_ids)
      if (gProds.includes(pid)) {
        productMatch = true
        break
      }
    }
  } else {
    const productIds = parseJsonbArray(camp.product_ids)
    productMatch = productIds.includes(pid)
  }

  if (variantIdsList.length > 0) {
    if (!vid || !variantIdsList.includes(vid)) return false
    if (productMatch || targetType === 'all') return true
    return vid.startsWith(`${pid}-`)
  }
  return productMatch
}

async function findBestSellerCampaignDiscountRow(c, { productId, variantId, sellerId }) {
  const pid = String(productId || '').trim()
  const vid = String(variantId || '').trim()
  const sid = String(sellerId || '').trim()
  if (!pid || !sid) return null
  const nowIso = new Date().toISOString()
  const r = await c.query(
    `SELECT * FROM seller_campaigns
     WHERE seller_id = $1
       AND status = 'active'
       AND COALESCE(campaign_type, 'internal') = 'internal'
       AND (start_at IS NULL OR start_at <= $2::timestamptz)
       AND (end_at IS NULL OR end_at >= $2::timestamptz)
     ORDER BY discount_value DESC`,
    [sid, nowIso],
  )
  let bestDiscount = null
  for (const camp of r.rows || []) {
    const covered = await sellerCampaignCoversProductVariant(c, camp, pid, vid)
    if (covered) {
      if (!bestDiscount || parseFloat(camp.discount_value) > parseFloat(bestDiscount.discount_value)) {
        bestDiscount = camp
      }
    }
  }
  return bestDiscount
}


// --- Store Carts (session cart: create, get, add/update/remove line-items) ---
const productIdFromVariantId = (variantId) => {
  if (!variantId || typeof variantId !== 'string') return null
  let base
  if (variantId.endsWith('-variant')) {
    base = variantId.slice(0, -'-variant'.length)
  } else {
    const variantDashIdx = variantId.lastIndexOf('-variant-')
    if (variantDashIdx > 0) {
      base = variantId.slice(0, variantDashIdx)
    } else {
      const idx = variantId.indexOf('-v-')
      base = idx > 0 ? variantId.slice(0, idx) : variantId
    }
  }
  // Buybox/"other sellers" listings use a composite id — {productId}-listing-{sellerId}
  // (see store-products.js: `String(l.product_id) + '-listing-' + l.seller_id`) — so its
  // variant ids look like {productId}-listing-{sellerId}-variant-{N}. Strip the
  // "-listing-{sellerId}" part too, or getAdminHubProductByIdOrHandleDb() gets handed
  // that whole composite string, fails to match it as a UUID or a handle, and the
  // add-to-cart call 404s with "Product not found".
  const listingIdx = base.indexOf('-listing-')
  return listingIdx > 0 ? base.slice(0, listingIdx) : base
}

const BONUS_POINTS_PER_EURO_DISCOUNT = 50
const BONUS_SIGNUP_POINTS = 100
const STRIPE_MIN_CHARGE_CENTS_EUR = 50
const COUPON_CODE_MAX_LEN = 100

const discountCentsFromBonusPoints = (points) => {
  const p = Math.max(0, Number(points || 0))
  return Math.floor((p / BONUS_POINTS_PER_EURO_DISCOUNT) * 100)
}

const normalizeCouponCode = (code) =>
  String(code || '').trim().toUpperCase().slice(0, COUPON_CODE_MAX_LEN)

const resolveCouponDiscountCents = (couponRow, subtotalCents) => {
  if (!couponRow) return 0
  const sub = Math.max(0, Number(subtotalCents || 0))
  const minSub = Math.max(0, Number(couponRow.min_subtotal_cents || 0))
  if (sub < minSub) return 0
  const type = String(couponRow.discount_type || 'percent').toLowerCase()
  const val = Math.max(0, Number(couponRow.discount_value || 0))
  if (type === 'fixed') return Math.min(sub, Math.floor(val))
  const pct = Math.min(100, val)
  return Math.min(sub, Math.floor((sub * pct) / 100))
}

const loadValidCouponForSeller = async (client, sellerId, code) => {
  const normalizedCode = normalizeCouponCode(code)
  if (!normalizedCode) return null
  const effectiveSellerId = String(sellerId || 'default')
  // Try seller-specific coupon first, then fall back to platform-wide ('default') coupons
  const sellerIds = effectiveSellerId === 'default'
    ? ['default']
    : [effectiveSellerId, 'default']
  const r = await client.query(
    `SELECT *
     FROM admin_hub_coupons
     WHERE COALESCE(NULLIF(TRIM(seller_id), ''), 'default') = ANY($1)
       AND lower(code) = lower($2)
       AND active = true
       AND (starts_at IS NULL OR starts_at <= now())
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY CASE WHEN COALESCE(NULLIF(TRIM(seller_id), ''), 'default') = $3 THEN 0 ELSE 1 END
     LIMIT 1`,
    [sellerIds, normalizedCode, effectiveSellerId],
  )
  const row = r.rows?.[0]
  if (!row) return null
  const usageLimit = row.usage_limit == null ? null : Number(row.usage_limit)
  const usedCount = Number(row.used_count || 0)
  if (usageLimit != null && usedCount >= usageLimit) return null
  return row
}

/** Normalize seller key on cart lines (matches getCartWithItems). */
const cartLineSellerKey = (it) => {
  const s = String(it?.seller_id ?? it?.sellerId ?? '').trim()
  return s || 'default'
}

/** Subtotal (cents) that a coupon may discount — platform coupons use full cart; seller coupons only that seller's lines. */
const couponEligibleSubtotalCents = (items, couponRow) => {
  if (!couponRow) return 0
  const list = Array.isArray(items) ? items : []
  const couponSeller = String(couponRow.seller_id || 'default').trim() || 'default'
  if (couponSeller === 'default') {
    return list.reduce((sum, it) => sum + Number(it.unit_price_cents || 0) * Number(it.quantity || 1), 0)
  }
  return list.reduce((sum, it) => {
    if (cartLineSellerKey(it) !== couponSeller) return sum
    return sum + Number(it.unit_price_cents || 0) * Number(it.quantity || 1)
  }, 0)
}

/**
 * Resolve coupon row + discount for the whole cart (multi-seller safe).
 * Picks among coupons matching the code whose seller_id is on the cart or platform default.
 * Also checks seller_listings so that a seller's coupon works even when their products
 * are master-products (seller_id = null / 'default' on cart items).
 */
/** True if `today` falls within [customer's birthday this/adjacent year, +windowDays]. */
const isWithinBirthdayWindow = (birthDate, windowDays) => {
  if (!birthDate || !(Number(windowDays) > 0)) return false
  const bd = new Date(birthDate)
  if (Number.isNaN(bd.getTime())) return false
  const today = new Date()
  const todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  const month = bd.getUTCMonth()
  const day = bd.getUTCDate()
  // Check this year's birthday plus the adjacent years so a birthday near Dec 31/Jan 1 whose
  // window spans the new year is still evaluated correctly either direction.
  for (const yearOffset of [-1, 0, 1]) {
    const candidate = Date.UTC(today.getUTCFullYear() + yearOffset, month, day)
    const windowEnd = candidate + Number(windowDays) * 24 * 60 * 60 * 1000
    if (todayUTC >= candidate && todayUTC <= windowEnd) return true
  }
  return false
}

const resolveCartCouponDiscountSync = async (client, items, rawCouponCode, customerEmail = null) => {
  const normalizedInput = normalizeCouponCode(rawCouponCode)
  if (!normalizedInput) {
    return { nextCouponCode: null, couponDiscountCents: 0, invalid: false }
  }
  const list = Array.isArray(items) ? items : []
  const sellersOnCart = [...new Set(list.map((it) => cartLineSellerKey(it)))]

  // Also find sellers who have listings for products in this cart (covers master-product case)
  let sellersViaListings = []
  try {
    const productIds = list.map((it) => String(it.product_id || '')).filter(Boolean)
    if (productIds.length) {
      const lq = await client.query(
        `SELECT DISTINCT seller_id FROM admin_hub_seller_listings WHERE product_id::text = ANY($1::text[]) AND status = 'active'`,
        [productIds]
      )
      sellersViaListings = (lq.rows || []).map((r) => String(r.seller_id || '')).filter(Boolean)
    }
  } catch (_) {}

  const sellerCandidates = [...new Set([...sellersOnCart, ...sellersViaListings, 'default'])]
  const r = await client.query(
    `SELECT *
     FROM admin_hub_coupons
     WHERE lower(code) = lower($1)
       AND COALESCE(NULLIF(TRIM(seller_id), ''), 'default') = ANY($2::varchar[])
       AND active = true
       AND (starts_at IS NULL OR starts_at <= now())
       AND (expires_at IS NULL OR expires_at > now())
     ORDER BY CASE WHEN COALESCE(NULLIF(TRIM(seller_id), ''), 'default') = 'default' THEN 1 ELSE 0 END, seller_id ASC`,
    [normalizedInput, sellerCandidates],
  )
  let candidates = (r.rows || []).filter((row) => {
    const usageLimit = row.usage_limit == null ? null : Number(row.usage_limit)
    const usedCount = Number(row.used_count || 0)
    return !(usageLimit != null && usedCount >= usageLimit)
  })
  const needsBirthdayCheck = candidates.some((row) => row.birthday_window_days != null)
  if (needsBirthdayCheck) {
    let birthDate = null
    const emailNorm = String(customerEmail || '').trim().toLowerCase()
    if (emailNorm) {
      try {
        const cr = await client.query(
          `SELECT birth_date FROM store_customers WHERE LOWER(TRIM(email)) = $1 ORDER BY created_at DESC LIMIT 1`,
          [emailNorm],
        )
        birthDate = cr.rows?.[0]?.birth_date || null
      } catch (_) {}
    }
    candidates = candidates.filter((row) =>
      row.birthday_window_days == null || isWithinBirthdayWindow(birthDate, row.birthday_window_days),
    )
  }
  if (!candidates.length) {
    return { nextCouponCode: null, couponDiscountCents: 0, invalid: true }
  }
  // Prefer seller-specific coupon, fall back to platform-wide
  const allSellerIds = new Set([...sellersOnCart, ...sellersViaListings])
  let couponRow =
    candidates.find((c) => String(c.seller_id || 'default') !== 'default' && allSellerIds.has(String(c.seller_id))) ||
    candidates.find((c) => String(c.seller_id || 'default') === 'default') ||
    candidates[0]
  const couponSeller = String(couponRow.seller_id || 'default').trim() || 'default'
  // For seller coupons, compute eligible subtotal using full cart (since master products map to 'default')
  const eligible = couponSeller === 'default'
    ? list.reduce((sum, it) => sum + Number(it.unit_price_cents || 0) * Number(it.quantity || 1), 0)
    : (() => {
        const direct = couponEligibleSubtotalCents(list, couponRow)
        if (direct > 0) return direct
        // Fallback: if seller's products are master products (default seller_id), use full cart
        return allSellerIds.has(couponSeller) || sellersViaListings.includes(couponSeller)
          ? list.reduce((sum, it) => sum + Number(it.unit_price_cents || 0) * Number(it.quantity || 1), 0)
          : 0
      })()
  if (eligible <= 0) {
    return { nextCouponCode: null, couponDiscountCents: 0, invalid: true }
  }
  const couponDiscountCents = resolveCouponDiscountCents(couponRow, eligible)
  return {
    nextCouponCode: normalizeCouponCode(couponRow.code),
    couponDiscountCents,
    invalid: false,
  }
}

const bonusPointsEarnedFromOrderPaidCents = (paidCents) =>
  Math.ceil(Number(paidCents || 0) / 100)

/** Seller commission/payout basis: merchandise at list price (subtotal), before bonus discount. Bonus is platform-funded. */
const sellerOrderRevenueBasisCents = (row) => {
  const sub = row.subtotal_cents != null ? Number(row.subtotal_cents) : NaN
  if (Number.isFinite(sub) && sub > 0) return Math.round(sub)
  const tot = row.total_cents != null ? Number(row.total_cents) : 0
  return Math.max(0, Math.round(tot))
}

/** Komisyon her zaman sepet (ürün) tutarı üzerinden — müşterinin ödediği total_cents veya bonus/kupon sonrası net üzerinden değil. */
const platformCommissionCentsFromMerchandise = (orderRow, commissionRate) => {
  const basis = sellerOrderRevenueBasisCents(orderRow)
  const r = Number(commissionRate ?? 0.12)
  const rate = Number.isFinite(r) && r >= 0 ? r : 0.12
  return Math.max(0, Math.round(basis * rate))
}

const resolvePlatformApplicationFeeCents = (orderRow, commissionRate) => {
  const stored = Number(orderRow.stripe_application_fee_cents)
  if (Number.isFinite(stored) && stored > 0) return stored
  return platformCommissionCentsFromMerchandise(orderRow, commissionRate)
}

/**
 * Einheitliche API-Aufschlüsselung für Shop / Seller / Admin (kein Stripe-Geld bei platform_loyalty).
 *
 * `platform_subsidy_cents` mixes bonus + coupon (kept for backward compat with existing callers —
 * do not remove). `bonus_redeemed_cents` / `coupon_discount_cents` / `platform_bonus_funding_cents`
 * below are the disambiguated fields (BonusPunkte.md §3.1) — prefer these for anything new.
 *
 * `goods_vat_rate_percent` / `goods_vat_cents` / `vat_scheme` are null until §3.10's per-order VAT
 * columns exist — do NOT default them to 19%, that reintroduces the exact bug §3.10 documents.
 */
const buildOrderSettlementBreakdown = (orderRow, commissionRateFallback = 0.12) => {
  const sub = sellerOrderRevenueBasisCents(orderRow)
  const ship = Math.max(0, Number(orderRow.shipping_cents || 0))
  const disc = Math.max(0, Number(orderRow.discount_cents || 0))
  const paid = Math.max(0, resolveOrderPaidTotalCents(orderRow))
  const commission = resolvePlatformApplicationFeeCents(orderRow, commissionRateFallback)
  const sellerNetStored = Number(orderRow.seller_net_after_commission_cents)
  const sellerNet =
    Number.isFinite(sellerNetStored) && sellerNetStored >= 0
      ? sellerNetStored
      : Math.max(0, sub - commission)
  const kind = String(orderRow.checkout_payment_kind || 'stripe').trim() || 'stripe'
  const stripeCharged = paid > 0 && kind === 'stripe'
  const platformSubsidy = Math.max(0, sub + ship - paid)
  const bonusRedeemed = orderBonusDiscountCents(orderRow)
  const couponDiscount = orderCouponDiscountCents(orderRow)
  const destinationCountry = orderRow.country ? String(orderRow.country).trim().toUpperCase() : null
  const goodsVatRatePercent =
    orderRow.goods_vat_rate_percent != null ? Number(orderRow.goods_vat_rate_percent) : null
  const goodsVatCents =
    orderRow.goods_vat_cents != null ? Math.max(0, Number(orderRow.goods_vat_cents)) : null
  const vatScheme = orderRow.vat_scheme || null
  return {
    checkout_payment_kind: kind,
    merchandise_subtotal_cents: sub,
    shipping_cents: ship,
    discount_total_cents: disc,
    customer_paid_cents: paid,
    stripe_charge_cents: stripeCharged ? paid : 0,
    platform_subsidy_cents: platformSubsidy,
    platform_commission_cents: commission,
    seller_net_merchandise_cents: sellerNet,
    // §3.1 disambiguated fields:
    bonus_redeemed_cents: bonusRedeemed,
    coupon_discount_cents: couponDiscount,
    platform_bonus_funding_cents: bonusRedeemed,
    destination_country: destinationCountry,
    goods_vat_rate_percent: goodsVatRatePercent,
    goods_vat_cents: goodsVatCents,
    vat_scheme: vatScheme,
  }
}

const clampCartBonusRedemption = (requestedPoints, balance, subtotalCents) => {
  let p = Math.max(0, Math.min(Number(requestedPoints) || 0, Number(balance) || 0))
  p = Math.floor(p)
  if (subtotalCents < STRIPE_MIN_CHARGE_CENTS_EUR) return 0
  let disc = discountCentsFromBonusPoints(p)
  const maxDiscount = subtotalCents - STRIPE_MIN_CHARGE_CENTS_EUR
  if (disc > maxDiscount) {
    p = Math.floor((maxDiscount * BONUS_POINTS_PER_EURO_DISCOUNT) / 100)
  }
  return p
}

/** Single source for PI amount + order verification (bonus/coupon + Versand). */
const computeCartCheckoutMoney = (cart, shippingCentsInput) => {
  const items = Array.isArray(cart?.items) ? cart.items : []
  const subtotalCents = items.reduce(
    (sum, it) => sum + Number(it.unit_price_cents || 0) * Number(it.quantity || 1),
    0,
  )
  const reservedPts = Number(cart.bonus_points_reserved || 0)
  const bonusDiscountCents = discountCentsFromBonusPoints(reservedPts)
  const couponDiscountCents = Math.max(0, Number(cart.coupon_discount_cents || 0))
  const discountCents = Math.max(0, bonusDiscountCents + couponDiscountCents)
  const shippingCents = Math.max(0, Number(shippingCentsInput || 0))
  const merchandiseAfterDiscount = Math.max(0, subtotalCents - discountCents)
  const payTotalCents = Math.max(0, merchandiseAfterDiscount + shippingCents)
  return {
    subtotalCents,
    bonusDiscountCents,
    couponDiscountCents,
    discountCents,
    shippingCents,
    merchandiseAfterDiscount,
    payTotalCents,
  }
}

const clearCartBonusReserve = async (client, cartId) => {
  await client.query('UPDATE store_carts SET bonus_points_reserved = 0, updated_at = now() WHERE id = $1', [cartId]).catch(() => {})
}

/**
 * Recalculate coupon_discount_cents from store_carts.coupon_code and current line totals.
 * Stale values after qty/item changes caused PI vs order mismatches (Stripe amount ≠ computeCartCheckoutMoney).
 */
const syncCartCouponDiscountFromLines = async (client, cartId, cartMaybe = null) => {
  const cart = cartMaybe || (await getCartWithItems(client, cartId))
  if (!cart) return null
  const items = Array.isArray(cart.items) ? cart.items : []
  let nextCouponCode = cart.coupon_code || null
  let couponDiscountCents = 0
  if (nextCouponCode) {
    const result = await resolveCartCouponDiscountSync(client, items, nextCouponCode, cart.email || null)
    nextCouponCode = result.nextCouponCode
    couponDiscountCents = result.couponDiscountCents
  }
  await client.query(
    'UPDATE store_carts SET coupon_code = $1, coupon_discount_cents = $2, updated_at = now() WHERE id = $3',
    [nextCouponCode, couponDiscountCents, cartId],
  )
  return getCartWithItems(client, cartId)
}

/**
 * Sipariş tamamlanırken DB'deki bonus/kupon PI oluşturulurkenki Stripe metadata ile uyumsuz kalabiliyor
 * (sekme/redirect, PATCH yarışı). Satır ara toplamı metadata ile aynıysa indirimleri metadata'dan geri yaz.
 */
const reconcileCartCheckoutFromPaymentIntent = async (client, cartId, cart, pi) => {
  const m = pi.metadata && typeof pi.metadata === 'object' ? pi.metadata : {}
  const metaCartId = String(m.cart_id || '').trim()
  if (metaCartId && metaCartId !== cartId) {
    return { ok: false, reason: 'cart_id' }
  }
  const lineItems = Array.isArray(cart.items) ? cart.items : []
  const lineSubtotal = lineItems.reduce(
    (sum, it) => sum + Number(it.unit_price_cents || 0) * Number(it.quantity || 1),
    0,
  )
  const metaSub = parseInt(String(m.subtotal_cents || ''), 10)
  if (Number.isFinite(metaSub) && metaSub >= 0 && metaSub !== lineSubtotal) {
    return { ok: false, reason: 'subtotal' }
  }

  const metaBonusRaw = parseInt(String(m.bonus_points_redeemed != null ? m.bonus_points_redeemed : ''), 10)
  const bonusPts =
    Number.isFinite(metaBonusRaw) && metaBonusRaw >= 0
      ? metaBonusRaw
      : Number(cart.bonus_points_reserved || 0)

  const metaCouponDiscRaw = parseInt(String(m.coupon_discount_cents != null ? m.coupon_discount_cents : ''), 10)
  const couponDisc =
    Number.isFinite(metaCouponDiscRaw) && metaCouponDiscRaw >= 0
      ? metaCouponDiscRaw
      : Math.max(0, Number(cart.coupon_discount_cents || 0))

  let couponCode = cart.coupon_code || null
  if (Object.prototype.hasOwnProperty.call(m, 'coupon_code')) {
    const rawCc = String(m.coupon_code || '').trim()
    couponCode = rawCc ? normalizeCouponCode(rawCc) : null
  }

  await client.query(
    'UPDATE store_carts SET bonus_points_reserved = $1, coupon_discount_cents = $2, coupon_code = $3, updated_at = now() WHERE id = $4',
    [bonusPts, couponDisc, couponCode, cartId],
  )
  const nextCart = await getCartWithItems(client, cartId)
  return { ok: true, cart: nextCart }
}

/**
 * @param {import('pg').Client} client
 * @param {{ customerId: string, pointsDelta: number, description: string, source?: string, orderId?: string|null, returnId?: string|null, occurredAt?: string|Date|null, skipBalanceUpdate?: boolean }} opts
 */
const appendBonusLedger = async (client, opts) => {
  const {
    customerId,
    pointsDelta,
    description,
    source = 'manual',
    orderId = null,
    returnId = null,
    occurredAt = null,
    skipBalanceUpdate = false,
  } = opts
  if (!customerId || !Number.isFinite(Number(pointsDelta))) return
  const at = occurredAt ? new Date(occurredAt).toISOString() : null
  await client.query(
    `INSERT INTO store_customer_bonus_ledger (customer_id, occurred_at, points_delta, description, source, order_id, return_id)
     VALUES ($1::uuid, COALESCE($2::timestamptz, NOW()), $3, $4, $5, $6::uuid, $7::uuid)`,
    [customerId, at, Number(pointsDelta), String(description || '').trim() || '—', String(source).slice(0, 40), orderId || null, returnId || null],
  )
  if (!skipBalanceUpdate) {
    await client.query(
      `UPDATE store_customers SET bonus_points = COALESCE(bonus_points, 0) + $1, updated_at = NOW() WHERE id = $2::uuid`,
      [Number(pointsDelta), customerId],
    )
  }
}

/** Legacy ledger rows ended with " inkl. Versand (+N Punkte)" — strip for display/API. */
const stripLegacyBonusLedgerVersandSuffix = (desc) => {
  if (desc == null || desc === '') return desc
  const s = String(desc).replace(/\s+inkl\.\s*Versand\s*\(\+[0-9]+\s+Punkte\)\s*$/i, '').trim()
  return s || desc
}

const getCartWithItems = async (client, cartId) => {
  const cartRes = await client.query(
    'SELECT id, created_at, updated_at, email, COALESCE(bonus_points_reserved, 0) AS bonus_points_reserved, coupon_code, COALESCE(coupon_discount_cents, 0) AS coupon_discount_cents FROM store_carts WHERE id = $1',
    [cartId],
  )
  const cartRow = cartRes.rows && cartRes.rows[0]
  if (!cartRow) return null
  const itemsRes = await client.query(
    `SELECT ci.id, ci.variant_id, ci.product_id, ci.quantity, ci.unit_price_cents, ci.title, ci.thumbnail, ci.product_handle,
     COALESCE(p1.id, p2.id) AS current_product_id,
     COALESCE(p1.handle, p2.handle) AS current_product_handle,
     COALESCE(p1.metadata->>'shipping_group_id', p2.metadata->>'shipping_group_id') AS shipping_group_id,
     COALESCE(p1.title, p2.title) AS product_title,
     COALESCE(p1.metadata, p2.metadata) AS product_metadata,
     COALESCE(NULLIF(TRIM(ci.seller_id), ''), p1.seller_id, p2.seller_id, 'default') AS seller_id,
     COALESCE(ss.store_name, '') AS seller_store_name
     FROM store_cart_items ci
     LEFT JOIN admin_hub_products p1 ON p1.id::text = ci.product_id
     LEFT JOIN admin_hub_products p2 ON p1.id IS NULL AND p2.handle = ci.product_handle
     LEFT JOIN admin_hub_seller_settings ss ON ss.seller_id = COALESCE(NULLIF(TRIM(ci.seller_id), ''), p1.seller_id, p2.seller_id)
     WHERE ci.cart_id = $1 AND ci.removed_at IS NULL ORDER BY ci.created_at`,
    [cartId]
  )
  const bestsellerIds = await getBestsellerProductIds().catch(() => new Set())
  const items = (itemsRes.rows || []).map((r) => {
    let pm = r.product_metadata
    if (pm != null && typeof pm === 'string') {
      try {
        pm = JSON.parse(pm)
      } catch (_) {
        pm = null
      }
    }
    const isBestseller = bestsellerIds.has(String(r.product_id || '')) || (pm && bestsellerIds.has(String(pm.id || '')))
    const metadataOut = pm && typeof pm === 'object'
      ? (isBestseller ? { ...pm, is_bestseller: true } : pm)
      : (isBestseller ? { is_bestseller: true } : null)
    return {
      id: r.id,
      variant_id: r.variant_id,
      product_id: r.current_product_id || r.product_id,
      quantity: r.quantity,
      unit_price_cents: r.unit_price_cents,
      title: r.title,
      thumbnail: r.thumbnail,
      product_handle: r.current_product_handle || r.product_handle,
      shipping_group_id: r.shipping_group_id || null,
      product_title: r.product_title || null,
      product_metadata: metadataOut,
      seller_id: r.seller_id || 'default',
      seller_store_name: String(r.seller_store_name || '').trim() || null,
    }
  })
  return {
    id: cartRow.id,
    created_at: cartRow.created_at,
    updated_at: cartRow.updated_at,
    bonus_points_reserved: Number(cartRow.bonus_points_reserved || 0),
    coupon_code: cartRow.coupon_code || null,
    coupon_discount_cents: Number(cartRow.coupon_discount_cents || 0),
    items,
  }
}
const storeCartsPOST = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return res.status(503).json({ message: 'Database not configured' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query('INSERT INTO store_carts DEFAULT VALUES RETURNING id, created_at, updated_at')
    const row = r.rows && r.rows[0]
    if (!row) { await client.end(); return res.status(500).json({ message: 'Failed to create cart' }) }
    const cart = await getCartWithItems(client, row.id)
    await client.end()
    res.status(201).json({ cart })
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('Store carts POST:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}
const storeCartGET = async (req, res) => {
  const cartId = (req.params.id || req.params.cartId || '').toString().trim()
  if (!cartId) return res.status(400).json({ message: 'Cart id required' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return res.status(503).json({ message: 'Database not configured' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const cart = await getCartWithItems(client, cartId)
    await client.end()
    if (!cart) return res.status(404).json({ message: 'Cart not found' })
    res.json({ cart })
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('Store cart GET:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

/** PATCH /store/carts/:id — bonus_points_reserved + customer contact info */
const storeCartPATCH = async (req, res) => {
  const cartId = (req.params.id || req.params.cartId || '').toString().trim()
  if (!cartId) return res.status(400).json({ message: 'Cart id required' })
  const body = req.body || {}
  const rawReq = body.bonus_points_reserved ?? body.bonus_points_to_redeem
  const requested = Math.max(0, parseInt(rawReq, 10) || 0)
  const couponCodeRaw = body.coupon_code

  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return res.status(503).json({ message: 'Database not configured' })

  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const cart = await getCartWithItems(client, cartId)
    if (!cart) {
      await client.end()
      return res.status(404).json({ message: 'Cart not found' })
    }
    const items = Array.isArray(cart.items) ? cart.items : []
    const subtotalCents = items.reduce((sum, it) => sum + (Number(it.unit_price_cents || 0) * Number(it.quantity || 1)), 0)

    // Preserve existing bonus_points_reserved if not explicitly provided in this request
    let reserved = rawReq !== undefined ? 0 : Number(cart.bonus_points_reserved || 0)
    if (rawReq !== undefined && requested > 0) {
      const authHeader = req.headers.authorization || ''
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
      const payload = verifyCustomerToken(token)
      if (!payload?.id) {
        await client.end()
        return res.status(401).json({ message: 'Anmeldung erforderlich, um Bonuspunkte einzulösen' })
      }
      const balR = await client.query(
        'SELECT COALESCE(bonus_points, 0) AS bp FROM store_customers WHERE id = $1::uuid',
        [payload.id],
      )
      const balance = Number(balR.rows?.[0]?.bp || 0)
      reserved = clampCartBonusRedemption(requested, balance, subtotalCents)
    }

    let nextCouponCode = cart.coupon_code || null
    let couponDiscountCents = 0
    if (couponCodeRaw !== undefined) {
      const incoming = normalizeCouponCode(couponCodeRaw)
      nextCouponCode = incoming || null
    }
    if (nextCouponCode) {
      const result = await resolveCartCouponDiscountSync(client, items, nextCouponCode, cart.email || null)
      if (result.invalid) {
        if (couponCodeRaw !== undefined) {
          await client.end()
          return res.status(400).json({ message: 'Ungültiger oder abgelaufener Coupon-Code' })
        }
        nextCouponCode = null
        couponDiscountCents = 0
      } else {
        nextCouponCode = result.nextCouponCode
        couponDiscountCents = result.couponDiscountCents
      }
    }

    // Save customer contact info if provided
    if (body.email !== undefined || body.first_name !== undefined || body.last_name !== undefined || body.phone !== undefined) {
      const fields = []; const vals = []
      if (body.email !== undefined) { vals.push(body.email || null); fields.push(`email = $${vals.length}`) }
      if (body.first_name !== undefined) { vals.push(body.first_name || null); fields.push(`first_name = $${vals.length}`) }
      if (body.last_name !== undefined) { vals.push(body.last_name || null); fields.push(`last_name = $${vals.length}`) }
      if (body.phone !== undefined) { vals.push(body.phone || null); fields.push(`phone = $${vals.length}`) }
      vals.push(cartId)
      await client.query(`UPDATE store_carts SET ${fields.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals)
    }
    await client.query(
      'UPDATE store_carts SET bonus_points_reserved = $1, coupon_code = $2, coupon_discount_cents = $3, updated_at = now() WHERE id = $4',
      [reserved, nextCouponCode, couponDiscountCents, cartId],
    )
    const updated = await getCartWithItems(client, cartId)
    await client.end()
    res.json({
      cart: updated,
      bonus_discount_cents: discountCentsFromBonusPoints(reserved),
      coupon_discount_cents: couponDiscountCents,
      bonus_points_reserved: reserved,
      coupon_code: nextCouponCode,
    })
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('Store cart PATCH:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

const storeCartLineItemsPOST = async (req, res) => {
  const cartId = (req.params.id || req.params.cartId || '').toString().trim()
  if (!cartId) return res.status(400).json({ message: 'Cart id required' })
  const body = req.body || {}
  const variantId = (body.variant_id || body.variantId || '').toString().trim()
  const quantity = Math.max(1, parseInt(body.quantity, 10) || 1)
  const chosenSellerId = (body.seller_id || '').toString().trim() || null
  if (!variantId) return res.status(400).json({ message: 'variant_id required' })
  const productId = productIdFromVariantId(variantId)
  if (!productId) return res.status(400).json({ message: 'Invalid variant_id' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return res.status(503).json({ message: 'Database not configured' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const product = await getAdminHubProductByIdOrHandleDb(productId)
    if (!product) { await client.end(); return res.status(404).json({ message: 'Product not found' }) }
    const meta = product.metadata && typeof product.metadata === 'object' ? product.metadata : {}
    const destCountry = normalizeCountryCode(body.country || body.shipping_country || body.market_country) || 'DE'
    const priceCents = product.price_cents != null ? Number(product.price_cents) : Math.round(Number(product.price || 0) * 100)
    const rawVariants = Array.isArray(product.variants) && product.variants.length > 0 ? product.variants : []
    let unitPriceCents = priceCents
    const variantIndex = variantId.includes('-v-')
      ? parseInt(variantId.split('-v-')[1], 10)
      : variantId.includes('-variant-')
        ? parseInt(variantId.split('-variant-').pop(), 10)
        : null
    let variantLabel = ''
    if (rawVariants.length && variantIndex >= 0 && rawVariants[variantIndex]) {
      const v = rawVariants[variantIndex]
      if (v.price_cents != null) unitPriceCents = Number(v.price_cents)
      else if (v.price != null) unitPriceCents = Math.round(Number(v.price) * 100)
      const optVals = Array.isArray(v.option_values) && v.option_values.length > 0 ? v.option_values : null
      const variationGroups = Array.isArray(meta.variation_groups) ? meta.variation_groups : null
      if (optVals && variationGroups && variationGroups.length === optVals.length) {
        const toUpper = (g) => (g && g.name ? String(g.name).toUpperCase() : '')
        variantLabel = variationGroups.map((g, i) => `${toUpper(g)}: ${optVals[i] || ''}`).join(' / ')
      } else if (optVals) {
        variantLabel = optVals.join(' / ')
      } else {
        variantLabel = v.title || v.value || ''
      }
    }
    // Image resolution must match the PDP's own priority (ProductTemplate.jsx: variant's own
    // media/image_url first, product-level thumbnail only as fallback) — a naive top-level
    // metadata.media lookup here used to show a sibling/product-level image (e.g. inherited
    // from "add existing product" prefill) instead of the specific variant actually added.
    const mappedForThumb = mapAdminHubToStoreProduct(product)
    const mappedVariant = variantIndex != null && Number.isFinite(variantIndex) ? mappedForThumb.variants?.[variantIndex] : null
    const thumb = mappedVariant?.images?.[0] || mappedVariant?.image_url || mappedForThumb.thumbnail || null
    // If a specific seller is chosen (Andere Verkäufer / buybox), their listing price wins.
    const productSellerId = product.seller_id ? String(product.seller_id).trim() : ''
    const lineSellerId = chosenSellerId || (productSellerId && productSellerId !== 'default' ? productSellerId : null) || null
    let listingApplied = false
    if (lineSellerId) {
      const listingRow = await client.query(
        `SELECT price_cents FROM admin_hub_seller_listings WHERE product_id = $1 AND seller_id = $2 AND status = 'active' LIMIT 1`,
        [String(product.id || productId), lineSellerId]
      )
      if (listingRow.rows[0]) {
        unitPriceCents = Number(listingRow.rows[0].price_cents)
        listingApplied = true
      }
    }
    const variantPrices = rawVariants.length && variantIndex >= 0 && rawVariants[variantIndex]
      && rawVariants[variantIndex].metadata && typeof rawVariants[variantIndex].metadata === 'object'
      ? rawVariants[variantIndex].metadata.prices
      : null
    const exactCountryPrice = pickCountryMerchandiseCents(variantPrices, destCountry, { fallbackDe: false })
      || pickCountryMerchandiseCents(meta.prices, destCountry, { fallbackDe: false })
    if (exactCountryPrice != null) unitPriceCents = exactCountryPrice
    else if (!listingApplied) {
      const fallbackPrice = pickCountryMerchandiseCents(variantPrices, destCountry, { fallbackDe: true })
        || pickCountryMerchandiseCents(meta.prices, destCountry, { fallbackDe: true })
      if (fallbackPrice != null) unitPriceCents = fallbackPrice
    }
    const sellerForCamp = lineSellerId || ''
    if (sellerForCamp) {
      try {
        const campRow = await findBestSellerCampaignDiscountRow(client, {
          productId: String(product.id || productId),
          variantId,
          sellerId: sellerForCamp,
        })
        if (campRow) unitPriceCents = applySellerCampaignToPriceCents(unitPriceCents, campRow)
      } catch (_) {}
    }
    const title = (product.title || 'Product') + (variantLabel ? ` (${variantLabel})` : '')
    const handle = product.handle || product.id
    const cartExists = await client.query('SELECT id FROM store_carts WHERE id = $1', [cartId])
    if (!cartExists.rows || !cartExists.rows[0]) { await client.end(); return res.status(404).json({ message: 'Cart not found' }) }
    const existing = lineSellerId
      ? await client.query(
          `SELECT id, quantity FROM store_cart_items
           WHERE cart_id = $1 AND variant_id = $2 AND removed_at IS NULL
             AND COALESCE(NULLIF(TRIM(seller_id), ''), '') = $3`,
          [cartId, variantId, lineSellerId]
        )
      : await client.query(
          `SELECT id, quantity FROM store_cart_items
           WHERE cart_id = $1 AND variant_id = $2 AND removed_at IS NULL
             AND (seller_id IS NULL OR TRIM(seller_id) = '' OR seller_id = 'default')`,
          [cartId, variantId]
        )
    if (existing.rows && existing.rows[0]) {
      const newQty = (existing.rows[0].quantity || 0) + quantity
      await client.query(
        'UPDATE store_cart_items SET quantity = $1, seller_id = COALESCE($2, seller_id), unit_price_cents = $3, updated_at = now() WHERE id = $4',
        [newQty, lineSellerId, unitPriceCents, existing.rows[0].id]
      )
    } else {
      await client.query(
        'INSERT INTO store_cart_items (cart_id, variant_id, product_id, quantity, unit_price_cents, title, thumbnail, product_handle, seller_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [cartId, variantId, String(product.id || productId), quantity, unitPriceCents, title, thumb, handle, lineSellerId]
      )
    }
    await clearCartBonusReserve(client, cartId)
    // Backfill customer identity onto the cart as soon as we know it (logged-in add-to-cart),
    // instead of only capturing it once the shopper reaches the checkout form — a cart that's
    // abandoned before checkout would otherwise show up with a blank Kunde/E-Mail forever.
    const authHeader = req.headers.authorization || ''
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
    const customerPayload = bearerToken ? verifyCustomerToken(bearerToken) : null
    if (customerPayload?.id) {
      await client.query(
        `UPDATE store_carts SET
           email = COALESCE(NULLIF(email, ''), (SELECT email FROM store_customers WHERE id = $1::uuid)),
           first_name = COALESCE(NULLIF(first_name, ''), (SELECT first_name FROM store_customers WHERE id = $1::uuid)),
           last_name = COALESCE(NULLIF(last_name, ''), (SELECT last_name FROM store_customers WHERE id = $1::uuid)),
           updated_at = now()
         WHERE id = $2`,
        [customerPayload.id, cartId]
      ).catch(() => {})
    }
    const cart = await syncCartCouponDiscountFromLines(client, cartId)
    await client.end()
    res.json({ cart })
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('Store cart line-items POST:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}
const storeCartLineItemPATCH = async (req, res) => {
  const cartId = (req.params.id || req.params.cartId || '').toString().trim()
  const lineId = (req.params.lineId || req.params.line_id || '').toString().trim()
  if (!cartId || !lineId) return res.status(400).json({ message: 'Cart id and line item id required' })
  const quantity = Math.max(0, parseInt((req.body || {}).quantity, 10))
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return res.status(503).json({ message: 'Database not configured' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    if (quantity === 0) {
      // Soft-delete (removed_at) instead of a hard DELETE, so abandoned-checkout reporting can
      // still tell "customer removed this item" apart from "item is still in the cart".
      await client.query('UPDATE store_cart_items SET removed_at = now(), updated_at = now() WHERE cart_id = $1 AND id = $2 AND removed_at IS NULL', [cartId, lineId])
    } else {
      const up = await client.query('UPDATE store_cart_items SET quantity = $1, updated_at = now() WHERE cart_id = $2 AND id = $3 AND removed_at IS NULL RETURNING id', [quantity, cartId, lineId])
      if (!up.rows || !up.rows[0]) { await client.end(); return res.status(404).json({ message: 'Line item not found' }) }
    }
    await clearCartBonusReserve(client, cartId)
    const cart = await syncCartCouponDiscountFromLines(client, cartId)
    await client.end()
    res.json({ cart })
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('Store cart line-item PATCH:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}
const storeCartLineItemDELETE = async (req, res) => {
  const cartId = (req.params.id || req.params.cartId || '').toString().trim()
  const lineId = (req.params.lineId || req.params.line_id || '').toString().trim()
  if (!cartId || !lineId) return res.status(400).json({ message: 'Cart id and line item id required' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return res.status(503).json({ message: 'Database not configured' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const del = await client.query('UPDATE store_cart_items SET removed_at = now(), updated_at = now() WHERE cart_id = $1 AND id = $2 AND removed_at IS NULL RETURNING id', [cartId, lineId])
    if (!del.rows || !del.rows[0]) { await client.end(); return res.status(404).json({ message: 'Line item not found' }) }
    await clearCartBonusReserve(client, cartId)
    const cart = await syncCartCouponDiscountFromLines(client, cartId)
    await client.end()
    res.json({ cart })
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('Store cart line-item DELETE:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

// Clear cart: delete all line items
const storeCartClearDELETE = async (req, res) => {
  const cartId = (req.params.id || req.params.cartId || '').toString().trim()
  if (!cartId) return res.status(400).json({ message: 'Cart id required' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return res.status(503).json({ message: 'Database not configured' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    // Ensure cart exists
    const cartExists = await client.query('SELECT id FROM store_carts WHERE id = $1', [cartId])
    if (!cartExists.rows || !cartExists.rows[0]) { await client.end(); return res.status(404).json({ message: 'Cart not found' }) }
    await client.query('UPDATE store_cart_items SET removed_at = now(), updated_at = now() WHERE cart_id = $1 AND removed_at IS NULL', [cartId])
    await clearCartBonusReserve(client, cartId)
    const cart = await syncCartCouponDiscountFromLines(client, cartId)
    await client.end()
    res.json({ cart })
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('Store cart clear DELETE:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

/** store_name → company_name → first/last — für Stripe-Beschreibungen */
async function resolveSellerDisplayNameForStripe(client, sellerId) {
  const sid = String(sellerId || '').trim()
  if (!sid || sid === 'default') return ''
  try {
    const r = await client.query(
      `SELECT store_name, company_name, first_name, last_name FROM seller_users WHERE seller_id = $1 LIMIT 1`,
      [sid],
    )
    const row = r.rows?.[0]
    if (!row) return sid
    const store = String(row.store_name || '').trim()
    const company = String(row.company_name || '').trim()
    const person = [row.first_name, row.last_name].filter(Boolean).join(' ').trim()
    return store || company || person || sid
  } catch (_) {
    return sid
  }
}

function truncateForStripeDescription(s, maxLen = 120) {
  let out = String(s || '').replace(/\s+/g, ' ').trim()
  if (!out) return ''
  if (out.length > maxLen) out = `${out.slice(0, Math.max(0, maxLen - 1))}…`
  return out
}

// --- Store Payment Intent (Stripe) ---
const storePaymentIntentPOST = async (req, res) => {
  const body = req.body || {}
  const cartId = (body.cart_id || body.cartId || '').toString().trim()
  if (!cartId) return res.status(400).json({ message: 'cart_id required' })

  const { Client } = require('pg')
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return res.status(503).json({ message: 'Database not configured' })

  let client
  try {
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    let cart = await getCartWithItems(client, cartId)
    if (!cart) {
      await client.end()
      return res.status(404).json({ message: 'Cart not found' })
    }
    cart = (await syncCartCouponDiscountFromLines(client, cartId, cart)) || cart

    const items = Array.isArray(cart.items) ? cart.items : []
    if (!items.length) {
      await client.end()
      return res.status(400).json({ message: 'Cart is empty' })
    }
    
    const shippingCentsRaw = Math.max(0, Number(body.shipping_cents || 0))
    const money = computeCartCheckoutMoney(cart, shippingCentsRaw)
    const {
      subtotalCents,
      bonusDiscountCents,
      couponDiscountCents,
      discountCents,
      shippingCents,
      payTotalCents: payCents,
    } = money
    const reservedPtsPre = Number(cart.bonus_points_reserved || 0)
    if (payCents <= 0) {
      await client.end()
      return res.status(200).json({
        zero_checkout: true,
        amount_cents: 0,
        pay_total_cents: 0,
        subtotal_cents: subtotalCents,
        shipping_cents: shippingCents,
        bonus_discount_cents: bonusDiscountCents,
        coupon_discount_cents: couponDiscountCents,
        discount_cents: discountCents,
        coupon_code: cart.coupon_code || null,
        bonus_points_reserved: reservedPtsPre,
        requires_customer_auth: true,
        message:
          'Der zu zahlende Betrag ist 0 €. Sie können die Bestellung mit eingelösten Bonuspunkten / Rabatt abschließen (ohne Kartenzahlung).',
      })
    }

    // The order owner is always the platform (Andertal), never "whichever seller happened to
    // own the cart's first item" — a cart routinely mixes items from multiple sellers, and even
    // a single-seller cart must behave the same way for consistency (see order-creation below,
    // which mirrors this). Per-seller payout is settled internally from store_order_items.seller_id
    // (see payouts.js/transactions.js), not by routing the customer's payment to a seller's own
    // Stripe account — so no Destination Charge / transfer_data is used here anymore.
    const cartSellerId = 'default'
    const cartSellerLabel = 'Marketplace'

    const platformRow = await loadPlatformCheckoutRow(client)
    const secretKeyResolved = resolveStripeSecretKeyFromPlatform(platformRow)
    if (!secretKeyResolved) {
      await client.end()
      return res.status(503).json({ message: 'Stripe Secret Key nicht konfiguriert — Sellercentral → Einstellungen → Checkout speichern.' })
    }

    const paymentMethodTypes = paymentMethodTypesFromPlatformRow(platformRow)
    const stripe = new (require('stripe'))(secretKeyResolved)
    const authHdr = (req.headers.authorization || '').toString()
    const bearerTok = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : ''
    let stripeCustomerId = null
    /** Set when logged-in store row exists — used to recover stale Stripe customer ids */
    let stripeCustomerRecovery = null
    if (bearerTok) {
      const payload = verifyCustomerToken(bearerTok)
      if (payload?.id) {
        const custR = await client.query(
          'SELECT id, email, first_name, last_name, stripe_customer_id FROM store_customers WHERE id = $1::uuid',
          [String(payload.id)],
        )
        const c = custR.rows?.[0]
        if (c) {
          stripeCustomerRecovery = {
            dbId: c.id,
            email: c.email || payload.email || null,
            first_name: c.first_name,
            last_name: c.last_name,
          }
          stripeCustomerId = c.stripe_customer_id || null
          if (!stripeCustomerId) {
            const sc = await stripe.customers.create({
              email: c.email || payload.email || undefined,
              name: [c.first_name, c.last_name].filter(Boolean).join(' ').trim() || undefined,
              metadata: { andertal_customer_id: c.id },
            })
            stripeCustomerId = sc.id
            await client.query('UPDATE store_customers SET stripe_customer_id = $1 WHERE id = $2::uuid', [stripeCustomerId, c.id])
          }
        }
      }
    }
    const reservedPts = Number(cart.bonus_points_reserved || 0)
    const piBody = {
      amount: payCents,
      currency: 'eur',
      payment_method_types: paymentMethodTypes,
      description: `Checkout — ${cartSellerLabel}`,
      metadata: {
        cart_id: cartId,
        seller_id: String(cartSellerId),
        seller_name: cartSellerLabel,
        subtotal_cents: String(subtotalCents),
        /** Seller/commerce basis before bonus (same as subtotal lines); bonus is platform-funded. */
        seller_settlement_basis_cents: String(subtotalCents),
        platform_bonus_subsidy_cents: String(bonusDiscountCents),
        discount_cents: String(discountCents),
        coupon_discount_cents: String(couponDiscountCents),
        coupon_code: String(cart.coupon_code || ''),
        bonus_points_redeemed: String(reservedPts),
        shipping_cents_snapshot: String(shippingCents),
        pay_total_cents: String(payCents),
      },
    }
    if (stripeCustomerId) {
      piBody.customer = stripeCustomerId
      // Required by Stripe when Customer Session has payment_method_save=enabled
      piBody.setup_future_usage = 'off_session'
    }

    const cancelPiId = (body.cancel_payment_intent_id || '').toString().trim()
    let paymentIntent = null
    if (cancelPiId && cancelPiId.startsWith('pi_')) {
      try {
        const prev = await stripe.paymentIntents.retrieve(cancelPiId)
        const prevCart = String(prev.metadata?.cart_id || '').trim()
        // Reusing the same PaymentIntent (updating amount in place) keeps the client_secret
        // unchanged, so the Stripe Elements form on the frontend does NOT get remounted —
        // recreating a new PaymentIntent here forces a remount that wipes every field the
        // customer already typed (address, name, etc.). Stripe explicitly supports updating
        // amount on an unconfirmed PaymentIntent for exactly this reason.
        const updatableStatuses = new Set(['requires_payment_method', 'requires_confirmation', 'requires_action'])
        if (prevCart === cartId && updatableStatuses.has(prev.status)) {
          try {
            const updateBody = { amount: payCents, metadata: piBody.metadata }
            if (piBody.application_fee_amount != null) updateBody.application_fee_amount = piBody.application_fee_amount
            paymentIntent = await stripe.paymentIntents.update(cancelPiId, updateBody)
          } catch (_) {
            paymentIntent = null
          }
        } else if (prevCart === cartId && prev.status !== 'succeeded' && prev.status !== 'canceled') {
          await stripe.paymentIntents.cancel(cancelPiId).catch(() => {})
        }
      } catch (_) {}
    }

    try {
      if (!paymentIntent) paymentIntent = await stripe.paymentIntents.create(piBody)
    } catch (stripeErr) {
      const code = stripeErr && stripeErr.code
      const param = stripeErr && stripeErr.param
      const errMsg = String((stripeErr && stripeErr.message) || '')
      const noSuchCustomer =
        (code === 'resource_missing' && param === 'customer') ||
        /\bno such customer\b/i.test(errMsg)
      if (noSuchCustomer && stripeCustomerId && stripeCustomerRecovery) {
        await client.query('UPDATE store_customers SET stripe_customer_id = NULL WHERE id = $1::uuid', [
          stripeCustomerRecovery.dbId,
        ])
        const sc = await stripe.customers.create({
          email: stripeCustomerRecovery.email || undefined,
          name: [stripeCustomerRecovery.first_name, stripeCustomerRecovery.last_name].filter(Boolean).join(' ').trim() || undefined,
          metadata: { andertal_customer_id: stripeCustomerRecovery.dbId },
        })
        const newStripeId = sc.id
        await client.query('UPDATE store_customers SET stripe_customer_id = $1 WHERE id = $2::uuid', [
          newStripeId,
          stripeCustomerRecovery.dbId,
        ])
        piBody.customer = newStripeId
        paymentIntent = await stripe.paymentIntents.create(piBody)
      } else {
        throw stripeErr
      }
    }

    let customerSessionSecret = null
    if (stripeCustomerId) {
      try {
        const cs = await stripe.customerSessions.create({
          customer: stripeCustomerId,
          components: {
            payment_element: {
              enabled: true,
              features: {
                payment_method_save: 'enabled',
                payment_method_redisplay: 'enabled',
                payment_method_remove: 'enabled',
              },
            },
          },
        })
        customerSessionSecret = cs.client_secret
      } catch (_) {}
    }

    await client.end()
    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id,
      customer_session_secret: customerSessionSecret,
      amount_cents: payCents,
      subtotal_cents: subtotalCents,
      shipping_cents: shippingCents,
      bonus_discount_cents: bonusDiscountCents,
      coupon_discount_cents: couponDiscountCents,
      discount_cents: discountCents,
      coupon_code: cart.coupon_code || null,
      bonus_points_reserved: reservedPts,
    })
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('Store payment-intent POST:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

// --- Store Orders (Stripe payment success sonrası) ---
const getOrderWithItems = async (client, orderId) => {
  const oRes = await client.query(
    `SELECT id, order_number, cart_id, payment_intent_id, status, order_status, payment_status, delivery_status, email, first_name, last_name, phone, address_line1, address_line2, city, postal_code, country, billing_address_line1, billing_address_line2, billing_city, billing_postal_code, billing_country, billing_same_as_shipping, payment_method, customer_id, is_guest, newsletter_opted_in, subtotal_cents, total_cents, COALESCE(shipping_cents,0) AS shipping_cents, COALESCE(discount_cents,0) AS discount_cents, COALESCE(coupon_discount_cents,0) AS coupon_discount_cents, coupon_code, COALESCE(bonus_points_redeemed,0) AS bonus_points_redeemed, currency, locale, created_at, updated_at,
      COALESCE(checkout_payment_kind, 'stripe') AS checkout_payment_kind,
      COALESCE(seller_net_after_commission_cents, 0) AS seller_net_after_commission_cents,
      COALESCE(stripe_application_fee_cents, 0) AS stripe_application_fee_cents
     FROM store_orders WHERE id = $1`,
    [orderId]
  )
  const oRow = oRes.rows && oRes.rows[0]
  if (!oRow) return null

  const itemsRes = await client.query(
    `SELECT oi.id, oi.variant_id, oi.product_id, oi.quantity, oi.unit_price_cents, oi.title, oi.thumbnail, oi.product_handle,
     COALESCE(p1.id, p2.id) AS current_product_id,
     COALESCE(p1.title, p2.title) AS product_title,
     COALESCE(p1.handle, p2.handle) AS current_product_handle,
     COALESCE(p1.metadata, p2.metadata) AS product_metadata
     FROM store_order_items oi
     LEFT JOIN admin_hub_products p1 ON p1.id::text = oi.product_id
     LEFT JOIN admin_hub_products p2 ON p1.id IS NULL AND p2.handle = oi.product_handle
     WHERE oi.order_id = $1 ORDER BY oi.created_at`,
    [orderId]
  )
  const items = (itemsRes.rows || []).map((r) => {
    let pm = r.product_metadata
    if (pm != null && typeof pm === 'string') { try { pm = JSON.parse(pm) } catch (_) { pm = null } }
    return {
      id: r.id,
      variant_id: r.variant_id,
      product_id: r.current_product_id || r.product_id,
      quantity: r.quantity,
      unit_price_cents: r.unit_price_cents,
      title: r.title,
      thumbnail: r.thumbnail,
      product_handle: r.current_product_handle || r.product_handle,
      product_title: r.product_title || null,
      product_metadata: pm && typeof pm === 'object' ? pm : null,
    }
  })

  return {
    id: oRow.id,
    order_number: oRow.order_number ? Number(oRow.order_number) : null,
    cart_id: oRow.cart_id,
    payment_intent_id: oRow.payment_intent_id,
    payment_method: oRow.payment_method,
    billing_address_line1: oRow.billing_address_line1,
    billing_address_line2: oRow.billing_address_line2,
    billing_city: oRow.billing_city,
    billing_postal_code: oRow.billing_postal_code,
    billing_country: oRow.billing_country,
    billing_same_as_shipping: oRow.billing_same_as_shipping !== false,
    customer_id: oRow.customer_id,
    is_guest: oRow.is_guest !== false,
    newsletter_opted_in: oRow.newsletter_opted_in === true,
    status: oRow.status,
    order_status: oRow.order_status,
    payment_status: oRow.payment_status,
    delivery_status: oRow.delivery_status,
    email: oRow.email,
    first_name: oRow.first_name,
    last_name: oRow.last_name,
    phone: oRow.phone,
    address_line1: oRow.address_line1,
    address_line2: oRow.address_line2,
    city: oRow.city,
    postal_code: oRow.postal_code,
    country: oRow.country,
    subtotal_cents: oRow.subtotal_cents,
    shipping_cents: Number(oRow.shipping_cents || 0),
    discount_cents: Number(oRow.discount_cents || 0),
    coupon_discount_cents: Number(oRow.coupon_discount_cents || 0),
    coupon_code: oRow.coupon_code || null,
    bonus_points_redeemed: Number(oRow.bonus_points_redeemed || 0),
    total_cents: resolveOrderPaidTotalCents(oRow),
    checkout_payment_kind: oRow.checkout_payment_kind || 'stripe',
    seller_net_after_commission_cents: Number(oRow.seller_net_after_commission_cents || 0),
    stripe_application_fee_cents: Number(oRow.stripe_application_fee_cents || 0),
    settlement_breakdown: buildOrderSettlementBreakdown(
      {
        subtotal_cents: oRow.subtotal_cents,
        total_cents: oRow.total_cents,
        shipping_cents: oRow.shipping_cents,
        discount_cents: oRow.discount_cents,
        coupon_discount_cents: oRow.coupon_discount_cents,
        country: oRow.country,
        stripe_application_fee_cents: oRow.stripe_application_fee_cents,
        checkout_payment_kind: oRow.checkout_payment_kind,
        seller_net_after_commission_cents: oRow.seller_net_after_commission_cents,
      },
      0.12,
    ),
    currency: oRow.currency,
    created_at: oRow.created_at,
    updated_at: oRow.updated_at,
    items,
  }
}

// ── Customer Auth Helpers ─────────────────────────────────────────────
const _crypto = require('crypto')
const _rawCustomerSecret = process.env.CUSTOMER_JWT_SECRET || process.env.JWT_SECRET || ''
// Same rationale as SELLER_JWT_SECRET in seller-auth.js: gate on "pointed at the real DB", not
// NODE_ENV, which can be unset on the actual deployment and silently leave every customer
// impersonable via the public fallback secret.
const _isRealCustomerDeployment = process.env.NODE_ENV === 'production' || /render\.com/i.test(process.env.DATABASE_URL || '')
if (!_rawCustomerSecret && _isRealCustomerDeployment) {
  console.error('[SECURITY] CUSTOMER_JWT_SECRET env var is not set — refusing to start with a guessable fallback secret against a real database.')
  process.exit(1)
}
const CUSTOMER_JWT_SECRET = _rawCustomerSecret || 'dev-only-customer-secret-do-not-use-in-prod'
// Token lifetime: 7 days (same as seller tokens)
const CUSTOMER_TOKEN_TTL_SECONDS = 7 * 24 * 3600

function hashPassword(password) {
  const salt = _crypto.randomBytes(16).toString('hex')
  const hash = _crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':')
    if (!salt || !hash) return false
    const attempt = _crypto.scryptSync(password, salt, 64).toString('hex')
    return attempt === hash
  } catch { return false }
}

function signCustomerToken(payload) {
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + CUSTOMER_TOKEN_TTL_SECONDS })).toString('base64url')
  const sig = _crypto.createHmac('sha256', CUSTOMER_JWT_SECRET).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

function verifyCustomerToken(token) {
  if (!token) return null
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, body, sig] = parts
    const expected = _crypto.createHmac('sha256', CUSTOMER_JWT_SECRET).update(`${header}.${body}`).digest('base64url')
    if (sig !== expected) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null
    return payload
  } catch { return null }
}

const _CUSTOMER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function customerIdForPg(payload) {
  if (!payload?.id) return null
  const raw = String(payload.id).trim()
  return _CUSTOMER_UUID_RE.test(raw) ? raw : null
}

// POST /store/customers — register customer
const CustomerRegisterSchema = z.object({
  email:      zEmail,
  password:   zPassword,
  first_name: z.string().max(60).optional(),
  last_name:  z.string().max(60).optional(),
  phone:      z.string().max(30).optional(),
  locale:     z.string().max(5).optional(),
})
const storeCustomerRegisterPOST = async (req, res) => {
  const parsed = validate(CustomerRegisterSchema, req.body || {}, res)
  if (!parsed) return
  const body = parsed
  const email = body.email.trim().toLowerCase()
  const password = body.password
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl) return res.status(503).json({ message: 'Database not configured' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const existing = await client.query(
      'SELECT id, password_hash FROM store_customers WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))',
      [email],
    )
    const rows = existing.rows || []
    // Any row with a password = registered account (handles duplicate email rows from pre-normalization)
    if (rows.some((r) => r.password_hash)) {
      await client.end()
      return res.status(409).json({ message: 'An account with this email already exists' })
    }
    // Multiple guest-only rows (e.g. same email different casing) — remove and insert one clean row
    if (rows.length > 1) {
      await client.query('DELETE FROM store_customers WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))', [email])
    }
    const existingRow = rows.length === 1 ? rows[0] : null
    const password_hash = hashPassword(password)
    const first_name = (body.first_name || '').trim() || null
    const last_name = (body.last_name || '').trim() || null
    const phone = (body.phone || '').trim() || null
    const account_type = ['privat', 'gewerbe'].includes(body.account_type) ? body.account_type : 'privat'
    const gender = (body.gender || '').trim() || null
    const birth_date = (body.birth_date || '').trim() || null
    const address_line1 = (body.address_line1 || '').trim() || null
    const address_line2 = (body.address_line2 || '').trim() || null
    const zip_code = (body.zip_code || '').trim() || null
    const city = (body.city || '').trim() || null
    const country = (body.country || '').trim() || null
    const company_name = (body.company_name || '').trim() || null
    const vat_number = (body.vat_number || '').trim() || null
    const SHOP_LOCALES = ['en', 'de', 'tr', 'fr', 'it', 'es']
    const preferredLocaleRaw = String(body.locale || '').trim().toLowerCase()
    const preferredLocale = SHOP_LOCALES.includes(preferredLocaleRaw) ? preferredLocaleRaw : null
    let r
    if (existingRow) {
      // Guest entry exists — upgrade to registered account
      r = await client.query(
        `UPDATE store_customers SET password_hash=$1, first_name=$2, last_name=$3, phone=$4, account_type=$5,
         gender=$6, birth_date=$7::date, address_line1=$8, address_line2=$9, zip_code=$10, city=$11,
         country=$12, company_name=$13, vat_number=$14,
         locale = COALESCE($16, locale),
         bonus_points = COALESCE(bonus_points, 0) + ${BONUS_SIGNUP_POINTS}, updated_at=NOW()
         WHERE id=$15
         RETURNING id, customer_number, email, first_name, last_name, phone, account_type, company_name, locale, created_at`,
        [password_hash, first_name, last_name, phone, account_type, gender, birth_date || null,
         address_line1, address_line2, zip_code, city, country, company_name, vat_number, existingRow.id, preferredLocale]
      )
    }
    // UPDATE 0 rows (satır silinmiş / yarış) → INSERT; misafir yokken de INSERT
    if (!existingRow || !r.rows[0]) {
      r = await client.query(
        `INSERT INTO store_customers (email, password_hash, first_name, last_name, phone, account_type, gender, birth_date, address_line1, address_line2, zip_code, city, country, company_name, vat_number, bonus_points, locale)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING id, customer_number, email, first_name, last_name, phone, account_type, company_name, locale, created_at`,
        [email, password_hash, first_name, last_name, phone, account_type, gender, birth_date || null, address_line1, address_line2, zip_code, city, country, company_name, vat_number, BONUS_SIGNUP_POINTS, preferredLocale]
      )
    }
    const customer = {
      ...r.rows[0],
      customer_number: r.rows[0].customer_number ? Number(r.rows[0].customer_number) : null,
      locale: r.rows[0].locale || preferredLocale || null,
    }
    const cid = r.rows[0].id
    if (vat_number) {
      // Follow-up UPDATE (not folded into the INSERT/UPDATE above) so a slow/unreachable VIES
      // service can never delay account creation — registration always completes immediately.
      try {
        const viesResult = await resolveViesVerification(vat_number)
        await client.query(
          `UPDATE store_customers SET vies_valid=$1, vies_checked_at=$2, vies_company_name=$3 WHERE id=$4::uuid`,
          [viesResult.vies_valid, viesResult.vies_checked_at, viesResult.vies_company_name, cid],
        )
        Object.assign(customer, viesResult)
      } catch (ve) {
        console.warn('vies check on register:', ve?.message || ve)
      }
    }
    try {
      await appendBonusLedger(client, {
        customerId: cid,
        pointsDelta: BONUS_SIGNUP_POINTS,
        description: `Registrierung — Willkommensbonus (+${BONUS_SIGNUP_POINTS} Punkte)`,
        source: 'registration',
        skipBalanceUpdate: true,
      })
    } catch (le) {
      console.warn('bonus ledger registration:', le?.message || le)
    }
    await client.end()
    res.status(201).json({ customer })
    setImmediate(() => {
      try { require('../flow-automation').runAutomationFlowsForCustomerEvent({ triggerKey: 'customer_signup', customerId: cid, email, locale: body.locale }).catch(() => {}) } catch (_) {}
    })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    if (e.code === '23505') return res.status(409).json({ message: 'An account with this email already exists' })
    res.status(500).json({ message: e?.message || 'Registration failed' })
  }
}

// GET /store/customers/email-exists?email=... — used by the register form to warn inline,
// before submit, that an account already exists (register itself already reveals this via
// a 409 on submit — this just surfaces it earlier).
const storeCustomerEmailExistsGET = async (req, res) => {
  const email = String(req.query?.email || '').trim().toLowerCase()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.json({ exists: false })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl) return res.json({ exists: false })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(
      'SELECT 1 FROM store_customers WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) AND password_hash IS NOT NULL LIMIT 1',
      [email],
    )
    await client.end()
    res.json({ exists: r.rows.length > 0 })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.json({ exists: false })
  }
}

// PATCH /store/customers/me — update own profile/address
const storeCustomerMePATCH = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const payload = verifyCustomerToken(token)
  if (!payload) return res.status(401).json({ message: 'Unauthorized' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const body = req.body || {}
  const allowed = ['first_name','last_name','phone','account_type','address_line1','address_line2','zip_code','city','country','company_name','vat_number','locale']
  const SHOP_LOCALES = ['en', 'de', 'tr', 'fr', 'it', 'es']
  const sets = []
  const vals = []
  for (const key of allowed) {
    if (!(key in body)) continue
    if (key === 'locale') {
      const loc = String(body.locale || '').trim().toLowerCase()
      if (!SHOP_LOCALES.includes(loc)) continue
      vals.push(loc)
      sets.push(`locale = $${vals.length}`)
      continue
    }
    vals.push(body[key] || null)
    sets.push(`${key} = $${vals.length}`)
  }
  if (!sets.length) return res.status(400).json({ message: 'Nothing to update' })

  // Live VIES re-verification whenever the VAT-ID itself changes (not on every unrelated profile
  // edit) — a cleared field resets the stored verification instead of leaving a stale badge.
  if ('vat_number' in body) {
    const nextVat = String(body.vat_number || '').trim()
    const viesResult = nextVat ? await resolveViesVerification(nextVat) : { vies_valid: null, vies_checked_at: null, vies_company_name: null }
    for (const [col, val] of Object.entries(viesResult)) {
      vals.push(val)
      sets.push(`${col} = $${vals.length}`)
    }
  }

  vals.push(payload.id)
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(
      `UPDATE store_customers SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length}::uuid
       RETURNING id, customer_number, email, first_name, last_name, phone, account_type, gender, birth_date, address_line1, address_line2, zip_code, city, country, company_name, vat_number, locale, COALESCE(bonus_points,0) AS bonus_points, created_at, vies_valid, vies_checked_at, vies_company_name`,
      vals
    )
    await client.end()
    const row = r.rows[0]
    if (!row) return res.status(404).json({ message: 'Customer not found' })
    res.json({
      customer: {
        ...row,
        customer_number: row.customer_number ? Number(row.customer_number) : null,
        bonus_points: Number(row.bonus_points || 0),
      },
    })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Update failed' })
  }
}

// DELETE /store/customers/me — self-service account deletion (GDPR); requires password if account has one
const storeCustomerMeDELETE = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const payload = verifyCustomerToken(token)
  if (!payload) return res.status(401).json({ message: 'Unauthorized' })
  const body = req.body || {}
  const password = (body.password ?? '').toString()
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const found = await client.query(
      'SELECT id, password_hash FROM store_customers WHERE id = $1::uuid',
      [payload.id],
    )
    const row = found.rows[0]
    if (!row) {
      await client.end()
      return res.status(404).json({ message: 'Customer not found' })
    }
    if (row.password_hash) {
      if (!password.trim()) {
        await client.end()
        return res.status(400).json({ message: 'Password required to delete your account' })
      }
      if (!verifyPassword(password, row.password_hash)) {
        await client.end()
        return res.status(401).json({ message: 'Invalid password' })
      }
    } else {
      if (body.confirm !== true) {
        await client.end()
        return res.status(400).json({ message: 'Set confirm: true to delete this account' })
      }
    }
    await client.query('DELETE FROM store_customers WHERE id = $1::uuid', [payload.id])
    await client.end()
    res.json({ success: true })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Could not delete account' })
  }
}

// POST /store/auth/token — login customer
const storeAuthTokenPOST = async (req, res) => {
  const body = req.body || {}
  const email = (body.email || '').trim().toLowerCase()
  const password = (body.password || '').toString()
  if (!email || !password) return res.status(400).json({ message: 'Email and password are required' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query('SELECT * FROM store_customers WHERE email = $1', [email])
    await client.end()
    const row = r.rows[0]
    if (!row || !row.password_hash) return res.status(401).json({ message: 'Invalid email or password' })
    if (!verifyPassword(password, row.password_hash)) return res.status(401).json({ message: 'Invalid email or password' })
    const token = signCustomerToken({
      id: row.id,
      email: row.email,
      role: 'customer',
      first_name: row.first_name || null,
      last_name: row.last_name || null,
      customer_number: row.customer_number != null ? Number(row.customer_number) : null,
    })
    const customer = { id: row.id, customer_number: row.customer_number ? Number(row.customer_number) : null, email: row.email, first_name: row.first_name, last_name: row.last_name, phone: row.phone, account_type: row.account_type, company_name: row.company_name, locale: row.locale || null }
    res.json({ customer, token, access_token: token })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Login failed' })
  }
}

// GET /store/customers/me — current customer by JWT
const storeCustomersMeGET = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const payload = verifyCustomerToken(token)
  if (!payload) return res.status(401).json({ message: 'Unauthorized' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(
      'SELECT id, customer_number, email, first_name, last_name, phone, account_type, gender, birth_date, address_line1, address_line2, zip_code, city, country, company_name, vat_number, locale, COALESCE(bonus_points,0) AS bonus_points, created_at FROM store_customers WHERE id = $1',
      [payload.id]
    )
    const row = r.rows[0]
    if (!row) {
      await client.end()
      return res.status(404).json({ message: 'Customer not found' })
    }
    let addresses = []
    let wishlist_product_ids = []
    try {
      const ar = await client.query(
        `SELECT id, label, address_line1, address_line2, zip_code, city, country, is_default_shipping, is_default_billing, created_at
         FROM store_customer_addresses WHERE customer_id = $1::uuid ORDER BY created_at ASC`,
        [payload.id],
      )
      addresses = ar.rows || []
    } catch (_) {}
    try {
      const wr = await client.query(
        'SELECT product_id FROM store_customer_wishlist WHERE customer_id = $1::uuid ORDER BY created_at DESC',
        [payload.id],
      )
      wishlist_product_ids = (wr.rows || []).map((x) => x.product_id)
    } catch (_) {}
    let bonus_ledger = []
    try {
      const lr = await client.query(
        `SELECT id, occurred_at, points_delta, description, source, order_id, created_at
         FROM store_customer_bonus_ledger
         WHERE customer_id = $1::uuid
         ORDER BY occurred_at DESC NULLS LAST, id DESC
         LIMIT 200`,
        [payload.id],
      )
      bonus_ledger = (lr.rows || []).map((e) => ({
        ...e,
        description: stripLegacyBonusLedgerVersandSuffix(e.description),
      }))
    } catch (_) {}
    await client.end()
    res.json({
      customer: {
        ...row,
        customer_number: row.customer_number ? Number(row.customer_number) : null,
        bonus_points: Number(row.bonus_points || 0),
        bonus_ledger,
        addresses,
        wishlist_product_ids,
      },
    })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// GET /store/reviews?product_id=... or ?product_ids=id1,id2 (same EAN / multi-seller PDP)
const storeReviewsGET = async (req, res) => {
  const productId = (req.query.product_id || '').trim()
  const idsRaw = (req.query.product_ids || '').toString().trim()
  const productIds = idsRaw ? idsRaw.split(',').map((s) => s.trim()).filter(Boolean) : []
  if (!productId && !productIds.length) return res.json({ reviews: [] })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    let r
    if (productIds.length > 0) {
      r = await client.query(
        `SELECT r.id, r.product_id, r.rating, r.comment, r.customer_name, r.created_at, r.seller_id,
                COALESCE(c.first_name, '') as first_name, COALESCE(c.last_name, '') as last_name
         FROM store_product_reviews r
         LEFT JOIN store_customers c ON c.id = r.customer_id
         WHERE r.product_id = ANY($1::text[])
         ORDER BY r.created_at DESC`,
        [productIds]
      )
    } else {
      r = await client.query(
        `SELECT r.id, r.product_id, r.rating, r.comment, r.customer_name, r.created_at, r.seller_id,
                COALESCE(c.first_name, '') as first_name, COALESCE(c.last_name, '') as last_name
         FROM store_product_reviews r
         LEFT JOIN store_customers c ON c.id = r.customer_id
         WHERE r.product_id = $1
         ORDER BY r.created_at DESC`,
        [productId]
      )
    }
    await client.end()
    res.json({ reviews: r.rows || [] })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// POST /store/reviews — submit a product review (auth required)
const storeReviewsPOST = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const payload = verifyCustomerToken(token)
  if (!payload?.id) return res.status(401).json({ message: 'Invalid token' })
  const { order_id, product_id, rating, comment } = req.body || {}
  if (!product_id) return res.status(400).json({ message: 'product_id required' })
  if (!order_id) return res.status(400).json({ message: 'order_id required' })
  const ratingNum = Number(rating)
  if (!ratingNum || ratingNum < 1 || ratingNum > 5) return res.status(400).json({ message: 'rating must be 1-5' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const orderCheck = await client.query(
      `SELECT id, seller_id FROM store_orders WHERE id = $1::uuid AND (customer_id = $2::uuid OR email = (SELECT email FROM store_customers WHERE id = $2::uuid))`,
      [order_id, payload.id]
    )
    if (!orderCheck.rows[0]) {
      await client.end()
      return res.status(403).json({ message: 'Order not found or access denied' })
    }
    const custR = await client.query('SELECT first_name, last_name FROM store_customers WHERE id = $1', [payload.id])
    const cust = custR.rows[0]
    const customer_name = cust ? [cust.first_name, cust.last_name].filter(Boolean).join(' ') || null : null
    const pid = String(product_id || '').trim()
    const orderSellerId =
      orderCheck.rows && orderCheck.rows[0] && orderCheck.rows[0].seller_id != null && String(orderCheck.rows[0].seller_id).trim() !== ''
        ? String(orderCheck.rows[0].seller_id).trim()
        : null
    const pr = await client.query('SELECT seller_id FROM admin_hub_products WHERE id::text = $1 LIMIT 1', [pid])
    const productSellerId =
      pr.rows && pr.rows[0] && pr.rows[0].seller_id != null && String(pr.rows[0].seller_id).trim() !== ''
        ? String(pr.rows[0].seller_id).trim()
        : null
    // Prefer seller from order (multi-offer / buybox flow); fallback to product row owner.
    const sellerIdForReview = orderSellerId || productSellerId || null
    const r = await client.query(
      `INSERT INTO store_product_reviews (order_id, product_id, customer_id, rating, comment, customer_name, seller_id)
       VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7)
       ON CONFLICT (order_id, product_id) DO UPDATE SET rating=$4, comment=$5, customer_name=$6, seller_id=$7, updated_at=now()
       RETURNING *`,
      [order_id, product_id, payload.id, ratingNum, comment?.trim() || null, customer_name, sellerIdForReview]
    )
    const statsR = await client.query(
      `SELECT COUNT(*)::int as cnt, ROUND(AVG(rating)::numeric, 2)::float as avg FROM store_product_reviews WHERE product_id = $1`,
      [product_id]
    )
    const stats = statsR.rows[0]
    await client.query(
      `UPDATE admin_hub_products SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id::text = $2`,
      [JSON.stringify({ review_count: stats.cnt, review_avg: parseFloat(stats.avg || 0) }), product_id]
    ).catch(() => {})
    if (sellerIdForReview) {
      const aggR = await client.query(
        `SELECT ROUND(AVG(rating)::numeric, 2)::float as avg, COUNT(*)::int as cnt FROM store_product_reviews WHERE seller_id = $1`,
        [sellerIdForReview]
      )
      const ar = aggR.rows && aggR.rows[0]
      const savg = ar && ar.avg != null ? parseFloat(ar.avg) : 0
      const scnt = ar && ar.cnt != null ? Number(ar.cnt) : 0
      await client.query(
        `INSERT INTO admin_hub_seller_settings (seller_id, review_avg, review_count, updated_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (seller_id) DO UPDATE SET
           review_avg = EXCLUDED.review_avg,
           review_count = EXCLUDED.review_count,
           updated_at = now()`,
        [sellerIdForReview, scnt > 0 ? savg : null, scnt]
      ).catch(() => {})
    }
    await client.end()
    res.json({ review: r.rows[0] })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// --- Shipping Groups CRUD ---
const adminHubShippingGroupsGET = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const isSuperuser = req.sellerUser?.is_superuser || false
    const callerSellerId = req.sellerUser?.seller_id
    let groups
    if (!isSuperuser && callerSellerId) {
      groups = await client.query(
        `
      SELECT g.*, c.name AS carrier_name
      FROM store_shipping_groups g
      LEFT JOIN store_shipping_carriers c ON c.id = g.carrier_id
      WHERE g.seller_id = $1
      ORDER BY g.created_at ASC
    `,
        [String(callerSellerId).trim()]
      )
    } else {
      groups = await client.query(`
      SELECT g.*, c.name AS carrier_name
      FROM store_shipping_groups g
      LEFT JOIN store_shipping_carriers c ON c.id = g.carrier_id
      ORDER BY g.created_at ASC
    `)
    }
    const prices = await client.query('SELECT * FROM store_shipping_prices ORDER BY country_code')
    await client.end()
    const pricesByGroup = {}
    for (const p of (prices.rows || [])) {
      if (!pricesByGroup[p.group_id]) pricesByGroup[p.group_id] = []
      const cc = normalizeHubCountryCode(p.country_code)
      if (!cc) continue
      pricesByGroup[p.group_id].push({ ...p, country_code: cc })
    }
    const result = (groups.rows || []).map(g => ({ ...g, prices: pricesByGroup[g.id] || [] }))
    res.json({ groups: result })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.json({ groups: [] })
  }
}

const adminHubShippingGroupPOST = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const { name, carrier_id, prices, return_method } = req.body || {}
  if (!name) return res.status(400).json({ message: 'name required' })
  const callerSellerId = req.sellerUser?.seller_id || null
  const rm = return_method === 'customer_ships' ? 'customer_ships' : 'seller_pays'
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(
      `INSERT INTO store_shipping_groups (name, carrier_id, seller_id, return_method) VALUES ($1, $2, $3, $4) RETURNING *`,
      [name.trim(), carrier_id || null, callerSellerId, rm]
    )
    const group = r.rows[0]
    if (Array.isArray(prices) && prices.length > 0) {
      for (const p of prices) {
        const cc = normalizeHubCountryCode(p.country_code)
        if (!cc) continue
        await client.query(
          `INSERT INTO store_shipping_prices (group_id, country_code, price_cents) VALUES ($1,$2,$3)
           ON CONFLICT (group_id, country_code) DO UPDATE SET price_cents=$3`,
          [group.id, cc, Math.round(Number(p.price_cents) || 0)]
        )
      }
    }
    await client.end()
    res.status(201).json({ group })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const adminHubShippingGroupPATCH = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const id = (req.params.id || '').trim()
  const { name, carrier_id, prices, return_method } = req.body || {}
  const isSuperuser = req.sellerUser?.is_superuser || false
  const callerSellerId = req.sellerUser?.seller_id
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    // Ownership check for non-superusers
    if (!isSuperuser) {
      const own = await client.query(`SELECT id FROM store_shipping_groups WHERE id=$1::uuid AND seller_id=$2`, [id, callerSellerId])
      if (!own.rows.length) { await client.end(); return res.status(403).json({ message: 'Nicht erlaubt' }) }
    }
    if (name !== undefined || carrier_id !== undefined || return_method !== undefined) {
      const sets = []; const vals = []
      if (name !== undefined) { vals.push(name.trim()); sets.push(`name=$${vals.length}`) }
      if (carrier_id !== undefined) { vals.push(carrier_id || null); sets.push(`carrier_id=$${vals.length}`) }
      if (return_method !== undefined) {
        const rm = return_method === 'customer_ships' ? 'customer_ships' : 'seller_pays'
        vals.push(rm); sets.push(`return_method=$${vals.length}`)
      }
      sets.push(`updated_at=now()`)
      vals.push(id)
      await client.query(`UPDATE store_shipping_groups SET ${sets.join(',')} WHERE id=$${vals.length}::uuid`, vals)
    }
    if (Array.isArray(prices)) {
      for (const p of prices) {
        const cc = normalizeHubCountryCode(p.country_code)
        if (!cc) continue
        await client.query(
          `INSERT INTO store_shipping_prices (group_id, country_code, price_cents) VALUES ($1,$2,$3)
           ON CONFLICT (group_id, country_code) DO UPDATE SET price_cents=$3`,
          [id, cc, Math.round(Number(p.price_cents) || 0)]
        )
      }
    }
    const r = await client.query(`SELECT g.*, c.name AS carrier_name FROM store_shipping_groups g LEFT JOIN store_shipping_carriers c ON c.id=g.carrier_id WHERE g.id=$1::uuid`, [id])
    const pr = await client.query('SELECT * FROM store_shipping_prices WHERE group_id=$1 ORDER BY country_code', [id])
    await client.end()
    const normPrices = (pr.rows || [])
      .map((row) => {
        const cc = normalizeHubCountryCode(row.country_code)
        return cc ? { ...row, country_code: cc } : null
      })
      .filter(Boolean)
    const group = r.rows[0] ? { ...r.rows[0], prices: normPrices } : null
    res.json({ group })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const adminHubShippingGroupDELETE = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const id = (req.params.id || '').trim()
  const isSuperuser = req.sellerUser?.is_superuser || false
  const callerSellerId = req.sellerUser?.seller_id
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    if (!isSuperuser) {
      const own = await client.query(`SELECT id FROM store_shipping_groups WHERE id=$1::uuid AND seller_id=$2`, [id, callerSellerId])
      if (!own.rows.length) { await client.end(); return res.status(403).json({ message: 'Nicht erlaubt' }) }
    }
    await client.query('DELETE FROM store_shipping_groups WHERE id=$1::uuid', [id])
    await client.end()
    res.json({ success: true })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// GET /store/shipping-groups — public, for shop to show prices
const storeShippingGroupsGET = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const groups = await client.query('SELECT id, name FROM store_shipping_groups ORDER BY created_at ASC')
    const prices = await client.query('SELECT group_id, country_code, price_cents FROM store_shipping_prices')
    // Superuser-disabled countries (admin_hub_country_overrides) are stripped out here, at the
    // single source every shop surface reads from (cart/checkout/product pages all derive their
    // country list from this endpoint's `prices` — see CartContext.jsx) — so disabling a country
    // hides it everywhere and makes it unbuyable, even if sellers still have prices configured for it.
    const disabled = await client.query(
      `SELECT country_code FROM admin_hub_country_overrides WHERE is_enabled = false`,
    ).catch(() => ({ rows: [] }))
    await client.end()
    const disabledSet = new Set((disabled.rows || []).map((r) => normalizeHubCountryCode(r.country_code)).filter(Boolean))
    const pricesByGroup = {}
    for (const p of (prices.rows || [])) {
      const cc = normalizeHubCountryCode(p.country_code)
      if (!cc || disabledSet.has(cc)) continue
      if (!pricesByGroup[p.group_id]) pricesByGroup[p.group_id] = {}
      pricesByGroup[p.group_id][cc] = Number(p.price_cents)
    }
    const result = (groups.rows || []).map(g => ({ id: g.id, name: g.name, prices: pricesByGroup[g.id] || {} }))
    res.json({ groups: result })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.json({ groups: [] })
  }
}

// Mirrors apps/sellercentral/src/lib/countries.js ISO_CODES — the same full list "Lieferländer
// auswählen" (shipping-group country picker) shows, so the superuser overview lists every
// country that could be picked there, not just ones a seller already happened to price.
const ALL_SHIPPABLE_COUNTRY_CODES = [
  'AF', 'AL', 'DZ', 'AD', 'AO', 'AG', 'AR', 'AM', 'AU', 'AT', 'AZ', 'BS', 'BH', 'BD', 'BB', 'BY', 'BE', 'BZ',
  'BJ', 'BT', 'BO', 'BA', 'BW', 'BR', 'BN', 'BG', 'BF', 'BI', 'CV', 'KH', 'CM', 'CA', 'CF', 'TD', 'CL', 'CN',
  'CO', 'KM', 'CG', 'CD', 'CR', 'HR', 'CU', 'CY', 'CZ', 'DK', 'DJ', 'DM', 'DO', 'EC', 'EG', 'SV', 'GQ', 'ER',
  'EE', 'SZ', 'ET', 'FJ', 'FI', 'FR', 'GA', 'GM', 'GE', 'DE', 'GH', 'GR', 'GD', 'GT', 'GN', 'GW', 'GY', 'HT',
  'HN', 'HU', 'IS', 'IN', 'ID', 'IR', 'IQ', 'IE', 'IL', 'IT', 'JM', 'JP', 'JO', 'KZ', 'KE', 'KI', 'KP', 'KR',
  'KW', 'KG', 'LA', 'LV', 'LB', 'LS', 'LR', 'LY', 'LI', 'LT', 'LU', 'MG', 'MW', 'MY', 'MV', 'ML', 'MT', 'MH',
  'MR', 'MU', 'MX', 'FM', 'MD', 'MC', 'MN', 'ME', 'MA', 'MZ', 'MM', 'NA', 'NR', 'NP', 'NL', 'NZ', 'NI', 'NE',
  'NG', 'MK', 'NO', 'OM', 'PK', 'PW', 'PA', 'PG', 'PY', 'PE', 'PH', 'PL', 'PT', 'QA', 'RO', 'RU', 'RW', 'KN',
  'LC', 'VC', 'WS', 'SM', 'ST', 'SA', 'SN', 'RS', 'SC', 'SL', 'SG', 'SK', 'SI', 'SB', 'SO', 'ZA', 'SS', 'ES',
  'LK', 'SD', 'SR', 'SE', 'CH', 'SY', 'TW', 'TJ', 'TZ', 'TH', 'TL', 'TG', 'TO', 'TT', 'TN', 'TR', 'TM', 'TV',
  'UG', 'UA', 'AE', 'GB', 'US', 'UY', 'UZ', 'VU', 'VE', 'VN', 'YE', 'ZM', 'ZW',
]

// GET /admin-hub/v1/country-overview — superuser only. Every shippable country (same full list
// the "Lieferländer auswählen" picker uses), with a count of products currently routed through a
// shipping group that includes it (0 if none), and whether a superuser has switched it off.
const adminHubCountryOverviewGET = async (req, res) => {
  if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser required' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_hub_country_overrides (
        country_code text PRIMARY KEY,
        is_enabled boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    const r = await client.query(`
      SELECT
        sp.country_code,
        COUNT(DISTINCT p.id)::int AS product_count
      FROM store_shipping_prices sp
      LEFT JOIN admin_hub_products p
        ON p.status = 'published'
        AND p.metadata->>'shipping_group_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND (p.metadata->>'shipping_group_id')::uuid = sp.group_id
      GROUP BY sp.country_code
    `)
    const overridesR = await client.query(`SELECT country_code, is_enabled FROM admin_hub_country_overrides`)
    await client.end()
    const countByCode = {}
    for (const row of r.rows || []) {
      const cc = normalizeHubCountryCode(row.country_code)
      if (cc) countByCode[cc] = (countByCode[cc] || 0) + Number(row.product_count || 0)
    }
    const overrideByCode = {}
    for (const row of overridesR.rows || []) {
      const cc = normalizeHubCountryCode(row.country_code)
      if (cc) overrideByCode[cc] = row.is_enabled !== false
    }
    const countries = ALL_SHIPPABLE_COUNTRY_CODES.map((code) => ({
      country_code: code,
      product_count: countByCode[code] || 0,
      is_enabled: overrideByCode[code] !== undefined ? overrideByCode[code] : true,
    }))
    res.json({ countries })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error', countries: [] })
  }
}

// PATCH /admin-hub/v1/country-overview/:country_code — superuser only, toggle a country on/off.
const adminHubCountryOverviewPATCH = async (req, res) => {
  if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser required' })
  const countryCode = normalizeHubCountryCode(req.params.country_code)
  if (!countryCode) return res.status(400).json({ message: 'Invalid country code' })
  const { is_enabled } = req.body || {}
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_hub_country_overrides (
        country_code text PRIMARY KEY,
        is_enabled boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    await client.query(
      `INSERT INTO admin_hub_country_overrides (country_code, is_enabled, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (country_code) DO UPDATE SET is_enabled = $2, updated_at = now()`,
      [countryCode, is_enabled !== false],
    )
    await client.end()
    res.json({ success: true, country_code: countryCode, is_enabled: is_enabled !== false })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// PATCH /admin-hub/v1/country-overview — bulk toggle (superuser). Body: { country_codes: [], is_enabled: bool }
const adminHubCountryOverviewBulkPATCH = async (req, res) => {
  if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser required' })
  const rawCodes = Array.isArray(req.body?.country_codes) ? req.body.country_codes : []
  const codes = [...new Set(rawCodes.map((c) => normalizeHubCountryCode(c)).filter(Boolean))]
  if (!codes.length) return res.status(400).json({ message: 'country_codes required' })
  const is_enabled = req.body?.is_enabled !== false
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_hub_country_overrides (
        country_code text PRIMARY KEY,
        is_enabled boolean NOT NULL DEFAULT true,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    for (const countryCode of codes) {
      await client.query(
        `INSERT INTO admin_hub_country_overrides (country_code, is_enabled, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (country_code) DO UPDATE SET is_enabled = $2, updated_at = now()`,
        [countryCode, is_enabled],
      )
    }
    await client.end()
    res.json({ success: true, country_codes: codes, is_enabled, updated: codes.length })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// GET /store/orders/:id/invoice — customer downloads their own invoice as PDF
const storeOrderInvoicePdfGET = async (req, res) => {
  const orderId = (req.params.id || '').trim()
  if (!orderId) return res.status(400).json({ message: 'id required' })
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const payload = verifyCustomerToken(token)
  if (!payload?.email) return res.status(401).json({ message: 'Invalid token' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const PDFDocument = require('pdfkit')
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    // Verify order belongs to this customer
    const oRes = await client.query(
      `SELECT * FROM store_orders WHERE id = $1::uuid
        AND (LOWER(TRIM(email)) = LOWER(TRIM($2)) OR (customer_id IS NOT NULL AND customer_id = $3::uuid))`,
      [orderId, payload.email, payload.id]
    )
    const row = oRes.rows && oRes.rows[0]
    if (!row) { await client.end(); return res.status(404).json({ message: 'Order not found' }) }
    // Seller may have opted invoices for this order into "customer_api" sourcing (Görev 6) —
    // serve the document their own ERP pushed to us instead of generating our own.
    const customerDocUrl = await require('./order-documents').resolveCustomerSuppliedDocumentUrl(client, orderId, row.seller_id, 'invoice')
    if (customerDocUrl) { await client.end(); return res.redirect(302, customerDocUrl) }
    const iRes = await client.query('SELECT * FROM store_order_items WHERE order_id = $1 ORDER BY created_at', [orderId])
    const itemRows = iRes.rows || []
    let sellerInfo = null
    try {
      sellerInfo = await querySellerInfoForOrderDocuments(client, row, itemRows)
    } catch (_) {}
    await client.end(); client = null
    const on = row.order_number != null ? String(row.order_number) : String(orderId).slice(0, 8)
    const shopName = process.env.SHOP_INVOICE_NAME || 'Andertal'
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Rechnung-${on}.pdf"`)
    const doc = new PDFDocument({ margin: 42, size: 'A4', compress: false, pdfVersion: '1.7' })
    doc.pipe(res)
    renderInvoicePdfDocument(doc, {
      row,
      itemRows,
      orderId,
      invoiceNumber: on,
      shopName,
      sellerInfo,
      // Invoices are always issued in German regardless of the shipping/billing country.
      locale: 'de',
    })
    doc.end()
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    if (!res.headersSent) res.status(500).json({ message: e?.message || 'PDF error' })
  }
}

const storeReturnPdfLatin = (s) => {
  if (s == null || s === undefined) return ''
  return String(s)
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
}
const storeReturnPdfFmtDate = (d) => {
  if (!d) return '—'
  try {
    return new Date(d).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  } catch (_) {
    return '—'
  }
}

/** Approved return only — customer Retourenschein PDF */
const storeOrderReturnRetourenscheinGET = async (req, res) => {
  const orderId = (req.params.id || '').trim()
  if (!orderId) return res.status(400).json({ message: 'id required' })
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const payload = verifyCustomerToken(token)
  if (!payload?.email) return res.status(401).json({ message: 'Invalid token' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const PDFDocument = require('pdfkit')
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const oRes = await client.query(
      `SELECT * FROM store_orders WHERE id = $1::uuid
        AND (LOWER(TRIM(email)) = LOWER(TRIM($2)) OR (customer_id IS NOT NULL AND customer_id = $3::uuid))`,
      [orderId, payload.email, payload.id],
    )
    if (!oRes.rows?.[0]) { await client.end(); return res.status(404).json({ message: 'Order not found' }) }
    const row = oRes.rows[0]
    const customerDocUrl = await require('./order-documents').resolveCustomerSuppliedDocumentUrl(client, orderId, row.seller_id, 'retourelabel')
    if (customerDocUrl) { await client.end(); return res.redirect(302, customerDocUrl) }
    const rRes = await client.query(
      `SELECT * FROM store_returns WHERE order_id = $1::uuid AND status = 'genehmigt' ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    )
    const ret = rRes.rows?.[0]
    if (!ret) { await client.end(); return res.status(404).json({ message: 'Keine genehmigte Retoure' }) }
    const iRes = await client.query('SELECT * FROM store_order_items WHERE order_id = $1 ORDER BY created_at', [orderId])
    const itemRows = iRes.rows || []
    let sellerInfo = null
    let logoUrl = ''
    try {
      sellerInfo = await querySellerInfoForOrderDocuments(client, row, itemRows)
      const lr = await client.query("SELECT shop_logo_url FROM admin_hub_seller_settings WHERE seller_id='default' LIMIT 1")
      logoUrl = lr.rows?.[0]?.shop_logo_url || ''
    } catch (_) {}
    await client.end()
    client = null
    let shopLogoBuffer = null
    if (logoUrl) {
      try {
        shopLogoBuffer = await new Promise((resolve) => {
          const mod = logoUrl.startsWith('https') ? require('https') : require('http')
          const reqLogo = mod.get(logoUrl, { timeout: 5000 }, (r) => {
            if (r.statusCode !== 200) { r.resume(); return resolve(null) }
            const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => resolve(Buffer.concat(chunks))); r.on('error', () => resolve(null))
          })
          reqLogo.on('error', () => resolve(null)); reqLogo.on('timeout', () => { reqLogo.destroy(); resolve(null) })
        })
      } catch (_) {}
    }
    const on = row.order_number != null ? String(row.order_number) : String(orderId).slice(0, 8)
    const shopName = process.env.SHOP_INVOICE_NAME || 'Andertal'
    const pdfLocale = 'de'
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="${getOrderPdfFilename('retoure', on, pdfLocale)}"`)
    const doc = new PDFDocument({ margin: 42, size: 'A4', compress: false, pdfVersion: '1.7' })
    doc.pipe(res)
    renderRetourenscheinPdfDocument(doc, {
      row,
      returnRow: ret,
      shopName,
      sellerInfo,
      shopLogoBuffer,
      locale: pdfLocale,
    })
    doc.end()
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    if (!res.headersSent) res.status(500).json({ message: e?.message || 'PDF error' })
  }
}

/** Compact shipping label style PDF — gleiche Retoure-Nr., zum Ausschneiden/Kleben */
const storeOrderReturnEtikettGET = async (req, res) => {
  const orderId = (req.params.id || '').trim()
  if (!orderId) return res.status(400).json({ message: 'id required' })
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const payload = verifyCustomerToken(token)
  if (!payload?.email) return res.status(401).json({ message: 'Invalid token' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const PDFDocument = require('pdfkit')
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const oRes = await client.query(
      `SELECT * FROM store_orders WHERE id = $1::uuid
        AND (LOWER(TRIM(email)) = LOWER(TRIM($2)) OR (customer_id IS NOT NULL AND customer_id = $3::uuid))`,
      [orderId, payload.email, payload.id],
    )
    if (!oRes.rows?.[0]) { await client.end(); return res.status(404).json({ message: 'Order not found' }) }
    const row = oRes.rows[0]
    const customerDocUrl = await require('./order-documents').resolveCustomerSuppliedDocumentUrl(client, orderId, row.seller_id, 'retourelabel')
    if (customerDocUrl) { await client.end(); return res.redirect(302, customerDocUrl) }
    const rRes = await client.query(
      `SELECT * FROM store_returns WHERE order_id = $1::uuid AND status = 'genehmigt' ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    )
    const ret = rRes.rows?.[0]
    if (!ret) { await client.end(); return res.status(404).json({ message: 'Keine genehmigte Retoure' }) }
    await client.end()
    client = null
    const rn = ret.return_number != null ? `R-${ret.return_number}` : 'R-—'
    const on = row.order_number != null ? String(row.order_number) : String(orderId).slice(0, 8)
    const cust = [row.first_name, row.last_name].filter(Boolean).join(' ')
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="Ruecksende-Etikett-${on}.pdf"`)
    const doc = new PDFDocument({ margin: 24, size: [288, 432] })
    doc.pipe(res)
    doc.fontSize(9).fillColor('#666').text('Rücksendung', { align: 'center' })
    doc.moveDown(0.2)
    doc.fontSize(22).font('Helvetica-Bold').fillColor('#111').text(rn, { align: 'center' })
    doc.moveDown(0.3)
    doc.font('Helvetica').fontSize(9).fillColor('#374151').text(`Bestellung #${on}`, { align: 'center' })
    if (cust) doc.text(storeReturnPdfLatin(cust), { align: 'center' })
    doc.text(storeReturnPdfLatin([row.address_line1, [row.postal_code, row.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || '—'), { align: 'center', width: 240 })
    doc.moveDown(0.5)
    doc.fontSize(7).fillColor('#9ca3af').text('Bitte gut sichtbar auf dem Paket anbringen.', { align: 'center', width: 240 })
    doc.end()
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    if (!res.headersSent) res.status(500).json({ message: e?.message || 'PDF error' })
  }
}

// GET /store/reviews/my — customer's own reviews
const storeReviewsMyGET = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const payload = verifyCustomerToken(token)
  if (!payload?.id) return res.status(401).json({ message: 'Invalid token' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(
      `SELECT id, order_id, product_id, rating, comment, created_at FROM store_product_reviews WHERE customer_id = $1::uuid ORDER BY created_at DESC`,
      [payload.id]
    )
    await client.end()
    res.json({ reviews: r.rows || [] })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// GET /admin-hub/reviews — all reviews for seller central
const adminHubReviewsGET = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const isSuperuser = req.sellerUser?.is_superuser || false
    const sellerSellerId = req.sellerUser?.seller_id
    let sellerFilter = ''
    const params = []
    if (!isSuperuser && sellerSellerId) {
      params.push(sellerSellerId)
      sellerFilter = `WHERE p.seller_id = $${params.length}`
    }
    const r = await client.query(
      `SELECT r.id, r.order_id, r.product_id, r.rating, r.comment, r.customer_name, r.created_at,
              r.seller_id,
              o.order_number,
              p.title as product_title, p.handle as product_handle, p.metadata->>'sku' as product_sku,
              s.store_name as seller_store_name
       FROM store_product_reviews r
       LEFT JOIN store_orders o ON o.id = r.order_id
       LEFT JOIN admin_hub_products p ON p.id::text = r.product_id
       LEFT JOIN admin_hub_seller_settings s ON s.seller_id = r.seller_id
       ${sellerFilter}
       ORDER BY r.created_at DESC
       LIMIT 1000`,
      params
    )
    await client.end()
    // Aggregate stats
    const rows = r.rows || []
    const totalCount = rows.length
    const avgRating = totalCount > 0 ? rows.reduce((s, x) => s + (x.rating || 0), 0) / totalCount : null
    const dist = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 }
    for (const row of rows) dist[row.rating] = (dist[row.rating] || 0) + 1
    res.json({ reviews: rows, stats: { total: totalCount, avg: avgRating ? Math.round(avgRating * 10) / 10 : null, distribution: dist } })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const storeWishlistGET = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const payload = verifyCustomerToken(token)
  if (!payload?.id) return res.status(401).json({ message: 'Unauthorized' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(
      'SELECT product_id, created_at FROM store_customer_wishlist WHERE customer_id = $1::uuid ORDER BY created_at DESC',
      [payload.id],
    )
    await client.end()
    res.json({ items: (r.rows || []).map((x) => ({ product_id: x.product_id, created_at: x.created_at })) })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const storeWishlistPOST = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const payload = verifyCustomerToken(token)
  if (!payload?.id) return res.status(401).json({ message: 'Unauthorized' })
  const productId = (req.body?.product_id || req.body?.productId || '').toString().trim()
  if (!productId) return res.status(400).json({ message: 'product_id required' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const ex = await client.query('SELECT id FROM admin_hub_products WHERE id = $1::uuid', [productId])
    if (!ex.rows?.[0]) {
      await client.end()
      return res.status(404).json({ message: 'Product not found' })
    }
    await client.query(
      `INSERT INTO store_customer_wishlist (customer_id, product_id) VALUES ($1::uuid, $2::uuid) ON CONFLICT (customer_id, product_id) DO NOTHING`,
      [payload.id, productId],
    )
    await client.end()
    res.status(201).json({ ok: true })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const storeWishlistDELETE = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const payload = verifyCustomerToken(token)
  if (!payload?.id) return res.status(401).json({ message: 'Unauthorized' })
  const productId = (req.params?.productId || '').toString().trim()
  if (!productId) return res.status(400).json({ message: 'product id required' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    await client.query('DELETE FROM store_customer_wishlist WHERE customer_id = $1::uuid AND product_id = $2::uuid', [payload.id, productId])
    await client.end()
    res.json({ ok: true })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const storeCustomerAddressesGET = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const payload = verifyCustomerToken(token)
  if (!payload?.id) return res.status(401).json({ message: 'Unauthorized' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(
      `SELECT id, label, address_line1, address_line2, zip_code, city, country, is_default_shipping, is_default_billing, created_at
       FROM store_customer_addresses WHERE customer_id = $1::uuid ORDER BY created_at ASC`,
      [payload.id],
    )
    await client.end()
    res.json({ addresses: r.rows || [] })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const storeCustomerAddressesPOST = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const payload = verifyCustomerToken(token)
  if (!payload?.id) return res.status(401).json({ message: 'Unauthorized' })
  const b = req.body || {}
  const address_line1 = (
    b.address_line1 ??
    b.line1 ??
    b.street ??
    b.address1 ??
    b.address?.line1 ??
    b.address?.address_line1 ??
    ''
  )
    .toString()
    .trim()
  if (!address_line1) return res.status(400).json({ message: 'address_line1 required' })
  const label = (b.label || '').toString().trim() || null
  const address_line2 = (b.address_line2 || '').toString().trim() || null
  const zip_code = (b.zip_code || b.postal_code || '').toString().trim() || null
  const city = (b.city || '').toString().trim() || null
  const country = (b.country || 'DE').toString().trim() || 'DE'
  let is_default_shipping = b.is_default_shipping === true
  let is_default_billing = b.is_default_billing === true
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const cntR = await client.query('SELECT COUNT(*)::int AS n FROM store_customer_addresses WHERE customer_id = $1::uuid', [payload.id])
    const n = Number(cntR.rows?.[0]?.n || 0)
    if (n === 0) {
      is_default_shipping = true
      is_default_billing = true
    }
    if (is_default_shipping) {
      await client.query('UPDATE store_customer_addresses SET is_default_shipping = false WHERE customer_id = $1::uuid', [payload.id])
    }
    if (is_default_billing) {
      await client.query('UPDATE store_customer_addresses SET is_default_billing = false WHERE customer_id = $1::uuid', [payload.id])
    }
    const ins = await client.query(
      `INSERT INTO store_customer_addresses (customer_id, label, address_line1, address_line2, zip_code, city, country, is_default_shipping, is_default_billing)
       VALUES ($1::uuid,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, label, address_line1, address_line2, zip_code, city, country, is_default_shipping, is_default_billing, created_at`,
      [payload.id, label, address_line1, address_line2, zip_code, city, country, is_default_shipping, is_default_billing],
    )
    await client.end()
    res.status(201).json({ address: ins.rows[0] })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const storeCustomerAddressesPATCH = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const payload = verifyCustomerToken(token)
  if (!payload?.id) return res.status(401).json({ message: 'Unauthorized' })
  const addressId = (req.params?.addressId || '').toString().trim()
  if (!addressId) return res.status(400).json({ message: 'address id required' })
  const b = req.body || {}
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const own = await client.query(
      'SELECT id FROM store_customer_addresses WHERE id = $1::uuid AND customer_id = $2::uuid',
      [addressId, payload.id],
    )
    if (!own.rows?.[0]) {
      await client.end()
      return res.status(404).json({ message: 'Address not found' })
    }
    const sets = []
    const vals = []
    const push = (col, v) => {
      vals.push(v)
      sets.push(`${col} = $${vals.length}`)
    }
    if ('label' in b) push('label', (b.label || '').toString().trim() || null)
    if (
      'address_line1' in b ||
      'line1' in b ||
      'street' in b ||
      'address1' in b
    ) {
      const v = (
        b.address_line1 ??
        b.line1 ??
        b.street ??
        b.address1 ??
        ''
      )
        .toString()
        .trim()
      if (!v) {
        await client.end()
        return res.status(400).json({ message: 'address_line1 required' })
      }
      push('address_line1', v)
    }
    if ('address_line2' in b) push('address_line2', (b.address_line2 || '').toString().trim() || null)
    if ('zip_code' in b || 'postal_code' in b) push('zip_code', (b.zip_code || b.postal_code || '').toString().trim() || null)
    if ('city' in b) push('city', (b.city || '').toString().trim() || null)
    if ('country' in b) push('country', (b.country || '').toString().trim() || null)
    if (b.is_default_shipping === true) {
      await client.query('UPDATE store_customer_addresses SET is_default_shipping = false WHERE customer_id = $1::uuid', [payload.id])
      sets.push('is_default_shipping = true')
    } else if (b.is_default_shipping === false) {
      sets.push('is_default_shipping = false')
    }
    if (b.is_default_billing === true) {
      await client.query('UPDATE store_customer_addresses SET is_default_billing = false WHERE customer_id = $1::uuid', [payload.id])
      sets.push('is_default_billing = true')
    } else if (b.is_default_billing === false) {
      sets.push('is_default_billing = false')
    }
    if (!sets.length) {
      await client.end()
      return res.status(400).json({ message: 'Nothing to update' })
    }
    sets.push('updated_at = NOW()')
    const idPos = vals.length + 1
    const custPos = vals.length + 2
    const r = await client.query(
      `UPDATE store_customer_addresses SET ${sets.join(', ')} WHERE id = $${idPos}::uuid AND customer_id = $${custPos}::uuid
       RETURNING id, label, address_line1, address_line2, zip_code, city, country, is_default_shipping, is_default_billing, created_at, updated_at`,
      [...vals, addressId, payload.id],
    )
    await client.end()
    res.json({ address: r.rows[0] })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const storeCustomerAddressesDELETE = async (req, res) => {
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const payload = verifyCustomerToken(token)
  if (!payload?.id) return res.status(401).json({ message: 'Unauthorized' })
  const addressId = (req.params?.addressId || '').toString().trim()
  if (!addressId) return res.status(400).json({ message: 'address id required' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const del = await client.query(
      'DELETE FROM store_customer_addresses WHERE id = $1::uuid AND customer_id = $2::uuid RETURNING is_default_shipping, is_default_billing',
      [addressId, payload.id],
    )
    const deleted = del.rows?.[0]
    if (!deleted) {
      await client.end()
      return res.status(404).json({ message: 'Address not found' })
    }
    if (deleted.is_default_shipping) {
      await client.query('UPDATE store_customer_addresses SET is_default_shipping = false WHERE customer_id = $1::uuid', [payload.id])
      const n = await client.query(
        'SELECT id FROM store_customer_addresses WHERE customer_id = $1::uuid ORDER BY created_at ASC LIMIT 1',
        [payload.id],
      )
      if (n.rows?.[0]?.id) {
        await client.query('UPDATE store_customer_addresses SET is_default_shipping = true WHERE id = $1::uuid', [n.rows[0].id])
      }
    }
    if (deleted.is_default_billing) {
      await client.query('UPDATE store_customer_addresses SET is_default_billing = false WHERE customer_id = $1::uuid', [payload.id])
      const n = await client.query(
        'SELECT id FROM store_customer_addresses WHERE customer_id = $1::uuid ORDER BY created_at ASC LIMIT 1',
        [payload.id],
      )
      if (n.rows?.[0]?.id) {
        await client.query('UPDATE store_customer_addresses SET is_default_billing = true WHERE id = $1::uuid', [n.rows[0].id])
      }
    }
    await client.end()
    res.json({ ok: true })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// GET /store/orders/me — orders for authenticated customer
const storeOrdersMeGET = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const payload = verifyCustomerToken(token)
  if (!payload?.email) return res.status(401).json({ message: 'Invalid token' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const custId = customerIdForPg(payload)
    const custEmail = payload.email ? String(payload.email).trim() : ''
    const ordersR = await client.query(
      `SELECT id, order_number, order_status, payment_status, delivery_status,
              stripe_transfer_status,
              total_cents, subtotal_cents, shipping_cents, discount_cents, currency,
              first_name, last_name, phone, email,
              address_line1, address_line2, city, postal_code, country,
              billing_address_line1, billing_city, billing_postal_code, billing_country, billing_same_as_shipping,
              payment_method, tracking_number, carrier_name, shipped_at, delivery_date, notes,
              newsletter_opted_in, created_at, updated_at
       FROM store_orders
       WHERE ($2::uuid IS NOT NULL AND customer_id = $2::uuid)
          OR (email IS NOT NULL AND TRIM(email) <> '' AND LOWER(TRIM(email)) = LOWER(TRIM($1)))
       ORDER BY created_at DESC`,
      [custEmail, custId || null]
    )
    const orderIds = (ordersR.rows || []).map(r => r.id)
    let itemsMap = {}
    if (orderIds.length > 0) {
      try {
        const itemsR = await client.query(
          `SELECT oi.id, oi.order_id, oi.title, oi.quantity, oi.unit_price_cents, oi.product_id, oi.product_handle, oi.thumbnail,
           COALESCE(p1.id, p2.id) AS current_product_id,
           COALESCE(p1.handle, p2.handle) AS current_product_handle,
           COALESCE(p1.metadata, p2.metadata) AS product_metadata
           FROM store_order_items oi
           LEFT JOIN admin_hub_products p1 ON p1.id::text = oi.product_id
           LEFT JOIN admin_hub_products p2 ON p1.id IS NULL AND p2.handle = oi.product_handle
           WHERE oi.order_id = ANY($1::uuid[])`,
          [orderIds]
        )
        for (const r of (itemsR.rows || [])) {
          let pm = r.product_metadata
          if (pm != null && typeof pm === 'string') { try { pm = JSON.parse(pm) } catch (_) { pm = null } }
          const it = {
            id: r.id, order_id: r.order_id, title: r.title, quantity: r.quantity, unit_price_cents: r.unit_price_cents,
            product_id: r.current_product_id || r.product_id,
            product_handle: r.current_product_handle || r.product_handle,
            thumbnail: r.thumbnail,
            product_metadata: pm && typeof pm === 'object' ? pm : null,
          }
          if (!itemsMap[it.order_id]) itemsMap[it.order_id] = []
          itemsMap[it.order_id].push(it)
        }
      } catch {
        // fallback without product_id if column not yet migrated
        const itemsR = await client.query(
          `SELECT id, order_id, title, quantity, unit_price_cents, product_handle, thumbnail
           FROM store_order_items WHERE order_id = ANY($1::uuid[])`,
          [orderIds]
        )
        for (const it of (itemsR.rows || [])) {
          if (!itemsMap[it.order_id]) itemsMap[it.order_id] = []
          itemsMap[it.order_id].push(it)
        }
      }
    }
    // Also fetch return requests
    let returnsMap = {}
    if (orderIds.length > 0) {
      try {
        const returnsR = await client.query(
          `SELECT id, order_id, status, reason, notes, return_number, refund_status, refund_amount_cents,
                  label_sent_at, label_url, label_tracking_number, label_carrier_name, created_at,
                  return_method, seller_id, items,
                  customer_tracking_number, customer_carrier_name, customer_tracking_at, received_at
             FROM store_returns WHERE order_id = ANY($1::uuid[]) ORDER BY created_at DESC`,
          [orderIds]
        )
        for (const r of (returnsR.rows || [])) {
          if (!returnsMap[r.order_id]) returnsMap[r.order_id] = []
          returnsMap[r.order_id].push(r)
        }
      } catch (_) {}
    }
    const cancelTz = String(process.env.STORE_POLICY_TIMEZONE || 'Europe/Berlin').trim() || 'Europe/Berlin'
    let cancelWindowMap = {}
    if (orderIds.length > 0) {
      try {
        const cr = await client.query(
          `SELECT id,
            (
              (NOW() <= created_at + interval '15 minutes')
              OR (
                (EXTRACT(HOUR FROM (created_at AT TIME ZONE $1::text)) * 60
                 + EXTRACT(MINUTE FROM (created_at AT TIME ZONE $1::text))) < (7 * 60)
                AND NOW() < (
                  (date_trunc('day', (created_at AT TIME ZONE $1::text)::timestamp) + interval '7 hours')
                  AT TIME ZONE $1::text
                )
              )
            ) AS policy_cancel_ok
           FROM store_orders WHERE id = ANY($2::uuid[])`,
          [cancelTz, orderIds],
        )
        for (const x of cr.rows || []) cancelWindowMap[x.id] = x.policy_cancel_ok === true
      } catch (ce) {
        console.warn('storeOrdersMeGET cancellation window:', ce?.message || ce)
      }
    }

    await client.end()
    const blockedOs = new Set(['storniert', 'refunded', 'retoure', 'retoure_anfrage'])
    const blockedDs = new Set(['versendet', 'zugestellt', 'shipped', 'delivered'])
    const orders = (ordersR.rows || []).map(row => {
      let cancellation_allowed = !!cancelWindowMap[row.id]
      const os = String(row.order_status || '').toLowerCase()
      const ds = String(row.delivery_status || 'offen').toLowerCase()
      if (blockedOs.has(os)) cancellation_allowed = false
      if (blockedDs.has(ds)) cancellation_allowed = false
      const trk = row.tracking_number != null && String(row.tracking_number).trim() !== ''
      if (trk) cancellation_allowed = false
      const tst = String(row.stripe_transfer_status || '').toLowerCase()
      if (tst === 'completed') cancellation_allowed = false
      return {
        ...row,
        total_cents: resolveOrderPaidTotalCents(row),
        order_number: row.order_number ? Number(row.order_number) : null,
        items: itemsMap[row.id] || [],
        returns: returnsMap[row.id] || [],
        cancellation_allowed,
      }
    })
    res.json({ orders })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

/** Resolve return_method for a seller from their shipping group (or default seller_pays). */
async function resolveReturnMethodForSeller(client, sellerId, shippingGroupId) {
  if (shippingGroupId) {
    try {
      const r = await client.query(
        `SELECT return_method FROM store_shipping_groups WHERE id = $1::uuid LIMIT 1`,
        [shippingGroupId],
      )
      const m = String(r.rows[0]?.return_method || '').trim()
      if (m === 'customer_ships' || m === 'seller_pays') return m
    } catch (_) {}
  }
  if (sellerId) {
    try {
      const r = await client.query(
        `SELECT return_method FROM store_shipping_groups
          WHERE seller_id = $1 AND return_method IS NOT NULL
          ORDER BY updated_at DESC NULLS LAST, created_at DESC LIMIT 1`,
        [sellerId],
      )
      const m = String(r.rows[0]?.return_method || '').trim()
      if (m === 'customer_ships' || m === 'seller_pays') return m
    } catch (_) {}
  }
  return 'seller_pays'
}

async function resolveShippingGroupIdForItem(client, productId, sellerId) {
  const pid = String(productId || '').trim()
  const sid = String(sellerId || '').trim()
  if (!pid) return null
  if (sid && sid !== 'default') {
    try {
      const lr = await client.query(
        `SELECT shipping_group_id FROM admin_hub_seller_listings
          WHERE product_id::text = $1 AND seller_id = $2
            AND shipping_group_id IS NOT NULL AND TRIM(shipping_group_id) <> ''
          LIMIT 1`,
        [pid, sid],
      )
      if (lr.rows[0]?.shipping_group_id) return String(lr.rows[0].shipping_group_id)
    } catch (_) {}
  }
  try {
    const pr = await client.query(
      `SELECT metadata->>'shipping_group_id' AS sg FROM admin_hub_products WHERE id::text = $1 LIMIT 1`,
      [pid],
    )
    const sg = String(pr.rows[0]?.sg || '').trim()
    return sg || null
  } catch (_) {
    return null
  }
}

// POST /store/orders/:id/return-request — customer requests a return (product-based, TASK-13)
const storeReturnRequestPOST = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const orderId = (req.params.id || '').trim()
  if (!orderId) return res.status(400).json({ message: 'order id required' })
  const payload = verifyCustomerToken(token)
  if (!payload?.email) return res.status(401).json({ message: 'Invalid token' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const orderR = await client.query(
      `SELECT id, order_number, delivery_status, delivery_date, total_cents, seller_id FROM store_orders WHERE id = $1::uuid
       AND (
         ($3::uuid IS NOT NULL AND customer_id = $3::uuid)
         OR (email IS NOT NULL AND LOWER(TRIM(email)) = LOWER(TRIM($2)))
       )`,
      [orderId, payload.email, customerIdForPg(payload)],
    )
    if (!orderR.rows[0]) { await client.end(); return res.status(404).json({ message: 'Order not found' }) }
    const order = orderR.rows[0]
    const deliveryDate = order.delivery_date ? new Date(order.delivery_date) : null
    if (deliveryDate) {
      const daysSince = (Date.now() - deliveryDate.getTime()) / (1000 * 60 * 60 * 24)
      if (daysSince > 14) {
        await client.end()
        return res.status(400).json({ message: 'Rückgabefrist abgelaufen. Rückgabe ist nur innerhalb von 14 Tagen nach Lieferung möglich.' })
      }
    }
    const existR = await client.query(
      "SELECT id FROM store_returns WHERE order_id = $1::uuid AND status NOT IN ('abgelehnt','abgeschlossen')",
      [orderId]
    )
    if (existR.rows.length > 0) { await client.end(); return res.status(409).json({ message: 'Es gibt bereits eine offene Retouranfrage für diese Bestellung.' }) }

    const { reason = '', notes = '', items: rawItems } = req.body || {}
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      await client.end()
      return res.status(400).json({ message: 'Bitte wählen Sie mindestens einen Artikel für die Retoure aus.' })
    }

    const oiRes = await client.query(
      `SELECT id, product_id, title, quantity, unit_price_cents, seller_id
         FROM store_order_items WHERE order_id = $1::uuid`,
      [orderId],
    )
    const byId = new Map((oiRes.rows || []).map((r) => [String(r.id), r]))
    const normalized = []
    for (const raw of rawItems) {
      const orderItemId = String(raw.order_item_id || raw.id || '').trim()
      const oi = byId.get(orderItemId)
      if (!oi) {
        await client.end()
        return res.status(400).json({ message: 'Ungültiger Artikel in der Retoure.' })
      }
      const qty = Math.max(1, Math.min(Number(oi.quantity) || 1, Math.round(Number(raw.quantity) || Number(oi.quantity) || 1)))
      if (qty > Number(oi.quantity || 1)) {
        await client.end()
        return res.status(400).json({ message: 'Retourmenge überschreitet die bestellte Menge.' })
      }
      const sid = String(oi.seller_id || order.seller_id || '').trim() || null
      normalized.push({
        order_item_id: oi.id,
        product_id: oi.product_id || null,
        title: oi.title || '',
        quantity: qty,
        unit_price_cents: Number(oi.unit_price_cents || 0),
        seller_id: sid,
      })
    }

    // Multi-seller: one return per seller (MVP)
    const bySeller = new Map()
    for (const it of normalized) {
      const key = it.seller_id || 'default'
      if (!bySeller.has(key)) bySeller.set(key, [])
      bySeller.get(key).push(it)
    }

    const created = []
    for (const [sellerKey, sellerItems] of bySeller.entries()) {
      const sellerId = sellerKey === 'default' ? null : sellerKey
      const sgId = await resolveShippingGroupIdForItem(client, sellerItems[0].product_id, sellerId)
      const returnMethod = await resolveReturnMethodForSeller(client, sellerId, sgId)
      const r = await client.query(
        `INSERT INTO store_returns (order_id, status, reason, notes, items, seller_id, return_method)
         VALUES ($1::uuid, 'offen', $2, $3, $4::jsonb, $5, $6)
         RETURNING id, return_number, status, created_at, return_method, seller_id`,
        [orderId, reason, notes || null, JSON.stringify(sellerItems), sellerId, returnMethod],
      )
      const ret = r.rows[0]
      created.push(ret)

      if (returnMethod === 'seller_pays') {
        const labelResult = await createReturnLabelForOrder(client, { returnId: ret.id, orderId }).catch((e) => {
          console.warn('[return-label] createReturnLabelForOrder threw:', e?.message || e)
          return { ok: false, reason: e?.message || 'unexpected_error' }
        })
        if (!labelResult.ok) {
          console.warn(`[return-label] order ${orderId}: label not created (${labelResult.reason})`)
        }
      }
    }

    await client.query(
      `UPDATE store_orders SET order_status = 'retoure_anfrage', updated_at = now() WHERE id = $1::uuid`,
      [orderId],
    )
    await client.end()
    const first = created[0]
    res.json({
      return_request: {
        ...first,
        return_number: first.return_number ? Number(first.return_number) : null,
      },
      returns: created.map((x) => ({
        ...x,
        return_number: x.return_number ? Number(x.return_number) : null,
      })),
    })
    // Dispatch per created return's method — if mixed, fire both triggers once each
    const triggers = new Set(
      created.map((x) => (x.return_method === 'customer_ships' ? 'return_requested_customer_ships' : 'return_requested')),
    )
    for (const tk of triggers) void dispatchOrderFlowEvent(tk, orderId)
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// POST /store/orders/:id/return-tracking — customer submits own return tracking (Model B)
const storeReturnTrackingPOST = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const orderId = (req.params.id || '').trim()
  if (!orderId) return res.status(400).json({ message: 'order id required' })
  const payload = verifyCustomerToken(token)
  if (!payload?.email) return res.status(401).json({ message: 'Invalid token' })
  const tracking = String(req.body?.tracking_number || '').trim()
  const carrier = String(req.body?.carrier_name || '').trim() || null
  if (!tracking) return res.status(400).json({ message: 'tracking_number required' })
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const orderR = await client.query(
      `SELECT id FROM store_orders WHERE id = $1::uuid
       AND (
         ($3::uuid IS NOT NULL AND customer_id = $3::uuid)
         OR (email IS NOT NULL AND LOWER(TRIM(email)) = LOWER(TRIM($2)))
       )`,
      [orderId, payload.email, customerIdForPg(payload)],
    )
    if (!orderR.rows[0]) { await client.end(); return res.status(404).json({ message: 'Order not found' }) }
    const retR = await client.query(
      `SELECT id, return_method FROM store_returns
        WHERE order_id = $1::uuid AND status NOT IN ('abgelehnt','abgeschlossen')
        ORDER BY created_at DESC LIMIT 1`,
      [orderId],
    )
    const ret = retR.rows[0]
    if (!ret) { await client.end(); return res.status(404).json({ message: 'No open return' }) }
    if (ret.return_method !== 'customer_ships') {
      await client.end()
      return res.status(400).json({ message: 'Tracking is only required for customer-shipped returns.' })
    }
    const upd = await client.query(
      `UPDATE store_returns SET
         customer_tracking_number = $1,
         customer_carrier_name = $2,
         customer_tracking_at = now(),
         updated_at = now()
       WHERE id = $3::uuid
       RETURNING id, return_number, customer_tracking_number, customer_carrier_name, customer_tracking_at, return_method, status`,
      [tracking, carrier, ret.id],
    )
    await client.end()
    const row = upd.rows[0]
    res.json({
      return: {
        ...row,
        return_number: row.return_number ? Number(row.return_number) : null,
      },
    })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

// POST /store/orders/:id/cancel — customer self-cancel within policy window (15 min or night orders until 07:00 local)
const storeOrdersCancelPOST = async (req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!token) return res.status(401).json({ message: 'Unauthorized' })
  const orderId = (req.params.id || '').trim()
  if (!orderId) return res.status(400).json({ message: 'order id required' })
  const payload = verifyCustomerToken(token)
  if (!payload?.email) return res.status(401).json({ message: 'Invalid token' })
  const cancelTz = String(process.env.STORE_POLICY_TIMEZONE || 'Europe/Berlin').trim() || 'Europe/Berlin'

  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()

    const orderR = await client.query(
      `SELECT id, order_number, customer_id, payment_intent_id, payment_status, order_status, delivery_status,
              tracking_number, stripe_transfer_status, stripe_payout_status, total_cents,
              COALESCE(bonus_points_redeemed, 0)::int AS bonus_points_redeemed, created_at,
              (
                (NOW() <= created_at + interval '15 minutes')
                OR (
                  (EXTRACT(HOUR FROM (created_at AT TIME ZONE $2::text)) * 60
                   + EXTRACT(MINUTE FROM (created_at AT TIME ZONE $2::text))) < (7 * 60)
                  AND NOW() < (
                    (date_trunc('day', (created_at AT TIME ZONE $2::text)::timestamp) + interval '7 hours')
                    AT TIME ZONE $2::text
                  )
                )
              ) AS policy_cancel_ok
       FROM store_orders WHERE id = $1::uuid
         AND (
           ($4::uuid IS NOT NULL AND customer_id = $4::uuid)
           OR (email IS NOT NULL AND LOWER(TRIM(email)) = LOWER(TRIM($3)))
         )`,
      [orderId, cancelTz, payload.email, customerIdForPg(payload)],
    )
    const row = orderR.rows[0]
    if (!row) {
      await client.end()
      return res.status(404).json({ message: 'Order not found' })
    }

    const os = String(row.order_status || '').toLowerCase()
    if (os === 'storniert') {
      await client.end()
      return res.json({
        success: true,
        already_cancelled: true,
        order: { id: row.id, order_status: 'storniert', payment_status: row.payment_status },
      })
    }
    if (['refunded', 'retoure', 'retoure_anfrage'].includes(os)) {
      await client.end()
      return res.status(400).json({ message: 'Diese Bestellung kann nicht mehr storniert werden.' })
    }
    const ds = String(row.delivery_status || 'offen').toLowerCase()
    if (['versendet', 'zugestellt', 'shipped', 'delivered'].includes(ds)) {
      await client.end()
      return res.status(400).json({ message: 'Die Bestellung wurde bereits versendet.' })
    }
    if (row.tracking_number != null && String(row.tracking_number).trim() !== '') {
      await client.end()
      return res.status(400).json({ message: 'Sendungsverfolgung aktiv — Stornierung nicht möglich.' })
    }
    if (
      String(row.stripe_transfer_status || '').toLowerCase() === 'completed' ||
      String(row.stripe_payout_status || '').toLowerCase() === 'paid'
    ) {
      await client.end()
      return res.status(400).json({ message: 'Auszahlung bereits erfolgt — bitte den Support kontaktieren.' })
    }
    if (!row.policy_cancel_ok) {
      await client.end()
      return res.status(400).json({ message: 'Stornierungsfrist abgelaufen.' })
    }

    const totalCents = Number(row.total_cents || 0)
    const piId = row.payment_intent_id ? String(row.payment_intent_id).trim() : ''

    const platformRow = await loadPlatformCheckoutRow(client)
    const secretKey = resolveStripeSecretKeyFromPlatform(platformRow)

    if (totalCents > 0) {
      if (!piId) {
        await client.end()
        return res.status(400).json({ message: 'Keine Zahlungsreferenz — bitte den Support kontaktieren.' })
      }
      if (!secretKey) {
        await client.end()
        return res.status(503).json({ message: 'Zahlungsrückbuchung ist nicht konfiguriert.' })
      }
      try {
        const stripe = new (require('stripe'))(secretKey)
        const pi = await stripe.paymentIntents.retrieve(piId)
        if (pi.status === 'requires_capture') {
          await stripe.paymentIntents.cancel(piId)
        } else if (pi.status === 'succeeded') {
          const ch = pi.latest_charge
          const chargeId = typeof ch === 'string' ? ch : ch?.id
          if (!chargeId) {
            await client.end()
            return res.status(400).json({ message: 'Keine Charge für Erstattung gefunden.' })
          }
          // Destination charge: reverse the transfer and refund the application fee too
          const isDestinationCharge = !!(pi.transfer_data?.destination)
          const refundParams = { charge: chargeId }
          if (isDestinationCharge) {
            refundParams.reverse_transfer = true
            refundParams.refund_application_fee = true
          }
          await stripe.refunds.create(refundParams)
        } else if (pi.status === 'canceled' || pi.status === 'requires_payment_method') {
          /* bereits storniert / unbezahlt */
        } else {
          await client.end()
          return res.status(400).json({ message: `Zahlungsstatus „${pi.status}” — automatische Stornierung nicht möglich.` })
        }
      } catch (se) {
        await client.end()
        return res.status(502).json({ message: se?.message || 'Stripe-Rückbuchung fehlgeschlagen' })
      }
    }

    const custId = row.customer_id
    if (custId) {
      try {
        const doneEarn = await client.query(
          `SELECT id FROM store_customer_bonus_ledger WHERE order_id = $1::uuid AND source = 'order_cancel_earn' LIMIT 1`,
          [orderId],
        )
        const doneRedeem = await client.query(
          `SELECT id FROM store_customer_bonus_ledger WHERE order_id = $1::uuid AND source = 'order_cancel_redeem' LIMIT 1`,
          [orderId],
        )
        const earned = await client.query(
          `SELECT COALESCE(SUM(points_delta), 0)::int AS total FROM store_customer_bonus_ledger WHERE order_id = $1::uuid AND source = 'order_earn'`,
          [orderId],
        )
        const earnedPts = Number(earned.rows[0]?.total || 0)
        const redeemed = await client.query(
          `SELECT COALESCE(SUM(points_delta), 0)::int AS total FROM store_customer_bonus_ledger WHERE order_id = $1::uuid AND source = 'order_redeem'`,
          [orderId],
        )
        const redeemedPts = Number(redeemed.rows[0]?.total || 0)
        if (earnedPts > 0 && !doneEarn.rows.length) {
          await appendBonusLedger(client, {
            customerId: custId,
            pointsDelta: -earnedPts,
            description: `Storno Bestellung #${row.order_number} — Punkte zurückgebucht (−${earnedPts})`,
            source: 'order_cancel_earn',
            orderId,
          })
        }
        const redeemedFromOrder = Number(row.bonus_points_redeemed || 0)
        const pointsToGiveBack = redeemedPts < 0 ? -redeemedPts : redeemedFromOrder
        if (pointsToGiveBack > 0 && !doneRedeem.rows.length) {
          await appendBonusLedger(client, {
            customerId: custId,
            pointsDelta: pointsToGiveBack,
            description: `Storno Bestellung #${row.order_number} — eingelöste Punkte zurück (+${pointsToGiveBack})`,
            source: 'order_cancel_redeem',
            orderId,
          })
        }
      } catch (be) {
        console.warn('bonus reversal cancel:', be?.message || be)
      }
    }

    await client.query(
      `UPDATE store_orders SET order_status = 'storniert',
         payment_status = CASE WHEN $2::bigint > 0 THEN 'refunded' ELSE payment_status END,
         updated_at = now()
       WHERE id = $1::uuid`,
      [orderId, totalCents],
    )

    await client.end()
    res.json({
      success: true,
      order: {
        id: row.id,
        order_status: 'storniert',
        payment_status: totalCents > 0 ? 'refunded' : row.payment_status,
      },
    })
  } catch (e) {
    if (client) try { await client.end() } catch (_) {}
    res.status(500).json({ message: e?.message || 'Error' })
  }
}

const storeOrdersPOST = async (req, res) => {
  const body = req.body || {}
  const cartId = (body.cart_id || body.cartId || '').toString().trim()
  if (!cartId) return res.status(400).json({ message: 'cart_id required' })
  // docs/affiliate.md PR 4 — optional, only present when the shop's checkout page found a
  // consented-to __atrl cookie. Never validated/required here; purely a hint for the
  // fire-and-forget commission-recalc call after the order is created.
  const affiliateCookieId = (body.affiliate_cookie_id || '').toString().trim() || null

  const authHdr = (req.headers.authorization || '').toString()
  const bearerTok = authHdr.startsWith('Bearer ') ? authHdr.slice(7).trim() : ''
  let jwtCustomerId = null
  let jwtEmail = null
  if (bearerTok) {
    const jp = verifyCustomerToken(bearerTok)
    const cid = customerIdForPg(jp)
    if (cid) {
      jwtCustomerId = cid
      jwtEmail = jp?.email ? String(jp.email).trim() : null
    }
  }

  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return res.status(503).json({ message: 'Database not configured' })

  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()

    const paymentIntentIdEarly = (body.payment_intent_id || body.paymentIntentId || '').toString().trim()

    const returnExistingOrder = async (orderId) => {
      const order = await getOrderWithItems(client, orderId)
      await client.end()
      return res.status(200).json({ order, reused: true })
    }

    // Idempotency: payment already linked to an order (retry after 502 / deploy).
    if (paymentIntentIdEarly.startsWith('pi_')) {
      try {
        const exPi = (await client.query(
          'SELECT id FROM store_orders WHERE payment_intent_id = $1 LIMIT 1',
          [paymentIntentIdEarly],
        )).rows?.[0]
        if (exPi?.id) return await returnExistingOrder(exPi.id)
      } catch (_) {}
    }

    let cart = await getCartWithItems(client, cartId)
    if (!cart) { await client.end(); return res.status(404).json({ message: 'Cart not found' }) }
    cart = (await syncCartCouponDiscountFromLines(client, cartId, cart)) || cart
    const items = Array.isArray(cart.items) ? cart.items : []
    if (!items.length) { await client.end(); return res.status(400).json({ message: 'Cart is empty' }) }

    let email = (body.email || '').toString().trim() || null
    let first_name = (body.first_name || '').toString().trim() || null
    let last_name = (body.last_name || '').toString().trim() || null
    let phone = (body.phone || '').toString().trim() || null
    const address_line1 = (body.address_line1 || '').toString().trim() || null
    const address_line2 = (body.address_line2 || '').toString().trim() || null
    const city = (body.city || '').toString().trim() || null
    const postal_code = (body.postal_code || '').toString().trim() || null
    const country = (body.country || '').toString().trim() || null
    const billingSame = body.billing_same_as_shipping !== false
    const billing_address_line1 = billingSame ? (body.address_line1 || '').toString().trim() || null : (body.billing_address_line1 || '').toString().trim() || null
    const billing_address_line2 = billingSame ? (body.address_line2 || '').toString().trim() || null : (body.billing_address_line2 || '').toString().trim() || null
    const billing_city = billingSame ? (body.city || '').toString().trim() || null : (body.billing_city || '').toString().trim() || null
    const billing_postal_code = billingSame ? (body.postal_code || '').toString().trim() || null : (body.billing_postal_code || '').toString().trim() || null
    const billing_country = billingSame ? (body.country || '').toString().trim() || null : (body.billing_country || '').toString().trim() || null
    const newsletter_opted_in = body.newsletter_opted_in === true
    const localeRaw = (body.locale || '').toString().trim().toLowerCase()
    const locale = ['en', 'de', 'tr', 'fr', 'it', 'es'].includes(localeRaw) ? localeRaw : null

    // The order owner is always the platform — never "whichever seller happened to own the
    // cart's first item" (see storePaymentIntentPOST's cartSellerId for the matching PaymentIntent
    // side of this). A cart routinely mixes items from multiple sellers, and a single-seller
    // cart behaves the same way for consistency. Per-item seller attribution for commission/
    // payout/visibility lives on store_order_items.seller_id (set below per line item), never here.
    const sellerId = 'default'
    const sellerLabelShort = 'Marketplace'

    // Customer: angemeldet → immer Konto-E-Mail + customer_id (Bestellungen unter „Meine Bestellungen“)
    let customerId = null
    let isGuest = true
    // B2B reverse-charge (BonusPunkte.md §6): a 'gewerbe' customer's VAT-ID, already collected on their
    // account profile (register/account pages, store_customers.vat_number) — never a new checkout field.
    // Snapshotted onto the order at creation time so later profile edits don't rewrite past invoices.
    let customerVatId = null
    let customerVatIdVerified = null
    try {
      if (jwtCustomerId) {
        const accR = await client.query(
          'SELECT id, account_type, first_name, last_name, phone, email, vat_number, vies_valid FROM store_customers WHERE id = $1::uuid',
          [jwtCustomerId],
        )
        const acc = accR.rows?.[0]
        if (acc) {
          customerId = acc.id
          isGuest = acc.account_type === 'gastkunde'
          if (!first_name && acc.first_name) first_name = acc.first_name
          if (!last_name && acc.last_name) last_name = acc.last_name
          if (!phone && acc.phone) phone = acc.phone
          if (acc.email) email = String(acc.email).trim()
          else if (jwtEmail) email = jwtEmail
          if (acc.account_type === 'gewerbe' && acc.vat_number) {
            customerVatId = String(acc.vat_number).trim() || null
            customerVatIdVerified = acc.vies_valid === true ? true : (acc.vies_valid === false ? false : null)
          }
        }
      } else if (email) {
        const custRes = await client.query('SELECT id, account_type, vat_number, vies_valid FROM store_customers WHERE LOWER(TRIM(email)) = LOWER(TRIM($1))', [email])
        if (custRes.rows && custRes.rows[0]) {
          customerId = custRes.rows[0].id
          isGuest = custRes.rows[0].account_type === 'gastkunde'
          if (custRes.rows[0].account_type === 'gewerbe' && custRes.rows[0].vat_number) {
            customerVatId = String(custRes.rows[0].vat_number).trim() || null
            const vv = custRes.rows[0].vies_valid
            customerVatIdVerified = vv === true ? true : (vv === false ? false : null)
          }
        } else {
          const insC = await client.query(
            `INSERT INTO store_customers (email, first_name, last_name, phone, account_type, address_line1, zip_code, city, country)
             VALUES ($1,$2,$3,$4,'gastkunde',$5,$6,$7,$8)
             ON CONFLICT (email) DO UPDATE SET
               first_name = COALESCE(EXCLUDED.first_name, store_customers.first_name),
               last_name  = COALESCE(EXCLUDED.last_name,  store_customers.last_name),
               updated_at = now()
             RETURNING id`,
            [email, first_name, last_name, phone, address_line1, postal_code, city, country],
          )
          if (insC.rows && insC.rows[0]) customerId = insC.rows[0].id
          isGuest = true
        }
      }
    } catch (_) {}

    const shippingFromBody = Math.max(0, Number(body.shipping_cents || 0))
    const moneyRoute = computeCartCheckoutMoney(cart, shippingFromBody)
    const isZeroPayOrder = moneyRoute.payTotalCents === 0
    const paymentIntentId = (body.payment_intent_id || body.paymentIntentId || '').toString().trim()

    if (!isZeroPayOrder && !paymentIntentId) {
      await client.end()
      return res.status(400).json({ message: 'payment_intent_id required' })
    }
    if (isZeroPayOrder && !jwtCustomerId) {
      await client.end()
      return res.status(401).json({
        message:
          'Anmeldung erforderlich für einen 0 €-Checkout (Bonus / Rabatt deckt den gesamten Betrag). Keine Kartenzahlung bei Stripe.',
      })
    }
    if (isZeroPayOrder && paymentIntentId.startsWith('pi_')) {
      await client.end()
      return res.status(400).json({ message: 'Ungültige Kombination: 0 €-Checkout darf keine PaymentIntent-ID enthalten.' })
    }

    let shippingCentsOrder = shippingFromBody
    let orderPaidTotalCents = 0
    let paidCentsFromStripe = 0

    const platformRowOrders = await loadPlatformCheckoutRow(client)
    const secretKey = resolveStripeSecretKeyFromPlatform(platformRowOrders)
    let paymentMethod = 'card'
    let stripeInst = null
    let piStripeAccountId = null   // connected account from destination charge
    let piAppFeeCents = null       // application_fee_amount from destination charge

    if (isZeroPayOrder) {
      orderPaidTotalCents = 0
      paidCentsFromStripe = 0
      shippingCentsOrder = shippingFromBody
      const bDisc = Number(moneyRoute.bonusDiscountCents || 0)
      const cDisc = Number(moneyRoute.couponDiscountCents || 0)
      if (bDisc > 0 && cDisc > 0) paymentMethod = 'bonus_points_coupon'
      else if (bDisc > 0) paymentMethod = 'bonus_points'
      else if (cDisc > 0) paymentMethod = 'coupon'
      else paymentMethod = 'promotion'
    } else if (secretKey) {
      try {
        stripeInst = new (require('stripe'))(secretKey)
        const pi = await stripeInst.paymentIntents.retrieve(paymentIntentId, { expand: ['payment_method'] })
        if (pi.status !== 'succeeded') {
          await client.end()
          return res.status(400).json({ message: `Zahlung noch nicht abgeschlossen (Status: ${pi.status})` })
        }
        paidCentsFromStripe = Number(pi.amount)

        const recon = await reconcileCartCheckoutFromPaymentIntent(client, cartId, cart, pi)
        if (!recon.ok) {
          await client.end()
          const msg =
            recon.reason === 'subtotal'
              ? 'Der Warenkorb hat sich seit der Zahlung geändert. Bitte Checkout neu laden.'
              : 'Die Zahlung passt nicht zu diesem Warenkorb. Bitte Checkout neu laden.'
          return res.status(400).json({ message: msg })
        }
        cart = recon.cart

        const m = pi.metadata || {}
        const snapPay = parseInt(String(m.pay_total_cents || ''), 10)
        const snapShip = parseInt(String(m.shipping_cents_snapshot || ''), 10)

        if (Number.isFinite(snapPay) && Number.isFinite(snapShip) && snapPay === paidCentsFromStripe) {
          const verifyMoney = computeCartCheckoutMoney(cart, snapShip)
          if (verifyMoney.payTotalCents !== paidCentsFromStripe || verifyMoney.payTotalCents !== snapPay) {
            await client.end()
            return res.status(400).json({ message: 'Zahlungsbetrag stimmt nicht mit dem Warenkorb überein. Bitte Checkout neu laden.' })
          }
          shippingCentsOrder = snapShip
          orderPaidTotalCents = paidCentsFromStripe
        } else {
          const fb = computeCartCheckoutMoney(cart, shippingFromBody)
          orderPaidTotalCents = fb.payTotalCents
          if (paidCentsFromStripe !== orderPaidTotalCents) {
            await client.end()
            return res.status(400).json({ message: 'Zahlungsbetrag stimmt nicht mit dem Warenkorb überein. Bitte Checkout neu laden.' })
          }
        }

        const pm = pi.payment_method
        if (pm && typeof pm === 'object') {
          if (pm.type === 'card' && pm.card && pm.card.brand) { paymentMethod = pm.card.brand }
          else if (pm.type) { paymentMethod = pm.type }
        } else if (pi.payment_method_types && pi.payment_method_types[0]) {
          paymentMethod = pi.payment_method_types[0]
        }
        piStripeAccountId = (typeof pi.transfer_data?.destination === 'string' ? pi.transfer_data.destination : pi.transfer_data?.destination?.id) || null
        piAppFeeCents = pi.application_fee_amount || null
      } catch (e) {
        await client.end()
        return res.status(400).json({ message: e?.message || 'Zahlung konnte nicht verifiziert werden' })
      }
    } else if (!isZeroPayOrder) {
      await client.end()
      return res.status(503).json({ message: 'Stripe Secret Key nicht konfiguriert — Sellercentral → Einstellungen → Checkout speichern.' })
    }

    const moneyInsert = computeCartCheckoutMoney(cart, shippingCentsOrder)
    const subtotalCents = moneyInsert.subtotalCents
    const discountCents = moneyInsert.discountCents
    const couponDiscountCents = moneyInsert.couponDiscountCents
    const bonusPointsRedeemed = Number(cart.bonus_points_reserved || 0)
    if (!isZeroPayOrder && secretKey && moneyInsert.payTotalCents !== paidCentsFromStripe) {
      await client.end()
      return res.status(400).json({ message: 'Zahlungsbetrag stimmt nicht mit dem Warenkorb überein. Bitte Checkout neu laden.' })
    }
    if (isZeroPayOrder && moneyInsert.payTotalCents !== 0) {
      await client.end()
      return res.status(400).json({ message: 'Warenkorb nicht mehr 0 € — Checkout neu laden.' })
    }
    if (isZeroPayOrder && !customerId) {
      await client.end()
      return res.status(401).json({ message: 'Kundenkonto für 0 €-Checkout erforderlich.' })
    }

    if (bonusPointsRedeemed > 0 && customerId) {
      const chk = await client.query('SELECT COALESCE(bonus_points,0) AS bp FROM store_customers WHERE id = $1::uuid', [customerId])
      const bal = Number(chk.rows?.[0]?.bp || 0)
      if (bal < bonusPointsRedeemed) {
        await client.end()
        return res.status(400).json({ message: 'Bonuspunkte reichen nicht mehr. Bitte Checkout neu laden.' })
      }
    }

    let sellerCommissionRate = 0.12
    try {
      const crR = await client.query(
        'SELECT commission_rate FROM seller_users WHERE seller_id = $1 LIMIT 1',
        [sellerId],
      )
      if (crR.rows?.[0] && crR.rows[0].commission_rate != null) {
        sellerCommissionRate = Number(crR.rows[0].commission_rate)
      }
    } catch (_) {}
    // A cart can contain items from multiple sellers (store-checkout allows mixed-seller carts
    // for display/coupon purposes — see cartLineSellerKey usage elsewhere in this file), but only
    // one seller_id is stamped on the order. seller_net_after_commission_cents must reflect only
    // THIS seller's own line items, not the whole cart's subtotal, or a shared order would pay out
    // the "primary" seller for merchandise that isn't theirs.
    const sellerOwnItemsSubtotalCents = items
      .filter((it) => cartLineSellerKey(it) === sellerId)
      .reduce((sum, it) => sum + Number(it.unit_price_cents || 0) * Number(it.quantity || 1), 0)
    const sellerScopedBasisCents = sellerOwnItemsSubtotalCents > 0 ? sellerOwnItemsSubtotalCents : subtotalCents
    const platformFeeMerchandiseBasis = platformCommissionCentsFromMerchandise(
      { subtotal_cents: sellerScopedBasisCents, total_cents: orderPaidTotalCents },
      sellerCommissionRate,
    )

    // When piStripeAccountId is set, the payment was routed via Destination Charge.
    // The commission (application_fee_amount) was already deducted by Stripe.
    const stripeTransferInit = (piStripeAccountId && !isZeroPayOrder) ? 'destination_charge' : 'not_applicable'
    const checkoutPaymentKind = isZeroPayOrder ? 'platform_loyalty' : 'stripe'
    const sellerNetMerchandiseCents = Math.max(0, sellerScopedBasisCents - platformFeeMerchandiseBasis)
    const paymentIntentForDb = isZeroPayOrder ? null : paymentIntentId

    const stripeApplicationFeeForDb = piAppFeeCents != null ? piAppFeeCents : platformFeeMerchandiseBasis

    // Per-customer coupon limit check
    if (cart.coupon_code && customerId) {
      try {
        const cpnRow = (await client.query(
          `SELECT id, per_customer_limit FROM admin_hub_coupons WHERE lower(code) = lower($1) AND active = true LIMIT 1`,
          [cart.coupon_code]
        )).rows[0]
        if (cpnRow?.per_customer_limit != null) {
          const usageCnt = Number((await client.query(
            `SELECT COUNT(*) AS cnt FROM admin_hub_coupon_usage WHERE coupon_id = $1 AND customer_id = $2`,
            [cpnRow.id, customerId]
          )).rows[0]?.cnt || 0)
          if (usageCnt >= cpnRow.per_customer_limit) {
            await client.end()
            return res.status(400).json({ message: 'Dieser Coupon wurde bereits zu oft verwendet' })
          }
        }
      } catch (_) {}
    }

    const ins = await client.query(
      `INSERT INTO store_orders
        (cart_id, payment_intent_id, status, seller_id, email, first_name, last_name, phone,
         address_line1, address_line2, city, postal_code, country,
         billing_address_line1, billing_address_line2, billing_city, billing_postal_code, billing_country, billing_same_as_shipping,
         payment_method, customer_id, is_guest, newsletter_opted_in,
         order_status, payment_status, stripe_transfer_status,
         stripe_account_id, stripe_application_fee_cents, stripe_payout_status,
         checkout_payment_kind, seller_net_after_commission_cents,
         subtotal_cents, discount_cents, coupon_code, coupon_discount_cents, shipping_cents, bonus_points_redeemed, total_cents, currency, locale,
         platform_bonus_funding_cents, customer_vat_id, customer_vat_id_verified)
       VALUES ($1,$2,'paid',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'offen','bezahlt',
         '${stripeTransferInit}',$33,$23,'pending',
         $24,$25,
         $26,$27,$28,$29,$30,$31,$32,'eur',$34,
         $35,$36,$37)
       RETURNING id, order_number`,
      [cartId, paymentIntentForDb, sellerId, email, first_name, last_name, phone,
       address_line1, address_line2, city, postal_code, country,
       billing_address_line1, billing_address_line2, billing_city, billing_postal_code, billing_country, billingSame,
       paymentMethod, customerId, isGuest, newsletter_opted_in,
       stripeApplicationFeeForDb,
       checkoutPaymentKind,
       sellerNetMerchandiseCents,
       subtotalCents, discountCents, cart.coupon_code || null, couponDiscountCents, shippingCentsOrder, bonusPointsRedeemed, orderPaidTotalCents,
       piStripeAccountId || null, locale,
       discountCentsFromBonusPoints(bonusPointsRedeemed), customerVatId, customerVatIdVerified]
    )

    const orderId = ins.rows && ins.rows[0] ? ins.rows[0].id : null
    const orderNumber = ins.rows && ins.rows[0] ? ins.rows[0].order_number : null
    if (!orderId) { await client.end(); return res.status(500).json({ message: 'Order insert failed' }) }

    // Update Stripe payment intent with order number and seller display name (merge metadata — keep PI snapshot keys)
    if (!isZeroPayOrder && secretKey && orderNumber && paymentIntentId) {
      try {
        const stripeForUpdate = stripeInst || new (require('stripe'))(secretKey)
        const curPi = await stripeForUpdate.paymentIntents.retrieve(paymentIntentId)
        const prevMeta = curPi.metadata && typeof curPi.metadata === 'object' ? curPi.metadata : {}
        await stripeForUpdate.paymentIntents.update(paymentIntentId, {
          description: `#${orderNumber} — ${sellerLabelShort}`,
          metadata: {
            ...prevMeta,
            order_number: String(orderNumber),
            order_id: String(orderId),
            seller_id: String(sellerId),
            seller_name: sellerLabelShort,
          },
        })
      } catch (_) {}
    }

    // Stripe Connect transfer is intentionally NOT sent at order creation.
    // It is dispatched by scheduled job after delivery + 14 days.

    for (const it of items) {
      await client.query(
        `INSERT INTO store_order_items
          (order_id, variant_id, product_id, quantity, unit_price_cents, title, thumbnail, product_handle, seller_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          orderId,
          it.variant_id,
          it.product_id,
          it.quantity,
          it.unit_price_cents,
          it.title,
          it.thumbnail,
          it.product_handle,
          cartLineSellerKey(it),
        ]
      )
    }

    if (bonusPointsRedeemed > 0 && customerId) {
      await client.query(
        `UPDATE store_customers SET bonus_points = bonus_points - $1, updated_at = NOW() WHERE id = $2::uuid AND bonus_points >= $1`,
        [bonusPointsRedeemed, customerId],
      )
      try {
        await appendBonusLedger(client, {
          customerId,
          pointsDelta: -bonusPointsRedeemed,
          description: `Bestellung #${orderNumber} — Bonus an der Kasse eingelöst (−${bonusPointsRedeemed} Punkte)`,
          source: 'order_redeem',
          orderId,
          skipBalanceUpdate: true,
        })
      } catch (le) {
        console.warn('bonus ledger order_redeem:', le?.message || le)
      }
    }
    if (!isGuest && customerId) {
      const earned = bonusPointsEarnedFromOrderPaidCents(orderPaidTotalCents)
      if (earned > 0) {
        await client.query(
          `UPDATE store_customers SET bonus_points = COALESCE(bonus_points, 0) + $1, updated_at = NOW() WHERE id = $2::uuid`,
          [earned, customerId],
        )
        try {
          await appendBonusLedger(client, {
            customerId,
            pointsDelta: earned,
            description: `Bestellung #${orderNumber} (+${earned} Punkte)`,
            source: 'order_earn',
            orderId,
            skipBalanceUpdate: true,
          })
        } catch (le) {
          console.warn('bonus ledger order_earn:', le?.message || le)
        }
      }
    }

    // Increment coupon used_count + record per-customer usage
    if (cart.coupon_code) {
      await client.query(
        `UPDATE admin_hub_coupons SET used_count = COALESCE(used_count, 0) + 1, updated_at = now() WHERE lower(code) = lower($1)`,
        [cart.coupon_code]
      ).catch(() => {})
      if (customerId) {
        await client.query(
          `INSERT INTO admin_hub_coupon_usage (coupon_id, customer_id, order_id)
           SELECT id, $1, $2 FROM admin_hub_coupons WHERE lower(code) = lower($3) LIMIT 1`,
          [customerId, orderId, cart.coupon_code]
        ).catch(() => {})
      }
    }

    await clearCartBonusReserve(client, cartId)
    await client.query('UPDATE store_carts SET coupon_code = NULL, coupon_discount_cents = 0, updated_at = now() WHERE id = $1', [cartId]).catch(() => {})

    // Clear cart items so user can't reorder accidentally
    await client.query('DELETE FROM store_cart_items WHERE cart_id = $1', [cartId])

    const order = await getOrderWithItems(client, orderId)
    await client.end()
    res.status(201).json({ order })
    // Fire-and-forget AFTER response — must be outside try so a failure cannot trigger the 500 catch handler
    void dispatchOrderFlowEvent('order_placed', orderId)
    // docs/affiliate.md PR 4 — no-op when the checkout payload didn't include an affiliate_cookie_id
    // (the vast majority of orders; only visitors who arrived via a consented affiliate link have one).
    if (affiliateCookieId) {
      void require('../modules/affiliate-platform/workers/commission-recalc')
        .recalcAffiliateCommissionForOrder({
          orderId, cookieId: affiliateCookieId, sellerId,
          platformCommissionCents: platformFeeMerchandiseBasis,
          grossAmountCents: sellerScopedBasisCents,
          customerEmail: email,
        })
        .catch((e) => console.warn('recalcAffiliateCommissionForOrder:', e?.message || e))
    }
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('Store orders POST:', err)
    if (!res.headersSent) res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

/**
 * Ownership check applied ONLY when a Bearer token is present. A logged-in customer must own the
 * order (same email or customer_id) — no more paging through other people's orders by editing the
 * URL. Requests WITHOUT a token (guest post-checkout redirect, order-status links in confirmation
 * emails — flow-automation.js builds these for guests who never get a token) still resolve by ID
 * alone, same as before. This is a deliberate, narrower fix: order.id is a random UUID (not
 * enumerable), so treating it as a capability URL for the guest case is an accepted trade-off,
 * not an oversight — see docs/BonusPunkte.md-adjacent security note in this session's summary if
 * this needs revisiting (a signed short-lived guest access token would close the remaining gap).
 */
const storeOrdersGET = async (req, res) => {
  const orderId = (req.params.id || '').toString().trim()
  if (!orderId) return res.status(400).json({ message: 'Order id required' })
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return res.status(503).json({ message: 'Database not configured' })

  const authHeader = req.headers.authorization || ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  let requireOwnership = false
  let payload = null
  if (token) {
    payload = verifyCustomerToken(token)
    if (!payload?.email) return res.status(401).json({ message: 'Invalid token' })
    requireOwnership = true
  }

  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const order = await getOrderWithItems(client, orderId)
    await client.end()
    if (!order) return res.status(404).json({ message: 'Order not found' })
    if (requireOwnership) {
      const emailMatch = order.email && String(order.email).trim().toLowerCase() === String(payload.email).trim().toLowerCase()
      const customerMatch = order.customer_id && payload.id && String(order.customer_id) === String(payload.id)
      if (!emailMatch && !customerMatch) return res.status(404).json({ message: 'Order not found' })
    }
    res.json({ order })
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('Store orders GET:', err)
    res.status(500).json({ message: (err && err.message) || 'Internal server error' })
  }
}

const storePublicPaymentConfigGET = async (_req, res) => {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) {
    return res.json({ stripe_publishable_key: null, payment_method_types: paymentMethodTypesFromPlatformRow(null) })
  }
  let client
  try {
    const { Client } = require('pg')
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const row = await loadPlatformCheckoutRow(client)
    await client.end()
    const dbPk = resolveStripePublishableFromPlatform(row)
    res.json({
      stripe_publishable_key: dbPk || null,
      payment_method_types: paymentMethodTypesFromPlatformRow(row),
      payment_method_layout: (row?.payment_method_layout || 'grid').toString(),
    })
  } catch (err) {
    if (client) try { await client.end() } catch (_) {}
    console.error('storePublicPaymentConfigGET:', err)
    res.json({ stripe_publishable_key: null, payment_method_types: ['card'] })
  }
}

// Routes


// ── Router ────────────────────────────────────────────────────────────────────
module.exports = function createStoreCheckoutRouter() {
  const router = Router()

  // Carts
  router.post('/store/carts', storeCartsPOST)
  router.get('/store/carts/:id', storeCartGET)
  router.patch('/store/carts/:id', storeCartPATCH)
  router.post('/store/carts/:id/line-items', storeCartLineItemsPOST)
  router.patch('/store/carts/:id/line-items/:lineId', storeCartLineItemPATCH)
  router.delete('/store/carts/:id/line-items/:lineId', storeCartLineItemDELETE)
  router.delete('/store/carts/:id/line-items', storeCartClearDELETE)

  // Payment + Orders
  router.get('/store/public-payment-config', storePublicPaymentConfigGET)
  router.post('/store/payment-intent', storePaymentIntentPOST)
  router.post('/store/orders', storeOrdersPOST)
  router.get('/store/orders/me', storeOrdersMeGET)
  router.get('/store/orders/:id', storeOrdersGET)
  router.post('/store/orders/:id/cancel', storeOrdersCancelPOST)
  router.post('/store/orders/:id/return-request', storeReturnRequestPOST)
  router.post('/store/orders/:id/return-tracking', storeReturnTrackingPOST)
  router.get('/store/orders/:id/invoice', storeOrderInvoicePdfGET)
  router.get('/store/orders/:id/return-retourenschein', storeOrderReturnRetourenscheinGET)
  router.get('/store/orders/:id/return-etikett', storeOrderReturnEtikettGET)

  // Customers
  router.post('/store/customers', storeCustomerRegisterPOST)
  router.get('/store/customers/email-exists', storeCustomerEmailExistsGET)
  router.post('/store/auth/token', storeAuthTokenPOST)
  router.get('/store/customers/me', storeCustomersMeGET)
  router.patch('/store/customers/me', storeCustomerMePATCH)
  router.delete('/store/customers/me', storeCustomerMeDELETE)
  router.get('/store/customers/me/addresses', storeCustomerAddressesGET)
  router.post('/store/customers/me/addresses', storeCustomerAddressesPOST)
  router.patch('/store/customers/me/addresses/:addressId', storeCustomerAddressesPATCH)
  router.delete('/store/customers/me/addresses/:addressId', storeCustomerAddressesDELETE)

  // Wishlist
  router.get('/store/wishlist', storeWishlistGET)
  router.post('/store/wishlist', storeWishlistPOST)
  router.delete('/store/wishlist/:productId', storeWishlistDELETE)

  // Reviews
  router.get('/store/reviews/my', storeReviewsMyGET)
  router.get('/store/reviews', storeReviewsGET)
  router.post('/store/reviews', storeReviewsPOST)
  router.get('/admin-hub/reviews', adminHubReviewsGET)

  // Shipping Groups
  router.get('/admin-hub/v1/shipping-groups', requireSellerAuth, adminHubShippingGroupsGET)
  router.post('/admin-hub/v1/shipping-groups', requireSellerAuth, adminHubShippingGroupPOST)
  router.patch('/admin-hub/v1/shipping-groups/:id', requireSellerAuth, adminHubShippingGroupPATCH)
  router.delete('/admin-hub/v1/shipping-groups/:id', requireSellerAuth, adminHubShippingGroupDELETE)
  router.get('/store/shipping-groups', storeShippingGroupsGET)
  router.get('/admin-hub/v1/country-overview', requireSellerAuth, adminHubCountryOverviewGET)
  router.patch('/admin-hub/v1/country-overview', requireSellerAuth, adminHubCountryOverviewBulkPATCH)
  router.patch('/admin-hub/v1/country-overview/:country_code', requireSellerAuth, adminHubCountryOverviewPATCH)

  return router
}

module.exports.verifyCustomerToken = verifyCustomerToken
module.exports.signCustomerToken = signCustomerToken
module.exports.customerIdForPg = customerIdForPg
module.exports.appendBonusLedger = appendBonusLedger
module.exports.stripLegacyBonusLedgerVersandSuffix = stripLegacyBonusLedgerVersandSuffix
module.exports.buildOrderSettlementBreakdown = buildOrderSettlementBreakdown
module.exports.sellerOrderRevenueBasisCents = sellerOrderRevenueBasisCents
module.exports.resolvePlatformApplicationFeeCents = resolvePlatformApplicationFeeCents
module.exports.platformCommissionCentsFromMerchandise = platformCommissionCentsFromMerchandise
module.exports.normalizeCouponCode = normalizeCouponCode
module.exports.bonusPointsEarnedFromOrderPaidCents = bonusPointsEarnedFromOrderPaidCents
module.exports.getOrderWithItems = getOrderWithItems
module.exports.resolveSellerDisplayNameForStripe = resolveSellerDisplayNameForStripe
module.exports.truncateForStripeDescription = truncateForStripeDescription
module.exports.computeCartCheckoutMoney = computeCartCheckoutMoney
module.exports.discountCentsFromBonusPoints = discountCentsFromBonusPoints
module.exports.clampCartBonusRedemption = clampCartBonusRedemption
