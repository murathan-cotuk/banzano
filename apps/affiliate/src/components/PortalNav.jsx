'use client'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter, usePathname } from 'next/navigation'
import { clearToken } from '../lib/api'

const S = {
  nav: { display: 'flex', alignItems: 'center', height: 56, background: '#0c0c0c', padding: '0 28px', gap: 32, position: 'sticky', top: 0, zIndex: 100 },
  brand: { fontSize: 16, fontWeight: 700, color: '#fff', textDecoration: 'none', marginRight: 8 },
  sep: { width: 1, height: 20, background: '#333' },
  link: (active) => ({ color: active ? '#fff' : '#888', textDecoration: 'none', fontSize: 14, fontWeight: active ? 600 : 400, transition: 'color 0.15s', cursor: 'pointer' }),
  spacer: { flex: 1 },
  logoutBtn: { background: 'none', border: 'none', color: '#888', fontSize: 14, cursor: 'pointer', padding: 0 },
}

export default function PortalNav() {
  const t = useTranslations('nav')
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()

  const isActive = (seg) => pathname.includes(`/${seg}`)

  function logout() {
    clearToken()
    router.push(`/${locale}/login`)
  }

  return (
    <nav style={S.nav}>
      <a href={`/${locale}/dashboard`} style={S.brand}>Andertal <span style={{ color: '#555', fontWeight: 400 }}>Affiliates</span></a>
      <div style={S.sep} />
      <a href={`/${locale}/dashboard`} style={S.link(isActive('dashboard'))}>{t('dashboard')}</a>
      <a href={`/${locale}/links`} style={S.link(isActive('links'))}>{t('links')}</a>
      <a href={`/${locale}/referrals`} style={S.link(isActive('referrals'))}>{t('referrals')}</a>
      <a href={`/${locale}/reports`} style={S.link(isActive('reports'))}>{t('reports')}</a>
      <a href={`/${locale}/payouts`} style={S.link(isActive('payouts'))}>{t('payouts')}</a>
      <a href={`/${locale}/resources`} style={S.link(isActive('resources'))}>{t('resources')}</a>
      <a href={`/${locale}/settings`} style={S.link(isActive('settings'))}>{t('settings')}</a>
      <a href={`/${locale}/terms`} style={S.link(isActive('terms'))}>{t('terms')}</a>
      <div style={S.spacer} />
      <button style={S.logoutBtn} onClick={logout}>{t('logout')}</button>
    </nav>
  )
}
