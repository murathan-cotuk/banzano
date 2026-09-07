const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { computePlatformCommissionCents, computeAffiliateCommissionCents } = require('./commission-calculator')

describe('commission-calculator', () => {
  it('computePlatformCommissionCents: 100€ sale at default 12% platform rate → 12€', () => {
    assert.equal(computePlatformCommissionCents(10000), 1200)
  })

  it('computePlatformCommissionCents: honors a seller-specific commission_rate', () => {
    assert.equal(computePlatformCommissionCents(10000, 0.15), 1500)
  })

  it('computePlatformCommissionCents: rounds to the nearest cent', () => {
    assert.equal(computePlatformCommissionCents(333, 0.12), 40) // 39.96 -> 40
  })

  it('computeAffiliateCommissionCents: product_sale is 8% of the platform commission (docs/affiliate.md example)', () => {
    const { rate_pct, commission_cents } = computeAffiliateCommissionCents(1200, 'product_sale')
    assert.equal(rate_pct, 8)
    assert.equal(commission_cents, 96) // 12€ platform commission -> 0,96€ affiliate
  })

  it('computeAffiliateCommissionCents: seller_referral is 5% of the platform commission (docs/affiliate.md example)', () => {
    const { rate_pct, commission_cents } = computeAffiliateCommissionCents(1200, 'seller_referral')
    assert.equal(rate_pct, 5)
    assert.equal(commission_cents, 60) // 12€ platform commission -> 0,60€ affiliate
  })

  it('computeAffiliateCommissionCents: throws on an unknown source_type rather than silently returning 0', () => {
    assert.throws(() => computeAffiliateCommissionCents(1200, 'bogus'))
  })

  it('computeAffiliateCommissionCents: rounds to the nearest cent', () => {
    const { commission_cents } = computeAffiliateCommissionCents(1201, 'product_sale') // 96.08 -> 96
    assert.equal(commission_cents, 96)
  })
})
