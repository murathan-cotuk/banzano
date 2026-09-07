const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  computeExpiresAt,
  isExpired,
  applyClickToAttribution,
  shouldCreateSellerReferral,
  findApplicableAttribution,
} = require('./attribution-engine')

describe('attribution-engine', () => {
  it('computeExpiresAt: product window is 30 days', () => {
    const from = new Date('2026-01-01T00:00:00Z')
    const expires = computeExpiresAt('product', from)
    assert.equal(expires.toISOString(), '2026-01-31T00:00:00.000Z')
  })

  it('computeExpiresAt: seller_signup window is 24 hours', () => {
    const from = new Date('2026-01-01T00:00:00Z')
    const expires = computeExpiresAt('seller_signup', from)
    assert.equal(expires.toISOString(), '2026-01-02T00:00:00.000Z')
  })

  it('computeExpiresAt: storefront falls back to the product window', () => {
    const from = new Date('2026-01-01T00:00:00Z')
    assert.equal(computeExpiresAt('storefront', from).getTime(), computeExpiresAt('product', from).getTime())
  })

  it('isExpired: true once expires_at has passed', () => {
    const now = new Date('2026-02-01T00:00:00Z')
    assert.equal(isExpired({ expires_at: '2026-01-31T00:00:00Z' }, now), true)
    assert.equal(isExpired({ expires_at: '2026-02-02T00:00:00Z' }, now), false)
  })

  it('isExpired: null/missing attribution counts as expired', () => {
    assert.equal(isExpired(null), true)
    assert.equal(isExpired(undefined), true)
  })

  it('applyClickToAttribution: no existing row starts a fresh attribution', () => {
    const now = new Date('2026-01-05T12:00:00Z')
    const next = applyClickToAttribution({
      existing: null,
      affiliateId: 'aff-1',
      cookieId: 'cookie-1',
      sourceType: 'product',
      productId: 'prod-1',
      now,
    })
    assert.equal(next.affiliate_id, 'aff-1')
    assert.equal(next.first_click_at, now)
    assert.equal(next.last_click_at, now)
    assert.equal(next.resolved_at, null)
    assert.equal(next.expires_at.getTime(), computeExpiresAt('product', now).getTime())
  })

  it('applyClickToAttribution: last-click — a later click from a DIFFERENT affiliate wins', () => {
    const firstClick = new Date('2026-01-01T00:00:00Z')
    const existing = {
      affiliate_id: 'aff-1',
      first_click_at: firstClick,
      last_click_at: firstClick,
      expires_at: computeExpiresAt('product', firstClick),
      resolved_at: null,
      resolved_order_id: null,
      resolved_seller_id: null,
    }
    const secondClick = new Date('2026-01-10T00:00:00Z')
    const next = applyClickToAttribution({
      existing,
      affiliateId: 'aff-2',
      cookieId: 'cookie-1',
      sourceType: 'product',
      productId: 'prod-1',
      now: secondClick,
    })
    assert.equal(next.affiliate_id, 'aff-2', 'later click overwrites the earlier affiliate')
    assert.equal(next.first_click_at, firstClick, 'first_click_at is preserved across updates')
    assert.equal(next.last_click_at, secondClick)
    assert.equal(next.expires_at.getTime(), computeExpiresAt('product', secondClick).getTime(), 'window rolls forward from the latest click')
  })

  it('applyClickToAttribution: an expired existing row is treated as absent (fresh start)', () => {
    const oldClick = new Date('2025-01-01T00:00:00Z')
    const existing = {
      affiliate_id: 'aff-1',
      first_click_at: oldClick,
      last_click_at: oldClick,
      expires_at: computeExpiresAt('product', oldClick), // long expired relative to `now` below
      resolved_at: null,
    }
    const now = new Date('2026-06-01T00:00:00Z')
    const next = applyClickToAttribution({ existing, affiliateId: 'aff-2', cookieId: 'c', sourceType: 'product', now })
    assert.equal(next.first_click_at, now, 'expired row does not carry its first_click_at forward')
  })

  it('applyClickToAttribution: a RESOLVED existing row is left alone — a new click starts a separate attribution', () => {
    const resolvedAt = new Date('2026-01-15T00:00:00Z')
    const existing = {
      affiliate_id: 'aff-1',
      first_click_at: new Date('2026-01-01T00:00:00Z'),
      last_click_at: new Date('2026-01-14T00:00:00Z'),
      expires_at: computeExpiresAt('product', new Date('2026-01-14T00:00:00Z')),
      resolved_at: resolvedAt,
      resolved_order_id: 'order-1',
      resolved_seller_id: 'seller-1',
    }
    const now = new Date('2026-01-20T00:00:00Z')
    const next = applyClickToAttribution({ existing, affiliateId: 'aff-2', cookieId: 'c', sourceType: 'product', now })
    assert.equal(next.affiliate_id, 'aff-2')
    assert.equal(next.resolved_at, null, 'fresh attribution starts unresolved even though the prior one had converted')
    assert.equal(next.first_click_at, now)
  })

  it('shouldCreateSellerReferral: true only when no referral exists yet for that seller', () => {
    assert.equal(shouldCreateSellerReferral(null), true)
    assert.equal(shouldCreateSellerReferral(undefined), true)
    assert.equal(shouldCreateSellerReferral({ id: 'ref-1', affiliate_id: 'aff-1' }), false)
  })

  it('findApplicableAttribution: picks the most recently clicked non-expired, unresolved product attribution', () => {
    const now = new Date('2026-03-01T00:00:00Z')
    const older = { source_type: 'product', last_click_at: new Date('2026-02-01T00:00:00Z'), expires_at: computeExpiresAt('product', new Date('2026-02-01T00:00:00Z')), resolved_at: null }
    const newer = { source_type: 'product', last_click_at: new Date('2026-02-20T00:00:00Z'), expires_at: computeExpiresAt('product', new Date('2026-02-20T00:00:00Z')), resolved_at: null }
    const result = findApplicableAttribution([older, newer], now)
    assert.equal(result, newer)
  })

  it('findApplicableAttribution: ignores expired and already-resolved rows', () => {
    const now = new Date('2026-06-01T00:00:00Z')
    const expired = { source_type: 'product', last_click_at: new Date('2026-01-01T00:00:00Z'), expires_at: computeExpiresAt('product', new Date('2026-01-01T00:00:00Z')), resolved_at: null }
    const resolved = { source_type: 'product', last_click_at: new Date('2026-05-25T00:00:00Z'), expires_at: computeExpiresAt('product', new Date('2026-05-25T00:00:00Z')), resolved_at: new Date('2026-05-26T00:00:00Z') }
    assert.equal(findApplicableAttribution([expired, resolved], now), null)
  })

  it('findApplicableAttribution: ignores non-product source types (seller_signup resolves via seller_referrals, not this path)', () => {
    const now = new Date('2026-01-10T00:00:00Z')
    const sellerSignup = { source_type: 'seller_signup', last_click_at: now, expires_at: computeExpiresAt('seller_signup', now), resolved_at: null }
    assert.equal(findApplicableAttribution([sellerSignup], now), null)
  })

  it('findApplicableAttribution: empty/no candidates returns null', () => {
    assert.equal(findApplicableAttribution([]), null)
    assert.equal(findApplicableAttribution(undefined), null)
  })
})
