# RoadSense M2 — Yerel TEST API

Bu servis geliştirme/prototip içindir. Yalnız deterministik TestDetector vardır.
Gönderilen görüntüde hasar bulunduğunu iddia etmez; sonuçlar `TEST_SYNTHETIC`
olarak etiketlenir. YOLO ağırlığı, çıkarımı, kamera veya web oynatıcı içermez.
YOLO isteği `503 yolo_model_unavailable` döner; sessiz TEST geçişi yapılmaz.

## Ortam ve tekrar kurulumu

Hedef: Windows x64, normal GIL CPython **3.14.10**. Free-threaded Python kullanılmaz.
Python'un resmî tam çalışma zamanı ZIP'i, Windows belgesindeki kayıtsız çıkarma
yöntemiyle kullanılabilir. Embeddable paket değildir; venv desteği korunur.

- Kaynak: https://www.python.org/ftp/python/3.14.10/python-3.14.10-amd64.zip
- Manifest: https://www.python.org/ftp/python/3.14.10/windows-3.14.10.json
- Arşiv SHA-256: `cc28026a650970cc1570bb127312f1f9634eb67abfe157ae6ca1acbbc627d091`
- Python.exe PSF Authenticode imzası ayrıca kontrol edilmelidir.

M3A'da normal PowerShell'den doğrulanan düzen (OneDrive, AppData ve Codex
LocalCache dışında; `%USERPROFILE%\RoadSenseLocal\m3a-cp31410`):

```text
RoadSenseLocal/m3a-cp31410/python-3.14.10/   tam, kayıtsız çalışma zamanı
RoadSenseLocal/m3a-cp31410/api-venv/         yalnız API sanal ortamı
RoadSenseLocal/m3a-cp31410/private-test/access.json  yeni özel REPLAY kimliği
RoadSenseLocal/m3a-cp31410/private-test/data/        ayrı TEST verileri
```

Eski M2 LocalCache ortamı korunur. Eski venv'in `pyvenv.cfg` içindeki mantıksal
AppData `home` yolu normal PowerShell'de bulunamadığından çıkış kodu 103 üretir.
Yeni runtime doğrulanmış aynı ZIP'ten çıkarıldı, yeni venv fiziksel runtime
yolundan oluşturuldu ve aynı wheel/hash kilitleriyle çevrimdışı kuruldu. Eski
venv taşınmadı veya değiştirilmedi. Paket kimliği olmayan aynı kullanıcı
PowerShell sürecinde Python/importlar, pip check, pytest ve HTTP servis başlangıcı
ayrıca doğrulandı. PATH, py varsayılanı, registry, dosya ilişkileri ve global
Python 3.12/pip değiştirilmedi. Bu doğrulama başka bilgisayara kurulum testi değildir.

`requirements.lock` 15 çalışma zamanı paketini, `requirements-dev.lock` bunlara
ek 9 test paketini sabitler. `requirements-bootstrap.lock` pip **26.2.2** içindir.
Tüm girdiler PyPI wheel SHA-256 değeriyle sabittir. `pyproject.toml` doğrudan paketleri
belgeler; bu kaynak uygulama için editable install/build backend gerekmez.

Hazırlanmış sanal ortamda, bu klasörden PowerShell:

```powershell
$apiRoot = Join-Path $env:USERPROFILE 'RoadSenseLocal\m3a-cp31410'
$apiPython = Join-Path $apiRoot 'api-venv\Scripts\python.exe'
& $apiPython -m pip install --require-hashes --only-binary=:all: -r requirements-bootstrap.lock
& $apiPython -m pip install --require-hashes --only-binary=:all: -r requirements-dev.lock
& $apiPython -m pip check
```

Kurulum cache'i mevcutsa `--no-index --find-links <cache-yolu>` kullanılabilir.
Yeni Python/OS hedefinde native wheel hash'leri tekrar incelenmelidir. Sürüm/hash
uyuşmazlığında force, kaynak derleme veya kontrolsüz yükseltme yapılmamalıdır.

## Kimlik ve sunucuyu başlatma

Kimlikler repo dışında JSON dosyasında sağlanır. Dosya bir dizi içerir; her girdide
`id`, rastgele en az 32 karakterli `token`, izinli `domains` dizisi ve `reviewer`
boolean alanı bulunur. Token üretiminde `secrets.token_urlsafe(32)` kullanılabilir.
Gerçek değerleri terminale/loga/repo örneklerine yazmayın. Sabit geliştirme token'ı
bu depoda bulunmaz. Bu mekanizma üretim kullanıcı kimlik sağlayıcısı değildir.

```powershell
$apiRoot = Join-Path $env:USERPROFILE 'RoadSenseLocal\m3a-cp31410'
$apiPython = Join-Path $apiRoot 'api-venv\Scripts\python.exe'
Set-Location -LiteralPath (Join-Path $env:USERPROFILE 'OneDrive\Masaüstü\yolRadar\apps\api')
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:ROADSENSE_API_AUTH_FILE = Join-Path $apiRoot 'private-test\access.json'
$env:ROADSENSE_API_DATA_DIR = Join-Path $apiRoot 'private-test\data'
& $apiPython -B -m pip check
& $apiPython -B -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8001 --workers 1 --limit-concurrency 16 --timeout-keep-alive 5 --no-access-log
```

Eksik/geçersiz kimlik yapılandırmasında başlangıç reddedilir. Health ve OpenAPI
dışında bütün endpointler `Authorization: Bearer <yerel-token>` ister. Kullanıcı,
rol ve domain yetkisi sunucu yapılandırmasından gelir; istemci bunları atayamaz.
Reviewer yalnız izinli domainlerde inceleme yapabilir. Başkasının oturumu/işi
normal kullanıcı için 404'tür. Host/CORS kısıtları yetkilendirmenin yerine geçmez.

Sunucuyu `0.0.0.0` üzerinde açmayın. M2 internet/LAN veya gerçek kullanıcı verisiyle
üretim dağıtımı için tasarlanmamıştır. `--reload`/çoklu Uvicorn worker kullanmayın;
aynı veri alanına ikinci servis ayrıca işletim sistemi kilidiyle reddedilir.

Ön planda başlatılan servisi aynı terminalde **Ctrl+C** ile durdurun. M3A test
servisi 8001'de zaten çalışıyorsa ikinci kez başlatmayın. Farklı bir terminalden
yalnız bu servisi güvenle durdurmak için aşağıdaki kontrol kullanılabilir:

```powershell
$apiPython = Join-Path $env:USERPROFILE 'RoadSenseLocal\m3a-cp31410\api-venv\Scripts\python.exe'
$apiBasePython = Join-Path $env:USERPROFILE 'RoadSenseLocal\m3a-cp31410\python-3.14.10\python.exe'
$listener = @(Get-NetTCPConnection -State Listen -LocalPort 8001 -ErrorAction SilentlyContinue)
if ($listener.Count -eq 1 -and $listener[0].LocalAddress -eq '127.0.0.1') {
    $apiProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener[0].OwningProcess)"
    if ($apiProcess.ExecutablePath -in @($apiPython, $apiBasePython) -and
        $apiProcess.CommandLine.StartsWith(('"' + $apiPython + '" ')) -and
        $apiProcess.CommandLine -match 'uvicorn app\.main:create_app' -and
        $apiProcess.CommandLine -match '--port 8001(?:\s|$)') {
        Stop-Process -Id $apiProcess.ProcessId
    } else { throw '8001 beklenen RoadSense sürecine ait değil; durdurulmadı.' }
}
```

8000 eski ortam ve verileriyle çalışır; yeni 8001 ayrı veri kökünü kullanır.
Eski veriler/kimlikler kopyalanmadı. Yeni kimlik yalnız REPLAY yetkilidir,
reviewer değildir. İki servise aynı SQLite veri kökünü vermeyin. Health kontrolü
için ayrı PowerShell'de `Invoke-RestMethod http://127.0.0.1:8001/health` kullanın.

Health: `GET http://127.0.0.1:8001/health`.
OpenAPI request şemaları: `GET http://127.0.0.1:8001/openapi.json`.
Harici CDN kullanan Swagger/ReDoc sayfası açılmaz.

## REST sözleşmesi

`S=/v1/sessions/{sessionId}`, `R=S/runs/{runId}` kısaltmaları aşağıdaki tablo içindir.
JSON işlemlerinde `Content-Type: application/json`, içerikte image/jpeg veya
image/png kullanılır. Bütün yanıtlar no-store/nosniff taşır.

| Metot / yol | İstek | Başarılı yanıt |
| --- | --- | --- |
| GET /health | Yok; kimliksiz | 200: status, profile=TEST, resultLabel, contractVersion |
| POST /v1/sessions | commandId, sourceDomain, detectorKind, testProfile, clockId; REPLAY için videoId/videoDurationMs/samplingIntervalMs; opsiyonel contractVersion (varsayılan 1, video için açık 2) | 201: `{session, resultLabel}` |
| GET S | Yok | 200: `{session, resultLabel}` |
| POST S/runs | commandId, expectedRunId | 200: yeni run içeren `{session, resultLabel}` |
| POST S/cancel | Yok | 200: cancelled session; tekrarı yeni kayıt oluşturmaz |
| POST R/frames | `{frame: ImageFrame, kind: frame veya photo, vehiclePosition?: PositionSample}` | 201: frameId, status=registered, duplicate |
| PUT R/frames/{frameId}/content | Ham JPEG/PNG byte'ları; dosya adı alınmaz | 202: jobId/sessionId/runId/frameId/domain/TEST etiketi/status/duplicate |
| GET /v1/jobs/{jobId} | Yok | 200: durum, errorCode veya observationIds ve M1 observations dizisi |
| POST R/frames/{frameId}/skip | Yok; yalnız henüz yüklenmemiş kare | 200: frameId, status=skipped |
| GET R/timeline | Yok | 200: events, resultLabel, trackingStatus |
| GET R/summary | Yok | 200: M1 summary, trackingStatus, countMeaning |
| POST R/complete | `{analysisStatus: completed veya partial veya failed}` | 200: sonlandırılmış session; devam eden iş varsa 409 |
| GET /v1/candidates | Yok | 200: yetkili/current-run items, resultLabel |
| POST /v1/candidates/{candidateId}/review | commandId, decision=approve/reject; onay için damageLocation | 200: item ve resultLabel |
| POST R/events/{eventId}/review | commandId, decision; konum gönderilmez | 200: event ve resultLabel |
| POST R/events/group | commandId, observationIds; reviewer zorunlu | 200: atomik yeni event ve TEST/tracking etiketi |

İlave iki endpoint teknik gereklilik içindir: `skip`, analiz edilmeyen örnekleri
açıkça sayar; `events/group`, M1'in açık gözlem gruplarını yetkili inceleme
işlemiyle sunucuda kurar. Fiziksel tracker eklemez.

Hatalar: `{error: {code, requestId}}`. Ham Pydantic girdisi, parser istisnası veya
görüntü/konum yanıt hatasına/loga konmaz. Başlıca HTTP durumları:

- 401 authentication_required; 403 domain_not_allowed/reviewer_required.
- 404 session_not_found/job_not_found/frame_not_registered/event_not_found.
- 409 stale_run/session_not_active, metadata/payload/idempotency/review çatışması.
- 413 request_body_too_large/image_too_large; 415 jpeg_or_png_required.
- 422 invalid_contract, clock/coordinate mismatch, incomplete_sampling_coverage,
  damage_location_required_for_verification veya geçersiz gruplama.
- 429 active_session_limit/frame_metadata_limit/analysis_queue_full.
- 408 upload_timeout; 503 upload_busy/storage_unavailable/yolo_model_unavailable.
- 507 media_quota_exceeded.

İçerik doğrulaması worker'da yapılır: 202 analiz başarısı değildir. Bozuk içerik,
MIME/gerçek biçim veya boyut uyuşmazlığı işte `failed / invalid_image` üretir.
Worker çökmesi/timeout ayrı güvenli errorCode ile raporlanır.

## M3 için örnek akış

1. Rastgele commandId ile REPLAY/TEST ve `synthetic_one`, `synthetic_two` veya
   `synthetic_empty` profilli oturum oluştur. Model/classMap kimliğini sunucudan al.
2. Decoded zaman ayrımı için oturumu açık `contractVersion: 2` ile oluştur.
   Her örnek için benzersiz frameId ile ImageFrame kaydet. capturedAt VIDEO,
   clockId ve videoId oturumla eşleşir; valueMs gerçek kaynak PTS'dir.
   v2 `frame.plannedSampleTimestampMs` grid hedefini ayrıca taşır; PTS yuvarlanmaz.
3. Aynı frameId'nin content yoluna canvas/JPEG/PNG byte'larını gönder. Bir aktif
   istek ve sınırlı istemci kuyruğu kullan; 429'da sınırsız tekrar başlatma.
4. jobId'yi sorgula. Başarılı sonuçtaki M1 `box` alanı normalize x/y/width/height
   taşır (ayrı boundingBox alias'ı eklenmedi). Frame/run/time kimliğini eşleştir.
5. Timeline/summary al. Seek, başa dönme, video değiştirme ve yeni plan için yeni
   run/oturum aç; eski cevabı yeni videoya çizme. Bu servis oynatıcı içermez.
6. İşler bittikten sonra completed/partial/failed ile sonlandır; video sonuna
   gelinmesi analiz kapsamını otomatik tamamlamaz.

Aynı metadata tekrarında yeni kare oluşmaz. Aynı frameId ve aynı byte/MIME tekrarında
aynı job döner. Değişen payload 409'dur; başarısız kareyi sessizce yeniden yazmaz.
Yeni analiz girişimi yeni run gerektirir. Oluşturma/run/gruplama/inceleme commandId
değerleri tekrarları ayırır. Oturum oluşturma tekrarında güncel aynı oturum döner.

## M1 uyumu ve olay sayılarının anlamı

M1 v1 davranışı korunur; M3A v2 açıkça eklenmiştir. Sıkı sonlu sayılar, boolean reddi, JS güvenli sayı
sınırı, saat/domain, kutu, classMap, aday/verified ayrımı Python'da kontrol edilir.
İki dil aynı 89 sentetik fixture'ı okur. Testlerdeki YOLO kimliği gerçek model
çalıştırıldığı anlamına gelmez. Gerçek koordinat, medya veya video içermezler.

Kayıtlı kaynak REPLAY'dir; detektör bağımsızdır. M2'de kayıt kökeni UNKNOWN tutulur:
istemcinin gerçek/sim köken iddiası güvenilir provenance sayılmaz. Dolayısıyla
REPLAY konum taşıyamaz; ileride güvenilir kayıt kaydı ayrıca gerekecektir.

TestDetector görüntüyü yorumlamaz. Belirlenmiş profile göre aynı normalize
sentetik kutuları döndürür; ID'ler session/run/frame/sınıftan deterministik türetilir.

**Fiziksel hasar tracker'ı yoktur.** Başlangıçta her gözlem geçici bir olaydır.
Reviewer farklı karelerin aynı hasara ait olduğunu açıkça gruplayabilir. Aynı
karedeki iki kutu/farklı sınıf tek gruba sokulamaz; kısmi veya incelenmiş gruplar
sessizce değiştirilemez. Grup değişimi yeni eventId ile transaction içinde eski
pending olay/adayları değiştirir; komut kaydı değiştirilen olayları saklar.
`trackingStatus=NO_PHYSICAL_TRACKER`, `countMeaning=PROVISIONAL_EVENT_GROUPS`.
totalEvents kesin tekil fiziksel hasar sayısı değildir; rawObservationCount ayrıdır.

Özet rejected olayları dışlar; pending olaylar geçicidir. Kapsam tamamlanması
yalnız sabit samplingIntervalMs gridindeki tüm örnekleri ifade eder, tüm video
karelerini değil. v1 tam-grid kuralı korunur. v2 gerçek PTS ile grid hedefini ayırır:
hedef <= PTS <= hedef+100 ms, ayrıca PTS sonraki yuvadan/video bitiminden küçüktür.
Hedef öncesi veya pencere dışı kare başarı sayılmaz. Olay zamanı gerçek PTS,
kapsam planlanan hedef kullanır. Kaynak zamanı HTTP yanıt saati değildir.
Sürümleme, tolerans ve geri alma ayrıntıları:
[M3A zaman sözleşmesi](../../docs/architecture/m3a-video-timing.md).

Konumsuz video olayı insan tarafından onaylanabilir; bu işlem VerifiedDamage
oluşturmaz. Harita doğrulaması açık konum/yöntem/belirsizlik ister; araç GPS'i hasar
konumuna kopyalanmaz. Orijinal aday kanıtı snapshot olarak korunur; güncel inceleme
durumu video için kanonik event.reviewStatus, konum doğrulaması için API zarfındaki
reviewDecision'dır. Reviewer DTO'su bunları ayrı yansıtır. VerifiedDamage ayrı kayıttır. İnsan onayı
SIM/REPLAY/TEST kayıtlarını REAL/YOLO'ya dönüştürmez. Terminal run incelemeye açık
kalabilir; yeni run açıldığında eski run için işlem 409 olur.

## Sınırlar, saklama ve worker

- Kare 4 MiB, fotoğraf 8 MiB, görüntü 16 MP; tek karede en fazla 100 gözlem.
- JSON gövde 128 KiB; gerçek alınan byte'lar sayılır, Content-Length'e güvenilmez.
- Toplam aktif iş 8; uploadlar seri ve timeout'lu; kullanıcı/domain başına 4 aktif
  oturum, run başına 10.000 kare metadata kaydı.
- Özel medya kotası 256 MiB. Sunucu dosya adlarını kendisi üretir; public static
  medya endpointi yoktur. Özgün JPEG/PNG yalnız yerel özel alanda tutulur; EXIF
  okunmaz veya konum olarak kullanılmaz. İnternete servis edilmez.
- Veri alanı TEST/REAL, TEST/SIM, TEST/REPLAY olarak fiziksel ayrıdır. Her SQLite
  kaydı ayrıca sunucu tarafından atanmış owner/session/run taşır.
- SQLite WAL + FULL synchronous ve transaction kullanır. Tek uygulama örneği
  kilidi vardır; bilinmeyen şemaya otomatik migration yapılmaz.
- Başlangıç/kapanışta yarım işler failed/worker_interrupted olur; otomatik başarı
  veya kontrolsüz yeniden analiz yapılmaz. İptal/yeni run sonrası geç sonuç kayıt
  transaction'ında reddedilir. Gözlem/aday/olay yazımı atomiktir.
- 24 saatten eski oturumlar başlangıç temizliğinde kaldırılır; sahipli UUID adlı
  sahipsiz geçici medyalar temizlenir. Çalışma sırasında quota büyümeyi sınırlar.
  Bu süre geliştirme politikasıdır, yasal saklama standardı değildir.
- Tek supervisor her iş için yeni spawn process açar; timeout/iptalde sonlandırır
  ve sonraki iş için yeniden oluşturur. M2'de model yoktur. GPU modeli eklenirken
  process başına model yükleme maliyeti ve kalıcı inference worker ayrıca ele alınır.
- Ayrı process kaynak/iptal kontrolüdür; güvensiz native decoder için OS sandbox
  veya üretim güvenlik sınırı değildir.

FastAPI telemetry tracing/metrics/logs/operation_spans/auto_configure kapalıdır.
SDK/exporter, Redis, Celery, ML, Docker veya multipart paketi kurulmaz.

## Testler ve açık konular

API klasöründe izole Python ile `python -m pytest`; çalışma dosyaları için repo
dışında yeni bir `--basetemp` seçin. Aynı basetemp'i tekrar kullanmak pytest'in
önceki test klasörünü temizlemesine neden olur; kullanıcı verisi olan yolu vermeyin.
Kökten npm test/typecheck, mobil test:map, admin lint/build ve map:assets:check
regresyonları ayrıca çalıştırılır. Yeni shared fixture testleri mevcut M1 testlerine
eklenir; eski 38 test değiştirilmez.

Starlette 1.10.0 mevcut HTTPX TestClient arayüzü için deprecation uyarısı verir.
HTTPX 0.28.1 onaylı kaldı; httpx2 eklenmedi, uyarı gizlenmedi. Gelecekte ayrı
bağımlılık değerlendirmesi gerekir.

Üretim kimlik sağlayıcısı, TLS, internet/LAN dağıtımı, gerçek video codec denetimi,
YOLO/CUDA performansı, fiziksel tracking ve gerçek kamera/GPS zaman eşlemesi
tamamlanmış sayılmaz. M1'in bilinen Expo Doctor/audit/Zod borçları bu işle giderilmez.

Lisanslar: FastAPI/Pydantic/pytest MIT, Uvicorn/HTTPX BSD-3-Clause, Pillow MIT-CMU;
dolaylı paketlerin hash ve sürümleri lock dosyalarındadır. Wheel'lerdeki lisans
bildirimleri kurulumda korunur; Python/SQLite ve native görüntü kütüphanelerinin
kendi bildirimleri de geçerlidir. Model/veri seti lisans incelemesi M2 kapsamında yoktur.

## M4A: özel reviewer okuma API'si

Sunucu tarafından atanmış `Principal.reviewer=true` ve izinli domain gerekir.
Mevcut REPLAY analiz kimliği yükseltilmez. Owner oturum/summary uçları başka
kullanıcının verisini reviewer'a açmaz; aşağıdaki ayrı uçları kullanın:

| GET yolu | Filtreler / sonuç |
| --- | --- |
| `/v1/review/sessions` | sourceDomain, detectorKind, status; güvenli oturum DTO'ları |
| `/v1/review/sessions/{sessionId}/runs/{runId}/candidates` | status, canonicalClass; inceleme DTO'ları |
| `/v1/review/sessions/{sessionId}/runs/{runId}/evidence/{frameId}` | Yetkili JPEG/PNG binary; no-store, nosniff |
| `/v1/review/map-damages` | layer=production (varsayılan) veya açık layer=test; sourceDomain |

Liste uçlarında `limit=25` varsayılan, üst sınır 100, `cursor` devam anahtarıdır.
`environment=TEST` dışındaki ortamlar 403'tür. Tanımsız, yinelenen ve kimlik iddiası
taşıyan query parametreleri 422'dir. Token sadece Authorization başlığındadır;
URL'ye, public VITE değişkenine veya kalıcı tarayıcı depolamasına yazılmaz.

Yanıt zarfı `{environment:"TEST",items:[...],nextCursor:null|"..."}` biçimindedir.
Sıralama `(sourceDomain,id)`; imzalı cursor principal, domain, filtre, ortam,
endpoint ve limit ile bağlıdır. Restart sonrası yeniden ilk sayfadan başlayın.
Cursor oluşturulduktan sonra eklenen kayıtlar dışlanır; inceleme durumu/yeni run
değişimleri için sayfalar arası tarihsel bir DB snapshot garantisi yoktur.

DTO'da `videoTimestampMs` gerçek decoded PTS'dir; planlanan örnekleme zamanı
veya HTTP saati değildir. `reviewStatus` içerik kararıdır; `locationStatus` ve
`verifiedDamage` ayrı anlam taşır. Bakım durumları burada bulunmaz. En fazla 100
observation ve 20 kanıt referansı önizlenir; toplam sayılar ve
`referencesTruncated` açıkça döner. Kanıt endpointi bilinen frameId ile ayrıca
okunabilir; tam referans sayfalaması bu aşamada eklenmemiştir.

Mevcut karar POST uçları korunur. İsteğe bağlı `expectedReviewRevision` eski
istemcileri bozmadan revision kontrolü ekler. Aynı principal/session/run içindeki
aynı commandId, işlem, hedef ve gövde aynı cevabı döndürür; değişen gövde/hedef 409.
Terminal içerik kararı başka endpointten değiştirilemez. Konum doğrulaması ayrı
koşullarla ilerler; konumsuz içerik onayından VerifiedDamage doğmaz.

SQLite generic records içinde `review-state`, `review-audit` ve komut makbuzu
aynı `BEGIN IMMEDIATE` transaction'ında yazılır. Yeni tablo/migration yoktur.
Eski kayıtlar revision 0 ile okunur; eski reviewer/zaman uydurulmaz. Yeni audit
gerçek karar anını ve sunucudaki actor kimliğini kaydeder; DTO en son audit'i
gösterir. İçerik ve sonraki konum kararının geçmişi DB'de ayrı tutulur.

Bu backend yalnız TEST verisidir. Üretim harita katmanı daima boştur. Açık test
katmanı yalnız onaylı, yöntem/belirsizlik taşıyan, geçerli GPS VerifiedDamage
döndürür. REAL kaynak etiketi, insan onayı veya YOLO kimliği üretime terfi değildir.
SIM_LOCAL WGS84'e çevrilmez; araç GPS'si hasar kanıtı sayılmaz.

M4A test servisi ayrı port/kimlik/veri alanında çalıştırılır. Mevcut 8001 servisini
değişmiş kodla mevcut veri alanında otomatik yeniden başlatmayın. Gerçek kullanıcı
auth dosyasına reviewer eklemek ayrıca yetkilendirilmelidir. Üretim RBAC, audit
saklama politikası, karar geri açma/düzeltme ve M4B/M4C arayüzleri tamamlanmamıştır.
Örnekler ve politika: [M4 inceleme akışı](../../docs/architecture/m4-review-flow.md).

## M4B: kanıt metadata ve reviewer özeti

İki ek GET ucu mevcut reviewer/domain/TEST kontrollerine tabidir:

- `/v1/review/sessions/{sessionId}/runs/{runId}/candidates/{candidateId}/evidence`
- `/v1/review/sessions/{sessionId}/runs/{runId}/summary`

İlk uç `{environment,candidateId,items,nextCursor,observationCount,frameCount}`
döner. Her öğe candidate/event/scope/detector kimliği, orijinal ImageFrame,
EvidenceRef ve yalnız seçilen adaya ait kayıtlı observation/normalize box taşır.
Binary indirme referansı frameId'dir; görüntü mevcut yetkili binary uçtan alınır.
Dosya yolu, medya adı, token veya görüntü byte'ı metadata içinde bulunmaz.

`limit` varsayılan 25/maksimum 100 gözlemdir. Her sayfada ayrıca en fazla 20
farklı frame vardır. Sıralama gerçek PTS/frameId/observationId; devam cursor'u
principal/domain/ortam/aday/run/limit ile imzalıdır. Büyük gruplar devam sayfasıyla
okunur; M4A'nın 100 observation/20 frame önizlemesi değiştirilmemiştir. Metadata
ve yeni reviewer summary JSON yanıtlarının üst sınırı 2 MiB UTF-8 byte'tır (413).

Reviewer summary tek transaction içinde oturum, frame, observation, event ve
aday ilişkilerini okur. totalEvents tüm geçici olaylar; reviewCounts tüm
pending/approved/rejected dağılımıdır. includedEvents, classCounts ve ilk/son
zamanlar mevcut owner özeti gibi pending+approved olaylara aittir. Owner summary
değişmez; reddedilenler içine eklenmez. locationCounts ayrı hasar konumu durumudur.
verifiedRelations ilk 100 ilişkiyi taşır; verifiedCount/verifiedTruncated toplamı
ve kesilmeyi açıklar. Bilinmeyen audit veya koordinat üretilmez.

slots.planned=N, analyzed=A, skipped=S, failed=F, unattempted=N−A−S−F.
Başarılı kapsam dışında kalan N−A'dır ve skipped/failed yuvaları da içerir.
Coverage oynatma ilerlemesi değildir. Yeni sayım/metadata DTO'ları shared ile aynı
sentetik fixture'larla test edilir; mevcut DTO/testler korunur. Yeni tablo veya
migration yoktur.

Karar sonrası kanonik kaydı taramadan okuyabilmek için mevcut reviewer candidates
ucuna isteğe bağlı `candidateId` filtresi eklendi. Bu filtre session/run/domain
yetkisini genişletmez; diğer filtreler ve cursor bağlamı korunur.

Web İnceleme sayfası ayrı reviewer token'ıyla çalışır; analiz token'ı aktarılmaz.
Hedefler yalnız 127.0.0.1:8001 ve 127.0.0.1:8002 allowlist'idir. Hedef değişimi ve
çıkış eski token/veri/istek/blob URL'lerini temizler. Kanıt MIME, boyut, imza,
scope/event/frame/PTS ve doğal görüntü boyutuyla doğrulanır. Onay/ret içerik
kararıdır; terminal karar geri açılmaz. Timeout'ta sunucu sonucu yeniden okunur;
tekrar gerekiyorsa aynı commandId/gövde/revision korunur.

M4B test servisi 127.0.0.1:8002 üzerinde ayrı veri ve kimliklerle çalışır. Varsayılan
8001 video analizi korunur; iki servis veri paylaşmaz. Yeni üretim kimlik sistemi,
M4C harita katmanı, model veya mobil özellik eklenmemiştir.
