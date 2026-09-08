"use client";

import dynamic from "next/dynamic";
import { CustomerAuthProvider } from "@andertal/lib";
import { CartProvider } from "@/context/CartContext";
import { WishlistProvider } from "@/context/WishlistContext";
import { LandingChromeProvider } from "@/context/LandingChromeContext";
import { MobileBottomNavScrollProvider } from "@/context/MobileBottomNavScrollContext";
import { ShopStylesProvider } from "@/context/ShopStylesContext";
import ShopStylesInjector from "@/components/ShopStylesInjector";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useLenis } from "@/hooks/useLenis";
import PostHogProvider from "@/components/PostHogProvider";
import ShopPresenceHeartbeat from "@/components/ShopPresenceHeartbeat";
import { ProductBadgeStylesProvider } from "@/components/ProductBadgeStylesProvider";

// Lazy-loaded: not needed for initial paint — deferred to after hydration.
const CartSidebar      = dynamic(() => import("@/components/CartSidebar"),      { ssr: false });
const ScrollToTopButton = dynamic(() => import("@/components/ScrollToTopButton"), { ssr: false });
const CookieBanner     = dynamic(() => import("@/components/CookieBanner"),     { ssr: false });
const AffiliateRefCapture = dynamic(() => import("@/components/AffiliateRefCapture"), { ssr: false });
const AffiliateDisclosureBanner = dynamic(() => import("@/components/AffiliateDisclosureBanner"), { ssr: false });
const MaintenanceModeOverlay = dynamic(() => import("@/components/MaintenanceModeOverlay"), { ssr: false });
import MobileShell from "@/components/MobileShell";

function LenisInit() {
  useLenis();
  return null;
}

export default function Providers({ children }) {
  return (
    <PostHogProvider>
    <ErrorBoundary>
      <CustomerAuthProvider>
        <WishlistProvider>
          <CartProvider>
            <MobileBottomNavScrollProvider>
              <ShopStylesProvider>
                <ShopStylesInjector />
                <ProductBadgeStylesProvider>
                <LandingChromeProvider>
                  <LenisInit />
                  <ShopPresenceHeartbeat />
                  <MobileShell>{children}</MobileShell>
                </LandingChromeProvider>
                </ProductBadgeStylesProvider>
              </ShopStylesProvider>
              <CartSidebar />
              <ScrollToTopButton />
              <CookieBanner />
              <AffiliateRefCapture />
              <AffiliateDisclosureBanner />
              <MaintenanceModeOverlay />
            </MobileBottomNavScrollProvider>
          </CartProvider>
        </WishlistProvider>
      </CustomerAuthProvider>
    </ErrorBoundary>
    </PostHogProvider>
  );
}


