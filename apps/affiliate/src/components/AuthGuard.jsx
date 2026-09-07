'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale } from 'next-intl'
import { api, clearToken } from '../lib/api'

export default function AuthGuard({ children }) {
  const router = useRouter()
  const locale = useLocale()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const token = localStorage.getItem('aff_token')
    if (!token) {
      router.replace(`/${locale}/login`)
      return
    }
    api.me().then(() => setReady(true)).catch(() => {
      clearToken()
      router.replace(`/${locale}/login`)
    })
  }, [locale, router])

  if (!ready) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', color: '#666' }}>Loading…</div>
  return children
}
