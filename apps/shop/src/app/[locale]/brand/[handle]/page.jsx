"use client";

import ShopHeader from "@/components/ShopHeader";
import Footer from "@/components/Footer";
import { ProductGrid } from "@/components/ProductGrid";
import { Link } from "@/i18n/navigation";
import { useState, useEffect, useRef, useMemo } from "react";
import { useParams, notFound } from "next/navigation";
import { resolveImageUrl } from "@/lib/image-url";
import { cachedJsonFetch } from "@/lib/browser-fetch-cache";
import { storeCategoriesQuery } from "@/lib/store-categories-url";
import { useMarketPrefix } from "@/context/MarketPrefixContext";
import { SITE_URL } from "@/lib/seo";
import {
  SORT_OPTIONS,
  PER_PAGE,
  buildFacetsFromProducts,
  filterFacetsToCatalog,
  buildCategorySlugToNameMap,
  deriveCategoriesFromProducts,
  productCategoryIds,
  filterProductsByFacets,
  applyCatalogSort,
  formatFacetOptionLabel,
  getFacetGroupTitle,
} from "@/lib/catalog-listing";
import styled, { keyframes } from "styled-components";
import CustomCheckbox from "@/components/ui/CustomCheckbox";
import { useTranslations } from "next-intl";
import CatalogDrawerPortal, {
  CATALOG_DRAWER_MAX_PX,
  CATALOG_FILTER_OVERLAY_Z,
  CATALOG_FILTER_SIDEBAR_Z,
  catalogDrawerMaxCss,
} from "@/lib/catalog-drawer-portal";

/* ─────────────────────────────────────────────────────────── */
const HEADER_H = 72;

/* ─── Shimmer skeleton ───────────────────────────────────── */
const shimmer = keyframes`
  0%   { background-position: -800px 0; }
  100% { background-position:  800px 0; }
`;
const Bone = styled.div`
  background: linear-gradient(90deg, #efefed 25%, #e5e5e3 50%, #efefed 75%);
  background-size: 800px 100%;
  animation: ${shimmer} 1.5s infinite linear;
`;

/* ─── Page shell ─────────────────────────────────────────── */
const PageWrap = styled.div`
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: #fafafa;
`;

const Main = styled.main`
  flex: 1;
`;

/* ─── Hero banner ────────────────────────────────────────── */
const HeroBanner = styled.div`
  width: 100%;
  aspect-ratio: 21 / 6;
  min-height: 160px;
  max-height: 320px;
  overflow: hidden;
  position: relative;
  background: #f4f4f2;

  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
    opacity: 1;
  }
`;

const HeroText = styled.div`
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  padding: 24px 32px;

  h1 {
    margin: 0 0 4px;
  }
`;

/* ─── Inline header (no banner) ─────────────────────────── */
const ColHeader = styled.div`
  padding: 28px 32px 0;
  max-width: 1440px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 14px;

  h1 {
    margin: 0;
  }

  @media (max-width: 600px) { padding: 20px 16px 0; }
`;

const LogoCircle = styled.div`
  width: 52px;
  height: 52px;
  border-radius: 50%;
  overflow: hidden;
  background: #f4f4f2;
  border: 1px solid #e8e8e6;
  flex-shrink: 0;

  img { width: 100%; height: 100%; object-fit: cover; display: block; }
`;

/* ─── Breadcrumb (below filter bar, above product grid) ── */
const Breadcrumb = styled.nav`
  padding: 8px 32px 10px;
  max-width: 1440px;
  margin: 0 auto;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: #999;
  letter-spacing: 0.02em;
  background: #fff;
  border-bottom: 1px solid #e8e8e6;

  a { color: #999; text-decoration: none; transition: color 0.12s; &:hover { color: #111; } }
  b { color: #444; font-weight: 500; }

  @media (max-width: 600px) { padding: 6px 16px 8px; }
  @media (max-width: 767px) { display: none; }
`;

/* ─── Filter bar ─────────────────────────────────────────── */
const FilterBar = styled.div`
  position: sticky;
  top: ${HEADER_H}px;
  z-index: 20;
  background: #fff;
  border-top: 1px solid #e8e8e6;
  border-bottom: 1px solid #e8e8e6;
`;

const FilterBarInner = styled.div`
  max-width: 1440px;
  margin: 0 auto;
  padding: 0 32px;
  display: flex;
  align-items: stretch;
  justify-content: space-between;
  gap: 0;

  @media (max-width: 600px) { padding: 0 16px; }
`;

const FilterBtn = styled.button`
  display: none;
  align-items: center;
  gap: 7px;
  padding: 12px 0;
  background: none;
  border: none;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${(p) => (p.$active ? "#111" : "#666")};
  cursor: pointer;
  transition: color 0.12s;
  border-bottom: 2px solid ${(p) => (p.$active ? "#111" : "transparent")};
  margin-bottom: -1px;

  svg { width: 14px; height: 14px; stroke: currentColor; fill: none; stroke-width: 1.8; }
  &:hover { color: #111; }

  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: inline-flex;
  }
`;

const SortWrap = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #666;
  margin-left: auto;
`;

const SortLabel = styled.span`
  font-size: 11px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: #999;
  white-space: nowrap;

  @media (max-width: 480px) { display: none; }
`;

const SortSelect = styled.select`
  appearance: none;
  background: transparent;
  border: none;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #111;
  cursor: pointer;
  outline: none;
  padding: 12px 20px 12px 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23555' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 4px center;
`;

const SidebarOverlay = styled.div`
  display: none;
  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.45);
    z-index: ${CATALOG_FILTER_OVERLAY_Z};
    opacity: ${(p) => (p.$open ? 1 : 0)};
    pointer-events: ${(p) => (p.$open ? "auto" : "none")};
    transition: opacity var(--app-duration-surface, 0.3s) var(--app-ease-out, cubic-bezier(0.4, 0, 0.2, 1));
  }
`;

const SidebarHead = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  margin-bottom: ${(p) => (p.$filterMode ? "0" : "20px")};
  padding: ${(p) => (p.$filterMode ? "12px 14px" : "0 0 12px")};
  border-bottom: 1px solid #e8e8e6;

  @media (min-width: 1024px) {
    display: none;
  }
`;

const DesktopSidebarContent = styled.div`
  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: none;
  }
`;

const MobileFilterSplit = styled.div`
  display: none;
  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    display: flex;
    flex-direction: row;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
`;

const MobileFilterLeft = styled.div`
  width: 92px;
  flex-shrink: 0;
  overflow-y: auto;
  background: #f7f7f6;
  border-right: 1px solid #e8e8e6;
`;

const MobileFilterLeftBtn = styled.button`
  display: block;
  width: 100%;
  padding: 13px 8px 13px 11px;
  font-size: 11px;
  font-weight: ${(p) => (p.$active ? 700 : 400)};
  text-align: left;
  background: ${(p) => (p.$active ? "#fff" : "transparent")};
  border: none;
  border-left: 3px solid ${(p) => (p.$active ? "#111" : "transparent")};
  color: ${(p) => (p.$active ? "#111" : "#555")};
  cursor: pointer;
  line-height: 1.3;
  letter-spacing: 0.02em;
  font-family: inherit;
`;

const MobileFilterRight = styled.div`
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 12px 10px;
`;

const MobileFilterPillGrid = styled.div`
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 7px;
`;

const MobileFilterPill = styled.button`
  padding: 9px 6px;
  font-size: 11.5px;
  font-weight: ${(p) => (p.$on ? 700 : 400)};
  background: ${(p) => (p.$on ? "#111" : "#fff")};
  color: ${(p) => (p.$on ? "#fff" : "#444")};
  border: 1.5px solid ${(p) => (p.$on ? "#111" : "#d1d5db")};
  border-radius: 8px;
  cursor: pointer;
  text-align: center;
  line-height: 1.3;
  font-family: inherit;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
  &:hover { border-color: #111; }
  word-break: break-word;
`;

const FilterGroup = styled.div`
  border-bottom: 1px solid #eceae7;
`;

const FilterGroupTitle = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 0;
  background: none;
  border: none;
  cursor: pointer;
  text-align: left;
`;

const FilterGroupHeading = styled.h4.attrs({ className: "shop-typo-sidebar-nav" })`
  margin: 0;
  padding: 0;
  flex: 1;
  min-width: 0;
  text-align: left;
`;

const FilterGroupBody = styled.div`
  display: ${(p) => (p.$open ? "block" : "none")};
  padding: 0 0 12px;
`;

const FilterChevron = styled.span`
  font-size: 14px;
  line-height: 1;
  color: #666;
  transform: rotate(${(p) => (p.$open ? "180deg" : "0deg")});
  transition: transform 0.18s ease;
`;

const CheckRow = styled.label.attrs({ className: "shop-typo-sidebar-submenu" })`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
  cursor: pointer;
  color: ${(p) => (p.$on ? "var(--sidebar-nav-color, #111827)" : "var(--sidebar-submenu-color, #4b5563)")};
  font-weight: ${(p) => (p.$on ? 600 : "var(--sidebar-submenu-fw, 400)")};
  transition: color 0.12s;

  & > label {
    flex-shrink: 0;
    width: 12px;
    height: 12px;
  }

  & > label svg {
    width: 100% !important;
    height: 100% !important;
    display: block;
  }

  &:hover { color: var(--sidebar-nav-color, #111827); }
`;

const ClearAllBtn = styled.button`
  background: none;
  border: 1px solid #ccc;
  padding: 6px 14px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: #555;
  cursor: pointer;
  transition: border-color 0.12s, color 0.12s;

  &:hover { border-color: #111; color: #111; }
`;

const CategoryNavGroup = styled.div`
  margin-bottom: 16px;
  padding-bottom: 12px;
  border-bottom: 1px solid #e8e8e6;
`;

const CategoryNavTitle = styled.div`
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: #111;
  margin-bottom: 6px;
`;

const CategoryNavBtn = styled.button`
  display: block;
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  color: ${(p) => (p.$active ? "#111827" : "#4b5563")};
  font-weight: ${(p) => (p.$active ? 600 : 400)};
  text-align: left;
  border: none;
  border-radius: 6px;
  background: ${(p) => (p.$active ? "#e5e7eb" : "transparent")};
  margin-bottom: 2px;
  cursor: pointer;
  font-family: inherit;
  transition: background 0.12s, color 0.12s;

  &:hover {
    background: #e5e7eb;
    color: #111827;
  }
`;

const MOBILE_CATEGORIES_KEY = "__categories";

/* ─── Body (Kategorie-/Kollektion-Layout: flex + Sticky-Sidebar) ─ */
const ContentWrap = styled.div`
  max-width: 1440px;
  margin: 0 auto;
  padding: 14px 32px 80px;
  width: 100%;
  box-sizing: border-box;
  display: flex;
  gap: 32px;
  align-items: flex-start;

  @media (max-width: 767px) {
    padding: 6px 6px 80px;
    padding-left: 4px !important;
    padding-right: 4px !important;
    gap: 0;
  }
`;

const SidebarCol = styled.aside`
  width: 280px;
  flex-shrink: 0;
  position: sticky;
  top: ${HEADER_H + 100}px;
  max-height: calc(100vh - ${HEADER_H + 100}px);
  overflow-y: auto;

  @media (max-width: ${CATALOG_DRAWER_MAX_PX}px) {
    position: fixed;
    top: 0;
    left: 0;
    width: min(360px, 90vw);
    height: 100dvh;
    max-height: 100dvh;
    z-index: ${CATALOG_FILTER_SIDEBAR_Z};
    background: #fff;
    box-shadow: 4px 0 32px rgba(0, 0, 0, 0.2);
    transform: translateX(${(p) => (p.$open ? "0" : "-100%")});
    transition: transform var(--app-duration-surface, 0.3s) var(--app-ease-out, cubic-bezier(0.4, 0, 0.2, 1));
    padding: ${(p) => (p.$filterMode ? "0" : "14px 16px 16px")};
    box-sizing: border-box;
    display: ${(p) => (p.$filterMode ? "flex" : "block")};
    flex-direction: column;
    overflow: ${(p) => (p.$filterMode ? "hidden" : "auto")};

    @media (prefers-reduced-motion: reduce) {
      transition: none;
    }
  }
`;

const MainCol = styled.div`
  min-width: 0;
`;

/* ─── Chips ──────────────────────────────────────────────── */
const ChipBar = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 14px 0 0;
`;

const Chip = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  background: #111;
  color: #fff;
  border: none;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  cursor: pointer;
  transition: background 0.12s;

  &:hover { background: #333; }
`;

/* ─── Result bar ─────────────────────────────────────────── */
const ResultBar = styled.div`
  padding: 16px 0 12px;
  font-size: 11.5px;
  color: #999;
  letter-spacing: 0.04em;
`;

/* ─── Pagination ─────────────────────────────────────────── */
const Pager = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  padding-top: 48px;
`;

const PBtn = styled.button`
  min-width: 36px;
  height: 36px;
  padding: 0 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid ${(p) => (p.$on ? "#111" : "#ddd")};
  background: ${(p) => (p.$on ? "#111" : "#fff")};
  color: ${(p) => (p.$on ? "#fff" : "#555")};
  font-size: 12.5px;
  font-weight: ${(p) => (p.$on ? "700" : "400")};
  cursor: ${(p) => (p.disabled ? "not-allowed" : "pointer")};
  opacity: ${(p) => (p.disabled ? "0.3" : "1")};
  transition: border-color 0.12s, color 0.12s, background 0.12s;

  &:not(:disabled):hover {
    border-color: #111;
    color: ${(p) => (p.$on ? "#fff" : "#111")};
  }
`;

/* ─── Description ────────────────────────────────────────── */
const Desc = styled.div`
  margin-top: 56px;
  padding-top: 28px;
  border-top: 1px solid #e8e8e6;
  font-size: 13.5px;
  line-height: 1.8;
  color: #666;
  max-width: 700px;

  h1,h2,h3 { font-size: 15px; font-weight: 700; color: #111; margin: 1.5em 0 0.5em; }
  p { margin: 0 0 0.75em; }
  a { color: #111; text-decoration: underline; }
`;

/* ─────────────────────────────────────────────────────────── *
 *  Page
 * ─────────────────────────────────────────────────────────── */
export default function BrandPage() {
  const params   = useParams();
  const locale   = params?.locale ?? "en";
  const marketPrefixVal = useMarketPrefix();
  const handle   = params?.handle ? String(params.handle) : undefined;
  const tCommon  = useTranslations("common");

  const [brand,       setBrand]       = useState(null);
  const [products,    setProducts]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [notFoundSt,  setNotFoundSt]  = useState(false);
  const [sort,        setSort]        = useState("default");
  const [page,        setPage]        = useState(1);
  const [filters,     setFilters]     = useState({});
  const [activeCategoryId, setActiveCategoryId] = useState(null);
  const [panelOpen,   setPanelOpen]   = useState(false);
  const [openFilterGroups, setOpenFilterGroups] = useState({});
  const [activeMobileFilterGroup, setActiveMobileFilterGroup] = useState(null);
  const [categorySlugToName, setCategorySlugToName] = useState(() => new Map());
  const [categoryTree, setCategoryTree] = useState([]);
  const [metafieldDefinitions, setMetafieldDefinitions] = useState({});
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const bodyRef = useRef(null);

  /* ── Fetch ── */
  useEffect(() => {
    if (!handle) return;
    setActiveCategoryId(null);
    setFilters({});
    setPage(1);
    (async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(`/api/store-brands/${encodeURIComponent(handle)}`);
        if (res.status === 404) { setNotFoundSt(true); setLoading(false); return; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        if (!data?.brand) { setNotFoundSt(true); setLoading(false); return; }
        setBrand(data.brand);
        setProducts(data.products ?? []);
      } catch (e) {
        setError(e?.message ?? "Error");
      } finally {
        setLoading(false);
      }
    })();
  }, [handle]);

  /* ── Canonical (market-aware public URL) ── */
  useEffect(() => {
    if (typeof document === "undefined" || !brand?.handle) return;
    const prefix = (marketPrefixVal || "").replace(/\/$/, "") || `/${(locale || "de").toLowerCase()}`;
    let el = document.querySelector('link[rel="canonical"]');
    if (!el) { el = document.createElement("link"); el.rel = "canonical"; document.head.appendChild(el); }
    el.href = `${SITE_URL}${prefix}/brand/${brand.handle}`;
  }, [locale, brand?.handle, marketPrefixVal]);

  useEffect(() => {
    let cancelled = false;
    cachedJsonFetch(`/api/store-categories${storeCategoriesQuery(locale, { tree: "true", is_visible: "true" })}`, { ttlMs: 15000 })
      .then((data) => {
        if (cancelled) return;
        const tree = data.tree || [];
        setCategoryTree(tree);
        setCategorySlugToName(buildCategorySlugToNameMap(tree));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [locale]);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/store-metafield-definitions")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) setMetafieldDefinitions(data?.definitions || {});
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const facets = useMemo(
    () => filterFacetsToCatalog(buildFacetsFromProducts(products), metafieldDefinitions),
    [products, metafieldDefinitions],
  );
  const hasFacets = Object.keys(facets).length > 0;
  const brandCategories = useMemo(
    () => deriveCategoriesFromProducts(products, categoryTree),
    [products, categoryTree],
  );
  const hasCategories = brandCategories.length > 0;
  const showCatalogSidebar = hasFacets || hasCategories;
  const useFilterDrawerLayout = hasFacets || hasCategories;
  const activeCategory = brandCategories.find((entry) => entry.id === activeCategoryId) || null;

  // facets her render’da yeni obje olmamalı — [facets] deps ile aksi halde max update depth.
  // Yeni facet anahtarı geldiğinde açık/kapalı için filters’ı ref’ten oku (deps’e gerek yok).
  useEffect(() => {
    const facetKeys = Object.keys(facets);
    setOpenFilterGroups((prev) => {
      const f = filtersRef.current;
      let changed = false;
      const next = { ...prev };
      facetKeys.forEach((key) => {
        if (!(key in next)) {
          next[key] = Boolean(f[key]?.length);
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [facets]);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    if (!window.matchMedia(catalogDrawerMaxCss).matches) return undefined;
    const prev = document.body.style.overflow;
    if (panelOpen) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [panelOpen]);

  useEffect(() => {
    if (!panelOpen || !useFilterDrawerLayout) return;
    if (hasCategories && !hasFacets) {
      setActiveMobileFilterGroup(MOBILE_CATEGORIES_KEY);
      return;
    }
    const keys = Object.keys(facets);
    if (keys.length > 0 && (!activeMobileFilterGroup || (activeMobileFilterGroup !== MOBILE_CATEGORIES_KEY && !facets[activeMobileFilterGroup]))) {
      setActiveMobileFilterGroup(hasCategories ? MOBILE_CATEGORIES_KEY : keys[0]);
    }
  }, [panelOpen, facets, hasFacets, hasCategories, useFilterDrawerLayout, activeMobileFilterGroup]);

  const toggle = (key, val) => {
    setFilters((prev) => {
      const cur = prev[key] || [];
      const next = cur.includes(val) ? cur.filter((x) => x !== val) : [...cur, val];
      if (!next.length) {
        const u = { ...prev };
        delete u[key];
        return u;
      }
      return { ...prev, [key]: next };
    });
    setPage(1);
  };

  const selectCategory = (categoryId) => {
    setActiveCategoryId((prev) => (prev === categoryId ? null : categoryId));
    setPage(1);
  };

  const clearAll = () => {
    setFilters({});
    setActiveCategoryId(null);
    setPage(1);
  };

  let filtered = filterProductsByFacets(products, filters);
  if (activeCategoryId) {
    filtered = filtered.filter((product) => productCategoryIds(product).has(activeCategoryId));
  }
  const sorted = applyCatalogSort(filtered, sort, { bestsellerOnly: false });

  const total      = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const curPage    = Math.min(page, totalPages);
  const paginated  = sorted.slice((curPage - 1) * PER_PAGE, curPage * PER_PAGE);

  const activeCount = Object.values(filters).reduce((n, v) => n + (v?.length || 0), 0) + (activeCategoryId ? 1 : 0);

  const title     = brand?.name ?? handle ?? "";
  const bannerUrl = brand?.banner_image ? resolveImageUrl(brand.banner_image) : "";
  const logoUrl   = brand?.logo_image   ? resolveImageUrl(brand.logo_image)   : "";

  if (notFoundSt) notFound();

  /* ── Skeleton ── */
  if (loading) return (
    <PageWrap>
      <ShopHeader />
      <Main>
        <Bone style={{ height: 220 }} />
        <ContentWrap>
          <MainCol>
            <Bone style={{ height: 13, width: 200, margin: "24px 0 32px" }} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1, background: "#e8e8e6" }}>
              {Array.from({ length: 6 }).map((_, i) => <Bone key={i} style={{ aspectRatio: "3/4" }} />)}
            </div>
          </MainCol>
        </ContentWrap>
      </Main>
      <Footer />
    </PageWrap>
  );

  if (error || !brand) return (
    <PageWrap>
      <ShopHeader />
      <Main>
        <ContentWrap>
          <MainCol>
            <p style={{ padding: "48px 0", color: "#b91c1c", fontSize: 13 }}>
              {error || "Brand not found."}
            </p>
          </MainCol>
        </ContentWrap>
      </Main>
      <Footer />
    </PageWrap>
  );

  /* ── Render ── */
  return (
    <PageWrap>
      <ShopHeader />
      <Main>

        {/* ── Banner / header ── */}
        {bannerUrl ? (
          <HeroBanner>
            <img src={bannerUrl} alt={title} />
            <HeroText>
              <h1 className="shop-typo-catalog-title shop-typo-catalog-title--on-dark">
                {logoUrl && (
                  <img
                    src={logoUrl}
                    alt=""
                    style={{
                      width: 36,
                      height: 36,
                      objectFit: "cover",
                      borderRadius: "50%",
                      verticalAlign: "middle",
                      marginRight: 10,
                      border: "2px solid rgba(255,255,255,0.8)",
                    }}
                  />
                )}
                {title}
              </h1>
            </HeroText>
          </HeroBanner>
        ) : (
          <ColHeader>
            {logoUrl && <LogoCircle><img src={logoUrl} alt={title} /></LogoCircle>}
            <h1 className="shop-typo-catalog-title">{title}</h1>
          </ColHeader>
        )}

        {/* ── Sticky filter/sort bar ── */}
        <FilterBar>
          <FilterBarInner>
            {showCatalogSidebar && (
              <FilterBtn
                type="button"
                $active={panelOpen || activeCount > 0}
                onClick={() => setPanelOpen((o) => !o)}
                aria-expanded={panelOpen}
              >
                <svg viewBox="0 0 16 12">
                  <line x1="0" y1="2"  x2="16" y2="2" />
                  <line x1="0" y1="6"  x2="16" y2="6" />
                  <line x1="0" y1="10" x2="16" y2="10"/>
                  <circle cx="5"  cy="2"  r="1.5" fill="#111" stroke="none"/>
                  <circle cx="11" cy="6"  r="1.5" fill="#111" stroke="none"/>
                  <circle cx="5"  cy="10" r="1.5" fill="#111" stroke="none"/>
                </svg>
                {hasCategories && !hasFacets ? tCommon("categories") : tCommon("filter")}{activeCount > 0 ? ` (${activeCount})` : ""}
              </FilterBtn>
            )}

            <SortWrap>
              <SortLabel>Sort:</SortLabel>
              <SortSelect
                value={sort}
                onChange={e => { setSort(e.target.value); setPage(1); }}
                aria-label="Sort products"
              >
                {SORT_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </SortSelect>
            </SortWrap>
          </FilterBarInner>
        </FilterBar>

        <Breadcrumb aria-label="Breadcrumb">
          <Link href={`/${locale}`}>Home</Link>
          <span style={{ color: "#ccc" }}>/</span>
          <b>{title}</b>
        </Breadcrumb>

        <ContentWrap ref={bodyRef}>
          {showCatalogSidebar && (
            <CatalogDrawerPortal>
              <>
                <SidebarOverlay $open={panelOpen} onClick={() => setPanelOpen(false)} />
                <SidebarCol $open={panelOpen} $filterMode={useFilterDrawerLayout}>
              <SidebarHead $filterMode={useFilterDrawerLayout}>
                <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                  {hasCategories && !hasFacets ? tCommon("categories") : tCommon("filter")}{activeCount > 0 ? ` (${activeCount})` : ""}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {activeCount > 0 && (
                    <ClearAllBtn type="button" onClick={clearAll} style={{ padding: "2px 8px", fontSize: 10 }}>
                      {tCommon("clear")}
                    </ClearAllBtn>
                  )}
                  <button type="button" onClick={() => setPanelOpen(false)} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#555", lineHeight: 1, padding: 0 }} aria-label={tCommon("close")}>×</button>
                </div>
              </SidebarHead>

              {/* Desktop: categories + accordion filters */}
              <DesktopSidebarContent>
                <div>
                  {hasCategories && (
                    <CategoryNavGroup>
                      <CategoryNavTitle>{tCommon("categories")}</CategoryNavTitle>
                      <CategoryNavBtn type="button" $active={!activeCategoryId} onClick={() => { setActiveCategoryId(null); setPage(1); }}>
                        {tCommon("allProducts")}
                      </CategoryNavBtn>
                      {brandCategories.map((entry) => (
                        <CategoryNavBtn
                          key={entry.id}
                          type="button"
                          $active={activeCategoryId === entry.id}
                          onClick={() => selectCategory(entry.id)}
                        >
                          {entry.name}
                          <span style={{ float: "right", color: "#9ca3af", fontWeight: 400, fontSize: 11 }}>{entry.count}</span>
                        </CategoryNavBtn>
                      ))}
                    </CategoryNavGroup>
                  )}
                  {hasFacets && (
                    <>
                      <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#111", marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid #e8e8e6" }}>
                        {tCommon("filter")}
                        {activeCount > 0 && (
                          <ClearAllBtn type="button" onClick={clearAll} style={{ float: "right", padding: "2px 8px", fontSize: 10 }}>
                            {tCommon("clear")}
                          </ClearAllBtn>
                        )}
                      </div>
                      {Object.entries(facets).map(([key, vals]) => (
                        <FilterGroup key={key}>
                          <FilterGroupTitle type="button" onClick={() => setOpenFilterGroups((prev) => ({ ...prev, [key]: !prev[key] }))}>
                            <FilterGroupHeading>{getFacetGroupTitle(key, locale, metafieldDefinitions)}</FilterGroupHeading>
                            <FilterChevron $open={!!openFilterGroups[key]}>⌄</FilterChevron>
                          </FilterGroupTitle>
                          <FilterGroupBody $open={!!openFilterGroups[key]}>
                            {vals.map((val) => {
                              const on = (filters[key] || []).includes(val);
                              const label = formatFacetOptionLabel(key, val, categorySlugToName, locale, metafieldDefinitions);
                              return (
                                <CheckRow key={val} $on={on}>
                                  <CustomCheckbox checked={on} onChange={() => toggle(key, val)} size={12} />
                                  {label}
                                </CheckRow>
                              );
                            })}
                          </FilterGroupBody>
                        </FilterGroup>
                      ))}
                    </>
                  )}
                  {activeCount > 0 && (
                    <ClearAllBtn type="button" onClick={() => { clearAll(); setPanelOpen(false); }}>
                      {tCommon("clearAllFilters")}
                    </ClearAllBtn>
                  )}
                </div>
              </DesktopSidebarContent>

              {/* Mobile: two-panel layout */}
              <MobileFilterSplit>
                <MobileFilterLeft>
                  {hasCategories && (
                    <MobileFilterLeftBtn
                      type="button"
                      $active={activeMobileFilterGroup === MOBILE_CATEGORIES_KEY}
                      onClick={() => setActiveMobileFilterGroup(MOBILE_CATEGORIES_KEY)}
                    >
                      {tCommon("categories")}
                      {activeCategoryId && <span style={{ display: "block", fontSize: 9, color: "#ff971c", fontWeight: 800, marginTop: 2 }}>1</span>}
                    </MobileFilterLeftBtn>
                  )}
                  {Object.entries(facets).map(([key]) => {
                    const cnt = (filters[key] || []).length;
                    return (
                      <MobileFilterLeftBtn key={key} type="button" $active={activeMobileFilterGroup === key} onClick={() => setActiveMobileFilterGroup(key)}>
                        {getFacetGroupTitle(key, locale, metafieldDefinitions)}
                        {cnt > 0 && <span style={{ display: "block", fontSize: 9, color: "#ff971c", fontWeight: 800, marginTop: 2 }}>{cnt} ausgewählt</span>}
                      </MobileFilterLeftBtn>
                    );
                  })}
                </MobileFilterLeft>
                <MobileFilterRight>
                  {activeMobileFilterGroup === MOBILE_CATEGORIES_KEY && hasCategories ? (
                    <MobileFilterPillGrid>
                      <MobileFilterPill type="button" $on={!activeCategoryId} onClick={() => { setActiveCategoryId(null); setPage(1); }}>
                        {tCommon("allProducts")}
                      </MobileFilterPill>
                      {brandCategories.map((entry) => (
                        <MobileFilterPill
                          key={entry.id}
                          type="button"
                          $on={activeCategoryId === entry.id}
                          onClick={() => selectCategory(entry.id)}
                        >
                          {entry.name}
                        </MobileFilterPill>
                      ))}
                    </MobileFilterPillGrid>
                  ) : activeMobileFilterGroup && facets[activeMobileFilterGroup] ? (
                    <MobileFilterPillGrid>
                      {facets[activeMobileFilterGroup].map((val) => {
                        const on = (filters[activeMobileFilterGroup] || []).includes(val);
                        return (
                          <MobileFilterPill key={val} type="button" $on={on} onClick={() => toggle(activeMobileFilterGroup, val)}>
                            {formatFacetOptionLabel(activeMobileFilterGroup, val, categorySlugToName, locale, metafieldDefinitions)}
                          </MobileFilterPill>
                        );
                      })}
                    </MobileFilterPillGrid>
                  ) : (
                    <div style={{ color: "#aaa", fontSize: 12 }}>{tCommon("filterSelectHint")}</div>
                  )}
                </MobileFilterRight>
              </MobileFilterSplit>
            </SidebarCol>
              </>
            </CatalogDrawerPortal>
          )}

          <MainCol>
            {activeCount > 0 && (
              <ChipBar>
                {activeCategory && (
                  <Chip type="button" onClick={() => selectCategory(activeCategory.id)}>
                    {activeCategory.name} ×
                  </Chip>
                )}
                {Object.entries(filters).flatMap(([k, vals]) =>
                  (vals || []).map((v) => (
                    <Chip key={`${k}:${v}`} type="button" onClick={() => toggle(k, v)}>
                      {formatFacetOptionLabel(k, v, categorySlugToName, locale, metafieldDefinitions)} ×
                    </Chip>
                  ))
                )}
              </ChipBar>
            )}

            <ResultBar>
              {total} {total === 1 ? "product" : "products"}
            </ResultBar>

            {paginated.length === 0 ? (
              <div style={{ textAlign: "center", padding: "80px 0", color: "#bbb", fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                No products match your filters.
              </div>
            ) : (
              <ProductGrid products={paginated} maxColumns={4} activeFilters={filters} />
            )}

            {totalPages > 1 && (
              <Pager>
                <PBtn
                  type="button"
                  disabled={curPage <= 1}
                  onClick={() => { setPage(p => p - 1); bodyRef.current?.scrollIntoView({ behavior: "smooth" }); }}
                >‹</PBtn>

                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter(p => p === 1 || p === totalPages || Math.abs(p - curPage) <= 2)
                  .reduce((acc, p, idx, arr) => {
                    if (idx > 0 && p - arr[idx - 1] > 1) acc.push("…");
                    acc.push(p);
                    return acc;
                  }, [])
                  .map((p, i) =>
                    p === "…"
                      ? <span key={`d${i}`} style={{ width: 36, textAlign: "center", color: "#bbb", fontSize: 12 }}>…</span>
                      : <PBtn key={p} type="button" $on={p === curPage}
                          onClick={() => { setPage(p); bodyRef.current?.scrollIntoView({ behavior: "smooth" }); }}>
                          {p}
                        </PBtn>
                  )}

                <PBtn
                  type="button"
                  disabled={curPage >= totalPages}
                  onClick={() => { setPage(p => p + 1); bodyRef.current?.scrollIntoView({ behavior: "smooth" }); }}
                >›</PBtn>
              </Pager>
            )}

            {brand?.address && (
              <Desc>
                <strong>{title}</strong><br />
                {brand.address}
              </Desc>
            )}
          </MainCol>
        </ContentWrap>
      </Main>
      <Footer />
    </PageWrap>
  );
}
