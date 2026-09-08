/**
 * Title/name → URL handle (SEO-style).
 * - Words from spaces (and hyphens) become segments joined by "-".
 * - First segment: lowercase. Each following segment: first letter uppercase, rest lowercase.
 * Example: "Vampire Vape 30ml Aroma" → "vampire-Vape-30ml-Aroma"
 * Transliteration: ü→u, ö→o, … (same as before).
 */

const CHAR_MAP = {
  ü: "ue", Ü: "ue", ö: "oe", Ö: "oe", ä: "ae", Ä: "ae",
  ı: "i", I: "i", İ: "i",
  ç: "c", Ç: "c", ğ: "g", Ğ: "g",
  ß: "ss", æ: "ae", Æ: "ae", ø: "oe", Ø: "oe", å: "a", Å: "a",
};

const PLACEHOLDER_HANDLE_RE = /^(untitled|unbenannt|product|produkt)$/i;

export function isPlaceholderHandle(value) {
  const t = String(value || "").trim();
  return !t || PLACEHOLDER_HANDLE_RE.test(t);
}

function transliterate(s) {
  let out = s;
  for (const [from, to] of Object.entries(CHAR_MAP)) {
    out = out.split(from).join(to);
  }
  return out;
}

function segmentToLower(s) {
  return String(s || "").toLowerCase();
}

function capitalizeFirst(s) {
  const t = String(s || "");
  if (!t) return "";
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

export function titleToHandle(str) {
  if (!str || typeof str !== "string") return "";
  let s = transliterate(str.trim());
  s = s.toLowerCase().replace(/[^a-z0-9\s-]/g, " ");
  const rawParts = s.split(/[\s-]+/).map((p) => p.trim()).filter(Boolean);
  if (rawParts.length === 0) return "";

  const segments = rawParts.map((part, i) => {
    const lower = segmentToLower(part);
    if (!lower) return "";
    if (i === 0) return lower;
    return capitalizeFirst(lower);
  }).filter(Boolean);

  return segments.join("-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Allow manual edits: letters, digits, hyphens; collapse repeated hyphens.
 * Does NOT strip a trailing hyphen — this runs on every keystroke (onChange), and
 * trimming the trailing "-" the instant it's typed made it look like "-" could never
 * be entered at all (each keypress immediately erased the hyphen the user just typed
 * at the cursor/end position). Leading hyphens are still stripped since a slug can't
 * usefully start with one and users don't type at position 0 while mid-edit.
 */
export function sanitizeSeoHandleInput(raw) {
  return String(raw || "")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-/, "");
}

/** Final cleanup at save time: also drop a trailing hyphen left over from editing. */
export function normalizeSeoHandle(raw) {
  return sanitizeSeoHandleInput(raw).replace(/-$/, "");
}
