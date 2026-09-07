'use strict'

const crypto = require('crypto')
const config = require('./config')

// Crockford base32 — no 0/O/1/I/L confusion pairs, safe to read aloud or type from a screenshot.
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * `AFF_` + N random base32 chars (config.AFFILIATE_CODE_RANDOM_LENGTH). Caller is responsible for
 * retrying on a unique-constraint collision (astronomically rare at this length, but the DB is
 * the actual source of truth for uniqueness, not this function).
 * @returns {string}
 */
function generateAffiliateCode() {
  const bytes = crypto.randomBytes(config.AFFILIATE_CODE_RANDOM_LENGTH)
  let out = ''
  for (let i = 0; i < config.AFFILIATE_CODE_RANDOM_LENGTH; i++) {
    out += BASE32_ALPHABET[bytes[i] % BASE32_ALPHABET.length]
  }
  return `${config.AFFILIATE_CODE_PREFIX}${out}`
}

/** @param {string} code */
function isValidAffiliateCode(code) {
  const prefix = config.AFFILIATE_CODE_PREFIX
  if (typeof code !== 'string' || !code.startsWith(prefix)) return false
  const rest = code.slice(prefix.length)
  if (rest.length !== config.AFFILIATE_CODE_RANDOM_LENGTH) return false
  return [...rest].every((ch) => BASE32_ALPHABET.includes(ch))
}

module.exports = { generateAffiliateCode, isValidAffiliateCode }
