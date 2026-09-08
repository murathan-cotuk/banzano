"use client";

import { useEffect, useMemo, useState } from "react";
import styled from "styled-components";
import GlobalPageLoader from "@/components/ui/GlobalPageLoader";
import CatalogCmsLanding from "@/components/catalog/CatalogCmsLanding";
import CatalogHubFilterShell from "@/components/catalog/CatalogHubFilterShell";
import Carousel from "@/components/Carousel";
import { ProductCard } from "@/components/ProductCard";
import { Link } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { useResponsiveColumnCount } from "@/hooks/useResponsiveColumnCount";
import { getLocalizedCategory } from "@/lib/format";
import { storeCategoriesQuery } from "@/lib/store-categories-url";
import { getMedusaClient } from "@/lib/medusa-client";
import { cachedJsonFetch } from "@/lib/browser-fetch-cache";

const FilterBar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 24px 20px;
  flex-wrap: wrap;

  @media (max-width: 767px) {
    padding: 0 16px 16px;
    gap: 6px;
  }
`;

const FilterChip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1.5px solid ${(p) => (p.$active ? "#111827" : "#d1d5db")};
  background: ${(p) => (p.$active ? "#111827" : "#fff")};
  color: ${(p) => (p.$active ? "#fff" : "#374151")};
  font-size: 13px;
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.15s, background 0.15s, color 0.15s;

  &:hover {
    border-color: #111827;
  }
`;

const SeeAll = styled(Link)`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  text-decoration: none;
  color: #111827;
  border: 1px solid #d1d5db;
  background: #fff;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  padding: 8px 12px;
`;

function productSalesScore(product) {
  const meta = product?.metadata || {};
  return Number(meta.sold_last_month || meta.sold || meta.sales_count || 0) || 0;
}

function isBestSellerProduct(product) {
  return productSalesScore(product) > 0 || product?.metadata?.is_bestseller === true;
}

const MAX_ITEMS_PER_CAROUSEL = 20;

// Alternate scoring strategies selectable via the Sellercentral API-page settings panel.
const SORT_SCORERS = {
  sales: productSalesScore,
  views: (p) => Number(p?.metadata?.view_count || p?.metadata?.views || 0) || 0,
  rating: (p) => {
    const reviewCount = Number(p?.metadata?.review_count || 0) || 0;
    const reviewAvg = Number(p?.metadata?.review_avg || 0) || 0;
    return reviewAvg * reviewCount;
  },
  newest: (p) => {
    const t = p?.created_at ? new Date(p.created_at).getTime() : 0;
    return Number.isFinite(t) ? t : 0;
  },
};

function seededRandom(seed) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h || 1;
}

function pickI18n(i18n, locale) {
  if (!i18n) return null;
  return i18n[locale] || i18n.de || null;
}

// Mirrors sales/page.jsx: maps every category id (root or nested) to its top-level root,
// so a product tagged with a leaf category still groups under the right root section.
function buildCategoryRootMap(nodes, root = null) {
  const map = new Map();
  for (const node of nodes || []) {
    if (!node) continue;
    const r = root ?? node;
    const id = String(node.id || "").trim();
    if (id) map.set(id, r);
    const childMap = buildCategoryRootMap(node.children || [], r);
    for (const [k, v] of childMap) map.set(k, v);
  }
  return map;
}

export default function BestsellersPage() {
  const locale = useLocale();
  const itemsPerRow = useResponsiveColumnCount(5, 2);
  const [categoryTree, setCategoryTree] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedCollections, setSelectedCollections] = useState(new Set());
  const [pageSettings, setPageSettings] = useState(null);
  const [showProductFilterBar, setShowProductFilterBar] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError("");
        const [catData, prData, settingsRes, landingFlag] = await Promise.all([
          cachedJsonFetch(`/api/store-categories${storeCategoriesQuery(locale, { tree: "true", is_visible: "true" })}`, { ttlMs: 15000 }).catch(() => ({ tree: [] })),
          // Large catalog snapshot (up to 1200 products) — cached client-side for 2 min so
          // revisits/back-navigation don't re-pull the full payload from the backend each time.
          cachedJsonFetch("/api/store-products?limit=1200", { ttlMs: 15000 }).catch(() => ({ products: [] })),
          fetch("/api/store-api-page-settings/bestsellers").catch(() => null),
          (async () => {
            try {
              const client = getMedusaClient();
              const page = await client.getPageBySlug("bestsellers");
              if (!page?.id) return false;
              const lp = await fetch(`/api/store-landing-page/${encodeURIComponent(page.id)}`).then((r) => r.json());
              return lp?.settings?.show_product_filter_bar === true;
            } catch {
              return false;
            }
          })(),
        ]);
        // catData already resolved above (cachedJsonFetch resolves to parsed JSON, with its own
        // .catch fallback to { tree: [] } on failure — no separate .ok/.json() step needed here).
        const settingsData = settingsRes && settingsRes.ok ? await settingsRes.json().catch(() => null) : null;
        if (!cancelled) {
          setCategoryTree(Array.isArray(catData?.tree) ? catData.tree : []);
          setProducts(Array.isArray(prData?.products) ? prData.products : []);
          setPageSettings(settingsData || null);
          setShowProductFilterBar(landingFlag === true);
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || "Error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const copy = useMemo(() => {
    if (locale === "de") return { title: "Bestsellers", text: "Meistverkaufte Produkte nach Kategorien", seeAll: "Alle ansehen", empty: "Keine Bestseller gefunden.", all: "Alle" };
    if (locale === "tr") return { title: "Cok Satanlar", text: "Kategorilere gore en cok satilan urunler", seeAll: "Tumunu gor", empty: "Cok satan urun bulunamadi.", all: "Tumu" };
    return { title: "Bestsellers", text: "Top-selling products by category", seeAll: "See all", empty: "No bestsellers found.", all: "All" };
  }, [locale]);

  const maxItems = (pageSettings?.max_items && Number(pageSettings.max_items) > 0)
    ? Number(pageSettings.max_items)
    : MAX_ITEMS_PER_CAROUSEL;
  const sortMode = pageSettings?.sort_mode && (SORT_SCORERS[pageSettings.sort_mode] || pageSettings.sort_mode === "random")
    ? pageSettings.sort_mode
    : "sales";
  const scorer = SORT_SCORERS[sortMode] || productSalesScore;
  const titleOverride = pickI18n(pageSettings?.title_i18n, locale)?.title || "";
  const textOverride = pickI18n(pageSettings?.subtitle_i18n, locale)?.subtitle || "";
  const pageTitle = titleOverride || copy.title;
  const pageText = textOverride || copy.text;

  const rows = useMemo(() => {
    const bestsellers = products.filter((p) => isBestSellerProduct(p));
    if (!bestsellers.length || !categoryTree.length) return [];

    const rootCategories = categoryTree.filter((n) => n && n.has_products !== false);
    if (!rootCategories.length) return [];
    const catRootMap = buildCategoryRootMap(rootCategories);

    const byRoot = new Map();
    for (const p of bestsellers) {
      const catId = String(p.metadata?.admin_category_id || p.metadata?.category_id || "").trim();
      if (!catId) continue;
      const root = catRootMap.get(catId);
      if (!root?.id) continue;
      const key = String(root.id);
      if (!byRoot.has(key)) byRoot.set(key, { collection: root, products: [] });
      byRoot.get(key).products.push(p);
    }

    return [...byRoot.values()]
      .map((entry) => {
        let sorted;
        if (sortMode === "random") {
          const rand = seededRandom(hashStr(String(entry.collection.id)));
          sorted = entry.products
            .map((p) => ({ p, r: rand() }))
            .sort((a, b) => a.r - b.r)
            .map(({ p }) => p);
        } else {
          sorted = [...entry.products].sort((a, b) => scorer(b) - scorer(a));
        }
        return { collection: entry.collection, products: sorted.slice(0, maxItems) };
      })
      .filter((entry) => entry.products.length > 0)
      .sort((a, b) => b.products.length - a.products.length);
  }, [categoryTree, products, sortMode, scorer, maxItems]);

  const filterCollections = useMemo(() => rows.map((r) => r.collection), [rows]);

  const visibleRows = useMemo(() => {
    if (selectedCollections.size === 0) return rows;
    return rows.filter((r) => selectedCollections.has(String(r.collection.id)));
  }, [rows, selectedCollections]);

  const toggleCollection = (key) => {
    setSelectedCollections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const hubLinks = useMemo(() => {
    if (!showProductFilterBar) return [];
    const cats = filterCollections
      .map((c) => {
        const slug = String(c.slug || c.handle || "").replace(/^\//, "");
        if (!slug) return null;
        return {
          slug,
          title: getLocalizedCategory(c, locale).name || c.name || slug,
          href: `#${slug}`,
          active: selectedCollections.has(String(c.id)),
          onClick: () => toggleCollection(String(c.id)),
        };
      })
      .filter(Boolean);
    return [
      {
        slug: "__all__",
        title: copy.all,
        href: "#all",
        active: selectedCollections.size === 0,
        onClick: () => setSelectedCollections(new Set()),
      },
      ...cats,
    ];
  }, [showProductFilterBar, filterCollections, locale, selectedCollections, copy.all]);

  const body = (
    <>
      {!loading && !error && filterCollections.length > 0 && !showProductFilterBar && (
        <FilterBar>
          <FilterChip
            $active={selectedCollections.size === 0}
            onClick={() => setSelectedCollections(new Set())}
          >
            {copy.all}
          </FilterChip>
          {filterCollections.map((c) => {
            const key = String(c.id);
            const catName = getLocalizedCategory(c, locale).name || c.name || c.slug || "";
            return (
              <FilterChip
                key={key}
                $active={selectedCollections.has(key)}
                onClick={() => toggleCollection(key)}
              >
                {catName}
              </FilterChip>
            );
          })}
        </FilterBar>
      )}

      {loading ? <GlobalPageLoader /> : null}
      {error ? <p style={{ color: "#b91c1c", padding: "0 24px" }}>{error}</p> : null}
      {!loading && !error && rows.length === 0 ? (
        <p style={{ color: "#6b7280", padding: "0 24px" }}>{copy.empty}</p>
      ) : null}

      {!loading && !error && visibleRows.map(({ collection, products: list }) => {
        const catName = getLocalizedCategory(collection, locale).name || collection.name || collection.slug || "";
        const catSlug = String(collection.slug || collection.handle || "").replace(/^\//, "");
        return (
          <div key={collection.id} style={{ padding: "8px 24px 28px" }}>
            <div style={{ width: "100%", maxWidth: 1700, boxSizing: "border-box", minWidth: 0, marginLeft: "auto", marginRight: "auto" }}>
              <Carousel
                contained={false}
                navOnSides
                gap={12}
                visibleCount={itemsPerRow}
                showFade={false}
                ariaLabel={catName || "Bestsellers category"}
                header={(
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", gap: 12, flexWrap: "wrap" }}>
                    <h2 className="shop-typo-h2" style={{ margin: 0 }}>
                      {catName}
                    </h2>
                    {catSlug && <SeeAll href={`/${catSlug}?bestseller=1`}>{copy.seeAll} →</SeeAll>}
                  </div>
                )}
              >
                {list.map((p) => (
                  <ProductCard key={p.id} product={p} plainImage isBestseller />
                ))}
              </Carousel>
            </div>
          </div>
        );
      })}
    </>
  );

  return (
    <CatalogCmsLanding slug="bestsellers" fallbackTitle={pageTitle} showTitleWhenNoContainers preferNativeCatalog>
      {showProductFilterBar && hubLinks.length > 0 ? (
        <CatalogHubFilterShell links={hubLinks} locale={locale}>
          {body}
        </CatalogHubFilterShell>
      ) : (
        body
      )}
    </CatalogCmsLanding>
  );
}
