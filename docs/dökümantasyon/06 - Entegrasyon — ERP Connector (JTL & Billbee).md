**ERP Connector — JTL & Billbee**

*apps/medusa-backend/src/connectors — Satıcı ERP Entegrasyon Katmanı*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Amaç

Satıcıların kendi ERP/stok yönetim yazılımlarını (JTL-Wawi, Billbee ve ileride Xentral, Plentymarkets, Shopware vb.) Andertal ile bağlayarak ürün, stok ve sipariş verisini otomatik senkronize edebilmesini sağlayan katmandır. Amaç: satıcı JTL veya Billbee'yi seçsin, birkaç dakikada bağlansın; ürünler ERP'den Andertal'a, siparişler Andertal'dan ERP'ye, stok ise ÇİFT YÖNLÜ aksın.

## 2. Mimari Prensip

"Kanonik model + adaptör" deseni: her ERP kendi API'sinin garipliklerini bir "mapper" dosyasında çözer (ör. `billbee-to-canonical.js`), ama sonuçta hepsi AYNI ara-format'a (`canonical-product.js`, `canonical-order.js`) çevrilir. Andertal'ın geri kalan kodu (uyumluluk motoru, ürün kaydı, sipariş işleme) yalnızca bu kanonik modelle konuşur, hangi ERP'den geldiğini bilmesi gerekmez. Yeni bir ERP eklemek (ör. Xentral) yalnızca yeni bir mapper + `connector-interface.js`'i uygulayan bir sınıf yazmak anlamına gelir; kanonik modelin ya da onu tüketen koda dokunmak gerekmez.

## 3. Mevcut Durum (2026-09 itibarıyla) — Gerçek İlerleme

| **Bileşen** | **Durum** |
| --- | --- |
| Kanonik model (canonical-product.js, canonical-order.js) | Hazır. |
| Connector arayüzü + kayıt defteri (connector-interface.js, registry.js) | Hazır. |
| Billbee → kanonik model çevirici (mappers/billbee-to-canonical.js) | Hazır. |
| Billbee'nin kendi API sarmalayıcısı (mevcut billbee-marketplace-api.js + integrations.js) | Zaten üretimde çalışıyordu, connector katmanına bağlanacak. |
| Billbee sipariş güncelleme webhook'u | HENÜZ GERÇEK İŞLEV YOK — şu an sadece boş bir "204 No Content" cevabı dönüyor, gerçek işleme mantığı yazılmadı. |
| JTL SCX kimlik doğrulama modülü (auth.js, token cache) | YOK. |
| JTL SCX event poller (Seller:Offer.New/Update dinleyicisi) | YOK. |
| JTL metadata bootstrap (kategori/özellik eşleme) | YOK. |
| JTL sign-up / update rota'ları | YOK. |
| Veritabanı tabloları (admin_hub_erp_connections, admin_hub_erp_sync_state, admin_hub_erp_external_map, admin_hub_erp_sync_log) | HENÜZ OLUŞTURULMADI. |
| SellerCentral "ERP Bağla" sayfası (Settings/Integrations altında planlanan) | YOK. |
| Uyumluluk Motoru bağlantısı (canonical → validateProductCompliance()) | Motor (resolve-compliance.js) zaten var ve kullanılabilir durumda, connector'a henüz kablolanmadı. |

## 4. JTL Entegrasyonunun Doğru Modeli

JTL için kullanıcı adı/şifre YOKTUR — bu yaygın bir yanlış varsayımdır. Doğru model "SCX Channel API"dir: satıcı kendi JTL-Wawi'sinde Platforms → Andertal → Connect yolunu izler, bu bir "sign-up URL" + oturum kimliği (sessionId) üretir; Andertal bu oturumu sellercentral üzerinden tamamlar. Bağlantı kurulduktan sonra veri akışı bir "event poller" (belirli aralıklarla JTL'nin event kuyruğunu kontrol eden bir görev, ör. her 60 saniyede bir) ile sağlanır — webhook değil, polling modeli kullanılır (JTL webhook desteği ileride eklenebilir).

Ortam değişkenleri (gizli anahtarlar HARİÇ, sadece isimler): JTL_SCX_CHANNEL_REFRESH_TOKEN, JTL_SCX_API_BASE (sandbox: scx-sbx.api.jtl-software.com, üretim: scx.api.jtl-software.com), JTL_SCX_CHANNEL_ID.

ÖNEMLİ GÜVENLİK NOTU: JTL'den alınan görsel URL'leri 7 gün sonra süresi dolan (expire) geçici linklerdir — bu görsellerin Andertal'ın kendi medya deposuna kopyalanması gerekir, aksi halde ürün görselleri bir hafta sonra kırılır.

## 5. Yapılması Gerekenler (Kod Dışı, Kullanıcı Aksiyonu)

- **JTL Partner Portal'dan bir sandbox token istenmesi** — bu talep gönderildi (2026-09), JTL'den yanıt bekleniyor; erişim bilgileri gelmeden JTL tarafı kodlanamaz/test edilemez.
- Token geldiğinde: Render'a `JTL_SCX_CHANNEL_REFRESH_TOKEN` / `JTL_SCX_API_BASE` / `JTL_SCX_CHANNEL_ID` ortam değişkenlerinin eklenmesi.
- JTL Partner Portal'da sign-up/update URL'lerinin tanımlanması.
- Mümkünse Windows üzerinde JTL-Wawi kurulup gerçek bir satıcı akışının uçtan uca test edilmesi.
- Bu adımlar tamamlanmadan Bölüm 3'teki "YOK" olarak işaretli JTL bileşenleri (auth, event poller, metadata bootstrap, sign-up rotaları, ilgili DB tabloları, SellerCentral "ERP Bağla" sayfası) kodlanamaz — hepsi gerçek bir sandbox ortamına karşı geliştirilmesi gereken parçalardır.

## 6. GÜVENLİK UYARISI — Bu Doküman Hazırlanırken Tespit Edildi

docs/CONNECTOR.md dosyasının en altında, planlama notları arasında GERÇEK bir JTL Client ID ve Client Secret (Geheimer Schlüssel) açık metin olarak bulunmaktadır ve bu dosya Git geçmişine (en az iki "update" commit'i ile) işlenmiştir. Bu doküman ve tüm türevleri bu bilgiyi TEKRARLAMAMAKTADIR. Ancak repo'ya erişimi olan herkes (veya repo'nun geçmişte paylaşıldığı herhangi biri) bu anahtarı görebilir. Önerilen aksiyon: JTL Partner Portal üzerinden bu Client Secret'ın en kısa sürede iptal edilip yenisinin üretilmesi ve yeni anahtarın SADECE Render'ın ortam değişkenlerine (asla bir .md dosyasına) girilmesi.
