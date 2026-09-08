**Shop (Mağaza)**

*apps/shop — Müşteri Vitrini & Satın Alma Akışı*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Genel Bakış

Shop (andertal.com), Andertal pazaryerinin müşteri tarafındaki vitrini ve satın alma akışını barındıran Next.js uygulamasıdır (apps/shop). Çok satıcılı (multi-vendor) bir pazaryeri olduğu için ürünler farklı satıcılara ait olabilir; ödeme, kargo ve iade süreçleri satıcı bazında ayrıştırılarak yönetilir. next-intl ile 6 dilde tam çeviri desteği vardır; ana sayfa ve kategori/koleksiyon sayfaları sürükle-bırak "landing page" container sistemiyle (bkz. Bölüm 4) SellerCentral üzerinden düzenlenebilir.

## 2. Ana Müşteri Akışları

| **Alan** | **Açıklama** |
| --- | --- |
| /[handle], /product, /produkt | Ürün detay sayfaları (Almanca ve İngilizce URL segment isimleri paralel desteklenir). |
| /category, /kollektion, /collections, /brands, /brand | Kategori, koleksiyon ve marka listeleme/detay sayfaları. |
| /search | Ürün arama. |
| /cart, /checkout | Sepet ve ödeme akışı — Stripe ile entegre, çok satıcılı sepetlerde her satıcının kendi kargo/komisyon hesaplaması ayrı ayrı yapılır. |
| /account, /addresses, /payment-methods | Müşteri hesabı, adres defteri, kayıtlı ödeme yöntemleri. |
| /orders, /order, /invoices | Sipariş geçmişi, sipariş detayı, faturalar (PDF indirilebilir). |
| /wishlist, /merkzettel | İstek listesi (Almanca "Merkzettel" arama motoru için ayrı bir rota olarak da sunulur). |
| /reviews | Ürün değerlendirmeleri. |
| /bonus | Bonus puan bakiyesi ve geçmişi (bkz. Bonus Puanları entegrasyon dokümanı). |
| /nachrichten | Müşteri-satıcı/destek mesajlaşma kutusu. |
| /seller | Bir satıcının kendi mağaza vitrini (marka sayfası benzeri). |
| /newsletter, /register, /login, /forgot-password | Bülten aboneliği ve hesap işlemleri. |
| /bestsellers, /neuheiten, /recommended, /sales | Öne çıkan/kişiselleştirilmiş ürün koleksiyonu sayfaları. |
| /pages/[slug] | CMS tarafından (SellerCentral → Content → Pages) yönetilen statik içerik sayfaları — örn. Gizlilik Politikası (/datenschutz) bu mekanizmayla yayınlanır. |

## 3. Sunucu Tarafı API Uç Noktaları (/api/store-*)

Shop, kendi Next.js API rotalarını bir "proxy/orkestrasyon" katmanı olarak kullanır — bu rotalar genellikle apps/medusa-backend'e istek atıp önbellekleme (cache) ve veri şekillendirme yapar: store-products, store-categories, store-collections, store-orders, store-carts, store-payment-intent, store-public-payment-config, store-sellers, store-seller-profile, store-seller-settings, store-menus / store-menu-locations, store-pages, store-brands, store-styles, store-metafield-definitions, store-product-badges, store-campaign-discount, store-invoice, store-return-etikett / store-return-retourenschein (iade evrakları), store-presence-heartbeat (canlı ziyaretçi sayacı), store-api-page-settings, personalization-view / personalized-products (kişiselleştirilmiş ürün önerileri), brand-favicon, affiliate-track (bkz. Affiliate dokümanı).

## 4. Landing Page / Container Sistemi

Ana sayfa ve birçok kategori/koleksiyon sayfası, SellerCentral'daki sürükle-bırak düzenleyici ile oluşturulan "container" listelerinden oluşur (hero banner, ürün karüseli, içerik mozaiği, resim+metin blokları, en çok satanlar karüseli, vb.). LandingContainers.jsx bu container tiplerini render eder; hangi container'ların masaüstü/mobil/tablette görüneceği visible_on alanıyla kontrol edilir.

## 5. Performans Çalışması (2026-09)

Bu dönemde ana sayfanın PageSpeed puanının çok düşük (37/100, LCP 89.6s, ~19MB yük, CLS 0.454) olduğu tespit edilip beş bağımsız kök nedene ayrı ayrı müdahale edilmiştir:

1. **Ana sayfa tamamen istemci tarafında (client-side) render ediliyordu** — boş HTML → JS yüklenir → hydrate olur → container JSON'ı çekilir → her bölümün ürün/koleksiyon verisi ayrı ayrı çekilir → görseller en son indirilmeye başlar. Düz ana sayfa (`page.jsx`, `pageId`/`categoryId` almayan tek çağrı noktası) sunucu tarafı bileşene (async Server Component) çevrildi; artık backend'den container JSON'ını sunucuda çekip ilk HTML ile birlikte gönderiyor.
2. **Landing hero/banner/mozaik görselleri ham `<img>` etiketiydi** — `next/image` yok, lazy-loading yok, satıcı/admin'in yüklediği ham boyutta (çoğu zaman birkaç MB'lık PNG) doğrudan servis ediliyordu. `LandingContainers.jsx`, `ProductCard.jsx` ve `ProductListItem` `next/image`'a taşındı; sadece ilk (katlama üstü) hero slaytına `priority` verildi.
3. **Görsel yükleme borusu yalnızca ürün görsellerini sıkıştırıyordu** — `media.js` içindeki `processProductImageToSquareWebp` fonksiyonu yalnızca `purpose=product` yüklemelerinde çalışıyordu; landing banner/kategori/koleksiyon/marka/blog görselleri bu adımı hiç görmeden ham haliyle diske/S3'e yazılıyordu. Bu, büyük dosya boyutlarının doğrudan nedeniydi. Ürün yolunun davranışına dokunmadan, `purpose !== 'product'` olan tüm yüklemeler için ikinci bir işleme yolu eklendi: en uzun kenarı 1920px'e sınırlayan (crop yok), WebP'ye (kalite ~82) çeviren, SVG/GIF'i ve zaten küçük WebP'yi dokunmadan geçiren genel bir sıkıştırma adımı.
4. **Google Fonts, render'ı bloklayan bir CSS `@import` ile yükleniyordu** — `next/font` kullanılmıyordu. `globals.css`, `not-found.jsx` ve `BecomeSellerLanding.jsx` içindeki üç ayrı `@import` `next/font/google`'a taşındı.
5. **İkinci, önceden bilinmeyen bir CLS kaynağı bulundu**: `useIsNarrow`/`useIsTablet` kancaları `matchMedia`'yı yalnızca `useEffect` içinde çözüyordu; bu yüzden ilk boyamada masaüstü container seti mount oluyor, hydration'dan hemen sonra farklı bir mobil container setiyle DEĞİŞTİRİLİYORDU — sadece görsel kayması değil, yapısal bir bölüm değişimiydi ve CLS 0.454'ün büyük bir bölümünden muhtemelen bu sorumluydu. Üst seviye container görünürlük filtresi (`visible_on`), JS tabanlı koşullu mount yerine CSS medya sorgusuyla (Tailwind'in mevcut breakpoint ölçeğiyle eşleşen) hem masaüstü hem mobil varyantı render edip görünürlüğü CSS ile değiştirecek şekilde değiştirildi.

Ayrıca zaten yüklenmiş, sıkıştırılmamış görselleri geriye dönük düzeltmek için `apps/medusa-backend/scripts/backfill-optimize-media.js` yazıldı (`--dry-run` varsayılan, üretim verisini toplu olarak değiştirdiği için gerçek çalıştırma kullanıcı onayı bekliyor — henüz sadece dry-run yapıldı).

En büyük kalan kaldıraç noktası (bu ekibin kontrolü dışında, kullanıcı kararı gerektirir): görsellerin önünde bir CDN (ör. Cloudflare) olmaması ve mevcut Render.com sunucu planının "her zaman açık" (always-on) olup olmadığının kontrol edilmesi — bkz. docs/CloudflareKurulum.md.

## 6. Bilinen Açık Konular (2026-09 itibarıyla)

- **KRİTİK, HENÜZ ÇÖZÜLMEDİ — styled-components SSR bailout**: bazı bileşenlerin styled-components stilleri sunucu tarafında (SSR) doğru üretilmiyor olabilir ("bailout" — sunucu render'ından çıkıp istemciye devretme), bu da LCP'yi baskın şekilde etkiliyor olabilir. Yukarıdaki 5 madde uygulandı ve doğrulandı; bu 6. madde ayrı, daha sonra tespit edilmiş ve henüz düzeltilmemiş bir sorundur.
- **CDN yok**: görsellerin önünde bir CDN (Cloudflare önerilir) olmaması — bkz. yukarıdaki not. Cloudflare "Polish" (otomatik görsel yeniden sıkıştırma) da bu adımın bir parçası olarak önerilir.
- **Render.com sunucu planı doğrulanmadı**: "her zaman açık" (always-on) bir planda mı yoksa uykuya geçen bir planda mı olduğu kontrol edilmedi — soğuk başlangıç (cold start) tek başına TTFB'yi 10-30 saniye artırabilir.
- **Redis doğrulaması yapılmadı**: `REDIS_URL` production'da tanımlı mı ve gerçekten bağlanıyor mu (loglarda "Redis connected") — bu, hem Shop'un API önbellekleme hem de Flow Otomasyonu kuyruğu için önemlidir (bkz. ilgili entegrasyon dokümanı).
- **Backfill script'i yalnızca dry-run yapıldı**: `apps/medusa-backend/scripts/backfill-optimize-media.js` zaten yüklenmiş, sıkıştırılmamış görselleri gerçekten yeniden yazmak için kullanıcı onayı bekliyor.
