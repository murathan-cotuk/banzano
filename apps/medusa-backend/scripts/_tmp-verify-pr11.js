require('dotenv').config();
const { Client } = require('pg');
const { ensureAffiliateTables } = require('../src/modules/affiliate-platform/schema');

(async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await ensureAffiliateTables(client);

  // schema check: new column exists
  const col = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='affiliates' AND column_name='stripe_onboarding_complete'`
  );
  console.log('stripe_onboarding_complete column exists:', col.rows.length === 1);

  const a = await client.query(
    `INSERT INTO affiliates (code, email, password_hash, full_name, country, status)
     VALUES ('AFF_TEST0004', 'pr11verify@example.test', 'x', 'PR11 Test', 'DE', 'active')
     RETURNING id`
  );
  const affId = a.rows[0].id;

  const sellerId = 'pr11-test-seller';
  await client.query(
    `INSERT INTO seller_referrals (affiliate_id, seller_id, current_rate_pct) VALUES ($1, $2, 5.00)`,
    [affId, sellerId]
  );
  await client.query(
    `INSERT INTO affiliate_commissions
       (affiliate_id, source_type, seller_id, gross_amount_cents, platform_commission_cents, rate_pct, commission_cents, status, earned_at, confirmable_at)
     VALUES ($1, 'seller_referral', $2, 10000, 1200, 5.00, 60, 'confirmed', now(), now())`,
    [affId, sellerId]
  );
  await client.query(
    `INSERT INTO affiliate_payouts (affiliate_id, amount_cents, currency, status, period_start, period_end)
     VALUES ($1, 6000, 'EUR', 'paid', now()::date - 30, now()::date)`,
    [affId]
  );

  // Simulate GET /referrals query exactly
  const referrals = await client.query(
    `SELECT sr.id, sr.seller_id, sr.referred_at, sr.commission_tier_active, sr.current_rate_pct,
            COALESCE(SUM(ac.commission_cents) FILTER (
              WHERE ac.status IN ('confirmed','paid') AND ac.earned_at >= date_trunc('month', now())
            ), 0)::int AS this_month_cents,
            COALESCE(SUM(ac.commission_cents) FILTER (WHERE ac.status IN ('confirmed','paid')), 0)::int AS lifetime_cents
       FROM seller_referrals sr
       LEFT JOIN affiliate_commissions ac
         ON ac.affiliate_id = sr.affiliate_id AND ac.seller_id = sr.seller_id AND ac.source_type = 'seller_referral'
      WHERE sr.affiliate_id = $1
      GROUP BY sr.id`,
    [affId]
  );
  console.log('referrals row:', referrals.rows[0]);

  // Simulate GET /payouts query exactly
  const payouts = await client.query(
    `SELECT id, amount_cents, currency, status, period_start, period_end FROM affiliate_payouts WHERE affiliate_id = $1`,
    [affId]
  );
  const pending = await client.query(
    `SELECT COALESCE(SUM(commission_cents), 0)::int AS cents FROM affiliate_commissions WHERE affiliate_id = $1 AND status = 'confirmed' AND payout_id IS NULL`,
    [affId]
  );
  console.log('payouts rows:', payouts.rows.length, 'next_estimated_cents:', pending.rows[0].cents);

  // stripe_onboarding_complete update path
  await client.query(`UPDATE affiliates SET stripe_account_id = 'acct_test123', stripe_onboarding_complete = true WHERE id = $1`, [affId]);
  const check = await client.query(`SELECT stripe_account_id, stripe_onboarding_complete FROM affiliates WHERE id = $1`, [affId]);
  console.log('stripe fields:', check.rows[0]);

  // cleanup
  await client.query('DELETE FROM affiliate_payouts WHERE affiliate_id = $1', [affId]);
  await client.query('DELETE FROM affiliate_commissions WHERE affiliate_id = $1', [affId]);
  await client.query('DELETE FROM seller_referrals WHERE affiliate_id = $1', [affId]);
  await client.query('DELETE FROM affiliates WHERE id = $1', [affId]);
  const remaining = await client.query("SELECT count(*) FROM affiliates WHERE code = 'AFF_TEST0004'");
  console.log('remaining after cleanup:', remaining.rows[0].count);

  await client.end();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
