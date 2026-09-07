/**
 * Shared helpers for affiliate tracking (docs/affiliate.md PR 2), used by the /r/[code] redirect
 * route and the /api/affiliate-track proxy — both server-side Next.js route handlers.
 */

export const COOKIE_CONSENT_NAME = "andertal_cookie_consent"; // written by CookieBanner.jsx
export const AFFILIATE_COOKIE_NAME = "__atrl";
export const AFFILIATE_COOKIE_MAX_AGE_SECONDS = 30 * 86400; // config.COOKIE_MAX_AGE_SECONDS

export const getBackendUrl = () =>
  (process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "http://localhost:9000").replace(/\/$/, "");

/**
 * @param {import("next/headers").ReadonlyRequestCookies | { get(name: string): { value: string } | undefined }} cookieStore
 * @returns {boolean} true only when the visitor explicitly accepted the "marketing" category.
 */
export function hasMarketingConsent(cookieStore) {
  try {
    const raw = cookieStore.get(COOKIE_CONSENT_NAME)?.value;
    if (!raw) return false;
    const parsed = JSON.parse(decodeURIComponent(raw));
    return parsed?.marketing === true;
  } catch {
    return false;
  }
}

/** Random UUID for a new __atrl cookie value — only ever generated when consent is already true. */
export function generateVisitorCookieId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `v${Date.now()}${Math.random().toString(36).slice(2)}`;
  }
}

/** Best-effort AFF_ code extraction from a "ref" query param — trims and uppercases only. */
export function normalizeRefParam(ref) {
  const s = String(ref || "").trim().toUpperCase();
  return s || null;
}

/**
 * Client-side read of the __atrl cookie (not httpOnly, set by /r/[code] or /api/affiliate-track
 * only when the visitor consented to marketing tracking) — used at checkout to attribute an order
 * to whichever affiliate's product link led to it (docs/affiliate.md PR 4's commission-recalc).
 * Returns null in any non-browser context or when the cookie isn't set.
 */
export function readAffiliateCookieId() {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${AFFILIATE_COOKIE_NAME}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}
