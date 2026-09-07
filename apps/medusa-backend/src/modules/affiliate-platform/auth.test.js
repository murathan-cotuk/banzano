const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { hashPassword, verifyPassword, validatePasswordStrength, signAffiliateToken, verifyAffiliateToken } = require('./auth')

describe('affiliate auth', () => {
  it('hashPassword/verifyPassword: round-trips correctly', () => {
    const stored = hashPassword('correcthorse1')
    assert.equal(verifyPassword('correcthorse1', stored), true)
    assert.equal(verifyPassword('wrongpassword1', stored), false)
  })

  it('hashPassword: two hashes of the same password differ (random salt)', () => {
    assert.notEqual(hashPassword('correcthorse1'), hashPassword('correcthorse1'))
  })

  it('verifyPassword: malformed stored value never throws, just fails', () => {
    assert.equal(verifyPassword('x', ''), false)
    assert.equal(verifyPassword('x', 'not-a-hash'), false)
    assert.equal(verifyPassword('x', null), false)
  })

  it('validatePasswordStrength: rejects short/letters-only/digits-only, accepts a valid one', () => {
    assert.ok(validatePasswordStrength(''))
    assert.ok(validatePasswordStrength('short1'))
    assert.ok(validatePasswordStrength('alllettersnodigits'))
    assert.ok(validatePasswordStrength('12345678'))
    assert.equal(validatePasswordStrength('goodpass1'), null)
  })

  it('signAffiliateToken/verifyAffiliateToken: round-trips the payload', () => {
    const token = signAffiliateToken({ id: 'aff-1', email: 'a@b.test' })
    const payload = verifyAffiliateToken(token)
    assert.equal(payload.id, 'aff-1')
    assert.equal(payload.email, 'a@b.test')
  })

  it('verifyAffiliateToken: rejects a tampered signature', () => {
    const token = signAffiliateToken({ id: 'aff-1' })
    const [h, b] = token.split('.')
    const tampered = `${h}.${b}.deadbeef`
    assert.equal(verifyAffiliateToken(tampered), null)
  })

  it('verifyAffiliateToken: rejects garbage/empty input', () => {
    assert.equal(verifyAffiliateToken(''), null)
    assert.equal(verifyAffiliateToken(null), null)
    assert.equal(verifyAffiliateToken('not.a.token'), null)
  })
})
