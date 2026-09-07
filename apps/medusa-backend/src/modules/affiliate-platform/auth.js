'use strict'

/**
 * Affiliate portal auth — password hashing (scrypt + per-password random salt, matching
 * routes/seller-auth.js's hashSellerPassword/verifySellerPassword, not app-platform's weaker
 * static-salt SHA-256; affiliates get real EUR payouts so the stronger pattern applies) and a
 * hand-rolled HMAC JWT (matching modules/app-platform/service.js's signDeveloperToken —
 * no jsonwebtoken dependency needed for this repo's simple bearer-token use case).
 */

const crypto = require('crypto')

const JWT_SECRET = (() => {
  const s = process.env.AFFILIATE_JWT_SECRET || ''
  if (!s && process.env.NODE_ENV === 'production') {
    console.error('[SECURITY] AFFILIATE_JWT_SECRET env var is not set!')
  }
  return s || 'dev-only-affiliate-secret-change-in-prod'
})()

const TOKEN_TTL_SECONDS = 7 * 24 * 3600 // 7 days

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':')
    if (!salt || !hash) return false
    const candidate = crypto.scryptSync(password, salt, 64).toString('hex')
    const a = Buffer.from(candidate)
    const b = Buffer.from(hash)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  } catch {
    return false
  }
}

function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') return 'Password is required.'
  if (password.length < 8) return 'Password must be at least 8 characters.'
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain at least one letter.'
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.'
  return null
}

function signAffiliateToken(payload) {
  const h = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
  const b = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  })).toString('base64url')
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url')
  return `${h}.${b}.${sig}`
}

function verifyAffiliateToken(token) {
  if (!token) return null
  try {
    const [h, b, sig] = String(token).split('.')
    if (!h || !b || !sig) return null
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${b}`).digest('base64url')
    const a = Buffer.from(sig)
    const e = Buffer.from(expected)
    if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) return null
    const payload = JSON.parse(Buffer.from(b, 'base64url').toString())
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null
    return payload
  } catch {
    return null
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  validatePasswordStrength,
  signAffiliateToken,
  verifyAffiliateToken,
}
