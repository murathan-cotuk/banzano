**Stripe & Ödemeler**

*Ödeme Alma (Checkout) ve Para Dağıtımı (Payout) Mimarisi*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Amaç

Andertal, çok satıcılı bir pazaryeri olarak müşteri ödemesini tek bir Stripe hesabında toplar, sonra bu tutarı satıcılara ve (yeni eklenen) affiliate'lere dağıtır. Bu doküman, ödeme alma (checkout) ve para dağıtma (payout) tarafındaki tüm Stripe entegrasyon noktalarını özetler.

## 2. Ödeme Alma (Checkout)

Müşteri ödemesi Stripe'ın Payment Element / Card Element bileşenleriyle alınır; kart bilgisi hiçbir zaman Andertal sunucularına dokunmaz (Stripe.js doğrudan Stripe'a gönderir). Çok satıcılı bir sepet tek bir Stripe PaymentIntent'te toplanır — her satıcının kendi kargo/komisyon hesaplaması ayrı yapılsa da müşteri tek bir ödeme işlemi görür. Kayıtlı ödeme yöntemleri (saved-payment-methods) desteklenir, böylece tekrarlayan müşteriler kart bilgisini yeniden girmez.

Özel bir yol: eğer bir siparişin tamamı bonus puan + kupon ile karşılanıyorsa (mal bedelinin geri kalanı sıfırsa), sistem Stripe'a hiç gitmeyen ayrı bir `platform_loyalty` ödeme yolunu kullanır — bu durumda kart bilgisi hiç istenmez (bkz. Bonus Puanları dokümanı, Bölüm 2, "Minimum Stripe tutarı" satırı: bonus, mal bedelini 0,50€'nun altına indiremez, tamamen bonus/kupon olan siparişler bu ayrı yolu kullanır).

## 3. Satıcılara Para Dağıtımı — İki Paralel Model

| **Model** | **Nasıl Çalışır** | **Kim Kullanır** |
| --- | --- | --- |
| IBAN / Banka Havalesi | Her 15 günlük dönem için otomatik "Provisionsrechnung" (komisyon faturası) üretilir; superuser bu faturaları inceleyip banka havalesiyle öder, sistemde "ödendi" işaretler. Ayrıca ayda iki kez (2. ve 4. Cuma) otomatik toplu bir işlem de vardır. | Satıcıların ÇOĞUNLUĞU (varsayılan/ana yöntem). |
| Stripe Connect Express | Satıcı/affiliate kendi Stripe Express hesabını bağlar (bir "Account Link" üzerinden Stripe'ın kendi KYC/onboarding akışına yönlendirilir). Platform stripe.transfers.create ile bu hesaba para aktarır. Hesap BİLİNÇLİ OLARAK "manuel ödeme takvimi" (payouts.schedule.interval = manual) ile ayarlanır — yani para hesaba düşer ama otomatik olarak dış bankaya gönderilmez; kişi kendi Stripe Express panelinden (bir "dashboard-link" / createLoginLink ile erişilen) istediği an kendi bankasına çeker. Bu, platformun parayı doğrudan otomatik olarak dış hesaplara göndermek yerine bir kontrol/onay adımı istemesinin bilinçli sonucudur. | Bazı satıcılar + affiliate sisteminin TÜMÜ. |

Satıcı tarafında Settings → Stripe Connect sayfası KASITLI olarak superuser-only'dir — sıradan bir satıcı bu sayfaya erişemez, çünkü satıcıların büyük çoğunluğu IBAN modelini kullanır ve Stripe Connect ile hiçbir işlem yapmamalıdır (yanlışlıkla iki farklı ödeme yoluna kaydolmalarını önlemek için).

## 4. Manuel Superuser Müdahalesi (routes/stripe-connect.js)

Superuser, gerektiğinde tek bir siparişin parasını normal 14 günlük bekleme süresini beklemeden manuel olarak serbest bırakabilir (/admin-hub/v1/stripe-connect/transfer/:orderId). Bu uç nokta, siparişin hangi ödeme modeliyle alındığına göre (destination charge / legacy transfer) iki farklı Stripe API çağrısı arasında otomatik seçim yapar.

## 5. Vergi (KDV) Ayrımı — Karıştırılmaması Gereken İki Farklı Oran

İki tamamen farklı KDV hesabı vardır ve bunlar birbirine karıştırılmamalıdır:

1. **Mal/ürün KDV'si** — müşterinin ödediği ürün fiyatının içindeki KDV (ürün tipine ve varış ülkesine göre değişir, ör. gıdada indirimli oran). Bu, mevcut `goods-vat.js` motoru tarafından hesaplanır ve Sipariş Faturasında (Verkaufsrechnung) gösterilir — komisyon burada YER ALMAZ.
2. **Komisyon KDV'si** — Andertal'ın satıcıdan kestiği platform komisyonu (%12 varsayılan) üzerinden hesaplanan, tamamen ayrı bir KDV. Bu yalnızca Provisionsrechnung'da (komisyon faturası) görünür ve mal bedeliyle hiçbir ilişkisi yoktur.

Bu ayrım, Bonus Puanları dokümanındaki "aynı Euro'nun üç farklı görünümü" prensibiyle doğrudan bağlantılıdır: bir sipariş faturası mal KDV'sini gösterir, bir komisyon faturası komisyon KDV'sini gösterir — ikisi asla tek bir toplamda birleştirilmez.

## 6. Affiliate Ödeme Sistemi ile İlişki

Affiliate Platform (bkz. ayrı doküman) sisteminin ödeme motoru, tam olarak yukarıdaki "Stripe Connect Express" modelini bire bir mirasla yeniden kullanır (aynı Account Link + manuel takvim + dashboard-link deseni) — kod tekrarı yerine mevcut resolveStripeSecretKeyFromPlatform / loadPlatformCheckoutRow yardımcı fonksiyonları doğrudan içe aktarılarak (import edilerek) kullanılmıştır.
