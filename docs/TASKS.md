1) ✅ Yapıldı — Shopta product card ve product sayfasinda üründe indirim var ise yaninda indirim yüzdesinin göründügü bi balon aciliyor. kirmizi olmali o balon. ürün fiyati cizili olacak indirim fiyati kirmizi olacak.


7) ✅ Yapıldı (düzeltme 2026-08-12) — Marken `/brands`: CMS `brands_directory` (eski boş `seller_carousel` artık aynı Marken-Raster’ı boyar) = arama + A–Z + 5×10 kart grid. Content→Pages Seiteninhalt (richtext) `CatalogCmsLanding` içinde her zaman container’ların EN ALTINDA.


10) ✅ Yapıldı — Lieferscheinda faturada siparisler sayfasinda ve emaillerde ürün isminin yaninda varyasyonlar parantez icinde gözükmesin. yine yaninda alsin ancak daha acik renkli ufak puntoda not seklinde düssün
11) ✅ Yapıldı — bi sipariste sendungsnummer yok henüz. lieferschein drucken diyorum sendungsnummer cikiyor. sacma :D sendungsnummer tek satira sigmali ve logo tam ortada o kadar büyük görünmemeli evraklarda.


14) ✅ Yapıldı — yeni acilan seller hesaplari neden to-do listte bu sayfaya yönlendiriliyor?: settings/stripe-connect sellerlarin stripe ile yapacaklari bir sey yok hatta bir sey yapamamalilar. erisememeliler.
15) ✅ Yapıldı — sellercentralde settings sayfasinda soldaki menülerden de yalnizca superuser in görebildiklerini kirmizi yap.
16) ✅ Yapıldı (izolasyon zaten güvenliydi, sadece amaç etiketleri eklendi) — settings/locations sayfasindaki icerikler her seller in kendine özel olacak. baska sellerlar göremeyecek. add location dendiginde ya da mevcut location düzenlenmek istendiginde o adresin ne amacla kullanilacagi secilebilsin. Siparislerin kargolandigi adres, iadelerin gelecegi adres, fatura adresi vs ayri ayri secilebilsin. bir adrese her biri tanimlanabilsin ancak tercihe göre her biri icin ayri bir adres de belirlenebilir.
17) ✅ Yapıldı — DAC7 / § 12 PStTG sayfasına kısa kılavuz eklendi (nedir, kim, ne zaman, adımlar, ne yapmaz) + rapor aracı aynı kaldı.
18) ✅ Yapıldı — settings/general sayfasinda kendini tekrar eden bölümler var. mesela iki defa adres giriliyor, iki defa sirket bilgileri giriliyor falan. burada da iban yazma kismi var falan. iban baska yerden yaziliyor ama... düzenle burayi.
19) ✅ Yapıldı — settings/security sayfasinda konto seit kismi bos. doldur. yeni sifre belirleme kisminda yazilanlari gösterme butonu ekle.
20) ✅ Yapıldı — settings/payments sayfasinda So funktionieren Auszahlungen altinda Auszahlung (88%) yaziyor. 88% neden var? kaldir. kafa karismasin.
21) ✅ Yapıldı (DE/NL/ES zaten varsayılan açık, ürün sayısı gösteriliyor) — settings/shipping sayfasinda Länder bölümü var. orada ülkelere satislarin acik mi olacagini kapali mi olacagini ayarlayabiliyoruz. anack orada yalnizca müsterilerin girdigi ülkeler görünüyor. tüm ülkeler gözükmeli. Lieferländer auswählen bölümünde gözüktügü gibi olmali ve yaninda acip kapama olmali. sen bunu ayarla ve simdilik almanya, hollanda, ispanya sec. yanlarinda o ülke icin kac ürün secildigi var. onlari daha detayli göstermeyi unutma.
22) ✅ Yapıldı — pricing/SEO/metafield/varyasyon UX + VariantEditPage alanları + GPSR varyant kilidi tamamdı. Ayrı ürünleri tek parent altında birleştirme: Inventory’de 2+ seç → Combine as variants; POST /admin-hub/v1/products/combine-as-variants (kaynaklar status=merged).
23) ✅ Yapıldı — Ürün/sipariş küçük resimleri + hover + shop linki tamamlandı. ActionMenu Polaris Popover/ActionList; ManualOrderModal Polaris Modal + TextField/Select.
24) ✅ Yapıldı — kök neden: login durumuyla ilgisi yoktu (kategori listesinde hiç auth kontrolü yoktu). Kategoriler tek seferlik bir fetch ile geliyor; menüyü sayfa yüklenir yüklenmez açarsan (ya da fetch başarısız olursa) kategori bölümü DOM'dan tamamen kayboluyordu, geriye sadece hesap bölümü (login iken "Mein Konto", logout iken "Anmelden/Registrieren") kalıyordu — bu da login'e bağlıymış gibi görünüyordu. Şimdi fetch tamamlanana kadar kategori bölümü placeholder (shimmer) gösteriyor, kaybolmuyor. Merkzettel notu: gerçek bir guest-wishlist yok, gördüğün şey login'e yönlendirmeden önceki tek karelik "boş liste" anı (FOUC), ayrı bir konu. — mobilde soldan sidebar kategoriler gelsin diye altaki menü butonuna basiyorum ancak anmelden registrieren diyor. orada menü itemler gözükmeliydi. BOZMA BIR SEYI. Login olunca gözüküyor ancak logoutken de göözükmeli. login olmamis biri nasil merkzettel görebiliyor onu tam anlamadim ben :D

25) Satıcılar için zorunlu: Gebühren (platform ücretleri) için kredi kartı ekleme + Auszahlung (ödeme) için IBAN ekleme. İkisi de mutlaka girilmeli; eksikse onboarding/to-do ve ilgili settings (payments / billing) net uyarmalı, satışa açılmadan tamamlanmış sayılmamalı.

26) settings/shipping’den Retouren adresi bölümü kaldırılacak (kaldırıldı). Retoure / Lager / Fatura adresleri yalnızca settings/locations (Standorte) üzerinden girilir ve zorunludur; locations değerleri esas alınır. Zorunlu kurulum kalemleri (Standorte 3 amaç + kredi kartı + IBAN) seller detay sayfasından kontrol edilebilir olmalı.

27) products/... ürünün icine girilmis sayfa hic güzel durmuyo ya sellercentralde. yani cok daginik. cok savruk, cok amatörce duruyor. buradaki bilgi girme alanlarini tablere ayirsak daha iyi olur gibi düsünüyorum. detayli bir calisma yapman gerekecek ve HICBIR SEYI bozmaman gerekecek. ben sana aklima gelen önerileri yapicam sen de en mükemmel nasil olursa önerilerimi ciddiye alip en iyi bildigin metodu harmanlayarak yeni bir ürün sayfasi kuracaksin. Her dil icin gerekli menü ayarlamalarini, icerigibi vs ayarlayacaksin. related products, sales, type, kismini sellerlar göremesin mesela. alt alta dizilen basliklarin arasinda cok bosluk olmasin, kompakt olsun. yazi tipi puntosu cok büyük su an. biraz kücült ki daha fazla icerik görünsün. en üstte yan yana bu tabler olacak:

- Allgemein, Spezifikationen, Variante, Rechtlich yada her ne ise ismi (TÜM hukuki gereklilikler burada olacak GPSR, WEEE, Eprel cart curt vs sen biliyorsun)

Allgemein: sagdaki status ile baslayan bar olacak. solda ise ürün adi, altinda sku ean, altinda beschreibung, altinda shop assignment icindeki menüler olacak ancak onlari ausklappen seklinde yapmayalim. dümdüz her zaman görünür olsun bunun icindeki bilgiler. Fiyat bölümü gelecek sonra. Verkaufspreis, indirim fiyati, uvp gözükecek. Altina stok girme bölümü, minimum order quantity bölümleri eklenecek. altina görseller eklenecek. 

Spezifikationen: Maße & Verpackung kismi (Breite, höhe, lönge, gewicht, verkaufseinheit, maßeinheit, verpackungseinheit, verpackungseinheit mehrzahl, grundeinheit) buraya tasinacak ve genisletilecek. Unit vs girdigimiz bölümde burada olacak parentez icinde gördügün üzere. altindaeigenschaften olacak. yani önceden metadata diye belirledigimiz kisim. burada bi arama cubugu olacak yaninda eigenschaft suchen butonu olacak. girilen metadatalar buradan secilip icleri doldurulabilecek. eklenmis eigenschaftenleri secebilecekler. ancak istedikleri yok ise yeni eigenschaften ekleme önderisinde bulunmaya devam edebilecekler. (Superusera bunun bildirimi kesinlikle gitmeli)

Variante: iste o tüm varyasyon olusturma kismini buradak yapacagiz. sellerlar varyasyon option basligi olarak bizim metadata adini verdigimiz kisimdan, yani metaobjects sayfasindan ekledigimiz metaobfectlerden secim yapabilecek. mesela metaobjects sayfasinda anzeigename Farbe var. bu varyasyon opsiyonu olarak eklenecek. sonra altina bu metanin icindeki degerlerden secebilecek. swatch image kendi ayarlayabilecek, varyasyonlar burada alt alta gösterilecek, yaninda kalem olacak basildiginda icine girilebilecek, "Variante" tab'i haric parent artikelde olan tabler burada da gözükecek, parent artikelde yazilan degerin aynisinin kabul görmesini istemeleri halinda her bir deger girme bölümünün yaninda cengel iconu olacak. cengel iconu secili ise parent a girilen degerin aynisi yer alacak orada ve o bölüm kilitlenecek cengel oldugu icin. mesela bir varian icindeyiz ve beschreibun kismindayiz. ama parenta zaten yazmisim ve onun kullanilmasini istiyorum. o halde cengele basicam, parent icine yazilmis degerler ile otomatik doldurulacak orasi, rengi biraz grilesecek o bölümün ve icine tiklanamaz olacak cünkü kilitledik. kilit kaldirildiginda o degerler yine orada kalacaklar ancak düzenlenebilecekler. yani o kilit aslinda direkt copy paste yapiyor ancak kilit kaldirildiginda delete yapmiyor.

Rechtlich: önceden de belirttigim gibi bu kisimdan nefret ediyorum. hukuki olarak gereken ne var ise burada olacak. sik gibi bir bölüm. baska seylerle karistirmaya gerek yok abi.

haydi bu düzenlemeleri adim adim detaylica yap. HICBIR SEYI BOZMA!!! DÜZENLE VE YENIDEN KUR ANCAK FONKSIYONLARI SAKIN BOZMA!!!

---

## Docs klasöründeki dış görevler — SENİN yapman gerekenler (2026-09-05 taranan)

Aşağıdakiler kod tarafında yapılamaz — hesap/panel erişimi, domain/ödeme kararı ya da fiziksel test gerektiriyor.

- [ ] **Performans (Redis doğrulama):** Render dashboard → `REDIS_URL` tanımlı mı ve loglarda "Redis connected" var mı bak. Sonra `curl -w "%{time_total}"` ile aynı isteği 2 kere at, ikincisi hızlı mı (Redis'ten) kontrol et.
- [ ] **Developer Platform yayına alma:** Vercel'de `apps/developer` için proje oluştur → domain `developer.andertal.com`. Render'a `DEVELOPER_JWT_SECRET`, `CORS_ORIGINS`'e `developer.andertal.com`, `APP_PLATFORM_AUTO_APPROVE=true`, `SUPERUSER_EMAILS` ekle.
- [ ] **JTL Connector (Connector projesi için ön koşul):** JTL Partner Portal'dan sandbox token iste. Token gelince Render'a `JTL_SCX_CHANNEL_REFRESH_TOKEN` / `JTL_SCX_API_BASE` / `JTL_SCX_CHANNEL_ID` ekle, Partner Portal'da sign-up/update URL'lerini tanımla. Mümkünse Windows'ta JTL-Wawi kurup gerçek satıcı akışını test et.
- [ ] **Affiliate programı — domain kararı:** Yeni bir domain gerekiyor (ör. `affiliate.andertal.com`). Kod tarafı hiç başlamadı (0%) — domain/isim kararını verirsen inşaya başlanabilir.
- [ ] **Bonuspunkte backfill onayı:** `scripts/backfill-platform-bonus-funding.js` canlı DB'ye karşı hazır ama hiç çalıştırılmadı (production veri değişikliği içeriyor) — önce `--dry-run`, sonra gerçek çalıştırma için onayın gerekiyor.

## Docs klasöründeki iç görevler — kod tarafında yapılacaklar (bana ait, öncelik sırasıyla soracağım)

- **BRAND.md:** ✅ Kontrol edildi — zaten yapılmış. Onay ekranı ayrı sayfa değil, `BrandPage.jsx` içine gömülü ("Pending Authorizations" kartı, sadece superuser'a görünüyor, `/content/brands`'te). Yanlış alarm.
- **HUKUKI.md:** ✅ Kısmen ilerletildi (2026-09-05) — superuser inceleme kuyruğu (`content/compliance-review`) + kategori bazlı profil override sayfası (`content/compliance-profiles` — bir kategorinin otomatik atanan profili yanlışsa tek tek düzeltilebiliyor, alt kategoriler üst kategoriden bağımsız kendi profiline sahip olabiliyor) kuruldu. Kalan: sabit GPSR kontrolü hâlâ profile-bazlı değil (bilinçli, henüz güvenli değil), Excel-import uyumluluk kontrolü yok, `docs/COMPLIANCE.md` yazılmadı.
- **SUPPORT-LANDING:** ✅ Gerçek eksikler kapatıldı (2026-09-05) — 3 yeni container tipi (support_order_picker, support_help_cards, support_help_library) artık shop'ta gerçekten render oluyor (önceden sadece DB'deydi, ekranda HİÇ görünmüyorlardı — canlı bug'dı); backend sanitize whitelist'i bu 3 tip + recursive `children[]` nesting (derinlik 3, toplam 200 sınırı) ile güncellendi; sunucu başlangıç kancası (`ensureCustomerSupportLanding`) server.js'e bağlandı; eksik npm script'leri (`test:customer-support-landing`, `smoke:customer-support-landing`) eklendi ve ana `test` script'ine dahil edildi. Tüm testler (9/9 yeni + 53/53 toplam) ve smoke test geçiyor. Sellercentral editöründe tam ağaç/nesting UI'ı (STEP1'in Adım 2 kısmı) henüz yok — o ayrı, büyük bir iş.
- **Connector (JTL):** Canonical model + Billbee mapper + DB tabloları var ama JTL SCX auth/event-poller/mapper ve sellercentral "ERP bağla" sayfası hiç yok.
- **Developer Platform:** Kod (PR1-4) tamam, sadece deploy/env eksik (yukarıdaki dış görev).
- **Affiliate:** Domain kararından sonra sıfırdan inşa (en son öncelik, idealo'dan bile sonra değil ama idealo listenin en sonunda kalacak şekilde sıralayacağım).
- **Idealo:** En sona bırakıldı, sadece yol haritası var, hiç kod yok.

- Sellercentralde /help sayfasi her dile göre uyarlanmamis.

101) Andertale dair yapılmış bütün geliştirmelerin analiz edilip dokümante et. Bu bildiğimiz word dosyalarından oluşacak, her webservis için ayrı word dosyası açılıp her bir alan için ne iş yaptığı anlatılacak. Her bir entegrasyon için ayrı ayrı ne iş yaptığı anlatılacak. dökümantasyon klasörü. icinde olustur tüm wordleri.

102) Bütün süreçlerin business process model and notation edilerek diyagramların çiz. Bu ise microsoft visio, bizagi vb. uygulamalar ile iş akış diyagramları çizilecek. Process model klasörü icinde olustur. 