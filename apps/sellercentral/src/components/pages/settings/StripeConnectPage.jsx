"use client";

import React, { useEffect, useState } from "react";
import { Banner, BlockStack, Box, Button, Card, InlineStack, Text } from "@shopify/polaris";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/i18n/navigation";
import { useLocale } from "next-intl";
import { getUI } from "@/lib/ui-strings";
import { getMedusaAdminClient } from "@/lib/medusa-admin-client";
import { lt } from "@/lib/locale-text";
import { userError } from "@/lib/api-error-messages";

export default function StripeConnectPage() {
  const locale = useLocale();
  const ui = getUI(locale);
  const searchParams = useSearchParams();
  const router = useRouter();
  const client = getMedusaAdminClient();

  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(null);
  // null → { connected, onboarding_complete, stripe_account_id, commission_rate }
  const [isSuperuser, setIsSuperuser] = useState(null); // null = unknown yet, true/false once read

  const justConnected = searchParams?.get("connected") === "true";
  const needsRefresh  = searchParams?.get("refresh") === "true";

  useEffect(() => {
    if (typeof window === "undefined") return;
    setIsSuperuser(localStorage.getItem("sellerIsSuperuser") === "true");
  }, []);

  useEffect(() => {
    if (isSuperuser) fetchStatus();
  }, [isSuperuser]);

  // If Stripe redirected back with ?connected=true, re-fetch status (Stripe might have updated)
  useEffect(() => {
    if (isSuperuser && (justConnected || needsRefresh)) fetchStatus();
  }, [isSuperuser, justConnected, needsRefresh]);

  const fetchStatus = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await client.stripeConnectStatus();
      setStatus(data);
    } catch (e) {
      setError(userError(e, locale, "Failed to load Stripe Connect status."));
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    setConnecting(true);
    setError("");
    try {
      const data = await client.stripeConnectOnboard();
      if (data?.url) {
        // Redirect to Stripe's hosted onboarding
        window.location.href = data.url;
      } else {
        throw new Error("No onboarding URL returned.");
      }
    } catch (e) {
      setError(userError(e, locale, "Failed to start Stripe Connect onboarding."));
      setConnecting(false);
    }
  };

  const handleDashboard = async () => {
    setDashboardLoading(true);
    setError("");
    try {
      const data = await client.stripeConnectDashboardLink();
      if (data?.url) window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (e) {
      setError(userError(e, locale, "Failed to get dashboard link."));
    } finally {
      setDashboardLoading(false);
    }
  };

  const commissionPct = status ? Math.round((status.commission_rate ?? 0.12) * 100) : 12;
  const sellerPct = 100 - commissionPct;

  const t = (en, tr, fr, es, it, de) => lt(locale, en, tr, fr, es, it, de);
  const copy = {
    headerTitle: t("Stripe Connect — Payouts", "Stripe Connect — Ödemeler", "Stripe Connect — Versements", "Stripe Connect — Pagos", "Stripe Connect — Pagamenti", "Stripe Connect — Auszahlungen"),
    headerDesc: t(
      `Connect your Stripe account to receive payouts directly. After delivery +14 days, ${sellerPct}% will be automatically transferred to you — Andertal retains the ${commissionPct}% platform fee.`,
      `Doğrudan ödeme almak için Stripe hesabınızı bağlayın. Teslimat +14 gün sonra ${sellerPct}% otomatik olarak size aktarılır — Andertal %${commissionPct} platform ücretini alıkoyar.`,
      `Connectez votre compte Stripe pour recevoir des versements directement. Après livraison +14 jours, ${sellerPct}% vous seront versés automatiquement — Andertal conserve les ${commissionPct}% de frais de plateforme.`,
      `Conecte su cuenta Stripe para recibir pagos directamente. Tras la entrega +14 días, se le transferirá automáticamente el ${sellerPct}% — Andertal retiene el ${commissionPct}% de tarifa de plataforma.`,
      `Collega il tuo account Stripe per ricevere i pagamenti direttamente. Dopo la consegna +14 giorni, il ${sellerPct}% verrà trasferito automaticamente a te — Andertal trattiene il ${commissionPct}% come commissione di piattaforma.`,
      `Verbinde dein Stripe-Konto, um Auszahlungen direkt zu erhalten. Nach Lieferung +14 Tagen werden automatisch ${sellerPct}% an dich überwiesen — ${commissionPct}% Plattformgebühr behält Andertal.`,
    ),
    connectedSuccess: t("Stripe account successfully connected! Payouts will be processed automatically from now on.", "Stripe hesabı başarıyla bağlandı! Ödemeler artık otomatik olarak işlenecek.", "Compte Stripe connecté avec succès ! Les versements seront traités automatiquement désormais.", "¡Cuenta Stripe conectada con éxito! Los pagos se procesarán automáticamente a partir de ahora.", "Account Stripe connesso con successo! I pagamenti verranno elaborati automaticamente da ora in poi.", "Stripe-Konto erfolgreich verbunden! Auszahlungen werden ab sofort automatisch verarbeitet."),
    refreshExpired: t('The onboarding link has expired. Click "Connect Stripe" below again.', '"Stripe\'ı Bağla"ya aşağıdan tekrar tıklayın. Bağlantı süresi doldu.', 'Le lien d\'inscription a expiré. Cliquez à nouveau sur « Connecter Stripe » ci-dessous.', 'El enlace de incorporación ha caducado. Haga clic de nuevo en "Conectar Stripe" a continuación.', 'Il link di onboarding è scaduto. Fai clic di nuovo su "Collega Stripe" qui sotto.', 'Der Onboarding-Link ist abgelaufen. Klicke unten erneut auf "Stripe verbinden".'),
    statusConnectedActive: t("Connected & active", "Bağlandı & aktif", "Connecté & actif", "Conectado y activo", "Connesso & attivo", "Verbunden & aktiv"),
    statusConnectedPending: t("Connected — onboarding pending", "Bağlandı — kayıt beklemede", "Connecté — inscription en attente", "Conectado — incorporación pendiente", "Connesso — onboarding in attesa", "Verbunden — Onboarding ausstehend"),
    statusNotConnected: t("Not connected", "Bağlı değil", "Non connecté", "No conectado", "Non connesso", "Nicht verbunden"),
    accountId: t("Account ID", "Hesap Kimliği", "ID de compte", "ID de cuenta", "ID account", "Konto-ID"),
    howPayoutsWork: t("How payouts work:", "Ödemeler nasıl çalışır:", "Comment fonctionnent les versements :", "Cómo funcionan los pagos:", "Come funzionano i pagamenti:", "Wie Auszahlungen funktionieren:"),
    howPayoutsDesc: t(
      <>When a customer pays, the payout is automatically released after delivery +14 days and Stripe transfers <strong>{sellerPct}%</strong> of the product value directly to your connected account. The {commissionPct}% platform fee stays with Andertal. Payouts appear in your Stripe Express Dashboard.</>,
      <>Bir müşteri ödeme yaptığında, ödeme teslimat +14 gün sonra otomatik olarak serbest bırakılır ve Stripe ürün değerinin <strong>{sellerPct}%</strong>'sini doğrudan bağlı hesabınıza aktarır. {commissionPct}% platform ücreti Andertal'da kalır. Ödemeler Stripe Express Dashboard'unuzda görünür.</>,
      <>Lorsqu'un client paie, le versement est automatiquement libéré après livraison +14 jours et Stripe transfère <strong>{sellerPct}%</strong> de la valeur du produit directement sur votre compte connecté. Les {commissionPct}% de frais de plateforme restent chez Andertal. Les versements apparaissent dans votre Stripe Express Dashboard.</>,
      <>Cuando un cliente paga, el pago se libera automáticamente tras la entrega +14 días y Stripe transfiere <strong>{sellerPct}%</strong> del valor del producto directamente a su cuenta conectada. El {commissionPct}% de tarifa de plataforma se queda en Andertal. Los pagos aparecen en su Stripe Express Dashboard.</>,
      <>Quando un cliente paga, il pagamento viene rilasciato automaticamente dopo la consegna +14 giorni e Stripe trasferisce <strong>{sellerPct}%</strong> del valore del prodotto direttamente sul tuo account connesso. Il {commissionPct}% di commissione di piattaforma rimane ad Andertal. I pagamenti appaiono nel tuo Stripe Express Dashboard.</>,
      <>Wenn ein Kunde bezahlt, wird die Auszahlung nach Lieferung +14 Tagen automatisch freigegeben und Stripe überweist <strong>{sellerPct}%</strong> des Produktwerts direkt auf dein verbundenes Konto. Die {commissionPct}% Plattformgebühr verbleibt bei Andertal. Auszahlungen erscheinen in deinem Stripe Express Dashboard.</>,
    ),
    onboardingIncomplete: t('You have not yet fully completed the Stripe registration. Click "Continue onboarding" to enter your bank and identity details with Stripe. Until then, no payouts will be processed.', '"Kayıta devam et"e tıklayarak Stripe\'ta banka ve kimlik bilgilerinizi girin. Siz bunu yapana kadar ödeme işlenmez.', 'Vous n\'avez pas encore entièrement complété l\'inscription Stripe. Cliquez sur « Continuer l\'inscription » pour saisir vos coordonnées bancaires et d\'identité chez Stripe. Jusque-là, aucun versement ne sera traité.', 'Aún no ha completado el registro de Stripe. Haga clic en "Continuar incorporación" para ingresar sus datos bancarios e identidad en Stripe. Hasta entonces no se procesarán pagos.', 'Non hai ancora completato completamente la registrazione Stripe. Fai clic su "Continua onboarding" per inserire i tuoi dati bancari e di identità su Stripe. Nel frattempo non verranno elaborati pagamenti.', 'Du hast die Stripe-Registrierung noch nicht vollständig abgeschlossen. Klicke auf "Onboarding fortsetzen", um deine Bank- und Identitätsdaten bei Stripe einzutragen. Bis dahin werden keine Auszahlungen verarbeitet.'),
    btnConnectStripe: t("Connect Stripe", "Stripe'ı Bağla", "Connecter Stripe", "Conectar Stripe", "Collega Stripe", "Stripe verbinden"),
    btnContinueOnboarding: t("Continue onboarding", "Kayıta devam et", "Continuer l'inscription", "Continuar incorporación", "Continua onboarding", "Onboarding fortsetzen"),
    btnOpenDashboard: t("Open Stripe Dashboard ↗", "Stripe Dashboard'u Aç ↗", "Ouvrir le Dashboard Stripe ↗", "Abrir Dashboard de Stripe ↗", "Apri Stripe Dashboard ↗", "Stripe Dashboard öffnen ↗"),
    btnRefreshStatus: t("Refresh status", "Durumu yenile", "Actualiser le statut", "Actualizar estado", "Aggiorna stato", "Status aktualisieren"),
    commissionTitle: t("Payout breakdown", "Ödeme dağılımı", "Répartition des versements", "Desglose de pagos", "Ripartizione dei pagamenti", "Vergütungsaufteilung"),
    labelProductPrice: t("Product price", "Ürün fiyatı", "Prix du produit", "Precio del producto", "Prezzo del prodotto", "Produktpreis"),
    labelProductPriceSub: t("what the customer pays", "müşterinin ödediği", "ce que paie le client", "lo que paga el cliente", "quello che paga il cliente", "was der Kunde zahlt"),
    labelYourPayout: t("Your payout", "Sizin ödemeniz", "Votre versement", "Su pago", "Il tuo pagamento", "Deine Auszahlung"),
    labelYourPayoutSub: t("automatically via Stripe", "Stripe üzerinden otomatik", "automatiquement via Stripe", "automáticamente vía Stripe", "automaticamente via Stripe", "automatisch via Stripe"),
    labelPlatformFee: t("Platform fee", "Platform ücreti", "Frais de plateforme", "Tarifa de plataforma", "Commissione di piattaforma", "Plattformgebühr"),
    labelPlatformFeeSub: t("incl. Stripe fees", "Stripe ücretleri dahil", "frais Stripe inclus", "incl. tarifas de Stripe", "incl. commissioni Stripe", "inkl. Stripe-Gebühren"),
  };

  if (isSuperuser === null) {
    return (
      <Card><Text as="p" tone="subdued">{ui.loading}</Text></Card>
    );
  }

  if (!isSuperuser) {
    return (
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">{copy.headerTitle}</Text>
          <Banner tone="info">
            {t(
              "Sellers don't manage Stripe directly — payouts are handled automatically by Andertal. This page is for platform administrators only.",
              "Satıcılar Stripe'ı doğrudan yönetmez — ödemeler Andertal tarafından otomatik olarak yapılır. Bu sayfa yalnızca platform yöneticileri içindir.",
              "Les vendeurs ne gèrent pas Stripe directement — les versements sont traités automatiquement par Andertal. Cette page est réservée aux administrateurs de la plateforme.",
              "Los vendedores no gestionan Stripe directamente — los pagos los procesa Andertal automáticamente. Esta página es solo para administradores de la plataforma.",
              "I venditori non gestiscono Stripe direttamente — i pagamenti sono elaborati automaticamente da Andertal. Questa pagina è solo per gli amministratori della piattaforma.",
              "Verkäufer verwalten Stripe nicht direkt — Auszahlungen erfolgen automatisch über Andertal. Diese Seite ist nur für Plattform-Administratoren.",
            )}
          </Banner>
        </BlockStack>
      </Card>
    );
  }

  return (
    <BlockStack gap="400">
      {/* Header */}
      <Card>
        <BlockStack gap="200">
          <Text as="h2" variant="headingMd">{copy.headerTitle}</Text>
          <Text as="p" tone="subdued">{copy.headerDesc}</Text>
        </BlockStack>
      </Card>

      {/* Just connected success */}
      {justConnected && (
        <Banner tone="success" onDismiss={() => router.replace("/settings/stripe-connect")}>
          {copy.connectedSuccess}
        </Banner>
      )}

      {/* Needs refresh */}
      {needsRefresh && !justConnected && (
        <Banner tone="warning" onDismiss={() => router.replace("/settings/stripe-connect")}>
          {copy.refreshExpired}
        </Banner>
      )}

      {error && (
        <Banner tone="critical" onDismiss={() => setError("")}>{error}</Banner>
      )}

      {loading ? (
        <Card><Text as="p" tone="subdued">{ui.loading}</Text></Card>
      ) : (
        <>
          {/* Status card */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">Status</Text>

              <InlineStack gap="300" blockAlign="center">
                {/* Connection dot */}
                <span style={{
                  display: "inline-block", width: 12, height: 12, borderRadius: "50%", flexShrink: 0,
                  background: status?.onboarding_complete ? "#10b981" : status?.connected ? "#f59e0b" : "#d1d5db",
                }} />
                <BlockStack gap="0">
                  <Text as="p" variant="bodyMd" fontWeight="semibold">
                    {status?.onboarding_complete
                      ? copy.statusConnectedActive
                      : status?.connected
                      ? copy.statusConnectedPending
                      : copy.statusNotConnected}
                  </Text>
                  {status?.stripe_account_id && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {copy.accountId}: {status.stripe_account_id}
                    </Text>
                  )}
                </BlockStack>
              </InlineStack>

              {/* How it works */}
              {status?.onboarding_complete && (
                <Box background="bg-surface-secondary" borderRadius="200" padding="300">
                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" fontWeight="semibold">{copy.howPayoutsWork}</Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {copy.howPayoutsDesc}
                    </Text>
                  </BlockStack>
                </Box>
              )}

              {/* Onboarding incomplete warning */}
              {status?.connected && !status?.onboarding_complete && (
                <Box background="bg-surface-caution" borderRadius="200" padding="300">
                  <Text as="p" variant="bodySm">
                    {copy.onboardingIncomplete}
                  </Text>
                </Box>
              )}
            </BlockStack>
          </Card>

          {/* Actions */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">{ui.actions}</Text>
              <InlineStack gap="300" wrap>
                {!status?.connected ? (
                  <Button variant="primary" onClick={handleConnect} loading={connecting}>
                    {copy.btnConnectStripe}
                  </Button>
                ) : !status?.onboarding_complete ? (
                  <Button variant="primary" onClick={handleConnect} loading={connecting}>
                    {copy.btnContinueOnboarding}
                  </Button>
                ) : (
                  <Button onClick={handleDashboard} loading={dashboardLoading}>
                    {copy.btnOpenDashboard}
                  </Button>
                )}
                {status?.connected && (
                  <Button onClick={fetchStatus} loading={loading} size="slim">
                    {copy.btnRefreshStatus}
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </Card>

          {/* Commission breakdown */}
          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">{copy.commissionTitle}</Text>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                {[
                  { label: copy.labelProductPrice, value: "100%", sub: copy.labelProductPriceSub },
                  { label: copy.labelYourPayout, value: `${sellerPct}%`, sub: copy.labelYourPayoutSub, highlight: true },
                  { label: copy.labelPlatformFee, value: `${commissionPct}%`, sub: copy.labelPlatformFeeSub },
                ].map(({ label, value, sub, highlight }) => (
                  <Box
                    key={label}
                    background={highlight ? "bg-surface-selected" : "bg-surface-secondary"}
                    borderRadius="200"
                    padding="300"
                  >
                    <BlockStack gap="100">
                      <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
                      <Text as="p" variant="headingLg" fontWeight="bold"
                        tone={highlight ? "success" : undefined}>
                        {value}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">{sub}</Text>
                    </BlockStack>
                  </Box>
                ))}
              </div>
            </BlockStack>
          </Card>
        </>
      )}
    </BlockStack>
  );
}
