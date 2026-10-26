# RoadSense mobil demo haritası

Expo 57.0.30 / React Native 0.86.3 / React 19.2.3 korunur. Expo Doctor'ın
beklenen `expo ~57.0.31` uyarısı bilinen durumdur; bu görevde güncellenmez.

Başlangıç ekranındaki **Haritayı Aç**, Isparta merkezli yerel Leaflet belgesini
WebView'da açar. Üç işaretçi yalnızca temsili demo noktalarıdır; adminin sekiz
bildirimiyle ilişkili değildir. Haritaya dokunma seçimi geçici ekran state'idir;
geri dönüşte silinir. GPS yalnızca kullanıcı düğmeye bastığında foreground
izniyle kullanılır; backend veya kalıcı konum kaydı yoktur.

## Komutlar (depo kökünden)

```powershell
npm.cmd run map:assets --workspace=mobile
npm.cmd run map:assets:check --workspace=mobile
npm.cmd run test:map --workspace=mobile
npm.cmd run typecheck
npm.cmd test
npm.cmd run lint --workspace=admin
npm.cmd run build:admin
npm.cmd run dev:mobile
```

Leaflet yalnızca `scripts/prepare-map-assets.mjs` tarafından yerel paketinden
okunur; RN ortamında harita kütüphanesi olarak import edilmez. Sabit 1.9.4
sürümü ve resmî JS/CSS SHA-256 değerleri kontrol edilir. PNG'ler paketlenir.
Üretilmiş kaynak ve THIRD_PARTY_NOTICES.txt birlikte tutulur; değişiklik sonrası
varlıkları yeniden üretin. prestart/pretypecheck yalnızca bütünlük kontrolüdür.

## Bağımlılık yerleşimi

WebView 13.16.1 mobil node_modules içindedir. Mobil, Expo, RN ve WebView aynı
mobil React 19.2.3 kopyasını; admin ve React DOM kök React 19.3.1 kopyasını
kullanmalıdır. Yeni paket eklemeden önce izole lockfile karşılaştırması yapın.
Varsayılan hoisted kurulum bu ayrımı değiştirebilir. Bu görevde doğrulanan komut:

```powershell
npm.cmd install --workspace=mobile --save-exact react-native-webview@13.16.1 leaflet@1.9.4 --install-strategy=nested --prefer-dedupe --strict-peer-deps --ignore-scripts --no-audit --no-fund
```

Beklenen paket farkı: kaldırılan 0 yol, eklenen yalnızca mobil WebView; mobil
workspace metadata'sına iki direct bağımlılık. Mevcut paket sürümleri değişmez.
Force/legacy-peer-deps, kontrolsüz override veya audit fix kullanılmaz.

## İçerik, mesajlar ve bağlantı

Yerel script hash'li CSP dış script/iframe/bağlantı isteklerini engeller;
yalnızca HTTPS OSM döşeme görselleri ve yerel PNG verileri açıktır. Leaflet'in
dinamik stilleri için inline stil izni vardır, inline script/eval izni yoktur.
2048 UTF-16 kod birimi sınırından sonra katı v2 JSON şeması ve sonlu koordinat
aralıkları doğrulanır. Bilinmeyen mesajlar yok sayılır; içerik kod yapılmaz.
RN'den haritaya yalnızca doğrulanmış location-update/location-clear verileri
WebView postMessage ile gönderilir; injection/eval kullanılmaz. Belge session
kimliği ve artan sıra numarası eski/çift mesajları ayırır. Dış gezinme engellenir;
yalnızca kullanıcı tıklamasıyla sabit atıf adresleri sistem tarayıcısına açılır.

Yerel Leaflet ağ gerektirmez; yeni OSM döşemeleri bağlantı gerektirir. HTML'in
yüklenmesi döşemelerin yüklendiği anlamına gelmez. Kısmi/tam döşeme hatası,
15 saniyelik zaman aşımı ve WebView süreç hatası ayrı yönetilir. Yeniden dene
belgeyi yeniden oluşturur ve seçimi siler; otomatik istek döngüsü yoktur.
Normal HTTP cache açıktır; offline/toplu indirme veya ön yükleme yapılmaz.
RoadSense User-Agent tanıtımı ve görünür OSM atfı korunur.

- [OSM döşeme politikası](https://operations.osmfoundation.org/policies/tiles/)
- [Leaflet 1.9.4](https://leafletjs.com/download.html)
- [SDK 57 WebView](https://docs.expo.dev/versions/v57.0.0/sdk/webview/)

## Gerçek cihaz doğrulaması

Otomatik testler mesaj sınırını, yerel belgeyi ve runtime olaylarını sınar;
WebView/native modül, gerçek döşeme yüklemesi veya dokunmatik hareket kanıtı
değildir. iPhone 16 / Expo Go 57.0.9 üzerinde şu liste ayrıca doğrulanmalıdır:

- Açılış, Haritayı Aç, Isparta merkezi ve gerçek döşemeler.
- Üç demo işaretçisi ve üç popup; +/−, pinch zoom ve sürükleme.
- Boş alana dokunma, enlem/boylamın doğru sırayla gösterilmesi.
- Geri dönüş, ikinci açılış ve seçimin temizlenmesi.
- Bağlantı kesilince anlaşılır hata ve bağlantı sonrası kullanıcı tetikli deneme.
- Küçük ekran/yatay görünümde popup, atıf ve kontrollerin görünürlüğü.

22 Ekim 2026 gerçek iPhone 16 / Expo Go testi, kullanıcı doğrulaması:

| Kontrol | Sonuç |
|---|---|
| RoadSense, Haritayı Aç, harita döşemeleri ve üç işaretçi | Doğrulandı |
| Üç popup, +/−, pinch zoom ve sürükleme | Doğrulandı |
| Koordinat seçimi, geri dönüş, ikinci açılış ve seçimin temizlenmesi | Doğrulandı |
| Bağlantı hatası ve bağlantı sonrası yeniden deneme | Doğrulandı |
| Dikey ekran görünürlüğü, lisans ekranı ve yatay taşma olmaması | Doğrulandı |
| Farklı cihaz boyutları ve Android gerçek cihaz | Test edilmedi |

Fast Refresh anahtarı önceki ekran görüntüsünde açık; ayrı kaynak değişikliğiyle
canlı yenileme testi yapılmış sayılmaz. app.json içindeki mevcut dikey yön
korunur; yatay yön testi yapılmadı.

## Görev 6B.2 — kullanıcı başlatmalı konum

Eklenen tek paket expo-location 57.0.22'dir. Ön inceleme ve gerçek kurulumda
nested + prefer-dedupe + strict-peer-deps ile yalnızca mobil expo-location yolu
eklendi; eski paket sürümü/integrity kayıtları ve iki React kopyası korundu:

```powershell
npm.cmd install expo-location@57.0.22 --save-exact --workspace=mobile --install-strategy=nested --prefer-dedupe --strict-peer-deps --ignore-scripts --no-audit --no-fund
```

- Açılışta izin istenmez. Konumuma Git, ilk geçerli ölçümde kapanan tek seferlik
  aboneliktir; Konum Takibini Başlat açıkça sürekli foreground izlemeyi başlatır.
- Takibi Durdur, geri dönüş, lisans ekranı, kritik WebView/döşeme hatası,
  AppState inactive/background ve izin/servis kaybı aboneliği temizler.
  İzin diyaloğundaki geçici inactive durumu, yalnızca hâlen geçerli kullanıcı
  işlemi için active'e dönüşte devam edebilir. Background dönüşü otomatik başlamaz.
- Geç dönen native abonelik hemen kaldırılır; önceki aboneliğin kurulumu
  tamamlanmadan yeni native abonelik açılmaz. Konum geçmişi/rota izi tutulmaz.
- High doğruluk isteği, 10 m mesafe eşiği ve Android'de 5000 ms zaman aralığı
  kullanılır. Bunlar gerçek hassasiyet veya iOS güncelleme aralığı garantisi değildir.
  İlk geçerli ölçüm için 20 saniye sınırı vardır. 30 saniyeden eski ölçüm eski
  olarak gösterilir ve işaretçi gizlenir. Sabit dururken olay gelmemesi tek
  başına GPS arızası sayılmaz. Aşırı sıçrama zaman/mesafe/belirsizlikle filtrelenir.
- Mavi işaretçi ve doğruluk dairesi demo/seçim katmanlarından ayrıdır. Kamera
  yalnızca Konumuma Git ile merkezlenir; takip elle sürüklemeyi geri almaz.
- Konum yalnızca geçici bellektedir; backend, analytics, log veya storage'a
  yazılmaz. Konuma merkezlenmiş OSM döşeme istekleri sağlayıcıya yaklaşık alanı
  ve bağlantı bilgilerini gösterebilir. Atıf ve HTTP cache korunur.
- app.json Türkçe WhenInUse metni gelecekteki kendi native build'imiz içindir.
  Expo Go'nun sistem izin penceresi kendi native yapılandırmasını kullanır.
  Always/background, motion ve Android foreground service etkinleştirilmez.

Konum katmanı: locationTypes/policy → provider bağımsız locationService →
expoLocationAdapter → useForegroundLocation → MapScreen. Node testleri gerçek
GPS/native abonelik çalıştırmaz; sentetik ölçümler ve sahte saat/provider kullanır.
Mevcut test komutu dört test dosyasını da çalıştırır:

```powershell
npm.cmd run test:map --workspace=mobile
```

25 Ekim 2026 Görev 6B.2 gerçek iPhone 16 testleri, kullanıcı doğrulaması:

| Kontrol | Sonuç |
|---|---|
| RoadSense, harita, üç demo ve GPS düğmeleri | Doğrulandı |
| Konumuma Git, mavi işaretçi, merkezleme, doğruluk ve son ölçüm | Doğrulandı |
| Sistem izin penceresi ve izin sonrası konum alma | Doğrulandı |
| Genel servis açık, Expo Go izni Asla | İzin kapalı uyarısı ve Ayarlar bağlantısı doğrulandı |
| Takibi başlatma ve durdurma | Doğrulandı |
| Geri dönüş, temiz yeniden açılış ve background dönüşünde otomatik başlamama | Doğrulandı |
| Üç popup, +/−, pinch, sürükleme, seçim, lisanslar, atıf ve taşma olmaması | Yeniden doğrulandı |
| Genel Konum Servisleri kapalı | Düzeltme sonrası servis kapalı uyarısı cihazda doğrulandı; çökme yok |
| Servis yeniden açılınca Konumuma Git | Konumun yeniden geldiği doğrulandı |
| Takipte elle sürükleme sonrası kameranın yerinde kalması | Sabit dururken 15 saniyelik cihaz kontrolünde doğrulandı |
| Gerçek hareketle konum güncellemesi | Kullanıcı hareket testini yapamıyor; test edilmedi |
| Yaklaşık izin, gerçekten zayıf sinyal, Android ve farklı ekran boyutları | Test edilmedi |

Önceki ortam beyanı iOS 18 / App Store Expo Go 57.0.9'dur; sürüm bu oturumda
yeniden okunmadı. Konum politikası/servis ve v2 köprü testleri sentetik ölçümler
kullanır; hareketle GPS güncellemesinin gerçek cihaz kanıtı değildir. Önceki
6B.1 bağlantı kesilmesi testi bu görevde yeniden yapılmış sayılmaz. Testleri
sabit güvenli ortamda veya yürüyerek yapın; sürüş sırasında telefon kullanımı
gerektiren test yok.

Expo Doctor 20/21 ve mevcut mobil audit/Zod uyarıları çözülmüş değildir.
Rota/navigasyon, background takip, hasara yaklaşma, YOLO ve backend eklenmedi.
