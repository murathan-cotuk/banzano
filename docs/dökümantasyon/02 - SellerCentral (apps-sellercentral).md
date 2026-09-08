**SellerCentral**

*apps/sellercentral — Satıcı & Yönetici Paneli*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Genel Bakış

SellerCentral (sellercentral.andertal.com), Andertal pazaryerindeki satıcıların (seller) ürünlerini, siparişlerini, ödemelerini, pazarlama araçlarını ve mağaza ayarlarını yönettiği Next.js tabanlı yönetim panelidir (apps/sellercentral). Arayüz Shopify'ın açık kaynak "Polaris" tasarım sistemi ile inşa edilmiştir. Uygulama hem sıradan satıcılar (kendi ürün/sipariş verilerini görür) hem de "superuser" (platform yöneticisi — Andertal ekibi) rolünü tek bir kod tabanında, rol bazlı görünürlük/erişim kısıtlamalarıyla barındırır.

next-intl kütüphanesi ile 6 dilde (Almanca, İngilizce, Türkçe, Fransızca, İspanyolca, İtalyanca) tam çeviri desteği vardır; her sayfa /[locale]/... yapısındadır.

## 2. Kimlik Doğrulama ve Rol Modeli

Kimlik doğrulama, Medusa'nın kendi admin auth sisteminden tamamen ayrı, özel bir JWT sistemidir (`SELLER_JWT_SECRET`, `apps/medusa-backend/src/routes/seller-auth.js`). Tüm satıcı hesapları `seller_users` tablosunda tutulur; oturumlar `seller_sessions` tablosunda ayrıca izlenir (her token'ın bir `sid`'i vardır, bu sayede bir oturum sunucu tarafında iptal edilebilir/geri çağrılabilir — token süresi dolmamış olsa bile).

Üç önemli alan rol modelini belirler:
- **`is_superuser`** — platform yöneticisi (Andertal ekibi). Superuser her satıcının verisini görebilir, kategori/uyumluluk/marka onayı gibi platform geneli ayarları değiştirebilir. Kayıt anında yalnızca `INITIAL_SUPERUSER_EMAILS` ortam değişkenindeki e-postalar otomatik superuser olur; sonrası manuel atamayla yapılır.
- **`sub_of_seller_id`** — bir satıcı hesabının başka bir satıcının ekip üyesi (alt hesap) olduğunu belirtir (Settings → Users & Permissions ile davet edilir). Alt hesaplar kendi `permissions` alanına göre kısıtlanmış erişime sahiptir; mağaza adı gibi paylaşılan bilgiler ana hesaptan miras alınır.
- **Ürünlerde kategori kilidi** (2026-09 eklendi) — bir ürünün kategorisi bir kez kaydedildikten sonra değiştirilemez; çünkü kategori, o ürün için hangi uyumluluk (compliance) alanlarının zorunlu olacağını belirler ve sonradan değiştirilmesi ürünü iki farklı zorunlu alan kümesi arasında tutarsız bırakabilir.

Güvenlik notu: backend, `DATABASE_URL` gerçek üretim veritabanına (render.com) işaret ediyorsa `SELLER_JWT_SECRET`/`CUSTOMER_JWT_SECRET` ortam değişkenleri tanımlı olmadan başlamayı REDDEDER — bu, zayıf bir geliştirme sırrının gerçek veriye karşı yanlışlıkla kullanılmasını önleyen bilinçli bir güvenlik kilididir.

## 3. Ana Bölümler

| **Bölüm** | **İçerik / Amaç** |
| --- | --- |
| Dashboard | Genel satış/sipariş özet ekranı. |
| Products | Ürün listesi, tekli/toplu ürün ekleme (single-upload, bulk-upload, bulk-images, bulk-videos), mevcut ürünü ekleme (add-existing), envanter (inventory), koleksiyonlar (collections), hediye kartları (gift-cards), ürün grupları, yükleme şablonları (upload-templates). Tekil ürün düzenleme sayfası (/products/[id]) sekmeli bir yapı ile Allgemein / Spezifikationen / Variante / Rechtlich bölümlerine ayrılmıştır. |
| Orders | Sipariş listesi, terk edilmiş sepetler (abandoned checkouts — superuser only), manuel sipariş oluşturma, teslimat belgesi/fatura üretimi. |
| Inbox | Satıcı-müşteri-superuser arası mesajlaşma/destek kutusu. |
| Customers | Müşteri listesi, değerlendirmeler (reviews), bülten (newsletter) aboneleri — superuser ağırlıklı. |
| Marketing | Kampanyalar, attribution (pazarlama kaynak analitiği), SEO araçları, otomasyonlar (automations), Affiliate özet sayfası (bkz. Affiliate Portal dokümanı), Affiliate Admin paneli (superuser). |
| Content | Sayfalar (pages), blog yazıları, menüler, kategoriler, landing page düzenleyici (sürükle-bırak container sistemi), stiller (styles — mağazanın tema/renk ayarları), metaobjects (özel alan/metadata tanımları), markalar (brands) — onay kuyruğu dahil, URL yönlendirmeleri, medya kütüphanesi, dosyalar, Compliance Review / Compliance Profiles (bkz. Bölüm 5), Payout Risk (superuser). |
| Analytics | Satış/trafik raporları; "live view" (superuser only) canlı ziyaretçi izleme. |
| Reports | İndirilebilir raporlar (finans, envanter, vb.). |
| Sellers | (Superuser only) Tüm satıcıların listesi, onay/red işlemleri, hata kayıtları (sellers/errors). |
| Discounts | İndirim kuralları ve kupon yönetimi. |
| Import/Export | Toplu veri içe/dışa aktarma araçları. |
| Shipping | Kargo ayarları. |
| Store | Mağaza görünümü/önizleme. |
| Apps | Üçüncü parti "App Platform" (apps/developer) entegrasyon yönetimi. |
| Brand | Marka sayfası yönetimi ve onay durumu. |
| Help | Yardım merkezi (çok dilli, statik içerik). |
| Advertise | Reklam/PPC kampanya yönetimi. |

## 4. Settings (Ayarlar) — Alt Bölümler

| **Alt sayfa** | **Amaç** |
| --- | --- |
| general | Genel mağaza/şirket bilgileri. |
| account | Hesap profili. |
| security | Şifre değiştirme (görünürlük butonu ile), oturum güvenliği. |
| locations | Satıcının adresleri — her adrese amaç etiketi (kargo/iade/fatura) atanabilir, izolasyon zaten güvenlidir (bir satıcı başka satıcının adresini göremez). |
| payment / payments | Ödeme alma ayarları ve "Auszahlungen nasıl çalışır" açıklaması. |
| stripe-connect | YALNIZCA superuser erişimine kapalı bilgi sayfası — normal satıcılar Stripe Connect ile hiçbir işlem yapamaz/yapmamalıdır (bilinçli tasarım kararı). |
| billing | Provizyon faturaları (Provisionsrechnung) — 15 günlük dönemler halinde otomatik üretilir, PDF olarak indirilebilir. |
| taxes | Vergi ayarları. |
| dac7 | DAC7 / §12 PStTG (Alman Platform Vergi Şeffaflık Kanunu) rehberi ve raporlama aracı. |
| bonus-points | Bonus puan sistemi ayarları (bkz. ayrı entegrasyon dokümanı). |
| shipping | Teslimat yapılan ülkelerin açık/kapalı ayarı — tüm ülkeler listelenir, açma/kapama anahtarı ve o ülke için kaç ürün seçili olduğu gösterilir. |
| checkout | Ödeme akışı ayarları (superuser ağırlıklı, hassas — dikkatli değiştirilir). |
| integrations | Üçüncü parti entegrasyon bağlantıları. |
| notifications | Bildirim tercihleri. |
| categories | Satıcıya özel kategori görünürlük ayarları. |
| banners | Mağaza banner'ları. |
| plan / platform | Abonelik planı / platform geneli ayarlar (superuser). |
| users-permissions | Ekip üyesi davetleri ve özel izin (permission) atamaları. |
| verification | Kimlik/işletme doğrulama süreci. |

## 5. Uyumluluk (Compliance) Sistemi

İki sayfa birlikte çalışır: Content → Compliance Review, superuser'ın ürün bazında hangi uyumluluk profilinin (ör. GPSR, WEEE, EPREL gereksinimleri) uygulanması gerektiğini incelediği kuyruktur; sıralama, filtreleme ve satıcı adı gösterimi desteklenir. Content → Compliance Profiles ise kategori bazında hangi profilin otomatik atandığını gösteren, gerektiğinde tek tek override edilebilen bir genel tablo sunar — alt kategoriler üst kategoriden bağımsız kendi profiline sahip olabilir. Bir kategorinin etkin profili, parent_id zinciri hafızada (tek SQL sorgusuyla) yürünerek hesaplanır.

## 6. Ürün Düzenleme Sayfası Mimarisi (Ürün Detay)

/products/[id] sayfası dört sekmeye ayrılmıştır:

1. **Allgemein** — sağ üstte durum (status) çubuğu; solda ürün adı, altında SKU/EAN, açıklama, mağaza atama menüleri (her zaman açık, "ausklappen" gerektirmez). Fiyat bölümü (satış fiyatı, indirim fiyatı, UVP/tavsiye fiyatı), stok/minimum sipariş miktarı, görseller.
2. **Spezifikationen** — Ölçüler & Ambalaj (genişlik, yükseklik, uzunluk, ağırlık, satış birimi, ölçü birimi, ambalaj birimi, temel birim); altında Eigenschaften (metaobjects sisteminden seçilen özel alanlar) — arama kutusu ile mevcut metaobjectlerden seçim yapılır, olmayan bir özellik için superuser'a bildirim giden bir "yeni özellik önerisi" akışı vardır.
3. **Variante** — varyasyon oluşturma: seçenek başlıkları (ör. "Renk") metaobjects sayfasından, değerleri o metaobject'in içindeki değerlerden seçilir; renk için swatch görsel atanabilir. Her varyant satırının yanında bir "kilit" ikonu vardır — kilit AÇIK ise o alan parent (ana) üründeki değeri otomatik kopyalar ve salt-okunur olur (gri, tıklanamaz); kilit kapatıldığında değer olduğu gibi kalır ama artık düzenlenebilir (kilit kaldırma bir silme işlemi yapmaz, sadece kopyalanan değeri düzenlenebilir hale getirir).
4. **Rechtlich** — tüm hukuki/uyumluluk alanları (GPSR taban katmanı her zaman burada, altına kategoriye göre WEEE/EPREL/vb. dinamik alanlar eklenir — bkz. Bölüm 5 ve docs/COMPLIANCE.md). Made in Europe (AB menşe) bölümü 2026-09'da buradan Spezifikationen sekmesine taşınmıştır, çünkü o bir uyumluluk zorunluluğu değil, isteğe bağlı bir rozet bilgisidir.

Fiyatlandırma ile ilgili önemli bir kural: ürünün gösterileceği para birimi/pazar (EUR/DE) her zaman sabittir ve arayüz diline (locale) BAĞLI DEĞİLDİR — bu ayrım daha önce yanlışlıkla birbirine bağlıydı ve düzeltilmiştir (Türkçe arayüz seçilince fiyatların yanlışlıkla TL görünmesi hatası).

## 7. Bildirimler ve Değişmeyen Kayıt (Unsaved Changes) Mekanizması

Sayfa genelinde bir UnsavedChangesContext bulunur: bir sayfa "kirli" (değiştirilmiş, kaydedilmemiş) hale geldiğinde arama çubuğunun sağında Save/Discard butonları belirir ve kullanıcı başka bir sayfaya geçmeye çalışırsa onay istenir. Bu mekanizma Product, Category, Collection, Variant, Landing Page, Content Menus, Styles ve Verification Settings sayfalarında ortak olarak kullanılır.

## 8. Bilinen Açık Konular (2026-09 itibarıyla)

- **GPSR'ın sert bloklaması hâlâ kategori/profil bazlı değil** — her ürün, kategorisi ne olursa olsun aynı 3 GPSR alanını (Hersteller, Herstellerinformationen, Verantwortliche Person) doldurmadan kaydedilemez. Bu, kategori→profil atamasının otomatik anahtar-kelime eşleştirmesine dayanması ve ~%33 kategorinin genel GPSR'a düşmesi nedeniyle bilinçli olarak değiştirilmedi (yanlışlıkla satıcı bloklama riski) — bkz. docs/COMPLIANCE.md Bölüm 5.
- **Navigasyon/render kararlılığı** — sayfa geçişlerinde nadiren React'in "Cannot read properties of null (reading 'removeChild')" hatası verip arayüzün donması sorunu, kök nedeni (`PolarisLayout.jsx`'teki arama kutusunun `next/dynamic({ssr:false})` ile yüklenmesi + layout'un her sayfada yeniden mount olması) bulunup düzeltildi (2026-09-08). Shop tarafında aynı belirtinin bildirilmiş olması ayrıca doğrulanmadı — Shop'ta layout doğru şekilde paylaşımlı bir Next.js `layout.jsx` içinde olduğu için aynı kök neden orada geçerli değil.
- **Shop cache'inin anlık yenilenmesi** — kayıttan sonra shop'a `/api/revalidate` bildirimi gönderen mekanizma (middleware düzeyinde) koddadır ve mantıken doğru görünmektedir; üretimde hâlâ gecikme yaşanıyorsa önce `REVALIDATE_SECRET`/`STOREFRONT_PUBLIC_URL` ortam değişkenlerinin Render ve Shop tarafında birbirleriyle eşleştiği doğrulanmalıdır (uyuşmazlıkta istek prod'da sessizce başarısız olur, log basmaz).
- **Ürün listesi/envanter sayfası ve ürün düzenleme sayfasındaki tab yeniden tasarımı gibi bazı UI cilası maddeleri** (Save/Discard çubuğunun her durumda güvenilir görünmesi, "görsel ekle" butonunun her senaryoda çalıştığının canlı ortamda uçtan uca doğrulanması) kod incelemesiyle sorunsuz bulundu ama tam kapsamlı canlı regresyon testi zaman kısıtı nedeniyle yapılamadı.
