/**
 * BleStatusPanel.js
 * ─────────────────────────────────────────────────────────────────
 * UI component — shows BLE connection status and live count value.
 * Drop this anywhere in your screen tree.
 *
 * Props:
 *   All values/callbacks returned by useBleDetector()
 * ─────────────────────────────────────────────────────────────────
 */

import React, { useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { BLE_STATUS } from '../hooks/useBleDetector';

// ── Status → display config ───────────────────────────────────────
const STATUS_CONFIG = {
  [BLE_STATUS.IDLE]:         { label: 'IDLE',               color: '#6b7280', pulse: false },
  [BLE_STATUS.BLE_OFF]:      { label: 'BLUETOOTH OFF',      color: '#ef4444', pulse: false },
  [BLE_STATUS.REQUESTING]:   { label: 'REQUESTING PERMS…',  color: '#f59e0b', pulse: true  },
  [BLE_STATUS.NO_PERM]:      { label: 'PERMISSION DENIED',  color: '#ef4444', pulse: false },
  [BLE_STATUS.SCANNING]:     { label: 'SCANNING…',          color: '#3b82f6', pulse: true  },
  [BLE_STATUS.NOT_FOUND]:    { label: 'DEVICE NOT FOUND',   color: '#f97316', pulse: false },
  [BLE_STATUS.CONNECTING]:   { label: 'CONNECTING…',        color: '#8b5cf6', pulse: true  },
  [BLE_STATUS.DISCOVERING]:  { label: 'DISCOVERING…',       color: '#8b5cf6', pulse: true  },
  [BLE_STATUS.CONNECTED]:    { label: 'CONNECTED',          color: '#10b981', pulse: false },
  [BLE_STATUS.MONITORING]:   { label: 'LIVE ●',             color: '#10b981', pulse: false },
  [BLE_STATUS.DISCONNECTED]: { label: 'DISCONNECTED',       color: '#f97316', pulse: false },
  [BLE_STATUS.ERROR]:        { label: 'ERROR',              color: '#ef4444', pulse: false },
};

const PULSING = [
  BLE_STATUS.SCANNING,
  BLE_STATUS.CONNECTING,
  BLE_STATUS.DISCOVERING,
  BLE_STATUS.REQUESTING,
];

// ── Dot pulse animation ───────────────────────────────────────────
function PulseDot({ color }) {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1.6, duration: 600, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1.0, duration: 600, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);

  return (
    <Animated.View
      style={[styles.dot, { backgroundColor: color, transform: [{ scale }] }]}
    />
  );
}

// ── Main component ────────────────────────────────────────────────
export default function BleStatusPanel({
  status,
  connectedDevice,
  liveCount,
  errorMessage,
  isScanning,
  isConnected,
  bleAdapterState,
  onScan,
  onDisconnect,
  onRequestPermissions,
}) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG[BLE_STATUS.IDLE];
  const isPulsing = PULSING.includes(status);

  const deviceName =
    connectedDevice?.localName ??
    connectedDevice?.name ??
    connectedDevice?.id?.slice(-8) ??
    '—';

  return (
    <View style={styles.panel}>

      {/* ── Header row ── */}
      <View style={styles.headerRow}>
        <Text style={styles.title}>DETECTOR  BLE</Text>
        <View style={styles.statusBadge}>
          {isPulsing ? (
            <PulseDot color={cfg.color} />
          ) : (
            <View style={[styles.dot, { backgroundColor: cfg.color }]} />
          )}
          <Text style={[styles.statusLabel, { color: cfg.color }]}>{cfg.label}</Text>
          {isPulsing && (
            <ActivityIndicator
              size="small"
              color={cfg.color}
              style={{ marginLeft: 6 }}
            />
          )}
        </View>
      </View>

      {/* ── Live count display ── */}
      <View style={styles.countBox}>
        <Text style={styles.countLabel}>LIVE COUNT</Text>
        <Text style={[styles.countValue, !isConnected && styles.countDim]}>
          {liveCount !== null ? String(liveCount).padStart(5, '0') : '—————'}
        </Text>
        <Text style={styles.countUnit}>
          {isConnected ? 'counts / sec' : ''}
        </Text>
      </View>

      {/* ── Device info ── */}
      {connectedDevice && (
        <View style={styles.deviceRow}>
          <Text style={styles.deviceLabel}>DEVICE</Text>
          <Text style={styles.deviceName}>{deviceName}</Text>
        </View>
      )}

      {/* ── Error message ── */}
      {errorMessage && (
        <Text style={styles.errorText}>⚠  {errorMessage}</Text>
      )}

      {/* ── Action buttons ── */}
      <View style={styles.buttonRow}>
        {!isConnected && !isScanning && (
          <TouchableOpacity
            style={[styles.btn, styles.btnScan]}
            onPress={onScan}
            activeOpacity={0.75}
          >
            <Text style={styles.btnText}>SCAN &amp; CONNECT</Text>
          </TouchableOpacity>
        )}

        {isScanning && (
          <TouchableOpacity
            style={[styles.btn, styles.btnStop]}
            onPress={onDisconnect}
            activeOpacity={0.75}
          >
            <Text style={styles.btnText}>STOP SCAN</Text>
          </TouchableOpacity>
        )}

        {isConnected && (
          <TouchableOpacity
            style={[styles.btn, styles.btnDisconnect]}
            onPress={onDisconnect}
            activeOpacity={0.75}
          >
            <Text style={styles.btnText}>DISCONNECT</Text>
          </TouchableOpacity>
        )}

        {(status === BLE_STATUS.NO_PERM) && (
          <TouchableOpacity
            style={[styles.btn, styles.btnPerm]}
            onPress={onRequestPermissions}
            activeOpacity={0.75}
          >
            <Text style={styles.btnText}>GRANT PERMISSIONS</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ── Styles ────────────────────────────────────────────────────────
const styles = StyleSheet.create({
  panel: {
    backgroundColor: '#1a1a2e',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#2d2d4e',
    padding: 14,
    minWidth: 240,
  },

  // ── Header
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    color: '#9ca3af',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  statusLabel: {
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
  },

  // ── Count
  countBox: {
    alignItems: 'center',
    paddingVertical: 10,
    marginBottom: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#2d2d4e',
  },
  countLabel: {
    color: '#6b7280',
    fontSize: 8,
    letterSpacing: 2,
    marginBottom: 4,
  },
  countValue: {
    color: '#00ff88',
    fontSize: 36,
    fontFamily: Platform.OS === 'android' ? 'monospace' : 'Courier',
    fontWeight: '700',
    letterSpacing: 4,
  },
  countDim: {
    color: '#374151',
  },
  countUnit: {
    color: '#4b5563',
    fontSize: 8,
    letterSpacing: 1.5,
    marginTop: 2,
  },

  // ── Device info
  deviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  deviceLabel: {
    color: '#6b7280',
    fontSize: 8,
    letterSpacing: 1.5,
  },
  deviceName: {
    color: '#d1d5db',
    fontSize: 10,
    fontWeight: '600',
  },

  // ── Error
  errorText: {
    color: '#fca5a5',
    fontSize: 9,
    marginBottom: 8,
    letterSpacing: 0.5,
  },

  // ── Buttons
  buttonRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
    flexWrap: 'wrap',
  },
  btn: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: 6,
    alignItems: 'center',
    minWidth: 100,
  },
  btnScan:       { backgroundColor: '#1d4ed8' },
  btnStop:       { backgroundColor: '#b45309' },
  btnDisconnect: { backgroundColor: '#7f1d1d' },
  btnPerm:       { backgroundColor: '#4c1d95' },
  btnText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
  },
});
