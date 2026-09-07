'use client'
import { useState } from 'react'
import { useLocale } from 'next-intl'
import AuthGuard from '../../../components/AuthGuard'
import PortalNav from '../../../components/PortalNav'

const S = {
  page: { minHeight: '100vh', background: '#f7f8fa' },
  main: { maxWidth: 800, margin: '0 auto', padding: '36px 24px' },
  h1: { fontSize: 26, fontWeight: 700, color: '#111', margin: '0 0 4px' },
  sub: { fontSize: 14, color: '#666', margin: '0 0 28px' },
  section: { marginBottom: 30 },
  sectionTitle: { fontSize: 15, fontWeight: 600, color: '#333', marginBottom: 12 },
  card: { background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', padding: '18px 20px' },
  snippet: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 0', borderBottom: '1px solid #f1f1f1' },
  snippetText: { fontSize: 14, color: '#222', flex: 1, lineHeight: 1.5 },
  copyBtn: { padding: '7px 14px', background: '#f3f4f6', color: '#333', border: '1.5px solid #e0e0e0', borderRadius: 7, fontSize: 13, fontWeight: 500, cursor: 'pointer', flexShrink: 0 },
  note: { background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, padding: '14px 18px', color: '#1e40af', fontSize: 13.5, lineHeight: 1.5 },
}

const TEXTS = {
  de: {
    title: 'Ressourcen', sub: 'Textbausteine und Hinweise für deine Promotion.',
    copyTitle: 'Textvorlagen', copied: 'Kopiert!', copy: 'Kopieren',
    snippets: [
      'Entdecke Andertal — hochwertige Produkte, faire Preise. [Dein Link]',
      'Ich nutze Andertal für meine Einkäufe und empfehle es gerne weiter. [Dein Link]',
      'Neu bei Andertal? Über meinen Link geht’s direkt los. [Dein Link]',
    ],
    bannerTitle: 'Werbebanner', bannerNote: 'Gestaltete Bildbanner sind derzeit noch nicht verfügbar — sie folgen in einer späteren Version. Bis dahin bitte die Textvorlagen oder deinen eigenen Link direkt verwenden.',
    disclosureTitle: 'Kennzeichnungspflicht', disclosureNote: 'Affiliate-/Empfehlungslinks müssen als Werbung gekennzeichnet werden (z. B. „Werbung“ oder „Enthält Affiliate-Link“), wenn du sie teilst — das ist in Deutschland rechtlich vorgeschrieben (BGH-Rechtsprechung zu Influencer-Werbung). Bitte informiere dich über die für dein Land geltenden Regeln.',
  },
  tr: {
    title: 'Kaynaklar', sub: 'Tanıtımların için hazır metinler ve notlar.',
    copyTitle: 'Metin şablonları', copied: 'Kopyalandı!', copy: 'Kopyala',
    snippets: [
      "Andertal'ı keşfet — kaliteli ürünler, uygun fiyatlar. [Linkin]",
      'Alışverişlerimde Andertal kullanıyorum, tavsiye ederim. [Linkin]',
      "Andertal'a yeni misin? Linkimden hemen başla. [Linkin]",
    ],
    bannerTitle: 'Reklam bannerları', bannerNote: 'Tasarlanmış görsel bannerlar henüz mevcut değil — sonraki bir sürümde eklenecek. O zamana kadar lütfen metin şablonlarını veya kendi linkini kullan.',
    disclosureTitle: 'Bildirim yükümlülüğü', disclosureNote: 'Affiliate/ortaklık linklerini paylaşırken bunları reklam olarak belirtmen gerekir (ör. "Reklam" veya "Affiliate link içerir") — bu, birçok ülkede (örn. Almanya) yasal bir zorunluluktur. Lütfen kendi ülkende geçerli kuralları kontrol et.',
  },
  en: {
    title: 'Resources', sub: 'Copy snippets and guidance for your promotions.',
    copyTitle: 'Copy templates', copied: 'Copied!', copy: 'Copy',
    snippets: [
      'Discover Andertal — quality products, fair prices. [Your link]',
      'I use Andertal for my shopping and happily recommend it. [Your link]',
      'New to Andertal? Get started through my link. [Your link]',
    ],
    bannerTitle: 'Ad banners', bannerNote: "Designed image banners aren't available yet — they'll follow in a later release. Until then, please use the copy templates or your own link directly.",
    disclosureTitle: 'Disclosure requirement', disclosureNote: 'Affiliate/referral links must be disclosed as advertising when you share them (e.g. "Ad" or "Contains an affiliate link") — this is a legal requirement in many jurisdictions (e.g. Germany, per BGH case law on influencer advertising). Please check the rules that apply in your own country.',
  },
  fr: {
    title: 'Ressources', sub: 'Modèles de texte et conseils pour vos promotions.',
    copyTitle: 'Modèles de texte', copied: 'Copié !', copy: 'Copier',
    snippets: [
      'Découvrez Andertal — des produits de qualité, des prix justes. [Votre lien]',
      "J'utilise Andertal pour mes achats et je le recommande volontiers. [Votre lien]",
      'Nouveau sur Andertal ? Commencez via mon lien. [Votre lien]',
    ],
    bannerTitle: 'Bannières publicitaires', bannerNote: "Les bannières graphiques ne sont pas encore disponibles — elles arriveront dans une prochaine version. En attendant, utilisez les modèles de texte ou votre lien directement.",
    disclosureTitle: 'Obligation de divulgation', disclosureNote: 'Les liens d\'affiliation doivent être signalés comme de la publicité lorsque vous les partagez (ex. « Publicité » ou « Contient un lien d\'affiliation ») — c\'est une obligation légale dans de nombreux pays. Vérifiez les règles applicables dans le vôtre.',
  },
  es: {
    title: 'Recursos', sub: 'Plantillas de texto y consejos para tus promociones.',
    copyTitle: 'Plantillas de texto', copied: '¡Copiado!', copy: 'Copiar',
    snippets: [
      'Descubre Andertal — productos de calidad, precios justos. [Tu enlace]',
      'Uso Andertal para mis compras y lo recomiendo encantado/a. [Tu enlace]',
      '¿Nuevo en Andertal? Empieza a través de mi enlace. [Tu enlace]',
    ],
    bannerTitle: 'Banners publicitarios', bannerNote: 'Los banners de imagen diseñados aún no están disponibles — llegarán en una versión posterior. Mientras tanto, usa las plantillas de texto o tu propio enlace.',
    disclosureTitle: 'Obligación de divulgación', disclosureNote: 'Los enlaces de afiliado deben identificarse como publicidad al compartirlos (p. ej. "Publicidad" o "Contiene un enlace de afiliado") — es un requisito legal en muchos países. Consulta la normativa aplicable en el tuyo.',
  },
  it: {
    title: 'Risorse', sub: 'Modelli di testo e indicazioni per le tue promozioni.',
    copyTitle: 'Modelli di testo', copied: 'Copiato!', copy: 'Copia',
    snippets: [
      'Scopri Andertal — prodotti di qualità, prezzi giusti. [Il tuo link]',
      'Uso Andertal per i miei acquisti e lo consiglio volentieri. [Il tuo link]',
      'Nuovo su Andertal? Inizia tramite il mio link. [Il tuo link]',
    ],
    bannerTitle: 'Banner pubblicitari', bannerNote: 'I banner grafici non sono ancora disponibili — arriveranno in una versione successiva. Nel frattempo usa i modelli di testo o il tuo link direttamente.',
    disclosureTitle: 'Obbligo di divulgazione', disclosureNote: 'I link di affiliazione devono essere segnalati come pubblicità quando li condividi (es. "Pubblicità" o "Contiene un link di affiliazione") — è un obbligo legale in molti paesi. Verifica le norme applicabili nel tuo.',
  },
}

export default function ResourcesPage() {
  const locale = useLocale()
  const t = TEXTS[locale] || TEXTS.de
  const [copiedIdx, setCopiedIdx] = useState(null)

  const copy = (text, idx) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx(null), 1500)
    }).catch(() => {})
  }

  return (
    <AuthGuard>
      <div style={S.page}>
        <PortalNav />
        <div style={S.main}>
          <h1 style={S.h1}>{t.title}</h1>
          <p style={S.sub}>{t.sub}</p>

          <div style={S.section}>
            <div style={S.sectionTitle}>{t.copyTitle}</div>
            <div style={S.card}>
              {t.snippets.map((s, i) => (
                <div key={i} style={{ ...S.snippet, borderBottom: i === t.snippets.length - 1 ? 'none' : S.snippet.borderBottom }}>
                  <div style={S.snippetText}>{s}</div>
                  <button style={S.copyBtn} onClick={() => copy(s, i)}>{copiedIdx === i ? t.copied : t.copy}</button>
                </div>
              ))}
            </div>
          </div>

          <div style={S.section}>
            <div style={S.sectionTitle}>{t.bannerTitle}</div>
            <div style={S.note}>{t.bannerNote}</div>
          </div>

          <div style={S.section}>
            <div style={S.sectionTitle}>{t.disclosureTitle}</div>
            <div style={S.note}>{t.disclosureNote}</div>
          </div>
        </div>
      </div>
    </AuthGuard>
  )
}
