import { NextResponse } from "next/server";
import { cookies, headers } from "next/headers";
import {
  getBackendUrl,
  hasMarketingConsent,
  generateVisitorCookieId,
  AFFILIATE_COOKIE_NAME,
  AFFILIATE_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/affiliate";

/**
 * Affiliate short-link redirect (docs/affiliate.md PR 2): andertal.com/r/{short_code} →
 * 302 to the link's target_url with ?ref=AFF_XXX appended, recording the click along the way.
 * Excluded from src/proxy.js's locale/market rewrite matcher so this stays un-prefixed.
 */
export async function GET(request, { params }) {
  const { code } = await params;
  const base = getBackendUrl();
  const fallback = () => NextResponse.redirect(new URL("/", request.url));

  let resolved;
  try {
    const res = await fetch(`${base}/public/affiliate-track/resolve/${encodeURIComponent(code)}`, {
      cache: "no-store",
    });
    if (!res.ok) return fallback();
    resolved = await res.json();
  } catch {
    return fallback();
  }
  if (!resolved?.target_url) return fallback();

  const cookieStore = await cookies();
  const consent = hasMarketingConsent(cookieStore);
  const existingCookieId = cookieStore.get(AFFILIATE_COOKIE_NAME)?.value || null;
  const cookieId = consent ? (existingCookieId || generateVisitorCookieId()) : null;

  try {
    const h = await headers();
    await fetch(`${base}/public/affiliate-track/click`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": h.get("x-forwarded-for") || "",
        "user-agent": h.get("user-agent") || "",
      },
      body: JSON.stringify({
        affiliate_code: resolved.affiliate_code,
        link_id: resolved.link_id,
        source_type: resolved.type === "product" ? "product" : resolved.type === "seller_signup" ? "seller_signup" : "storefront",
        product_id: resolved.product_id || null,
        consent_marketing: consent,
        cookie_id: cookieId,
        referer: h.get("referer") || "",
      }),
      cache: "no-store",
    });
  } catch {
    // Click recording is best-effort — never block the redirect on it.
  }

  let dest;
  try {
    dest = new URL(resolved.target_url, request.url);
  } catch {
    return fallback();
  }
  dest.searchParams.set("ref", resolved.affiliate_code);

  const response = NextResponse.redirect(dest);
  if (consent && cookieId) {
    response.cookies.set(AFFILIATE_COOKIE_NAME, cookieId, {
      path: "/",
      maxAge: AFFILIATE_COOKIE_MAX_AGE_SECONDS,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }
  return response;
}
