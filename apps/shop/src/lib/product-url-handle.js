/**
 * Product URL slug for the current storefront language.
 * Per-locale handles live in metadata.translations[locale].handle (sellercentral).
 * Format: {handle}-a-{8chars} where 8chars = last 8 chars of Medusa ULID (without prod_ prefix).
 */

const PLACEHOLDER_HANDLE_RE = /^(untitled|unbenannt|product|produkt)$/i;

export function isPlaceholderHandle(value) {
  const t = String(value || "").trim();
  return !t || PLACEHOLDER_HANDLE_RE.test(t);
}

function firstRealHandle(...vals) {
  for (const v of vals) {
    const t = String(v || "").trim();
    if (t && !isPlaceholderHandle(t)) return t;
  }
  for (const v of vals) {
    const t = String(v || "").trim();
    if (t) return t;
  }
  return "";
}

/** Last 8 chars of the catalog UUID (listing composite ids must not be used). */
export function productUrlShortCode(productOrId) {
  const raw = String(
    typeof productOrId === "object" && productOrId
      ? (productOrId.id || "")
      : (productOrId || ""),
  )
    .replace(/^prod_/i, "")
    .toLowerCase();
  const uuid = raw.match(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  );
  const id = uuid ? uuid[0] : raw;
  return id.length >= 8 ? id.slice(-8) : id;
}

export function storefrontProductHandle(product, locale) {
  if (!product) return "";
  const loc = String(locale || "de").toLowerCase();
  const trMap = product.metadata?.translations && typeof product.metadata.translations === "object"
    ? product.metadata.translations
    : {};
  const tr = trMap[loc];
  const h = firstRealHandle(
    tr?.handle,
    product.handle,
    trMap.de?.handle,
  );
  if (!h) return "";
  const shortCode = productUrlShortCode(product);
  return shortCode ? `${h}-a-${shortCode}` : h;
}

/** Shop URLs are {handle}-a-{8} or legacy {handle}-{8}. */
export function parseProductUrlHandle(urlHandle) {
  const full = String(urlHandle || "").trim();
  if (!full) return { full: "", base: "", shortCode: "" };
  const lastDash = full.lastIndexOf("-");
  if (lastDash < 1) return { full, base: full, shortCode: "" };
  const suffix = full.slice(lastDash + 1);
  if (!/^[a-z0-9]{8}$/i.test(suffix)) return { full, base: full, shortCode: "" };
  const withoutSuffix = full.slice(0, lastDash);
  const base = withoutSuffix.toLowerCase().endsWith("-a")
    ? withoutSuffix.slice(0, -2)
    : withoutSuffix;
  return { full, base, shortCode: suffix.toLowerCase() };
}

/** Extracts the base handle from a URL segment that may include an -a-{8char} or legacy {8char} suffix. */
export function baseHandleFromUrl(urlHandle) {
  return parseProductUrlHandle(urlHandle).base || "";
}
