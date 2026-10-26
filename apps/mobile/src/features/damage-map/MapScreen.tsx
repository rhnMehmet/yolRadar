import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, BackHandler, Linking, Modal, Platform, Pressable, SafeAreaView,
  ScrollView, StatusBar as NativeStatusBar, StyleSheet, Text, View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { WebView } from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import type { Coordinates } from '@roadsense/shared';
import { createMapDocument } from './mapDocument.ts';
import { ATTRIBUTION_URLS, getAttributionUrl, isDocumentNavigationAllowed, parseMapMessage, serializeMapCommand } from './mapBridge.ts';
import type { MapCommand, TileState } from './mapBridge.ts';
import { DEMO_MAP_NOTICE } from './demoMapMarkers.ts';
import { THIRD_PARTY_NOTICES } from './generated/leafletAssets.ts';
import { useForegroundLocation } from '../location/useForegroundLocation.ts';

const tileError = 'Harita döşemeleri yüklenemedi. Bağlantınızı kontrol edip yeniden deneyin.';
const stateLabels: Record<TileState, string> = {
  loading: 'Harita döşemeleri yükleniyor…',
  ready: 'Harita hazır. Nokta seçmek için haritaya dokunun.',
  'partial-error': 'Bazı döşemeler yüklenemedi. Bağlantınızı kontrol edin.',
  error: tileError,
};

export function MapScreen({ onBack }: { onBack: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [tileState, setTileState] = useState<TileState>('loading');
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Coordinates | null>(null);
  const [licencesOpen, setLicencesOpen] = useState(false);
  const [linkError, setLinkError] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const webview = useRef<WebView>(null);
  const sessionSeed = useRef(`roadsense-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const session = `${sessionSeed.current}-${attempt}`;
  const sequence = useRef(0);
  const sentCenter = useRef(0);
  const location = useForegroundLocation(mapReady && !licencesOpen && !error);
  const generation = useRef(0);
  const active = useRef(true);
  const initializationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const source = useMemo(() => ({ html: createMapDocument(session) }), [session]);

  useEffect(() => {
    if (!mapReady) return;
    const envelope = { v: 2 as const, session, seq: ++sequence.current };
    const fix = location.freshFix;
    const command: MapCommand = fix ? {
      ...envelope, type: 'location-update', latitude: fix.latitude, longitude: fix.longitude,
      accuracyMetres: fix.accuracyMetres, timestampMs: fix.timestampMs,
      center: location.state.centerRequest > sentCenter.current,
    } : { ...envelope, type: 'location-clear' };
    const payload = serializeMapCommand(command);
    if (payload) {
      webview.current?.postMessage(payload);
      if (fix) sentCenter.current = location.state.centerRequest;
    }
  }, [mapReady, session, location.freshFix, location.state.centerRequest]);

  function clearInitializationTimer() {
    if (initializationTimer.current !== null) clearTimeout(initializationTimer.current);
    initializationTimer.current = null;
  }

  useEffect(() => {
    active.current = true;
    initializationTimer.current = setTimeout(() => {
      if (!active.current) return;
      setMapReady(false);
      setTileState('error');
      setError('Harita başlatılamadı. Yeniden deneyin veya önceki ekrana dönün.');
    }, 15000);
    return () => { active.current = false; clearInitializationTimer(); };
  }, [attempt]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => { location.stop(); onBack(); return true; });
    return () => subscription.remove();
  }, [onBack]);

  function retry() {
    location.stop();
    setMapReady(false);
    sequence.current = 0;
    sentCenter.current = location.state.centerRequest;
    generation.current += 1;
    setSelected(null);
    setError(null);
    setTileState('loading');
    setAttempt(generation.current);
  }

  function fail(message: string) {
    if (!active.current || generation.current !== attempt) return;
    clearInitializationTimer();
    location.stop();
    setMapReady(false);
    setTileState('error');
    setError(message);
  }

  function handleMessage(event: WebViewMessageEvent) {
    if (!active.current || generation.current !== attempt) return;
    const message = parseMapMessage(event.nativeEvent.data, session);
    if (!message) return;
    switch (message.type) {
      case 'map-ready': clearInitializationTimer(); setMapReady(true); break;
      case 'tiles-state':
        setTileState(message.state);
        setError(message.state === 'error' ? tileError : null);
        if (message.state === 'error') { location.stop(); setMapReady(false); }
        break;
      case 'point-selected':
        setSelected({ latitude: message.latitude, longitude: message.longitude });
        break;
      case 'map-error':
        fail(message.code === 'tile-timeout' ? tileError : 'Harita başlatılamadı. Yeniden deneyin veya geri dönün.');
        break;
    }
  }

  function openAttribution(url: string) {
    const allowed = getAttributionUrl(url);
    if (allowed) void Linking.openURL(allowed).catch(() => { if (active.current) setLinkError(true); });
  }

  return (
    <SafeAreaView style={styles.screen}>
      <StatusBar style="dark" />
      <View style={styles.content}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel="Başlangıç ekranına dön" onPress={() => { location.stop(); onBack(); }} style={styles.backButton}>
            <Text style={styles.backText}>‹ Geri</Text>
          </Pressable>
          <View style={styles.heading}>
            <Text accessibilityRole="header" style={styles.title}>Isparta haritası</Text>
            <Text style={styles.subtitle}>RoadSense · Demo</Text>
          </View>
        </View>
        <View style={styles.notice}><Text style={styles.noticeText}>{DEMO_MAP_NOTICE}</Text></View>
        <Text accessibilityLiveRegion="polite" style={[styles.status, tileState !== 'ready' && tileState !== 'loading' && styles.errorText]}>
          {error ?? stateLabels[tileState]}
        </Text>
        <View style={styles.mapFrame}>
          <WebView
            ref={webview}
            key={attempt}
            source={source}
            originWhitelist={['*']}
            onMessage={handleMessage}
            onShouldStartLoadWithRequest={(request) => {
              if (isDocumentNavigationAllowed(request.url)) return true;
              if (request.navigationType === 'click') openAttribution(request.url);
              return false;
            }}
            onOpenWindow={() => { /* External windows are deliberately not opened. */ }}
            onError={() => fail('Harita görüntülenemedi. Yeniden deneyin veya geri dönün.')}
            onHttpError={() => fail(tileError)}
            onContentProcessDidTerminate={() => fail('Harita işlemi durdu. Yeniden deneyin.')}
            onRenderProcessGone={() => fail('Harita işlemi durdu. Yeniden deneyin.')}
            applicationNameForUserAgent="RoadSense/1.0 (+https://github.com/rhnMehmet/yolRadar)"
            javaScriptEnabled
            javaScriptCanOpenWindowsAutomatically={false}
            geolocationEnabled={false}
            domStorageEnabled={false}
            allowFileAccess={false}
            allowFileAccessFromFileURLs={false}
            allowUniversalAccessFromFileURLs={false}
            mixedContentMode="never"
            thirdPartyCookiesEnabled={false}
            sharedCookiesEnabled={false}
            cacheEnabled
            incognito={false}
            bounces={false}
            scrollEnabled={false}
            automaticallyAdjustContentInsets={false}
            allowsBackForwardNavigationGestures={false}
            style={styles.webview}
          />
          {tileState === 'loading' && <View pointerEvents="none" style={styles.loading}><ActivityIndicator color="#0B6B59" /><Text style={styles.loadingText}>Yükleniyor…</Text></View>}
          {(tileState === 'error' || tileState === 'partial-error') && (
            <View style={styles.retryBar}>
              <Pressable accessibilityRole="button" onPress={retry} style={styles.retryButton}><Text style={styles.retryText}>Yeniden dene</Text></Pressable>
            </View>
          )}
        </View>
        <View style={styles.locationCard}>
          <View style={styles.locationButtons}>
            <Pressable accessibilityRole="button" disabled={!mapReady || (location.busy && location.state.mode !== 'tracking')}
              onPress={location.locate} style={({ pressed }) => [styles.locationButton, (!mapReady || (location.busy && location.state.mode !== 'tracking')) && styles.disabled, pressed && styles.pressed]}>
              <Text style={styles.locationButtonText}>Konumuma Git</Text>
            </Pressable>
            <Pressable accessibilityRole="button" disabled={!mapReady && !location.busy}
              onPress={location.busy ? location.stop : location.startTracking}
              style={({ pressed }) => [styles.locationButton, location.busy && styles.stopButton, !mapReady && !location.busy && styles.disabled, pressed && styles.pressed]}>
              <Text style={styles.locationButtonText}>{location.busy ? 'Takibi Durdur' : 'Konum Takibini Başlat'}</Text>
            </Pressable>
          </View>
          <Text accessibilityLiveRegion="polite" style={styles.locationStatus}>{location.state.message}</Text>
          {location.state.fix && <Text style={styles.locationStatus}>
            Mavi işaretçi · {location.freshFix ? 'Son ölçüm' : 'Eski ölçüm; işaretçi gizlendi'}: {new Date(location.state.fix.timestampMs).toLocaleTimeString('tr-TR')}
            {' · '}{location.state.fix.accuracyMetres === null ? 'Doğruluk bilinmiyor' : `±${Math.round(location.state.fix.accuracyMetres)} m`}
            {location.state.fix.approximate ? ' · Yaklaşık konum' : ''}
          </Text>}
          {location.state.phase === 'denied' && !location.state.canAskAgain && <Pressable accessibilityRole="button"
            onPress={() => { void Linking.openSettings().catch(() => { if (active.current) setLinkError(true); }); }} style={styles.footerButton}>
            <Text style={styles.footerText}>Konum izni için Ayarlar'ı aç</Text>
          </Pressable>}
          <Text style={styles.privacyText}>Konum kaydedilmez veya RoadSense sunucusuna gönderilmez. Konumunuza giderken görünen yaklaşık bölge ve bağlantı bilgileriniz OSM döşeme sağlayıcısına görünür olabilir.</Text>
        </View>
        <View style={styles.selection}>
          <Text style={styles.selectionTitle}>Seçilen nokta</Text>
          <Text selectable style={styles.coordinateText}>{selected
            ? `Enlem: ${selected.latitude.toFixed(6)}   Boylam: ${selected.longitude.toFixed(6)}`
            : 'Koordinat seçmek için haritanın boş bir yerine dokunun.'}</Text>
          <Text style={styles.selectionHint}>Seçim yalnızca bu ekranda tutulur; gönderilmez veya kaydedilmez.</Text>
        </View>
        <View style={styles.footer}>
          <Pressable accessibilityRole="link" onPress={() => openAttribution(ATTRIBUTION_URLS[0])} style={styles.footerButton}><Text style={styles.footerText}>© OpenStreetMap contributors</Text></Pressable>
          <Pressable accessibilityRole="button" onPress={() => { location.stop(); setLicencesOpen(true); }} style={styles.footerButton}><Text style={styles.footerText}>Lisanslar</Text></Pressable>
        </View>
        {linkError && <Text style={styles.errorText}>Bağlantı veya Ayarlar açılamadı.</Text>}
      </View>
      <Modal visible={licencesOpen} animationType="slide" onRequestClose={() => setLicencesOpen(false)}>
        <SafeAreaView style={styles.screen}>
          <Pressable accessibilityRole="button" onPress={() => setLicencesOpen(false)} style={styles.backButton}><Text style={styles.backText}>‹ Haritaya dön</Text></Pressable>
          <ScrollView contentContainerStyle={styles.licences}><Text selectable>{THIRD_PARTY_NOTICES}</Text></ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F7FA', paddingTop: Platform.OS === 'android' ? (NativeStatusBar.currentHeight ?? 24) : 0 },
  content: { flex: 1, paddingHorizontal: 12, gap: 7 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  backButton: { minHeight: 44, minWidth: 64, paddingHorizontal: 12, justifyContent: 'center' },
  backText: { color: '#0B6B59', fontSize: 17, fontWeight: '700' },
  heading: { flex: 1 },
  title: { fontSize: 20, fontWeight: '700', color: '#152E3A' },
  subtitle: { fontSize: 12, color: '#526572' },
  notice: { backgroundColor: '#FFF4D9', borderRadius: 10, padding: 9 },
  noticeText: { fontSize: 12, lineHeight: 17, color: '#624400' },
  status: { fontSize: 12, lineHeight: 17, color: '#405665' },
  errorText: { color: '#92351C', fontSize: 12, lineHeight: 17 },
  mapFrame: { flex: 1, minHeight: 160, borderRadius: 14, overflow: 'hidden', borderWidth: 1, borderColor: '#D6E1DC' },
  webview: { flex: 1, backgroundColor: '#E7EDE8' },
  loading: { position: 'absolute', top: 12, alignSelf: 'center', flexDirection: 'row', gap: 8, padding: 10, backgroundColor: '#FFFFFF', borderRadius: 10 },
  loadingText: { color: '#183F32', fontSize: 13 },
  retryBar: { position: 'absolute', top: 12, right: 12 },
  retryButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 16, backgroundColor: '#0B6B59', borderRadius: 10 },
  retryText: { color: '#FFFFFF', fontWeight: '700' },
  selection: { backgroundColor: '#FFFFFF', borderRadius: 10, padding: 10, gap: 4 },
  selectionTitle: { fontSize: 13, fontWeight: '700', color: '#152E3A' },
  coordinateText: { fontSize: 12, lineHeight: 18, color: '#183F32', fontVariant: ['tabular-nums'] },
  selectionHint: { fontSize: 10, lineHeight: 15, color: '#526572' },
  locationCard: { backgroundColor: '#FFFFFF', borderRadius: 10, padding: 8, gap: 5 },
  locationButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  locationButton: { flexGrow: 1, flexBasis: 140, minHeight: 44, justifyContent: 'center', alignItems: 'center', padding: 8, borderRadius: 8, backgroundColor: '#1758AD' },
  locationButtonText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700', textAlign: 'center' },
  stopButton: { backgroundColor: '#963B22' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.75 },
  locationStatus: { fontSize: 11, lineHeight: 16, color: '#183F32' },
  privacyText: { fontSize: 10, lineHeight: 14, color: '#526572' },
  footer: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  footerButton: { minHeight: 36, paddingHorizontal: 4, justifyContent: 'center' },
  footerText: { fontSize: 11, color: '#405665', textDecorationLine: 'underline' },
  licences: { padding: 20 },
});
