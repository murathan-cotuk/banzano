/**
 * Category thumbnail for header / mobile menu cards.
 * Handles string URLs, JSON-array strings, and {url|src|path} objects.
 */
export function unwrapCategoryImageValue(raw, depth = 0) {
  if (raw == null || raw === "" || depth > 4) return "";
  if (Array.isArray(raw)) return unwrapCategoryImageValue(raw[0], depth + 1);
  if (typeof raw === "object") {
    return unwrapCategoryImageValue(raw.url || raw.src || raw.path || "", depth + 1);
  }
  const s = String(raw).trim();
  if (!s || s === "[object Object]") return "";
  if (s.startsWith("[")) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed) && parsed[0]) return unwrapCategoryImageValue(parsed[0], depth + 1);
    } catch (_) {}
  }
  return s;
}

export function pickCategoryListImageRaw(node) {
  if (!node) return "";
  const meta = node.metadata && typeof node.metadata === "object" ? node.metadata : {};
  const candidates = [
    node.image_url,
    meta.image_url,
    meta.imageUrl,
    node.banner_image_url,
    meta.banner_image_url,
  ];
  for (const c of candidates) {
    const parsed = unwrapCategoryImageValue(c);
    if (parsed) return parsed;
  }
  return "";
}
