"use client";

import React, { useEffect, useState } from "react";
import { useLocale } from "next-intl";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Banner, Spinner, Box } from "@shopify/polaris";
import { useRouter } from "@/i18n/navigation";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";

// Surfaces a real financial gap found while testing the shop as a customer (2026-09):
// runSellerIbanPayoutsIfDue (payouts.js) silently skips any seller with no/invalid IBAN on
// every automatic payout run (console.warn only, nobody watches server logs) — so a seller's
// earned money can sit unpaid indefinitely with no one noticing. This page lists exactly the
// sellers who would be skipped right now, using the same eligibility SQL as that job so the
// amounts shown here match what would actually be paid out once the seller adds a valid IBAN.
function fmtEuro(cents) {
  return `${(Number(cents || 0) / 100).toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
}

const copy = (locale) => {
  const t = (en, tr, de) => (locale === "en" ? en : locale === "tr" ? tr : de);
  return {
    title: t("Payout risk — missing IBAN", "Ödeme riski — IBAN eksik", "Auszahlungsrisiko — IBAN fehlt"),
    subtitle: t(
      "Sellers with money already owed to them (14+ days delivered, no open return) but no valid IBAN on file. The automatic payout run skips these silently — nothing gets paid until the seller adds a real IBAN.",
      "Kendilerine zaten borçlu olunan (14+ gün teslim edilmiş, açık iade yok) ama geçerli bir IBAN'ı olmayan satıcılar. Otomatik ödeme çalışması bunları sessizce atlıyor — satıcı gerçek bir IBAN girene kadar hiçbir ödeme yapılmıyor.",
      "Verkäufer, denen bereits Geld zusteht (14+ Tage geliefert, keine offene Retoure), aber ohne gültige IBAN. Der automatische Auszahlungslauf überspringt diese stillschweigend — es wird nichts ausgezahlt, bis der Verkäufer eine echte IBAN hinterlegt.",
    ),
    empty: t("No seller is currently at risk.", "Şu anda riskli satıcı yok.", "Aktuell ist kein Verkäufer betroffen."),
    loadError: t("Could not load the list.", "Liste yüklenemedi.", "Liste konnte nicht geladen werden."),
    colSeller: t("Seller", "Satıcı", "Verkäufer"),
    colOrders: t("Orders due", "Bekleyen sipariş", "Fällige Bestellungen"),
    colOwed: t("Owed", "Birikmiş tutar", "Geschuldeter Betrag"),
    colIban: t("IBAN", "IBAN", "IBAN"),
    missingIban: t("Missing", "Yok", "Fehlt"),
    invalidIban: t("Too short / invalid", "Çok kısa / geçersiz", "Zu kurz / ungültig"),
    openSeller: t("Open seller", "Satıcıyı aç", "Verkäufer öffnen"),
  };
};

export default function PayoutRiskPage() {
  const locale = useLocale();
  const router = useRouter();
  const c = copy(locale);
  const [sellers, setSellers] = useState(null);
  const [error, setError] = useState("");
  const [isSuperuser, setIsSuperuser] = useState(null); // null = not checked yet

  useEffect(() => {
    const su = typeof window !== "undefined" && localStorage.getItem("sellerIsSuperuser") === "true";
    setIsSuperuser(su);
    if (!su) { router.replace("/"); return; }
    let cancelled = false;
    getMedusaAdminClient().getSellersMissingIban()
      .then((d) => { if (!cancelled) setSellers(d.sellers || []); })
      .catch(() => { if (!cancelled) { setSellers([]); setError(c.loadError); } });
    return () => { cancelled = true; };
  }, []);

  if (!isSuperuser) return null;

  return (
    <Page title={c.title}>
      <BlockStack gap="400">
        <Text as="p" tone="subdued">{c.subtitle}</Text>
        {error && <Banner tone="critical" onDismiss={() => setError("")}>{error}</Banner>}
        <Card padding="0">
          {sellers === null ? (
            <Box padding="800">
              <InlineStack align="center"><Spinner size="small" /></InlineStack>
            </Box>
          ) : sellers.length === 0 ? (
            <Box padding="600">
              <Text as="p" tone="subdued" alignment="center">{c.empty}</Text>
            </Box>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#f6f6f7", textAlign: "left" }}>
                  {[c.colSeller, c.colOrders, c.colOwed, c.colIban, ""].map((h) => (
                    <th key={h} style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", borderBottom: "1px solid #e1e3e5" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sellers.map((s) => (
                  <tr key={s.seller_id} style={{ borderTop: "1px solid #f1f1f1", cursor: "pointer" }} onClick={() => router.push(`/sellers/${s.seller_id}`)}>
                    <td style={{ padding: "12px 16px" }}>
                      <div style={{ fontWeight: 600, color: "#111827" }}>{s.store_name || s.company_name || s.email || s.seller_id}</div>
                      <div style={{ fontSize: 11, color: "#9ca3af" }}>{s.email}</div>
                    </td>
                    <td style={{ padding: "12px 16px" }}>{s.order_count}</td>
                    <td style={{ padding: "12px 16px", fontWeight: 700, color: "#b91c1c" }}>{fmtEuro(s.owed_cents)}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <Badge tone="critical">{s.has_iban ? c.invalidIban : c.missingIban}</Badge>
                    </td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }}>
                      <span style={{ color: "#2563eb", fontWeight: 600, fontSize: 12 }}>{c.openSeller} →</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
