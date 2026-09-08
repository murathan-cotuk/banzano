"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Link, useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import {
  Page,
  Layout,
  Card,
  Button,
  Text,
  TextField,
  BlockStack,
  InlineStack,
  Box,
  Banner,
  Checkbox,
  Divider,
  Select,
  Tabs,
} from "@shopify/polaris";
import { ProductIcon, LockIcon } from "@shopify/polaris-icons";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { useUnsavedChanges } from "@/context/UnsavedChangesContext";
import MediaPickerModal from "@/components/MediaPickerModal";
import CategoryDrilldownSelect from "@/components/inputs/CategoryDrilldownSelect";
import ComplianceFieldsSection from "@/components/products/ComplianceFieldsSection";
import InfoIconTooltip from "@/components/InfoIconTooltip";
import { decodeVariantPathKey, findVariantIndexByOptionKey } from "@/lib/variant-path-key";
import {
  ProductSectionHeading,
  ProductSectionRule,
  PRODUCT_SECTION_STYLES,
} from "@/components/products/ProductSection";
import { lt } from "@/lib/locale-text";
import { seoPlainPreview } from "@/lib/product-change-request-format";
import { EU_ORIGIN_STATUS } from "@andertal/shop-theme";

/** Same shape as ProductEditPage's getMeta/updateMeta, but reads/writes the VARIANT's own
 * metadata — each variant is an independent sellable unit; the parent only groups them.
 * Category/brand typically follow the parent via parent_locked_fields. */
function getMeta(obj, key, fallback = "") {
  const m = obj?.metadata;
  if (!m || typeof m !== "object") return fallback;
  return m[key] != null && m[key] !== "" ? String(m[key]) : fallback;
}

/** Maße / Grundpreis fields copied together when "spezifikationen" is locked to parent. */
const SPEZ_LOCK_KEYS = [
  "dimensions_width",
  "dimensions_height",
  "dimensions_length",
  "weight_grams",
  "sales_unit",
  "packaging_unit",
  "packaging_unit_plural",
  "unit_type",
  "unit_value",
  "unit_reference",
];

function copyMetaKey(target, source, key) {
  if (source[key] === "" || source[key] == null) delete target[key];
  else target[key] = source[key];
}

/** Re-apply locked fields from parent so save always mirrors live parent values. */
function applyLockedParentValues(variant, parentProduct, locale = "de") {
  const m = { ...(variant?.metadata && typeof variant.metadata === "object" ? variant.metadata : {}) };
  const locks = Array.isArray(m.parent_locked_fields) ? m.parent_locked_fields : [];
  if (!locks.length) return variant;
  const pm = parentProduct?.metadata && typeof parentProduct.metadata === "object" ? parentProduct.metadata : {};
  let next = { ...variant };

  for (const key of locks) {
    if (key === "title") {
      if (locale === "de") {
        next.title = parentProduct?.title ?? next.title;
      } else {
        const ptr = pm.translations?.[locale]?.title;
        const tr = { ...(m.translations || {}) };
        tr[locale] = { ...(tr[locale] || {}), title: ptr != null ? String(ptr) : "" };
        m.translations = tr;
      }
    } else if (key === "description") {
      const pDesc =
        locale === "de"
          ? parentProduct?.description || pm.description || ""
          : pm.translations?.[locale]?.description || "";
      if (locale === "de") {
        m.description = pDesc;
      } else {
        const tr = { ...(m.translations || {}) };
        tr[locale] = { ...(tr[locale] || {}), description: pDesc };
        m.translations = tr;
      }
    } else if (key === "category_id") {
      copyMetaKey(m, pm, "category_id");
      copyMetaKey(m, pm, "admin_category_id");
      copyMetaKey(m, pm, "category_ids");
      copyMetaKey(m, pm, "category_slug");
    } else if (key === "brand_id") {
      copyMetaKey(m, pm, "brand_id");
    } else if (key === "metafields") {
      if (pm.metafields != null) m.metafields = structuredClone
        ? structuredClone(pm.metafields)
        : JSON.parse(JSON.stringify(pm.metafields));
      else delete m.metafields;
    } else if (key === "spezifikationen") {
      for (const sk of SPEZ_LOCK_KEYS) copyMetaKey(m, pm, sk);
    } else {
      copyMetaKey(m, pm, key);
    }
  }
  next.metadata = m;
  return next;
}

const getDefaultBaseUrl = () => {
  const env = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "";
  const url = (typeof env === "string" ? env : "").trim();
  return url || (typeof window !== "undefined" ? "http://localhost:9000" : "");
};

function sanitizePriceDraftString(s) {
  const t = String(s ?? "").replace(",", ".");
  let out = "";
  let dot = false;
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !dot) {
      dot = true;
      out += ".";
    }
  }
  return out;
}

function descriptionVisualToHtml(html) {
  const s = (html || "").trim();
  if (!s) return "";
  if (/<(p|div|h[1-6]|ul|ol|li)\b/i.test(s)) return s;
  return `<p>${s}</p>`;
}

function categoryLineageIdsFromFlatList(flatCategories, categoryId) {
  if (!categoryId || !Array.isArray(flatCategories) || flatCategories.length === 0) return [];
  const byId = new Map(flatCategories.map((c) => [String(c.id), c]));
  const out = [];
  let cur = byId.get(String(categoryId));
  const seen = new Set();
  while (cur && !seen.has(String(cur.id))) {
    seen.add(String(cur.id));
    out.push(String(cur.id));
    const pid = cur.parent_id != null ? String(cur.parent_id) : "";
    cur = pid && byId.has(pid) ? byId.get(pid) : null;
  }
  return out;
}

function variantImageUrlForLocale(row, loc) {
  const l = String(loc || "de").toLowerCase();
  const map = row?.image_urls && typeof row.image_urls === "object" ? row.image_urls : {};
  if (map[l]) return map[l];
  const keys = Object.keys(map).filter((k) => map[k] != null && String(map[k]).trim() !== "");
  if (keys.length === 0) return row?.image_url || "";
  if (map.de) return map.de;
  if (l === "de") return row?.image_url || "";
  return row?.image_url || "";
}

function optionDisplayLabel(opt, loc) {
  const l = String(loc || "de").toLowerCase();
  if (opt && typeof opt === "object") {
    const labels = opt.labels && typeof opt.labels === "object" ? opt.labels : {};
    if (Object.prototype.hasOwnProperty.call(labels, l)) {
      const s = labels[l];
      if (s != null && String(s).trim() !== "") return String(s).trim();
    }
    return String(opt.value ?? "").trim();
  }
  return String(opt ?? "").trim();
}

const STATUS_OPTIONS = (locale) => [
  { label: lt(locale, "Active", "Aktif", "Actif", "Activo", "Attivo", "Aktiv"), value: "published" },
  { label: lt(locale, "Draft", "Taslak", "Brouillon", "Borrador", "Bozza", "Entwurf"), value: "draft" },
  { label: lt(locale, "Inactive", "Pasif", "Inactif", "Inactivo", "Inattivo", "Inaktiv"), value: "archived" },
];

const UNIT_TYPE_OPTIONS = (locale) => [
  { label: lt(locale, "— None —", "— Yok —", "— Aucun —", "— Ninguno —", "— Nessuno —", "— Keine —"), value: "" },
  { label: "kg", value: "kg" },
  { label: "g", value: "g" },
  { label: "L", value: "L" },
  { label: "ml", value: "ml" },
  { label: lt(locale, "Piece", "Adet", "Pièce", "Pieza", "Pezzo", "Stück"), value: "stück" },
];

function normalizeForCompareProduct(p) {
  if (!p) return p;
  const { updated_at, created_at, ...rest } = p;
  return rest;
}

/**
 * @param {{ product: object, idOrHandle: string, variantKeySegment: string, onReload: () => void }} props
 */
export default function VariantEditPage({ product: initialProduct, idOrHandle, variantKeySegment, onReload }) {
  const router = useRouter();
  const locale = useLocale();
  const client = getMedusaAdminClient();
  const baseUrl = (client.baseURL || getDefaultBaseUrl()).replace(/\/$/, "");
  const unsaved = useUnsavedChanges();
  const t = useCallback((en, tr, fr, es, it, de) => lt(locale, en, tr, fr, es, it, de), [locale]);

  const optionKeyParts = useMemo(() => decodeVariantPathKey(variantKeySegment), [variantKeySegment]);

  const [product, setProduct] = useState(initialProduct);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  const [descriptionMode, setDescriptionMode] = useState("visual");
  const descEditorRef = useRef(null);
  const [priceInputs, setPriceInputs] = useState({});
  const priceInputsRef = useRef({});
  const [isSuperuser, setIsSuperuser] = useState(false);
  const [categories, setCategories] = useState([]);
  const [brands, setBrands] = useState([]);
  const [shippingGroupsList, setShippingGroupsList] = useState([]);
  const [euOriginVerifying, setEuOriginVerifying] = useState(false);
  const [euOriginNotice, setEuOriginNotice] = useState("");
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsSuperuser(localStorage.getItem("sellerIsSuperuser") === "true");
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      client.getAdminHubCategories().then((r) => r.categories || []).catch(() => []),
      client.getBrands().then((r) => r.brands || []).catch(() => []),
      client.request("/admin-hub/v1/shipping-groups").then((r) => r?.groups || []).catch(() => []),
    ]).then(([categoriesList, brandsList, shippingList]) => {
      if (!cancelled) {
        setCategories(categoriesList);
        setBrands(brandsList);
        setShippingGroupsList(shippingList);
      }
    });
    return () => { cancelled = true; };
  }, [client]);

  const [baselineSnapshot, setBaselineSnapshot] = useState(() =>
    initialProduct ? JSON.stringify(normalizeForCompareProduct(initialProduct)) : null,
  );

  useEffect(() => {
    setProduct(initialProduct);
    setBaselineSnapshot(initialProduct ? JSON.stringify(normalizeForCompareProduct(initialProduct)) : null);
  }, [initialProduct]);

  const variantIndex = useMemo(() => {
    if (!optionKeyParts || !Array.isArray(product?.variants)) return -1;
    return findVariantIndexByOptionKey(product.variants, optionKeyParts);
  }, [product?.variants, optionKeyParts]);

  const v = variantIndex >= 0 ? product.variants[variantIndex] : null;
  const vm = v?.metadata && typeof v.metadata === "object" ? v.metadata : {};
  const vTr = (vm.translations || {})[locale] || {};

  const meta = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};
  const variantGroups = Array.isArray(meta.variation_groups) ? meta.variation_groups : [];

  const isDirty =
    !!product &&
    baselineSnapshot != null &&
    JSON.stringify(normalizeForCompareProduct(product)) !== baselineSnapshot;

  useEffect(() => {
    unsaved?.setDirty(!!isDirty);
  }, [isDirty, unsaved]);

  useEffect(() => {
    unsaved?.setHandlers({
      onSave: () => saveRef.current?.(),
      onDiscard: () => discardRef.current?.(),
    });
    return () => {
      unsaved?.clearHandlers?.();
      unsaved?.setDirty(false);
    };
  }, [unsaved]);

  const discard = useCallback(() => {
    setProduct(initialProduct);
    setBaselineSnapshot(initialProduct ? JSON.stringify(normalizeForCompareProduct(initialProduct)) : null);
    unsaved?.setDirty(false);
  }, [initialProduct, unsaved]);

  const patchVariant = useCallback(
    (updater) => {
      if (!optionKeyParts || variantIndex < 0) return;
      setProduct((prev) => {
        const variants = [...(prev?.variants || [])];
        const cur = variants[variantIndex];
        if (!cur) return prev;
        const next = typeof updater === "function" ? updater(cur) : { ...cur, ...updater };
        variants[variantIndex] = next;
        return { ...prev, variants };
      });
    },
    [optionKeyParts, variantIndex]
  );

  const editingTitle =
    locale === "de"
      ? (v?.title ?? "")
      : (vTr.title ?? "");

  // For DE: prefer v.metadata.description, fall back to translations.de.description (set by Excel import)
  const canonicalDesc = vm.description ?? vTr.description ?? "";
  const editingDescription =
    locale === "de" ? canonicalDesc : (vTr.description ?? "");

  useEffect(() => {
    if (!v || descriptionMode !== "visual" || !descEditorRef.current) return;
    const locks = Array.isArray(vm.parent_locked_fields) ? vm.parent_locked_fields : [];
    const lockedDesc = locks.includes("description");
    const html = (lockedDesc
      ? (locale === "de" ? (product?.description || "") : (product?.metadata?.translations?.[locale]?.description || ""))
      : editingDescription) || "";
    if (descEditorRef.current.innerHTML !== html) descEditorRef.current.innerHTML = html;
  }, [v, descriptionMode, locale, editingDescription, product, vm.parent_locked_fields]);

  const hasLocaleVariantMedia =
    locale !== "de" && Object.prototype.hasOwnProperty.call(vTr, "media");
  const variantMediaUrls = (() => {
    if (hasLocaleVariantMedia) {
      const m = vTr.media;
      if (Array.isArray(m)) return m.filter((u) => u != null && String(u).trim() !== "");
      return [];
    }
    const m = vm.media;
    if (Array.isArray(m)) return m.filter((u) => u != null && String(u).trim() !== "");
    return [];
  })();

  const variantSummary = useMemo(() => {
    if (!v?.option_values || !variantGroups.length) return v?.title || t("Variant", "Varyant", "Variante", "Variante", "Variante", "Variante");
    return v.option_values
      .map((val, gi) => {
        const g = variantGroups[gi];
        const opt = (g?.options || []).find(
          (o) => String(o.value || "").trim().toLowerCase() === String(val || "").trim().toLowerCase()
        );
        return opt ? optionDisplayLabel(opt, locale) : val;
      })
      .join(" · ");
  }, [v, variantGroups, locale]);

  const save = useCallback(async () => {
    if (!product || variantIndex < 0) return false;
    try {
      setSaving(true);
      setMessage({ type: "", text: "" });

      // Variant-only PATCH — avoids full-product GPSR gate that blocked sibling variants.
      const variantsToSave = (product.variants || []).map((row, i) => {
        if (i !== variantIndex) return row;
        let next = applyLockedParentValues(row, product, locale);
        const nm = { ...(next.metadata && typeof next.metadata === "object" ? next.metadata : {}) };
        const locks = Array.isArray(nm.parent_locked_fields) ? nm.parent_locked_fields : [];
        const pm = product.metadata && typeof product.metadata === "object" ? product.metadata : {};
        // Category / brand: follow parent when locked OR when child left empty.
        if (locks.includes("category_id") || !nm.category_id) {
          copyMetaKey(nm, pm, "category_id");
          copyMetaKey(nm, pm, "admin_category_id");
          copyMetaKey(nm, pm, "category_ids");
          copyMetaKey(nm, pm, "category_slug");
        }
        if (locks.includes("brand_id") || !nm.brand_id) {
          copyMetaKey(nm, pm, "brand_id");
        }
        next = { ...next, metadata: nm };
        return next;
      });

      const current = variantsToSave[variantIndex];
      if (String(current?.ean || "").trim() === "") {
        setMessage({
          type: "warning",
          text: t(
            "Enter an EAN for this variant before saving.",
            "Kaydetmeden önce bu varyant için EAN girin.",
            "Saisissez un EAN pour cette variante avant d'enregistrer.",
            "Introduzca un EAN para esta variante antes de guardar.",
            "Inserisci un EAN per questa variante prima di salvare.",
            "Bitte EAN für diese Variante eintragen, um zu speichern.",
          ),
        });
        return false;
      }

      const res = await client.patchProductVariants(idOrHandle, variantsToSave);
      const saved = res?.product || { ...product, variants: variantsToSave };
      setProduct(saved);
      setBaselineSnapshot(JSON.stringify(normalizeForCompareProduct(saved)));
      unsaved?.setDirty(false);
      setMessage({ type: "success", text: t("Saved", "Kaydedildi", "Enregistré", "Guardado", "Salvato", "Gespeichert") });
      onReload?.();
      return true;
    } catch (err) {
      setMessage({
        type: "error",
        text:
          err?.message ||
          t("Save failed", "Kaydetme başarısız", "Échec de l'enregistrement", "Error al guardar", "Salvataggio non riuscito", "Speichern fehlgeschlagen"),
      });
      return false;
    } finally {
      setSaving(false);
    }
  }, [product, variantIndex, idOrHandle, client, onReload, unsaved, locale, t]);

  const saveRef = useRef(save);
  const discardRef = useRef(discard);
  saveRef.current = save;
  discardRef.current = discard;

  const updateLocaleVariantField = (key, value) => {
    patchVariant((cur) => {
      const m = { ...(cur.metadata && typeof cur.metadata === "object" ? cur.metadata : {}) };
      const tr = { ...(m.translations || {}) };
      const locData = { ...(tr[locale] || {}) };
      locData[key] = value;
      tr[locale] = locData;
      m.translations = tr;
      return { ...cur, metadata: m };
    });
  };

  const updateVariantMeta = (key, value) => {
    patchVariant((cur) => {
      const m = { ...(cur.metadata && typeof cur.metadata === "object" ? cur.metadata : {}) };
      if (value === "" || value == null) delete m[key];
      else m[key] = value;
      return { ...cur, metadata: m };
    });
  };

  /**
   * Fields locked to the parent product's value: mirrors the parent live (both on screen and
   * on save) while locked — the field is disabled and shows the parent's current value.
   * Unlocking stops the mirroring and leaves the last-shown value in place, editable (it does
   * not clear the field).
   */
  const lockedFields = Array.isArray(vm.parent_locked_fields) ? vm.parent_locked_fields : [];
  const isFieldLocked = (key) => lockedFields.includes(key);
  const parentMeta = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};

  const effectiveMeta = (key, fallback = "") => {
    if (isFieldLocked(key)) return getMeta(product, key, fallback);
    if (key === "category_id" || key === "brand_id") {
      const own = getMeta(v, key, "");
      return own || getMeta(product, key, fallback);
    }
    return getMeta(v, key, fallback);
  };

  const effectiveSpez = (key, fallback = "") => {
    if (isFieldLocked("spezifikationen")) {
      const pv = parentMeta[key];
      return pv != null && pv !== "" ? String(pv) : fallback;
    }
    const ov = vm[key];
    return ov != null && ov !== "" ? String(ov) : fallback;
  };

  /** setValue: optional custom writer for fields not stored as a plain vm[key] (e.g. locale-translated description). */
  const toggleFieldLock = (key, parentValue, setValue) => {
    const nowLocked = isFieldLocked(key);
    patchVariant((cur) => {
      const m = { ...(cur.metadata && typeof cur.metadata === "object" ? cur.metadata : {}) };
      const cf = Array.isArray(m.parent_locked_fields) ? m.parent_locked_fields : [];
      if (nowLocked) {
        m.parent_locked_fields = cf.filter((k) => k !== key);
        return { ...cur, metadata: m };
      }
      m.parent_locked_fields = [...cf.filter((k) => k !== key), key];
      if (key === "spezifikationen") {
        for (const sk of SPEZ_LOCK_KEYS) copyMetaKey(m, parentMeta, sk);
      } else if (key === "metafields") {
        if (parentMeta.metafields != null) {
          m.metafields = structuredClone
            ? structuredClone(parentMeta.metafields)
            : JSON.parse(JSON.stringify(parentMeta.metafields));
        } else delete m.metafields;
      } else if (key === "category_id") {
        copyMetaKey(m, parentMeta, "category_id");
        copyMetaKey(m, parentMeta, "admin_category_id");
        copyMetaKey(m, parentMeta, "category_ids");
        copyMetaKey(m, parentMeta, "category_slug");
      } else if (key === "brand_id") {
        copyMetaKey(m, parentMeta, "brand_id");
      } else if (!setValue) {
        if (parentValue === "" || parentValue == null) delete m[key];
        else m[key] = parentValue;
      }
      return { ...cur, metadata: m };
    });
    if (!nowLocked && setValue) setValue(parentValue);
  };
  /** Lock toggle button placed next to a lockable field's label. */
  const LockToggle = ({ fieldKey, parentValue, setValue }) => {
    const locked = isFieldLocked(fieldKey);
    return (
      <button
        type="button"
        onClick={() => toggleFieldLock(fieldKey, parentValue, setValue)}
        title={locked ? t("Locked to parent value — click to unlock and edit", "Ana ürün değerine kilitli — düzenlemek için kilidi aç", "Verrouillé sur la valeur du produit parent — cliquez pour déverrouiller", "Bloqueado al valor del producto principal — clic para desbloquear", "Bloccato al valore del prodotto principale — clic per sbloccare", "An Hauptartikel-Wert gebunden — zum Bearbeiten entsperren") : t("Use parent value", "Ana ürün değerini kullan", "Utiliser la valeur du produit parent", "Usar el valor del producto principal", "Usa il valore del prodotto principale", "Wert vom Hauptartikel übernehmen")}
        style={{
          display: "inline-flex", alignItems: "center", justifyContent: "center",
          width: 22, height: 22, padding: 0, border: "none", borderRadius: 4, cursor: "pointer",
          background: locked ? "var(--p-color-bg-fill-brand, #303030)" : "transparent",
          color: locked ? "#fff" : "var(--p-color-icon-subdued)",
        }}
      >
        <span style={{ width: 14, height: 14, display: "block" }}><LockIcon /></span>
      </button>
    );
  };

  // Category / brand: empty child fields inherit parent on screen + on save (see effectiveMeta / save).

  const parentTitleForLocale =
    locale === "de"
      ? product?.title || ""
      : parentMeta.translations?.[locale]?.title || product?.title || "";
  const displayTitle = isFieldLocked("title") ? parentTitleForLocale : editingTitle;

  const parentDescForLocale =
    locale === "de"
      ? product?.description || ""
      : parentMeta.translations?.[locale]?.description || "";
  const displayDescription = isFieldLocked("description") ? parentDescForLocale : editingDescription;

  const updateVariantCategoryWithParents = useCallback((categoryId) => {
    const selected = String(categoryId || "").trim();
    patchVariant((cur) => {
      const m = { ...(cur.metadata && typeof cur.metadata === "object" ? cur.metadata : {}) };
      if (!selected) {
        delete m.category_id;
        delete m.admin_category_id;
        delete m.category_ids;
        delete m.category_slug;
        return { ...cur, metadata: m };
      }
      const byId = new Map((categories || []).map((c) => [String(c.id), c]));
      const catNode = byId.get(selected);
      const lineage = categoryLineageIdsFromFlatList(categories, selected);
      m.category_id = selected;
      m.admin_category_id = selected;
      m.category_ids = lineage.length > 0 ? lineage : [selected];
      if (catNode?.slug) m.category_slug = String(catNode.slug).replace(/^\//, "");
      return { ...cur, metadata: m };
    });
  }, [categories, patchVariant]);

  const handleVerifyEuOriginVariant = useCallback(async (manual) => {
    if (!product?.id || !v?.option_values) return;
    setEuOriginVerifying(true);
    setEuOriginNotice("");
    try {
      const res = await client.verifyEuOrigin(product.id, {
        manual: Boolean(manual),
        provider: vm.eu_origin_provider || "stub",
        variantOptionValues: v.option_values,
      });
      if (res?.product) setProduct(res.product);
      const st = res?.eu_origin?.eu_origin_status || res?.status;
      if (st === EU_ORIGIN_STATUS.VERIFIED) {
        setEuOriginNotice(t(
          "EU origin verified — badge appears in shop after saving.",
          "AB kökeni doğrulandı — kayıt sonrası mağazada rozet görünür.",
          "Origine UE vérifiée — le badge apparaît dans la boutique après enregistrement.",
          "Origen UE verificado — el badge aparece en la tienda tras guardar.",
          "Origine UE verificata — il badge appare nel negozio dopo il salvataggio.",
          "EU-Herkunft verifiziert — Badge erscheint im Shop nach Speichern.",
        ));
      } else {
        setEuOriginNotice(res?.message || t(
          "Verification pending (queue / superuser).",
          "Doğrulama beklemede (kuyruk / süper kullanıcı).",
          "Vérification en attente (file d'attente / superuser).",
          "Verificación pendiente (cola / superusuario).",
          "Verifica in sospeso (coda / superuser).",
          "Prüfung ausstehend (Warteschlange / Superuser).",
        ));
      }
    } catch (e) {
      setEuOriginNotice(e?.message || t("Verification failed.", "Doğrulama başarısız.", "Échec de la vérification.", "Error en la verificación.", "Verifica fallita.", "Verifizierung fehlgeschlagen"));
    } finally {
      setEuOriginVerifying(false);
    }
  }, [product?.id, v?.option_values, vm.eu_origin_provider, client, t]);

  const removeVariantMedia = (index) => {
    const next = variantMediaUrls.filter((_, i) => i !== index);
    if (locale === "de") updateVariantMeta("media", next.length ? next : undefined);
    else updateLocaleVariantField("media", next);
  };

  const resolveMediaUrl = (url) => {
    if (!url) return "";
    return url.startsWith("http") || url.startsWith("data:") ? url : `${baseUrl}${url.startsWith("/") ? "" : "/"}${url}`;
  };

  const metafieldsList = Array.isArray(vm.metafields)
    ? vm.metafields
    : vm.metafields && typeof vm.metafields === "object"
      ? Object.entries(vm.metafields).map(([k, val]) => ({ key: k, value: val }))
      : [];

  const effectiveMetafieldsList = (() => {
    if (isFieldLocked("metafields")) {
      const pmf = parentMeta.metafields;
      if (Array.isArray(pmf)) return pmf;
      if (pmf && typeof pmf === "object") return Object.entries(pmf).map(([k, val]) => ({ key: k, value: val }));
      return [];
    }
    return metafieldsList;
  })();

  // For DE: prefer v.metadata.bullet_points, fall back to translations.de.bullet_points (set by Excel import)
  const bullets =
    locale === "de"
      ? Array.isArray(vm.bullet_points) ? vm.bullet_points
        : Array.isArray(vTr.bullet_points) ? vTr.bullet_points : []
      : Array.isArray(vTr.bullet_points) ? vTr.bullet_points : [];

  if (optionKeyParts == null) {
    return (
      <Page title={t("Variant", "Varyant", "Variante", "Variante", "Variante", "Variante")}>
        <Banner tone="critical">{t("Invalid variant link.", "Geçersiz varyant bağlantısı.", "Lien de variante invalide.", "Enlace de variante inválido.", "Link variante non valido.", "Ungültiger Variantenlink.")}</Banner>
        <Box paddingBlockStart="400">
          <Button onClick={() => router.push(`/products/${idOrHandle}`)}>{t("Back to product", "Ürüne dön", "Retour au produit", "Volver al producto", "Torna al prodotto", "Zurück zum Produkt")}</Button>
        </Box>
      </Page>
    );
  }

  if (!v) {
    return (
      <Page title={t("Variant", "Varyant", "Variante", "Variante", "Variante", "Variante")}>
        <Banner tone="critical">{t("This variant no longer exists on the product.", "Bu varyant artık üründe bulunmuyor.", "Cette variante n'existe plus sur le produit.", "Esta variante ya no existe en el producto.", "Questa variante non esiste più nel prodotto.", "Diese Variante existiert nicht mehr im Produkt.")}</Banner>
        <Box paddingBlockStart="400">
          <Button onClick={() => router.push(`/products/${idOrHandle}`)}>{t("Back to product", "Ürüne dön", "Retour au produit", "Volver al producto", "Torna al prodotto", "Zurück zum Produkt")}</Button>
        </Box>
      </Page>
    );
  }

  return (
    <Page title="">
      <style>{`
        .product-edit-header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
        .product-edit-header .product-edit-title-link { display: inline-flex; align-items: center; gap: 6px; text-decoration: none; color: var(--p-color-text); font-size: 0.8125rem; }
        .product-edit-header .product-edit-name { margin: 0; font-size: 0.8125rem; font-weight: 700; }
        .product-media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(88px, 1fr)); gap: 8px; max-width: 400px; }
        .product-media-item { aspect-ratio: 1; border-radius: 6px; overflow: hidden; background: var(--p-color-bg-fill-secondary); position: relative; }
        .product-media-item img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .product-media-remove { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; border: none; border-radius: 50%; background: rgba(0,0,0,0.5); color: #fff; font-size: 13px; line-height: 1; cursor: pointer; }
        .product-media-add { aspect-ratio: 1; border-radius: 6px; border: 2px dashed var(--p-color-border); display: flex; align-items: center; justify-content: center; cursor: pointer; }
        .product-description-box { border: 1px solid var(--p-color-border); border-radius: 8px; overflow: hidden; background: var(--p-color-bg-surface); }
        .product-description-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 10px; background: var(--p-color-bg-surface-secondary); border-bottom: 1px solid var(--p-color-border); }
        .product-description-toolbar .product-desc-btn { width: 28px; height: 28px; padding: 0; border: none; border-radius: 6px; cursor: pointer; background: transparent; }
        .product-description-toolbar .product-desc-html-btn { width: 28px; height: 28px; padding: 0; border: none; border-radius: 6px; cursor: pointer; background: transparent; }
        .product-description-toolbar .product-desc-html-btn.active { background: var(--p-color-bg-surface-selected); }
        .product-description-editor { min-height: 120px; padding: 10px 12px; outline: none; font-size: 13px; line-height: 1.45; }
        .product-description-html { min-height: 120px; width: 100%; padding: 10px 12px; font-family: ui-monospace, monospace; font-size: 12px; border: none; resize: vertical; box-sizing: border-box; }
        .product-edit-price-grid { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 10px; align-items: start; }
        @media (max-width: 780px) { .product-edit-price-grid { grid-template-columns: 1fr; } }
        .variant-lock-disabled { opacity: 0.65; pointer-events: none; }
        ${PRODUCT_SECTION_STYLES}
      `}</style>

      {message.text && (
        <Box paddingBlockEnd="200">
          <Banner
            tone={message.type === "success" ? "success" : message.type === "warning" ? "warning" : "critical"}
            onDismiss={() => setMessage({ type: "", text: "" })}
          >
            {message.text}
          </Banner>
        </Box>
      )}

      <div className="product-edit-header">
        <Link href={`/products/${idOrHandle}`} className="product-edit-title-link">
          <span style={{ display: "flex", width: 20, height: 20 }}><ProductIcon /></span>
          <span className="product-edit-name">{product?.title || "Product"}</span>
        </Link>
        <Text as="span" variant="bodySm" tone="subdued">
          → Variant: {variantSummary}
        </Text>
        <Button
          size="slim"
          variant="tertiary"
          onClick={() => {
            try { sessionStorage.setItem(`pe_tab_${idOrHandle}`, "2"); } catch { /* ignore */ }
            router.push(`/products/${idOrHandle}`);
          }}
        >
          {t("Back to variations", "Varyasyonlara dön", "Retour aux variantes", "Volver a variantes", "Torna alle varianti", "Zurück zu Variationen")}
        </Button>
        <span style={{ flex: 1 }} />
        <Button size="slim" variant="primary" onClick={() => save()} loading={saving}>
          Save
        </Button>
      </div>

      <Box paddingBlockEnd="300">
        <Tabs
          tabs={[
            { id: "allgemein", content: t("General", "Genel", "Général", "General", "Generale", "Allgemein") },
            { id: "spezifikationen", content: t("Specifications", "Özellikler", "Spécifications", "Especificaciones", "Specifiche", "Spezifikationen") },
            { id: "rechtlich", content: t("Legal", "Yasal", "Juridique", "Legal", "Legale", "Rechtlich") },
          ]}
          selected={activeTabIndex}
          onSelect={setActiveTabIndex}
        />
      </Box>

      {activeTabIndex === 0 && (
      <Layout>
        <Layout.Section>
          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="300">
              <ProductSectionHeading>Variant options</ProductSectionHeading>
              <InlineStack gap="200" wrap>
                {(v.option_values || []).map((val, i) => (
                  <span
                    key={i}
                    style={{
                      padding: "4px 8px",
                      background: "var(--p-color-bg-fill-secondary)",
                      borderRadius: 6,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {variantGroups[i]?.name || `Group ${i + 1}`}: {val}
                  </span>
                ))}
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">
                {t(
                  "Option keys above; customer-facing labels follow the parent variation translations. Edit groups on the main product.",
                  "Yukarıdaki seçenek anahtarları; müşteri etiketleri ana ürün varyasyon çevirilerinden gelir. Grupları ana üründe düzenleyin.",
                  "Clés d'option ci-dessus ; les libellés clients suivent les traductions du produit parent.",
                  "Claves de opción arriba; las etiquetas de cliente siguen las traducciones del producto principal.",
                  "Chiavi opzione sopra; le etichette cliente seguono le traduzioni del prodotto principale.",
                  "Options-Schlüssel oben; kundenbezogene Labels folgen den Variations-Übersetzungen des Hauptartikels. Gruppen dort bearbeiten.",
                )}
              </Text>

              <ProductSectionRule />

              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <ProductSectionHeading>Title ({locale.toUpperCase()})</ProductSectionHeading>
                <LockToggle
                  fieldKey="title"
                  parentValue={parentTitleForLocale}
                  setValue={(val) => {
                    if (locale === "de") patchVariant({ title: val });
                    else updateLocaleVariantField("title", val);
                  }}
                />
              </InlineStack>
              <TextField
                label="Title"
                labelHidden
                value={displayTitle}
                onChange={(tVal) => {
                  if (locale === "de") patchVariant({ title: tVal });
                  else updateLocaleVariantField("title", tVal);
                }}
                autoComplete="off"
                disabled={isFieldLocked("title")}
              />

              <ProductSectionRule />

              <InlineStack gap="300" wrap>
                <Box minWidth="220px" flex="1">
                  <TextField
                    label="SKU"
                    value={v.sku ?? ""}
                    onChange={(tVal) => patchVariant({ sku: tVal })}
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="220px" flex="1">
                  <TextField
                    label="EAN"
                    value={v.ean ?? ""}
                    onChange={(tVal) => patchVariant({ ean: tVal || undefined })}
                    autoComplete="off"
                    error={String(v.ean || "").trim() === "" ? "EAN required" : undefined}
                  />
                </Box>
              </InlineStack>

              <ProductSectionRule />

              <ProductSectionHeading>
                {t("Shop assignment", "Mağaza ataması", "Attribution boutique", "Asignación de tienda", "Assegnazione negozio", "Shop-Zuordnung")}
              </ProductSectionHeading>
              <Text as="p" variant="bodySm" tone="subdued">
                {t(
                  "Category and brand follow the parent by default (lock). Shipping group stays per variant.",
                  "Kategori ve marka varsayılan olarak ana ürünü izler (kilit). Kargo grubu varyanta özel kalır.",
                  "Catégorie et marque suivent le parent par défaut (cadenas). Groupe d'expédition par variante.",
                  "Categoría y marca siguen al principal por defecto (candado). Grupo de envío por variante.",
                  "Categoria e marca seguono il principale di default (lucchetto). Gruppo di spedizione per variante.",
                  "Kategorie und Marke folgen standardmäßig dem Hauptartikel (Schloss). Versandgruppe bleibt pro Variante.",
                )}
              </Text>
              <InlineStack gap="300" wrap>
                <Box minWidth="220px" flex="1">
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <Text as="p" variant="bodySm" fontWeight="semibold">{t("Category", "Kategori", "Catégorie", "Categoría", "Categoria", "Kategorie")}</Text>
                    <LockToggle fieldKey="category_id" parentValue={getMeta(product, "category_id")} />
                  </InlineStack>
                  <Box paddingBlockStart="100" className={isFieldLocked("category_id") ? "variant-lock-disabled" : undefined}>
                    <CategoryDrilldownSelect
                      label={t("Category", "Kategori", "Catégorie", "Categoría", "Categoria", "Kategorie")}
                      labelHidden
                      categories={categories || []}
                      value={effectiveMeta("category_id")}
                      onChange={updateVariantCategoryWithParents}
                      placeholder={t("Select category", "Kategori seç", "Choisir une catégorie", "Seleccionar categoría", "Seleziona categoria", "Kategorie wählen")}
                    />
                  </Box>
                </Box>
                <Box minWidth="220px" flex="1">
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <Text as="span" variant="bodySm" fontWeight="semibold">{t("Brand", "Marka", "Marque", "Marca", "Marca", "Marke")}</Text>
                    <LockToggle fieldKey="brand_id" parentValue={getMeta(product, "brand_id")} />
                  </InlineStack>
                  <Box paddingBlockStart="100">
                    <Select
                      label={t("Brand", "Marka", "Marque", "Marca", "Marca", "Marke")}
                      labelHidden
                      options={[
                        { label: t("— None —", "— Yok —", "— Aucune —", "— Ninguna —", "— Nessuna —", "— Keine —"), value: "" },
                        ...(brands || [])
                          .filter((b) => (b.status || "active") === "active" || b.id === effectiveMeta("brand_id"))
                          .map((b) => {
                            const pending = (b.status || "active") !== "active";
                            const pendingSuffix = pending
                              ? ` (${t("pending authorization", "onay bekliyor", "autorisation en attente", "autorización pendiente", "autorizzazione in attesa", "Autorisierung ausstehend")})`
                              : "";
                            return { label: `${b.name}${pendingSuffix}`, value: b.id, disabled: pending };
                          }),
                      ]}
                      value={effectiveMeta("brand_id") || ""}
                      onChange={(val) => updateVariantMeta("brand_id", val || undefined)}
                      disabled={isFieldLocked("brand_id")}
                    />
                  </Box>
                </Box>
                <Box minWidth="220px" flex="1">
                  <Select
                    label={t("Shipping group", "Kargo grubu", "Groupe d'expédition", "Grupo de envío", "Gruppo di spedizione", "Versandgruppe")}
                    options={[
                      { label: t("— None —", "— Yok —", "— Aucun —", "— Ninguno —", "— Nessuno —", "— Keine —"), value: "" },
                      ...shippingGroupsList.map((g) => ({ label: g.name, value: g.id })),
                    ]}
                    value={vm.shipping_group_id ?? ""}
                    onChange={(val) => updateVariantMeta("shipping_group_id", val || undefined)}
                  />
                </Box>
              </InlineStack>

              <ProductSectionRule />

              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <ProductSectionHeading>Description</ProductSectionHeading>
                <LockToggle
                  fieldKey="description"
                  parentValue={parentDescForLocale}
                  setValue={(val) => (locale === "de" ? updateVariantMeta("description", val) : updateLocaleVariantField("description", val))}
                />
              </InlineStack>
              <div className={`product-description-box${isFieldLocked("description") ? " variant-lock-disabled" : ""}`}>
                <div className="product-description-toolbar">
                  <div />
                  <button
                    type="button"
                    className={`product-desc-html-btn ${descriptionMode === "html" ? "active" : ""}`}
                    onClick={() => {
                      if (descriptionMode === "visual" && descEditorRef.current) {
                        const html = descriptionVisualToHtml(descEditorRef.current.innerHTML || "");
                        if (locale === "de") updateVariantMeta("description", html);
                        else updateLocaleVariantField("description", html);
                      } else if (descriptionMode !== "visual" && descEditorRef.current) {
                        descEditorRef.current.innerHTML = displayDescription || "";
                      }
                      setDescriptionMode(descriptionMode === "html" ? "visual" : "html");
                    }}
                  >
                    HTML
                  </button>
                </div>
                {descriptionMode === "html" ? (
                  <textarea
                    className="product-description-html"
                    value={displayDescription}
                    onChange={(e) => {
                      if (locale === "de") updateVariantMeta("description", e.target.value);
                      else updateLocaleVariantField("description", e.target.value);
                    }}
                    rows={6}
                    spellCheck={false}
                  />
                ) : (
                  <div
                    ref={descEditorRef}
                    className="product-description-editor"
                    contentEditable={!isFieldLocked("description")}
                    suppressContentEditableWarning
                    onBlur={() => {
                      if (!descEditorRef.current || isFieldLocked("description")) return;
                      const html = descriptionVisualToHtml(descEditorRef.current.innerHTML || "");
                      if (locale === "de") updateVariantMeta("description", html);
                      else updateLocaleVariantField("description", html);
                    }}
                  />
                )}
              </div>

              <ProductSectionRule />

              <ProductSectionHeading>Media (variant gallery)</ProductSectionHeading>
              {locale !== "de" && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {hasLocaleVariantMedia
                    ? "Images for this language only; clear all to fall back to default variant media."
                    : "Using default variant media until you add images for this language."}
                </Text>
              )}
              <div className="product-media-grid">
                {variantMediaUrls.map((url, i) => (
                  <div key={i} className="product-media-item">
                    <img src={resolveMediaUrl(url)} alt="" />
                    <button type="button" className="product-media-remove" onClick={() => removeVariantMedia(i)}>
                      ×
                    </button>
                  </div>
                ))}
                {variantMediaUrls.length < 8 && (
                  <div className="product-media-add" role="button" tabIndex={0} onClick={() => setMediaPickerOpen(true)}>
                    +
                  </div>
                )}
              </div>
              <MediaPickerModal
                open={mediaPickerOpen}
                onClose={() => setMediaPickerOpen(false)}
                title="Select images"
                multiple
                uploadPurpose="product"
                onSelect={(urls) => {
                  const toAdd = urls.slice(0, Math.max(0, 8 - variantMediaUrls.length));
                  if (!toAdd.length) return;
                  const merged = [...variantMediaUrls, ...toAdd].slice(0, 8);
                  if (locale === "de") updateVariantMeta("media", merged);
                  else updateLocaleVariantField("media", merged);
                }}
              />
              <MediaPickerModal
                open={coverPickerOpen}
                onClose={() => setCoverPickerOpen(false)}
                title="Select cover image"
                multiple={false}
                uploadPurpose="product"
                onSelect={(urls) => {
                  const u = urls[0];
                  if (!u) return;
                  if (locale === "de") patchVariant({ image_url: u });
                  else {
                    const iu = { ...(v.image_urls || {}) };
                    iu[locale] = u;
                    patchVariant({ image_urls: iu });
                  }
                }}
              />

              <ProductSectionRule />

              <ProductSectionHeading>Cover image (picker / locale)</ProductSectionHeading>
              <Text as="p" variant="bodySm" tone="subdued">
                Same as matrix: German uses image_url; other locales use image_urls.{`{locale}`}.
              </Text>
              <InlineStack gap="300" wrap>
                <Button size="slim" onClick={() => setCoverPickerOpen(true)}>
                  Open media picker for cover
                </Button>
              </InlineStack>
              <div style={{ marginTop: 8 }}>
                {(() => {
                  const raw = variantImageUrlForLocale(v, locale);
                  return raw ? <img src={resolveMediaUrl(raw)} alt="" style={{ maxWidth: 120, borderRadius: 8 }} /> : <Text tone="subdued">No cover</Text>;
                })()}
              </div>

              <ProductSectionRule />

              <ProductSectionHeading>{t("Status", "Durum", "Statut", "Estado", "Stato", "Status")}</ProductSectionHeading>
              <Checkbox
                label={t(
                  "Variant active (sellable in the shop)",
                  "Varyant aktif (mağazada satılabilir)",
                  "Variante active (vendable en boutique)",
                  "Variante activa (vendible en la tienda)",
                  "Variante attiva (vendibile nel negozio)",
                  "Variante aktiv (im Shop verkäuflich)",
                )}
                checked={vm.disabled !== true}
                onChange={(on) => patchVariant((cur) => {
                  const m = { ...(cur.metadata && typeof cur.metadata === "object" ? cur.metadata : {}) };
                  if (on) delete m.disabled; else m.disabled = true;
                  return { ...cur, metadata: m };
                })}
                helpText={t(
                  "When off this variant is hidden and not purchasable, even if the product is published.",
                  "Kapalıyken bu varyant gizlenir ve satın alınamaz — ürün yayında olsa bile.",
                  "Désactivée, cette variante est masquée et non achetable, même si le produit est publié.",
                  "Si está desactivada, esta variante se oculta y no se puede comprar, aunque el producto esté publicado.",
                  "Se disattivata, questa variante è nascosta e non acquistabile, anche se il prodotto è pubblicato.",
                  "Wenn aus, ist diese Variante ausgeblendet und nicht kaufbar, auch bei veröffentlichtem Produkt.",
                )}
              />

              <ProductSectionRule />

              <ProductSectionHeading>Stock</ProductSectionHeading>
              <TextField
                label="Inventory"
                labelHidden
                type="number"
                min={0}
                value={v.inventory != null ? String(v.inventory) : "0"}
                onChange={(t) => patchVariant({ inventory: t === "" ? 0 : parseInt(String(t), 10) || 0 })}
              />

              <ProductSectionRule />

              <ProductSectionHeading>{lt(locale, "Pricing", "Fiyatlandırma", "Tarification", "Precios", "Prezzi", "Preisgestaltung")}</ProductSectionHeading>
              <div className="product-edit-price-grid">
              {[
                { field: "compare_at_price", centsKey: "compare_at_price_cents", label: lt(locale, "UVP (RRP)", "UVP", "PVR", "PVP", "PVR", "UVP") },
                { field: "price", centsKey: "price_cents", label: lt(locale, "Selling price", "Satış fiyatı", "Prix de vente", "Precio de venta", "Prezzo di vendita", "Verkaufspreis") },
                { field: "sale_price", centsKey: "sale_price_cents", label: lt(locale, "Discount price", "İndirim fiyatı", "Prix réduit", "Precio de descuento", "Prezzo scontato", "Rabattpreis") },
              ].map(({ field: f, centsKey: ck, label: priceLabel }) => {
                const dk = `${f}_draft`;
                const isDraft = Object.prototype.hasOwnProperty.call(priceInputs, dk);
                const displayVal = isDraft
                  ? priceInputs[dk]
                  : v[ck] != null
                    ? (Number(v[ck]) / 100).toFixed(2)
                    : "";
                return (
                  <TextField
                    key={f}
                    label={priceLabel}
                    value={displayVal}
                    onChange={(val) => {
                      const clean = sanitizePriceDraftString(val);
                      setPriceInputs((prev) => ({ ...prev, [dk]: clean }));
                    }}
                    onBlur={() => {
                      const clean = sanitizePriceDraftString(priceInputs[dk] ?? displayVal);
                      const n = parseFloat(clean);
                      patchVariant({
                        [ck]: !isNaN(n) && clean !== "" ? Math.round(n * 100) : undefined,
                      });
                      setPriceInputs((prev) => {
                        const next = { ...prev };
                        delete next[dk];
                        return next;
                      });
                    }}
                    autoComplete="off"
                  />
                );
              })}
              </div>

              <ProductSectionRule />

              <ProductSectionHeading>Bullet points (max 5, je max. 120 Zeichen)</ProductSectionHeading>
              {bullets.map((b, i) => {
                const len = String(b ?? "").length;
                const overLimit = len > 120;
                return (
                  <Box key={i}>
                    <TextField
                      label={`Bullet ${i + 1}`}
                      labelHidden
                      value={b}
                      maxLength={120}
                      onChange={(t) => {
                        const trimmed = String(t).slice(0, 120);
                        const next = [...bullets];
                        next[i] = trimmed;
                        if (locale === "de") updateVariantMeta("bullet_points", next.filter((x) => x != null && String(x).trim() !== ""));
                        else updateLocaleVariantField("bullet_points", next.filter((x) => x != null && String(x).trim() !== ""));
                      }}
                    />
                    <Text as="p" variant="bodySm" tone="subdued" style={{ marginTop: 4, color: overLimit ? "var(--p-color-text-critical)" : undefined }}>
                      {len} / 120
                    </Text>
                  </Box>
                );
              })}
              {bullets.length < 5 && (
                <Button
                  size="slim"
                  variant="secondary"
                  onClick={() => {
                    const next = [...bullets, ""];
                    if (locale === "de") updateVariantMeta("bullet_points", next);
                    else updateLocaleVariantField("bullet_points", next);
                  }}
                >
                  + Bullet
                </Button>
              )}

              <ProductSectionRule />

              <ProductSectionHeading>SEO (variant)</ProductSectionHeading>
              <TextField
                label="Meta title"
                value={vm.seo_meta_title ?? vTr.seo_title ?? ""}
                onChange={(t) => updateVariantMeta("seo_meta_title", t || undefined)}
                placeholder={displayTitle || product?.title || "Meta title"}
              />
              <TextField
                label="Meta description"
                value={vm.seo_meta_description ?? vTr.seo_description ?? ""}
                onChange={(t) => updateVariantMeta("seo_meta_description", t || undefined)}
                placeholder={seoPlainPreview(editingDescription || product?.description, 160) || "Meta description"}
                multiline={2}
              />
              <TextField
                label="Keywords"
                value={vm.seo_keywords ?? vTr.seo_keywords ?? ""}
                onChange={(t) => updateVariantMeta("seo_keywords", t || undefined)}
              />
            </BlockStack>
            </div>
          </Card>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <div className="product-edit-sidebar">
          <Card>
            <BlockStack gap="300">
              <ProductSectionHeading>Product status</ProductSectionHeading>
              <Select
                label="Status"
                labelHidden
                options={STATUS_OPTIONS(locale)}
                value={product.status || "draft"}
                disabled
              />
              <Text as="p" variant="bodySm" tone="subdued">
                Change status on the main product page.
              </Text>
              <Divider />
              <Button onClick={() => router.push(`/products/${idOrHandle}`)}>{t("Back to product", "Ürüne dön", "Retour au produit", "Volver al producto", "Torna al prodotto", "Zurück zum Produkt")}</Button>
            </BlockStack>
          </Card>
          </div>
        </Layout.Section>
      </Layout>
      )}

      {activeTabIndex === 1 && (
      <Layout>
        <Layout.Section>
          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="300">
              <InlineStack gap="200" blockAlign="center" wrap={false}>
                <ProductSectionHeading>{t("Dimensions & packaging", "Ölçüler ve ambalaj", "Dimensions et emballage", "Dimensiones y embalaje", "Dimensioni e imballaggio", "Maße & Verpackung")}</ProductSectionHeading>
                <LockToggle fieldKey="spezifikationen" parentValue={null} />
              </InlineStack>
              <div className={isFieldLocked("spezifikationen") ? "variant-lock-disabled" : undefined}>
              <InlineStack gap="200" wrap>
                <Box minWidth="130px" flex="1">
                  <TextField label={`${t("Width", "Genişlik", "Largeur", "Ancho", "Larghezza", "Breite")} (cm)`} type="number" value={effectiveSpez("dimensions_width")} onChange={(val) => updateVariantMeta("dimensions_width", val)} placeholder="0" disabled={isFieldLocked("spezifikationen")} />
                </Box>
                <Box minWidth="130px" flex="1">
                  <TextField label={`${t("Height", "Yükseklik", "Hauteur", "Alto", "Altezza", "Höhe")} (cm)`} type="number" value={effectiveSpez("dimensions_height")} onChange={(val) => updateVariantMeta("dimensions_height", val)} placeholder="0" disabled={isFieldLocked("spezifikationen")} />
                </Box>
                <Box minWidth="130px" flex="1">
                  <TextField label={`${t("Length", "Uzunluk", "Longueur", "Largo", "Lunghezza", "Länge")} (cm)`} type="number" value={effectiveSpez("dimensions_length")} onChange={(val) => updateVariantMeta("dimensions_length", val)} placeholder="0" disabled={isFieldLocked("spezifikationen")} />
                </Box>
                <Box minWidth="130px" flex="1">
                  <TextField label={`${t("Weight", "Ağırlık", "Poids", "Peso", "Peso", "Gewicht")} (g)`} type="number" value={effectiveSpez("weight_grams")} onChange={(val) => updateVariantMeta("weight_grams", val === "" ? "" : parseInt(val, 10))} placeholder="0" disabled={isFieldLocked("spezifikationen")} />
                </Box>
              </InlineStack>
              <Box paddingBlockStart="200">
              <InlineStack gap="200" wrap>
                <Box minWidth="160px" flex="1">
                  <TextField
                    label={t("Sales unit","Satış birimi","Unité de vente","Unidad de venta","Unità di vendita","Verkaufseinheit")}
                    value={effectiveSpez("sales_unit")}
                    onChange={(val) => updateVariantMeta("sales_unit", val)}
                    placeholder={t("e.g. piece", "örn. adet", "ex. pièce", "ej. unidad", "es. pezzo", "z. B. Stück")}
                    helpText={t(
                      "How the item is sold (e.g. piece, pack) — not the base-price content.",
                      "Ürünün nasıl satıldığı (örn. adet, paket) — birim fiyat içeriği değil.",
                      "Comment l'article est vendu (ex. pièce) — pas le contenu du prix unitaire.",
                      "Cómo se vende (ej. unidad) — no el contenido del precio unitario.",
                      "Come si vende (es. pezzo) — non il contenuto del prezzo unitario.",
                      "Wie verkauft wird (z. B. Stück, Packung) — nicht der Grundpreis-Inhalt.",
                    )}
                    autoComplete="off"
                    disabled={isFieldLocked("spezifikationen")}
                  />
                </Box>
                <Box minWidth="160px" flex="1">
                  <Select
                    label={t("Unit of measure", "Ölçü birimi", "Unité de mesure", "Unidad de medida", "Unità di misura", "Maßeinheit")}
                    options={UNIT_TYPE_OPTIONS(locale)}
                    value={effectiveSpez("unit_type")}
                    onChange={(val) => updateVariantMeta("unit_type", val)}
                    disabled={isFieldLocked("spezifikationen")}
                  />
                </Box>
                <Box minWidth="160px" flex="1">
                  <TextField
                    label={t("Packaging unit","Ambalaj birimi","Unité d'emballage","Unidad de embalaje","Unità di imballaggio","Verpackungseinheit")}
                    value={effectiveSpez("packaging_unit")}
                    onChange={(val) => updateVariantMeta("packaging_unit", val)}
                    placeholder={t("e.g. carton", "örn. koli", "ex. carton", "ej. cartón", "es. cartone", "z. B. Karton")}
                    autoComplete="off"
                    disabled={isFieldLocked("spezifikationen")}
                  />
                </Box>
              </InlineStack>
              </Box>
              <Box paddingBlockStart="200">
              <InlineStack gap="200" wrap>
                <Box minWidth="160px" flex="1">
                  <TextField
                    label={t("Packaging unit (plural)","Ambalaj birimi (çoğul)","Unité d'emballage (pluriel)","Unidad de embalaje (plural)","Unità di imballaggio (plurale)","Verpackungseinheit (Mehrzahl)")}
                    value={effectiveSpez("packaging_unit_plural")}
                    onChange={(val) => updateVariantMeta("packaging_unit_plural", val)}
                    placeholder={t("e.g. cartons", "örn. koliler", "ex. cartons", "ej. cartones", "es. cartoni", "z. B. Kartons")}
                    autoComplete="off"
                    disabled={isFieldLocked("spezifikationen")}
                  />
                </Box>
                <Box minWidth="160px" flex="1">
                  <TextField
                    label={t("Base unit", "Temel birim", "Unité de base", "Unidad base", "Unità base", "Grundeinheit")}
                    type="number"
                    value={effectiveSpez("unit_reference", "1")}
                    onChange={(val) => updateVariantMeta("unit_reference", val)}
                    placeholder="1"
                    helpText={t(
                      "Reference for price/unit (e.g. 1 = per 1 kg).",
                      "Birim fiyat referansı (örn. 1 = 1 kg başına).",
                      "Référence prix/unité (ex. 1 = par 1 kg).",
                      "Referencia precio/unidad (ej. 1 = por 1 kg).",
                      "Riferimento prezzo/unità (es. 1 = per 1 kg).",
                      "Bezug für Preis/Einheit (z. B. 1 = je 1 kg).",
                    )}
                    disabled={isFieldLocked("spezifikationen")}
                  />
                </Box>
                <Box minWidth="160px" flex="1">
                  <TextField
                    label={t("Amount", "Miktar", "Quantité", "Cantidad", "Quantità", "Menge")}
                    type="number"
                    value={effectiveSpez("unit_value")}
                    onChange={(val) => updateVariantMeta("unit_value", val)}
                    placeholder="e.g. 200"
                    helpText={t(
                      "Net content for base price, e.g. 200 with unit g.",
                      "Birim fiyat için net içerik, örn. birim g iken 200.",
                      "Contenu net pour le prix unitaire, ex. 200 avec unité g.",
                      "Contenido neto para precio unitario, ej. 200 con unidad g.",
                      "Contenuto netto per prezzo unitario, es. 200 con unità g.",
                      "Nettoinhalt für den Grundpreis, z. B. 200 bei Einheit g.",
                    )}
                    disabled={isFieldLocked("spezifikationen")}
                  />
                </Box>
              </InlineStack>
              </Box>
              <Text as="p" variant="bodySm" tone="subdued">
                {t(
                  'Shown on the product, e.g. "Content: 200 g (€5.00* / 1 kg)". Verkaufseinheit = sell-as label; Maßeinheit + Menge + Grundeinheit = base-price math.',
                  'Üründe gösterilir, örn. "İçerik: 200 g (€5,00* / 1 kg)". Verkaufseinheit = satış etiketi; Maßeinheit + Menge + Grundeinheit = birim fiyat hesabı.',
                  'Affiché sur le produit, ex. « Contenu : 200 g (5,00 €* / 1 kg) ».',
                  'Se muestra en el producto, ej. « Contenido: 200 g (5,00 €* / 1 kg) ».',
                  'Mostrato sul prodotto, es. « Contenuto: 200 g (5,00 €* / 1 kg) ».',
                  'Wird auf dem Produkt angezeigt, z. B. „Inhalt: 200 g (5,00 €* / 1 kg)“. Verkaufseinheit = Verkaufsbezeichnung; Maßeinheit + Menge + Grundeinheit = Grundpreis-Berechnung.',
                )}
              </Text>
              </div>

              <ProductSectionRule />

              <BlockStack gap="200">
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <ProductSectionHeading>{t("Attributes", "Özellikler", "Attributs", "Atributos", "Attributi", "Eigenschaften")}</ProductSectionHeading>
                  <LockToggle fieldKey="metafields" parentValue={parentMeta.metafields} />
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {t(
                    "Optional key/value pairs for this variant (shop attributes).",
                    "Bu varyant için isteğe bağlı anahtar/değer çiftleri (mağaza özellikleri).",
                    "Paires clé/valeur optionnelles pour cette variante.",
                    "Pares clave/valor opcionales para esta variante.",
                    "Coppie chiave/valore opzionali per questa variante.",
                    "Optionale Key/Value-Paare nur für diese Variante (shop-spezifische Attribute).",
                  )}
                </Text>
                <Box padding="300" background="bg-surface-secondary" borderRadius="200" className={isFieldLocked("metafields") ? "variant-lock-disabled" : undefined}>
                  <BlockStack gap="200">
                    {effectiveMetafieldsList.map((item, i) => (
                      <Box
                        key={i}
                        padding="300"
                        background="bg-surface"
                        borderRadius="200"
                        borderWidth="025"
                        borderColor="border"
                      >
                        <InlineStack gap="300" wrap blockAlign="start">
                          <Box minWidth="140px" flex="1">
                            <TextField
                              label="Key"
                              value={item.key || ""}
                              onChange={(keyVal) => {
                                const arr = [...effectiveMetafieldsList];
                                arr[i] = { ...arr[i], key: keyVal };
                                patchVariant((cur) => ({
                                  ...cur,
                                  metadata: { ...(cur.metadata || {}), metafields: arr },
                                }));
                              }}
                              autoComplete="off"
                              disabled={isFieldLocked("metafields")}
                            />
                          </Box>
                          <Box minWidth="180px" flex="2">
                            <TextField
                              label="Value"
                              value={String(item.value ?? "")}
                              onChange={(val) => {
                                const arr = [...effectiveMetafieldsList];
                                arr[i] = { ...arr[i], value: val };
                                patchVariant((cur) => ({
                                  ...cur,
                                  metadata: { ...(cur.metadata || {}), metafields: arr },
                                }));
                              }}
                              autoComplete="off"
                              disabled={isFieldLocked("metafields")}
                            />
                          </Box>
                        </InlineStack>
                      </Box>
                    ))}
                    <InlineStack>
                      <Button
                        size="slim"
                        variant="secondary"
                        disabled={isFieldLocked("metafields")}
                        onClick={() =>
                          patchVariant((cur) => ({
                            ...cur,
                            metadata: {
                              ...(cur.metadata || {}),
                              metafields: [...effectiveMetafieldsList, { key: "", value: "" }],
                            },
                          }))
                        }
                      >
                        {t("+ Add attribute", "+ Özellik ekle", "+ Ajouter un attribut", "+ Añadir atributo", "+ Aggiungi attributo", "+ Metafeld hinzufügen")}
                      </Button>
                    </InlineStack>
                  </BlockStack>
                </Box>
              </BlockStack>
            </BlockStack>
            </div>
          </Card>
        </Layout.Section>
      </Layout>
      )}

      {activeTabIndex === 2 && (
      <Layout>
        <Layout.Section>
          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="300">
              <ProductSectionHeading>
                {locale === "en" ? "Compliance / manufacturer (this variant)" : locale === "tr" ? "Uyumluluk / üretici (bu varyant)" : locale === "fr" ? "Conformité / fabricant (cette variante)" : locale === "es" ? "Cumplimiento / fabricante (esta variante)" : locale === "it" ? "Conformità / produttore (questa variante)" : "Compliance / Hersteller (diese Variante)"}
              </ProductSectionHeading>
              <Text as="p" variant="bodySm" tone="subdued">
                {locale === "en"
                  ? "EU product safety (GPSR). Tap “i” for what to enter in each field."
                  : locale === "tr"
                    ? "AB ürün güvenliği (GPSR). Her alana ne yazılacağını “i” ile görün."
                    : locale === "fr"
                      ? "Sécurité produit UE (GPSR). Appuyez sur « i » pour savoir quoi saisir."
                      : locale === "es"
                        ? "Seguridad de producto UE (GPSR). Pulsa « i » para ver qué indicar."
                        : locale === "it"
                          ? "Sicurezza prodotto UE (GPSR). Tocca « i » per sapere cosa inserire."
                          : "EU-Produktsicherheit (GPSR). Tippen Sie auf „i“, um zu sehen, was einzutragen ist."}
              </Text>
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>{locale === "en" ? "Manufacturer" : locale === "tr" ? "Üretici" : locale === "fr" ? "Fabricant" : locale === "es" ? "Fabricante" : locale === "it" ? "Fabbricante" : "Hersteller"}</span>
                    <InfoIconTooltip
                      text={
                        locale === "en" ? "Name of the company or person that manufactured the product."
                          : locale === "tr" ? "Ürünü üreten şirket veya kişinin adı."
                            : locale === "fr" ? "Nom du fabricant."
                              : locale === "es" ? "Nombre del fabricante."
                                : locale === "it" ? "Nome del fabbricante."
                                  : "Name des Herstellers."
                      }
                    />
                    <LockToggle fieldKey="hersteller" parentValue={getMeta(product, "hersteller")} />
                  </InlineStack>
                }
                value={effectiveMeta("hersteller")}
                onChange={(val) => updateVariantMeta("hersteller", val || undefined)}
                placeholder={locale === "en" ? "e.g. Acme GmbH" : "z. B. Acme GmbH"}
                autoComplete="off"
                disabled={isFieldLocked("hersteller")}
              />
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>{locale === "en" ? "Manufacturer details" : locale === "tr" ? "Üretici bilgileri" : locale === "fr" ? "Coordonnées du fabricant" : locale === "es" ? "Datos del fabricante" : locale === "it" ? "Dati del fabbricante" : "Herstellerinformationen"}</span>
                    <InfoIconTooltip
                      text={
                        locale === "en" ? "Postal address and contact of the manufacturer."
                          : locale === "tr" ? "Üreticinin posta adresi ve iletişimi."
                            : locale === "fr" ? "Adresse et contact du fabricant."
                              : locale === "es" ? "Dirección y contacto del fabricante."
                                : locale === "it" ? "Indirizzo e contatto del fabbricante."
                                  : "Adresse und Kontakt des Herstellers."
                      }
                    />
                    <LockToggle fieldKey="hersteller_information" parentValue={getMeta(product, "hersteller_information")} />
                  </InlineStack>
                }
                value={effectiveMeta("hersteller_information")}
                onChange={(val) => updateVariantMeta("hersteller_information", val || undefined)}
                placeholder={locale === "en" ? "Street, city, country, email/phone" : "Straße, Ort, Land, E-Mail/Telefon"}
                multiline={2}
                autoComplete="off"
                disabled={isFieldLocked("hersteller_information")}
              />
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>{locale === "en" ? "Responsible person (EU)" : locale === "tr" ? "Sorumlu kişi (AB)" : locale === "fr" ? "Personne responsable (UE)" : locale === "es" ? "Persona responsable (UE)" : locale === "it" ? "Persona responsabile (UE)" : "Verantwortliche Person (EU)"}</span>
                    <InfoIconTooltip
                      text={
                        locale === "en" ? "EU-based safety contact. If the manufacturer is in the EU, this can be the same party."
                          : locale === "tr" ? "AB’de yerleşik güvenlik iletişimi. Üretici AB’deyse aynı taraf olabilir."
                            : locale === "fr" ? "Contact sécurité basé dans l'UE. Si le fabricant est dans l'UE, ce peut être la même entité."
                              : locale === "es" ? "Contacto de seguridad en la UE. Si el fabricante está en la UE, puede ser la misma parte."
                                : locale === "it" ? "Contatto di sicurezza nell'UE. Se il fabbricante è nell'UE, può essere la stessa parte."
                                  : "In der EU ansässige Sicherheitskontaktstelle. Sitzt der Hersteller in der EU, kann dies dieselbe Stelle sein."
                      }
                    />
                    <LockToggle fieldKey="verantwortliche_person_information" parentValue={getMeta(product, "verantwortliche_person_information")} />
                  </InlineStack>
                }
                value={effectiveMeta("verantwortliche_person_information")}
                onChange={(val) => updateVariantMeta("verantwortliche_person_information", val || undefined)}
                placeholder={locale === "en" ? "Name, EU address, email/phone" : "Name, EU-Adresse, E-Mail/Telefon"}
                multiline={2}
                autoComplete="off"
                disabled={isFieldLocked("verantwortliche_person_information")}
              />
              <ComplianceFieldsSection
                client={client}
                categoryId={effectiveMeta("category_id")}
                marketplace="DE"
                locale={locale}
                product={v}
                getMeta={(obj, key, fb) => {
                  if (obj === v && isFieldLocked(key)) return getMeta(product, key, fb);
                  return getMeta(obj, key, fb);
                }}
                updateMeta={updateVariantMeta}
              />

              <ProductSectionRule />
              <ProductSectionHeading>
                {locale === "en" ? "Made in Europe (this variant, optional)" : locale === "tr" ? "Made in Europe (bu varyant, isteğe bağlı)" : locale === "fr" ? "Made in Europe (cette variante, optionnel)" : locale === "es" ? "Made in Europe (esta variante, opcional)" : locale === "it" ? "Made in Europe (questa variante, opzionale)" : "Made in Europe (diese Variante, optional)"}
              </ProductSectionHeading>
              {euOriginNotice ? (
                <Banner tone="info" onDismiss={() => setEuOriginNotice("")}>{euOriginNotice}</Banner>
              ) : null}
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>{locale === "en" ? "Country of origin (EU)" : locale === "tr" ? "Menşe ülke (AB)" : locale === "fr" ? "Pays d'origine (UE)" : locale === "es" ? "País de origen (UE)" : locale === "it" ? "Paese di origine (UE)" : "Herkunftsland (EU)"}</span>
                    <LockToggle fieldKey="eu_origin_country" parentValue={getMeta(product, "eu_origin_country")} />
                  </InlineStack>
                }
                value={isFieldLocked("eu_origin_country") ? getMeta(product, "eu_origin_country") : (vm.eu_origin_country ?? "")}
                onChange={(val) => updateVariantMeta("eu_origin_country", val || undefined)}
                placeholder={locale === "en" ? "e.g. DE, FR, IT" : locale === "tr" ? "örn. DE, FR, IT" : "z. B. DE, FR, IT"}
                autoComplete="off"
                disabled={isFieldLocked("eu_origin_country")}
              />
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>Registry-ID</span>
                    <LockToggle fieldKey="eu_origin_registry_id" parentValue={getMeta(product, "eu_origin_registry_id")} />
                  </InlineStack>
                }
                value={isFieldLocked("eu_origin_registry_id") ? getMeta(product, "eu_origin_registry_id") : (vm.eu_origin_registry_id ?? "")}
                onChange={(val) => updateVariantMeta("eu_origin_registry_id", val || undefined)}
                placeholder={locale === "en" ? "EU registry / certificate number" : locale === "tr" ? "AB kayıt / sertifika numarası" : locale === "fr" ? "Registre UE / numéro de certificat" : locale === "es" ? "Registro UE / número de certificado" : locale === "it" ? "Registro UE / numero di certificato" : "EU-Registry / Zertifikatsnummer"}
                autoComplete="off"
                disabled={isFieldLocked("eu_origin_registry_id")}
              />
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>Nachweisdokument (URL)</span>
                    <LockToggle fieldKey="eu_origin_document_url" parentValue={getMeta(product, "eu_origin_document_url")} />
                  </InlineStack>
                }
                value={isFieldLocked("eu_origin_document_url") ? getMeta(product, "eu_origin_document_url") : (vm.eu_origin_document_url ?? "")}
                onChange={(val) => updateVariantMeta("eu_origin_document_url", val || undefined)}
                placeholder="https://…"
                autoComplete="off"
                disabled={isFieldLocked("eu_origin_document_url")}
              />
              <Select
                label={locale === "en" ? "Registry provider" : locale === "tr" ? "Registry sağlayıcısı" : locale === "fr" ? "Fournisseur de registre" : locale === "es" ? "Proveedor de registro" : locale === "it" ? "Provider registro" : "Registry-Provider"}
                options={[
                  { label: locale === "en" ? "Stub (manual check)" : locale === "tr" ? "Stub (manuel kontrol)" : locale === "fr" ? "Stub (vérification manuelle)" : locale === "es" ? "Stub (verificación manual)" : locale === "it" ? "Stub (verifica manuale)" : "Stub (manuelle Prüfung)", value: "stub" },
                ]}
                value={vm.eu_origin_provider || "stub"}
                onChange={(val) => updateVariantMeta("eu_origin_provider", val || "stub")}
              />
              <TextField
                label="Status"
                value={vm.eu_origin_status || "—"}
                readOnly
                autoComplete="off"
                helpText={
                  vm.eu_origin_verified_at
                    ? `${locale === "en" ? "Verified at:" : locale === "tr" ? "Doğrulandı:" : locale === "fr" ? "Vérifié le :" : locale === "es" ? "Verificado el:" : locale === "it" ? "Verificato il:" : "Verifiziert am:"} ${vm.eu_origin_verified_at}`
                    : undefined
                }
              />
              <InlineStack gap="200">
                <Button
                  onClick={() => handleVerifyEuOriginVariant(false)}
                  loading={euOriginVerifying}
                  disabled={!product?.id || euOriginVerifying}
                >
                  {locale === "en" ? "Check registry (stub)" : locale === "tr" ? "Registry kontrol et (stub)" : locale === "fr" ? "Vérifier le registre (stub)" : locale === "es" ? "Verificar registro (stub)" : locale === "it" ? "Controlla registro (stub)" : "Registry prüfen (Stub)"}
                </Button>
                {isSuperuser ? (
                  <Button
                    variant="primary"
                    onClick={() => handleVerifyEuOriginVariant(true)}
                    loading={euOriginVerifying}
                    disabled={!product?.id || euOriginVerifying}
                  >
                    {locale === "en" ? "Verify manually" : locale === "tr" ? "Manuel doğrula" : locale === "fr" ? "Vérifier manuellement" : locale === "es" ? "Verificar manualmente" : locale === "it" ? "Verifica manualmente" : "Manuell verifizieren"}
                  </Button>
                ) : null}
              </InlineStack>
            </BlockStack>
            </div>
          </Card>
        </Layout.Section>
      </Layout>
      )}
    </Page>
  );
}
