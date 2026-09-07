'use strict'
const { Router } = require('express')
const { z } = require('zod')

// ── Zod schemas ───────────────────────────────────────────────────────────────
const zEmail    = z.string().email('Invalid email address').max(254)
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

// ── Crypto helpers ────────────────────────────────────────────────────────────
// Gate on "are we pointed at the real production DB", not NODE_ENV — NODE_ENV can be
// unset/misconfigured on the actual deployment while DATABASE_URL still points at the real
// Render Postgres instance, in which case the old NODE_ENV-only check silently let every seller
// (and everyone else, since the fallback string is public source code) sign a valid token for
// ANY seller_id, reading/acting as any other seller. That's the real severity behind "sellers
// can see other sellers' notifications" — this isn't scoped to notifications, it's full
// impersonation. render.com in DATABASE_URL mirrors the same signal this codebase already uses
// everywhere else to detect "this is the real deployment" (see the repeated
// `dbUrl.includes('render.com')` SSL checks throughout src/routes/*.js).
const _SELLER_JWT_SECRET = (() => {
  const s = process.env.SELLER_JWT_SECRET || process.env.JWT_SECRET || ''
  const isRealDeployment = process.env.NODE_ENV === 'production' || /render\.com/i.test(process.env.DATABASE_URL || '')
  if (!s && isRealDeployment) {
    console.error('[SECURITY] SELLER_JWT_SECRET env var is not set — refusing to start with a guessable fallback secret against a real database.')
    process.exit(1)
  }
  return s || 'dev-only-seller-secret-do-not-use-in-prod'
})()

const SELLER_TOKEN_TTL_SECONDS = 7 * 24 * 3600

const INITIAL_SUPERUSER_EMAILS = (process.env.SUPERUSER_EMAILS || 'murathan.cotuk@gmail.com')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)

// ── Sessions (devices) ───────────────────────────────────────────────────────
// Login-issued tokens are plain stateless JWTs (see verifySellerToken) — there was no way to
// list "which device is logged in" or force one of them out, since nothing server-side tracked
// them. Each login now also writes a row here and embeds its id as `sid` in the token; requests
// carrying a `sid` get checked against this table (revoked/missing → 401), so revoking a device
// actually ends that session instead of just hiding it in a UI. Tokens issued before this change
// have no `sid` and keep working un-tracked until they naturally expire (7 days) — no forced logout.
async function ensureSellerSessionsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS seller_sessions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      seller_id text,
      user_agent text,
      ip_address text,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz NOT NULL DEFAULT now(),
      revoked_at timestamptz
    )
  `)
  await client.query(`CREATE INDEX IF NOT EXISTS idx_seller_sessions_user ON seller_sessions (user_id, revoked_at)`)
}

function clientIpFromRequest(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim()
  return req.socket?.remoteAddress || req.ip || ''
}

async function createSellerSession(client, { userId, sellerId, req }) {
  await ensureSellerSessionsTable(client)
  const r = await client.query(
    `INSERT INTO seller_sessions (user_id, seller_id, user_agent, ip_address) VALUES ($1, $2, $3, $4) RETURNING id`,
    [userId, sellerId || null, String(req.headers['user-agent'] || '').slice(0, 500), clientIpFromRequest(req)],
  )
  return r.rows[0]?.id || null
}

function signSellerToken(payload) {
  const _c = require('crypto')
  const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + SELLER_TOKEN_TTL_SECONDS })).toString('base64url')
  const sig = _c.createHmac('sha256', _SELLER_JWT_SECRET).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

function verifySellerToken(token) {
  if (!token) return null
  try {
    const _c = require('crypto')
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const [header, body, sig] = parts
    const expected = _c.createHmac('sha256', _SELLER_JWT_SECRET).update(`${header}.${body}`).digest('base64url')
    if (sig !== expected) return null
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null
    return payload
  } catch { return null }
}

function hashSellerPassword(password) {
  const _c = require('crypto')
  const salt = _c.randomBytes(16).toString('hex')
  const hash = _c.scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

function verifySellerPassword(password, stored) {
  try {
    const _c = require('crypto')
    const [salt, hash] = stored.split(':')
    if (!salt || !hash) return false
    return _c.scryptSync(password, salt, 64).toString('hex') === hash
  } catch { return false }
}

function validatePasswordStrength(password) {
  if (!password || typeof password !== 'string') return 'Password is required.'
  if (password.length < 8) return 'Password must be at least 8 characters.'
  if (!/[a-zA-Z]/.test(password)) return 'Password must contain at least one letter.'
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.'
  return null
}

// AES-256-GCM TOTP encryption (reads TOTP_ENCRYPTION_KEY from process.env at call time)
function _getTotpKeyBuf() {
  const key = process.env.TOTP_ENCRYPTION_KEY || ''
  if (!key || key.length !== 64) return null
  return Buffer.from(key, 'hex')
}

function encryptTotp(plaintext) {
  const crypto = require('crypto')
  const keyBuf = _getTotpKeyBuf()
  if (!keyBuf) throw new Error('TOTP_ENCRYPTION_KEY not configured')
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv)
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`
}

function decryptTotp(stored) {
  if (!stored || !stored.startsWith('enc:')) return stored
  const crypto = require('crypto')
  const keyBuf = _getTotpKeyBuf()
  if (!keyBuf) return null
  const parts = stored.split(':')
  if (parts.length !== 4) return stored
  const [, ivHex, tagHex, ctHex] = parts
  try {
    const iv = Buffer.from(ivHex, 'hex')
    const tag = Buffer.from(tagHex, 'hex')
    const ct = Buffer.from(ctHex, 'hex')
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
  } catch (e) {
    console.error('TOTP decrypt failed:', e.message)
    return null
  }
}

// ── DB ────────────────────────────────────────────────────────────────────────
function getSellerDbClient() {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return null
  const { Client } = require('pg')
  return new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
}

// ── Middleware (exported so server.js can mount at /admin-hub before routes) ──

async function requireSellerAuth(req, res, next) {
  const auth = req.headers['authorization'] || ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  const payload = verifySellerToken(token)
  if (!payload) return res.status(401).json({ message: 'Unauthorized' })
  // No `sid` = token issued before session tracking existed — let it through untracked
  // rather than force-logging-out everyone already signed in when this shipped.
  if (payload.sid) {
    const { getPooledClient } = require('../db-pool')
    const client = getPooledClient()
    if (client) {
      try {
        await client.connect()
        const r = await client.query(
          `UPDATE seller_sessions SET last_seen_at = now() WHERE id = $1::uuid AND revoked_at IS NULL RETURNING id`,
          [payload.sid],
        )
        await client.end()
        if (!r.rows.length) return res.status(401).json({ message: 'Session revoked' })
      } catch (e) {
        try { await client.end() } catch (_) {}
        // DB hiccup shouldn't lock everyone out — fail open on infra errors, not on a
        // confirmed revocation (that path returns 401 above, before this catch).
        console.error('[requireSellerAuth] session check failed:', e?.message || e)
      }
    }
  }
  req.sellerUser = payload
  req.sellerSessionId = payload.sid || null
  next()
}

function requireSuperuser(req, res, next) {
  if (!req.sellerUser?.is_superuser) return res.status(403).json({ message: 'Superuser access required' })
  next()
}

// ── Notifications ─────────────────────────────────────────────────────────────
async function notifySuperusersNewSeller({ email, store_name, seller_id, first_name, last_name, seller_user_id }) {
  // Recipients: explicit SUPERUSER_EMAILS env var, else the same default superuser
  // list used to decide is_superuser at registration time (INITIAL_SUPERUSER_EMAILS).
  // Previously this fell back to an empty list and silently no-op'd when
  // SUPERUSER_EMAILS wasn't set, even though a superuser account clearly existed.
  const superuserEmails = (process.env.SUPERUSER_EMAILS || '').split(',').map((e) => e.trim()).filter(Boolean)
  const recipients = superuserEmails.length ? superuserEmails : INITIAL_SUPERUSER_EMAILS
  const sellerCentralUrl = process.env.SELLER_CENTRAL_URL || 'https://andertal-sellercentral.vercel.app'
  const displayName = [first_name, last_name].filter(Boolean).join(' ') || email
  const { insertAdminHubNotificationSafe } = require('../admin-hub-notify')
  await insertAdminHubNotificationSafe({
    type: 'seller_registered',
    title: `Neuer Seller registriert: ${store_name || email}`,
    body: `${displayName} (${email}) hat sich registriert. Bitte prüfen und freischalten.`,
    sellerId: seller_id || null,
    referenceId: seller_user_id || null,
  })
  if (!recipients.length) return
  const subject = `Neuer Seller registriert: ${store_name || email}`
  const html = `
<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#1f2937">
  <div style="font-size:22px;font-weight:900;letter-spacing:0.14em;color:#111;margin-bottom:24px">ANDERTAL</div>
  <h2 style="font-size:17px;font-weight:700;margin:0 0 16px">Neuer Seller registriert</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px;margin-bottom:24px">
    <tr><td style="padding:7px 0;color:#6b7280;width:120px">Name</td><td style="padding:7px 0;font-weight:500">${displayName}</td></tr>
    <tr><td style="padding:7px 0;color:#6b7280">E-Mail</td><td style="padding:7px 0">${email}</td></tr>
    <tr><td style="padding:7px 0;color:#6b7280">Shop-Name</td><td style="padding:7px 0">${store_name || '—'}</td></tr>
    <tr><td style="padding:7px 0;color:#6b7280">Seller ID</td><td style="padding:7px 0;font-family:monospace;font-size:12px">${seller_id}</td></tr>
    <tr><td style="padding:7px 0;color:#6b7280">Registriert</td><td style="padding:7px 0">${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}</td></tr>
  </table>
  <a href="${sellerCentralUrl}/de/settings/users-permissions"
     style="display:inline-block;padding:11px 22px;background:#ff971c;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">
    Seller freischalten →
  </a>
  <p style="margin-top:24px;font-size:12px;color:#9ca3af">Diese E-Mail wurde automatisch generiert.</p>
</div>`
  // Route through the shared email service (Resend, then generic SMTP_*, then a
  // logged dev fallback) instead of a bespoke nodemailer transport gated on
  // SMTP_HOST — this project mostly sends outbound mail via RESEND_API_KEY, which
  // the old raw-env-var check ignored, so this notification silently never sent.
  const { sendEmail } = require('../email')
  await sendEmail({
    to: recipients,
    subject,
    html,
    text: `Neuer Seller registriert\n\nName: ${displayName}\nE-Mail: ${email}\nShop: ${store_name || '—'}\nSeller ID: ${seller_id}\n\nFreischalten: ${sellerCentralUrl}/de/settings/users-permissions`,
  })
}

// ── Route handlers ────────────────────────────────────────────────────────────

const SellerRegisterSchema = z.object({
  email:        zEmail,
  password:     zPassword,
  store_name:   z.string().max(120).optional(),
  storeName:    z.string().max(120).optional(),
  invite_token: z.string().max(200).optional(),
  first_name:   z.string().max(60).optional(),
  last_name:    z.string().max(60).optional(),
  agreement_accepted: z.boolean().optional(),
  agreement_version:  z.string().optional(),
})
// docs/affiliate.md PR 6 — sellercentral's middleware.js (PR 2) drops a short-lived
// `andertal_referred_by` cookie when ?ref= is present on /register. cookie-parser isn't mounted
// until later in server.js (after this router), so this route can't rely on req.cookies — read
// the raw Cookie header directly instead of moving global middleware order.
function readCookieValue(req, name) {
  const header = req.headers?.cookie
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return null
}

/** Format-checks + looks up the referring affiliate by code — never blocks registration if absent/invalid. */
async function resolveReferringAffiliateId(req, client) {
  const code = readCookieValue(req, 'andertal_referred_by')
  if (!code || !/^AFF_[0-9A-Z]{8}$/.test(code)) return null
  try {
    const r = await client.query(`SELECT id FROM affiliates WHERE code = $1 AND status = 'active'`, [code])
    return r.rows[0]?.id || null
  } catch {
    return null
  }
}

const sellerAuthRegisterPOST = async (req, res) => {
  const parsed = validate(SellerRegisterSchema, req.body || {}, res)
  if (!parsed) return
  const body = parsed
  const email = body.email.trim().toLowerCase()
  const password = body.password
  const store_name = (body.store_name || body.storeName || '').trim()
  const invite_token = (body.invite_token || '').trim()
  const first_name = (body.first_name || '').trim()
  const last_name = (body.last_name || '').trim()
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    const existing = await client.query('SELECT id FROM seller_users WHERE email = $1', [email])
    if (existing.rows.length > 0) {
      await client.end()
      return res.status(409).json({ message: 'An account with this email already exists' })
    }
    let invite = null
    if (invite_token) {
      const invRes = await client.query(
        `SELECT * FROM seller_invitations WHERE token = $1 AND accepted_at IS NULL AND expires_at > now()`,
        [invite_token]
      )
      if (invRes.rows.length > 0) invite = invRes.rows[0]
    }
    if (!invite) {
      const invByEmail = await client.query(
        `SELECT * FROM seller_invitations WHERE LOWER(email) = $1 AND accepted_at IS NULL AND expires_at > now() ORDER BY created_at DESC LIMIT 1`,
        [email]
      )
      if (invByEmail.rows.length > 0) invite = invByEmail.rows[0]
    }
    if (store_name && !invite) {
      const storeCheck = await client.query(`SELECT id FROM seller_users WHERE LOWER(store_name) = LOWER($1)`, [store_name])
      if (storeCheck.rows.length > 0) {
        await client.end()
        return res.status(409).json({ message: 'Dieser Store-Name ist bereits vergeben. Bitte wählen Sie einen anderen Namen.' })
      }
      const settingsCheck = await client.query(`SELECT seller_id FROM admin_hub_seller_settings WHERE LOWER(store_name) = LOWER($1) LIMIT 1`, [store_name]).catch(() => ({ rows: [] }))
      if (settingsCheck.rows.length > 0) {
        await client.end()
        return res.status(409).json({ message: 'Dieser Store-Name ist bereits vergeben. Bitte wählen Sie einen anderen Namen.' })
      }
    }
    const is_superuser = INITIAL_SUPERUSER_EMAILS.includes(email)
    const password_hash = hashSellerPassword(password)
    const own_seller_id = `seller_${require('crypto').randomBytes(8).toString('hex')}`
    const sub_of_seller_id = invite ? invite.invited_by_seller_id : null
    const effective_permissions = invite?.permissions || null
    const display_first = first_name || invite?.first_name || null
    const display_last = last_name || invite?.last_name || null
    const effective_store_name = sub_of_seller_id ? null : (store_name || null)
    const agreement_accepted = !!body.agreement_accepted
    const agreement_accepted_at = agreement_accepted ? new Date().toISOString() : null
    const agreement_version = body.agreement_version || '1.0'
    const agreement_ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || null
    // docs/affiliate.md PR 6 — Model 1. Only stamps WHO referred this account; the actual
    // commission-generating seller_referrals row (with its UNIQUE seller_id lock-in) is created
    // separately at superuser approval time, not here — see the seller approval handler below.
    const referred_by_affiliate_id = await resolveReferringAffiliateId(req, client)
    const r = await client.query(
      `INSERT INTO seller_users (email, password_hash, store_name, seller_id, is_superuser, sub_of_seller_id, permissions, first_name, last_name, agreement_accepted, agreement_accepted_at, agreement_version, agreement_ip, referred_by_affiliate_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id, email, store_name, seller_id, is_superuser, sub_of_seller_id, permissions, first_name, last_name, created_at`,
      [email, password_hash, effective_store_name, own_seller_id, is_superuser, sub_of_seller_id, effective_permissions ? JSON.stringify(effective_permissions) : null, display_first, display_last, agreement_accepted, agreement_accepted_at, agreement_version, agreement_ip, referred_by_affiliate_id]
    )
    if (effective_store_name && !sub_of_seller_id) {
      await client.query(
        `INSERT INTO admin_hub_seller_settings (seller_id, store_name, updated_at) VALUES ($1, $2, now()) ON CONFLICT (seller_id) DO UPDATE SET store_name = $2, updated_at = now()`,
        [own_seller_id, effective_store_name]
      ).catch(() => {})
    }
    if (invite) {
      await client.query(`UPDATE seller_invitations SET accepted_at = now() WHERE id = $1`, [invite.id]).catch(() => {})
    }
    const user = r.rows[0]
    const effectiveSellerId = user.sub_of_seller_id || user.seller_id
    let displayStoreName = user.store_name || ''
    if (user.sub_of_seller_id) {
      const parentRow = await client.query(`SELECT store_name FROM seller_users WHERE seller_id = $1 LIMIT 1`, [user.sub_of_seller_id]).catch(() => ({ rows: [] }))
      displayStoreName = parentRow.rows[0]?.store_name || ''
    }
    const sessionId = await createSellerSession(client, { userId: user.id, sellerId: effectiveSellerId, req }).catch((e) => {
      console.error('createSellerSession (register) failed:', e?.message || e)
      return null
    })
    await client.end()
    const token = signSellerToken({ id: user.id, email: user.email, seller_id: effectiveSellerId, is_superuser: user.is_superuser, store_name: displayStoreName, sid: sessionId || undefined })
    res.json({ token, user: { id: user.id, email: user.email, seller_id: effectiveSellerId, is_superuser: user.is_superuser, store_name: displayStoreName } })
    if (!is_superuser && !sub_of_seller_id) {
      notifySuperusersNewSeller({ email: user.email, store_name: displayStoreName, seller_id: effectiveSellerId, first_name: user.first_name, last_name: user.last_name, seller_user_id: user.id }).catch((e) => console.error('notifySuperusersNewSeller:', e.message))
      setImmediate(() => {
        try { require('../flow-automation').runAutomationFlowsForSellerEvent({ triggerKey: 'seller_signup', sellerUserId: user.id }).catch(() => {}) } catch (_) {}
      })
    }
  } catch (err) {
    try { await client.end() } catch (_) {}
    console.error('sellerAuthRegisterPOST:', err)
    res.status(500).json({ message: err?.message || 'Registration failed' })
  }
}

const SellerLoginSchema = z.object({
  email:     zEmail,
  password:  z.string().min(1, 'Password is required').max(256),
  totp_code: z.string().max(8).optional(),
})
const sellerAuthLoginPOST = async (req, res) => {
  const parsed = validate(SellerLoginSchema, req.body || {}, res)
  if (!parsed) return
  const body = parsed
  const email = body.email.trim().toLowerCase()
  const password = body.password
  const totpCode = (body.totp_code || '').trim().replace(/\s/g, '')
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    const r = await client.query('SELECT id, email, password_hash, store_name, seller_id, sub_of_seller_id, is_superuser, permissions, totp_secret, totp_enabled FROM seller_users WHERE email = $1', [email])
    const user = r.rows[0]
    if (!user) { await client.end(); return res.status(401).json({ message: 'Invalid email or password' }) }
    const shouldBeSuperuser = user.is_superuser || INITIAL_SUPERUSER_EMAILS.includes(email)
    if (!verifySellerPassword(password, user.password_hash)) { await client.end(); return res.status(401).json({ message: 'Invalid email or password' }) }
    if (user.totp_enabled && user.totp_secret) {
      if (!totpCode) {
        await client.end()
        return res.status(200).json({ totp_required: true, message: 'Two-factor authentication code required.' })
      }
      const speakeasy = require('speakeasy')
      const totpPlain = decryptTotp(user.totp_secret)
      if (!totpPlain) { await client.end(); return res.status(500).json({ message: 'Internal error during 2FA verification.' }) }
      const valid = speakeasy.totp.verify({ secret: totpPlain, encoding: 'base32', token: totpCode, window: 1 })
      if (!valid) { await client.end(); return res.status(401).json({ message: 'Invalid two-factor authentication code.' }) }
    }
    if (shouldBeSuperuser && !user.is_superuser) {
      await client.query('UPDATE seller_users SET is_superuser = true WHERE id = $1', [user.id]).catch(() => {})
      user.is_superuser = true
    }
    const effectiveSellerId = user.sub_of_seller_id || user.seller_id
    let displayStoreName = (user.store_name || '').trim()
    if (user.sub_of_seller_id) {
      const pr = await client.query(
        `SELECT COALESCE(NULLIF(TRIM(ss.store_name), ''), NULLIF(TRIM(su.store_name), '')) AS sn FROM seller_users su LEFT JOIN admin_hub_seller_settings ss ON ss.seller_id = su.seller_id WHERE su.seller_id = $1 LIMIT 1`,
        [user.sub_of_seller_id]
      )
      displayStoreName = (pr.rows[0]?.sn || '').trim()
    }
    if (!displayStoreName && effectiveSellerId) {
      const ss = await client.query('SELECT store_name FROM admin_hub_seller_settings WHERE seller_id = $1', [effectiveSellerId])
      displayStoreName = (ss.rows[0]?.store_name || '').trim()
    }
    let preferredLocale = 'de'
    if (effectiveSellerId) {
      try {
        const lr = await client.query('SELECT locale FROM admin_hub_seller_settings WHERE seller_id = $1 LIMIT 1', [effectiveSellerId])
        const loc = String(lr.rows[0]?.locale || '').trim().toLowerCase()
        if (['en', 'de', 'tr', 'fr', 'it', 'es'].includes(loc)) preferredLocale = loc
      } catch (_) {}
    }
    const sessionId = await createSellerSession(client, { userId: user.id, sellerId: effectiveSellerId, req }).catch((e) => {
      console.error('createSellerSession (login) failed:', e?.message || e)
      return null
    })
    await client.end()
    const token = signSellerToken({ id: user.id, email: user.email, seller_id: effectiveSellerId, is_superuser: shouldBeSuperuser, store_name: displayStoreName, sid: sessionId || undefined })
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        seller_id: effectiveSellerId,
        is_superuser: shouldBeSuperuser,
        store_name: displayStoreName,
        permissions: user.permissions || null,
        locale: preferredLocale,
      },
    })
  } catch (err) {
    try { await client.end() } catch (_) {}
    console.error('sellerAuthLoginPOST:', err)
    res.status(500).json({ message: err?.message || 'Login failed' })
  }
}

const sellerAuthMeGET = async (req, res) => {
  const user = req.sellerUser
  if (!user) return res.status(401).json({ message: 'Unauthorized' })
  res.json({ user })
}

const sellerAuth2faSetupPOST = async (req, res) => {
  const sellerUser = req.sellerUser
  if (!sellerUser) return res.status(401).json({ message: 'Unauthorized' })
  try {
    const speakeasy = require('speakeasy')
    const QRCode = require('qrcode')
    const secret = speakeasy.generateSecret({ name: `Andertal Sellercentral (${sellerUser.email})`, issuer: 'Andertal', length: 32 })
    const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
    const { Client } = require('pg')
    const lc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await lc.connect()
    await lc.query(`UPDATE seller_users SET totp_secret = $1, totp_enabled = false WHERE id = $2`, [encryptTotp(secret.base32), sellerUser.id])
    await lc.end()
    const qrDataUrl = await QRCode.toDataURL(secret.otpauth_url)
    res.json({ qr_code: qrDataUrl, ...(process.env.NODE_ENV !== 'production' && { secret: secret.base32 }) })
  } catch (err) {
    console.error('2fa setup:', err)
    res.status(500).json({ message: err?.message || '2FA setup failed' })
  }
}

const sellerAuth2faVerifyPOST = async (req, res) => {
  const sellerUser = req.sellerUser
  if (!sellerUser) return res.status(401).json({ message: 'Unauthorized' })
  const code = String(req.body?.code || '').trim().replace(/\s/g, '')
  if (!code) return res.status(400).json({ message: 'Code is required' })
  try {
    const speakeasy = require('speakeasy')
    const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
    const { Client } = require('pg')
    const lc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await lc.connect()
    const ur = await lc.query('SELECT totp_secret, totp_enabled FROM seller_users WHERE id = $1', [sellerUser.id])
    const row = ur.rows[0]
    if (!row || !row.totp_secret) { await lc.end(); return res.status(400).json({ message: 'No pending 2FA setup. Run setup first.' }) }
    const totpPlain = decryptTotp(row.totp_secret)
    if (!totpPlain) { await lc.end(); return res.status(500).json({ message: 'Internal error during 2FA verification.' }) }
    const valid = speakeasy.totp.verify({ secret: totpPlain, encoding: 'base32', token: code, window: 1 })
    if (!valid) { await lc.end(); return res.status(400).json({ message: 'Invalid code. Check your authenticator app.' }) }
    await lc.query('UPDATE seller_users SET totp_enabled = true WHERE id = $1', [sellerUser.id])
    await lc.end()
    res.json({ ok: true, message: '2FA enabled successfully.' })
  } catch (err) {
    console.error('2fa verify:', err)
    res.status(500).json({ message: err?.message || '2FA verify failed' })
  }
}

const sellerAuth2faDisablePOST = async (req, res) => {
  const sellerUser = req.sellerUser
  if (!sellerUser) return res.status(401).json({ message: 'Unauthorized' })
  const code = String(req.body?.code || '').trim().replace(/\s/g, '')
  const password = String(req.body?.password || '')
  if (!code && !password) return res.status(400).json({ message: 'Provide current TOTP code or password to disable 2FA.' })
  try {
    const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
    const { Client } = require('pg')
    const lc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await lc.connect()
    const ur = await lc.query('SELECT totp_secret, totp_enabled, password_hash FROM seller_users WHERE id = $1', [sellerUser.id])
    const row = ur.rows[0]
    if (!row) { await lc.end(); return res.status(404).json({ message: 'User not found' }) }
    if (!row.totp_enabled) { await lc.end(); return res.status(400).json({ message: '2FA is not enabled.' }) }
    let authorized = false
    if (code && row.totp_secret) {
      const speakeasy = require('speakeasy')
      const totpPlain = decryptTotp(row.totp_secret)
      if (totpPlain) authorized = speakeasy.totp.verify({ secret: totpPlain, encoding: 'base32', token: code, window: 1 })
    }
    if (!authorized && password) authorized = verifySellerPassword(password, row.password_hash)
    if (!authorized) { await lc.end(); return res.status(401).json({ message: 'Invalid code or password.' }) }
    await lc.query('UPDATE seller_users SET totp_secret = NULL, totp_enabled = false WHERE id = $1', [sellerUser.id])
    await lc.end()
    res.json({ ok: true, message: '2FA disabled.' })
  } catch (err) {
    console.error('2fa disable:', err)
    res.status(500).json({ message: err?.message || '2FA disable failed' })
  }
}

const sellerAuth2faStatusGET = async (req, res) => {
  const sellerUser = req.sellerUser
  if (!sellerUser) return res.status(401).json({ message: 'Unauthorized' })
  try {
    const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
    const { Client } = require('pg')
    const lc = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await lc.connect()
    const ur = await lc.query('SELECT totp_enabled FROM seller_users WHERE id = $1', [sellerUser.id])
    await lc.end()
    res.json({ totp_enabled: ur.rows[0]?.totp_enabled || false })
  } catch (err) {
    res.status(500).json({ message: err?.message })
  }
}

const sellerUsersGET = async (req, res) => {
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    const r = await client.query(
      `SELECT id, email, store_name, seller_id, is_superuser, created_at,
              approval_status, company_name, authorized_person_name, tax_id, vat_id,
              business_address, phone, iban, documents, rejection_reason, approved_at, permissions
       FROM seller_users ORDER BY created_at DESC`
    )
    await client.end()
    res.json({ users: r.rows })
  } catch (err) {
    try { await client.end() } catch (_) {}
    res.status(500).json({ message: err?.message })
  }
}

const sellerUserSuperuserPATCH = async (req, res) => {
  const { id } = req.params
  const { is_superuser } = req.body || {}
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    const r = await client.query('UPDATE seller_users SET is_superuser = $1, updated_at = now() WHERE id = $2 RETURNING id, email, is_superuser', [!!is_superuser, id])
    await client.end()
    if (!r.rows.length) return res.status(404).json({ message: 'User not found' })
    res.json({ user: r.rows[0] })
  } catch (err) {
    try { await client.end() } catch (_) {}
    res.status(500).json({ message: err?.message })
  }
}

const sellerUserCreatePOST = async (req, res) => {
  const body = req.body || {}
  const email = (body.email || '').trim().toLowerCase()
  const password = (body.password || '').toString()
  const store_name = (body.store_name || '').trim()
  const is_superuser = !!body.is_superuser
  const permissions = body.permissions || null
  if (!email || !password) return res.status(400).json({ message: 'Email and password required' })
  const pwErr = validatePasswordStrength(password)
  if (pwErr) return res.status(400).json({ message: pwErr })
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    const existing = await client.query('SELECT id FROM seller_users WHERE email = $1', [email])
    if (existing.rows.length) { await client.end(); return res.status(409).json({ message: 'An account with this email already exists' }) }
    const password_hash = hashSellerPassword(password)
    const seller_id = `seller_${require('crypto').randomBytes(8).toString('hex')}`
    const r = await client.query(
      `INSERT INTO seller_users (email, password_hash, store_name, seller_id, is_superuser, permissions) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, store_name, seller_id, is_superuser, permissions, created_at`,
      [email, password_hash, store_name || null, seller_id, is_superuser, permissions ? JSON.stringify(permissions) : null]
    )
    if (store_name) {
      await client.query(
        `INSERT INTO admin_hub_seller_settings (seller_id, store_name, updated_at) VALUES ($1, $2, now()) ON CONFLICT (seller_id) DO UPDATE SET store_name = $2, updated_at = now()`,
        [seller_id, store_name]
      ).catch(() => {})
    }
    await client.end()
    res.json({ user: r.rows[0] })
  } catch (err) {
    try { await client.end() } catch (_) {}
    res.status(500).json({ message: err?.message || 'Create failed' })
  }
}

const sellerUserUpdatePATCH = async (req, res) => {
  const { id } = req.params
  const body = req.body || {}
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    const sets = ['updated_at = now()']
    const params = []
    if (body.store_name !== undefined) { params.push(body.store_name || null); sets.push(`store_name = $${params.length}`) }
    if (body.is_superuser !== undefined) { params.push(!!body.is_superuser); sets.push(`is_superuser = $${params.length}`) }
    if (body.permissions !== undefined) { params.push(body.permissions ? JSON.stringify(body.permissions) : null); sets.push(`permissions = $${params.length}`) }
    if (body.password) {
      const pwErr = validatePasswordStrength(body.password)
      if (pwErr) return res.status(400).json({ message: pwErr })
      params.push(hashSellerPassword(body.password)); sets.push(`password_hash = $${params.length}`)
    }
    params.push(id)
    const r = await client.query(
      `UPDATE seller_users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, email, store_name, seller_id, is_superuser, permissions, created_at`,
      params
    )
    await client.end()
    if (!r.rows.length) return res.status(404).json({ message: 'User not found' })
    const u = r.rows[0]
    if (body.store_name !== undefined && u.seller_id) {
      const c2 = getSellerDbClient()
      try {
        await c2.connect()
        await c2.query(`INSERT INTO admin_hub_seller_settings (seller_id, store_name, updated_at) VALUES ($1, $2, now()) ON CONFLICT (seller_id) DO UPDATE SET store_name = $2, updated_at = now()`, [u.seller_id, body.store_name || ''])
        await c2.end()
      } catch (_) {}
    }
    res.json({ user: u })
  } catch (err) {
    try { await client.end() } catch (_) {}
    res.status(500).json({ message: err?.message })
  }
}

const sellerUserDeleteDELETE = async (req, res) => {
  const { id } = req.params
  const myId = req.sellerUser?.id
  if (id === myId) return res.status(400).json({ message: 'Cannot delete yourself' })
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    await client.query('DELETE FROM seller_users WHERE id = $1', [id])
    await client.end()
    res.json({ success: true })
  } catch (err) {
    try { await client.end() } catch (_) {}
    res.status(500).json({ message: err?.message })
  }
}

// ── Sessions (devices) API — list / revoke this login account's own sessions ──
// Scoped to req.sellerUser.id (the individual login identity), not seller_id — a sub-user
// should manage their own devices, not force-logout every other user on the same seller account.
function summarizeUserAgentServer(ua) {
  const u = String(ua || '').toLowerCase()
  let os = 'Unknown'
  if (u.includes('windows')) os = 'Windows'
  else if (u.includes('mac os') || u.includes('macintosh')) os = 'macOS'
  else if (u.includes('android')) os = 'Android'
  else if (u.includes('iphone') || u.includes('ipad')) os = 'iOS'
  else if (u.includes('linux')) os = 'Linux'
  let browser = 'Browser'
  if (u.includes('edg/')) browser = 'Edge'
  else if (u.includes('chrome') && !u.includes('chromium')) browser = 'Chrome'
  else if (u.includes('firefox')) browser = 'Firefox'
  else if (u.includes('safari') && !u.includes('chrome')) browser = 'Safari'
  return `${os} · ${browser}`
}

const sellerSessionsGET = async (req, res) => {
  const userId = req.sellerUser?.id
  if (!userId) return res.status(401).json({ message: 'Unauthorized' })
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    await ensureSellerSessionsTable(client)
    const r = await client.query(
      `SELECT id, user_agent, ip_address, created_at, last_seen_at
       FROM seller_sessions WHERE user_id = $1::uuid AND revoked_at IS NULL
       ORDER BY last_seen_at DESC`,
      [userId],
    )
    await client.end()
    const sessions = r.rows.map((row) => ({
      id: row.id,
      device_label: summarizeUserAgentServer(row.user_agent),
      ip_address: row.ip_address || null,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      is_current: row.id === req.sellerSessionId,
    }))
    res.json({
      sessions,
      current_session_id: req.sellerSessionId || null,
      // False when JWT has no `sid` (legacy token / silent create failure / old impersonation).
      // UI can tell "re-login required" apart from a truly empty device list.
      session_tracking: Boolean(req.sellerSessionId),
    })
  } catch (err) {
    try { await client.end() } catch (_) {}
    res.status(500).json({ message: err?.message || 'Error' })
  }
}

const sellerSessionRevokeDELETE = async (req, res) => {
  const userId = req.sellerUser?.id
  if (!userId) return res.status(401).json({ message: 'Unauthorized' })
  const sessionId = (req.params.id || '').trim()
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    await ensureSellerSessionsTable(client)
    // user_id match is the ownership check — a session id alone isn't enough to revoke it.
    const r = await client.query(
      `UPDATE seller_sessions SET revoked_at = now() WHERE id = $1::uuid AND user_id = $2::uuid AND revoked_at IS NULL RETURNING id`,
      [sessionId, userId],
    )
    await client.end()
    if (!r.rows.length) return res.status(404).json({ message: 'Session not found' })
    res.json({ success: true })
  } catch (err) {
    try { await client.end() } catch (_) {}
    res.status(500).json({ message: err?.message || 'Error' })
  }
}

const sellerSessionsRevokeAllDELETE = async (req, res) => {
  const userId = req.sellerUser?.id
  if (!userId) return res.status(401).json({ message: 'Unauthorized' })
  // Default: keep the caller's own current session alive (matches "log out other devices").
  // ?include_current=1 ends every session, including this one.
  const includeCurrent = String(req.query.include_current || '') === '1'
  const client = getSellerDbClient()
  if (!client) return res.status(503).json({ message: 'Database not configured' })
  try {
    await client.connect()
    await ensureSellerSessionsTable(client)
    const params = [userId]
    let extra = ''
    if (!includeCurrent && req.sellerSessionId) {
      params.push(req.sellerSessionId)
      extra = ' AND id != $2::uuid'
    }
    const r = await client.query(
      `UPDATE seller_sessions SET revoked_at = now() WHERE user_id = $1::uuid AND revoked_at IS NULL${extra} RETURNING id`,
      params,
    )
    await client.end()
    res.json({ success: true, revoked_count: r.rows.length })
  } catch (err) {
    try { await client.end() } catch (_) {}
    res.status(500).json({ message: err?.message || 'Error' })
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

module.exports = function createSellerAuthRouter() {
  const router = Router()

  router.post('/admin-hub/auth/register', sellerAuthRegisterPOST)
  router.post('/admin-hub/auth/login', sellerAuthLoginPOST)
  router.get('/admin-hub/auth/me', sellerAuthMeGET)
  router.get('/admin-hub/auth/2fa/status', sellerAuth2faStatusGET)
  router.post('/admin-hub/auth/2fa/setup', sellerAuth2faSetupPOST)
  router.post('/admin-hub/auth/2fa/verify', sellerAuth2faVerifyPOST)
  router.post('/admin-hub/auth/2fa/disable', sellerAuth2faDisablePOST)
  router.get('/admin-hub/users', requireSuperuser, sellerUsersGET)
  router.post('/admin-hub/users', requireSuperuser, sellerUserCreatePOST)
  router.patch('/admin-hub/users/:id', requireSuperuser, sellerUserUpdatePATCH)
  router.delete('/admin-hub/users/:id', requireSuperuser, sellerUserDeleteDELETE)
  router.patch('/admin-hub/users/:id/superuser', requireSuperuser, sellerUserSuperuserPATCH)
  router.get('/admin-hub/v1/sessions', sellerSessionsGET)
  router.delete('/admin-hub/v1/sessions/:id', sellerSessionRevokeDELETE)
  router.delete('/admin-hub/v1/sessions', sellerSessionsRevokeAllDELETE)

  return router
}

module.exports.requireSellerAuth = requireSellerAuth
module.exports.requireSuperuser = requireSuperuser
module.exports.verifySellerToken = verifySellerToken
module.exports.signSellerToken = signSellerToken
module.exports.createSellerSession = createSellerSession
module.exports.validatePasswordStrength = validatePasswordStrength
module.exports.encryptTotp = encryptTotp
module.exports.decryptTotp = decryptTotp
module.exports.hashSellerPassword = hashSellerPassword
module.exports.verifySellerPassword = verifySellerPassword
module.exports.getSellerDbClient = getSellerDbClient
