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
