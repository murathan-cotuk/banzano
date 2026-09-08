/**
 * Product / variant images stored by sellercentral:
 * - Gallery: metadata.media (DE) or metadata.translations[locale].media when set.
 * - Variants: image_url (default) + image_urls[locale] overrides.
 * - Parent umbrella rows often have no own media; listing cards must use the
 *   first child variant's first image.
 */

/** Normalize media entries (string | {url|src|path}) to a non-empty URL string. */
export function coerceMediaUrl(entry) {
  if (entry == null || entry === "") return "";
  if (typeof entry === "string") return entry.trim();
  if (typeof entry === "object") {
    const nested = entry.url ?? entry.src ?? entry.path ?? entry.href ?? "";
    return typeof nested === "string" ? nested.trim() : "";
  }
  return "";
}

function coerceMediaList(list) {
  if (!Array.isArray(list)) return [];
  return list.map(coerceMediaUrl).filter(Boolean);
}

const MEDIA_LOCALE_FALLBACK = ["de", "en", "tr", "fr", "es", "it"];

export function localizedProductMediaList(product, locale) {
  const meta = product?.metadata || {};
  const loc = String(locale || "de").toLowerCase();
  const trMap = meta.translations && typeof meta.translations === "object" ? meta.translations : {};
  const locList = coerceMediaList(trMap[loc]?.media);
  if (locList.length) return locList;
  const deList = coerceMediaList(trMap.de?.media);
  if (deList.length) return deList;
  const root = coerceMediaList(Array.isArray(meta.media) ? meta.media : []);
  if (root.length) return root;
  for (const l of MEDIA_LOCALE_FALLBACK) {
    if (l === loc || l === "de") continue;
    const list = coerceMediaList(trMap[l]?.media);
    if (list.length) return list;
  }
  return [];
}

export function variantImageUrlForLocale(variant, locale) {
  if (!variant) return "";
  const loc = String(locale || "de").toLowerCase();
  const map = variant.image_urls && typeof variant.image_urls === "object" ? variant.image_urls : {};
  if (map[loc]) return coerceMediaUrl(map[loc]);
  const keys = Object.keys(map).filter((k) => coerceMediaUrl(map[k]));
  if (keys.length === 0) return coerceMediaUrl(variant.image_url || variant.image || "");
  if (map.de) return coerceMediaUrl(map.de);
  if (loc === "de") return coerceMediaUrl(variant.image_url || variant.image || "");
  return coerceMediaUrl(variant.image_url || variant.image || "");
}

/**
 * Returns the full image list for a variant in the given locale.
 * Priority: locale media → default media → top-level media/images → mapped images[] → single image_url.
 */
export function variantMediaForLocale(variant, locale) {
  if (!variant) return [];
  const loc = String(locale || "de").toLowerCase();
  const vMeta = variant.metadata && typeof variant.metadata === "object" ? variant.metadata : {};
  // 1. Locale-specific media in translations
  const tr = vMeta.translations;
  if (tr && tr[loc] && Array.isArray(tr[loc].media) && tr[loc].media.length > 0) {
    const list = coerceMediaList(tr[loc].media);
    if (list.length) return list;
  }
  // 2. Default variant media (locale-agnostic)
  if (Array.isArray(vMeta.media) && vMeta.media.length > 0) {
    const list = coerceMediaList(vMeta.media);
    if (list.length) return list;
  }
  // 3. Top-level media on the variant object (some payloads)
  if (Array.isArray(variant.media) && variant.media.length > 0) {
    const list = coerceMediaList(variant.media);
    if (list.length) return list;
  }
  // 4. Backend-mapped images array (already resolved URL strings)
  if (Array.isArray(variant.images) && variant.images.length > 0) {
    const list = coerceMediaList(variant.images);
    if (list.length) return list;
  }
  // 5. Fallback: single cover image / locale map
  const single = variantImageUrlForLocale(variant, locale);
  return single ? [single] : [];
}

/**
 * Listing / card cover image.
 * Prefer the selected (or first) child variant's first image; then walk remaining
 * children; finally fall back to parent gallery / product.images / thumbnail.
 */
export function resolveProductListingImage(product, locale, preferredVariant = null) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const ordered = [];
  if (preferredVariant) ordered.push(preferredVariant);
  for (const variant of variants) {
    if (variant && variant !== preferredVariant) ordered.push(variant);
  }

  for (const variant of ordered) {
    const media = variantMediaForLocale(variant, locale);
    if (media[0]) return media[0];
  }

  const parentMedia = localizedProductMediaList(product, locale);
  if (parentMedia[0]) return parentMedia[0];

  const images = Array.isArray(product?.images) ? coerceMediaList(product.images) : [];
  if (images[0]) return images[0];

  // Mapper often already copied first-variant cover onto thumbnail / metadata.thumbnail.
  return coerceMediaUrl(
    product?.thumbnail ||
      product?.metadata?.thumbnail ||
      product?.image_url ||
      product?.image ||
      "",
  );
}

/** Second image for hover swap — second frame from the same source as the primary. */
export function resolveProductListingImageSecondary(product, locale, preferredVariant = null) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  const ordered = [];
  if (preferredVariant) ordered.push(preferredVariant);
  for (const variant of variants) {
    if (variant && variant !== preferredVariant) ordered.push(variant);
  }

  for (const variant of ordered) {
    const media = variantMediaForLocale(variant, locale);
    if (media[0]) return media[1] || "";
  }

  const parentMedia = localizedProductMediaList(product, locale);
  if (parentMedia[0]) return parentMedia[1] || "";
  const images = Array.isArray(product?.images) ? coerceMediaList(product.images) : [];
  return images[1] || "";
}

/**
 * Returns locale-specific variant content overrides (title, description, bullet_points).
 * Fallback chain: requested locale → de → en → any available translation → base fields.
 */
export function variantLocaleContent(variant, locale) {
  if (!variant) return {};
  const loc = String(locale || "de").toLowerCase();
  const vMeta = variant.metadata && typeof variant.metadata === "object" ? variant.metadata : {};
  const trMap = vMeta.translations && typeof vMeta.translations === "object" ? vMeta.translations : {};
  const FALLBACK = [loc, "de", "en", "tr", "fr", "es", "it"];

  function pick(field, base) {
    for (const l of FALLBACK) {
      if (trMap[l]?.[field]) return trMap[l][field];
    }
    return base ?? null;
  }

  function pickArr(field, base) {
    for (const l of FALLBACK) {
      if (Array.isArray(trMap[l]?.[field]) && trMap[l][field].length > 0) return trMap[l][field];
    }
    return Array.isArray(base) ? base : null;
  }

  return {
    title: pick("title", variant.title),
    description: pick("description", vMeta.description),
    bullet_points: pickArr("bullet_points", vMeta.bullet_points),
  };
}
