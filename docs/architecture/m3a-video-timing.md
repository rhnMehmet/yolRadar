# M3A — Planlanan örnek ile gerçek video zamanı

Bu belge yalnız TEST_SYNTHETIC prototip sözleşmesini tanımlar. Gerçek video
decode/codec, tarayıcı scheduler veya YOLO doğrulaması değildir; M3B ekranı yoktur.

## Açık sürüm geçişi

- `CONTRACT_VERSION=1` varsayılanı korunur. Eski oturumlar ve 89 M1/M2 fixture
  aynı kuralları kullanır. v1 sonuçları tam-grid ister (mevcut 0.000001 ms sayısal
  toleransıyla); `plannedSampleTimestampMs` kabul etmez. 1001 ms v1 için reddedilir.
- Video istemcisi `POST /v1/sessions` isteğinde açıkça `contractVersion: 2` seçer.
  v2 yalnız REPLAY içindir. REAL/SIM v1 kalır. REST `/v1` yol öneki HTTP API
  sürümüdür; gövdedeki wire sözleşme sürümünden bağımsızdır.
- v2 ImageFrame ve FrameAnalysisOutcome için `plannedSampleTimestampMs`
  zorunludur. Eksik/null/string/boolean hedef kabul edilmez. v1'e veya v2'ye gizli
  fallback yoktur. Scope eşleşmesi sürümü de içerir; run boyunca sürüm değişmez.
- Eski SQLite JSON kayıtları yerinde kalır. Şema/saklama migration'ı gerekmez.
  Eski oluşturma commandId fingerprint'i korunur; açık v1 ile sürümün atlanması
  eşdeğerdir. v2 ayrı payload kimliğidir. Eski oturumu yükseltmek yerine yeni
  v2 oturum oluşturulur. Yeni run aynı sözleşme sürümünü korur.

## İki farklı zaman

`ImageFrame.capturedAt.valueMs`, VIDEO saatindeki gerçek decoded sunum zamanıdır
(PTS). `FrameAnalysisOutcome.videoTimestampMs` aynı gerçek zamanı taşır. Yeni bir
actualVideoTimestampMs alias'ı yoktur. Observation zamanı kare zamanıyla birebir
eşleşir; timeline min/max PTS'yi kullanır. HTTP/duvar saati veya oynatıcı ilerlemesi
bu alanların yerine geçmez. PTS yuvarlanmaz.

`plannedSampleTimestampMs = k * samplingIntervalMs`, `k >= 0`, süre bitiminden
küçük olan **tam** grid hedefidir. Kapsam hedef yuvaya yazılır; örneğin hedef 1000,
PTS 1001.001 ise olay işareti 1001.001'de, kapsam aralığı [1000,2000) içindedir.
Bu aralık tüm decoded karelerin analiz edildiği anlamına gelmez.

v2 kabul kuralı, `p` hedef, `a` gerçek PTS, `i` aralık, `d` süre olmak üzere:

```text
p <= a <= p + 100 ms
a < min(p + i, d)
```

100 ms üst sınırı dahildir; sonraki yuva ve video bitimi hariçtir. Hedefin
öncesindeki kare kabul edilmez. M3B, hedefte/sonrasında gelen decoded kareyi
seçmeli; 100 ms içinde uygun kare yoksa o yuvayı başarı saymamalıdır. Düşük FPS,
VFR boşluğu veya tarayıcı gecikmesi kapsam boşluğu bırakabilir. Bu kasıtlı sınır,
gerçek PTS'yi grid'e yuvarlamaktan ve uzaktaki kareyi hedefe yazmaktan kaçınır.
29.97 FPS gibi kesirli PTS ve değişken aralıklar pencere içindeyse kabul edilir.

## Kimlik, idempotency ve geç cevaplar

Bir yuvaya farklı frameId veya değişmiş PTS atanamaz (API 409). Aynı frameId'nin
başka yuvada kullanımı metadata çatışmasıdır. Aynı gerçek PTS farklı yuvaları
dolduramaz; kabul pencereleri kesişmez ve kapsam ayrıca tekrarları kontrol eder.
Tam aynı sonuç tekrarları kapsamı artırmaz; status/PTS/hedef çelişkisi reddedilir.
Aynı metadata ve aynı içerik/MIME aynı job döndürür; değişmiş byte'lar 409'dur.

Seek/restart yeni runId gerektirir. Eski run'a kayıt/gönderim 409'dur; iptal veya
run dönüşünden sonra gelen worker sonucu observation/event yazamaz. M3B ayrıca
istemcide generation ve AbortController ile eski cevabın çizilmesini önlemelidir.
Video sonu `completed` kanıtı değildir; tamamlanmış kapsam ayrıca zorunludur.

TS ve Python aynı `contracts/fixtures/m3a-video-timing.json` senaryolarını okur.
API testleri gerçek worker, metadata/byte tekrarları, yuva çatışması, eski run ve
iptal sonrası geç sonucu ayrıca sınar. Bu testler gerçek MP4/VFR tarayıcı testi
veya fiziksel hasar takibi yerine geçmez.

## Geri alma

Commit edilmemiş M3A kaynaklarını inceleyerek önceki sürüme geri almak ve önceki
Python ortamını kullanmak mümkündür; otomatik reset uygulanmaz. Eski ortam,
veriler ve kimlikler taşınmaz/silinmez. v2 ile oluşan ayrı TEST verisini eski
uygulamaya okutmayın; v1 otomatik downgrade edilmez. Eski 8000 servisi M3A kodunu
yüklemiş sayılmaz; ayrı 8001 servisi yeni kodu doğrulamak içindir.
