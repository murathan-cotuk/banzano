'use client'
import { useLocale } from 'next-intl'
import AuthGuard from '../../../components/AuthGuard'
import PortalNav from '../../../components/PortalNav'

const S = {
  page: { minHeight: '100vh', background: '#f7f8fa' },
  main: { maxWidth: 760, margin: '0 auto', padding: '36px 24px 60px' },
  h1: { fontSize: 26, fontWeight: 700, color: '#111', margin: '0 0 4px' },
  sub: { fontSize: 14, color: '#666', margin: '0 0 20px' },
  draftBanner: { background: '#fef2f2', border: '1.5px solid #ef4444', borderRadius: 10, padding: '16px 20px', color: '#991b1b', fontSize: 14, lineHeight: 1.6, marginBottom: 30, fontWeight: 500 },
  card: { background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.06)', padding: '28px 32px' },
  h2: { fontSize: 16, fontWeight: 700, color: '#111', margin: '26px 0 8px' },
  h2First: { fontSize: 16, fontWeight: 700, color: '#111', margin: '0 0 8px' },
  p: { fontSize: 14, color: '#374151', lineHeight: 1.7, margin: '0 0 4px' },
}

const TEXTS = {
  de: {
    title: 'Affiliate-Vereinbarung', sub: 'Bedingungen der Teilnahme am Andertal-Partnerprogramm.',
    draft: 'ENTWURF — NOCH NICHT RECHTLICH GEPRÜFT. Dieser Text ist ein vorläufiges Gerüst und stellt keine verbindliche Vertragsgrundlage dar. Er wird vor dem produktiven Einsatz von einem Rechtsanwalt geprüft und final formuliert. Bitte nicht als bindende Vereinbarung behandeln oder zitieren.',
    s1: '1. Gegenstand', s1p: 'Diese Vereinbarung regelt die Teilnahme am Andertal-Partnerprogramm, über das Partner Empfehlungslinks generieren und dafür eine Provision auf vermittelte Verkäufe bzw. Verkäufer-Anmeldungen erhalten können.',
    s2: '2. Provisionen', s2p: 'Provisionssätze und -berechnung richten sich nach den im Partnerportal angezeigten aktuellen Konditionen. Provisionen werden nach einer Bestätigungsfrist (siehe Portal) endgültig und können vor Ablauf dieser Frist bei Rückabwicklung des zugrundeliegenden Kaufs storniert werden.',
    s3: '3. Auszahlung', s3p: 'Auszahlungen erfolgen ab einem im Portal angegebenen Mindestbetrag über den hinterlegten Zahlungsdienstleister. Partner sind für die korrekte Angabe ihrer steuerlichen Daten selbst verantwortlich.',
    s4: '4. Unzulässige Praktiken', s4p: 'Unzulässig sind u. a.: Selbstempfehlung (Eigenkäufe über den eigenen Link), Gebotsabgabe auf Markenbegriffe in bezahlter Suche, irreführende Werbung sowie jede Form von Klick- oder Verkaufsmanipulation.',
    s5: '5. Kündigung', s5p: 'Beide Seiten können die Teilnahme jederzeit beenden. Bereits bestätigte, noch nicht ausgezahlte Provisionen werden nach den zum Zeitpunkt der Kündigung geltenden Regeln abgewickelt.',
    s6: '6. Kontakt', s6p: 'Fragen zu dieser Vereinbarung richten Sie bitte an den Andertal-Support.',
  },
  tr: {
    title: 'Affiliate Sözleşmesi', sub: 'Andertal Ortaklık Programı katılım koşulları.',
    draft: 'TASLAK — HENÜZ HUKUKİ İNCELEMEDEN GEÇMEDİ. Bu metin geçici bir iskelettir ve bağlayıcı bir sözleşme temeli oluşturmaz. Canlıya alınmadan önce bir avukat tarafından incelenip nihai hale getirilecektir. Lütfen bağlayıcı bir anlaşma olarak değerlendirmeyin veya referans göstermeyin.',
    s1: '1. Konu', s1p: 'Bu sözleşme, ortakların yönlendirme linki oluşturarak, yönlendirdikleri satışlar veya satıcı kayıtları üzerinden komisyon kazanabildiği Andertal Ortaklık Programı\'na katılımı düzenler.',
    s2: '2. Komisyonlar', s2p: 'Komisyon oranları ve hesaplama yöntemi, ortaklık portalında gösterilen güncel koşullara göre belirlenir. Komisyonlar bir onay süresinin (bkz. portal) ardından kesinleşir ve bu süre dolmadan ilgili satışın iptali halinde geri alınabilir.',
    s3: '3. Ödeme', s3p: 'Ödemeler, portalda belirtilen asgari tutara ulaşıldığında kayıtlı ödeme sağlayıcısı üzerinden yapılır. Ortaklar, vergi bilgilerinin doğruluğundan kendileri sorumludur.',
    s4: '4. Yasak Uygulamalar', s4p: 'Kendi linki üzerinden kendine satış yapma, marka terimlerine ücretli aramada teklif verme, yanıltıcı reklam ve her türlü tıklama/satış manipülasyonu yasaktır.',
    s5: '5. Fesih', s5p: 'Her iki taraf da katılımı istediği zaman sonlandırabilir. Onaylanmış ancak henüz ödenmemiş komisyonlar, fesih tarihinde geçerli kurallara göre işleme alınır.',
    s6: '6. İletişim', s6p: 'Bu sözleşmeyle ilgili sorularınız için lütfen Andertal destek ekibiyle iletişime geçin.',
  },
  en: {
    title: 'Affiliate Agreement', sub: 'Terms of participation in the Andertal affiliate program.',
    draft: 'DRAFT — NOT YET LEGALLY REVIEWED. This text is a provisional skeleton and does not constitute a binding contractual basis. It will be reviewed and finalized by a lawyer before going live. Please do not treat or cite this as a binding agreement.',
    s1: '1. Subject', s1p: 'This agreement governs participation in the Andertal affiliate program, through which affiliates can generate referral links and earn a commission on sales or seller signups driven through them.',
    s2: '2. Commissions', s2p: 'Commission rates and calculation follow the current terms shown in the affiliate portal. Commissions become final after a confirmation period (see portal) and may be clawed back before that period ends if the underlying purchase is refunded.',
    s3: '3. Payout', s3p: 'Payouts are made once a minimum amount shown in the portal is reached, via the connected payment provider. Affiliates are responsible for the accuracy of their own tax information.',
    s4: '4. Prohibited practices', s4p: 'Prohibited practices include, among others: self-referral (purchases made through your own link), bidding on brand terms in paid search, misleading advertising, and any form of click or sale manipulation.',
    s5: '5. Termination', s5p: 'Either party may end participation at any time. Already-confirmed, not-yet-paid commissions are settled according to the rules in effect at the time of termination.',
    s6: '6. Contact', s6p: 'Questions about this agreement should be directed to Andertal support.',
  },
  fr: {
    title: "Contrat d'affiliation", sub: "Conditions de participation au programme d'affiliation Andertal.",
    draft: "BROUILLON — PAS ENCORE VALIDÉ JURIDIQUEMENT. Ce texte est un squelette provisoire et ne constitue pas une base contractuelle contraignante. Il sera révisé et finalisé par un avocat avant sa mise en ligne. Merci de ne pas le considérer ni le citer comme un accord contraignant.",
    s1: '1. Objet', s1p: "Ce contrat régit la participation au programme d'affiliation Andertal, permettant aux affiliés de générer des liens de parrainage et de percevoir une commission sur les ventes ou inscriptions de vendeurs générées.",
    s2: '2. Commissions', s2p: 'Les taux de commission suivent les conditions actuelles indiquées dans le portail. Les commissions deviennent définitives après une période de confirmation (voir portail) et peuvent être annulées avant son terme en cas de remboursement.',
    s3: '3. Paiement', s3p: 'Les paiements sont effectués une fois le montant minimum indiqué dans le portail atteint, via le prestataire de paiement connecté. Les affiliés sont responsables de l\'exactitude de leurs informations fiscales.',
    s4: '4. Pratiques interdites', s4p: "Sont notamment interdits : l'auto-parrainage, les enchères sur les termes de marque en recherche payante, la publicité trompeuse et toute manipulation des clics ou des ventes.",
    s5: '5. Résiliation', s5p: 'Chaque partie peut mettre fin à la participation à tout moment. Les commissions déjà confirmées et non encore payées sont réglées selon les règles en vigueur à la date de résiliation.',
    s6: '6. Contact', s6p: 'Pour toute question relative à ce contrat, veuillez contacter le support Andertal.',
  },
  es: {
    title: 'Acuerdo de afiliados', sub: 'Términos de participación en el programa de afiliados de Andertal.',
    draft: 'BORRADOR — AÚN NO REVISADO LEGALMENTE. Este texto es un esqueleto provisional y no constituye una base contractual vinculante. Será revisado y finalizado por un abogado antes de su publicación. No lo trate ni lo cite como un acuerdo vinculante.',
    s1: '1. Objeto', s1p: 'Este acuerdo regula la participación en el programa de afiliados de Andertal, mediante el cual los afiliados pueden generar enlaces de referencia y ganar una comisión por las ventas o altas de vendedores generadas.',
    s2: '2. Comisiones', s2p: 'Las tasas de comisión siguen las condiciones actuales que se muestran en el portal. Las comisiones se vuelven definitivas tras un período de confirmación (ver portal) y pueden revertirse antes de que finalice si se reembolsa la compra correspondiente.',
    s3: '3. Pago', s3p: 'Los pagos se realizan una vez alcanzado el importe mínimo indicado en el portal, a través del proveedor de pagos conectado. Los afiliados son responsables de la exactitud de su información fiscal.',
    s4: '4. Prácticas prohibidas', s4p: 'Están prohibidas, entre otras: la autorreferencia, pujar por términos de marca en búsqueda de pago, la publicidad engañosa y cualquier manipulación de clics o ventas.',
    s5: '5. Terminación', s5p: 'Cualquiera de las partes puede finalizar la participación en cualquier momento. Las comisiones ya confirmadas y aún no pagadas se liquidan según las reglas vigentes en el momento de la terminación.',
    s6: '6. Contacto', s6p: 'Para consultas sobre este acuerdo, contacte con el soporte de Andertal.',
  },
  it: {
    title: 'Accordo di affiliazione', sub: 'Termini di partecipazione al programma di affiliazione Andertal.',
    draft: 'BOZZA — NON ANCORA REVISIONATA LEGALMENTE. Questo testo è uno scheletro provvisorio e non costituisce una base contrattuale vincolante. Sarà rivisto e finalizzato da un avvocato prima della pubblicazione. Si prega di non trattarlo né citarlo come un accordo vincolante.',
    s1: '1. Oggetto', s1p: "Questo accordo disciplina la partecipazione al programma di affiliazione Andertal, tramite il quale gli affiliati possono generare link di referral e guadagnare una commissione sulle vendite o registrazioni di venditori generate.",
    s2: '2. Commissioni', s2p: 'Le aliquote di commissione seguono le condizioni attuali mostrate nel portale. Le commissioni diventano definitive dopo un periodo di conferma (vedi portale) e possono essere stornate prima di tale scadenza in caso di rimborso.',
    s3: '3. Pagamento', s3p: "I pagamenti vengono effettuati al raggiungimento dell'importo minimo indicato nel portale, tramite il fornitore di pagamenti collegato. Gli affiliati sono responsabili dell'accuratezza dei propri dati fiscali.",
    s4: '4. Pratiche vietate', s4p: 'Sono vietate, tra le altre: l\'auto-referral, le offerte su termini di marchio nella ricerca a pagamento, la pubblicità ingannevole e qualsiasi manipolazione di click o vendite.',
    s5: '5. Recesso', s5p: 'Entrambe le parti possono terminare la partecipazione in qualsiasi momento. Le commissioni già confermate e non ancora pagate vengono regolate secondo le regole in vigore alla data di recesso.',
    s6: '6. Contatti', s6p: "Per domande su questo accordo, contattare il supporto Andertal.",
  },
}

export default function TermsPage() {
  const locale = useLocale()
  const t = TEXTS[locale] || TEXTS.de

  return (
    <AuthGuard>
      <div style={S.page}>
        <PortalNav />
        <div style={S.main}>
          <h1 style={S.h1}>{t.title}</h1>
          <p style={S.sub}>{t.sub}</p>

          <div style={S.draftBanner}>{t.draft}</div>

          <div style={S.card}>
            <div style={S.h2First}>{t.s1}</div>
            <p style={S.p}>{t.s1p}</p>
            <div style={S.h2}>{t.s2}</div>
            <p style={S.p}>{t.s2p}</p>
            <div style={S.h2}>{t.s3}</div>
            <p style={S.p}>{t.s3p}</p>
            <div style={S.h2}>{t.s4}</div>
            <p style={S.p}>{t.s4p}</p>
            <div style={S.h2}>{t.s5}</div>
            <p style={S.p}>{t.s5p}</p>
            <div style={S.h2}>{t.s6}</div>
            <p style={S.p}>{t.s6p}</p>
          </div>
        </div>
      </div>
    </AuthGuard>
  )
}
