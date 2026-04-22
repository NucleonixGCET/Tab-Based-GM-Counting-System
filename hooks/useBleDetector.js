/**
 * useBleDetector.js
 * ─────────────────────────────────────────────────────────────────
 * BLE hook for Nordic nRF52810-based Scintillation Detector.
 *
 * Scan strategy:
 *   - No UUID filter → discovers ALL nearby BLE devices
 *   - Auto-connects to first device whose name contains AUTO_CONNECT_KEYWORD
 *   - All other named devices appear in foundDevices for manual selection
 *
 * Nordic UART Service UUIDs (nRF52810 default firmware):
 *   Service  : 6E400001-B5A3-F393-E0A9-E50E24DCCA9E
 *   TX char  : 6E400002-B5A3-F393-E0A9-E50E24DCCA9E  (phone → device)
 *   RX char  : 6E400003-B5A3-F393-E0A9-E50E24DCCA9E  (device → phone, monitored)
 * ─────────────────────────────────────────────────────────────────
 */

import { useEffect, useRef, useCallback, useReducer } from 'react';
import { Platform, PermissionsAndroid, Alert } from 'react-native';
import { BleManager, State as BleState } from 'react-native-ble-plx';
import { decode as decodeBase64, encode as encodeBase64 } from 'base-64';

// ── UUIDs ──────────────────────────────────────────────────────────
export const UART_SERVICE_UUID = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
export const UART_TX_CHAR_UUID = '6E400002-B5A3-F393-E0A9-E50E24DCCA9E';
export const UART_RX_CHAR_UUID = '6E400003-B5A3-F393-E0A9-E50E24DCCA9E';

// ── Scan config ────────────────────────────────────────────────────
// Any device whose localName contains this string (case-insensitive) will
// be auto-connected. Everything else goes into the manual picker list.
export const AUTO_CONNECT_KEYWORD = '52810';
export const SCAN_TIMEOUT_MS      = 20_000;   // 20 s discovery window
export const DEBOUNCE_MS          = 800;

// ── Status labels ──────────────────────────────────────────────────
export const BLE_STATUS = {
  IDLE:         'IDLE',
  BLE_OFF:      'BLUETOOTH_OFF',
  REQUESTING:   'REQUESTING_PERMISSIONS',
  NO_PERM:      'PERMISSION_DENIED',
  SCANNING:     'SCANNING',
  NOT_FOUND:    'DEVICE_NOT_FOUND',
  CONNECTING:   'CONNECTING',
  DISCOVERING:  'DISCOVERING_SERVICES',
  CONNECTED:    'CONNECTED',
  MONITORING:   'MONITORING',
  DISCONNECTED: 'DISCONNECTED',
  ERROR:        'ERROR',
};

// ── State ──────────────────────────────────────────────────────────
const initialState = {
  bleAdapterState: BleState.Unknown,
  status:          BLE_STATUS.IDLE,
  connectedDevice: null,
  liveCount:       null,
  errorMessage:    null,
  isScanning:      false,
  foundDevices:    [],   // [{id, name, rssi}] — for manual picker
};

function reducer(state, action) {
  switch (action.type) {
    case 'BLE_STATE':
      return { ...state, bleAdapterState: action.payload };
    case 'STATUS':
      return { ...state, status: action.payload, errorMessage: null };
    case 'ERROR':
      return { ...state, status: BLE_STATUS.ERROR, errorMessage: action.payload };
    case 'CONNECTED':
      return { ...state, status: BLE_STATUS.CONNECTED, connectedDevice: action.payload, errorMessage: null };
    case 'MONITORING':
      return { ...state, status: BLE_STATUS.MONITORING };
    case 'LIVE_COUNT':
      return { ...state, liveCount: action.payload };
    case 'SCANNING':
      return {
        ...state,
        isScanning:   action.payload,
        status:       action.payload ? BLE_STATUS.SCANNING : state.status,
        foundDevices: action.payload ? [] : state.foundDevices, // clear list on new scan
      };
    case 'DEVICE_FOUND': {
      // Deduplicate by device ID; update RSSI if seen again
      const exists = state.foundDevices.find(d => d.id === action.payload.id);
      if (exists) return state;
      return { ...state, foundDevices: [...state.foundDevices, action.payload] };
    }
    case 'DISCONNECTED':
      return { ...state, status: BLE_STATUS.DISCONNECTED, connectedDevice: null, isScanning: false };
    case 'RESET':
      return { ...initialState, bleAdapterState: state.bleAdapterState };
    default:
      return state;
  }
}

// ── Helpers ────────────────────────────────────────────────────────
function decodeCharacteristicValue(base64Value) {
  if (!base64Value) return '';
  try {
    return decodeBase64(base64Value);
  } catch (e) {
    console.warn('[BLE] Base64 decode error:', e.message);
    return '';
  }
}

/**
 * Parses one BLE frame from the nRF52810 detector.
 *
 * Detector format (one or many per packet):
 *   "Cnts:35!\r\nCnts:39!\r\nCnts:40!\r\n"
 *
 * Edge-cases handled:
 *   - Fragmented leading byte: "nts:35!" (BLE split the 'C' into the prev packet)
 *   - Multiple readings in one BLE notification (MTU batching)
 *
 * Returns an array of integers (may be empty if nothing matched).
 */
function parseCountValues(rawText) {
  if (!rawText) return [];
  // Match both "Cnts:35!" and the fragmented "nts:35!" variant
  const matches = rawText.matchAll(/C?nts:(\d+)!/g);
  const counts = [];
  for (const m of matches) {
    counts.push(parseInt(m[1], 10));
  }
  return counts;
}


async function requestAndroidPermissions() {
  if (Platform.OS !== 'android') return true;
  if (Platform.Version >= 31) {
    const results = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_ADVERTISE,
      PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    ]);
    return Object.values(results).every(r => r === PermissionsAndroid.RESULTS.GRANTED);
  }
  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    { title: 'Location Permission', message: 'Required for Bluetooth scanning.', buttonPositive: 'Allow' }
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

// ── Hook ───────────────────────────────────────────────────────────
export function useBleDetector({ onCountReceived } = {}) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const managerRef       = useRef(null);
  const scanTimerRef     = useRef(null);
  const monitorSubRef    = useRef(null);
  const isScanningRef    = useRef(false);    // avoids stale closure in timeout
  const isConnectingRef  = useRef(false);   // prevents double-connect
  // Writable char UUIDs discovered during service enumeration (used by sendCommand)
  const writeSvcUUIDRef  = useRef(UART_SERVICE_UUID);
  const writeCharUUIDRef = useRef(UART_TX_CHAR_UUID);

  // ── Count queue ────────────────────────────────────────────────
  // BLE sends batches of CPS readings. The queue drains them one
  // per second so the display ticks naturally like a live counter.
  const countQueueRef  = useRef([]);       // FIFO of parsed integers
  const queueTimerRef  = useRef(null);     // setTimeout handle for drainer
  const retryCountRef  = useRef(0);        // stale-connection auto-retry counter

  // ── BLE Manager lifecycle ──────────────────────────────────────
  useEffect(() => {
    const manager = new BleManager();
    managerRef.current = manager;

    const stateSub = manager.onStateChange((bleState) => {
      console.log('[BLE] Adapter state →', bleState);
      dispatch({ type: 'BLE_STATE', payload: bleState });
      if (bleState === BleState.PoweredOff) {
        dispatch({ type: 'STATUS', payload: BLE_STATUS.BLE_OFF });
        Alert.alert('Bluetooth Off', 'Please enable Bluetooth to connect to the detector.');
      }
    }, true);

    return () => {
      stateSub.remove();
      _stopScan();
      _stopMonitor();
      manager.destroy();
    };
  }, []);

  // ── Internals ──────────────────────────────────────────────────
  function _stopScan() {
    if (scanTimerRef.current) {
      clearTimeout(scanTimerRef.current);
      scanTimerRef.current = null;
    }
    isScanningRef.current = false;
    managerRef.current?.stopDeviceScan();
    dispatch({ type: 'SCANNING', payload: false });
  }

  function _stopMonitor() {
    monitorSubRef.current?.remove();
    monitorSubRef.current = null;
    // Stop and flush the count queue
    if (queueTimerRef.current) {
      clearTimeout(queueTimerRef.current);
      queueTimerRef.current = null;
    }
    countQueueRef.current = [];
  }

  // Drains the count queue one item per second.
  function _drainQueue() {
    if (countQueueRef.current.length === 0) {
      queueTimerRef.current = null;   // queue empty — drainer stops
      return;
    }
    const count = countQueueRef.current.shift();
    dispatch({ type: 'LIVE_COUNT', payload: count });
    onCountReceived?.(count);
    // Schedule next drain in 1 s
    queueTimerRef.current = setTimeout(_drainQueue, 1000);
  }

  // Enqueue a batch of counts. Starts the drainer if not already running.
  function _enqueueCounts(counts) {
    countQueueRef.current.push(...counts);
    if (!queueTimerRef.current) {
      _drainQueue();   // kick-start immediately for first item
    }
  }

  async function _startMonitor(device) {
    dispatch({ type: 'STATUS', payload: BLE_STATUS.DISCOVERING });
    try {
      await device.discoverAllServicesAndCharacteristics();
    } catch (e) {
      console.error('[BLE] Service discovery failed:', e.message, '| code:', e.errorCode);
      dispatch({ type: 'ERROR', payload: `Service discovery failed (code ${e.errorCode ?? '?'})` });
      isConnectingRef.current = false;
      return;
    }

    // ── Log every service + characteristic so we can see the real UUIDs ──
    let notifySvcUUID = null;
    let notifyCharUUID = null;
    try {
      const services = await device.services();
      for (const svc of services) {
        console.log('[BLE] Service:', svc.uuid);
        const chars = await svc.characteristics();
        for (const ch of chars) {
          console.log(
            `[BLE]   Char: ${ch.uuid}` +
            ` | notify=${ch.isNotifiable}` +
            ` | indicate=${ch.isIndicatable}` +
            ` | read=${ch.isReadable}` +
            ` | write=${ch.isWritableWithResponse}`
          );
          // Prefer a characteristic that is notifiable but NOT writable —
          // that's the RX channel (data FROM device). Skip TX (write+notify).
          const isPureNotify = (ch.isNotifiable || ch.isIndicatable) && !ch.isWritableWithResponse;
          if (!notifyCharUUID && isPureNotify) {
            notifySvcUUID  = svc.uuid;
            notifyCharUUID = ch.uuid;
          }
          // Track writable characteristic (TX — phone → device)
          if (ch.isWritableWithResponse || ch.isWritableWithoutResponse) {
            writeSvcUUIDRef.current  = svc.uuid;
            writeCharUUIDRef.current = ch.uuid;
            console.log('[BLE] Write char discovered:', ch.uuid);
          }
        }
      }
    } catch (e) {
      console.warn('[BLE] Could not enumerate services:', e.message);
    }

    // Fall back to hardcoded Nordic UART UUIDs if auto-detect missed
    const svcUUID  = notifySvcUUID  ?? UART_SERVICE_UUID;
    const charUUID = notifyCharUUID ?? UART_RX_CHAR_UUID;
    console.log(`[BLE] Monitoring  svc=${svcUUID}  char=${charUUID}`);

    const connectedAt = Date.now();
    dispatch({ type: 'MONITORING' });
    isConnectingRef.current = false;

    device.onDisconnected((error, dev) => {
      const aliveMs = Date.now() - connectedAt;
      console.log('[BLE] Disconnected:', dev?.id, `| alive ${aliveMs}ms`, error?.message ?? '');
      _stopMonitor();
      dispatch({ type: 'DISCONNECTED' });

      if (aliveMs < 2000 && retryCountRef.current < 3) {
        retryCountRef.current += 1;
        console.log(`[BLE] Stale connection — auto-retry #${retryCountRef.current} in 1.5 s …`);
        setTimeout(async () => {
          if (!isScanningRef.current && !isConnectingRef.current) {
            dispatch({ type: 'STATUS', payload: BLE_STATUS.CONNECTING });
            await _connectToDevice(dev);
          }
        }, 1500);
      } else {
        retryCountRef.current = 0;
      }
    });

    monitorSubRef.current = device.monitorCharacteristicForService(
      svcUUID,
      charUUID,
      (error, characteristic) => {
        if (error) {
          if (error.errorCode !== 205 && error.errorCode !== 2) {
            console.error('[BLE] Monitor error:', error.message, '| code:', error.errorCode);
            dispatch({ type: 'ERROR', payload: `Monitor error (code ${error.errorCode ?? '?'})` });
          }
          return;
        }
        const raw = decodeCharacteristicValue(characteristic?.value);
        const counts = parseCountValues(raw);
        if (counts.length > 0) {
          console.log('[BLE] Queuing counts:', counts);
          _enqueueCounts(counts);
        } else {
          console.warn('[BLE] No counts parsed from frame:', JSON.stringify(raw));
        }
      }
    );
  }

  async function _connectToDevice(device) {
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;

    _stopScan();
    dispatch({ type: 'STATUS', payload: BLE_STATUS.CONNECTING });
    console.log('[BLE] Connecting to', device.name ?? device.localName ?? device.id);

    // Cancel any stale native connection for this device ID before
    // trying to connect — prevents immediate disconnect on hot-reload.
    try {
      await managerRef.current.cancelDeviceConnection(device.id);
      console.log('[BLE] Cleared stale connection for', device.id);
    } catch (_) {
      // No existing connection — that's fine, continue.
    }

    try {
      const connected = await device.connect({ timeout: 10_000, autoConnect: false });
      console.log('[BLE] Connected:', connected.id);
      dispatch({ type: 'CONNECTED', payload: connected });

      // Give the device 400 ms to stabilize before GATT operations.
      await new Promise(resolve => setTimeout(resolve, 400));

      await _startMonitor(connected);
    } catch (e) {
      console.error('[BLE] Connection failed:', e.message, '| code:', e.errorCode);
      dispatch({ type: 'ERROR', payload: `Connection failed (code ${e.errorCode ?? '?'})` });
      isConnectingRef.current = false;
    }
  }

  // ── Public API ─────────────────────────────────────────────────

  const requestPermissions = useCallback(async () => {
    dispatch({ type: 'STATUS', payload: BLE_STATUS.REQUESTING });
    const granted = await requestAndroidPermissions();
    if (!granted) {
      dispatch({ type: 'STATUS', payload: BLE_STATUS.NO_PERM });
      Alert.alert('Permissions Required', 'Enable Bluetooth permissions in Android Settings.');
    } else {
      dispatch({ type: 'STATUS', payload: BLE_STATUS.IDLE });
    }
    return granted;
  }, []);

  const startScan = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager) return;

    if (state.bleAdapterState !== BleState.PoweredOn) {
      Alert.alert('Bluetooth Off', 'Please enable Bluetooth first.');
      return;
    }
    if (isScanningRef.current || state.connectedDevice) return;

    // Ensure Android permissions
    if (Platform.OS === 'android') {
      const granted = await requestAndroidPermissions();
      if (!granted) {
        dispatch({ type: 'STATUS', payload: BLE_STATUS.NO_PERM });
        return;
      }
    }

    _stopMonitor();
    isConnectingRef.current = false;
    isScanningRef.current = true;
    dispatch({ type: 'SCANNING', payload: true });

    console.log('[BLE] Scan started — no UUID filter, open discovery');

    manager.startDeviceScan(
      null,                         // ← null = scan ALL BLE devices, no UUID filter
      { allowDuplicates: false },
      async (error, device) => {
        if (error) {
          console.error('[BLE] Scan error:', error.message, '| code:', error.errorCode);
          dispatch({ type: 'ERROR', payload: `Scan error (code ${error.errorCode ?? '?'})` });
          _stopScan();
          return;
        }
        if (!device) return;

        const name = device.localName ?? device.name ?? '';
        if (!name) return;  // skip anonymous devices (no name = not our device)

        console.log('[BLE] Discovered:', name, '| RSSI:', device.rssi, '| ID:', device.id);

        // Add to picker list
        dispatch({
          type: 'DEVICE_FOUND',
          payload: { id: device.id, name, rssi: device.rssi ?? 0 },
        });

        // Auto-connect disabled: device is added to picker list for manual connection.
        // User must tap the device row (or press CONNECT) in BleConnectionScreen.
        if (name.toLowerCase().includes(AUTO_CONNECT_KEYWORD.toLowerCase())) {
          console.log('[BLE] Detector found (awaiting manual connect):', name);
        }
      }
    );

    // Auto-stop after timeout using ref (not stale state)
    scanTimerRef.current = setTimeout(() => {
      if (isScanningRef.current) {
        console.warn('[BLE] Scan timeout — no auto-connect device found.');
        _stopScan();
        dispatch({ type: 'STATUS', payload: BLE_STATUS.NOT_FOUND });
      }
    }, SCAN_TIMEOUT_MS);

  }, [state.bleAdapterState, state.connectedDevice]);

  /** Manually connect to a device from the picker list */
  const connectToDevice = useCallback(async (deviceId) => {
    const manager = managerRef.current;
    if (!manager) return;
    try {
      // react-native-ble-plx can connect by ID directly
      const device = await manager.connectToDevice(deviceId, {
        timeout: 10_000,
        autoConnect: false,
      });
      dispatch({ type: 'CONNECTED', payload: device });
      console.log('[BLE] Manually connected to:', device.id);
      await _startMonitor(device);
    } catch (e) {
      console.error('[BLE] Manual connect failed:', e.message);
      dispatch({ type: 'ERROR', payload: `Connection failed (code ${e.errorCode ?? '?'})` });
    }
  }, []);

  const disconnect = useCallback(async () => {
    _stopMonitor();
    const device = state.connectedDevice;
    if (device) {
      try { await device.cancelConnection(); } catch (_) {}
    }
    dispatch({ type: 'DISCONNECTED' });
  }, [state.connectedDevice]);

  const stopScan = useCallback(() => {
    _stopScan();
    dispatch({ type: 'STATUS', payload: BLE_STATUS.IDLE });
  }, []);

  const reset = useCallback(() => {
    disconnect();
    dispatch({ type: 'RESET' });
  }, [disconnect]);

  /**
   * Send a plain-text command string to the connected scintillator device.
   * The string is Base64-encoded and written to the writable UART TX characteristic.
   * Example: sendCommand('STHV 400')
   */
  const sendCommand = useCallback(async (text) => {
    const device = state.connectedDevice;
    if (!device) {
      console.warn('[BLE] sendCommand: no connected device');
      return false;
    }
    try {
      const encoded = encodeBase64(text);
      await device.writeCharacteristicWithResponseForService(
        writeSvcUUIDRef.current,
        writeCharUUIDRef.current,
        encoded,
      );
      console.log('[BLE] Command sent:', text);
      return true;
    } catch (e) {
      console.error('[BLE] sendCommand failed:', e.message, '| code:', e.errorCode);
      return false;
    }
  }, [state.connectedDevice]);

  return {
    bleAdapterState: state.bleAdapterState,
    status:          state.status,
    connectedDevice: state.connectedDevice,
    liveCount:       state.liveCount,
    errorMessage:    state.errorMessage,
    isScanning:      state.isScanning,
    isConnected:     state.status === BLE_STATUS.MONITORING,
    foundDevices:    state.foundDevices,   // ← exposed for picker UI
    requestPermissions,
    startScan,
    stopScan,
    connectToDevice,  // ← manual connect by ID
    disconnect,
    reset,
    sendCommand,      // ← write a text command to the device
  };
}
