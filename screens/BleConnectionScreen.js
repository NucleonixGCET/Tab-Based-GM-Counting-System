/**
 * BleConnectionScreen.js
 * Full-screen BLE connection screen shown at boot.
 * - Shows all discovered BLE devices in a picker list
 * - Auto-connects to devices matching "52810"
 * - "SKIP" button goes directly to the main screen
 */

import React, { useContext, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  StatusBar,
  Image,
  ActivityIndicator,
  ScrollView,
  Platform,
} from 'react-native';
import { GMContext } from '../App';
import { BLE_STATUS } from '../hooks/useBleDetector';

// ── Status display config ──────────────────────────────────────────
const STATUS_CONFIG = {
  [BLE_STATUS.IDLE]:         { label: 'READY TO SCAN',           color: '#4b9dff', icon: '📡' },
  [BLE_STATUS.BLE_OFF]:      { label: 'BLUETOOTH IS OFF',        color: '#ef4444', icon: '🚫' },
  [BLE_STATUS.REQUESTING]:   { label: 'REQUESTING PERMISSIONS…', color: '#f59e0b', icon: '🔑' },
  [BLE_STATUS.NO_PERM]:      { label: 'PERMISSION DENIED',       color: '#ef4444', icon: '⛔' },
  [BLE_STATUS.SCANNING]:     { label: 'SCANNING FOR DEVICES…',   color: '#60a5fa', icon: '🔍' },
  [BLE_STATUS.NOT_FOUND]:    { label: 'AUTO-DETECT TIMED OUT',   color: '#f97316', icon: '⏱' },
  [BLE_STATUS.CONNECTING]:   { label: 'CONNECTING…',             color: '#a78bfa', icon: '🔗' },
  [BLE_STATUS.DISCOVERING]:  { label: 'DISCOVERING SERVICES…',   color: '#a78bfa', icon: '⚙️' },
  [BLE_STATUS.CONNECTED]:    { label: 'CONNECTED',               color: '#34d399', icon: '✅' },
  [BLE_STATUS.MONITORING]:   { label: 'LIVE — ENTERING SYSTEM',  color: '#34d399', icon: '✅' },
  [BLE_STATUS.DISCONNECTED]: { label: 'DISCONNECTED',            color: '#f97316', icon: '⚠️' },
  [BLE_STATUS.ERROR]:        { label: 'ERROR',                   color: '#ef4444', icon: '❌' },
};

const BUSY_STATES = [
  BLE_STATUS.SCANNING,
  BLE_STATUS.CONNECTING,
  BLE_STATUS.DISCOVERING,
  BLE_STATUS.REQUESTING,
];

// ── Pulsing ring ───────────────────────────────────────────────────
function PulsingRing({ color, active }) {
  const scale   = useRef(new Animated.Value(0.85)).current;
  const opacity = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    if (!active) { scale.setValue(0.85); opacity.setValue(0.8); return; }
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale,   { toValue: 1.35, duration: 850, useNativeDriver: true }),
          Animated.timing(scale,   { toValue: 0.85, duration: 850, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0.15, duration: 850, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 0.8,  duration: 850, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [active]);

  return (
    <Animated.View
      style={[styles.ring, { borderColor: color, transform: [{ scale }], opacity }]}
    />
  );
}

// ── RSSI signal strength bar ───────────────────────────────────────
function RssiBar({ rssi }) {
  // rssi typically -100 (weak) to -30 (strong)
  const strength = Math.max(0, Math.min(100, ((rssi + 100) / 70) * 100));
  const color = strength > 65 ? '#34d399' : strength > 35 ? '#f59e0b' : '#ef4444';
  return (
    <View style={styles.rssiWrap}>
      {[25, 50, 75, 100].map((threshold) => (
        <View
          key={threshold}
          style={[
            styles.rssiBar,
            { backgroundColor: strength >= threshold ? color : '#1f2937' },
          ]}
        />
      ))}
    </View>
  );
}

// ── Main screen ────────────────────────────────────────────────────
export default function BleConnectionScreen() {
  const { ble, setScreen } = useContext(GMContext);
  const cfg    = STATUS_CONFIG[ble.status] ?? STATUS_CONFIG[BLE_STATUS.IDLE];
  const isBusy = BUSY_STATES.includes(ble.status);

  const isError = [
    BLE_STATUS.NOT_FOUND, BLE_STATUS.NO_PERM,
    BLE_STATUS.ERROR, BLE_STATUS.DISCONNECTED, BLE_STATUS.BLE_OFF,
  ].includes(ble.status);

  const showPicker =
    ble.foundDevices.length > 0 &&
    !ble.isConnected &&
    ble.status !== BLE_STATUS.CONNECTING &&
    ble.status !== BLE_STATUS.DISCOVERING;

  // Fade-in on mount
  const fadeAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, []);

  return (
    <Animated.View style={[styles.container, { opacity: fadeAnim }]}>
      <StatusBar barStyle="light-content" backgroundColor="#070d1c" />

      {/* ── Header ── */}
      <View style={styles.header}>
        <Image source={require('../image.jpeg')} style={styles.logo} resizeMode="contain" />
        <Text style={styles.appTitle}>G.M Counting System</Text>
        <Text style={styles.appSubtitle}>NUCLEONIX SYSTEMS  ·  nRF52810 DETECTOR</Text>
      </View>

      {/* ── Central icon widget ── */}
      <View style={styles.centerWidget}>
        <View style={styles.iconContainer}>
          <PulsingRing color={cfg.color} active={isBusy} />
          <View style={[styles.iconCircle, { borderColor: cfg.color }]}>
            <Text style={styles.iconEmoji}>{cfg.icon}</Text>
          </View>
        </View>

        <Text style={[styles.statusText, { color: cfg.color }]}>{cfg.label}</Text>

        {isBusy && (
          <ActivityIndicator size="large" color={cfg.color} style={{ marginTop: 10 }} />
        )}

        {/* Connected device name */}
        {ble.connectedDevice && (
          <View style={[styles.deviceBadge, { borderColor: cfg.color }]}>
            <Text style={styles.deviceBadgeLabel}>CONNECTED TO</Text>
            <Text style={[styles.deviceBadgeName, { color: cfg.color }]}>
              {ble.connectedDevice.localName ?? ble.connectedDevice.name ?? ble.connectedDevice.id?.slice(-8)}
            </Text>
          </View>
        )}

        {ble.errorMessage && (
          <Text style={styles.errorMsg}>⚠  {ble.errorMessage}</Text>
        )}
      </View>

      {/* ── Device picker list ── */}
      {showPicker && (
        <View style={styles.pickerContainer}>
          <Text style={styles.pickerTitle}>
            NEARBY DEVICES  ·  {ble.foundDevices.length} found  ·  press CONNECT
          </Text>
          <ScrollView
            style={styles.pickerScroll}
            showsVerticalScrollIndicator={false}
          >
            {ble.foundDevices
              .slice()
              .sort((a, b) => b.rssi - a.rssi)   // strongest signal first
              .map((device) => {
                const isDetector = device.name.toLowerCase().includes('52810');
                return (
                  <View
                    key={device.id}
                    style={[styles.deviceRow, isDetector && styles.deviceRowHighlight]}
                  >
                    <View style={styles.deviceRowLeft}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                        <Text style={styles.deviceRowName}>{device.name}</Text>
                        {isDetector && (
                          <View style={styles.detectorTag}>
                            <Text style={styles.detectorTagText}>DETECTOR</Text>
                          </View>
                        )}
                      </View>
                      <Text style={styles.deviceRowId}>{device.id.slice(-11)}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
                        <RssiBar rssi={device.rssi} />
                        <Text style={styles.rssiLabel}>{device.rssi} dBm</Text>
                      </View>
                    </View>
                    {/* Explicit CONNECT button */}
                    <TouchableOpacity
                      style={[styles.connectBtn, isDetector && styles.connectBtnPrimary]}
                      onPress={() => ble.connectToDevice(device.id)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.connectBtnText, isDetector && styles.connectBtnTextPrimary]}>
                        CONNECT
                      </Text>
                    </TouchableOpacity>
                  </View>
                );
              })}
          </ScrollView>
        </View>
      )}

      {/* ── Action buttons ── */}
      <View style={styles.buttonArea}>
        {!isBusy && !ble.isConnected && (
          <TouchableOpacity style={styles.scanBtn} onPress={ble.startScan} activeOpacity={0.8}>
            <Text style={styles.scanBtnText}>
              {isError || ble.foundDevices.length > 0 ? '↺  RESCAN' : '⬤  SCAN FOR DEVICES'}
            </Text>
          </TouchableOpacity>
        )}

        {ble.isScanning && (
          <TouchableOpacity
            style={[styles.scanBtn, styles.stopBtn]}
            onPress={ble.stopScan}
            activeOpacity={0.8}
          >
            <Text style={styles.scanBtnText}>◼  STOP SCAN</Text>
          </TouchableOpacity>
        )}

        {ble.status === BLE_STATUS.NO_PERM && (
          <TouchableOpacity
            style={[styles.scanBtn, styles.permBtn]}
            onPress={ble.requestPermissions}
            activeOpacity={0.8}
          >
            <Text style={styles.scanBtnText}>🔑  GRANT PERMISSIONS</Text>
          </TouchableOpacity>
        )}

        {/* Skip — always available unless busy/connected */}
        {!ble.isConnected && (
          <TouchableOpacity style={styles.skipBtn} onPress={() => setScreen('main')} activeOpacity={0.8}>
            <Text style={styles.skipBtnText}>
              {isBusy ? '— scanning in background —' : 'SKIP  →  Continue without detector'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      <Text style={styles.hint}>
        Ensure the AT-52810 detector is powered ON and Bluetooth is enabled on this tablet.
      </Text>
    </Animated.View>
  );
}

// ── Styles ─────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#070d1c',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 24,
    paddingHorizontal: 40,
  },

  // Header
  header: { alignItems: 'center', gap: 6 },
  logo:   { width: 56, height: 56, borderRadius: 10 },
  appTitle: {
    color: '#c8deff', fontSize: 26, fontWeight: '700', letterSpacing: 1,
  },
  appSubtitle: {
    color: '#374151', fontSize: 10, letterSpacing: 2.5, fontWeight: '600',
  },

  // Center widget
  centerWidget: { alignItems: 'center', gap: 14 },
  iconContainer: { width: 130, height: 130, alignItems: 'center', justifyContent: 'center' },
  ring: {
    position: 'absolute', width: 124, height: 124,
    borderRadius: 62, borderWidth: 2,
  },
  iconCircle: {
    width: 92, height: 92, borderRadius: 46,
    borderWidth: 2, backgroundColor: '#0d1b35',
    alignItems: 'center', justifyContent: 'center',
  },
  iconEmoji: { fontSize: 36 },
  statusText: { fontSize: 16, fontWeight: '700', letterSpacing: 1.5, textAlign: 'center' },

  deviceBadge: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 20, paddingVertical: 8,
    alignItems: 'center', gap: 3,
    backgroundColor: '#0d1f14',
  },
  deviceBadgeLabel: { color: '#6b7280', fontSize: 8, letterSpacing: 2 },
  deviceBadgeName:  { fontSize: 14, fontWeight: '700', letterSpacing: 1 },
  errorMsg: { color: '#fca5a5', fontSize: 11, textAlign: 'center', maxWidth: 400 },

  // Device picker
  pickerContainer: {
    width: '100%',
    maxWidth: 620,
    maxHeight: 200,
    backgroundColor: '#0d1425',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#1e3a5f',
    overflow: 'hidden',
  },
  pickerTitle: {
    color: '#4b5563',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 2,
    textAlign: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#1e3a5f',
  },
  pickerScroll: { flex: 1 },
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#111827',
    gap: 12,
  },
  deviceRowHighlight: {
    backgroundColor: '#0d2a1a',
    borderLeftWidth: 3,
    borderLeftColor: '#34d399',
  },
  deviceRowLeft:  { flex: 1 },
  deviceRowRight: { alignItems: 'flex-end', gap: 4 },
  deviceRowName:  { color: '#e5e7eb', fontSize: 13, fontWeight: '600' },
  deviceRowId:    { color: '#4b5563', fontSize: 9, fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier' },

  // RSSI bars
  rssiWrap: { flexDirection: 'row', gap: 2, alignItems: 'flex-end' },
  rssiBar:  { width: 5, borderRadius: 2 },
  rssiLabel: { color: '#6b7280', fontSize: 9 },

  detectorTag: {
    backgroundColor: '#064e3b',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  detectorTagText: { color: '#34d399', fontSize: 8, fontWeight: '700', letterSpacing: 1 },

  // Buttons
  buttonArea: { alignItems: 'center', gap: 12, width: '100%', maxWidth: 440 },
  scanBtn: {
    backgroundColor: '#1d4ed8', borderRadius: 10,
    paddingVertical: 13, width: '100%', alignItems: 'center',
  },
  stopBtn: { backgroundColor: '#92400e' },
  permBtn: { backgroundColor: '#4c1d95' },
  scanBtnText: { color: '#fff', fontSize: 13, fontWeight: '700', letterSpacing: 1.5 },
  skipBtn: { paddingVertical: 8 },
  skipBtnText: { color: '#374151', fontSize: 10, letterSpacing: 1, textDecorationLine: 'underline' },

  // Explicit connect button (on each device row)
  connectBtn: {
    backgroundColor: '#1e3a6a',
    borderWidth: 1.5,
    borderColor: '#3b82f6',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 14,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 80,
  },
  connectBtnPrimary: {
    backgroundColor: '#064e3b',
    borderColor: '#34d399',
  },
  connectBtnText: {
    color: '#60a5fa',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  connectBtnTextPrimary: {
    color: '#34d399',
  },


  hint: {
    color: '#1f2937', fontSize: 10, textAlign: 'center',
    letterSpacing: 0.5, maxWidth: 500,
  },
});
