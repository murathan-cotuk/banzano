# Process Model — BPMN Diyagramları

Bu klasördeki `.bpmn` dosyaları, Business Process Model and Notation (BPMN 2.0) standardında yazılmış, gerçek iş akışı diyagramlarıdır (havuz/lane, görev, karar noktası, başlangıç/bitiş olayları ve görsel yerleşim bilgisi dahil).

## Nasıl açılır?

`.bpmn` dosyaları düz XML'dir ama Word/Visio ile doğrudan açılmaz. En kolay yollar:

1. **Tarayıcıda, kurulum gerektirmeden:** https://demo.bpmn.io/ adresine gidip dosyayı sürükle-bırak yapın. Ücretsiz, hesap gerektirmez.
2. **Bizagi Modeler** (görev metninde adı geçen araç): Bizagi kendi `.bpm` formatını kullanır ama BPMN 2.0 XML içe aktarma (import) desteği vardır — File → Import → BPMN 2.0.
3. **Camunda Modeler** (ücretsiz masaüstü uygulaması): dosyayı doğrudan açar, düzenlemenize de izin verir.
4. **Microsoft Visio:** Visio'nun kendi BPMN şablonları vardır ama üçüncü parti `.bpmn` XML dosyalarını doğrudan içe aktarmaz — önce yukarıdaki araçlardan biriyle açıp Visio'nun anladığı bir formata (ör. SVG/PNG, veya Visio'nun "BPMN Diagram" şablonuna elle kopyalama) çevirmeniz gerekir. Native `.vsdx` üretimi bu araç setinde desteklenmez; BPMN 2.0 XML, tüm modelleme araçlarının ortak/taşınabilir standart formatı olduğu için bu yol tercih edilmiştir.

## Dosyalar

| Dosya | Süreç |
|---|---|
| 01 - Sipariş ve Ödeme Süreci.bpmn | Müşteri sepeti onayından satıcıya ödeme yapılana kadar tüm sipariş yaşam döngüsü. |
| 02 - Satıcı Kayıt ve Onay Süreci.bpmn | Satıcı adayının kaydından superuser onayına, ürünlerin otomatik yayına alınmasına kadar. |
| 03 - Affiliate Komisyon Yaşam Döngüsü.bpmn | Affiliate linkine tıklamadan, attribution'a, komisyon hesaplamaya, onay bekleme süresine, aylık Stripe ödemesine kadar (Model 2 — Product Referral örneği). |
| 04 - İade Süreci.bpmn | Müşteri iade talebinden, ödeme/bonus/komisyon ters kayıtlarına kadar. |
| 05 - Uyumluluk (Compliance) İnceleme Süreci.bpmn | Ürün kaydından, kategori bazlı uyumluluk profili çözümlemeye, superuser incelemesine kadar. |

## Not

Bu 5 diyagram, platformdaki en kritik/temel süreçleri kapsar — literal olarak "her" alt süreç (ör. kupon oluşturma, mesajlaşma, DAC7 raporlama gibi daha küçük akışlar) henüz diyagramlanmadı. Ek süreçler istenirse aynı yöntemle (kod tabanından gerçek akış çıkarılarak) eklenebilir.
