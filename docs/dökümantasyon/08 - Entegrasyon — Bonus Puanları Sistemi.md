**Bonus Puanları Sistemi**

*Platform Finansmanlı Müşteri Sadakat Puanları*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Amaç

Platform tarafından finanse edilen bir müşteri sadakat/bonus puan sistemidir. Kritik prensip: bonus puanların maliyeti SATICIYA yansıtılmaz — Andertal kendi cebinden karşılar. Bu, sistemin tüm muhasebe/fatura mantığının temelini oluşturur ve "Andertal Ecom Prod Imp" projesinin ("ChatGPT önerisi" olarak anılan bir dış taslağın Andertal koduna göre düzeltilmiş hali) merkezinde yer alır.

## 2. Temel Mekanik

| **Kural** | **Değer** |
| --- | --- |
| Puan → Euro dönüşümü | 50 puan = 1,00 € |
| Kazanma matrahı | Müşterinin GERÇEKTEN ÖDEDİĞİ tutar (bonus ve kupon düşüldükten sonraki net ödeme, kargo dahil) — "50€ ürün her zaman 1€ kazandırır" YANLIŞTIR; 50€ ürüne 1€ bonus kullanılırsa müşteri 49€ öder ve 49 puan kazanır, 50 değil. |
| Kazanma yuvarlama | Yukarı yuvarlama (ceil) — örn. 33,33€ ödeme → 34 puan. |
| Kullanma yuvarlama | Aşağı yuvarlama (floor) — puan/50×100 cent. |
| Hoş geldin bonusu | Yeni kayıt olan her müşteriye 100 puan (2,00€ değerinde). |
| Misafir (guest) sipariş | Puan kazanılmaz — sadece giriş yapmış müşteriler kazanır (kasıtlı, değiştirilmeyecek). |
| Minimum Stripe tutarı | Bonus, mal bedelini 0,50€'nun altına indiremez; tamamı bonus+kupon ile karşılanan siparişler ayrı bir "platform_loyalty" ödeme yolu kullanır (kart bilgisi istenmez). |

## 3. Doğru Nakit Akışı (Kritik Örnek)

50,00€'luk bir üründe 1,00€ (50 puan) bonus kullanılırsa:

| **Kalem** | **Tutar** |
| --- | --- |
| Mal bedeli (liste, satıcı brütü) | 50,00 € |
| Müşterinin kartla/PayPal ile ödediği | 49,00 € |
| Platform bonus finansmanı | 1,00 € |
| Platform komisyonu (%12, mal bedeli üzerinden) | −6,00 € |
| Satıcıya ödenen net (payout) | 44,00 € (= 50 − 6, bonus eklenmez) |
| Platformun eline geçen net nakit | 5,00 € (= 6 komisyon − 1 bonus maliyeti) |

YANLIŞ (ve dış taslağın yaptığı hata): satıcıya "50 − 6 + 1 = 45€" ödenmesi gerektiğini düşünmek — bu, aynı 1€'yu iki kez saymaktır. Doğrusu satıcı her zaman mal bedelinin komisyon sonrası netini alır (44€), bonusun kimin ödediği bu hesabı değiştirmez.

## 4. Üç Kademeli Fatura/Rapor Modeli (Aynı Euro'nun Üç Farklı Görünümü)

Sistemde ÜÇ ayrı belge/ekran seviyesi vardır ve her biri farklı bir kitleye, farklı bir toplama seviyesinde hitap eder — bunlar birbirine karıştırılmamalıdır:

| **Seviye** | **İçerik** | **Kim görür** |
| --- | --- | --- |
| 1. Sipariş Faturası (Verkaufsrechnung) | Tekil sipariş: mal + kargo, ödeme kaynağı (kart + Andertal bonus payı ayrı satır). KOMİSYON GÖSTERİLMEZ. | Satıcı + müşteri + superuser |
| 2. Provisionsrechnung (Komisyon Faturası) | Bir satıcının bir ödeme dönemindeki (15 günlük) satış toplamı, toplam bonus finansmanı, komisyon (net + KDV), ödenen net tutar. | İlgili satıcı + superuser |
| 3. Finanzamt / Platform Sekmesi | TÜM satıcıların bir dönemdeki toplamı — 2. seviyedeki tüm faturaların toplamıdır, ayrı bir hesaplama YAPILMAZ. | Yalnızca superuser |

Bu ayrım şu kritik hatayı önler: 10.000 sipariş × 1€ bonus asla "10.000€ ekstra gelir" olarak görünmemelidir — bu üç seviye aynı parayı farklı toplama derinliklerinde gösterir, çoğaltmaz.

## 5. Uygulama Durumu (Bölüm Bölüm)

| **Bölüm** | **Durum** |
| --- | --- |
| §1/§2/§3.10 — Temel hesap mantığı + ülkeye göre fiyat çapası doğrulaması | TAMAMLANDI — elle tek tek kontrol edildi, hesap hatası bulunmadı. |
| §3.1 — Settlement (hesaplaşma) alanlarının ayrıştırılması | TAMAMLANDI — bonus_redeemed_cents, coupon_discount_cents, platform_bonus_funding_cents, destination_country, mal KDV alanları ayrı ayrı API'de dönüyor. |
| §3.2 — Sipariş satırında bonus finansmanının kalıcı saklanması | TAMAMLANDI. |
| §3.3 — Ledger'ın değiştirilemez (immutable) + idempotent hale getirilmesi | TAMAMLANDI (bir alt-kısmı bilinçli olarak ertelendi). |
| §3.4 — Kısmi iadede oranlı puan geri alma | TAMAMLANDI. |
| §3.5 — Satış faturası ile komisyon faturasının birbirine karışmaması | TAMAMLANDI — mevcut goods-vat.js KDV motoruna dokunmadan, üzerine 2 gerçek hata düzeltildi. |
| §3.6 — Muhasebe dışa aktarma (export) — yeni "Accounting/Tax" kolon grubu | TAMAMLANDI — mevcut varsayılan kolonlar değişmedi, yeni grup opt-in (isteğe bağlı seçilebilir). |
| §3.7 — Superuser müşteri bakiye görünümü | TAMAMLANDI. |
| §3.8 — Billing sayfası (3 sekme: Sipariş belgeleri / Komisyon faturaları / Finanzamt) | KISMEN TAMAMLANDI — bilinçli kapsam sınırlaması: CANLI, zamanlanmış otomatik ödeme cron görevi (runAutomaticPayoutsIfDue) kasıtlı olarak DOKUNULMADAN bırakıldı, çünkü "çalışan ödeme sistemini kırma" kuralı en çok orada geçerlidir. |
| §3.9 — Analytics/Transactions sayfası | KISMEN TAMAMLANDI — dokümanın işaret ettiği somut hatalar düzeltildi ve eksik rakamlar zaten backend'de hazır olan veriden eklendi; sayfanın TAM yeniden tasarımı (kompakt tipografi, tablo şeması, mobil grid) YAPILMADI. |
| §3.11 — Otomatik testler | TAMAMLANDI — apps/medusa-backend/src/bonus-settlement.test.js. |
| Finanzamt Excel export (3 sayfa: Özet / Satıcı Bazlı / OSS Teslim Ülkesi) | TAMAMLANDI. |
| Transactions sayfası Excel export | TAMAMLANDI. |

## 6. Kasıtlı Olarak Yapılmayanlar / Ertelenmiş Riskler

- **Canlı, zamanlanmış otomatik ödeme cron görevine (`runAutomaticPayoutsIfDue`) kasıtlı olarak dokunulmadı** — "çalışan bir ödeme sistemini kırma" kuralı hiçbir yerde bu görevdeki kadar geçerli değildir; bonus puan düzeltmeleri bu göreve dokunmadan, onun ÜZERİNE inşa edildi.
- **Analytics/Transactions sayfasının tam yeniden tasarımı yapılmadı** — dokümanın işaret ettiği somut sayısal hatalar düzeltildi ve backend'de zaten hazır olan ama arayüze yansımamış rakamlar eklendi, ama sayfanın kompakt tipografi/tablo şeması/mobil grid ile baştan tasarlanması ayrı, yapılmamış bir iştir.
- **Ledger'ın (defter) immutable+idempotent hale getirilmesinin bir alt-kısmı bilinçli olarak ertelendi** — ana immutability/idempotency garantisi kuruldu, ama tüm kenar senaryolar (ör. çok nadir görülen yarış durumları) için ek sertleştirme gelecek işe bırakıldı.
- **Finansmanı platformun karşıladığı ilkesi hiçbir noktada gevşetilmedi** — bonus puan maliyetinin satıcıya yansıtıldığı hiçbir kod yolu yoktur; bu, sistemin en temel, asla ihlal edilmemesi gereken kuralı olarak kabul edilir.
