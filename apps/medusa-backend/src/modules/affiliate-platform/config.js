'use strict'

/**
 * Affiliate platform default parameters — single source of truth for every hardcoded number
 * used across the module. Mirrors docs/affiliate.md's "KARAR TABLOSU" (decision table) exactly.
 *
 * Karar Değişikliği Prosedürü (docs/affiliate.md): if any of these values change, update the
 * decision table there FIRST, then this file + a migration if the change affects stored rows,
 * then rebase any open PRs against the new value.
 */
module.exports = {
  // ── Attribution ──────────────────────────────────────────────────────────────
  PRODUCT_ATTRIBUTION_WINDOW_DAYS: 30,
  SELLER_SIGNUP_ATTRIBUTION_WINDOW_HOURS: 24,
  ATTRIBUTION_MODEL: 'last_click',

  // ── Platform fee (Andertal) — affiliate payout is a percentage of this ─────────
  DEFAULT_PLATFORM_COMMISSION_RATE: 0.12, // used when seller_users.commission_rate is unset

  // ── Seller Referral (Model 1) — % of Andertal's platform commission ────────────
  SELLER_REFERRAL_OF_PLATFORM_PCT: 5,

  // ── Product Referral (Model 2) — % of Andertal's platform commission ───────────
  PRODUCT_REFERRAL_OF_PLATFORM_PCT: 8,

  // ── Payout (Andertal treasury → affiliate Stripe Connect) ──────────────────────
  MIN_PAYOUT_EUR: 50,
  PAYOUT_DAY_OF_MONTH: 1,
  PAYOUT_HOUR_UTC: 3,
  CONFIRMATION_HOLD_DAYS: 30,

  // ── Cookie & tracking ────────────────────────────────────────────────────────
  COOKIE_NAME: '__atrl',
  COOKIE_MAX_AGE_SECONDS: 30 * 86400,

  // ── Fraud & compliance ───────────────────────────────────────────────────────
  SELF_REFERRAL_AUTO_BLOCK: true,
  IP_MATCH_AUTO_FLAG: true,
  VELOCITY_CLICKS_PER_DAY_THRESHOLD: 50,
  CHARGEBACK_AUTO_SUSPEND_THRESHOLD: 3,
  CHARGEBACK_SUSPEND_WINDOW_DAYS: 90,
  FRAUD_FLAGS_AUTO_SUSPEND_THRESHOLD: 3,
  KYC_REQUIRED_OVER_EUR: 600, // DAC7

  // ── Approval (affiliate account signup — not product enrollment, that doesn't exist) ──
  MANUAL_APPROVAL_FIRST_N_AFFILIATES: 100,

  // ── Geography / currency ────────────────────────────────────────────────────
  ALLOWED_COUNTRIES: ['DE', 'AT', 'CH', 'NL', 'BE', 'LU', 'FR', 'IT', 'ES', 'PT', 'IE', 'DK', 'SE', 'FI', 'PL', 'GB'],
  CURRENCY: 'EUR',

  // ── Codes ────────────────────────────────────────────────────────────────────
  AFFILIATE_CODE_PREFIX: 'AFF_',
  AFFILIATE_CODE_RANDOM_LENGTH: 8, // base32 chars after the prefix

  // ── Source types (affiliate_links.type / affiliate_attributions.source_type) ──
  LINK_TYPES: ['seller_signup', 'product', 'category', 'storefront'],
  ATTRIBUTION_SOURCE_TYPES: ['product', 'seller_signup', 'storefront'],
  COMMISSION_SOURCE_TYPES: ['seller_referral', 'product_sale'],

  // ── Statuses ─────────────────────────────────────────────────────────────────
  AFFILIATE_STATUSES: ['pending', 'active', 'suspended', 'banned', 'closed'],
  COMMISSION_STATUSES: ['pending', 'confirmed', 'clawed_back', 'paid', 'forfeited'],
  PAYOUT_STATUSES: ['pending', 'processing', 'paid', 'failed'],
  FRAUD_FLAG_TYPES: ['self_referral', 'ip_match', 'velocity', 'pattern', 'chargeback', 'brand_bid', 'manual'],
  FRAUD_FLAG_SEVERITIES: ['low', 'medium', 'high'],
}
