/**
 * Resolve image URL for display.
 *
 * Own-backend /uploads/ paths (relative or absolute) are returned as relative
 * paths so the shop rewrite proxies them. Foreign absolute upload hosts stay
 * as-is so legacy CDN files still load.
 */
const BACKEND_URL = (typeof process !== "undefined" && process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL) || "http://localhost:9000";
const BASE = (BACKEND_URL || "").replace(/\/$/, "");

/** Extract pathname from a full URL (http(s) or //). Returns null if not a valid URL. */
function getPathname(fullUrl) {
  if (!fullUrl || typeof fullUrl !== "string") return null;
  const s = fullUrl.trim();
  try {
    if (s.startsWith("//")) return new URL(`https:${s}`).pathname;
    if (s.startsWith("http")) return new URL(s).pathname;
  } catch (_) {}
  return null;
}

function isOwnUploadHost(fullUrl) {
  try {
    const abs = fullUrl.startsWith("//") ? `https:${fullUrl}` : fullUrl;
    const host = new URL(abs).hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return true;
    let backendHost = "";
    try {
      const b = BASE.startsWith("http") ? BASE : `https://${BASE}`;
      backendHost = new URL(b).hostname.toLowerCase();
    } catch (_) {}
    if (backendHost && host === backendHost) return true;
    if (host === "andertal.com" || host.endsWith(".andertal.com")) return true;
    return false;
  } catch (_) {
    return false;
  }
}

export function resolveImageUrl(url) {
  if (!url || typeof url !== "string") return "";
  const u = url.trim();
  if (!u) return "";

  if (!u.startsWith("http") && !u.startsWith("//")) {
    // Relative path: /uploads/... stays relative so shop rewrite proxy serves it
    if (u.startsWith("/uploads/")) return u;
    return `${BASE}${u.startsWith("/") ? "" : "/"}${u}`;
  }

  // Absolute URL: rewrite /uploads/ to a same-origin path only when the file
  // lives on this shop's own backend. Foreign hosts (legacy CDNs) must stay
  // absolute — stripping them made category thumbnails 404.
  const pathname = getPathname(u);
  if (pathname && pathname.startsWith("/uploads/")) {
    if (isOwnUploadHost(u)) return pathname;
    return u;
  }
  return u;
}

/**
 * Rewrite image URLs inside HTML (e.g. collection description richtext).
 * Ensures img src="/uploads/..." or wrong-host URLs use the configured backend.
 */
export function rewriteImageUrlsInHtml(html) {
  if (!html || typeof html !== "string") return html;
  return html.replace(
    /<img([^>]*)\ssrc=["']([^"']+)["']/gi,
    (match, attrs, src) => `<img${attrs} src="${resolveImageUrl(src)}"`
  );
}
