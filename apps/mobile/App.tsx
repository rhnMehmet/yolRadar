import { StatusBar } from 'expo-status-bar';
import { APP_NAME } from '@roadsense/shared';
import { useState } from 'react';
import { MapScreen } from './src/features/damage-map/MapScreen';
import {
  Platform,
  Pressable,
  ScrollView,
  StatusBar as NativeStatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

const platformLabels = ['Android desteği', 'iOS desteği', 'Expo + React Native'];

export default function App() {
  const { width } = useWindowDimensions();
  const [mapOpen, setMapOpen] = useState(false);

  if (mapOpen) return <MapScreen onBack={() => setMapOpen(false)} />;

  return (
    <View style={styles.screen}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View style={styles.content}>
          <View style={styles.brandMark} accessible={false}>
            <View style={styles.roadLine} />
            <View style={styles.roadLine} />
            <View style={styles.roadLine} />
          </View>

          <Text style={styles.eyebrow}>YOLLAR İÇİN BİRLİKTE</Text>
          <Text
            accessibilityRole="header"
            style={[styles.title, width < 360 && styles.compactTitle]}
          >
            {APP_NAME}
          </Text>
          <Text style={styles.subtitle}>
            Yapay Zekâ Destekli Akıllı Yol Hasarı Haritası
          </Text>

          <View style={styles.statusCard}>
            <View style={styles.statusHeading}>
              <View style={styles.statusDot} />
              <Text style={styles.statusLabel}>İLK ADIM TAMAM</Text>
            </View>
            <Text style={styles.statusText}>
              Mobil uygulama geliştirme ortamı hazır.
            </Text>
          </View>

          <View style={styles.platforms}>
            {platformLabels.map((label) => (
              <View key={label} style={styles.platformChip}>
                <Text style={styles.platformLabel}>{label}</Text>
              </View>
            ))}
          </View>

          <Pressable accessibilityRole="button" accessibilityHint="Isparta merkezli demo haritasını açar" onPress={() => setMapOpen(true)} style={styles.mapButton}>
            <Text style={styles.mapButtonText}>Haritayı Aç</Text>
          </Pressable>
          <Text style={styles.footer}>TypeScript ile geliştiriliyor. • 02</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#F5F7FA',
    paddingTop: Platform.OS === 'android' ? (NativeStatusBar.currentHeight ?? 24) : 0,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 40,
  },
  content: {
    width: '100%',
    maxWidth: 480,
  },
  brandMark: {
    width: 56,
    height: 64,
    borderRadius: 18,
    backgroundColor: '#0B6B59',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginBottom: 32,
    transform: [{ rotate: '8deg' }],
  },
  roadLine: {
    width: 4,
    height: 9,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
  },
  eyebrow: {
    color: '#526572',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 10,
  },
  title: {
    color: '#152E3A',
    fontSize: 44,
    fontWeight: '800',
    letterSpacing: -1.5,
  },
  compactTitle: {
    fontSize: 38,
  },
  subtitle: {
    color: '#526572',
    fontSize: 20,
    lineHeight: 29,
    marginTop: 14,
    maxWidth: 360,
  },
  statusCard: {
    marginTop: 36,
    padding: 22,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#D6E8DF',
    backgroundColor: '#EBF5EF',
  },
  statusHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: '#0B6B59',
  },
  statusLabel: {
    color: '#0B6B59',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
  statusText: {
    color: '#183F32',
    fontSize: 17,
    fontWeight: '500',
    lineHeight: 26,
  },
  platforms: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 20,
  },
  platformChip: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#DDE4E9',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  platformLabel: {
    color: '#405665',
    fontSize: 12,
    fontWeight: '500',
  },
  footer: {
    color: '#526572',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 28,
  },
  mapButton: {
    marginTop: 24,
    minHeight: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    backgroundColor: '#0B6B59',
  },
  mapButtonText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
});
