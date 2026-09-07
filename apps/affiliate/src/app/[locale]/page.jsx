import { redirect } from 'next/navigation'

export default async function LocaleRoot({ params }) {
  const { locale } = await params
  redirect(`/${locale}/dashboard`)
}
