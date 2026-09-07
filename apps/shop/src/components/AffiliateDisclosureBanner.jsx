"use client";

import { useEffect, useState } from "react";
import { useLocale } from "next-intl";

// One-time, discrete disclosure shown the first time a visitor lands via an affiliate link
// (docs/affiliate.md PR 9 — BGH 2017 requirement that affiliate/referral links be disclosed as
// advertising). This is a transparency/UWG obligation, independent of cookie/marketing consent
// (PR2's __atrl tracking cookie), so it fires purely off the presence of a `?ref=` param and is
// shown once ever per browser, not once per session.
const SEEN_KEY = "andertal_aff_disclosure_seen";

const TEXTS = {
  de: "Hinweis: Diese Seite wurde über einen Partnerlink aufgerufen. Wir erhalten ggf. eine Provision für über diesen Link getätigte Käufe.",
  tr: "Bilgi: Bu sayfaya bir ortaklık (affiliate) bağlantısı üzerinden ulaştınız. Bu bağlantı üzerinden yapılan alışverişlerden komisyon alabiliriz.",
  en: "Note: You reached this page via an affiliate link. We may earn a commission on purchases made through this link.",
  fr: "Remarque : vous avez accédé à cette page via un lien d'affiliation. Nous pouvons percevoir une commission sur les achats effectués via ce lien.",
  es: "Aviso: has llegado a esta página a través de un enlace de afiliado. Es posible que recibamos una comisión por las compras realizadas a través de este enlace.",
  it: "Nota: sei arrivato a questa pagina tramite un link di affiliazione. Potremmo ricevere una commissione sugli acquisti effettuati tramite questo link.",
};

export default function AffiliateDisclosureBanner() {
  const locale = useLocale();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      const hasRef = new URL(window.location.href).searchParams.has("ref");
      if (!hasRef) return;
      if (localStorage.getItem(SEEN_KEY) === "1") return;
      localStorage.setItem(SEEN_KEY, "1");
      setVisible(true);
    } catch {}
  }, []);

  if (!visible) return null;

  const text = TEXTS[locale] || TEXTS.de;

  return (
    <div
      role="note"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 2147483646,
        background: "#111827",
        color: "#fff",
        fontSize: 13,
        lineHeight: 1.4,
        padding: "10px 44px 10px 16px",
        textAlign: "center",
      }}
    >
      {text}
      <button
        onClick={() => setVisible(false)}
        aria-label="Close"
        style={{
          position: "absolute",
          top: 6,
          right: 10,
          background: "transparent",
          border: "none",
          color: "#fff",
          fontSize: 18,
          lineHeight: 1,
          cursor: "pointer",
          padding: 6,
        }}
      >
        ×
      </button>
    </div>
  );
}
