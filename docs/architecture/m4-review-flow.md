# M4A — İnceleme API'si ve karar tutarlılığı

## Kapsam ve üç ayrı durum

Bu aşama backend/shared sözleşmeleridir. M4B ekranı, M4C harita adaptörü ve gerçek
üretim kimlik sistemi uygulanmaz. Video `event.reviewStatus` içerik için kanonik
kaynaktır. Candidate içindeki orijinal `candidate.reviewStatus=pending` snapshot
olarak kalır. Zarfın `reviewDecision` alanı aday konum onayı/ret yolunun sonucudur;
güncel video içerik kararı yerine kullanılmamalıdır. Videosuz adaylarda içerik
kararı zarfından okunur. Reviewer DTO bunları birleştirir:

| Alan | Anlam |
| --- | --- |
| reviewStatus | pending / approved / rejected içerik kararı |
| locationStatus | UNKNOWN / ESTIMATED / VERIFIED hasar konumu |
| verifiedDamage | İnsan onaylı, kanıt ve yöntem koşullarını sağlayan ayrı kayıt |
| reviewRevision | Bu event veya videosuz aday için kayıtlı yeni audit revision'ı |
| reviewScope | Son kayıtlı audit CONTENT veya LOCATION; yalnız audit varsa |

Bakım sürecindeki `new/in_review/resolved` bu DTO değildir. İçerik onayı konum,
bakım tamamlanması veya gerçek model çıktısı anlamına gelmez. TEST_SYNTHETIC etiketi
insan onayından sonra da korunur.

## Uçlar ve sentetik örnek

Tüm özel isteklerde bearer kimliği başlıktadır. Aşağıdaki ID ve zamanlar sentetiktir;
credential örneği verilmez. Kimlikler frontend kaynaklarına veya kalıcı depolamaya
konulmaz. Mevcut REPLAY analiz principal'ı reviewer değildir.

```http
GET /v1/review/sessions?environment=TEST&sourceDomain=REPLAY&limit=25
GET /v1/review/sessions/demo-session/runs/demo-run/candidates?status=pending
GET /v1/review/sessions/demo-session/runs/demo-run/evidence/demo-frame
GET /v1/review/map-damages?layer=production
```

İlk iki uç `environment/items/nextCursor` zarfı döner. Aday öğesi örneği:

```json
{
  "contractVersion": 2,
  "sessionId": "demo-session",
  "runId": "demo-run",
  "sourceDomain": "REPLAY",
  "environment": "TEST",
  "detectorKind": "TEST",
  "resultOrigin": "TEST_SYNTHETIC",
  "modelVersion": "synthetic-v1",
  "classMapVersion": "synthetic-map-v1",
  "candidateId": "demo-candidate",
  "eventId": "demo-event",
  "videoId": "demo-video",
  "recordingOrigin": "UNKNOWN",
  "frameId": "demo-frame",
  "canonicalClass": "pothole",
  "videoTimestampMs": 1001.001001001001,
  "confidence": 0.75,
  "reviewStatus": "pending",
  "reviewRevision": 0,
  "locationStatus": "UNKNOWN",
  "observationIds": ["demo-observation"],
  "observationCount": 1,
  "frameCount": 1,
  "referencesTruncated": false,
  "evidence": [{"frameId":"demo-frame","width":16,"height":16,"available":true,"mime":"image/png","videoTimestampMs":1001.001001001001}]
}
```

Kaynak dosya yolu, medya adı, token, video byte'ları ve owner bilgisi taşınmaz.
Gerçek audit yokken reviewerId/reviewedAt/reviewScope alanları atlanır; null veya
uydurma tarih kullanılmaz. Yeni karar sonrası gerçek sunucu UTC zamanı, actor ve
revision döner. Eski terminal kayıtlar audit olmadan revision 0 ile geçerlidir.
Son audit konum kararına aitse reviewScope=LOCATION'dır; önceki içerik audit'i
SQLite'ta korunur. Audit geçmişi listeleme/düzeltme arayüzü eklenmemiştir.

## Liste sınırları ve yetki

- Varsayılan 25, maksimum 100 kayıt. Sıralama `(sourceDomain,id)` ile kararlıdır.
- sessions: sourceDomain, detectorKind, status; candidates: status, canonicalClass.
- Her uç yalnız kendi izin verdiği query alanlarını kabul eder; tekrar eden
  parametreler ve ownerId/reviewer/token gibi iddialar 422'dir.
- Principal.reviewer ve server-side izinli domain şarttır. TEST dışı environment
  403; başka owner'ın owner uçları 404; eski run 409; başka domain/frame 404.
- HMAC cursor principal/domain/ortam/filtre/endpoint/limit ile bağlıdır. Anahtar
  Engine ömrü kadardır; restart sonrası listeyi baştan alın. Cursor'dan owner veya
  yetki türetilmez. İlk sayfa sonrasındaki yeni kayıtlar creation cutoff ile dışlanır.
- Bu cutoff tüm sayfalarda eski içerik durumunu dondurmaz. Karar veya run değişirse
  filtrelenmiş listeyi baştan yenileyin; revision güncelliği karar POST'unda kontrol edilir.
- SQL sayfa başına domain başına en fazla limit+1 satır okur. Her adayın kanıt
  kimliği/owner/scope bağlantıları doğrulanır; en fazla 10.000 gözlem işlenebilir.
  DTO önizlemesi 100 observation ve 20 frame ile sınırlıdır; toplamlar ve kesilme
  bayrağı döner. Çok büyük gruplar için referans pagination/performans ölçümü ileriki iştir.

## Atomik karar ve idempotency

Mevcut POST uçları korunur:

```http
POST /v1/sessions/demo-session/runs/demo-run/events/demo-event/review
```

```json
{"commandId":"demo-content-approval","decision":"approve","expectedReviewRevision":0}
```

Bu içerik onayı konum istemez. Candidate konum onayı ise mevcut VerifiedDamage
doğrulamasına tabidir: sınıf/scope/detector, açık HUMAN_PLACEMENT veya
CALIBRATED_PROJECTION yöntemi, belirsizlik ve domain'e uygun hasar koordinatı.
Mevcut REPLAY kayıt kökeni sunucu tarafından UNKNOWN tutulduğu için rastgele GPS
iddiasıyla konum doğrulanamaz. Konumsuz candidate approve 422 kalır.

`BEGIN IMMEDIATE` aynı SQLite bölümünde kararları sıraya sokar. Kanonik durum ve
isteğe bağlı expectedReviewRevision yazım öncesi kontrol edilir. Karar, doğrulama
kaydı (varsa), review-audit, review-state ve komut makbuzu aynı transaction içindedir.
Audit veya makbuz yazımı başarısızsa hepsi geri alınır. Yeni tablo veya DDL migration
yoktur; generic records türleri kullanılır. Eski komut hash'leri geriye uyumlu okunur.

| İstek sırası | Sonuç |
| --- | --- |
| event approve → candidate reject | İkinci 409; içerik approved kalır |
| event reject → candidate approve | İkinci 409 |
| candidate reject → event approve | İkinci 409 |
| Aynı principal/run/commandId, işlem/hedef/gövde aynı | Saklanan aynı yanıt; yeni audit yok |
| Aynı commandId, farklı işlem/hedef/gövde | 409 idempotency_conflict |
| Yeni commandId ile terminal içerik kararı | 409 review_conflict |
| Eşzamanlı iki çelişen reviewer | Bir 200 ve bir 409; tek audit/revision |
| expectedReviewRevision eski | 409; yazım yok |
| Eski run'a karar | 409; yeni run etkilenmez |

İçerik onayından sonra ayrı konum onayı ancak konum koşulları geçerliyse mümkündür;
içerik kararı geri çevrilmez. Revizyon toplu event/konum incelemesine aittir.
Karar geri açma, düzeltme/itiraz, silinmez üretim audit deposu ve daha ayrıntılı
konum yetkileri bu aşamada yoktur. 24 saatlik mevcut TEST saklama politikası audit
için de geçerlidir; üretim audit saklama garantisi değildir.

## Kanıt erişimi

Binary endpoint mevcut session/run/owner/frame ilişkisini ve reviewer domain'ini
kontrol eder. Yalnız doğrulanmış analyzed JPEG/PNG alınır. Dosya server tarafından
üretilen özel medya adından çözülür; kök dışı yol reddedilir. Boyut üst sınırı ve
kayıtlı SHA-256 tekrar kontrol edilir. Eksik/bozuk kanıt 404'tür. `image/png` veya
`image/jpeg`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` ve genel
`evidence.png/jpg` dosya adı kullanılır. Public static medya ve URL token'ı yoktur.
DTO available, kayıtlı analiz metadata'sını bildirir; sonraki dosya kaybında GET
404 dönebilir. İstemci bunu bağımsız kanıt yükleme hatası olarak ele almalıdır.

## Harita sınırı ve M4C önerisi

TEST-only backend'in üretim katmanı daima `items:[]` döner. REAL kaynak veya
YOLO_RESULT etiketi üretim provenance'ı değildir. Açık `layer=test` yalnız
approved + VerifiedDamage + GPS + geçerli yöntem/belirsizlik/scope döndürür.
UNKNOWN, araç GPS'si ve SIM_LOCAL WGS84 noktası yapılmaz. İnsan kararı TEST sonucunu
gerçek hasara terfi ettirmez; sahte koordinat üretilmez.

M4C, yalnız sunucudan gelen uygun katmanı ayrı TEST etiketiyle tüketmelidir.
Mevcut sekiz demo kayıt ile bakım durumlarını reviewer içerik durumuna bağlamayın.
Üretim provenance/auth/konum kanıtı politikası tasarlanmadan gerçek katmanı açmayın.

## M4B kullanım önerisi

Liste → aday detayı → yetkili fetch ile kanıt blob'u akışını kullanın; token'ı img
URL'sine koymayın. Blob URL'sini ekran kapandığında iptal edin. Yeni komuta benzersiz
commandId ve gösterilen reviewRevision ekleyin; ağ tekrarında aynı gövdeyi koruyun.
409 sonrası listeyi yenileyin; sessiz overwrite yapmayın. Oturum/run değişince geç
yanıtları atın. İçerik, konum ve bakım etiketlerini ayrı gösterin. TEST_SYNTHETIC
uyarısını onaylanmış öğede de koruyun. Reviewer gerçek servis yapılandırmasına
eklenmeden M4B'yi mevcut analiz token'ıyla açmaya çalışmayın.

## Doğrulama ve servis güvenliği

TS/Python aynı 60 sentetik fixture'ı okur; kesirli PTS, audit eksikliği, ekstra sır/yol
alanı, yanlış domain, VERIFIED şartları ve test/üretim harita ayrımı sınanır.
Yeni API, tutarlılık, yarış, rollback, restart ve medya testleri eski testleri silmez.
Gerçek HTTP kanıtı ayrı 127.0.0.1:8002 ve geçici auth/data ile alınır. Mevcut 8001
süreci, kullanıcı token dosyaları ve veri alanı yeniden başlatılmaz veya taşınmaz.
Python bağımsız PowerShell ortamı ve paket sürümleri korunur; yeni paket kurulmaz.

Bu bir geliştirme/prototip altyapısıdır. Gerçek RBAC/SSO/TLS, ölçek/yük testi,
üretim audit saklama ve karar düzeltme akışı ayrı çalışma gerektirir. HTTPX uyarısı,
Expo Doctor 20/21, mobil audit ve Zod bildirimi bu görevde çözülmemiştir.

## M4B uygulaması

İnceleme artık lazy web bölümüdür. Oturum ve aday sayfaları, durum/sınıf filtreleri,
ayrı kimlik, kayıtlı kanıt, box overlay ve içerik kararı gerçek reviewer API'sine
bağlıdır. Sabit frontend hasar veya kutu üretilmez. Sunucu yetkisi girişte doğrulanır.

Yeni metadata GET'i `/v1/review/sessions/{sessionId}/runs/{runId}/candidates/{candidateId}/evidence`
aday/event/frame ilişkisini ve her gözlemin owner/scope/detector/frame/PTS/sınıfını
doğrular. Yanıtın `items` öğeleri ReviewFrame DTO'sudur. `evidence.frameId` mevcut
binary endpointine güvenli indirme referansıdır. Fotoğraf/video yolu dönmez.
Sayfa en fazla 100 gözlem ve 20 frame; büyük gruplar imzalı cursor ile devam eder.
2 MiB UTF-8 yanıt üst sınırı aşılırsa 413 olur. M4A önizleme sınırları korunur.

Yeni `/v1/review/sessions/{sessionId}/runs/{runId}/summary`, aynı SQLite transaction'ı
içinde tutarlı sayımlar yapar. `totalEvents` tüm olaylar, `includedEvents` rapora
dahil pending+approved olaylardır. `reviewCounts` tüm içerik durumları;
`locationCounts` UNKNOWN/ESTIMATED/VERIFIED hasar konumlarıdır. Sınıf dağılımı ve
ilk/son zaman rapora dahil kümeye aittir. `verifiedCount`, `verifiedRelations`
(ilk 100) ve `verifiedTruncated` ayrıdır. Bunlar bakım durumları değildir.

Özet örneği (yalnız alan kesiti; sentetik):

```json
{
  "totalEvents": 2,
  "includedEvents": 1,
  "reviewCounts": {"pending": 0, "approved": 1, "rejected": 1},
  "locationCounts": {"UNKNOWN": 2, "ESTIMATED": 0, "VERIFIED": 0},
  "slots": {"planned": 4, "analyzed": 1, "skipped": 0, "failed": 0, "unattempted": 3}
}
```

Owner summary'nin anlamı ve yetkisi korunur. Reviewer candidates ucundaki yeni
isteğe bağlı candidateId filtresi, karar/409 sonrası tek güncel kaydı session/run
kapsamında alır. Eski snapshot'ı güncel içerik kararı gibi yorumlamaz.

Web hedefleri açık loopback allowlist'idir. Analiz ekranı 8001 ile açılır; İnceleme
8002 TEST alanıyla açılır. Her iki ekranda hedef değişimi token ve yetkili veriyi
temizler. Kimlikler component/controller ömründe bellektedir; kaynak, VITE, URL,
kalıcı browser storage veya loglarda bulunmaz. İnceleme token'ı analiz istemcisine
geçmez. Çıkış bir sunucu token iptal servisi değildir; yerel belleği temizler.

Kanıt authenticated fetch ile alınır. MIME/boyut/dosya imzası, DTO/scope/detector,
aday/event/frame/PTS ve img doğal boyutu kontrol edilir. Blob URL seçim değişimi,
çıkış ve unmount'ta revoke edilir. Eski response ve eski img hatası yeni görüntüyü
değiştiremez. Normalize kutular görüntünün kendi aspect-ratio düzleminde çizilir;
fullscreen/portrait kenar boşluğu üzerine yanlış kutu taşınmaz.

Karar düğmesi bir commandId ve expectedReviewRevision üretir; çift tıklama ikinci
POST oluşturmaz. 409 canonical kaydı yeniler. Timeout, sunucunun karar yazmadığını
kanıtlamaz: güncel kayıt okunur, hâlâ belirsizse yeni karar engellenir ve aynı
komutla kontrollü tekrar sunulur. Token/hedef değişimi ve çıkış bu yerel bekleme
durumunu temizler; sunucuda geri alma yapmaz. Gerçek kullanıcı medyasında otomatik
karar verilmez; HTTP kanıt testleri yalnız M4B-SYNTHETIC oturumlarını seçer.

Timeline, görünür genişlikte yaklaşık 44 CSS px alanlara göre saf görsel kümeler
üretir. Grup listesi 20 olay/sayfa gösterir; seçilen olayın özgün PTS'sine seek
yapılır. EventId/sayı/veri değişmez ve events/group çağrılmaz. Tab/Enter/Space doğal
buton davranışını, Escape kapatma/fokus dönüşünü kullanır. Timeline bu owner
raporuna dahil olayları gösterir; reddedilenler ayrı İnceleme kaynağındadır.

VideoSummary korunarak video süresi, plan/başarı/skipped/failed/unattempted, başarılı
kapsam dışı yuva/süre, olay/sınıf/model bilgileri ve sayfalı olay listesi eklendi.
Unattempted=N−A−S−F; başarı dışı=N−A. Sahipsiz/yerel örnekleme boşluğu backend skip
diye yazılmaz. Owner özeti konum doğrulaması sağlamadığında arayüz bunu açık söyler;
UNKNOWN veya verified değeri uydurmaz. Yeni video/run eski timeline/rapor görünümünü
temizler. Yeni npm/Python paketi veya migration yoktur.

M4C uygulanmadı; üretim harita katmanı TEST-only ortamda boş kalır. M5A mobil UI/UX
ve sonraki kamera/ses/entegrasyon adımları ayrı onay bekler. Tarayıcı, viewport,
fullscreen ve gerçek cihaz sonuçları otomatik unit testiyle eş tutulmaz; teslim
raporu bağımsız kontrolleri, kullanıcı beyanlarını ve eksik testleri ayrı listeler.

## M4C — Web harita katmanları

Harita mevcut üç Isparta DEMO noktasını korur; sekiz bakım bildirimi ve 3/2/3
sayılarıyla ilişkilendirmez. DEMO varsayılan açık, ÜRETİM açık, TEST kapalıdır.
Mevcut TEST-only API'de üretim katmanı daima boştur. REAL kaynak etiketi,
YOLO_RESULT veya reviewer onayı TEST ortamını üretime dönüştürmez.

### Okuma ve konum politikası

Harita istemcisi yalnız `GET /v1/review/map-damages` yeteneğini dışarı açar;
karar veya konum yazma yeteneği yoktur. Ortak ReviewItem guard'ı, aynı scope ve
detector doğrulaması, `isReviewMapEligible` ve Leaflet Web Mercator sınırı
(±85.0511287798) uygulanır. UNKNOWN, araç konumu, SIM_LOCAL, konumsuz REPLAY,
bozuk koordinatlar ve projeksiyon dışı noktalar çizilmez. Sıfır geçerlidir.

GPS accuracyM, hasar uncertaintyM ve konumlandırma yöntemi ayrı gösterilir.
VERIFIED, konumun matematiksel kesinliği veya bakımın tamamlanması değildir.
İkon HTML'i sabittir; sunucu alanları yalnız React metni olarak render edilir.
Popup'lar dar ekranda genişliği sınırlar, iç kaydırma kullanır; harita resize
sonrası açık popup konumunu tekrar hesaplar. OSM atfı ve döşeme hata/tekrar
akışı korunur. API hatası döşeme hatası değildir ve DEMO'yu kapatmaz.

API yalnız environment/layer/sourceDomain/limit/cursor alır. Sınıf filtresi
sadece yüklenen sayfadadır; global sorgu veya toplam gibi sunulmaz. Varsayılan
25, üst sınır 100; cursor geçmişi önceki/sonraki sayfayı sağlar. Cursor 422
verirse ilk sayfa bir kez yeniden okunur. Scope/limit değişince geçmiş sıfırlanır.

### Kimlik ve navigasyon

Kimlik yalnız bileşen/controller belleğindedir. URL, localStorage, sessionStorage
veya VITE değişkenine yazılmaz. Hedef değişimi, çıkış ve unmount kimliği,
marker'ları, cursor'ları ve TEST tercihini siler. Geç HTTP yanıtları generation ve
abort ile dışlanır; çıkıştan sonra geciken okuma yeni TEST isteği başlatamaz.
401/403 reviewer kimliğini düşürür. Diğer API hataları anlaşılır gösterilir.

`İncelemede Aç` yalnız origin/sourceDomain/sessionId/runId/candidateId/verifiedId
aktarır. Token, GPS snapshot'ı ve blob aktarılmaz. Ayrı reviewer girişi gerekir;
hedef referans origin'ine sabittir. Canonical aday aynı run/domain/verifiedId
ile yeniden okunur. REAL için CaptureSession oluşturulmaz, REPLAY oturum
listesi/summary çağrılmaz. Kanıt mevcut metadata endpointinden okunur. REAL
kanıt saati DEVICE_MONOTONIC, REPLAY video saati VIDEO PTS olarak etiketlenir.
Haritadan açılan detay salt okunurdur; otomatik karar yoktur. Yeni normal
İnceleme görünümüne geçiş ayrı component key ile eski kimliği temizler.

### Bağımsız pozitif TEST alanı

8003 loopback alanı yalnız M4C sentetik test içindir; açık allowlist girdisidir.
Veri ve rastgele principal dosyaları repo dışındadır. REAL-scope producer ve
reviewer ayrıdır. REAL sözleşmesi v1 kullanır; v2 yalnız REPLAY içindir.
Sentetik PNG resmi upload/job akışıyla işlenir; iki aday resmi location review
sözleşmesiyle HUMAN_PLACEMENT, sentetik GPS, accuracy 5 m, uncertainty 12 m
olarak doğrulanır. Hiçbir fiziksel konum ölçümü veya gerçek YOLO tespiti yoktur.
Doğrudan SQLite yazımı veya politika gevşetmesi yapılmaz. 8001/8002 verileri,
kimlikleri ve servisleri kullanılmaz veya yeniden başlatılmaz. CORS mevcut
izinli 5173 origin'leriyle sınırlıdır; wildcard eklenmez.

### M4C doğrulama sınırları

Yeni web testleri konum/provenans, API sınırları, cursor, kimlik yaşam döngüsü,
geç yanıt ve REAL referans detayını kapsar. Gerçek HTTP testinde iki ayrı TEST
sayfası, boş production, producer 403, canonical kanıt ve exact CORS doğrulanır.
Bunlar gerçek fiziksel yol hasarı testi değildir. Birim/HTTP testleri görsel
ve fiziksel dokunmatik testinin yerine geçmez; oturum raporu bu ayrımı belirtir.
Üretim API'si, performans yük testi ve mobil M5A/M5B bu kapsamın dışındadır.
