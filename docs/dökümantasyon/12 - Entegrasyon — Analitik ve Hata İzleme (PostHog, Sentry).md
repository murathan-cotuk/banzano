**Analitik ve Hata İzleme**

*PostHog (Kullanıcı Analitiği) & Sentry (Hata İzleme)*

Andertal Marketplace — Teknik Dokümantasyon · 2026-09-08

## 1. Amaç

Ürün kullanım analitiği ve ön-uç (frontend) hata izleme için iki ayrı üçüncü parti servis kullanılır: PostHog (kullanıcı davranış analitiği) ve Sentry (hata/performans izleme).

## 2. PostHog — Kullanıcı Davranış Analitiği

Sayfa görüntüleme (pageview) ve olay (event) takibi için kullanılır — hangi ürünlerin görüntülendiği, sepete eklendiği, satın alındığı gibi standart e-ticaret huni (funnel) analitiği sağlar. `PostHogProvider.jsx` bilinçli olarak tembel (lazy) yüklenir; ana sayfa yükleme performansını (LCP) etkilememesi için ilk render'ı bloklamaz — bu, Bölüm 1'de bahsedilen performans çalışmasında zaten doğru bulunup dokunulmamış bir parçadır.

## 3. Sentry — Hata ve Performans İzleme

Ön-uçtaki (frontend) JavaScript hatalarını ve performans izlerini (trace) yakalar. `instrumentation-client.js` içinde başlatılır; hata raporları reklam engelleyicilerin (ad-blocker) doğrudan `sentry.io`'ya giden istekleri engellemesini aşmak için kendi domaininden bir "tunnel" rotasına (`/monitoring`) yönlendirilir. Performans izleme oranı (`tracesSampleRate`) performans çalışması sırasında 1.0'dan (her isteğin izlenmesi) 0.1'e (isteklerin %10'u) düşürülmüştür — tam izleme, ekstra ağ/CPU yükü nedeniyle sayfa performansını ölçülebilir şekilde etkiliyordu; `replayIntegration()` (oturum tekrar oynatma) hâlâ etkindir.

## 4. Kapsam Notu

Bu iki servis şu an yalnızca Shop (apps/shop) uygulamasında doğrulanmıştır. SellerCentral, Affiliate Portal ve Developer Platform uygulamalarında aynı entegrasyonların olup olmadığı bu doküman kapsamında ayrıca doğrulanmamıştır — genişletme gerekiyorsa her uygulama için ayrı ayrı kontrol edilmelidir.
