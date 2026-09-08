/**
 * Format number with comma as decimal separator (e.g. 9,95)
 */
export function formatDecimal(num) {
  if (num == null || Number.isNaN(Number(num))) return "0,00";
  const n = Number(num);
  const fixed = n.toFixed(2);
  return fixed.replace(".", ",");
}

/**
 * Format price in cents to string with comma (e.g. 995 -> "9,95")
 */
export function formatPriceCents(cents) {
  if (cents == null || Number.isNaN(Number(cents))) return "0,00";
  const value = Number(cents) / 100;
  return formatDecimal(value);
}

/**
 * Get title and description for a product in the given locale (from metadata.translations).
 * Fallback chain: requested locale → de → en → any available translation → product.title/description.
 */
const LOCALES = ["de", "en", "tr", "fr", "es", "it"];

/** New products default to this placeholder; it must not block fallback to a real locale title. */
export function isPlaceholderProductTitle(value) {
  const t = String(value || "").trim();
  return !t || /^(untitled|unbenannt)$/i.test(t);
}

function pickTranslatedField(tr, meta, field, locale, base) {
  const loc = String(locale || "de").slice(0, 2).toLowerCase();
  const fallbackOrder = [loc, "de", "en"];
  const usable = (fieldName, val) => {
    if (!val) return false;
    if (fieldName === "title" && isPlaceholderProductTitle(val)) return false;
    return true;
  };
  if (tr) {
    for (const l of fallbackOrder) {
      if (l && usable(field, tr[l]?.[field])) return tr[l][field];
    }
    for (const l of LOCALES) {
      if (usable(field, tr[l]?.[field])) return tr[l][field];
    }
  }
  const flatKey = `${field}_${loc}`;
  if (meta?.[flatKey]) return meta[flatKey];
  for (const l of LOCALES) {
    const k = `${field}_${l}`;
    if (meta?.[k]) return meta[k];
  }
  return base ?? "";
}

/**
 * Localized category name/description from metadata.translations.
 */
export function getLocalizedCategory(category, locale) {
  if (!category) return { name: "", description: "" };
  const meta = category.metadata && typeof category.metadata === "object" ? category.metadata : {};
  const tr = meta.translations;
  return {
    name: pickTranslatedField(tr, meta, "name", locale, category.name),
    description: pickTranslatedField(tr, meta, "description", locale, category.description),
  };
}

export function getLocalizedProduct(product, locale) {
  if (!product) return { title: "", description: "" };
  const tr = product.metadata?.translations;
  const fallbackOrder = [locale, "de", "en"];
  const LOCALES = ["de", "en", "tr", "fr", "es", "it"];

  function pickField(field, base) {
    const usable = (val) => {
      if (!val) return false;
      if (field === "title" && isPlaceholderProductTitle(val)) return false;
      return true;
    };
    if (tr) {
      for (const l of fallbackOrder) {
        if (l && usable(tr[l]?.[field])) return tr[l][field];
      }
      for (const l of LOCALES) {
        if (usable(tr[l]?.[field])) return tr[l][field];
      }
    }
    return usable(base) ? base : (base ?? "");
  }

  return {
    title: pickField("title", product.title),
    description: pickField("description", product.description),
  };
}

/**
 * Cart line title from API: `title` is frozen at add-to-cart; `product_title` + `product_metadata`
 * carry DB + translations so the name follows the active shop locale.
 */
export function getLocalizedCartLineTitle(item, locale) {
  if (!item) return "";
  const raw = item.title || "";
  const dbTitle = item.product_title;
  const meta = item.product_metadata;
  if (dbTitle != null && String(dbTitle).trim() !== "" && meta != null && typeof meta === "object") {
    const { title } = getLocalizedProduct({ title: dbTitle, metadata: meta }, locale);
    const m = raw.match(/^(.*)\s+\((.+)\)$/);
    if (m && m[2]) return `${title} (${m[2]})`;
    return title || raw;
  }
  return raw;
}

/**
 * Strip HTML tags and return plain text (for product description preview)
 */
export function htmlToText(html) {
  if (!html || typeof html !== "string") return "";
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip HTML and truncate to maxLen (for search dropdown – plain text only).
 * Use in frontend only; no backend sanitization needed.
 */
export function stripHtmlForSearch(html, maxLen = 120) {
  const text = htmlToText(html);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim() + "…";
}
