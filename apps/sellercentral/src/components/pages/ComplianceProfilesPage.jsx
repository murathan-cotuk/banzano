"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Banner, Select, Button, Box, Spinner, TextField } from "@shopify/polaris";
import CategoryDrilldownSelect from "@/components/inputs/CategoryDrilldownSelect";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";

// Per-category compliance profile override (follow-up to docs/HUKUKI.md's automatic keyword-based
// assignment, which isn't always right — e.g. a subcategory like "washing machines" may need a
// different profile than its parent "electronics"). Inheritance from the nearest ancestor stays
// the default; this page only lets a superuser correct the exception cases.
function localizedLabel(i18n, locale, fallback) {
  if (i18n && typeof i18n === "object") {
    if (locale && i18n[locale]) return i18n[locale];
    if (i18n.de) return i18n.de;
  }
  return fallback;
}

const INHERIT_VALUE = "__inherit__";

const copy = (locale) => {
  const t = (en, tr, de) => (locale === "en" ? en : locale === "tr" ? tr : de);
  return {
    title: t("Compliance profiles", "Uyumluluk profilleri", "Compliance-Profile"),
    subtitle: t(
      "Every category was auto-assigned a compliance profile (docs/HUKUKI.md). That assignment isn't always right — use this page to override a specific category without affecting its siblings.",
      "Her kategoriye otomatik olarak bir uyumluluk profili atandı. Bu atama her zaman doğru değildir — bu sayfayı belirli bir kategoriyi, kardeşlerini etkilemeden düzeltmek için kullanın.",
      "Jeder Kategorie wurde automatisch ein Compliance-Profil zugewiesen. Diese Zuordnung ist nicht immer korrekt — nutzen Sie diese Seite, um eine bestimmte Kategorie zu korrigieren, ohne die Geschwisterkategorien zu beeinflussen.",
    ),
    overviewTitle: t("All categories", "Tüm kategoriler", "Alle Kategorien"),
    searchPlaceholder: t("Search category…", "Kategori ara…", "Kategorie suchen…"),
    filterAll: t("All", "Tümü", "Alle"),
    filterOwn: t("Own override", "Kendi ayarı", "Eigene Einstellung"),
    filterInherited: t("Inherited", "Miras alınan", "Geerbt"),
    filterDefault: t("No coverage (default)", "Kapsam yok (varsayılan)", "Keine Zuweisung (Standard)"),
    colCategory: t("Category", "Kategori", "Kategorie"),
    colProfile: t("Effective profile", "Geçerli profil", "Wirksames Profil"),
    colStatus: t("Status", "Durum", "Status"),
    resultCount: (n, total) => t(`${n} of ${total}`, `${total} kategoriden ${n}`, `${n} von ${total}`),
    overviewLoadError: t("Could not load the category overview.", "Kategori genel görünümü yüklenemedi.", "Kategorieübersicht konnte nicht geladen werden."),
    pickCategory: t("Category", "Kategori", "Kategorie"),
    pickPlaceholder: t("Search or browse a category…", "Bir kategori arayın veya gezinin…", "Kategorie suchen oder durchsuchen…"),
    currentProfile: t("Effective profile", "Geçerli profil", "Wirksames Profil"),
    ownOverride: t("This category's own setting", "Bu kategorinin kendi ayarı", "Eigene Einstellung dieser Kategorie"),
    inheritOption: t("— Inherit from parent category —", "— Üst kategoriden miras al —", "— Von übergeordneter Kategorie erben —"),
    inheritedBadge: t("Inherited", "Miras alınıyor", "Geerbt"),
    ownBadge: t("Own setting", "Kendi ayarı", "Eigene Einstellung"),
    defaultBadge: t("No coverage (default profile)", "Kapsam yok (varsayılan profil)", "Keine Zuweisung (Standardprofil)"),
    requiredFields: t("Required fields for this category right now", "Bu kategori için şu an zorunlu alanlar", "Aktuell für diese Kategorie erforderliche Felder"),
    save: t("Save", "Kaydet", "Speichern"),
    saved: t("Saved.", "Kaydedildi.", "Gespeichert."),
    saveError: t("Could not save.", "Kaydedilemedi.", "Konnte nicht gespeichert werden."),
    loadError: t("Could not load categories.", "Kategoriler yüklenemedi.", "Kategorien konnten nicht geladen werden."),
    selectFirst: t("Select a category above to see and change its compliance profile.", "Uyumluluk profilini görmek ve değiştirmek için yukarıdan bir kategori seçin.", "Wählen Sie oben eine Kategorie, um deren Compliance-Profil zu sehen und zu ändern."),
  };
};

const STATUS_TONE = { own: "success", inherited: "info", default: "attention" };

function SortableHeader({ label, field, sort, onSort }) {
  const active = sort.field === field;
  return (
    <th
      role="button"
      tabIndex={0}
      onClick={() => onSort(field)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSort(field); } }}
      style={{
        padding: "10px 16px",
        fontSize: 11,
        fontWeight: 700,
        color: active ? "#111827" : "#6d7175",
        textTransform: "uppercase",
        borderBottom: "1px solid #e1e3e5",
        cursor: "pointer",
        userSelect: "none",
        whiteSpace: "nowrap",
      }}
    >
      {label} {active ? (sort.dir === "asc" ? "▲" : "▼") : ""}
    </th>
  );
}

export default function ComplianceProfilesPage() {
  const locale = useLocale();
  const router = useRouter();
  const c = copy(locale);
  const [isSuperuser, setIsSuperuser] = useState(null);
  const [categories, setCategories] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loadError, setLoadError] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [schema, setSchema] = useState(null); // resolved compliance-schema for categoryId
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState(INHERIT_VALUE);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });

  // Overview table (all categories at once) — separate from the single-category editor below.
  const [overview, setOverview] = useState(null); // null = loading
  const [overviewError, setOverviewError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [sort, setSort] = useState({ field: "category", dir: "asc" });

  const loadOverview = () => {
    setOverview(null);
    setOverviewError("");
    getMedusaAdminClient().getComplianceOverview()
      .then((d) => setOverview(d.categories || []))
      .catch(() => { setOverview([]); setOverviewError(c.overviewLoadError); });
  };

  useEffect(() => {
    const su = typeof window !== "undefined" && localStorage.getItem("sellerIsSuperuser") === "true";
    setIsSuperuser(su);
    if (!su) { router.replace("/"); return; }
    const client = getMedusaAdminClient();
    Promise.all([client.getAdminHubCategories(), client.getComplianceProfiles()])
      .then(([catRes, profRes]) => {
        setCategories(catRes.categories || []);
        setProfiles(profRes.profiles || []);
      })
      .catch(() => setLoadError(c.loadError));
    loadOverview();
  }, []);

  useEffect(() => {
    if (!categoryId) { setSchema(null); return; }
    setSchemaLoading(true);
    setMessage({ type: "", text: "" });
    getMedusaAdminClient().getCategoryComplianceSchema(categoryId)
      .then((data) => {
        setSchema(data);
        setSelectedProfile(data?.own_profile_id || INHERIT_VALUE);
      })
      .catch(() => setSchema(null))
      .finally(() => setSchemaLoading(false));
  }, [categoryId]);

  const profileOptions = useMemo(() => [
    { label: c.inheritOption, value: INHERIT_VALUE },
    ...profiles.map((p) => ({ label: localizedLabel(p.label_i18n, locale, p.label), value: p.id })),
  ], [profiles, locale, c.inheritOption]);

  const requiredFieldLabels = useMemo(() => {
    if (!schema?.required_fields) return [];
    return schema.required_fields.map((key) => ({
      key,
      label: localizedLabel(schema.field_definitions?.[key]?.label_i18n, locale, key),
    }));
  }, [schema, locale]);

  const handleSave = async () => {
    setSaving(true);
    setMessage({ type: "", text: "" });
    try {
      const nextProfileId = selectedProfile === INHERIT_VALUE ? null : selectedProfile;
      await getMedusaAdminClient().setCategoryComplianceProfile(categoryId, nextProfileId);
      const fresh = await getMedusaAdminClient().getCategoryComplianceSchema(categoryId);
      setSchema(fresh);
      setMessage({ type: "success", text: c.saved });
      loadOverview(); // this category's row (and any children inheriting from it) may have changed
    } catch (e) {
      setMessage({ type: "error", text: e?.message || c.saveError });
    }
    setSaving(false);
  };

  const statusFilterOptions = [
    { label: c.filterAll, value: "" },
    { label: c.filterOwn, value: "own" },
    { label: c.filterInherited, value: "inherited" },
    { label: c.filterDefault, value: "default" },
  ];

  const handleSort = (field) => {
    setSort((prev) => (prev.field === field ? { field, dir: prev.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" }));
  };

  const visibleOverview = useMemo(() => {
    if (!Array.isArray(overview)) return [];
    const q = search.trim().toLowerCase();
    let list = overview.filter((row) => {
      if (statusFilter && row.resolved_from !== statusFilter) return false;
      if (q && !(row.name || "").toLowerCase().includes(q)) return false;
      return true;
    });
    list = [...list].sort((a, b) => {
      let va;
      let vb;
      if (sort.field === "profile") {
        va = localizedLabel(a.effective_profile_label_i18n, locale, a.effective_profile_id || "").toLowerCase();
        vb = localizedLabel(b.effective_profile_label_i18n, locale, b.effective_profile_id || "").toLowerCase();
      } else if (sort.field === "status") {
        va = a.resolved_from || "";
        vb = b.resolved_from || "";
      } else {
        va = (a.name || "").toLowerCase();
        vb = (b.name || "").toLowerCase();
      }
      if (va < vb) return sort.dir === "asc" ? -1 : 1;
      if (va > vb) return sort.dir === "asc" ? 1 : -1;
      return 0;
    });
    return list;
  }, [overview, search, statusFilter, sort, locale]);

  const statusBadge = (row) => {
    const label = row.resolved_from === "own" ? c.ownBadge : row.resolved_from === "inherited" ? c.inheritedBadge : c.defaultBadge;
    return <Badge tone={STATUS_TONE[row.resolved_from] || "info"}>{label}</Badge>;
  };

  if (!isSuperuser) return null;

  return (
    <Page title={c.title}>
      <BlockStack gap="400">
        <Text as="p" tone="subdued">{c.subtitle}</Text>
        {loadError && <Banner tone="critical">{loadError}</Banner>}

        {/* ── Overview: every category at a glance, sortable/filterable ── */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingSm">{c.overviewTitle}</Text>
            <InlineStack gap="300" wrap>
              <div style={{ minWidth: 220 }}>
                <TextField
                  label={c.searchPlaceholder}
                  labelHidden
                  value={search}
                  onChange={setSearch}
                  placeholder={c.searchPlaceholder}
                  autoComplete="off"
                  clearButton
                  onClearButtonClick={() => setSearch("")}
                />
              </div>
              <div style={{ minWidth: 220 }}>
                <Select
                  label={c.filterAll}
                  labelHidden
                  options={statusFilterOptions}
                  value={statusFilter}
                  onChange={setStatusFilter}
                />
              </div>
              {Array.isArray(overview) && (
                <Text as="span" tone="subdued" variant="bodySm">
                  {c.resultCount(visibleOverview.length, overview.length)}
                </Text>
              )}
            </InlineStack>
          </BlockStack>
          {overviewError && <Box paddingBlockStart="300"><Banner tone="critical">{overviewError}</Banner></Box>}
          <Box paddingBlockStart="300">
            {overview === null ? (
              <Box padding="600"><InlineStack align="center"><Spinner size="small" /></InlineStack></Box>
            ) : visibleOverview.length === 0 ? (
              <Box padding="400"><Text as="p" tone="subdued" alignment="center">—</Text></Box>
            ) : (
              <div style={{ maxHeight: 420, overflowY: "auto", border: "1px solid #e1e3e5", borderRadius: 8 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f6f6f7", textAlign: "left", position: "sticky", top: 0 }}>
                      <SortableHeader label={c.colCategory} field="category" sort={sort} onSort={handleSort} />
                      <SortableHeader label={c.colProfile} field="profile" sort={sort} onSort={handleSort} />
                      <SortableHeader label={c.colStatus} field="status" sort={sort} onSort={handleSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {visibleOverview.map((row) => (
                      <tr
                        key={row.id}
                        onClick={() => setCategoryId(row.id)}
                        style={{
                          borderTop: "1px solid #f1f1f1",
                          cursor: "pointer",
                          background: row.id === categoryId ? "#eff6ff" : undefined,
                        }}
                      >
                        <td style={{ padding: "10px 16px", fontWeight: 600, color: "#111827" }}>{row.name || "—"}</td>
                        <td style={{ padding: "10px 16px" }}>{localizedLabel(row.effective_profile_label_i18n, locale, row.effective_profile_id)}</td>
                        <td style={{ padding: "10px 16px" }}>{statusBadge(row)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Box>
        </Card>

        {/* ── Editor: pick (or click a row above) to override a single category ── */}
        <Card>
          <BlockStack gap="300">
            <CategoryDrilldownSelect
              label={c.pickCategory}
              categories={categories}
              value={categoryId}
              onChange={setCategoryId}
              placeholder={c.pickPlaceholder}
            />
          </BlockStack>
        </Card>

        {!categoryId ? (
          <Box padding="600">
            <Text as="p" tone="subdued" alignment="center">{c.selectFirst}</Text>
          </Box>
        ) : schemaLoading ? (
          <Box padding="600"><InlineStack align="center"><Spinner size="small" /></InlineStack></Box>
        ) : schema ? (
          <Card>
            <BlockStack gap="400">
              {message.text && (
                <Banner tone={message.type === "success" ? "success" : "critical"} onDismiss={() => setMessage({ type: "", text: "" })}>
                  {message.text}
                </Banner>
              )}
              <InlineStack gap="200" blockAlign="center">
                <Text as="h3" variant="headingSm">{c.currentProfile}</Text>
                <Badge tone={schema.own_profile_id ? "success" : "info"}>
                  {schema.own_profile_id ? c.ownBadge : c.inheritedBadge}
                </Badge>
              </InlineStack>
              <Select
                label={c.ownOverride}
                options={profileOptions}
                value={selectedProfile}
                onChange={setSelectedProfile}
              />
              <InlineStack>
                <Button variant="primary" onClick={handleSave} loading={saving}>{c.save}</Button>
              </InlineStack>
              <BlockStack gap="150">
                <Text as="h3" variant="headingSm">{c.requiredFields}</Text>
                <InlineStack gap="150" wrap>
                  {requiredFieldLabels.map((f) => (
                    <Badge key={f.key}>{f.label}</Badge>
                  ))}
                </InlineStack>
              </BlockStack>
            </BlockStack>
          </Card>
        ) : null}
      </BlockStack>
    </Page>
  );
}
