**Flow Otomasyonu**

*BullMQ/Redis Tabanlı Pazarlama Otomasyon Motoru — src/flow-queue.js*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Amaç

SellerCentral'daki Marketing → Automations bölümü, satıcıların "tetikleyici olay → e-posta gönder" şeklinde kural tabanlı pazarlama otomasyonları (flow) tanımlamasını sağlar — örn. "sipariş kargoya verildiğinde takip e-postası gönder", "teslim edildikten 7 gün sonra değerlendirme iste", "30 gün alışveriş yapmayan müşteriye geri kazanma e-postası gönder" (win-back). Bu, e-ticaret platformlarındaki "Klaviyo/Mailchimp Flows" benzeri bir özelliktir, ancak Andertal'ın kendi altyapısında inşa edilmiştir.

## 2. Mimari — BullMQ + Redis

Sistem, iş kuyruğu için BullMQ kütüphanesini ve arkasında Redis'i kullanır. Bir tetikleyici olay gerçekleştiğinde (ör. sipariş kargoya verildi), ilgili flow'lar bir kuyruğa iş (job) olarak eklenir; bir worker süreci bu işleri sırayla işleyip e-postayı gönderir. Bu, e-posta gönderiminin ana istek/yanıt döngüsünü bloklamamasını ve geçici bir hata durumunda (ör. e-posta sağlayıcısı geçici erişilemez) işin yeniden denenebilmesini sağlar.

`REDIS_URL` ortam değişkeni tanımlı DEĞİLSE sistem otomatik olarak "fake redis" / bellek-içi (in-memory) bir kuyruğa düşer (sunucu başlangıç loglarında "redisUrl not found. A fake redis instance will be used." uyarısı görülür) — bu, geliştirme ortamında Redis kurmadan çalışabilmek için bir geri dönüş mekanizmasıdır, ama üretimde kalıcı olmayan bir kuyruk anlamına gelir (sunucu yeniden başlarsa bekleyen işler kaybolur). Üretimde `REDIS_URL`'in gerçekten tanımlı ve bağlı olduğu doğrulanmalıdır (bkz. Shop dokümanının Bölüm 6'sındaki performans notu — bu doğrulama henüz yapılmadı).

## 3. Tetikleyici Olaylar (Triggers)

| **Tetikleyici** | **Anlamı** |
| --- | --- |
| order_placed | Sipariş oluşturuldu (ödeme alındı). |
| order_shipped | Sipariş kargoya verildi. |
| order_delivered | Sipariş teslim edildi. |
| review_request | Değerlendirme isteği zamanlanmış (genellikle teslimattan belirli gün sonra). |
| win_back | Müşteri belirli bir süredir alışveriş yapmadı — geri kazanma kampanyası. |
| abandoned_cart | Sepet terk edildi (ödeme tamamlanmadı). |

Onlarca hazır e-posta şablonu (flows.js içinde) bu tetikleyicilerin bir veya birden fazlasına bağlanabilir — örneğin bir "teşekkür" şablonu hem order_placed hem order_shipped hem order_delivered tetikleyicilerinde kullanılabilir; satıcı hangi şablonun hangi olayda gönderileceğini SellerCentral arayüzünden seçer.

## 4. Diğer Sistemlerle Bağlantı

Bu kuyruk mekanizması yalnızca pazarlama e-postalarına özgü değildir — Affiliate sisteminin sellercentral seller-auth.js kaydı, DAC7 raporlaması gibi başka "olay olduğunda arka planda bir şey yap" ihtiyaçları da benzer (ama daha basit, çoğunlukla setInterval tabanlı) desenler kullanır. Flow Automation, bunlardan yalnızca "kural tabanlı, satıcının kendi tanımladığı pazarlama e-postaları" kısmının resmi adıdır.
