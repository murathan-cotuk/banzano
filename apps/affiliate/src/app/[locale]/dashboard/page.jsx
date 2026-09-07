'use client'
import { useState, useEffect } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import AuthGuard from '../../../components/AuthGuard'
import PortalNav from '../../../components/PortalNav'
import { api } from '../../../lib/api'

const S = {
  page: { minHeight: '100vh', background: '#f7f8fa' },
  main: { maxWidth: 900, margin: '0 auto', padding: '36px 24px' },
  h1: { fontSize: 26, fontWeight: 700, color: '#111', margin: '0 0 4px' },
  sub: { fontSize: 14, color: '#666', margin: '0 0 24px' },
  pendingBanner: { background: '#fffbeb', border: '1px solid #f59e0b', borderRadius: 10, padding: '14px 18px', color: '#92400e', fontSize: 14, marginBottom: 28 },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 16, marginBottom: 36 },
  stat: { background: '#fff', borderRadius: 10, padding: '20px 22px', boxShadow: '0 1px 4px rgba(0,0,0,0.06)' },
  statVal: { fontSize: 32, fontWeight: 700, color: '#111', lineHeight: 1.1 },
  statLabel: { fontSize: 13, color: '#888', marginTop: 4 },
  section: { marginBottom: 36 },
  sectionTitle: { fontSize: 15, fontWeight: 600, color: '#333', marginBottom: 14 },
  quickBtns: { display: 'flex', gap: 12 },
  qBtn: { padding: '10px 18px', background: '#111827', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer', textDecoration: 'none' },
  qBtnGhost: { padding: '10px 18px', background: '#fff', color: '#333', border: '1.5px solid #e0e0e0', borderRadius: 8, fontSize: 14, fontWeight: 500, cursor: 'pointer', textDecoration: 'none' },
}

function formatEur(cents) {
  return ((cents || 0) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' })
}

export default function DashboardPage() {
  const t = useTranslations('dashboard')
  const locale = useLocale()
  const [me, setMe] = useState(null)
  const [stats, setStats] = useState(null)

  useEffect(() => {
    api.me().then((r) => setMe(r.affiliate)).catch(() => {})
    api.dashboard().then(setStats).catch(() => {})
  }, [])

  return (
    <AuthGuard>
      <div style={S.page}>
        <PortalNav />
        <div style={S.main}>
          <h1 style={S.h1}>{t('welcome')}{me?.full_name ? `, ${me.full_name}` : ''}</h1>
          <p style={S.sub}>{t('title')}</p>

          {me?.status === 'pending' && (
            <div style={S.pendingBanner}>{t('pendingApproval')}</div>
          )}
          {me?.status === 'suspended' && (
            <div style={{ ...S.pendingBanner, background: '#fef2f2', border: '1px solid #ef4444', color: '#991b1b' }}>{t('suspended')}</div>
          )}

          <div style={S.stats}>
            <div style={S.stat}><div style={S.statVal}>{stats?.active_links ?? '—'}</div><div style={S.statLabel}>{t('activeLinks')}</div></div>
            <div style={S.stat}><div style={S.statVal}>{stats?.total_clicks ?? '—'}</div><div style={S.statLabel}>{t('totalClicks')}</div></div>
            <div style={S.stat}><div style={S.statVal}>{stats?.referred_sellers ?? '—'}</div><div style={S.statLabel}>{t('referredSellers')}</div></div>
            <div style={S.stat}><div style={S.statVal}>{stats ? formatEur(stats.pending_commission_cents) : '—'}</div><div style={S.statLabel}>{t('pendingCommission')}</div></div>
            <div style={S.stat}><div style={S.statVal}>{stats ? formatEur(stats.confirmed_commission_cents) : '—'}</div><div style={S.statLabel}>{t('confirmedCommission')}</div></div>
          </div>

          <div style={S.section}>
            <div style={S.sectionTitle}>{t('quickActions')}</div>
            <div style={S.quickBtns}>
              <a href={`/${locale}/links/new`} style={S.qBtn}>{t('createLink')}</a>
              <a href={`/${locale}/links`} style={S.qBtnGhost}>{t('viewLinks')}</a>
            </div>
          </div>
        </div>
      </div>
    </AuthGuard>
  )
}
