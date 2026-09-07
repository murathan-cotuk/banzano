'use strict'

/**
 * Affiliate platform DB schema — docs/affiliate.md's "VERİTABANI MIGRATION'LARI" section,
 * translated into this repo's actual working pattern: an idempotent `CREATE TABLE IF NOT EXISTS`
 * ensure-function called at the top of request handlers (see routes/campaigns.js's
 * ensureAutomationTable), not the mostly-abandoned TypeORM migrations/ folder — Postgres makes
 * a no-op `IF NOT EXISTS` check cheap, so there's no need for a run-once guard.
 *
 * No product_affiliate_enrollments table — docs/affiliate.md is explicit that Model 2 (product
 * referral) has no seller enrollment/approval step, so there's nothing to store per-product.
 *
 * @param {import('pg').Client} client already-connected pg client
 */
async function ensureAffiliateTables(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS affiliates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT UNIQUE NOT NULL,                       -- AFF_K3X9MNQ7
      vanity_slug TEXT UNIQUE,                         -- /r/john-smith, optional
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT,
      company_name TEXT,
      country TEXT,
      vat_number TEXT,
      tax_id TEXT,                                     -- required once lifetime earnings pass KYC_REQUIRED_OVER_EUR (DAC7)
      stripe_account_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',           -- pending | active | suspended | banned | closed
      ban_reason TEXT,                                  -- fraud | tos_violation | self_closed | ...
      terms_accepted_at TIMESTAMPTZ,
      email_verified_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS affiliate_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      affiliate_id uuid NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      type TEXT NOT NULL,                              -- 'seller_signup' | 'product' | 'category' | 'storefront'
      target_url TEXT NOT NULL,
      short_code TEXT UNIQUE NOT NULL,                 -- /r/{short_code}
      product_id uuid,                                 -- type='product' — any catalog product, no enrollment gate
      label TEXT,
      disabled_at TIMESTAMPTZ,                         -- superuser emergency disable (legal/fraud), link stays for history
      disabled_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await client.query(`CREATE INDEX IF NOT EXISTS affiliate_links_affiliate_id_idx ON affiliate_links(affiliate_id)`)

  await client.query(`
    CREATE TABLE IF NOT EXISTS affiliate_clicks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      link_id uuid NOT NULL REFERENCES affiliate_links(id) ON DELETE CASCADE,
      affiliate_id uuid NOT NULL REFERENCES affiliates(id),
      ip_hash TEXT,                                    -- SHA-256, never the raw IP (GDPR pseudonymization)
      user_agent TEXT,
      referer TEXT,
      country TEXT,
      cookie_id TEXT,                                  -- anonymous visitor id
      consent_marketing BOOLEAN NOT NULL,              -- false: click stored, no cookie set, no attribution
      bot_flagged BOOLEAN NOT NULL DEFAULT false,
      clicked_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await client.query(`CREATE INDEX IF NOT EXISTS affiliate_clicks_cookie_id_idx ON affiliate_clicks(cookie_id)`)
  await client.query(`CREATE INDEX IF NOT EXISTS affiliate_clicks_affiliate_id_idx ON affiliate_clicks(affiliate_id)`)

  await client.query(`
    CREATE TABLE IF NOT EXISTS affiliate_attributions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      affiliate_id uuid NOT NULL REFERENCES affiliates(id),
      cookie_id TEXT NOT NULL,
      source_type TEXT NOT NULL,                       -- 'product' | 'seller_signup' | 'storefront'
      product_id uuid,                                 -- set when source_type='product'
      first_click_at TIMESTAMPTZ NOT NULL,
      last_click_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,                 -- product: +30d, seller_signup: +24h (config.js)
      resolved_order_id uuid,
      resolved_seller_id text,                          -- marketplace seller_id (text throughout this codebase, not seller_users.id)
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await client.query(`CREATE INDEX IF NOT EXISTS affiliate_attributions_cookie_id_idx ON affiliate_attributions(cookie_id)`)
  await client.query(`CREATE INDEX IF NOT EXISTS affiliate_attributions_expires_at_idx ON affiliate_attributions(expires_at)`)

  // Model 1 (seller referral): a seller is locked to whichever affiliate's link they signed up
  // through, for as long as the referral relationship exists — UNIQUE(seller_id) is what actually
  // enforces the "first attribute wins, never reassigned" lock-in from docs/affiliate.md, not the
  // (last-click) affiliate_attributions row that led up to the signup.
  await client.query(`
    CREATE TABLE IF NOT EXISTS seller_referrals (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      affiliate_id uuid NOT NULL REFERENCES affiliates(id) ON DELETE RESTRICT,
      seller_id text NOT NULL UNIQUE,                   -- marketplace seller_id (text, not seller_users.id)
      referred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      commission_tier_active BOOLEAN NOT NULL DEFAULT true,
      current_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 5.00,  -- % of Andertal's platform commission
      notes TEXT
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS affiliate_commissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      affiliate_id uuid NOT NULL REFERENCES affiliates(id),
      source_type TEXT NOT NULL,                       -- 'seller_referral' | 'product_sale'
      order_id uuid,
      seller_id text,                                   -- marketplace seller_id (text, not seller_users.id)
      product_id uuid,
      gross_amount_cents INTEGER NOT NULL,              -- merchandise / GMV basis (cents)
      platform_commission_cents INTEGER NOT NULL,       -- Andertal's own cut (cents)
      rate_pct NUMERIC(5,2) NOT NULL,                   -- seller_referral: 5 | product_sale: 8
      commission_cents INTEGER NOT NULL,                -- platform_commission_cents * rate_pct / 100
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'pending',           -- pending | confirmed | clawed_back | paid | forfeited
      earned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      confirmable_at TIMESTAMPTZ NOT NULL,               -- earned_at + 30 days
      payout_id uuid,
      emergency_protected BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await client.query(`CREATE INDEX IF NOT EXISTS affiliate_commissions_affiliate_id_idx ON affiliate_commissions(affiliate_id)`)
  await client.query(`CREATE INDEX IF NOT EXISTS affiliate_commissions_status_idx ON affiliate_commissions(status)`)

  await client.query(`
    CREATE TABLE IF NOT EXISTS affiliate_payouts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      affiliate_id uuid NOT NULL REFERENCES affiliates(id),
      amount_cents INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'EUR',
      status TEXT NOT NULL DEFAULT 'pending',           -- pending | processing | paid | failed
      stripe_transfer_id TEXT,
      period_start DATE,
      period_end DATE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    )
  `)

  await client.query(`
    CREATE TABLE IF NOT EXISTS affiliate_fraud_flags (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      affiliate_id uuid NOT NULL REFERENCES affiliates(id),
      flag_type TEXT NOT NULL,                          -- self_referral | ip_match | velocity | pattern | chargeback | brand_bid | manual
      severity TEXT NOT NULL,                           -- low | medium | high
      details JSONB,
      resolved_by TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `)
  await client.query(`CREATE INDEX IF NOT EXISTS affiliate_fraud_flags_affiliate_id_idx ON affiliate_fraud_flags(affiliate_id)`)

  // seller_users already exists (seller-auth.js) — this column links a seller to the affiliate
  // whose signup link they registered through (Model 1). Nullable: most sellers have no referral.
  await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS referred_by_affiliate_id uuid REFERENCES affiliates(id)`)
}

module.exports = { ensureAffiliateTables }
