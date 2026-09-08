**Affiliate Platform**

*apps/affiliate · apps/medusa-backend (affiliate-platform modülü) · apps/sellercentral · apps/shop*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Genel Bakış

Affiliate Portal (affiliate.andertal.com), Andertal pazaryerine yeni satıcı ve müşteri getiren üçüncü taraf "affiliate"lerin (bağlı pazarlamacı) kayıt olup link ürettiği, kazancını takip ettiği ve ödemesini aldığı bağımsız bir Next.js uygulamasıdır (apps/affiliate). Sistem, docs/affiliate.md içinde tanımlanan detaylı ürün spesifikasyonuna göre 13 ayrı PR (Pull Request) halinde inşa edilmiştir.

Temel prensip: Affiliate komisyonu SATICIDAN kesilmez. Andertal'ın zaten aldığı pazaryeri komisyonundan (varsayılan %12) bir pay ayrılır ve bu pay Andertal'ın kendi kasasından (Stripe hesabından) affiliate'e Stripe Connect üzerinden aktarılır. Yani satıcının maliyeti hiçbir şekilde değişmez.

## 2. İki Affiliate Modeli

### Model 1 — Seller Referral (Satıcı Yönlendirme, Tekrarlayan Gelir)

Bir affiliate, kendi özel `seller_signup` linkiyle (AFF_XXX kodu) yeni bir satıcıyı platforma getirdiğinde devreye girer. Bu link tıklaması yalnızca **24 saat** geçerlidir (Model 2'ye göre çok daha kısa bir pencere — kayıt genelde hemen olur). Satıcı bu pencere içinde kayıt olursa `seller_referrals` tablosuna **kalıcı** bir satır yazılır (`seller_id` üzerinde veritabanı seviyesinde UNIQUE kısıtı) — bir kez kilitlendikten sonra o satıcının sonraki tıklamaları bu atamayı **değiştiremez** (lock-in).

Her ayın 1'inde çalışan bir arka plan işi (`seller-referral-monthly.js`), referans verilen satıcının bir önceki takvim ayında ürettiği TÜM platform komisyonunu (Andertal'ın kestiği %12'lik pay, iade edilen siparişler hariç tutularak) toplar ve bunun **%5**'ini tek bir `affiliate_commissions` satırı olarak affiliate'e kazandırır. Bu, tekrarlayan (recurring) bir gelirdir: satıcı platformda sattıkça, onu getiren affiliate her ay pay almaya devam eder. İşlem idempotent'tir — aynı ay için tekrar tetiklense bile (o ay zaten kredilendirildiyse) ikinci kez yazmaz, bu da kesin bir cron yerine periyodik bir kontrolle de güvenle çalışmasını sağlar.

### Model 2 — Product Referral (Ürün Yönlendirme, Tüm Katalog)

Bir affiliate'in `product` / `category` / `storefront` tipi linki üzerinden gelen bir ziyaretçi **30 gün** içinde herhangi bir sipariş verirse devreye girer. Model 1'in aksine burada bir kilitlenme YOKTUR: aynı ziyaretçi farklı affiliate linklerine art arda tıklarsa, sipariş anındaki **en son tıklanan** link kazanır (gerçek last-click, her sipariş kendi başına değerlendirilir). Komisyon oranı, Andertal'ın o siparişten aldığı platform komisyonunun **%8**'idir (Model 1'deki %5'ten yüksek — tek seferlik bir satış için ödenen daha büyük pay). Her komisyon satırı, kesinleşmeden (confirmed) önce **30 günlük** bir bekleme (hold) süresi boyunca `pending` durumunda kalır; bu süre içinde bir iade/chargeback olursa komisyon `clawed_back` durumuna geri alınır.

## 3. Mimari ve Dosya Yapısı

Sistem 3 uygulamaya yayılmıştır:

| **Uygulama** | **Rolü** |
| --- | --- |
| apps/affiliate | Affiliate'in kendi portalı: kayıt, giriş, link üretimi, kazanç raporları, ödemeler, Stripe bağlantısı. |
| apps/medusa-backend | Tüm iş mantığı, veritabanı, komisyon hesaplama, ödeme motoru, fraud tespiti — /affiliate-api/v1/* ve /admin-hub/v1/affiliate-admin/* uç noktaları. |
| apps/sellercentral | Satıcı tarafında salt-okunur özet sayfası (/marketing/affiliate) ve superuser yönetim paneli (/affiliate-admin). |
| apps/shop | Ziyaretçi tarafında ?ref= parametresi yakalama, çerez onayı entegrasyonu, kısa link yönlendirmesi (/r/[code]), tek seferlik "bu link bir affiliate linkidir" bilgilendirme banner'ı. |

#### Backend modül yapısı (apps/medusa-backend/src/modules/affiliate-platform/)

| **Dosya** | **Görevi** |
| --- | --- |
| config.js | Tüm karar tablosu sabitleri: oranlar, pencere süreleri, minimum ödeme tutarı, izin verilen ülkeler. |
| schema.js | Veritabanı tablolarını (idempotent CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN IF NOT EXISTS) oluşturan fonksiyon. Her istek başında çağrılır. |
| attribution-engine.js | Saf mantık (DB'siz): hangi tıklamanın hangi satışa bağlanacağını belirleyen "last-click" algoritması. |
| commission-calculator.js | Saf mantık: platform komisyonundan affiliate payını hesaplayan fonksiyonlar (%5 / %8). |
| codes.js | AFF_XXXXXXXX formatında benzersiz affiliate kodu üretici (Crockford base32). |
| auth.js | Affiliate'e özel şifre hash'leme (scrypt) ve JWT imzalama/doğrulama (AFFILIATE_JWT_SECRET). |
| fraud-detector.js | Self-referral (kendine yönlendirme) tespiti + manuel fraud flag kaydı + otomatik askıya alma eşiği. |
| payout-scheduler.js | Aylık Stripe Connect transfer motoru — AFFILIATE_PAYOUTS_ENABLED=false olduğu sürece devre dışıdır (bkz. Bölüm 8). |
| workers/commission-recalc.js | Sipariş ödendiğinde çalışır: attribution bulur, self-referral kontrolü yapar, komisyon satırı oluşturur. |
| workers/commission-clawback.js | İade edilen siparişin komisyonunu geri alır (status → clawed_back). |
| workers/commission-confirm.js | Günlük: 30 günlük bekleme süresi dolan "pending" komisyonları "confirmed" yapar. |
| workers/seller-referral-monthly.js | Aylık: her referred seller'ın o ayki platform komisyonunun %5'ini hesaplayıp komisyon satırı oluşturur. |

## 4. Veritabanı Şeması

Sekiz ana tablo + seller_users tablosuna bir yeni sütun. Tüm tablolar UUID birincil anahtar kullanır ve idempotent şekilde (uygulama her istekte kontrol eder, migration sistemi yerine) oluşturulur — bu, projenin genel mimari kararıdır (ayrı bir migration sistemi yoktur).

| **Tablo** | **Amaç** |
| --- | --- |
| affiliates | Her affiliate hesabı: kod, e-posta, şifre, ülke, VAT/vergi no, Stripe hesap ID, onay durumu (pending/active/suspended/banned/closed). |
| affiliate_links | Üretilen her link: tipi (seller_signup/product/category/storefront), hedef URL, kısa kod, devre dışı bırakma bilgisi. |
| affiliate_clicks | Her tıklama kaydı: IP'nin hash'i (GDPR — ham IP asla saklanmaz), çerez onayı durumu. |
| affiliate_attributions | Hangi tıklamanın hangi affiliate'e ait olduğunun takibi, son geçerlilik tarihi, çözümlenmiş sipariş ID'si. |
| seller_referrals | Model 1 kilidi: bir satıcı sadece bir affiliate'e bağlı kalır (seller_id UNIQUE kısıtı ile veritabanı seviyesinde garanti edilir). |
| affiliate_commissions | Kazanılan her komisyon satırı: kaynak tipi, tutar, oran, durum (pending/confirmed/clawed_back/paid/forfeited), denetim alanları (manuel düzeltmeler için). |
| affiliate_payouts | Yapılan her toplu ödeme: tutar, Stripe transfer ID'si, dönem, durum. |
| affiliate_fraud_flags | Tespit edilen her şüpheli durum: tipi (self_referral/brand_bid/manual/...), önem derecesi, çözüm notu. |

## 5. Takip (Tracking) Akışı

Bir ziyaretçi ?ref=AFF_XXX içeren bir link üzerinden geldiğinde:

1. Shop tarafındaki yakalama katmanı isteği görür, `__atrl` adında bir çerez yazar (30 gün geçerli) ve linkteki kodu `affiliate_links` tablosunda çözümler.
2. Aynı anda `affiliate_attributions` tablosuna bir satır yazılır/güncellenir; geçerlilik süresi kaynağa göre hesaplanır (`seller_signup` → 24 saat, `product`/`category`/`storefront` → 30 gün).
3. Ziyaretçi süre dolmadan bir sipariş verirse (Model 2) ya da satıcı olarak kayıt olursa (Model 1), o anki geçerli attribution satırı okunur ve ilgili komisyon (workers/commission-recalc.js veya seller-referral-monthly.js) hesaplanır. Model 2'de her yeni tıklama önceki attribution'ı ezer (last-click); Model 1'de kayıt anına kadar aynı şekilde ezilebilir, ama kayıt gerçekleştiği an `seller_referrals` satırı ile kalıcı olarak kilitlenir.
4. Süre dolmuşsa veya o kaynak için hiç attribution yoksa, hiçbir affiliate'e kredi yazılmaz — sipariş/kayıt normal şekilde devam eder, yalnızca komisyonsuz.
5. Tüm tıklama kayıtları GDPR gereği ham IP değil, IP'nin hash'i olarak `affiliate_clicks` tablosuna yazılır; çerez onayı verilmemişse tıklama sayılır ama kalıcı attribution oluşturulmaz.

## 6. Affiliate Portalı Özellikleri (apps/affiliate)

| **Sayfa** | **İçerik** |
| --- | --- |
| /signup, /login | Kayıt (ülke seçimi dropdown, şifre görünürlük butonu, Şartlar/Gizlilik linkleri) ve giriş. |
| /dashboard | Aktif link sayısı, toplam tıklama, yönlendirilen satıcı sayısı, bekleyen/onaylanmış komisyon özeti. |
| /links, /links/new | Link listesi ve yeni link oluşturma sihirbazı (tip seçimi + ürün arama). |
| /referrals | Yönlendirilen satıcıların anonimleştirilmiş listesi (ör. "S-1234"), bu ay/toplam kazanç. |
| /reports | Tüm komisyon geçmişi, durum filtresi, CSV dışa aktarma. |
| /payouts | Kendi ödeme geçmişi + tahmini bir sonraki ödeme tutarı. |
| /settings | Stripe Connect hesap bağlama/durum görüntüleme (ödeme alabilmek için ZORUNLU adım). |
| /resources | Hazır tanıtım metinleri, kopyala butonu, kanuni bildirim (linklerin reklam olarak işaretlenmesi zorunluluğu) uyarısı. |
| /terms | Affiliate sözleşmesi taslağı — sayfa üzerinde büyük harflerle "TASLAK — HENÜZ HUKUKİ İNCELEMEDEN GEÇMEDİ" uyarısı vardır (bkz. Bölüm 8). |

## 7. SellerCentral Tarafı

### 7.1 /marketing/affiliate (Her satıcı görebilir)

Salt okunur bilgilendirme sayfası: satıcının ürünlerine gelen affiliate tıklama/satış özeti. Satıcının hiçbir onay/red/ekleme yetkisi yoktur — tüm katalog otomatik olarak affiliate'lere açıktır ve komisyon Andertal kasasından ödendiği için satıcının bakiyesini etkilemez.

### 7.2 /affiliate-admin (Yalnızca Superuser)

Sekmeli tek sayfa halinde inşa edilmiştir (docs/affiliate.md'de 4 ayrı sayfa olarak tarif edilmiş olsa da işlevsel olarak eşdeğer, daha hızlı gezinme sağlayan tek panel tercih edilmiştir):

| **Sekme** | **İşlev** |
| --- | --- |
| Bekleyen Kayıtlar | Yeni affiliate başvurularını onaylama/reddetme. |
| Fraud Kuyruğu | Otomatik (self-referral) ve manuel (marka-teklif kontrolü) tespit edilen şüpheli durumlar; çözüldü/askıya al/yasakla aksiyonları. |
| Ödemeler | Tüm affiliate'lere yapılmış geçmiş ödemelerin tam listesi. |
| Komisyon Düzeltmeleri | Superuser'ın manuel olarak bonus ekleyebildiği veya komisyon geri alabildiği (clawback), gerekçesi zorunlu olarak kaydedilen (denetim izi) bölüm. |
| Linkler | Bir affiliate kodunu arayıp o affiliate'in ürettiği linkleri görüntüleme; yasal/fraud gerekçesiyle acil link devre dışı bırakma/yeniden etkinleştirme. |

## 8. Ödeme Sistemi ve Uyum Kapıları (Compliance Gates)

ÖNEMLİ — bu bölüm operasyonel risk içerir, lütfen dikkatle okuyun:

### 8.1 Ödemeler varsayılan olarak KAPALIDIR

Gerçek Stripe para transferi yapan aylık ödeme motoru (payout-scheduler.js), AFFILIATE_PAYOUTS_ENABLED ortam değişkeni "true" olmadığı sürece hiçbir işlem yapmaz (varsayılan: kapalı/tanımsız). Bunun nedeni, docs/affiliate.md'nin açıkça şart koştuğu şu kural: "PR 7 (Payout) merge öncesi: Steuerberater (mali müşavir) vergi modülü review'u + DAC7 raporlama logic doğrulaması" YAPILMADAN bu özellik canlıya alınamaz. Bu inceleme şu ana kadar YAPILMAMIŞTIR.

### 8.2 Diğer iki uyum kapısı

Steuerberater/DAC7 incelemesine ek olarak, docs/affiliate.md şu iki kapıyı da ödeme açılmadan önce şart koşar:

- **TTDSG / Hukuk onayı** — çerez rızası akışının (affiliate takip çerezi dahil) Almanya'daki TTDSG (Telekommunikation-Telemedien-Datenschutz-Gesetz) ve genel GDPR gerekliliklerini karşıladığının bir hukuk danışmanı tarafından teyit edilmesi. Kod tarafında çerez onayı entegrasyonu mevcuttur (bkz. Bölüm 3, apps/shop satırı) ama bu, hukuki bir onay yerine geçmez.
- **Avukat sözleşme (/terms) incelemesi** — affiliate portalındaki `/terms` sayfası şu an bir taslaktır ve sayfa üzerinde büyük harflerle "TASLAK — HENÜZ HUKUKİ İNCELEMEDEN GEÇMEDİ" uyarısı gösterilir. Bir avukat bu sözleşmeyi onaylamadan bağlayıcı bir hukuki metin olarak sunulamaz.

Sonuç: sistemin kod tarafı tamamen çalışır durumdadır ve gerçek para dahil her adım (Stripe Connect onboarding, transfer, denetim izi) production veritabanına karşı test edilip doğrulanmıştır — ancak yukarıdaki üç incelemeden hiçbiri tamamlanmadan gerçek parayla affiliate ödemesi yapılmamalı ve /terms sayfası bağlayıcı bir sözleşme olarak sunulmamalıdır.

## 9. Fraud (Sahtekârlık) Tespiti — Mevcut Durum

Şu anda TAM olarak çalışan tek otomatik kontrol: Self-Referral (kendi kendine yönlendirme) — affiliate'in kendi e-posta adresiyle kendi linki üzerinden alışveriş yapması tespit edilir, komisyon oluşturulmaz ve otomatik "high" önem dereceli bir flag kaydedilir. Bir affiliate'in çözülmemiş flag sayısı 3'e ulaştığında hesabı otomatik olarak askıya alınır.

Bilinçli olarak ERTELENMİŞ kontroller (docs/affiliate.md'de tarif edilmiş ancak bu aşamada inşa edilmemiş — kod içinde bu açıkça yorum olarak belirtilmiştir): IP eşleşmesi, tıklama hızı (velocity) analizi, coğrafi/zaman deseni analizi, otomatik chargeback takibi. Marka adı üzerine ücretli reklam verme (brand bidding) tespiti ise otomatik değil, manueldir: bir superuser periyodik olarak Google/Bing'de arama yapar ve bulgu varsa panel üzerinden (Fraud Kuyruğu sekmesi) kaydeder — bkz. docs/affiliate-brand-bid-monitoring.md.

## 10. Bilinen Eksikler / Gelecek İş

- **Render `CORS_ORIGINS`'e affiliate portal domaini eklenmedi** — bu eklenmeden canlı affiliate.andertal.com üzerinde kayıt/giriş "Failed to fetch" hatası verir (kod tarafında sorun yoktur, saf bir ortam-değişkeni eksikliğidir).
- **Üç uyum kapısından hiçbiri kapatılmadı** (bkz. Bölüm 8) — gerçek para transferi bu tamamlanmadan açılmamalı.
- **Ertelenmiş fraud kontrolleri** henüz inşa edilmedi (bkz. Bölüm 9): IP eşleşmesi, tıklama hızı analizi, coğrafi/zaman deseni analizi, otomatik chargeback takibi.
- **docs/CONNECTOR.md içinde sızmış bir JTL secret'ı** ayrı, acil bir güvenlik görevi olarak bulundu (2026-09-08) — affiliate sistemiyle ilgisi yok ama aynı tarama sırasında tespit edildi, rotasyonu gerekiyor.
