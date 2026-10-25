# RoadSense mobil demo haritası

Expo 57.0.30 / React Native 0.86.3 / React 19.2.3 korunur. Expo Doctor'ın
beklenen `expo ~57.0.31` uyarısı bilinen durumdur; bu görevde güncellenmez.

Başlangıç ekranındaki **Haritayı Aç**, Isparta merkezli yerel Leaflet belgesini
WebView'da açar. Üç işaretçi yalnızca temsili demo noktalarıdır; adminin sekiz
bildirimiyle ilişkili değildir. Haritaya dokunma seçimi geçici ekran state'idir;
geri dönüşte silinir. GPS/konum izni, backend veya kalıcı kayıt yoktur.

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
2048 UTF-16 kod birimi sınırından sonra katı v1 JSON şeması ve sonlu koordinat
aralıkları doğrulanır. Bilinmeyen mesajlar yok sayılır; içerik kod yapılmaz.
RN'den haritaya komut/injection kullanılmaz. Dış üst sayfa gezinmesi engellenir;
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
