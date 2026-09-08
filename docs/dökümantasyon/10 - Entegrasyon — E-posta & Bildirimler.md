**E-posta & Bildirimler**

*src/email-providers.js — Değiştirilebilir Giden E-posta Katmanı*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Amaç

Platformun gönderdiği tüm giden e-postaları (pazarlama flow'ları, sipariş bildirimleri, komisyon faturaları, affiliate hesap bildirimleri, destek mesajları vb.) ve uygulama içi bildirim (notification) sistemini kapsar.

## 2. Giden E-posta — Değiştirilebilir Sağlayıcı (Pluggable Provider)

src/email-providers.js dosyası, hangi e-posta servisinin kullanılacağını platform ayarlarından okuyup çalışma zamanında (runtime) seçen bir soyutlama katmanıdır. İki sağlayıcı desteklenir:

| **Sağlayıcı** | **Kullanım Şekli** |
| --- | --- |
| SMTP (Nodemailer) | Klasik SMTP sunucu bağlantısı (ör. bir e-posta hosting sağlayıcısının SMTP'si). |
| Resend | Modern, API tabanlı bir e-posta gönderim servisi (transactional email API). |

Hangi sağlayıcının aktif olduğu ve API anahtarları veritabanından (platform ayarları) okunur, koda sabitlenmez — bu sayede sağlayıcı değişikliği bir kod değişikliği gerektirmez, sadece SellerCentral/superuser ayarlarından bir güncelleme yeterlidir.

## 3. E-posta Gönderilen Senaryolar

- **Pazarlama flow'ları** (bkz. Flow Automation dokümanı) — sipariş oluşturuldu/kargoya verildi/teslim edildi, değerlendirme isteği, geri kazanma (win-back), sepet terk bildirimi.
- **Sipariş & hesap işlemleri** — sipariş onayı, şifre sıfırlama, satıcı hesap onayı/reddi (SellerCentral kayıt sonrası inceleme süreci).
- **Komisyon faturaları (Provisionsrechnung)** — her 15 günlük dönem sonunda otomatik üretilen komisyon faturası satıcıya e-posta ile bildirilir (`[commission-invoice-email]` log öneki ile izlenir).
- **Affiliate hesap bildirimleri** — başvuru onayı/reddi, aylık ödeme bildirimi, fraud/askıya alma bildirimi.
- **Destek/mesajlaşma** — Inbox üzerinden gelen yeni mesaj bildirimleri.

Önemli operasyonel not: SMTP sağlayıcı ayarlanmamışsa (platform ayarlarında ne SMTP ne Resend yapılandırılmışsa) e-posta gönderimi sessizce atlanır ve yalnızca sunucu logunda "SMTP not configured" uyarısı görülür — asıl işlem (ör. fatura üretimi) bu yüzden ASLA başarısız olmaz, sadece bildirim e-postası gitmez.

## 4. Uygulama İçi Bildirimler

notifications.js ve admin-hub-notify.js (paylaşılan yardımcı fonksiyon insertAdminHubNotificationSafe), SellerCentral'ın sağ üstündeki bildirim çanı ile Shop'taki müşteri bildirimlerini besleyen ortak, veritabanı tabanlı bir bildirim tablosuna satır ekler. E-posta gönderimi ile uygulama içi bildirim genellikle BİRLİKTE tetiklenir (aynı olay hem e-posta hem uygulama içi bildirim üretir) ama birbirinden bağımsız çalışabilir — biri başarısız olursa diğerini engellemez.
