**Medusa Backend — Çekirdek Mimari**

*apps/medusa-backend — Tüm Uygulamaların Ortak API Sunucusu*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Genel Bakış

apps/medusa-backend, tüm Andertal ekosisteminin (Shop, SellerCentral, Affiliate Portal, Developer Platform) ortak API sunucusudur. Node.js + Express üzerine kurulu, Medusa v2 çekirdeği ile genişletilmiş, ~60 ayrı route (uç nokta) dosyasından oluşan tek bir monolitik backend'dir (mikroservis mimarisi değildir). Bu doküman, diğer tüm entegrasyon dokümanlarının (Stripe, JTL, Compliance, Bonus Puanları vb.) ortak referans aldığı mimari kararları özetler.

## 2. Temel Mimari Kararlar (Tüm Modüllerde Tekrarlanan Desenler)

- **Ham `pg` istemcisi, Medusa'nın kendi ORM/manager'ı yerine.** Medusa v2'nin dahili "manager"ı çoğu özel tabloda kullanılabilir durumda değildir (sunucu başlangıç logunda görülen "Medusa manager not available: Could not resolve 'manager'" bunun kanıtıdır); bunun yerine hemen her route dosyası kendi `pg.Client` bağlantısını açıp kapatan basit, açık fonksiyonlar kullanır. Bu, framework'ün soyutlamasına güvenmek yerine SQL üzerinde tam kontrol sağlar ama her dosyada bağlantı açma/kapama tekrarı anlamına gelir.
- **Migration sistemi yoktur — idempotent `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.** Her modül, gerekli tabloları/sütunları kendi "ensure" fonksiyonuyla (ör. `ensureAffiliateTables`, şema dosyaları) sunucu her başladığında veya her istekte kontrol eder. Şema değişikliği yapmak için ayrı bir migration dosyası yazmak yerine doğrudan bu "ensure" fonksiyonu güncellenir.
- **`admin_hub_*` önekli tablolar, Medusa'nın kendi native tablolarından ayrıdır.** Ürün katalog, kategori, sayfa, menü gibi pazaryerine özel her şey `admin_hub_products`, `admin_hub_categories` gibi kendi şemasında tutulur; Medusa'nın çekirdek `product`/`product_category` tabloları yalnızca sınırlı, temel senaryolarda (ör. bazı eski/çekirdek uyumluluk noktalarında) kullanılır.
- **Her uygulamanın kendi, birbirinden bağımsız JWT sistemi vardır** — satıcı (`SELLER_JWT_SECRET`), müşteri (`CUSTOMER_JWT_SECRET`), affiliate (`AFFILIATE_JWT_SECRET`), geliştirici (`DEVELOPER_JWT_SECRET`) hepsi ayrı sırlarla imzalanır ve Medusa'nın kendi admin auth'undan tamamen bağımsızdır.
- **Gerçek üretim veritabanına karşı çalışırken sert güvenlik kilitleri vardır** — `DATABASE_URL` bir render.com adresine işaret ediyorsa, ilgili JWT sırrı ortam değişkeni olarak tanımlanmadan sunucu başlamayı reddeder (zayıf bir geliştirme-varsayılanının gerçek veriye karşı yanlışlıkla kullanılmasını önlemek için).
- **Fire-and-forget arka plan işleri** — kritik olmayan ama faydalı işler (ör. uyumluluk taraması `stampComplianceReviewAsync`, shop cache bildirimi `notifyShopRevalidate`) ana isteği asla bekletmeyecek, hata verirse sessizce yutulacak şekilde tasarlanır; bu işler başarısız olsa bile asıl kayıt/güncelleme işlemi etkilenmez.

## 3. Route Dosyalarının Kategorik Dökümü (59 dosya)

| **Kategori** | **İlgili Dosyalar** |
| --- | --- |
| Kimlik & Hesap | seller-auth, seller-account, seller-agreement, seller-card, verification, developer-api, affiliate-api (auth kısmı) |
| Ürün & Katalog | store-products, admin-products, categories, collections, brands, product-groups, product-badges, metafields, media |
| Sipariş & Ödeme | store-checkout, platform-checkout, orders, order-documents, returns, transactions, shipment-tracking, stripe-connect, payouts, saved-payment-methods, webhooks |
| Satıcı Yönetimi | sellers, seller-listings, seller-locations, seller-settings, seller-error-logs |
| Pazarlama | campaigns, marketing-automations, coupons, newsletter, personalization, ranking, seo-hub |
| İçerik / CMS | pages, menus, styles, integrations, store-integrations |
| Müşteri İletişimi | customers, messages, notifications, support-cases |
| Affiliate Sistemi | affiliate-api, affiliate-admin, affiliate-seller-marketing, affiliate-track (bkz. ayrı doküman) |
| App Platform | app-oauth, app-store (bkz. Developer Platform dokümanı) |
| Uyumluluk & Vergi | dac7, bonus-points-admin (bkz. ayrı dokümanlar) |
| Dış Kanal / Feed | idealo-feed (bkz. idealo.md — henüz kod yok, sadece yol haritası), public-api-v1, store-public |
| Genel Akış Motoru | flows (bkz. Flow Automation dokümanı) |

## 4. Ödeme Modelleri (İki Paralel Yaklaşım)

Kod tabanında ödeme dağıtımı için iki farklı, bilinçli olarak bir arada tutulan model bulunur:

1. **Satıcı tarafı Stripe Connect (net komisyon sonrası ödeme)** — her satıcı kendi Stripe Connect hesabını bağlar (Settings → stripe-connect, yalnızca superuser erişimine kapalı bir bilgi sayfası, satıcılar burada işlem yapamaz). Satıcının payout'u her zaman "mal bedeli − platform komisyonu (%12 varsayılan)" formülüyle hesaplanır; bonus puan finansmanı bu hesaba dahil edilmez (satıcı bonusun maliyetini asla görmez) — bkz. Bonus Puanları dokümanı, Bölüm 3.
2. **Platform hazinesi (treasury) → dışa Stripe Connect transferi** — bazı ödemeler satıcıdan değil, doğrudan Andertal'ın kendi Stripe bakiyesinden çıkar: affiliate komisyon ödemeleri (Andertal'ın kestiği platform komisyonundan bir pay, `payout-scheduler.js` ile aylık Stripe Connect transferi olarak affiliate'in kendi Connect hesabına gönderilir) ve bonus puan finansmanı (müşteriye tanınan indirimin maliyeti tamamen Andertal'ın kasasından karşılanır, hiçbir satıcı faturasına yansımaz). Bu iki akış birbirinden ve satıcı ödemelerinden tamamen ayrı muhasebeleştirilir — aynı Euro'nun üç farklı görünümü (sipariş faturası / komisyon faturası / Finanzamt sekmesi) prensibiyle karışmaları engellenir (bkz. Bonus Puanları dokümanı, Bölüm 4).

## 5. Test ve Doğrulama Kültürü

Ayrı bir staging veritabanı YOKTUR. Yeni bir özelliğin veritabanı davranışı doğrulanırken iki yöntemden biri kullanılır: (a) BEGIN...ROLLBACK içine alınmış bir işlemle sadece şema/yapı testi yapmak, ya da (b) gerçek üretim veritabanına karşı küçük, tek seferlik bir Node betiği ile gerçek INSERT + doğrulama + DELETE (temizlik) döngüsü çalıştırmak. Bu betikler her zaman iş bitince silinir, kalıcı kod tabanının bir parçası değildir. package.json içindeki "test" script'i, node:test çalıştırıcısı ile çalışan kalıcı birim testlerini (attribution-engine, commission-calculator, auth, media-filename, vb.) içerir.
