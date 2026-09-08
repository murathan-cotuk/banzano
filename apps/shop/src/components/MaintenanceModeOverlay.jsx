"use client";

import { useEffect, useState } from "react";

// Superuser-controlled "coming soon" / pause mode (SellerCentral → Settings → General).
// Fetches the same cached, public settings endpoint the branding/logo already uses — no extra
// backend load — and renders a full-viewport image over every page when enabled. Does not
// unmount the app underneath (cheap toggle, no navigation/state loss once turned back off).
export default function MaintenanceModeOverlay() {
  const [state, setState] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/store-seller-settings?seller_id=default", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        setState({
          enabled: data?.maintenance_mode_enabled === true,
          imageUrl: data?.maintenance_mode_image_url || "",
        });
      })
      .catch(() => {
        if (!cancelled) setState({ enabled: false, imageUrl: "" });
      });
    return () => { cancelled = true; };
  }, []);

  if (!state?.enabled) return null;

  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 2147483647,
        background: state.imageUrl ? `#000 url(${JSON.stringify(state.imageUrl)}) center / cover no-repeat` : "#111827",
      }}
    />
  );
}
