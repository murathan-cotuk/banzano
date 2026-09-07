/**
 * Medusa v2 Backend Server
 * dotenv + MedusaAppLoader + app.load() + listen + graceful shutdown.
 * Render: Start Command = node server.js
 * Custom API routes: src/api (Medusa v2 discovers them from here when ts-node is registered).
 */
require('dotenv').config()
try {
  require('dotenv').config({ path: '.env.local' })
} catch (e) {}

// ── Sentry init (S1.4) ──────────────────────────────────────────────────────
// Must run BEFORE other modules are required so OpenTelemetry can patch them.
// No-op if SENTRY_DSN is unset (typical for local dev) so nothing breaks.
const Sentry = require('@sentry/node')
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    sendDefaultPii: false,
    beforeSend(event, hint) {
      const error = hint?.originalException || hint?.syntheticException
      if (error && error.code === 'EPIPE') return null
      return event
    },
  })
}

// TypeScript API routes (src/api) yüklenebilsin
try {
  require('ts-node/register')
} catch (_) {}

const path = require('path')
const fs = require('fs')
const { runAutomationFlowsForOrder, runAutomationFlowsForCustomerEvent, runWinBackScan, runAbandonedCartScan, runProductWishlistWatchers, runBirthdayScan, runReviewRequestScan } = require('./src/flow-automation')
const {
  applyEuOriginMetadataPolicy,
  registerEuOriginRoutes,
  ensureEuOriginPendingTable,
} = require('./src/eu-origin')
const {
  decodeMultipartFilename,
  resolveUploadDisplayFilename,
  storageFilenameWithPrefix,
} = require('./src/media-filename')
const { enqueueFlowEvent, startFlowQueueWorker, getFlowQueueStatus } = require('./src/flow-queue')
const { pingForHealth } = require('./src/redis')
const { resolveSmtpSenderIdentity } = require('./src/smtp-sender-resolve')
const { renderInvoicePdfDocument, renderLieferscheinPdfDocument, renderProvisionsfakturPdfDocument, getOrderPdfFilename } = require('./src/order-pdf-buffers')
const { renderPeriodCommissionInvoiceDocument } = require('./src/order-pdf-layout')
const { resolveOrderPaidTotalCents } = require('./src/order-money')

let backendLinkModulesPath
try {
  backendLinkModulesPath = require.resolve('@medusajs/link-modules', { paths: [__dirname] })
} catch (_) {
  const distIndex = path.resolve(__dirname, 'node_modules', '@medusajs', 'link-modules', 'dist', 'index.js')
  if (fs.existsSync(distIndex)) {
    backendLinkModulesPath = distIndex
  } else {
    const pkgDir = path.join(__dirname, 'node_modules', '@medusajs', 'link-modules')
    const pkgPath = path.join(pkgDir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
        const main = pkg.main || pkg.module || 'dist/index.js'
        const candidate = path.resolve(pkgDir, main)
        if (fs.existsSync(candidate)) backendLinkModulesPath = candidate
      } catch (__) {}
    }
  }
  if (typeof backendLinkModulesPath === 'undefined') backendLinkModulesPath = null
}

// Require hook: @medusajs/medusa/link-modules -> { discoveryPath } (framework bu path'i yükleyip resources doldurur)
const Module = require('module')
const origRequire = Module.prototype.require
const patchedRequire = function (id) {
  if (id === '@medusajs/medusa/link-modules') {
    if (backendLinkModulesPath) {
      return { discoveryPath: backendLinkModulesPath }
    }
    return origRequire.call(this, '@medusajs/link-modules')
  }
  return origRequire.apply(this, arguments)
}
patchedRequire.resolve = function (id, options) {
  if (id === '@medusajs/medusa/link-modules') {
    if (backendLinkModulesPath) return backendLinkModulesPath
    return origRequire.resolve.call(this, '@medusajs/link-modules', options)
  }
  return origRequire.resolve.apply(this, arguments)
}
Module.prototype.require = patchedRequire

// Runtime patch: tüm kopyalara da yaz (yazılabiliyorsa); hook yoksa yedek
const linkContent = "module.exports = require('@medusajs/link-modules')\n"

function collectNodeModulesRoots(startDir, maxDepth = 15) {
  const roots = new Set()
  let dir = path.resolve(startDir)
  let depth = 0
  while (dir && depth < maxDepth) {
    const nm = path.join(dir, 'node_modules')
    if (fs.existsSync(nm)) roots.add(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
    depth++
  }
  return roots
}

function findMedusaInNodeModules(nodeModulesPath, found, depth = 0) {
  if (depth > 8) return
  try {
    const names = fs.readdirSync(nodeModulesPath, { withFileTypes: true })
    const atMedusa = path.join(nodeModulesPath, '@medusajs', 'medusa')
    if (fs.existsSync(atMedusa)) found.add(atMedusa)
    for (const e of names) {
      if (e.isDirectory() && e.name === 'node_modules') {
        findMedusaInNodeModules(path.join(nodeModulesPath, e.name), found, depth + 1)
      } else if (e.isDirectory() && !e.name.startsWith('.')) {
        const sub = path.join(nodeModulesPath, e.name)
        const subNm = path.join(sub, 'node_modules')
        if (fs.existsSync(subNm)) findMedusaInNodeModules(subNm, found, depth + 1)
      }
    }
  } catch (_) {}
}

const roots = new Set([
  ...collectNodeModulesRoots(__dirname),
  ...collectNodeModulesRoots(process.cwd())
])
const repoRoot = path.resolve(__dirname, '..', '..')
if (fs.existsSync(path.join(repoRoot, 'node_modules'))) roots.add(repoRoot)

const allMedusaDirs = new Set()
for (const root of roots) {
  const nm = path.join(root, 'node_modules')
  findMedusaInNodeModules(nm, allMedusaDirs)
}

let patchApplied = false
for (const medusaDir of allMedusaDirs) {
  try {
    fs.writeFileSync(path.join(medusaDir, 'link-modules.js'), linkContent)
    const pkgPath = path.join(medusaDir, 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    if (!pkg.exports) pkg.exports = {}
    if (typeof pkg.exports === 'object' && !Array.isArray(pkg.exports)) {
      pkg.exports['./link-modules'] = './link-modules.js'
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
    }
    log.info('link-modules patch applied at:', medusaDir)
    patchApplied = true
  } catch (e) {
    console.warn('link-modules runtime patch skipped:', medusaDir, e.message)
  }
}
if (!patchApplied) {
  try {
    require.resolve('@medusajs/medusa/link-modules')
    patchApplied = true
  } catch (_) {}
}
if (!patchApplied) {
  console.error('link-modules: no @medusajs/medusa found or all patches failed. Render: Root Directory = apps/medusa-backend, Build = npm install, Start = npm run start')
  process.exit(1)
}

const { MedusaAppLoader, configLoader, pgConnectionLoader, container } = require('@medusajs/framework')
const { logger } = require('@medusajs/framework/logger')
const { asValue } = require('@medusajs/framework/awilix')
const { ContainerRegistrationKeys } = require('@medusajs/utils')
const express = require('express')
const cors = require('cors')
const rateLimit = require('express-rate-limit')

const PORT = process.env.PORT || 9000
const HOST = process.env.HOST || '0.0.0.0'

// ── Centralized logger ────────────────────────────────────────────────────────
// info  → suppressed in production (dev/debug noise)
// warn  → always shown (recoverable issues worth knowing)
// error → always shown (failures that need attention)
const _isProd = process.env.NODE_ENV === 'production'
const log = {
  info:  (...a) => { if (!_isProd) console.log(...a) },
  warn:  (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
}

// ── Zod validation helper ─────────────────────────────────────────────────────
// Usage: const parsed = validate(MySchema, req.body, res)
//        if (!parsed) return   ← res already sent with 400
const { z } = require('zod')
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

// Common field schemas reused across multiple endpoints
const zEmail    = z.string().email('Invalid email address').max(254)
const zPassword = z.string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
const zUrl      = z.string().url('Invalid URL').or(z.literal('')).optional()

// ── TOTP secret encryption (AES-256-GCM) ─────────────────────────────────────
// Env: TOTP_ENCRYPTION_KEY — exactly 64 hex chars (32 bytes).
// Production: REQUIRED. Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
if (!process.env.TOTP_ENCRYPTION_KEY) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('TOTP_ENCRYPTION_KEY is required in production. Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"')
  }
  // Development / fresh clone: allow `npm run dev` without configuring TOTP immediately.
  // Fixed weak key — only for localhost; NEVER deploy without a real rotation key.
  process.env.TOTP_ENCRYPTION_KEY = '0'.repeat(64)
  log.warn('[dev] TOTP_ENCRYPTION_KEY unset — using local-only placeholder. Add TOTP_ENCRYPTION_KEY to .env before real 2FA / shared DB.')
}
if (process.env.TOTP_ENCRYPTION_KEY.length !== 64) {
  throw new Error('TOTP_ENCRYPTION_KEY must be exactly 64 hex chars (32 bytes)')
}

// ── Production security check (startup) ───────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const missing = []
  if (!process.env.SELLER_JWT_SECRET && !process.env.JWT_SECRET) missing.push('SELLER_JWT_SECRET')
  if (!process.env.CUSTOMER_JWT_SECRET && !process.env.JWT_SECRET) missing.push('CUSTOMER_JWT_SECRET')
  if (!process.env.DATABASE_URL) missing.push('DATABASE_URL')
  if (missing.length) {
    console.error(`[SECURITY] Missing required environment variables in production: ${missing.join(', ')}`)
    console.error('[SECURITY] Server startup aborted. Set these variables in your deployment environment.')
    process.exit(1)
  }
}

// CORS: Vercel/Render'da frontend origin'leri env ile verin (virgülle ayrılmış).
// Örnek: CORS_ORIGINS=https://andertal-sellercentral.vercel.app,https://andertal-shop.vercel.app
// Production'da CORS_ORIGINS ayarlanmazsa yalnızca localhost'a izin verilir — "herkese aç" bırakılmaz.
function getAllowedOrigins() {
  const isProduction = process.env.NODE_ENV === 'production'
  const env = process.env.CORS_ORIGINS || process.env.ALLOWED_ORIGINS
  if (env) {
    return env.split(',').map((o) => o.trim()).filter(Boolean)
  }
  const store = (process.env.STORE_CORS || '').split(',').map((o) => o.trim()).filter(Boolean)
  const admin = (process.env.ADMIN_CORS || '').split(',').map((o) => o.trim()).filter(Boolean)
  const combined = [...new Set([...store, ...admin])]
  if (combined.length) return combined
  if (isProduction) {
    // Production'da hiçbir env tanımlanmamışsa: CORS'u kapat, boş liste = herkesi reddet
    console.warn('[SECURITY] CORS_ORIGINS env var is not set in production! All cross-origin requests will be blocked. Set CORS_ORIGINS to allow your frontend domains.')
    return []
  }
  return ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3002', 'http://localhost:3003']
}

async function start() {
  try {
    log.info('\n🚀 Medusa v2 backend başlatılıyor...\n')
    await configLoader(path.resolve(__dirname), 'medusa-config')
    await pgConnectionLoader()
    if (!container.hasRegistration(ContainerRegistrationKeys.LOGGER)) {
      container.register(ContainerRegistrationKeys.LOGGER, asValue(logger))
    }

    const app = express()
    const dispatchCustomerFlowEvent = async (triggerKey, payload = {}) => {
      const tk = String(triggerKey || '').trim()
      if (!tk) return
      try {
        const queued = await enqueueFlowEvent('customer-flow-event', { triggerKey: tk, ...payload })
        if (queued) return
      } catch (qe) {
        console.warn('[flow-queue] enqueue customer event failed, fallback immediate:', qe?.message || qe)
      }
      setImmediate(() => {
        runAutomationFlowsForCustomerEvent({ triggerKey: tk, ...payload }).catch((fe) => {
          console.warn(`runAutomationFlowsForCustomerEvent ${tk}:`, fe?.message || fe)
        })
      })
    }
    let logSellerError = async () => {}
    const jsonBodyLimit = process.env.JSON_BODY_LIMIT || '10mb'
    // Preserve raw Buffer on req.rawBody for Stripe webhook signature verification.
    // express.json() still parses normally; webhook handler reads req.rawBody instead of req.body.
    app.use(express.json({
      limit: jsonBodyLimit,
      verify: (req, _res, buf) => { req.rawBody = buf },
    }))
    app.use(express.urlencoded({ extended: true, limit: jsonBodyLimit }))
    const allowedOrigins = getAllowedOrigins()
    log.info('CORS allowed origins:', allowedOrigins.length ? allowedOrigins.join(', ') : '(localhost only — set CORS_ORIGINS in production)')
    app.use(cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true) // same-origin / server-to-server / Postman
        // Geliştirme ortamında localhost her zaman kabul edilir
        if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true)
        if (allowedOrigins.includes(origin)) return cb(null, true)
        return cb(null, false)
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'sentry-trace', 'baggage', 'sentry-baggage'],
    }))
    // ── Rate limiting — per-endpoint granular limits ──────────────────────────
    const _rl = (opts) => rateLimit({ standardHeaders: 'draft-7', legacyHeaders: false, ...opts })

    // General catch-all — high ceiling, just prevents floods
    const generalLimiter = _rl({
      windowMs: 60 * 1000,
      max: 300,
      skip: (req) => req.path === '/health',
    })

    // Seller login — 10 attempts per 15 min; only failed requests count
    const authLimiter = _rl({
      windowMs: 15 * 60 * 1000,
      max: 10,
      skipSuccessfulRequests: true,
      message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
    })

    // New account registrations — 5 per hour per IP
    const registerLimiter = _rl({
      windowMs: 60 * 60 * 1000,
      max: 5,
      skipSuccessfulRequests: true,
      message: { error: 'Too many registration attempts. Please try again later.' },
    })

    // Customer login (/store/auth/token) — 15 attempts per 15 min
    const customerAuthLimiter = _rl({
      windowMs: 15 * 60 * 1000,
      max: 15,
      skipSuccessfulRequests: true,
      message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
    })

    // 2FA endpoints — TOTP has 1 000 000 combinations; tight window is the only defense
    const totpLimiter = _rl({
      windowMs: 15 * 60 * 1000,
      max: 5,
      skipSuccessfulRequests: true,
      message: { error: 'Too many 2FA attempts. Please try again in 15 minutes.' },
    })

    // Password change — 5 per hour
    const passwordChangeLimiter = _rl({
      windowMs: 60 * 60 * 1000,
      max: 5,
      skipSuccessfulRequests: true,
      message: { error: 'Too many password change attempts. Please try again later.' },
    })

    // Payment intent creation — 10 per minute
    const paymentLimiter = _rl({
      windowMs: 60 * 1000,
      max: 10,
      message: { error: 'Too many payment requests. Please slow down.' },
    })

    app.use(generalLimiter)
    app.use('/admin-hub/auth/login',           authLimiter)
    app.use('/admin-hub/auth/register',        registerLimiter)
    app.use('/admin-hub/auth/2fa/setup',       totpLimiter)
    app.use('/admin-hub/auth/2fa/verify',      totpLimiter)
    app.use('/admin-hub/auth/2fa/disable',     totpLimiter)
    app.use('/admin-hub/v1/seller/password',   passwordChangeLimiter)
    app.use('/store/customers',                registerLimiter)   // customer register
    app.use('/store/auth/token',               customerAuthLimiter)
    app.use('/store/payment-intent',           paymentLimiter)

    // ── DB connection helper ─────────────────────────────────────────────────
    // Wraps connect → fn(client) → end in a guaranteed finally so connections
    // are always released even on early returns or thrown errors.
    // Usage: const result = await withClient(getSellerDbClient, async (client) => { ... })
    async function withClient(getClient, fn) {
      const client = getClient()
      if (!client) throw Object.assign(new Error('Database not configured'), { status: 503 })
      await client.connect()
      try {
        return await fn(client)
      } finally {
        await client.end().catch(() => {})
      }
    }


    // Root ve health: "Cannot GET /" yerine JSON döner
    app.get('/', (req, res) => {
      res.json({ ok: true, service: 'medusa-backend', timestamp: new Date().toISOString() })
    })
    app.get('/health', async (req, res) => {
      const redisPing = await pingForHealth()
      const notificationQueue = getFlowQueueStatus()
      res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        redis: {
          url_configured: redisPing.url_configured,
          ping_ok: redisPing.ping_ok,
          ...(redisPing.error ? { error: redisPing.error } : {}),
        },
        notification_queue: notificationQueue,
      })
    })
    // Uploads: use UPLOAD_DIR for a persistent volume path, or S3 when S3_UPLOAD_* env is set.
    // Otherwise __dirname/uploads (ephemeral on many hosts). See docs/UPLOADS.md.
    const uploadDir = process.env.UPLOAD_DIR
      ? path.resolve(process.env.UPLOAD_DIR)
      : path.join(__dirname, 'uploads')
    const useS3 = !!(process.env.S3_UPLOAD_BUCKET && process.env.S3_UPLOAD_REGION)
    if (!useS3) {
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true })
      }
      app.use('/uploads', express.static(uploadDir))
    }
    const appLoader = new MedusaAppLoader({ cwd: path.resolve(__dirname) })

    let medusaApp
    try {
      medusaApp = await appLoader.load()
    } catch (loadErr) {
      console.error('\n❌ app.load() failed:', loadErr.code || loadErr.name, loadErr.message)
      if (loadErr.stack) console.error(loadErr.stack)
      process.exit(1)
    }

    const { expressLoader } = require('@medusajs/framework/http')
    const { app: httpApp } = await expressLoader({ app, container })

    // Explicit OPTIONS preflight handler on httpApp so Medusa's own CORS does not
    // override the custom allowed headers (sentry-trace, baggage etc.) for all routes.
    const ALLOWED_HEADERS = 'Content-Type,Authorization,sentry-trace,baggage,sentry-baggage'
    httpApp.options('*', (req, res) => {
      const origin = req.headers.origin
      const allowAllOrigins = getAllowedOrigins() === null
      const allowed = allowAllOrigins || !origin || /^https?:\/\/localhost(:\d+)?$/.test(origin) || (getAllowedOrigins() || []).includes(origin)
      if (origin && allowed) res.setHeader('Access-Control-Allow-Origin', origin)
      else if (!origin) res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
      res.setHeader('Access-Control-Max-Age', '86400')
      res.status(204).end()
    })

    // Admin Hub tabloları yoksa oluştur (menüs/categories deploy sonrası çalışsın diye)
    const DATABASE_URL = process.env.DATABASE_URL || ''
    if (DATABASE_URL && DATABASE_URL.startsWith('postgres')) {
      try {
        const { Client } = require('pg')
        const dbUrl = DATABASE_URL.replace(/^postgresql:\/\//, 'postgres://')
        const isRender = dbUrl.includes('render.com')
        const client = new Client({ connectionString: dbUrl, ssl: isRender ? { rejectUnauthorized: false } : false })
        await client.connect()
        await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";')
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_menus (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            name varchar(100) NOT NULL,
            slug varchar(100) NOT NULL UNIQUE,
            location varchar(50) DEFAULT 'main',
            categories_with_products boolean DEFAULT false,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `)
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_menu_items (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            menu_id uuid NOT NULL REFERENCES admin_hub_menus(id) ON DELETE CASCADE,
            label varchar(255) NOT NULL,
            slug varchar(255),
            link_type varchar(50) DEFAULT 'url',
            link_value text,
            parent_id uuid REFERENCES admin_hub_menu_items(id) ON DELETE CASCADE,
            sort_order integer DEFAULT 0,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `)
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_hub_menus_slug ON admin_hub_menus(slug);')
        try {
          await client.query('ALTER TABLE admin_hub_menus ADD COLUMN IF NOT EXISTS location varchar(50) DEFAULT \'main\';')
        } catch (e) {
          if (e.code !== '42701') throw e
        }
        try {
          await client.query('ALTER TABLE admin_hub_menus ADD COLUMN IF NOT EXISTS categories_with_products boolean DEFAULT false;')
        } catch (e) {
          if (e.code !== '42701') throw e
        }
        try {
          await client.query('ALTER TABLE admin_hub_menu_items ADD COLUMN IF NOT EXISTS slug varchar(255);')
        } catch (e) {
          if (e.code !== '42701') throw e
        }
        try {
          await client.query('ALTER TABLE admin_hub_menus ADD COLUMN IF NOT EXISTS name_i18n jsonb;')
        } catch (e) {
          if (e.code !== '42701') throw e
        }
        try {
          await client.query('ALTER TABLE admin_hub_menu_items ADD COLUMN IF NOT EXISTS label_i18n jsonb;')
        } catch (e) {
          if (e.code !== '42701') throw e
        }
        await client.query('CREATE INDEX IF NOT EXISTS idx_admin_hub_menus_location ON admin_hub_menus(location);')
        await client.query('CREATE INDEX IF NOT EXISTS idx_admin_hub_menu_items_menu_id ON admin_hub_menu_items(menu_id);')
        await client.query('CREATE INDEX IF NOT EXISTS idx_admin_hub_menu_items_parent_id ON admin_hub_menu_items(parent_id);')
        // Fix: normalize empty string location to NULL so they don't get misread as "main"
        await client.query(`UPDATE admin_hub_menus SET location = NULL WHERE location = ''`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_menu_locations (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            slug varchar(50) NOT NULL UNIQUE,
            label varchar(255) NOT NULL,
            html_id varchar(50),
            sort_order integer DEFAULT 0
          );
        `)
        await client.query(`
          INSERT INTO admin_hub_menu_locations (slug, label, html_id, sort_order) VALUES
            ('main', 'Main menu (dropdown)', NULL, 0),
            ('second', 'Second menu (navbar bar)', 'subnav', 1),
            ('footer1', 'Footer column 1', NULL, 10),
            ('footer2', 'Footer column 2', NULL, 11),
            ('footer3', 'Footer column 3', NULL, 12),
            ('footer4', 'Footer column 4', NULL, 13)
          ON CONFLICT (slug) DO NOTHING;
        `)
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_media (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            filename varchar(255) NOT NULL,
            url text NOT NULL,
            mime_type varchar(100),
            size integer DEFAULT 0,
            alt varchar(255),
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `)
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_pages (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            title varchar(255) NOT NULL,
            slug varchar(255) NOT NULL UNIQUE,
            body text,
            status varchar(50) DEFAULT 'draft',
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `)
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_hub_pages_slug ON admin_hub_pages(slug);')
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS page_type varchar(50) DEFAULT 'page';`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS featured_image text;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS excerpt text;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS meta_title varchar(512);`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS meta_description text;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS meta_keywords varchar(512);`).catch(() => {})
        // Per-language overrides (DE stays on the plain columns above; other locales live here,
        // keyed by locale, same {locale: {field: value}} shape as admin_hub_menus.name_i18n).
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS title_i18n jsonb;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS body_i18n jsonb;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS excerpt_i18n jsonb;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS meta_title_i18n jsonb;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_pages ADD COLUMN IF NOT EXISTS meta_description_i18n jsonb;`).catch(() => {})
        await client.query(`UPDATE admin_hub_pages SET page_type = 'page' WHERE page_type IS NULL`).catch(() => {})
        // Editable settings for the hardcoded API-driven storefront pages (/bestsellers, /sales) —
        // these pages aren't container-based CMS pages, but Sellercentral still needs a place to
        // adjust their title copy, item count and sort/data-source strategy per page.
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_api_page_settings (
            page_slug varchar(50) PRIMARY KEY,
            title_i18n jsonb,
            subtitle_i18n jsonb,
            max_items integer,
            sort_mode varchar(30),
            updated_at timestamp NOT NULL DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_collections (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            title varchar(255) NOT NULL,
            handle varchar(255) NOT NULL UNIQUE,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `)
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_hub_collections_handle ON admin_hub_collections(handle);')
        try {
          await client.query('ALTER TABLE admin_hub_collections ADD COLUMN metadata jsonb;')
        } catch (e) {
          if (e.code !== '42701') throw e
        }
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_seller_settings (
            seller_id varchar(255) PRIMARY KEY DEFAULT 'default',
            store_name varchar(255),
            updated_at timestamp DEFAULT now()
          );
        `)
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_brands (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            name varchar(255) NOT NULL,
            handle varchar(255) NOT NULL UNIQUE,
            logo_image text,
            banner_image text,
            address text,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `)
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_hub_brands_handle ON admin_hub_brands(handle);')
        await client.query('ALTER TABLE admin_hub_brands ADD COLUMN IF NOT EXISTS banner_image text;')
        await client.query('ALTER TABLE admin_hub_brands ADD COLUMN IF NOT EXISTS seller_id varchar(255) DEFAULT NULL;')
        // ── Brand authorization workflow (docs/BRAND.md Faz 1) ──
        await client.query(`ALTER TABLE admin_hub_brands ADD COLUMN IF NOT EXISTS status varchar(20) DEFAULT 'active';`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_brands ADD COLUMN IF NOT EXISTS brand_type varchar(30) DEFAULT 'own';`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_brands ADD COLUMN IF NOT EXISTS trademark_number varchar(120) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_brands ADD COLUMN IF NOT EXISTS trademark_jurisdiction varchar(40) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_brands ADD COLUMN IF NOT EXISTS approved_at timestamp DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_brands ADD COLUMN IF NOT EXISTS approved_by varchar(255) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_brands ADD COLUMN IF NOT EXISTS rejection_reason text DEFAULT NULL;`).catch(() => {})
        // Existing brands = own brands, already active (non-breaking migration)
        await client.query(`UPDATE admin_hub_brands SET status = 'active' WHERE status IS NULL;`).catch(() => {})
        await client.query(`UPDATE admin_hub_brands SET brand_type = 'own' WHERE brand_type IS NULL;`).catch(() => {})
        // Rename old 'registered' → 'own_registered' (brand type rename)
        await client.query(`UPDATE admin_hub_brands SET brand_type = 'own_registered' WHERE brand_type = 'registered';`).catch(() => {})
        // verification_level: own brands = unverified (no trademark proof), approved registered = verified
        await client.query(`ALTER TABLE admin_hub_brands ADD COLUMN IF NOT EXISTS verification_level varchar(20) DEFAULT NULL;`).catch(() => {})
        await client.query(`UPDATE admin_hub_brands SET verification_level = 'unverified' WHERE brand_type = 'own' AND verification_level IS NULL;`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_brand_authorization_documents (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            brand_id uuid NOT NULL,
            seller_id varchar(255),
            document_type varchar(40) NOT NULL,
            file_url text NOT NULL,
            file_name text,
            status varchar(20) NOT NULL DEFAULT 'pending',
            reviewer_id varchar(255),
            reviewer_note text,
            reviewed_at timestamp,
            uploaded_at timestamp NOT NULL DEFAULT now()
          );
        `).catch(() => {})
        await client.query('CREATE INDEX IF NOT EXISTS idx_brand_auth_docs_brand ON admin_hub_brand_authorization_documents(brand_id);').catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_carts (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `)
        await client.query(`ALTER TABLE store_carts ADD COLUMN IF NOT EXISTS bonus_points_reserved integer NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`ALTER TABLE store_carts ADD COLUMN IF NOT EXISTS email text`).catch(() => {})
        await client.query(`ALTER TABLE store_carts ADD COLUMN IF NOT EXISTS first_name text`).catch(() => {})
        await client.query(`ALTER TABLE store_carts ADD COLUMN IF NOT EXISTS last_name text`).catch(() => {})
        await client.query(`ALTER TABLE store_carts ADD COLUMN IF NOT EXISTS phone text`).catch(() => {})
        await client.query(`ALTER TABLE store_carts ADD COLUMN IF NOT EXISTS coupon_code text`).catch(() => {})
        await client.query(`ALTER TABLE store_carts ADD COLUMN IF NOT EXISTS coupon_discount_cents integer NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS coupon_code text`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS coupon_discount_cents integer NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_coupons (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            seller_id varchar(255) NOT NULL DEFAULT 'default',
            code varchar(100) NOT NULL,
            discount_type varchar(20) NOT NULL DEFAULT 'percent',
            discount_value integer NOT NULL,
            min_subtotal_cents integer NOT NULL DEFAULT 0,
            usage_limit integer,
            used_count integer NOT NULL DEFAULT 0,
            active boolean NOT NULL DEFAULT true,
            expires_at timestamp,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `).catch(() => {})
        await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_hub_coupons_seller_code ON admin_hub_coupons(seller_id, lower(code));').catch(() => {})
        await client.query('ALTER TABLE admin_hub_coupons ADD COLUMN IF NOT EXISTS starts_at timestamp;').catch(() => {})
        await client.query('ALTER TABLE admin_hub_coupons ADD COLUMN IF NOT EXISTS per_customer_limit integer;').catch(() => {})
        // Birthday campaign: when set, this coupon is valid for a given customer only within
        // N days of THEIR OWN birthday (store_customers.birth_date), evaluated live at checkout
        // — independent of (and in addition to) the coupon's own starts_at/expires_at window.
        // See resolveCartCouponDiscountSync in store-checkout.js.
        await client.query('ALTER TABLE admin_hub_coupons ADD COLUMN IF NOT EXISTS birthday_window_days integer;').catch(() => {})
        await client.query(`
          INSERT INTO admin_hub_coupons (seller_id, code, discount_type, discount_value, per_customer_limit, active, birthday_window_days)
          VALUES ('default', 'BIRTHDAY', 'percent', 5, 1, true, 30)
          ON CONFLICT (seller_id, lower(code)) DO NOTHING
        `).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_coupon_usage (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            coupon_id uuid NOT NULL,
            customer_id uuid NOT NULL,
            order_id uuid,
            used_at timestamp NOT NULL DEFAULT now()
          );
        `).catch(() => {})
        await client.query('CREATE INDEX IF NOT EXISTS idx_coupon_usage_coupon_customer ON admin_hub_coupon_usage(coupon_id, customer_id);').catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_cart_items (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            cart_id uuid NOT NULL REFERENCES store_carts(id) ON DELETE CASCADE,
            variant_id text NOT NULL,
            product_id text NOT NULL,
            quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
            unit_price_cents integer NOT NULL DEFAULT 0,
            title text,
            thumbnail text,
            product_handle text,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `)
        await client.query('CREATE INDEX IF NOT EXISTS idx_store_cart_items_cart_id ON store_cart_items(cart_id);')
        // Soft-delete flag: removing an item from a cart now keeps the row (removed_at set)
        // instead of hard-deleting it, so abandoned-checkout reporting can tell "items removed
        // from cart" apart from "cart still has these items" instead of losing that history.
        await client.query('ALTER TABLE store_cart_items ADD COLUMN IF NOT EXISTS removed_at timestamptz').catch(() => {})

        // Orders (Stripe checkout sonrası)
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_orders (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            cart_id uuid REFERENCES store_carts(id) ON DELETE SET NULL,
            payment_intent_id text,
            status varchar(50) NOT NULL DEFAULT 'pending',
            email text,
            first_name text,
            last_name text,
            phone text,
            address_line1 text,
            address_line2 text,
            city text,
            postal_code text,
            country text,
            subtotal_cents integer NOT NULL DEFAULT 0,
            total_cents integer NOT NULL DEFAULT 0,
            currency text NOT NULL DEFAULT 'eur',
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `)
        await client.query(`
          ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS order_number BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 100001 INCREMENT BY 1);
        `).catch(() => {})
        await client.query(`
  ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS payment_status varchar(50) NOT NULL DEFAULT 'bezahlt';
`).catch(() => {})
        await client.query(`
  ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS delivery_status varchar(50) NOT NULL DEFAULT 'offen';
`).catch(() => {})
        await client.query(`
  ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS order_status varchar(50) NOT NULL DEFAULT 'offen';
`).catch(() => {})
        await client.query(`
  ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS seller_id varchar(255) DEFAULT 'default';
`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS payment_method varchar(100);`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS billing_address_line1 text;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS billing_address_line2 text;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS billing_city text;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS billing_postal_code varchar(20);`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS billing_country varchar(10);`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS billing_same_as_shipping boolean DEFAULT true;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS is_guest boolean DEFAULT true;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS newsletter_opted_in boolean DEFAULT false;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS customer_id uuid;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS locale varchar(8);`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS tracking_number varchar(200);`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS carrier_name varchar(100);`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS shipped_at timestamp;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS sendcloud_label_url text;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS notes text;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS delivery_date timestamp;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS stripe_transfer_status varchar(50) NOT NULL DEFAULT 'legacy_skipped';`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS stripe_transfer_id text;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS stripe_transfer_error text;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS stripe_transfer_at timestamp;`).catch(() => {})
        // Destination Charges + Manual Payouts fields
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS stripe_account_id text;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS stripe_application_fee_cents integer;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS stripe_payout_status varchar(50);`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS stripe_payout_id text;`).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_stripe_payout_id ON store_orders (stripe_payout_id) WHERE stripe_payout_id IS NOT NULL;`).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_orders_stripe_payout_status ON store_orders (stripe_payout_status) WHERE stripe_payout_status IS NOT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS discount_cents integer NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS shipping_cents integer NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_platform_checkout (
            id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
            stripe_publishable_key text,
            stripe_secret_key text,
            pay_card boolean NOT NULL DEFAULT true,
            pay_paypal boolean NOT NULL DEFAULT false,
            pay_klarna boolean NOT NULL DEFAULT false,
            paypal_client_id text,
            paypal_client_secret text,
            updated_at timestamp DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`INSERT INTO store_platform_checkout (id) VALUES (1) ON CONFLICT (id) DO NOTHING`).catch(() => {})
        await client.query(`ALTER TABLE store_platform_checkout ADD COLUMN IF NOT EXISTS payment_method_layout text DEFAULT 'grid'`).catch(() => {})
        await client.query(`ALTER TABLE store_platform_checkout ADD COLUMN IF NOT EXISTS payment_method_types_json jsonb`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS free_shipping_thresholds jsonb`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS shop_logo_url text`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS shop_favicon_url text`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS sellercentral_logo_url text`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS sellercentral_favicon_url text`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS shop_logo_height integer DEFAULT 34`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS sellercentral_logo_height integer DEFAULT 30`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS platform_name text`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS support_email text`).catch(() => {})
        // Recipient for "admin" audience flows (Content → Flows) — e.g. new-seller-signup
        // notifications to the platform team, distinct from support_email (customer-facing contact).
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS admin_notification_email text`).catch(() => {})
        await client.query(`UPDATE admin_hub_seller_settings SET admin_notification_email = 'info@andertal.com' WHERE seller_id = 'default' AND admin_notification_email IS NULL`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS announcement_bar_items jsonb`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS logo_config jsonb`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_banners (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            title text NOT NULL DEFAULT '',
            subtitle text,
            image_url text,
            link_url text,
            button_text text,
            is_active boolean NOT NULL DEFAULT true,
            position integer NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_banners ADD COLUMN IF NOT EXISTS video_url text`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS bonus_points_redeemed integer NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS checkout_payment_kind varchar(32) NOT NULL DEFAULT 'stripe'`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS seller_net_after_commission_cents integer NOT NULL DEFAULT 0`).catch(() => {})
        // BonusPunkte.md §3.2 — persists the platform-funded discount cents for this order (= bonus
        // redemption value at order time), independent of coupon_discount_cents, so settlement/export
        // never has to re-derive "how much of discount_cents was bonus vs coupon" after the fact.
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS platform_bonus_funding_cents integer NOT NULL DEFAULT 0`).catch(() => {})
        // BonusPunkte.md §6 B2B reverse-charge — snapshot of the 'gewerbe' customer's VAT-ID
        // (store_customers.vat_number, already collected on account/register — NOT a new checkout
        // field) at order time, so a later profile edit never rewrites a past invoice's tax basis.
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS customer_vat_id text`).catch(() => {})
        // Live VIES lookup result (see src/vies-check.js), snapshotted at order time from the
        // customer's profile check — null = never checked / VIES unreachable (falls back to the
        // existing format-only reverse-charge logic, unchanged). Informational only, shown on the
        // invoice's reverse-charge note; does NOT itself decide the 0%-VAT scheme.
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS customer_vat_id_verified boolean`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS vies_valid boolean`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS vies_checked_at timestamptz`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS vies_company_name text`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_shipping_carriers (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            name varchar(100) NOT NULL,
            tracking_url_template text,
            api_key text,
            api_secret text,
            seller_id varchar(255),
            is_active boolean DEFAULT true,
            sort_order integer DEFAULT 0,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`ALTER TABLE store_shipping_carriers ADD COLUMN IF NOT EXISTS seller_id varchar(255)`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_shipment_events (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            order_id uuid REFERENCES store_orders(id) ON DELETE CASCADE,
            status varchar(50) NOT NULL DEFAULT 'manual',
            description text,
            location varchar(200),
            event_time timestamp DEFAULT now(),
            source varchar(50) DEFAULT 'manual',
            created_at timestamp DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_shipment_events_order ON store_shipment_events(order_id)`).catch(() => {})
        await client.query(`ALTER TABLE store_shipping_carriers ADD COLUMN IF NOT EXISTS logo_url text`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_integrations (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            name varchar(100) NOT NULL,
            slug varchar(100) NOT NULL UNIQUE,
            logo_url text,
            api_key text,
            api_secret text,
            webhook_url text,
            config jsonb DEFAULT '{}',
            is_active boolean DEFAULT false,
            category varchar(50) DEFAULT 'other',
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`ALTER TABLE store_integrations ADD COLUMN IF NOT EXISTS seller_scope_key text`).catch(() => {})
        // customer_number may be missing if table was created before this column was added
        await client.query(`
          DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='store_customers' AND column_name='customer_number') THEN
              ALTER TABLE store_customers ADD COLUMN customer_number BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 10001 INCREMENT BY 1);
            END IF;
          END $$;
        `).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS password_hash text;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS account_type varchar(20) DEFAULT 'privat';`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS gender varchar(10);`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS birth_date date;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS address_line1 text;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS address_line2 text;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS zip_code varchar(20);`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS city text;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS country varchar(100);`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS company_name text;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS vat_number text;`).catch(() => {})
        // Fix duplicate + NULL customer_numbers and restore identity sequence.
        // Uses a row-by-row DO block so every assignment is guaranteed unique.
        await client.query(`
          DO $$
          DECLARE
            rec    RECORD;
            new_num BIGINT;
          BEGIN
            -- 1. Drop GENERATED ALWAYS identity so we can write to the column directly
            BEGIN
              ALTER TABLE store_customers ALTER COLUMN customer_number DROP IDENTITY;
            EXCEPTION WHEN OTHERS THEN NULL;
            END;

            -- 2. Starting point = current max (or 100000 if table is empty)
            SELECT COALESCE(MAX(customer_number), 100000) INTO new_num FROM store_customers;

            -- 3. Assign fresh numbers to every duplicate (keep the earliest row's number)
            FOR rec IN
              SELECT id FROM (
                SELECT id,
                  ROW_NUMBER() OVER (PARTITION BY customer_number ORDER BY created_at ASC) AS rn
                FROM store_customers
                WHERE customer_number IS NOT NULL
              ) t
              WHERE rn > 1
              ORDER BY rn
            LOOP
              new_num := new_num + 1;
              UPDATE store_customers SET customer_number = new_num WHERE id = rec.id;
            END LOOP;

            -- 4. Also fill in any NULL customer_numbers
            FOR rec IN
              SELECT id FROM store_customers WHERE customer_number IS NULL ORDER BY created_at
            LOOP
              new_num := new_num + 1;
              UPDATE store_customers SET customer_number = new_num WHERE id = rec.id;
            END LOOP;

            -- 5. Restore GENERATED ALWAYS AS IDENTITY starting after the new max
            BEGIN
              EXECUTE format(
                'ALTER TABLE store_customers ALTER COLUMN customer_number ADD GENERATED ALWAYS AS IDENTITY (START WITH %s INCREMENT BY 1)',
                new_num + 1
              );
            EXCEPTION WHEN OTHERS THEN NULL;
            END;
          END $$
        `).catch(e => console.warn('customer_number dedup migration:', e?.message))
        // Ensure uniqueness index exists (safe to run repeatedly)
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS store_customers_customer_number_unique
          ON store_customers(customer_number) WHERE customer_number IS NOT NULL;
        `).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS notes text;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS email_marketing_consent boolean DEFAULT false;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS bonus_points integer DEFAULT 0;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS billing_address_line1 text;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS billing_address_line2 text;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS billing_zip_code varchar(20);`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS billing_city text;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS billing_country varchar(100);`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS stripe_customer_id text;`).catch(() => {})
        await client.query(`ALTER TABLE store_customers ADD COLUMN IF NOT EXISTS locale varchar(8);`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_messages (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            order_id uuid REFERENCES store_orders(id) ON DELETE SET NULL,
            sender_type varchar(20) NOT NULL,
            sender_email text,
            recipient_email text,
            subject text,
            body text NOT NULL,
            is_read_by_seller boolean NOT NULL DEFAULT false,
            is_read_by_customer boolean NOT NULL DEFAULT false,
            created_at timestamp NOT NULL DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_smtp_settings (
            seller_id varchar(255) PRIMARY KEY DEFAULT 'default',
            provider varchar(50),
            host text,
            port integer DEFAULT 587,
            secure boolean DEFAULT false,
            username text,
            password_enc text,
            from_name text,
            from_email text,
            updated_at timestamp DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS notifications_seen_at timestamp;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS billbee_api_key text;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS billbee_basic_username text;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS billbee_basic_password text;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS billbee_updated_at timestamp;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS billbee_connection_name text;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS storefront_url text;`).catch(() => {})
        // Seller's last-used Sellercentral UI language — captured opportunistically when they reply to a
        // message or open a support ticket, so message-notification emails can be sent in that language.
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS locale varchar(8) DEFAULT 'de';`).catch(() => {})
        // Barcode scanner behavior for the /versand packing screen (auto-focus, auto-submit on Enter, min length).
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS barcode_scanner_config jsonb;`).catch(() => {})
        // ── Platform legal / company info ────────────────────────────────────
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS legal_company_name varchar(255)`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS legal_representative varchar(255)`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS legal_street varchar(255)`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS legal_city varchar(255)`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS legal_trade_register varchar(255)`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS legal_register_court varchar(255)`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS legal_vat_id varchar(100)`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS legal_tax_id varchar(100)`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS legal_email varchar(255)`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS enabled_shop_locales jsonb`).catch(() => {})
        await client.query(`CREATE TABLE IF NOT EXISTS admin_hub_notifications (
          id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
          type varchar(50) NOT NULL,
          title text,
          body text,
          seller_id varchar(255),
          reference_id text,
          seen_at timestamp,
          created_at timestamp NOT NULL DEFAULT now()
        )`).catch(() => {})
        await client.query(`CREATE TABLE IF NOT EXISTS seller_hub_notification_state (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          recipient_key varchar(255) NOT NULL,
          source_type varchar(64) NOT NULL,
          source_id uuid NOT NULL,
          read_at timestamptz,
          deleted_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (recipient_key, source_type, source_id)
        )`).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_seller_notif_state_recipient ON seller_hub_notification_state(recipient_key)`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_flows (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            name varchar(255) NOT NULL,
            trigger_key varchar(80) NOT NULL,
            status varchar(20) NOT NULL DEFAULT 'draft',
            sent_count integer NOT NULL DEFAULT 0,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_flow_steps (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            flow_id uuid NOT NULL REFERENCES admin_hub_flows(id) ON DELETE CASCADE,
            step_order integer NOT NULL DEFAULT 0,
            step_type varchar(40) NOT NULL,
            wait_hours integer,
            email_subject text,
            email_body text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_flow_steps ADD COLUMN IF NOT EXISTS email_i18n jsonb DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_flow_steps ADD COLUMN IF NOT EXISTS email_attachments jsonb DEFAULT NULL`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_smtp_sender_profiles (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            seller_id varchar(255) NOT NULL DEFAULT 'default',
            from_email varchar(512) NOT NULL,
            from_name text,
            is_default boolean NOT NULL DEFAULT false,
            last_test_ok boolean,
            last_test_at timestamptz,
            last_test_message text,
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(seller_id, from_email)
          );
        `).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_store_smtp_sender_profiles_seller ON store_smtp_sender_profiles(seller_id)`).catch(() => {})
        await client.query(`
          INSERT INTO store_smtp_sender_profiles (seller_id, from_email, from_name, is_default)
          SELECT 'default', TRIM(from_email), NULLIF(TRIM(from_name), ''), true
          FROM store_smtp_settings WHERE seller_id = 'default'
            AND from_email IS NOT NULL AND TRIM(from_email) <> ''
            AND NOT EXISTS (SELECT 1 FROM store_smtp_sender_profiles p WHERE p.seller_id = 'default')
        `).catch(() => {})
        await client.query(
          `ALTER TABLE admin_hub_flow_steps ADD COLUMN IF NOT EXISTS smtp_sender_id uuid REFERENCES store_smtp_sender_profiles(id) ON DELETE SET NULL`,
        ).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_flows ADD COLUMN IF NOT EXISTS audience varchar(20) NOT NULL DEFAULT 'customer'`).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_admin_hub_flow_steps_flow ON admin_hub_flow_steps(flow_id, step_order)`).catch(() => {})
        // Seed the customer/seller messaging-notification flows (Content → Flows) once — never
        // overwrites a trigger_key the superuser already has a flow for.
        try {
          const { seedMessageFlows } = require('./src/seed-message-flows')
          await seedMessageFlows(client)
        } catch (e) {
          console.warn('[seed-message-flows]', e?.message || e)
        }
        try {
          const { seedSupportCaseFlows } = require('./src/seed-support-case-flows')
          await seedSupportCaseFlows(client)
        } catch (e) {
          console.warn('[seed-support-case-flows]', e?.message || e)
        }
        // Seed the seller lifecycle flows (registered/docs submitted/approved/rejected/
        // documents required) once — same idempotent skip-if-exists pattern as above.
        try {
          const { seedSellerLifecycleFlows } = require('./src/seed-seller-lifecycle-flows')
          await seedSellerLifecycleFlows(client)
        } catch (e) {
          console.warn('[seed-seller-lifecycle-flows]', e?.message || e)
        }
        try {
          const { seedReviewRequestFlow } = require('./src/seed-review-request-flow')
          await seedReviewRequestFlow(client)
        } catch (e) {
          console.warn('[seed-review-request-flow]', e?.message || e)
        }
        try {
          const { seedWinBackFlow } = require('./src/seed-winback-flow')
          await seedWinBackFlow(client)
        } catch (e) {
          console.warn('[seed-winback-flow]', e?.message || e)
        }
        try {
          const { seedReturnRequestedFlow } = require('./src/seed-return-requested-flow')
          await seedReturnRequestedFlow(client)
        } catch (e) {
          console.warn('[seed-return-requested-flow]', e?.message || e)
        }
        try {
          const { seedReturnRequestedCustomerShipsFlow } = require('./src/seed-return-requested-customer-ships-flow')
          await seedReturnRequestedCustomerShipsFlow(client)
        } catch (e) {
          console.warn('[seed-return-requested-customer-ships-flow]', e?.message || e)
        }
        try {
          const { dedupeAndNormalizeFlows } = require('./src/flow-catalog')
          await dedupeAndNormalizeFlows(client)
        } catch (e) {
          console.warn('[flow-catalog]', e?.message || e)
        }
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_flow_snapshots (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            flow_id uuid NOT NULL REFERENCES admin_hub_flows(id) ON DELETE CASCADE,
            version_num integer NOT NULL,
            flow_snapshot jsonb NOT NULL DEFAULT '{}',
            steps_snapshot jsonb NOT NULL DEFAULT '[]',
            created_at timestamptz NOT NULL DEFAULT now(),
            UNIQUE(flow_id, version_num)
          )
        `).catch(() => {})
        await client.query(
          `CREATE INDEX IF NOT EXISTS idx_flow_snapshots_flow_ver ON admin_hub_flow_snapshots(flow_id, version_num DESC)`,
        ).catch(() => {})

        // Seed new flow templates once (draft — a superuser reviews/translates/activates them
        // under Content → Flows before they start sending): reorder reminder ('win_back'),
        // favorited-product low-stock and price-drop nudges.
        try {
          const seedFlows = [
            {
              trigger_key: 'win_back',
              name: 'Reorder Reminder',
              i18n: {
                en: { subject: "Time to restock? We miss you!", body: "<p>Hi {FIRST_NAME},</p><p>It's been a while since your last order at {SHOP_NAME} — we hope everything arrived well!</p><p>If you're ready to restock or discover something new, we'd love to have you back.</p><p><a href=\"{SHOP_HOME_URL}\">Browse the shop</a></p>" },
                de: { subject: "Zeit zum Nachbestellen? Wir vermissen Sie!", body: "<p>Hallo {FIRST_NAME},</p><p>es ist eine Weile her seit Ihrer letzten Bestellung bei {SHOP_NAME} — wir hoffen, alles ist gut angekommen!</p><p>Wenn Sie nachbestellen oder etwas Neues entdecken möchten, freuen wir uns auf Sie.</p><p><a href=\"{SHOP_HOME_URL}\">Zum Shop</a></p>" },
                tr: { subject: "Yeniden sipariş zamanı mı? Sizi özledik!", body: "<p>Merhaba {FIRST_NAME},</p><p>{SHOP_NAME}'daki son siparişinizin üzerinden bir süre geçti — umarız her şey sorunsuz ulaşmıştır!</p><p>Yeniden sipariş vermek veya yeni ürünler keşfetmek isterseniz sizi tekrar aramızda görmekten mutluluk duyarız.</p><p><a href=\"{SHOP_HOME_URL}\">Mağazaya göz atın</a></p>" },
                fr: { subject: "Envie de recommander ? Vous nous manquez !", body: "<p>Bonjour {FIRST_NAME},</p><p>Cela fait un moment depuis votre dernière commande chez {SHOP_NAME} — nous espérons que tout est bien arrivé !</p><p>Si vous souhaitez recommander ou découvrir de nouveautés, nous serions ravis de vous revoir.</p><p><a href=\"{SHOP_HOME_URL}\">Parcourir la boutique</a></p>" },
                it: { subject: "Tempo di riordinare? Ci manchi!", body: "<p>Ciao {FIRST_NAME},</p><p>è passato un po' dal tuo ultimo ordine su {SHOP_NAME} — speriamo sia arrivato tutto bene!</p><p>Se vuoi riordinare o scoprire qualcosa di nuovo, saremmo felici di riaverti tra noi.</p><p><a href=\"{SHOP_HOME_URL}\">Vai al negozio</a></p>" },
                es: { subject: "¿Hora de volver a pedir? ¡Te echamos de menos!", body: "<p>Hola {FIRST_NAME},</p><p>ha pasado un tiempo desde tu último pedido en {SHOP_NAME} — ¡esperamos que todo llegara bien!</p><p>Si quieres volver a pedir o descubrir algo nuevo, nos encantaría verte de nuevo.</p><p><a href=\"{SHOP_HOME_URL}\">Ver la tienda</a></p>" },
              },
            },
            {
              trigger_key: 'favorite_low_stock',
              name: 'Favorite Product Low Stock',
              i18n: {
                en: { subject: "Hurry — {PRODUCT_NAME} is almost sold out", body: "<p>Hi {FIRST_NAME},</p><p>A product on your wishlist is running low.</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong> — only {PRODUCT_STOCK} left in stock.</p><p><a href=\"{PRODUCT_URL}\">Get it before it's gone</a></p>" },
                de: { subject: "Schnell sein — {PRODUCT_NAME} ist fast ausverkauft", body: "<p>Hallo {FIRST_NAME},</p><p>ein Produkt auf Ihrer Merkliste wird knapp.</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong> — nur noch {PRODUCT_STOCK} Stück auf Lager.</p><p><a href=\"{PRODUCT_URL}\">Jetzt sichern</a></p>" },
                tr: { subject: "Acele edin — {PRODUCT_NAME} tükenmek üzere", body: "<p>Merhaba {FIRST_NAME},</p><p>favorilerinizdeki bir ürünün stoğu azalıyor.</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong> — stokta sadece {PRODUCT_STOCK} adet kaldı.</p><p><a href=\"{PRODUCT_URL}\">Tükenmeden edinin</a></p>" },
                fr: { subject: "Dépêchez-vous — {PRODUCT_NAME} est presque épuisé", body: "<p>Bonjour {FIRST_NAME},</p><p>un produit de votre liste de souhaits se fait rare.</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong> — seulement {PRODUCT_STOCK} en stock.</p><p><a href=\"{PRODUCT_URL}\">À saisir avant rupture</a></p>" },
                it: { subject: "Sbrigati — {PRODUCT_NAME} è quasi esaurito", body: "<p>Ciao {FIRST_NAME},</p><p>un prodotto nella tua wishlist sta finendo.</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong> — solo {PRODUCT_STOCK} rimasti in stock.</p><p><a href=\"{PRODUCT_URL}\">Prendilo prima che finisca</a></p>" },
                es: { subject: "Date prisa — {PRODUCT_NAME} está casi agotado", body: "<p>Hola {FIRST_NAME},</p><p>un producto de tu lista de deseos se está agotando.</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong> — solo quedan {PRODUCT_STOCK} unidades.</p><p><a href=\"{PRODUCT_URL}\">Consíguelo antes de que se agote</a></p>" },
              },
            },
            {
              trigger_key: 'favorite_price_drop',
              name: 'Favorite Product Price Drop',
              i18n: {
                en: { subject: "Price drop: {PRODUCT_NAME} is now cheaper!", body: "<p>Hi {FIRST_NAME},</p><p>A product on your wishlist just got cheaper!</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong><br/><span style=\"text-decoration:line-through;color:#9ca3af;\">{PRODUCT_OLD_PRICE}</span> &rarr; <strong>{PRODUCT_PRICE}</strong></p><p><a href=\"{PRODUCT_URL}\">Shop now</a></p>" },
                de: { subject: "Preissenkung: {PRODUCT_NAME} ist jetzt günstiger!", body: "<p>Hallo {FIRST_NAME},</p><p>ein Produkt auf Ihrer Merkliste ist gerade günstiger geworden!</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong><br/><span style=\"text-decoration:line-through;color:#9ca3af;\">{PRODUCT_OLD_PRICE}</span> &rarr; <strong>{PRODUCT_PRICE}</strong></p><p><a href=\"{PRODUCT_URL}\">Jetzt ansehen</a></p>" },
                tr: { subject: "Fiyat düştü: {PRODUCT_NAME} artık daha uygun!", body: "<p>Merhaba {FIRST_NAME},</p><p>favorilerinizdeki bir ürünün fiyatı az önce düştü!</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong><br/><span style=\"text-decoration:line-through;color:#9ca3af;\">{PRODUCT_OLD_PRICE}</span> &rarr; <strong>{PRODUCT_PRICE}</strong></p><p><a href=\"{PRODUCT_URL}\">Şimdi incele</a></p>" },
                fr: { subject: "Baisse de prix : {PRODUCT_NAME} est maintenant moins cher !", body: "<p>Bonjour {FIRST_NAME},</p><p>un produit de votre liste de souhaits vient de baisser de prix !</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong><br/><span style=\"text-decoration:line-through;color:#9ca3af;\">{PRODUCT_OLD_PRICE}</span> &rarr; <strong>{PRODUCT_PRICE}</strong></p><p><a href=\"{PRODUCT_URL}\">Voir maintenant</a></p>" },
                it: { subject: "Calo di prezzo: {PRODUCT_NAME} ora costa meno!", body: "<p>Ciao {FIRST_NAME},</p><p>un prodotto nella tua wishlist è appena diventato più economico!</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong><br/><span style=\"text-decoration:line-through;color:#9ca3af;\">{PRODUCT_OLD_PRICE}</span> &rarr; <strong>{PRODUCT_PRICE}</strong></p><p><a href=\"{PRODUCT_URL}\">Scopri ora</a></p>" },
                es: { subject: "Bajada de precio: ¡{PRODUCT_NAME} ahora es más barato!", body: "<p>Hola {FIRST_NAME},</p><p>¡un producto de tu lista de deseos acaba de bajar de precio!</p>{PRODUCT_IMAGE_HTML}<p><strong>{PRODUCT_NAME}</strong><br/><span style=\"text-decoration:line-through;color:#9ca3af;\">{PRODUCT_OLD_PRICE}</span> &rarr; <strong>{PRODUCT_PRICE}</strong></p><p><a href=\"{PRODUCT_URL}\">Ver ahora</a></p>" },
              },
            },
          ]
          for (const f of seedFlows) {
            const exists = await client.query(`SELECT id FROM admin_hub_flows WHERE trigger_key = $1 LIMIT 1`, [f.trigger_key])
            if (exists.rows.length) continue
            const ins = await client.query(
              `INSERT INTO admin_hub_flows (name, trigger_key, status, audience) VALUES ($1, $2, 'draft', 'customer') RETURNING id`,
              [f.name, f.trigger_key],
            )
            const flowId = ins.rows[0].id
            const enTpl = f.i18n.en
            await client.query(
              `INSERT INTO admin_hub_flow_steps (flow_id, step_order, step_type, email_subject, email_body, email_i18n)
               VALUES ($1::uuid, 1, 'send_email', $2, $3, $4::jsonb)`,
              [flowId, enTpl.subject, enTpl.body, JSON.stringify(f.i18n)],
            )
          }
        } catch (_) {}
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS iban text;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS payment_account_holder text;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS payment_bic text;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS payment_bank_name text;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS stripe_custom_account_id text;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS permissions jsonb DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS commission_rate numeric(5,4) NOT NULL DEFAULT 0.12;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ALTER COLUMN commission_rate SET DEFAULT 0.12`).catch(() => {})
        await client.query(`UPDATE seller_users SET commission_rate = 0.12 WHERE commission_rate = 0.10`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS sub_of_seller_id varchar(255) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS first_name varchar(255) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS last_name varchar(255) DEFAULT NULL;`).catch(() => {})
        // Message channel support (customer vs support)
        await client.query(`ALTER TABLE store_messages ADD COLUMN IF NOT EXISTS channel varchar(20) DEFAULT 'customer';`).catch(() => {})
        await client.query(`ALTER TABLE store_messages ADD COLUMN IF NOT EXISTS seller_id varchar(255) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE store_messages ADD COLUMN IF NOT EXISTS is_read_by_support boolean NOT NULL DEFAULT false;`).catch(() => {})
        // Which order item this message is about — an order can mix products from several real
        // sellers, so the customer must pick exactly one product per message and it must route
        // only to that product's seller, never to every seller who happens to share the order.
        await client.query(`ALTER TABLE store_messages ADD COLUMN IF NOT EXISTS product_id text;`).catch(() => {})
        // Seller onboarding / approval fields
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS approval_status varchar(30) DEFAULT 'registered';`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS company_name varchar(255) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS tax_id varchar(100) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS vat_id varchar(100) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS business_address jsonb DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS warehouse_address jsonb DEFAULT NULL;`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS seller_error_logs (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            seller_id varchar(255),
            error_code varchar(100),
            error_message text NOT NULL,
            terminal_output text,
            context varchar(255),
            resolution text,
            status varchar(20) NOT NULL DEFAULT 'open',
            is_read boolean NOT NULL DEFAULT false,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS idx_seller_error_logs_seller_id ON seller_error_logs(seller_id);
          CREATE INDEX IF NOT EXISTS idx_seller_error_logs_status ON seller_error_logs(status);
          CREATE INDEX IF NOT EXISTS idx_seller_error_logs_created_at ON seller_error_logs(created_at DESC);
        `).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS seller_locations (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            seller_id varchar(255) NOT NULL,
            name varchar(255) NOT NULL DEFAULT 'Hauptstandort',
            type varchar(30) NOT NULL DEFAULT 'warehouse',
            address_line1 text,
            address_line2 text,
            city varchar(255),
            postal_code varchar(20),
            country varchar(100) DEFAULT 'Deutschland',
            phone varchar(100),
            email varchar(255),
            is_primary boolean NOT NULL DEFAULT false,
            is_active boolean NOT NULL DEFAULT true,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
          CREATE INDEX IF NOT EXISTS idx_seller_locations_seller_id ON seller_locations(seller_id);
        `).catch(() => {})
        // Address purpose tags — independent of is_primary, one location can hold several at once.
        await client.query(`ALTER TABLE seller_locations ADD COLUMN IF NOT EXISTS is_shipping_from boolean NOT NULL DEFAULT false;`).catch(() => {})
        await client.query(`ALTER TABLE seller_locations ADD COLUMN IF NOT EXISTS is_returns_to boolean NOT NULL DEFAULT false;`).catch(() => {})
        await client.query(`ALTER TABLE seller_locations ADD COLUMN IF NOT EXISTS is_billing boolean NOT NULL DEFAULT false;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS phone varchar(100) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS website varchar(255) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS documents jsonb DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS rejection_reason text DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS approved_at timestamp DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS approved_by varchar(255) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS agreement_accepted boolean NOT NULL DEFAULT false;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS agreement_accepted_at timestamp DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS agreement_version varchar(20) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS agreement_ip varchar(60) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS authorized_person_name varchar(255) DEFAULT NULL;`).catch(() => {})
        // Verification pipeline columns
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS risk_score integer DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS verification_steps jsonb DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS verification_started_at timestamp DEFAULT NULL;`).catch(() => {})
        // Stripe Connect columns
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS stripe_account_id varchar(255) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS stripe_onboarding_complete boolean NOT NULL DEFAULT false;`).catch(() => {})
        // 2FA / TOTP columns
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS totp_secret text DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS totp_enabled boolean NOT NULL DEFAULT false;`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS andertal_billbee_api_key text`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS andertal_billbee_api_secret text`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS billbee_integration_enabled boolean NOT NULL DEFAULT true`).catch(() => {})
        await client.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_users_andertal_billbee_api_key ON seller_users(andertal_billbee_api_key) WHERE andertal_billbee_api_key IS NOT NULL`,
        ).catch(() => {})

        // ── Seller agreement signature ──────────────────────────────────────────
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS signature_data text DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS signature_at timestamptz DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS signature_ip varchar(60) DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS agreement_pdf_url text DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS stripe_customer_id text DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS stripe_payment_method_id text DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS stripe_card_last4 varchar(4) DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS stripe_card_brand varchar(30) DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS stripe_card_exp_month integer DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS stripe_card_exp_year integer DEFAULT NULL`).catch(() => {})
        // Marktplatzhaftung (§ 22f UStG) compliance fields
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS lucid_number varchar(100) DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS epr_document_url text DEFAULT NULL`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS seller_sign_tokens (
            token varchar(64) PRIMARY KEY,
            seller_id varchar(255) NOT NULL,
            locale varchar(10) NOT NULL DEFAULT 'de',
            used_at timestamptz DEFAULT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 minutes'),
            ip varchar(60) DEFAULT NULL
          )
        `).catch(() => {})
        await client.query(`ALTER TABLE seller_sign_tokens ADD COLUMN IF NOT EXISTS sign_session varchar(64) DEFAULT NULL`).catch(() => {})

        // ── Ranking infrastructure ──────────────────────────────────────────────
        await client.query(`
          CREATE TABLE IF NOT EXISTS product_events (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            event_type varchar(30) NOT NULL,
            product_id text NOT NULL,
            seller_id varchar(255),
            category_id text,
            strategy varchar(50) DEFAULT 'default',
            session_id varchar(255),
            position integer,
            created_at timestamp DEFAULT now()
          )
        `).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_product_events_product ON product_events(product_id, created_at)`).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_product_events_type_at ON product_events(event_type, created_at)`).catch(() => {})

        await client.query(`
          CREATE TABLE IF NOT EXISTS product_ranking_features (
            product_id text PRIMARY KEY,
            seller_id varchar(255),
            collection_id text,
            sales_7d integer DEFAULT 0,
            sales_30d integer DEFAULT 0,
            sales_90d integer DEFAULT 0,
            gmv_30d_cents bigint DEFAULT 0,
            impressions_30d integer DEFAULT 0,
            clicks_30d integer DEFAULT 0,
            ctr_30d numeric(6,4) DEFAULT 0,
            add_to_cart_30d integer DEFAULT 0,
            review_avg numeric(3,2) DEFAULT 0,
            review_count integer DEFAULT 0,
            return_count_30d integer DEFAULT 0,
            price_cents integer DEFAULT 0,
            compare_at_price_cents integer DEFAULT 0,
            discount_pct numeric(5,2) DEFAULT 0,
            inventory integer DEFAULT 0,
            content_score numeric(4,3) DEFAULT 0,
            published_at timestamp,
            popularity_score numeric(8,6) DEFAULT 0,
            freshness_score numeric(8,6) DEFAULT 0,
            velocity_score numeric(8,6) DEFAULT 0,
            final_score numeric(8,6) DEFAULT 0,
            updated_at timestamp DEFAULT now()
          )
        `).catch(() => {})

        await client.query(`
          CREATE TABLE IF NOT EXISTS ranking_config (
            strategy varchar(50) PRIMARY KEY,
            config jsonb NOT NULL DEFAULT '{}',
            updated_at timestamp DEFAULT now()
          )
        `).catch(() => {})

        await client.query(`
          INSERT INTO ranking_config (strategy, config) VALUES
            ('default',     '{"w_popularity":0.45,"w_freshness":0.15,"w_content":0.10,"w_discount":0.15,"w_seller":0.10,"w_velocity":0.05,"freshness_halflife_days":30,"exploration_k":0.25,"diversity_max_consecutive":3,"urgency_threshold":5}'),
            ('neuheiten',   '{"w_popularity":0.15,"w_freshness":0.55,"w_content":0.10,"w_discount":0.08,"w_seller":0.07,"w_velocity":0.05,"freshness_halflife_days":14,"exploration_k":0.40,"diversity_max_consecutive":3,"urgency_threshold":5}'),
            ('bestsellers', '{"w_popularity":0.65,"w_freshness":0.00,"w_content":0.05,"w_discount":0.12,"w_seller":0.15,"w_velocity":0.03,"freshness_halflife_days":90,"exploration_k":0.10,"diversity_max_consecutive":2,"urgency_threshold":5}'),
            ('sales',       '{"w_popularity":0.25,"w_freshness":0.08,"w_content":0.05,"w_discount":0.48,"w_seller":0.09,"w_velocity":0.05,"freshness_halflife_days":21,"exploration_k":0.15,"diversity_max_consecutive":4,"urgency_threshold":5}'),
            ('search',      '{"w_popularity":0.35,"w_freshness":0.10,"w_content":0.08,"w_discount":0.15,"w_seller":0.12,"w_velocity":0.20,"freshness_halflife_days":30,"exploration_k":0.10,"diversity_max_consecutive":5,"urgency_threshold":5}')
          ON CONFLICT (strategy) DO NOTHING
        `).catch(() => {})

        // Normalize store_name: convert empty string to NULL so sub-users don't conflict
        await client.query(`UPDATE seller_users SET store_name = NULL WHERE store_name = ''`).catch(() => {})
        await client.query(`ALTER TABLE seller_invitations ADD COLUMN IF NOT EXISTS first_name varchar(255) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_invitations ADD COLUMN IF NOT EXISTS last_name varchar(255) DEFAULT NULL;`).catch(() => {})
        await client.query(`ALTER TABLE seller_invitations ADD COLUMN IF NOT EXISTS permissions jsonb DEFAULT NULL;`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS seller_payouts (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            seller_id varchar(255) NOT NULL,
            period_start date NOT NULL,
            period_end date NOT NULL,
            total_cents bigint NOT NULL DEFAULT 0,
            commission_cents bigint NOT NULL DEFAULT 0,
            payout_cents bigint NOT NULL DEFAULT 0,
            iban text,
            status varchar(30) NOT NULL DEFAULT 'offen',
            proof_url text,
            paid_at timestamp,
            notes text,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `).catch(() => {})
        // BonusPunkte.md §3.8: per-period breakdown so the Billing "Finanzamt" tab (superuser) can
        // sum these across sellers and get the exact same numbers as each seller's own Provisionsrechnung
        // (Tab 3 = Σ of Tab 2 rows), instead of recomputing independently from store_orders.
        await client.query(`ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS customer_paid_cents bigint NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS bonus_funding_cents bigint NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS commission_vat_cents bigint NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS refund_cents bigint NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`ALTER TABLE seller_payouts ADD COLUMN IF NOT EXISTS order_count integer NOT NULL DEFAULT 0`).catch(() => {})
        // Non-payout ledger adjustments against a seller's account (e.g. shipping label charges) —
        // netted out of their next payout instead of moving real money at charge time when they
        // have enough unpaid revenue to cover it; otherwise the seller's saved card is charged.
        await client.query(`
          CREATE TABLE IF NOT EXISTS seller_ledger_adjustments (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            seller_id text NOT NULL,
            type text NOT NULL,
            amount_cents integer NOT NULL,
            description_key text NOT NULL,
            description_params jsonb DEFAULT '{}',
            order_id uuid REFERENCES store_orders(id),
            charge_method text,
            stripe_payment_intent_id text,
            settled_payout_id uuid,
            created_at timestamptz DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_seller_ledger_adjustments_seller ON seller_ledger_adjustments(seller_id)`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS seller_payout_auto_runs (
            run_key varchar(64) PRIMARY KEY,
            period_start date NOT NULL,
            period_end date NOT NULL,
            executed_at timestamp NOT NULL DEFAULT now(),
            source_iban text,
            created_count integer NOT NULL DEFAULT 0
          );
        `).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS seller_invitations (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            email varchar(255) UNIQUE NOT NULL,
            invited_by_seller_id varchar(255) NOT NULL,
            token varchar(255) UNIQUE NOT NULL,
            expires_at timestamp NOT NULL,
            accepted_at timestamp,
            created_at timestamp DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_customer_discounts (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            customer_id uuid NOT NULL REFERENCES store_customers(id) ON DELETE CASCADE,
            code varchar(100) NOT NULL,
            type varchar(20) NOT NULL DEFAULT 'percentage',
            value numeric(10,2) NOT NULL DEFAULT 0,
            min_order_cents integer DEFAULT 0,
            max_uses integer DEFAULT 1,
            used_count integer DEFAULT 0,
            expires_at timestamp,
            notes text,
            created_at timestamp DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_customer_bonus_ledger (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            customer_id uuid NOT NULL REFERENCES store_customers(id) ON DELETE CASCADE,
            occurred_at timestamptz NOT NULL DEFAULT now(),
            points_delta integer NOT NULL,
            description text NOT NULL,
            source varchar(40) NOT NULL DEFAULT 'manual',
            order_id uuid REFERENCES store_orders(id) ON DELETE SET NULL,
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now()
          );
        `).catch(() => {})
        await client.query('CREATE INDEX IF NOT EXISTS idx_store_customer_bonus_ledger_customer ON store_customer_bonus_ledger(customer_id)').catch(() => {})
        // BonusPunkte.md §3.3 — one ledger row per (order, event-type) for the 4 sources that can only
        // legitimately happen once per order (earn/redeem at checkout, cancel-earn/cancel-redeem at
        // cancellation). Prevents a double webhook/double-cancel call from crediting or debiting twice.
        // order_return_earn/order_return_redeem are excluded here on purpose — a single order can have
        // several partial refunds over time (§3.4, not yet implemented), each needing its own row; that
        // work will add a return_id column and its own uniqueness scope instead of reusing this index.
        // If this fails (existing duplicate rows in production), it silently no-ops like every other
        // migration in this file — check logs after deploy and clean up duplicates manually if needed.
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_bonus_ledger_order_source_unique
          ON store_customer_bonus_ledger (order_id, source)
          WHERE order_id IS NOT NULL AND source IN ('order_earn', 'order_redeem', 'order_cancel_earn', 'order_cancel_redeem')
        `).catch(() => {})
        // return_id column + its unique index live further down, right after store_returns is
        // created (search "BonusPunkte.md §3.4") — store_returns doesn't exist yet at this point in
        // a fresh database, and the FK would silently fail forever under this file's .catch(()=>{})
        // convention if added here.
        await client.query(`
  CREATE TABLE IF NOT EXISTS store_customers (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_number BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 10001 INCREMENT BY 1),
    email text UNIQUE NOT NULL,
    first_name text,
    last_name text,
    phone text,
    email_marketing_consent boolean DEFAULT false,
    notes text,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  );
`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_customer_wishlist (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            customer_id uuid NOT NULL REFERENCES store_customers(id) ON DELETE CASCADE,
            product_id uuid NOT NULL REFERENCES admin_hub_products(id) ON DELETE CASCADE,
            created_at timestamptz DEFAULT now(),
            UNIQUE(customer_id, product_id)
          );
        `).catch(() => {})
        await client.query('CREATE INDEX IF NOT EXISTS idx_store_customer_wishlist_customer ON store_customer_wishlist(customer_id)').catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_customer_addresses (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            customer_id uuid NOT NULL REFERENCES store_customers(id) ON DELETE CASCADE,
            label text,
            address_line1 text NOT NULL,
            address_line2 text,
            zip_code varchar(20),
            city text,
            country varchar(10),
            is_default_shipping boolean NOT NULL DEFAULT false,
            is_default_billing boolean NOT NULL DEFAULT false,
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now()
          );
        `).catch(() => {})
        await client.query('CREATE INDEX IF NOT EXISTS idx_store_customer_addresses_customer ON store_customer_addresses(customer_id)').catch(() => {})
        await client.query(`ALTER TABLE store_customer_addresses ALTER COLUMN country TYPE varchar(100)`).catch(() => {})
        await client.query(`
          INSERT INTO store_customer_addresses (customer_id, address_line1, address_line2, zip_code, city, country, is_default_shipping, is_default_billing)
          SELECT c.id, c.address_line1, c.address_line2, c.zip_code, c.city, COALESCE(NULLIF(TRIM(c.country), ''), 'DE'), true, true
          FROM store_customers c
          WHERE c.address_line1 IS NOT NULL AND TRIM(c.address_line1) <> ''
            AND NOT EXISTS (SELECT 1 FROM store_customer_addresses a WHERE a.customer_id = c.id)
        `).catch(() => {})
        await client.query(`
  CREATE TABLE IF NOT EXISTS store_returns (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    return_number BIGINT GENERATED ALWAYS AS IDENTITY (START WITH 200001 INCREMENT BY 1),
    order_id uuid REFERENCES store_orders(id) ON DELETE SET NULL,
    status varchar(50) NOT NULL DEFAULT 'offen',
    reason text,
    notes text,
    items jsonb,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  );
`).catch(() => {})
        // BonusPunkte.md §3.4 — a single order can have several partial refunds over time, each
        // needing its own order_return_earn/order_return_redeem reversal row. return_id disambiguates
        // them (NULL for every pre-existing row and for every non-return source — untouched).
        await client.query(`ALTER TABLE store_customer_bonus_ledger ADD COLUMN IF NOT EXISTS return_id uuid REFERENCES store_returns(id) ON DELETE SET NULL`).catch(() => {})
        await client.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_bonus_ledger_return_source_unique
          ON store_customer_bonus_ledger (return_id, source)
          WHERE return_id IS NOT NULL AND source IN ('order_return_earn', 'order_return_redeem')
        `).catch(() => {})
        // Migrations: add refund fields to store_returns
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS refund_amount_cents integer`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS refund_status varchar(50)`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS refund_note text`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS approved_at timestamp`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS rejected_at timestamp`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS label_sent_at timestamp`).catch(() => {})
        // Auto-generated Sendcloud/DHL return label (created at return-request time, see return-label.js)
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS label_url text`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS label_tracking_number varchar(100)`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS label_carrier_name varchar(100)`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS label_created_at timestamp`).catch(() => {})
        // Seller is only billed once the return parcel actually moves in the carrier network
        // (webhook-detected), never at label-creation time — see webhooks.js /webhook/sendcloud.
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS label_cost_cents integer`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS label_first_status_id integer`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS label_charge_status varchar(20) DEFAULT 'pending'`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS label_charged_at timestamp`).catch(() => {})
        // TASK-13: product-based returns + seller_pays vs customer_ships
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS seller_id varchar(255)`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS return_method varchar(40) DEFAULT 'seller_pays'`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS customer_tracking_number varchar(120)`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS customer_carrier_name varchar(100)`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS customer_tracking_at timestamp`).catch(() => {})
        await client.query(`ALTER TABLE store_returns ADD COLUMN IF NOT EXISTS received_at timestamp`).catch(() => {})
        await client.query(`ALTER TABLE store_orders ADD COLUMN IF NOT EXISTS order_status varchar(50) DEFAULT 'offen'`).catch(() => {})

        await client.query(`
          CREATE TABLE IF NOT EXISTS store_order_items (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            order_id uuid NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
            variant_id text,
            product_id text,
            quantity integer NOT NULL DEFAULT 1 CHECK (quantity > 0),
            unit_price_cents integer NOT NULL DEFAULT 0,
            title text,
            thumbnail text,
            product_handle text,
            created_at timestamp DEFAULT now(),
            updated_at timestamp DEFAULT now()
          );
        `)

        await client.query('CREATE INDEX IF NOT EXISTS idx_store_order_items_order_id ON store_order_items(order_id);')
        await client.query(`ALTER TABLE store_order_items ADD COLUMN IF NOT EXISTS seller_id varchar(255)`).catch(() => {})
        await client.query(`
          UPDATE store_order_items oi
          SET seller_id = p.seller_id
          FROM admin_hub_products p
          WHERE (oi.seller_id IS NULL OR TRIM(COALESCE(oi.seller_id, '')) = '')
            AND oi.product_id IS NOT NULL
            AND p.id::text = oi.product_id::text
            AND p.seller_id IS NOT NULL
            AND TRIM(p.seller_id) <> ''
            AND TRIM(p.seller_id) <> 'default'
        `).catch(() => {})
        await client.query('CREATE INDEX IF NOT EXISTS idx_store_orders_payment_intent_id ON store_orders(payment_intent_id);')
        await client.query(`
          CREATE TABLE IF NOT EXISTS store_product_reviews (
            id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
            order_id uuid NOT NULL REFERENCES store_orders(id) ON DELETE CASCADE,
            product_id text NOT NULL,
            customer_id uuid REFERENCES store_customers(id) ON DELETE SET NULL,
            rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
            comment text,
            customer_name text,
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now(),
            UNIQUE(order_id, product_id)
          );
        `).catch(() => {})
        await client.query(`
  CREATE TABLE IF NOT EXISTS store_shipping_groups (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    carrier_id uuid REFERENCES store_shipping_carriers(id) ON DELETE SET NULL,
    name varchar(200) NOT NULL,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  );
`).catch(() => {})
        await client.query(`
  CREATE TABLE IF NOT EXISTS store_shipping_prices (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id uuid NOT NULL REFERENCES store_shipping_groups(id) ON DELETE CASCADE,
    country_code varchar(10) NOT NULL,
    price_cents integer NOT NULL DEFAULT 0,
    created_at timestamp DEFAULT now(),
    UNIQUE(group_id, country_code)
  );
`).catch(() => {})
        await client.query(`ALTER TABLE store_shipping_groups ADD COLUMN IF NOT EXISTS seller_id varchar(255) DEFAULT NULL`).catch(() => {})
        await client.query(`ALTER TABLE store_shipping_groups ADD COLUMN IF NOT EXISTS return_method varchar(40) DEFAULT 'seller_pays'`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS return_address jsonb DEFAULT '{}'::jsonb`).catch(() => {})
        await client.query(`ALTER TABLE store_order_items ADD COLUMN IF NOT EXISTS product_id text`).catch(() => {})
        // Backfill product_id for old order items that have a product_handle
        await client.query(`
          UPDATE store_order_items soi
          SET product_id = p.id::text
          FROM admin_hub_products p
          WHERE soi.product_id IS NULL
            AND soi.product_handle IS NOT NULL
            AND soi.product_handle <> ''
            AND p.handle = soi.product_handle
        `).catch(() => {})
        await client.query('CREATE INDEX IF NOT EXISTS idx_store_product_reviews_product ON store_product_reviews(product_id)').catch(() => {})
        await client.query('CREATE INDEX IF NOT EXISTS idx_store_product_reviews_customer ON store_product_reviews(customer_id)').catch(() => {})
        await client.query(`ALTER TABLE store_product_reviews ADD COLUMN IF NOT EXISTS seller_id varchar(255)`).catch(() => {})
        await client.query('CREATE INDEX IF NOT EXISTS idx_store_product_reviews_seller ON store_product_reviews(seller_id)').catch(() => {})
        await client.query(`UPDATE store_product_reviews r SET seller_id = p.seller_id FROM admin_hub_products p WHERE r.seller_id IS NULL AND p.id::text = r.product_id`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS review_avg numeric(4,2)`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS review_count integer NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`
          INSERT INTO admin_hub_seller_settings (seller_id, review_avg, review_count, updated_at)
          SELECT r.seller_id,
                 ROUND(AVG(r.rating)::numeric, 2)::float,
                 COUNT(*)::int,
                 now()
          FROM store_product_reviews r
          WHERE r.seller_id IS NOT NULL AND TRIM(COALESCE(r.seller_id, '')) <> ''
          GROUP BY r.seller_id
          ON CONFLICT (seller_id) DO UPDATE SET
            review_avg = EXCLUDED.review_avg,
            review_count = EXCLUDED.review_count,
            updated_at = now()
        `).catch(() => {})
        await client.query(`
  CREATE TABLE IF NOT EXISTS admin_hub_landing_page (
    id INTEGER PRIMARY KEY DEFAULT 1,
    containers JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`).catch(() => {})
        await client.query(`
  CREATE TABLE IF NOT EXISTS admin_hub_landing_pages (
    page_id varchar(100) PRIMARY KEY,
    containers JSONB NOT NULL DEFAULT '[]',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`).catch(() => {})
        await client.query(`
  CREATE TABLE IF NOT EXISTS admin_hub_landing_categories (
    category_id varchar(255) PRIMARY KEY,
    containers JSONB NOT NULL DEFAULT '[]',
    settings JSONB NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_landing_page ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_landing_pages ADD COLUMN IF NOT EXISTS settings JSONB NOT NULL DEFAULT '{}'::jsonb`).catch(() => {})
        await client.query(`
  CREATE TABLE IF NOT EXISTS admin_hub_styles (
    key varchar(50) PRIMARY KEY,
    value JSONB
  );
`).catch(() => {})
        // Seller users table for authentication
        await client.query(`
  CREATE TABLE IF NOT EXISTS seller_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email varchar(255) UNIQUE NOT NULL,
    password_hash varchar(255) NOT NULL,
    store_name varchar(255) DEFAULT '',
    seller_id varchar(255) UNIQUE NOT NULL,
    is_superuser boolean DEFAULT false,
    created_at timestamp DEFAULT now(),
    updated_at timestamp DEFAULT now()
  );
`).catch(() => {})
        // Seller product groups (dynamic product groups for campaigns)
        await client.query(`
          CREATE TABLE IF NOT EXISTS seller_product_groups (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            seller_id text NOT NULL,
            name text NOT NULL,
            description text DEFAULT '',
            product_ids jsonb NOT NULL DEFAULT '[]',
            filter_rules jsonb DEFAULT '{}',
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_spg_seller ON seller_product_groups(seller_id)`).catch(() => {})
        // Product badges (superuser-managed text badges shown on product images: Sale, Bestseller, etc.)
        await client.query(`
          CREATE TABLE IF NOT EXISTS admin_hub_product_badges (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            label text NOT NULL,
            position text NOT NULL DEFAULT 'top-left',
            bg_color text DEFAULT '#e53935',
            text_color text DEFAULT '#ffffff',
            font_size int DEFAULT 12,
            border_width int DEFAULT 0,
            border_color text DEFAULT '#000000',
            border_radius int DEFAULT 4,
            offset_x int DEFAULT 8,
            offset_y int DEFAULT 8,
            target_type text NOT NULL DEFAULT 'product',
            product_id text,
            group_id uuid,
            api_rule text,
            api_category_id text,
            active boolean DEFAULT true,
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now()
          );
        `).catch(() => {})
        // Per-locale badge content: text-vs-image mode, a DE-default image, and an i18n blob
        // ({en: {label, image_url}, tr: {...}, ...}) — same _i18n[locale][field] convention
        // used by landing containers, falls back to the root label/image_url for DE.
        await client.query(`ALTER TABLE admin_hub_product_badges ADD COLUMN IF NOT EXISTS badge_type text NOT NULL DEFAULT 'text';`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_product_badges ADD COLUMN IF NOT EXISTS image_url text;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_product_badges ADD COLUMN IF NOT EXISTS i18n jsonb;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_product_badges ADD COLUMN IF NOT EXISTS image_width int;`).catch(() => {})
        await client.query(`ALTER TABLE admin_hub_product_badges ADD COLUMN IF NOT EXISTS image_height int;`).catch(() => {})
        // Text badges never used image_width in the UI (unused default 22) — clear so
        // optional width/height controls mean "auto" until the merchant sets them.
        await client.query(`
          UPDATE admin_hub_product_badges
             SET image_width = NULL
           WHERE COALESCE(badge_type, 'text') = 'text'
             AND image_height IS NULL
             AND image_width = 22
        `).catch(() => {})
        try {
          const { seedDefaultProductBadges } = require('./src/product-badges-seed')
          const seedRes = await seedDefaultProductBadges(client)
          if (seedRes?.inserted) {
            console.log(`[seed-product-badges] inserted ${seedRes.inserted} default api badge(s)`)
          }
        } catch (e) {
          console.warn('[seed-product-badges]', e?.message || e)
        }
        try {
          const { ensureBecomeSellerLanding } = require('./src/become-seller-landing-seed')
          const bs = await ensureBecomeSellerLanding(client)
          if (bs?.seeded) {
            console.log(`[seed-become-seller] page=${bs.pageId} containers=${bs.added}${bs.created ? ' (page created)' : ''}`)
          }
        } catch (e) {
          console.warn('[seed-become-seller]', e?.message || e)
        }
        try {
          const { ensureCustomerSupportLanding } = require('./src/customer-support-landing-seed')
          const cs = await ensureCustomerSupportLanding(client)
          if (cs?.created || cs?.migrated || cs?.stripped) {
            console.log(`[seed-customer-support] created=${!!cs.created} migrated=${!!cs.migrated} stripped=${cs.stripped || 0} containers=${cs.added || 0}`)
          }
        } catch (e) {
          console.warn('[seed-customer-support]', e?.message || e)
        }
        // Seller campaigns (Aktionen/Kampagnen)
        await client.query(`
          CREATE TABLE IF NOT EXISTS seller_campaigns (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            seller_id text NOT NULL,
            name text NOT NULL,
            description text DEFAULT '',
            status text NOT NULL DEFAULT 'draft',
            start_at timestamptz,
            end_at timestamptz,
            discount_type text NOT NULL DEFAULT 'percentage',
            discount_value numeric(10,2) NOT NULL DEFAULT 0,
            target_type text NOT NULL DEFAULT 'products',
            product_ids jsonb NOT NULL DEFAULT '[]',
            group_ids jsonb NOT NULL DEFAULT '[]',
            settings jsonb DEFAULT '{}',
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sc_seller ON seller_campaigns(seller_id)`).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sc_status ON seller_campaigns(status)`).catch(() => {})
        // PPC ad columns on seller_campaigns
        await client.query(`ALTER TABLE seller_campaigns ADD COLUMN IF NOT EXISTS campaign_type text NOT NULL DEFAULT 'internal'`).catch(() => {})
        await client.query(`ALTER TABLE seller_campaigns ADD COLUMN IF NOT EXISTS budget_daily_cents integer NOT NULL DEFAULT 0`).catch(() => {})
        await client.query(`ALTER TABLE seller_campaigns ADD COLUMN IF NOT EXISTS bid_strategy text NOT NULL DEFAULT 'cpc'`).catch(() => {})
        await client.query(`ALTER TABLE seller_campaigns ADD COLUMN IF NOT EXISTS ad_platforms jsonb NOT NULL DEFAULT '[]'`).catch(() => {})
        await client.query(`ALTER TABLE seller_campaigns ADD COLUMN IF NOT EXISTS ad_status text NOT NULL DEFAULT 'draft'`).catch(() => {})
        await client.query(`ALTER TABLE seller_campaigns ADD COLUMN IF NOT EXISTS external_campaign_ids jsonb NOT NULL DEFAULT '{}'`).catch(() => {})
        await client.query(`ALTER TABLE seller_campaigns ADD COLUMN IF NOT EXISTS stripe_charge_id text`).catch(() => {})
        await client.query(`ALTER TABLE seller_campaigns ADD COLUMN IF NOT EXISTS variant_ids jsonb NOT NULL DEFAULT '[]'`).catch(() => {})
        // Platform marketing accounts (superuser-managed)
        await client.query(`
          CREATE TABLE IF NOT EXISTS platform_marketing_accounts (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            platform text NOT NULL,
            display_name text NOT NULL DEFAULT '',
            credentials jsonb NOT NULL DEFAULT '{}',
            is_active boolean NOT NULL DEFAULT true,
            created_at timestamptz DEFAULT now(),
            updated_at timestamptz DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pma_platform ON platform_marketing_accounts(platform)`).catch(() => {})
        await client.query(`
          CREATE TABLE IF NOT EXISTS shop_live_presence (
            session_id varchar(64) PRIMARY KEY,
            ip_address varchar(45),
            country_code varchar(8),
            city varchar(120),
            region varchar(120),
            page_path text,
            page_title text,
            referrer text,
            user_agent text,
            device_type varchar(20),
            first_seen_at timestamptz NOT NULL DEFAULT now(),
            last_seen_at timestamptz NOT NULL DEFAULT now()
          );
        `).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_shop_live_presence_last_seen ON shop_live_presence(last_seen_at DESC)`).catch(() => {})
        await client.query(`CREATE INDEX IF NOT EXISTS idx_shop_live_presence_country ON shop_live_presence(country_code)`).catch(() => {})
        const { initializeSupportCaseSchema } = require('./src/support-case-schema')
        await initializeSupportCaseSchema(client)
        await client.end()
        log.info('Admin Hub and support-case tables ready')
      } catch (migErr) {
        console.warn('Admin Hub migration (menus) skipped or failed:', migErr && migErr.message)
      }
    }

    // ── App Platform migrations ──────────────────────────────────────────────
    {
      const _apDbClient = () => {
        const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
        if (!dbUrl || !dbUrl.startsWith('postgres')) return null
        const { Client } = require('pg')
        const isRender = dbUrl.includes('render.com')
        return new Client({ connectionString: dbUrl, ssl: isRender ? { rejectUnauthorized: false } : false })
      }
      const apClient = _apDbClient()
      try {
        await apClient.connect()
        await apClient.query(`
          CREATE TABLE IF NOT EXISTS developers (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            company_name TEXT,
            country TEXT,
            vat_number TEXT,
            is_superuser_developer BOOLEAN NOT NULL DEFAULT FALSE,
            stripe_account_id TEXT,
            dpa_accepted_at TIMESTAMPTZ,
            email_verified_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `).catch(() => {})
        await apClient.query(`CREATE INDEX IF NOT EXISTS idx_developers_email ON developers(email)`).catch(() => {})

        await apClient.query(`
          CREATE TABLE IF NOT EXISTS platform_apps (
            id TEXT PRIMARY KEY,
            developer_id TEXT NOT NULL REFERENCES developers(id) ON DELETE RESTRICT,
            handle TEXT UNIQUE NOT NULL,
            type TEXT NOT NULL DEFAULT 'integration_app',
            client_id TEXT UNIQUE NOT NULL,
            client_secret_hash TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            current_version_id TEXT,
            install_count INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `).catch(() => {})
        await apClient.query(`CREATE INDEX IF NOT EXISTS idx_platform_apps_handle ON platform_apps(handle)`).catch(() => {})
        await apClient.query(`CREATE INDEX IF NOT EXISTS idx_platform_apps_developer ON platform_apps(developer_id)`).catch(() => {})
        await apClient.query(`CREATE INDEX IF NOT EXISTS idx_platform_apps_status ON platform_apps(status)`).catch(() => {})

        await apClient.query(`
          CREATE TABLE IF NOT EXISTS platform_app_versions (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES platform_apps(id) ON DELETE CASCADE,
            version TEXT NOT NULL,
            manifest JSONB NOT NULL,
            changelog TEXT,
            submitted_at TIMESTAMPTZ,
            approved_at TIMESTAMPTZ,
            approved_by TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (app_id, version)
          )
        `).catch(() => {})

        await apClient.query(`
          CREATE TABLE IF NOT EXISTS platform_app_installations (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES platform_apps(id) ON DELETE CASCADE,
            seller_id TEXT NOT NULL,
            version_id TEXT REFERENCES platform_app_versions(id),
            scopes TEXT[] NOT NULL DEFAULT '{}',
            settings JSONB NOT NULL DEFAULT '{}',
            installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            uninstalled_at TIMESTAMPTZ,
            UNIQUE (app_id, seller_id)
          )
        `).catch(() => {})
        await apClient.query(`CREATE INDEX IF NOT EXISTS idx_pai_seller ON platform_app_installations(seller_id)`).catch(() => {})
        await apClient.query(`CREATE INDEX IF NOT EXISTS idx_pai_app ON platform_app_installations(app_id)`).catch(() => {})

        await apClient.query(`
          CREATE TABLE IF NOT EXISTS platform_oauth_codes (
            id TEXT PRIMARY KEY,
            code_hash TEXT UNIQUE NOT NULL,
            app_id TEXT NOT NULL REFERENCES platform_apps(id) ON DELETE CASCADE,
            seller_id TEXT NOT NULL,
            scopes TEXT[] NOT NULL DEFAULT '{}',
            redirect_uri TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            used_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `).catch(() => {})
        await apClient.query(`CREATE INDEX IF NOT EXISTS idx_poc_code ON platform_oauth_codes(code_hash)`).catch(() => {})

        await apClient.query(`
          CREATE TABLE IF NOT EXISTS platform_app_tokens (
            id TEXT PRIMARY KEY,
            installation_id TEXT NOT NULL REFERENCES platform_app_installations(id) ON DELETE CASCADE,
            access_token_hash TEXT UNIQUE NOT NULL,
            refresh_token_hash TEXT UNIQUE,
            scopes TEXT[] NOT NULL DEFAULT '{}',
            expires_at TIMESTAMPTZ NOT NULL,
            revoked_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `).catch(() => {})
        await apClient.query(`CREATE INDEX IF NOT EXISTS idx_pat_access ON platform_app_tokens(access_token_hash)`).catch(() => {})
        await apClient.query(`CREATE INDEX IF NOT EXISTS idx_pat_refresh ON platform_app_tokens(refresh_token_hash)`).catch(() => {})
        await apClient.query(`CREATE INDEX IF NOT EXISTS idx_pat_install ON platform_app_tokens(installation_id)`).catch(() => {})

        await apClient.query(`
          CREATE TABLE IF NOT EXISTS platform_app_webhook_subscriptions (
            id TEXT PRIMARY KEY,
            installation_id TEXT NOT NULL REFERENCES platform_app_installations(id) ON DELETE CASCADE,
            event TEXT NOT NULL,
            endpoint_url TEXT NOT NULL,
            is_active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `).catch(() => {})

        await apClient.query(`
          CREATE TABLE IF NOT EXISTS platform_app_reviews (
            id TEXT PRIMARY KEY,
            app_id TEXT NOT NULL REFERENCES platform_apps(id) ON DELETE CASCADE,
            version_id TEXT REFERENCES platform_app_versions(id),
            reviewer_id TEXT,
            status TEXT NOT NULL,
            notes TEXT,
            reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `).catch(() => {})

        await apClient.query(`ALTER TABLE seller_users ADD COLUMN IF NOT EXISTS developer_id TEXT REFERENCES developers(id)`).catch(() => {})
        await apClient.end()
        log.info('App Platform tables ready')
      } catch (e) {
        try { await apClient.end() } catch (_) {}
        console.warn('App Platform migration skipped:', e?.message)
      }
    }

    // Proje loader'ları: adminHubService ve regionService container'a register edilir (.js = Render'da güvenilir)
    try {
      const adminHubServiceLoader = require(path.join(__dirname, 'loaders', 'admin-hub-service-loader.js'))
      const load = adminHubServiceLoader.default || adminHubServiceLoader
      await load(container)
    } catch (e) {
      console.error('adminHubServiceLoader failed:', e && e.message)
      if (e && e.stack) console.error(e.stack)
    }
    try {
      const regionServiceLoader = require(path.join(__dirname, 'loaders', 'region-service-loader.js'))
      const loadRegion = regionServiceLoader.default || regionServiceLoader
      await loadRegion(container)
    } catch (e) {
      console.error('regionServiceLoader failed:', e && e.message)
      if (e && e.stack) console.error(e.stack)
    }

    // Custom route'lar için scope (container kullan; adminHubService, regionService, productService)
    httpApp.use(['/admin-hub', '/admin', '/store'], (req, res, next) => {
      if (!req.scope) req.scope = container
      next()
    })

    // --- Seller Auth: extracted to src/routes/seller-auth.js ---
    // seller-auth.js's module.exports IS createSellerAuthRouter itself (static props attached to the function) —
    // destructuring createSellerAuthRouter as a property of the require() result gave `undefined`.
    const createSellerAuthRouter = require('./src/routes/seller-auth')
    const { requireSellerAuth, requireSuperuser, verifySellerToken, signSellerToken, createSellerSession, validatePasswordStrength, encryptTotp, decryptTotp, hashSellerPassword, verifySellerPassword, getSellerDbClient } = createSellerAuthRouter
    // ── Auth gatekeeper for /admin-hub (S1.3) ─────────────────────────────
    // Default-deny on every /admin-hub/* request: must carry a valid seller
    // bearer token via requireSellerAuth (see ~line 5630) UNLESS the path
    // matches a known-public pattern below.
    //
    // Adding a new public endpoint requires updating ADMIN_HUB_PUBLIC_PATTERNS.
    // requireSellerAuth is a function declaration (hoisted within this scope)
    // so it is callable here at request time even though it is defined later
    // in the file.
    const ADMIN_HUB_PUBLIC_PATTERNS = [
      /^\/auth\/login(\/|\?|$)/,
      /^\/auth\/register(\/|\?|$)/,
      // Billbee integration callbacks use Basic Auth, not seller JWT.
      /^\/v1\/integrations\/billbee\/webhook(\/|\?|$)/,
    ]
    httpApp.use('/admin-hub', (req, res, next) => {
      if (req.method === 'OPTIONS') return next() // CORS preflight
      const reqPath = req.path || '/'
      if (ADMIN_HUB_PUBLIC_PATTERNS.some((re) => re.test(reqPath))) {
        return next()
      }
      return requireSellerAuth(req, res, next)
    })

    // ── Auth gatekeeper for /admin/* (S1.3b) ──────────────────────────────
    // The /admin-hub gatekeeper above does NOT cover /admin/*. Those routes
    // (registered around line 2474+) ARE called by the live sellercentral
    // MedusaAdminClient (see apps/sellercentral/src/lib/medusa-admin-client.js
    // — getProducts, createProduct, getMedusaCollections({adminHub:false}),
    // etc.) and were previously unauthenticated, allowing anyone to read or
    // modify the product catalog. This middleware adds requireSellerAuth on
    // the specific path prefixes we know are ours, leaving the rest of
    // /admin/* (Medusa-managed admin routes, including framework auth flows
    // like /admin/auth/*) untouched.
    const ADMIN_PROTECTED_PREFIXES = [
      '/admin/products',
      '/admin/orders',
      '/admin/collections',
      '/admin/product-categories',
      '/admin/regions',
    ]
    httpApp.use(ADMIN_PROTECTED_PREFIXES, (req, res, next) => {
      if (req.method === 'OPTIONS') return next() // CORS preflight
      return requireSellerAuth(req, res, next)
    })

    // Public store endpoints: stale-while-revalidate cache headers
    // Private paths (cart, orders, customer, payment) must NOT be cached publicly.
    httpApp.use('/store', (req, res, next) => {
      if (req.method !== 'GET') return next()
      const p = req.path // e.g. /products, /products/my-handle, /collections
      // Never cache personal / transactional endpoints
      const noCache = ['/carts', '/orders', '/customers', '/payment', '/wishlist', '/payment-methods', '/public-payment-config']
      if (noCache.some((prefix) => p === prefix || p.startsWith(prefix + '/'))) return next()
      // Menus and categories change rarely
      if (p === '/menus' || p === '/menu-locations') {
        res.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
      } else if (p === '/categories' || p.startsWith('/categories/')) {
        res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=600')
      } else if (p === '/collections' || p.startsWith('/collections/')) {
        res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=600')
      } else if (p === '/brands' || p.startsWith('/brands/')) {
        res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=600')
      } else if (p === '/products' || p.startsWith('/products/')) {
        res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
        res.set('Vary', 'Accept-Encoding')
      } else if (p.startsWith('/seller-settings') || p.startsWith('/seller-profile') || p.startsWith('/approved-seller-ids')) {
        res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300')
      } else if (p.startsWith('/page-by-label-slug/')) {
        res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=3600')
      }
      // All others: no explicit cache header (Express default: no Cache-Control)
      next()
    })

    // --- Categories: extracted to src/routes/categories.js ---
    const {
      resolveAdminHub,
      mapAdminHubCategoryPgRow,
      buildAdminHubCategoryTreeFromFlat,
      localizeCategoriesForRequest,
      localizeSingleCategoryForRequest,
    } = require('./src/categories-helpers')
    const {
      isUuid,
      updateAdminHubCollectionDb,
      deleteAdminHubCollectionDb,
      getAdminHubCollectionByIdDb,
      getAdminHubCollectionByHandleDb,
    } = require('./src/collections-db')
    const createCategoriesRouter = require('./src/routes/categories')
    httpApp.use('/', createCategoriesRouter())

    // --- Affiliate platform tracking (public, no auth): extracted to src/routes/affiliate-track.js ---
    const createAffiliateTrackRouter = require('./src/routes/affiliate-track')
    httpApp.use('/', createAffiliateTrackRouter())

    // --- Admin products/orders + collections: extracted to src/routes/collections.js ---
    const createCollectionsRouter = require('./src/routes/collections')
    httpApp.use('/', createCollectionsRouter())


    // --- Brands + Banners: extracted to src/routes/brands.js ---
    const createBrandsRouter = require('./src/routes/brands')
    httpApp.use('/', createBrandsRouter())

    // --- Metafield Definitions: extracted to src/routes/metafields.js ---
    const createMetafieldsRouter = require('./src/routes/metafields')
    httpApp.use('/', createMetafieldsRouter())

    // --- Admin Hub Menus: extracted to src/routes/menus.js ---
    const createMenusRouter = require('./src/routes/menus')
    httpApp.use('/', createMenusRouter())

    // --- Admin Hub Products: extracted to src/routes/admin-products.js ---
    // admin-products.js's module.exports IS the router factory function itself (with
    // getAdminHubProductByIdOrHandleDb/updateAdminHubProductDb/getProductsDbClient/listAdminHubProductsDb
    // attached as static properties on it) — destructuring `createAdminProductsRouter` as if it
    // were a property of a plain exports object gave `undefined`, causing
    // "TypeError: createAdminProductsRouter is not a function" on every boot.
    const createAdminProductsRouter = require('./src/routes/admin-products')
    const { getAdminHubProductByIdOrHandleDb, updateAdminHubProductDb, getProductsDbClient } = createAdminProductsRouter
    httpApp.use('/', createAdminProductsRouter())

    // --- Seller Settings: extracted to src/routes/seller-settings.js ---
    // seller-settings.js's module.exports IS createSellerSettingsRouter itself (static props attached to it) —
    // destructuring createSellerSettingsRouter as a property of the require() result gave `undefined`.
    const createSellerSettingsRouter = require('./src/routes/seller-settings')
    const { normalizeHubCountryCode, normalizeThresholdsObject, STORE_PUBLISHED_STATUSES, isStorePublishedStatus, storePublishedStatusSql, getSellerStoreName, getApprovedSellerIdsSet, isStoreVisibleSellerProduct } = createSellerSettingsRouter
    httpApp.use('/', createSellerSettingsRouter())

    // ── Seller Auth ───────────────────────────────────────────────────────────
    httpApp.use('/', createSellerAuthRouter())

    // --- Platform Checkout + Store Public: extracted to src/routes/platform-checkout.js ---
    // platform-checkout.js's module.exports IS createPlatformCheckoutRouter itself (static props attached to it) —
    // destructuring createPlatformCheckoutRouter as a property of the require() result gave `undefined`.
    const createPlatformCheckoutRouter = require('./src/routes/platform-checkout')
    const { loadPlatformCheckoutRow, resolveStripeSecretKeyFromPlatform, resolveStripePublishableFromPlatform, paymentMethodTypesFromPlatformRow } = createPlatformCheckoutRouter
    httpApp.use('/', createPlatformCheckoutRouter({ requireSuperuser }))

    // --- Store Products + Brands: extracted to src/routes/store-products.js ---
    // store-products.js's module.exports IS createStoreProductsRouter itself (static props attached to it) —
    // destructuring createStoreProductsRouter as a property of the require() result gave `undefined`.
    const createStoreProductsRouter = require('./src/routes/store-products')
    const { normalizeStoreEan, parseVariantsArray, extractEanFromHubProductRow, resolveUploadUrl, mapAdminHubToStoreProduct, getBestsellerProductIds, isUuidLike, getAdminHubCollectionIdByHandle } = createStoreProductsRouter
    httpApp.use('/', createStoreProductsRouter())

    // --- Store Checkout (carts, payment intent, orders, customers, shipping groups): extracted to src/routes/store-checkout.js ---
    // store-checkout.js's module.exports IS createStoreCheckoutRouter itself (static props attached to it) —
    // destructuring createStoreCheckoutRouter as a property of the require() result gave `undefined`.
    const createStoreCheckoutRouter = require('./src/routes/store-checkout')
    const { verifyCustomerToken, signCustomerToken, customerIdForPg, appendBonusLedger, stripLegacyBonusLedgerVersandSuffix, buildOrderSettlementBreakdown, sellerOrderRevenueBasisCents, resolvePlatformApplicationFeeCents, platformCommissionCentsFromMerchandise, normalizeCouponCode, bonusPointsEarnedFromOrderPaidCents, getOrderWithItems, resolveSellerDisplayNameForStripe, truncateForStripeDescription, computeCartCheckoutMoney } = createStoreCheckoutRouter
    httpApp.use('/', createStoreCheckoutRouter())

    // --- Store Public (collections, categories, menus, page-by-label-slug): extracted to src/routes/store-public.js ---
    const createStorePublicRouter = require('./src/routes/store-public')
    httpApp.use('/', createStorePublicRouter())

    // --- Admin Hub Media: extracted to src/routes/media.js ---
    const createMediaRouter = require('./src/routes/media')
    httpApp.use('/', createMediaRouter())

    // --- Idealo product feed (public, unauthenticated XML — docs/idealo.md): src/routes/idealo-feed.js ---
    const createIdealoFeedRouter = require('./src/routes/idealo-feed')
    httpApp.use('/', createIdealoFeedRouter())

    // Shared Postgres client factory — still used by many not-yet-extracted
    // admin-hub sections below (orders, pages, campaigns, etc.).
    const getDbClient = () => {
      const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      if (!dbUrl || !dbUrl.startsWith('postgres')) return null
      const { Client } = require('pg')
      const isRender = dbUrl.includes('render.com')
      return new Client({ connectionString: dbUrl, ssl: isRender ? { rejectUnauthorized: false } : false })
    }



    // ──────────────────────────────────────────────────────────────────────────

    // --- Sendcloud Platform Config: extracted to src/routes/store-integrations.js ---
    const createStoreIntegrationsRouter = require('./src/routes/store-integrations')
    httpApp.use('/', createStoreIntegrationsRouter())

    // --- Abandoned Carts + Returns: extracted to src/routes/returns.js ---
    const createReturnsRouter = require('./src/routes/returns')
    httpApp.use('/', createReturnsRouter())

    // --- Saved payment methods (list/setup-intent/delete): extracted to src/routes/saved-payment-methods.js ---
    const createSavedPaymentMethodsRouter = require('./src/routes/saved-payment-methods')
    httpApp.use('/', createSavedPaymentMethodsRouter({ loadPlatformCheckoutRow, resolveStripeSecretKeyFromPlatform, verifyCustomerToken }))

    // --- Admin Hub Orders (CRUD, PDFs, live-visitors, store presence heartbeat): extracted to src/routes/orders.js ---
    const createOrdersRouter = require('./src/routes/orders')
    httpApp.use('/', createOrdersRouter({ requireSuperuser }))

    // --- Admin Hub Customers (CRUD + discounts + bonus-ledger) + Shipping Carriers: extracted to src/routes/customers.js ---
    const createCustomersRouter = require('./src/routes/customers')
    httpApp.use('/', createCustomersRouter())

    const createBonusPointsAdminRouter = require('./src/routes/bonus-points-admin')
    httpApp.use('/', createBonusPointsAdminRouter())

    // --- Integrations (trustpilot, generic integrations, billbee credentials/test/webhook, marketplace connection): extracted to src/routes/integrations.js ---
    const createIntegrationsRouter = require('./src/routes/integrations')
    httpApp.use('/', createIntegrationsRouter({ verifySellerToken, requireSuperuser, getSellerDbClient }))

    // --- Admin Hub Pages CRUD + Store pages + Landing Page CMS: extracted to src/routes/pages.js ---
    const createPagesRouter = require('./src/routes/pages')
    httpApp.use('/', createPagesRouter())

    // --- Styles + Public Trustpilot Config: extracted to src/routes/styles.js ---
    const createStylesRouter = require('./src/routes/styles')
    httpApp.use('/', createStylesRouter())




    // --- Notifications (per-recipient read/delete state): extracted to src/routes/notifications.js ---
    const createNotificationsRouter = require('./src/routes/notifications')
    httpApp.use('/', createNotificationsRouter())

    // --- Personalization (product-view tracking + 15-algorithm recommendation engine): src/routes/personalization.js ---
    const { createPersonalizationRouter } = require('./src/routes/personalization')
    httpApp.use('/', createPersonalizationRouter())

    // --- Messages (admin-hub + store + templates) + SMTP settings/senders: extracted to src/routes/messages.js ---
    // getSmtpTransport is also used elsewhere in this file (automations, flow test-email, seller invitations).
    const { createMessagesRouter, getSmtpTransport } = require('./src/routes/messages')
    httpApp.use('/', createMessagesRouter({ verifyCustomerToken, requireSuperuser }))

    // --- Secure customer/seller support cases (legacy store_messages remains read-only here) ---
    const createSupportCasesRouter = require('./src/routes/support-cases')
    httpApp.use('/', createSupportCasesRouter({ verifyCustomerToken }))
    const { startSupportArchiveJob } = require('./src/support-case-schema')
    startSupportArchiveJob()

    // --- Marketing Automations (low_stock_alert/review_request/welcome_email background runner): extracted to src/routes/marketing-automations.js ---
    const createMarketingAutomationsRunner = require('./src/routes/marketing-automations')
    createMarketingAutomationsRunner({ getSmtpTransport })

    // --- Automation flows (flows CRUD, translate, test-email, merge-fields, execution logs): extracted to src/routes/flows.js ---
    const createFlowsRouter = require('./src/routes/flows')
    httpApp.use('/', createFlowsRouter({ requireSuperuser, getSmtpTransport }))

    // --- Coupons: extracted to src/routes/coupons.js ---
    const createCouponsRouter = require('./src/routes/coupons')
    httpApp.use('/', createCouponsRouter({ normalizeCouponCode }))

    // --- Transactions (list) + Commission Invoices (list) + Seller Payout PDF: extracted to src/routes/transactions.js ---
    const createTransactionsRouter = require('./src/routes/transactions')
    httpApp.use('/', createTransactionsRouter({
      sellerOrderRevenueBasisCents,
      resolvePlatformApplicationFeeCents,
      buildOrderSettlementBreakdown,
    }))

    // --- Payouts (CRUD, summary, overview, marketing analytics) + automatic Friday IBAN/SEPA payout runner: extracted to src/routes/payouts.js ---
    const createPayoutsRouter = require('./src/routes/payouts')
    httpApp.use('/', createPayoutsRouter({
      getSellerDbClient,
      loadPlatformCheckoutRow,
      resolveStripeSecretKeyFromPlatform,
    }))

    // mapDhlStatus is also used below by the background tracking refresh job (pure function, no closure state).
    function mapDhlStatus(event) {
      const st = event?.status && typeof event.status === 'object' ? event.status : {}
      const code = String(st.statusCode || event?.statusCode || '').toUpperCase().replace(/-/g, '_')
      const desc = String(st.description || st.status || event?.description || '').toLowerCase()
      // Delivered to door or parcel locker / Filiale pickup (customer has the parcel)
      if (
        code === 'DELIVERED' ||
        code === 'PICKED_UP' ||
        code === 'PICKED_UP_BY_CONSIGNEE' ||
        code === 'CONSIGNMENT_PICKED_UP' ||
        code === 'SUCCESSFULLY_DELIVERED'
      ) return 'zugestellt'
      if (desc.includes('zugestellt') || desc.includes('successfully delivered') || desc.includes('erfolgreich zugestellt')) return 'zugestellt'
      if (desc.includes('abholung in der filiale') || desc.includes('abholung in der packstation')) return 'zugestellt'
      if (desc.includes('filiale') && desc.includes('abholung') && (desc.includes('erfolgt') || desc.includes('erfolgreich'))) return 'zugestellt'
      if (desc.includes('packstation') && (desc.includes('abgeholt') || desc.includes('abholung'))) return 'zugestellt'
      if (desc.includes('wunschfiliale') && desc.includes('bereit')) return 'in_transit'
      if (code === 'OUT_FOR_DELIVERY' || desc.includes('zur zustellung') || desc.includes('out for delivery')) return 'in_transit'
      if (code === 'IN_TRANSIT' || code === 'TRANSIT' || desc.includes('transport') || desc.includes('weitertransport') || desc.includes('in transit')) return 'in_transit'
      if (code === 'EXCEPTION' || desc.includes('ausnahme') || desc.includes('exception') || desc.includes('fehler')) return 'exception'
      if (code === 'PRE_TRANSIT' || desc.includes('aufgegeben') || desc.includes('pre-transit') || desc.includes('vorbereitung') || desc.includes('elektronisch angekündigt')) return 'versendet'
      return 'in_transit'
    }

    // Background tracking refresh: every 3 hours, refresh DHL tracking for all in-transit orders
    const runAutoTrackingRefresh = async () => {
      const client = getDbClient()
      if (!client) return
      try {
        await client.connect()
        const r = await client.query(
          `SELECT o.id, o.seller_id, o.carrier_name, o.tracking_number, o.postal_code
           FROM store_orders o
           WHERE o.tracking_number IS NOT NULL AND o.tracking_number != ''
             AND o.delivery_status NOT IN ('zugestellt', 'storniert')
             AND o.created_at > now() - interval '60 days'
           ORDER BY o.created_at DESC
           LIMIT 200`
        )
        await client.end()
        for (const order of r.rows) {
          const cn = String(order.carrier_name || '').toLowerCase().trim()
          const isDHL = cn === 'dhl' || cn.startsWith('dhl')
          const isDPD = cn === 'dpd' || cn.startsWith('dpd')
          const isGLS = cn === 'gls' || cn.startsWith('gls')
          const isUPS = cn === 'ups' || cn.startsWith('ups')
          if (!isDHL && !isDPD && !isGLS && !isUPS) continue
          try {
            const dbUrl2 = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
            const { Client: PgClient2 } = require('pg')
            const c2 = new PgClient2({ connectionString: dbUrl2, ssl: dbUrl2.includes('render.com') ? { rejectUnauthorized: false } : false })
            await c2.connect()
            const trackingNumber = String(order.tracking_number).trim()
            const https = require('https')
            let bgEvents = []

            if (isDHL) {
              const envDhlKey = (process.env.DHL_API_KEY || process.env.DHL_TRACK_API_KEY || process.env.DHLPARCEL_API_KEY || '').toString().trim()
              // Prefer this order's own seller's DHL config, fall back to the platform-wide entry (seller_id IS NULL)
              const cq = await c2.query(
                `SELECT api_key FROM store_shipping_carriers
                 WHERE LOWER(TRIM(name)) LIKE $1 AND is_active=true AND (seller_id = $2 OR seller_id IS NULL)
                 ORDER BY (seller_id IS NOT NULL) DESC LIMIT 1`,
                ['dhl%', order.seller_id || null]
              )
              const apiKey = (cq.rows[0]?.api_key && String(cq.rows[0].api_key).trim()) || envDhlKey
              if (!apiKey) {
                console.warn(`[runAutoTrackingRefresh] order ${order.id}: DHL tracking skipped — no API key (set store_shipping_carriers.api_key for DHL, or DHL_API_KEY env var)`)
                await c2.end()
                continue
              }
              const pc = String(order.postal_code || '').trim().replace(/\s+/g, '')
              let path = `/track/shipments?trackingNumber=${encodeURIComponent(trackingNumber)}`
              if (pc) path += `&recipientPostalCode=${encodeURIComponent(pc)}`
              const dhlData = await new Promise((resolve) => {
                const req2 = https.request(
                  { hostname: 'api-eu.dhl.com', path, method: 'GET', headers: { 'DHL-API-Key': apiKey, Accept: 'application/json' } },
                  (resp) => { let body = ''; resp.on('data', (d) => { body += d }); resp.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}) } }) }
                )
                req2.on('error', () => resolve({})); req2.end()
              })
              const shipment = dhlData?.shipments?.[0] || null
              const events = Array.isArray(shipment?.events) ? shipment.events : (shipment?.status ? [{ timestamp: shipment.timestamp, status: shipment.status, location: shipment.location }] : [])
              for (const ev of events) {
                const ts = ev.timestamp ? new Date(ev.timestamp).toISOString() : new Date().toISOString()
                const addr = ev.location?.address || {}
                const loc = [addr.addressLocality, addr.countryCode].filter(Boolean).join(', ') || null
                const desc = (ev.description || ev.status?.description || '').trim()
                bgEvents.push({ status: mapDhlStatus(ev), description: desc || null, location: loc, event_time: ts })
              }
            } else if (isDPD) {
              const dpdData = await new Promise((resolve) => {
                const path = `/parcel/${encodeURIComponent(trackingNumber)}/de_DE/parcelstatus`
                const req2 = https.request(
                  { hostname: 'tracking.dpd.de', path, method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } },
                  (resp) => { let body = ''; resp.on('data', d => { body += d }); resp.on('end', () => { try { resolve({ data: JSON.parse(body), ok: resp.statusCode < 400 }) } catch { resolve({ data: {}, ok: false }) } }) }
                )
                req2.on('error', () => resolve({ data: {}, ok: false })); req2.end()
              })
              if (dpdData.ok) {
                for (const step of (dpdData.data?.parcelStatusList || [])) {
                  const desc = (step.label || step.description || '').trim()
                  const ts = step.date ? new Date(`${step.date}T${step.time || '00:00:00'}`).toISOString() : new Date().toISOString()
                  const descLower = desc.toLowerCase()
                  let status = 'in_transit'
                  if (descLower.includes('zugestellt') || descLower.includes('übergeben an') || descLower.includes('delivered')) status = 'zugestellt'
                  else if (descLower.includes('aufgabe') || descLower.includes('übergabe an dpd') || descLower.includes('abgegeben')) status = 'versendet'
                  bgEvents.push({ status, description: desc || null, location: step.city || null, event_time: ts })
                }
              }
            } else if (isGLS) {
              const glsData = await new Promise((resolve) => {
                const path = `/app/service/open/rest/DE/de/rstt001/?match=${encodeURIComponent(trackingNumber)}&type=standard&caller=witt&milis=${Date.now()}`
                const req2 = https.request(
                  { hostname: 'gls-group.com', path, method: 'GET', headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } },
                  (resp) => { let body = ''; resp.on('data', d => { body += d }); resp.on('end', () => { try { resolve({ data: JSON.parse(body), ok: resp.statusCode < 400 }) } catch { resolve({ data: {}, ok: false }) } }) }
                )
                req2.on('error', () => resolve({ data: {}, ok: false })); req2.end()
              })
              if (glsData.ok) {
                for (const tuple of (glsData.data?.tuples || [])) {
                  for (const ev of (tuple.history || [])) {
                    const desc = (ev.evtDscr || ev.description || '').trim()
                    const ts = ev.date ? new Date(`${ev.date}T${ev.time || '00:00'}:00`).toISOString() : new Date().toISOString()
                    const descLower = desc.toLowerCase()
                    let status = 'in_transit'
                    if (descLower.includes('zugestellt') || descLower.includes('delivered')) status = 'zugestellt'
                    else if (descLower.includes('aufgabe') || descLower.includes('einlieferung') || descLower.includes('paketshop')) status = 'versendet'
                    bgEvents.push({ status, description: desc || null, location: ev.location || null, event_time: ts })
                  }
                }
              }
            } else if (isUPS) {
              // Prefer this order's own seller's UPS config, fall back to the platform-wide entry (seller_id IS NULL)
              const cq = await c2.query(
                `SELECT api_key, api_secret FROM store_shipping_carriers
                 WHERE LOWER(TRIM(name)) LIKE $1 AND is_active=true AND (seller_id = $2 OR seller_id IS NULL)
                 ORDER BY (seller_id IS NOT NULL) DESC LIMIT 1`,
                ['ups%', order.seller_id || null]
              )
              const upsKey = (cq.rows[0]?.api_key && String(cq.rows[0].api_key).trim()) || ''
              const upsSecret = (cq.rows[0]?.api_secret && String(cq.rows[0].api_secret).trim()) || ''
              if (!upsKey) {
                console.warn(`[runAutoTrackingRefresh] order ${order.id}: UPS tracking skipped — no API key in store_shipping_carriers`)
              }
              if (upsKey) {
                const creds = Buffer.from(`${upsKey}:${upsSecret}`).toString('base64')
                const tokenBody = 'grant_type=client_credentials'
                const tokenData = await new Promise((resolve) => {
                  const req2 = https.request(
                    { hostname: 'onlinetools.ups.com', path: '/security/v1/oauth/token', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${creds}`, 'Content-Length': Buffer.byteLength(tokenBody) } },
                    (resp) => { let b = ''; resp.on('data', d => { b += d }); resp.on('end', () => { try { resolve(JSON.parse(b)) } catch { resolve({}) } }) }
                  )
                  req2.on('error', () => resolve({})); req2.write(tokenBody); req2.end()
                })
                const accessToken = tokenData.access_token
                if (accessToken) {
                  const upsData = await new Promise((resolve) => {
                    const req2 = https.request(
                      { hostname: 'onlinetools.ups.com', path: `/api/track/v1/details/${encodeURIComponent(trackingNumber)}`, method: 'GET', headers: { Authorization: `Bearer ${accessToken}`, transId: `order-${order.id}`, transactionSrc: 'andertal', Accept: 'application/json' } },
                      (resp) => { let b = ''; resp.on('data', d => { b += d }); resp.on('end', () => { try { resolve({ data: JSON.parse(b), ok: resp.statusCode < 400 }) } catch { resolve({ data: {}, ok: false }) } }) }
                    )
                    req2.on('error', () => resolve({ data: {}, ok: false })); req2.end()
                  })
                  if (upsData.ok) {
                    const activities = upsData.data?.trackResponse?.shipment?.[0]?.package?.[0]?.activity || []
                    for (const act of activities) {
                      const desc = (act.status?.description || '').trim()
                      const loc = [act.location?.address?.city, act.location?.address?.countryCode].filter(Boolean).join(', ') || null
                      const d = act.date || ''; const t = act.time || '000000'
                      const ts = d.length === 8 ? new Date(`${d.slice(0,4)}-${d.slice(4,6)}-${d.slice(6,8)}T${t.slice(0,2)}:${t.slice(2,4)}:${t.slice(4,6)}`).toISOString() : new Date().toISOString()
                      const statusCode = String(act.status?.type || '').toUpperCase()
                      let status = 'in_transit'
                      if (statusCode === 'D' || statusCode === 'P') status = 'zugestellt'
                      else if (statusCode === 'M' || statusCode === 'O') status = 'versendet'
                      bgEvents.push({ status, description: desc || null, location: loc, event_time: ts })
                    }
                  }
                }
              }
            }

            let mostRecentStatus = null
            for (const ev of bgEvents) {
              mostRecentStatus = ev.status
              const exists = await c2.query(
                `SELECT id FROM store_shipment_events WHERE order_id=$1::uuid AND status=$2 AND event_time=$3::timestamptz AND description IS NOT DISTINCT FROM $4 LIMIT 1`,
                [order.id, ev.status, ev.event_time, ev.description || null]
              )
              if (!exists.rows.length) {
                await c2.query(
                  `INSERT INTO store_shipment_events (order_id, status, description, location, event_time, source) VALUES ($1::uuid,$2,$3,$4,$5::timestamptz,'auto')`,
                  [order.id, ev.status, ev.description || null, ev.location || null, ev.event_time]
                )
              }
            }
            let firedTrigger = null
            if (mostRecentStatus === 'zugestellt') {
              const upd = await c2.query(`UPDATE store_orders SET delivery_status='zugestellt', delivery_date=COALESCE(delivery_date,now()), updated_at=now() WHERE id=$1::uuid AND delivery_status != 'zugestellt'`, [order.id])
              await c2.query(`UPDATE store_orders SET order_status='abgeschlossen', updated_at=now() WHERE id=$1::uuid AND payment_status='bezahlt' AND delivery_status='zugestellt' AND order_status NOT IN ('abgeschlossen','retoure','retoure_anfrage','refunded','storniert')`, [order.id])
              if (upd.rowCount > 0) firedTrigger = 'order_delivered'
            } else if (mostRecentStatus === 'versendet' || mostRecentStatus === 'in_transit') {
              const upd = await c2.query(`UPDATE store_orders SET delivery_status='versendet', updated_at=now() WHERE id=$1::uuid AND delivery_status NOT IN ('versendet','zugestellt')`, [order.id])
              if (upd.rowCount > 0) firedTrigger = 'order_shipped'
            }
            await c2.end()
            // Auto-refresh runs outside any request context, so dispatch straight to the flow
            // engine (mirrors dispatchCustomerFlowEvent above) instead of the per-route helpers
            // that only exist inside routes/*.js request handlers.
            if (firedTrigger) {
              const tk = firedTrigger
              const oid = String(order.id)
              try {
                const queued = await enqueueFlowEvent('order-flow-event', { triggerKey: tk, orderId: oid })
                if (!queued) {
                  setImmediate(() => {
                    runAutomationFlowsForOrder({ triggerKey: tk, orderId: oid }).catch((fe) => {
                      console.warn(`[runAutoTrackingRefresh] runAutomationFlowsForOrder ${tk}:`, fe?.message || fe)
                    })
                  })
                }
              } catch (qe) {
                console.warn('[runAutoTrackingRefresh] enqueue order event failed:', qe?.message || qe)
              }
            }
          } catch (e) {
            console.warn(`[runAutoTrackingRefresh] order ${order.id} (${order.carrier_name}) refresh failed:`, e?.message || e)
          }
        }
      } catch (e) {
        console.warn('[runAutoTrackingRefresh] batch query failed:', e?.message || e)
        try { await client.end() } catch (_2) {}
      }
    }
    // Run 5 min after boot, then every 30 min. DHL's approved quota is 250 requests/day — at
    // 48 runs/day that's safe up to ~5 concurrently in-transit DHL orders; if that grows, either
    // lengthen this interval or (better) switch to DHL's Push/webhook product to stop polling
    // entirely — see runAutoTrackingRefresh's DHL branch for where a webhook receiver would replace this.
    setTimeout(() => runAutoTrackingRefresh().catch(() => {}), 5 * 60 * 1000)
    setInterval(() => runAutoTrackingRefresh().catch(() => {}), 30 * 60 * 1000)

    // --- Seller Account (IBAN/profile/account/password) + Subusers/Invites: extracted to src/routes/seller-account.js ---
    const createSellerAccountRouter = require('./src/routes/seller-account')
    httpApp.use('/', createSellerAccountRouter({
      getSellerDbClient,
      loadPlatformCheckoutRow,
      resolveStripeSecretKeyFromPlatform,
      verifySellerPassword,
      hashSellerPassword,
      getSmtpTransport,
    }))

    // --- Seller Error Logs (log/list/report/patch/delete): extracted to src/routes/seller-error-logs.js ---
    // logSellerError (declared as `let` near the top of this file, default no-op) is reassigned here to the
    // real implementation, since it's called from other handlers (e.g. seller order errors) before this point.
    const { createSellerErrorLogsRouter } = require('./src/routes/seller-error-logs')
    const sellerErrorLogsModule = createSellerErrorLogsRouter()
    logSellerError = sellerErrorLogsModule.logSellerError
    httpApp.use('/', sellerErrorLogsModule.router)

    // --- Shipment Events & Tracking + Carrier API (DHL/DPD/GLS/UPS) refresh + Sendcloud label purchase flow: extracted to src/routes/shipment-tracking.js ---
    // Mounted here (not at its original textual position) so logSellerError is captured *after* the real
    // implementation was assigned above, not the no-op default from module load.
    const createShipmentTrackingRouter = require('./src/routes/shipment-tracking')
    httpApp.use('/', createShipmentTrackingRouter({ logSellerError, loadPlatformCheckoutRow, resolveStripeSecretKeyFromPlatform }))

    // Görev 6: müşterinin kendi ERP/sisteminden fatura/lieferschein/retourelabel push edebilmesi
    const createOrderDocumentsRouter = require('./src/routes/order-documents')
    httpApp.use('/', createOrderDocumentsRouter())

    // --- Seller Locations CRUD: extracted to src/routes/seller-locations.js ---
    const createSellerLocationsRouter = require('./src/routes/seller-locations')
    httpApp.use('/', createSellerLocationsRouter())



    // --- Seller Product Groups: extracted to src/routes/product-groups.js ---
    const createProductGroupsRouter = require('./src/routes/product-groups')
    httpApp.use('/', createProductGroupsRouter())

    // --- Product Badges (superuser-only, styling section under content/styles): extracted to src/routes/product-badges.js ---
    const createProductBadgesRouter = require('./src/routes/product-badges')
    httpApp.use('/', createProductBadgesRouter({ requireSuperuser }))

    // --- Seller Campaigns + Google Ads publishing + Automation Rules + Platform Marketing Accounts + store discount lookup: extracted to src/routes/campaigns.js ---
    const createCampaignsRouter = require('./src/routes/campaigns')
    httpApp.use('/', createCampaignsRouter({
      requireSuperuser,
      loadPlatformCheckoutRow,
      resolveStripeSecretKeyFromPlatform,
      getAdminHubProductByIdOrHandleDb,
    }))

    // --- SellerCentral /marketing/affiliate read-only summary: extracted to src/routes/affiliate-seller-marketing.js ---
    const createAffiliateSellerMarketingRouter = require('./src/routes/affiliate-seller-marketing')
    httpApp.use('/', createAffiliateSellerMarketingRouter())

    // --- SellerCentral /affiliate-admin (superuser only): extracted to src/routes/affiliate-admin.js ---
    const createAffiliateAdminRouter = require('./src/routes/affiliate-admin')
    httpApp.use('/', createAffiliateAdminRouter())

    // --- SEO Hub (superuser: entity meta audit / live analyze / auto-generate) ---
    const createSeoHubRouter = require('./src/routes/seo-hub')
    httpApp.use('/', createSeoHubRouter())

    // --- Seller Listings CRUD + Product Change Requests: extracted to src/routes/seller-listings.js ---
    const createSellerListingsRouter = require('./src/routes/seller-listings')
    httpApp.use('/', createSellerListingsRouter())

    // --- Seller Management (superuser: list/detail/update/approve/impersonate + own company-info): extracted to src/routes/sellers.js ---
    const createSellersRouter = require('./src/routes/sellers')
    httpApp.use('/', createSellersRouter({ getSellerDbClient, signSellerToken, createSellerSession }))

    // --- DAC7 / § 12 PStTG Reporting (superuser: preview + XML export): extracted to src/routes/dac7.js ---
    const createDac7Router = require('./src/routes/dac7')
    httpApp.use('/', createDac7Router({ getSellerDbClient }))

    // --- Verification Pipeline (start/status/review): extracted to src/routes/verification.js ---
    const createVerificationRouter = require('./src/routes/verification')
    httpApp.use('/', createVerificationRouter({ getSellerDbClient, getProductsDbClient }))

    // --- Seller Agreement Signing (sign-token/QR, public sign page, auth, submit+PDF, status): extracted to src/routes/seller-agreement.js ---
    const createSellerAgreementRouter = require('./src/routes/seller-agreement')
    httpApp.use('/', createSellerAgreementRouter({ verifySellerPassword, getProductsDbClient }))

    // --- Stripe Connect (onboard/status/dashboard-link/disconnect/manual transfer): extracted to src/routes/stripe-connect.js ---
    const createStripeConnectRouter = require('./src/routes/stripe-connect')
    httpApp.use('/', createStripeConnectRouter({
      getSellerDbClient,
      loadPlatformCheckoutRow,
      resolveStripeSecretKeyFromPlatform,
      requireSuperuser,
      resolvePlatformApplicationFeeCents,
      resolveSellerDisplayNameForStripe,
      truncateForStripeDescription,
    }))

    // --- Seller Credit Card (setup-intent/confirm/get/delete + superuser view/delete): extracted to src/routes/seller-card.js ---
    const createSellerCardRouter = require('./src/routes/seller-card')
    httpApp.use('/', createSellerCardRouter({
      getSellerDbClient,
      loadPlatformCheckoutRow,
      resolveStripeSecretKeyFromPlatform,
      requireSuperuser,
    }))

    // --- Sendcloud webhook (parcel status) + Stripe webhook (payment_intent/checkout.session/charge.refunded/payout.paid/payout.failed): extracted to src/routes/webhooks.js ---
    const createWebhooksRouter = require('./src/routes/webhooks')
    httpApp.use('/', createWebhooksRouter({ getSellerDbClient, loadPlatformCheckoutRow, resolveStripeSecretKeyFromPlatform }))

    // ── Marketplace tables ────────────────────────────────────────────────────
    // dbQ was originally defined here and got removed when the metafields section
    // (which sat right above this block) was extracted to src/routes/metafields.js —
    // that extraction kept its own copy of dbQ, but this block still needs one too.
    const dbQ = async (sql, params = []) => {
      const { Client } = require('pg')
      const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
      const client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
      await client.connect()
      try { const r = await client.query(sql, params); return r } finally { await client.end() }
    }
    await dbQ(`CREATE TABLE IF NOT EXISTS admin_hub_seller_listings (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id  uuid NOT NULL REFERENCES admin_hub_products(id) ON DELETE CASCADE,
      seller_id   varchar(255) NOT NULL,
      price_cents integer NOT NULL DEFAULT 0,
      inventory   integer NOT NULL DEFAULT 0,
      status      varchar(50) NOT NULL DEFAULT 'active',
      orders_count integer NOT NULL DEFAULT 0,
      sku         text,
      shipping_group_id text,
      brand_id    text,
      publish_date text,
      seller_metadata jsonb DEFAULT NULL,
      created_at  timestamptz DEFAULT now(),
      updated_at  timestamptz DEFAULT now(),
      UNIQUE(product_id, seller_id)
    )`).catch(() => {})
    await dbQ(`ALTER TABLE admin_hub_seller_listings ADD COLUMN IF NOT EXISTS sku text`).catch(() => {})
    await dbQ(`ALTER TABLE admin_hub_seller_listings ADD COLUMN IF NOT EXISTS shipping_group_id text`).catch(() => {})
    await dbQ(`ALTER TABLE admin_hub_seller_listings ADD COLUMN IF NOT EXISTS brand_id text`).catch(() => {})
    await dbQ(`ALTER TABLE admin_hub_seller_listings ADD COLUMN IF NOT EXISTS publish_date text`).catch(() => {})
    await dbQ(`ALTER TABLE admin_hub_seller_listings ADD COLUMN IF NOT EXISTS seller_metadata jsonb DEFAULT NULL`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_seller_listings_product ON admin_hub_seller_listings(product_id)`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_seller_listings_seller  ON admin_hub_seller_listings(seller_id)`).catch(() => {})

    // ── ERP Connector Platform (Faz 1: JTL SCX + Billbee) ──────────────────────
    await dbQ(`CREATE TABLE IF NOT EXISTS admin_hub_erp_connections (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seller_id   varchar(255) NOT NULL,
      erp_type    varchar(50) NOT NULL,
      status      varchar(50) NOT NULL DEFAULT 'disconnected',
      config      jsonb DEFAULT '{}'::jsonb,
      linked_at   timestamptz,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      UNIQUE(seller_id, erp_type)
    )`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_erp_connections_seller ON admin_hub_erp_connections(seller_id)`).catch(() => {})

    await dbQ(`CREATE TABLE IF NOT EXISTS admin_hub_erp_sync_state (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seller_id       varchar(255) NOT NULL,
      erp_type        varchar(50) NOT NULL,
      last_full_sync  timestamptz,
      last_delta_sync timestamptz,
      cursor          text,
      updated_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE(seller_id, erp_type)
    )`).catch(() => {})

    await dbQ(`CREATE TABLE IF NOT EXISTS admin_hub_erp_external_map (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seller_id    varchar(255) NOT NULL,
      erp_type     varchar(50) NOT NULL,
      external_id  text NOT NULL,
      entity_type  varchar(50) NOT NULL,
      andertal_id  text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      UNIQUE(seller_id, erp_type, external_id, entity_type)
    )`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_erp_external_map_andertal ON admin_hub_erp_external_map(andertal_id)`).catch(() => {})

    await dbQ(`CREATE TABLE IF NOT EXISTS admin_hub_jtl_sellers (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      seller_id      varchar(255) NOT NULL,
      jtl_seller_id  text NOT NULL,
      company_name   text,
      is_active      boolean NOT NULL DEFAULT true,
      linked_at      timestamptz NOT NULL DEFAULT now(),
      UNIQUE(seller_id),
      UNIQUE(jtl_seller_id)
    )`).catch(() => {})

    await dbQ(`CREATE TABLE IF NOT EXISTS admin_hub_erp_sync_log (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id      text,
      seller_id   varchar(255),
      erp_type    varchar(50) NOT NULL,
      status      varchar(50) NOT NULL,
      counts      jsonb DEFAULT '{}'::jsonb,
      errors      jsonb DEFAULT '[]'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    )`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_erp_sync_log_seller ON admin_hub_erp_sync_log(seller_id, erp_type)`).catch(() => {})

    // ── Customer-supplied documents (Görev 6: satıcı her belge türü için kaynak seçebilir) ──
    // document_sources: { invoice: 'platform'|'customer_api', lieferschein: ..., retourelabel: ... }
    // Eksik/boş anahtar = 'platform' (varsayılan, geriye dönük uyumlu).
    await dbQ(`ALTER TABLE admin_hub_seller_settings ADD COLUMN IF NOT EXISTS document_sources jsonb DEFAULT '{}'::jsonb`).catch(() => {})
    await dbQ(`CREATE TABLE IF NOT EXISTS admin_hub_order_documents (
      id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id       uuid NOT NULL,
      seller_id      varchar(255) NOT NULL,
      document_type  varchar(30) NOT NULL,
      file_url       text NOT NULL,
      filename       text,
      uploaded_via   varchar(50) NOT NULL DEFAULT 'customer_api',
      integration_id uuid,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      UNIQUE(order_id, document_type)
    )`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_order_documents_seller ON admin_hub_order_documents(seller_id)`).catch(() => {})

    await dbQ(`CREATE TABLE IF NOT EXISTS admin_hub_product_change_requests (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      product_id    uuid NOT NULL REFERENCES admin_hub_products(id) ON DELETE CASCADE,
      seller_id     varchar(255) NOT NULL,
      status        varchar(50) NOT NULL DEFAULT 'pending',
      field_name    varchar(255) NOT NULL,
      old_value     text,
      new_value     text NOT NULL,
      reviewer_note text,
      created_at    timestamptz DEFAULT now(),
      updated_at    timestamptz DEFAULT now()
    )`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_change_requests_status ON admin_hub_product_change_requests(status)`).catch(() => {})
    await ensureEuOriginPendingTable(dbQ).catch(() => {})
    await dbQ(`ALTER TABLE store_cart_items ADD COLUMN IF NOT EXISTS seller_id varchar(255)`).catch(() => {})

    // Newsletter subscriber endpoint
    await dbQ(`CREATE TABLE IF NOT EXISTS store_newsletter_subscribers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      source text DEFAULT 'landing_page',
      status text NOT NULL DEFAULT 'active',
      first_name text,
      last_name text,
      preferred_locale varchar(8),
      notes text,
      subscribed_at timestamptz DEFAULT now(),
      unsubscribed_at timestamptz,
      updated_at timestamptz DEFAULT now(),
      UNIQUE(email)
    )`).catch(() => {})
    await dbQ(`ALTER TABLE store_newsletter_subscribers ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'`).catch(() => {})
    await dbQ(`ALTER TABLE store_newsletter_subscribers ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz`).catch(() => {})
    await dbQ(`ALTER TABLE store_newsletter_subscribers ADD COLUMN IF NOT EXISTS first_name text`).catch(() => {})
    await dbQ(`ALTER TABLE store_newsletter_subscribers ADD COLUMN IF NOT EXISTS last_name text`).catch(() => {})
    await dbQ(`ALTER TABLE store_newsletter_subscribers ADD COLUMN IF NOT EXISTS preferred_locale varchar(8)`).catch(() => {})
    await dbQ(`ALTER TABLE store_newsletter_subscribers ADD COLUMN IF NOT EXISTS notes text`).catch(() => {})
    await dbQ(`ALTER TABLE store_newsletter_subscribers ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now()`).catch(() => {})
    await dbQ(`CREATE TABLE IF NOT EXISTS store_newsletter_unsubscribe_tokens (
      token      text PRIMARY KEY,
      email      text NOT NULL,
      locale     varchar(8) NOT NULL DEFAULT 'de',
      created_at timestamptz NOT NULL DEFAULT now(),
      used       boolean NOT NULL DEFAULT false
    )`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_unsub_tokens_email ON store_newsletter_unsubscribe_tokens(email)`).catch(() => {})

    await dbQ(`CREATE TABLE IF NOT EXISTS store_newsletter_email_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      subscriber_id uuid REFERENCES store_newsletter_subscribers(id) ON DELETE SET NULL,
      recipient_email text NOT NULL,
      subject text,
      provider text,
      delivery_status text NOT NULL DEFAULT 'sent',
      flow_trigger_key text,
      sent_at timestamptz DEFAULT now()
    )`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_newsletter_logs_subscriber ON store_newsletter_email_logs(subscriber_id, sent_at DESC)`).catch(() => {})
    // Flow execution log: idempotency + status tracking (incremental, backwards-compatible)
    await dbQ(`CREATE TABLE IF NOT EXISTS store_flow_execution_logs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trigger_key text NOT NULL,
      flow_id uuid REFERENCES admin_hub_flows(id) ON DELETE CASCADE,
      step_order integer NOT NULL DEFAULT 0,
      audience text NOT NULL DEFAULT 'customer',
      recipient_email text,
      order_id uuid REFERENCES store_orders(id) ON DELETE SET NULL,
      customer_id uuid REFERENCES store_customers(id) ON DELETE SET NULL,
      idempotency_key text NOT NULL,
      status text NOT NULL DEFAULT 'pending',
      attempts integer NOT NULL DEFAULT 1,
      error_message text,
      metadata jsonb,
      sent_at timestamptz,
      created_at timestamptz DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      UNIQUE(idempotency_key)
    )`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_flow_exec_trigger_created ON store_flow_execution_logs(trigger_key, created_at DESC)`).catch(() => {})
    await dbQ(`CREATE INDEX IF NOT EXISTS idx_flow_exec_status_created ON store_flow_execution_logs(status, created_at DESC)`).catch(() => {})
    await dbQ(`
      INSERT INTO store_newsletter_subscribers (email, source, status, first_name, last_name, subscribed_at, updated_at)
      SELECT DISTINCT LOWER(TRIM(c.email)) AS email,
             'legacy_customer' AS source,
             'active' AS status,
             NULLIF(TRIM(c.first_name), ''),
             NULLIF(TRIM(c.last_name), ''),
             now(),
             now()
      FROM store_customers c
      WHERE c.email IS NOT NULL
        AND TRIM(c.email) <> ''
        AND (
          COALESCE(c.email_marketing_consent, false) = true
          OR EXISTS (
            SELECT 1
            FROM store_orders o
            WHERE LOWER(TRIM(o.email)) = LOWER(TRIM(c.email))
              AND COALESCE(o.newsletter_opted_in, false) = true
          )
        )
      ON CONFLICT (email) DO NOTHING
    `).catch(() => {})
    // --- Newsletter subscribe/unsubscribe + admin CRUD: extracted to src/routes/newsletter.js ---
    const createNewsletterRouter = require('./src/routes/newsletter')
    httpApp.use('/', createNewsletterRouter({ dispatchCustomerFlowEvent }))

    // --- Ranking API (store/products/ranked, store/events, admin-hub/v1/ranking/*): extracted to src/routes/ranking.js ---
    const createRankingRouter = require('./src/routes/ranking')
    const { router: rankingRouter, computeRankingFeatures } = createRankingRouter({ storePublishedStatusSql })
    httpApp.use('/', rankingRouter)

    // Auto-compute ranking features every 2 hours
    setTimeout(() => {
      computeRankingFeatures().catch(() => {})
      setInterval(() => computeRankingFeatures().catch(() => {}), 2 * 60 * 60 * 1000)
    }, 30 * 1000) // 30s delay after startup

    // Win-back / reorder reminder (trigger 'win_back'): daily scan for lapsed customers.
    setTimeout(() => {
      runWinBackScan().catch(() => {})
      setInterval(() => runWinBackScan().catch(() => {}), 24 * 60 * 60 * 1000)
    }, 60 * 1000) // 60s delay after startup

    // Birthday campaign (trigger 'customer_birthday'): daily scan, sends once per customer per year.
    setTimeout(() => {
      runBirthdayScan().catch(() => {})
      setInterval(() => runBirthdayScan().catch(() => {}), 24 * 60 * 60 * 1000)
    }, 65 * 1000) // 65s delay after startup

    // Review request (trigger 'review_request'): checked every 3 hours so the configured
    // post-delivery wait (default 72h) is honored reasonably closely, same pattern as abandoned_cart.
    setTimeout(() => {
      runReviewRequestScan().catch(() => {})
      setInterval(() => runReviewRequestScan().catch(() => {}), 3 * 60 * 60 * 1000)
    }, 70 * 1000) // 70s delay after startup

    // Wishlist watchers (triggers 'favorite_low_stock' / 'favorite_price_drop'): checked every
    // 15 minutes so a price drop or low-stock crossing reaches favoriting customers promptly.
    setTimeout(() => {
      runProductWishlistWatchers().catch(() => {})
      setInterval(() => runProductWishlistWatchers().catch(() => {}), 15 * 60 * 1000)
    }, 45 * 1000) // 45s delay after startup

    // Abandoned cart (trigger 'abandoned_cart'): no other code path ever fires this trigger, so
    // it needs its own scan — checked every 15 minutes so the flow's configured wait_hours delay
    // (e.g. "1 hr") is honored reasonably closely.
    setTimeout(() => {
      runAbandonedCartScan().catch(() => {})
      setInterval(() => runAbandonedCartScan().catch(() => {}), 15 * 60 * 1000)
    }, 50 * 1000) // 50s delay after startup

    // docs/affiliate.md PR 4 — promotes affiliate_commissions past their 30-day hold to
    // 'confirmed'. Doc calls for a daily cron; every 6h is just a more prompt version of the same
    // idempotent "past confirmable_at → confirmed" check, no different in effect.
    setTimeout(() => {
      const { confirmDueAffiliateCommissions } = require('./src/modules/affiliate-platform/workers/commission-confirm')
      confirmDueAffiliateCommissions().catch(() => {})
      setInterval(() => confirmDueAffiliateCommissions().catch(() => {}), 6 * 60 * 60 * 1000)
    }, 60 * 1000) // 60s delay after startup

    // docs/affiliate.md PR 6 — "cron, ayın 1'i" (Model 1, seller referral, previous calendar
    // month). No cron lib in this codebase (house pattern is setInterval) — check every 6h and
    // only actually run the worker on the 1st of the UTC month; the worker's own idempotency
    // check (an existing commission row for that seller+period) makes firing 4x on that one day
    // harmless rather than needing exact once-a-month timing.
    setTimeout(() => {
      const { runSellerReferralMonthly } = require('./src/modules/affiliate-platform/workers/seller-referral-monthly')
      const runIfFirstOfMonth = () => {
        if (new Date().getUTCDate() !== 1) return
        runSellerReferralMonthly().catch(() => {})
      }
      runIfFirstOfMonth()
      setInterval(runIfFirstOfMonth, 6 * 60 * 60 * 1000)
    }, 70 * 1000) // 70s delay after startup

    // docs/affiliate.md PR 7 — real Stripe transfers. Registering this is safe even before the
    // Steuerberater compliance gate is satisfied: runMonthlyAffiliatePayouts no-ops entirely
    // unless AFFILIATE_PAYOUTS_ENABLED=true (see payout-scheduler.js), which is not set anywhere
    // in this codebase's .env.example — it has to be a deliberate production opt-in.
    setTimeout(() => {
      const { runMonthlyAffiliatePayouts } = require('./src/modules/affiliate-platform/payout-scheduler')
      const runIfFirstOfMonth = () => {
        if (new Date().getUTCDate() !== 1) return
        runMonthlyAffiliatePayouts().catch(() => {})
      }
      runIfFirstOfMonth()
      setInterval(runIfFirstOfMonth, 6 * 60 * 60 * 1000)
    }, 80 * 1000) // 80s delay after startup

    startFlowQueueWorker({
      onOrderEvent: async (jobData) => {
        await runAutomationFlowsForOrder({
          triggerKey: String(jobData?.triggerKey || '').trim(),
          orderId: String(jobData?.orderId || '').trim(),
        })
      },
      onCustomerEvent: async (jobData) => {
        await runAutomationFlowsForCustomerEvent({
          triggerKey: String(jobData?.triggerKey || '').trim(),
          customerId: String(jobData?.customerId || '').trim(),
          email: String(jobData?.email || '').trim(),
        })
      },
    })

    // ── App Platform routes ─────────────────────────────────────────────────
    try {
      const cookieParser = require('cookie-parser')
      httpApp.use(cookieParser())
    } catch (_) {}

    try {
      const createDeveloperApiRouter = require('./src/routes/developer-api')
      httpApp.use('/developer-api/v1', createDeveloperApiRouter())
    } catch (e) { console.warn('developer-api mount failed:', e?.message) }

    try {
      const createAffiliateApiRouter = require('./src/routes/affiliate-api')
      httpApp.use('/affiliate-api/v1', createAffiliateApiRouter())
    } catch (e) { console.warn('affiliate-api mount failed:', e?.message) }

    try {
      const createAppOAuthRouter = require('./src/routes/app-oauth')
      httpApp.use('/oauth', createAppOAuthRouter({ verifySellerToken }))
    } catch (e) { console.warn('app-oauth mount failed:', e?.message) }

    try {
      const createPublicApiV1Router = require('./src/routes/public-api-v1')
      httpApp.use('/api/public-api/v1', createPublicApiV1Router())
    } catch (e) { console.warn('public-api-v1 mount failed:', e?.message) }

    try {
      const createAppStoreRouter = require('./src/routes/app-store')
      httpApp.use('/admin-hub/v1/app-store', createAppStoreRouter())
    } catch (e) { console.warn('app-store mount failed:', e?.message) }

    try {
      const { mountBillbeeMarketplaceApi } = require(path.join(__dirname, 'billbee-marketplace-api'))
      mountBillbeeMarketplaceApi(httpApp, { getSellerDbClient, getProductsDbClient })
    } catch (e) {
      console.warn('Billbee marketplace API mount failed:', e?.message || e)
    }

    // ── Sentry Express error handler (S1.4) ──────────────────────────────
    // Must be added AFTER all route handlers (so it sees their errors) and
    // BEFORE listen(). No-op if Sentry was not initialized (no DSN).
    if (process.env.SENTRY_DSN) {
      try {
        Sentry.setupExpressErrorHandler(httpApp)
      } catch (e) {
        console.warn('Sentry.setupExpressErrorHandler failed:', e?.message || e)
      }
    }

    httpApp.listen(PORT, HOST, () => {
      log.info(`\n✅ Medusa v2 backend başarıyla başlatıldı!`)
      log.info(`📍 Listening on ${HOST}:${PORT}\n`)
    })

    process.on('SIGTERM', () => {
      log.info('\nSIGTERM received, shutting down gracefully')
      httpApp.close(() => { process.exit(0) })
    })
    process.on('SIGINT', () => {
      log.info('\nSIGINT received, shutting down gracefully')
      httpApp.close(() => { process.exit(0) })
    })
  } catch (error) {
    console.error('\n❌ Medusa v2 başlatma hatası:', error.code || error.name, error.message)
    if (error.stack) console.error(error.stack)
    if (error.name === 'KnexTimeoutError' || (error.message && error.message.includes('acquiring a connection'))) {
      console.error('\n💡 PostgreSQL bağlantı hatası. Kontrol edin:')
      console.error('   - PostgreSQL servisi çalışıyor mu? (Windows: Servisler)')
      console.error('   - .env.local içinde DATABASE_URL doğru mu? (postgres://user:pass@localhost:5432/medusa)')
      console.error('   - "medusa" veritabanı oluşturuldu mu? (psql -U postgres -c "CREATE DATABASE medusa;")')
      console.error('   - Backend olmadan çalıştırmak için: npm run dev:web\n')
    }
    process.exit(1)
  }
}

start()
