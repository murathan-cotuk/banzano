'use client'
import { useState, useEffect } from 'react'
import { useLocale } from 'next-intl'
import AuthGuard from '../../../components/AuthGuard'
import PortalNav from '../../../components/PortalNav'
import { api } from '../../../lib/api'

const S = {
  page: { minHeight: '100vh', background: '#f7f8fa' },
  main: { maxWidth: 700, margin: '0 auto', padding: '36px 24px' },
  h1: { fontSize: 26, fontWeight: 700, color: '#111', margin: '0 0 4px' },
  sub: { fontSize: 14, color: '#666', margin: '0 0 28px' },
  card: { background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', padding: '24px 26px', marginBottom: 20 },
  sectionTitle: { fontSize: 16, fontWeight: 700, color: '#111', marginBottom: 6 },
  desc: { fontSize: 13.5, color: '#6b7280', lineHeight: 1.6, marginBottom: 18 },
  row: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  btn: { padding: '10px 18px', background: '#111827', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  btnGhost: { padding: '10px 18px', background: '#fff', color: '#333', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer' },
  badge: (bg, fg) => ({ display: 'inline-block', padding: '4px 12px', borderRadius: 999, fontSize: 13, fontWeight: 600, background: bg, color: fg }),
  note: { background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 10, padding: '12px 16px', color: '#92400e', fontSize: 13.5, marginTop: 14 },
}

const TEXTS = {
  de: {
    title: 'Einstellungen', sub: 'Zahlungsdaten und Kontoinformationen.',
    stripeTitle: 'Auszahlung — Stripe Connect', stripeDesc: 'Verbinde dein Stripe-Konto, um Provisionen ausgezahlt zu bekommen. Auszahlungen erfolgen automatisch am 1. jedes Monats, sobald der Mindestbetrag erreicht ist.',
    connect: 'Stripe verbinden', continueSetup: 'Einrichtung fortsetzen', openDashboard: 'Stripe-Dashboard öffnen', refresh: 'Status aktualisieren',
    notConnected: 'Nicht verbunden', pending: 'Einrichtung unvollständig', complete: 'Verbunden',
    warnNotConnected: 'Ohne verbundenes Stripe-Konto können keine Provisionen ausgezahlt werden.',
    loading: 'Lädt…', error: 'Aktion fehlgeschlagen. Bitte erneut versuchen.',
  },
  tr: {
    title: 'Ayarlar', sub: 'Ödeme bilgileri ve hesap ayarları.',
    stripeTitle: 'Ödeme — Stripe Connect', stripeDesc: 'Komisyonlarının ödenebilmesi için Stripe hesabını bağla. Ödemeler, asgari tutara ulaşıldığında her ayın 1\'inde otomatik yapılır.',
    connect: 'Stripe\'ı bağla', continueSetup: 'Kuruluma devam et', openDashboard: 'Stripe panelini aç', refresh: 'Durumu yenile',
    notConnected: 'Bağlı değil', pending: 'Kurulum tamamlanmadı', complete: 'Bağlandı',
    warnNotConnected: 'Stripe hesabı bağlanmadan komisyon ödemesi yapılamaz.',
    loading: 'Yükleniyor…', error: 'İşlem başarısız. Lütfen tekrar deneyin.',
  },
  en: {
    title: 'Settings', sub: 'Payout details and account settings.',
    stripeTitle: 'Payout — Stripe Connect', stripeDesc: "Connect your Stripe account so your commissions can be paid out. Payouts run automatically on the 1st of each month once you reach the minimum amount.",
    connect: 'Connect Stripe', continueSetup: 'Continue setup', openDashboard: 'Open Stripe dashboard', refresh: 'Refresh status',
    notConnected: 'Not connected', pending: 'Setup incomplete', complete: 'Connected',
    warnNotConnected: 'Commissions cannot be paid out without a connected Stripe account.',
    loading: 'Loading…', error: 'Action failed. Please try again.',
  },
  fr: {
    title: 'Paramètres', sub: 'Informations de paiement et paramètres du compte.',
    stripeTitle: 'Paiement — Stripe Connect', stripeDesc: 'Connectez votre compte Stripe pour recevoir vos commissions. Les paiements sont effectués automatiquement le 1er de chaque mois une fois le montant minimum atteint.',
    connect: 'Connecter Stripe', continueSetup: 'Continuer la configuration', openDashboard: 'Ouvrir le tableau de bord Stripe', refresh: 'Actualiser le statut',
    notConnected: 'Non connecté', pending: 'Configuration incomplète', complete: 'Connecté',
    warnNotConnected: 'Les commissions ne peuvent pas être versées sans compte Stripe connecté.',
    loading: 'Chargement…', error: "Échec de l'action. Veuillez réessayer.",
  },
  es: {
    title: 'Ajustes', sub: 'Datos de pago y configuración de la cuenta.',
    stripeTitle: 'Pago — Stripe Connect', stripeDesc: 'Conecta tu cuenta de Stripe para poder recibir tus comisiones. Los pagos se realizan automáticamente el día 1 de cada mes al alcanzar el importe mínimo.',
    connect: 'Conectar Stripe', continueSetup: 'Continuar configuración', openDashboard: 'Abrir panel de Stripe', refresh: 'Actualizar estado',
    notConnected: 'No conectado', pending: 'Configuración incompleta', complete: 'Conectado',
    warnNotConnected: 'No se pueden pagar comisiones sin una cuenta de Stripe conectada.',
    loading: 'Cargando…', error: 'La acción falló. Inténtalo de nuevo.',
  },
  it: {
    title: 'Impostazioni', sub: 'Dati di pagamento e impostazioni account.',
    stripeTitle: 'Pagamento — Stripe Connect', stripeDesc: 'Collega il tuo account Stripe per ricevere le tue commissioni. I pagamenti vengono effettuati automaticamente il 1° di ogni mese al raggiungimento dell\'importo minimo.',
    connect: 'Collega Stripe', continueSetup: 'Continua configurazione', openDashboard: 'Apri dashboard Stripe', refresh: 'Aggiorna stato',
    notConnected: 'Non collegato', pending: 'Configurazione incompleta', complete: 'Collegato',
    warnNotConnected: 'Le commissioni non possono essere pagate senza un account Stripe collegato.',
    loading: 'Caricamento…', error: 'Azione non riuscita. Riprova.',
  },
}

export default function SettingsPage() {
  const locale = useLocale()
  const t = TEXTS[locale] || TEXTS.de
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = () => {
    api.stripeConnectStatus().then(setStatus).catch(() => setError(t.error))
  }

  // Reads location.search directly (rather than next/navigation's useSearchParams) so this page
  // doesn't need a Suspense boundary just to notice the ?connected=true / ?refresh=true params
  // Stripe's Account Link return_url/refresh_url land on after onboarding.
  useEffect(() => {
    load()
  }, [])

  const onboard = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await api.stripeConnectOnboard()
      if (r.url) window.location.href = r.url
    } catch {
      setError(t.error)
      setBusy(false)
    }
  }

  const openDashboard = async () => {
    setBusy(true)
    setError('')
    try {
      const r = await api.stripeConnectDashboardLink()
      if (r.url) window.open(r.url, '_blank', 'noopener')
    } catch {
      setError(t.error)
    } finally {
      setBusy(false)
    }
  }

  const badge = !status
    ? null
    : status.onboarding_complete
      ? S.badge('#f0fdf4', '#15803d')
      : status.connected
        ? S.badge('#fffbeb', '#92400e')
        : S.badge('#f3f4f6', '#4b5563')
  const badgeLabel = !status ? t.loading : status.onboarding_complete ? t.complete : status.connected ? t.pending : t.notConnected

  return (
    <AuthGuard>
      <div style={S.page}>
        <PortalNav />
        <div style={S.main}>
          <h1 style={S.h1}>{t.title}</h1>
          <p style={S.sub}>{t.sub}</p>

          <div style={S.card}>
            <div style={S.sectionTitle}>{t.stripeTitle}</div>
            <p style={S.desc}>{t.stripeDesc}</p>
            <div style={S.row}>
              {badge && <span style={badge}>{badgeLabel}</span>}
              {status && !status.onboarding_complete && (
                <button style={S.btn} onClick={onboard} disabled={busy}>
                  {status.connected ? t.continueSetup : t.connect}
                </button>
              )}
              {status?.onboarding_complete && (
                <button style={S.btnGhost} onClick={openDashboard} disabled={busy}>{t.openDashboard}</button>
              )}
              <button style={S.btnGhost} onClick={load} disabled={busy}>{t.refresh}</button>
            </div>
            {status && !status.connected && (
              <div style={S.note}>{t.warnNotConnected}</div>
            )}
            {error && <div style={{ ...S.note, background: '#fef2f2', border: '1px solid #ef4444', color: '#991b1b' }}>{error}</div>}
          </div>
        </div>
      </div>
    </AuthGuard>
  )
}
