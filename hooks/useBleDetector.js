/**
 * useBleDetector.js
 * ─────────────────────────────────────────────────────────────────
 * BLE hook for Nordic nRF52810-based Scintillation Detector.
 *
 * Scan strategy:
 *   - No UUID filter → discovers ALL nearby BLE devices
 *   - All named devices appear in foundDevices for manual selection
 *
 * Nordic UART Service UUIDs (nRF52810 default firmware):
 *   Service  : 6E400001-B5A3-F393-E0A9-E50E24DCCA9E
 *   TX char  : 6E400002-B5A3-F393-E0A9-E50E24DCCA9E  (phone → device)
 *   RX char  : 6E400003-B5A3-F393-E0A9-E50E24DCCA9E  (device → phone, monitored)
 *
 * ── Frame model (mirrors Serial Bluetooth Monitor behaviour) ──────
 *
 *  The firmware transmits 2 frames every 2 seconds.  Each frame represents
 *  exactly 1 second of detector data:
 *
 *    "Counts,<n>,CurHV,<kV>!\r\n"
 *
 *  BLE MTU batching may cause the two frames to arrive in a single
 *  notification, or occasionally 3-4 frames may be batched together.
 *
 *  Strategy:
 *    1. Gate all incoming frames behind collectingRef — only frames that
 *       arrive AFTER startCollecting() (i.e. after SRTC is sent) are
 *       accepted.  This discards any HV-settling frames that the device
 *       may emit immediately after STHV, eliminating HV-spike readings.
 *    2. Every accepted frame is pushed individually into a FIFO display
 *       queue (displayQueueRef).
 *    3. A drain timer releases exactly ONE frame per second from the queue,
 *       dispatching a LIVE_COUNT action each time.  This gives a perfectly
 *       steady 1-update/second LCD rate regardless of how the BLE stack
 *       batches the notifications — identical to what the Serial BT Monitor
 *       does when it prints one line per received frame.
 *    4. If more frames are in the queue than have been drained (e.g. 3
 *       frames arrived in one notification) they simply wait in the FIFO and
 *       are released in subsequent seconds — no frames are ever dropped and
 *       no artificial summing or pairing is done.
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
export const AUTO_CONNECT_KEYWORD = '52810';
export const SCAN_TIMEOUT_MS     = 20_000;   // 20 s discovery window
export const DEBOUNCE_MS         = 800;

// ── Status labels ──────────────────────────────────────────────────
export const BLE_STATUS = {
  IDLE        : 'IDLE',
  BLE_OFF     : 'BLUETOOTH_OFF',
  REQUESTING  : 'REQUESTING_PERMISSIONS',
  NO_PERM     : 'PERMISSION_DENIED',
  SCANNING    : 'SCANNING',
  NOT_FOUND   : 'DEVICE_NOT_FOUND',
  CONNECTING  : 'CONNECTING',
  DISCOVERING : 'DISCOVERING_SERVICES',
  CONNECTED   : 'CONNECTED',
  MONITORING  : 'MONITORING',
  DISCONNECTED: 'DISCONNECTED',
  ERROR       : 'ERROR',
};

// ── Reducer ────────────────────────────────────────────────────────
const initialState = {
  bleAdapterState: BleState.Unknown,
  status         : BLE_STATUS.IDLE,
  connectedDevice: null,
  liveCount      : null,
  liveHV         : null,
  liveCountToken : 0,
  errorMessage   : null,
  isScanning     : false,
  foundDevices   : [],
};

function reducer(state, action) {
  switch (action.type) {
    case 'BLE_STATE' : return { ...state, bleAdapterState: action.payload };
    case 'STATUS'    : return { ...state, status: action.payload, errorMessage: null };
    case 'ERROR'     : return { ...state, status: BLE_STATUS.ERROR, errorMessage: action.payload };
    case 'CONNECTED' : return { ...state, status: BLE_STATUS.CONNECTED, connectedDevice: action.payload, errorMessage: null };
    case 'MONITORING': return { ...state, status: BLE_STATUS.MONITORING };
    case 'LIVE_COUNT': return {
      ...state,
      liveCount     : action.payload.count,
      liveHV        : action.payload.hv ?? state.liveHV,
      liveCountToken: (state.liveCountToken ?? 0) + 1,
    };
    case 'SCANNING': return {
      ...state,
      isScanning  : action.payload,
      status      : action.payload ? BLE_STATUS.SCANNING : state.status,
      foundDevices: action.payload ? [] : state.foundDevices,
    };
    case 'DEVICE_FOUND': {
      const exists = state.foundDevices.find(d => d.id === action.payload.id);
      if (exists) return state;
      return { ...state, foundDevices: [...state.foundDevices, action.payload] };
    }
    case 'DISCONNECTED': return { ...state, status: BLE_STATUS.DISCONNECTED, connectedDevice: null, isScanning: false };
    case 'RESET'       : return { ...initialState, bleAdapterState: state.bleAdapterState };
    default            : return state;
  }
}

// ── Helpers ────────────────────────────────────────────────────────
function decodeCharValue(base64Value) {
  if (!base64Value) return '';
  try   { return decodeBase64(base64Value); }
  catch (e) { console.warn('[BLE] Base64 decode error:', e.message); return ''; }
}

/**
 * parseFrames(rawText)
 *
 * Extracts all complete "Counts,N,CurHV,F!" messages from a raw string.
 * Returns an array of { count: number, hv: number|null } objects.
 *
 * HV conversion:
 *   - Value < 10  → device sent kV  (e.g. 0.497) → multiply × 1000 → Volts
 *   - Value ≥ 10  → device sent Volts directly    → round to integer
 *
 * HV validation: 
 *   - Hard bounds: 0-1600V (nRF52810 max rating with margin)
 *   - This function doesn't know expected HV, so adaptive validation
 *     happens in the notification callback via recentHvRef.
 */
function parseFrames(rawText) {
  if (!rawText) return [];
  const results = [];
  const HV_MIN = 0;
  const HV_MAX = 1600;

  // Primary format: Counts,N,CurHV,F!
  for (const m of rawText.matchAll(/Counts,(\d+),CurHV,([\d.]+)!/g)) {
    const hvRaw   = parseFloat(m[2]);
    const hvVolts = hvRaw >= 10 ? Math.round(hvRaw) : Math.round(hvRaw * 1000);
    
    // Hard bounds check only; adaptive filtering happens at notification level
    if (hvVolts >= HV_MIN && hvVolts <= HV_MAX) {
      results.push({ count: parseInt(m[1], 10), hv: hvVolts });
    }
  }

  // Legacy fallback: C?nts:N!
  if (results.length === 0) {
    for (const m of rawText.matchAll(/C?nts:(\d+)!/g)) {
      results.push({ count: parseInt(m[1], 10), hv: null });
    }
  }

  return results;
}

// ── Android permission helper ───────────────────────────────────────
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
    { title: 'Location Permission', message: 'Required for Bluetooth scanning.', buttonPositive: 'Allow' },
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

// ── Hook ───────────────────────────────────────────────────────────
export function useBleDetector({ onCountReceived } = {}) {
  const [state, dispatch] = useReducer(reducer, initialState);

  const managerRef       = useRef(null);
  const scanTimerRef     = useRef(null);
  const monitorSubRef    = useRef(null);
  const isScanningRef    = useRef(false);
  const isConnectingRef  = useRef(false);
  const writeSvcUUIDRef  = useRef(UART_SERVICE_UUID);
  const writeCharUUIDRef = useRef(UART_TX_CHAR_UUID);
  const retryCountRef    = useRef(0);

  // ── Incoming BLE reassembly buffer ────────────────────────────
  // BLE packets may be fragmented; we accumulate until we see '!' terminators.
  const bleBufferRef = useRef('');

  // ── Collection gate ───────────────────────────────────────────
  // When false (default), ALL incoming frames are discarded.
  // Set to true by startCollecting() which is called right after SRTC is
  // confirmed sent.  This ensures that any frames the device emits while HV
  // is settling (between STHV and SRTC) are never stored or displayed.
  const collectingRef = useRef(false);

  // ── Display queue ─────────────────────────────────────────────
  // Each element is a { count, hv } frame representing exactly 1 second of
  // detector data.  The drain timer below releases one element per second,
  // producing a steady 1 Hz LCD update that matches what the Serial BT
  // Monitor shows when it prints one line per received frame.
  const displayQueueRef = useRef([]);
  const displayDrainRef = useRef(null);  // setInterval handle

  // ── frameQueueRef ─────────────────────────────────────────────
  // Secondary queue used by the App.js counting loop (flushFrames / popFrame).
  const frameQueueRef = useRef([]);

  // ── Throttle state updates to reduce re-renders on low-end devices ────
  // Instead of updating state for every frame, batch updates using RAF.
  // This prevents the main thread from being overwhelmed by React updates.
  const pendingFrameRef = useRef(null);
  const rafIdRef = useRef(null);
  const drainScheduledRef = useRef(false);

  // ── HV stabilization grace period ────────────────────────────────────
  // When HV is changed, the device takes time to settle. During this time,
  // it emits frames at intermediate or old voltages. We discard frames during
  // a grace period after startCollecting() to ensure only stable data is collected.
  const stabilizationEndTimeRef = useRef(0);

  // ── Adaptive HV validation ────────────────────────────────────────────
  // Track recent valid HV readings to detect and reject corrupted frames.
  // Frames with HV values > 30V away from the median are filtered out.
  // This prevents frame boundary corruption (970V, 930V, 10V, 80V, etc.) from
  // polluting the data while allowing normal device drift (±10-15V).
  const recentHvRef = useRef([]);  // sliding window of last 10 valid HV readings
  const HV_MEDIAN_WINDOW = 10;
  const HV_DEVIATION_THRESHOLD = 30;  // reject if > 30V from median

  // ─────────────────────────────────────────────────────────────
  // BLE Manager lifecycle
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────

  function _stopScan() {
    if (scanTimerRef.current) { clearTimeout(scanTimerRef.current); scanTimerRef.current = null; }
    isScanningRef.current = false;
    managerRef.current?.stopDeviceScan();
    dispatch({ type: 'SCANNING', payload: false });
  }

  function _stopMonitor() {
    monitorSubRef.current?.remove();
    monitorSubRef.current = null;
    _stopDrain();
  }

  /** Stop the drain timer and wipe both queues + the collecting gate. */
  function _stopDrain() {
    if (displayDrainRef.current) {
      clearInterval(displayDrainRef.current);
      displayDrainRef.current = null;
    }
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    drainScheduledRef.current = false;
    stabilizationEndTimeRef.current = 0; // reset grace period
    recentHvRef.current = []; // reset HV history
    displayQueueRef.current = [];
    frameQueueRef.current   = [];
    collectingRef.current   = false;
    bleBufferRef.current    = '';
  }

  /**
   * isHvValid(hvVolts)
   *
   * Adaptive HV validation using a sliding window of recent readings.
   * - First 3 readings: always accepted (bootstrap phase)
   * - After 3 readings: accept if within ±30V of the median
   * - This rejects corrupted values (970V, 930V, 10V, 80V, etc.) while
   *   allowing normal device drift (±10-15V typical).
   */
  function isHvValid(hvVolts) {
    // Always accept if we don't have enough history yet
    if (recentHvRef.current.length < 3) {
      recentHvRef.current.push(hvVolts);
      return true;
    }

    // Calculate median of recent readings
    const sorted = [...recentHvRef.current].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // Accept if within ±30V of median
    const isValid = Math.abs(hvVolts - median) <= HV_DEVIATION_THRESHOLD;

    if (isValid) {
      // Add to sliding window
      recentHvRef.current.push(hvVolts);
      if (recentHvRef.current.length > HV_MEDIAN_WINDOW) {
        recentHvRef.current.shift();
      }
    } else {
      console.warn(`[BLE] Frame rejected: HV=${hvVolts}V is >30V from median=${median}V (likely corrupted)`);
    }

    return isValid;
  }

  /**
   * _startDrain()
   *
   * Ensures the 1-per-second drain timer is running.
   *
   * OPTIMIZATION STRATEGY:
   * - For responsive behavior at LOW frame rates (sporadic arrival like at 400HV):
   *   Dispatch the first frame IMMEDIATELY, not via RAF. This prevents lag.
   * - For HIGH frame rates (batched notifications like at 500+HV):
   *   RAF batching still applies to the initial _startDrain() call from the
   *   notification handler, which prevents flooding React. But once the drain
   *   timer is active, frames queue normally.
   * - Subsequent frames: released one per second by the interval.
   * - Auto-stop: when the queue becomes empty the interval clears itself.
   *
   * Guard: if the drain is already running when new frames are pushed, nothing
   * extra is needed — the interval will keep popping until empty.
   */
  function _startDrain() {
    if (displayDrainRef.current) return; // drain interval already running
    if (displayQueueRef.current.length === 0) return; // nothing to drain

    // IMMEDIATE dispatch of first frame (no RAF delay)
    // This ensures responsive behavior at low frame rates
    const first = displayQueueRef.current.shift();
    if (first) {
      pendingFrameRef.current = first;
      dispatch({ type: 'LIVE_COUNT', payload: first });
      onCountReceived?.(first.count);
    }

    if (displayQueueRef.current.length === 0) return; // nothing more to drain

    // Set up the 1-per-second interval for subsequent frames
    displayDrainRef.current = setInterval(() => {
      const frame = displayQueueRef.current.shift();
      if (frame) {
        pendingFrameRef.current = frame;
        dispatch({ type: 'LIVE_COUNT', payload: frame });
        onCountReceived?.(frame.count);
      }
      // Auto-cancel when queue drains completely
      if (displayQueueRef.current.length === 0) {
        clearInterval(displayDrainRef.current);
        displayDrainRef.current = null;
      }
    }, 1000);
  }

  // ─────────────────────────────────────────────────────────────
  // BLE monitor (characteristic notification callback)
  // ─────────────────────────────────────────────────────────────

  async function _startMonitor(device) {
    dispatch({ type: 'STATUS', payload: BLE_STATUS.DISCOVERING });
    bleBufferRef.current = '';

    try {
      await device.discoverAllServicesAndCharacteristics();
    } catch (e) {
      console.error('[BLE] Service discovery failed:', e.message, '| code:', e.errorCode);
      dispatch({ type: 'ERROR', payload: `Service discovery failed (code ${e.errorCode ?? '?'})` });
      isConnectingRef.current = false;
      return;
    }

    // Enumerate services to find the correct notify / write characteristics
    let notifySvcUUID  = null;
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
            ` | write=${ch.isWritableWithResponse}`,
          );
          const isPureNotify = (ch.isNotifiable || ch.isIndicatable) && !ch.isWritableWithResponse;
          if (!notifyCharUUID && isPureNotify) {
            notifySvcUUID  = svc.uuid;
            notifyCharUUID = ch.uuid;
          }
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

    // ── The core notification callback ──────────────────────────────────────
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

        // ── Gate: discard everything until startCollecting() is called ──────
        // This prevents HV-settling frames (emitted by the device between
        // STHV and SRTC) from ever reaching the display queue or count store.
        if (!collectingRef.current) return;

        // ── HV stabilization grace period ─────────────────────────────────
        // After SRTC, the device needs time to stabilize at the new HV voltage.
        // During the first 500ms, frames may still reflect old/intermediate voltages
        // or arrive from the pre-warm period. Discard them to ensure only stable data.
        const now = Date.now();
        if (now < stabilizationEndTimeRef.current) {
          console.log('[BLE] Discarding frame during stabilization grace period (HV settling)');
          return;
        }

        // ── Reassemble fragmented BLE packets ──────────────────────────────
        // Append raw bytes to the buffer and split on '!' terminators.
        // The tail after the last '!' (possibly empty or a partial frame)
        // is kept in bleBufferRef for the next notification.
        const raw = decodeCharValue(characteristic?.value);
        if (!raw) return; // empty notification
        
        bleBufferRef.current += raw;

        const parts = bleBufferRef.current.split('!');
        bleBufferRef.current = parts.pop() ?? ''; // save incomplete tail

        // ── Parse each complete segment ────────────────────────────────────
        const frames = [];
        for (const part of parts) {
          const parsed = parseFrames(part + '!');
          // Filter frames using adaptive HV validation
          for (const frame of parsed) {
            if (frame.hv === null || isHvValid(frame.hv)) {
              frames.push(frame);
            }
          }
        }

        if (frames.length === 0) return;

        console.log('[BLE] Frames received:', JSON.stringify(frames));

        // ── Enqueue every frame individually ───────────────────────────────
        // Each frame = 1 second of detector data, just like the Serial BT
        // Monitor displays one line per frame.  The drain timer will release
        // them one per second, producing a lag-free 1 Hz display update.
        for (const frame of frames) {
          frameQueueRef.current.push(frame);
          displayQueueRef.current.push(frame);
        }

        // RAF batching: Schedule drain with RAF only if not already scheduled.
        // This batches frequent frame notifications while keeping sporadic
        // ones responsive (via immediate _startDrain dispatch).
        if (!drainScheduledRef.current) {
          drainScheduledRef.current = true;
          requestAnimationFrame(() => {
            drainScheduledRef.current = false;
            _startDrain();
          });
        }
      },
    );
  }

  async function _connectToDevice(device) {
    if (isConnectingRef.current) return;
    isConnectingRef.current = true;

    _stopScan();
    dispatch({ type: 'STATUS', payload: BLE_STATUS.CONNECTING });
    console.log('[BLE] Connecting to', device.name ?? device.localName ?? device.id);

    try { await managerRef.current.cancelDeviceConnection(device.id); }
    catch (_) { /* no stale connection — fine */ }

    try {
      const connected = await device.connect({ timeout: 10_000, autoConnect: false });
      console.log('[BLE] Connected:', connected.id);
      dispatch({ type: 'CONNECTED', payload: connected });
      await new Promise(resolve => setTimeout(resolve, 400));
      await _startMonitor(connected);
    } catch (e) {
      console.error('[BLE] Connection failed:', e.message, '| code:', e.errorCode);
      dispatch({ type: 'ERROR', payload: `Connection failed (code ${e.errorCode ?? '?'})` });
      isConnectingRef.current = false;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────

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

    if (Platform.OS === 'android') {
      const granted = await requestAndroidPermissions();
      if (!granted) { dispatch({ type: 'STATUS', payload: BLE_STATUS.NO_PERM }); return; }
    }

    _stopMonitor();
    isConnectingRef.current = false;
    isScanningRef.current   = true;
    dispatch({ type: 'SCANNING', payload: true });
    console.log('[BLE] Scan started — no UUID filter, open discovery');

    manager.startDeviceScan(null, { allowDuplicates: false }, async (error, device) => {
      if (error) {
        console.error('[BLE] Scan error:', error.message, '| code:', error.errorCode);
        dispatch({ type: 'ERROR', payload: `Scan error (code ${error.errorCode ?? '?'})` });
        _stopScan();
        return;
      }
      if (!device) return;
      const name = device.localName ?? device.name ?? '';
      if (!name) return;

      console.log('[BLE] Discovered:', name, '| RSSI:', device.rssi, '| ID:', device.id);
      dispatch({ type: 'DEVICE_FOUND', payload: { id: device.id, name, rssi: device.rssi ?? 0 } });
      if (name.toLowerCase().includes(AUTO_CONNECT_KEYWORD.toLowerCase())) {
        console.log('[BLE] Detector found (awaiting manual connect):', name);
      }
    });

    scanTimerRef.current = setTimeout(() => {
      if (isScanningRef.current) {
        console.warn('[BLE] Scan timeout — no device found.');
        _stopScan();
        dispatch({ type: 'STATUS', payload: BLE_STATUS.NOT_FOUND });
      }
    }, SCAN_TIMEOUT_MS);
  }, [state.bleAdapterState, state.connectedDevice]);

  const connectToDevice = useCallback(async (deviceId) => {
    const manager = managerRef.current;
    if (!manager || isConnectingRef.current) return;
    isConnectingRef.current = true;

    _stopScan();
    dispatch({ type: 'STATUS', payload: BLE_STATUS.CONNECTING });

    try { await manager.cancelDeviceConnection(deviceId); } catch (_) { }
    await new Promise(resolve => setTimeout(resolve, 300));

    try {
      const device = await manager.connectToDevice(deviceId, { timeout: 10_000, autoConnect: false });
      console.log('[BLE] Manually connected to:', device.id);
      dispatch({ type: 'CONNECTED', payload: device });
      await new Promise(resolve => setTimeout(resolve, 400));
      await _startMonitor(device);
    } catch (e) {
      console.error('[BLE] Manual connect failed:', e.message, '| code:', e.errorCode);
      dispatch({ type: 'ERROR', payload: `Connection failed (code ${e.errorCode ?? '?'})` });
      isConnectingRef.current = false;
    }
  }, []);

  const disconnect = useCallback(async () => {
    _stopMonitor();
    const device = state.connectedDevice;
    if (device) { try { await device.cancelConnection(); } catch (_) { } }
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

  const sendCommand = useCallback(async (text) => {
    const device = state.connectedDevice;
    if (!device) { console.warn('[BLE] sendCommand: no connected device'); return false; }
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

  /**
   * startCollecting()
   *
   * Opens the collection gate.  Must be called immediately after the SRTC
   * command is confirmed sent to the device.  Any frames that arrived during
   * the HV-settling window (after STHV, before SRTC) are silently discarded
   * by the gate check inside the notification callback.
   *
   * The reassembly buffer is cleared so partial data from the pre-warm period
   * cannot bleed into the first real frame.
   *
   * A 500ms stabilization grace period is started to discard frames that
   * arrive during HV settling, ensuring only stable detector data is queued.
   */
  const startCollecting = useCallback(() => {
    bleBufferRef.current  = ''; // discard any pre-warm partial data
    collectingRef.current = true;
    // Start 500ms grace period to let HV stabilize before accepting frames
    stabilizationEndTimeRef.current = Date.now() + 500;
    console.log('[BLE] startCollecting: gate OPEN — frames will now be queued (after 500ms stabilization)');
  }, []);

  /**
   * stopCollecting()
   *
   * Closes the collection gate.  Call this when STPC is sent or a run is
   * manually aborted.  In-flight frames that arrive after this point are
   * discarded, preventing stale data from appearing after the run ends.
   */
  const stopCollecting = useCallback(() => {
    collectingRef.current = false;
    stabilizationEndTimeRef.current = 0; // reset grace period
    console.log('[BLE] stopCollecting: gate CLOSED — incoming frames discarded');
  }, []);

  /**
   * clearQueue()
   *
   * Stops the drain timer and empties both queues (display + frame).
   * Call this between iterations or at run start to guarantee a clean slate.
   * The collection gate is intentionally NOT touched here — it remains in
   * whatever state the caller set it to.
   */
  const clearQueue = useCallback(() => {
    if (displayDrainRef.current) {
      clearInterval(displayDrainRef.current);
      displayDrainRef.current = null;
    }
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    drainScheduledRef.current = false;
    stabilizationEndTimeRef.current = 0; // reset grace period
    recentHvRef.current = []; // reset HV history for next measurement
    displayQueueRef.current = [];
    frameQueueRef.current   = [];
    console.log('[BLE] clearQueue: display and frame queues flushed');
  }, []);

  const popFrame = useCallback(() => {
    return frameQueueRef.current.shift() ?? null;
  }, []);

  const flushFrames = useCallback(() => {
    const frames = [...frameQueueRef.current];
    frameQueueRef.current = [];
    return frames;
  }, []);

  return {
    bleAdapterState : state.bleAdapterState,
    status          : state.status,
    connectedDevice : state.connectedDevice,
    liveCount       : state.liveCount,
    liveHV          : state.liveHV,
    liveCountToken  : state.liveCountToken,
    errorMessage    : state.errorMessage,
    isScanning      : state.isScanning,
    isConnected     : state.status === BLE_STATUS.MONITORING,
    foundDevices    : state.foundDevices,
    requestPermissions,
    startScan,
    stopScan,
    connectToDevice,
    disconnect,
    reset,
    sendCommand,
    startCollecting,   // call after SRTC confirmed → opens frame gate
    stopCollecting,    // call after STPC / run abort → closes frame gate
    clearQueue,
    popFrame,
    flushFrames,
  };
}
