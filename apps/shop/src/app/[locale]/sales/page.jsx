"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import styled from "styled-components";
import GlobalPageLoader from "@/components/ui/GlobalPageLoader";
import CatalogCmsLanding from "@/components/catalog/CatalogCmsLanding";
import Carousel from "@/components/Carousel";
import { ProductCard } from "@/components/ProductCard";
import { Link } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { isDiscountedProduct } from "@/lib/catalog-listing";
import { getLocalizedCategory } from "@/lib/format";
import { storeCategoriesQuery } from "@/lib/store-categories-url";
import { cachedJsonFetch } from "@/lib/browser-fetch-cache";

/* ── Two-column layout ───────────────────────────────── */
const Inner = styled.div`
  max-width: 1380px;
  margin: 0 auto;
  display: flex;
  align-items: flex-start;
  gap: 0;
`;

/* ── Left sidebar ─────────────────────────────────────── */
const Sidebar = styled.aside`
  width: 200px;
  flex-shrink: 0;
  padding: 16px 0 40px 16px;
  position: sticky;
  top: 72px;
  max-height: calc(100vh - 80px);
  overflow-y: auto;
  scrollbar-width: thin;

  @media (max-width: 960px) {
    display: none;
  }
`;

const SidebarTitle = styled.div`
  font-size: 12px;
  font-weight: 700;
  color: #111;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  margin-bottom: 8px;
  padding-bottom: 8px;
  border-bottom: 2px solid #e5e7eb;
`;

const SidebarList = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
`;

const SidebarItem = styled.a`
  display: block;
  padding: 5px 8px;
  border-radius: 5px;
  font-size: 13px;
  font-weight: ${(p) => (p.$active ? "700" : "500")};
  color: ${(p) => (p.$active ? "#111" : "#374151")};
  background: ${(p) => (p.$active ? "#dbeafe" : "transparent")};
  text-decoration: none;
  line-height: 1.35;
  border-left: 3px solid ${(p) => (p.$active ? "#2563eb" : "transparent")};
  transition: background 0.12s, color 0.12s;

  &:hover {
    background: #f3f4f6;
    color: #111;
  }
`;

/* ── Mobile category pills ─────────────────────────── */
const MobilePills = styled.div`
  display: none;
  overflow-x: auto;
  gap: 6px;
  padding: 10px 16px 0;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;

  @media (max-width: 960px) {
    display: flex;
  }
`;

const Pill = styled.a`
  display: inline-block;
  flex-shrink: 0;
  padding: 5px 12px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid #d1d5db;
  font-size: 12px;
  font-weight: 600;
  color: #374151;
  text-decoration: none;
  white-space: nowrap;

  &:hover { background: #f3f4f6; }
`;

/* ── Main content column ─────────────────────────────── */
const ContentCol = styled.div`
  flex: 1;
  min-width: 0;
  padding: 8px 12px 40px;

  @media (max-width: 960px) {
    padding: 4px 0 40px;
  }
`;

/* ── Section (one per category) ─────────────────────── */
const Section = styled.section`
  background: #fff;
  border-radius: 10px;
  margin-bottom: 8px;
  overflow: hidden;

  @media (max-width: 960px) {
    border-radius: 0;
    margin-bottom: 6px;
  }
`;

const SectionHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px 6px;
  flex-wrap: wrap;
`;

const SectionTitle = styled.h2`
  margin: 0;
  font-size: clamp(14px, 1.8vw, 16px);
  font-weight: 700;
  color: #111;
`;

const SeeAll = styled(Link)`
  display: inline-flex;
  align-items: center;
  gap: 3px;
  text-decoration: none;
  color: #2563eb;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;

  &:hover { text-decoration: underline; }
`;

const MAX_ITEMS_PER_CAROUSEL = 20;
const CARD_WIDTH = 180;
const CARD_GAP = 10;

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

function productPerfScore(product) {
  const meta = product?.metadata || {};
  const sold = Number(meta.sold_last_month || meta.sold || 0) || 0;
  const views = Number(meta.view_count || meta.views || 0) || 0;
  const reviewCount = Number(meta.review_count || 0) || 0;
  const reviewAvg = Number(meta.review_avg || 0) || 0;
  return sold * 1000 + views * 10 + reviewAvg * reviewCount * 5;
}

// Alternate scoring strategies selectable via the Sellercentral API-page settings panel.
const SORT_SCORERS = {
  sales: productPerfScore,
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

const pageCopy = {
  de: { title: "Angebote", empty: "Keine reduzierten Produkte gefunden.", seeAll: "Alle ansehen" },
  tr: { title: "İndirimler", empty: "İndirimli ürün bulunamadı.", seeAll: "Tümünü gör" },
  fr: { title: "Promotions", empty: "Aucun produit en promotion.", seeAll: "Tout voir" },
  es: { title: "Ofertas", empty: "No se encontraron productos en oferta.", seeAll: "Ver todo" },
  it: { title: "Offerte", empty: "Nessun prodotto in offerta.", seeAll: "Vedi tutto" },
  en: { title: "Sales", empty: "No discounted products found.", seeAll: "See all" },
};

export default function SalesPage() {
  const locale = useLocale();
  const l = String(locale || "en").toLowerCase();
  const copy = pageCopy[l] || pageCopy.en;

  const [categoryTree, setCategoryTree] = useState([]);
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [activeId, setActiveId] = useState(null);
  const [pageSettings, setPageSettings] = useState(null);
  const observerRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        setError("");
        const [catData, prData, settingsRes] = await Promise.all([
          cachedJsonFetch(`/api/store-categories${storeCategoriesQuery(locale, { tree: "true", is_visible: "true" })}`, { ttlMs: 15000 }).catch(() => ({ tree: [] })),
          // Large catalog snapshot (up to 1200 products) — cached client-side for 2 min so
          // revisits/back-navigation don't re-pull the full payload from the backend each time.
          cachedJsonFetch("/api/store-products?limit=1200", { ttlMs: 15000 }).catch(() => ({ products: [] })),
          fetch("/api/store-api-page-settings/sales").catch(() => null),
        ]);
        const settingsData = settingsRes && settingsRes.ok ? await settingsRes.json().catch(() => null) : null;
        if (!cancelled) {
          setCategoryTree(Array.isArray(catData?.tree) ? catData.tree : []);
          setProducts(Array.isArray(prData?.products) ? prData.products : []);
          setPageSettings(settingsData || null);
        }
      } catch (e) {
        if (!cancelled) setError(e?.message || "Error");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [locale]);

  const maxItems = (pageSettings?.max_items && Number(pageSettings.max_items) > 0)
    ? Number(pageSettings.max_items)
    : MAX_ITEMS_PER_CAROUSEL;
  const sortMode = pageSettings?.sort_mode && (SORT_SCORERS[pageSettings.sort_mode] || pageSettings.sort_mode === "random")
    ? pageSettings.sort_mode
    : "sales";
  const scorer = SORT_SCORERS[sortMode] || productPerfScore;

  const titleOverride = pickI18n(pageSettings?.title_i18n, l)?.title || "";
  const pageTitle = titleOverride || copy.title;

  const rows = useMemo(() => {
    const discounted = products.filter(isDiscountedProduct);
    if (!discounted.length || !categoryTree.length) return [];

    const rootCategories = categoryTree.filter((n) => n && n.has_products !== false);
    if (!rootCategories.length) return [];

    const catRootMap = buildCategoryRootMap(rootCategories);

    const byRoot = new Map();
    for (const p of discounted) {
      const catId = String(p.metadata?.admin_category_id || p.metadata?.category_id || "").trim();
      if (!catId) continue;
      const root = catRootMap.get(catId);
      if (!root?.id) continue;
      const key = String(root.id);
      if (!byRoot.has(key)) byRoot.set(key, { category: root, products: [] });
      byRoot.get(key).products.push(p);
    }

    return [...byRoot.values()]
      .map(({ category, products: list }) => {
        let sorted;
        if (sortMode === "random") {
          const rand = seededRandom(hashStr(String(category.id)));
          sorted = list
            .map((p) => ({ p, r: rand() }))
            .sort((a, b) => a.r - b.r)
            .map(({ p }) => p);
        } else {
          sorted = [...list].sort((a, b) => scorer(b) - scorer(a));
        }
        return { category, products: sorted.slice(0, maxItems) };
      })
      .filter((r) => r.products.length > 0)
      .sort((a, b) => b.products.length - a.products.length);
  }, [categoryTree, products, sortMode, scorer, maxItems]);

  // Sidebar active section via IntersectionObserver
  useEffect(() => {
    if (!rows.length) return;
    if (observerRef.current) observerRef.current.disconnect();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveId(entry.target.id);
        }
      },
      { rootMargin: "-64px 0px -55% 0px", threshold: 0 },
    );
    observerRef.current = observer;

    for (const { category } of rows) {
      const el = document.getElementById(`cat-${category.id}`);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [rows]);

  const showContent = !loading && !error;

  return (
    <CatalogCmsLanding slug="sales" fallbackTitle={pageTitle} showTitleWhenNoContainers preferNativeCatalog>
      {/* Mobile category pills */}
      {showContent && rows.length > 0 && (
        <MobilePills>
          {rows.map(({ category }) => {
            const catName = getLocalizedCategory(category, locale).name || category.name || "";
            return (
              <Pill key={category.id} href={`#cat-${category.id}`}>{catName}</Pill>
            );
          })}
        </MobilePills>
      )}

      <Inner>
        {/* Left sidebar */}
        {showContent && rows.length > 0 && (
          <Sidebar>
            <SidebarTitle>{pageTitle}</SidebarTitle>
            <SidebarList>
              {rows.map(({ category }) => {
                const catName = getLocalizedCategory(category, locale).name || category.name || "";
                const id = `cat-${category.id}`;
                return (
                  <li key={id}>
                    <SidebarItem href={`#${id}`} $active={activeId === id}>
                      {catName}
                    </SidebarItem>
                  </li>
                );
              })}
            </SidebarList>
          </Sidebar>
        )}

        {/* Main content */}
        <ContentCol>
          {loading ? (
            <GlobalPageLoader />
          ) : error ? (
            <p style={{ color: "#b91c1c", padding: "16px" }}>{error}</p>
          ) : rows.length === 0 ? (
            <p style={{ color: "#6b7280", padding: "16px" }}>{copy.empty}</p>
          ) : (
            rows.map(({ category, products: list }) => {
              const catName = getLocalizedCategory(category, locale).name || category.name || category.slug || "";
              const catSlug = String(category.slug || category.handle || "").replace(/^\//, "");
              return (
                <Section key={category.id} id={`cat-${category.id}`}>
                  <SectionHeader>
                    <SectionTitle>{catName}</SectionTitle>
                    {catSlug && (
                      <SeeAll href={`/${catSlug}?sale=1`}>{copy.seeAll} →</SeeAll>
                    )}
                  </SectionHeader>
                  <Carousel
                    contained={false}
                    navOnSides
                    itemWidth={CARD_WIDTH}
                    gap={CARD_GAP}
                    showFade={false}
                    ariaLabel={catName}
                  >
                    {list.map((p) => (
                      <ProductCard key={p.id} product={p} plainImage />
                    ))}
                  </Carousel>
                </Section>
              );
            })
          )}
        </ContentCol>
      </Inner>
    </CatalogCmsLanding>
  );
}
