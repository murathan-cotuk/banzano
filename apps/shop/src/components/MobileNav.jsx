"use client";

/**
 * MobileNav — Bottom navigation bar + slide-in drawer for narrow viewports (≤1023px, mobil + tablet).
 * Bar: Home, Menü, Warenkorb, Merkzettel, Profil (search lives in ShopHeader).
 * Drawer: Kategorien (+ category image thumbs) then Mein Konto; no CMS “Menü” / Service links.
 * Rendered as a sibling of page content via Providers.jsx (display:none on desktop).
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Link, usePathname } from "@/i18n/navigation";
import { useLocale, useTranslations } from "next-intl";
import { storeCategoriesQuery } from "@/lib/store-categories-url";
import { cachedJsonFetch } from "@/lib/browser-fetch-cache";
import { useCustomerAuth as useAuth } from "@andertal/lib";
import { LogoutButton } from "@andertal/ui";
import { useCart } from "@/context/CartContext";
import { useWishlist } from "@/context/WishlistContext";
import { restPathFromPathname } from "@/lib/shop-market";
import { findCategoryNodeById, mapCategoryNodesToMenuRows, shouldCategoryMenuDrill } from "@/lib/category-menu-rows";
import ModernMobileBottomNav from "@/components/ModernMobileBottomNav";
import { useShopStyles } from "@/context/ShopStylesContext";
import {
  MOBILE_CHROME_SCROLL_THRESHOLD_PX,
  useMobileBottomNavScroll,
} from "@/context/MobileBottomNavScrollContext";

const TEAL = "#1b8880";
const USE_MODERN_MOBILE_BOTTOM_NAV = true;

/* ─── inline styles (no styled-components dependency) ─────── */

const css = {
  /* Bottom bar */
  bar: () => ({
    display: "flex",
    position: "fixed",
    bottom: 0,
    left: 0,
    right: 0,
    height: "calc(58px + env(safe-area-inset-bottom, 0px))",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
    background: "#fff",
    borderTop: "1px solid #e5e7eb",
    boxShadow: "0 -2px 12px rgba(0,0,0,0.07)",
    zIndex: 2147483640,
    alignItems: "stretch",
  }),
  barBtn: (active) => ({
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 0,
    border: "none",
    background: "transparent",
    cursor: "pointer",
    padding: "0 4px",
    color: active ? TEAL : "#6b7280",
    fontFamily: "inherit",
    WebkitTapHighlightColor: "transparent",
    transition: "color 0.15s",
    textDecoration: "none",
    minWidth: 0,
  }),
  cartBadge: {
    position: "absolute",
    top: -5,
    right: -7,
    background: TEAL,
    color: "#fff",
    borderRadius: "50%",
    minWidth: 16,
    height: 16,
    fontSize: 9,
    fontWeight: 800,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    pointerEvents: "none",
  },

  /* Overlay */
  overlay: (open, reducedMotion) => ({
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.52)",
    zIndex: 2147483700,
    opacity: open ? 1 : 0,
    pointerEvents: open ? "auto" : "none",
    transition: reducedMotion ? "none" : "opacity 0.3s cubic-bezier(0.4,0,0.2,1)",
  }),

  /* Drawer */
  drawer: (open, reducedMotion) => ({
    position: "fixed",
    top: 0,
    left: 0,
    width: "min(360px, 90vw)",
    height: "100dvh",
    background: "#fff",
    zIndex: 2147483701,
    transform: open ? "translateX(0)" : "translateX(-100%)",
    transition: reducedMotion ? "none" : "transform 0.3s cubic-bezier(0.4,0,0.2,1)",
    boxShadow: "4px 0 32px rgba(0,0,0,0.16)",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
  }),

  drawerHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 16px",
    background: TEAL,
    flexShrink: 0,
  },

  drawerBody: {
    flex: 1,
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
  },

  sectionLabel: {
    padding: "12px 16px 4px",
    fontSize: 10,
    fontWeight: 700,
    color: "#9ca3af",
    textTransform: "uppercase",
    letterSpacing: "0.1em",
  },

  drawerLink: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "11px 16px",
    fontSize: 15,
    fontWeight: 500,
    color: "#111827",
    textDecoration: "none",
    transition: "background 0.1s",
    borderBottom: "1px solid #f9fafb",
  },

  /** Category row: thumb (square) + label — comfortable tap height */
  categoryRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    padding: "10px 16px",
    fontSize: 15,
    fontWeight: 500,
    color: "#111827",
    textDecoration: "none",
    transition: "background 0.1s",
    borderBottom: "1px solid #f3f4f6",
  },
  categoryRowBtn: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 12,
    minHeight: 56,
    padding: "10px 16px",
    fontSize: 15,
    fontWeight: 600,
    color: "#111827",
    background: "none",
    border: "none",
    borderBottom: "1px solid #f3f4f6",
    textAlign: "left",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  subCategoryLink: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "9px 16px 9px 76px",
    fontSize: 14,
    fontWeight: 500,
    color: "#374151",
    textDecoration: "none",
    borderBottom: "1px solid #f9fafb",
  },

  categoryThumb: {
    width: 48,
    height: 48,
    borderRadius: 8,
    objectFit: "cover",
    background: "#e5e7eb",
    flexShrink: 0,
  },

  categoryThumbPlaceholder: {
    width: 48,
    height: 48,
    borderRadius: 8,
    background: "linear-gradient(135deg, #e5e7eb 0%, #d1d5db 100%)",
    flexShrink: 0,
  },

  drawerBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    padding: "11px 16px",
    fontSize: 15,
    fontWeight: 500,
    color: "#111827",
    background: "none",
    border: "none",
    borderBottom: "1px solid #f9fafb",
    cursor: "pointer",
    textAlign: "left",
    fontFamily: "inherit",
    transition: "background 0.1s",
  },

  divider: {
    height: 8,
    background: "#f9fafb",
    borderTop: "1px solid #f3f4f6",
    borderBottom: "1px solid #f3f4f6",
    margin: "4px 0",
  },

  /* Body-level bottom padding so content isn't hidden under the bar */
};

/* ─── Icons ──────────────────────────────────────────────── */
const IcoHome = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 9.5L12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9.5z" />
    <polyline points="9 22 9 12 15 12 15 22" />
  </svg>
);

const IcoMenu = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M2 5.75A.75.75 0 0 1 2.75 5h18.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 5.75ZM2 12a.75.75 0 0 1 .75-.75h18.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 12Zm0 6.25a.75.75 0 0 1 .75-.75h18.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z" />
  </svg>
);

const IcoCart = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M1 2.75A.75.75 0 0 1 1.75 2h.52a2.25 2.25 0 0 1 2.21 1.81L4.71 5h15.56a2 2 0 0 1 1.97 2.33l-1.41 6.71A3 3 0 0 1 17.88 16H7.64a3 3 0 0 1-2.95-2.46L2.76 3.6A.75.75 0 0 0 2.27 3H1.75A.75.75 0 0 1 1 2.75ZM6 19a2 2 0 1 1 4 0 2 2 0 0 1-4 0Zm9 0a2 2 0 1 1 4 0 2 2 0 0 1-4 0Z" />
  </svg>
);

const IcoUser = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
  </svg>
);

/** Heart — Merkzettel / wishlist */
const IcoHeart = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
  </svg>
);

const IcoChevron = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.35, flexShrink: 0 }}>
    <path d="M9 18l6-6-6-6" />
  </svg>
);

const IcoClose = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M18 6L6 18M6 6l12 12" />
  </svg>
);

/* ─── Hover helpers ──────────────────────────────────────── */
function HoverLink({ style, ...props }) {
  const [hov, setHov] = useState(false);
  return (
    <Link
      {...props}
      style={{ ...style, background: hov ? "#f3f4f6" : "transparent" }}
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
    />
  );
}

function appPathFromPathname(pathname) {
  if (!pathname) return "/";
  const rest = restPathFromPathname(pathname);
  return rest === "" ? "/" : rest.startsWith("/") ? rest : `/${rest}`;
}

/* ─── Main component ─────────────────────────────────────── */
export default function MobileNav({ layout = "fixed" }) {
  const shopStyles = useShopStyles();
  const mc = shopStyles?.mobileChrome || {};
  const { mobileBottomNavScroll } = useMobileBottomNavScroll();
  const pathname = usePathname();
  const locale = useLocale();
  const t = useTranslations("common");
  const tPanel = useTranslations("accountPanel");
  const tWishlist = useTranslations("wishlist");
  const { isAuthenticated, user, logout } = useAuth();
  const { openCartSidebar, itemCount } = useCart();
  const { ids: wishlistIds } = useWishlist();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTarget, setDrawerTarget] = useState("menu"); // "menu" | "account"
  const [categoryTree, setCategoryTree] = useState([]);
  const [categoryDrillStack, setCategoryDrillStack] = useState([]);
  const [categoriesLoading, setCategoriesLoading] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [isMobileNavViewport, setIsMobileNavViewport] = useState(false);
  const drawerRef = useRef(null);
  const drawerBodyRef = useRef(null);
  const accountSectionRef = useRef(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const onChange = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia("(max-width: 1023px)");
    const go = () => setIsMobileNavViewport(mq.matches);
    go();
    mq.addEventListener("change", go);
    return () => mq.removeEventListener("change", go);
  }, []);

  /* Fetch data once — tracked with a loading flag so the "Menu" drawer's Kategorien section
   * can show a placeholder instead of silently disappearing while this is in flight (it used
   * to vanish entirely on categories.length === 0, leaving just the login/register block for
   * a logged-out visitor who opened the drawer before this fetch settled). */
  useEffect(() => {
    let cancelled = false;
    setCategoriesLoading(true);
    cachedJsonFetch(`/api/store-categories${storeCategoriesQuery(locale, { tree: "true", is_visible: "true" })}`, { ttlMs: 15000 })
      .then((d) => {
        if (cancelled) return;
        setCategoryTree(Array.isArray(d?.tree) ? d.tree : []);
        setCategoryDrillStack([]);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setCategoriesLoading(false); });
    return () => { cancelled = true; };
  }, [locale]);

  /* Close drawer on route change */
  useEffect(() => {
    setDrawerOpen(false);
    setDrawerTarget("menu");
    setCategoryDrillStack([]);
  }, [pathname]);

  /* Body scroll lock when drawer open */
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [drawerOpen]);

  /* Close on Escape key */
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") setDrawerOpen(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    setCategoryDrillStack([]);
  }, []);

  const drillCurrent = categoryDrillStack.length ? categoryDrillStack[categoryDrillStack.length - 1] : null;
  const drillParent = drillCurrent ? findCategoryNodeById(categoryTree, drillCurrent.id) : null;
  const categoryRows = mapCategoryNodesToMenuRows(
    drillParent ? drillParent.children : categoryTree,
    locale,
  );

  useEffect(() => {
    if (!drawerOpen || drawerTarget !== "account") return;
    const t = setTimeout(() => {
      accountSectionRef.current?.scrollIntoView({ block: "start", behavior: reducedMotion ? "auto" : "smooth" });
    }, 50);
    return () => clearTimeout(t);
  }, [drawerOpen, drawerTarget, reducedMotion]);

  const appPath = appPathFromPathname(pathname);
  const isHome = appPath === "/" || appPath === "";
  const isMerkzettel =
    appPath === "/merkzettel" || appPath === "/favorites" || appPath === "/wishlist";
  const isCart = appPath === "/cart" || appPath.startsWith("/cart/");
  const isProfile =
    !isMerkzettel &&
    (appPath === "/account" ||
      appPath.startsWith("/account/") ||
      appPath === "/login" ||
      appPath === "/register" ||
      ["/orders", "/addresses", "/payment-methods", "/nachrichten", "/reviews", "/bonus", "/invoices"].some(
        (h) => appPath === h || appPath.startsWith(`${h}/`),
      ));
  /** Kaydırma ile kademeli gizleme — tema: bottom_nav_recess_on_scroll */
  const bottomNavRecessProgress =
    layout === "fixed" &&
    !!mc.bottom_nav_recess_on_scroll &&
    isMobileNavViewport &&
    !drawerOpen &&
    mobileBottomNavScroll.scrollY > MOBILE_CHROME_SCROLL_THRESHOLD_PX
      ? Math.min(1, Math.max(0, mobileBottomNavScroll.chromeHideProgress ?? 0))
      : 0;

  const hideOnAuthPages =
    appPath === "/login" ||
    appPath.startsWith("/login/") ||
    appPath === "/register" ||
    appPath.startsWith("/register/");
  const wishlistCount = wishlistIds?.size ?? 0;

  if (hideOnAuthPages) return null;

  return (
    /* Dar görünümde görünür (≤1023px) — globals.css ile geniş ekranda gizli */
    <div className="andertal-mobile-nav-root">
      {/* ── Drawer Overlay ── */}
      <div
        style={css.overlay(drawerOpen, reducedMotion)}
        onClick={closeDrawer}
        aria-hidden="true"
      />

      {/* ── Side Drawer ── */}
      <div
        ref={drawerRef}
        style={css.drawer(drawerOpen, reducedMotion)}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
      >
        {/* Drawer head */}
        <div style={css.drawerHead}>
          <span style={{ fontSize: 16, fontWeight: 700, color: "#fff", letterSpacing: "0.01em" }}>{t("menu")}</span>
          <button
            type="button"
            onClick={closeDrawer}
            aria-label={t("closeMenu")}
            style={{ background: "rgba(255,255,255,0.15)", border: "none", color: "#fff", cursor: "pointer", padding: 8, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <IcoClose />
          </button>
        </div>

        {/* Drawer scrollable body: categories first, Mein Konto at bottom (no CMS “Menü” / no Service) */}
        <div ref={drawerBodyRef} style={css.drawerBody}>
          {categoriesLoading && categoryTree.length === 0 && (
            <>
              <div style={css.sectionLabel}>{t("categories")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "4px 16px 12px" }}>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} style={{ height: 36, borderRadius: 8, background: "linear-gradient(90deg,#efefed 25%,#e5e5e3 50%,#efefed 75%)", backgroundSize: "800px 100%", animation: "shimmer 1.5s infinite linear" }} />
                ))}
              </div>
              <div style={css.divider} />
            </>
          )}

          {(categoryRows.length > 0 || drillCurrent) && (
            <>
              <div style={css.sectionLabel}>{t("categories")}</div>
              <div>
                {drillCurrent ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setCategoryDrillStack((s) => s.slice(0, -1))}
                      style={{ ...css.categoryRowBtn, width: "100%", border: "none", background: "transparent", font: "inherit", textAlign: "left" }}
                    >
                      <span style={{ width: 36, textAlign: "center", fontSize: 16 }}>←</span>
                      <span style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>{t("back")}</span>
                    </button>
                    <Link
                      href={`/${String(drillCurrent.slug || "").replace(/^\//, "")}`}
                      onClick={closeDrawer}
                      style={{ ...css.categoryRowBtn, textDecoration: "none", display: "flex", fontWeight: 700 }}
                    >
                      <span style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>{drillCurrent.label}</span>
                    </Link>
                  </>
                ) : null}
                {categoryRows.map((cat) => (
                  <Link
                    key={cat.id}
                    href={`/${cat.slug}`}
                    onClick={(e) => {
                      if (shouldCategoryMenuDrill(e, cat.hasChildren)) {
                        e.preventDefault();
                        setCategoryDrillStack((s) => [...s, { id: cat.id, label: cat.label, slug: cat.slug }]);
                        return;
                      }
                      closeDrawer();
                    }}
                    style={{ ...css.categoryRowBtn, textDecoration: "none", display: "flex" }}
                  >
                    {cat.imageUrl ? <img src={cat.imageUrl} alt="" style={css.categoryThumb} /> : <div style={css.categoryThumbPlaceholder} aria-hidden />}
                    <span style={{ flex: 1, minWidth: 0, lineHeight: 1.35 }}>{cat.label}</span>
                    <IcoChevron />
                  </Link>
                ))}
              </div>
            </>
          )}

          {(categoryRows.length > 0 || drillCurrent) && <div style={css.divider} />}

          {isAuthenticated ? (
            <>
              <div style={css.divider} />
              <HoverLink href="/account" onClick={closeDrawer} style={{ ...css.drawerLink, fontWeight: 700, color: TEAL }}>
                <span>{tPanel("navOverview")}</span><IcoChevron />
              </HoverLink>
              <div style={{ padding: "8px 16px 4px" }}>
                <LogoutButton
                  label={t("logout")}
                  onClick={() => {
                    closeDrawer();
                    document.cookie = "andertal_cauth=; path=/; max-age=0; SameSite=Lax";
                    logout();
                  }}
                />
              </div>
            </>
          ) : (
            <>
              <div style={css.sectionLabel}>{t("account")}</div>
              <HoverLink href="/login"    onClick={closeDrawer} style={{ ...css.drawerLink, fontWeight: 700, color: TEAL }}>
                <span>{t("login")}</span><IcoChevron />
              </HoverLink>
              <HoverLink href="/register" onClick={closeDrawer} style={css.drawerLink}>
                <span>{t("register")}</span><IcoChevron />
              </HoverLink>
            </>
          )}

          <div style={{ height: 24 }} />
        </div>
      </div>

      {/* ── Bottom Navigation Bar ── */}
      {USE_MODERN_MOBILE_BOTTOM_NAV ? (
        <ModernMobileBottomNav
          layout={layout}
          accentColor={TEAL}
          recessProgress={bottomNavRecessProgress}
          surfaceBg={mc.bottom_nav_bg}
          borderTop={mc.bottom_nav_border_top}
          blur={mc.bottom_nav_blur}
          boxShadow={mc.bottom_nav_shadow}
          items={[
            { key: "home", label: t("home"), icon: <IcoHome />, href: "/", active: isHome },
            {
              key: "menu",
              label: t("menu"),
              icon: <IcoMenu />,
              active: drawerOpen && drawerTarget === "menu",
              onClick: () => {
                setDrawerTarget("menu");
                setDrawerOpen((v) => !v);
              },
            },
            {
              key: "cart",
              label: t("cart"),
              icon: <IcoCart />,
              active: isCart,
              badge: itemCount || 0,
              onClick: openCartSidebar,
            },
            {
              key: "wishlist",
              label: tWishlist("title"),
              icon: <IcoHeart />,
              href: "/merkzettel",
              active: isMerkzettel,
              badge: wishlistCount || 0,
            },
            isAuthenticated
              ? {
                  key: "profile",
                  label: t("profile"),
                  icon: <IcoUser />,
                  href: "/account",
                  active: isProfile,
                }
              : {
                  key: "profile",
                  label: t("profile"),
                  icon: <IcoUser />,
                  href: "/login",
                  active: isProfile,
                },
          ]}
        />
      ) : (
      <nav
        style={{
          ...css.bar(),
          transition: reducedMotion ? "none" : undefined,
          transform: bottomNavRecessProgress > 0
            ? `translateY(calc(${bottomNavRecessProgress} * (100% + env(safe-area-inset-bottom, 0px))))`
            : "translateY(0)",
          pointerEvents: bottomNavRecessProgress >= 0.95 ? "none" : "auto",
        }}
        aria-label="Mobile Navigation"
        aria-hidden={bottomNavRecessProgress >= 0.98 ? true : undefined}
      >
        {/* Home */}
        <Link href="/" style={css.barBtn(isHome)} aria-label={t("homepage")}>
          <IcoHome />
        </Link>

        {/* Categories / Menu */}
        <button
          type="button"
          style={css.barBtn(drawerOpen && drawerTarget === "menu")}
          onClick={() => {
            setDrawerTarget("menu");
            setDrawerOpen((v) => !v);
          }}
          aria-label={t("openMenu")}
          aria-expanded={drawerOpen}
        >
          <IcoMenu />
        </button>

        {/* Warenkorb */}
        <button
          type="button"
          style={css.barBtn(isCart)}
          onClick={openCartSidebar}
          aria-label={t("cart")}
        >
          <div style={{ position: "relative", display: "inline-flex" }}>
            <IcoCart />
            {itemCount > 0 && (
              <span style={css.cartBadge}>{itemCount > 99 ? "99+" : itemCount}</span>
            )}
          </div>
        </button>

        {/* Merkzettel */}
        <Link href="/merkzettel" style={css.barBtn(isMerkzettel)} aria-label={tWishlist("title")}>
          <div style={{ position: "relative", display: "inline-flex" }}>
            <IcoHeart />
            {wishlistCount > 0 && (
              <span style={css.cartBadge}>{wishlistCount > 99 ? "99+" : wishlistCount}</span>
            )}
          </div>
        </Link>

        {/* Profil */}
        {isAuthenticated ? (
          <button
            type="button"
            style={css.barBtn(drawerOpen && drawerTarget === "account")}
            aria-label={t("profile")}
            onClick={() => {
              setDrawerTarget("account");
              setDrawerOpen(true);
            }}
          >
            <div style={{ position: "relative", display: "inline-flex" }}>
              <IcoUser />
              <span style={{ ...css.cartBadge, background: "#22c55e", minWidth: 10, height: 10, top: -2, right: -4 }} />
            </div>
          </button>
        ) : (
          <Link
            href="/login"
            style={css.barBtn(isProfile)}
            aria-label={t("login")}
          >
            <div style={{ position: "relative", display: "inline-flex" }}>
              <IcoUser />
            </div>
          </Link>
        )}
      </nav>
      )}

    </div>
  );
}
