**Uyumluluk Motoru**

*GPSR · WEEE · EPREL · DAC7 — apps/medusa-backend/src/compliance*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Amaç ve Problem Tanımı

Andertal, AB genelinde farklı ürün tiplerinin (elektronik, kozmetik, gıda, oyuncak, kimyasal vb.) her biri için farklı yasal bildirim yükümlülüğü (GPSR, WEEE, EPREL, Batarya Yönetmeliği, REACH, Kozmetik Yönetmeliği vb.) taşıyan çok kategorili bir pazaryeridir. Sistemin başlangıcında TÜM ürünlere aynı 3 GPSR alanı zorunlu kılınıyordu (kitaba da elektroniğe de aynı kural) — bu hem yanlış ölçekte hem de kategori bazlı ayrım yapmıyordu. "Uyumluluk Profili" (Compliance Profile) sistemi bu sorunu çözmek için inşa edilmiştir: her kategoriye bir profil atanır, her profil hangi alanların zorunlu olduğunu tanımlar, ülkeye özel ek katmanlar (Almanya için LUCID/Pfand, Fransa için Triman/Nutri-Score vb.) ayrı bir "overlay" olarak üstüne eklenir.

## 2. Üç Katmanlı Model

| **Katman** | **Örnek** |
| --- | --- |
| 1. compliance_profile (ürün tipi) | CE, WEEE, EPREL, kozmetik, gıda, oyuncak, kimyasal, tekstil... |
| 2. marketplace overlay (hedef ülke) | Almanca etiket zorunluluğu, Fransa'da Triman etiketi, İtalya'da RAEE kaydı... |
| 3. brand_authorization (marka) | Marka için fatura/yetki belgesi, superuser onayı. |

Bu üç katmanlı yaklaşım, "24.000 kategori × 27 ülke × 50 sertifika" gibi yönetilemez bir kombinasyon matrisi yazmak yerine ~15 profil + 9 ülke overlay'i ile kapsamı yönetilebilir kılar; her kategori bir profile atanır ve alt kategoriler üst kategoriden bu profili miras alır (inheritance).

## 3. Tanımlanmış 15 Uyumluluk Profili

general_consumer_gpsr, electronics_weee, energy_labeled_eprel, battery_containing, cosmetics, food, food_supplement, toys, textiles, chemicals_reach, books_media, digital_goods, nicotine_tpd, medical_device (yalnızca superuser onayıyla yayınlanabilir — pazaryerinde yüksek riskli kabul edilir), ce_marked_general.

9 pazaryeri (marketplace) overlay'i tanımlıdır: EU (genel), DE, FR, IT, ES, AT, NL, PL, SE. Ulusal kayıt alanları KOŞULLUDUR — örneğin weee_number_fr yalnızca ürünün profili zaten WEEE gerektiriyorsa istenir (bir kitaptan asla WEEE numarası istenmez).

## 4. Gerçek Uygulama Durumu (2026-09 itibarıyla) — Faz Faz

| **Faz** | **Durum** |
| --- | --- |
| Faz 1 — Veri modeli + atama motoru | TAMAMLANDI ve GERÇEK VERİYE UYGULANDI. Tüm 12.337 kategoriye compliance_profile_id atanmış ve doğrulanmıştır (production veritabanından tekrar okunarak 12.337/12.337 doğrulandı). Dağılım: general_consumer_gpsr 4059, books_media 3175, electronics_weee 949, food 938, toys 752, textiles 685, ce_marked_general 561, cosmetics 425, chemicals_reach 385, energy_labeled_eprel 141, food_supplement 139, battery_containing 91, medical_device 24, nicotine_tpd 8, digital_goods 5. Bu atama anahtar-kelime eşleştirmesiyle yapılmıştır, %100 kesinlik iddia edilmez — CSV tabanlı manuel override mekanizması ile düzeltilebilir. |
| Faz 2 — Backend doğrulama | BİLİNÇLİ OLARAK "engellemeyen" (non-blocking) modda açıktır. Eski sabit GPSR kontrolü hâlâ TÜM ürünlerde koşulsuz olarak çalışmaya devam ediyor (değiştirilmedi — risk alınmadı). Bunun YANINDA, her ürün kaydından sonra arka planda (isteğe hiç etki etmeden) bir "needs_compliance_review" damgası hesaplanıp metadata'ya yazılıyor. Bu damga hiçbir ürünü ASLA engellemez, sadece superuser'ın görmesi için bir işarettir. |
| Faz 3 — SellerCentral arayüzü | TAMAMLANDI. ComplianceFieldsSection.jsx bileşeni, ürünün kategorisine göre kategoriye özel EK alanları dinamik olarak gösterir (sabit GPSR/WEEE/EPREL blokları kasıtlı olarak korunmuştur, kaldırılmamıştır). Ayrıca superuser'a özel iki sayfa vardır: Compliance Review (hangi ürünlerin hangi eksik alanları var, kuyruk halinde) ve Compliance Profiles (kategori bazında profil override — bir kategorinin otomatik atanan profili yanlışsa superuser tek tek düzeltebilir). |
| Faz 4 — Shop gösterimi | TAMAMLANDI. Ürün sayfasında sadece dolu olan uyumluluk alanları gösterilir; URL formatındaki değerler (ör. CE beyanı, güvenlik veri formu) tıklanabilir "Dokument ansehen" linkine dönüştürülür. Daha önce bir hata nedeniyle WEEE/EPREL numaraları hem özel kutuda hem genel özellik tablosunda iki kez görünüyordu — bu düzeltilmiştir. |

## 5. Bilinçli Olarak Yapılmayanlar (Gelecek İş, Risk Nedeniyle Ertelendi)

- **Sert GPSR gate'e geçiş** — Faz 2'deki sabit, koşulsuz GPSR kontrolünün "yalnızca profil gerektiriyorsa" mantığına çevrilmesi kasıtlı olarak yapılmadı. Gerekçe: kategori→profil ataması anahtar-kelime tabanlı ve %100 kesin değil (~%33 kategori genel GPSR'a düştü); bunu şimdi sert bir engelleme kapısına çevirmek, yanlış atanmış bir kategorideki satıcıyı haksız yere ürün yayınlamaktan alıkoyabilir. Önerilen sıra: önce kategori ataması CSV override ile kademeli düzeltilmeli, sonra superuser bir süre `compliance_review` verisini gözlemleyip güvenmeli, ancak ondan sonra sert gate'e geçilmeli.
- **DE/AT için Almanca etiket dili uyarısı** — 2026-09-08'de eklendi (ComplianceFieldsSection.jsx'te bir bilgi banner'ı olarak); sistem bunu henüz zorunlu bir doğrulama olarak DEĞİL, yalnızca bir hatırlatma olarak gösteriyor.
- **2. satıcı aynı EAN'e ürün eklerken GPSR'ı tekrar girmek zorunda kalması** — 2026-09-08'de kod incelemesiyle bunun ARTIK bir sorun olmadığı doğrulandı: ikinci satıcının eklemesi ayrı bir ürün değil, mevcut ürüne bağlı yeni bir `admin_hub_seller_listings` satırı oluşturuyor; GPSR merkezi üründe durduğu için bu akış GPSR kontrolünden hiç geçmiyor.
- **Excel toplu import için ayrı bir uyumluluk kontrolü yazılmadı** — gerek yok: import, ürünleri aynı `POST`/`PUT /admin-hub/products` uçlarına gönderiyor, bu da manuel kayıtla aynı arka plan `compliance_review` damgalamasından otomatik olarak geçiyor.
- **EPREL numarası tıklanabilir bir derin linke dönüştürülmedi** — resmi EPREL URL formatı kategoriye göre değiştiği ve güvenilir şekilde doğrulanamadığı için, yanlış link riski almamak adına düz metin olarak bırakıldı.
- **docs/COMPLIANCE.md** artık yazılmış durumda (2026-09-08) — 15 profilin tablosu, 9 overlay, kod haritası ve bu bölümdeki kararların gerekçeleri orada da tekrarlanır.

## 6. DAC7 / §12 PStTG (Platform Vergi Şeffaflık Kanunu)

SellerCentral'da Settings → DAC7 sayfası, Almanya'nın Platform Vergi Şeffaflık Kanunu (§12 PStTG, AB'nin DAC7 direktifinin ulusal uygulaması) kapsamında satıcı gelirlerinin vergi dairesine bildirilmesi zorunluluğunu açıklayan kısa bir rehber (nedir, kimi ilgilendirir, ne zaman, adımlar, sistemin ne YAPMADIĞI) ve bir raporlama aracı içerir. Affiliate sisteminde de aynı ilke geçerlidir: yıllık 600€ üstü kazanan affiliate'lerden tam KYC + vergi kimlik numarası istenmesi planlanmıştır (bkz. Affiliate Platform dokümanı) — bu kısım henüz bir dosya yükleme arayüzüyle desteklenmemektedir.

## 7. Yasal Sorumluluk Uyarısı

Bu doküman ve sistemin kendisi bir HUKUKİ TAVSİYE DEĞİLDİR. compliance-profiles.json ve marketplace-overlays.json dosyalarının kendi içinde de aynı uyarı (legal_disclaimer) yer alır: canlıya alınmadan önce bir avukat veya onaylı uyumluluk danışmanı ile doğrulanması gerektiği açıkça belirtilmiştir.
