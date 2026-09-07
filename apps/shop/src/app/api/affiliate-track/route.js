import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  getBackendUrl,
  hasMarketingConsent,
  generateVisitorCookieId,
  normalizeRefParam,
  AFFILIATE_COOKIE_NAME,
  AFFILIATE_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/affiliate";

/**
 * Client-callable proxy for direct `?ref=AFF_XXX` landings that didn't go through /r/[code]
 * (e.g. an affiliate shared a raw product/category/storefront URL). Called by
 * AffiliateRefCapture.jsx. Same consent-gating + cookie-setting as the /r/[code] route, just
 * triggered from the client instead of a server redirect.
 */
export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const ref = normalizeRefParam(body?.ref);
  if (!ref) return NextResponse.json({ ok: false, message: "ref required" }, { status: 400 });

  const sourceType = body?.source_type === "product" ? "product" : "storefront";
  const productId = sourceType === "product" && body?.product_id ? String(body.product_id) : null;

  const cookieStore = await cookies();
  const consent = hasMarketingConsent(cookieStore);
  const existingCookieId = cookieStore.get(AFFILIATE_COOKIE_NAME)?.value || null;
  const cookieId = consent ? (existingCookieId || generateVisitorCookieId()) : null;

  const base = getBackendUrl();
  let attributed = false;
  try {
    const res = await fetch(`${base}/public/affiliate-track/click`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": request.headers.get("x-forwarded-for") || "",
        "user-agent": request.headers.get("user-agent") || "",
      },
      body: JSON.stringify({
        affiliate_code: ref,
        source_type: sourceType,
        product_id: productId,
        consent_marketing: consent,
        cookie_id: cookieId,
        referer: request.headers.get("referer") || "",
      }),
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      attributed = !!data?.attributed;
    }
  } catch {
    // Best-effort — the visitor's page load must never fail because of this.
  }

  const response = NextResponse.json({ ok: true, attributed });
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
