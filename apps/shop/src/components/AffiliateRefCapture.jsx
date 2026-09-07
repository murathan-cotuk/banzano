"use client";

import { useEffect } from "react";

const SESSION_KEY = "andertal_pending_ref";
const FIRED_KEY = "andertal_ref_fired"; // per browser-tab session; avoids re-POSTing on every render/navigation

/**
 * Captures `?ref=AFF_XXX` for visitors who land directly on a shop page instead of going through
 * the /r/[code] short-link redirect (which already records the click server-side) — e.g. an
 * affiliate shared a raw product or category URL. docs/affiliate.md PR 2.
 *
 * Only handles the generic 'storefront' source type — a direct product-page landing that skipped
 * /r/[code] doesn't have a resolvable affiliate_links row to attribute the click to a specific
 * product, so it's deliberately not guessed from the URL slug here.
 */
export default function AffiliateRefCapture() {
  useEffect(() => {
    const resolveRef = () => {
      try {
        const fromUrl = new URL(window.location.href).searchParams.get("ref");
        if (fromUrl) {
          sessionStorage.setItem(SESSION_KEY, fromUrl);
          return fromUrl;
        }
        return sessionStorage.getItem(SESSION_KEY);
      } catch {
        return null;
      }
    };

    const post = (ref) =>
      fetch("/api/affiliate-track", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref, source_type: "storefront" }),
      }).catch(() => {});

    const ref = resolveRef();
    if (!ref) return;

    // First attempt on mount — records the click either way; attribution only happens
    // server-side if the consent cookie already says "marketing: true".
    let alreadyFired = false;
    try { alreadyFired = sessionStorage.getItem(FIRED_KEY) === ref; } catch {}
    if (!alreadyFired) {
      post(ref).then(() => { try { sessionStorage.setItem(FIRED_KEY, ref); } catch {} });
    }

    // Consent may not have existed yet at mount time — CookieBanner dispatches this event the
    // moment the visitor makes ANY choice (accept or reject) in this same session, so retry once
    // to catch the case where they accept marketing cookies right after landing.
    const onConsent = () => post(ref);
    window.addEventListener("cookieConsent", onConsent, { once: true });
    return () => window.removeEventListener("cookieConsent", onConsent);
  }, []);

  return null;
}
