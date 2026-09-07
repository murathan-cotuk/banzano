const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { generateAffiliateCode, isValidAffiliateCode } = require('./codes')

describe('affiliate codes', () => {
  it('generateAffiliateCode: AFF_ prefix + 8 chars, no ambiguous 0/O/1/I/L pairs', () => {
    const code = generateAffiliateCode()
    assert.match(code, /^AFF_[0-9A-HJKMNP-TV-Z]{8}$/)
  })

  it('generateAffiliateCode: not deterministic across calls', () => {
    const a = generateAffiliateCode()
    const b = generateAffiliateCode()
    assert.notEqual(a, b)
  })

  it('isValidAffiliateCode: accepts a freshly generated code', () => {
    assert.equal(isValidAffiliateCode(generateAffiliateCode()), true)
  })

  it('isValidAffiliateCode: rejects wrong prefix, wrong length, lowercase, and non-strings', () => {
    assert.equal(isValidAffiliateCode('XYZ_ABCDEFGH'), false)
    assert.equal(isValidAffiliateCode('AFF_ABC'), false)
    assert.equal(isValidAffiliateCode('AFF_abcdefgh'), false)
    assert.equal(isValidAffiliateCode(null), false)
    assert.equal(isValidAffiliateCode(undefined), false)
    assert.equal(isValidAffiliateCode(12345), false)
  })
})
