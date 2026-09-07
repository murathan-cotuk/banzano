/**
 * Runs automation flow emails for order-related triggers (SMTP via store_smtp_settings default).
 * Uses multi-locale templates from admin_hub_flow_steps.email_i18n when present.
 */

const crypto = require('crypto')
const { Client } = require('pg')
const logger = require('./logger')
const { resolveSmtpSenderIdentity } = require('./smtp-sender-resolve')
const { resolveOrderPaidTotalCents } = require('./order-money')
const { resolveFlowMailProvider, resolveResendApiKey, sendFlowOutboundEmail } = require('./email-providers')
const { consumeFlowEmailSlot } = require('./flow-email-rate-limit')

/** Cap retries for a single flow step. Failed abandoned_cart scans used to retry forever
 *  (every 15 min) and each failure emailed info@ via Resend — burning the daily quota. */
const MAX_FLOW_SEND_ATTEMPTS = Math.max(1, parseInt(String(process.env.FLOW_SEND_MAX_ATTEMPTS || '3'), 10) || 3)
const { SUPPORTED_LOCALES: FLOW_EMAIL_LOCALES, resolveLocaleFromCountry: resolveEmailLocaleFromCountry } = require('./locale-from-country')
const { enrichOrderItemRows } = require('./order-items-seller')
const {
  isOrderDispatcherTrigger,
  isMessageDispatcherTrigger,
  isSellerLifecycleTrigger,
  isCustomerAccountTrigger,
  shouldSkipOrderFlowTemplate,
} = require('./flow-triggers')

/** Mirrors apps/shop/src/lib/shop-market.js — URL language segment from market country. */
function storefrontLangFromMarketCountry(market) {
  const m = String(market || 'de').toLowerCase()
  if (['de', 'at', 'ch', 'li', 'lu', 'be'].includes(m)) return 'de'
  if (['fr', 'mc', 'sn', 'ci', 'cm', 'cd'].includes(m)) return 'fr'
  if (['it', 'sm', 'va'].includes(m)) return 'it'
  if (
    ['es', 'mx', 'ar', 'co', 'cl', 'pe', 've', 'ec', 'bo', 'py', 'uy', 'cr', 'gt', 'hn', 'sv', 'ni', 'pa', 'do', 'cu', 'pr'].includes(
      m,
    )
  )
    return 'es'
  if (m === 'tr') return 'tr'
  return 'en'
}

/**
 * Shop canonical URLs: /{market}/{lang}/… (middleware). Derives market from shipping country.
 * Override via env: STOREFRONT_EMAIL_MARKET, STOREFRONT_EMAIL_LANG (ISO2 lowercase).
 */
function storefrontPathPrefixFromShippingCountry(shippingCountryRaw) {
  const envM = String(process.env.STOREFRONT_EMAIL_MARKET || '').trim().toLowerCase()
  const envL = String(process.env.STOREFRONT_EMAIL_LANG || '').trim().toLowerCase()
  const ship = String(shippingCountryRaw || '').trim().toLowerCase()
  const market = /^[a-z]{2}$/.test(envM) ? envM : /^[a-z]{2}$/.test(ship) ? ship : 'de'
  const lang =
    /^[a-z]{2}$/.test(envL) && FLOW_EMAIL_LOCALES.includes(envL) ? envL : storefrontLangFromMarketCountry(market)
  return { market, lang, prefix: `/${market}/${lang}` }
}

function absoluteStorefrontUrl(baseSite, path) {
  const b = String(baseSite || '').replace(/\/$/, '')
  const p = String(path || '')
  if (!b) return ''
  if (!p.startsWith('/')) return `${b}/${p}`
  return `${b}${p}`
}

/** Resend (and most ESP test modes) reject RFC example domains — never attempt to send. */
function isNonDeliverableFlowRecipient(email) {
  const e = String(email || '').trim().toLowerCase()
  if (!e || !e.includes('@')) return true
  const domain = e.split('@').pop() || ''
  if (
    domain === 'example.com' ||
    domain === 'example.org' ||
    domain === 'example.net' ||
    domain === 'test' ||
    domain.endsWith('.example') ||
    domain.endsWith('.invalid') ||
    domain.endsWith('.localhost') ||
    domain === 'localhost'
  ) {
    return true
  }
  // Common E2E / seed placeholders
  if (/^(claude-e2e-test|e2e-test|test\+|noreply\+test)/i.test(e.split('@')[0] || '')) {
    if (domain === 'example.com' || domain.endsWith('.test')) return true
  }
  return false
}

/**
 * Absolute shop URL for emails (flow placeholders). Backend Render jobs often lack Next.js env;
 * accept several aliases used across deployments.
 */
function resolvePublicShopBaseUrl() {
  const candidates = [
    process.env.STOREFRONT_PUBLIC_URL,
    process.env.SHOP_PUBLIC_URL,
    process.env.PUBLIC_SHOP_URL,
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_SHOP_URL,
    process.env.SITE_URL,
  ]
  for (const raw of candidates) {
    const s = String(raw || '').trim().replace(/\/$/, '')
    if (!s) continue
    if (/^https?:\/\//i.test(s)) return s
  }
  const vercel = String(process.env.VERCEL_URL || process.env.NEXT_PUBLIC_VERCEL_URL || '').trim()
  if (vercel) {
    const host = vercel.replace(/^https?:\/\//i, '').replace(/\/$/, '')
    if (host) return `https://${host}`
  }
  return ''
}

function formatEuro(cents) {
  const n = Number(cents)
  if (Number.isNaN(n)) return '0,00 €'
  return `${(n / 100).toFixed(2).replace('.', ',')} €`
}

/** store_order_items.title bakes the variant as a trailing "(...)" at checkout (store-checkout.js) —
 * split it back out so it can render as a smaller, muted note instead of inline in the title. */
function splitItemTitle(title) {
  const s = String(title || '').trim()
  const m = s.match(/^(.*?)\s*\(([^()]+)\)\s*$/)
  if (!m || !m[1].trim()) return { main: s, note: '' }
  return { main: m[1].trim(), note: m[2].trim() }
}

/** Carrier tracking page URL when carrier + number are known (same heuristics as storefront orders page). */
function trackingUrlFromCarrier(carrierRaw, numberRaw) {
  const number = String(numberRaw || '').trim()
  if (!number) return ''
  const c = String(carrierRaw || '').toLowerCase().trim()
  if (c.includes('dhl')) return `https://www.dhl.de/de/privatkunden/dhl-sendungsverfolgung.html?piececode=${encodeURIComponent(number)}`
  if (c.includes('dpd')) return `https://tracking.dpd.de/status/de_DE/parcel/${encodeURIComponent(number)}`
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${encodeURIComponent(number)}`
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(number)}`
  if (c.includes('hermes') || c.includes('evri'))
    return `https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsdetails/#/${encodeURIComponent(number)}`
  if (c.includes('gls')) return `https://gls-group.com/DE/de/paketverfolgung?match=${encodeURIComponent(number)}`
  if (c.includes('post') || c.includes('brief'))
    return `https://www.deutschepost.de/de/s/sendungsverfolgung.html?barcode=${encodeURIComponent(number)}`
  return ''
}

function applyFlowEmailPlaceholders(template, vars) {
  return String(template || '').replace(/\{([A-Za-z0-9_]+)\}/g, (_, rawKey) => {
    const keyUp = String(rawKey).toUpperCase()
    const v = vars[keyUp] ?? vars[String(rawKey)] ?? vars[rawKey]
    // Unknown/empty merge fields (e.g. no tracking number yet) render blank rather than leaving the raw {TOKEN} in the sent email.
    return v == null ? '' : String(v).trim()
  })
}

function flowEmailHtmlToPlainText(html) {
  return String(html || '')
    .replace(/\r\n/g, '\n')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function bundleSubjectB(b) {
  if (!b || typeof b !== 'object') return ''
  return String(b.subject_b || b.subjectAlt || '').trim()
}

/** Picks localized template; optional A/B subject line B per locale ({ subject_b } in bundle). */
function pickStepTemplate(step, locale) {
  const i18n = step.email_i18n
  const tryLocales = [locale, 'en', 'de']
  if (i18n && typeof i18n === 'object') {
    for (const loc of tryLocales) {
      if (!FLOW_EMAIL_LOCALES.includes(loc)) continue
      const b = i18n[loc]
      const subj = String(b?.subject || '').trim()
      const body = String(b?.body || '').trim()
      if (subj && body) {
        const sb = bundleSubjectB(b)
        return { subject: subj, body, subject_b: sb || undefined }
      }
    }
    for (const loc of FLOW_EMAIL_LOCALES) {
      const b = i18n[loc]
      const subj = String(b?.subject || '').trim()
      const body = String(b?.body || '').trim()
      if (subj && body) {
        const sb = bundleSubjectB(b)
        return { subject: subj, body, subject_b: sb || undefined }
      }
    }
  }
  const ls = String(step.email_subject || '').trim()
  const lb = String(step.email_body || '').trim()
  if (ls && lb) return { subject: ls, body: lb }
  return null
}

/** Deterministic A/B from idempotency key so retries keep the same subject line. */
function pickSubjectForAb(idempotencyKey, primary, variantB) {
  const b = String(variantB || '').trim()
  if (!b) return { text: String(primary || '').trim(), variant: null }
  const off = String(process.env.FLOW_AB_SUBJECT_SPLIT || '1').trim().toLowerCase()
  if (off === '0' || off === 'false' || off === 'off') {
    return { text: String(primary || '').trim(), variant: 'a' }
  }
  const digest = crypto.createHash('sha256').update(String(idempotencyKey || '')).digest()
  const useB = digest[0] % 2 === 1
  return useB ? { text: b, variant: 'b' } : { text: String(primary || '').trim(), variant: 'a' }
}

async function getSmtpTransport(client) {
  let nodemailer
  try {
    nodemailer = require('nodemailer')
  } catch {
    return null
  }
  const r = await client.query(`SELECT * FROM store_smtp_settings WHERE seller_id = 'default' LIMIT 1`)
  const s = r.rows[0]
  if (!s?.host || !s?.username) return null
  return nodemailer.createTransport({
    host: s.host,
    port: s.port || 587,
    secure: !!s.secure,
    auth: { user: s.username, pass: s.password_enc || '' },
  })
}

/** Recipient for "admin" audience flows (Content → Flows) — configured in Settings → Platform,
 * distinct from support_email (the customer-facing contact shown inside email bodies). */
async function resolveAdminNotificationEmail(client) {
  const r = await client.query(
    `SELECT admin_notification_email FROM admin_hub_seller_settings WHERE seller_id = 'default' LIMIT 1`,
  )
  return String(r.rows[0]?.admin_notification_email || '').trim() || 'info@andertal.com'
}

function buildFlowStepIdempotencyKey({ triggerKey, flowId, stepOrder, audience, recipientEmail, orderId, customerId, dedupeKey }) {
  const raw = [
    String(triggerKey || '').trim().toLowerCase(),
    String(flowId || '').trim().toLowerCase(),
    String(stepOrder != null ? stepOrder : '').trim(),
    String(audience || '').trim().toLowerCase(),
    String(recipientEmail || '').trim().toLowerCase(),
    String(orderId || '').trim().toLowerCase(),
    String(customerId || '').trim().toLowerCase(),
    // Extra dedup dimension for customer-only events tied to a specific product (favorite_low_stock,
    // favorite_price_drop) — without this, every product would collapse onto the same idempotency key
    // (orderId is always '' for these) and only the first-ever product alert for a customer would send.
    String(dedupeKey || '').trim().toLowerCase(),
  ].join('|')
  return crypto.createHash('sha256').update(raw).digest('hex')
}

/**
 * Claim a send attempt for this idempotency key.
 * Returns { skip: true } when already sent/skipped or permanently failed (attempts exhausted).
 * Does NOT increment attempts for terminal rows (avoids attempt inflation on every 15‑min scan).
 */
async function reserveFlowExecutionLog(client, entry) {
  const idempotencyKey = String(entry.idempotencyKey || '').trim()
  const existing = await client.query(
    `SELECT id, status, attempts, metadata FROM store_flow_execution_logs WHERE idempotency_key = $1 LIMIT 1`,
    [idempotencyKey],
  )
  if (existing.rows[0]) {
    const row = existing.rows[0]
    const status = String(row.status || '')
    const attempts = Number(row.attempts || 0)
    if (status === 'sent' || status === 'skipped') {
      return { id: row.id, status, attempts, skip: true, metadata: row.metadata }
    }
    if (status === 'failed' && attempts >= MAX_FLOW_SEND_ATTEMPTS) {
      return { id: row.id, status, attempts, skip: true, metadata: row.metadata }
    }
    // Atomic claim — concurrent scanners (multi-instance) lose the race cleanly.
    const upd = await client.query(
      `UPDATE store_flow_execution_logs
       SET attempts = attempts + 1,
           status = 'pending',
           error_message = NULL,
           updated_at = now()
       WHERE idempotency_key = $1
         AND status IN ('pending', 'failed')
         AND attempts < $2
       RETURNING id, status, attempts, metadata`,
      [idempotencyKey, MAX_FLOW_SEND_ATTEMPTS],
    )
    if (!upd.rows[0]) {
      const again = await client.query(
        `SELECT id, status, attempts, metadata FROM store_flow_execution_logs WHERE idempotency_key = $1 LIMIT 1`,
        [idempotencyKey],
      )
      const r2 = again.rows[0] || row
      return { id: r2.id, status: r2.status, attempts: r2.attempts, skip: true, metadata: r2.metadata }
    }
    return { ...upd.rows[0], skip: false }
  }
  try {
    const r = await client.query(
      `INSERT INTO store_flow_execution_logs
        (trigger_key, flow_id, step_order, audience, recipient_email, order_id, customer_id, idempotency_key, status, attempts, metadata, created_at, updated_at)
       VALUES
        ($1, $2::uuid, $3, $4, $5, NULLIF($6,'')::uuid, NULLIF($7,'')::uuid, $8, 'pending', 1, $9::jsonb, now(), now())
       RETURNING id, status, attempts, metadata`,
      [
        String(entry.triggerKey || '').trim(),
        String(entry.flowId || '').trim(),
        Number(entry.stepOrder || 0),
        String(entry.audience || '').trim(),
        String(entry.recipientEmail || '').trim().toLowerCase(),
        String(entry.orderId || '').trim(),
        String(entry.customerId || '').trim(),
        idempotencyKey,
        JSON.stringify(entry.metadata || {}),
      ],
    )
    return r.rows[0] ? { ...r.rows[0], skip: false } : null
  } catch (e) {
    // Unique violation — another instance inserted first; re-enter via SELECT path.
    if (e && (e.code === '23505' || /duplicate/i.test(String(e.message || '')))) {
      return reserveFlowExecutionLog(client, entry)
    }
    throw e
  }
}

async function finalizeFlowExecutionLog(client, idempotencyKey, patch) {
  await client.query(
    `UPDATE store_flow_execution_logs
     SET status = $2,
         error_message = $3,
         sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END,
         metadata = COALESCE(metadata, '{}'::jsonb) || $4::jsonb,
         updated_at = now()
     WHERE idempotency_key = $1`,
    [
      String(idempotencyKey || '').trim(),
      String(patch.status || '').trim() || 'pending',
      patch.errorMessage ? String(patch.errorMessage).slice(0, 1500) : null,
      JSON.stringify(patch.metadata || {}),
    ],
  )
}

async function loadOrderContext(client, orderId) {
  const oRes = await client.query(`SELECT * FROM store_orders WHERE id = $1::uuid`, [orderId])
  const orderRaw = oRes.rows[0]
  if (!orderRaw) return null
  const order = { ...orderRaw, total_cents: resolveOrderPaidTotalCents(orderRaw) }
  const iRes = await client.query(
    `SELECT * FROM store_order_items WHERE order_id = $1::uuid ORDER BY created_at ASC`,
    [orderId],
  )
  // enrichOrderItemRows resolves the purchased variant's own sku/ean (store_order_items has
  // no sku/ean columns of its own) — without this, {ITEM_n_SKU} was always blank in emails.
  const items = await enrichOrderItemRows(client, iRes.rows || [])
  let storeName = 'Shop'
  let supportEmail = ''
  const sid = order.seller_id
  let dbStorefrontUrl = ''
  if (sid) {
    const sh = await client.query(
      `SELECT store_name, support_email, storefront_url FROM admin_hub_seller_settings WHERE seller_id = $1 LIMIT 1`,
      [sid],
    )
    if (sh.rows[0]) {
      storeName = String(sh.rows[0].store_name || storeName).trim() || storeName
      supportEmail = String(sh.rows[0].support_email || '').trim()
      dbStorefrontUrl = String(sh.rows[0].storefront_url || '').trim().replace(/\/$/, '')
    }
  }
  const platformRow = await client.query(
    `SELECT storefront_url, platform_name, store_name FROM admin_hub_seller_settings WHERE seller_id = 'default' LIMIT 1`,
  )
  if (!dbStorefrontUrl) {
    dbStorefrontUrl = String(platformRow.rows[0]?.storefront_url || '').trim().replace(/\/$/, '')
  }
  // Marketplace emails must show the platform's own brand as the sender name (not the
  // fulfilling seller's store name, and not the platform seller-settings row's own
  // "store_name" field either — that field is used for other seller-facing purposes
  // and isn't guaranteed to hold the customer-facing brand). Falls straight to the
  // literal brand name so a stray/legacy store_name value can never leak into emails.
  const platformName = String(platformRow.rows[0]?.platform_name || 'Andertal').trim() || 'Andertal'
  const siteUrl = resolvePublicShopBaseUrl() || dbStorefrontUrl
  if (!siteUrl) {
    logger.warn(
      '[flow-automation] Public shop URL missing: set STOREFRONT_PUBLIC_URL on the backend or configure it in Sellercentral → Settings → Plattform — otherwise tokens like {ORDER_DETAIL_URL} stay empty in emails.',
    )
  }
  const parts = []
  for (const it of items) {
    const q = Number(it.quantity || 1)
    const title = String(it.title || 'Item').trim()
    parts.push(`${q}× ${title}`)
  }
  const lineSummary = parts.length ? `${parts.join('; ')} · ${formatEuro(order.total_cents)}` : formatEuro(order.total_cents)
  const first = items[0]
  const productTitle = first ? String(first.title || '').trim() : ''
  const productImage = first?.thumbnail ? String(first.thumbnail).trim() : ''

  const backendUrl = String(process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || process.env.BACKEND_URL || '').replace(/\/$/, '')
  const resolveUrl = (u) => {
    if (!u) return ''
    if (/^https?:\/\//i.test(u)) return u
    return backendUrl ? `${backendUrl}${u.startsWith('/') ? '' : '/'}${u}` : u
  }

  const orderItemsHtml = items.length
    ? `<table style="border-collapse:collapse;width:100%;font-family:inherit;font-size:13px;">\n` +
      items.map((it) => {
        const imgSrc = resolveUrl(it.thumbnail || '')
        const imgTag = imgSrc ? `<img src="${imgSrc}" alt="" width="48" height="48" style="object-fit:cover;border-radius:4px;display:block;" />` : ''
        const qty = Number(it.quantity || 1)
        const price = formatEuro(it.unit_price_cents)
        const { main: titleMain, note: titleNote } = splitItemTitle(it.title)
        const titleHtml = titleNote
          ? `${titleMain}<br/><span style="font-size:11px;color:#9ca3af;">${titleNote}</span>`
          : titleMain
        return `<tr><td style="padding:6px 10px 6px 0;vertical-align:top;width:56px;">${imgTag}</td>` +
          `<td style="padding:6px 0;vertical-align:top;">${titleHtml}</td>` +
          `<td style="padding:6px 0 6px 10px;vertical-align:top;white-space:nowrap;text-align:right;">${qty}× ${price}</td></tr>`
      }).join('\n') +
      `\n</table>`
    : ''

  const prefixParts = storefrontPathPrefixFromShippingCountry(order.country)
  const retRes = await client.query(
    `SELECT return_number, reason, label_url, label_tracking_number, label_carrier_name,
            return_method, seller_id, customer_tracking_number, customer_carrier_name
     FROM store_returns WHERE order_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
    [orderId],
  )
  const returnInfo = retRes.rows[0] || null

  // Build return address HTML for Model B (customer_ships) emails
  let returnAddressHtml = ''
  try {
    const sid = String(returnInfo?.seller_id || order.seller_id || '').trim()
    let addr = null
    if (sid && sid !== 'default') {
      // Prefer Settings → Locations returns purpose
      try {
        const lr = await client.query(
          `SELECT name, address_line1, address_line2, city, postal_code, country
             FROM seller_locations
            WHERE seller_id = $1 AND is_returns_to = true
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1`,
          [sid],
        )
        const loc = lr.rows[0]
        if (loc && String(loc.address_line1 || '').trim()) {
          addr = {
            name: String(loc.name || '').trim(),
            street: [loc.address_line1, loc.address_line2].filter(Boolean).map((x) => String(x).trim()).join(', '),
            zip: String(loc.postal_code || '').trim(),
            city: String(loc.city || '').trim(),
            country: String(loc.country || 'DE').trim(),
          }
        }
      } catch (_) {}
      if (!addr || !String(addr.street || '').trim()) {
        const ar = await client.query(
          `SELECT return_address FROM admin_hub_seller_settings WHERE seller_id = $1 LIMIT 1`,
          [sid],
        )
        addr = ar.rows[0]?.return_address
      }
      if (!addr || typeof addr !== 'object' || !String(addr.street || '').trim()) {
        const su = await client.query(
          `SELECT store_name, company_name, business_address FROM seller_users WHERE seller_id = $1 LIMIT 1`,
          [sid],
        )
        const u = su.rows[0]
        const ba = u?.business_address && typeof u.business_address === 'object' ? u.business_address : {}
        addr = {
          name: String(u?.company_name || u?.store_name || '').trim(),
          street: String(ba.street || ba.address_line1 || '').trim(),
          zip: String(ba.postal_code || ba.zip || '').trim(),
          city: String(ba.city || '').trim(),
          country: String(ba.country || 'DE').trim(),
        }
      }
    }
    if (!addr || !String(addr.street || '').trim()) {
      const plat = await client.query(
        `SELECT legal_company_name, legal_street, legal_city, return_address
           FROM admin_hub_seller_settings WHERE seller_id = 'default' LIMIT 1`,
      )
      const p = plat.rows[0]
      const ra = p?.return_address && typeof p.return_address === 'object' ? p.return_address : null
      addr = ra && String(ra.street || '').trim()
        ? ra
        : {
            name: String(p?.legal_company_name || storeName || 'Andertal').trim(),
            street: String(p?.legal_street || '').trim(),
            zip: '',
            city: String(p?.legal_city || '').trim(),
            country: 'DE',
          }
    }
    if (addr) {
      const lines = [
        String(addr.name || '').trim(),
        String(addr.street || '').trim(),
        [String(addr.zip || '').trim(), String(addr.city || '').trim()].filter(Boolean).join(' '),
        String(addr.country || '').trim(),
      ].filter(Boolean)
      returnAddressHtml = lines.map((l) => String(l).replace(/</g, '&lt;')).join('<br/>')
    }
  } catch (_) {}

  return {
    order,
    items,
    storeName,
    platformName,
    supportEmail,
    siteUrl,
    lineSummary,
    productTitle,
    productImage,
    orderItemsHtml,
    resolveUrl,
    prefixParts,
    returnInfo,
    returnAddressHtml,
  }
}

function salutationVarsFromGender(genderRaw) {
  const g = String(genderRaw || '').trim().toLowerCase()
  const isFemale = ['female', 'f', 'woman', 'w', 'frau'].includes(g)
  const isMale = ['male', 'm', 'man', 'herr'].includes(g)
  const raw = String(genderRaw || '').trim()
  let SALUTATION_DE = ''
  let GREETING_DE = ''
  let SALUTATION_EN = ''
  let GREETING_EN = ''
  let SALUTATION_TR = ''
  let GREETING_TR = ''
  if (isFemale) {
    SALUTATION_DE = 'Frau'
    GREETING_DE = 'Sehr geehrte Frau'
    SALUTATION_EN = 'Ms.'
    GREETING_EN = 'Dear Ms.'
    SALUTATION_TR = 'Bayan'
    GREETING_TR = 'Sayın Bayan'
  } else if (isMale) {
    SALUTATION_DE = 'Herr'
    GREETING_DE = 'Sehr geehrter Herr'
    SALUTATION_EN = 'Mr.'
    GREETING_EN = 'Dear Mr.'
    SALUTATION_TR = 'Bay'
    GREETING_TR = 'Sayın Bay'
  } else {
    GREETING_DE = 'Guten Tag'
    GREETING_EN = 'Hello'
    GREETING_TR = 'Merhaba'
  }
  return {
    GENDER: raw,
    SALUTATION_DE,
    GREETING_DE,
    SALUTATION_EN,
    GREETING_EN,
    SALUTATION_TR,
    GREETING_TR,
  }
}

function overlayCustomerProfile(vars, cust) {
  if (!cust) return
  const fn = String(cust.first_name || '').trim()
  const ln = String(cust.last_name || '').trim()
  const fullName = [fn, ln].filter(Boolean).join(' ') || String(cust.email || '').trim()
  if (fn) vars.FIRST_NAME = fn
  if (ln) vars.LAST_NAME = ln
  if (fullName) {
    vars.CUSTOMER_NAME = fullName
    vars.CUSTOMER = fullName
    if (!vars.SHIPPING_FULL_NAME) vars.SHIPPING_FULL_NAME = fullName
  }
  const em = String(cust.email || '').trim()
  if (em) vars.EMAIL = em
  const ph = String(cust.phone || '').trim()
  if (ph) vars.PHONE = ph
}

function buildPlaceholderVars(ctx, triggerKey, customerProfile = null) {
  const {
    order,
    items,
    storeName,
    platformName,
    supportEmail,
    siteUrl,
    lineSummary,
    productTitle,
    productImage,
    orderItemsHtml,
    resolveUrl,
    prefixParts,
    returnInfo,
  } = ctx
  const fn = String(order.first_name || '').trim()
  const ln = String(order.last_name || '').trim()
  const fullName = [fn, ln].filter(Boolean).join(' ') || String(order.email || '').trim()
  const ordDate = order.created_at ? new Date(order.created_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''
  const shipDate = order.shipped_at ? new Date(order.shipped_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : ''
  const baseSite = String(siteUrl || '').replace(/\/$/, '')
  const { market, lang, prefix } = prefixParts || storefrontPathPrefixFromShippingCountry(order.country)
  const firstHandle = items[0]?.product_handle ? String(items[0].product_handle).trim() : ''
  const orderDetailUrl = order.id ? absoluteStorefrontUrl(baseSite, `${prefix}/order/${order.id}`) : ''
  const trackingUrl = trackingUrlFromCarrier(order.carrier_name, order.tracking_number)
  const vars = {
    CUSTOMER_NAME: fullName,
    CUSTOMER: fullName,
    FIRST_NAME: fn || fullName,
    LAST_NAME: ln,
    EMAIL: String(order.email || '').trim(),
    PHONE: String(order.phone || '').trim(),
    ORDER_NUMBER: String(order.order_number != null ? order.order_number : ''),
    ORDER_ID: String(order.order_number != null ? order.order_number : ''),
    ORDER_UUID: String(order.id || ''),
    ORDER_DATE: ordDate,
    ORDER_TOTAL: formatEuro(order.total_cents),
    ORDER_SUBTOTAL: formatEuro(order.subtotal_cents),
    ORDER_SHIPPING: formatEuro(order.shipping_cents),
    ORDER_DISCOUNT: formatEuro(Math.max(0, Number(order.discount_cents || 0))),
    ORDER_CURRENCY: String(order.currency || 'EUR').toUpperCase(),
    PAYMENT_METHOD: String(order.payment_method || ''),
    SHIPPING_FULL_NAME: fullName,
    ADDRESS_LINE1: String(order.address_line1 || ''),
    ADDRESS_LINE2: String(order.address_line2 || ''),
    CITY: String(order.city || ''),
    POSTAL_CODE: String(order.postal_code || ''),
    ZIP_CODE: String(order.postal_code || ''),
    COUNTRY: String(order.country || ''),
    PRODUCT: productTitle,
    PRODUCT_NAME: productTitle,
    PRODUCT_IMAGE: resolveUrl ? resolveUrl(productImage) : (productImage || ''),
    PRODUCT_IMAGE_HTML: productImage
      ? `<img src="${resolveUrl ? resolveUrl(productImage) : productImage}" alt="${productTitle.replace(/"/g, '&quot;')}" style="max-width:200px;width:100%;height:auto;display:block;border-radius:6px;" />`
      : '',
    ORDER_ITEMS_HTML: orderItemsHtml || '',
    LINE_ITEMS_SUMMARY: lineSummary,
    STORE_NAME: storeName,
    SHOP_NAME: storeName,
    PLATFORM_NAME: platformName,
    SITE_URL: siteUrl || 'https://',
    SUPPORT_EMAIL: supportEmail || String(order.email || '').trim(),
    TRACKING_NUMBER: String(order.tracking_number || '').trim(),
    CARRIER_NAME: String(order.carrier_name || '').trim(),
    SHIP_DATE: shipDate,
    TRACKING_URL: trackingUrl,
    /** Deutsch alternative token often used in templates */
    SENDUNGSVERFOLGUNG_URL: trackingUrl || orderDetailUrl,
    TRACKING_LINK: trackingUrl,
    MY_ORDERS_URL: absoluteStorefrontUrl(baseSite, `${prefix}/orders`),
    SHOP_HOME_URL: absoluteStorefrontUrl(baseSite, `${prefix}/`),
    ACCOUNT_URL: absoluteStorefrontUrl(baseSite, `${prefix}/account`),
    ORDER_DETAIL_URL: orderDetailUrl,
    // Deep-links straight into the "write a review" page (apps/shop/.../reviews/page.jsx),
    // pre-expanding this order via ?order= — not the product page, which has no review form.
    REVIEW_URL: order.id ? absoluteStorefrontUrl(baseSite, `${prefix}/reviews?order=${encodeURIComponent(order.id)}`) : absoluteStorefrontUrl(baseSite, `${prefix}/reviews`),
    IMPRESSUM_URL: absoluteStorefrontUrl(baseSite, `${prefix}/impressum`),
    DATENSCHUTZ_URL: absoluteStorefrontUrl(baseSite, `${prefix}/datenschutz`),
    MARKET_COUNTRY: String(market || '').toUpperCase(),
    STOREFRONT_LOCALE: lang,
    CHECKOUT_URL: absoluteStorefrontUrl(baseSite, `${prefix}/checkout`),
    PRODUCT_URL: firstHandle
      ? absoluteStorefrontUrl(baseSite, `${prefix}/produkt/${encodeURIComponent(firstHandle)}`)
      : absoluteStorefrontUrl(baseSite, `${prefix}/`),
    LOGIN_URL: absoluteStorefrontUrl(baseSite, `${prefix}/login`),
    REGISTER_URL: absoluteStorefrontUrl(baseSite, `${prefix}/register`),
    RETURN_NUMBER: returnInfo?.return_number != null ? String(returnInfo.return_number) : '',
    RETURN_REASON: String(returnInfo?.reason || ''),
    RETURN_LABEL_URL: String(returnInfo?.label_url || ''),
    RETURN_TRACKING_NUMBER: String(returnInfo?.label_tracking_number || returnInfo?.customer_tracking_number || ''),
    RETURN_CARRIER_NAME: String(returnInfo?.label_carrier_name || returnInfo?.customer_carrier_name || ''),
    RETURN_ADDRESS_HTML: String(ctx.returnAddressHtml || ''),
  }
  items.slice(0, 5).forEach((it, i) => {
    const n = i + 1
    vars[`ITEM_${n}_NAME`] = String(it.title || '').trim()
    vars[`ITEM_${n}_IMAGE`] = resolveUrl ? resolveUrl(it.thumbnail || '') : (it.thumbnail || '')
    vars[`ITEM_${n}_QUANTITY`] = String(Number(it.quantity || 1))
    vars[`ITEM_${n}_PRICE`] = formatEuro(it.unit_price_cents)
    vars[`ITEM_${n}_SKU`] = String(it.sku || '').trim()
  })
  if (customerProfile) {
    overlayCustomerProfile(vars, customerProfile)
    Object.assign(vars, salutationVarsFromGender(customerProfile.gender))
  }
  return vars
}

async function placeholderVarsCustomerOnly(client, cust) {
  const fn = String(cust.first_name || '').trim()
  const ln = String(cust.last_name || '').trim()
  const fullName = [fn, ln].filter(Boolean).join(' ') || String(cust.email || '').trim()
  const sh = await client.query(`SELECT store_name, platform_name, support_email, storefront_url FROM admin_hub_seller_settings WHERE seller_id = 'default' LIMIT 1`)
  // Prefer the platform brand name (same field order-based flows use) over the legacy
  // store_name column, and never fall back to the English literal "Shop".
  const storeName = String(sh.rows[0]?.platform_name || sh.rows[0]?.store_name || 'Andertal').trim() || 'Andertal'
  const supportEmail = String(sh.rows[0]?.support_email || '').trim()
  const dbStorefrontUrl = String(sh.rows[0]?.storefront_url || '').trim().replace(/\/$/, '')
  const siteUrl = resolvePublicShopBaseUrl() || dbStorefrontUrl
  const { market, lang, prefix } = storefrontPathPrefixFromShippingCountry(cust.country)
  const absPath = (p) => absoluteStorefrontUrl(siteUrl, p)
  const vars = {
    CUSTOMER_NAME: fullName,
    CUSTOMER: fullName,
    FIRST_NAME: fn || fullName,
    LAST_NAME: ln,
    EMAIL: String(cust.email || '').trim(),
    PHONE: String(cust.phone || '').trim(),
    ORDER_NUMBER: '',
    ORDER_ID: '',
    ORDER_DATE: '',
    ORDER_TOTAL: '',
    ORDER_SUBTOTAL: '',
    ORDER_SHIPPING: '',
    ORDER_DISCOUNT: '',
    ORDER_CURRENCY: '',
    PAYMENT_METHOD: '',
    SHIPPING_FULL_NAME: fullName,
    ADDRESS_LINE1: String(cust.address_line1 || ''),
    ADDRESS_LINE2: String(cust.address_line2 || ''),
    CITY: String(cust.city || ''),
    POSTAL_CODE: String(cust.zip_code || ''),
    ZIP_CODE: String(cust.zip_code || ''),
    COUNTRY: String(cust.country || ''),
    PRODUCT: '',
    PRODUCT_NAME: '',
    PRODUCT_IMAGE: '',
    PRODUCT_IMAGE_HTML: '',
    LINE_ITEMS_SUMMARY: '',
    STORE_NAME: storeName,
    SHOP_NAME: storeName,
    SITE_URL: siteUrl || 'https://',
    SUPPORT_EMAIL: supportEmail || String(cust.email || '').trim(),
    TRACKING_NUMBER: '',
    CARRIER_NAME: '',
    TRACKING_URL: '',
    SENDUNGSVERFOLGUNG_URL: '',
    TRACKING_LINK: '',
    MY_ORDERS_URL: absPath(`${prefix}/orders`),
    SHOP_HOME_URL: absPath(`${prefix}/`),
    ACCOUNT_URL: absPath(`${prefix}/account`),
    ORDER_DETAIL_URL: '',
    REVIEW_URL: absPath(`${prefix}/reviews`),
    IMPRESSUM_URL: absPath(`${prefix}/impressum`),
    DATENSCHUTZ_URL: absPath(`${prefix}/datenschutz`),
    MARKET_COUNTRY: String(market || '').toUpperCase(),
    STOREFRONT_LOCALE: lang,
    CHECKOUT_URL: absPath(`${prefix}/checkout`),
    PRODUCT_URL: absPath(`${prefix}/`),
    LOGIN_URL: absPath(`${prefix}/login`),
    REGISTER_URL: absPath(`${prefix}/register`),
    ORDER_UUID: '',
    ORDER_ITEMS_HTML: '',
    UNSUBSCRIBE_URL: '',
    ...salutationVarsFromGender(cust.gender),
  }
  // Generate a real unsubscribe token when we have a DB client
  try {
    const { generateUnsubscribeUrl } = require('./routes/newsletter')
    const email = String(cust.email || '').trim().toLowerCase()
    if (email && client) {
      vars.UNSUBSCRIBE_URL = await generateUnsubscribeUrl(client, email, lang, siteUrl)
    }
  } catch (_) {}
  return vars
}

/**
 * Merge fields for flow test emails: latest order for customer when present, else profile-only.
 * @returns {Promise<object|null>} placeholder map, or null if customer id invalid / not found
 */
async function buildFlowEmailPlaceholderVarsForCustomer(client, customerId) {
  const id = String(customerId || '').trim()
  if (!id) return null
  const cRes = await client.query(
    `SELECT id, email, first_name, last_name, phone, gender, address_line1, address_line2, zip_code, city, country FROM store_customers WHERE id = $1::uuid`,
    [id],
  )
  const cust = cRes.rows[0]
  if (!cust) return null

  const ordR = await client.query(
    `SELECT id FROM store_orders WHERE customer_id = $1::uuid ORDER BY created_at DESC LIMIT 1`,
    [id],
  )

  if (ordR.rows[0]) {
    const ctx = await loadOrderContext(client, ordR.rows[0].id)
    if (ctx) {
      const vars = buildPlaceholderVars(ctx, '*', cust)
      try {
        const { generateUnsubscribeUrl } = require('./routes/newsletter')
        const email = String(cust.email || '').trim().toLowerCase()
        const locale = String(vars.STOREFRONT_LOCALE || 'de').trim()
        const base = String(vars.SITE_URL || '').trim()
        if (email) vars.UNSUBSCRIBE_URL = await generateUnsubscribeUrl(client, email, locale, base)
      } catch (_) {}
      return vars
    }
  }

  return placeholderVarsCustomerOnly(client, cust)
}

/**
 * A flow email actually failed to send (SMTP/Resend error) — surfaces this two ways so it isn't
 * only visible by digging through Content → Flows → Activity: (1) a superuser-panel notification
 * (admin_hub_notifications, type 'flow_send_failed' — see routes/notifications.js), and (2) at most
 * one ops email per failure incident. Ops alerts never go through Resend (would burn customer-mail
 * daily quota and show as "delivered" in Resend while the real flow mail failed).
 */
async function notifySuperuserFlowFailure(client, {
  triggerKey,
  flowId,
  stepOrder,
  recipientEmail,
  errorMessage,
  fromEmail,
  fromName,
  transport,
  idempotencyKey,
  attempt,
}) {
  const title = `Flow-Mail fehlgeschlagen: ${triggerKey || 'unbekannt'}`
  const bodyText = `Flow ${flowId}, Schritt ${stepOrder}, Empfänger ${recipientEmail || '—'}: ${String(errorMessage || '').slice(0, 400)}`

  // Retries must not spam the panel or burn any mail quota.
  if (Number(attempt || 1) > 1) {
    logger.warn(`[flow-automation] ${title} (retry attempt=${attempt}, no re-alert) — ${bodyText}`)
    return
  }

  try {
    await client.query(
      `INSERT INTO admin_hub_notifications (type, title, body, reference_id) VALUES ('flow_send_failed', $1, $2, $3)`,
      [title, bodyText, flowId ? String(flowId) : null],
    )
  } catch (e) {
    logger.warn('[flow-automation] failed to insert flow_send_failed notification', e?.message || e)
  }

  if (idempotencyKey) {
    try {
      const prev = await client.query(
        `SELECT metadata->>'failure_alert_sent' AS sent FROM store_flow_execution_logs WHERE idempotency_key = $1 LIMIT 1`,
        [String(idempotencyKey)],
      )
      if (String(prev.rows[0]?.sent || '') === '1') return
      await client.query(
        `UPDATE store_flow_execution_logs
         SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"failure_alert_sent":"1"}'::jsonb, updated_at = now()
         WHERE idempotency_key = $1`,
        [String(idempotencyKey)],
      )
    } catch (_) {}
  }

  // Explicit empty disables email; default still info@ but only via SMTP (never Resend).
  const alertToRaw = process.env.FLOW_FAILURE_ALERT_EMAIL
  const alertTo =
    alertToRaw === undefined || alertToRaw === null
      ? 'info@andertal.com'
      : String(alertToRaw).trim()
  if (!alertTo || alertTo === '0' || alertTo.toLowerCase() === 'off') return

  try {
    const provider = await resolveFlowMailProvider(client)
    if (provider === 'resend') {
      // Panel notification above is enough — do not burn Resend quota on ops alerts.
      logger.warn(`[flow-automation] ${title} — ${bodyText}`)
      return
    }
    if (!transport) {
      logger.warn(`[flow-automation] ${title} (no SMTP for ops alert) — ${bodyText}`)
      return
    }
    await sendFlowOutboundEmail({
      client,
      transport,
      from: `"${String(fromName || 'Andertal').replace(/"/g, '')}" <${fromEmail || alertTo}>`,
      to: alertTo,
      subject: title,
      html: `<p>${bodyText.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
      text: bodyText,
    })
  } catch (e) {
    logger.warn('[flow-automation] failed to send flow failure alert email', e?.message || e)
  }
}

/**
 * Send consecutive flow steps from the start until a positive wait_hours is encountered.
 */
async function sendImmediateStepsForFlow({
  client,
  transport,
  rateScopeKey,
  flowId,
  audience,
  triggerKey,
  steps,
  toEmail,
  templateLocale,
  placeholderVars,
  orderId,
  customerId,
  dedupeKey,
  // Hours since the triggering real-world event (e.g. cart abandonment) — lets periodic scanners
  // (no delayed-step scheduler exists) satisfy wait_hours steps against real elapsed time instead
  // of a single boolean. null/undefined = not applicable, only an explicit 0h wait is satisfied.
  elapsedHours,
}) {
  const { buildFlowEmailPdfAttachments } = require('./order-pdf-buffers')
  let idx = 0
  let emailsSent = 0
  let cumulativeWaitHours = 0
  while (idx < steps.length) {
    const s = steps[idx]
    if (s.step_type === 'wait_hours') {
      const wh = Number(s.wait_hours || 0)
      cumulativeWaitHours += wh
      const satisfied = wh <= 0 || (elapsedHours != null && elapsedHours >= cumulativeWaitHours)
      if (!satisfied) {
        logger.warn(
          `[flow-automation] order ${orderId} flow ${flowId}: wait_hours=${wh} stops immediate sends — delayed steps are not scheduled yet. Put "Send email" as the first step (or 0h wait) for instant mail after checkout.`,
        )
        break
      }
      idx += 1
      continue
    }
    if (s.step_type !== 'send_email') {
      idx += 1
      continue
    }
    const stepOrder = Number(s.step_order || idx + 1)
    const idempotencyKey = buildFlowStepIdempotencyKey({
      triggerKey,
      flowId,
      stepOrder,
      audience,
      recipientEmail: toEmail,
      orderId,
      customerId,
      dedupeKey,
    })
    const reserved = await reserveFlowExecutionLog(client, {
      triggerKey,
      flowId,
      stepOrder,
      audience,
      recipientEmail: toEmail,
      orderId,
      customerId,
      idempotencyKey,
      metadata: { templateLocale, step_type: s.step_type, channel: 'email', dedupe_key: dedupeKey || undefined },
    })
    if (reserved?.skip) {
      logger.info(
        `[flow-automation] idempotent-skip trigger=${triggerKey} flow=${flowId} step=${stepOrder} status=${reserved.status} attempts=${reserved.attempts} recipient=${String(toEmail || '').toLowerCase()}`,
      )
      idx += 1
      continue
    }
    const tpl = pickStepTemplate(s, templateLocale)
    if (!tpl) {
      await finalizeFlowExecutionLog(client, idempotencyKey, {
        status: 'skipped',
        errorMessage: 'template_empty',
      })
      logger.warn(
        `[flow-automation] flow ${flowId} step ${idx + 1}: skipped — email subject/body is empty. Fill in the template in Content → Flows.`,
      )
      idx += 1
      continue
    }
    if (!toEmail) {
      await finalizeFlowExecutionLog(client, idempotencyKey, {
        status: 'skipped',
        errorMessage: 'recipient_missing',
      })
      idx += 1
      continue
    }
    if (isNonDeliverableFlowRecipient(toEmail)) {
      await finalizeFlowExecutionLog(client, idempotencyKey, {
        status: 'skipped',
        errorMessage: 'recipient_non_deliverable_test_domain',
      })
      logger.warn(
        `[flow-automation] skip non-deliverable recipient trigger=${triggerKey} flow=${flowId} to=${String(toEmail).toLowerCase()}`,
      )
      idx += 1
      continue
    }
    const { text: subjectRaw, variant: abVariant } = pickSubjectForAb(idempotencyKey, tpl.subject, tpl.subject_b)
    const subject = applyFlowEmailPlaceholders(subjectRaw, placeholderVars)
    const html = applyFlowEmailPlaceholders(tpl.body, placeholderVars)
    const plain = flowEmailHtmlToPlainText(html)
    let attachments = []
    const oid = String(orderId || '').trim()
    const keys = Array.isArray(s.email_attachments) ? s.email_attachments : []
    if (oid && keys.length) {
      try {
        attachments = await buildFlowEmailPdfAttachments(client, oid, keys)
      } catch (e) {
        logger.error('[flow-automation] pdf attachments', e?.message || e)
      }
    }
    // Marketplace emails must be sent as the platform ("Andertal"), not the fulfilling seller's own
    // store name — PLATFORM_NAME is set for order-based triggers; customer-only triggers already
    // resolve STORE_NAME from the platform's own settings row, so it's a safe fallback there.
    const { fromEmail, fromName } = await resolveSmtpSenderIdentity(client, s.smtp_sender_id, 'default', placeholderVars.PLATFORM_NAME || placeholderVars.STORE_NAME)
    if (!fromEmail) {
      await finalizeFlowExecutionLog(client, idempotencyKey, {
        status: 'skipped',
        errorMessage: 'smtp_sender_missing',
      })
      idx += 1
      continue
    }
    // Placeholder only — overwritten by the real result below; only read if an exception
    // happens before that assignment, in which case the exact provider name doesn't matter.
    let sendMeta = { provider: 'smtp' }
    try {
      try {
        consumeFlowEmailSlot(rateScopeKey || 'default')
      } catch (rlErr) {
        // Leave pending so the next scan can retry without burning the permanent-failure budget.
        const attempts = Number(reserved?.attempts || 1)
        await client.query(
          `UPDATE store_flow_execution_logs
           SET attempts = GREATEST(attempts - 1, 0),
               status = 'pending',
               error_message = $2,
               metadata = COALESCE(metadata, '{}'::jsonb) || $3::jsonb,
               updated_at = now()
           WHERE idempotency_key = $1`,
          [
            idempotencyKey,
            rlErr?.message || 'rate_limited',
            JSON.stringify({ channel: 'email', ab_variant: abVariant, rate_limited: true }),
          ],
        )
        logger.warn(
          `[flow-automation] rate-limited trigger=${triggerKey} flow=${flowId} step=${stepOrder} attempt=${attempts}`,
        )
        idx += 1
        continue
      }
      sendMeta = await sendFlowOutboundEmail({
        client,
        transport,
        from: `"${String(fromName).replace(/"/g, '')}" <${fromEmail}>`,
        to: toEmail,
        subject,
        html,
        text: plain || subject,
        attachments: attachments.length ? attachments : undefined,
      })
      await finalizeFlowExecutionLog(client, idempotencyKey, {
        status: 'sent',
        metadata: {
          channel: 'email',
          mail_provider: sendMeta.provider,
          message_id: sendMeta.messageId || null,
          ab_variant: abVariant,
        },
      })
    } catch (sendErr) {
      const errMsg = sendErr?.message || String(sendErr || 'send_failed')
      const attempts = Number(reserved?.attempts || 1)
      // Quota / hard provider errors: do not keep retrying every 15 minutes.
      const permanent =
        attempts >= MAX_FLOW_SEND_ATTEMPTS ||
        /daily|quota|rate.?limit|too many|429|402|forbidden|invalid.*to|invalid.*from/i.test(errMsg)
      await finalizeFlowExecutionLog(client, idempotencyKey, {
        status: 'failed',
        errorMessage: errMsg,
        metadata: {
          channel: 'email',
          ab_variant: abVariant,
          attempts,
          permanent: permanent || undefined,
        },
      })
      if (permanent && attempts < MAX_FLOW_SEND_ATTEMPTS) {
        // Force exhaustion so subsequent scans skip immediately.
        await client.query(
          `UPDATE store_flow_execution_logs SET attempts = $2, updated_at = now() WHERE idempotency_key = $1`,
          [idempotencyKey, MAX_FLOW_SEND_ATTEMPTS],
        )
      }
      logger.error(
        `[flow-automation] send failed trigger=${triggerKey} flow=${flowId} step=${stepOrder} attempt=${attempts}:`,
        errMsg,
      )
      await notifySuperuserFlowFailure(client, {
        triggerKey,
        flowId,
        stepOrder,
        recipientEmail: toEmail,
        errorMessage: errMsg,
        fromEmail,
        fromName,
        transport,
        idempotencyKey,
        attempt: attempts,
      }).catch(() => {})
      idx += 1
      continue
    }
    try {
      await client.query(
        `INSERT INTO store_newsletter_email_logs (subscriber_id, recipient_email, subject, provider, delivery_status, flow_trigger_key, sent_at)
         SELECT s.id, $1, $2, $4, 'sent', $3, now()
         FROM store_newsletter_subscribers s
         WHERE LOWER(s.email) = LOWER($1)
         LIMIT 1`,
        [
          String(toEmail || '').trim().toLowerCase(),
          String(subject || '').trim(),
          String(triggerKey || '').trim() || null,
          String(sendMeta.provider || 'smtp'),
        ],
      )
    } catch (_) {
      // Do not block flow emails when newsletter log insert fails.
    }
    emailsSent += 1
    idx += 1
  }
  const hasSendEmailStep = steps.some((x) => x.step_type === 'send_email')
  if (hasSendEmailStep && emailsSent === 0) {
    logger.warn(
      `[flow-automation] order ${orderId} flow ${flowId}: send_email step(s) but nothing delivered (empty templates, missing From, or wait > 0 before any email).`,
    )
  }
  if (emailsSent > 0) {
    await client.query(`UPDATE admin_hub_flows SET sent_count = sent_count + 1 WHERE id = $1::uuid`, [flowId])
  }
  return emailsSent
}

/**
 * @param {{ triggerKey: string, orderId: string }} opts
 */
async function runAutomationFlowsForOrder(opts) {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) {
    logger.warn('[flow-automation] skip: DATABASE_URL missing')
    return
  }

  const triggerKey = String(opts.triggerKey || '').trim()
  const orderId = String(opts.orderId || '').trim()
  if (!triggerKey || !orderId) return
  if (!isOrderDispatcherTrigger(triggerKey)) {
    logger.warn(`[flow-automation] refusing non-order trigger "${triggerKey}" on order dispatcher (order=${orderId})`)
    return
  }

  let client
  try {
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()

    const ctx = await loadOrderContext(client, orderId)
    if (!ctx) {
      logger.warn('[flow-automation] skip: order not found', orderId)
      return
    }

    const useResend = (await resolveFlowMailProvider(client)) === 'resend'
    let transport = null
    if (!useResend) {
      transport = await getSmtpTransport(client)
      if (!transport) {
        logger.warn('[flow-automation] skip: SMTP not configured (store_smtp_settings needs host + username)')
        return
      }
    } else {
      const key = await resolveResendApiKey(client)
      if (!key) {
        logger.warn('[flow-automation] skip: Resend selected but API key missing (store_integrations or RESEND_API_KEY)')
        return
      }
    }

    let customerProfile = null
    if (ctx.order.customer_id) {
      const cr = await client.query(
        `SELECT id, email, first_name, last_name, phone, gender FROM store_customers WHERE id = $1::uuid`,
        [ctx.order.customer_id],
      )
      customerProfile = cr.rows[0] || null
    }
    const placeholderVars = buildPlaceholderVars(ctx, triggerKey, customerProfile)
    const orderLocaleRaw = String(ctx.order.locale || '').trim().toLowerCase()
    const customerLocale = FLOW_EMAIL_LOCALES.includes(orderLocaleRaw)
      ? orderLocaleRaw
      : resolveEmailLocaleFromCountry(ctx.order.country)
    // Inject unsubscribe URL token for this recipient
    try {
      const { generateUnsubscribeUrl } = require('./routes/newsletter')
      const recipientEmail = String(ctx.order.email || '').trim().toLowerCase()
      if (recipientEmail) {
        placeholderVars.UNSUBSCRIBE_URL = await generateUnsubscribeUrl(
          client,
          recipientEmail,
          customerLocale,
          String(placeholderVars.SITE_URL || '').trim(),
        )
      }
    } catch (_) {}
    const rateScopeKey = String(ctx.order.seller_id || 'default').trim() || 'default'

    const flowsR = await client.query(
      `SELECT id, audience FROM admin_hub_flows
       WHERE status = 'active' AND trigger_key = $1
       ORDER BY updated_at ASC`,
      [triggerKey],
    )

    const flowRows = flowsR.rows || []
    if (!flowRows.length) {
      logger.warn(
        `[flow-automation] no active flow for trigger "${triggerKey}" — enable the flow (status Active, not Draft) and matching trigger in Content → Flows`,
      )
      return
    }

    // order.seller_id is always the platform now (a cart/order can mix items from several real
    // sellers) — so a "seller audience" flow can no longer resolve to a single recipient from the
    // order row. Every distinct real seller who actually has an item in this order gets notified
    // instead, one send each (their own item-scoped view isn't built yet — same order-level
    // placeholders as before — but each fulfilling seller now correctly hears about their own
    // orders, and no seller is skipped or wrongly notified about someone else's).
    const distinctItemSellerIds = [...new Set(
      (ctx.items || [])
        .map((it) => String(it.seller_id || '').trim())
        .filter((sid) => sid && sid !== 'default'),
    )]

    let adminEmail = ''
    let totalEmails = 0
    for (const fr of flowRows) {
      const flowId = fr.id
      const audRaw = String(fr.audience || 'customer').toLowerCase()
      const audience = audRaw === 'seller' ? 'seller' : audRaw === 'admin' ? 'admin' : 'customer'

      const sr = await client.query(
        `SELECT step_order, step_type, wait_hours, email_subject, email_body, email_i18n, email_attachments, smtp_sender_id
         FROM admin_hub_flow_steps WHERE flow_id = $1::uuid ORDER BY step_order ASC`,
        [flowId],
      )
      const steps = sr.rows || []
      if (shouldSkipOrderFlowTemplate(triggerKey, steps)) {
        logger.warn(
          `[flow-automation] skip flow ${flowId} on "${triggerKey}": template is inbox/support, not an order email`,
        )
        continue
      }

      if (audience === 'customer' || audience === 'admin') {
        const toEmail = audience === 'admin'
          ? (adminEmail || (adminEmail = await resolveAdminNotificationEmail(client)))
          : String(ctx.order.email || '').trim()
        if (!toEmail) {
          logger.warn(`[flow-automation] skip flow ${flowId} (${audience}): no recipient`)
          continue
        }
        const n = await sendImmediateStepsForFlow({
          client,
          transport,
          rateScopeKey,
          flowId,
          audience,
          triggerKey,
          steps,
          toEmail,
          templateLocale: audience === 'admin' ? 'de' : customerLocale,
          placeholderVars,
          orderId,
          customerId: ctx.order.customer_id ? String(ctx.order.customer_id) : '',
          elapsedHours: opts.elapsedHours != null ? Number(opts.elapsedHours) : null,
        })
        totalEmails += n
        continue
      }

      if (!distinctItemSellerIds.length) {
        logger.warn(`[flow-automation] skip flow ${flowId}: seller audience but no order items have a real seller_id`)
        continue
      }
      for (const sid of distinctItemSellerIds) {
        const sur = await client.query(
          `SELECT email FROM seller_users WHERE seller_id = $1 AND sub_of_seller_id IS NULL ORDER BY created_at ASC LIMIT 1`,
          [sid],
        )
        const toEmail = String(sur.rows[0]?.email || '').trim()
        if (!toEmail) {
          logger.warn(`[flow-automation] skip flow ${flowId} (seller): no account email for seller ${sid}`)
          continue
        }
        const n = await sendImmediateStepsForFlow({
          client,
          transport,
          rateScopeKey,
          flowId,
          audience,
          triggerKey,
          steps,
          toEmail,
          templateLocale: 'de',
          placeholderVars,
          orderId,
          customerId: ctx.order.customer_id ? String(ctx.order.customer_id) : '',
          elapsedHours: opts.elapsedHours != null ? Number(opts.elapsedHours) : null,
        })
        totalEmails += n
      }
    }
    if (totalEmails > 0) {
      logger.info(`[flow-automation] ${triggerKey} order=${orderId}: sent ${totalEmails} email(s)`)
    } else if (flowRows.length > 0) {
      logger.warn(
        `[flow-automation] ${triggerKey} order=${orderId}: matched ${flowRows.length} flow(s) but 0 emails — see warnings above (draft→active, wait step first, SMTP, templates).`,
      )
    }
  } catch (e) {
    logger.error('[flow-automation]', opts.triggerKey, opts.orderId, e?.message || e)
  } finally {
    if (client)
      try {
        await client.end()
      } catch (_) {}
  }
}

/**
 * Seller lifecycle events (seller_signup, seller_docs_submitted, seller_verification_approved,
 * seller_verification_rejected, seller_documents_required): the recipient IS the seller
 * account itself, so this reads seller_users directly (real name/store name) instead of the
 * store_customers-based runAutomationFlowsForCustomerEvent, which a seller's email usually
 * doesn't match — that path would leave FIRST_NAME/STORE_NAME blank for seller-facing mail.
 * @param {{ triggerKey: string, sellerUserId: string, dedupeKey?: string }} opts
 */
async function runAutomationFlowsForSellerEvent(opts) {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) {
    logger.warn('[flow-automation] skip seller event: DATABASE_URL missing')
    return
  }
  const triggerKey = String(opts.triggerKey || '').trim()
  const sellerUserId = String(opts.sellerUserId || '').trim()
  if (!triggerKey || !sellerUserId) return
  if (!isSellerLifecycleTrigger(triggerKey)) {
    logger.warn(`[flow-automation] refusing non-lifecycle trigger "${triggerKey}" on seller dispatcher`)
    return
  }

  let client
  try {
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const useResend = (await resolveFlowMailProvider(client)) === 'resend'
    let transport = null
    if (!useResend) {
      transport = await getSmtpTransport(client)
      if (!transport) {
        logger.warn('[flow-automation] skip seller event: SMTP not configured')
        return
      }
    } else if (!(await resolveResendApiKey(client))) {
      logger.warn('[flow-automation] skip seller event: Resend API key missing')
      return
    }

    const sr = await client.query(
      `SELECT id, email, first_name, last_name, store_name, company_name, seller_id, rejection_reason
       FROM seller_users WHERE id = $1::uuid LIMIT 1`,
      [sellerUserId],
    )
    const seller = sr.rows[0]
    if (!seller || !seller.email) {
      logger.warn(`[flow-automation] skip seller event ${triggerKey}: seller ${sellerUserId} not found or has no email`)
      await client.end()
      return
    }

    const platformRow = await client.query(
      `SELECT storefront_url, platform_name, support_email FROM admin_hub_seller_settings WHERE seller_id = 'default' LIMIT 1`,
    )
    const platformName = String(platformRow.rows[0]?.platform_name || 'Andertal').trim() || 'Andertal'
    const siteUrl = resolvePublicShopBaseUrl() || String(platformRow.rows[0]?.storefront_url || '').trim().replace(/\/$/, '')
    const supportEmail = String(platformRow.rows[0]?.support_email || '').trim()
    const sellercentralUrl = String(process.env.SELLERCENTRAL_PUBLIC_URL || '').trim().replace(/\/$/, '') || 'https://sellercentral.andertal.com'

    const fn = String(seller.first_name || '').trim()
    const ln = String(seller.last_name || '').trim()
    const storeName = String(seller.store_name || seller.company_name || '').trim()
    const fullName = [fn, ln].filter(Boolean).join(' ') || storeName || String(seller.email || '').trim()

    const vars = {
      CUSTOMER_NAME: fullName,
      CUSTOMER: fullName,
      FIRST_NAME: fn || fullName,
      LAST_NAME: ln,
      EMAIL: String(seller.email || '').trim(),
      STORE_NAME: storeName || platformName,
      SHOP_NAME: storeName || platformName,
      PLATFORM_NAME: platformName,
      SITE_URL: siteUrl || 'https://',
      SUPPORT_EMAIL: supportEmail || String(seller.email || '').trim(),
      SELLERCENTRAL_URL: sellercentralUrl,
      SELLERCENTRAL_LOGIN_URL: `${sellercentralUrl}/login`,
      REJECTION_REASON: String(seller.rejection_reason || ''),
      IMPRESSUM_URL: absoluteStorefrontUrl(siteUrl, '/impressum'),
      DATENSCHUTZ_URL: absoluteStorefrontUrl(siteUrl, '/datenschutz'),
    }

    const flowsR = await client.query(
      `SELECT id, audience FROM admin_hub_flows WHERE status = 'active' AND trigger_key = $1 ORDER BY updated_at ASC`,
      [triggerKey],
    )
    const flowRows = flowsR.rows || []
    if (!flowRows.length) {
      await client.end()
      return
    }

    let adminEmail = ''
    let total = 0
    for (const fr of flowRows) {
      const audience = String(fr.audience || 'seller').toLowerCase() === 'admin' ? 'admin' : 'seller'
      let toEmail = seller.email
      if (audience === 'admin') {
        if (!adminEmail) adminEmail = await resolveAdminNotificationEmail(client)
        toEmail = adminEmail
        if (!toEmail) {
          logger.warn(`[flow-automation] skip flow ${fr.id} (admin): no admin notification email configured (Settings → Platform)`)
          continue
        }
      }
      const sr2 = await client.query(
        `SELECT step_order, step_type, wait_hours, email_subject, email_body, email_i18n, email_attachments, smtp_sender_id
         FROM admin_hub_flow_steps WHERE flow_id = $1::uuid ORDER BY step_order ASC`,
        [fr.id],
      )
      const n = await sendImmediateStepsForFlow({
        client,
        transport,
        rateScopeKey: 'seller_events',
        flowId: fr.id,
        audience,
        triggerKey,
        steps: sr2.rows || [],
        toEmail,
        templateLocale: 'de',
        placeholderVars: vars,
        orderId: '',
        customerId: '',
        dedupeKey: opts.dedupeKey || '',
      })
      total += n
    }
    await client.end()
    if (total > 0) {
      logger.info(`[flow-automation] ${triggerKey} seller=${seller.email}: sent ${total} email(s)`)
    }
  } catch (e) {
    logger.error('[flow-automation] seller event failed', triggerKey, sellerUserId, e?.message || e)
    if (client) {
      try {
        await client.end()
      } catch (_) {}
    }
  }
}

/**
 * @param {{ triggerKey: string, customerId?: string, email?: string }} opts
 */
async function runAutomationFlowsForCustomerEvent(opts) {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) {
    logger.warn('[flow-automation] skip customer event: DATABASE_URL missing')
    return
  }
  const triggerKey = String(opts.triggerKey || '').trim()
  const customerId = String(opts.customerId || '').trim()
  const fallbackEmail = String(opts.email || '').trim().toLowerCase()
  if (!triggerKey) return
  if (!isCustomerAccountTrigger(triggerKey)) {
    logger.warn(`[flow-automation] refusing non-customer trigger "${triggerKey}" on customer dispatcher`)
    return
  }

  let client
  try {
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const useResend = (await resolveFlowMailProvider(client)) === 'resend'
    let transport = null
    if (!useResend) {
      transport = await getSmtpTransport(client)
      if (!transport) {
        logger.warn('[flow-automation] skip customer event: SMTP not configured')
        return
      }
    } else if (!(await resolveResendApiKey(client))) {
      logger.warn('[flow-automation] skip customer event: Resend API key missing')
      return
    }

    let cust = null
    if (customerId) {
      const c1 = await client.query(
        `SELECT id, email, first_name, last_name, phone, gender, address_line1, address_line2, zip_code, city, country
         FROM store_customers WHERE id = $1::uuid LIMIT 1`,
        [customerId],
      )
      cust = c1.rows[0] || null
    }
    if (!cust && fallbackEmail) {
      const c2 = await client.query(
        `SELECT id, email, first_name, last_name, phone, gender, address_line1, address_line2, zip_code, city, country
         FROM store_customers WHERE LOWER(TRIM(email)) = LOWER(TRIM($1)) ORDER BY created_at DESC NULLS LAST LIMIT 1`,
        [fallbackEmail],
      )
      cust = c2.rows[0] || null
    }
    if (!cust && fallbackEmail) {
      cust = { email: fallbackEmail, first_name: '', last_name: '', phone: '', country: '' }
    }
    if (!cust) {
      logger.warn(`[flow-automation] skip customer event ${triggerKey}: recipient not found`)
      return
    }

    const vars = await placeholderVarsCustomerOnly(client, cust)
    // Overlay product context for wishlist-triggered events (favorite_low_stock, favorite_price_drop) —
    // placeholderVarsCustomerOnly() has no order to pull PRODUCT_* fields from, so the caller passes
    // the specific product the customer favorited.
    if (opts.product) {
      const p = opts.product
      const { prefix } = storefrontPathPrefixFromShippingCountry(cust.country || '')
      const productUrl = p.handle ? absoluteStorefrontUrl(vars.SITE_URL, `${prefix}/produkt/${encodeURIComponent(p.handle)}`) : vars.PRODUCT_URL
      vars.PRODUCT = p.title || vars.PRODUCT
      vars.PRODUCT_NAME = p.title || vars.PRODUCT_NAME
      vars.PRODUCT_IMAGE = p.image || vars.PRODUCT_IMAGE
      vars.PRODUCT_IMAGE_HTML = p.image
        ? `<img src="${p.image}" alt="${String(p.title || '').replace(/"/g, '&quot;')}" style="max-width:200px;width:100%;height:auto;display:block;border-radius:6px;" />`
        : vars.PRODUCT_IMAGE_HTML
      vars.PRODUCT_URL = productUrl
      vars.PRODUCT_PRICE = p.price_cents != null ? formatEuro(p.price_cents) : ''
      vars.PRODUCT_OLD_PRICE = p.old_price_cents != null ? formatEuro(p.old_price_cents) : ''
      vars.PRODUCT_STOCK = p.stock != null ? String(p.stock) : ''
    }
    // Overlay cart context for the abandoned_cart trigger — recovery link + first-item summary.
    if (opts.cart) {
      const { prefix } = storefrontPathPrefixFromShippingCountry(cust.country || '')
      vars.CART_URL = absoluteStorefrontUrl(vars.SITE_URL, `${prefix}/checkout`)
      vars.ITEM_1_QUANTITY = opts.cart.itemQuantity != null ? String(opts.cart.itemQuantity) : ''
      vars.ITEM_1_PRICE = opts.cart.itemPriceCents != null ? formatEuro(opts.cart.itemPriceCents) : ''
      vars.LINE_ITEMS_SUMMARY = opts.cart.totalCents != null ? formatEuro(opts.cart.totalCents) : ''
    }
    // Prefer the UI language the customer was actually using (passed by the caller, e.g.
    // register/newsletter forms) over guessing from their shipping country — a German
    // speaker with a non-DE delivery country would otherwise get an English signup email.
    const requestedLocale = String(opts.locale || '').trim().toLowerCase()
    const locale = FLOW_EMAIL_LOCALES.includes(requestedLocale) ? requestedLocale : resolveEmailLocaleFromCountry(cust.country || '')
    // Rebuild unsubscribe URL with the actual email locale (preferred_locale from signup), not country guess
    try {
      const { generateUnsubscribeUrl } = require('./routes/newsletter')
      const to = String(cust.email || fallbackEmail || '').trim().toLowerCase()
      if (to) {
        vars.UNSUBSCRIBE_URL = await generateUnsubscribeUrl(
          client,
          to,
          locale,
          String(vars.SITE_URL || '').trim(),
        )
        vars.STOREFRONT_LOCALE = locale
      }
    } catch (_) {}
    const toEmail = String(cust.email || fallbackEmail || '').trim()
    if (!toEmail) return

    const flowsR = await client.query(
      `SELECT id, audience FROM admin_hub_flows
       WHERE status = 'active' AND trigger_key = $1
       ORDER BY updated_at ASC`,
      [triggerKey],
    )
    const flowRows = flowsR.rows || []
    if (!flowRows.length) return

    let adminEmail = ''
    let total = 0
    for (const fr of flowRows) {
      const audRaw = String(fr.audience || 'customer').toLowerCase()
      const audience = audRaw === 'seller' ? 'seller' : audRaw === 'admin' ? 'admin' : 'customer'
      const recipientEmail = audience === 'admin'
        ? (adminEmail || (adminEmail = await resolveAdminNotificationEmail(client)))
        : toEmail
      if (!recipientEmail) {
        logger.warn(`[flow-automation] skip flow ${fr.id} (${audience}): no recipient`)
        continue
      }
      const sr = await client.query(
        `SELECT step_order, step_type, wait_hours, email_subject, email_body, email_i18n, email_attachments, smtp_sender_id
         FROM admin_hub_flow_steps WHERE flow_id = $1::uuid ORDER BY step_order ASC`,
        [fr.id],
      )
      const n = await sendImmediateStepsForFlow({
        client,
        transport,
        rateScopeKey: 'customer_events',
        flowId: fr.id,
        audience,
        triggerKey,
        steps: sr.rows || [],
        toEmail: recipientEmail,
        templateLocale: audience === 'admin' ? 'de' : locale,
        placeholderVars: vars,
        orderId: '',
        customerId: cust.id ? String(cust.id) : '',
        dedupeKey: opts.dedupeKey || '',
        elapsedHours: opts.elapsedHours != null ? Number(opts.elapsedHours) : null,
      })
      total += n
    }
    if (total > 0) {
      logger.info(`[flow-automation] ${triggerKey} customer=${toEmail}: sent ${total} email(s)`)
    }
  } catch (e) {
    logger.error('[flow-automation] customer event failed', triggerKey, customerId || fallbackEmail, e?.message || e)
  } finally {
    if (client) {
      try {
        await client.end()
      } catch (_) {}
    }
  }
}

/**
 * Generic dispatch for messaging-related triggers (customer_message_sent, seller_new_customer_message,
 * customer_message_replied, seller_support_ticket_sent, seller_support_ticket_replied). Unlike
 * runAutomationFlowsForOrder/runAutomationFlowsForCustomerEvent, the recipient is already known by the
 * caller (messages.js resolves it from the specific message/order/seller context) — this function only
 * needs to load the active flow(s) for the trigger and render/send the configured template(s) to that
 * recipient, in the caller-supplied locale.
 */
async function runAutomationFlowsForMessageEvent(opts) {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) {
    logger.warn('[flow-automation] skip message event: DATABASE_URL missing')
    return 0
  }
  const triggerKey = String(opts.triggerKey || '').trim()
  const toEmail = String(opts.toEmail || '').trim()
  if (!triggerKey || !toEmail) return 0
  if (!isMessageDispatcherTrigger(triggerKey)) {
    logger.warn(`[flow-automation] refusing non-message trigger "${triggerKey}" on message dispatcher`)
    return 0
  }

  let client
  try {
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()

    const useResend = (await resolveFlowMailProvider(client)) === 'resend'
    let transport = null
    if (!useResend) {
      transport = await getSmtpTransport(client)
      if (!transport) {
        logger.warn('[flow-automation] skip message event: SMTP not configured')
        return 0
      }
    } else if (!(await resolveResendApiKey(client))) {
      logger.warn('[flow-automation] skip message event: Resend API key missing')
      return 0
    }

    const requestedLocale = String(opts.locale || '').trim().toLowerCase()
    const locale = FLOW_EMAIL_LOCALES.includes(requestedLocale) ? requestedLocale : 'de'

    const flowsR = await client.query(
      `SELECT id, audience FROM admin_hub_flows WHERE status = 'active' AND trigger_key = $1 ORDER BY updated_at ASC`,
      [triggerKey],
    )
    const flowRows = flowsR.rows || []
    if (!flowRows.length) {
      logger.warn(`[flow-automation] no active flow for message trigger "${triggerKey}" — enable it in Content → Flows`)
      return 0
    }

    // Message/support-case callers resolve the exact recipient. Admin audience is therefore
    // safe here as well: it is sent only to the explicit toEmail supplied by the caller.
    let total = 0
    for (const fr of flowRows) {
      const audRaw = String(fr.audience || 'customer').toLowerCase()
      const audience = audRaw === 'seller' ? 'seller' : audRaw === 'admin' ? 'admin' : 'customer'
      const sr = await client.query(
        `SELECT step_order, step_type, wait_hours, email_subject, email_body, email_i18n, email_attachments, smtp_sender_id
         FROM admin_hub_flow_steps WHERE flow_id = $1::uuid ORDER BY step_order ASC`,
        [fr.id],
      )
      const n = await sendImmediateStepsForFlow({
        client,
        transport,
        rateScopeKey: opts.rateScopeKey || 'messages',
        flowId: fr.id,
        audience,
        triggerKey,
        steps: sr.rows || [],
        toEmail,
        templateLocale: locale,
        placeholderVars: opts.vars || {},
        orderId: opts.orderId || '',
        customerId: opts.customerId || '',
        dedupeKey: opts.dedupeKey || '',
      })
      total += n
    }
    if (total > 0) logger.info(`[flow-automation] ${triggerKey} -> ${toEmail}: sent ${total} email(s)`)
    return total
  } catch (e) {
    logger.error('[flow-automation] message event failed', triggerKey, toEmail, e?.message || e)
    return 0
  } finally {
    if (client) {
      try { await client.end() } catch (_) {}
    }
  }
}

/**
 * Win-back / reorder reminder (trigger_key 'win_back'): finds customers whose most recent order
 * was placed at least REORDER_REMINDER_DAYS ago with no order since, and nudges them to come
 * back. Runs periodically (see server.js) — sending is one-shot per customer (idempotency key
 * has no time dimension), so this is a gentle single reminder rather than a recurring nag.
 */
const REORDER_REMINDER_DAYS = 30
async function runWinBackScan() {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return
  let client
  try {
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(
      `SELECT o.customer_id, MAX(o.created_at) AS last_order_at
       FROM store_orders o
       WHERE o.customer_id IS NOT NULL AND o.order_status != 'storniert'
       GROUP BY o.customer_id
       HAVING MAX(o.created_at) <= now() - ($1::int * interval '1 day')
       LIMIT 200`,
      [REORDER_REMINDER_DAYS],
    )
    await client.end()
    for (const row of (r.rows || [])) {
      await runAutomationFlowsForCustomerEvent({ triggerKey: 'win_back', customerId: row.customer_id }).catch((e) =>
        logger.warn('[flow-automation] win_back failed', e?.message || e),
      )
    }
  } catch (e) {
    logger.error('[flow-automation] win_back scan failed', e?.message || e)
    if (client) {
      try {
        await client.end()
      } catch (_) {}
    }
  }
}

/**
 * Birthday campaign (trigger_key 'customer_birthday'): fires once a year, on the day, for every
 * customer with a birth_date on file. Unlike win_back (one-shot forever), the idempotency
 * dedupeKey includes the current year so the same customer gets a fresh email each birthday.
 * Runs daily (see server.js).
 */
async function runBirthdayScan() {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return
  let client
  try {
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    const r = await client.query(`
      SELECT id FROM store_customers
      WHERE birth_date IS NOT NULL
        AND EXTRACT(MONTH FROM birth_date) = EXTRACT(MONTH FROM CURRENT_DATE)
        AND EXTRACT(DAY FROM birth_date) = EXTRACT(DAY FROM CURRENT_DATE)
      LIMIT 500
    `)
    await client.end()
    const year = String(new Date().getFullYear())
    for (const row of r.rows || []) {
      await runAutomationFlowsForCustomerEvent({
        triggerKey: 'customer_birthday',
        customerId: row.id,
        dedupeKey: year,
      }).catch((e) => logger.warn('[flow-automation] customer_birthday failed', e?.message || e))
    }
  } catch (e) {
    logger.error('[flow-automation] birthday scan failed', e?.message || e)
    if (client) {
      try {
        await client.end()
      } catch (_) {}
    }
  }
}

/**
 * Abandoned cart (trigger_key 'abandoned_cart'): nothing else in this file ever fires this
 * trigger — carts don't have a natural "event" the way orders do, so detecting one requires
 * periodically scanning for carts that still have items but never became an order. Runs
 * periodically (see server.js). admin_hub_flow_steps has no scheduler for delayed steps, so this
 * scan re-checks every still-abandoned cart on every run and passes the real elapsed hours since
 * the cart was last touched (elapsedHours) — sendImmediateStepsForFlow satisfies each wait_hours
 * step against that instead of firing every step in one burst, so a 2-step flow (e.g. wait 2h →
 * email 1 → wait 24h → email 2) actually sends email 2 ~24h after email 1, not immediately after.
 * Per-step idempotency (buildFlowStepIdempotencyKey, keyed by cart id) caps each cart at exactly
 * one send per configured email step even though it's rescanned every run; once the cart is
 * purchased or emptied it drops out of the WHERE/HAVING below and is never scanned again, so any
 * not-yet-sent later step simply never fires.
 */
const ABANDONED_CART_DEFAULT_DELAY_HOURS = 2
async function runAbandonedCartScan() {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return
  let client
  try {
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()

    const flowR = await client.query(
      `SELECT f.id, s.wait_hours
       FROM admin_hub_flows f
       LEFT JOIN admin_hub_flow_steps s ON s.flow_id = f.id AND s.step_order = 0 AND s.step_type = 'wait_hours'
       WHERE f.status = 'active' AND f.trigger_key = 'abandoned_cart'
       ORDER BY f.updated_at ASC LIMIT 1`,
    )
    if (!flowR.rows.length) {
      await client.end()
      return
    }
    const delayHours = Number(flowR.rows[0].wait_hours) > 0 ? Number(flowR.rows[0].wait_hours) : ABANDONED_CART_DEFAULT_DELAY_HOURS

    const r = await client.query(
      `SELECT c.id, c.email, c.updated_at,
         COUNT(ci.id) FILTER (WHERE ci.removed_at IS NULL)::int as item_count,
         SUM(ci.quantity) FILTER (WHERE ci.removed_at IS NULL) as total_qty,
         SUM(ci.unit_price_cents * ci.quantity) FILTER (WHERE ci.removed_at IS NULL) as cart_total,
         (array_agg(ci.title ORDER BY ci.created_at) FILTER (WHERE ci.removed_at IS NULL))[1] as first_title,
         (array_agg(ci.thumbnail ORDER BY ci.created_at) FILTER (WHERE ci.removed_at IS NULL))[1] as first_thumbnail,
         (array_agg(ci.product_handle ORDER BY ci.created_at) FILTER (WHERE ci.removed_at IS NULL))[1] as first_handle,
         (array_agg(ci.unit_price_cents ORDER BY ci.created_at) FILTER (WHERE ci.removed_at IS NULL))[1] as first_price_cents,
         (array_agg(ci.quantity ORDER BY ci.created_at) FILTER (WHERE ci.removed_at IS NULL))[1] as first_qty
       FROM store_carts c
       JOIN store_cart_items ci ON ci.cart_id = c.id
       LEFT JOIN store_orders o ON o.cart_id = c.id
       WHERE o.id IS NULL AND c.email IS NOT NULL AND c.email != ''
         AND c.email NOT ILIKE '%@example.com'
         AND c.email NOT ILIKE '%@example.org'
         AND c.email NOT ILIKE '%@example.net'
         AND c.updated_at <= now() - ($1::numeric * interval '1 hour')
       GROUP BY c.id, c.email, c.updated_at
       HAVING COUNT(ci.id) FILTER (WHERE ci.removed_at IS NULL) > 0
       LIMIT 200`,
      [delayHours],
    )
    await client.end()

    for (const row of r.rows || []) {
      if (isNonDeliverableFlowRecipient(row.email)) continue
      const elapsedHours = row.updated_at ? (Date.now() - new Date(row.updated_at).getTime()) / (1000 * 60 * 60) : null
      await runAutomationFlowsForCustomerEvent({
        triggerKey: 'abandoned_cart',
        email: row.email,
        product: {
          title: row.first_title,
          image: row.first_thumbnail,
          handle: row.first_handle,
          price_cents: row.first_price_cents != null ? Number(row.first_price_cents) : null,
        },
        cart: {
          itemQuantity: row.first_qty != null ? Number(row.first_qty) : null,
          itemPriceCents: row.first_price_cents != null ? Number(row.first_price_cents) : null,
          totalCents: row.cart_total != null ? Number(row.cart_total) : null,
        },
        dedupeKey: String(row.id),
        elapsedHours,
      }).catch((e) => logger.warn('[flow-automation] abandoned_cart failed', e?.message || e))
    }
  } catch (e) {
    logger.error('[flow-automation] abandoned cart scan failed', e?.message || e)
    if (client) {
      try {
        await client.end()
      } catch (_) {}
    }
  }
}

/**
 * Review request (trigger_key 'review_request'): nothing else in this file ever fires this
 * trigger — like abandoned_cart, it needs periodic scanning rather than a natural order event.
 * Finds orders delivered at least N hours ago (N = the flow's own first wait_hours step, default
 * REVIEW_REQUEST_DEFAULT_DELAY_HOURS) and dispatches via runAutomationFlowsForOrder (not the
 * customer-only path) so PRODUCT_NAME/ORDER_NUMBER/PRODUCT_URL etc. are populated (note:
 * {REVIEW_LINK} is documented in the flows.js merge-field catalog but not actually populated
 * by buildPlaceholderVars — link to {PRODUCT_URL} or {ORDER_DETAIL_URL} instead in templates). Per-order
 * idempotency caps each order at exactly one review-request email regardless of rescans. Runs
 * periodically (see server.js).
 *
 * NOTE: apps/medusa-backend/src/routes/marketing-automations.js has a separate, older
 * per-seller "review_request" automation rule (store_automation_rules) with its own hardcoded
 * German-only email — unrelated to this Content → Flows trigger. Don't confuse the two.
 */
const REVIEW_REQUEST_DEFAULT_DELAY_HOURS = 72
async function runReviewRequestScan() {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return
  let client
  try {
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()

    const flowR = await client.query(
      `SELECT f.id, s.wait_hours
       FROM admin_hub_flows f
       LEFT JOIN admin_hub_flow_steps s ON s.flow_id = f.id AND s.step_order = 0 AND s.step_type = 'wait_hours'
       WHERE f.status = 'active' AND f.trigger_key = 'review_request'
       ORDER BY f.updated_at ASC LIMIT 1`,
    )
    if (!flowR.rows.length) {
      await client.end()
      return
    }
    const delayHours = Number(flowR.rows[0].wait_hours) > 0 ? Number(flowR.rows[0].wait_hours) : REVIEW_REQUEST_DEFAULT_DELAY_HOURS

    const r = await client.query(
      `SELECT id, delivery_date FROM store_orders
       WHERE delivery_status = 'zugestellt' AND delivery_date IS NOT NULL
         AND delivery_date <= now() - ($1::numeric * interval '1 hour')
         AND order_status NOT IN ('storniert', 'refunded')
       ORDER BY delivery_date DESC
       LIMIT 200`,
      [delayHours],
    )
    await client.end()

    for (const row of r.rows || []) {
      const elapsedHours = row.delivery_date ? (Date.now() - new Date(row.delivery_date).getTime()) / (1000 * 60 * 60) : null
      await runAutomationFlowsForOrder({
        triggerKey: 'review_request',
        orderId: row.id,
        elapsedHours,
      }).catch((e) => logger.warn('[flow-automation] review_request failed', e?.message || e))
    }
  } catch (e) {
    logger.error('[flow-automation] review request scan failed', e?.message || e)
    if (client) {
      try {
        await client.end()
      } catch (_) {}
    }
  }
}

/**
 * Wishlist watchers (trigger_keys 'favorite_low_stock' / 'favorite_price_drop'): compares each
 * favorited product's current price/inventory against the last-seen snapshot and notifies every
 * customer who favorited it. Runs periodically instead of hooking every product-write path
 * (manual edit, CSV import, per-seller listings, campaigns can all change price/inventory).
 */
const LOW_STOCK_THRESHOLD = 10
async function runProductWishlistWatchers() {
  const dbUrl = (process.env.DATABASE_URL || '').replace(/^postgresql:\/\//, 'postgres://')
  if (!dbUrl || !dbUrl.startsWith('postgres')) return
  let client
  try {
    client = new Client({ connectionString: dbUrl, ssl: dbUrl.includes('render.com') ? { rejectUnauthorized: false } : false })
    await client.connect()
    await client
      .query(
        `CREATE TABLE IF NOT EXISTS store_product_watch_state (
           product_id uuid PRIMARY KEY,
           last_price_cents integer,
           last_inventory integer,
           updated_at timestamptz NOT NULL DEFAULT now()
         )`,
      )
      .catch(() => {})

    const r = await client.query(`
      SELECT p.id, p.title, p.handle, p.price_cents, p.inventory, p.metadata,
             w.last_price_cents, w.last_inventory
      FROM admin_hub_products p
      JOIN (SELECT DISTINCT product_id FROM store_customer_wishlist) fw ON fw.product_id = p.id
      LEFT JOIN store_product_watch_state w ON w.product_id = p.id
      WHERE p.status = 'published'
    `)

    for (const row of r.rows || []) {
      const productId = String(row.id)
      const price = row.price_cents != null ? Number(row.price_cents) : null
      const inv = row.inventory != null ? Number(row.inventory) : null
      const hadSnapshot = row.last_price_cents != null || row.last_inventory != null

      if (hadSnapshot) {
        const crossedLowStock =
          inv != null && inv < LOW_STOCK_THRESHOLD && (row.last_inventory == null || row.last_inventory >= LOW_STOCK_THRESHOLD)
        const priceDropped = price != null && row.last_price_cents != null && price < row.last_price_cents

        if (crossedLowStock || priceDropped) {
          let meta = row.metadata
          if (meta != null && typeof meta === 'string') {
            try {
              meta = JSON.parse(meta)
            } catch (_) {
              meta = null
            }
          }
          const media = meta && meta.media
          const image = Array.isArray(media) && media[0] ? (typeof media[0] === 'string' ? media[0] : media[0].url) : typeof media === 'string' ? media : null
          const product = { title: row.title, handle: row.handle, image, price_cents: price, stock: inv }

          const wl = await client.query(`SELECT customer_id FROM store_customer_wishlist WHERE product_id = $1::uuid`, [productId])
          for (const wrow of wl.rows || []) {
            if (crossedLowStock) {
              await runAutomationFlowsForCustomerEvent({
                triggerKey: 'favorite_low_stock',
                customerId: wrow.customer_id,
                product,
                dedupeKey: productId,
              }).catch((e) => logger.warn('[flow-automation] favorite_low_stock failed', e?.message || e))
            }
            if (priceDropped) {
              await runAutomationFlowsForCustomerEvent({
                triggerKey: 'favorite_price_drop',
                customerId: wrow.customer_id,
                product: { ...product, old_price_cents: row.last_price_cents },
                dedupeKey: `${productId}:${price}`,
              }).catch((e) => logger.warn('[flow-automation] favorite_price_drop failed', e?.message || e))
            }
          }
        }
      }

      await client.query(
        `INSERT INTO store_product_watch_state (product_id, last_price_cents, last_inventory, updated_at)
         VALUES ($1::uuid, $2, $3, now())
         ON CONFLICT (product_id) DO UPDATE SET last_price_cents = $2, last_inventory = $3, updated_at = now()`,
        [productId, price, inv],
      )
    }
    await client.end()
  } catch (e) {
    logger.error('[flow-automation] wishlist watchers failed', e?.message || e)
    if (client) {
      try {
        await client.end()
      } catch (_) {}
    }
  }
}

module.exports = {
  runAutomationFlowsForOrder,
  runAutomationFlowsForCustomerEvent,
  runAutomationFlowsForSellerEvent,
  runAutomationFlowsForMessageEvent,
  resolveEmailLocaleFromCountry,
  FLOW_EMAIL_LOCALES,
  buildFlowEmailPlaceholderVarsForCustomer,
  resolveSmtpSenderIdentity,
  runWinBackScan,
  runAbandonedCartScan,
  runProductWishlistWatchers,
  runBirthdayScan,
  runReviewRequestScan,
}
