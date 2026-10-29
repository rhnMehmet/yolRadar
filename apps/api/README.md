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

Yerel düzen (`LOCALAPPDATA` altında, OneDrive dışında):

```text
RoadSense/venvs/python-3.14.10/   tam, kayıtsız çalışma zamanı
RoadSense/venvs/api-cp31410/      yalnız API sanal ortamı
RoadSense/venvs/cache-cp31410/    hash doğrulamalı kurulum wheel'leri
RoadSense/api-data/              özel kimlik dosyası ve çalışma verileri
```

Windows uygulama yalıtımı bu yolları uygulamanın LocalCache alanına yönlendirebilir.
Sanal ortamın gerçek yolunu `python -c "import sys; print(sys.executable)"` ile
doğrulayın; venv klasörünü taşımayın. PATH, py varsayılanı veya dosya ilişkilendirmesi
değişikliği gerekmez. Mevcut Python 3.12/global pip bu ortama dahil değildir.

Bu bilgisayardaki doğrulanmış sınırlama: Codex dışında, aynı Windows kullanıcısıyla
çalışan normal PowerShell'de yukarıdaki mantıksal venv yolu bulunmuyor. LocalCache
içindeki gerçek venv yürütülebiliri de pyvenv.cfg dosyasındaki mantıksal `home`
yolunu normal bağlamda bulamadığı için başlatılamıyor. Aşağıdaki komutlar mevcut
kurulumda Codex bağlamında çalışır; normal terminal için doğrudan çalıştıkları
varsayılmamalıdır. Ortam dosyaları veya sistem ayarları bu kontrol sırasında
değiştirilmedi. Normal terminalden bağımsız başlatma için ayrı onayla, doğru fiziksel
runtime yolundan yeni bir venv oluşturulması ve yeniden doğrulanması gerekir.
Bu sınırlama kaynak kodundan çok mevcut yerel kurulumla ilgilidir.

`requirements.lock` 15 çalışma zamanı paketini, `requirements-dev.lock` bunlara
ek 9 test paketini sabitler. `requirements-bootstrap.lock` pip **26.2.2** içindir.
Tüm girdiler PyPI wheel SHA-256 değeriyle sabittir. `pyproject.toml` doğrudan paketleri
belgeler; bu kaynak uygulama için editable install/build backend gerekmez.

Hazırlanmış sanal ortamda, bu klasörden PowerShell:

```powershell
$apiPython = Join-Path $env:LOCALAPPDATA 'RoadSense\venvs\api-cp31410\Scripts\python.exe'
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
$env:ROADSENSE_API_AUTH_FILE = Join-Path $env:LOCALAPPDATA 'RoadSense\api-data\dev-access.json'
$env:ROADSENSE_API_DATA_DIR = Join-Path $env:LOCALAPPDATA 'RoadSense\api-data'
& $apiPython -m uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --limit-concurrency 16 --timeout-keep-alive 5 --no-access-log
```

Eksik/geçersiz kimlik yapılandırmasında başlangıç reddedilir. Health ve OpenAPI
dışında bütün endpointler `Authorization: Bearer <yerel-token>` ister. Kullanıcı,
rol ve domain yetkisi sunucu yapılandırmasından gelir; istemci bunları atayamaz.
Reviewer yalnız izinli domainlerde inceleme yapabilir. Başkasının oturumu/işi
normal kullanıcı için 404'tür. Host/CORS kısıtları yetkilendirmenin yerine geçmez.

Sunucuyu `0.0.0.0` üzerinde açmayın. M2 internet/LAN veya gerçek kullanıcı verisiyle
üretim dağıtımı için tasarlanmamıştır. `--reload`/çoklu Uvicorn worker kullanmayın;
aynı veri alanına ikinci servis ayrıca işletim sistemi kilidiyle reddedilir.

Health: `GET http://127.0.0.1:8000/health`.
OpenAPI request şemaları: `GET http://127.0.0.1:8000/openapi.json`.
Harici CDN kullanan Swagger/ReDoc sayfası açılmaz.

## REST sözleşmesi

`S=/v1/sessions/{sessionId}`, `R=S/runs/{runId}` kısaltmaları aşağıdaki tablo içindir.
JSON işlemlerinde `Content-Type: application/json`, içerikte image/jpeg veya
image/png kullanılır. Bütün yanıtlar no-store/nosniff taşır.

| Metot / yol | İstek | Başarılı yanıt |
| --- | --- | --- |
| GET /health | Yok; kimliksiz | 200: status, profile=TEST, resultLabel, contractVersion |
| POST /v1/sessions | commandId, sourceDomain, detectorKind, testProfile, clockId; REPLAY için videoId/videoDurationMs/samplingIntervalMs | 201: `{session, resultLabel}` |
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
2. Her örnek için benzersiz frameId ile ImageFrame kaydet. capturedAt VIDEO,
   clockId ve videoId oturumla eşleşir; valueMs kaynak video zamanıdır.
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

M1 kaynakları değiştirilmez. Sıkı sonlu sayılar, boolean reddi, JS güvenli sayı
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
karelerini değil. Grid dışındaki kare kabul edilmez; decoded video zamanı ve hedef
örnekleme zamanı M3'te eşleştirilmelidir. Kaynak zamanı HTTP yanıt saati değildir.

Konumsuz video olayı insan tarafından onaylanabilir; bu işlem VerifiedDamage
oluşturmaz. Harita doğrulaması açık konum/yöntem/belirsizlik ister; araç GPS'i hasar
konumuna kopyalanmaz. Orijinal aday kanıtı snapshot olarak korunur; güncel inceleme
durumu API zarfındaki reviewDecision'dır. VerifiedDamage ayrı kayıttır. İnsan onayı
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
