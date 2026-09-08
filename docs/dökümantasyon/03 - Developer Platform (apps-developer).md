**Developer Platform**

*apps/developer — Üçüncü Taraf Uygulama (App) Ekosistemi*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Genel Bakış

Developer Platform (planlanan alan adı: developer.andertal.com), üçüncü taraf yazılımcıların Andertal pazaryerine entegre olan "uygulamalar" (app) geliştirip yayınlayabildiği bir Next.js portalıdır (apps/developer). Amaç, App Platform ekosistemi kurarak dış geliştiricilerin API anahtarları alıp kendi entegrasyonlarını (ör. muhasebe yazılımı bağlantısı, özel raporlama aracı, otomasyon eklentisi) inşa edebilmesidir — modelin ilham kaynağı Shopify App Store / Stripe App benzeri platformlardır.

## 2. Kimlik Doğrulama

Kendi JWT sistemi vardır (Affiliate ve Seller sistemlerinden bağımsız, ayrı bir "developer" kullanıcı tipi). Kayıt (/auth/signup) ve giriş (/auth/login) uç noktaları apps/medusa-backend/src/routes/developer-api.js içinde tanımlıdır ve DEVELOPER_JWT_SECRET ortam değişkeni ile imzalanır.

## 3. Uygulama Yaşam Döngüsü

Bir uygulama şu durumlar arasında ilerler: **draft** (geliştirici manifest'i oluşturdu, henüz gönderilmedi) → **pending_review** (geliştirici incelemeye gönderdi) → **published** (Andertal onayladı, artık kurulabilir) ya da reddedilirse tekrar düzenlemeye açık bir duruma döner. `APP_PLATFORM_AUTO_APPROVE` ortam değişkeni `true` ise bu inceleme adımı tamamen atlanır ve uygulama oluşturulur oluşturulmaz (ya da gönderilir gönderilmez) doğrudan `published` durumuna geçer — bu, geliştirme/test ortamları için düşünülmüş bir kısayoldur, üretimde dikkatli kullanılmalıdır.

## 4. İzin Kapsamları (Scopes)

scope-registry.js dosyası, bir uygulamanın talep edebileceği tüm izin kapsamlarının merkezi listesini tutar (ör. "orders:read", "products:write" gibi ayrıntı düzeyinde erişim). Bu, üçüncü parti bir uygulamanın yalnızca ihtiyacı olan veriye erişebilmesini garanti eden bir güvenlik sınırıdır.

## 5. Durum ve Bilinen Eksikler (2026-09 itibarıyla)

Kod tarafı (PR1-4) tamamlanmış durumdadır — kimlik doğrulama, izin kapsamları, uygulama yaşam döngüsü ve API uç noktalarının hepsi çalışır durumdadır. Eksik olan tamamen operasyoneldir, kod değişikliği gerektirmez:

- Vercel'de `apps/developer` için bir proje henüz oluşturulmadı, `developer.andertal.com` domaini bağlanmadı.
- Render'da `DEVELOPER_JWT_SECRET`, `CORS_ORIGINS`'e `developer.andertal.com` eklenmesi ve `APP_PLATFORM_AUTO_APPROVE`/`SUPERUSER_EMAILS` gibi ortam değişkenleri henüz ayarlanmadı.
- Bu adımlar tamamlanana kadar Developer Platform hiçbir gerçek trafik almaz — yani şu an tamamen kapalı, görünmeyen bir özelliktir.
