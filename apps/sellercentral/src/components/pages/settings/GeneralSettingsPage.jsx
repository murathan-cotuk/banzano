"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "@/i18n/navigation";
import { usePathname, Link } from "@/i18n/navigation";
import { useLocale, useTranslations } from "next-intl";
import { userError } from "@/lib/api-error-messages";
import {
  Card,
  Text,
  TextField,
  Button,
  BlockStack,
  InlineStack,
  Box,
  Divider,
  Banner,
  Select,
} from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import MediaPickerModal from "@/components/MediaPickerModal";
import { routing } from "@/i18n/routing";
import { getUI } from "@/lib/ui-strings";

const ALL_SHOP_LOCALES = [
  { code: "en", label: "English" },
  { code: "de", label: "Deutsch" },
  { code: "fr", label: "Français" },
  { code: "it", label: "Italiano" },
  { code: "es", label: "Español" },
  { code: "tr", label: "Türkçe" },
];

function LocaleToggle({ on, onChange, disabled, label }) {
  return (
    <button
      type="button"
      onClick={() => { if (!disabled) onChange(!on); }}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-checked={on}
      role="switch"
      style={{
        width: 46,
        height: 26,
        borderRadius: 13,
        padding: 0,
        background: on ? "#10b981" : "#d1d5db",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        position: "relative",
        transition: "background 0.2s",
        flexShrink: 0,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 3,
          left: on ? 23 : 3,
          width: 20,
          height: 20,
          borderRadius: "50%",
          background: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          transition: "left 0.2s",
        }}
      />
    </button>
  );
}

function SectionLabel({ title, subtitle }) {
  return (
    <BlockStack gap="100">
      <Text as="h2" variant="headingMd">{title}</Text>
      {subtitle ? (
        <Text as="p" tone="subdued" variant="bodySm">{subtitle}</Text>
      ) : null}
    </BlockStack>
  );
}

function parseLegalCity(raw) {
  const s = String(raw || "").trim();
  if (!s) return { postal: "", city: "" };
  const m = s.match(/^(\d{4,5})\s+(.+)$/);
  if (m) return { postal: m[1], city: m[2].trim() };
  return { postal: "", city: s };
}

export default function GeneralSettingsPage() {
  const client = getMedusaAdminClient();
  const router = useRouter();
  const locale = useLocale();
  const ui = getUI(locale || "de");
  const pathname = usePathname() || "/";
  const pathWithoutLocale = pathname.startsWith("/") ? pathname : `/${pathname}`;
  const t = useTranslations("locale");
  const [formData, setFormData] = useState({
    storeName: "",
    phone: "",
    companyName: "",
    taxId: "",
    vatId: "",
    lucidNumber: "",
    eprDocumentUrl: "",
    website: "",
    businessStreet: "",
    businessCity: "",
    businessPostalCode: "",
    businessCountry: "",
    representative: "",
    tradeRegister: "",
    registerCourt: "",
    legalEmail: "",
    documents: [],
  });
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [uploadingDocs, setUploadingDocs] = useState(false);
  const [isSuperuser, setIsSuperuser] = useState(false);
  const [enabledShopLocales, setEnabledShopLocales] = useState(() => ALL_SHOP_LOCALES.map((l) => l.code));
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(false);
  const [maintenanceImageUrl, setMaintenanceImageUrl] = useState("");
  const [maintenanceSaving, setMaintenanceSaving] = useState(false);
  const [maintenanceError, setMaintenanceError] = useState("");
  const [maintenancePickerOpen, setMaintenancePickerOpen] = useState(false);
  const [localesSaving, setLocalesSaving] = useState(false);
  const [localesSaved, setLocalesSaved] = useState(false);
  const [localesError, setLocalesError] = useState("");
  const [uiLocale, setUiLocale] = useState(locale || "de");
  const [localeSaving, setLocaleSaving] = useState(false);

  const copy = {
    pageIntro: locale === "tr"
      ? "Mağaza adı, şirket ve yasal bilgiler. Adresler (depo / iade / fatura) Ayarlar → Konumlar’da yönetilir."
      : locale === "en"
        ? "Store name, company and legal details. Addresses (warehouse / returns / billing) are managed under Settings → Locations."
        : "Shopname, Firmen- und Rechtsdaten. Adressen (Lager / Retoure / Rechnung) verwalten Sie unter Einstellungen → Standorte.",
    storeCard: locale === "tr" ? "Mağaza" : locale === "en" ? "Store" : "Shop",
    storeCardSub: locale === "tr"
      ? "Shop’ta ürün sayfalarında Verkäufer olarak görünür."
      : locale === "en"
        ? "Shown as Verkäufer on product pages in the shop."
        : "Wird im Shop auf Produktseiten als Verkäufer angezeigt.",
    companyCard: isSuperuser
      ? (locale === "tr" ? "Şirket & platform işletmecisi" : locale === "en" ? "Company & platform operator" : "Firma & Plattformbetreiber")
      : (locale === "tr" ? "Şirket bilgileri" : locale === "en" ? "Company details" : "Firmendaten"),
    companyCardSub: isSuperuser
      ? (locale === "tr"
        ? "Tek form: satıcı hesabı ve platform Impressum / sözleşme PDF’i aynı kaynaktan beslenir."
        : locale === "en"
          ? "One form feeds both your seller account and the platform Impressum / seller-agreement PDF."
          : "Ein Formular speist Konto und Plattform-Impressum / Seller-Agreement-PDF.")
      : (locale === "tr"
        ? "Yasal şirket adı, vergi bilgileri ve kayıtlı iş adresi."
        : locale === "en"
          ? "Legal company name, tax details and registered business address."
          : "Rechtlicher Firmenname, Steuerdaten und eingetragene Geschäftsadresse."),
    identity: locale === "tr" ? "Kimlik" : locale === "en" ? "Identity" : "Identität",
    address: locale === "tr" ? "Kayıtlı iş adresi" : locale === "en" ? "Registered business address" : "Eingetragene Geschäftsadresse",
    register: locale === "tr" ? "Ticaret sicili" : locale === "en" ? "Trade register" : "Handelsregister",
    contact: locale === "tr" ? "İletişim" : locale === "en" ? "Contact" : "Kontakt",
    compliance: locale === "de" ? "Verpackungsgesetz (LUCID / EPR)" : locale === "tr" ? "Ambalaj Geri Dönüşüm (LUCID / EPR)" : "Packaging Recycling (LUCID / EPR)",
    complianceSub: locale === "de"
      ? "Pflichtangabe nach VerpackG. Ohne gültige LUCID-Registrierung keine Listings auf DE-Marktplätzen."
      : locale === "tr"
        ? "VerpackG gereği zorunlu. Geçerli LUCID olmadan Almanya’da ürün listelenemez."
        : "Required under VerpackG. Without valid LUCID you cannot list on DE marketplaces.",
    docs: locale === "tr" ? "Şirket belgeleri" : locale === "en" ? "Company documents" : "Firmendokumente",
    docsSub: locale === "tr"
      ? "Ticaret sicili, vergi belgesi vb. yükleyin."
      : locale === "en"
        ? "Upload trade license, tax certificate, registration documents, etc."
        : "Handelsregister, Steuerbescheinigung, Registrierungsunterlagen usw. hochladen.",
    locationsNote: locale === "tr"
      ? "Depo, iade ve fatura adresleri →"
      : locale === "en"
        ? "Warehouse, returns and billing addresses →"
        : "Lager-, Retouren- und Rechnungsadressen →",
    locationsLink: locale === "tr" ? "Konumlar" : locale === "en" ? "Locations" : "Standorte",
    managingDirector: locale === "de" ? "Vertreten durch (Geschäftsführer)" : locale === "tr" ? "Yetkili kişi (Geschäftsführer)" : "Managing Director",
    tradeReg: locale === "de" ? "Handelsregisternummer" : locale === "tr" ? "Ticaret sicil no." : "Trade Register No.",
    regCourt: locale === "de" ? "Registergericht" : locale === "tr" ? "Sicil mahkemesi" : "Registry Court",
    legalEmail: locale === "tr" ? "Yasal / Impressum e-posta" : locale === "en" ? "Legal / Impressum email" : "Rechtliche / Impressum-E-Mail",
    ibanNote: locale === "de"
      ? "IBAN und Bankverbindung: Einstellungen → Zahlungen."
      : locale === "tr"
        ? "IBAN ve banka bilgileri: Ayarlar → Ödemeler."
        : "IBAN and bank details: Settings → Payments.",
  };

  useEffect(() => {
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 8000);
    const load = async () => {
      try {
        const isSuLs = typeof window !== "undefined" ? localStorage.getItem("sellerIsSuperuser") === "true" : false;
        const [data, accountData] = await Promise.all([
          client.getSellerSettings(),
          client.getSellerAccount().catch(() => ({})),
        ]);
        const isSu = accountData?.sellerUser?.is_superuser === true || accountData?.is_superuser === true || isSuLs;
        if (!cancelled) setIsSuperuser(isSu);

        let platData = {};
        if (isSu) {
          platData = await client.getSellerSettings("default").catch(() => ({}));
          const enabled = Array.isArray(platData.enabled_shop_locales) && platData.enabled_shop_locales.length
            ? platData.enabled_shop_locales.map((c) => String(c).toLowerCase())
            : ALL_SHOP_LOCALES.map((l) => l.code);
          if (!cancelled) {
            setEnabledShopLocales(ALL_SHOP_LOCALES.map((l) => l.code).filter((c) => enabled.includes(c)));
            setMaintenanceEnabled(platData.maintenance_mode_enabled === true);
            setMaintenanceImageUrl(platData.maintenance_mode_image_url || "");
          }
        }

        if (!cancelled) {
          const preferred = String(data?.locale || "").toLowerCase();
          if (routing.locales.includes(preferred)) {
            setUiLocale(preferred);
            try { localStorage.setItem("sellerLocale", preferred); } catch (_) {}
          }

          const sellerUser = accountData?.sellerUser || data?.sellerUser || data?.seller || {};
          const businessAddress = sellerUser.business_address || {};
          const documents = Array.isArray(sellerUser.documents) ? sellerUser.documents : [];
          const legalCityParsed = parseLegalCity(platData.legal_city);

          // One source of truth: prefer platform legal_* when present (superuser), else seller company fields
          const companyName = (isSu && platData.legal_company_name) || sellerUser.company_name || "";
          const taxId = (isSu && platData.legal_tax_id) || sellerUser.tax_id || "";
          const vatId = (isSu && platData.legal_vat_id) || sellerUser.vat_id || "";
          const businessStreet = (isSu && platData.legal_street) || businessAddress.street || "";
          const businessPostalCode = (isSu && legalCityParsed.postal) || businessAddress.postal_code || "";
          const businessCity = (isSu && legalCityParsed.city) || businessAddress.city || "";
          const businessCountry = businessAddress.country || "";

          setFormData((prev) => ({
            ...prev,
            storeName: data.store_name || "",
            phone: sellerUser.phone || "",
            companyName,
            taxId,
            vatId,
            lucidNumber: sellerUser.lucid_number || "",
            eprDocumentUrl: sellerUser.epr_document_url || "",
            website: sellerUser.website || "",
            businessStreet,
            businessCity,
            businessPostalCode,
            businessCountry,
            representative: platData.legal_representative || "",
            tradeRegister: platData.legal_trade_register || "",
            registerCourt: platData.legal_register_court || "",
            legalEmail: platData.legal_email || "",
            documents,
          }));
        }
      } catch (_) {
        if (!cancelled) {
          setFormData((prev) => ({
            ...prev,
            storeName: typeof window !== "undefined" ? (localStorage.getItem("storeName") || "") : "",
          }));
        }
      } finally {
        if (!cancelled) {
          clearTimeout(timeout);
          setLoading(false);
        }
      }
    };
    load();
    return () => { cancelled = true; clearTimeout(timeout); };
  }, []);

  const handleSubmit = async (e) => {
    e?.preventDefault?.();
    setSaveError("");
    setSaving(true);
    try {
      await client.updateSellerSettings({ store_name: formData.storeName.trim() });
      await client.updateSellerCompanyInfo({
        company_name: formData.companyName.trim() || null,
        tax_id: formData.taxId.trim() || null,
        vat_id: formData.vatId.trim() || null,
        lucid_number: formData.lucidNumber.trim() || null,
        epr_document_url: formData.eprDocumentUrl.trim() || null,
        phone: formData.phone.trim() || null,
        website: formData.website.trim() || null,
        documents: Array.isArray(formData.documents) ? formData.documents : [],
        business_address: {
          street: formData.businessStreet.trim() || "",
          city: formData.businessCity.trim() || "",
          postal_code: formData.businessPostalCode.trim() || "",
          country: formData.businessCountry.trim() || "",
        },
      });

      // Superuser: same values also become platform Impressum / agreement PDF source
      if (isSuperuser) {
        const legalCity = [formData.businessPostalCode.trim(), formData.businessCity.trim()].filter(Boolean).join(" ");
        await client.updateSellerSettings({
          seller_id: "default",
          legal_company_name: formData.companyName.trim() || "",
          legal_representative: formData.representative.trim() || "",
          legal_street: formData.businessStreet.trim() || "",
          legal_city: legalCity,
          legal_trade_register: formData.tradeRegister.trim() || "",
          legal_register_court: formData.registerCourt.trim() || "",
          legal_vat_id: formData.vatId.trim() || "",
          legal_tax_id: formData.taxId.trim() || "",
          legal_email: formData.legalEmail.trim() || "",
        });
      }

      const newName = formData.storeName.trim();
      if (typeof window !== "undefined" && newName) {
        localStorage.setItem("storeName", newName);
        window.dispatchEvent(new CustomEvent("sellerStoreNameChanged", { detail: { storeName: newName } }));
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveError(userError(err, locale, "Failed to save settings."));
    } finally {
      setSaving(false);
    }
  };

  const handleLocaleToggle = async (code, nextOn) => {
    if (!isSuperuser) return;
    const prev = enabledShopLocales;
    let next;
    if (nextOn) {
      next = ALL_SHOP_LOCALES.map((l) => l.code).filter((c) => c === code || prev.includes(c));
    } else {
      next = prev.filter((c) => c !== code);
      if (!next.length) {
        setLocalesError(
          locale === "tr"
            ? "En az bir dil açık kalmalı."
            : locale === "en"
              ? "At least one language must stay enabled."
              : "Mindestens eine Sprache muss aktiv bleiben.",
        );
        return;
      }
    }
    setLocalesError("");
    setEnabledShopLocales(next);
    setLocalesSaving(true);
    try {
      await client.updateSellerSettings({ seller_id: "default", enabled_shop_locales: next });
      setLocalesSaved(true);
      setTimeout(() => setLocalesSaved(false), 2500);
      try {
        const shopOrigin = (typeof window !== "undefined" && window.location?.origin?.includes("localhost"))
          ? (process.env.NEXT_PUBLIC_SHOP_URL || "http://localhost:3000")
          : (process.env.NEXT_PUBLIC_SHOP_URL || "");
        if (shopOrigin) {
          fetch(`${shopOrigin.replace(/\/$/, "")}/api/store-seller-settings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ seller_id: "default" }),
          }).catch(() => {});
        }
      } catch (_) {}
    } catch (err) {
      setEnabledShopLocales(prev);
      setLocalesError(err?.message || ui.saveError);
    } finally {
      setLocalesSaving(false);
    }
  };

  const bustShopSettingsCache = () => {
    try {
      const shopOrigin = (typeof window !== "undefined" && window.location?.origin?.includes("localhost"))
        ? (process.env.NEXT_PUBLIC_SHOP_URL || "http://localhost:3000")
        : (process.env.NEXT_PUBLIC_SHOP_URL || "");
      if (shopOrigin) {
        fetch(`${shopOrigin.replace(/\/$/, "")}/api/store-seller-settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seller_id: "default" }),
        }).catch(() => {});
      }
    } catch (_) {}
  };

  const handleMaintenanceToggle = async (nextOn) => {
    if (!isSuperuser) return;
    const prev = maintenanceEnabled;
    setMaintenanceEnabled(nextOn);
    setMaintenanceError("");
    setMaintenanceSaving(true);
    try {
      await client.updateSellerSettings({ seller_id: "default", maintenance_mode_enabled: nextOn });
      bustShopSettingsCache();
    } catch (err) {
      setMaintenanceEnabled(prev);
      setMaintenanceError(err?.message || ui.saveError);
    } finally {
      setMaintenanceSaving(false);
    }
  };

  const handleMaintenanceImageSelect = async (urls) => {
    const url = urls?.[0];
    if (!url) return;
    setMaintenancePickerOpen(false);
    const prev = maintenanceImageUrl;
    setMaintenanceImageUrl(url);
    setMaintenanceError("");
    setMaintenanceSaving(true);
    try {
      await client.updateSellerSettings({ seller_id: "default", maintenance_mode_image_url: url });
      bustShopSettingsCache();
    } catch (err) {
      setMaintenanceImageUrl(prev);
      setMaintenanceError(err?.message || ui.saveError);
    } finally {
      setMaintenanceSaving(false);
    }
  };

  const handleDocumentUpload = async (files) => {
    if (!files?.length) return;
    setUploadingDocs(true);
    setSaveError("");
    try {
      const arr = Array.from(files);
      const uploaded = [];
      for (const file of arr) {
        const fd = new FormData();
        fd.append("file", file);
        const result = await client.uploadMedia(fd);
        if (result?.url) {
          uploaded.push({
            name: file.name,
            url: result.url,
            mime_type: file.type || "",
            size: file.size || 0,
            uploaded_at: new Date().toISOString(),
          });
        }
      }
      if (uploaded.length) {
        setFormData((p) => ({ ...p, documents: [...(p.documents || []), ...uploaded] }));
      }
    } catch (err) {
      setSaveError(userError(err, locale, "Document upload failed."));
    } finally {
      setUploadingDocs(false);
    }
  };

  const removeDocument = (idx) => {
    setFormData((p) => ({ ...p, documents: (p.documents || []).filter((_, i) => i !== idx) }));
  };

  const handleLanguageChange = async (value) => {
    const next = String(value || "").toLowerCase();
    if (!routing.locales.includes(next) || next === uiLocale) return;
    setUiLocale(next);
    setLocaleSaving(true);
    setSaveError("");
    try {
      await client.updateSellerSettings({ locale: next });
      try { localStorage.setItem("sellerLocale", next); } catch (_) {}
      const base =
        pathWithoutLocale === "/" || !pathWithoutLocale
          ? "/settings/general"
          : pathWithoutLocale.startsWith("/")
            ? pathWithoutLocale
            : `/${pathWithoutLocale}`;
      router.push(base, { locale: next });
    } catch (err) {
      setUiLocale(locale || "de");
      setSaveError(userError(err, locale, "Could not save language preference."));
    } finally {
      setLocaleSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <BlockStack gap="200">
          <Text as="p" tone="subdued">{ui.loading || "Loading…"}</Text>
        </BlockStack>
      </Card>
    );
  }

  return (
    <BlockStack gap="400">
      <Text as="p" tone="subdued">{copy.pageIntro}</Text>
      {saved && (
        <Banner tone="success" onDismiss={() => setSaved(false)}>
          {ui.savedSuccess || "Settings saved successfully."}
        </Banner>
      )}
      {saveError && (
        <Banner tone="critical" onDismiss={() => setSaveError("")}>
          {saveError}
        </Banner>
      )}

      <Card>
        <BlockStack gap="300">
          <SectionLabel
            title={locale === "tr" ? "Arayüz dili" : locale === "en" ? "Interface language" : "Sprache der Benutzeroberfläche"}
            subtitle={locale === "tr"
              ? "Sellercentral dil tercihi hesabınıza kaydedilir."
              : locale === "en"
                ? "Sellercentral language preference is saved to your account."
                : "Die Sellercentral-Spracheinstellung wird in Ihrem Konto gespeichert."}
          />
          <Box maxWidth="320px">
            <Select
              label={locale === "tr" ? "Dil" : locale === "en" ? "Language" : "Sprache"}
              labelHidden
              options={routing.locales.map((loc) => ({ label: t(loc), value: loc }))}
              value={uiLocale}
              onChange={handleLanguageChange}
              disabled={localeSaving}
            />
          </Box>
        </BlockStack>
      </Card>

      <form onSubmit={handleSubmit}>
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="400">
              <SectionLabel title={copy.storeCard} subtitle={copy.storeCardSub} />
              <TextField
                label={ui.storeName || "Store name"}
                value={formData.storeName}
                onChange={(v) => setFormData((p) => ({ ...p, storeName: v }))}
                placeholder="e.g. Mein Shop"
                autoComplete="organization"
              />
              <InlineStack gap="300" wrap>
                <Box minWidth="200px" width="100%">
                  <TextField
                    label={ui.phone || "Phone"}
                    type="tel"
                    value={formData.phone}
                    onChange={(v) => setFormData((p) => ({ ...p, phone: v }))}
                    placeholder="+49 …"
                    autoComplete="tel"
                  />
                </Box>
                <Box minWidth="200px" width="100%">
                  <TextField
                    label="Website"
                    value={formData.website}
                    onChange={(v) => setFormData((p) => ({ ...p, website: v }))}
                    placeholder="https://..."
                    autoComplete="url"
                  />
                </Box>
              </InlineStack>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <SectionLabel title={copy.companyCard} subtitle={copy.companyCardSub} />

              <Text as="h3" variant="headingSm">{copy.identity}</Text>
              <TextField
                label={ui.companyName || "Company legal name"}
                value={formData.companyName}
                onChange={(v) => setFormData((p) => ({ ...p, companyName: v }))}
                placeholder={isSuperuser ? "Andertal GmbH" : "Legal company name"}
                autoComplete="organization"
              />
              {isSuperuser && (
                <TextField
                  label={copy.managingDirector}
                  value={formData.representative}
                  onChange={(v) => setFormData((p) => ({ ...p, representative: v }))}
                  placeholder="First Last"
                  autoComplete="name"
                />
              )}
              <InlineStack gap="300" wrap>
                <Box minWidth="180px">
                  <TextField
                    label={ui.taxId || "Tax ID"}
                    value={formData.taxId}
                    onChange={(v) => setFormData((p) => ({ ...p, taxId: v }))}
                    autoComplete="off"
                  />
                </Box>
                <Box minWidth="180px">
                  <TextField
                    label={ui.vatId || "USt-IdNr. / VAT ID"}
                    value={formData.vatId}
                    onChange={(v) => setFormData((p) => ({ ...p, vatId: v }))}
                    autoComplete="off"
                    helpText="z.B. DE123456789"
                  />
                </Box>
              </InlineStack>
              <Text as="p" tone="subdued" variant="bodySm">{copy.ibanNote}</Text>

              <Divider />
              <Text as="h3" variant="headingSm">{copy.address}</Text>
              <TextField
                label={ui.address || "Street"}
                value={formData.businessStreet}
                onChange={(v) => setFormData((p) => ({ ...p, businessStreet: v }))}
                autoComplete="street-address"
              />
              <InlineStack gap="300" wrap>
                <Box minWidth="120px">
                  <TextField
                    label={ui.postalCode || "Postal code"}
                    value={formData.businessPostalCode}
                    onChange={(v) => setFormData((p) => ({ ...p, businessPostalCode: v }))}
                    autoComplete="postal-code"
                  />
                </Box>
                <Box minWidth="160px">
                  <TextField
                    label={locale === "de" ? "Stadt" : locale === "tr" ? "Şehir" : "City"}
                    value={formData.businessCity}
                    onChange={(v) => setFormData((p) => ({ ...p, businessCity: v }))}
                    autoComplete="address-level2"
                  />
                </Box>
                <Box minWidth="140px">
                  <TextField
                    label={locale === "de" ? "Land" : locale === "tr" ? "Ülke" : "Country"}
                    value={formData.businessCountry}
                    onChange={(v) => setFormData((p) => ({ ...p, businessCountry: v }))}
                    autoComplete="country-name"
                  />
                </Box>
              </InlineStack>
              <Banner tone="info">
                <p>
                  {copy.locationsNote}{" "}
                  <Link href="/settings/locations" style={{ fontWeight: 600, textDecoration: "underline" }}>
                    {copy.locationsLink}
                  </Link>
                </p>
              </Banner>

              {isSuperuser && (
                <>
                  <Divider />
                  <Text as="h3" variant="headingSm">{copy.register}</Text>
                  <InlineStack gap="300" wrap>
                    <Box minWidth="200px" width="100%">
                      <TextField
                        label={copy.tradeReg}
                        value={formData.tradeRegister}
                        onChange={(v) => setFormData((p) => ({ ...p, tradeRegister: v }))}
                        placeholder="HRB XXXXX"
                        autoComplete="off"
                      />
                    </Box>
                    <Box minWidth="200px" width="100%">
                      <TextField
                        label={copy.regCourt}
                        value={formData.registerCourt}
                        onChange={(v) => setFormData((p) => ({ ...p, registerCourt: v }))}
                        placeholder="Amtsgericht Düsseldorf"
                        autoComplete="off"
                      />
                    </Box>
                  </InlineStack>
                  <Text as="h3" variant="headingSm">{copy.contact}</Text>
                  <TextField
                    label={copy.legalEmail}
                    value={formData.legalEmail}
                    onChange={(v) => setFormData((p) => ({ ...p, legalEmail: v }))}
                    placeholder="info@andertal.com"
                    autoComplete="email"
                    type="email"
                    helpText={ui.adminInfoNote}
                  />
                </>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <SectionLabel title={copy.compliance} subtitle={copy.complianceSub} />
              <Box maxWidth="320px">
                <TextField
                  label={locale === "de" ? "LUCID-Registrierungsnummer" : locale === "tr" ? "LUCID Kayıt Numarası" : "LUCID Registration Number"}
                  value={formData.lucidNumber}
                  onChange={(v) => setFormData((p) => ({ ...p, lucidNumber: v }))}
                  placeholder="DE1234567890123"
                  autoComplete="off"
                />
              </Box>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <SectionLabel title={copy.docs} subtitle={copy.docsSub} />
              <input
                type="file"
                multiple
                accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
                onChange={(e) => { handleDocumentUpload(e.target.files); e.target.value = ""; }}
                disabled={uploadingDocs}
              />
              {uploadingDocs && <Text as="p" tone="subdued">Uploading documents…</Text>}
              {(formData.documents || []).length > 0 && (
                <BlockStack gap="100">
                  {formData.documents.map((doc, idx) => (
                    <InlineStack key={`${doc.url || doc.name}-${idx}`} align="space-between" blockAlign="center">
                      <a href={doc.url} target="_blank" rel="noreferrer" style={{ fontSize: 13, textDecoration: "underline" }}>
                        {doc.name || doc.url}
                      </a>
                      <Button size="slim" variant="plain" tone="critical" onClick={() => removeDocument(idx)}>
                        {ui.delete || "Remove"}
                      </Button>
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>

          <InlineStack gap="200">
            <Button submit variant="primary" loading={saving}>
              {ui.save || "Save"}
            </Button>
          </InlineStack>
        </BlockStack>
      </form>

      {isSuperuser && (
        <Card>
          <BlockStack gap="400">
            <SectionLabel
              title={locale === "tr" ? "Website dilleri" : locale === "en" ? "Website languages" : "Website-Sprachen"}
              subtitle={locale === "tr"
                ? "Shop’ta gösterilecek dilleri aç/kapa."
                : locale === "en"
                  ? "Toggle which languages appear on the shop."
                  : "Sprachen für den Shop ein-/ausschalten."}
            />
            <BlockStack gap="300">
              {ALL_SHOP_LOCALES.map((l) => {
                const on = enabledShopLocales.includes(l.code);
                return (
                  <InlineStack key={l.code} align="space-between" blockAlign="center" wrap={false}>
                    <Text as="span" variant="bodyMd">
                      {l.label}{" "}
                      <Text as="span" tone="subdued" variant="bodySm">
                        ({l.code.toUpperCase()})
                      </Text>
                    </Text>
                    <LocaleToggle
                      on={on}
                      disabled={localesSaving || (on && enabledShopLocales.length <= 1)}
                      label={`${l.label} ${on ? "on" : "off"}`}
                      onChange={(v) => handleLocaleToggle(l.code, v)}
                    />
                  </InlineStack>
                );
              })}
            </BlockStack>
            {localesError && <Banner tone="critical"><p>{localesError}</p></Banner>}
            {localesSaved && !localesError && (
              <Banner tone="success">
                <p>{ui.savedSuccess}</p>
              </Banner>
            )}
          </BlockStack>
        </Card>
      )}

      {isSuperuser && (
        <Card>
          <BlockStack gap="400">
            <SectionLabel
              title={locale === "tr" ? "Bakım modu (Coming soon)" : locale === "en" ? "Maintenance mode (Coming soon)" : "Wartungsmodus (Coming soon)"}
              subtitle={locale === "tr"
                ? "Açıldığında shop'taki tüm sayfalar seçilen görselle tam ekran kaplanır."
                : locale === "en"
                  ? "When on, every page on the shop is covered full-screen by the selected image."
                  : "Wenn aktiviert, wird jede Shop-Seite vollflächig vom ausgewählten Bild überdeckt."}
            />
            <InlineStack align="space-between" blockAlign="center" wrap={false}>
              <Text as="span" variant="bodyMd">
                {locale === "tr" ? "Siteyi duraklat" : locale === "en" ? "Pause the site" : "Website pausieren"}
              </Text>
              <LocaleToggle
                on={maintenanceEnabled}
                disabled={maintenanceSaving}
                label="maintenance mode"
                onChange={handleMaintenanceToggle}
              />
            </InlineStack>
            <BlockStack gap="200">
              <Text as="span" variant="bodyMd">
                {locale === "tr" ? "Görsel" : locale === "en" ? "Image" : "Bild"}
              </Text>
              {maintenanceImageUrl ? (
                <img
                  src={maintenanceImageUrl}
                  alt=""
                  style={{ width: "100%", maxWidth: 320, borderRadius: 8, border: "1px solid #e5e7eb", display: "block" }}
                />
              ) : (
                <Text as="p" tone="subdued" variant="bodySm">
                  {locale === "tr" ? "Henüz görsel seçilmedi." : locale === "en" ? "No image selected yet." : "Noch kein Bild ausgewählt."}
                </Text>
              )}
              <InlineStack gap="200">
                <Button onClick={() => setMaintenancePickerOpen(true)} disabled={maintenanceSaving}>
                  {locale === "tr" ? "Görsel seç" : locale === "en" ? "Choose image" : "Bild auswählen"}
                </Button>
              </InlineStack>
            </BlockStack>
            {maintenanceError && <Banner tone="critical"><p>{maintenanceError}</p></Banner>}
            <MediaPickerModal
              open={maintenancePickerOpen}
              onClose={() => setMaintenancePickerOpen(false)}
              multiple={false}
              onSelect={handleMaintenanceImageSelect}
            />
          </BlockStack>
        </Card>
      )}
    </BlockStack>
  );
}
