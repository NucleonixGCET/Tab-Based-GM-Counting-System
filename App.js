/**
 * GM Counting System — App.js
 * Visual design matches the NUCLEONIX GC-602A physical instrument.
 *
 * ACQ Modes  : PRESET_TIME (default) | CPS | CPM
 * PROG Cycle : OFF → ACQ_SELECT → TIME_ADJUST → READINGS_ADJUST
 *            → [ITERATION_ADJUST → DHV_ADJUST for PRESET_TIME only]
 *            → SAVE_CONFIRM → DATA_STORE → DATA_OUTPUT → DATA_RECALL → DATA_ERASE → OFF
 * HV Control : Arrow buttons at bottom of main panel (30 V or 50 V steps)
 * Global HV  : React Context (GMContext)
 */

import React, {
  useState,
  useEffect,
  useRef,
  useContext,
  createContext,
} from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
  StatusBar,
  SafeAreaView,
  ScrollView,
  LogBox,
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { useBleDetector } from './hooks/useBleDetector';

// Suppress known React Native internal touch-tracking warning (harmless,
// fires when a drag gesture exits the screen bounds).
LogBox.ignoreLogs(['Cannot record touch move without a touch start']);

// ─── Constants ───────────────────────────────────────────────────────────────
const DATABASE_NAME    = 'NP.db';
const HV_MIN           = 0;
const HV_MAX           = 1500;
const DEFAULT_HV       = 400;
const DEFAULT_PR_TIME  = 10;
const COUNT_RATE       = 127;

const ACQ_LABELS = {
  PRESET_TIME: 'PRESET TIME',
  CPS: 'CPS',
  CPM: 'CPM',
};

const ACQ_MODE_ORDER = ['PRESET_TIME', 'CPS', 'CPM'];

const PROG_OFF              = 'OFF';
const PROG_ACQ_SELECT       = 'ACQ_SELECT';
const PROG_TIME_ADJUST      = 'TIME_ADJUST';
const PROG_READINGS_ADJUST  = 'READINGS_ADJUST';
const PROG_ITERATION_ADJUST = 'ITERATION_ADJUST';
const PROG_DHV_ADJUST       = 'DHV_ADJUST';
const PROG_SAVE_CONFIRM     = 'SAVE_CONFIRM';
const PROG_SHOW_OK          = 'SHOW_OK';

const PROG_DATA_STORE  = 'DATA_STORE';
const PROG_DATA_OUTPUT = 'DATA_OUTPUT';
const PROG_DATA_RECALL = 'DATA_RECALL';
const PROG_DATA_ERASE  = 'DATA_ERASE';
const PROG_SET_HV      = 'SET_HV';        // set base HV before saving

const PROG_DATA_SUBS = [PROG_DATA_STORE, PROG_DATA_OUTPUT, PROG_DATA_RECALL, PROG_DATA_ERASE];

const BOOT_GEIGER    = 'BOOT_GEIGER';
const BOOT_NUCLEONIX = 'BOOT_NUCLEONIX';
const BOOT_READY     = 'BOOT_READY';

const STORE_MODE_AUTO    = 'AUTO';
const STORE_MODE_MANUAL  = 'MANUAL';
const OUTPUT_ROUTE_USB     = 'USB_PC';
const OUTPUT_ROUTE_PRINTER = 'PRINTER_D25';
const OUTPUT_ROUTE_LABELS  = {
  [OUTPUT_ROUTE_USB]:     'USB SERIAL → PC',
  [OUTPUT_ROUTE_PRINTER]: '25-PIN D → PRINTER',
};

const PARAM_FIELD_TIMER      = 'TIMER';
const PARAM_FIELD_READINGS   = 'READINGS';
const PARAM_FIELD_ITERATIONS = 'ITERATIONS';
const PARAM_FIELD_DHV        = 'DHV';

const numToDigits = (n) => {
  const s = String(Math.max(0, Math.min(9999, n))).padStart(4, '0');
  return s.split('').map(Number);
};
const digitsToNum = (d) => Math.max(1, d[0] * 1000 + d[1] * 100 + d[2] * 10 + d[3]);

// ─── Global GM Context ───────────────────────────────────────────────────────
export const GMContext = createContext(null);

function GMProvider({ children }) {
  const [hv, setHv]       = useState(DEFAULT_HV);
  const [screen, setScreen] = useState('connect');

  const countCallbackRef = useRef(null);

  const ble = useBleDetector({
    onCountReceived: (count) => {
      countCallbackRef.current?.(count);
    },
  });

  useEffect(() => {
    if (ble.isConnected) setScreen('main');
  }, [ble.isConnected]);

  return (
    <GMContext.Provider value={{ hv, setHv, ble, screen, setScreen, countCallbackRef }}>
      {children}
    </GMContext.Provider>
  );
}

export default function App() {
  return (
    <GMProvider>
      <GMCountingScreen />
    </GMProvider>
  );
}

// ─── Main Screen ─────────────────────────────────────────────────────────────
function GMCountingScreen() {
  const { hv, setHv } = useContext(GMContext);
  const [hvStep, setHvStep] = useState(30);
  const refHvRef = useRef(0);

  useEffect(() => {
    const iv = setInterval(() => {
      refHvRef.current = Math.max(0, hv + Math.floor((Math.random() - 0.5) * 6));
    }, 1000);
    return () => clearInterval(iv);
  }, [hv]);

  const [bootStage, setBootStage]             = useState(BOOT_GEIGER);
  const [storeDataMode, setStoreDataMode]     = useState(STORE_MODE_AUTO);
  const [outputRoute, setOutputRoute]         = useState(OUTPUT_ROUTE_USB);
  const [storedReadings, setStoredReadings]   = useState([]);
  const [recallIndex, setRecallIndex]         = useState(-1);
  const [recallIterIndex, setRecallIterIndex] = useState(0);
  const [pendingMeasurement, setPendingMeasurement] = useState(null);
  const [flashMessage, setFlashMessage]       = useState('');
  const [isBleMenuOpen, setIsBleMenuOpen]     = useState(false);


  const nextSerialNoRef    = useRef(1);
  const dbRef              = useRef(null);
  const flashTimeoutRef    = useRef(null);
  const rearPanelConfigRef = useRef({
    detectorInput:     'MHV SOCKET',
    powerInput:        '+12V ADAPTOR',
    printerPort:       '25-PIN D CONNECTOR',
    powerConnected:    true,
    detectorConnected: true,
  });

  const [acqMode, setAcqMode]           = useState('PRESET_TIME');
  const [draftAcqMode, setDraftAcqMode] = useState('PRESET_TIME');
  const [progSub, setProgSub]           = useState(PROG_OFF);
  const [cursorPos, setCursorPos]       = useState(0);
  const [draftDigits, setDraftDigits]   = useState([0, 0, 1, 0]);
  const [hvCursorPos, setHvCursorPos] = useState(0);
  const [draftHvDigits, setDraftHvDigits] = useState([0, 4, 0, 0]);
  const okTimeoutRef = useRef(null);

  const DEFAULT_ITERATIONS = 1;
  const [iterations, setIterations]           = useState(DEFAULT_ITERATIONS);
  const [draftIterations, setDraftIterations] = useState(DEFAULT_ITERATIONS);
  const [dHv, setDHv]         = useState(0);
  const [draftDHv, setDraftDHv] = useState(0);
  const [activeParamField, setActiveParamField] = useState(PARAM_FIELD_TIMER);

  const [currentIteration, setCurrentIteration] = useState(0);
  const iterationResultsRef = useRef([]);
  const programSessionRef   = useRef(null);

  const [counts, setCounts]                   = useState(0);
  const [displayedCounts, setDisplayedCounts] = useState(0);
  const [presetTime, setPresetTime]           = useState(DEFAULT_PR_TIME);
  const [isRunning, setIsRunning]             = useState(false);
  const [elapsedTime, setElapsedTime]         = useState(0);
  const [runningTotal, setRunningTotal]       = useState(0);  // cumulative PRESET_TIME sum across all iterations
  const [iterationRestartToken, setIterationRestartToken] = useState(0);
  const [blinkOn, setBlinkOn]                 = useState(true);  // blinking 'A' during counting
  const blinkTimerRef = useRef(null);

  const intervalRef        = useRef(null);
  const windowCountsRef    = useRef(0);
  const windowElapsedRef   = useRef(0);
  const cpmHistoryRef      = useRef([]);
  const displayedCountsRef = useRef(0);
  const elapsedTimeRef     = useRef(0);
  const bleIsConnectedRef  = useRef(false);
  const isRunningRef       = useRef(false);
  const acqModeRef         = useRef('PRESET_TIME');  // tracks acqMode for use inside BLE callback
  const bleCpsRef          = useRef(0);              // latest raw CPS from BLE (separate from CPM result)

  const { countCallbackRef, ble } = useContext(GMContext);

  useEffect(() => { bleIsConnectedRef.current = ble.isConnected; }, [ble.isConnected]);
  useEffect(() => { isRunningRef.current = isRunning; }, [isRunning]);
  useEffect(() => { acqModeRef.current = acqMode; }, [acqMode]);

  useEffect(() => {
    countCallbackRef.current = (count) => {
      if (!isRunningRef.current) return;
      bleCpsRef.current = count;            // always track latest raw BLE CPS
      displayedCountsRef.current = count;
      setCounts(count);
      // In CPM mode the 5-second window logic controls displayedCounts;
      // don't overwrite it here or the CPM result would be replaced every second.
      if (acqModeRef.current !== 'CPM') {
        setDisplayedCounts(count);
      }
      // NOTE: setCounts is intentionally NOT called here.
      // For PRESET_TIME, the counting interval accumulates counts via bleCpsRef;
      // calling setCounts(count) here would replace the accumulated total with
      // the raw CPS reading, making PRESET_TIME display look like CPS.
    };
    return () => { countCallbackRef.current = null; };
  }, []);

  // ── Database ─────────────────────────────────────────────────────────────
  useEffect(() => {
    try {
      const db = SQLite.openDatabaseSync(DATABASE_NAME);
      dbRef.current = db;
      db.execSync(`
        CREATE TABLE IF NOT EXISTS measurements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          serialNo INTEGER, value INTEGER, acqMode TEXT, presetTime INTEGER,
          numberOfReadings INTEGER, label TEXT, iterations INTEGER, dHv INTEGER,
          iterationResults TEXT, hv INTEGER, storeDataMode TEXT, outputRoute TEXT,
          detectorInput TEXT, powerInput TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);
      const cols = [
        'ALTER TABLE measurements ADD COLUMN serialNo INTEGER;',
        'ALTER TABLE measurements ADD COLUMN iterationResults TEXT;',
        'ALTER TABLE measurements ADD COLUMN hv INTEGER;',
        'ALTER TABLE measurements ADD COLUMN storeDataMode TEXT;',
        'ALTER TABLE measurements ADD COLUMN outputRoute TEXT;',
        'ALTER TABLE measurements ADD COLUMN detectorInput TEXT;',
        'ALTER TABLE measurements ADD COLUMN powerInput TEXT;',
      ];
      for (const sql of cols) { try { db.execSync(sql); } catch (_) {} }

      const rows = db.getAllSync('SELECT * FROM measurements ORDER BY serialNo ASC');
      if (rows && rows.length > 0) {
        const parsed = rows.map((r) => ({
          ...r,
          iterationResults: r.iterationResults ? JSON.parse(r.iterationResults) : [],
        }));
        setStoredReadings(parsed);
        nextSerialNoRef.current = parsed[parsed.length - 1].serialNo + 1;
        setRecallIndex(parsed.length - 1);
      }
    } catch (err) {
      console.error('DB init error:', err);
    }
  }, []);

  useEffect(() => {
    const g = setTimeout(() => setBootStage(BOOT_NUCLEONIX), 3000);
    const r = setTimeout(() => setBootStage(BOOT_READY), 6000);
    return () => { clearTimeout(g); clearTimeout(r); };
  }, []);

  useEffect(() => {
    return () => {
      if (okTimeoutRef.current)    clearTimeout(okTimeoutRef.current);
      if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
      if (blinkTimerRef.current)   clearInterval(blinkTimerRef.current);
    };
  }, []);

  // Blink the 'A' indicator every 500 ms while counting
  useEffect(() => {
    if (isRunning) {
      blinkTimerRef.current = setInterval(() => setBlinkOn((v) => !v), 500);
    } else {
      if (blinkTimerRef.current) clearInterval(blinkTimerRef.current);
      setBlinkOn(true);
    }
    return () => { if (blinkTimerRef.current) clearInterval(blinkTimerRef.current); };
  }, [isRunning]);

  // ── Programming Session ──────────────────────────────────────────────────
  const beginProgrammingSession = () => {
    const snap = { acqMode, presetTime, iterations, dHv };
    programSessionRef.current = snap;
    setDraftAcqMode(snap.acqMode);
    setDraftDigits(numToDigits(snap.presetTime));
    setCursorPos(0);
    setDraftIterations(snap.iterations);
    setDraftDHv(snap.dHv);
  };

  const discardProgrammingSession = () => {
    const snap = programSessionRef.current;
    if (snap) {
      setDraftAcqMode(snap.acqMode);
      setDraftDigits(numToDigits(snap.presetTime));
      setDraftIterations(snap.iterations);
      setDraftDHv(snap.dHv);
    }
    setCursorPos(0);
    setActiveParamField(PARAM_FIELD_TIMER);
    programSessionRef.current = null;
    setProgSub(PROG_OFF);   // SAVE is now last; discard just exits
  };

  const commitProgrammingSession = () => {
    setAcqMode(draftAcqMode);
    setPresetTime(digitsToNum(draftDigits));
    setIterations(draftIterations);
    setDHv(draftDHv);
    setActiveParamField(PARAM_FIELD_TIMER);
    programSessionRef.current = null;
    if (okTimeoutRef.current) clearTimeout(okTimeoutRef.current);
    setProgSub(PROG_SHOW_OK);
    okTimeoutRef.current = setTimeout(() => {
      setProgSub(PROG_OFF);   // SAVE is last; after OK just exit
      okTimeoutRef.current = null;
    }, 1000);
  };

  // ── Flash Message ────────────────────────────────────────────────────────
  const showFlashMessage = (msg, duration = 1500) => {
    if (flashTimeoutRef.current) clearTimeout(flashTimeoutRef.current);
    setFlashMessage(msg);
    flashTimeoutRef.current = setTimeout(() => {
      setFlashMessage('');
      flashTimeoutRef.current = null;
    }, duration);
  };

  // ── Data Storage ─────────────────────────────────────────────────────────
  const appendStoredMeasurement = (measurement) => {
    const entry = { ...measurement, serialNo: nextSerialNoRef.current };
    try {
      const db = dbRef.current;
      if (!db) throw new Error('DB not ready');
      db.runSync(`INSERT INTO measurements (
        serialNo, value, acqMode, presetTime, numberOfReadings,
        label, iterations, dHv, iterationResults, hv,
        storeDataMode, outputRoute, detectorInput, powerInput
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        entry.serialNo, entry.value, entry.acqMode, entry.presetTime, entry.numberOfReadings,
        'SP', entry.iterations, entry.dHv, JSON.stringify(entry.iterationResults || []), entry.hv,
        entry.storeDataMode, entry.outputRoute, entry.detectorInput, entry.powerInput,
      ]);
    } catch (err) { console.error('Store error:', err); }
    nextSerialNoRef.current += 1;
    setStoredReadings((prev) => [...prev, entry]);
    setRecallIndex(storedReadings.length);
    return entry;
  };

  const queueMeasurement = (value) => {
    const m = {
      value, acqMode,
      presetTime: (acqMode === 'CPS' || acqMode === 'CPM') ? elapsedTimeRef.current : presetTime,
      numberOfReadings: storedReadings.length,
      iterations, dHv,
      iterationResults: [...iterationResultsRef.current],
      hv, storeDataMode, outputRoute,
      detectorInput: rearPanelConfigRef.current.detectorInput,
      powerInput:    rearPanelConfigRef.current.powerInput,
    };
    if (storeDataMode === STORE_MODE_AUTO) {
      appendStoredMeasurement(m);
      setPendingMeasurement(null);
    } else {
      setPendingMeasurement(m);
    }
  };

  // ── Counting loop ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isRunning) return;
    intervalRef.current = setInterval(() => {
      const tick = bleIsConnectedRef.current ? 0 : Math.floor(COUNT_RATE + (Math.random() - 0.5) * 40);

      if (acqMode === 'PRESET_TIME') {
        // BLE: accumulate the latest BLE CPS reading each second (bleCpsRef is kept
        // up to date by the data callback without touching counts state).
        // Simulation: add random tick each second.
        const ptTick = bleIsConnectedRef.current ? bleCpsRef.current : tick;
        setCounts((c) => c + ptTick);
        setRunningTotal((r) => r + ptTick);  // dedicated cumulative display state
        setElapsedTime((prev) => {
          const next = prev + 1;
          if (next >= presetTime) {
            clearInterval(intervalRef.current);
            setCounts((finalCount) => {
              iterationResultsRef.current.push({ count: finalCount, refHv: refHvRef.current });
              const done = iterationResultsRef.current.length;
              if (done < iterations) {
                setTimeout(() => {
                  elapsedTimeRef.current = 0;
                  setElapsedTime(0);
                  setCurrentIteration(done + 1);
                  if (dHv > 0) setHv((v) => Math.min(v + dHv, HV_MAX));
                  setIterationRestartToken((v) => v + 1);
                }, 1000);
                return 0;   // reset immediately so runningSum shows correct cumulative during pause
              } else {
                const total = iterationResultsRef.current.reduce((a, b) => a + b.count, 0);
                displayedCountsRef.current = total;
                setDisplayedCounts(total);
                setCurrentIteration(0);
                setIsRunning(false);
                queueMeasurement(total);
                return finalCount;
              }
            });
            return prev;
          }
          return next;
        });

      } else if (acqMode === 'CPS') {
        if (bleIsConnectedRef.current) {
          iterationResultsRef.current.push({ timeUnit: iterationResultsRef.current.length + 1, count: displayedCountsRef.current, refHv: refHvRef.current });
          elapsedTimeRef.current += 1;
          setElapsedTime((t) => t + 1);
        } else {
          windowCountsRef.current += tick;
          const cps = windowCountsRef.current;
          displayedCountsRef.current = cps;
          setDisplayedCounts(cps);
          iterationResultsRef.current.push({ timeUnit: iterationResultsRef.current.length + 1, count: cps, refHv: refHvRef.current });
          windowCountsRef.current = 0;
          elapsedTimeRef.current += 1;
          setElapsedTime((t) => t + 1);
        }

      } else if (acqMode === 'CPM') {
        elapsedTimeRef.current += 1;
        setElapsedTime((t) => t + 1);
        
        const currentCps = bleIsConnectedRef.current ? bleCpsRef.current : tick;
        cpmHistoryRef.current.push(currentCps);
        
        // 5 second sliding window, updating every 2 seconds
        if (cpmHistoryRef.current.length >= 5) {
          if ((cpmHistoryRef.current.length - 5) % 2 === 0) {
            const last5 = cpmHistoryRef.current.slice(-5);
            const sum = last5.reduce((a, b) => a + b, 0);
            const cpm = sum * 12;
            displayedCountsRef.current = cpm;
            setDisplayedCounts(cpm);
            iterationResultsRef.current.push({ timeUnit: iterationResultsRef.current.length + 1, count: cpm, refHv: refHvRef.current });
          }
        }
      }
    }, 1000);
    return () => clearInterval(intervalRef.current);
  }, [isRunning, acqMode, presetTime, iterations, iterationRestartToken, hv, storeDataMode, outputRoute]);

  // ── PROG ─────────────────────────────────────────────────────────────────
  const handlePROG = () => {
    if (isRunning || bootStage !== BOOT_READY) return;
    if (progSub === PROG_SHOW_OK || flashMessage) return;

    if (progSub === PROG_OFF) { beginProgrammingSession(); setProgSub(PROG_ACQ_SELECT); return; }
    if (progSub === PROG_ACQ_SELECT) {
      if (draftAcqMode === 'CPS' || draftAcqMode === 'CPM') { setProgSub(PROG_READINGS_ADJUST); setActiveParamField(PARAM_FIELD_READINGS); }
      else { setCursorPos(0); setProgSub(PROG_TIME_ADJUST); setActiveParamField(PARAM_FIELD_TIMER); }
      return;
    }
    if (progSub === PROG_TIME_ADJUST)      { setProgSub(PROG_READINGS_ADJUST); setActiveParamField(PARAM_FIELD_READINGS); return; }
    if (progSub === PROG_READINGS_ADJUST)  {
      // CPS/CPM skip ITERATION and DHV steps — so they go straight to SET_HV then DATA_STORE
      if (draftAcqMode === 'CPS' || draftAcqMode === 'CPM') { setDraftHvDigits(numToDigits(hv)); setHvCursorPos(0); setProgSub(PROG_SET_HV); }
      else { setProgSub(PROG_ITERATION_ADJUST); setActiveParamField(PARAM_FIELD_ITERATIONS); }
      return;
    }
    if (progSub === PROG_ITERATION_ADJUST) { setDraftHvDigits(numToDigits(hv)); setHvCursorPos(0); setProgSub(PROG_SET_HV); return; }
    if (progSub === PROG_SET_HV)           {
      const newHv = digitsToNum(draftHvDigits);
      setHv(newHv);
      // ── Send HV command to scintillator device ──────────────────────────
      if (ble.isConnected) {
        const cmd = `STHV ${newHv}`;
        ble.sendCommand(cmd).then((ok) => {
          if (ok) showFlashMessage(`HV SET: ${newHv}V`);
          else    showFlashMessage('HV CMD FAILED');
        });
      }
      if (draftAcqMode === 'CPS' || draftAcqMode === 'CPM') setProgSub(PROG_DATA_STORE);
      else { setProgSub(PROG_DHV_ADJUST); setActiveParamField(PARAM_FIELD_DHV); }
      return;
    }
    if (progSub === PROG_DHV_ADJUST)       { setProgSub(PROG_DATA_STORE); return; }  // data subs first
    if (progSub === PROG_DATA_STORE)       { setProgSub(PROG_DATA_OUTPUT); return; }  // Export step before recall
    if (progSub === PROG_DATA_OUTPUT)      { setRecallIndex(storedReadings.length > 0 ? storedReadings.length - 1 : -1); setRecallIterIndex(0); setProgSub(PROG_DATA_RECALL); return; }
    if (progSub === PROG_DATA_RECALL)      { setProgSub(PROG_DATA_ERASE); return; }
    if (progSub === PROG_DATA_ERASE)       { setProgSub(PROG_SAVE_CONFIRM); return; }  // SAVE is last
    if (progSub === PROG_SAVE_CONFIRM)     { discardProgrammingSession(); }            // PROG → discard & exit
  };

  // ── Erase (defined here so handleUp/Down can reference it) ──────────────
  const handleEraseData = () => {
    if (progSub !== PROG_DATA_ERASE) return;
    try {
      dbRef.current?.runSync('DELETE FROM measurements');
      dbRef.current?.runSync("DELETE FROM sqlite_sequence WHERE name='measurements';");
    } catch (err) { console.error('Erase error:', err); }
    setStoredReadings([]);
    setPendingMeasurement(null);
    setRecallIndex(-1);
    nextSerialNoRef.current = 1;
    showFlashMessage('MEMORY CLEARED');
    setProgSub(PROG_OFF);
  };

  // ── ▲ / ▼ ────────────────────────────────────────────────────────────────
  const handleUp = () => {
    if (isRunning || bootStage !== BOOT_READY || flashMessage) return;
    if (progSub === PROG_DATA_STORE)  { setStoreDataMode((m) => m === STORE_MODE_AUTO ? STORE_MODE_MANUAL : STORE_MODE_AUTO); return; }
    if (progSub === PROG_DATA_OUTPUT) { handleExportDB(); return; }   // ▲ = confirm export
    if (progSub === PROG_DATA_RECALL) {
      if (storedReadings.length === 0) return;
      const _entry = storedReadings[recallIndex >= 0 ? recallIndex : 0];
      const _iLen  = _entry ? (_entry.iterationResults || []).length : 0;
      if (_iLen > 1 && recallIterIndex < _iLen - 1) {
        setRecallIterIndex((i) => i + 1);
      } else {
        setRecallIndex((i) => Math.min(i + 1, storedReadings.length - 1));
        setRecallIterIndex(0);
      }
      return;
    }
    if (progSub === PROG_DATA_ERASE)  { handleEraseData(); return; }
    if (progSub === PROG_SET_HV)      { setDraftHvDigits((p) => { const n = [...p]; n[hvCursorPos] = hvCursorPos === 0 ? (n[hvCursorPos] + 1) % 2 : (n[hvCursorPos] + 1) % 10; return n; }); return; }
    if (progSub === PROG_ACQ_SELECT)       { setDraftAcqMode((m) => ACQ_MODE_ORDER[(ACQ_MODE_ORDER.indexOf(m) + 1) % ACQ_MODE_ORDER.length]); }
    else if (progSub === PROG_TIME_ADJUST) { setDraftDigits((p) => { const n = [...p]; n[cursorPos] = (n[cursorPos] + 1) % 10; return n; }); }
    else if (progSub === PROG_ITERATION_ADJUST) { setDraftIterations((n) => Math.min(n + 1, 20)); }
    else if (progSub === PROG_DHV_ADJUST)       { setDraftDHv((v) => Math.min(v + 5, 100)); }
    else if (progSub === PROG_SAVE_CONFIRM)     { commitProgrammingSession(); }
  };

  const handleDown = () => {
    if (isRunning || bootStage !== BOOT_READY || flashMessage) return;
    if (progSub === PROG_DATA_STORE)  { setStoreDataMode((m) => m === STORE_MODE_AUTO ? STORE_MODE_MANUAL : STORE_MODE_AUTO); return; }
    if (progSub === PROG_DATA_OUTPUT) { setOutputRoute((r) => r === OUTPUT_ROUTE_USB ? OUTPUT_ROUTE_PRINTER : OUTPUT_ROUTE_USB); return; }  // ▼ = toggle route
    if (progSub === PROG_DATA_RECALL) {
      if (storedReadings.length === 0) return;
      if (recallIterIndex > 0) {
        setRecallIterIndex((i) => i - 1);
      } else {
        const prevIdx   = Math.max(recallIndex - 1, 0);
        const prevEntry = storedReadings[prevIdx];
        const prevILen  = prevEntry ? (prevEntry.iterationResults || []).length : 0;
        setRecallIndex(prevIdx);
        setRecallIterIndex(prevILen > 1 ? prevILen - 1 : 0);
      }
      return;
    }
    if (progSub === PROG_DATA_ERASE)  { handleEraseData(); return; }
    if (progSub === PROG_SET_HV)      { setHvCursorPos((p) => (p === 0 ? 3 : p - 1)); return; }
    if (progSub === PROG_ACQ_SELECT)       { setDraftAcqMode((m) => ACQ_MODE_ORDER[(ACQ_MODE_ORDER.indexOf(m) - 1 + ACQ_MODE_ORDER.length) % ACQ_MODE_ORDER.length]); }
    else if (progSub === PROG_TIME_ADJUST) { setCursorPos((p) => (p === 0 ? 3 : p - 1)); }
    else if (progSub === PROG_ITERATION_ADJUST) { setDraftIterations((n) => Math.max(n - 1, 1)); }
    else if (progSub === PROG_DHV_ADJUST)       { setDraftDHv((v) => Math.max(v - 5, 0)); }
    else if (progSub === PROG_SAVE_CONFIRM)     { commitProgrammingSession(); }
  };

  // ── START / STOP ─────────────────────────────────────────────────────────
  const handleSRT = () => {
    if (isRunning || bootStage !== BOOT_READY || progSub !== PROG_OFF || flashMessage) return;
    if (!rearPanelConfigRef.current.powerConnected || !rearPanelConfigRef.current.detectorConnected) {
      Alert.alert('Rear Panel Check', 'Connect +12V adaptor power and the G.M. detector on the MHV socket.');
      return;
    }
    setCounts(0); displayedCountsRef.current = 0; setDisplayedCounts(0);
    elapsedTimeRef.current = 0; setElapsedTime(0); setRunningTotal(0);
    windowCountsRef.current = 0; windowElapsedRef.current = 0; cpmHistoryRef.current = [];
    iterationResultsRef.current = [];
    setCurrentIteration(iterations > 1 ? 1 : 0);
    programSessionRef.current = null;
    setProgSub(PROG_OFF);
    setIsRunning(true);
  };

  const handleSTP = () => {
    clearInterval(intervalRef.current);
    setIsRunning(false);
    if (acqMode === 'CPS' || acqMode === 'CPM') queueMeasurement(displayedCountsRef.current);
  };

  // ── STORE ────────────────────────────────────────────────────────────────
  const handleSTORE = () => {
    // During SET_HV: STORE toggles the step size between 30V and 50V
    if (progSub === PROG_SET_HV) { setHvStep((s) => s === 30 ? 50 : 30); return; }
    if (bootStage !== BOOT_READY || isRunning || progSub !== PROG_OFF || flashMessage) return;
    if (storeDataMode === STORE_MODE_MANUAL) {
      if (!pendingMeasurement) { showFlashMessage('NO DATA TO STORE'); return; }
      appendStoredMeasurement(pendingMeasurement);
      setPendingMeasurement(null);
      showFlashMessage('DATA STORED');
    } else {
      showFlashMessage('AUTO STORE ENABLED');
    }
  };

  // handleEraseData is defined above (before handleUp/handleDown)

  const handleExportDB = async () => {
    try {
      if (dbRef.current) { try { dbRef.current.execSync('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (_) {} }
      const uri  = `${FileSystem.documentDirectory}SQLite/${DATABASE_NAME}`;
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists) { Alert.alert('Export Error', 'No database found.'); return; }
      if (Platform.OS === 'android') {
        const perm = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(
          'content://com.android.externalstorage.documents/tree/primary%3ADownload'
        );
        if (perm.granted && perm.directoryUri) {
          try {
            const files = await FileSystem.StorageAccessFramework.readDirectoryAsync(perm.directoryUri);
            for (const f of files) { if (f.endsWith(DATABASE_NAME)) await FileSystem.deleteAsync(f, { idempotent: true }); }
          } catch (_) {}
          const tgt    = await FileSystem.StorageAccessFramework.createFileAsync(perm.directoryUri, DATABASE_NAME, 'application/x-sqlite3');
          const b64    = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
          await FileSystem.writeAsStringAsync(tgt, b64, { encoding: FileSystem.EncodingType.Base64 });
          Alert.alert('Export Complete', `${DATABASE_NAME} saved.`);
          return;
        }
      }
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/x-sqlite3', dialogTitle: 'Export GM Database', UTI: 'public.database' });
      } else {
        Alert.alert('Export Error', 'Sharing not available.');
      }
    } catch (err) { Alert.alert('Export Failed', err.message); }
  };

  // ── Derived values ────────────────────────────────────────────────────────
  const remainingTime = acqMode === 'PRESET_TIME'
    ? Math.max(presetTime - elapsedTime, 0)
    : acqMode === 'CPM' ? Math.max(60 - windowElapsedRef.current, 0) : 0;

  const runningSum = iterationResultsRef.current.reduce((a, b) => a + (b.count ?? 0), 0) + counts;
  const displayResult = (acqMode === 'CPS' || acqMode === 'CPM')
    ? displayedCounts
    : (acqMode === 'PRESET_TIME' && isRunning) ? runningTotal
    : (!isRunning && iterationResultsRef.current.length > 0) ? displayedCounts
    : counts;

  const isBooting      = bootStage !== BOOT_READY;
  const isProgOn       = progSub !== PROG_OFF;
  const isDataSubMode  = PROG_DATA_SUBS.includes(progSub);
  const isProgEditMode = isProgOn && !isDataSubMode && progSub !== PROG_SHOW_OK;
  const memoryCount    = storedReadings.length;
  const currentRecallEntry = recallIndex >= 0 ? storedReadings[recallIndex] : null;
  const displayAcqMode = isProgEditMode ? draftAcqMode : acqMode;
  const draftPresetTime = digitsToNum(draftDigits);

  const formatCounts = (n) => String(n).padStart(6, '0');
  const formatPRTime = (n) => String(n).padStart(4, '0');
  const formatHV4    = (n) => typeof n === 'number' ? String(n).padStart(4, '0') : '----';

  // Recall computed values
  // PRESET_TIME → sum of all iteration counts
  // CPM → average of all minute counts
  // CPS → average of all second counts
  const recallDisplayCount = currentRecallEntry ? (() => {
    const r = currentRecallEntry.iterationResults || [];
    if (currentRecallEntry.acqMode === 'PRESET_TIME' && r.length > 0)
      return r.reduce((a, b) => a + (typeof b === 'object' ? b.count : b), 0);
    if ((currentRecallEntry.acqMode === 'CPM' || currentRecallEntry.acqMode === 'CPS') && r.length > 0) {
      const total = r.reduce((a, b) => a + (typeof b === 'object' ? b.count : b), 0);
      return Math.round(total / r.length);
    }
    return currentRecallEntry.value;
  })() : 0;

  // Iteration-aware count for recall display: shows each iteration's value when navigating
  const recallIterCount = (() => {
    if (!currentRecallEntry) return 0;
    const r = currentRecallEntry.iterationResults || [];
    if (r.length > 1 && recallIterIndex >= 0 && recallIterIndex < r.length) {
      const item = r[recallIterIndex];
      return typeof item === 'object' ? item.count : item;
    }
    return recallDisplayCount;
  })();

  // Average ref HV across all stored iteration results for this record
  const recallAvgRefHv = currentRecallEntry ? (() => {
    const r = currentRecallEntry.iterationResults || [];
    const hvVals = r
      .map((item) => (typeof item === 'object' ? item.refHv : null))
      .filter((v) => typeof v === 'number');
    if (hvVals.length === 0) return currentRecallEntry.hv;  // fall back to stored HV
    return Math.round(hvVals.reduce((a, b) => a + b, 0) / hvVals.length);
  })() : null;

  // LCD line 1: SN + PT
  const snStr = String(Math.max(0, nextSerialNoRef.current - 1)).padStart(4, '0');
  const ptStr = isRunning ? formatPRTime(remainingTime) : formatPRTime(presetTime);

  // PROG sub-mode icon — full 10-step cycle (SET_HV is 5th now)
  const progSubIcon =
    progSub === PROG_ACQ_SELECT        ? '①' : progSub === PROG_TIME_ADJUST     ? '②'
    : progSub === PROG_READINGS_ADJUST ? '③' : progSub === PROG_ITERATION_ADJUST? '④'
    : progSub === PROG_SET_HV          ? '⑤' : progSub === PROG_DHV_ADJUST      ? '⑥'
    : progSub === PROG_DATA_STORE      ? '⑦' : progSub === PROG_DATA_OUTPUT     ? '⑧'
    : progSub === PROG_DATA_RECALL     ? '⑨' : progSub === PROG_DATA_ERASE      ? '⑩'
    : progSub === PROG_SAVE_CONFIRM    ? '⑪' : '✓';

  // Hint bar
  const progLabel =
    isBooting                          ? 'Boot sequence in progress'
    : flashMessage                     ? flashMessage
    : progSub === PROG_ACQ_SELECT      ? '▲ / ▼ → Select ACQ Mode  ·  PROG → Next'
    : progSub === PROG_TIME_ADJUST     ? '▲ → Increment digit  ·  ▼ → Move cursor  ·  PROG → Next'
    : progSub === PROG_READINGS_ADJUST ? 'READINGS shows MEM count (read-only)  ·  PROG → Next'
    : progSub === PROG_ITERATION_ADJUST? '▲/▼ set iterations (1–9)  ·  PROG → Next'
    : progSub === PROG_DHV_ADJUST      ? '▲/▼ set delta HV step  ·  PROG → Next'
    : progSub === PROG_SAVE_CONFIRM    ? '▲ or ▼ → SAVE  ·  PROG → Discard & Continue'
    : progSub === PROG_SHOW_OK         ? 'Settings saved!'
    : progSub === PROG_DATA_STORE      ? '▲ / ▼ → Toggle AUTO/MANUAL  ·  PROG → Next'
    : progSub === PROG_DATA_OUTPUT     ? '▲ → EXPORT  ·  ▼ → Change route  ·  PROG → Skip'
    : progSub === PROG_DATA_RECALL     ? '▲ / ▼ → Navigate experiments  ·  PROG → Next'
    : progSub === PROG_DATA_ERASE      ? '▲ or ▼ → CONFIRM ERASE  ·  PROG → Cancel erase'
    : progSub === PROG_SET_HV          ? `▲ +${hvStep}V  ·  ▼ -${hvStep}V  ·  STORE ⇄ ${hvStep === 30 ? 50 : 30}V step  ·  PROG → Next`
    : storeDataMode === STORE_MODE_MANUAL
      ? 'STORE → save pending  ·  PROG → programming mode'
      : 'PROG → enter programming mode';

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="dark-content" backgroundColor={DEVICE_BG} />

      <View style={styles.outerPanel}>

        {/* ── Title ─────────────────────────────────────────────────────── */}
        <Text style={styles.deviceTitle}>G.M COUNTING SYSTEM (AT)</Text>

        {/* ── BLE Status Indicator (Premium pill) ───────────────────────── */}
        {!ble.isConnected && (
          <View style={styles.bleRegionOuter}>
            <View style={styles.bleRegion}>
              {isBleMenuOpen ? (
                <TouchableOpacity onPress={() => ble.startScan()} activeOpacity={0.7} style={styles.bleRegionTouch}>
                  <Text style={ble.isScanning ? styles.bleRegionTextHighlight : styles.bleRegionTextAction}>
                    {ble.isScanning ? '◉  SCANNING...' : '▶  START SCAN'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity onPress={() => setIsBleMenuOpen(true)} activeOpacity={0.7} style={styles.bleRegionTouch}>
                  <Text style={styles.bleRegionText}>◎  NOT CONNECTED</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* ── LCD Display ───────────────────────────────────────────────── */}
        <View style={styles.lcdOuter}>
          <View style={styles.lcdScreen}>

            {/* Boot */}
            {isBooting && (
              <View style={styles.lcdOverlay}>
                <Text style={styles.lcdBootText}>
                  {bootStage === BOOT_GEIGER ? 'GEIGER COUNTING' : 'NUCLEONIX SYSTEMS'}
                </Text>
              </View>
            )}

            {/* Flash message */}
            {!isBooting && flashMessage !== '' && (
              <View style={styles.lcdOverlay}>
                <Text style={styles.lcdFlashText}>{flashMessage}</Text>
              </View>
            )}

            {/* ══ BLE DEVICE LIST (inside LCD) ══ */}
            {!isBooting && flashMessage === '' && isBleMenuOpen && !ble.isConnected && (
              <View style={[styles.lcdOverlay, { paddingHorizontal: 14, paddingVertical: 8, backgroundColor: '#c8ce1a', alignItems: 'stretch' }]}>
                {/* Header */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', borderBottomWidth: 2, borderBottomColor: '#8a9000', paddingBottom: 5, marginBottom: 6 }}>
                  <Text style={{ fontFamily: MONO, fontWeight: '900', fontSize: 14, color: '#2a2e00', letterSpacing: 2 }}>
                    ◆ BLE DEVICES ({ble.foundDevices.length})
                  </Text>
                  <TouchableOpacity onPress={() => setIsBleMenuOpen(false)} hitSlop={{top:8,bottom:8,left:8,right:8}}>
                    <Text style={{ fontFamily: MONO, fontWeight: '900', fontSize: 12, color: '#6a0000', letterSpacing: 1 }}>[ESC]</Text>
                  </TouchableOpacity>
                </View>

                {ble.foundDevices.length === 0 ? (
                  <Text style={{ fontFamily: MONO, fontSize: 14, color: '#2a2e00', textAlign: 'center', marginTop: 14, opacity: 0.75, letterSpacing: 1 }}>
                    {ble.isScanning ? 'Scanning...' : 'No devices found.\nTap START SCAN.'}
                  </Text>
                ) : (
                  <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
                    {ble.foundDevices.map((d, i) => (
                      <View key={d.id} style={styles.bleDeviceRow}>
                        {/* Name + Address */}
                        <View style={{ flex: 1, marginRight: 8 }}>
                          <Text
                            style={{ fontFamily: MONO, fontWeight: '900', fontSize: 15, color: '#0a0d00', letterSpacing: 0.5 }}
                            numberOfLines={1}
                          >
                            {i + 1}. {d.name || 'Unknown'}
                          </Text>
                          <Text
                            style={{ fontFamily: MONO, fontSize: 11, color: '#3a4000', letterSpacing: 0.3, marginTop: 1 }}
                            numberOfLines={1}
                          >
                            {d.id || 'No address'}
                          </Text>
                        </View>
                        {/* Connect button */}
                        <TouchableOpacity
                          style={styles.bleConnectBtn}
                          onPress={() => { ble.connectToDevice(d.id); setIsBleMenuOpen(false); }}
                        >
                          <Text style={styles.bleConnectBtnText}>CONNECT</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                  </ScrollView>
                )}
              </View>
            )}

            {/* ══ DATA_STORE ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_DATA_STORE && (
              <View style={styles.lcdOverlay}>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>STORE</Text>
                  <Text style={styles.lcdPhysRight}>HV</Text>
                </View>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>{storeDataMode}</Text>
                  <Text style={styles.lcdPhysRight}>{formatHV4(hv)}</Text>
                </View>
              </View>
            )}

            {/* ══ DATA_OUTPUT (EXPORT) ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_DATA_OUTPUT && (
              <View style={styles.lcdOverlay}>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>EXPORT?</Text>
                  <Text style={styles.lcdPhysRight}>HV</Text>
                </View>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>DATA</Text>
                  <Text style={styles.lcdPhysRight}>{formatHV4(hv)}</Text>
                </View>
              </View>
            )}

            {/* ══ DATA_RECALL ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_DATA_RECALL && (
              <View style={styles.lcdOverlay}>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>RECALL</Text>
                </View>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>
                    {currentRecallEntry
                      ? String(currentRecallEntry.serialNo).padStart(4, '0')
                      : '----'}
                  </Text>
                  <Text style={styles.lcdPhysRight}>
                    {currentRecallEntry
                      ? String(recallIterCount).padStart(6, '0')
                      : ''}
                  </Text>
                </View>
              </View>
            )}

            {/* ══ DATA_ERASE ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_DATA_ERASE && (
              <View style={styles.lcdOverlay}>
                <Text style={[styles.lcdPhysLeft, { fontSize: 34, letterSpacing: 4, textAlign: 'center', width: '100%', marginVertical: 10 }]}>Erase?</Text>
              </View>
            )}

            {/* ══ SET_HV ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_SET_HV && (
              <View style={styles.lcdOverlay}>
                <View style={[styles.lcdPhysRow, { alignItems: "flex-end" }]}>
                  <View style={{ flex: 0, width: 120 }}>
                    <Text style={styles.lcdPhysLeft}>SET</Text>
                    <Text style={styles.lcdPhysLeft}>HV</Text>
                  </View>
                  <View style={{ flexDirection: "row", justifyContent: "center", flex: 1 }}>
                    {draftHvDigits.map((d, i) => (
                      <View key={`hvcol-${i}`} style={{ alignItems: "center", width: 30 }}>
                        <Text style={{ fontSize: 22, fontWeight: "900", color: "#0a2a6a", fontFamily: MONO, lineHeight: 24 }}>
                          {i === hvCursorPos ? "^" : " "}
                        </Text>
                        <Text style={{ fontSize: 28, fontWeight: "900", color: LCD_TEXT, fontFamily: MONO, lineHeight: 32 }}>
                          {d}
                        </Text>
                      </View>
                    ))}
                  </View>
                  <View style={{ width: 40 }} />
                </View>
              </View>
            )}

            {/* ══ SAVE? ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_SAVE_CONFIRM && (
              <View style={styles.lcdOverlay}>
                <Text style={[styles.lcdPhysLeft, { fontSize: 34, letterSpacing: 4, textAlign: 'center', width: '100%', marginVertical: 10 }]}>Save?</Text>
              </View>
            )}

            {/* ══ OK ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_SHOW_OK && (
              <View style={styles.lcdOverlay}>
                <Text style={[styles.lcdOverlayTitle, { fontSize: 52, letterSpacing: 8 }]}>OK</Text>
                <Text style={styles.lcdOverlaySub}>Settings saved!</Text>
              </View>
            )}

            {/* ══ READINGS_ADJUST ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_READINGS_ADJUST && (
              <View style={styles.lcdOverlay}>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>READINGS</Text>
                  <Text style={styles.lcdPhysRight}>HV</Text>
                </View>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>{formatPRTime(memoryCount)}</Text>
                  <Text style={styles.lcdPhysRight}>{formatHV4(hv)}</Text>
                </View>
              </View>
            )}

            {/* ══ ITERATION_ADJUST ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_ITERATION_ADJUST && (
              <View style={styles.lcdOverlay}>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>ITERATION</Text>
                  <Text style={styles.lcdPhysRight}>HV</Text>
                </View>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>{'     '}{draftIterations}</Text>
                  <Text style={styles.lcdPhysRight}>{formatHV4(hv)}</Text>
                </View>
              </View>
            )}

            {/* ══ DHV_ADJUST ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_DHV_ADJUST && (
              <View style={styles.lcdOverlay}>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>dHV STEP</Text>
                  <Text style={styles.lcdPhysRight}>HV</Text>
                </View>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>{`+${draftDHv} V`}</Text>
                  <Text style={styles.lcdPhysRight}>{formatHV4(hv)}</Text>
                </View>
              </View>
            )}

            {/* ══ ACQ_SELECT ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_ACQ_SELECT && (
              <View style={styles.lcdOverlay}>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>ACQ MODE</Text>
                  <Text style={styles.lcdPhysRight}>HV</Text>
                </View>
                <View style={styles.lcdPhysRow}>
                  <Text style={styles.lcdPhysLeft}>{ACQ_LABELS[displayAcqMode]}</Text>
                  <Text style={styles.lcdPhysRight}>{formatHV4(hv)}</Text>
                </View>
              </View>
            )}

            {/* ══ TIME_ADJUST — column-per-digit (cursor always aligned) ══ */}
            {!isBooting && flashMessage === '' && !isBleMenuOpen && progSub === PROG_TIME_ADJUST && (
              <View style={styles.lcdOverlay}>
                <View style={{ flexDirection: 'row', alignItems: 'center', width: '100%', paddingHorizontal: 14 }}>
                  {/* Left label */}
                  <View style={{ width: 80 }}>
                    <Text style={[styles.lcdPhysLeft, { fontSize: 20, lineHeight: 24 }]}>PRESET</Text>
                    <Text style={[styles.lcdPhysLeft, { fontSize: 20, lineHeight: 24 }]}>TIME</Text>
                  </View>
                  {/* Digit columns — cursor ^ sits directly above its digit in same View */}
                  <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'center' }}>
                    {draftDigits.map((d, i) => (
                      <View key={`dcol-${i}`} style={{ alignItems: 'center', width: 30, marginHorizontal: 2 }}>
                        {i === cursorPos
                          ? <Text style={{ fontSize: 16, fontWeight: '900', fontFamily: MONO, lineHeight: 18, color: '#0a2a6a' }}>^</Text>
                          : <View style={{ height: 18 }} />}
                        <Text style={{ fontSize: 30, fontWeight: '900', fontFamily: MONO,
                          color: i === cursorPos ? '#0a2a6a' : LCD_TEXT, lineHeight: 36 }}>{d}</Text>
                      </View>
                    ))}
                  </View>
                  {/* Right HV */}
                  <View style={{ width: 72, alignItems: 'flex-end' }}>
                    <Text style={{ fontFamily: MONO, fontSize: 13, color: LCD_TEXT, fontWeight: '700', lineHeight: 16 }}>HV</Text>
                    <Text style={{ fontFamily: MONO, fontSize: 20, color: LCD_TEXT, fontWeight: '900', lineHeight: 24 }}>{formatHV4(hv)}</Text>
                  </View>
                </View>
              </View>
            )}

            {/* ══ Main 2-line LCD display (PROG_OFF / non-overlay states) ══ */}
            {!isBooting
              && flashMessage === ''
              && !isBleMenuOpen
              && !isDataSubMode
              && progSub !== PROG_SAVE_CONFIRM
              && progSub !== PROG_SHOW_OK
              && progSub !== PROG_READINGS_ADJUST
              && progSub !== PROG_ITERATION_ADJUST
              && progSub !== PROG_DHV_ADJUST
              && progSub !== PROG_ACQ_SELECT
              && progSub !== PROG_SET_HV
              && progSub !== PROG_TIME_ADJUST && (
              <View style={styles.lcdMainContent}>
                {/* LINE 1: ET+PT (running) or SN+PT (idle) */}
                <Text style={styles.lcdLine}>
                  {isRunning
                    ? (acqMode === 'CPS' || acqMode === 'CPM'
                        ? `ET${formatPRTime(elapsedTime + 1)}  PT0000${blinkOn ? ' A' : '  '}`
                        : `ET${formatPRTime(Math.min(elapsedTime + 1, presetTime))}  PT${formatPRTime(presetTime)}${blinkOn ? ' A' : '  '}`)
                    : `SN${snStr}  PT${ptStr}`}
                </Text>
                {/* LINE 2: HV + COUNT */}
                <Text style={styles.lcdLine}>
                  {`HV${formatHV4(hv)}  ${formatCounts(displayResult)}`}
                </Text>
                {/* Sub-info line: mode + iteration */}
                <View style={styles.lcdSubRow}>
                  <Text style={styles.lcdSubText}>{ACQ_LABELS[acqMode]}</Text>
                  {currentIteration > 0 && isRunning && (
                    <Text style={styles.lcdSubText}> · Run {currentIteration}/{iterations}</Text>
                  )}
                </View>
              </View>
            )}

          </View>
        </View>

        {/* ── Button Panel (dark blue panel matching physical device) ─────── */}
        <View style={styles.buttonPanelWrapper}>
          <View style={styles.buttonGrid}>

            {/* Row 1: STORE | ▲ | START */}
            <View style={styles.buttonRow}>
              <TouchableOpacity style={styles.btn} onPress={handleSTORE} activeOpacity={0.75}>
                <Text style={styles.btnText}>STORE</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.btn} onPress={handleUp} activeOpacity={0.75}>
                <Text style={styles.arrowChar}>▲</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.btn} onPress={handleSRT} disabled={isRunning} activeOpacity={0.75}>
                <Text style={styles.btnText}>START</Text>
              </TouchableOpacity>
            </View>

            {/* Row 2: PROG | ▼ | STOP */}
            <View style={styles.buttonRow}>
              <TouchableOpacity
                style={[styles.btn, isProgEditMode && styles.btnProgActive]}
                onPress={handlePROG}
                activeOpacity={0.75}
              >
                <Text style={[styles.btnText, isProgOn && styles.btnTextProg]}>PROG</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.btn} onPress={handleDown} activeOpacity={0.75}>
                <Text style={styles.arrowChar}>▼</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.btn} onPress={handleSTP} activeOpacity={0.75}>
                <Text style={styles.btnText}>STOP</Text>
              </TouchableOpacity>
            </View>

          </View>
        </View>


        {/* ── Bottom bar ────────────────────────────────────────────────── */}
        <View style={styles.bottomBar}>
          <Image
            source={require('./NSPL-LOGO.jpg.jpeg')}
            style={styles.brandLogo}
            resizeMode="contain"
          />
          <Text style={styles.hintText}>NUCLEONIX</Text>
          <Text style={styles.modelText}>GC 602A</Text>
        </View>

      </View>
    </SafeAreaView>
  );
}

// ─── Design Tokens ────────────────────────────────────────────────────────────
// Physical device color palette
const DEVICE_BG   = '#7898b0';   // light steel-blue body (like the aluminum casing)
const FACE_PANEL  = '#6a8298';   // slightly darker face plate
const LABEL_TEXT  = '#0a1825';   // dark text on light panel background
const HINT_TEXT   = '#2a4050';   // medium dark for hint text

// LCD — bright positive display (yellow-green backlit, dark characters)
const LCD_OUTER   = '#2a2a10';   // dark LCD frame border
const LCD_BG      = '#c8d400';   // bright yellow-green LCD background
const LCD_TEXT    = '#1a1a00';   // very dark yellow-tint text
const LCD_LABEL   = '#3a3a10';   // slightly lighter label text

// Button panel (dark navy blue matching physical device button section)
const BTN_PANEL   = '#3b7782';   // dark teal face panel
const BTN_BG      = '#162848';   // button background
const BTN_BORDER  = '#e0f0ff';   // button border directly around button
const BTN_TEXT    = '#e0f0ff';   // near-white button text

const PROG_COLOR  = '#60a5fa';   // PROG mode highlight (blue)
const MONO        = 'monospace';

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = StyleSheet.create({

  safeArea: {
    flex: 1,
    backgroundColor: DEVICE_BG,
    alignItems: "center",
    justifyContent: "center",
    padding: 24, // Space from edges of the screen
  },

  outerPanel: {
    width: "100%",
    flex: 1,
    backgroundColor: FACE_PANEL,
    paddingVertical: 14,
    paddingHorizontal: 22,
    justifyContent: "space-between",
    alignItems: "center",
    borderWidth: 8,
    borderColor: "#111", // Black bolded borders
  },

  // ── Title ─────────────────────────────────────────────────────────────────
  deviceTitle: {
    fontSize: 40,
    fontWeight: '700',
    color: LABEL_TEXT,
    letterSpacing: 3,
    textAlign: 'center',
    fontFamily: MONO,
    marginBottom: 6,
  },

  // ── Info row (small chips) ────────────────────────────────────────────────
  infoRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 10,
  },
  infoChip: {
    fontSize: 12,
    color: '#2a4050',
    fontFamily: MONO,
    borderWidth: 1,
    borderColor: '#4a6888',
    borderRadius: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#5a7890',
  },
  infoChipActive: { backgroundColor: '#1a4060', borderColor: '#7ab8e8', color: '#c8e8ff' },
  infoChipRun:    { backgroundColor: '#1a4020', borderColor: '#3a8040', color: '#c8ffc8' },
  infoChipProg:   { backgroundColor: '#1a2a5a', borderColor: PROG_COLOR, color: '#a0c8ff' },

  // ── LCD Outer (bezel / frame) ─────────────────────────────────────────────
  lcdOuter: {
    width: "50%",
    alignSelf: 'center',
    borderWidth: 4,
    borderColor: LCD_OUTER,
    borderRadius: 4,
    marginBottom: 12,
  },

  lcdScreen: {
    backgroundColor: LCD_BG,
    height: 145,
    paddingVertical: 10,
    paddingHorizontal: 18,
    justifyContent: 'center',
    overflow: 'hidden',
  },

  // ── Main 2-line LCD content ───────────────────────────────────────────────
  lcdMainContent: {
    justifyContent: 'center',
  },
  lcdLine: {
    fontSize: 32,
    fontWeight: '700',
    color: LCD_TEXT,
    fontFamily: MONO,
    letterSpacing: 2,
    lineHeight: 42,
  },
  lcdSubRow: {
    flexDirection: 'row',
    marginTop: 4,
  },
  lcdSubText: {
    fontSize: 14,
    color: LCD_LABEL,
    fontFamily: MONO,
    fontWeight: '600',
    letterSpacing: 0.5,
  },

  // ── LCD Overlays (shown during PROG modes) ────────────────────────────────
  lcdOverlay: {
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    paddingVertical: 10,
    overflow: 'hidden',
  },

  // ── Physical 2-line LCD row layout (matches GC-602A display exactly) ────
  // Line 1: LABEL (left)          HV (right)
  // Line 2: VALUE (left)        XXXX (right)
  lcdPhysRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
    width: '100%',
    paddingHorizontal: 14,
    paddingVertical: 2,
  },
  lcdPhysLeft: {
    fontSize: 26,
    fontWeight: '900',
    color: LCD_TEXT,
    fontFamily: MONO,
    letterSpacing: 2,
    flex: 1,
  },
  lcdPhysRight: {
    fontSize: 26,
    fontWeight: '900',
    color: LCD_TEXT,
    fontFamily: MONO,
    letterSpacing: 2,
    textAlign: 'right',
  },

  lcdBootText: {
    fontSize: 30,
    fontWeight: '900',
    color: LCD_TEXT,
    fontFamily: MONO,
    letterSpacing: 2,
    textAlign: 'center',
  },
  lcdFlashText: {
    fontSize: 28,
    fontWeight: '900',
    color: LCD_TEXT,
    fontFamily: MONO,
    letterSpacing: 2,
    textAlign: 'center',
  },
  lcdOverlayTitle: {
    fontSize: 26,
    fontWeight: '900',
    color: '#3a2000',    // dark amber on bright LCD
    fontFamily: MONO,
    letterSpacing: 4,
    marginBottom: 4,
  },
  lcdOverlayValue: {
    fontSize: 36,
    fontWeight: '900',
    color: LCD_TEXT,
    fontFamily: MONO,
    letterSpacing: 3,
    marginVertical: 4,
  },
  lcdOverlaySub: {
    fontSize: 16,
    color: LCD_LABEL,
    fontFamily: MONO,
    marginTop: 3,
    textAlign: 'center',
  },

  // ── Digit editor (TIME_ADJUST) ────────────────────────────────────────────
  digitRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginTop: 6,
  },
  digitCell: { alignItems: 'center', width: 46 },
  digitCursor:       { fontSize: 18, fontWeight: '900', height: 22, lineHeight: 22 },
  digitCursorActive: { color: '#0a2a60' },
  digitCursorHidden: { color: 'transparent' },
  digitChar: {
    fontSize: 46,
    fontWeight: '900',
    color: LCD_TEXT,
    fontFamily: MONO,
  },
  digitCharActive: { color: '#0a2a6a' },
  digitUnit: {
    fontSize: 24,
    color: LCD_LABEL,
    fontFamily: MONO,
    marginBottom: 6,
    marginLeft: 6,
  },

  // ── LCD action buttons ────────────────────────────────────────────────────
  lcdExportBtn: {
    marginTop: 10,
    backgroundColor: '#3a2060',
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 6,
  },
  lcdExportBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  // Arrow-key confirmation box (replaces old "ERASE MEMORY" button)
  eraseConfirmBox: {
    marginVertical: 14,
    borderWidth: 2.5,
    borderColor: '#6a3a00',
    borderRadius: 6,
    paddingVertical: 10,
    paddingHorizontal: 28,
    backgroundColor: '#a8ae00',   // slightly darker than LCD to make it readable
    alignItems: 'center',
  },
  eraseConfirmArrow: {
    fontSize: 36,
    fontWeight: '900',
    color: '#1a1a00',
    fontFamily: MONO,
    letterSpacing: 18,
  },
  eraseConfirmLabel: {
    fontSize: 14,
    fontWeight: '800',
    color: '#3a2000',
    fontFamily: MONO,
    letterSpacing: 1.5,
    marginTop: 4,
  },


  // ── Recall table ──────────────────────────────────────────────────────────
  iterTable: {
    width: 280,
    marginTop: 8,
    backgroundColor: '#a0b000',
    borderWidth: 1,
    borderColor: LCD_OUTER,
  },
  iterTableHead: {
    flexDirection: 'row',
    backgroundColor: '#6a7800',
    paddingVertical: 5,
    paddingHorizontal: 10,
  },
  iterTableHdr: {
    flex: 1,
    fontSize: 14,
    fontWeight: '700',
    color: '#e8f000',
    textAlign: 'center',
    fontFamily: MONO,
  },
  iterTableRow: {
    flexDirection: 'row',
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#8a9a00',
  },
  iterTableCell: {
    flex: 1,
    fontSize: 16,
    color: LCD_TEXT,
    textAlign: 'center',
    fontFamily: MONO,
  },

  // ── Info row tags ──────────────────────────────────────────────────────────
  infoRow: {
    flexDirection: 'row',
    alignSelf: 'center',
    gap: 8,
    marginBottom: 6,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  infoChip: {
    backgroundColor: '#7ea4ba',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 4,
    color: '#0d1a33',
    fontFamily: MONO,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
    borderWidth: 1,
    borderColor: '#60869a',
  },
  infoChipRun: {
    backgroundColor: '#fdba74',
    borderColor: '#fb923c',
    color: '#7c2d12',
  },
  infoChipProg: {
    backgroundColor: '#60a5fa',
    borderColor: '#3b82f6',
    color: '#fff',
  },

  // ── BLE Connection Indicator (Flavored pill) ──────────────────────────────
  bleRegionOuter: {
    alignSelf: 'center',
    marginBottom: 12,
  },
  bleRegion: {
    backgroundColor: '#1a2430',      // dark instrument-chassis recess
    paddingHorizontal: 22,
    paddingVertical: 7,
    borderRadius: 20,               // pill shape
    borderWidth: 1.5,
    borderColor: '#2d3f50',
    alignItems: 'center',
    minWidth: 200,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 3,
  },
  bleRegionConnected: {
    backgroundColor: '#1b7a2f',      // solid green when connected
    borderColor: '#11561f',
    shadowColor: '#4ade80',
    shadowRadius: 10,
    shadowOpacity: 0.9,
    elevation: 6,
  },
  bleRegionTouch: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  bleRegionText: {
    fontFamily: MONO,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: '#4a6a5a',               // muted green when idle/not connected
    textAlign: 'center',
  },
  bleRegionTextAction: {
    fontFamily: MONO,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1.5,
    color: '#c8f7d0',               // pale green when ready to scan
    textAlign: 'center',
  },
  bleRegionTextHighlight: {
    fontFamily: MONO,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 2,
    color: '#4ade80',               // bright neon green when actively scanning
    textAlign: 'center',
  },

  // ── BLE Device list rows (inside LCD) ─────────────────────────────────────
  bleDeviceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    paddingBottom: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#9aab00',
  },
  bleConnectBtn: {
    backgroundColor: '#15223a',
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: '#dce8ff',
    marginLeft: 10,
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  bleConnectBtnText: {
    color: '#dce8ff',
    fontFamily: MONO,
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1,
  },

  // ── Button Panel Wrapper (matches dark teal plate from physical panel) ───
  buttonPanelWrapper: {
    alignSelf: 'center',
    backgroundColor: BTN_PANEL,
    borderRadius: 4,
    borderWidth: 4,
    borderColor: '#181e26',
    padding: 16,
    marginBottom: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 6,
  },

  buttonGrid: {
    gap: 16,
  },

  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 16,
  },

  // Big square buttons
  btn: {
    width: 90,
    height: 90,
    backgroundColor: BTN_BG,
    borderWidth: 2,
    borderColor: BTN_BORDER,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
    elevation: 4,
  },

  btnText: {
    fontSize: 20,
    fontWeight: '900',
    color: BTN_TEXT,
    letterSpacing: 1,
  },

  arrowChar: {
    fontSize: 50,
    color: BTN_TEXT,
    fontWeight: '900',
    marginTop: -8,
  },

  btnProgActive: {
    backgroundColor: '#1a2a5a',
    borderColor: PROG_COLOR,
  },
  btnTextProg: { color: PROG_COLOR },

  // ── HV Setting Panel ──────────────────────────────────────────────────────
  hvPanel: {
    width: '100%',
    backgroundColor: '#507090',   // matches the device body area
    borderWidth: 1.5,
    borderColor: '#3a5570',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 16,
    marginBottom: 8,
    alignItems: 'center',
  },
  hvTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#dce8ff',
    letterSpacing: 2.5,
    marginBottom: 6,
  },
  hvRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 6,
  },
  hvBtn: {
    width: 74,
    height: 52,
    backgroundColor: BTN_BG,
    borderWidth: 2,
    borderColor: BTN_BORDER,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    elevation: 3,
  },
  hvBtnDisabled: { opacity: 0.35 },
  hvBtnArrow: { fontSize: 22, color: BTN_TEXT, fontWeight: '900' },
  hvBtnStep:  { fontSize: 10, color: '#7ab8e8', fontWeight: '700', marginTop: 2 },

  hvDisplay: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: LCD_BG,
    borderWidth: 3,
    borderColor: LCD_OUTER,
    borderRadius: 3,
    paddingVertical: 6,
    paddingHorizontal: 10,
    gap: 4,
    shadowColor: '#c8d400',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    elevation: 4,
  },
  hvDisplayLabel: { fontSize: 14, color: LCD_LABEL, fontFamily: MONO, fontWeight: '700' },
  hvDisplayValue: {
    fontSize: 30,
    fontWeight: '900',
    color: LCD_TEXT,
    fontFamily: MONO,
    letterSpacing: 3,
  },
  hvDisplayUnit: { fontSize: 16, color: LCD_LABEL, fontFamily: MONO },

  hvStepRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hvStepLabel: { fontSize: 11, color: '#dce8ff', fontWeight: '700', letterSpacing: 0.5 },
  hvStepBtn: {
    paddingVertical: 4,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    borderColor: '#3a5570',
    borderRadius: 4,
    backgroundColor: BTN_BG,
  },
  hvStepBtnActive:   { backgroundColor: '#1a3a6a', borderColor: PROG_COLOR },
  hvStepTxt:         { fontSize: 13, fontWeight: '700', color: '#7ab8e8' },
  hvStepTxtActive:   { color: PROG_COLOR },

  // ── Bottom bar ────────────────────────────────────────────────────────────
  bottomBar: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  brandLogo: {
    width: 48,
    height: 48,
    borderRadius: 6,
  },
  brandText: {
    fontSize: 13,
    fontWeight: '800',
    color: LABEL_TEXT,
    letterSpacing: 1,
    fontFamily: MONO,
  },
  hintText: {
    flex: 1,
    fontSize: 20,
    color: LABEL_TEXT,
    textAlign: 'left',
    fontFamily: MONO,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginHorizontal: 8,
  },
  modelText: {
    fontSize: 24,
    fontWeight: '700',
    color: LABEL_TEXT,
    fontFamily: MONO,
    letterSpacing: 0.5,
  },
});



