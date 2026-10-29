# M1 — Ortak sözleşmeler ve video analiz politikaları

Bu aşama yalnızca `packages/shared` içinde saf TypeScript sözleşmeleri ve testler
sağlar. Backend, depolama, ağ isteği, kamera, oynatıcı, model veya ses motoru içermez.
Mevcut `DamageReport`, harita ve GPS API'leri korunur. Yeni sözleşmeler wire sürümü
`contractVersion: 1` ile ayrıca dışa aktarılır; eski kayıtlar otomatik dönüştürülmez.

## Kaynak, detektör ve güven sınırı

| Alan | Anlamı |
| --- | --- |
| `REAL` | Gerçek zamanda edinilen kaynak |
| `SIM` | Simülasyon saati ve metre birimli yerel dünya koordinatları |
| `REPLAY` | Kayıtlı video; o anda YOLO ile analiz edilmesi mümkündür |
| `TEST` | Sentetik/test detektörü; gösterim etiketi `TEST_SYNTHETIC` |
| `YOLO` | YOLO detektör kimliği; gösterim etiketi `YOLO_RESULT` |

Kaynak ve detektör birbirinden bağımsızdır. `resultLabel()` etiketi detektörden
türetir; REPLAY otomatik olarak TEST sayılmaz. YOLO kimlikli sentetik birim testi
model çalıştırıldığı anlamına gelmez. Test sonucu gerçek YOLO çıkarımı diye sunulamaz.

`sessionId`, `runId`, domain ve sürüm tüm ilişkili kayıtlarla eşleşir. Video
değiştirme, ileri sarma, başa dönme veya yeni analiz girişimi yeni `runId` gerektirir.
Duraklatmada aynı run ancak uçuşta kalan işler iptal/boşaltılıp doğru kareye bağlı
sonuçlar korunuyorsa devam edebilir; diğer durumda yeni run açılmalıdır. Bu dosyalar
oynatıcı yaşam döngüsünü uygulamaz; bu yükümlülük M2/M3'e aittir.

**TypeScript ve bu doğrulayıcılar tek başına güvenlik sınırı değildir.** Gelecekte
sunucu oturum/domain/detektör/classMap bilgisini kendisi belirlemeli, kullanıcıdan
gelen `approved`, `reviewerId`, `sourceDomain` veya TEST/YOLO iddialarına güvenmemelidir.
Her doğrulama önce oturum ve kaynak referansları üzerinde yapılır; aday doğrulayıcısı
önceden kare/classMap ile doğrulanmış gözlemleri, onay/uyarı doğrulayıcıları da önceden
doğrulanmış adayı bekler. Ham JSON doğrudan bu son aşamalara atlanmamalıdır.

REAL, SIM ve REPLAY sunucuda ayrı veri alanları ve medya alanları kullanmalıdır.
TEST sonuçları ayrıca işaretlenip gerçek üretim hasarlarından ayrılmalıdır; yalnız
domain filtresi yeterli değildir. İnsan onayı domain veya detektörü değiştirmez.
SIM/TEST onayı REAL/YOLO kaydı oluşturamaz. Yetkilendirme, boyut/kuyruk sınırları,
JSON şeması, atomik benzersizlik, içerik hash'iyle idempotency çatışması ve saklama
politikaları M2'de sunucuda tekrar uygulanacaktır. Burada taşıma katmanı yoktur.

## Modeller ve konum

| Model | Sorumluluk |
| --- | --- |
| `CaptureSession` | Aktif run, kaynak, saat örneği ve detektör kimliği |
| `ImageFrame` | Kare ID, boyut ve kaynak yakalama zamanı; medya gömülmez |
| `PositionSample` | Aynı oturum/saat içindeki araç konumu kanıtı |
| `DetectionObservation` | Tek kutu, raw class, doğrulanmış eşleme ve model skoru |
| `DamageCandidate` | Gözlem referansları, ayrı araç konumu ve hasar konum tahmini |
| `VerifiedDamage` | İnsan incelemesi ve bilinen/tahmin edilmiş hasar konumu |
| `AlertEvent` | Sınıf eşlemesi onaylı uyarı sözleşmesi; ses veya mesafe hesabı yok |
| `SimulationGroundTruth` | SIM dünyasındaki ayrı doğruluk kanalı; tespit sayılmaz |

`GPS` enlem/boylam ve `accuracyM` taşır. `SIM_LOCAL` koordinat sistemi ID'si,
`units: 'm'` ve x/y/z taşır. SIM verisi GPS biçiminde kabul edilmez. Koordinat ve
saat nesnelerinde karışık/ek alanlar reddedilir. Sayılar sonlu ve sınırlar içinde
olmalıdır; dönüştürülebilir sayısal metinler, NaN ve Infinity kabul edilmez.
Kaynağı UNKNOWN olan REPLAY konum taşıyamaz; bilinen kayıt kökeni REAL ise GPS,
SIM ise SIM_LOCAL kabul edilir. Bu kökeni sunucu doğrulamak zorundadır.

`damageLocation: { kind: 'UNKNOWN' }` geçerli bir adaydır. Araç GPS'i buraya
otomatik kopyalanmaz. Tahmin edilen konum açık yöntem ve belirsizlik taşır.
İnsan tarafından konumlandırma veya kalibre projeksiyon bu aşamada uygulanmaz.
Saatler DEVICE_MONOTONIC / SIMULATION / VIDEO olarak ayrıdır; `clockId` saat
örneğini ayırır. Farklı saatler doğrudan karşılaştırılmaz. GPS/kamera zaman
eşlemesi, UTC–monotonik dönüşüm ve yakalama gecikme belirsizliği M7 işidir.

`rawClassId` bir metindir; veri setinin sayısal indekslerine gömülü anlam verilmez.
`ClassMap` sürümlü ve onaylı olmalıdır. Eşlemesi onaysız/bilinmeyen gözlem yalnız
`unknown` sınıfıyla kabul edilir; kesin sınıf veya uyarı oluşturamaz. `other` da
ancak açık ve onaylı eşlemeyle kullanılabilir. Model skoru şiddet veya kesin
doğruluk yüzdesi değildir. Harita yaklaşım uyarısının yapısal doğrulaması ayrıca
`VerifiedDamage` gerektirir; yön, yol koridoru, mesafe, hız ve ses politikası içermez.

## Video olayları, tekilleştirme ve özet

`VideoAnalysisSession` kayıtlı kaynak olduğu için REPLAY/VIDEO kullanır. Kayıt
kökeni ayrı `recordingOrigin` alanıdır. `videoTimestampMs` videonun zamanıdır;
yanıtın sunucu saati veya oynatıcının yanıt geldiği andaki konumu değildir.

`createVideoTimelineEvent()` zaman ve skoru kaynak gözlemlerinden yeniden türetir.
Başlangıç zamanı en erken gözlem, son zaman en geç gözlem, skor en yüksek model
skorudur (kalibre olay olasılığı değildir). Referanslar sıralanır. Aynı olayın
birden çok karede görünmesi tek olay/işaret üretir. Aynı karede iki ayrı kutu tek
gruba sokulamaz; farklı sınıflar da sessizce birleştirilemez.

**Fiziksel hasarı izleyen tracker M1'de yoktur.** Birlikte verilen gözlem ID'leri,
gelecekteki tracker veya inceleyicinin açık gruplama kararıdır. Zaman yakınlığı
fiziksel kimlik kanıtı sayılmaz. Aynı fiziksel hasarın farklı geçişlerde yanlış
ayrılması veya aynı sınıftaki farklı hasarların yanlış birleşmesi M2/M7'de gerçek
model/veriyle ölçülecektir. `EXPLICIT_OBSERVATION_GROUPS` bu sınırı görünür kılar.

`acceptVideoTimelineEvent()` aktif run'a ait doğrulanmış olayı kabul eder.
Aynı olayın aynı içeriği tekrar gelirse duplicate döner; ID çatışması, başka olaya
atanmış gözlem, eski run/video, yanlış domain veya detektör reddedilir. Kayıtlı
olaylar burada immutable snapshot kabul edilir. Gelecekte incremental tracker
aynı olayı genişletecekse atomik, yetkili bir revizyon işlemi ayrıca tasarlanmalıdır;
aynı eventId'ye farklı gözlemleri sessizce eklemek desteklenmez.

Özet, kabul edilmiş ve incelemede reddedilmemiş olaylardan türetilir. Pending
olaylar geçicidir; toplam insan tarafından doğrulanmış hasar sayısı değildir.
`totalEvents`, `rawObservationCount` ve analiz edilen kare sayısı ayrıdır.
`unknown` ayrı sayılır. İlk/son hasar zamanı, sınıf dağılımı, model/classMap sürümü,
olay referansları, inceleme durumu ve detektör etiketi özette korunur.

## Analiz kapsamı ve iptal

Oturum `samplingIntervalMs` ile sabit bir örnekleme planı belirtir. Örnekler
0, interval, 2×interval ... süre bitmeden önceki son noktadır. En fazla 100.000
örnek yuvası kabul edilir. Her yuvanın tek, zamanıyla eşleşen kare ID'si ve
analyzed/skipped/failed sonucu bulunabilir; aynı sonuç tekrar sayılmaz, çatışma
reddedilir. Başarılı kare kanıtı bulunmayan sonuç özet üretemez.

Kapsam aralıkları bu sonuçlardan türetilir; kullanıcıdan "tamamlandı" aralığı
alınmaz. Atlanan/başarısız/hiç denenmeyen yuvalar boşluk olarak kalır. Oynatıcının
sona ulaşması kapsamı tamamlamaz. `complete` yalnız **beyan edilen örnekleme
planının** tamamını ifade eder; tüm video kareleri analiz edildi demek değildir.
`basis: 'DECLARED_SAMPLING_GRID'` ve interval arayüzde bu ayrımı korumalıdır.

Kare zamanı grid noktasıyla eşleşmelidir. Gerçek oynatıcı farklı bir decoded
timestamp üretirse M3'te frame-accurate örnekleme veya açık hedef/gerçek zaman
sözleşmesi değerlendirilmelidir; duvar saati ya da oynatma zamanı uydurulmamalıdır.
Örnekleme aralığı run içinde değişmez. Yeni plan yeni run gerektirir.

`completed` ancak tüm plan başarılıysa kabul edilir; aksi hâlde `partial`,
`cancelled` veya `failed` açıkça korunur. İptal edilmiş run'ın önceki kabul edilmiş
olayları kısmi raporda gösterilebilir; iptalden sonra gelen sonuçlar kabul edilmez.

## Test kapsamı ve devam sınırı

Yeni 30 sentetik test; domain/run/saat/koordinat/kutu/skor/eşleme doğrulamasını,
tekrarları, aday/onay ayrımını, olay gruplarını, eski sonuç reddini, kapsam
boşluklarını, özet tutarlılığını ve terminal durumları kapsar. Mevcut 8 ortak paket
testi korunur. Testlerde gerçek video, gerçek GPS veya model ağırlığı bulunmaz.

M2 önerisi: ayrı Python/FastAPI dizininde oturum/depolama, Detector protokolü,
açık TEST etiketli TestDetector, sınırlı kare işleri, sunucu izolasyonu ve bu TS
fixture'larına denk sözleşme testleri. Python bağımlılıkları ve tam dosya kapsamı
ayrı onay gerektirir. M3 video ekranı, M4 rapor/inceleme, M5 kamera/manuel fotoğraf,
M6 ses, M7 entegrasyon, M8 sergi; M9 eğitimli model entegrasyonudur. Bu işlerin
hiçbiri M1 kapsamında uygulanmaz. Mobil video ayrı fizibilite/onay konusudur.
