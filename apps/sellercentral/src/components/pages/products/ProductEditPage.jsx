"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter, Link } from "@/i18n/navigation";
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
  Divider,
  Select,
  SkeletonBodyText,
  SkeletonDisplayText,
  Popover,
  ActionList,
  Modal,
  Checkbox,
  Tag,
  Tabs,
} from "@shopify/polaris";
import { ProductIcon, MenuHorizontalIcon, ViewIcon, EditIcon } from "@shopify/polaris-icons";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { resolveImageUrl } from "@/lib/image-url";
import { getUI } from "@/lib/ui-strings";
import { lt } from "@/lib/locale-text";
import { titleToHandle, sanitizeSeoHandleInput, isPlaceholderHandle } from "@/lib/slugify";
import { useUnsavedChanges } from "@/context/UnsavedChangesContext";
import MediaPickerModal from "@/components/MediaPickerModal";
import InfoIconTooltip from "@/components/InfoIconTooltip";
import CategoryDrilldownSelect from "@/components/inputs/CategoryDrilldownSelect";
import ComplianceFieldsSection from "@/components/products/ComplianceFieldsSection";
import { routing } from "@/i18n/routing";
import { encodeVariantPathKey } from "@/lib/variant-path-key";
import { ChangeRequestFieldBadge } from "@/components/ChangeRequestFieldBadge";
import {
  fieldNameDisplayLabel,
  formatChangeRequestValueForDisplay,
  seoPlainPreview,
} from "@/lib/product-change-request-format";
import { EU_ORIGIN_STATUS } from "@andertal/shop-theme";
import {
  ProductSectionHeading,
  ProductSectionRule,
  PRODUCT_SECTION_STYLES,
} from "@/components/products/ProductSection";

const getDefaultBaseUrl = () => {
  const env = process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL || "";
  const url = (typeof env === "string" ? env : "").trim();
  return url || (typeof window !== "undefined" ? "http://localhost:9000" : "");
};

const getDefaultShopUrl = () => {
  const env = process.env.NEXT_PUBLIC_SHOP_URL || "";
  const url = (typeof env === "string" ? env : "").trim();
  if (url) return url.replace(/\/$/, "");
  if (typeof window !== "undefined") {
    if (window.location.hostname === "localhost") return "http://localhost:3000";
    return window.location.origin;
  }
  return "";
};

/** Digits + one decimal dot — avoids controlled type="number" + toFixed fighting mid-edit. */
function sanitizePriceDraftString(s) {
  const t = String(s ?? "").replace(",", ".");
  let out = "";
  let dot = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !dot) {
      dot = true;
      out += ".";
    }
  }
  return out;
}

/** Breadcrumb path from flat category list (parent_id links) for compact summaries. */
function categoryBreadcrumbFromFlatList(flatCategories, categoryId) {
  if (!categoryId || !Array.isArray(flatCategories) || flatCategories.length === 0) return "";
  const byId = new Map(flatCategories.map((c) => [String(c.id), c]));
  const parts = [];
  let cur = byId.get(String(categoryId));
  const seen = new Set();
  while (cur && !seen.has(String(cur.id))) {
    seen.add(String(cur.id));
    parts.unshift(String(cur.name || cur.slug || cur.id).trim());
    const pid = cur.parent_id != null ? String(cur.parent_id) : "";
    cur = pid && byId.has(pid) ? byId.get(pid) : null;
  }
  return parts.filter(Boolean).join(" › ");
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

/** Per-locale variant image; no leaking another locale’s image into DE when `image_urls` is set. */
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

/** Option `value` = canonical key; `labels[locale]` = display string for seller + shop. */
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

function statusOptionsFor(locale) {
  return [
    { label: lt(locale, "Active", "Aktif", "Actif", "Activo", "Attivo", "Aktiv"), value: "published" },
    { label: lt(locale, "Draft", "Taslak", "Brouillon", "Borrador", "Bozza", "Entwurf"), value: "draft" },
    { label: lt(locale, "Inactive", "Pasif", "Inactif", "Inactivo", "Inattivo", "Inaktiv"), value: "archived" },
  ];
}

const DEFAULT_DUPLICATE_OPTIONS = {
  title: true,
  description: true,
  price: true,
  inventory: false,
  categories: true,
  media: true,
  variants: true,
};

/** Katalog-Metafeld-UI: ürün operasyonel alanları (WEEE, EPREL, üretici, ID, type, …) burada yok */
const EXCLUDED_CATALOG_METAFIELD_KEYS = new Set([
  "category_ids", "category_id", "admin_category_id", "category_slug", "category",
  "sales_count", "salescount", "sold", "sold_count", "sold_last_month",
  "master_total_variants", "master_total_variant", "total_variants", "variant_count", "variants_count",
  "type", "ean", "sku", "handle", "title", "description", "status", "inventory", "price",
  "brand", "brand_id", "brand_name", "brand_handle", "brand_logo",
  "hersteller", "hersteller_information", "verantwortliche_person_information",
  "manufacturer", "manufacturer_information", "responsible_person_information",
  "weee_number", "wee_number", "weee", "wee", "eprel_number", "eprel", "eprel_id", "eprel_registration_number",
  "bullet_points", "bullet1", "bullet2", "bullet3", "bullet4", "bullet5",
  "seller_id", "product_id", "shipping_group_id", "collection_id", "collection_ids",
  "seo_keywords", "seo_meta_title", "seo_meta_description",
  "dimensions", "dimensions_length", "dimensions_width", "dimensions_height", "weight", "weight_grams",
  "unit_type", "unit_value", "unit_reference", "sales_unit", "packaging_unit", "packaging_unit_plural",
  "minimum_order_quantity", "product_files", "files", "media", "prices",
  "eu_origin_provider", "eu_origin_registry_id", "eu_origin_document_url", "eu_origin_status",
  "eu_origin_verified_at", "eu_origin_country",
]);

function isExcludedCatalogMetaKey(raw) {
  const k = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
  if (!k || k.startsWith("_")) return true;
  if (EXCLUDED_CATALOG_METAFIELD_KEYS.has(k)) return true;
  if (k.endsWith("_id") || k.endsWith("_ids")) return true;
  if (/(^|_)(weee?|eprel|bullet|hersteller|manufacturer|gpsr)(_|$)/i.test(k)) return true;
  if (k.includes("bullet_point")) return true;
  return false;
}

function resolveMetaDefLabel(def, key, uiLocale) {
  const loc = String(uiLocale || "de").slice(0, 2).toLowerCase();
  if (loc && loc !== "de") {
    const translated = def?.label_i18n?.[loc]?.label;
    if (translated != null && String(translated).trim()) return String(translated).trim();
  }
  if (def?.label != null && String(def.label).trim()) return String(def.label).trim();
  return key;
}

function filterMetaDefsForCatalog(definitions) {
  if (!definitions || typeof definitions !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(definitions)) {
    if (isExcludedCatalogMetaKey(k)) continue;
    out[k] = v;
  }
  return out;
}

function stripSkuEanFromVariants(variants) {
  if (!Array.isArray(variants)) return [];
  return variants.map((v) => {
    const { sku, ean, ...rest } = typeof v === "object" && v ? v : {};
    const out = { ...rest };
    out.sku = "";
    out.ean = undefined;
    if (Array.isArray(out.options)) {
      out.options = out.options.map((o) => {
        const opt = typeof o === "object" && o ? { ...o } : {};
        opt.sku = "";
        opt.ean = undefined;
        return opt;
      });
    }
    return out;
  });
}

const UNIT_TYPE_OPTIONS = [
  { label: "— None —", value: "" },
  { label: "kg", value: "kg" },
  { label: "g", value: "g" },
  { label: "L", value: "L" },
  { label: "ml", value: "ml" },
  { label: "Piece", value: "stück" },
];

const PRODUCT_COUNTRIES = [
  { code: "DE", label: "Deutschland",   flag: "🇩🇪", currency: "EUR", symbol: "€",   vatRate: 19,  taxLabel: "MwSt." },
  { code: "AT", label: "Österreich",    flag: "🇦🇹", currency: "EUR", symbol: "€",   vatRate: 20,  taxLabel: "MwSt." },
  { code: "CH", label: "Schweiz",       flag: "🇨🇭", currency: "CHF", symbol: "CHF", vatRate: 7.7, taxLabel: "MWST" },
  { code: "FR", label: "France",        flag: "🇫🇷", currency: "EUR", symbol: "€",   vatRate: 20,  taxLabel: "TVA" },
  { code: "IT", label: "Italia",        flag: "🇮🇹", currency: "EUR", symbol: "€",   vatRate: 22,  taxLabel: "IVA" },
  { code: "ES", label: "España",        flag: "🇪🇸", currency: "EUR", symbol: "€",   vatRate: 21,  taxLabel: "IVA" },
  { code: "TR", label: "Türkiye",       flag: "🇹🇷", currency: "TRY", symbol: "₺",   vatRate: 20,  taxLabel: "KDV" },
  { code: "US", label: "United States", flag: "🇺🇸", currency: "USD", symbol: "$",   vatRate: 0,   taxLabel: "Tax" },
];
const PRODUCT_COUNTRIES_MAP = Object.fromEntries(PRODUCT_COUNTRIES.map((c) => [c.code, c]));

/** Pricing country from app locale (globe). AT/CH are not separate here. */

function productEditCopy(locale) {
  return {
    title: lt(locale, "Title", "Başlık", "Titre", "Título", "Titolo", "Titel"),
    media: lt(locale, "Media", "Medya", "Médias", "Medios", "Media", "Medien"),
    variations: lt(locale, "Variations", "Varyasyonlar", "Variantes", "Variaciones", "Varianti", "Variationen"),
    variationsHelp: lt(
      locale,
      "Add groups (e.g. Color, Size). Combinations are generated automatically. Switch the globe to translate option labels.",
      "Grup ekle (örn. Renk, Beden). Kombinasyonlar otomatik oluşur. Seçenek etiketlerini çevirmek için küreyi değiştir.",
      "Ajoutez des groupes (ex. Couleur, Taille). Les combinaisons sont générées automatiquement.",
      "Añade grupos (p. ej. Color, Talla). Las combinaciones se generan automáticamente.",
      "Aggiungi gruppi (es. Colore, Taglia). Le combinazioni vengono generate automaticamente.",
      "Gruppen hinzufügen (z. B. Farbe, Größe). Kombinationen werden automatisch erzeugt. Globus wechseln, um Optionslabels zu übersetzen."
    ),
    pricing: lt(locale, "Pricing", "Fiyatlandırma", "Tarification", "Precios", "Prezzi", "Preisgestaltung"),
    uvp: lt(locale, "UVP (RRP)", "UVP", "PVR", "PVP", "PVR", "UVP"),
    sellingPrice: lt(locale, "Selling price", "Satış fiyatı", "Prix de vente", "Precio de venta", "Prezzo di vendita", "Verkaufspreis"),
    discountPrice: lt(locale, "Discount price", "İndirim fiyatı", "Prix réduit", "Precio de descuento", "Prezzo scontato", "Rabattpreis"),
    status: lt(locale, "Status", "Durum", "Statut", "Estado", "Stato", "Status"),
    inventory: lt(locale, "Inventory", "Stok", "Stock", "Inventario", "Inventario", "Bestand"),
    seo: lt(locale, "SEO", "SEO", "SEO", "SEO", "SEO", "SEO"),
    type: lt(locale, "Type", "Tür", "Type", "Tipo", "Tipo", "Typ"),
    sales: lt(locale, "Sales", "Satışlar", "Ventes", "Ventas", "Vendite", "Verkäufe"),
    weightDims: lt(locale, "Weight & dimensions", "Ağırlık ve ölçü", "Poids et dimensions", "Peso y dimensiones", "Peso e dimensioni", "Gewicht & Maße"),
    contentPerUnit: lt(locale, "Content per unit", "Birim içeriği", "Contenu par unité", "Contenido por unidad", "Contenuto per unità", "Inhalt pro Einheit"),
    moreActions: lt(locale, "More actions", "Diğer işlemler", "Plus d'actions", "Más acciones", "Altre azioni", "Weitere Aktionen"),
    addGroup: lt(locale, "+ Add Group", "+ Grup ekle", "+ Ajouter un groupe", "+ Añadir grupo", "+ Aggiungi gruppo", "+ Gruppe hinzufügen"),
    variationMatrix: lt(locale, "Variation matrix", "Varyasyon matrisi", "Matrice des variantes", "Matriz de variaciones", "Matrice varianti", "Variationsmatrix"),
    inventoryIds: lt(locale, "Inventory & identifiers", "Stok ve tanımlayıcılar", "Stock et identifiants", "Inventario e identificadores", "Inventario e identificatori", "Bestand & Kennungen"),
    newProduct: lt(locale, "New product", "Yeni ürün", "Nouveau produit", "Producto nuevo", "Nuovo prodotto", "Neues Produkt"),
    productFallback: lt(locale, "Product", "Ürün", "Produit", "Producto", "Prodotto", "Produkt"),
    viewInShop: lt(locale, "View in shop", "Mağazada gör", "Voir dans la boutique", "Ver en la tienda", "Vedi nel negozio", "Im Shop ansehen"),
    quantity: lt(locale, "Quantity", "Adet", "Quantité", "Cantidad", "Quantità", "Menge"),
    description: lt(locale, "Description", "Açıklama", "Description", "Descripción", "Descrizione", "Beschreibung"),
    descriptionHint: lt(locale, "Shown on the product page. Empty languages are filled automatically on save (DeepL).", "Ürün sayfasında gösterilir. Boş diller kaydetmede otomatik doldurulur (DeepL).", "Affiché sur la page produit. Les langues vides sont remplies automatiquement à l’enregistrement (DeepL).", "Se muestra en la página del producto. Los idiomas vacíos se rellenan al guardar (DeepL).", "Mostrato nella pagina prodotto. Le lingue vuote si compilano automaticamente al salvataggio (DeepL).", "Wird auf der Produktseite angezeigt. Leere Sprachen werden beim Speichern automatisch gefüllt (DeepL)."),
    titleHelp: lt(locale, "Empty languages are translated automatically when you save. Edit a language to keep your own wording.", "Boş diller kaydederken otomatik çevrilir. Kendi metniniz kalsın diye o dili düzenleyin.", "Les langues vides sont traduites automatiquement à l’enregistrement. Modifiez une langue pour conserver votre texte.", "Los idiomas vacíos se traducen al guardar. Edita un idioma para conservar tu texto.", "Le lingue vuote si traducono al salvataggio. Modifica una lingua per tenere il tuo testo.", "Leere Sprachen werden beim Speichern automatisch übersetzt. Eine Sprache selbst bearbeiten, um den eigenen Text zu behalten."),
    bullets: lt(locale, "Bullet points (max 5)", "Madde işaretleri (en fazla 5)", "Puces (max. 5)", "Viñetas (máx. 5)", "Punti elenco (max 5)", "Aufzählungspunkte (max. 5)"),
    bulletsHelp: lt(locale, "Short selling points shown on the product page. Max. 120 characters each.", "Ürün sayfasında görünen kısa satış noktaları. Her biri en fazla 120 karakter.", "Arguments de vente courts affichés sur la page produit. Max. 120 caractères chacun.", "Argumentos de venta cortos en la página del producto. Máx. 120 caracteres cada uno.", "Punti vendita brevi mostrati nella pagina prodotto. Max. 120 caratteri ciascuno.", "Kurze Verkaufsargumente auf der Produktseite. Je max. 120 Zeichen."),
    noVariantGroups: lt(locale, "No variant groups yet. Click + Add Group to start.", "Henüz varyant grubu yok. Başlamak için + Grup ekle’ye tıklayın.", "Aucun groupe de variantes. Cliquez sur + Ajouter un groupe.", "Aún no hay grupos de variantes. Pulsa + Añadir grupo.", "Nessun gruppo di varianti. Clicca + Aggiungi gruppo.", "Noch keine Variantengruppen. Klicken Sie auf + Gruppe hinzufügen."),
    addOption: lt(locale, "+ Add option", "+ Seçenek ekle", "+ Ajouter une option", "+ Añadir opción", "+ Aggiungi opzione", "+ Option hinzufügen"),
    optionsCount: (n) => lt(locale, `${n} option(s)`, `${n} seçenek`, `${n} option(s)`, `${n} opción(es)`, `${n} opzione/i`, `${n} Option(en)`),
    variantWord: (n) => lt(locale, n === 1 ? "variant" : "variants", n === 1 ? "varyant" : "varyant", n === 1 ? "variante" : "variantes", n === 1 ? "variante" : "variantes", n === 1 ? "variante" : "varianti", n === 1 ? "Variante" : "Varianten"),
    images: lt(locale, "Images", "Görseller", "Images", "Imágenes", "Immagini", "Bilder"),
    groupName: lt(locale, "Group name", "Grup adı", "Nom du groupe", "Nombre del grupo", "Nome del gruppo", "Gruppenname"),
    pricingHelp: lt(locale, "UVP is the recommended retail price. Selling price is what the customer pays. Discount price is the reduced price when on sale.", "UVP tavsiye edilen perakende fiyatıdır. Satış fiyatı müşterinin ödediği fiyattır. İndirim fiyatı kampanyadaki düşürülmüş fiyattır.", "Le PVR est le prix recommandé. Le prix de vente est ce que paie le client. Le prix réduit s’applique en promotion.", "El PVP es el precio recomendado. El precio de venta es lo que paga el cliente. El precio de descuento aplica en oferta.", "Il PVR è il prezzo consigliato. Il prezzo di vendita è quanto paga il cliente. Il prezzo scontato vale in promozione.", "UVP ist der empfohlene Verkaufspreis. Verkaufspreis zahlt der Kunde. Rabattpreis gilt im Angebot."),
    madeInEurope: lt(locale, "Made in Europe", "Avrupa malı", "Fabriqué en Europe", "Hecho en Europa", "Fatto in Europa", "Made in Europe"),
    proofDocument: lt(locale, "Proof document (URL)", "Kanıt belgesi (URL)", "Document justificatif (URL)", "Documento de prueba (URL)", "Documento di prova (URL)", "Nachweisdokument (URL)"),
    warehouseHint: lt(locale, "Warehouse split can be set later in metadata.", "Depo dağılımı daha sonra metafield’larda ayarlanabilir.", "La répartition d’entrepôt peut être définie plus tard.", "La división de almacén se puede definir más tarde.", "La suddivisione magazzino si può impostare dopo.", "Lageraufteilung kann später in Metafeldern gesetzt werden."),

    // Tabs
    tabGeneral: lt(locale, "General", "Genel", "Général", "General", "Generale", "Allgemein"),
    tabSpecs: lt(locale, "Specifications", "Özellikler", "Spécifications", "Especificaciones", "Specifiche", "Spezifikationen"),
    tabVariants: lt(locale, "Variants", "Varyasyonlar", "Variantes", "Variantes", "Varianti", "Variante"),
    tabLegal: lt(locale, "Legal", "Yasal", "Juridique", "Legal", "Legale", "Rechtlich"),

    // Spezifikationen — Maße & Verpackung
    dimsPackaging: lt(locale, "Dimensions & packaging", "Ölçüler ve ambalaj", "Dimensions et emballage", "Dimensiones y embalaje", "Dimensioni e imballaggio", "Maße & Verpackung"),
    width: lt(locale, "Width", "Genişlik", "Largeur", "Ancho", "Larghezza", "Breite"),
    height: lt(locale, "Height", "Yükseklik", "Hauteur", "Alto", "Altezza", "Höhe"),
    length: lt(locale, "Length", "Uzunluk", "Longueur", "Largo", "Lunghezza", "Länge"),
    weight: lt(locale, "Weight", "Ağırlık", "Poids", "Peso", "Peso", "Gewicht"),
    salesUnit: lt(locale, "Sales unit", "Satış birimi", "Unité de vente", "Unidad de venta", "Unità di vendita", "Verkaufseinheit"),
    unitOfMeasure: lt(locale, "Unit of measure", "Ölçü birimi", "Unité de mesure", "Unidad de medida", "Unità di misura", "Maßeinheit"),
    packagingUnit: lt(locale, "Packaging unit", "Ambalaj birimi", "Unité d'emballage", "Unidad de embalaje", "Unità di imballaggio", "Verpackungseinheit"),
    packagingUnitPlural: lt(locale, "Packaging unit (plural)", "Ambalaj birimi (çoğul)", "Unité d'emballage (pluriel)", "Unidad de embalaje (plural)", "Unità di imballaggio (plurale)", "Verpackungseinheit (Mehrzahl)"),
    baseUnit: lt(locale, "Base unit", "Temel birim", "Unité de base", "Unidad base", "Unità base", "Grundeinheit"),

    // Eigenschaften (metafields)
    eigenschaften: lt(locale, "Properties", "Özellikler", "Propriétés", "Propiedades", "Proprietà", "Eigenschaften"),
    searchEigenschaft: lt(locale, "Search property", "Özellik ara", "Rechercher une propriété", "Buscar propiedad", "Cerca proprietà", "Eigenschaft suchen"),

    // Allgemein — stock / MOQ
    minOrderQty: lt(locale, "Minimum order quantity", "Minimum sipariş adedi", "Quantité minimale de commande", "Cantidad mínima de pedido", "Quantità minima ordinabile", "Mindestbestellmenge"),

    // Rechtlich
    legalRequirements: lt(locale, "Legal requirements", "Yasal gereklilikler", "Exigences légales", "Requisitos legales", "Requisiti legali", "Rechtliche Anforderungen"),

    // Variante — parent lock
    lockToParent: lt(locale, "Use parent value", "Ana ürün değerini kullan", "Utiliser la valeur du produit parent", "Usar el valor del producto principal", "Usa il valore del prodotto principale", "Wert vom Hauptartikel übernehmen"),
  };
}

function defaultShopMarketForLocale(loc) {
  const l = String(loc || "de").toLowerCase();
  if (l === "en") return "gb";
  if (l === "tr") return "tr";
  if (l === "fr") return "fr";
  if (l === "it") return "it";
  if (l === "es") return "es";
  return "de";
}

function shopPreviewPrefix(loc) {
  const l = String(loc || "de").toLowerCase();
  return `/${defaultShopMarketForLocale(l)}/${l}`;
}

function shopProductHandleForLocale(product, loc) {
  const tr = product?.metadata?.translations?.[loc];
  const h = ((tr?.handle || "").trim() || (product?.handle || "").trim());
  if (!h) return "";
  const rawId = String(product?.id || "").replace(/^prod_/i, "").toLowerCase();
  const shortCode = rawId.length >= 8 ? rawId.slice(-8) : rawId;
  return shortCode ? `${h}-${shortCode}` : h;
}

function getEmptyProduct() {
  return {
    title: "",
    handle: "",
    sku: "",
    description: "",
    status: "draft",
    price: 0,
    inventory: 0,
    metadata: {},
    variants: [],
  };
}

function isPlaceholderProductTitle(value) {
  const t = String(value || "").trim();
  return !t || /^(untitled|unbenannt)$/i.test(t);
}

function isEmptyProductHtml(value) {
  const t = String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return !t;
}

function coerceProductMediaList(list) {
  if (!Array.isArray(list)) {
    if (list != null && String(list).trim() !== "") return [String(list).trim()];
    return [];
  }
  return list
    .map((u) => {
      if (u == null) return "";
      if (typeof u === "string") return u.trim();
      if (typeof u === "object") return String(u.url || u.src || u.path || "").trim();
      return "";
    })
    .filter(Boolean);
}

function withAutoTranslateNote(base, locale, locales) {
  if (!Array.isArray(locales) || !locales.length) return base;
  const list = locales.join(", ");
  return `${base} ${lt(locale, `Other languages updated: ${list}.`, `Diğer diller güncellendi: ${list}.`, `Autres langues mises à jour : ${list}.`, `Otros idiomas actualizados: ${list}.`, `Altre lingue aggiornate: ${list}.`, `Weitere Sprachen aktualisiert: ${list}.`)}`;
}

/** Seller-owned listing fields — never copy from another seller's catalog match (EAN / URL / existing_id). */
const SELLER_OWNED_META_KEYS = [
  "sku",
  "prices",
  "uvp_cents",
  "rabattpreis_cents",
  "shipping_group_id",
  "brand_id",
  "publish_date",
  "seller_id",
  "seller",
  "seller_name",
  "shop_name",
  "related_product_ids",
];

function stripSellerOwnedFromCatalogMeta(meta) {
  const out = meta && typeof meta === "object" ? { ...meta } : {};
  for (const k of SELLER_OWNED_META_KEYS) delete out[k];
  return out;
}

function sanitizeCatalogVariants(variants) {
  if (!Array.isArray(variants)) return [];
  return variants.map((v) => {
    const vMeta = v?.metadata && typeof v.metadata === "object" ? { ...v.metadata } : {};
    delete vMeta.shipping_group_id;
    delete vMeta.brand_id;
    delete vMeta.sku;
    delete vMeta.prices;
    return {
      ...v,
      sku: "",
      inventory: 0,
      inventory_quantity: 0,
      price: undefined,
      price_cents: 0,
      compare_at_price: undefined,
      compare_at_price_cents: undefined,
      sale_price: undefined,
      sale_price_cents: undefined,
      metadata: vMeta,
    };
  });
}

function normalizeProductForCompare(p) {
  if (!p) return null;
  return {
    title: p.title ?? "",
    handle: p.handle ?? "",
    sku: p.sku ?? "",
    description: p.description ?? "",
    status: p.status ?? "draft",
    price: p.price ?? 0,
    inventory: p.inventory ?? 0,
    metadata: p.metadata && typeof p.metadata === "object" ? p.metadata : {},
    variants: Array.isArray(p.variants) ? p.variants : [],
  };
}

function productSnapshot(p) {
  return JSON.stringify(normalizeProductForCompare(p));
}

function localizeProductForEditing(p, locale) {
  if (!p) return p;
  const tr = p.metadata?.translations;
  if (tr?.[locale]) {
    return {
      ...p,
      title: tr[locale].title ?? p.title,
      description: tr[locale].description ?? p.description,
    };
  }
  return p;
}

function getMeta(product, key, fallback = "") {
  const m = product?.metadata;
  if (!m || typeof m !== "object") return fallback;
  return m[key] != null && m[key] !== "" ? String(m[key]) : fallback;
}

function setMeta(product, key, value) {
  const m = { ...(product?.metadata && typeof product.metadata === "object" ? product.metadata : {}) };
  if (value === "" || value == null) delete m[key]; else m[key] = value;
  return { ...product, metadata: m };
}

function descriptionVisualToHtml(html) {
  const s = (html || "").trim();
  if (!s) return "";
  if (/<(p|div|h[1-6]|ul|ol|li)\b/i.test(s)) return s;
  return "<p>" + s + "</p>";
}

function changeRequestSellerLabel(cr) {
  if (!cr || typeof cr !== "object") return "—";
  return String(
    cr.seller_label ||
      cr.seller_store_name ||
      cr.seller_company_name ||
      cr.seller_email ||
      cr.seller_id ||
      "—"
  );
}

export default function ProductEditPage({ product: initialProduct, idOrHandle, isNew, onReload, sellerListings = [] }) {
  const router = useRouter();
  const locale = useLocale();
  const pe = useMemo(() => productEditCopy(locale), [locale]);
  const ui = getUI(locale);
  const client = getMedusaAdminClient();
  const baseUrl = (client.baseURL || getDefaultBaseUrl()).replace(/\/$/, "");
  const shopBaseUrl = getDefaultShopUrl();
  const searchParams = useSearchParams();
  const [product, setProduct] = useState(() => {
    const p = initialProduct ?? (isNew ? getEmptyProduct() : null);
    if (!p || !p.metadata?.translations) return p;
    const tr = p.metadata.translations[locale];
    return tr ? { ...p, title: tr.title ?? p.title, description: tr.description ?? p.description } : p;
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });
  // Save/approve/reject errors (and success banners like change-request) render at the top —
  // scroll up so the seller always sees them on long product forms.
  useEffect(() => {
    if (!message.text || (message.type !== "error" && message.type !== "success")) return;
    const scrollEl = typeof document !== "undefined" ? document.querySelector(".andertal-scroll-wrapper") : null;
    if (scrollEl) scrollEl.scrollTo({ top: 0, behavior: "smooth" });
    else if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [message]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [moreActionsOpen, setMoreActionsOpen] = useState(false);
  const [categories, setCategories] = useState([]);
  const [collections, setCollections] = useState([]);
  const [brands, setBrands] = useState([]);
  const [mediaPickerOpen, setMediaPickerOpen] = useState(false);
  const [mediaDragIndex, setMediaDragIndex] = useState(null);
  const [mediaDragOverIndex, setMediaDragOverIndex] = useState(null);
  const [collectionSearch, setCollectionSearch] = useState("");
  const [collectionPopoverOpen, setCollectionPopoverOpen] = useState(false);
  const [collectionRect, setCollectionRect] = useState(null);
  const collectionSearchRef = useRef(null);
  const [isSuperuser, setIsSuperuser] = useState(false);
  const [euOriginVerifying, setEuOriginVerifying] = useState(false);
  const [euOriginNotice, setEuOriginNotice] = useState("");
  const [relatedProductsList, setRelatedProductsList] = useState([]);
  const [relatedProductSearch, setRelatedProductSearch] = useState("");
  const [relatedProductPopoverOpen, setRelatedProductPopoverOpen] = useState(false);
  const [descriptionMode, setDescriptionMode] = useState("visual");
  const descEditorRef = useRef(null);
  const [baselineSnapshot, setBaselineSnapshot] = useState(() => {
    const p = initialProduct ?? (isNew ? getEmptyProduct() : null);
    return p ? productSnapshot(localizeProductForEditing(p, locale)) : null;
  });
  const dragGroupIdx = useRef(null);
  const [eanLookupState, setEanLookupState] = useState(null); // null | "loading" | "found" | "not_found"
  const [eanMatchedOn, setEanMatchedOn] = useState("parent"); // "parent" | "variant" — which EAN the lookup matched on
  const [urlSearchTerm, setUrlSearchTerm] = useState(""); // shop URL or handle to search
  const [urlSearchState, setUrlSearchState] = useState(null); // null | "loading" | "found" | "not_found"
  // Variant image picker: null = closed, option_values[] = target variant being edited
  const [variantImgPickerTarget, setVariantImgPickerTarget] = useState(null);
  // Swatch image picker: null = closed, {gi, oi} = target group/option
  const [swatchPickerTarget, setSwatchPickerTarget] = useState(null);
  // Draft price strings keyed by `${variantKey}_${field}` — committed on blur
  const [priceInputs, setPriceInputs] = useState({});
  const priceInputsRef = useRef({});
  useEffect(() => {
    priceInputsRef.current = priceInputs;
  }, [priceInputs]);
  // Per-country pricing: draft strings (text) — committed on blur; avoids number input + immediate toFixed
  const [countryPriceDrafts, setCountryPriceDrafts] = useState({});
  const countryPriceDraftsRef = useRef({});
  useEffect(() => {
    countryPriceDraftsRef.current = countryPriceDrafts;
  }, [countryPriceDrafts]);
  const [duplicateModalOpen, setDuplicateModalOpen] = useState(false);
  const [duplicateOptions, setDuplicateOptions] = useState(DEFAULT_DUPLICATE_OPTIONS);
  const [duplicateSaving, setDuplicateSaving] = useState(false);
  // Pricing must stay EUR/Germany regardless of interface language — a seller reading the UI in
  // Turkish or English isn't necessarily pricing for the Turkish/US market. There's no separate
  // manual market selector for this (editingCountry drove both), so this was silently switching
  // the price section to TRY/USD whenever the seller just changed their own display language.
  const editingCountry = "DE";
  const [shippingGroupsList, setShippingGroupsList] = useState([]);
  const [metaDefs, setMetaDefs] = useState({});
  const [metaDefSearch, setMetaDefSearch] = useState({});
  const [metaDefPopover, setMetaDefPopover] = useState({});
  const [vgValuePopover, setVgValuePopover] = useState({});
  const [vgValueSearch, setVgValueSearch] = useState({});
  /** Katalogdaki tüm tanımlar yerine: değeri olan veya kullanıcının eklediği metafield satırları */
  const [extraVisibleMetaDefKeys, setExtraVisibleMetaDefKeys] = useState({});
  const [addMetaDefPopoverOpen, setAddMetaDefPopoverOpen] = useState(false);
  const [classificationOpen, setClassificationOpen] = useState(false);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  /** Neues Katalog-Metafeld (Titel + Wert); Seller → Freigabe durch Superuser */
  const [newCatalogMetaOpen, setNewCatalogMetaOpen] = useState(false);
  const [newCatalogMetaLabel, setNewCatalogMetaLabel] = useState("");
  const [newCatalogMetaValue, setNewCatalogMetaValue] = useState("");
  const [newCatalogMetaKey, setNewCatalogMetaKey] = useState("");
  const [newCatalogMetaSaving, setNewCatalogMetaSaving] = useState(false);
  const [newCatalogMetaErr, setNewCatalogMetaErr] = useState("");
  const [pendingChangeRequests, setPendingChangeRequests] = useState([]);
  const [changeRequestsModalOpen, setChangeRequestsModalOpen] = useState(false);
  const [changeRequestActionId, setChangeRequestActionId] = useState("");
  const [fileUploading, setFileUploading] = useState(false);
  const [addingFile, setAddingFile] = useState(false);
  const [newFileUrl, setNewFileUrl] = useState("");
  const [newFileName, setNewFileName] = useState("");
  const [fileUploadErr, setFileUploadErr] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (collectionPopoverOpen) document.body.classList.add("andertal-collections-dropdown-open");
    else document.body.classList.remove("andertal-collections-dropdown-open");
    return () => document.body.classList.remove("andertal-collections-dropdown-open");
  }, [collectionPopoverOpen]);

  useEffect(() => {
    if (!collectionPopoverOpen) return;
    const update = () => {
      if (collectionSearchRef.current) {
        setCollectionRect(collectionSearchRef.current.getBoundingClientRect());
      }
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [collectionPopoverOpen]);

  const [currentSellerId, setCurrentSellerId] = useState(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsSuperuser(localStorage.getItem("sellerIsSuperuser") === "true");
    setCurrentSellerId(localStorage.getItem("sellerId") || null);
  }, []);

  const refetchPendingChangeRequests = useCallback(async (productId) => {
    // Pending-change-request review (current vs. proposed value, "suggested by") is a
    // superuser moderation tool — a seller should never see that their own edit to an
    // existing/shared product is sitting in a pending-approval queue.
    if (!productId || !isSuperuser) {
      setPendingChangeRequests([]);
      return [];
    }
    try {
      const d = await client.request(`/admin-hub/v1/product-change-requests?status=pending&product_id=${encodeURIComponent(productId)}`);
      const list = Array.isArray(d?.change_requests) ? d.change_requests : [];
      setPendingChangeRequests(list);
      return list;
    } catch (_) {
      setPendingChangeRequests([]);
      return [];
    }
  }, [client, isSuperuser]);

  const mergeLocaleFields = useCallback((p) => {
    if (!p) return p;
    const tr = p.metadata?.translations?.[locale];
    return tr
      ? { ...p, title: tr.title ?? p.title, description: tr.description ?? p.description }
      : p;
  }, [locale]);

  useEffect(() => {
    if (isNew || !product?.id) {
      setPendingChangeRequests([]);
      return;
    }
    refetchPendingChangeRequests(product.id);
  }, [isNew, product?.id, refetchPendingChangeRequests]);

  useEffect(() => {
    if (pendingChangeRequests.length === 0) setChangeRequestsModalOpen(false);
  }, [pendingChangeRequests.length]);

  const approveChangeRequest = useCallback(async (requestId) => {
    if (!requestId || !product?.id) return;
    try {
      setChangeRequestActionId(String(requestId));
      await client.request(`/admin-hub/v1/product-change-requests/${encodeURIComponent(requestId)}/approve`, {
        method: "POST",
        body: JSON.stringify({ reviewer_note: "Approved via product page" }),
      });
      const fresh = await client.getAdminHubProduct(product.id);
      const localized = mergeLocaleFields(fresh);
      if (localized) {
        setProduct(localized);
        setBaselineSnapshot(productSnapshot(localized));
      }
      await refetchPendingChangeRequests(product.id);
      setMessage({ type: "success", text: lt(locale, "Change approved and product updated.", "Değişiklik onaylandı ve ürün güncellendi.", "Modification approuvée et produit mis à jour.", "Cambio aprobado y producto actualizado.", "Modifica approvata e prodotto aggiornato.", "Änderung genehmigt und Produkt aktualisiert.") });
      onReload?.();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("andertal-notifications-refresh"));
      }
    } catch (err) {
      setMessage({ type: "error", text: err?.message || lt(locale, "Approval failed.", "Onaylama başarısız.", "Échec de l'approbation.", "La aprobación falló.", "Approvazione non riuscita.", "Freigabe fehlgeschlagen.") });
    } finally {
      setChangeRequestActionId("");
    }
  }, [client, product?.id, locale, onReload, refetchPendingChangeRequests, mergeLocaleFields]);
  const editAndApproveChangeRequest = useCallback(async (cr) => {
    if (!cr?.id || !product?.id) return;
    const edited = window.prompt(
      lt(locale, "Edit new value and approve:", "Yeni değeri düzenleyin ve onaylayın:", "Modifiez la nouvelle valeur puis approuvez-la :", "Edita el nuevo valor y apruébalo:", "Modifica il nuovo valore e approva:", "Neuen Wert bearbeiten und freigeben:"),
      String(cr?.new_value || ""),
    );
    if (edited == null) return;
    try {
      setChangeRequestActionId(String(cr.id));
      await client.request(`/admin-hub/v1/product-change-requests/${encodeURIComponent(cr.id)}/approve`, {
        method: "POST",
        body: JSON.stringify({ reviewer_note: "Edited + approved via product page", new_value: edited }),
      });
      const fresh = await client.getAdminHubProduct(product.id);
      const localized = mergeLocaleFields(fresh);
      if (localized) {
        setProduct(localized);
        setBaselineSnapshot(productSnapshot(localized));
      }
      await refetchPendingChangeRequests(product.id);
      setMessage({ type: "success", text: lt(locale, "Change edited and approved.", "Değişiklik düzenlenip onaylandı.", "Modification modifiée et approuvée.", "Cambio editado y aprobado.", "Modifica modificata e approvata.", "Änderung bearbeitet und freigegeben.") });
      onReload?.();
      if (typeof window !== "undefined") window.dispatchEvent(new Event("andertal-notifications-refresh"));
    } catch (err) {
      setMessage({ type: "error", text: err?.message || lt(locale, "Edit/approve failed.", "Düzenleme/onaylama başarısız.", "Échec de la modification/approbation.", "Error al editar/aprobar.", "Modifica/approvazione non riuscita.", "Bearbeiten/Freigabe fehlgeschlagen.") });
    } finally {
      setChangeRequestActionId("");
    }
  }, [client, locale, mergeLocaleFields, onReload, product?.id, refetchPendingChangeRequests]);

  const rejectChangeRequest = useCallback(async (requestId) => {
    if (!requestId || !product?.id) return;
    try {
      setChangeRequestActionId(String(requestId));
      await client.request(`/admin-hub/v1/product-change-requests/${encodeURIComponent(requestId)}/reject`, {
        method: "POST",
        body: JSON.stringify({ reviewer_note: "Rejected via product page" }),
      });
      await refetchPendingChangeRequests(product.id);
      setMessage({ type: "success", text: lt(locale, "Change rejected, product values stay unchanged.", "Değişiklik reddedildi, ürün değerleri korunuyor.", "Modification rejetée, les valeurs du produit restent inchangées.", "Cambio rechazado, los valores del producto se mantienen sin cambios.", "Modifica rifiutata, i valori del prodotto restano invariati.", "Änderung abgelehnt, Produktwerte bleiben unverändert.") });
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event("andertal-notifications-refresh"));
      }
    } catch (err) {
      setMessage({ type: "error", text: err?.message || lt(locale, "Rejection failed.", "Reddetme başarısız.", "Échec du rejet.", "El rechazo falló.", "Rifiuto non riuscito.", "Ablehnung fehlgeschlagen.") });
    } finally {
      setChangeRequestActionId("");
    }
  }, [client, product?.id, locale, refetchPendingChangeRequests]);

  // Sync from server when we switch product (id/handle) or locale. Merge translations[locale] into title/description.
  const initialProductId = initialProduct?.id ?? initialProduct?.handle ?? "";
  useEffect(() => {
    const next = initialProduct ?? (isNew ? getEmptyProduct() : null);
    if (!next) { setProduct((prev) => prev ?? null); return; }
    const localized = localizeProductForEditing(next, locale);
    setProduct((prev) => {
      const prevKey = prev?.id ?? prev?.handle ?? "";
      if (prevKey && initialProductId && prevKey === initialProductId) {
        return { ...prev, title: localized.title, description: localized.description };
      }
      return localized;
    });
    setBaselineSnapshot(productSnapshot(localized));
  }, [initialProductId, isNew, locale, initialProduct]);

  // Load categories, collections, brands in parallel so the page feels faster
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      client.getAdminHubCategories().then((r) => r.categories || []).catch(() => []),
      client.getMedusaCollections({ adminHub: true }).then((r) => r.collections || []).catch(() => []),
      client.getBrands().then((r) => r.brands || []).catch(() => []),
    ]).then(([categoriesList, collectionsList, brandsList]) => {
      if (!cancelled) {
        setCategories(categoriesList);
        setCollections(collectionsList);
        setBrands(brandsList);
      }
    });
    return () => { cancelled = true; };
  }, [client]);

  // Load products list once on mount (needed to resolve titles for existing related_product_ids tags)
  useEffect(() => {
    let cancelled = false;
    client.getAdminHubProducts({ limit: 200 }).then((r) => {
      if (!cancelled && r?.products) setRelatedProductsList(r.products);
    }).catch(() => { if (!cancelled) setRelatedProductsList([]); });
    return () => { cancelled = true; };
  }, [client]);

  // Load metafield definitions from MetaObjects
  useEffect(() => {
    let cancelled = false;
    client.getMetafieldDefinitions().then((r) => {
      if (!cancelled) setMetaDefs(filterMetaDefsForCatalog(r?.definitions || {}));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [client]);

  // Başka ürüne geçince "ek satır" seçimlerini sıfırla
  useEffect(() => {
    setExtraVisibleMetaDefKeys({});
  }, [product?.id, product?.handle]);

  // Load shipping groups for the dropdown
  useEffect(() => {
    let cancelled = false;
    client.request("/admin-hub/v1/shipping-groups").then((r) => {
      if (!cancelled) setShippingGroupsList(r?.groups || []);
    }).catch(() => { if (!cancelled) setShippingGroupsList([]); });
    return () => { cancelled = true; };
  }, [client]);

  // Auto-prune stale related_product_ids if those products were deleted
  useEffect(() => {
    if (!product) return;
    if (!relatedProductsList.length) return; // list not loaded yet — don't prune
    const ids = Array.isArray(product?.metadata?.related_product_ids)
      ? product.metadata.related_product_ids
      : [];
    if (!ids.length) return;
    const valid = new Set(relatedProductsList.map((p) => p?.id).filter(Boolean));
    const next = ids.filter((id) => valid.has(id));
    if (next.length !== ids.length) {
      setProduct((prev) => {
        if (!prev) return prev;
        const m = { ...(prev.metadata && typeof prev.metadata === "object" ? prev.metadata : {}) };
        if (next.length) m.related_product_ids = next;
        else delete m.related_product_ids;
        return { ...prev, metadata: m };
      });
    }
  }, [product?.id, product?.metadata?.related_product_ids, relatedProductsList]);

  useEffect(() => {
    if (descriptionMode === "visual" && descEditorRef.current) {
      const tr = product?.metadata?.translations || {};
      const locData = tr[locale] || {};
      const desc = locale === "de"
        ? (locData.description ?? product?.description ?? "")
        : (locData.description ?? "");
      descEditorRef.current.innerHTML = desc;
    }
  }, [descriptionMode, locale, product?.description, product?.metadata?.translations]);

  const isDirty =
    !!product &&
    baselineSnapshot != null &&
    productSnapshot(product) !== baselineSnapshot;
  const unsaved = useUnsavedChanges();

  const handleDiscard = useCallback(() => {
    const reset = initialProduct ?? (isNew ? getEmptyProduct() : null);
    const localized = localizeProductForEditing(reset, locale);
    setProduct(localized);
    setBaselineSnapshot(productSnapshot(localized));
    unsaved?.setDirty(false);
  }, [initialProduct, isNew, locale, unsaved]);

  useEffect(() => {
    if (!unsaved) return;
    unsaved.setDirty(!!isDirty);
  }, [isDirty, unsaved]);

  useEffect(() => {
    if (!unsaved) return;
    unsaved.setHandlers({
      onSave: () => saveRef.current?.(),
      onDiscard: () => discardRef.current?.(),
    });
    return () => {
      unsaved.clearHandlers();
      unsaved.setDirty(false);
    };
    // Deliberately NOT depending on `unsaved` itself: the context's memoized value gets a new
    // object identity every time isDirty changes, which would re-run this effect (and its
    // cleanup — clearHandlers + setDirty(false)) on every dirty-state toggle, wiping the Save/
    // Discard bar out immediately after it appears. setHandlers/clearHandlers/setDirty are all
    // stable identities (useCallback / raw useState setter), so this only needs to register once
    // per mount and clean up once on real unmount.
  }, [unsaved?.setHandlers, unsaved?.clearHandlers, unsaved?.setDirty]);

  const meta = product?.metadata && typeof product.metadata === "object" ? product.metadata : {};
  // Locked once a product exists with a category, since category drives which compliance
  // fields apply (Rechtlich tab) — changing it later would strand a product between two sets
  // of required fields.
  const categoryLocked = !isNew && Boolean(getMeta(product, "category_id"));

  // Per-locale content for the currently editing locale
  const editingTr = (meta.translations || {})[locale] || {};
  const editingTitle = locale === "de" ? (editingTr.title ?? product?.title ?? "") : (editingTr.title ?? "");
  const editingDescription = locale === "de" ? (editingTr.description ?? product?.description ?? "") : (editingTr.description ?? "");
  const editingBullets = Array.isArray(editingTr.bullet_points)
    ? editingTr.bullet_points
    : (locale === "de" && Array.isArray(meta.bullet_points) ? meta.bullet_points : []);

  // EAN lookup: when a new product's EAN is filled in, check if a master product exists and pre-fill form.
  const handleEanBlur = useCallback(async () => {
    if (!isNew) return;
    const ean = getMeta(product, "ean");
    if (!ean || String(ean).trim().length < 8) return;
    setEanLookupState("loading");
    try {
      const result = await client.lookupProductByEan(String(ean).trim());
      if (result) {
        setEanLookupState("found");
        setEanMatchedOn(result.matched_on || "parent");
        // Pre-fill form with existing master product data (keep seller-owned fields empty)
        setProduct((prev) => {
          if (!prev) return prev;
          const master = result.product;
          const masterMeta = stripSellerOwnedFromCatalogMeta(master.metadata);
          const masterVariants = Array.isArray(master.variants) ? master.variants : [];
          // Typed a child's own EAN directly (not the parent/grouping EAN): only that one
          // child is what the seller intends to sell — list it alone, don't drag in every
          // sibling variant. "master_total_variants" powers the "See other variations" link.
          const singleChildMode = result.matched_on === "variant" && masterVariants.length > 1;
          // Matched via the parent/grouping EAN: keep it as-is, seller wants the full family.
          const parentEan = singleChildMode ? String(ean).trim() : (result.matched_on === "variant" ? (masterMeta.ean || "") : String(ean).trim());
          if (singleChildMode) delete masterMeta.variation_groups;
          // Catalog shared fields only — SKU / price / shipping stay empty for this seller
          const mergedMeta = {
            ...masterMeta,
            ean: parentEan,
            master_product_id: master.id,
            master_total_variants: masterVariants.length,
          };
          return {
            ...prev,
            title: master.title || prev.title,
            description: master.description || prev.description,
            handle: master.handle || prev.handle,
            sku: "",
            price: 0,
            inventory: 0,
            metadata: mergedMeta,
            variants: singleChildMode
              ? []
              : (masterVariants.length > 0
                  ? sanitizeCatalogVariants(masterVariants)
                  : prev.variants),
          };
        });
      } else {
        setEanLookupState("not_found");
        setTimeout(() => setEanLookupState(null), 3000);
      }
    } catch (_) {
      setEanLookupState(null);
    }
  }, [isNew, product, client]);

  // Shop URL / handle search: find an existing master product by its shop URL code (8-char suffix or handle).
  const handleUrlSearch = useCallback(async () => {
    const raw = urlSearchTerm.trim();
    if (!raw) return;
    // Extract path segment: if full URL, take last non-empty path part
    let segment = raw;
    try {
      const parsed = new URL(raw);
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length > 0) segment = parts[parts.length - 1];
    } catch (_) {
      // not a URL, use raw string as-is
    }
    // Strip 8-char alphanumeric suffix to get the base handle
    const baseHandle = (() => {
      const lastDash = segment.lastIndexOf("-");
      if (lastDash >= 1) {
        const suffix = segment.slice(lastDash + 1);
        if (/^[a-z0-9]{8}$/i.test(suffix)) return segment.slice(0, lastDash);
      }
      return segment;
    })();
    setUrlSearchState("loading");
    try {
      // Try base handle first, then full segment as fallback
      let match = null;
      for (const h of [...new Set([baseHandle, segment])]) {
        if (!h) continue;
        try {
          const { product: found } = await client.getAdminHubProductFull(h);
          if (found?.id) { match = found; break; }
        } catch (_) {}
      }
      if (match) {
        setUrlSearchState("found");
        setProduct((prev) => {
          if (!prev) return prev;
          const masterMeta = stripSellerOwnedFromCatalogMeta(match.metadata);
          const mergedMeta = {
            ...masterMeta,
            master_product_id: match.id,
          };
          return {
            ...prev,
            title: match.title || prev.title,
            description: match.description || prev.description,
            handle: match.handle || prev.handle,
            sku: "",
            price: 0,
            inventory: 0,
            metadata: mergedMeta,
            variants: Array.isArray(match.variants) && match.variants.length > 0
              ? sanitizeCatalogVariants(match.variants)
              : prev.variants,
          };
        });
      } else {
        setUrlSearchState("not_found");
        setTimeout(() => setUrlSearchState(null), 3000);
      }
    } catch (_) {
      setUrlSearchState(null);
    }
  }, [urlSearchTerm, client]);

  // On mount: if ?existing_id is set, pre-fill form with that product's catalog data.
  // If ?variant_ean is also set, the seller picked one specific child variant (e.g. via
  // Add Existing Product) — list only that one item instead of the whole variant matrix,
  // since only that child is what they intend to sell (see "master_total_variants" below,
  // which powers the "See other variations" link back to Add Existing Product).
  useEffect(() => {
    if (!isNew) return;
    const existingId = searchParams?.get("existing_id");
    if (!existingId) return;
    const variantEanParam = String(searchParams?.get("variant_ean") || "").trim();
    (async () => {
      try {
        const { product: found } = await client.getAdminHubProductFull(existingId);
        if (!found?.id) return;
        const foundVariants = Array.isArray(found.variants) ? found.variants : [];
        const matchedVariant = variantEanParam
          ? foundVariants.find((v) => String(v?.ean || v?.metadata?.ean || "").trim() === variantEanParam)
          : null;
        const singleChildMode = !!matchedVariant && foundVariants.length > 1;
        setProduct((prev) => {
          if (!prev) return prev;
          const masterMeta = stripSellerOwnedFromCatalogMeta(found.metadata);
          if (singleChildMode) delete masterMeta.variation_groups;
          const mergedMeta = {
            ...masterMeta,
            ean: singleChildMode ? variantEanParam : masterMeta.ean,
            master_product_id: existingId,
            master_total_variants: foundVariants.length,
          };
          return {
            ...prev,
            title: found.title || prev.title,
            description: found.description || prev.description,
            handle: found.handle || prev.handle,
            sku: "",
            price: 0,
            inventory: 0,
            metadata: mergedMeta,
            variants: singleChildMode
              ? []
              : (foundVariants.length > 0
                  ? sanitizeCatalogVariants(foundVariants)
                  : prev.variants),
          };
        });
      } catch (_) {}
    })();
  }, []); // run only on mount

  // New product: URL handle follows the current locale title automatically (SEO slug).
  useEffect(() => {
    if (!isNew || !product) return;
    const src = (editingTitle || "").trim() || (product.title || "").trim();
    const next = titleToHandle(src);
    if (!next) return;
    setProduct((prev) => {
      if (!prev) return prev;
      const m = { ...(prev.metadata && typeof prev.metadata === "object" ? prev.metadata : {}) };
      const tr = { ...(m.translations || {}) };
      if (locale === "de") {
        tr.de = { ...(tr.de || {}), handle: next };
        const cur = (prev.handle || "").trim();
        if (cur === next) return prev;
        return { ...prev, handle: next, metadata: { ...m, translations: tr } };
      }
      const locPrev = { ...(tr[locale] || {}) };
      const curH = (locPrev.handle || "").trim();
      if (curH === next) return prev;
      tr[locale] = { ...locPrev, handle: next };
      return { ...prev, metadata: { ...m, translations: tr } };
    });
  }, [isNew, editingTitle, product?.title, locale]);

  // Secondary seller / shared catalog: logged-in seller is NOT the sole product owner → EAN immutable;
  // title/description/shared fields go through change-request review (not direct save).
  const productOwnerId = product?.seller_id ?? product?.seller ?? product?.metadata?.seller_id ?? null;
  const isSecondSeller = !isSuperuser && !isNew && Boolean(currentSellerId) && (
    !productOwnerId || String(currentSellerId) !== String(productOwnerId)
  );
  const isReusingCatalogOnCreate = isNew && !isSuperuser && (
    eanLookupState === "found" || urlSearchState === "found" || Boolean(meta.master_product_id)
  );
  const showSharedCatalogNotice = isSecondSeller || isReusingCatalogOnCreate;

  const changeRequestSubmittedMsg =
    locale === "tr"
      ? "Değişiklik talebiniz ekibimize iletildi. İncelendikten sonra onaylanır veya reddedilir. Fiyat, SKU ve kargo gibi kendi alanlarınız hemen kaydedilir."
      : locale === "de"
      ? "Dein Änderungsantrag wurde an unser Team übermittelt und wird geprüft. Eigene Felder (Preis, SKU, Versand) wurden sofort gespeichert."
      : locale === "fr"
      ? "Votre demande de modification a été transmise à notre équipe et sera examinée. Vos champs propres (prix, SKU, livraison) sont enregistrés immédiatement."
      : locale === "es"
      ? "Tu solicitud de cambio se ha enviado a nuestro equipo y será revisada. Tus campos propios (precio, SKU, envío) se guardan de inmediato."
      : locale === "it"
      ? "La tua richiesta di modifica è stata inviata al nostro team e verrà esaminata. I tuoi campi (prezzo, SKU, spedizione) sono salvati subito."
      : "Your change request has been sent to our team and will be reviewed. Your own fields (price, SKU, shipping) are saved immediately.";

  const sharedCatalogNoticeMsg =
    locale === "tr"
      ? "Bu ürün katalogda başka bir satıcı tarafından zaten eklenmiş. Ürün adı, açıklama, görseller ve diğer ortak katalog alanlarını doğrudan değiştiremezsiniz — kaydettiğinizde değişiklik talebi olarak ekibimize iletilir ve incelenir. Fiyat, SKU ve kargo yönteminizi ise kendiniz girersiniz."
      : locale === "de"
      ? "Dieses Produkt wurde bereits von einem anderen Anbieter im Katalog erfasst. Titel, Beschreibung, Bilder und andere gemeinsame Katalogfelder kannst du nicht direkt ändern — beim Speichern wird ein Änderungsantrag an unser Team gesendet und geprüft. Preis, SKU und Versandmethode trägst du selbst ein."
      : locale === "fr"
      ? "Ce produit a déjà été ajouté au catalogue par un autre vendeur. Vous ne pouvez pas modifier directement le titre, la description, les images et les autres champs partagés — à l'enregistrement, une demande de modification est envoyée à notre équipe. Vous saisissez vous-même le prix, le SKU et la livraison."
      : locale === "es"
      ? "Este producto ya fue añadido al catálogo por otro vendedor. No puedes cambiar directamente el título, la descripción, las imágenes u otros campos compartidos — al guardar se envía una solicitud de cambio a nuestro equipo. Tú introduces tu propio precio, SKU y envío."
      : locale === "it"
      ? "Questo prodotto è già stato aggiunto al catalogo da un altro venditore. Non puoi modificare direttamente titolo, descrizione, immagini e altri campi condivisi — al salvataggio la richiesta di modifica viene inviata al nostro team. Inserisci tu prezzo, SKU e spedizione."
      : "This product was already added to the catalog by another seller. You cannot directly change the title, description, images, or other shared catalog fields — when you save, a change request is sent to our team for review. Enter your own price, SKU, and shipping method.";

  // After create→redirect, show green success banner from query flag
  useEffect(() => {
    if (isNew) return;
    const cr = searchParams?.get("change_request");
    const cl = searchParams?.get("catalog_listing");
    if (cr === "1") {
      setMessage({ type: "success", text: changeRequestSubmittedMsg });
    } else if (cl === "1") {
      setMessage({
        type: "success",
        text: locale === "tr"
          ? "Mevcut katalog ürününe listing eklendi. Ortak alanlar (isim, açıklama vb.) doğrudan değişmez."
          : locale === "de"
          ? "Listing zum bestehenden Katalogprodukt hinzugefügt. Gemeinsame Felder ändern sich nicht direkt."
          : "Listing added to the existing catalog product. Shared fields are not changed directly.",
      });
    } else {
      return;
    }
    if (typeof window !== "undefined" && window.history?.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.delete("change_request");
      url.searchParams.delete("catalog_listing");
      window.history.replaceState({}, "", url.pathname + url.search);
    }
  // only on mount / when landing with these flags
  }, [isNew, searchParams]);

  // Per-country pricing for the currently editing country
  const currentCountryConf = PRODUCT_COUNTRIES_MAP[editingCountry] || PRODUCT_COUNTRIES_MAP["DE"];
  const countryPriceData = (meta.prices || {})[editingCountry] || {};
  // DE fallback: if no prices set yet, use legacy product.price as brutto
  const cpBruttoCents = countryPriceData.brutto_cents != null
    ? Number(countryPriceData.brutto_cents)
    : (editingCountry === "DE" && product?.price != null ? Math.round(Number(product.price) * 100) : null);
  const cpLinked = countryPriceData.linked !== false;
  const cpUvpCents = countryPriceData.uvp_cents != null ? Number(countryPriceData.uvp_cents) : (editingCountry === "DE" && meta.uvp_cents != null ? Number(meta.uvp_cents) : null);
  const cpSaleCents = countryPriceData.sale_cents != null ? Number(countryPriceData.sale_cents) : (editingCountry === "DE" && meta.rabattpreis_cents != null ? Number(meta.rabattpreis_cents) : null);

  const update = useCallback((updates) => {
    setProduct((prev) => (prev ? { ...prev, ...updates } : prev));
  }, []);

  // ── Per-locale content helpers ──────────────────────────────────
  const updateLocaleField = useCallback((key, value) => {
    setProduct((prev) => {
      if (!prev) return prev;
      const m = { ...(prev.metadata && typeof prev.metadata === "object" ? prev.metadata : {}) };
      const tr = { ...(m.translations || {}) };
      const locData = { ...(tr[locale] || {}) };
      if (key === "handle" && (value === "" || value == null)) delete locData.handle;
      else locData[key] = value;
      if (locData._auto && typeof locData._auto === "object" && locData._auto[key]) {
        const auto = { ...locData._auto };
        delete auto[key];
        if (Object.keys(auto).length) locData._auto = auto;
        else delete locData._auto;
      }
      tr[locale] = locData;
      m.translations = tr;
      // Keep product.title / product.description in sync for the primary DE locale
      if (locale === "de") {
        if (key === "title") return { ...prev, title: value, metadata: m };
        if (key === "description") return { ...prev, description: value, metadata: m };
      }
      return { ...prev, metadata: m };
    });
  }, [locale]);

  // ── Per-country price helpers ────────────────────────────────────
  const updateCountryPrice = useCallback((field, cents) => {
    setProduct((prev) => {
      if (!prev) return prev;
      const countryConf = PRODUCT_COUNTRIES_MAP[editingCountry] || PRODUCT_COUNTRIES_MAP["DE"];
      const m = { ...(prev.metadata && typeof prev.metadata === "object" ? prev.metadata : {}) };
      const prices = { ...(m.prices || {}) };
      const cp = { ...(prices[editingCountry] || {}) };
      cp[field] = cents;
      if (cp.linked !== false && cents != null) {
        if (field === "brutto_cents") cp.netto_cents = Math.round(cents / (1 + countryConf.vatRate / 100));
        else if (field === "netto_cents") cp.brutto_cents = Math.round(cents * (1 + countryConf.vatRate / 100));
      }
      prices[editingCountry] = cp;
      m.prices = prices;
      const extra = {};
      if (editingCountry === "DE") {
        const b = cp.brutto_cents;
        if (b != null) extra.price = b / 100;
      }
      return { ...prev, ...extra, metadata: m };
    });
  }, [editingCountry]);

  /** Pass `rawFromDom` from blur `e.currentTarget.value` so the last keystroke is never lost (draft ref can lag one render). */
  const commitCountryPriceDraft = useCallback((draftKey, metadataField, linkedClearKey, rawFromDom) => {
    const fromRef = countryPriceDraftsRef.current[draftKey];
    const raw =
      rawFromDom !== undefined ? sanitizePriceDraftString(String(rawFromDom)) : fromRef;
    if (raw === undefined) return;
    const trimmed = String(raw).trim();
    const n = parseFloat(trimmed.replace(",", "."));
    updateCountryPrice(metadataField, trimmed === "" || Number.isNaN(n) ? null : Math.round(n * 100));
    setCountryPriceDrafts((prev) => {
      const next = { ...prev };
      delete next[draftKey];
      if (linkedClearKey) delete next[linkedClearKey];
      countryPriceDraftsRef.current = next;
      return next;
    });
  }, [updateCountryPrice]);

  const updateMeta = useCallback((key, value) => {
    setProduct((prev) => {
      if (!prev) return prev;
      const m = { ...(prev.metadata && typeof prev.metadata === "object" ? prev.metadata : {}) };
      if (value === "" || value == null) delete m[key]; else m[key] = value;
      return { ...prev, metadata: m };
    });
  }, []);

  const handleVerifyEuOrigin = useCallback(async (manual) => {
    if (!product?.id) return;
    setEuOriginVerifying(true);
    setEuOriginNotice("");
    try {
      const res = await getMedusaAdminClient().verifyEuOrigin(product.id, {
        manual: Boolean(manual),
        provider: meta.eu_origin_provider || "stub",
      });
      if (res?.product) setProduct(res.product);
      const st = res?.eu_origin?.eu_origin_status || res?.status;
      if (st === EU_ORIGIN_STATUS.VERIFIED) {
        setEuOriginNotice(locale === "en" ? "EU origin verified — badge appears in shop after saving." : locale === "tr" ? "AB kökeni doğrulandı — kayıt sonrası mağazada rozet görünür." : locale === "fr" ? "Origine UE vérifiée — le badge apparaît dans la boutique après enregistrement." : locale === "es" ? "Origen UE verificado — el badge aparece en la tienda tras guardar." : locale === "it" ? "Origine UE verificata — il badge appare nel negozio dopo il salvataggio." : "EU-Herkunft verifiziert — Badge erscheint im Shop nach Speichern der Stile.");
      } else {
        setEuOriginNotice(res?.message || (locale === "en" ? "Verification pending (queue / superuser)." : locale === "tr" ? "Doğrulama beklemede (kuyruk / süper kullanıcı)." : locale === "fr" ? "Vérification en attente (file d'attente / superuser)." : locale === "es" ? "Verificación pendiente (cola / superusuario)." : locale === "it" ? "Verifica in sospeso (coda / superuser)." : "Prüfung ausstehend (Warteschlange / Superuser)."));
      }
    } catch (e) {
      setEuOriginNotice(e?.message || (locale === "en" ? "Verification failed." : locale === "tr" ? "Doğrulama başarısız." : locale === "fr" ? "Échec de la vérification." : locale === "es" ? "Error en la verificación." : locale === "it" ? "Verifica fallita." : "Verifizierung fehlgeschlagen"));
    } finally {
      setEuOriginVerifying(false);
    }
  }, [product?.id, meta.eu_origin_provider]);

  const updateCategoryWithParents = useCallback((categoryId) => {
    const selected = String(categoryId || "").trim();
    setProduct((prev) => {
      if (!prev) return prev;
      const m = { ...(prev.metadata && typeof prev.metadata === "object" ? prev.metadata : {}) };
      if (!selected) {
        delete m.category_id;
        delete m.admin_category_id;
        delete m.category_ids;
        delete m.category_slug;
        return { ...prev, metadata: m };
      }
      const byId = new Map((categories || []).map((c) => [String(c.id), c]));
      const catNode = byId.get(selected);
      const lineage = categoryLineageIdsFromFlatList(categories, selected);
      m.category_id = selected;
      m.admin_category_id = selected;
      m.category_ids = lineage.length > 0 ? lineage : [selected];
      if (catNode?.slug) m.category_slug = String(catNode.slug).replace(/^\//, "");
      return { ...prev, metadata: m };
    });
  }, [categories]);

  const save = async () => {
    if (!product) return false;
    // Flush visual editor content for the current editing locale
    const editingDescToSave = descriptionMode === "visual" && descEditorRef.current
      ? descriptionVisualToHtml(descEditorRef.current.innerHTML || "")
      : editingDescription;
    const fallbackStatus = initialProduct?.status ?? "draft";
    const nextStatus = product.status != null && String(product.status).trim() !== ""
      ? String(product.status).trim()
      : fallbackStatus;
    try {
      setSaving(true);
      setMessage({ type: "", text: "" });
      const metadata = { ...(product.metadata || {}) };
      const selectedCategoryId = String(metadata.category_id || "").trim();
      if (selectedCategoryId) {
        const byId = new Map((categories || []).map((c) => [String(c.id), c]));
        const catNode = byId.get(selectedCategoryId);
        const lineage = categoryLineageIdsFromFlatList(categories, selectedCategoryId);
        metadata.category_id = selectedCategoryId;
        metadata.admin_category_id = selectedCategoryId;
        metadata.category_ids = lineage.length > 0 ? lineage : [selectedCategoryId];
        if (catNode?.slug) metadata.category_slug = String(catNode.slug).replace(/^\//, "");
      }
      const storeName = (typeof window !== "undefined" ? (localStorage.getItem("storeName") || "").trim() : "") || "";
      if (storeName) {
        metadata.seller_name = storeName;
        metadata.shop_name = storeName;
      }
      // Auto-fill publish_date when empty: prefer product created_at, else now.
      if (!metadata.publish_date) {
        const createdAt = product?.created_at ? new Date(product.created_at) : null;
        metadata.publish_date =
          createdAt && !isNaN(createdAt.getTime())
            ? createdAt.toISOString()
            : new Date().toISOString();
      }
      // Commit the currently editing locale's content
      const allTranslations = { ...(metadata.translations || {}) };
      allTranslations[locale] = {
        ...(allTranslations[locale] || {}),
        title: editingTitle || product.title || "Untitled",
        description: editingDescToSave,
        bullet_points: editingBullets,
      };
      // Shop + inventory overview read DE/canonical fields. Editing another locale
      // used to leave DE as "Untitled" with empty media, so the shop never saw the name/image.
      const locTitle = String(allTranslations[locale]?.title || "").trim();
      if (isPlaceholderProductTitle(allTranslations.de?.title) && !isPlaceholderProductTitle(locTitle)) {
        allTranslations.de = { ...(allTranslations.de || {}), title: locTitle };
        allTranslations.de._auto = { ...(allTranslations.de._auto || {}), title: true };
      }
      if (isPlaceholderProductTitle(allTranslations.de?.title) && !isPlaceholderProductTitle(product.title)) {
        allTranslations.de = { ...(allTranslations.de || {}), title: String(product.title).trim() };
      }
      if (!allTranslations.de?.title) {
        allTranslations.de = { ...(allTranslations.de || {}), title: product.title || "Untitled", description: product.description || "" };
      }
      const locDesc = String(allTranslations[locale]?.description || "").trim();
      if (locale !== "de" && isEmptyProductHtml(allTranslations.de?.description) && !isEmptyProductHtml(locDesc)) {
        allTranslations.de = { ...(allTranslations.de || {}), description: locDesc };
        allTranslations.de._auto = { ...(allTranslations.de._auto || {}), description: true };
      }
      const locBullets = Array.isArray(allTranslations[locale]?.bullet_points)
        ? allTranslations[locale].bullet_points.map((b) => String(b || "").trim()).filter(Boolean)
        : [];
      const deBullets = Array.isArray(allTranslations.de?.bullet_points)
        ? allTranslations.de.bullet_points.map((b) => String(b || "").trim()).filter(Boolean)
        : [];
      if (locale !== "de" && deBullets.length === 0 && locBullets.length) {
        allTranslations.de = { ...(allTranslations.de || {}), bullet_points: locBullets };
        allTranslations.de._auto = { ...(allTranslations.de._auto || {}), bullet_points: true };
      }
      const locMedia = coerceProductMediaList(allTranslations[locale]?.media);
      const deMedia = coerceProductMediaList(allTranslations.de?.media);
      const rootMedia = coerceProductMediaList(metadata.media);
      if (rootMedia.length === 0 && deMedia.length === 0 && locMedia.length > 0) {
        metadata.media = locMedia;
        allTranslations.de = { ...(allTranslations.de || {}), media: locMedia };
      } else if (rootMedia.length === 0 && deMedia.length > 0) {
        metadata.media = deMedia;
      } else if (deMedia.length === 0 && rootMedia.length > 0) {
        allTranslations.de = { ...(allTranslations.de || {}), media: rootMedia };
      }
      const titleForHandle = isPlaceholderProductTitle(allTranslations.de?.title)
        ? (locTitle || product.title || "")
        : (allTranslations.de?.title || product.title || "");
      const fromTitle = titleToHandle(titleForHandle) || "";
      const currentHandle = (product.handle || "").trim();
      const canonicalHandle =
        (!isPlaceholderHandle(currentHandle) ? currentHandle : "") ||
        fromTitle ||
        "product";
      for (const locKey of Object.keys(allTranslations)) {
        const row = allTranslations[locKey] || {};
        if (!isPlaceholderHandle(row.handle)) continue;
        const locFromTitle = titleToHandle(row.title || "") || canonicalHandle;
        allTranslations[locKey] = { ...row, handle: locFromTitle };
      }
      allTranslations.de = { ...(allTranslations.de || {}), handle: canonicalHandle };
      metadata.translations = allTranslations;
      // variation_groups already in metadata (kept in sync by applyVariantGroups); re-serialize for safety
      if (variantGroups.length > 0) {
        metadata.variation_groups = variantGroups.map((g) => ({
          name: (g.name || "Option").trim() || "Option",
          ...(g.metafield_key ? { metafield_key: g.metafield_key } : {}),
          options: (g.options || []).map((o) => {
            const row = {
              value: String(o.value ?? "").trim(),
              ...(o.swatch_image ? { swatch_image: String(o.swatch_image).trim() } : {}),
            };
            if (o.labels && typeof o.labels === "object" && Object.keys(o.labels).length > 0) {
              row.labels = o.labels;
            }
            return row;
          }),
        }));
      }
      const variantsToSave = product.variants || [];
      const missingVariantEan = variantsToSave.find((row) => String(row?.ean || "").trim() === "");
      if (missingVariantEan) {
        setMessage({
          type: "warning",
          text: lt(locale, "Enter EAN for all variants before saving.", "Kaydetmek için tüm varyantlarda EAN girilmelidir.", "Saisissez un EAN pour toutes les variantes avant d'enregistrer.", "Introduce EAN para todas las variantes antes de guardar.", "Inserisci l'EAN per tutte le varianti prima di salvare.", "Bitte EAN für alle Varianten eintragen, um zu speichern."),
        });
        setActiveTabIndex(2);
        return false;
      }
      const gpsrMissing = [];
      if (!String(metadata.hersteller || "").trim()) gpsrMissing.push("Hersteller");
      if (!String(metadata.hersteller_information || "").trim()) gpsrMissing.push("Hersteller-Informationen");
      if (!String(metadata.verantwortliche_person_information || "").trim()) gpsrMissing.push("Verantwortliche Person (EU)");
      if (gpsrMissing.length > 0) {
        setMessage({
          type: "warning",
          text: lt(
            locale,
            `Fill in these GPSR fields to save: ${gpsrMissing.join(", ")}`,
            `Kaydetmek için GPSR alanlarını doldurun: ${gpsrMissing.join(", ")}`,
            `Remplissez ces champs GPSR pour enregistrer : ${gpsrMissing.join(", ")}`,
            `Complete estos campos GPSR para guardar: ${gpsrMissing.join(", ")}`,
            `Compila questi campi GPSR per salvare: ${gpsrMissing.join(", ")}`,
            `Bitte folgende GPSR-Felder ausfüllen, um zu speichern: ${gpsrMissing.join(", ")}`,
          ),
        });
        setActiveTabIndex(3);
        return false;
      }
      const collectionId = (metadata.collection_ids && metadata.collection_ids[0]) || product.collection_id || null;
      // Canonical title = DE locale (for backward compat with shop)
      const canonicalTitle = isPlaceholderProductTitle(metadata.translations?.de?.title)
        ? (locTitle || product.title || "Untitled")
        : (metadata.translations?.de?.title || product.title || "Untitled");
      // Canonical price = DE brutto price (for backward compat)
      const dePriceCents = (metadata.prices?.DE?.brutto_cents != null)
        ? Number(metadata.prices.DE.brutto_cents)
        : (product.price != null ? Math.round(Number(product.price) * 100) : 0);
      const canonicalDescription = metadata.translations?.de?.description || product.description || "";
      const payload = {
        title: canonicalTitle,
        handle: canonicalHandle,
        sku: product.sku || "",
        description: canonicalDescription,
        status: nextStatus,
        price: dePriceCents / 100,
        inventory: product.inventory ?? 0,
        metadata,
        variants: variantsToSave,
        source_locale: locale,
        auto_translate: true,
        ...(collectionId !== undefined && { collection_id: collectionId }),
      };
      if (isNew) {
        const res = await client.createAdminHubProductRaw(payload);
        const created = res?.product ?? res;
        if (res?.deduplicated) {
          if (res?.metafield_suggestions_submitted) {
            setMessage({ type: "success", text: changeRequestSubmittedMsg });
          } else {
            setMessage({
              type: "success",
              text: locale === "tr"
                ? "Mevcut katalog ürününe listing eklendi. Ortak alanlar (isim, açıklama vb.) doğrudan değişmez; kendi fiyat/SKU/kargonuzu kaydedin."
                : locale === "de"
                ? "Listing zum bestehenden Katalogprodukt hinzugefügt. Gemeinsame Felder (Name, Beschreibung usw.) ändern sich nicht direkt — trage deinen eigenen Preis/SKU/Versand ein."
                : "Listing added to the existing catalog product. Shared fields (name, description, etc.) are not changed directly — enter your own price/SKU/shipping.",
            });
          }
        } else {
          setMessage({ type: "success", text: withAutoTranslateNote(locale === "en" ? "Product created." : locale === "tr" ? "Ürün oluşturuldu." : locale === "fr" ? "Produit créé." : locale === "es" ? "Producto creado." : locale === "it" ? "Prodotto creato." : "Produkt erstellt.", locale, res?.product?.auto_translated_locales || created?.auto_translated_locales) });
        }
        onReload?.();
        if (created?.id) {
          const qs = res?.metafield_suggestions_submitted
            ? "?change_request=1"
            : (res?.deduplicated ? "?catalog_listing=1" : "");
          router.push(`/products/${created.id}${qs}`);
        }
        return true;
      }
      const updatedRaw = await client.updateAdminHubProduct(idOrHandle, payload);

      // Handle suggestion_submitted (superuser review needed for shared catalog changes).
      // Note: a request can carry BOTH a shared-field change proposal AND the caller's own
      // price/inventory/etc — when listing_saved is also true, fall through to that handling
      // below instead of returning early, otherwise the seller's own saved fields never reach
      // local state even though the backend persisted them.
      if (updatedRaw?.suggestion_submitted) {
        if (typeof window !== "undefined") {
          window.dispatchEvent(new Event("andertal-notifications-refresh"));
        }
        await refetchPendingChangeRequests(product.id);
        if (!updatedRaw?.listing_saved) {
          setMessage({ type: "success", text: changeRequestSubmittedMsg });
          const merged = { ...product, ...payload, metadata: payload.metadata ?? product.metadata };
          setProduct(merged);
          setBaselineSnapshot(productSnapshot(merged));
          unsaved?.setDirty(false);
          return true;
        }
      }

      // Handle listing_saved (seller-specific fields saved to listing, not master product)
      const resolvedProduct = updatedRaw?.product ?? updatedRaw;
      const savedProductRaw = (resolvedProduct && resolvedProduct.id) ? resolvedProduct : {
        ...product,
        ...payload,
        metadata: payload.metadata ?? product.metadata,
        variants: payload.variants ?? product.variants,
      };
      const savedTr = savedProductRaw?.metadata?.translations?.[locale];
      const savedProduct = savedTr
        ? {
            ...savedProductRaw,
            title: savedTr.title ?? savedProductRaw.title,
            description: savedTr.description ?? savedProductRaw.description,
          }
        : savedProductRaw;

      setProduct(savedProduct);
      setBaselineSnapshot(productSnapshot(savedProduct));
      unsaved?.setDirty(false);
      // Shop receives on-demand /api/revalidate after admin writes (plus short TTLs).
      const cacheDelayNote = locale === "en" ? " Shop cache is refreshed on save."
        : locale === "tr" ? " Kayıtta shop önbelleği yenilenir."
        : locale === "fr" ? " Le cache boutique est rafraîchi à l’enregistrement."
        : locale === "es" ? " La caché de la tienda se actualiza al guardar."
        : locale === "it" ? " La cache del negozio viene aggiornata al salvataggio."
        : " Shop-Cache wird beim Speichern aktualisiert.";
      const autoNoteLocales = updatedRaw?.listing_saved || updatedRaw?.suggestion_submitted
        ? []
        : (updatedRaw?.product?.auto_translated_locales || savedProduct?.auto_translated_locales);
      setMessage({ type: "success", text: withAutoTranslateNote((updatedRaw?.listing_saved
        ? (updatedRaw?.suggestion_submitted
            ? changeRequestSubmittedMsg
            : (locale === "en" ? "Price, inventory and own data saved." : locale === "tr" ? "Fiyat, stok ve özel veriler kaydedildi." : locale === "fr" ? "Prix, stock et données propres enregistrés." : locale === "es" ? "Precio, inventario y datos propios guardados." : locale === "it" ? "Prezzo, inventario e dati propri salvati." : "Preis, Bestand und eigene Daten gespeichert."))
        : ui.saved) + (updatedRaw?.suggestion_submitted ? "" : cacheDelayNote), locale, autoNoteLocales) });
      await refetchPendingChangeRequests(savedProduct.id);
      onReload?.();
      return true;
    } catch (err) {
      setMessage({ type: "error", text: err?.message || "Save failed" });
      return false;
    } finally {
      setSaving(false);
    }
  };

  const saveRef = useRef(save);
  const discardRef = useRef(handleDiscard);
  saveRef.current = save;
  discardRef.current = handleDiscard;

  const openDuplicateModal = () => {
    setDuplicateOptions({ ...DEFAULT_DUPLICATE_OPTIONS });
    setDuplicateModalOpen(true);
  };

  const runDuplicate = async () => {
    if (!product) return;
    setDuplicateSaving(true);
    try {
      const opt = duplicateOptions;
      const meta = (product.metadata && typeof product.metadata === "object") ? { ...product.metadata } : {};
      delete meta.ean;
      if (!opt.media) meta.media = undefined;
      if (!opt.categories) {
        meta.collection_ids = undefined;
        meta.collection_id = undefined;
      }
      const variants = opt.variants ? stripSkuEanFromVariants(product.variants) : [];
      const origTitle = (product.title || "").trim();
      const newTitle = opt.title ? origTitle : "Untitled";
      // Handle uses original title slug + timestamp to keep it clean (no "copy")
      const payload = {
        title: newTitle,
        handle: titleToHandle(origTitle || "produkt") + "-" + Date.now().toString(36),
        sku: "",
        description: opt.description ? (product.description || "") : "",
        status: "draft",
        price: opt.price && (product.price != null) ? Number(product.price) : 0,
        inventory: opt.inventory && (product.inventory != null) ? Number(product.inventory) : 0,
        metadata: meta,
        variants,
        ...(opt.categories && (product.collection_id != null) ? { collection_id: product.collection_id } : {}),
      };
      if (opt.categories && meta.collection_ids && Array.isArray(meta.collection_ids)) {
        payload.metadata = { ...payload.metadata, collection_ids: meta.collection_ids };
      }
      const created = await client.createAdminHubProduct(payload);
      setDuplicateModalOpen(false);
      if (created?.id) router.push(`/products/${created.id}`);
    } catch (err) {
      setMessage({ type: "error", text: err?.message || "Duplicate failed" });
    } finally {
      setDuplicateSaving(false);
    }
  };

  const deleteProduct = async () => {
    if (!product?.id) return;
    try {
      setSaving(true);
      await client.deleteAdminHubProduct(product.id);
      router.push("/products/inventory");
    } catch (err) {
      setMessage({ type: "error", text: err?.message || "Delete failed" });
    } finally {
      setSaving(false);
    }
  };

  const metafieldsList = Array.isArray(meta.metafields) ? meta.metafields : (meta.metafields && typeof meta.metafields === "object" ? Object.entries(meta.metafields).map(([k, v]) => ({ key: k, value: v })) : []);

  const normalizeCatalogMetaKey = (raw, labelFallback) => {
    let k = String(raw || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    if (!k && labelFallback) {
      k = titleToHandle(String(labelFallback)).replace(/-/g, "_").replace(/[^a-z0-9_]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    }
    return k || "";
  };

  const submitNewCatalogMetafield = async () => {
    setNewCatalogMetaErr("");
    const label = newCatalogMetaLabel.trim();
    const value = newCatalogMetaValue.trim();
    if (!label) {
      setNewCatalogMetaErr(locale === "en" ? "Please enter a title / display name." : locale === "tr" ? "Lütfen bir başlık / görünen ad girin." : locale === "fr" ? "Veuillez saisir un titre / nom d'affichage." : locale === "es" ? "Por favor ingrese un título / nombre de visualización." : locale === "it" ? "Inserire un titolo / nome di visualizzazione." : "Bitte Titel / Anzeigename angeben.");
      return;
    }
    if (!value) {
      setNewCatalogMetaErr(locale === "en" ? "Please enter a value." : locale === "tr" ? "Lütfen bir değer girin." : locale === "fr" ? "Veuillez saisir une valeur." : locale === "es" ? "Por favor ingrese un valor." : locale === "it" ? "Inserire un valore." : "Bitte Inhalt / Wert angeben.");
      return;
    }
    const key = normalizeCatalogMetaKey(newCatalogMetaKey, label);
    if (!key) {
      setNewCatalogMetaErr(locale === "en" ? "Invalid key." : locale === "tr" ? "Geçersiz anahtar." : locale === "fr" ? "Clé invalide." : locale === "es" ? "Clave inválida." : locale === "it" ? "Chiave non valida." : "Ungültiger Key.");
      return;
    }
    if (isExcludedCatalogMetaKey(key)) {
      setNewCatalogMetaErr(locale === "en" ? "This key is reserved for category assignment and cannot be used as a metafield." : locale === "tr" ? "Bu anahtar kategori atama için ayrılmıştır ve metafield olarak kullanılamaz." : locale === "fr" ? "Cette clé est réservée à l'attribution de catégorie et ne peut pas être utilisée comme métachamp." : locale === "es" ? "Esta clave está reservada para la asignación de categoría y no puede usarse como metacampo." : locale === "it" ? "Questa chiave è riservata all'assegnazione di categoria e non può essere usata come metacampo." : "Dieser Key ist für die Kategorie-Zuordnung reserviert und kann nicht als Metafeld angelegt werden.");
      return;
    }
    setNewCatalogMetaSaving(true);
    try {
      const others = metafieldsList.filter((m) => m.key !== key);
      updateMeta("metafields", [...others, ...[value].map((v) => ({ key, value: v }))]);
      setExtraVisibleMetaDefKeys((p) => ({ ...p, [key]: true }));
      await client.submitMetafieldCatalogProposal({
        ...(newCatalogMetaKey.trim() ? { key } : {}),
        label,
        values: [value],
      });
      const defs = await client.getMetafieldDefinitions().catch(() => null);
      if (defs?.definitions) setMetaDefs(filterMetaDefsForCatalog(defs.definitions));
      setNewCatalogMetaOpen(false);
      setNewCatalogMetaLabel("");
      setNewCatalogMetaValue("");
      setNewCatalogMetaKey("");
      setMessage({
        type: "success",
        text: isSuperuser
          ? (locale === "en" ? "Metafield saved in catalog." : locale === "tr" ? "Metafield katalogda kaydedildi." : locale === "fr" ? "Métachamp enregistré dans le catalogue." : locale === "es" ? "Metacampo guardado en el catálogo." : locale === "it" ? "Metacampo salvato nel catalogo." : "Metafeld wurde im Katalog gespeichert.")
          : (locale === "en" ? "Suggestion submitted — a superuser can approve it under Content → Metaobjects. Save the product: it will not appear in the shop until the new title/value is approved." : locale === "tr" ? "Öneri gönderildi — süper kullanıcı İçerik → Metaobjects altında onaylayabilir. Ürünü kaydedin: yeni başlık/değer onaylanana kadar shop’ta görünmez." : locale === "fr" ? "Suggestion soumise — un superuser peut l'approuver sous Contenu → Metaobjects. Enregistrez le produit : il restera masqué en boutique jusqu'à approbation." : locale === "es" ? "Sugerencia enviada — un superusuario puede aprobarla en Contenido → Metaobjetos. Guarda el producto: no aparecerá en la tienda hasta que se apruebe." : locale === "it" ? "Suggerimento inviato — un superuser può approvarlo in Contenuto → Metaoggetti. Salva il prodotto: resta nascosto nello shop fino all'approvazione." : "Vorschlag eingereicht — ein Superuser kann ihn unter Content → Metaobjects freigeben. Bitte Produkt speichern: Es bleibt im Shop unsichtbar, bis Titel/Wert freigegeben sind."),
      });
    } catch (e) {
      setNewCatalogMetaErr(e?.message || (locale === "en" ? "Error." : locale === "tr" ? "Hata." : locale === "fr" ? "Erreur." : locale === "es" ? "Error." : locale === "it" ? "Errore." : "Fehler"));
    } finally {
      setNewCatalogMetaSaving(false);
    }
  };

  const metaDefKeysWithValues = useMemo(() => {
    const s = new Set();
    for (const m of metafieldsList) {
      if (!m?.key) continue;
      if (m.value != null && String(m.value).trim() !== "") s.add(m.key);
    }
    return s;
  }, [metafieldsList]);

  const visibleMetaDefEntries = useMemo(() => {
    const fromDefs = Object.entries(metaDefs)
      .filter(([k]) => metaDefKeysWithValues.has(k) || extraVisibleMetaDefKeys[k]);
    const seen = new Set(fromDefs.map(([k]) => k));
    const extra = [];
    for (const k of metaDefKeysWithValues) {
      if (seen.has(k) || isExcludedCatalogMetaKey(k)) continue;
      extra.push([k, { label: k, values: metafieldsList.filter((m) => m.key === k).map((m) => m.value).filter(Boolean) }]);
    }
    return [...fromDefs, ...extra].sort(([a], [b]) => a.localeCompare(b));
  }, [metaDefs, metaDefKeysWithValues, extraVisibleMetaDefKeys, metafieldsList]);

  const hiddenMetaDefKeys = useMemo(
    () =>
      Object.keys(metaDefs)
        .filter((k) => !metaDefKeysWithValues.has(k) && !extraVisibleMetaDefKeys[k])
        .sort((a, b) => resolveMetaDefLabel(metaDefs[a], a, locale).localeCompare(resolveMetaDefLabel(metaDefs[b], b, locale))),
    [metaDefs, metaDefKeysWithValues, extraVisibleMetaDefKeys, locale],
  );
  const [addMetaDefSearch, setAddMetaDefSearch] = useState("");
  const visibleHiddenMetaDefKeys = useMemo(() => {
    const q = addMetaDefSearch.trim().toLowerCase();
    if (!q) return hiddenMetaDefKeys;
    return hiddenMetaDefKeys.filter((k) => {
      const label = resolveMetaDefLabel(metaDefs[k], k, locale).toLowerCase();
      return label.includes(q) || k.toLowerCase().includes(q);
    });
  }, [hiddenMetaDefKeys, addMetaDefSearch, metaDefs, locale]);

  // Must run unconditionally, before the loading-guard's early return below (Rules of Hooks).
  const productFiles = useMemo(() => {
    const f = getMeta(product, "product_files");
    return Array.isArray(f) ? f : [];
  }, [product]);

  if (!product && !isNew) {
    return (
      <Page title="Product">
        <Card><BlockStack gap="300"><SkeletonDisplayText size="small" /><SkeletonBodyText lines={3} /></BlockStack></Card>
      </Page>
    );
  }

  const hasLocaleMedia =
    locale !== "de" &&
    Object.prototype.hasOwnProperty.call((meta.translations || {})[locale] || {}, "media");
  const mediaUrls = (() => {
    if (hasLocaleMedia) return coerceProductMediaList(editingTr.media);
    return coerceProductMediaList(meta.media);
  })();
  const collectionIds = Array.isArray(meta.collection_ids) ? meta.collection_ids : (meta.collection_id != null ? [meta.collection_id] : (product?.collection_id != null ? [product.collection_id] : []));
  const relatedProductIds = Array.isArray(meta.related_product_ids) ? meta.related_product_ids : [];

  const categorySummaryPath = categoryBreadcrumbFromFlatList(categories, getMeta(product, "category_id"));
  const brandIdSummary = getMeta(product, "brand_id");
  const brandSummaryLabel = brandIdSummary
    ? (brands || []).find((b) => String(b.id) === String(brandIdSummary))?.name || ""
    : "";
  const shipIdSummary = meta.shipping_group_id;
  const shipSummaryLabel = shipIdSummary
    ? shippingGroupsList.find((g) => String(g.id) === String(shipIdSummary))?.name || ""
    : "";
  const classificationChips = [];
  if (categorySummaryPath) classificationChips.push({ key: "cat", text: categorySummaryPath });
  if (brandSummaryLabel) classificationChips.push({ key: "brand", text: brandSummaryLabel });
  if (shipSummaryLabel) classificationChips.push({ key: "ship", text: `${locale === "en" ? "Shipping" : locale === "tr" ? "Kargo" : locale === "fr" ? "Expédition" : locale === "es" ? "Envío" : locale === "it" ? "Spedizione" : "Versand"}: ${shipSummaryLabel}` });
  if (isSuperuser && collectionIds.length > 0) {
    classificationChips.push({
      key: "coll",
      text: locale === "en" ? `${collectionIds.length} collection${collectionIds.length !== 1 ? "s" : ""}` : locale === "tr" ? `${collectionIds.length} koleksiyon` : locale === "fr" ? `${collectionIds.length} collection${collectionIds.length !== 1 ? "s" : ""}` : locale === "es" ? `${collectionIds.length} colección${collectionIds.length !== 1 ? "es" : ""}` : locale === "it" ? `${collectionIds.length} collezione${collectionIds.length !== 1 ? "i" : ""}` : `${collectionIds.length} Kollektion${collectionIds.length !== 1 ? "en" : ""}`,
    });
  }

  // ─── Variation Engine ────────────────────────────────────────────────────────

  /** Cartesian product of arrays: [["Red","Black"],["S","M"]] → [["Red","S"],["Red","M"],...] */
  const cartesian = (arrs) => {
    if (!arrs.length) return [[]];
    const [first, ...rest] = arrs;
    const tail = cartesian(rest);
    return (first || []).flatMap((v) => tail.map((r) => [v, ...r]));
  };

  /**
   * Source of truth: metadata.variation_groups, RECONCILED with product.variants[].option_values.
   * Excel imports (and other flows) can add variant rows with option values that were never
   * folded back into metadata.variation_groups, so the two can silently drift apart — e.g. 9
   * distinct colors present across variants but only 1 registered in variation_groups. Any value
   * found in a variant's option_values that isn't already in the matching group is appended here
   * (as a bare, unconfigured option — no swatch/labels, since none exist for it yet) so this list
   * always matches what the Variation Matrix below actually shows. Saving the product persists
   * this reconciled list back to metadata.variation_groups (see handleSubmit), self-healing the
   * drift the next time anyone opens the product.
   */
  const variantGroups = (() => {
    const mg = meta.variation_groups;
    const base = Array.isArray(mg)
      ? mg.map((g) => ({
          name: g.name || "",
          options: (g.options || []).map((opt) => ({
            value: typeof opt === "object" ? String(opt.value ?? "") : String(opt ?? ""),
            swatch_image: typeof opt === "object" ? String(opt.swatch_image ?? opt.swatch_image_url ?? "") : "",
            labels: typeof opt === "object" && opt.labels && typeof opt.labels === "object" ? { ...opt.labels } : {},
          })),
        }))
      : [];
    if (base.length === 0) return base;
    const variantsList = Array.isArray(product?.variants) ? product.variants : [];
    return base.map((group, gIdx) => {
      const seen = new Set(group.options.map((o) => o.value.trim().toLowerCase()).filter(Boolean));
      const extra = [];
      for (const v of variantsList) {
        const ov = Array.isArray(v.option_values) ? v.option_values : [];
        const raw = ov[gIdx];
        if (raw == null || String(raw).trim() === "") continue;
        const key = String(raw).trim().toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        extra.push({ value: String(raw).trim(), swatch_image: "", labels: {} });
      }
      return extra.length ? { ...group, options: [...group.options, ...extra] } : group;
    });
  })();

  const getGroupDisplayName = (gi) => {
    const g = variantGroups[gi];
    if (!g) return "";
    if (String(locale).toLowerCase() === "de") return g.name || "";
    const trLoc = (meta.translations || {})[locale] || {};
    const arr = trLoc.variation_groups;
    if (Array.isArray(arr) && arr[gi]?.name != null && String(arr[gi].name).trim() !== "") {
      return String(arr[gi].name);
    }
    return g.name || "";
  };

  const getOptionInputValue = (opt) => {
    if (!opt) return "";
    const labels = opt.labels && typeof opt.labels === "object" ? opt.labels : {};
    if (Object.prototype.hasOwnProperty.call(labels, locale)) {
      const s = labels[locale];
      if (s != null) return String(s);
    }
    return String(opt.value || "");
  };

  /**
   * Apply new groups config: regenerates variant matrix while preserving existing
   * variant data (sku, ean, stock, prices, image) for unchanged combinations.
   * Atomically writes both metadata.variation_groups and variants.
   */
  const applyVariantGroups = (nextGroups) => {
    const valueArrs = nextGroups.map((g) =>
      (g.options || []).map((o) => String(o.value ?? "").trim()).filter(Boolean)
    );
    const allFilled = valueArrs.length > 0 && valueArrs.every((a) => a.length > 0);
    const combos = allFilled ? cartesian(valueArrs) : [];

    setProduct((prev) => {
      const existing = prev?.variants || [];
      const flat = combos.map((optionValues) => {
        const key = optionValues.join("\u0000");
        const ex = existing.find(
          (v) => Array.isArray(v.option_values) && v.option_values.join("\u0000") === key
        );
        if (ex) return { ...ex, option_values: optionValues };
        return {
          option_values: optionValues,
          title: optionValues.join(" / "),
          value: optionValues.join(" / "),
          sku: "",
          ean: undefined,
          inventory: 0,
          price_cents: undefined,
          compare_at_price_cents: undefined,
          sale_price_cents: undefined,
          image_url: undefined,
        };
      });
      const metaGroups = nextGroups.map((g) => ({
        name: g.name || "Option",
        ...(g.metafield_key ? { metafield_key: g.metafield_key } : {}),
        options: (g.options || []).map((o) => {
          const row = {
            value: String(o.value ?? "").trim(),
            ...(o.swatch_image ? { swatch_image: o.swatch_image } : {}),
          };
          if (o.labels && typeof o.labels === "object" && Object.keys(o.labels).length > 0) {
            row.labels = o.labels;
          }
          return row;
        }),
      }));
      return {
        ...prev,
        variants: flat,
        metadata: {
          ...(prev?.metadata && typeof prev.metadata === "object" ? prev.metadata : {}),
          variation_groups: metaGroups,
        },
      };
    });
  };

  /** Update a single field on one variant in the matrix */
  const updateMatrixVariant = (optionValues, field, value) => {
    const key = Array.isArray(optionValues) ? optionValues.join("\u0000") : "";
    setProduct((prev) => {
      const variants = [...(prev?.variants || [])];
      const idx = variants.findIndex(
        (v) => Array.isArray(v.option_values) && v.option_values.join("\u0000") === key
      );
      if (idx < 0) return prev;
      const v = { ...variants[idx] };
      if (field === "price") {
        const n = parseFloat(value);
        v.price_cents = !isNaN(n) && value !== "" ? Math.round(n * 100) : undefined;
      } else if (field === "compare_at_price") {
        const n = parseFloat(value);
        v.compare_at_price_cents = !isNaN(n) && value !== "" ? Math.round(n * 100) : undefined;
      } else if (field === "sale_price") {
        const n = parseFloat(value);
        v.sale_price_cents = !isNaN(n) && value !== "" ? Math.round(n * 100) : undefined;
      } else if (field === "inventory") {
        v.inventory = value !== "" ? parseInt(String(value), 10) || 0 : 0;
      } else if (field === "image_urls") {
        v.image_urls =
          value && typeof value === "object" && Object.keys(value).length > 0 ? value : undefined;
      } else {
        v[field] = value || undefined;
      }
      variants[idx] = v;
      return { ...prev, variants };
    });
  };

  /** Patch a key inside variant.metadata (for media array etc.) */
  const updateMatrixVariantMeta = (optionValues, metaKey, value) => {
    const key = Array.isArray(optionValues) ? optionValues.join("\u0000") : "";
    setProduct((prev) => {
      const variants = [...(prev?.variants || [])];
      const idx = variants.findIndex(
        (v) => Array.isArray(v.option_values) && v.option_values.join("\u0000") === key
      );
      if (idx < 0) return prev;
      const cur = variants[idx];
      const m = { ...(cur.metadata && typeof cur.metadata === "object" ? cur.metadata : {}) };
      if (value == null || (Array.isArray(value) && value.length === 0)) delete m[metaKey];
      else m[metaKey] = value;
      variants[idx] = { ...cur, metadata: m };
      return { ...prev, variants };
    });
  };

  // Group-level helpers — all go through applyVariantGroups
  const vg_addGroup = () =>
    applyVariantGroups([...variantGroups, { name: "", options: [{ value: "", swatch_image: "", labels: {} }] }]);
  const vg_removeGroup = (gi) =>
    applyVariantGroups(variantGroups.filter((_, i) => i !== gi));
  const vg_setGroupName = (gi, name) => {
    if (String(locale).toLowerCase() === "de") {
      applyVariantGroups(variantGroups.map((g, i) => (i === gi ? { ...g, name } : g)));
      return;
    }
    setProduct((prev) => {
      if (!prev) return prev;
      const m = { ...(prev.metadata && typeof prev.metadata === "object" ? prev.metadata : {}) };
      const tr = { ...(m.translations || {}) };
      const locData = { ...(tr[locale] || {}) };
      const n = variantGroups.length;
      const arr = Array.isArray(locData.variation_groups) ? [...locData.variation_groups] : [];
      while (arr.length < n) arr.push({});
      if (gi >= 0 && gi < n) arr[gi] = { ...arr[gi], name };
      locData.variation_groups = arr;
      tr[locale] = locData;
      m.translations = tr;
      return { ...prev, metadata: m };
    });
  };
  /** Link a group to a catalog Eigenschaft (metafield definition) — name follows the definition's label; "" unlinks back to free text. */
  const vg_setGroupMetaKey = (gi, key) => {
    const def = key ? metaDefs[key] : null;
    const label = def ? resolveMetaDefLabel(def, key, locale) : "";
    applyVariantGroups(variantGroups.map((g, i) =>
      i === gi ? { ...g, metafield_key: key || undefined, name: key ? label : g.name } : g
    ));
  };
  const vg_addOption = (gi) =>
    applyVariantGroups(variantGroups.map((g, i) =>
      i === gi ? { ...g, options: [...(g.options || []), { value: "", swatch_image: "", labels: {} }] } : g
    ));
  const vg_removeOption = (gi, oi) =>
    applyVariantGroups(variantGroups.map((g, i) =>
      i === gi ? { ...g, options: (g.options || []).filter((_, j) => j !== oi) } : g
    ));
  const vg_setOption = (gi, oi, field, value) =>
    applyVariantGroups(variantGroups.map((g, i) => {
      if (i !== gi) return g;
      const opts = [...(g.options || [])];
      if (!opts[oi]) return g;
      opts[oi] = { ...opts[oi], [field]: value };
      return { ...g, options: opts };
    }));
  /**
   * Add a value picked from (or newly proposed for) a linked Eigenschaft to a variant group.
   * Known values are added as a plain option; unknown ones are also submitted as a catalog
   * proposal — superusers get it applied immediately, sellers get a pending review (and the
   * superuser is notified) — while the seller keeps working locally with the value right away.
   */
  const vg_addLinkedOptionValue = (gi, value) => {
    const v = String(value || "").trim();
    if (!v) return;
    const g = variantGroups[gi];
    const key = g?.metafield_key;
    const def = key ? metaDefs[key] : null;
    const known = def && Array.isArray(def.values) ? def.values.includes(v) : true;
    applyVariantGroups(variantGroups.map((gr, i) =>
      i !== gi ? gr : { ...gr, options: [...(gr.options || []).filter((o) => String(o.value || "").trim()), { value: v, swatch_image: "", labels: {} }] }
    ));
    if (key && def && !known) {
      client.submitMetafieldCatalogProposal({ key, label: resolveMetaDefLabel(def, key, locale), values: [v] }).catch(() => {});
    }
  };
  const vg_moveGroup = (from, to) => {
    if (from === to) return;
    const next = [...variantGroups];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    applyVariantGroups(next);
  };

  const handleOptionDisplayChange = (gi, oi, text) => {
    const g = variantGroups[gi];
    if (!g?.options?.[oi]) return;
    const opt = g.options[oi];
    const prevCanonical = String(opt.value || "").trim();
    const labels = { ...(opt.labels || {}) };

    if (!prevCanonical) {
      const t = String(text || "").trim();
      if (!t) {
        const nextLabels = { ...labels };
        delete nextLabels[locale];
        applyVariantGroups(
          variantGroups.map((gr, i) =>
            i !== gi
              ? gr
              : {
                  ...gr,
                  options: gr.options.map((o, j) => (j === oi ? { ...o, labels: nextLabels } : o)),
                }
          )
        );
        return;
      }
      const seeded = { ...labels };
      routing.locales.forEach((loc) => {
        if (seeded[loc] == null || String(seeded[loc]).trim() === "") seeded[loc] = t;
      });
      applyVariantGroups(
        variantGroups.map((gr, i) =>
          i !== gi
            ? gr
            : {
                ...gr,
                options: gr.options.map((o, j) => (j === oi ? { ...o, value: t, labels: seeded } : o)),
              }
        )
      );
      return;
    }

    applyVariantGroups(
      variantGroups.map((gr, i) =>
        i !== gi
          ? gr
          : {
              ...gr,
              options: gr.options.map((o, j) =>
                j === oi ? { ...o, labels: { ...(o.labels || {}), [locale]: text } } : o
              ),
            }
      )
    );
  };

  // ─── Variant image picker ────────────────────────────────────────────────────
  const openVariantImgPicker = (optionValues) => {
    setVariantImgPickerTarget(optionValues);
  };

  const openSwatchPicker = (gi, oi) => {
    setSwatchPickerTarget({ gi, oi });
  };

  const removeMedia = (index) => {
    const next = mediaUrls.filter((_, i) => i !== index);
    if (locale === "de") updateMeta("media", next);
    else updateLocaleField("media", next);
  };

  const handleMediaDragStart = (e, i) => {
    setMediaDragIndex(i);
    e.dataTransfer.effectAllowed = "move";
  };
  const handleMediaDragOver = (e, i) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (mediaDragOverIndex !== i) setMediaDragOverIndex(i);
  };
  const handleMediaDrop = (e, i) => {
    e.preventDefault();
    if (mediaDragIndex === null || mediaDragIndex === i) {
      setMediaDragIndex(null);
      setMediaDragOverIndex(null);
      return;
    }
    const next = [...mediaUrls];
    const [moved] = next.splice(mediaDragIndex, 1);
    next.splice(i, 0, moved);
    if (locale === "de") updateMeta("media", next);
    else updateLocaleField("media", next);
    setMediaDragIndex(null);
    setMediaDragOverIndex(null);
  };
  const handleMediaDragEnd = () => {
    setMediaDragIndex(null);
    setMediaDragOverIndex(null);
  };
  const resolveMediaUrl = (url) => {
    if (!url) return "";
    if (url.startsWith("data:")) return url;
    // Delegate to the shared resolver: rewrites /uploads/ paths from any past
    // backend hostname to the current one, instead of returning old-domain
    // URLs verbatim (this used to just pass http(s) URLs through unchanged).
    return resolveImageUrl(url) || url;
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileUploading(true); setFileUploadErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      const result = await client.uploadMedia(fd, { purpose: "document" });
      if (result?.url) {
        const updated = [...productFiles, { name: "", url: result.url }];
        updateMeta("product_files", updated);
      } else {
        setFileUploadErr(locale === "en" ? "Upload failed." : locale === "tr" ? "Yükleme başarısız." : locale === "fr" ? "Échec du téléchargement." : locale === "es" ? "Error al subir." : locale === "it" ? "Caricamento fallito." : "Upload fehlgeschlagen.");
      }
    } catch (err) {
      setFileUploadErr(err?.message || (locale === "en" ? "Upload failed." : locale === "tr" ? "Yükleme başarısız." : locale === "fr" ? "Échec du téléchargement." : locale === "es" ? "Error al subir." : locale === "it" ? "Caricamento fallito." : "Upload fehlgeschlagen."));
    } finally {
      setFileUploading(false);
      if (e.target) e.target.value = "";
    }
  };

  const handleAddFileUrl = () => {
    const url = newFileUrl.trim();
    if (!url) return;
    const updated = [...productFiles, { name: newFileName.trim(), url }];
    updateMeta("product_files", updated);
    setNewFileUrl(""); setNewFileName(""); setAddingFile(false);
  };

  const removeProductFile = (i) => {
    const updated = productFiles.filter((_, idx) => idx !== i);
    updateMeta("product_files", updated.length ? updated : null);
  };

  const updateProductFileName = (i, name) => {
    const updated = productFiles.map((f, idx) => idx === i ? { ...f, name } : f);
    updateMeta("product_files", updated);
  };

  return (
    <Page title="">
      <style>{`
        .product-edit-header { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--p-color-border); }
        .product-edit-header .product-edit-title-link { display: inline-flex; align-items: center; gap: 8px; text-decoration: none; color: var(--p-color-text); font-size: 0.875rem; }
        .product-edit-header .product-edit-title-link:hover { color: var(--p-color-text); }
        .product-edit-header .product-edit-name { margin: 0; font-size: 1.125rem; font-weight: 700; letter-spacing: -0.02em; }
        ${PRODUCT_SECTION_STYLES}
        .product-edit-label { font-size: 0.8125rem; font-weight: 500; color: var(--p-color-text); margin-bottom: 6px; }
        .product-edit-price-grid { display: grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap: 16px; align-items: start; }
        @media (max-width: 780px) { .product-edit-price-grid { grid-template-columns: 1fr; } }
        .product-edit-main-stack { width: 100%; }
        .product-edit-sidebar { display: flex; flex-direction: column; gap: 16px; }
        .variations-fullwidth { width: 100%; }
        .product-price-strike { text-decoration: line-through; color: var(--p-color-text-subdued); }
        .product-media-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); gap: 12px; max-width: 400px; }
        .product-media-item { aspect-ratio: 1; border-radius: 8px; overflow: hidden; background: var(--p-color-bg-fill-secondary); position: relative; cursor: grab; border: 2px solid transparent; transition: border-color 0.15s, opacity 0.15s, box-shadow 0.15s; }
        .product-media-item:active { cursor: grabbing; }
        .product-media-item.dragging { opacity: 0.35; }
        .product-media-item.drag-over { border-color: var(--p-color-border-info, #2c6ecb); box-shadow: 0 0 0 2px rgba(44,110,203,0.2); }
        .product-media-item img { width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none; }
        .product-media-drag-hint { position: absolute; bottom: 4px; left: 50%; transform: translateX(-50%); font-size: 11px; color: rgba(255,255,255,0.9); background: rgba(0,0,0,0.45); border-radius: 4px; padding: 1px 5px; opacity: 0; transition: opacity 0.2s; pointer-events: none; white-space: nowrap; }
        .product-media-item:hover .product-media-drag-hint { opacity: 1; }
        .product-media-remove { position: absolute; top: 4px; right: 4px; width: 24px; height: 24px; border: none; border-radius: 50%; background: rgba(0,0,0,0.5); color: #fff; font-size: 14px; line-height: 1; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.2s; padding: 0; }
        .product-media-item:hover .product-media-remove { opacity: 1; }
        .product-media-remove:hover { background: rgba(0,0,0,0.75); }
        .product-media-add { aspect-ratio: 1; border-radius: 8px; border: 2px dashed var(--p-color-border); background: var(--p-color-bg-fill-secondary); display: flex; align-items: center; justify-content: center; cursor: pointer; color: var(--p-color-icon); transition: border-color 0.2s, background 0.2s; }
        .product-media-add:hover { border-color: var(--p-color-border-hover); background: var(--p-color-bg-fill-secondary-hover, rgba(0,0,0,0.03)); }
        .product-media-add svg { width: 24px; height: 24px; }
        @media (max-width: 480px) { .product-media-grid { grid-template-columns: repeat(3, 1fr); max-width: none; } }
        .product-media-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 16px; max-height: 480px; overflow-y: auto; padding: 4px 0; }
        .product-media-picker-add { aspect-ratio: 1; border-radius: 12px; border: 2px dashed var(--p-color-border); background: var(--p-color-bg-fill-secondary); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; cursor: pointer; color: var(--p-color-icon); transition: border-color 0.2s, background 0.2s; min-height: 140px; }
        .product-media-picker-add:hover { border-color: var(--p-color-border-hover); background: var(--p-color-bg-fill-secondary-hover, rgba(0,0,0,0.03)); }
        .product-media-picker-add svg { width: 32px; height: 32px; }
        .product-media-picker-add-label { font-size: 12px; font-weight: 500; color: var(--p-color-text-subdued); }
        .product-media-picker-item { position: relative; aspect-ratio: 1; border-radius: 12px; overflow: hidden; background: var(--p-color-bg-surface-secondary); border: 2px solid transparent; cursor: pointer; padding: 0; transition: border-color 0.2s, box-shadow 0.2s; min-height: 140px; }
        .product-media-picker-item:hover { border-color: var(--p-color-border-hover); box-shadow: 0 2px 8px rgba(0,0,0,0.08); }
        .product-media-picker-item.selected { border-color: var(--p-color-border-info); box-shadow: 0 0 0 2px var(--p-color-bg-fill-info); }
        .product-media-picker-item-img { width: 100%; height: 100%; display: block; }
        .product-media-picker-item-img .Polaris-Thumbnail { width: 100%; height: 100%; }
        .product-media-picker-item-img .Polaris-Thumbnail__Image { width: 100%; height: 100%; object-fit: cover; }
        .product-media-picker-tick { position: absolute; top: 8px; right: 8px; width: 28px; height: 28px; border-radius: 50%; background: var(--p-color-bg-fill-brand); color: #fff; display: inline-flex; align-items: center; justify-content: center; pointer-events: none; }
        .product-media-picker-tick svg { width: 16px; height: 16px; }
        .collection-dropdown-wrap { position: relative; }
        .collection-dropdown-item { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; border: none; background: none; width: 100%; text-align: left; font-size: 14px; color: var(--p-color-text); }
        .collection-dropdown-item:hover { background: var(--p-color-bg-surface-hover); }
        .product-description-box { border: 1px solid var(--p-color-border); border-radius: 12px; overflow: hidden; background: var(--p-color-bg-surface); }
        .product-description-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 12px; background: var(--p-color-bg-surface-secondary); border-bottom: 1px solid var(--p-color-border); }
        .product-description-toolbar-left { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; }
        .product-description-toolbar .product-desc-btn { width: 32px; height: 32px; padding: 0; border: none; border-radius: 6px; cursor: pointer; background: transparent; color: var(--p-color-text-subdued); transition: background 0.15s, color 0.15s; display: inline-flex; align-items: center; justify-content: center; }
        .product-description-toolbar .product-desc-btn:hover { background: var(--p-color-bg-surface-hover); color: var(--p-color-text); }
        .product-description-toolbar .product-desc-btn svg { width: 16px; height: 16px; }
        .product-description-toolbar .product-desc-divider { width: 1px; height: 20px; background: var(--p-color-border); margin: 0 4px; flex-shrink: 0; }
        .product-description-toolbar .product-desc-html-btn { width: 32px; height: 32px; padding: 0; border: none; border-radius: 6px; cursor: pointer; background: transparent; color: var(--p-color-text-subdued); transition: background 0.15s, color 0.15s; display: inline-flex; align-items: center; justify-content: center; }
        .product-description-toolbar .product-desc-html-btn:hover { background: var(--p-color-bg-surface-hover); color: var(--p-color-text); }
        .product-description-toolbar .product-desc-html-btn.active { background: var(--p-color-bg-surface-selected); color: var(--p-color-text); }
        .product-description-toolbar .product-desc-html-btn svg { width: 16px; height: 16px; }
        .product-description-editor { min-height: 200px; padding: 16px; outline: none; font-size: 14px; line-height: 1.6; color: var(--p-color-text); }
        .product-description-editor h1 { font-size: 1.75rem; font-weight: 700; margin: 0.75em 0 0.35em; line-height: 1.3; }
        .product-description-editor h2 { font-size: 1.5rem; font-weight: 700; margin: 0.75em 0 0.35em; line-height: 1.3; }
        .product-description-editor h3 { font-size: 1.25rem; font-weight: 600; margin: 0.6em 0 0.3em; line-height: 1.35; }
        .product-description-editor h4, .product-description-editor h5, .product-description-editor h6 { font-size: 1.1rem; font-weight: 600; margin: 0.5em 0 0.25em; line-height: 1.4; }
        .product-description-editor h1:first-child, .product-description-editor h2:first-child, .product-description-editor h3:first-child { margin-top: 0; }
        .product-description-editor p { margin: 0 0 0.6em; }
        .product-description-editor p:last-child { margin-bottom: 0; }
        .product-description-editor ul, .product-description-editor ol { margin: 0.4em 0 0.8em 1.5em; padding-left: 1.5em; }
        .product-description-editor ul { list-style-type: disc; }
        .product-description-editor ol { list-style-type: decimal; }
        .product-description-editor li { margin-bottom: 0.25em; }
        .product-description-editor strong { font-weight: 600; }
        .product-description-editor blockquote { margin: 0.75em 0; padding-left: 1em; border-left: 4px solid var(--p-color-border); color: var(--p-color-text-subdued); }
        .product-description-html { min-height: 200px; width: 100%; padding: 16px; font-family: ui-monospace, "SF Mono", Monaco, monospace; font-size: 13px; line-height: 1.5; color: var(--p-color-text); background: var(--p-color-bg-surface-secondary); border: none; border-radius: 0; resize: vertical; box-sizing: border-box; }
        .product-description-html:focus { outline: none; }
        .product-description-html::placeholder { color: var(--p-color-text-subdued); }
        .product-description-hint { margin-top: 8px; font-size: 12px; color: var(--p-color-text-subdued); }
        /* ── Variation engine — Groups ── */
        .vg-group { border: 1px solid var(--p-color-border); border-radius: 12px; padding: 0; background: var(--p-color-bg-surface); overflow: hidden; transition: box-shadow 0.15s; }
        .vg-group:hover { box-shadow: 0 2px 10px rgba(0,0,0,0.07); }
        .vg-group[draggable]:active { cursor: grabbing; box-shadow: 0 8px 28px rgba(0,0,0,0.13); opacity: 0.92; }
        .vg-group-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; background: var(--p-color-bg-surface-secondary); border-bottom: 1px solid var(--p-color-border-subdued); }
        .vg-group-body { padding: 14px 16px; }
        .vg-group-num { width: 22px; height: 22px; border-radius: 50%; background: var(--p-color-bg-fill-brand); color: #fff; font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .vg-drag-handle { color: var(--p-color-icon-subdued); font-size: 18px; cursor: grab; user-select: none; flex-shrink: 0; padding: 2px 4px; border-radius: 4px; }
        .vg-drag-handle:hover { background: var(--p-color-bg-surface-hover); color: var(--p-color-icon); }
        .vg-option-chip { display: inline-flex; align-items: center; gap: 5px; background: var(--p-color-bg-surface-secondary); border: 1.5px solid var(--p-color-border); border-radius: 30px; padding: 4px 4px 4px 10px; transition: border-color .12s; }
        .vg-option-chip:focus-within { border-color: var(--p-color-border-focus, #005bd3); box-shadow: 0 0 0 2px rgba(0,91,211,.12); }
        .vg-option-chip input { border: none; outline: none; background: transparent; font-size: 13px; color: var(--p-color-text); min-width: 64px; width: 90px; }
        .vg-option-chip input::placeholder { color: var(--p-color-text-subdued); }
        .vg-remove-btn { border: none; background: none; cursor: pointer; color: var(--p-color-icon-subdued); font-size: 15px; line-height: 1; padding: 2px 5px; border-radius: 50%; display: inline-flex; align-items: center; }
        .vg-remove-btn:hover { color: var(--p-color-text-critical); background: var(--p-color-bg-fill-critical-secondary, rgba(222,54,24,0.08)); }
        .vg-swatch { width: 26px; height: 26px; border-radius: 50%; overflow: hidden; flex-shrink: 0; border: 1.5px solid var(--p-color-border); cursor: pointer; padding: 0; background: none; appearance: none; display: block; }
        .vg-swatch:hover { border-color: var(--p-color-border-hover); box-shadow: 0 0 0 3px rgba(0,113,227,0.12); }
        .vg-swatch-empty { width: 26px; height: 26px; border-radius: 50%; flex-shrink: 0; border: 1.5px dashed var(--p-color-border); display: inline-flex; align-items: center; justify-content: center; color: var(--p-color-icon-subdued); font-size: 11px; cursor: pointer; padding: 0; background: none; appearance: none; }
        .vg-swatch-empty:hover { border-color: var(--p-color-border-info); background: rgba(0,113,227,0.04); }
        /* ── Variation engine — Matrix rows (always expanded, full-width) ── */
        .vm-card { border: 1px solid var(--p-color-border); border-radius: 10px; margin-bottom: 10px; background: var(--p-color-bg-surface-secondary, #f6f6f7); overflow: hidden; }
        .vm-card:last-child { margin-bottom: 0; }
        .vm-row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 14px 18px; padding: 14px 16px; }
        .vm-row-main { display: flex; align-items: flex-start; gap: 12px; flex: 1 1 220px; min-width: 180px; }
        .vm-thumb { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; border: 1px solid var(--p-color-border); display: block; flex-shrink: 0; }
        .vm-thumb-empty { width: 48px; height: 48px; border-radius: 8px; border: 1.5px dashed var(--p-color-border); background: #fff; display: flex; align-items: center; justify-content: center; color: var(--p-color-icon-subdued); font-size: 16px; flex-shrink: 0; }
        .vm-badge { display: inline-flex; align-items: center; gap: 5px; background: #fff; border: 1px solid var(--p-color-border); border-radius: 20px; padding: 2px 10px; font-size: 12px; font-weight: 500; color: var(--p-color-text); white-space: nowrap; }
        .vm-field-group { flex: 1 1 200px; min-width: 160px; }
        .vm-field-group.vm-prices { flex: 1 1 280px; }
        .vm-field-group.vm-images { flex: 1 1 220px; }
        .vm-sub-label { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .07em; color: var(--p-color-text-subdued); margin-bottom: 8px; }
        .vm-grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
        .vm-img-strip { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        .vm-img-item { position: relative; width: 56px; height: 56px; flex-shrink: 0; }
        .vm-img-item img { width: 56px; height: 56px; object-fit: cover; border-radius: 8px; border: 1px solid var(--p-color-border); display: block; }
        .vm-img-del { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; border-radius: 50%; border: none; background: rgba(0,0,0,.55); color: #fff; font-size: 11px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
        .vm-img-del:hover { background: rgba(200,0,0,.8); }
        .vm-img-add { width: 56px; height: 56px; border-radius: 8px; border: 2px dashed var(--p-color-border); background: #fff; cursor: pointer; font-size: 20px; color: var(--p-color-text-subdued); display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: border-color .12s, color .12s; }
        .vm-img-add:hover { border-color: var(--p-color-border-hover); color: var(--p-color-text); }
        .vm-edit-btn { flex-shrink: 0; align-self: center; }
        .variations-fullwidth { width: 100%; }
        .variations-fullwidth .Polaris-ShadowBevel { width: 100%; }
        @media (max-width: 900px) {
          .vm-grid-3 { grid-template-columns: 1fr; }
        }
        .checkbox-container { cursor: pointer; flex-shrink: 0; }
        .checkbox-container input { display: none; }
        .checkbox-container svg { overflow: visible; display: block; }
        .checkbox-path { fill: none; stroke: var(--p-color-border); stroke-width: 6; stroke-linecap: round; stroke-linejoin: round; transition: stroke-dasharray 0.35s ease, stroke-dashoffset 0.35s ease, stroke 0.2s; stroke-dasharray: 241 9999999; stroke-dashoffset: 0; }
        .checkbox-container input:checked ~ svg .checkbox-path { stroke: var(--p-color-bg-fill-brand); stroke-dasharray: 70.5 9999999; stroke-dashoffset: -262.27; }
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

      {showSharedCatalogNotice && (
        <Box paddingBlockEnd="200">
          <Banner tone="info">
            {sharedCatalogNoticeMsg}
          </Banner>
        </Box>
      )}

      {!isSuperuser && (meta._catalog_approval_pending || (Array.isArray(meta._pending_catalog_metafields) && meta._pending_catalog_metafields.length > 0)) && (
        <Box paddingBlockEnd="200">
          <Banner tone="warning">
            {locale === "en"
              ? "This product uses Eigenschaften or variation values waiting for superuser approval. It will not appear in the shop until they are approved (Content → Metaobjects)."
              : locale === "tr"
                ? "Bu ürün, superuser onayı bekleyen Eigenschaften veya varyasyon değerleri kullanıyor. Onaylanana kadar shop’ta görünmez (İçerik → Metaobjects)."
                : locale === "fr"
                  ? "Ce produit utilise des Eigenschaften ou des valeurs de variante en attente d'approbation superuser. Il restera masqué en boutique jusqu'à approbation (Contenu → Metaobjects)."
                  : locale === "es"
                    ? "Este producto usa Eigenschaften o valores de variante pendientes de aprobación. No aparecerá en la tienda hasta que se aprueben (Contenido → Metaobjetos)."
                    : locale === "it"
                      ? "Questo prodotto usa Eigenschaften o valori variante in attesa di approvazione. Resta nascosto nello shop fino all'approvazione (Contenuto → Metaoggetti)."
                      : "Dieses Produkt verwendet Eigenschaften- oder Variantenwerte, die auf Superuser-Freigabe warten. Es erscheint erst im Shop, wenn sie unter Content → Metaobjects freigegeben sind."}
          </Banner>
        </Box>
      )}

      {!isNew && pendingChangeRequests.length > 0 && (
        <Box paddingBlockEnd="200">
          <Banner tone="warning">
            <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
              <Text as="p" variant="bodySm">
                {locale === "tr"
                  ? `Değişiklik önerisi var (${pendingChangeRequests.length} alan).`
                  : locale === "fr"
                    ? `Modifications proposées (${pendingChangeRequests.length} champs).`
                    : locale === "es"
                      ? `Cambios propuestos (${pendingChangeRequests.length} campos).`
                      : locale === "it"
                        ? `Modifiche proposte (${pendingChangeRequests.length} campi).`
                        : locale === "de"
                          ? `Änderungsvorschläge vorhanden (${pendingChangeRequests.length} Felder).`
                          : `Pending change suggestions (${pendingChangeRequests.length} fields).`}
              </Text>
              {isSuperuser && (
                <Button size="slim" onClick={() => setChangeRequestsModalOpen(true)}>
                  {locale === "tr" ? "Değişiklik önerisi var" : locale === "fr" ? "Voir les modifications" : locale === "es" ? "Ver cambios" : locale === "it" ? "Vedi modifiche" : locale === "de" ? "Änderungen ansehen" : "Review changes"}
                </Button>
              )}
            </InlineStack>
          </Banner>
        </Box>
      )}

      {isSuperuser && (
        <Modal
          open={changeRequestsModalOpen}
          onClose={() => setChangeRequestsModalOpen(false)}
          title={locale === "tr" ? "Onay bekleyen alan değişiklikleri" : locale === "fr" ? "Modifications de champ en attente" : locale === "es" ? "Cambios de campo pendientes" : locale === "it" ? "Modifiche di campo in sospeso" : locale === "de" ? "Ausstehende Feldänderungen" : "Pending field changes"}
          size="large"
        >
          <Modal.Section>
            <BlockStack gap="400">
              {pendingChangeRequests.map((cr, idx) => {
                const busy = changeRequestActionId === String(cr.id);
                return (
                  <React.Fragment key={cr.id}>
                    {idx > 0 && <Divider />}
                    <BlockStack gap="200">
                      <InlineStack gap="300" align="space-between" blockAlign="center" wrap>
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          {fieldNameDisplayLabel(cr.field_name, locale)}
                        </Text>
                        <Text as="p" variant="bodyXs" tone="subdued">
                          {`${locale === "tr" ? "Satıcı" : locale === "fr" ? "Vendeur" : locale === "es" ? "Vendedor" : locale === "it" ? "Venditore" : locale === "de" ? "Verkäufer" : "Seller"}: ${changeRequestSellerLabel(cr)}`}
                        </Text>
                      </InlineStack>
                      <InlineStack gap="400" wrap align="start">
                        <Box minWidth="240px" maxWidth="480px">
                          <BlockStack gap="100">
                            <Text as="p" variant="bodyXs" tone="subdued">
                              {locale === "tr" ? "Mevcut değer" : locale === "fr" ? "Valeur actuelle" : locale === "es" ? "Valor actual" : locale === "it" ? "Valore attuale" : locale === "de" ? "Aktueller Wert" : "Current value"}
                            </Text>
                            <div style={{ fontSize: 13, lineHeight: 1.45, wordBreak: "break-word", whiteSpace: "pre-wrap" }}>
                              {formatChangeRequestValueForDisplay(cr.old_value)}
                            </div>
                          </BlockStack>
                        </Box>
                        <Box minWidth="240px" maxWidth="480px">
                          <BlockStack gap="100">
                            <Text as="p" variant="bodyXs" tone="subdued">
                              {locale === "tr" ? "Önerilen değer" : locale === "fr" ? "Valeur proposée" : locale === "es" ? "Valor propuesto" : locale === "it" ? "Valore proposto" : locale === "de" ? "Vorgeschlagener Wert" : "Proposed value"}
                            </Text>
                            <div style={{ fontSize: 13, lineHeight: 1.45, wordBreak: "break-word", whiteSpace: "pre-wrap", fontWeight: 600 }}>
                              {formatChangeRequestValueForDisplay(cr.new_value)}
                            </div>
                          </BlockStack>
                        </Box>
                      </InlineStack>
                      <InlineStack gap="200">
                        <Button size="slim" tone="success" onClick={() => approveChangeRequest(cr.id)} loading={busy} disabled={busy}>
                          {locale === "tr" ? "Onayla" : locale === "fr" ? "Approuver" : locale === "es" ? "Aprobar" : locale === "it" ? "Approva" : locale === "de" ? "Freigeben" : "Approve"}
                        </Button>
                        <Button size="slim" onClick={() => editAndApproveChangeRequest(cr)} disabled={busy}>
                          {locale === "tr" ? "Düzelt + Onayla" : locale === "fr" ? "Modifier + Approuver" : locale === "es" ? "Editar + Aprobar" : locale === "it" ? "Modifica + Approva" : locale === "de" ? "Bearbeiten + Freigeben" : "Edit + Approve"}
                        </Button>
                        <Button size="slim" tone="critical" variant="secondary" onClick={() => rejectChangeRequest(cr.id)} loading={busy} disabled={busy}>
                          {locale === "tr" ? "Reddet" : locale === "fr" ? "Rejeter" : locale === "es" ? "Rechazar" : locale === "it" ? "Rifiuta" : locale === "de" ? "Ablehnen" : "Reject"}
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </React.Fragment>
                );
              })}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}

      {!isNew && isSuperuser && sellerListings.length > 0 && (
        <Box paddingBlockEnd="200">
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="bodyMd" fontWeight="semibold">
                {locale === "en" ? "Sellers listing this product" : locale === "tr" ? "Bu ürünü listeleyen satıcılar" : locale === "fr" ? "Vendeurs listant ce produit" : locale === "es" ? "Vendedores que listan este producto" : locale === "it" ? "Venditori che elencano questo prodotto" : "Anbieter die dieses Produkt listen"}
              </Text>
              <Divider />
              {sellerListings.map((sl) => (
                <InlineStack key={sl.id} gap="400" blockAlign="center" wrap>
                  <Text as="span" variant="bodySm" fontWeight="semibold">
                    {sl.shop_name || sl.email || sl.seller_id}
                  </Text>
                  {sl.email && sl.shop_name && (
                    <Text as="span" variant="bodyXs" tone="subdued">{sl.email}</Text>
                  )}
                  <Text as="span" variant="bodyXs" tone="subdued">
                    {sl.price_cents != null ? `${(sl.price_cents / 100).toFixed(2)} €` : "—"}
                  </Text>
                  <Text as="span" variant="bodyXs" tone="subdued">
                    {`${locale === "en" ? "Stock" : locale === "tr" ? "Stok" : locale === "fr" ? "Stock" : locale === "es" ? "Stock" : locale === "it" ? "Stock" : "Bestand"}: ${sl.inventory ?? 0}`}
                  </Text>
                  <Text as="span" variant="bodyXs" tone={sl.status === "active" ? "success" : "subdued"}>
                    {sl.status ?? "—"}
                  </Text>
                </InlineStack>
              ))}
            </BlockStack>
          </Card>
        </Box>
      )}

      <div className="product-edit-header">
        <Link href="/products/inventory" className="product-edit-title-link" style={{ marginRight: 4 }}>
          <span style={{ display: "flex", alignItems: "center", width: 20, height: 20 }}><ProductIcon /></span>
          <span className="product-edit-name">{isNew ? pe.newProduct : (product?.title || pe.productFallback)}</span>
        </Link>
        <span style={{ flex: 1 }} />
        {!isNew && (
          <>
            {shopProductHandleForLocale(product, locale) && (
              <a
                href={`${shopBaseUrl}${shopPreviewPrefix(locale)}/${encodeURIComponent(shopProductHandleForLocale(product, locale))}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ textDecoration: "none" }}
              >
                <Button size="slim" icon={ViewIcon}>
                  {pe.viewInShop}
                </Button>
              </a>
            )}
            <Button size="slim" variant="primary" onClick={save} loading={saving}>
              {ui.save}
            </Button>
            <Popover
              active={moreActionsOpen}
              onClose={() => setMoreActionsOpen(false)}
              preferredPosition="below"
              activator={
                <Button
                  size="slim"
                  icon={MenuHorizontalIcon}
                  onClick={() => setMoreActionsOpen((v) => !v)}
                  accessibilityLabel={pe.moreActions}
                  style={{ background: "#1f2937", color: "#fff", border: "none" }}
                >
                  {pe.moreActions}
                </Button>
              }
              autofocusTarget="first-node"
            >
              <ActionList
                items={[
                  { content: ui.duplicate, onAction: () => { setMoreActionsOpen(false); openDuplicateModal(); } },
                  { content: ui.delete, destructive: true, onAction: () => { setMoreActionsOpen(false); setDeleteConfirmOpen(true); } },
                ]}
              />
            </Popover>
          </>
        )}
      </div>

      <Box paddingBlockEnd="300">
        <Tabs
          tabs={[
            { id: "allgemein", content: pe.tabGeneral },
            { id: "spezifikationen", content: pe.tabSpecs },
            { id: "variante", content: pe.tabVariants },
            { id: "rechtlich", content: pe.tabLegal },
          ]}
          selected={activeTabIndex}
          onSelect={setActiveTabIndex}
        />
      </Box>

      {activeTabIndex === 0 && (
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="500">
              <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                <ProductSectionHeading badge={<ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="title" />}>
                  {pe.title}
                </ProductSectionHeading>
                <Box minWidth="160px">
                  <Select label={pe.status} labelHidden options={statusOptionsFor(locale)} value={product.status || "draft"} onChange={(v) => update({ status: v })} />
                </Box>
              </InlineStack>
              <TextField label="Title" labelHidden value={editingTitle} onChange={(v) => updateLocaleField("title", v)} placeholder="e.g. Cotton T-Shirt" autoComplete="off" helpText={pe.titleHelp} />

              <ProductSectionRule />
              <InlineStack gap="300" wrap>
                <Box minWidth="240px" flex="1">
                  <TextField label="SKU" value={product.sku || ""} onChange={(v) => update({ sku: v })} placeholder="SKU" autoComplete="off" />
                </Box>
                <Box minWidth="240px" flex="1">
                  <TextField
                    label={
                      <InlineStack gap="200" blockAlign="center" wrap={false}>
                        <span>EAN</span>
                        <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="metadata.ean" />
                      </InlineStack>
                    }
                    value={getMeta(product, "ean")}
                    onChange={isSecondSeller ? undefined : (v) => { updateMeta("ean", v); setEanLookupState(null); }}
                    onBlur={isSecondSeller ? undefined : handleEanBlur}
                    placeholder="EAN / Barcode"
                    autoComplete="off"
                    disabled={isSecondSeller}
                    suffix={
                      isSecondSeller ? "🔒" :
                      eanLookupState === "loading" ? "⏳" :
                      eanLookupState === "found" ? (locale === "en" ? "✓ Product data loaded" : locale === "tr" ? "✓ Ürün verileri yüklendi" : locale === "fr" ? "✓ Données produit chargées" : locale === "es" ? "✓ Datos del producto cargados" : locale === "it" ? "✓ Dati prodotto caricati" : "✓ Produktdaten geladen") :
                      eanLookupState === "not_found" ? (locale === "en" ? "— New" : locale === "tr" ? "— Yeni" : locale === "fr" ? "— Nouveau" : locale === "es" ? "— Nuevo" : locale === "it" ? "— Nuovo" : "— Neu") : undefined
                    }
                  />
                </Box>
              </InlineStack>

              {eanLookupState === "found" && (
                <Banner tone="warning">
                  {eanMatchedOn === "variant"
                    ? (locale === "tr"
                        ? "Bu EAN, katalogdaki bir üst ürünün varyasyonuna ait. Form yüklendi — kendi fiyatını, SKU'nu ve kargo bilgilerini ekle. Ürün adı/açıklama gibi ortak alanları doğrudan değiştiremezsin; kaydettiğinde değişiklik talebi ekibimize iletilir."
                        : locale === "de"
                        ? "Diese EAN gehört zu einer Variante eines Katalogprodukts. Formular geladen — füge deinen eigenen Preis, SKU und Versand hinzu. Gemeinsame Felder (Titel/Beschreibung) kannst du nicht direkt ändern; beim Speichern geht ein Änderungsantrag an unser Team."
                        : "This EAN belongs to a catalog product variant. Form loaded — add your own price, SKU, and shipping. You cannot directly change shared fields (title/description); saving sends a change request to our team.")
                    : (locale === "tr"
                        ? "Bu EAN katalogda zaten kayıtlı. Form katalog verileriyle dolduruldu — kendi fiyatını, SKU'nu ve kargo bilgilerini ekle. Ürün adı, açıklama ve diğer ortak alanlar doğrudan değişmez; kaydettiğinde değişiklik talebi ekibimize iletilir ve incelenir."
                        : locale === "de"
                        ? "Diese EAN ist bereits im Katalog. Formular vorausgefüllt — füge deinen eigenen Preis, SKU und Versand hinzu. Titel, Beschreibung und andere gemeinsame Felder ändern sich nicht direkt; beim Speichern wird ein Änderungsantrag an unser Team gesendet."
                        : "This EAN is already in the catalog. Form pre-filled — add your own price, SKU, and shipping. Title, description, and other shared fields cannot be changed directly; saving sends a change request to our team for review.")}
                </Banner>
              )}

              {Number(meta.master_total_variants || 0) > 1 && meta.master_product_id && (
                <Banner tone="info">
                  <InlineStack gap="300" blockAlign="center" align="space-between" wrap>
                    <Text as="p" variant="bodySm">
                      {locale === "tr"
                        ? `Bu ürünün kataloğda ${meta.master_total_variants} varyasyonu var. Sadece bu tekini ekledin.`
                        : locale === "de"
                        ? `Dieses Produkt hat ${meta.master_total_variants} Varianten im Katalog. Du hast nur diese eine hinzugefügt.`
                        : `This product has ${meta.master_total_variants} variants in the catalog. You've added only this one.`}
                    </Text>
                    <Button
                      size="slim"
                      onClick={() => window.open(`/products/add-existing?product_id=${encodeURIComponent(meta.master_product_id)}`, "_blank", "noopener,noreferrer")}
                    >
                      {locale === "tr" ? "Diğer varyasyonları gör" : locale === "de" ? "Andere Varianten ansehen" : "See other variations"}
                    </Button>
                  </InlineStack>
                </Banner>
              )}

              <ProductSectionRule />

              <Box padding="400" background="bg-surface-secondary" borderRadius="300" borderWidth="025" borderColor="border">
                <BlockStack gap="300">
                  <BlockStack gap="150">
                    <ProductSectionHeading>{locale === "en" ? "Shop assignment" : locale === "tr" ? "Mağaza ataması" : locale === "fr" ? "Attribution boutique" : locale === "es" ? "Asignación de tienda" : locale === "it" ? "Assegnazione negozio" : "Shop-Zuordnung"}</ProductSectionHeading>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {locale === "en" ? `Category, brand, shipping group${isSuperuser ? " and collections" : ""} — control catalog and shop navigation.` : locale === "tr" ? `Kategori, marka, kargo grubu${isSuperuser ? " ve koleksiyonlar" : ""} — katalog ve mağaza navigasyonunu yönetir.` : locale === "fr" ? `Catégorie, marque, groupe d'expédition${isSuperuser ? " et collections" : ""} — gèrent le catalogue et la navigation boutique.` : locale === "es" ? `Categoría, marca, grupo de envío${isSuperuser ? " y colecciones" : ""} — controlan el catálogo y la navegación de la tienda.` : locale === "it" ? `Categoria, marca, gruppo di spedizione${isSuperuser ? " e collezioni" : ""} — gestiscono il catalogo e la navigazione del negozio.` : `Kategorie, Marke, Versandgruppe${isSuperuser ? " und Kollektionen" : ""} — steuern Katalog und Shop-Navigation.`}
                    </Text>
                  </BlockStack>

                  <div>
                    <BlockStack gap="400">
                      <Divider />
                      {variantGroups.length > 0 ? (
                        <Banner tone="info">
                          {locale === "en" ? "This product has variations — category, brand and shipping group are now set per variant (each variant is its own product). Open a variant below to edit them." : locale === "tr" ? "Bu ürünün varyasyonları var — kategori, marka ve kargo grubu artık varyant başına ayarlanıyor (her varyant kendi ürünüdür). Düzenlemek için aşağıdan bir varyant açın." : locale === "fr" ? "Ce produit a des variations — catégorie, marque et groupe d'expédition sont désormais définis par variante (chaque variante est son propre produit). Ouvrez une variante ci-dessous pour les modifier." : locale === "es" ? "Este producto tiene variaciones — categoría, marca y grupo de envío ahora se definen por variante (cada variante es su propio producto). Abre una variante abajo para editarlos." : locale === "it" ? "Questo prodotto ha variazioni — categoria, marca e gruppo di spedizione sono ora impostati per variante (ogni variante è un proprio prodotto). Apri una variante qui sotto per modificarli." : "Dieses Produkt hat Variationen — Kategorie, Marke und Versandgruppe werden jetzt pro Variante gesetzt (jede Variante ist ihr eigenes Produkt). Öffne unten eine Variante, um sie zu bearbeiten."}
                        </Banner>
                      ) : (
                      <InlineStack gap="500" wrap>
                        <Box minWidth="240px" flex="1">
                          <Text as="p" variant="bodySm" fontWeight="semibold">{locale === "en" ? "Category" : locale === "tr" ? "Kategori" : locale === "fr" ? "Catégorie" : locale === "es" ? "Categoría" : locale === "it" ? "Categoria" : "Kategorie"}</Text>
                          <Box paddingBlockStart="150">
                            <CategoryDrilldownSelect
                              label={locale === "en" ? "Category" : locale === "tr" ? "Kategori" : locale === "fr" ? "Catégorie" : locale === "es" ? "Categoría" : locale === "it" ? "Categoria" : "Kategorie"}
                              labelHidden
                              categories={categories || []}
                              value={getMeta(product, "category_id")}
                              onChange={updateCategoryWithParents}
                              placeholder={locale === "en" ? "Select category" : locale === "tr" ? "Kategori seç" : locale === "fr" ? "Choisir une catégorie" : locale === "es" ? "Seleccionar categoría" : locale === "it" ? "Seleziona categoria" : "Kategorie wählen"}
                              disabled={categoryLocked}
                            />
                          </Box>
                          {categoryLocked && (
                            <Box paddingBlockStart="100">
                              <Text as="p" variant="bodySm" tone="subdued">
                                {locale === "en" ? "The category can't be changed after the product has been created (it determines which legal fields apply)." : locale === "tr" ? "Ürün oluşturulduktan sonra kategori değiştirilemez (hangi yasal alanların uygulanacağını belirler)." : locale === "fr" ? "La catégorie ne peut plus être modifiée une fois le produit créé (elle détermine les champs légaux applicables)." : locale === "es" ? "La categoría no se puede cambiar después de crear el producto (determina los campos legales aplicables)." : locale === "it" ? "La categoria non può essere modificata dopo la creazione del prodotto (determina i campi legali applicabili)." : "Die Kategorie kann nach dem Anlegen des Produkts nicht mehr geändert werden (sie bestimmt, welche rechtlichen Felder gelten)."}
                              </Text>
                            </Box>
                          )}
                        </Box>
                        <Box minWidth="240px" flex="1">
                          <Select
                            label={locale === "en" ? "Brand" : locale === "tr" ? "Marka" : locale === "fr" ? "Marque" : locale === "es" ? "Marca" : locale === "it" ? "Marca" : "Marke"}
                            options={[
                              { label: locale === "en" ? "— None —" : locale === "tr" ? "— Yok —" : locale === "fr" ? "— Aucune —" : locale === "es" ? "— Ninguna —" : locale === "it" ? "— Nessuna —" : "— Keine —", value: "" },
                              ...(brands || [])
                                .filter((b) => (b.status || "active") === "active" || b.id === getMeta(product, "brand_id"))
                                .map((b) => {
                                  const pending = (b.status || "active") !== "active";
                                  const pendingSuffix = pending
                                    ? ` (${locale === "en" ? "pending authorization" : locale === "tr" ? "onay bekliyor" : locale === "fr" ? "autorisation en attente" : locale === "es" ? "autorización pendiente" : locale === "it" ? "autorizzazione in attesa" : "Autorisierung ausstehend"})`
                                    : "";
                                  return { label: `${b.name}${pendingSuffix}`, value: b.id, disabled: pending };
                                }),
                            ]}
                            value={getMeta(product, "brand_id") || ""}
                            onChange={(v) => updateMeta("brand_id", v || undefined)}
                            helpText={
                              (brands || []).find((b) => b.id === getMeta(product, "brand_id") && (b.status || "active") !== "active")
                                ? (locale === "en" ? "This brand is pending authorization and can't be published yet." : locale === "tr" ? "Bu marka onay bekliyor, henüz yayınlanamaz." : locale === "fr" ? "Cette marque est en attente d'autorisation et ne peut pas encore être publiée." : locale === "es" ? "Esta marca está pendiente de autorización y aún no se puede publicar." : locale === "it" ? "Questo brand è in attesa di autorizzazione e non può ancora essere pubblicato." : "Diese Marke wartet auf Autorisierung und kann noch nicht veröffentlicht werden.")
                                : undefined
                            }
                          />
                        </Box>
                        <Box minWidth="240px" flex="1">
                          <Select
                            label={locale === "en" ? "Shipping group" : locale === "tr" ? "Kargo grubu" : locale === "fr" ? "Groupe d'expédition" : locale === "es" ? "Grupo de envío" : locale === "it" ? "Gruppo di spedizione" : "Versandgruppe"}
                            options={[
                              { label: locale === "en" ? "— None —" : locale === "tr" ? "— Yok —" : locale === "fr" ? "— Aucun —" : locale === "es" ? "— Ninguno —" : locale === "it" ? "— Nessuno —" : "— Keine —", value: "" },
                              ...shippingGroupsList.map((g) => ({ label: g.name, value: g.id })),
                            ]}
                            value={meta.shipping_group_id ?? ""}
                            onChange={(v) => updateMeta("shipping_group_id", v || undefined)}
                          />
                        </Box>
                      </InlineStack>
                      )}

                      {isSuperuser && (
                        <>
                          <Divider />
                          <BlockStack gap="300">
                            <Text as="p" variant="bodySm" fontWeight="semibold">{locale === "en" ? "Collections" : locale === "tr" ? "Koleksiyonlar" : locale === "fr" ? "Collections" : locale === "es" ? "Colecciones" : locale === "it" ? "Collezioni" : "Kollektionen"}</Text>
                            <Text as="p" variant="bodySm" tone="subdued">{locale === "en" ? "Product can be assigned to multiple collections (e.g. Sale, Season)." : locale === "tr" ? "Ürün birden fazla koleksiyona atanabilir (örn. İndirim, Sezon)." : locale === "fr" ? "Le produit peut être assigné à plusieurs collections (ex. Soldes, Saison)." : locale === "es" ? "El producto puede asignarse a varias colecciones (ej. Rebajas, Temporada)." : locale === "it" ? "Il prodotto può essere assegnato a più collezioni (es. Saldo, Stagione)." : "Produkt kann mehreren Kollektionen zugeordnet werden (z. B. Sale, Saison)."}</Text>
                            <div>
                              <div ref={collectionSearchRef} className="collection-dropdown-wrap">
                                <TextField
                                  label={locale === "en" ? "Search collections" : locale === "tr" ? "Koleksiyon ara" : locale === "fr" ? "Rechercher des collections" : locale === "es" ? "Buscar colecciones" : locale === "it" ? "Cerca collezioni" : "Kollektionen durchsuchen"}
                                  labelHidden
                                  value={collectionSearch}
                                  onChange={setCollectionSearch}
                                  onFocus={() => setCollectionPopoverOpen(true)}
                                  placeholder={locale === "en" ? "Search collection…" : locale === "tr" ? "Koleksiyon ara…" : locale === "fr" ? "Rechercher une collection…" : locale === "es" ? "Buscar colección…" : locale === "it" ? "Cerca collezione…" : "Kollektion suchen…"}
                                  autoComplete="off"
                                />
                                {collectionPopoverOpen && collectionRect && (
                                  <div style={{ position: "fixed", top: collectionRect.bottom + 4, left: collectionRect.left, width: collectionRect.width, maxHeight: 280, overflowY: "auto", background: "var(--p-color-bg-surface)", border: "1px solid var(--p-color-border)", borderRadius: 8, boxShadow: "var(--p-shadow-400)", zIndex: 10002 }}>
                                    {(collections || [])
                                      .filter((c) => !collectionSearch.trim() || (c.title || c.handle || "").toLowerCase().includes(collectionSearch.toLowerCase()))
                                      .map((c) => (
                                        <button
                                          key={c.id}
                                          type="button"
                                          className="collection-dropdown-item"
                                          onClick={() => {
                                            const next = collectionIds.includes(c.id) ? collectionIds.filter((id) => id !== c.id) : [...collectionIds, c.id];
                                            updateMeta("collection_ids", next);
                                          }}
                                        >
                                          <span className="checkbox-container" style={{ pointerEvents: "none" }}>
                                            <input type="checkbox" checked={collectionIds.includes(c.id)} readOnly tabIndex={-1} />
                                            <svg viewBox="0 0 64 64" height="1.25em" width="1.25em">
                                              <path d="M 0 16 V 56 A 8 8 90 0 0 8 64 H 56 A 8 8 90 0 0 64 56 V 8 A 8 8 90 0 0 56 0 H 8 A 8 8 90 0 0 0 8 V 16 L 32 48 L 64 16 V 8 A 8 8 90 0 0 56 0 H 8 A 8 8 90 0 0 0 8 V 56 A 8 8 90 0 0 8 64 H 56 A 8 8 90 0 0 64 56 V 16" pathLength="575.0541381835938" className="checkbox-path" />
                                            </svg>
                                          </span>
                                          <span>{c.title || c.handle || c.id}</span>
                                        </button>
                                      ))}
                                  </div>
                                )}
                                {collectionPopoverOpen && <div style={{ position: "fixed", inset: 0, zIndex: 10001 }} onClick={() => setCollectionPopoverOpen(false)} aria-hidden />}
                              </div>
                              {collectionIds.filter((id) => (collections || []).some((c) => c.id === id)).length > 0 && (
                                <InlineStack gap="100" wrap>
                                  {collectionIds
                                    .filter((id) => (collections || []).some((c) => c.id === id))
                                    .map((id) => {
                                      const c = (collections || []).find((x) => x.id === id);
                                      return (
                                        <span
                                          key={id}
                                          style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 8px", background: "var(--p-color-bg-fill-secondary)", borderRadius: 6, fontSize: 12, color: "var(--p-color-text-subdued)" }}
                                        >
                                          {c ? (c.title || c.handle || id) : id}
                                          <button type="button" onClick={() => updateMeta("collection_ids", collectionIds.filter((x) => x !== id))} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, color: "inherit" }} aria-label="Remove">×</button>
                                        </span>
                                      );
                                    })}
                                </InlineStack>
                              )}
                            </div>
                          </BlockStack>
                        </>
                      )}
                    </BlockStack>
                  </div>
                </BlockStack>
              </Box>

              <ProductSectionRule />
              <BlockStack gap="200">
                <ProductSectionHeading badge={<ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="description" />}>
                  Description
                </ProductSectionHeading>
                <div className="product-description-box">
                  <div className="product-description-toolbar">
                    <div className="product-description-toolbar-left">
                      {descriptionMode === "visual" && (
                        <>
                          <button type="button" className="product-desc-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("bold"); }} title="Bold" aria-label="Bold">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fillRule="evenodd" d="M5 1a1.5 1.5 0 0 0-1.5 1.5v10.461c0 .85.689 1.539 1.538 1.539h4.462a3.999 3.999 0 0 0 2.316-7.262 3.999 3.999 0 0 0-3.316-6.238zm3.5 5.5a1.5 1.5 0 0 0 0-3h-2.5v3zm-2.5 2.5v3h3.5a1.5 1.5 0 0 0 0-3z" /></svg>
                          </button>
                          <button type="button" className="product-desc-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("italic"); }} title="Italic" aria-label="Italic">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M5.5 2.25a.75.75 0 0 1 .75-.75h6a.75.75 0 0 1 0 1.5h-2.344l-2.273 10h2.117a.75.75 0 0 1 0 1.5h-6a.75.75 0 0 1 0-1.5h2.345l2.272-10h-2.117a.75.75 0 0 1-.75-.75" /></svg>
                          </button>
                          <button type="button" className="product-desc-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("underline"); }} title="Underline" aria-label="Underline">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M5.25 1.75a.75.75 0 0 0-1.5 0v6a4.25 4.25 0 0 0 8.5 0v-6a.75.75 0 0 0-1.5 0v6a2.75 2.75 0 1 1-5.5 0z" /><path d="M2.75 13.5a.75.75 0 0 0 0 1.5h10.5a.75.75 0 0 0 0-1.5z" /></svg>
                          </button>
                          <span className="product-desc-divider" aria-hidden />
                          <button type="button" className="product-desc-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertUnorderedList"); }} title="Bulleted list" aria-label="Bulleted list">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M2 4a1 1 0 1 0 0-2 1 1 0 0 0 0 2" /><path d="M2 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2" /><path d="M3 13a1 1 0 1 1-2 0 1 1 0 0 1 2 0" /><path d="M5.25 2.25a.75.75 0 0 0 0 1.5h9a.75.75 0 0 0 0-1.5z" /><path d="M4.5 8a.75.75 0 0 1 .75-.75h9a.75.75 0 0 1 0 1.5h-9a.75.75 0 0 1-.75-.75" /><path d="M5.25 12.25a.75.75 0 0 0 0 1.5h9a.75.75 0 0 0 0-1.5z" /></svg>
                          </button>
                          <button type="button" className="product-desc-btn" onMouseDown={(e) => { e.preventDefault(); document.execCommand("insertOrderedList"); }} title="Numbered list" aria-label="Numbered list">
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M5.75 2.25a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5z" /><path d="M5.75 7.25a.75.75 0 0 0 0 1.5h8.5a.75.75 0 0 0 0-1.5z" /><path d="M5 13a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 5 13" /><path d="M2.25 5.75a1.5 1.5 0 0 0-1.5 1.5.5.5 0 0 0 1 0 .5.5 0 0 1 1 0v.05a.5.5 0 0 1-.168.375l-1.423 1.264c-.515.459-.191 1.311.499 1.311h1.592a.5.5 0 0 0 0-1h-.935l.932-.828c.32-.285.503-.693.503-1.121v-.051a1.5 1.5 0 0 0-1.5-1.5" /></svg>
                          </button>
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      className={`product-desc-html-btn ${descriptionMode === "html" ? "active" : ""}`}
                      onClick={() => {
                        if (descriptionMode === "visual" && descEditorRef.current) {
                          const html = descriptionVisualToHtml(descEditorRef.current.innerHTML || "");
                          update({ description: html });
                        } else if (descriptionMode !== "visual" && descEditorRef.current) {
                          descEditorRef.current.innerHTML = product.description || "";
                        }
                        setDescriptionMode(descriptionMode === "html" ? "visual" : "html");
                      }}
                      title={descriptionMode === "html" ? "Show visual" : "Show HTML"}
                      aria-label={descriptionMode === "html" ? "Show visual" : "Show HTML"}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M10.221 2.956a.75.75 0 0 0-1.442-.412l-3 10.5a.75.75 0 0 0 1.442.412z" /><path d="M5.03 4.22a.75.75 0 0 1 0 1.06l-2.72 2.72 2.72 2.72a.749.749 0 1 1-1.06 1.06l-3.25-3.25a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 0" /><path d="M10.97 11.78a.75.75 0 0 1 0-1.06l2.72-2.72-2.72-2.72a.749.749 0 1 1 1.06-1.06l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0" /></svg>
                    </button>
                  </div>
                  {descriptionMode === "html" ? (
                    <textarea
                      className="product-description-html"
                      value={editingDescription}
                      onChange={(e) => updateLocaleField("description", e.target.value)}
                      rows={10}
                      spellCheck={false}
                    />
                  ) : (
                    <div
                      ref={descEditorRef}
                      className="product-description-editor"
                      contentEditable
                      suppressContentEditableWarning
                      onBlur={() => { if (descEditorRef.current) updateLocaleField("description", descriptionVisualToHtml(descEditorRef.current.innerHTML || "")); }}
                    />
                  )}
                </div>
                <p className="product-description-hint">{pe.descriptionHint}</p>
              </BlockStack>

            </BlockStack>
            </div>
          </Card>

          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="400">
              <ProductSectionHeading>{pe.media}</ProductSectionHeading>
              <Text as="p" variant="bodySm" tone="subdued">
                {locale === "en" ? "New image uploads: JPEG or PNG, minimum 1000×1000 px; the server saves square WebP (1000×1000) for the shop." : locale === "tr" ? "Yeni görsel yüklemeleri: JPEG veya PNG, minimum 1000×1000 px; sunucu mağaza için kare WebP (1000×1000) kaydeder." : locale === "fr" ? "Nouveaux téléchargements d'images : JPEG ou PNG, minimum 1000×1000 px ; le serveur enregistre du WebP carré (1000×1000) pour la boutique." : locale === "es" ? "Nuevas subidas de imágenes: JPEG o PNG, mínimo 1000×1000 px; el servidor guarda WebP cuadrado (1000×1000) para la tienda." : locale === "it" ? "Nuovi caricamenti di immagini: JPEG o PNG, minimo 1000×1000 px; il server salva WebP quadrato (1000×1000) per il negozio." : "Neue Bild-Uploads: JPEG oder PNG, mindestens 1000×1000 px; der Server speichert quadratisches WebP (1000×1000) für den Shop."}
              </Text>
              {locale !== "de" && (
                <Text as="p" variant="bodySm" tone="subdued">
                  {hasLocaleMedia
                    ? (locale === "en" ? "Images for this language only. Clear all to fall back to German media." : locale === "tr" ? "Yalnızca bu dil için görseller. Tümünü silerseniz Almanca görseller kullanılır." : locale === "fr" ? "Images pour cette langue uniquement. Tout effacer pour revenir aux visuels allemands." : locale === "es" ? "Imágenes solo para este idioma. Bórralas todas para usar las alemanas." : locale === "it" ? "Immagini solo per questa lingua. Cancella tutto per tornare ai media tedeschi." : "Bilder nur für diese Sprache. Alle leeren, um auf deutsche Medien zurückzufallen.")
                    : (locale === "en" ? "Using German images until you add images for this language." : locale === "tr" ? "Bu dil için görsel ekleyene kadar Almanca görseller kullanılıyor." : locale === "fr" ? "Images allemandes utilisées jusqu’à ce que vous en ajoutiez pour cette langue." : locale === "es" ? "Se usan imágenes alemanas hasta que añadas las de este idioma." : locale === "it" ? "Si usano le immagini tedesche finché non ne aggiungi per questa lingua." : "Deutsche Bilder, bis Sie Bilder für diese Sprache hinzufügen.")}
                </Text>
              )}
              <div className="product-media-grid">
                {mediaUrls.map((url, i) => (
                  <div
                    key={url + i}
                    className={`product-media-item${mediaDragIndex === i ? " dragging" : ""}${mediaDragOverIndex === i && mediaDragIndex !== i ? " drag-over" : ""}`}
                    draggable={true}
                    onDragStart={(e) => handleMediaDragStart(e, i)}
                    onDragOver={(e) => handleMediaDragOver(e, i)}
                    onDrop={(e) => handleMediaDrop(e, i)}
                    onDragEnd={handleMediaDragEnd}
                  >
                    <img src={resolveMediaUrl(url)} alt="" referrerPolicy="no-referrer" />
                    <button type="button" className="product-media-remove" onClick={() => removeMedia(i)} aria-label="Remove image">×</button>
                    {mediaUrls.length > 1 && <span className="product-media-drag-hint">⠿ {locale === "en" ? "Drag" : locale === "tr" ? "Sürükle" : locale === "fr" ? "Glisser" : locale === "es" ? "Arrastrar" : locale === "it" ? "Trascina" : "Ziehen"}</span>}
                  </div>
                ))}
                {mediaUrls.length < 6 && (
                  <div className="product-media-add" role="button" tabIndex={0} title={locale === "en" ? "Add image" : locale === "tr" ? "Görsel ekle" : locale === "fr" ? "Ajouter une image" : locale === "es" ? "Agregar imagen" : locale === "it" ? "Aggiungi immagine" : "Bild hinzufügen"} onClick={() => setMediaPickerOpen(true)}>
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="currentColor"><path d="M8.75 3.75a.75.75 0 0 0-1.5 0v3.5h-3.5a.75.75 0 0 0 0 1.5h3.5v3.5a.75.75 0 0 0 1.5 0v-3.5h3.5a.75.75 0 0 0 0-1.5h-3.5z" /></svg>
                  </div>
                )}
              </div>
              {/* ── Product media picker ── */}
              <MediaPickerModal
                open={mediaPickerOpen}
                onClose={() => setMediaPickerOpen(false)}
                title={locale === "en" ? "Select image" : locale === "tr" ? "Görsel seç" : locale === "fr" ? "Sélectionner une image" : locale === "es" ? "Seleccionar imagen" : locale === "it" ? "Seleziona immagine" : "Bild auswählen"}
                multiple
                uploadPurpose="product"
                onSelect={(urls) => {
                  const toAdd = urls.slice(0, Math.max(0, 6 - mediaUrls.length));
                  if (!toAdd.length) return;
                  const merged = [...mediaUrls, ...toAdd].slice(0, 6);
                  if (locale === "de") updateMeta("media", merged);
                  else updateLocaleField("media", merged);
                }}
              />

              {/* ── Variant image picker (multiple) ── */}
              <MediaPickerModal
                open={variantImgPickerTarget !== null}
                onClose={() => setVariantImgPickerTarget(null)}
                title={
                  variantImgPickerTarget
                    ? `${locale === "en" ? "Images" : locale === "tr" ? "Görseller" : locale === "fr" ? "Images" : locale === "es" ? "Imágenes" : locale === "it" ? "Immagini" : "Bilder"} — ${variantImgPickerTarget.join(" / ")}`
                    : (locale === "en" ? "Variant images" : locale === "tr" ? "Varyant görselleri" : locale === "fr" ? "Images variante" : locale === "es" ? "Imágenes de variante" : locale === "it" ? "Immagini variante" : "Variantenbilder")
                }
                multiple={true}
                uploadPurpose="product"
                onSelect={(urls) => {
                  if (!variantImgPickerTarget || !urls.length) {
                    setVariantImgPickerTarget(null);
                    return;
                  }
                  const row = (product?.variants || []).find(
                    (v) =>
                      Array.isArray(v.option_values) &&
                      v.option_values.join("\u0000") === variantImgPickerTarget.join("\u0000")
                  );
                  const existing = Array.isArray(row?.metadata?.media) ? row.metadata.media : [];
                  const merged = [...existing, ...urls].slice(0, 8);
                  updateMatrixVariantMeta(variantImgPickerTarget, "media", merged);
                  setVariantImgPickerTarget(null);
                }}
              />

              {/* ── Swatch image picker ── */}
              <MediaPickerModal
                open={swatchPickerTarget !== null}
                onClose={() => setSwatchPickerTarget(null)}
                title={swatchPickerTarget
                  ? `Swatch — "${variantGroups[swatchPickerTarget.gi]?.options?.[swatchPickerTarget.oi]?.value || "option"}"`
                  : (locale === "en" ? "Swatch image" : locale === "tr" ? "Swatch görseli" : locale === "fr" ? "Image swatch" : locale === "es" ? "Imagen swatch" : locale === "it" ? "Immagine swatch" : "Swatch-Bild")}
                multiple={false}
                onSelect={(urls) => {
                  if (swatchPickerTarget && urls[0]) {
                    vg_setOption(swatchPickerTarget.gi, swatchPickerTarget.oi, "swatch_image", urls[0]);
                  }
                  setSwatchPickerTarget(null);
                }}
              />

            </BlockStack>
            </div>
          </Card>


          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="400">
              <ProductSectionHeading>{pe.pricing}</ProductSectionHeading>
              <Text as="p" variant="bodySm" tone="subdued">
                {pe.pricingHelp}
              </Text>
              <Text as="p" variant="bodySm" tone="subdued">
                {currentCountryConf.label} · {currentCountryConf.currency} · {currentCountryConf.taxLabel} {currentCountryConf.vatRate}%
              </Text>
              <div className="product-edit-price-grid">
                {[
                  { metaKey: "uvp_cents", label: pe.uvp, cents: cpUvpCents, placeholder: "—" },
                  { metaKey: "brutto_cents", label: pe.sellingPrice, cents: cpBruttoCents, placeholder: "0.00", clearNetto: true },
                  { metaKey: "sale_cents", label: pe.discountPrice, cents: cpSaleCents, placeholder: "—" },
                ].map(({ metaKey, label, cents, placeholder, clearNetto }) => {
                  const dk = `${editingCountry}_${metaKey}`;
                  const display = Object.prototype.hasOwnProperty.call(countryPriceDrafts, dk)
                    ? countryPriceDrafts[dk]
                    : cents != null
                      ? (cents / 100).toFixed(2)
                      : "";
                  return (
                    <TextField
                      key={metaKey}
                      label={label}
                      prefix={currentCountryConf.symbol}
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      value={display}
                      placeholder={placeholder}
                      onChange={(v) => {
                        const clean = sanitizePriceDraftString(v);
                        setCountryPriceDrafts((prev) => {
                          const next = { ...prev, [dk]: clean };
                          countryPriceDraftsRef.current = next;
                          return next;
                        });
                      }}
                      onBlur={(e) => {
                        const clearNettoKey = clearNetto && cpLinked ? `${editingCountry}_netto_cents` : null;
                        commitCountryPriceDraft(dk, metaKey, clearNettoKey, e.currentTarget.value);
                      }}
                    />
                  );
                })}
              </div>
            </BlockStack>
            </div>
          </Card>

          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="400">
              <ProductSectionHeading>{pe.bullets}</ProductSectionHeading>
              <Text as="p" variant="bodySm" tone="subdued">{pe.bulletsHelp}</Text>
              {[0, 1, 2, 3, 4].map((i) => {
                const val = editingBullets[i] ?? "";
                const len = String(val).length;
                const overLimit = len > 120;
                return (
                  <Box key={i}>
                    <TextField
                      label={`Bullet ${i + 1}`}
                      labelHidden
                      value={val}
                      maxLength={120}
                      onChange={(v) => {
                        const trimmed = String(v).slice(0, 120);
                        const next = [...editingBullets.slice(0, 5)];
                        while (next.length <= i) next.push("");
                        next[i] = trimmed;
                        updateLocaleField("bullet_points", next.filter((x, j) => j < 5));
                      }}
                      placeholder={i === 0 ? "e.g. Premium quality" : ""}
                      autoComplete="off"
                    />
                    <Text as="p" variant="bodySm" tone="subdued" style={{ marginTop: 4, color: overLimit ? "var(--p-color-text-critical)" : undefined }}>
                      {len} / 120
                    </Text>
                  </Box>
                );
              })}
            </BlockStack>
            </div>
          </Card>

          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="400">
              <ProductSectionHeading>{pe.inventory}</ProductSectionHeading>
              <InlineStack gap="200" wrap>
                <Box minWidth="120px">
                  <TextField label={pe.quantity} type="number" value={product.inventory != null ? String(product.inventory) : "0"} onChange={(v) => update({ inventory: parseInt(v, 10) || 0 })} min={0} />
                </Box>
                <Box minWidth="180px">
                  <TextField label={pe.minOrderQty} type="number" min={1} value={meta.minimum_order_quantity != null ? String(meta.minimum_order_quantity) : ""} onChange={(v) => updateMeta("minimum_order_quantity", v === "" ? undefined : Math.max(1, parseInt(v, 10) || 1))} placeholder="1" />
                </Box>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">{pe.warehouseHint}</Text>
            </BlockStack>
            </div>
          </Card>

              {isSuperuser && (
              <Card>
            <div className="product-edit-sections">
            <BlockStack gap="400">
              <ProductSectionHeading>{pe.seo}</ProductSectionHeading>
              <div>
                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--p-color-text-subdued)", marginBottom: 4 }}>
                    URL-Handle (Shop){locale !== "de" ? " — this language" : " — canonical (German)"}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <input
                      value={
                        locale === "de"
                          ? (isPlaceholderHandle(product.handle)
                            ? (titleToHandle(editingTitle || product.title || "") || "")
                            : ((product.handle || "").trim() || titleToHandle(editingTitle || product.title || "")))
                          : ((editingTr.handle || "").trim())
                      }
                      onChange={(e) => {
                        const v = sanitizeSeoHandleInput(e.target.value);
                        if (locale === "de") {
                          setProduct((prev) => {
                            if (!prev) return prev;
                            const m = { ...(prev.metadata && typeof prev.metadata === "object" ? prev.metadata : {}) };
                            const tr = { ...(m.translations || {}) };
                            tr.de = { ...(tr.de || {}), handle: v };
                            return { ...prev, handle: v, metadata: { ...m, translations: tr } };
                          });
                        } else {
                          updateLocaleField("handle", v);
                        }
                      }}
                      style={{ flex: 1, padding: "6px 10px", border: "1px solid var(--p-color-border)", borderRadius: 6, fontSize: 12, fontFamily: "monospace" }}
                      placeholder="url-handle"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const next = titleToHandle(editingTitle || product.title || "");
                        if (locale === "de") {
                          setProduct((prev) => {
                            if (!prev) return prev;
                            const m = { ...(prev.metadata && typeof prev.metadata === "object" ? prev.metadata : {}) };
                            const tr = { ...(m.translations || {}) };
                            tr.de = { ...(tr.de || {}), handle: next };
                            return { ...prev, handle: next, metadata: { ...m, translations: tr } };
                          });
                        } else {
                          updateLocaleField("handle", next);
                        }
                      }}
                      title="Titel → Handle synchronisieren"
                      style={{ padding: "6px 10px", background: "var(--p-color-bg-surface-hover)", border: "1px solid var(--p-color-border)", borderRadius: 6, cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}
                    >
                      ↻ Sync
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: "var(--p-color-text-subdued)", marginTop: 4 }}>
                    Shop-URL: {shopPreviewPrefix(locale)}/
                    <span style={{ fontFamily: "monospace" }}>
                      {shopProductHandleForLocale(product, locale) || titleToHandle(editingTitle || product.title || "…")}
                    </span>
                    {locale !== "de" && !(editingTr.handle || "").trim() && (product.handle || "").trim() ? (
                      <span> (empty uses DE handle)</span>
                    ) : null}
                  </div>
              </div>
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>Meta title</span>
                    <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="metadata.seo_meta_title" />
                  </InlineStack>
                }
                value={meta.seo_meta_title ?? ""}
                onChange={(v) => updateMeta("seo_meta_title", v)}
                placeholder={editingTitle || product.title || "Meta title"}
                autoComplete="off"
              />
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>Meta description</span>
                    <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="metadata.seo_meta_description" />
                  </InlineStack>
                }
                value={meta.seo_meta_description ?? ""}
                onChange={(v) => updateMeta("seo_meta_description", v)}
                placeholder={seoPlainPreview(editingDescription || product.description, 160) || "Meta description"}
                multiline={2}
              />
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>Keywords</span>
                    <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="metadata.seo_keywords" />
                  </InlineStack>
                }
                value={meta.seo_keywords ?? ""}
                onChange={(v) => updateMeta("seo_keywords", v)}
                placeholder="keyword1, keyword2"
                autoComplete="off"
              />
            </BlockStack>
            </div>
          </Card>
              )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <div className="product-edit-sidebar">
          <BlockStack gap="300">
            <Card>
              <BlockStack gap="400">
                <BlockStack gap="200">
                  <ProductSectionHeading>{locale === "en" ? "Publish date (optional)" : locale === "tr" ? "Yayın tarihi (isteğe bağlı)" : locale === "fr" ? "Date de publication (optionnel)" : locale === "es" ? "Fecha de publicación (opcional)" : locale === "it" ? "Data di pubblicazione (opzionale)" : "Veröffentlichungsdatum (optional)"}</ProductSectionHeading>
                  <TextField
                    label=""
                    labelHidden
                    type="datetime-local"
                    value={(() => {
                      // Keep the input controlled: datetime-local expects "YYYY-MM-DDTHH:mm"
                      const raw = meta.publish_date;
                      if (!raw) return "";
                      const d = new Date(raw);
                      if (isNaN(d.getTime())) return "";
                      const pad = (n) => String(n).padStart(2, "0");
                      const yyyy = d.getFullYear();
                      const mm = pad(d.getMonth() + 1);
                      const dd = pad(d.getDate());
                      const hh = pad(d.getHours());
                      const min = pad(d.getMinutes());
                      return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
                    })()}
                    onChange={(v) => {
                      if (!v) return updateMeta("publish_date", undefined);
                      const d = new Date(v);
                      if (isNaN(d.getTime())) return updateMeta("publish_date", undefined);
                      // Store ISO so shop can do new Date(publish_date) safely
                      updateMeta("publish_date", d.toISOString());
                    }}
                    placeholder="YYYY-MM-DDTHH:mm"
                    helpText={locale === "en" ? "If a future date + time is set, the shop shows \"Coming soon\"." : locale === "tr" ? "İleri tarih + saat seçilirse shop’ta \"Pek yakında\" gösterilir." : locale === "fr" ? "Si une date + heure future est sélectionnée, la boutique affiche \"Bientôt disponible\"." : locale === "es" ? "Si se selecciona una fecha + hora futura, la tienda muestra \"Próximamente\"." : locale === "it" ? "Se si seleziona una data + ora futura, il negozio mostra \"Presto disponibile\"." : "Bei zukünftigem Datum + Uhrzeit zeigt der Shop \"Demnächst verfügbar\"."}
                  />
                </BlockStack>

                {isSuperuser && (
                <>
                <div style={{ position: "relative", zIndex: relatedProductPopoverOpen ? 10000 : undefined, overflow: "visible" }}>
                  <BlockStack gap="200">
                    <ProductSectionHeading>{locale === "en" ? "Related products (customers also bought)" : locale === "tr" ? "İlgili ürünler (müşteriler de satın aldı)" : locale === "fr" ? "Produits associés (les clients ont aussi acheté)" : locale === "es" ? "Productos relacionados (los clientes también compraron)" : locale === "it" ? "Prodotti correlati (i clienti hanno anche acquistato)" : "Verwandte Produkte (Kunden kauften auch)"}</ProductSectionHeading>
                    <Text as="p" variant="bodySm" tone="subdued">{locale === "en" ? "Products shown in the \"Customers who bought this item also bought\" section on the product page." : locale === "tr" ? "Ürün sayfasında \"Bu ürünü satın alanlar bunları da satın aldı\" bölümünde gösterilecek ürünler." : locale === "fr" ? "Produits affichés dans la section \"Les clients qui ont acheté cet article ont aussi acheté\" sur la page produit." : locale === "es" ? "Productos mostrados en la sección \"Los clientes que compraron este artículo también compraron\" en la página del producto." : locale === "it" ? "Prodotti mostrati nella sezione \"I clienti che hanno acquistato questo articolo hanno anche acquistato\" nella pagina prodotto." : "Produkte die im Bereich \"Kunden, die diesen Artikel gekauft haben, kauften auch\" auf der Produktseite angezeigt werden."}</Text>
                    <TextField
                      label=""
                      labelHidden
                      value={relatedProductSearch}
                      onChange={setRelatedProductSearch}
                      onFocus={() => setRelatedProductPopoverOpen(true)}
                      placeholder={locale === "en" ? "Search product…" : locale === "tr" ? "Ürün ara…" : locale === "fr" ? "Rechercher un produit…" : locale === "es" ? "Buscar producto…" : locale === "it" ? "Cerca prodotto…" : "Produkt suchen…"}
                      autoComplete="off"
                    />
                    <div style={{ position: "relative" }}>
                      {relatedProductPopoverOpen && (
                        <div
                          style={{
                            position: "absolute",
                            top: "100%",
                            left: 0,
                            right: 0,
                            maxHeight: 280,
                            overflowY: "auto",
                            background: "var(--p-color-bg-surface)",
                            border: "1px solid var(--p-color-border)",
                            borderRadius: 8,
                            marginTop: 4,
                            zIndex: 10002,
                            boxShadow: "var(--p-shadow-400)",
                          }}
                        >
                          {(relatedProductsList || [])
                            .filter((p) => p.id !== product?.id && (!relatedProductSearch.trim() || (p.title || p.handle || "").toLowerCase().includes(relatedProductSearch.toLowerCase())))
                            .slice(0, 50)
                            .map((p) => (
                              <button
                                key={p.id}
                                type="button"
                                style={{ display: "block", width: "100%", padding: "8px 12px", textAlign: "left", border: "none", background: relatedProductIds.includes(p.id) ? "var(--p-color-bg-fill-secondary)" : "transparent", cursor: "pointer", fontSize: 13 }}
                                onClick={() => {
                                  const next = relatedProductIds.includes(p.id) ? relatedProductIds.filter((id) => id !== p.id) : [...relatedProductIds, p.id];
                                  updateMeta("related_product_ids", next.length ? next : null);
                                }}
                              >
                                <span style={{ marginRight: 8 }}>{relatedProductIds.includes(p.id) ? "✓" : ""}</span>
                                {p.title || p.handle || p.id}
                              </button>
                            ))}
                        </div>
                      )}
                    </div>
                    {relatedProductPopoverOpen && <div style={{ position: "fixed", inset: 0, zIndex: 10001 }} onClick={() => setRelatedProductPopoverOpen(false)} aria-hidden />}
                    {relatedProductIds.length > 0 && (
                      <InlineStack gap="100" wrap>
                        {relatedProductIds.map((id) => {
                          const p = (relatedProductsList || []).find((x) => x.id === id);
                          const label = p ? (p.title || p.handle || id) : id;
                          return (
                            <span
                              key={id}
                              style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 8px", background: "var(--p-color-bg-fill-secondary)", borderRadius: 6, fontSize: 12, color: "var(--p-color-text-subdued)" }}
                            >
                              {String(label).slice(0, 40)}{String(label).length > 40 ? "…" : ""}
                              <button type="button" onClick={() => updateMeta("related_product_ids", relatedProductIds.filter((x) => x !== id).length ? relatedProductIds.filter((x) => x !== id) : null)} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, lineHeight: 1, color: "inherit" }} aria-label="Remove">×</button>
                            </span>
                          );
                        })}
                      </InlineStack>
                    )}
                  </BlockStack>
                </div>

                <ProductSectionRule />

                <BlockStack gap="200">
                  <ProductSectionHeading>{pe.sales}</ProductSectionHeading>
                  <Text as="p" variant="bodyMd">{meta.sales_count != null ? meta.sales_count : 0} {locale === "en" ? "sales" : locale === "tr" ? "satış" : locale === "fr" ? "ventes" : locale === "es" ? "ventas" : locale === "it" ? "vendite" : "Verkäufe"}</Text>
                </BlockStack>

                <ProductSectionRule />

                <BlockStack gap="200">
                  <ProductSectionHeading>{pe.type}</ProductSectionHeading>
                  <TextField label="Product type" labelHidden value={meta.type ?? ""} onChange={(v) => updateMeta("type", v)} placeholder="e.g. T-Shirt" autoComplete="off" />
                </BlockStack>
                </>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
          </div>
        </Layout.Section>
      </Layout>
      )}

      {activeTabIndex === 2 && (
      <Layout>
        <Layout.Section>
              {/* Variations — directly after Media so they are not buried under GPSR/SEO */}
          <div className="variations-fullwidth">
            <Card>
              <BlockStack gap="400">
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <ProductSectionHeading>{pe.variations}</ProductSectionHeading>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {pe.variationsHelp}
                    </Text>
                  </div>
                  <Button variant="primary" size="slim" onClick={vg_addGroup}>{pe.addGroup}</Button>
                </div>
    
                {variantGroups.length === 0 && (
                  <div style={{ padding: "24px 0", textAlign: "center", color: "var(--p-color-text-subdued)", fontSize: 13 }}>
                    {pe.noVariantGroups}
                  </div>
                )}
    
                <BlockStack gap="300">
                  {variantGroups.map((group, gi) => (
                    <div
                      key={gi}
                      className="vg-group"
                      draggable
                      onDragStart={() => { dragGroupIdx.current = gi; }}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        const from = dragGroupIdx.current;
                        dragGroupIdx.current = null;
                        if (from !== null && from !== gi) vg_moveGroup(from, gi);
                      }}
                    >
                      <div className="vg-group-header">
                        <span className="vg-drag-handle" title="Drag to reorder">⠿</span>
                        <span className="vg-group-num">{gi + 1}</span>
                        {Object.keys(metaDefs).length > 0 && (
                          <div style={{ width: 150, flexShrink: 0 }}>
                            <Select
                              label={pe.eigenschaften}
                              labelHidden
                              options={[
                                { label: lt(locale, "Custom (free text)", "Serbest metin", "Texte libre", "Texto libre", "Testo libero", "Frei (Text)"), value: "" },
                                ...Object.keys(metaDefs).map((k) => ({ label: resolveMetaDefLabel(metaDefs[k], k, locale), value: k })),
                              ]}
                              value={group.metafield_key || ""}
                              onChange={(v) => vg_setGroupMetaKey(gi, v)}
                            />
                          </div>
                        )}
                        <div style={{ flex: 1, maxWidth: 220 }}>
                          <TextField
                            label="Group name"
                            labelHidden
                            value={getGroupDisplayName(gi)}
                            onChange={(v) => vg_setGroupName(gi, v)}
                            placeholder="e.g. Color, Size, Material"
                            autoComplete="off"
                            disabled={!!group.metafield_key}
                          />
                        </div>
                        <Text as="span" variant="bodySm" tone="subdued">
                          {pe.optionsCount((group.options || []).filter((o) => o.value.trim()).length)}
                        </Text>
                        <Button size="slim" variant="plain" tone="critical" onClick={() => vg_removeGroup(gi)}>
                          {ui.remove}
                        </Button>
                      </div>
    
                      <div className="vg-group-body">
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                          {(group.options || []).map((opt, oi) => (
                            <div key={oi} className="vg-option-chip">
                              <div style={{ position: "relative", flexShrink: 0 }}>
                                <button
                                  type="button"
                                  className={opt.swatch_image ? "vg-swatch" : "vg-swatch-empty"}
                                  title={opt.swatch_image ? "Swatch görselini değiştir" : "Swatch görseli ekle (shopta renk/desen simgesi)"}
                                  onClick={() => openSwatchPicker(gi, oi)}
                                >
                                  {opt.swatch_image
                                    ? <img src={resolveMediaUrl(opt.swatch_image)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                                    : <span style={{ fontSize: 10, lineHeight: 1, color: "#6b7280" }}>SW</span>}
                                </button>
                                {opt.swatch_image && (
                                  <button
                                    type="button"
                                    style={{ position: "absolute", top: -4, right: -4, width: 14, height: 14, borderRadius: "50%", background: "#de3618", border: "none", color: "#fff", fontSize: 9, lineHeight: 1, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0 }}
                                    onClick={(e) => { e.stopPropagation(); vg_setOption(gi, oi, "swatch_image", ""); }}
                                    title="Remove swatch"
                                  >×</button>
                                )}
                              </div>
                              {group.metafield_key ? (
                                <span style={{ fontSize: 13, color: "var(--p-color-text)", minWidth: 64, padding: "0 4px" }}>{getOptionInputValue(opt)}</span>
                              ) : (
                                <input
                                  type="text"
                                  value={getOptionInputValue(opt)}
                                  onChange={(e) => handleOptionDisplayChange(gi, oi, e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") {
                                      e.preventDefault();
                                      vg_addOption(gi);
                                    }
                                  }}
                                  placeholder="Value"
                                />
                              )}
                              <button type="button" className="vg-remove-btn" onClick={() => vg_removeOption(gi, oi)} title="Remove option">×</button>
                            </div>
                          ))}
                          {group.metafield_key ? (
                            (() => {
                              const def = metaDefs[group.metafield_key];
                              const used = (group.options || []).map((o) => String(o.value || "").trim());
                              const search = vgValueSearch[gi] || "";
                              const availableVals = (def?.values || []).filter((v) => !used.includes(v) && v.toLowerCase().includes(search.toLowerCase()));
                              const canAddCustom = search.trim() && !used.includes(search.trim()) && !(def?.values || []).includes(search.trim());
                              return (
                                <Popover
                                  active={!!vgValuePopover[gi]}
                                  onClose={() => setVgValuePopover((p) => ({ ...p, [gi]: false }))}
                                  activator={
                                    <Button size="slim" variant="plain" onClick={() => setVgValuePopover((p) => ({ ...p, [gi]: !p[gi] }))}>{pe.addOption}</Button>
                                  }
                                >
                                  <Box padding="200" minWidth="220px">
                                    <BlockStack gap="150">
                                      <TextField
                                        label={pe.searchEigenschaft}
                                        labelHidden
                                        autoComplete="off"
                                        size="slim"
                                        value={search}
                                        onChange={(v) => setVgValueSearch((p) => ({ ...p, [gi]: v }))}
                                        placeholder={pe.searchEigenschaft}
                                        autoFocus
                                      />
                                      <div style={{ maxHeight: 220, overflowY: "auto" }}>
                                        {availableVals.map((v) => (
                                          <div
                                            key={v}
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => { vg_addLinkedOptionValue(gi, v); setVgValueSearch((p) => ({ ...p, [gi]: "" })); setVgValuePopover((p) => ({ ...p, [gi]: false })); }}
                                            style={{ padding: "6px 8px", fontSize: 13, cursor: "pointer", borderRadius: 4 }}
                                          >
                                            {v}
                                          </div>
                                        ))}
                                        {canAddCustom && (
                                          <div
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => { vg_addLinkedOptionValue(gi, search.trim()); setVgValueSearch((p) => ({ ...p, [gi]: "" })); setVgValuePopover((p) => ({ ...p, [gi]: false })); }}
                                            style={{ padding: "6px 8px", fontSize: 13, cursor: "pointer", borderRadius: 4, color: "var(--p-color-text-brand, #2c6ecb)" }}
                                          >
                                            "{search.trim()}" {lt(locale, "propose new", "yeni öner", "proposer nouveau", "proponer nuevo", "proponi nuovo", "neu vorschlagen")}
                                          </div>
                                        )}
                                        {availableVals.length === 0 && !canAddCustom && (
                                          <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--p-color-text-subdued)" }}>
                                            {lt(locale, "No more values", "Başka değer yok", "Aucune autre valeur", "No hay más valores", "Nessun altro valore", "Keine weiteren Werte")}
                                          </div>
                                        )}
                                      </div>
                                    </BlockStack>
                                  </Box>
                                </Popover>
                              );
                            })()
                          ) : (
                            <Button size="slim" variant="plain" onClick={() => vg_addOption(gi)}>{pe.addOption}</Button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </BlockStack>
    
                {variantGroups.length > 0 && (() => {
                  const matrixRows = (product?.variants || []).filter((v) => Array.isArray(v.option_values));
                  if (matrixRows.length === 0) {
                    return (
                      <div style={{ padding: "12px 16px", background: "var(--p-color-bg-surface-warning, #fffbeb)", borderRadius: 8, fontSize: 13, color: "var(--p-color-text-subdued)" }}>
                        Add at least one option to each group to generate combinations.
                      </div>
                    );
                  }
                  return (
                    <div>
                      <div style={{ marginBottom: 10 }}>
                        <Text as="p" variant="bodySm" fontWeight="semibold">
                          {pe.variationMatrix} — {matrixRows.length} {pe.variantWord(matrixRows.length)}
                        </Text>
                      </div>
                      <div>
                        {matrixRows.map((v, vi) => {
                          const variantImgs = Array.isArray(v.metadata?.media) ? v.metadata.media : [];
                          const localeVariantImg =
                            String(locale).toLowerCase() === "de"
                              ? v.image_url || ""
                              : v.image_urls?.[locale] || v.image_url || "";
                          const thumbUrl = variantImgs[0]
                            ? resolveMediaUrl(variantImgs[0])
                            : localeVariantImg
                              ? resolveMediaUrl(localeVariantImg)
                              : null;
                          const vkey = Array.isArray(v.option_values) ? v.option_values.join("\u0000") : "";
                          const mkDraftKey = (f) => `${vkey}_${f}`;
                          const priceFields = [
                            { f: "compare_at_price", centsKey: "compare_at_price_cents", label: pe.uvp,           placeholder: "—" },
                            { f: "price",            centsKey: "price_cents",            label: pe.sellingPrice,  placeholder: "0.00" },
                            { f: "sale_price",       centsKey: "sale_price_cents",       label: pe.discountPrice, placeholder: "—" },
                          ];
    
                          return (
                            <div key={vi} className="vm-card">
                              <div className="vm-row">
                                <div className="vm-row-main">
                                  {thumbUrl
                                    ? <img src={thumbUrl} alt="" className="vm-thumb" />
                                    : <div className="vm-thumb-empty">+</div>
                                  }
                                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, flex: 1 }}>
                                    {(v.option_values || []).map((val, oi) => {
                                      const gOpt = variantGroups[oi];
                                      const opt = (gOpt?.options || []).find(
                                        (o) => String(o.value || "").trim().toLowerCase() === String(val || "").trim().toLowerCase()
                                      );
                                      const label = opt ? optionDisplayLabel(opt, locale) : val;
                                      const swatchUrl = opt?.swatch_image;
                                      return (
                                        <span key={oi} className="vm-badge">
                                          {swatchUrl && (
                                            <span style={{ width: 12, height: 12, borderRadius: "50%", display: "inline-block", backgroundImage: `url(${resolveMediaUrl(swatchUrl)})`, backgroundSize: "cover", border: "1px solid var(--p-color-border)", flexShrink: 0 }} />
                                          )}
                                          <span style={{ fontSize: 11, color: "var(--p-color-text-subdued)", marginRight: 2 }}>{getGroupDisplayName(oi) || gOpt?.name || `G${oi + 1}`}:</span>
                                          {label}
                                        </span>
                                      );
                                    })}
                                  </div>
                                </div>
    
                                <div className="vm-field-group">
                                  <div className="vm-sub-label">{pe.inventoryIds}</div>
                                  <div className="vm-grid-3">
                                    <TextField label="SKU" value={v.sku ?? ""} onChange={(val) => updateMatrixVariant(v.option_values, "sku", val)} placeholder="SKU" autoComplete="off" />
                                    <TextField
                                      label="EAN / GTIN"
                                      value={v.ean ?? ""}
                                      onChange={(val) => updateMatrixVariant(v.option_values, "ean", val)}
                                      placeholder="EAN"
                                      autoComplete="off"
                                      error={String(v.ean || "").trim() === "" ? "EAN required" : undefined}
                                    />
                                    <TextField label={pe.inventory} type="number" min={0} value={v.inventory != null ? String(v.inventory) : "0"} onChange={(val) => updateMatrixVariant(v.option_values, "inventory", val)} placeholder="0" />
                                  </div>
                                </div>
    
                                <div className="vm-field-group vm-prices">
                                  <div className="vm-sub-label">{pe.pricing}</div>
                                  <div className="vm-grid-3">
                                    {priceFields.map(({ f, centsKey, label, placeholder }) => {
                                      const dk = mkDraftKey(f);
                                      const isDraft = Object.prototype.hasOwnProperty.call(priceInputs, dk);
                                      const displayVal = isDraft
                                        ? priceInputs[dk]
                                        : (v[centsKey] != null ? (Number(v[centsKey]) / 100).toFixed(2) : "");
                                      return (
                                        <TextField
                                          key={f}
                                          label={label}
                                          value={displayVal}
                                          placeholder={placeholder}
                                          autoComplete="off"
                                          onChange={(val) => {
                                            const clean = sanitizePriceDraftString(val);
                                            setPriceInputs((prev) => {
                                              const next = { ...prev, [dk]: clean };
                                              priceInputsRef.current = next;
                                              return next;
                                            });
                                          }}
                                          onBlur={(e) => {
                                            const raw = sanitizePriceDraftString(e.currentTarget.value);
                                            updateMatrixVariant(v.option_values, f, raw);
                                            setPriceInputs((prev) => {
                                              const next = { ...prev };
                                              delete next[dk];
                                              priceInputsRef.current = next;
                                              return next;
                                            });
                                          }}
                                        />
                                      );
                                    })}
                                  </div>
                                </div>
    
                                <div className="vm-field-group vm-images">
                                  <div className="vm-sub-label">{pe.images}</div>
                                  <div className="vm-img-strip">
                                    {variantImgs.length === 0 && localeVariantImg && (
                                      <div className="vm-img-item" title="Added via the full Variant Edit page — manage it there">
                                        <img src={resolveMediaUrl(localeVariantImg)} alt="" />
                                      </div>
                                    )}
                                    {variantImgs.map((imgUrl, imgIdx) => (
                                      <div key={imgIdx} className="vm-img-item">
                                        <img src={resolveMediaUrl(imgUrl)} alt="" />
                                        <button
                                          type="button"
                                          className="vm-img-del"
                                          onClick={() => {
                                            const next = variantImgs.filter((_, i) => i !== imgIdx);
                                            updateMatrixVariantMeta(v.option_values, "media", next.length ? next : null);
                                          }}
                                        >×</button>
                                      </div>
                                    ))}
                                    {variantImgs.length < 8 && (
                                      <button
                                        type="button"
                                        className="vm-img-add"
                                        onClick={() => openVariantImgPicker(v.option_values)}
                                      >+</button>
                                    )}
                                  </div>
                                </div>
    
                                {!isNew && (
                                  <div className="vm-edit-btn">
                                    <Button
                                      size="slim"
                                      variant="plain"
                                      icon={EditIcon}
                                      accessibilityLabel="Edit variant"
                                      onClick={() => router.push(`/products/${idOrHandle}/variants/${encodeVariantPathKey(v.option_values)}`)}
                                    />
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })()}
              </BlockStack>
            </Card>
          </div>
        </Layout.Section>
      </Layout>
      )}

      {activeTabIndex === 1 && (
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="300">
              <ProductSectionHeading>{pe.dimsPackaging}</ProductSectionHeading>
              <InlineStack gap="200" wrap>
                <Box minWidth="140px" flex="1">
                  <TextField label={`${pe.width} (cm)`} type="number" value={meta.dimensions_width != null ? String(meta.dimensions_width) : ""} onChange={(v) => updateMeta("dimensions_width", v)} placeholder="0" />
                </Box>
                <Box minWidth="140px" flex="1">
                  <TextField label={`${pe.height} (cm)`} type="number" value={meta.dimensions_height != null ? String(meta.dimensions_height) : ""} onChange={(v) => updateMeta("dimensions_height", v)} placeholder="0" />
                </Box>
                <Box minWidth="140px" flex="1">
                  <TextField label={`${pe.length} (cm)`} type="number" value={meta.dimensions_length != null ? String(meta.dimensions_length) : ""} onChange={(v) => updateMeta("dimensions_length", v)} placeholder="0" />
                </Box>
                <Box minWidth="140px" flex="1">
                  <TextField label={`${pe.weight} (g)`} type="number" value={meta.weight_grams != null ? String(meta.weight_grams) : ""} onChange={(v) => updateMeta("weight_grams", v === "" ? "" : parseInt(v, 10))} placeholder="0" />
                </Box>
              </InlineStack>
              <InlineStack gap="200" wrap>
                <Box minWidth="180px" flex="1">
                  <TextField label={pe.salesUnit} value={meta.sales_unit ?? ""} onChange={(v) => updateMeta("sales_unit", v)} placeholder={lt(locale, "e.g. piece", "örn. adet", "ex. pièce", "ej. unidad", "es. pezzo", "z. B. Stück")} autoComplete="off" />
                </Box>
                <Box minWidth="180px" flex="1">
                  <Select label={pe.unitOfMeasure} options={UNIT_TYPE_OPTIONS} value={meta.unit_type ?? ""} onChange={(v) => updateMeta("unit_type", v)} />
                </Box>
                <Box minWidth="180px" flex="1">
                  <TextField label={pe.packagingUnit} value={meta.packaging_unit ?? ""} onChange={(v) => updateMeta("packaging_unit", v)} placeholder={lt(locale, "e.g. carton", "örn. koli", "ex. carton", "ej. cartón", "es. cartone", "z. B. Karton")} autoComplete="off" />
                </Box>
              </InlineStack>
              <InlineStack gap="200" wrap>
                <Box minWidth="180px" flex="1">
                  <TextField label={pe.packagingUnitPlural} value={meta.packaging_unit_plural ?? ""} onChange={(v) => updateMeta("packaging_unit_plural", v)} placeholder={lt(locale, "e.g. cartons", "örn. koliler", "ex. cartons", "ej. cartones", "es. cartoni", "z. B. Kartons")} autoComplete="off" />
                </Box>
                <Box minWidth="180px" flex="1">
                  <TextField label={pe.baseUnit} type="number" value={meta.unit_reference != null ? String(meta.unit_reference) : "1"} onChange={(v) => updateMeta("unit_reference", v)} placeholder="1" />
                </Box>
                <Box minWidth="180px" flex="1">
                  <TextField label={lt(locale, "Amount", "Miktar", "Quantité", "Cantidad", "Quantità", "Menge")} type="number" value={meta.unit_value != null ? String(meta.unit_value) : ""} onChange={(v) => updateMeta("unit_value", v)} placeholder="e.g. 200" />
                </Box>
              </InlineStack>
              <Text as="p" variant="bodySm" tone="subdued">{lt(locale, "Shown on the product, e.g. \"Content: 200 g (€5.00* / 1 kg)\".", "Ürün sayfasında gösterilir, örn. \"İçerik: 200 g (€5,00* / 1 kg)\".", "Affiché sur le produit, ex. « Contenu : 200 g (5,00 €* / 1 kg) ».", "Se muestra en el producto, ej. « Contenido: 200 g (5,00 €* / 1 kg) ».", "Mostrato sul prodotto, es. « Contenuto: 200 g (5,00 €* / 1 kg) ».", "Wird auf dem Produkt angezeigt, z. B. „Inhalt: 200 g (5,00 €* / 1 kg)“.")}</Text>
            </BlockStack>
            </div>
          </Card>

          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="400">
              <BlockStack gap="150">
                  <ProductSectionHeading>{pe.eigenschaften}</ProductSectionHeading>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {locale === "en" ? "Only metafields with set values — or those selected via \"Add metafield\" — are shown (not the entire catalog). Custom titles/values need superuser approval; until then the product stays hidden in the shop." : locale === "tr" ? "Yalnızca değer atanmış metafield'lar — veya \"Metafield ekle\" ile seçilenler — gösterilir (tüm katalog değil). Özel başlık/değerler superuser onayı ister; onaylanana kadar ürün shop’ta görünmez." : locale === "fr" ? "Seuls les métachamps avec des valeurs définies — ou sélectionnés via \"Ajouter un métachamp\" — sont affichés (pas l'ensemble du catalogue). Titres/valeurs personnalisés : approbation superuser, sinon le produit reste masqué." : locale === "es" ? "Solo se muestran los metacampos con valores establecidos — o los seleccionados mediante \"Agregar metacampo\" — (no el catálogo completo). Títulos/valores propios requieren aprobación; hasta entonces el producto no aparece en la tienda." : locale === "it" ? "Vengono mostrati solo i metacampi con valori impostati — o quelli selezionati tramite \"Aggiungi metacampo\" — (non l'intero catalogo). Titoli/valori personalizzati richiedono approvazione; fino ad allora il prodotto resta nascosto." : 'Nur Metafelder mit gesetzten Werten — oder über „Metafeld hinzufügen" ausgewählte — werden angezeigt (nicht der gesamte Katalog). Eigene Titel/Werte brauchen Superuser-Freigabe; bis dahin bleibt das Produkt im Shop unsichtbar.'}
                  </Text>
                </BlockStack>
                {Object.keys(metaDefs).length === 0 ? (
                  <Box padding="400" background="bg-surface-secondary" borderRadius="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      {locale === "en" ? "No catalog definitions yet — use \"New metafield (catalog)\" to create title and value (superuser: immediately active; seller: approval required)." : locale === "tr" ? "Henüz katalog tanımı yok — başlık ve değer oluşturmak için \"Yeni metafield (katalog)\" kullanın (süper kullanıcı: hemen aktif; satıcı: onay gerekli)." : locale === "fr" ? "Aucune définition de catalogue — utilisez \"Nouveau métachamp (catalogue)\" pour créer titre et valeur (superuser : immédiatement actif ; vendeur : approbation requise)." : locale === "es" ? "Aún no hay definiciones de catálogo — usa \"Nuevo metacampo (catálogo)\" para crear título y valor (superusuario: activo inmediatamente; vendedor: se requiere aprobación)." : locale === "it" ? "Nessuna definizione di catalogo ancora — usa \"Nuovo metacampo (catalogo)\" per creare titolo e valore (superuser: immediatamente attivo; venditore: approvazione richiesta)." : 'Noch keine Katalog-Definitionen — du kannst mit „Neues Metafeld (Katalog)" Titel und Wert anlegen (Superuser: sofort aktiv; Verkäufer: Freigabe nötig).'}
                    </Text>
                  </Box>
                ) : (
                  <Box padding="400" background="bg-surface-secondary" borderRadius="300">
                    <BlockStack gap="400">
                      {visibleMetaDefEntries.length === 0 && (
                        <Text as="p" variant="bodySm" tone="subdued">{locale === "en" ? "No metafields for this product. You can add some below." : locale === "tr" ? "Bu ürün için metafield yok. Aşağıdan ekleyebilirsiniz." : locale === "fr" ? "Aucun métachamp pour ce produit. Vous pouvez en ajouter ci-dessous." : locale === "es" ? "No hay metacampos para este producto. Puedes agregar algunos abajo." : locale === "it" ? "Nessun metacampo per questo prodotto. Puoi aggiungerne qui sotto." : "Keine Metafelder für dieses Produkt. Unten kannst du welche hinzufügen."}</Text>
                      )}
                      {visibleMetaDefEntries.map(([defKey, def]) => {
                        const selected = metafieldsList.filter(m => m.key === defKey).map(m => m.value).filter(Boolean);
                        const isOpen = !!metaDefPopover[defKey];
                        const search = metaDefSearch[defKey] || "";
                        const availableVals = (def.values || []).filter(v => !selected.includes(v) && v.toLowerCase().includes(search.toLowerCase()));
                        const canAddCustom = search.trim() && !selected.includes(search.trim()) && !(def.values || []).includes(search.trim());
                        const toggleVal = (val) => {
                          const others = metafieldsList.filter(m => m.key !== defKey);
                          const cur = selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val];
                          updateMeta("metafields", [...others, ...cur.map(v => ({ key: defKey, value: v }))]);
                        };
                        return (
                          <Box
                            key={defKey}
                            padding="400"
                            background="bg-surface"
                            borderRadius="200"
                            borderWidth="025"
                            borderColor="border"
                          >
                            <BlockStack gap="300">
                              <BlockStack gap="050">
                                <InlineStack gap="200" blockAlign="center" wrap={false}>
                                  <Text as="p" variant="bodyMd" fontWeight="semibold">{resolveMetaDefLabel(def, defKey, locale)}</Text>
                                  <InfoIconTooltip
                                    text={
                                      locale === "en" ? `Internal key: ${defKey}` :
                                      locale === "tr" ? `Teknik anahtar: ${defKey}` :
                                      locale === "fr" ? `Clé interne : ${defKey}` :
                                      locale === "es" ? `Clave interna: ${defKey}` :
                                      locale === "it" ? `Chiave interna: ${defKey}` :
                                      `Interner Schlüssel: ${defKey}`
                                    }
                                  />
                                  <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName={`metadata.${defKey}`} />
                                </InlineStack>
                              </BlockStack>
                              {selected.length > 0 && (
                                <InlineStack gap="200" wrap>
                                  {selected.map(val => (
                                    <Tag key={val} onRemove={() => {
                                      const others = metafieldsList.filter(m => m.key !== defKey);
                                      updateMeta("metafields", [...others, ...selected.filter(v => v !== val).map(v => ({ key: defKey, value: v }))]);
                                    }}>{val}</Tag>
                                  ))}
                                </InlineStack>
                              )}
                              <Popover
                                active={isOpen}
                                onClose={() => setMetaDefPopover(p => ({ ...p, [defKey]: false }))}
                                activator={
                                  <Button size="slim" variant="secondary" onClick={() => setMetaDefPopover(p => ({ ...p, [defKey]: !p[defKey] }))}>
                                    + {locale === "en" ? "Select value" : locale === "tr" ? "Değer seç" : locale === "fr" ? "Choisir une valeur" : locale === "es" ? "Seleccionar valor" : locale === "it" ? "Seleziona valore" : "Wert wählen"}
                                  </Button>
                                }
                              >
                                <Box padding="300" minWidth="220px">
                                  <BlockStack gap="200">
                                    <TextField
                                      label={locale === "en" ? "Search" : locale === "tr" ? "Ara" : locale === "fr" ? "Rechercher" : locale === "es" ? "Buscar" : locale === "it" ? "Cerca" : "Suchen"}
                                      labelHidden
                                      placeholder={locale === "en" ? "Search or enter…" : locale === "tr" ? "Ara veya gir…" : locale === "fr" ? "Rechercher ou saisir…" : locale === "es" ? "Buscar o ingresar…" : locale === "it" ? "Cerca o inserisci…" : "Suchen oder eingeben…"}
                                      value={search}
                                      onChange={v => setMetaDefSearch(p => ({ ...p, [defKey]: v }))}
                                      autoComplete="off"
                                      size="slim"
                                    />
                                    <div style={{ maxHeight: 200, overflowY: "auto" }}>
                                      {availableVals.map(val => (
                                        <div
                                          key={val}
                                          role="button"
                                          tabIndex={0}
                                          style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 6, fontSize: 13 }}
                                          onMouseEnter={e => { e.currentTarget.style.background = "var(--p-color-bg-surface-hover)"; }}
                                          onMouseLeave={e => { e.currentTarget.style.background = ""; }}
                                          onMouseDown={e => {
                                            e.preventDefault();
                                            toggleVal(val);
                                            setMetaDefSearch(p => ({ ...p, [defKey]: "" }));
                                            setMetaDefPopover(p => ({ ...p, [defKey]: false }));
                                          }}
                                        >{val}</div>
                                      ))}
                                      {canAddCustom && (
                                        <div
                                          role="button"
                                          tabIndex={0}
                                          style={{ padding: "8px 10px", cursor: "pointer", borderRadius: 6, fontSize: 13, fontStyle: "italic", color: "var(--p-color-text-subdued)" }}
                                          onMouseEnter={e => { e.currentTarget.style.background = "var(--p-color-bg-surface-hover)"; }}
                                          onMouseLeave={e => { e.currentTarget.style.background = ""; }}
                                          onMouseDown={e => {
                                            e.preventDefault();
                                            const custom = search.trim();
                                            toggleVal(custom);
                                            if (custom && !(def.values || []).includes(custom)) {
                                              client.submitMetafieldCatalogProposal({
                                                key: defKey,
                                                label: resolveMetaDefLabel(def, defKey, locale),
                                                values: [custom],
                                              }).catch(() => {});
                                            }
                                            setMetaDefSearch(p => ({ ...p, [defKey]: "" }));
                                            setMetaDefPopover(p => ({ ...p, [defKey]: false }));
                                          }}
                                        >"{search.trim()}" {locale === "en" ? "add" : locale === "tr" ? "ekle" : locale === "fr" ? "ajouter" : locale === "es" ? "agregar" : locale === "it" ? "aggiungi" : "hinzufügen"}</div>
                                      )}
                                      {availableVals.length === 0 && !canAddCustom && (
                                        <div style={{ padding: "8px 10px", fontSize: 13, color: "var(--p-color-text-subdued)" }}>{locale === "en" ? "No more options" : locale === "tr" ? "Başka seçenek yok" : locale === "fr" ? "Aucune autre option" : locale === "es" ? "No hay más opciones" : locale === "it" ? "Nessun'altra opzione" : "Keine weiteren Optionen"}</div>
                                      )}
                                    </div>
                                  </BlockStack>
                                </Box>
                              </Popover>
                            </BlockStack>
                          </Box>
                        );
                      })}
                      {hiddenMetaDefKeys.length > 0 && (
                        <Box paddingBlockStart="100">
                          <Popover
                            active={addMetaDefPopoverOpen}
                            preferredPosition="below"
                            preferredAlignment="left"
                            onClose={() => { setAddMetaDefPopoverOpen(false); setAddMetaDefSearch(""); }}
                            activator={
                              <Button size="slim" variant="secondary" onClick={() => setAddMetaDefPopoverOpen((o) => !o)}>
                                + {pe.searchEigenschaft}
                              </Button>
                            }
                          >
                            <div style={{ width: 380, maxWidth: "calc(100vw - 24px)" }}>
                              <div style={{ padding: "8px 10px 6px", borderBottom: "1px solid var(--p-color-border-secondary)" }}>
                                <TextField
                                  label={locale === "en" ? "Search" : locale === "tr" ? "Ara" : locale === "fr" ? "Rechercher" : locale === "es" ? "Buscar" : locale === "it" ? "Cerca" : "Suchen"}
                                  labelHidden
                                  autoComplete="off"
                                  size="slim"
                                  value={addMetaDefSearch}
                                  onChange={setAddMetaDefSearch}
                                  placeholder={locale === "en" ? "Search…" : locale === "tr" ? "Ara…" : locale === "fr" ? "Rechercher…" : locale === "es" ? "Buscar…" : locale === "it" ? "Cerca…" : "Suchen…"}
                                  autoFocus
                                />
                              </div>
                              <div style={{ maxHeight: 240, overflowY: "auto" }}>
                                {visibleHiddenMetaDefKeys.length === 0 ? (
                                  <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--p-color-text-subdued)" }}>
                                    {locale === "en" ? "No matching fields." : locale === "tr" ? "Eşleşen alan yok." : locale === "fr" ? "Aucun champ correspondant." : locale === "es" ? "No hay campos coincidentes." : locale === "it" ? "Nessun campo corrispondente." : "Keine passenden Felder."}
                                  </div>
                                ) : (
                                  visibleHiddenMetaDefKeys.map((k) => {
                                    const label = resolveMetaDefLabel(metaDefs[k], k, locale);
                                    const valCount = Array.isArray(metaDefs[k]?.values) ? metaDefs[k].values.length : 0;
                                    const addField = () => {
                                      setExtraVisibleMetaDefKeys((p) => ({ ...p, [k]: true }));
                                      setAddMetaDefPopoverOpen(false);
                                      setAddMetaDefSearch("");
                                    };
                                    return (
                                      <div
                                        key={k}
                                        role="button"
                                        tabIndex={0}
                                        onClick={addField}
                                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addField(); } }}
                                        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--p-color-bg-surface-hover)"; }}
                                        onMouseLeave={(e) => { e.currentTarget.style.background = ""; }}
                                        style={{
                                          display: "flex",
                                          alignItems: "center",
                                          gap: 10,
                                          padding: "7px 12px",
                                          cursor: "pointer",
                                          borderBottom: "1px solid var(--p-color-border-secondary)",
                                          lineHeight: 1.25,
                                        }}
                                      >
                                        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--p-color-text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                          {label}
                                        </span>
                                        <span style={{ flexShrink: 0, fontSize: 11, color: "var(--p-color-text-subdued)", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                                          {k}
                                        </span>
                                        {valCount > 0 ? (
                                          <span style={{ flexShrink: 0, fontSize: 11, color: "var(--p-color-text-subdued)", minWidth: 28, textAlign: "right" }}>
                                            {valCount}
                                          </span>
                                        ) : null}
                                        <span style={{ flexShrink: 0, fontSize: 16, fontWeight: 500, color: "var(--p-color-text-secondary)", lineHeight: 1 }} aria-hidden>+</span>
                                      </div>
                                    );
                                  })
                                )}
                              </div>
                            </div>
                          </Popover>
                        </Box>
                      )}
                    </BlockStack>
                  </Box>
                )}
                <InlineStack gap="300" blockAlign="center" wrap>
                  <Button size="slim" variant="primary" onClick={() => { setNewCatalogMetaErr(""); setNewCatalogMetaOpen(true); }}>
                    + {locale === "en" ? "New metafield (catalog)" : locale === "tr" ? "Yeni metafield (katalog)" : locale === "fr" ? "Nouveau métachamp (catalogue)" : locale === "es" ? "Nuevo metacampo (catálogo)" : locale === "it" ? "Nuovo metacampo (catalogo)" : "Neues Metafeld (Katalog)"}
                  </Button>
                </InlineStack>
              </BlockStack>

              <Modal
                open={newCatalogMetaOpen}
                onClose={() => { if (!newCatalogMetaSaving) setNewCatalogMetaOpen(false); }}
                title={locale === "en" ? "New catalog metafield" : locale === "tr" ? "Yeni katalog metafield'ı" : locale === "fr" ? "Nouveau métachamp de catalogue" : locale === "es" ? "Nuevo metacampo de catálogo" : locale === "it" ? "Nuovo metacampo catalogo" : "Neues Katalog-Metafeld"}
                primaryAction={{
                  content: isSuperuser ? (locale === "en" ? "Save in catalog" : locale === "tr" ? "Katalogda kaydet" : locale === "fr" ? "Enregistrer dans le catalogue" : locale === "es" ? "Guardar en catálogo" : locale === "it" ? "Salva nel catalogo" : "Im Katalog speichern") : (locale === "en" ? "Submit for approval" : locale === "tr" ? "Onay için gönder" : locale === "fr" ? "Soumettre pour approbation" : locale === "es" ? "Enviar para aprobación" : locale === "it" ? "Invia per approvazione" : "Zur Freigabe einreichen"),
                  onAction: submitNewCatalogMetafield,
                  loading: newCatalogMetaSaving,
                }}
                secondaryActions={[{ content: ui.cancel, onAction: () => { if (!newCatalogMetaSaving) setNewCatalogMetaOpen(false); } }]}
              >
                <Modal.Section>
                  <BlockStack gap="400">
                    {newCatalogMetaErr ? <Banner tone="critical" onDismiss={() => setNewCatalogMetaErr("")}>{newCatalogMetaErr}</Banner> : null}
                    <TextField
                      label={locale === "en" ? "Title (display name)" : locale === "tr" ? "Başlık (görünen ad)" : locale === "fr" ? "Titre (nom d'affichage)" : locale === "es" ? "Título (nombre de visualización)" : locale === "it" ? "Titolo (nome di visualizzazione)" : "Titel (Anzeigename)"}
                      value={newCatalogMetaLabel}
                      onChange={setNewCatalogMetaLabel}
                      placeholder={locale === "en" ? "e.g. Material, Certificate, Care instructions" : locale === "tr" ? "örn. Malzeme, Sertifika, Bakım talimatları" : locale === "fr" ? "ex. Matière, Certificat, Instructions d'entretien" : locale === "es" ? "ej. Material, Certificado, Instrucciones de cuidado" : locale === "it" ? "es. Materiale, Certificato, Istruzioni per la cura" : "z.B. Material, Zertifikat, Pflegehinweis"}
                      autoComplete="off"
                    />
                    <TextField
                      label={locale === "en" ? "Content (value)" : locale === "tr" ? "İçerik (değer)" : locale === "fr" ? "Contenu (valeur)" : locale === "es" ? "Contenido (valor)" : locale === "it" ? "Contenuto (valore)" : "Inhalt (Wert)"}
                      value={newCatalogMetaValue}
                      onChange={setNewCatalogMetaValue}
                      placeholder={locale === "en" ? "e.g. Cotton, OEKO-TEX, Machine wash 40°" : locale === "tr" ? "örn. Pamuk, OEKO-TEX, Makinede yıkama 40°" : locale === "fr" ? "ex. Coton, OEKO-TEX, Lavage machine 40°" : locale === "es" ? "ej. Algodón, OEKO-TEX, Lavado a máquina 40°" : locale === "it" ? "es. Cotone, OEKO-TEX, Lavaggio in lavatrice 40°" : "z.B. Baumwolle, OEKO-TEX, Maschinenwäsche 40°"}
                      autoComplete="off"
                    />
                    <TextField
                      label={locale === "en" ? "Key (optional)" : locale === "tr" ? "Anahtar (isteğe bağlı)" : locale === "fr" ? "Clé (optionnel)" : locale === "es" ? "Clave (opcional)" : locale === "it" ? "Chiave (opzionale)" : "Key (optional)"}
                      value={newCatalogMetaKey}
                      onChange={(v) => setNewCatalogMetaKey(v.toLowerCase())}
                      helpText={locale === "en" ? "Leave empty: generated from title (lowercase, underscores)." : locale === "tr" ? "Boş bırakın: başlıktan oluşturulur (küçük harf, alt çizgi)." : locale === "fr" ? "Laisser vide : généré à partir du titre (minuscules, tirets bas)." : locale === "es" ? "Dejar vacío: se genera desde el título (minúsculas, guiones bajos)." : locale === "it" ? "Lascia vuoto: generato dal titolo (minuscolo, trattini bassi)." : "Leer lassen: wird aus dem Titel erzeugt (kleinbuchstaben, Unterstriche)."}
                      autoComplete="off"
                    />
                  </BlockStack>
                </Modal.Section>
              </Modal>
            </div>
          </Card>

          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="400">
              <ProductSectionHeading>{pe.madeInEurope} ({locale === "en" ? "optional" : locale === "tr" ? "isteğe bağlı" : locale === "fr" ? "optionnel" : locale === "es" ? "opcional" : locale === "it" ? "opzionale" : "optional"})</ProductSectionHeading>
              <Text as="p" tone="subdued">
                {locale === "en" ? "Registry ID and proof document are optional. After saving with changed details: status \"pending\". The badge appears in the shop only when status is \"verified\" (superuser or later registry check)." : locale === "tr" ? "Registry ID ve kanıt belgesi isteğe bağlıdır. Değiştirilen bilgilerle kaydedildikten sonra: durum \"beklemede\". Mağazada rozet yalnızca durum \"doğrulandı\" olduğunda görünür (süper kullanıcı veya sonraki registry kontrolü)." : locale === "fr" ? "L'ID de registre et le document justificatif sont optionnels. Après enregistrement avec des informations modifiées : statut \"en attente\". Le badge n'apparaît dans la boutique qu'avec le statut \"vérifié\" (superuser ou vérification ultérieure du registre)." : locale === "es" ? "El ID de registro y el documento de prueba son opcionales. Tras guardar con datos modificados: estado \"pendiente\". El badge aparece en la tienda solo con estado \"verificado\" (superusuario o verificación posterior del registro)." : locale === "it" ? "L'ID registro e il documento di prova sono opzionali. Dopo il salvataggio con dati modificati: stato \"in sospeso\". Il badge appare nel negozio solo quando lo stato è \"verificato\" (superuser o controllo registro successivo)." : 'Registry-ID und Nachweisdokument optional. Nach Speichern mit geänderten Angaben: Status „pending". Im Shop erscheint das Badge nur bei Status „verified" (Superuser oder spätere Registry-Prüfung).'}
              </Text>
              {euOriginNotice ? (
                <Banner tone="info" onDismiss={() => setEuOriginNotice("")}>{euOriginNotice}</Banner>
              ) : null}
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>{locale === "en" ? "Country of origin (EU)" : locale === "tr" ? "Menşe ülke (AB)" : locale === "fr" ? "Pays d'origine (UE)" : locale === "es" ? "País de origen (UE)" : locale === "it" ? "Paese di origine (UE)" : "Herkunftsland (EU)"}</span>
                    <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="metadata.eu_origin_country" />
                  </InlineStack>
                }
                value={meta.eu_origin_country ?? ""}
                onChange={(v) => updateMeta("eu_origin_country", v || undefined)}
                placeholder={locale === "en" ? "e.g. DE, FR, IT" : locale === "tr" ? "örn. DE, FR, IT" : "z. B. DE, FR, IT"}
                autoComplete="off"
              />
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>Registry-ID</span>
                    <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="metadata.eu_origin_registry_id" />
                  </InlineStack>
                }
                value={meta.eu_origin_registry_id ?? ""}
                onChange={(v) => updateMeta("eu_origin_registry_id", v || undefined)}
                placeholder={locale === "en" ? "EU registry / certificate number" : locale === "tr" ? "AB kayıt / sertifika numarası" : locale === "fr" ? "Registre UE / numéro de certificat" : locale === "es" ? "Registro UE / número de certificado" : locale === "it" ? "Registro UE / numero di certificato" : "EU-Registry / Zertifikatsnummer"}
                autoComplete="off"
              />
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>{pe.proofDocument}</span>
                    <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="metadata.eu_origin_document_url" />
                  </InlineStack>
                }
                value={meta.eu_origin_document_url ?? ""}
                onChange={(v) => updateMeta("eu_origin_document_url", v || undefined)}
                placeholder="https://…"
                autoComplete="off"
              />
              <Select
                label={locale === "en" ? "Registry provider" : locale === "tr" ? "Registry sağlayıcısı" : locale === "fr" ? "Fournisseur de registre" : locale === "es" ? "Proveedor de registro" : locale === "it" ? "Provider registro" : "Registry-Provider"}
                options={[
                  { label: locale === "en" ? "Stub (manual check)" : locale === "tr" ? "Stub (manuel kontrol)" : locale === "fr" ? "Stub (vérification manuelle)" : locale === "es" ? "Stub (verificación manual)" : locale === "it" ? "Stub (verifica manuale)" : "Stub (manuelle Prüfung)", value: "stub" },
                ]}
                value={meta.eu_origin_provider || "stub"}
                onChange={(v) => updateMeta("eu_origin_provider", v || "stub")}
              />
              <TextField
                label="Status"
                value={meta.eu_origin_status || "—"}
                readOnly
                autoComplete="off"
                helpText={
                  meta.eu_origin_verified_at
                    ? `${locale === "en" ? "Verified at:" : locale === "tr" ? "Doğrulandı:" : locale === "fr" ? "Vérifié le :" : locale === "es" ? "Verificado el:" : locale === "it" ? "Verificato il:" : "Verifiziert am:"} ${meta.eu_origin_verified_at}`
                    : undefined
                }
              />
              <InlineStack gap="200">
                <Button
                  onClick={() => handleVerifyEuOrigin(false)}
                  loading={euOriginVerifying}
                  disabled={!product?.id || euOriginVerifying}
                >
                  {locale === "en" ? "Check registry (stub)" : locale === "tr" ? "Registry kontrol et (stub)" : locale === "fr" ? "Vérifier le registre (stub)" : locale === "es" ? "Verificar registro (stub)" : locale === "it" ? "Controlla registro (stub)" : "Registry prüfen (Stub)"}
                </Button>
                {isSuperuser ? (
                  <Button
                    variant="primary"
                    onClick={() => handleVerifyEuOrigin(true)}
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
          </BlockStack>
        </Layout.Section>
      </Layout>
      )}

      {activeTabIndex === 3 && (
      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="400">
              <ProductSectionHeading>{locale === "en" ? "Product safety information (GPSR)" : locale === "tr" ? "Ürün güvenlik bilgileri (GPSR)" : locale === "fr" ? "Informations de sécurité produit (GPSR)" : locale === "es" ? "Información de seguridad del producto (GPSR)" : locale === "it" ? "Informazioni di sicurezza prodotto (GPSR)" : "Produktsicherheitsinformationen (GPSR)"}</ProductSectionHeading>
              <Text as="p" variant="bodySm" tone="subdued">
                {locale === "en"
                  ? "Required by the EU General Product Safety Regulation. Enter the manufacturer and an EU-based responsible person so the shop can show the legally required safety contacts. Tap “i” next to each field for details."
                  : locale === "tr"
                    ? "AB Genel Ürün Güvenliği Tüzüğü (GPSR) gereği zorunlu. Mağazada yasal güvenlik iletişimlerinin gösterilmesi için üreticiyi ve AB’de yerleşik sorumlu kişiyi girin. Ayrıntı için her alanın yanındaki “i”ye tıklayın."
                    : locale === "fr"
                      ? "Exigé par le règlement UE sur la sécurité générale des produits. Indiquez le fabricant et une personne responsable basée dans l'UE pour afficher les contacts de sécurité légalement requis. Appuyez sur « i » pour les détails."
                      : locale === "es"
                        ? "Exigido por el Reglamento UE de seguridad general de los productos. Indica el fabricante y una persona responsable en la UE para mostrar los contactos de seguridad. Pulsa « i » para más detalles."
                        : locale === "it"
                          ? "Richiesto dal regolamento UE sulla sicurezza generale dei prodotti. Inserisci il fabbricante e una persona responsabile nell'UE per mostrare i contatti di sicurezza. Tocca « i » per i dettagli."
                          : "Erforderlich nach der EU-Produktsicherheitsverordnung (GPSR). Tragen Sie Hersteller und eine in der EU ansässige verantwortliche Person ein, damit der Shop die gesetzlich vorgeschriebenen Sicherheitskontakte anzeigen kann. Tippen Sie auf „i“ für Details."}
              </Text>
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>{locale === "en" ? "Manufacturer" : locale === "tr" ? "Üretici" : locale === "fr" ? "Fabricant" : locale === "es" ? "Fabricante" : locale === "it" ? "Fabbricante" : "Hersteller"}</span>
                    <InfoIconTooltip
                      text={
                        locale === "en" ? "Name of the company or person that manufactured the product (as on packaging/imprint)."
                          : locale === "tr" ? "Ürünü üreten şirket veya kişinin adı (ambalaj/künyedeki gibi)."
                            : locale === "fr" ? "Nom de l'entreprise ou de la personne qui a fabriqué le produit (comme sur l'emballage)."
                              : locale === "es" ? "Nombre de la empresa o persona que fabricó el producto (como en el envase)."
                                : locale === "it" ? "Nome dell'azienda o della persona che ha fabbricato il prodotto (come sulla confezione)."
                                  : "Name des Unternehmens oder der Person, die das Produkt hergestellt hat (wie auf Verpackung/Impressum)."
                      }
                    />
                    <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="metadata.hersteller" />
                  </InlineStack>
                }
                requiredIndicator
                value={meta.hersteller ?? ""}
                onChange={(v) => updateMeta("hersteller", v || undefined)}
                placeholder={locale === "en" ? "e.g. Acme GmbH" : locale === "tr" ? "örn. Acme GmbH" : "z. B. Acme GmbH"}
                autoComplete="off"
              />
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>{locale === "en" ? "Manufacturer details" : locale === "tr" ? "Üretici bilgileri" : locale === "fr" ? "Coordonnées du fabricant" : locale === "es" ? "Datos del fabricante" : locale === "it" ? "Dati del fabbricante" : "Herstellerinformationen"}</span>
                    <InfoIconTooltip
                      text={
                        locale === "en" ? "Postal address and contact of the manufacturer (street, postcode, city, country, email and/or phone)."
                          : locale === "tr" ? "Üreticinin posta adresi ve iletişimi (sokak, posta kodu, şehir, ülke, e-posta ve/veya telefon)."
                            : locale === "fr" ? "Adresse postale et contact du fabricant (rue, code postal, ville, pays, e-mail et/ou téléphone)."
                              : locale === "es" ? "Dirección postal y contacto del fabricante (calle, CP, ciudad, país, correo y/o teléfono)."
                                : locale === "it" ? "Indirizzo postale e contatto del fabbricante (via, CAP, città, paese, e-mail e/o telefono)."
                                  : "Postanschrift und Kontakt des Herstellers (Straße, PLZ, Ort, Land, E-Mail und/oder Telefon)."
                      }
                    />
                    <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="metadata.hersteller_information" />
                  </InlineStack>
                }
                requiredIndicator
                value={meta.hersteller_information ?? ""}
                onChange={(v) => updateMeta("hersteller_information", v || undefined)}
                placeholder={locale === "en" ? "Street, city, country, email/phone" : locale === "tr" ? "Sokak, şehir, ülke, e-posta/telefon" : "Straße, Ort, Land, E-Mail/Telefon"}
                multiline={2}
              />
              <TextField
                label={
                  <InlineStack gap="200" blockAlign="center" wrap={false}>
                    <span>{locale === "en" ? "Responsible person (EU)" : locale === "tr" ? "Sorumlu kişi (AB)" : locale === "fr" ? "Personne responsable (UE)" : locale === "es" ? "Persona responsable (UE)" : locale === "it" ? "Persona responsabile (UE)" : "Verantwortliche Person (EU)"}</span>
                    <InfoIconTooltip
                      text={
                        locale === "en" ? "EU-based contact for product safety (name + address + contact). If the manufacturer is in the EU, this can be the same party."
                          : locale === "tr" ? "Ürün güvenliği için AB'de yerleşik iletişim (ad + adres + iletişim). Üretici AB'deyse aynı taraf olabilir."
                            : locale === "fr" ? "Point de contact basé dans l'UE pour la sécurité produit (nom + adresse + contact). Si le fabricant est dans l'UE, ce peut être la même entité."
                              : locale === "es" ? "Contacto establecido en la UE para seguridad del producto (nombre + dirección + contacto). Si el fabricante está en la UE, puede ser la misma parte."
                                : locale === "it" ? "Contatto stabilito nell'UE per la sicurezza del prodotto (nome + indirizzo + contatto). Se il fabbricante è nell'UE, può essere la stessa parte."
                                  : "In der EU ansässige Kontaktstelle für Produktsicherheit (Name + Adresse + Kontakt). Sitzt der Hersteller in der EU, kann dies dieselbe Stelle sein."
                      }
                    />
                    <ChangeRequestFieldBadge requests={pendingChangeRequests} fieldName="metadata.verantwortliche_person_information" />
                  </InlineStack>
                }
                requiredIndicator
                value={meta.verantwortliche_person_information ?? ""}
                onChange={(v) => updateMeta("verantwortliche_person_information", v || undefined)}
                placeholder={locale === "en" ? "Name, EU address, email/phone" : locale === "tr" ? "Ad, AB adresi, e-posta/telefon" : "Name, EU-Adresse, E-Mail/Telefon"}
                multiline={2}
              />

              <ComplianceFieldsSection
                client={client}
                categoryId={getMeta(product, "category_id")}
                marketplace="DE"
                locale={locale}
                product={product}
                getMeta={getMeta}
                updateMeta={updateMeta}
              />
            </BlockStack>
            </div>
          </Card>

          <Card>
            <div className="product-edit-sections">
            <BlockStack gap="400">
              <ProductSectionHeading>{locale === "en" ? "Product documents & compliance" : locale === "tr" ? "Ürün belgeleri ve uyumluluk" : locale === "fr" ? "Documents produit & conformité" : locale === "es" ? "Documentos de producto y cumplimiento" : locale === "it" ? "Documenti prodotto e conformità" : "Produktdokumente & Compliance"}</ProductSectionHeading>
              <Text as="p" variant="bodySm" tone="subdued">
                {locale === "en" ? "WEEE registration number, EPREL number and product files (e.g. product data sheet, energy label). Files are shown in the shop below the product description." : locale === "tr" ? "WEEE kayıt numarası, EPREL numarası ve ürün dosyaları (örn. ürün veri sayfası, enerji etiketi). Dosyalar mağazada ürün açıklamasının altında gösterilir." : locale === "fr" ? "Numéro d'enregistrement WEEE, numéro EPREL et fichiers produit (ex. fiche technique, étiquette énergétique). Les fichiers sont affichés dans la boutique sous la description du produit." : locale === "es" ? "Número de registro WEEE, número EPREL y archivos de producto (ej. ficha técnica, etiqueta energética). Los archivos se muestran en la tienda debajo de la descripción del producto." : locale === "it" ? "Numero di registrazione WEEE, numero EPREL e file prodotto (es. scheda tecnica, etichetta energetica). I file vengono mostrati nel negozio sotto la descrizione del prodotto." : "WEEE-Reg.-Nummer, EPREL-Nummer und Produktdateien (z. B. Produktdatenblatt, EEK-Label). Dateien werden im Shop unter der Produktbeschreibung angezeigt."}
              </Text>
              <InlineStack gap="300" wrap>
                <Box minWidth="240px" flex="1">
                  <TextField
                    label="WEEE-Reg.-Nummer"
                    value={getMeta(product, "weee_number") || ""}
                    onChange={(v) => updateMeta("weee_number", v || null)}
                    placeholder="DE12345678"
                    helpText={locale === "en" ? "Electrical waste registration number (ElektroG)" : locale === "tr" ? "Elektronik atık kayıt numarası (ElektroG)" : locale === "fr" ? "Numéro d'enregistrement déchets électroniques (ElektroG)" : locale === "es" ? "Número de registro de residuos eléctricos (ElektroG)" : locale === "it" ? "Numero di registrazione rifiuti elettrici (ElektroG)" : "Elektroaltgeräte-Registrierungsnummer (ElektroG)"}
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="240px" flex="1">
                  <TextField
                    label="EPREL-Nummer"
                    value={getMeta(product, "eprel_number") || ""}
                    onChange={(v) => updateMeta("eprel_number", v || null)}
                    placeholder="123456"
                    helpText={locale === "en" ? "EU energy label registration number" : locale === "tr" ? "AB enerji etiketi kayıt numarası" : locale === "fr" ? "Numéro d'enregistrement étiquette énergie UE" : locale === "es" ? "Número de registro etiqueta energética UE" : locale === "it" ? "Numero di registrazione etichetta energetica UE" : "EU-Energielabel-Registrierungsnummer"}
                    autoComplete="off"
                  />
                </Box>
              </InlineStack>

              {/* Product files */}
              <Text as="h3" variant="bodySm" fontWeight="semibold">{locale === "en" ? "Product files" : locale === "tr" ? "Ürün dosyaları" : locale === "fr" ? "Fichiers produit" : locale === "es" ? "Archivos de producto" : locale === "it" ? "File prodotto" : "Produktdateien"}</Text>
              {productFiles.length > 0 && (
                <BlockStack gap="150">
                  {productFiles.map((file, i) => {
                    const rawUrl = file?.url;
                    const fileUrl = typeof rawUrl === "string" ? rawUrl : (rawUrl?.url || rawUrl?.href || rawUrl?.src || "");
                    const resolvedFileUrl = fileUrl
                      ? (fileUrl.startsWith("http") ? fileUrl : `${getDefaultBaseUrl()}${fileUrl.startsWith("/") ? "" : "/"}${fileUrl}`)
                      : "";
                    const isPdf = fileUrl.toLowerCase().includes(".pdf");
                    return (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb" }}>
                        <span style={{ fontSize: 15, flexShrink: 0 }}>
                          {isPdf ? "📄" : "📎"}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <input
                            type="text"
                            value={file.name || ""}
                            onChange={(e) => updateProductFileName(i, e.target.value)}
                            placeholder={locale === "en" ? "Display name in shop" : locale === "tr" ? "Mağazada görünen ad" : locale === "fr" ? "Nom d'affichage dans la boutique" : locale === "es" ? "Nombre a mostrar en la tienda" : locale === "it" ? "Nome visualizzato nel negozio" : "Anzeigename im Shop"}
                            style={{
                              width: "100%", border: "1px solid #d1d5db", borderRadius: 6,
                              padding: "4px 8px", fontSize: 13, background: "#fff",
                              outline: "none", boxSizing: "border-box",
                            }}
                          />
                          {resolvedFileUrl ? (
                            <a
                              href={resolvedFileUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ fontSize: 11, color: "#6366f1", marginTop: 2, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                            >
                              {resolvedFileUrl}
                            </a>
                          ) : (
                            <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>—</div>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeProductFile(i)}
                          style={{ flexShrink: 0, background: "none", border: "none", cursor: "pointer", color: "#ef4444", fontSize: 16, lineHeight: 1, padding: "2px 4px" }}
                          title={locale === "en" ? "Remove" : locale === "tr" ? "Kaldır" : locale === "fr" ? "Supprimer" : locale === "es" ? "Eliminar" : locale === "it" ? "Rimuovi" : "Entfernen"}
                        >✕</button>
                      </div>
                    );
                  })}
                </BlockStack>
              )}
              {addingFile && (
                <BlockStack gap="200">
                  <TextField
                    label={locale === "en" ? "File URL" : locale === "tr" ? "Dosya URL'si" : locale === "fr" ? "URL du fichier" : locale === "es" ? "URL del archivo" : locale === "it" ? "URL file" : "Datei-URL"}
                    value={newFileUrl}
                    onChange={setNewFileUrl}
                    placeholder="https://example.com/produktdatenblatt.pdf"
                    autoComplete="off"
                  />
                  <TextField
                    label={locale === "en" ? "Display name in shop" : locale === "tr" ? "Mağazada görünen ad" : locale === "fr" ? "Nom d'affichage dans la boutique" : locale === "es" ? "Nombre a mostrar en la tienda" : locale === "it" ? "Nome visualizzato nel negozio" : "Anzeigename im Shop"}
                    value={newFileName}
                    onChange={setNewFileName}
                    placeholder={locale === "en" ? "Product data sheet" : locale === "tr" ? "Ürün veri sayfası" : locale === "fr" ? "Fiche produit" : locale === "es" ? "Ficha técnica" : locale === "it" ? "Scheda tecnica" : "Produktdatenblatt"}
                    autoComplete="off"
                  />
                  <InlineStack gap="200">
                    <Button onClick={handleAddFileUrl} disabled={!newFileUrl.trim()} size="slim" variant="primary">{ui.add}</Button>
                    <Button onClick={() => { setAddingFile(false); setNewFileUrl(""); setNewFileName(""); }} size="slim">{ui.cancel}</Button>
                  </InlineStack>
                </BlockStack>
              )}
              {fileUploadErr && <Text tone="critical" variant="bodySm">{fileUploadErr}</Text>}
              <InlineStack gap="200">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/pdf,image/jpeg,image/png,image/webp"
                  style={{ display: "none" }}
                  onChange={handleFileUpload}
                />
                <Button size="slim" onClick={() => { setFileUploadErr(""); fileInputRef.current?.click(); }} loading={fileUploading}>
                  {locale === "en" ? "Upload file" : locale === "tr" ? "Dosya yükle" : locale === "fr" ? "Télécharger un fichier" : locale === "es" ? "Subir archivo" : locale === "it" ? "Carica file" : "Datei hochladen"}
                </Button>
                {!addingFile && (
                  <Button size="slim" onClick={() => setAddingFile(true)}>
                    {locale === "en" ? "Add URL" : locale === "tr" ? "URL ekle" : locale === "fr" ? "Ajouter une URL" : locale === "es" ? "Agregar URL" : locale === "it" ? "Aggiungi URL" : "URL hinzufügen"}
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
            </div>
          </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
      )}

      {deleteConfirmOpen && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }} onClick={() => setDeleteConfirmOpen(false)}>
          <div style={{ background: "var(--p-color-bg-surface)", padding: 24, borderRadius: 12, maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <Text as="p" variant="bodyMd">{ui.delete} “{product.title}”?</Text>
            <InlineStack gap="200" blockAlign="end">
              <Button onClick={() => setDeleteConfirmOpen(false)}>{ui.cancel}</Button>
              <Button variant="primary" tone="critical" onClick={() => { setDeleteConfirmOpen(false); deleteProduct(); }}>{ui.delete}</Button>
            </InlineStack>
          </div>
        </div>
      )}

      <Modal
        open={duplicateModalOpen}
        onClose={() => setDuplicateModalOpen(false)}
        title={ui.duplicate}
        primaryAction={{
          content: ui.duplicate,
          onAction: runDuplicate,
          loading: duplicateSaving,
        }}
        secondaryActions={[{ content: ui.cancel, onAction: () => setDuplicateModalOpen(false) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text as="p" tone="subdued">
              Choose what to copy into the new product. <strong>SKU and EAN are never copied</strong> and must be set for the new product.
            </Text>
            <BlockStack gap="300">
              <Checkbox
                label={'Title (with "(Copy)" suffix)'}
                checked={duplicateOptions.title}
                onChange={(v) => setDuplicateOptions((o) => ({ ...o, title: v }))}
              />
              <Checkbox
                label="Description"
                checked={duplicateOptions.description}
                onChange={(v) => setDuplicateOptions((o) => ({ ...o, description: v }))}
              />
              <Checkbox
                label="Price"
                checked={duplicateOptions.price}
                onChange={(v) => setDuplicateOptions((o) => ({ ...o, price: v }))}
              />
              <Checkbox
                label="Inventory quantity"
                checked={duplicateOptions.inventory}
                onChange={(v) => setDuplicateOptions((o) => ({ ...o, inventory: v }))}
              />
              <Checkbox
                label="Categories / collection"
                checked={duplicateOptions.categories}
                onChange={(v) => setDuplicateOptions((o) => ({ ...o, categories: v }))}
              />
              <Checkbox
                label="Images / media"
                checked={duplicateOptions.media}
                onChange={(v) => setDuplicateOptions((o) => ({ ...o, media: v }))}
              />
              <Checkbox
                label="Variants (option names and values; SKU/EAN never copied)"
                checked={duplicateOptions.variants}
                onChange={(v) => setDuplicateOptions((o) => ({ ...o, variants: v }))}
              />
            </BlockStack>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
