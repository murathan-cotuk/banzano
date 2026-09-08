"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useLocale } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { Page, Card, BlockStack, InlineStack, Text, Badge, Banner, Spinner, Box, Button, Tabs, TextField, Select } from "@shopify/polaris";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";

// Superuser-only (docs/affiliate.md PR 8): pending affiliate signups, fraud queue, payout
// history — one page with tabs instead of 4 separate routes, functionally equivalent.
function fmtDate(d, locale) {
  if (!d) return "—";
  try {
    return new Date(d).toLocaleString(locale === "en" ? "en-GB" : locale === "tr" ? "tr-TR" : "de-DE", {
      day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch { return "—"; }
}
function fmtEur(cents) {
  return ((cents || 0) / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
}

const SEVERITY_TONE = { low: "info", medium: "attention", high: "critical" };
const PAYOUT_STATUS_TONE = { pending: "info", processing: "attention", paid: "success", failed: "critical" };

const copy = (locale) => {
  const t = (en, tr, de) => (locale === "en" ? en : locale === "tr" ? tr : de);
  return {
    title: t("Affiliate admin", "Affiliate yönetimi", "Affiliate-Verwaltung"),
    tabPending: t("Pending signups", "Bekleyen kayıtlar", "Ausstehende Registrierungen"),
    tabFraud: t("Fraud queue", "Fraud kuyruğu", "Betrugs-Warteschlange"),
    tabPayouts: t("Payouts", "Ödemeler", "Auszahlungen"),
    emptyPending: t("No pending affiliate signups.", "Bekleyen affiliate kaydı yok.", "Keine ausstehenden Affiliate-Registrierungen."),
    emptyFraud: t("No open fraud flags.", "Açık fraud kaydı yok.", "Keine offenen Betrugs-Meldungen."),
    emptyPayouts: t("No payouts yet.", "Henüz ödeme yok.", "Noch keine Auszahlungen."),
    approve: t("Approve", "Onayla", "Genehmigen"),
    reject: t("Reject", "Reddet", "Ablehnen"),
    resolve: t("Resolve", "Çözüldü işaretle", "Als gelöst markieren"),
    suspend: t("Resolve + suspend", "Çözüldü + askıya al", "Lösen + sperren"),
    ban: t("Resolve + ban", "Çözüldü + yasakla", "Lösen + sperren (dauerhaft)"),
    colEmail: t("Email", "E-posta", "E-Mail"),
    colCode: t("Code", "Kod", "Code"),
    colCountry: t("Country", "Ülke", "Land"),
    colCreated: t("Signed up", "Kayıt", "Registriert"),
    colType: t("Type", "Tip", "Typ"),
    colSeverity: t("Severity", "Önem", "Schwere"),
    colAffiliate: t("Affiliate", "Affiliate", "Affiliate"),
    colStatus: t("Status", "Durum", "Status"),
    colAmount: t("Amount", "Tutar", "Betrag"),
    colPeriod: t("Period", "Dönem", "Zeitraum"),
    loadError: t("Could not load data.", "Veriler yüklenemedi.", "Daten konnten nicht geladen werden."),
    actionError: t("Action failed.", "İşlem başarısız.", "Aktion fehlgeschlagen."),
    logCheckTitle: t(
      "Log a manual monitoring finding (e.g. brand-bid check)",
      "Manuel izleme bulgusu kaydet (ör. marka-teklif kontrolü)",
      "Manuellen Prüfbefund erfassen (z. B. Brand-Bid-Check)"
    ),
    affiliateCode: t("Affiliate code", "Affiliate kodu", "Affiliate-Code"),
    flagType: t("Type", "Tip", "Typ"),
    notes: t("Notes", "Notlar", "Notizen"),
    logFinding: t("Log finding", "Bulguyu kaydet", "Befund erfassen"),
    logSuccess: t("Finding logged.", "Bulgu kaydedildi.", "Befund erfasst."),
    brandBid: t("Brand-bid (paid search)", "Marka teklifi (ücretli arama)", "Brand-Bid (bezahlte Suche)"),
    manual: t("Other / manual", "Diğer / manuel", "Sonstiges / manuell"),
    sevLow: t("Low", "Düşük", "Niedrig"),
    sevMedium: t("Medium", "Orta", "Mittel"),
    sevHigh: t("High", "Yüksek", "Hoch"),
    tabAdjustments: t("Commission adjustments", "Komisyon düzeltmeleri", "Provisionsanpassungen"),
    emptyAdjustments: t("No manual adjustments yet.", "Henüz manuel düzeltme yok.", "Noch keine manuellen Anpassungen."),
    adjustmentFormTitle: t("Log a manual bonus or clawback", "Manuel bonus veya geri alma kaydet", "Manuellen Bonus oder Rückbelastung erfassen"),
    adjustmentType: t("Type", "Tip", "Typ"),
    bonus: t("Bonus (add)", "Bonus (ekle)", "Bonus (hinzufügen)"),
    clawback: t("Clawback (deduct)", "Geri alma (düş)", "Rückbelastung (abziehen)"),
    amountEur: t("Amount (EUR)", "Tutar (EUR)", "Betrag (EUR)"),
    reason: t("Reason (required, kept for audit)", "Gerekçe (zorunlu, denetim için tutulur)", "Grund (Pflichtfeld, für Audit gespeichert)"),
    logAdjustment: t("Log adjustment", "Düzeltmeyi kaydet", "Anpassung erfassen"),
    adjustmentLogged: t("Adjustment logged.", "Düzeltme kaydedildi.", "Anpassung erfasst."),
    colBy: t("By", "Yapan", "Von"),
    colReason: t("Reason", "Gerekçe", "Grund"),
    tabLinks: t("Links", "Linkler", "Links"),
    linksSearchTitle: t("Look up an affiliate's links", "Bir affiliate'in linklerini ara", "Links eines Affiliates suchen"),
    search: t("Search", "Ara", "Suchen"),
    colShortCode: t("Short URL", "Kısa URL", "Kurz-URL"),
    colTarget: t("Target", "Hedef", "Ziel"),
    colLinkStatus: t("Status", "Durum", "Status"),
    linkEnabled: t("Active", "Aktif", "Aktiv"),
    linkDisabled: t("Disabled", "Devre dışı", "Deaktiviert"),
    disable: t("Disable", "Devre dışı bırak", "Deaktivieren"),
    enable: t("Re-enable", "Yeniden etkinleştir", "Wieder aktivieren"),
    disableReasonPrompt: t("Reason for disabling (required, e.g. legal/fraud)", "Devre dışı bırakma gerekçesi (zorunlu, ör. yasal/fraud)", "Grund für Deaktivierung (Pflichtfeld, z. B. rechtlich/Fraud)"),
    noLinksFound: t("No links found for that affiliate code.", "Bu affiliate kodu için link bulunamadı.", "Keine Links für diesen Affiliate-Code gefunden."),
    searchPrompt: t("Enter an affiliate code above and search.", "Yukarıya bir affiliate kodu girin ve arayın.", "Oben einen Affiliate-Code eingeben und suchen."),
  };
};

export default function AffiliateAdminPage() {
  const locale = useLocale();
  const router = useRouter();
  const c = copy(locale);
  const [isSuperuser, setIsSuperuser] = useState(null);
  const [tab, setTab] = useState(0);
  const [pending, setPending] = useState(null);
  const [fraud, setFraud] = useState(null);
  const [payouts, setPayouts] = useState(null);
  const [adjustments, setAdjustments] = useState(null);
  const [error, setError] = useState("");
  const [logForm, setLogForm] = useState({ code: "", flagType: "brand_bid", severity: "medium", notes: "" });
  const [logBusy, setLogBusy] = useState(false);
  const [logMsg, setLogMsg] = useState("");
  const [adjForm, setAdjForm] = useState({ code: "", type: "bonus", amount: "", reason: "" });
  const [adjBusy, setAdjBusy] = useState(false);
  const [adjMsg, setAdjMsg] = useState("");
  const [linkSearchCode, setLinkSearchCode] = useState("");
  const [links, setLinks] = useState(null);
  const [linksBusyId, setLinksBusyId] = useState(null);

  useEffect(() => {
    const su = typeof window !== "undefined" && localStorage.getItem("sellerIsSuperuser") === "true";
    setIsSuperuser(su);
    if (!su) router.replace("/");
  }, [router]);

  const client = getMedusaAdminClient();

  const loadPending = useCallback(() => {
    client.getAffiliateAdminPending().then((d) => setPending(d.affiliates || [])).catch(() => { setPending([]); setError(c.loadError); });
  }, []);
  const loadFraud = useCallback(() => {
    client.getAffiliateFraudQueue().then((d) => setFraud(d.flags || [])).catch(() => { setFraud([]); setError(c.loadError); });
  }, []);
  const loadPayouts = useCallback(() => {
    client.getAffiliatePayoutHistory().then((d) => setPayouts(d.payouts || [])).catch(() => { setPayouts([]); setError(c.loadError); });
  }, []);
  const loadAdjustments = useCallback(() => {
    client.getAffiliateCommissionAdjustments().then((d) => setAdjustments(d.adjustments || [])).catch(() => { setAdjustments([]); setError(c.loadError); });
  }, []);

  useEffect(() => {
    if (!isSuperuser) return;
    loadPending();
    loadFraud();
    loadPayouts();
    loadAdjustments();
  }, [isSuperuser, loadPending, loadFraud, loadPayouts, loadAdjustments]);

  const approve = async (id) => {
    try { await client.approveAffiliate(id); loadPending(); } catch { setError(c.actionError); }
  };
  const reject = async (id) => {
    try { await client.rejectAffiliate(id); loadPending(); } catch { setError(c.actionError); }
  };
  const resolveFlag = async (id, action) => {
    try { await client.resolveAffiliateFraudFlag(id, action); loadFraud(); } catch { setError(c.actionError); }
  };

  const submitLogForm = async () => {
    if (!logForm.code.trim()) return;
    setLogBusy(true);
    setLogMsg("");
    try {
      await client.logAffiliateManualFraudFlag({
        affiliate_code: logForm.code.trim().toUpperCase(),
        flag_type: logForm.flagType,
        severity: logForm.severity,
        notes: logForm.notes,
      });
      setLogForm({ code: "", flagType: "brand_bid", severity: "medium", notes: "" });
      setLogMsg(c.logSuccess);
      loadFraud();
    } catch {
      setError(c.actionError);
    } finally {
      setLogBusy(false);
    }
  };

  const searchLinks = async () => {
    if (!linkSearchCode.trim()) return;
    setLinks(null);
    try {
      const d = await client.getAffiliateLinksByCode(linkSearchCode.trim().toUpperCase());
      setLinks(d.links || []);
    } catch {
      setLinks([]);
      setError(c.actionError);
    }
  };

  const toggleLink = async (link) => {
    setLinksBusyId(link.id);
    try {
      if (link.disabled_at) {
        await client.enableAffiliateLink(link.id);
      } else {
        const reason = window.prompt(c.disableReasonPrompt);
        if (!reason || !reason.trim()) { setLinksBusyId(null); return; }
        await client.disableAffiliateLink(link.id, reason.trim());
      }
      await searchLinks();
    } catch {
      setError(c.actionError);
    } finally {
      setLinksBusyId(null);
    }
  };

  const submitAdjForm = async () => {
    const amount = Number(adjForm.amount);
    if (!adjForm.code.trim() || !Number.isFinite(amount) || amount <= 0 || !adjForm.reason.trim()) return;
    setAdjBusy(true);
    setAdjMsg("");
    try {
      await client.createAffiliateCommissionAdjustment({
        affiliate_code: adjForm.code.trim().toUpperCase(),
        type: adjForm.type,
        amount_eur: amount,
        reason: adjForm.reason.trim(),
      });
      setAdjForm({ code: "", type: "bonus", amount: "", reason: "" });
      setAdjMsg(c.adjustmentLogged);
      loadAdjustments();
    } catch {
      setError(c.actionError);
    } finally {
      setAdjBusy(false);
    }
  };

  if (!isSuperuser) return null;

  const tabs = [
    { id: "pending", content: `${c.tabPending}${Array.isArray(pending) ? ` (${pending.length})` : ""}` },
    { id: "fraud", content: `${c.tabFraud}${Array.isArray(fraud) ? ` (${fraud.length})` : ""}` },
    { id: "payouts", content: c.tabPayouts },
    { id: "adjustments", content: c.tabAdjustments },
    { id: "links", content: c.tabLinks },
  ];

  return (
    <Page title={c.title}>
      <BlockStack gap="400">
        {error && <Banner tone="critical" onDismiss={() => setError("")}>{error}</Banner>}
        <Card padding="0">
          <Tabs tabs={tabs} selected={tab} onSelect={setTab} />
          <Box padding="0">
            {tab === 0 && (
              pending === null ? (
                <Box padding="800"><InlineStack align="center"><Spinner size="small" /></InlineStack></Box>
              ) : pending.length === 0 ? (
                <Box padding="600"><Text as="p" tone="subdued" alignment="center">{c.emptyPending}</Text></Box>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f6f6f7", textAlign: "left" }}>
                      {[c.colEmail, c.colCode, c.colCountry, c.colCreated, ""].map((h) => (
                        <th key={h} style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", borderBottom: "1px solid #e1e3e5" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pending.map((a) => (
                      <tr key={a.id} style={{ borderTop: "1px solid #f1f1f1" }}>
                        <td style={{ padding: "12px 16px" }}>
                          <div style={{ fontWeight: 600, color: "#111827" }}>{a.full_name || "—"}</div>
                          <div style={{ fontSize: 11, color: "#9ca3af" }}>{a.email}</div>
                        </td>
                        <td style={{ padding: "12px 16px" }}><code>{a.code}</code></td>
                        <td style={{ padding: "12px 16px" }}>{a.country || "—"}</td>
                        <td style={{ padding: "12px 16px", color: "#6d7175" }}>{fmtDate(a.created_at, locale)}</td>
                        <td style={{ padding: "12px 16px", textAlign: "right" }}>
                          <InlineStack gap="150" align="end">
                            <Button size="slim" onClick={() => reject(a.id)}>{c.reject}</Button>
                            <Button size="slim" variant="primary" onClick={() => approve(a.id)}>{c.approve}</Button>
                          </InlineStack>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {tab === 1 && (
              <>
                <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">{c.logCheckTitle}</Text>
                    <InlineStack gap="200" blockAlign="end" wrap>
                      <div style={{ minWidth: 140 }}>
                        <TextField
                          label={c.affiliateCode}
                          labelHidden
                          placeholder={c.affiliateCode}
                          value={logForm.code}
                          onChange={(v) => setLogForm((f) => ({ ...f, code: v }))}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ minWidth: 180 }}>
                        <Select
                          label={c.flagType}
                          labelHidden
                          options={[
                            { label: c.brandBid, value: "brand_bid" },
                            { label: c.manual, value: "manual" },
                          ]}
                          value={logForm.flagType}
                          onChange={(v) => setLogForm((f) => ({ ...f, flagType: v }))}
                        />
                      </div>
                      <div style={{ minWidth: 120 }}>
                        <Select
                          label={c.colSeverity}
                          labelHidden
                          options={[
                            { label: c.sevLow, value: "low" },
                            { label: c.sevMedium, value: "medium" },
                            { label: c.sevHigh, value: "high" },
                          ]}
                          value={logForm.severity}
                          onChange={(v) => setLogForm((f) => ({ ...f, severity: v }))}
                        />
                      </div>
                      <div style={{ minWidth: 220, flex: 1 }}>
                        <TextField
                          label={c.notes}
                          labelHidden
                          placeholder={c.notes}
                          value={logForm.notes}
                          onChange={(v) => setLogForm((f) => ({ ...f, notes: v }))}
                          autoComplete="off"
                        />
                      </div>
                      <Button onClick={submitLogForm} loading={logBusy} disabled={!logForm.code.trim()}>{c.logFinding}</Button>
                    </InlineStack>
                    {logMsg && <Text as="p" tone="success">{logMsg}</Text>}
                  </BlockStack>
                </Box>
                {fraud === null ? (
                <Box padding="800"><InlineStack align="center"><Spinner size="small" /></InlineStack></Box>
              ) : fraud.length === 0 ? (
                <Box padding="600"><Text as="p" tone="subdued" alignment="center">{c.emptyFraud}</Text></Box>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f6f6f7", textAlign: "left" }}>
                      {[c.colAffiliate, c.colType, c.colSeverity, c.colCreated, ""].map((h) => (
                        <th key={h} style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", borderBottom: "1px solid #e1e3e5" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fraud.map((f) => (
                      <tr key={f.id} style={{ borderTop: "1px solid #f1f1f1" }}>
                        <td style={{ padding: "12px 16px" }}>
                          <div style={{ fontWeight: 600, color: "#111827" }}>{f.affiliate_code}</div>
                          <div style={{ fontSize: 11, color: "#9ca3af" }}>{f.affiliate_email}</div>
                        </td>
                        <td style={{ padding: "12px 16px" }}>{f.flag_type}</td>
                        <td style={{ padding: "12px 16px" }}><Badge tone={SEVERITY_TONE[f.severity] || "info"}>{f.severity}</Badge></td>
                        <td style={{ padding: "12px 16px", color: "#6d7175" }}>{fmtDate(f.created_at, locale)}</td>
                        <td style={{ padding: "12px 16px", textAlign: "right" }}>
                          <InlineStack gap="150" align="end">
                            <Button size="slim" onClick={() => resolveFlag(f.id, "resolve")}>{c.resolve}</Button>
                            <Button size="slim" onClick={() => resolveFlag(f.id, "suspend")}>{c.suspend}</Button>
                            <Button size="slim" tone="critical" onClick={() => resolveFlag(f.id, "ban")}>{c.ban}</Button>
                          </InlineStack>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                )}
              </>
            )}

            {tab === 2 && (
              payouts === null ? (
                <Box padding="800"><InlineStack align="center"><Spinner size="small" /></InlineStack></Box>
              ) : payouts.length === 0 ? (
                <Box padding="600"><Text as="p" tone="subdued" alignment="center">{c.emptyPayouts}</Text></Box>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#f6f6f7", textAlign: "left" }}>
                      {[c.colAffiliate, c.colAmount, c.colStatus, c.colPeriod, c.colCreated].map((h) => (
                        <th key={h} style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", borderBottom: "1px solid #e1e3e5" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map((p) => (
                      <tr key={p.id} style={{ borderTop: "1px solid #f1f1f1" }}>
                        <td style={{ padding: "12px 16px" }}>
                          <div style={{ fontWeight: 600, color: "#111827" }}>{p.affiliate_code}</div>
                          <div style={{ fontSize: 11, color: "#9ca3af" }}>{p.affiliate_email}</div>
                        </td>
                        <td style={{ padding: "12px 16px", fontWeight: 600 }}>{fmtEur(p.amount_cents)}</td>
                        <td style={{ padding: "12px 16px" }}><Badge tone={PAYOUT_STATUS_TONE[p.status] || "info"}>{p.status}</Badge></td>
                        <td style={{ padding: "12px 16px", color: "#6d7175" }}>{p.period_start ? `${fmtDate(p.period_start, locale)} – ${fmtDate(p.period_end, locale)}` : "—"}</td>
                        <td style={{ padding: "12px 16px", color: "#6d7175" }}>{fmtDate(p.created_at, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {tab === 3 && (
              <>
                <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">{c.adjustmentFormTitle}</Text>
                    <InlineStack gap="200" blockAlign="end" wrap>
                      <div style={{ minWidth: 140 }}>
                        <TextField
                          label={c.affiliateCode}
                          labelHidden
                          placeholder={c.affiliateCode}
                          value={adjForm.code}
                          onChange={(v) => setAdjForm((f) => ({ ...f, code: v }))}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ minWidth: 170 }}>
                        <Select
                          label={c.adjustmentType}
                          labelHidden
                          options={[
                            { label: c.bonus, value: "bonus" },
                            { label: c.clawback, value: "clawback" },
                          ]}
                          value={adjForm.type}
                          onChange={(v) => setAdjForm((f) => ({ ...f, type: v }))}
                        />
                      </div>
                      <div style={{ minWidth: 120 }}>
                        <TextField
                          label={c.amountEur}
                          labelHidden
                          type="number"
                          min="0.01"
                          step="0.01"
                          placeholder={c.amountEur}
                          value={adjForm.amount}
                          onChange={(v) => setAdjForm((f) => ({ ...f, amount: v }))}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ minWidth: 220, flex: 1 }}>
                        <TextField
                          label={c.reason}
                          labelHidden
                          placeholder={c.reason}
                          value={adjForm.reason}
                          onChange={(v) => setAdjForm((f) => ({ ...f, reason: v }))}
                          autoComplete="off"
                        />
                      </div>
                      <Button
                        onClick={submitAdjForm}
                        loading={adjBusy}
                        disabled={!adjForm.code.trim() || !adjForm.amount || !adjForm.reason.trim()}
                      >
                        {c.logAdjustment}
                      </Button>
                    </InlineStack>
                    {adjMsg && <Text as="p" tone="success">{adjMsg}</Text>}
                  </BlockStack>
                </Box>
                {adjustments === null ? (
                  <Box padding="800"><InlineStack align="center"><Spinner size="small" /></InlineStack></Box>
                ) : adjustments.length === 0 ? (
                  <Box padding="600"><Text as="p" tone="subdued" alignment="center">{c.emptyAdjustments}</Text></Box>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "#f6f6f7", textAlign: "left" }}>
                        {[c.colAffiliate, c.colType, c.colAmount, c.colReason, c.colBy, c.colCreated].map((h) => (
                          <th key={h} style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", borderBottom: "1px solid #e1e3e5" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {adjustments.map((a) => (
                        <tr key={a.id} style={{ borderTop: "1px solid #f1f1f1" }}>
                          <td style={{ padding: "12px 16px" }}>
                            <div style={{ fontWeight: 600, color: "#111827" }}>{a.affiliate_code}</div>
                            <div style={{ fontSize: 11, color: "#9ca3af" }}>{a.affiliate_email}</div>
                          </td>
                          <td style={{ padding: "12px 16px" }}>
                            <Badge tone={a.source_type === "manual_bonus" ? "success" : "critical"}>
                              {a.source_type === "manual_bonus" ? c.bonus : c.clawback}
                            </Badge>
                          </td>
                          <td style={{ padding: "12px 16px", fontWeight: 700 }}>{fmtEur(a.commission_cents)}</td>
                          <td style={{ padding: "12px 16px", color: "#374151" }}>{a.adjustment_reason || "—"}</td>
                          <td style={{ padding: "12px 16px", color: "#6d7175" }}>{a.adjustment_by || "—"}</td>
                          <td style={{ padding: "12px 16px", color: "#6d7175" }}>{fmtDate(a.created_at, locale)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}

            {tab === 4 && (
              <>
                <Box padding="400" borderBlockEndWidth="025" borderColor="border">
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">{c.linksSearchTitle}</Text>
                    <InlineStack gap="200" blockAlign="end">
                      <div style={{ minWidth: 180 }}>
                        <TextField
                          label={c.affiliateCode}
                          labelHidden
                          placeholder={c.affiliateCode}
                          value={linkSearchCode}
                          onChange={setLinkSearchCode}
                          autoComplete="off"
                        />
                      </div>
                      <Button onClick={searchLinks} disabled={!linkSearchCode.trim()}>{c.search}</Button>
                    </InlineStack>
                  </BlockStack>
                </Box>
                {links === null ? (
                  <Box padding="600"><Text as="p" tone="subdued" alignment="center">{c.searchPrompt}</Text></Box>
                ) : links.length === 0 ? (
                  <Box padding="600"><Text as="p" tone="subdued" alignment="center">{c.noLinksFound}</Text></Box>
                ) : (
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: "#f6f6f7", textAlign: "left" }}>
                        {[c.colShortCode, c.colType, c.colTarget, c.colLinkStatus, c.colCreated, ""].map((h) => (
                          <th key={h} style={{ padding: "10px 16px", fontSize: 11, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", borderBottom: "1px solid #e1e3e5" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {links.map((l) => (
                        <tr key={l.id} style={{ borderTop: "1px solid #f1f1f1" }}>
                          <td style={{ padding: "12px 16px" }}><code>/r/{l.short_code}</code></td>
                          <td style={{ padding: "12px 16px" }}>{l.type}</td>
                          <td style={{ padding: "12px 16px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.target_url}>{l.target_url}</td>
                          <td style={{ padding: "12px 16px" }}>
                            <Badge tone={l.disabled_at ? "critical" : "success"}>{l.disabled_at ? c.linkDisabled : c.linkEnabled}</Badge>
                            {l.disabled_at && l.disabled_reason && (
                              <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 2 }}>{l.disabled_reason}</div>
                            )}
                          </td>
                          <td style={{ padding: "12px 16px", color: "#6d7175" }}>{fmtDate(l.created_at, locale)}</td>
                          <td style={{ padding: "12px 16px", textAlign: "right" }}>
                            <Button size="slim" tone={l.disabled_at ? undefined : "critical"} loading={linksBusyId === l.id} onClick={() => toggleLink(l)}>
                              {l.disabled_at ? c.enable : c.disable}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </Box>
        </Card>
      </BlockStack>
    </Page>
  );
}
