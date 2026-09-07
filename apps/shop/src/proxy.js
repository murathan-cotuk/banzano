import createMiddleware from "next-intl/middleware";
import { NextRequest, NextResponse } from "next/server";
import { routing } from "./i18n/routing";
import {
  parseMarketPath,
  DEFAULT_CURRENCY,
  DEFAULT_MARKET,
  isValidCurrency,
  isValidLocale,
  isValidMarket,
  marketPrefix,
} from "./lib/shop-market";

function marketTripleFromCookie(request) {
  const raw = (request.cookies.get("andertal_market_prefix")?.value || "").trim();
  if (!raw.startsWith("/")) return null;
  return parseMarketPath(raw);
}

const LOCALES = routing.locales;
const DEFAULT_LOCALE = routing.defaultLocale;

/** Cloudflare / Vercel edge: visitor ISO 3166-1 alpha-2, upper case */
function geoCountryFromRequest(request) {
  const raw = (
    request.headers.get("cf-ipcountry") ||
    request.headers.get("x-vercel-ip-country") ||
    ""
  )
    .trim()
    .toUpperCase();
  if (!raw || raw === "XX") return "";
  return /^[A-Z]{2}$/.test(raw) ? raw : "";
}

/** First URL path segment for shop market (lowercase ISO country); null if geo unknown */
function marketFromGeoRequest(request) {
  const code = geoCountryFromRequest(request);
  if (!code) return null;
  const lower = code.toLowerCase();
  return isValidMarket(lower) ? lower : null;
}

/** Shop UI language from browser Accept-Language only (not from geo). */
function localeFromAcceptLanguage(request) {
  const acceptLanguage = request.headers.get("accept-language") || "";
  const acc = acceptLanguage.split(",").map((s) => (s.split(";")[0] || "").trim());
  for (const part of acc) {
    const lang = (part.split("-")[0] || "").toLowerCase();
    if (LOCALES.includes(lang)) return lang;
  }
  return null;
}

function requestWithPreferredLocale(request) {
  const pathname = request.nextUrl.pathname || "";
  const parts = pathname.split("/").filter(Boolean);
  if (parseMarketPath(pathname)) return request;
  if (parts.length >= 1 && isValidLocale(parts[0])) return request;

  const preferred = localeFromAcceptLanguage(request);
  if (!preferred) return request;

  const acceptLanguage = request.headers.get("accept-language") || "";
  const newHeaders = new Headers(request.headers);
  newHeaders.set("accept-language", `${preferred},${acceptLanguage}`);

  return new NextRequest(request.url, {
    method: request.method,
    headers: newHeaders,
  });
}

const intlMiddleware = createMiddleware(routing);

// Paths that require customer login (matched against the locale-stripped path segment)
const PROTECTED_SEGMENTS = new Set([
  "account", "orders", "addresses", "reviews", "bonus",
  "merkzettel", "wishlist", "invoices",
]);

function isProtectedPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  return parts.some(p => PROTECTED_SEGMENTS.has(p));
}

/** Next.js 16+: request interception lives in `proxy.js` (not `middleware.js`). */
export default function proxy(request) {
  const pathname = request.nextUrl.pathname || "";

  // Server-level auth guard: redirect to login if cookie missing for protected routes
  if (isProtectedPath(pathname)) {
    const authCookie = request.cookies.get("andertal_cauth");
    if (!authCookie?.value) {
      // Determine locale from path segments
      const parts = pathname.split("/").filter(Boolean);
      // Try: market path like /{market}/{locale}/{currency}/... or /{locale}/...
      const triple = parseMarketPath(pathname);
      const cookieT = marketTripleFromCookie(request);
      const locale = triple?.lang
        || (parts.length >= 1 && LOCALES.includes(parts[0]) ? parts[0] : DEFAULT_LOCALE);
      const market =
        cookieT?.country && isValidMarket(cookieT.country)
          ? cookieT.country
          : marketFromGeoRequest(request) || DEFAULT_MARKET;
      const loginUrl = new URL(`${marketPrefix(market, locale)}/login`, request.url);
      loginUrl.searchParams.set("redirect", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  if (pathname === "/sale" || pathname === "/sale/") {
    const loc = localeFromAcceptLanguage(request) || DEFAULT_LOCALE;
    const market = marketFromGeoRequest(request) || DEFAULT_MARKET;
    return NextResponse.redirect(
      new URL(`${marketPrefix(market, loc, DEFAULT_CURRENCY)}/sale`, request.url),
    );
  }

  const triple = parseMarketPath(pathname);
  if (triple) {
    const rawParts = pathname.split("/").filter(Boolean);
    const hadLegacyCurrencySegment =
      rawParts.length >= 3 && isValidCurrency(rawParts[2]);

    const mp = marketPrefix(triple.country, triple.lang);
    const canonicalPath =
      triple.rest === "" || triple.rest === "/"
        ? `${mp}/`
        : `${mp}${triple.rest.startsWith("/") ? triple.rest : `/${triple.rest}`}`;

    if (hadLegacyCurrencySegment) {
      const u = request.nextUrl.clone();
      u.pathname = canonicalPath;
      const redirectRes = NextResponse.redirect(u);
      try {
        redirectRes.cookies.set("andertal_market_prefix", mp, {
          path: "/",
          maxAge: 60 * 60 * 24 * 365,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
        });
        if (triple.currency && isValidCurrency(triple.currency)) {
          redirectRes.cookies.set("andertal_currency", triple.currency.toLowerCase(), {
            path: "/",
            maxAge: 60 * 60 * 24 * 365,
            sameSite: "lax",
            secure: process.env.NODE_ENV === "production",
          });
        }
      } catch (_) {}
      return redirectRes;
    }

    const internal =
      !triple.rest || triple.rest === "/"
        ? `/${triple.lang}`
        : `/${triple.lang}${triple.rest}`;
    const u = request.nextUrl.clone();
    u.pathname = internal;
    const h = new Headers(request.headers);
    h.set("x-andertal-market-prefix", mp);
    h.set("x-andertal-locale", String(triple.lang || "").toLowerCase());
    const curCookie = (request.cookies.get("andertal_currency")?.value || "").trim().toLowerCase();
    if (curCookie && isValidCurrency(curCookie)) {
      h.set("x-andertal-currency", curCookie);
    }
    const forwarded = new NextRequest(u, {
      headers: h,
      method: request.method,
    });
    const intlRes = intlMiddleware(forwarded);
    try {
      intlRes.cookies.set("andertal_market_prefix", mp, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    } catch (_) {}
    return intlRes;
  }

  const parts = pathname.split("/").filter(Boolean);
  if (parts.length >= 1 && isValidLocale(parts[0])) {
    const loc = parts[0].toLowerCase();
    const rest = parts.length > 1 ? `/${parts.slice(1).join("/")}` : "";
    const cookieT = marketTripleFromCookie(request);
    const market =
      cookieT?.country && isValidMarket(cookieT.country)
        ? cookieT.country
        : marketFromGeoRequest(request) || DEFAULT_MARKET;
    const mp = marketPrefix(market, loc);
    const destPath =
      rest === "" || rest === "/" ? `${mp}/` : `${mp}${rest}`;
    const dest = new URL(destPath, request.url);
    const redirectRes = NextResponse.redirect(dest);
    try {
      redirectRes.cookies.set("andertal_market_prefix", mp, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    } catch (_) {}
    return redirectRes;
  }

  if (pathname === "/" || pathname === "") {
    // 1. Returning visitor: use saved cookie
    const cookieT = marketTripleFromCookie(request);
    if (cookieT?.country && cookieT?.lang) {
      const mp = marketPrefix(cookieT.country, cookieT.lang);
      return NextResponse.redirect(new URL(mp + "/", request.url));
    }

    // 2. Language from browser only (not from geo).
    const locale = localeFromAcceptLanguage(request) || DEFAULT_LOCALE;

    // 3. Market (country segment) from geo IP; fallback default shop market.
    const market = marketFromGeoRequest(request) || DEFAULT_MARKET;

    const mp = marketPrefix(market, locale, DEFAULT_CURRENCY);
    const redirectRes = NextResponse.redirect(new URL(mp + "/", request.url));
    try {
      redirectRes.cookies.set("andertal_market_prefix", mp, {
        path: "/",
        maxAge: 60 * 60 * 24 * 365,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
      });
    } catch (_) {}
    return redirectRes;
  }

  const requestToUse = requestWithPreferredLocale(request);
  return intlMiddleware(requestToUse);
}

export const config = {
  // `icon`/`apple-icon` are Next.js's extensionless metadata routes (from src/app/icon.png,
  // apple-icon.png) — they have no dot in the path so the `.*\..*` exclusion below doesn't
  // catch them, and without this they get swept into intlMiddleware and 307-redirected to a
  // locale-prefixed path (e.g. /en/icon), which broke the favicon / apple-touch-icon entirely.
  // `r/*` is the affiliate short-link redirect (docs/affiliate.md) — it must reach
  // src/app/r/[code]/route.js directly, un-prefixed; letting it fall through to intlMiddleware
  // would 307 it to e.g. /de/r/abc123 and the short link would 404.
  matcher: ["/((?!api|_next|_vercel|monitoring|icon$|apple-icon$|r/|.*\\..*).*)"],
};
