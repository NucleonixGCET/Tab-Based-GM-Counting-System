/**
 * GM Counting System — App.js
 * Implements GM counting screen programming workflow
 *
 * ACQ Modes  : PRESET_TIME (default) | CPS | CPM
 * PROG Cycle : OFF → ACQ_SELECT → TIME_ADJUST → READINGS_ADJUST
 *            → LABEL_ASSIGN → ITERATION_ADJUST → SAVE_CONFIRM → OFF
 * HV Control : Draggable helipot slider (right = increase)
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
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Platform,
  StatusBar,
  SafeAreaView,
  Image,
  ScrollView,
} from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

// ─── Constants ───────────────────────────────────────────────────────────────
const DATABASE_NAME = 'NP.db';
const HV_MIN = 0;
const HV_MAX = 1200;
const DEFAULT_HV = 400;
const DEFAULT_PR_TIME = 10;   // seconds
const COUNT_RATE = 127;  // simulated counts / second


/** Display labels for each mode */
const ACQ_LABELS = {
  PRESET_TIME: 'PRESET TIME',
  CPS: 'CPS',
  CPM: 'CPM',
};

const ACQ_MODE_ORDER = ['PRESET_TIME', 'CPS', 'CPM'];

/** PROG sub-mode cycle states */
const PROG_OFF = 'OFF';
const PROG_ACQ_SELECT = 'ACQ_SELECT';      // ① ▲/▼ cycle ACQ mode
const PROG_TIME_ADJUST = 'TIME_ADJUST';     // ② ▲ increment digit · ▼ move cursor left
const PROG_READINGS_ADJUST = 'READINGS_ADJUST'; // ③ ▲ increment digit · ▼ move cursor left
const PROG_LABEL_ASSIGN = 'LABEL_ASSIGN';    // ④ ▲/▼ cycle label: SP → ST → BG
const PROG_ITERATION_ADJUST = 'ITERATION_ADJUST'; // ⑤ ▲/▼ set iteration count (1–9)
const PROG_DHV_ADJUST = 'DHV_ADJUST';       // ⑥ ▲/▼ set delta HV
const PROG_SAVE_CONFIRM = 'SAVE_CONFIRM';      // ⑦ press ▲/▼ to save · PROG to discard
const PROG_SHOW_OK = 'SHOW_OK';           // transient 1-second OK flash

const BOOT_GEIGER = 'BOOT_GEIGER';
const BOOT_NUCLEONIX = 'BOOT_NUCLEONIX';
const BOOT_READY = 'BOOT_READY';

const DATA_OFF = 'DATA_OFF';
const DATA_STORE_MODE = 'DATA_STORE_MODE';
const DATA_OUTPUT_ROUTE = 'DATA_OUTPUT_ROUTE';
const DATA_RECALL = 'DATA_RECALL';
const DATA_ERASE_CONFIRM = 'DATA_ERASE_CONFIRM';
const DATA_MESSAGE = 'DATA_MESSAGE';

const STORE_MODE_AUTO = 'AUTO';
const STORE_MODE_MANUAL = 'MANUAL';
const OUTPUT_ROUTE_USB = 'USB_PC';
const OUTPUT_ROUTE_PRINTER = 'PRINTER_D25';
const OUTPUT_ROUTE_LABELS = {
  [OUTPUT_ROUTE_USB]: 'USB SERIAL -> PC',
  [OUTPUT_ROUTE_PRINTER]: '25-PIN D -> PRINTER',
};

/** Dashboard parameter field states (replacement for 6-stage PROG cycle) */
const PARAM_FIELD_TIMER = 'TIMER';
const PARAM_FIELD_READINGS = 'READINGS';
const PARAM_FIELD_LABEL = 'LABEL';
const PARAM_FIELD_ITERATIONS = 'ITERATIONS';
const PARAM_FIELD_DHV = 'DHV';

const PARAM_FIELD_ORDER = [PARAM_FIELD_TIMER, PARAM_FIELD_READINGS, PARAM_FIELD_LABEL, PARAM_FIELD_ITERATIONS, PARAM_FIELD_DHV];

/** Label options */
const LABEL_OPTIONS = ['SP', 'ST', 'BG'];
const LABEL_NAMES = { SP: 'Sample', ST: 'Standard', BG: 'Background' };

/** Convert a 1–9999 number into [thousands, hundreds, tens, units] digit array */
const numToDigits = (n) => {
  const s = String(Math.max(0, Math.min(9999, n))).padStart(4, '0');
  return s.split('').map(Number);
};
/** Convert a digit array back to a number (min 1) */
const digitsToNum = (d) => Math.max(1, d[0] * 1000 + d[1] * 100 + d[2] * 10 + d[3]);

// ─── Global GM Context ───────────────────────────────────────────────────────
export const GMContext = createContext(null);

function GMProvider({ children }) {
  const [hv, setHv] = useState(DEFAULT_HV);
  return (
    <GMContext.Provider value={{ hv, setHv }}>
      {children}
    </GMContext.Provider>
  );
}

// ─── Root Export ─────────────────────────────────────────────────────────────
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
  const [hvStep, setHvStep] = useState(30); // HV jump: 30 V or 50 V
  const [refHv, setRefHv] = useState(0);
  const refHvRef = useRef(0);

  useEffect(() => {
    const iv = setInterval(() => {
      // Simulate live hardware analogue voltage returns
      const activeHv = Math.max(0, hv + Math.floor((Math.random() - 0.5) * 6));
      setRefHv(activeHv);
      refHvRef.current = activeHv;
    }, 1000);
    return () => clearInterval(iv);
  }, [hv]);

  const [bootStage, setBootStage] = useState(BOOT_GEIGER);
  const [dataMode, setDataMode] = useState(DATA_OFF);
  const [storeDataMode, setStoreDataMode] = useState(STORE_MODE_AUTO);
  const [outputRoute, setOutputRoute] = useState(OUTPUT_ROUTE_USB);
  const [storedReadings, setStoredReadings] = useState([]);
  const [recallIndex, setRecallIndex] = useState(-1);
  const [pendingMeasurement, setPendingMeasurement] = useState(null);
  const [dataMessage, setDataMessage] = useState('');
  const nextSerialNoRef = useRef(1);
  const dataModeTimeoutRef = useRef(null);
  const rearPanelConfigRef = useRef({
    detectorInput: 'MHV SOCKET',
    powerInput: '+12V ADAPTOR',
    printerPort: '25-PIN D CONNECTOR',
    powerConnected: true,
    detectorConnected: true,
  });

  // Acquisition
  const [acqMode, setAcqMode] = useState('PRESET_TIME');
  const [draftAcqMode, setDraftAcqMode] = useState('PRESET_TIME');
  const [progSub, setProgSub] = useState(PROG_OFF);   // PROG cycle state

  // Preset-time digit editing (used during PROG_TIME_ADJUST)
  const [cursorPos, setCursorPos] = useState(0);           // 0=thousands … 3=units
  const [draftDigits, setDraftDigits] = useState([0, 0, 1, 0]);
  const okTimeoutRef = useRef(null);

  // Label assignment (used during PROG_LABEL_ASSIGN)
  const [label, setLabel] = useState('SP');
  const [draftLabel, setDraftLabel] = useState('SP');

  // Iteration & dHV (used during PROG cycles)
  const DEFAULT_ITERATIONS = 1;
  const [iterations, setIterations] = useState(DEFAULT_ITERATIONS);      // committed
  const [draftIterations, setDraftIterations] = useState(DEFAULT_ITERATIONS); // staging
  const [dHv, setDHv] = useState(0);              // committed delta HV
  const [draftDHv, setDraftDHv] = useState(0);    // staging delta HV
  const [activeParamField, setActiveParamField] = useState(PARAM_FIELD_TIMER);  // NEW: tracks which parameter is shown
  // Runtime iteration tracking
  const [currentIteration, setCurrentIteration] = useState(0);           // which cycle we're on
  const iterationResultsRef = useRef([]);                                  // accumulated counts
  const programSessionRef = useRef(null);

  // Counting state
  const [counts, setCounts] = useState(0);
  const [displayedCounts, setDisplayedCounts] = useState(0); // last completed window
  const [presetTime, setPresetTime] = useState(DEFAULT_PR_TIME);
  const [isRunning, setIsRunning] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [iterationRestartToken, setIterationRestartToken] = useState(0);

  const intervalRef = useRef(null);
  const windowCountsRef = useRef(0);  // accumulator for current CPS/CPM window
  const windowElapsedRef = useRef(0);  // seconds elapsed within current window

  // ── Database Initialization ───────────────────────────────────────────────
  useEffect(() => {
    try {
      const db = SQLite.openDatabaseSync(DATABASE_NAME);
      db.execSync(`
        CREATE TABLE IF NOT EXISTS measurements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          serialNo INTEGER,
          value INTEGER,
          acqMode TEXT,
          presetTime INTEGER,
          numberOfReadings INTEGER,
          label TEXT,
          iterations INTEGER,
          dHv INTEGER,
          iterationResults TEXT,
          hv INTEGER,
          storeDataMode TEXT,
          outputRoute TEXT,
          detectorInput TEXT,
          powerInput TEXT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        );
      `);

      const rows = db.getAllSync('SELECT * FROM measurements ORDER BY serialNo ASC');
      if (rows && rows.length > 0) {
        const parsedRows = rows.map((r) => ({
          ...r,
          iterationResults: r.iterationResults ? JSON.parse(r.iterationResults) : [],
        }));
        setStoredReadings(parsedRows);
        const maxSerial = parsedRows[parsedRows.length - 1].serialNo;
        nextSerialNoRef.current = maxSerial + 1;
        setRecallIndex(parsedRows.length - 1);
      }
    } catch (err) {
      console.error('Failed to initialize local GM Database:', err);
    }
  }, []);

  useEffect(() => {
    const geigerTimer = setTimeout(() => setBootStage(BOOT_NUCLEONIX), 3000);
    const readyTimer = setTimeout(() => setBootStage(BOOT_READY), 6000);

    return () => {
      clearTimeout(geigerTimer);
      clearTimeout(readyTimer);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (okTimeoutRef.current) {
        clearTimeout(okTimeoutRef.current);
      }
      if (dataModeTimeoutRef.current) {
        clearTimeout(dataModeTimeoutRef.current);
      }
    };
  }, []);

  const beginProgrammingSession = () => {
    const snapshot = {
      acqMode,
      presetTime,
      label,
      iterations,
      dHv,
    };

    programSessionRef.current = snapshot;
    setDraftAcqMode(snapshot.acqMode);
    setDraftDigits(numToDigits(snapshot.presetTime));
    setCursorPos(0);
    setDraftLabel(snapshot.label);
    setDraftIterations(snapshot.iterations);
    setDraftDHv(snapshot.dHv);
  };

  const discardProgrammingSession = () => {
    const snapshot = programSessionRef.current;

    if (snapshot) {
      setDraftAcqMode(snapshot.acqMode);
      setDraftDigits(numToDigits(snapshot.presetTime));
      setDraftLabel(snapshot.label);
      setDraftIterations(snapshot.iterations);
      setDraftDHv(snapshot.dHv);
    }

    setCursorPos(0);
    setActiveParamField(PARAM_FIELD_TIMER);  // Reset to default parameter
    programSessionRef.current = null;
    setProgSub(PROG_OFF);
  };

  const commitProgrammingSession = () => {
    const nextPresetTime = digitsToNum(draftDigits);

    setAcqMode(draftAcqMode);
    setPresetTime(nextPresetTime);
    setLabel(draftLabel);
    setIterations(draftIterations);
    setDHv(draftDHv);
    setActiveParamField(PARAM_FIELD_TIMER);  // Reset to default parameter
    programSessionRef.current = null;

    if (okTimeoutRef.current) {
      clearTimeout(okTimeoutRef.current);
    }

    setProgSub(PROG_SHOW_OK);
    okTimeoutRef.current = setTimeout(() => {
      setProgSub(PROG_OFF);
      okTimeoutRef.current = null;
    }, 1000);
  };

  const showDataMessage = (message, duration = 1000) => {
    if (dataModeTimeoutRef.current) {
      clearTimeout(dataModeTimeoutRef.current);
    }

    setDataMessage(message);
    setDataMode(DATA_MESSAGE);
    dataModeTimeoutRef.current = setTimeout(() => {
      setDataMode(DATA_OFF);
      setDataMessage('');
      dataModeTimeoutRef.current = null;
    }, duration);
  };

  const appendStoredMeasurement = (measurement) => {
    const entry = {
      ...measurement,
      serialNo: nextSerialNoRef.current,
    };

    try {
      const db = SQLite.openDatabaseSync(DATABASE_NAME);
      db.runSync(`
        INSERT INTO measurements (
          serialNo, value, acqMode, presetTime, numberOfReadings,
          label, iterations, dHv, iterationResults, hv,
          storeDataMode, outputRoute, detectorInput, powerInput
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?
        )`,
        [
          entry.serialNo, entry.value, entry.acqMode, entry.presetTime, entry.numberOfReadings,
          entry.label, entry.iterations, entry.dHv, JSON.stringify(entry.iterationResults || []), entry.hv,
          entry.storeDataMode, entry.outputRoute, entry.detectorInput, entry.powerInput
        ]
      );
    } catch (err) {
      console.error('Failed to store reading into Database:', err);
    }

    nextSerialNoRef.current += 1;
    setStoredReadings((prev) => [...prev, entry]);
    setRecallIndex(storedReadings.length);

    return entry;
  };

  const queueMeasurement = (value) => {
    const measurement = {
      value,
      acqMode,
      presetTime: (acqMode === 'CPS' || acqMode === 'CPM') ? elapsedTime : presetTime,
      numberOfReadings: storedReadings.length,
      label,
      iterations,
      dHv,
      iterationResults: [...iterationResultsRef.current],
      hv,
      storeDataMode,
      outputRoute,
      detectorInput: rearPanelConfigRef.current.detectorInput,
      powerInput: rearPanelConfigRef.current.powerInput,
    };

    if (storeDataMode === STORE_MODE_AUTO) {
      appendStoredMeasurement(measurement);
      setPendingMeasurement(null);
      return;
    }

    setPendingMeasurement(measurement);
  };

  const cycleDataMode = () => {
    if (dataMode === DATA_OFF) {
      setDataMode(DATA_STORE_MODE);
      return;
    }

    if (dataMode === DATA_STORE_MODE) {
      setDataMode(DATA_OUTPUT_ROUTE);
      return;
    }

    if (dataMode === DATA_OUTPUT_ROUTE) {
      setRecallIndex(storedReadings.length > 0 ? storedReadings.length - 1 : -1);
      setDataMode(DATA_RECALL);
      return;
    }

    if (dataMode === DATA_RECALL) {
      setDataMode(DATA_ERASE_CONFIRM);
      return;
    }

    if (dataMode === DATA_ERASE_CONFIRM) {
      setDataMode(DATA_OFF);
    }
  };

  // ── Counting loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isRunning) return;

    intervalRef.current = setInterval(() => {
      // Simulate one tick of GM tube counts
      const tick = Math.floor(COUNT_RATE + (Math.random() - 0.5) * 40);

      if (acqMode === 'PRESET_TIME') {
        // ── Preset Time: accumulate counts, auto-stop (or repeat for iterations) ──
        setCounts((c) => c + tick);
        setElapsedTime((prev) => {
          const next = prev + 1;
          if (next >= presetTime) {
            clearInterval(intervalRef.current);
            // Store this cycle's count
            setCounts((finalCount) => {
              iterationResultsRef.current.push({ count: finalCount, refHv: refHvRef.current });
              const doneCount = iterationResultsRef.current.length;
              if (doneCount < iterations) {
                // More iterations to go — auto-restart after a brief pause
                setTimeout(() => {
                  setCounts(0);
                  setElapsedTime(0);
                  setCurrentIteration(doneCount + 1);
                  if (dHv > 0) {
                    setHv((currentHv) => Math.min(currentHv + dHv, HV_MAX));
                  }
                  setIterationRestartToken((v) => v + 1);
                }, 400);
              } else {
                // All done — compute and display average
                const total = iterationResultsRef.current.reduce((a, b) => a + b.count, 0);
                const avg = Math.round(total / doneCount);
                const completedValue = doneCount > 1 ? avg : finalCount;
                setDisplayedCounts(avg);
                setCurrentIteration(0);
                setIsRunning(false);
                queueMeasurement(completedValue);
              }
              return finalCount;
            });
            return prev;
          }
          return next;
        });

      } else if (acqMode === 'CPS') {
        // ── CPS: show count for every individual second, reset each second ─
        windowCountsRef.current += tick;
        const cpsValue = windowCountsRef.current;
        setDisplayedCounts(cpsValue);   // update display every second
        
        // Push the active CPS into the history array for RECALL
        iterationResultsRef.current.push({ timeUnit: iterationResultsRef.current.length + 1, count: cpsValue, refHv: refHvRef.current });
        
        windowCountsRef.current = 0;    // reset for next second
        setElapsedTime((t) => t + 1);

      } else if (acqMode === 'CPM') {
        // ── CPM: accumulate for 60 s, snapshot, reset, repeat ─────────────
        windowCountsRef.current += tick;
        windowElapsedRef.current += 1;
        setElapsedTime((t) => t + 1);

        if (windowElapsedRef.current >= 60) {
          const cpmValue = windowCountsRef.current;
          setDisplayedCounts(cpmValue); // snapshot completed minute
          
          // Push active CPM into the history array
          iterationResultsRef.current.push({ timeUnit: iterationResultsRef.current.length + 1, count: cpmValue, refHv: refHvRef.current });
          
          windowCountsRef.current = 0;               // reset
          windowElapsedRef.current = 0;
        }
      }
    }, 1000);

    return () => clearInterval(intervalRef.current);
  }, [
    isRunning,
    acqMode,
    presetTime,
    iterations,
    iterationRestartToken,
    label,
    hv,
    storeDataMode,
    outputRoute,
  ]);

  // ── PROG cycle handler ────────────────────────────────────────────────────
  const handlePROG = () => {
    if (isRunning || bootStage !== BOOT_READY || dataMode !== DATA_OFF) return;
    if (progSub === PROG_SHOW_OK) return;

    // Initial press: enter programming mode
    if (progSub === PROG_OFF) {
      beginProgrammingSession();
      setProgSub(PROG_ACQ_SELECT);
      return;
    }

    // From ACQ_SELECT, move to TIME_ADJUST or skip for CPS/CPM
    if (progSub === PROG_ACQ_SELECT) {
      if (draftAcqMode === 'CPS' || draftAcqMode === 'CPM') {
        setProgSub(PROG_READINGS_ADJUST);
        setActiveParamField(PARAM_FIELD_READINGS);
      } else {
        setCursorPos(0);
        setProgSub(PROG_TIME_ADJUST);
        setActiveParamField(PARAM_FIELD_TIMER);
      }
      return;
    }

    // From TIME_ADJUST, cycle to READINGS_ADJUST
    if (progSub === PROG_TIME_ADJUST) {
      setProgSub(PROG_READINGS_ADJUST);
      setActiveParamField(PARAM_FIELD_READINGS);
      return;
    }

    // From READINGS_ADJUST, cycle to LABEL_ASSIGN
    if (progSub === PROG_READINGS_ADJUST) {
      setProgSub(PROG_LABEL_ASSIGN);
      setActiveParamField(PARAM_FIELD_LABEL);
      return;
    }

    // From LABEL_ASSIGN, cycle to ITERATION_ADJUST or skip for CPS/CPM
    if (progSub === PROG_LABEL_ASSIGN) {
      if (draftAcqMode === 'CPS' || draftAcqMode === 'CPM') {
        setProgSub(PROG_SAVE_CONFIRM);
      } else {
        setProgSub(PROG_ITERATION_ADJUST);
        setActiveParamField(PARAM_FIELD_ITERATIONS);
      }
      return;
    }

    // From ITERATION_ADJUST, cycle to DHV_ADJUST
    if (progSub === PROG_ITERATION_ADJUST) {
      setProgSub(PROG_DHV_ADJUST);
      setActiveParamField(PARAM_FIELD_DHV);
      return;
    }

    // From DHV_ADJUST, move to SAVE_CONFIRM
    if (progSub === PROG_DHV_ADJUST) {
      setProgSub(PROG_SAVE_CONFIRM);
      return;
    }

    // From SAVE_CONFIRM, discard and exit
    if (progSub === PROG_SAVE_CONFIRM) {
      discardProgrammingSession();
    }
  };

  // ── ▲ / ▼ handlers ────────────────────────────────────────────────────────
  const handleUp = () => {
    if (isRunning || bootStage !== BOOT_READY) return;

    if (dataMode === DATA_STORE_MODE) {
      setStoreDataMode((mode) => (mode === STORE_MODE_AUTO ? STORE_MODE_MANUAL : STORE_MODE_AUTO));
      return;
    }

    if (dataMode === DATA_OUTPUT_ROUTE) {
      setOutputRoute((route) => (route === OUTPUT_ROUTE_USB ? OUTPUT_ROUTE_PRINTER : OUTPUT_ROUTE_USB));
      return;
    }

    if (dataMode === DATA_RECALL) {
      if (storedReadings.length === 0) return;
      setRecallIndex((index) => Math.min(index + 1, storedReadings.length - 1));
      return;
    }

    if (dataMode === DATA_ERASE_CONFIRM) {
      return;
    }

    if (dataMode === DATA_MESSAGE) return;

    if (progSub === PROG_ACQ_SELECT) {
      setDraftAcqMode((m) => {
        const idx = ACQ_MODE_ORDER.indexOf(m);
        return ACQ_MODE_ORDER[(idx + 1) % ACQ_MODE_ORDER.length];
      });

    } else if (progSub === PROG_TIME_ADJUST) {
      // ▲ → increment digit at cursorPos (0–9 wrap)
      setDraftDigits((prev) => {
        const next = [...prev];
        next[cursorPos] = (next[cursorPos] + 1) % 10;
        return next;
      });

    } else if (progSub === PROG_READINGS_ADJUST) {
      // READINGS is immutable and reflects current MEM count.
      return;

    } else if (progSub === PROG_LABEL_ASSIGN) {
      // ▲ → cycle label forward SP → ST → BG → SP
      setDraftLabel((prev) => {
        const idx = LABEL_OPTIONS.indexOf(prev);
        return LABEL_OPTIONS[(idx + 1) % LABEL_OPTIONS.length];
      });

    } else if (progSub === PROG_ITERATION_ADJUST) {
      // ▲ → increment iteration count (max 9)
      setDraftIterations((n) => Math.min(n + 1, 9));

    } else if (progSub === PROG_DHV_ADJUST) {
      // ▲ → increment dHV by 5 (max 100)
      setDraftDHv((v) => Math.min(v + 5, 100));

    } else if (progSub === PROG_SAVE_CONFIRM) {
      commitProgrammingSession();
    }
  };

  const handleDown = () => {
    if (isRunning || bootStage !== BOOT_READY) return;

    if (dataMode === DATA_STORE_MODE) {
      setStoreDataMode((mode) => (mode === STORE_MODE_AUTO ? STORE_MODE_MANUAL : STORE_MODE_AUTO));
      return;
    }

    if (dataMode === DATA_OUTPUT_ROUTE) {
      setOutputRoute((route) => (route === OUTPUT_ROUTE_USB ? OUTPUT_ROUTE_PRINTER : OUTPUT_ROUTE_USB));
      return;
    }

    if (dataMode === DATA_RECALL) {
      if (storedReadings.length === 0) return;
      setRecallIndex((index) => Math.max(index - 1, 0));
      return;
    }

    if (dataMode === DATA_ERASE_CONFIRM) {
      return;
    }

    if (dataMode === DATA_MESSAGE) return;

    if (progSub === PROG_ACQ_SELECT) {
      setDraftAcqMode((m) => {
        const idx = ACQ_MODE_ORDER.indexOf(m);
        return ACQ_MODE_ORDER[(idx - 1 + ACQ_MODE_ORDER.length) % ACQ_MODE_ORDER.length];
      });

    } else if (progSub === PROG_TIME_ADJUST) {
      // ▼ → move cursor one position to the LEFT (wraps 0 → 3)
      setCursorPos((pos) => (pos === 0 ? 3 : pos - 1));

    } else if (progSub === PROG_READINGS_ADJUST) {
      // READINGS is immutable and reflects current MEM count.
      return;

    } else if (progSub === PROG_LABEL_ASSIGN) {
      // ▼ → cycle label backward SP ← BG ← ST ← SP
      setDraftLabel((prev) => {
        const idx = LABEL_OPTIONS.indexOf(prev);
        return LABEL_OPTIONS[(idx - 1 + LABEL_OPTIONS.length) % LABEL_OPTIONS.length];
      });

    } else if (progSub === PROG_ITERATION_ADJUST) {
      // ▼ → decrement iteration count (min 1)
      setDraftIterations((n) => Math.max(n - 1, 1));

    } else if (progSub === PROG_DHV_ADJUST) {
      // ▼ → decrement dHV by 5 (min 0)
      setDraftDHv((v) => Math.max(v - 5, 0));

    } else if (progSub === PROG_SAVE_CONFIRM) {
      commitProgrammingSession();
    }
  };

  // ── SRT / STP ─────────────────────────────────────────────────────────────
  const handleSRT = () => {
    if (isRunning || bootStage !== BOOT_READY || dataMode !== DATA_OFF) return;
    if (!rearPanelConfigRef.current.powerConnected || !rearPanelConfigRef.current.detectorConnected) {
      Alert.alert('Rear Panel Check', 'Connect +12V adaptor power and the G.M. detector on the MHV socket.');
      return;
    }
    setCounts(0);
    setDisplayedCounts(0);
    setElapsedTime(0);
    windowCountsRef.current = 0;
    windowElapsedRef.current = 0;
    iterationResultsRef.current = [];
    setCurrentIteration(iterations > 1 ? 1 : 0);
    programSessionRef.current = null;
    setProgSub(PROG_OFF);
    setIsRunning(true);
  };

  const handleSTP = () => {
    clearInterval(intervalRef.current);
    setIsRunning(false);

    // Continuous modes don't have a natural termination point to stage measurements automatically.
    // Hitting STP serves as the manual snapshot point for CPS/CPM.
    if (acqMode === 'CPS' || acqMode === 'CPM') {
      queueMeasurement(displayedCounts);
    }
  };

  // ── STORE ─────────────────────────────────────────────────────────────────
  const handleSTORE = () => {
    if (isRunning || bootStage !== BOOT_READY) return;

    if (progSub === PROG_ITERATION_ADJUST) {
      // Iteration mode only edits count; HV is controlled separately by helipot slider.
      return;
    }

    if (progSub !== PROG_OFF) return;

    if (dataMode !== DATA_OFF) {
      cycleDataMode();
      return;
    }

    if (storeDataMode === STORE_MODE_MANUAL) {
      if (!pendingMeasurement) {
        showDataMessage('NO DATA TO STORE');
        return;
      }

      appendStoredMeasurement(pendingMeasurement);
      setPendingMeasurement(null);
      showDataMessage('DATA STORED');
      return;
    }

    showDataMessage('AUTO STORE ENABLED');
  };

  const handleStoreLongPress = () => {
    if (isRunning || bootStage !== BOOT_READY || progSub !== PROG_OFF || dataMode === DATA_MESSAGE) return;
    cycleDataMode();
  };

  const handleEraseData = () => {
    if (dataMode !== DATA_ERASE_CONFIRM) return;

    try {
      const db = SQLite.openDatabaseSync(DATABASE_NAME);
      db.runSync('DELETE FROM measurements');
      db.runSync("DELETE FROM sqlite_sequence WHERE name='measurements';");
    } catch (err) {
      console.error('Error erasing database:', err);
    }

    setStoredReadings([]);
    setPendingMeasurement(null);
    setRecallIndex(-1);
    nextSerialNoRef.current = 1;
    showDataMessage('MEMORY CLEARED');
  };

  const handleExportDB = async () => {
    try {
      const dbFileUri = `${FileSystem.documentDirectory}SQLite/${DATABASE_NAME}`;
      const fileInfo = await FileSystem.getInfoAsync(dbFileUri);
      
      if (!fileInfo.exists) {
        Alert.alert("Export Error", "No database found. Save some data first!");
        return;
      }

      if (Platform.OS === 'android') {
        const permission = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync(
          'content://com.android.externalstorage.documents/tree/primary%3ADownload'
        );

        if (permission.granted && permission.directoryUri) {
          const targetFileUri = await FileSystem.StorageAccessFramework.createFileAsync(
            permission.directoryUri,
            DATABASE_NAME,
            'application/x-sqlite3'
          );
          const dbBase64 = await FileSystem.readAsStringAsync(dbFileUri, {
            encoding: FileSystem.EncodingType.Base64,
          });
          await FileSystem.writeAsStringAsync(targetFileUri, dbBase64, {
            encoding: FileSystem.EncodingType.Base64,
          });

          Alert.alert('Export Complete', `${DATABASE_NAME} saved to selected folder.`);
          return;
        }
      }
      
      const canShare = await Sharing.isAvailableAsync();
      if (canShare) {
        await Sharing.shareAsync(dbFileUri, {
          mimeType: 'application/x-sqlite3',
          dialogTitle: 'Export GM Database',
          UTI: 'public.database'
        });
      } else {
        Alert.alert("Export Error", "Sharing is not available on this device.");
      }
    } catch (err) {
      console.error("Export DB Error:", err);
      Alert.alert("Export Failed", err.message);
    }
  };

  // ── Derived display values ────────────────────────────────────────────────
  const remainingTime = acqMode === 'PRESET_TIME'
    ? Math.max(presetTime - elapsedTime, 0)
    : acqMode === 'CPM'
      ? Math.max(60 - windowElapsedRef.current, 0)  // seconds left in current CPM window
      : 0;

  // What to show in the Counts row
  // Show averaged result when a multi-iteration run has completed
  const displayResult = (acqMode === 'CPS' || acqMode === 'CPM')
    ? displayedCounts
    : (iterations > 1 && !isRunning && iterationResultsRef.current.length > 0)
      ? displayedCounts   // averaged value set by the loop
      : counts;
  const isBooting = bootStage !== BOOT_READY;
  const isProgOn = progSub !== PROG_OFF;
  const isDataModeOn = dataMode !== DATA_OFF;
  const rearPanelConfig = rearPanelConfigRef.current;
  const memoryCount = storedReadings.length;
  const currentRecallEntry = recallIndex >= 0 ? storedReadings[recallIndex] : null;
  const displayAcqMode = isProgOn ? draftAcqMode : acqMode;
  const draftPresetTime = digitsToNum(draftDigits);
  const draftNumberOfReadings = memoryCount;

  const formatCounts = (n) => String(n).padStart(6, '0');
  const formatPRTime = (n) => String(n).padStart(4, '0');
  const formatHV = (n) => typeof n === 'number' ? String(n).padStart(4, '0') : '----';

  // ── PROG cycle label helpers ──────────────────────────────────────────────
  const progLabel =
    isBooting ? 'Boot sequence in progress'
      : dataMode === DATA_STORE_MODE ? '▲ / ▼  →  Toggle AUTO/MANUAL  ·  STORE → Next'
        : dataMode === DATA_OUTPUT_ROUTE ? '▲ / ▼  →  Select USB-PC or PRINTER  ·  STORE → Next'
          : dataMode === DATA_RECALL ? '▲ / ▼  →  Scroll by Sl.No.  ·  STORE → Next'
            : dataMode === DATA_ERASE_CONFIRM ? 'Press ▲ or ▼ to ERASE memory  ·  STORE → Exit'
              : dataMode === DATA_MESSAGE ? dataMessage
                : progSub === PROG_ACQ_SELECT ? '▲ / ▼  →  Select ACQ Mode'
                  : progSub === PROG_TIME_ADJUST ? '▲ → Increment digit  ·  ▼ → Move cursor left  (Preset Time)'
                    : progSub === PROG_READINGS_ADJUST ? 'READINGS shows total MEM count (read-only)'
                      : progSub === PROG_LABEL_ASSIGN ? '▲ / ▼  →  Cycle label  [SP · ST · BG]'
                        : progSub === PROG_ITERATION_ADJUST ? '▲/▼ set iterations (1-9)'
                          : progSub === PROG_SAVE_CONFIRM ? 'Press ▲ or ▼ to SAVE  ·  Press PROG to discard'
                            : progSub === PROG_SHOW_OK ? 'Settings saved!'
                                : storeDataMode === STORE_MODE_MANUAL
                                  ? 'STORE saves pending reading  ·  Long press STORE for memory menu'
                                  : 'Press PROG to enter programming mode  ·  Long press STORE for memory menu';

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar barStyle="light-content" backgroundColor="#050d1a" />

      <View style={styles.outerPanel}>

        {/* ── Logo ────────────────────────────────────────────────────────── */}
        <Image
          source={require('./image.jpeg')}
          style={styles.logo}
          resizeMode="contain"
        />

        {/* ── Title ──────────────────────────────────────────────────────── */}
        <Text style={[styles.title, { color: '#c8deff' }]}>G.M Counting System</Text>

        {/* ── Status badges ──────────────────────────────────────────────── */}
        <View style={styles.statusStrip}>
          {isProgOn && !isBooting && (
            <View style={[styles.badge, styles.badgeProg]}>
              <Text style={styles.badgeProgText}>
                {progSub === PROG_ACQ_SELECT ? 'ACQ SELECT'
                  : progSub === PROG_TIME_ADJUST ? 'TIME ADJUST'
                    : progSub === PROG_READINGS_ADJUST ? 'READINGS'
                      : progSub === PROG_LABEL_ASSIGN ? 'LABEL'
                        : progSub === PROG_ITERATION_ADJUST ? 'ITERATIONS'
                          : progSub === PROG_SAVE_CONFIRM ? 'SAVE?'
                            : 'SAVED ✓'}
              </Text>
            </View>
          )}
          {isDataModeOn && !isBooting && (
            <View style={[styles.badge, styles.badgeData]}>
              <Text style={styles.badgeDataText}>
                {dataMode === DATA_STORE_MODE ? 'STORE DATA'
                  : dataMode === DATA_OUTPUT_ROUTE ? 'DATA OUT'
                    : dataMode === DATA_RECALL ? 'RECALL'
                      : dataMode === DATA_ERASE_CONFIRM ? 'ERASE?'
                        : dataMessage}
              </Text>
            </View>
          )}
          {isRunning && (
            <View style={[styles.badge, styles.badgeRun]}>
              <Text style={styles.badgeRunText}>● COUNTING</Text>
            </View>
          )}
        </View>

        <View style={styles.rearStrip}>
          <Text style={styles.rearText}>DET {rearPanelConfig.detectorInput}</Text>
          <Text style={styles.rearText}>PWR {rearPanelConfig.powerInput}</Text>
          <Text style={styles.rearText}>OUT {OUTPUT_ROUTE_LABELS[outputRoute]}</Text>
          <Text style={styles.rearText}>STORE {storeDataMode}</Text>
          <Text style={styles.rearText}>MEM {String(memoryCount).padStart(4, '0')}</Text>
        </View>

        {/* ─── Main display + HV slider in a row ─────────────────────────── */}
        <View style={styles.mainRow}>

          {/* ── LCD Display panel ──────────────────────────────────────────── */}
          <View style={styles.displayBox}>

            {isBooting && (
              <View style={styles.overlayScreen}>
                <Text style={styles.bootIdentity}>
                  {bootStage === BOOT_GEIGER ? 'GEIGER COUNTING SYSTEM' : 'NUCLEONIX SYSTEMS'}
                </Text>
              </View>
            )}

            {!isBooting && dataMode === DATA_STORE_MODE && (
              <View style={styles.overlayScreen}>
                <Text style={styles.overlayLine1}>STORE</Text>
                <Text style={styles.overlayLine2}>DATA MODE</Text>
                <Text style={styles.memoryValue}>{storeDataMode}</Text>
                <Text style={styles.overlaySub}>Current route: {OUTPUT_ROUTE_LABELS[outputRoute]}</Text>
                <Text style={styles.overlaySub}>Pending: {pendingMeasurement ? 'YES' : 'NO'}</Text>
              </View>
            )}

            {!isBooting && dataMode === DATA_OUTPUT_ROUTE && (
              <View style={styles.overlayScreen}>
                <Text style={styles.overlayLine1}>DATA OUT</Text>
                <Text style={styles.overlayLine2}>REAR PANEL</Text>
                <Text style={styles.memoryValue}>{OUTPUT_ROUTE_LABELS[outputRoute]}</Text>
                
                <TouchableOpacity 
                  style={{ marginTop: 12, marginBottom: 8, backgroundColor: '#7c6cc4', paddingVertical: 10, paddingHorizontal: 24, borderRadius: 8 }}
                  onPress={handleExportDB}
                  activeOpacity={0.7}
                >
                  <Text style={{ color: '#ffffff', fontSize: 18, fontWeight: 'bold' }}>📤 EXPORT DB FILE</Text>
                </TouchableOpacity>

                <Text style={styles.overlaySub}>Tap button to extract SQLite file to File Explorer</Text>
                <Text style={styles.overlaySub}>▲ or ▼ to change hardware route</Text>
              </View>
            )}

            {!isBooting && dataMode === DATA_RECALL && (
              <View style={styles.overlayScreen}>
                <ScrollView contentContainerStyle={{ alignItems: 'center', justifyContent: 'center', flexGrow: 1, paddingVertical: 24 }} style={{ width: '100%' }} persistentScrollbar={true}>
                  <Text style={styles.overlayLine1}>RECALL</Text>
                  <Text style={styles.overlayLine2}>DATA</Text>
                  {currentRecallEntry ? (
                    <>
                      <Text style={[styles.memoryValue, { marginTop: 16 }]}>Sl.No. {String(currentRecallEntry.serialNo).padStart(4, '0')}</Text>
                      <Text style={[styles.overlaySub, { fontSize: 28, fontWeight: '700', color: '#f8fafc', marginVertical: 4 }]}>
                        Counts: {String(currentRecallEntry.value).padStart(6, '0')} {currentRecallEntry.iterations > 1 ? '(AVG)' : ''}
                      </Text>
                      <Text style={[styles.overlaySub, { fontSize: 20, marginBottom: 2 }]}>
                        {ACQ_LABELS[currentRecallEntry.acqMode]} {currentRecallEntry.acqMode === 'PRESET_TIME' ? `(${currentRecallEntry.presetTime}s)` : ''}  ·  {currentRecallEntry.label}  ·  HV {formatHV(currentRecallEntry.hv)}V
                      </Text>
                      <Text style={[styles.overlaySub, { fontSize: 18, marginBottom: 8 }]}>
                        OUT {OUTPUT_ROUTE_LABELS[currentRecallEntry.outputRoute]}
                      </Text>
                      {currentRecallEntry.iterations > 1 && currentRecallEntry.iterationResults && currentRecallEntry.iterationResults.length > 0 && (
                        <View style={styles.iterTableContainer}>
                            <View style={styles.iterTableHeader}>
                              <Text style={styles.iterTableColHeader}>Run</Text>
                              <Text style={styles.iterTableColHeader}>Ref HV (V)</Text>
                              <Text style={styles.iterTableColHeader}>Count</Text>
                            </View>
                            {currentRecallEntry.iterationResults.map((item, idx) => {
                              const val = typeof item === 'object' ? item.count : item;
                              const stepHv = typeof item === 'object' ? (item.refHv || item.hv || currentRecallEntry.hv) : currentRecallEntry.hv;

                              return (
                                <View key={idx} style={styles.iterTableRow}>
                                  <Text style={styles.iterTableCol1}>{idx + 1}</Text>
                                  <Text style={[styles.iterTableCol1, { color: '#fb923c' }]}>{stepHv}</Text>
                                  <Text style={styles.iterTableCol2}>{String(val).padStart(6, '0')}</Text>
                                </View>
                              );
                            })}
                        </View>
                      )}

                      {(currentRecallEntry.acqMode === 'CPS' || currentRecallEntry.acqMode === 'CPM') && (
                        <>
                          <Text style={[styles.overlaySub, { fontSize: 18, marginBottom: 8, color: '#fb923c' }]}>
                            Duration: {currentRecallEntry.acqMode === 'CPS' 
                              ? `${currentRecallEntry.presetTime} seconds` 
                              : `${Math.floor(currentRecallEntry.presetTime / 60)} minutes ${currentRecallEntry.presetTime % 60} seconds`}
                          </Text>

                          {currentRecallEntry.iterationResults && currentRecallEntry.iterationResults.length > 0 && (
                            <View style={[styles.iterTableContainer, { marginTop: 4 }]}>
                                <View style={styles.iterTableHeader}>
                                  <Text style={styles.iterTableColHeader}>{currentRecallEntry.acqMode === 'CPS' ? 'Second' : 'Minute'}</Text>
                                  <Text style={styles.iterTableColHeader}>Ref HV</Text>
                                  <Text style={styles.iterTableColHeader}>Count</Text>
                                </View>
                                {currentRecallEntry.iterationResults.map((item, idx) => (
                                    <View key={idx} style={styles.iterTableRow}>
                                      <Text style={styles.iterTableCol1}>{item.timeUnit}</Text>
                                      <Text style={[styles.iterTableCol1, { color: '#fb923c' }]}>{item.refHv || '----'}</Text>
                                      <Text style={styles.iterTableCol2}>{String(item.count).padStart(6, '0')}</Text>
                                    </View>
                                ))}
                            </View>
                          )}
                        </>
                      )}
                    </>
                  ) : (
                    <Text style={[styles.overlaySub, { marginTop: 16 }]}>No stored readings</Text>
                  )}
                </ScrollView>
              </View>
            )}

            {!isBooting && dataMode === DATA_ERASE_CONFIRM && (
              <View style={styles.overlayScreen}>
                <Text style={styles.overlayLine1}>ERASE?</Text>
                <Text style={styles.overlayLine2}>(MEM)</Text>
                <Text style={styles.overlaySub}>Stored records: {String(memoryCount).padStart(4, '0')}</Text>
                <TouchableOpacity style={styles.eraseBtn} onPress={handleEraseData} activeOpacity={0.7}>
                  <Text style={styles.eraseBtnText}>ERASE MEMORY</Text>
                </TouchableOpacity>
                <Text style={[styles.overlaySub, { marginTop: 16 }]}>STORE  {'→'}  Exit erase mode</Text>
              </View>
            )}

            {!isBooting && dataMode === DATA_MESSAGE && (
              <View style={styles.overlayScreen}>
                <Text style={styles.memoryValue}>{dataMessage}</Text>
              </View>
            )}

            {/* ══ SAVE? overlay ══ */}
            {!isBooting && dataMode === DATA_OFF && progSub === PROG_SAVE_CONFIRM && (
              <View style={styles.overlayScreen}>
                <Text style={styles.overlayLine1}>SAVE?</Text>
                <Text style={styles.overlayLine2}>(PRG)</Text>
                <Text style={styles.overlaySub}>{ACQ_LABELS[draftAcqMode]}</Text>
                <Text style={styles.overlaySub}>T {formatPRTime(draftPresetTime)} s  ·  R {formatPRTime(draftNumberOfReadings)}</Text>
                <Text style={styles.overlaySub}>L {draftLabel}  ·  I {draftIterations}</Text>
                <Text style={styles.overlaySub}>▲ or ▼  →  Confirm Save</Text>
                <Text style={styles.overlaySub}>PROG  {'→'}  Discard {'&'} Exit</Text>
              </View>
            )}

            {/* ══ OK flash overlay ══ */}
            {!isBooting && dataMode === DATA_OFF && progSub === PROG_SHOW_OK && (
              <View style={styles.overlayScreen}>
                <Text style={styles.overlayOK}>OK</Text>
                <Text style={styles.overlaySub}>Settings saved!</Text>
              </View>
            )}

            {/* ══ READINGS_ADJUST screen ══ */}
            {!isBooting && dataMode === DATA_OFF && progSub === PROG_READINGS_ADJUST && (
              <View style={{ paddingVertical: 4 }}>
                <Text style={styles.progEditHeader}>READINGS IN</Text>
                <View style={styles.progEditRow}>
                  <Text style={styles.progEditLabel}>REAIN</Text>
                  <Text style={styles.progEditHv}>{formatPRTime(memoryCount)}</Text>
                </View>
                <Text style={styles.overlaySub}>MEM count is read-only</Text>
              </View>
            )}

            {/* ══ LABEL_ASSIGN screen ══ */}
            {!isBooting && dataMode === DATA_OFF && progSub === PROG_LABEL_ASSIGN && (
              <View style={styles.overlayScreen}>
                <Text style={styles.progEditHeader}>LABLE</Text>
                <View style={styles.labelSelectRow}>
                  {LABEL_OPTIONS.map((opt) => (
                    <View key={opt} style={[
                      styles.labelOption,
                      draftLabel === opt && styles.labelOptionActive,
                    ]}>
                      <Text style={[
                        styles.labelOptionText,
                        draftLabel === opt && styles.labelOptionTextActive,
                      ]}>{opt}</Text>
                    </View>
                  ))}
                </View>
                <Text style={styles.labelDesc}>{LABEL_NAMES[draftLabel]}</Text>
                <Text style={styles.overlaySub}>▲ forward  ·  ▼ backward</Text>
              </View>
            )}

            {/* ══ ITERATION_ADJUST screen ══ */}
            {!isBooting && dataMode === DATA_OFF && progSub === PROG_ITERATION_ADJUST && (
              <View style={styles.overlayScreen}>
                <Text style={styles.progEditHeader}>ITERATION</Text>
                <View style={styles.iterBoxRow}>
                  <Text style={[styles.iterValue, styles.iterValueActive]}>{draftIterations}</Text>
                </View>
                <Text style={[styles.labelDesc, { marginTop: 4 }]}>
                  {draftIterations === 1 ? 'Single run' : `Run ×${draftIterations}, display average`}
                </Text>
                <Text style={styles.overlaySub}>HV is independent and controlled by helipot slider</Text>
              </View>
            )}

            {/* ══ Single Active Parameter Display (hardware 2-line simulation) ══ */}
            {!isBooting
              && dataMode === DATA_OFF
              && progSub !== PROG_SAVE_CONFIRM
              && progSub !== PROG_SHOW_OK
              && progSub !== PROG_READINGS_ADJUST
              && progSub !== PROG_LABEL_ASSIGN
              && progSub !== PROG_ITERATION_ADJUST && (
                <>
                  {/* === LINE 1: Count/AVG (always visible) === */}
                  <View style={styles.displayRow}>
                    <Text style={styles.displayLabel}>
                      {acqMode === 'CPM' ? 'CPM :'
                        : acqMode === 'CPS' ? 'CPS :'
                          : (iterations > 1 && !isRunning && iterationResultsRef.current.length > 0)
                            ? 'AVG :'
                            : 'COUNT :'}
                    </Text>
                    <Text style={styles.displayValue}>{formatCounts(displayResult)}</Text>
                    {currentIteration > 0 && isRunning && (
                      <Text style={styles.iterChip}>{currentIteration}/{iterations}</Text>
                    )}
                  </View>

                  <View style={styles.displayDivider} />

                  {/* === LINE 2: Active Parameter Field (one shown at a time) === */}

                  {/* TIMER - PR.TIME field */}
                  {progSub === PROG_TIME_ADJUST && (
                    <View style={{ paddingVertical: 4 }}>
                      <Text style={styles.progEditHeader}>PRESET</Text>
                      <View style={styles.progEditRow}>
                        <Text style={styles.progEditLabel}>TIME</Text>
                        <View style={styles.digitRow}>
                          {draftDigits.map((digit, idx) => (
                            <View key={idx} style={styles.digitCell}>
                              <Text style={[
                                styles.cursorArrow,
                                idx === cursorPos ? styles.cursorArrowActive : styles.cursorArrowHidden,
                              ]}>▲</Text>
                              <Text style={[
                                styles.digitChar,
                                idx === cursorPos && styles.digitCharActive,
                              ]}>{digit}</Text>
                            </View>
                          ))}
                        </View>
                        <Text style={styles.displayUnit}> s</Text>
                      </View>
                    </View>
                  )}

                  {/* READINGS - REAIN field */}
                  {progSub === PROG_READINGS_ADJUST && (
                    <View style={{ paddingVertical: 4 }}>
                      <Text style={styles.progEditHeader}>READINGS IN</Text>
                      <View style={styles.progEditRow}>
                        <Text style={styles.progEditLabel}>REAIN</Text>
                        <Text style={styles.progEditHv}>{formatPRTime(memoryCount)}</Text>
                      </View>
                    </View>
                  )}

                  {/* LABEL - LABLE field */}
                  {progSub === PROG_LABEL_ASSIGN && (
                    <View style={styles.overlayScreen}>
                      <Text style={styles.progEditHeader}>LABLE</Text>
                      <View style={styles.labelSelectRow}>
                        {LABEL_OPTIONS.map((opt) => (
                          <View key={opt} style={[
                            styles.labelOption,
                            draftLabel === opt && styles.labelOptionActive,
                          ]}>
                            <Text style={[
                              styles.labelOptionText,
                              draftLabel === opt && styles.labelOptionTextActive,
                            ]}>{opt}</Text>
                          </View>
                        ))}
                      </View>
                      <Text style={styles.labelDesc}>{LABEL_NAMES[draftLabel]}</Text>
                    </View>
                  )}

                  {/* ITERATIONS - ITERATION field */}
                  {progSub === PROG_ITERATION_ADJUST && (
                    <View style={styles.overlayScreen}>
                      <Text style={styles.progEditHeader}>ITERATION</Text>
                      <View style={styles.iterBoxRow}>
                        <Text style={[styles.iterValue, styles.iterValueActive]}>{draftIterations}</Text>
                      </View>
                      <Text style={[styles.labelDesc, { marginTop: 4 }]}>
                        {draftIterations === 1 ? 'Single run' : `Run ×${draftIterations}, display average`}
                      </Text>
                      <View style={styles.iterBoxRow}>
                        <Text style={styles.progEditLabel}>HV</Text>
                        <Text style={styles.iterValueSmall}>
                          {formatHV(hv)} V
                        </Text>
                      </View>
                    </View>
                  )}

                  {/* dHV - DHV_ADJUST field */}
                  {progSub === PROG_DHV_ADJUST && (
                    <View style={styles.overlayScreen}>
                      <Text style={styles.progEditHeader}>dHV STEP</Text>
                      <View style={styles.iterBoxRow}>
                        <Text style={[styles.iterValue, styles.iterValueActive]}>+{draftDHv} V</Text>
                      </View>
                      <Text style={[styles.labelDesc, { marginTop: 4 }]}>
                        {draftDHv === 0 ? 'Constant HV for all runs' : `Increase HV by ${draftDHv}V each run`}
                      </Text>
                    </View>
                  )}

                  {/* When in ACQ_SELECT mode, show a simplified view */}
                  {progSub === PROG_ACQ_SELECT && (
                    <View style={styles.overlayScreen}>
                      <Text style={styles.progEditHeader}>ACQ MODE</Text>
                      <View style={[
                        styles.modeTag,
                        displayAcqMode === 'CPS' && styles.modeTagCPS,
                        displayAcqMode === 'CPM' && styles.modeTagCPM,
                        styles.modeTagEditing,
                      ]}>
                        <Text style={styles.modeTagText}>{ACQ_LABELS[displayAcqMode]}</Text>
                      </View>
                      <Text style={styles.overlaySub}>▲ / ▼ to cycle modes</Text>
                    </View>
                  )}

                  {(activeParamField === PARAM_FIELD_ITERATIONS || (progSub === PROG_ITERATION_ADJUST)) && (
                    <View style={[styles.paramBox, progSub === PROG_ITERATION_ADJUST && styles.paramBoxActive]}>
                      <Text style={styles.paramLabel}>ITERATIONS</Text>
                      <Text style={styles.paramValue}>{progSub === PROG_ITERATION_ADJUST ? draftIterations : iterations}</Text>
                    </View>
                  )}

                  {(activeParamField === PARAM_FIELD_DHV || (progSub === PROG_DHV_ADJUST)) && (
                    <View style={[styles.paramBox, progSub === PROG_DHV_ADJUST && styles.paramBoxActive]}>
                      <Text style={styles.paramLabel}>dHV STEP</Text>
                      <Text style={styles.paramValue}>+{progSub === PROG_DHV_ADJUST ? draftDHv : dHv}V</Text>
                    </View>
                  )}

                  {/* When PROG_OFF (not editing), show the 4 parameters in a clean rotating display based on activeParamField */}
                  {progSub === PROG_OFF && activeParamField === PARAM_FIELD_TIMER && (
                    <View style={styles.displayRow}>
                      <Text style={styles.displayLabel}>PR.TIME :</Text>
                      {acqMode === 'PRESET_TIME' && !isRunning ? (
                        <Text style={styles.displayValue}>{formatPRTime(presetTime)}</Text>
                      ) : (
                        <Text style={[
                          styles.displayValue,
                          acqMode !== 'PRESET_TIME' && styles.displayValueDim,
                        ]}>{formatPRTime(remainingTime)}</Text>
                      )}
                      <Text style={styles.displayUnit}> s</Text>
                    </View>
                  )}

                  {progSub === PROG_OFF && activeParamField === PARAM_FIELD_READINGS && (
                    <View style={styles.displayRow}>
                      <Text style={styles.displayLabel}>MEM :</Text>
                      <Text style={styles.displayValue}>
                        {formatPRTime(memoryCount)}
                      </Text>
                    </View>
                  )}

                  {progSub === PROG_OFF && activeParamField === PARAM_FIELD_LABEL && (
                    <View style={styles.displayRow}>
                      <Text style={styles.displayLabel}>LABEL :</Text>
                      <Text style={[styles.displayValue, { color: '#a78bfa', letterSpacing: 2 }]}>
                        {label}
                      </Text>
                      <Text style={[styles.displayUnit, { color: '#7c6cc4' }]}>
                        {'  '}{LABEL_NAMES[label]}
                      </Text>
                    </View>
                  )}

                  {progSub === PROG_OFF && activeParamField === PARAM_FIELD_ITERATIONS && (
                    <View style={styles.displayRow}>
                      <Text style={styles.displayLabel}>ITERATIONS :</Text>
                      <Text style={styles.displayValue}>{iterations}</Text>
                      {iterations > 1 && (
                        <Text style={[styles.displayUnit, { color: '#38bdf8' }]}>{' '}avg</Text>
                      )}
                    </View>
                  )}

                  <View style={styles.displayDivider} />

                  {/* === LINE 3: HV (always visible at bottom) === */}
                  <View style={styles.displayRow}>
                    <Text style={[
                      styles.playIndicator,
                      isRunning && styles.playIndicatorActive,
                    ]}>▶</Text>
                    <Text style={styles.displayLabel}>Ref HV :</Text>
                    <Text style={styles.displayValue}>
                      ----
                    </Text>
                    <Text style={styles.displayUnit}> V</Text>
                  </View>
                </>
              )}

          </View>

          {/* ── HV Helipot Slider ───────────────────────────────────────────── */}
          <HVSlider hv={hv} setHv={setHv} disabled={isRunning || isBooting || isDataModeOn} hvStep={hvStep} setHvStep={setHvStep} />
        </View>

        {/* ── Button grid ────────────────────────────────────────────────── */}
        <View style={styles.buttonGrid}>

          {/* Row 1 */}
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.btn, isProgOn && styles.btnProgActive]}
              onPress={handlePROG}
              activeOpacity={0.7}>
              <Text style={[styles.btnText, isProgOn && styles.btnTextProg]}>PROG</Text>
              {isProgOn && (
                <Text style={styles.progSubLabel}>
                  {progSub === PROG_ACQ_SELECT ? '①'
                    : progSub === PROG_TIME_ADJUST ? '②'
                      : progSub === PROG_READINGS_ADJUST ? '③'
                        : progSub === PROG_LABEL_ASSIGN ? '④'
                          : progSub === PROG_ITERATION_ADJUST ? '⑤'
                            : progSub === PROG_DHV_ADJUST ? '⑥'
                              : progSub === PROG_SAVE_CONFIRM ? '⑦'
                                : '✓'}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, styles.btnArrow]}
              onPress={handleUp}
              activeOpacity={0.7}>
              <Text style={styles.arrowText}>▲</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, isRunning ? styles.btnDisabled : styles.btnSRT]}
              onPress={handleSRT}
              disabled={isRunning}
              activeOpacity={0.7}>
              <Text style={[styles.btnText, styles.btnSRTText]}>SRT</Text>
            </TouchableOpacity>
          </View>

          {/* Row 2 */}
          <View style={styles.buttonRow}>
            <TouchableOpacity
              style={[styles.btn, isDataModeOn && styles.btnStoreActive]}
              onPress={handleSTORE}
              onLongPress={handleStoreLongPress}
              activeOpacity={0.7}>
              <Text style={styles.btnText}>STORE</Text>
              <Text style={styles.progSubLabel}>{storeDataMode}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, styles.btnArrow]}
              onPress={handleDown}
              activeOpacity={0.7}>
              <Text style={styles.arrowText}>▼</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.btn, styles.btnSTP]}
              onPress={handleSTP}
              activeOpacity={0.7}>
              <Text style={[styles.btnText, styles.btnSTPText]}>STP</Text>
            </TouchableOpacity>
          </View>

        </View>

        {/* ── Hint bar ───────────────────────────────────────────────────── */}
        <Text style={styles.hintText}>{progLabel}</Text>

      </View>
    </SafeAreaView>
  );
}

// ─── HV Helipot Slider Component ─────────────────────────────────────────────
/**
 * Simulates the physical helipot knob from the manual.
 * Drag right  → increase HV (clockwise rotation)
 * Drag left   → decrease HV (counter-clockwise)
 */
function HVSlider({ hv, setHv, disabled, hvStep, setHvStep }) {
  const [hvInput, setHvInput] = useState(String(hv));

  useEffect(() => {
    setHvInput(String(hv));
  }, [hv]);

  const clampHv = (value) => Math.max(HV_MIN, Math.min(HV_MAX, value));

  const applyHvInput = () => {
    const parsed = Number.parseInt(hvInput, 10);
    if (Number.isNaN(parsed)) {
      setHvInput(String(hv));
      return;
    }
    const next = clampHv(parsed);
    setHv(next);
    setHvInput(String(next));
  };

  const jumpHv = (delta) => {
    if (disabled) return;
    setHv((v) => clampHv(v + delta));
  };

  return (
    <View style={styles.sliderContainer}>
      <Text style={styles.sliderTitle}>SET HV</Text>
      <Text style={styles.sliderTitle}>CONTROL</Text>

      {/* Knob label */}
      <View style={styles.knobRing}>
        <Text style={styles.knobValue}>{hv}</Text>
        <Text style={styles.knobUnit}>V</Text>
      </View>

      <TextInput
        style={[styles.hvInput, disabled && styles.hvInputDisabled]}
        value={hvInput}
        onChangeText={setHvInput}
        onEndEditing={applyHvInput}
        onSubmitEditing={applyHvInput}
        keyboardType="numeric"
        editable={!disabled}
        maxLength={4}
        placeholder="HV"
        placeholderTextColor="#6b7f99"
      />

      <View style={styles.sliderLabels}>
        <Text style={styles.sliderEdge}>◄ CCW</Text>
        <Text style={styles.sliderEdge}>CW ►</Text>
      </View>

      {/* ── HV jump controls ───────────────────────────────── */}
      <Text style={styles.stepLabel}>SETTING</Text>
      <View style={styles.stepRow}>
        <TouchableOpacity
          style={styles.stepBtn}
          onPress={applyHvInput}
          disabled={disabled}
          activeOpacity={0.7}
        >
          <Text style={styles.stepBtnText}>SET HV</Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.sliderHint}>
        {disabled ? 'HV locked during boot/count/program/data' : `Apply typed HV value`}
      </Text>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const CREAM = '#050d1a';   // deep space navy
const PANEL_BG = '#0c1829'; // midnight blue
const BORDER = '#1e4d8c';   // steel blue
const DISPLAY_BG = '#071220'; // near-black navy LCD
const GO_COLOR = '#22c55e';   // bright green SRT
const STOP_COLOR = '#ef4444'; // bright red STP
const PROG_COLOR = '#60a5fa'; // sky blue PROG
const TEXT_DARK = '#e2eaf8';  // light steel text
const TEXT_MID = '#93b4d4';   // muted blue text
const MONO = 'monospace';

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: CREAM,
    alignItems: 'center',
    justifyContent: 'center',
  },

  outerPanel: {
    width: '98%',
    flex: 0.98,
    maxWidth: 1600,
    backgroundColor: PANEL_BG,
    borderWidth: 3,
    borderColor: BORDER,
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 20,
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 3, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },

  logo: {
    width: 200,
    height: 60,
    alignSelf: 'center',
    marginBottom: 4,
  },

  title: {
    fontSize: 32,
    fontWeight: '700',
    color: TEXT_DARK,
    letterSpacing: 1.2,
    textAlign: 'center',
    marginBottom: 4,
    fontFamily: 'serif',
  },

  // ── Status strip ──────────────────────────────────────────────────────────
  statusStrip: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
    height: 28,
    marginBottom: 8,
  },
  badge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 10,
    justifyContent: 'center',
  },
  badgeProg: { backgroundColor: '#1e3a6a55', borderColor: PROG_COLOR },
  badgeProgText: { color: PROG_COLOR, fontWeight: '700', fontSize: 16, letterSpacing: 0.8 },
  badgeData: { backgroundColor: '#3f2a0f66', borderColor: '#f59e0b' },
  badgeDataText: { color: '#fbbf24', fontWeight: '700', fontSize: 16, letterSpacing: 0.8 },
  badgeRun: { backgroundColor: '#14532d55', borderColor: GO_COLOR },
  badgeRunText: { color: GO_COLOR, fontWeight: '700', fontSize: 16 },
  rearStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 14,
  },
  rearText: {
    fontSize: 16,
    color: '#9cc6ea',
    fontFamily: MONO,
    borderWidth: 1,
    borderColor: '#1e4d8c55',
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: '#071220',
  },

  // ── Main row (display + slider side by side) ──────────────────────────────
  mainRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    marginBottom: 12,
  },

  // ── Display box ───────────────────────────────────────────────────────────
  displayBox: {
    flex: 1,
    backgroundColor: DISPLAY_BG,
    borderWidth: 2.5,
    borderColor: BORDER,
    borderRadius: 4,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  displayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 4,
    minHeight: 44,
  },
  displayDivider: {
    height: 2,
    backgroundColor: '#1e4d8c66',
    marginVertical: 4,
  },
  displayLabel: {
    fontSize: 26,
    fontWeight: '600',
    color: '#7ab8e8',
    width: 160,
    fontFamily: MONO,
  },
  displayValue: {
    fontSize: 34,
    fontWeight: '700',
    color: '#e2eaf8',
    letterSpacing: 4,
    fontFamily: MONO,
  },
  displayValueDim: {
    color: '#888',
  },
  displayValueEditing: {
    color: PROG_COLOR,
  },
  timeInput: {
    fontSize: 34,
    fontWeight: '700',
    color: '#e2eaf8',
    letterSpacing: 4,
    fontFamily: MONO,
    minWidth: 100,
    borderBottomWidth: 3,
    borderBottomColor: PROG_COLOR,
    paddingVertical: 4,
    paddingHorizontal: 6,
  },
  displayUnit: {
    fontSize: 22,
    color: '#7ab8e8',
    fontFamily: MONO,
    marginLeft: 6,
  },
  playIndicator: {
    fontSize: 24,
    color: '#aaa',
    width: 32,
    fontFamily: MONO,
  },
  playIndicatorActive: {
    color: GO_COLOR,
  },

  // ── ACQ mode tag ──────────────────────────────────────────────────────────
  modeTag: {
    backgroundColor: '#0f3460',
    borderWidth: 2,
    borderColor: '#2a6abf',
    borderRadius: 6,
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  modeTagCPS: { backgroundColor: '#0f2d50', borderColor: '#3a7adf' },
  modeTagCPM: { backgroundColor: '#1a2a50', borderColor: '#5a8adf' },
  modeTagEditing: { borderColor: PROG_COLOR, borderWidth: 3 },
  modeTagText: {
    fontSize: 24,
    fontWeight: '800',
    color: '#c8e0ff',
    letterSpacing: 1,
    fontFamily: MONO,
  },

  // ── HV Slider ─────────────────────────────────────────────────────────────
  sliderContainer: {
    width: 220,
    alignItems: 'center',
    backgroundColor: '#0c1e3a',
    borderWidth: 2.5,
    borderColor: BORDER,
    borderRadius: 8,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  sliderTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#7ab8e8',
    letterSpacing: 1.2,
    textAlign: 'center',
  },
  knobRing: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: '#1a3a6a',
    borderWidth: 4,
    borderColor: '#3a7abf',
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 10,
    shadowColor: '#000',
    shadowOffset: { width: 2, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 4,
    elevation: 5,
  },
  knobValue: {
    fontSize: 28,
    fontWeight: '900',
    color: '#e2eaf8',
    fontFamily: MONO,
  },
  knobUnit: {
    fontSize: 18,
    color: '#7ab8e8',
    fontFamily: MONO,
  },
  sliderLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 6,
    paddingHorizontal: 4,
  },
  sliderEdge: {
    fontSize: 14,
    color: '#7ab8e8',
    fontWeight: '700',
  },
  sliderHint: {
    marginTop: 6,
    fontSize: 12,
    color: '#5a8abf',
    fontStyle: 'italic',
    textAlign: 'center',
  },
  hvInput: {
    width: '100%',
    marginTop: 8,
    borderWidth: 2,
    borderColor: '#2a6abf',
    borderRadius: 8,
    backgroundColor: '#081324',
    color: '#e2eaf8',
    fontFamily: MONO,
    fontSize: 24,
    fontWeight: '700',
    textAlign: 'center',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  hvInputDisabled: {
    backgroundColor: '#1f2937',
    color: '#9ca3af',
    borderColor: '#475569',
  },

  // ── HV Step toggle ────────────────────────────────────────────────────────
  stepLabel: {
    marginTop: 6,
    fontSize: 14,
    fontWeight: '700',
    color: '#7ab8e8',
    letterSpacing: 0.8,
    textAlign: 'center',
  },
  stepRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
  },
  stepBtn: {
    flex: 1,
    paddingVertical: 6,
    borderWidth: 1.5,
    borderColor: '#1e4d8c',
    borderRadius: 4,
    backgroundColor: '#0a1628',
    alignItems: 'center',
  },
  stepBtnActive: {
    backgroundColor: '#1e3a6a',
    borderColor: '#60a5fa',
  },
  stepBtnText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#7ab8e8',
  },
  stepBtnTextActive: {
    color: '#60a5fa',
  },

  // ── Button grid ───────────────────────────────────────────────────────────
  buttonGrid: {
    width: '100%',
    gap: 10,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 14,
  },
  btn: {
    flex: 1,
    height: 70,
    backgroundColor: '#0f2040',
    borderWidth: 2.5,
    borderColor: '#1e4d8c',
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#3a7abf',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 3,
    elevation: 4,
  },
  btnText: {
    fontSize: 26,
    fontWeight: '800',
    color: TEXT_DARK,
    letterSpacing: 1.4,
  },
  btnArrow: { flex: 0.65 },
  arrowText: { fontSize: 32, color: '#c8deff', fontWeight: '900' },

  btnProgActive: { backgroundColor: '#1a3460', borderColor: PROG_COLOR },
  btnStoreActive: { backgroundColor: '#5b3a10', borderColor: '#f59e0b' },
  btnTextProg: { color: PROG_COLOR },
  progSubLabel: { fontSize: 18, color: PROG_COLOR, fontWeight: '700' },

  btnSRT: { backgroundColor: '#14532d', borderColor: GO_COLOR },
  btnSRTText: { color: GO_COLOR, fontWeight: '900' },

  btnSTP: { backgroundColor: '#7f1d1d', borderColor: STOP_COLOR },
  btnSTPText: { color: '#fca5a5', fontWeight: '900' },

  btnDisabled: { backgroundColor: '#0a1628', borderColor: '#1e3a5f', opacity: 0.45 },

  hintText: {
    marginTop: 8,
    fontSize: 18,
    color: '#5a8abf',
    letterSpacing: 0.4,
    fontStyle: 'italic',
  },

  // ── Preset Time digit-editor UI ────────────────────────────────────────────────
  progEditHeader: {
    fontSize: 24,
    fontWeight: '800',
    color: '#7ab8e8',
    letterSpacing: 2,
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  progEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 4,
  },
  progEditLabel: {
    fontSize: 28,
    fontWeight: '700',
    color: '#7ab8e8',
    fontFamily: 'monospace',
    width: 90,
  },
  progEditHv: {
    fontSize: 32,
    fontWeight: '700',
    color: '#e2eaf8',
    letterSpacing: 3,
    fontFamily: 'monospace',
  },

  // Digit cells
  digitRow: {
    flexDirection: 'row',
    gap: 6,
  },
  digitCell: {
    alignItems: 'center',
    width: 44,
  },
  cursorArrow: {
    fontSize: 20,
    fontWeight: '900',
    height: 20,
    lineHeight: 20,
  },
  cursorArrowActive: {
    color: '#60a5fa',        // PROG_COLOR
  },
  cursorArrowHidden: {
    color: 'transparent',
  },
  digitChar: {
    fontSize: 46,
    fontWeight: '900',
    color: '#e2eaf8',
    fontFamily: 'monospace',
    letterSpacing: 0,
  },
  digitCharActive: {
    color: '#60a5fa',        // PROG_COLOR highlight
    textShadowColor: '#60a5fa55',
    textShadowRadius: 6,
    textShadowOffset: { width: 0, height: 0 },
  },

  // ── Overlay screens (SAVE? / OK) ───────────────────────────────────────────
  overlayScreen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 18,
  },
  overlayLine1: {
    fontSize: 48,
    fontWeight: '900',
    color: '#f59e0b',       // amber — attention
    letterSpacing: 3,
    fontFamily: 'monospace',
  },
  overlayLine2: {
    fontSize: 32,
    fontWeight: '700',
    color: '#fbbf24',
    letterSpacing: 2,
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  overlayOK: {
    fontSize: 64,
    fontWeight: '900',
    color: '#22c55e',       // bright green
    letterSpacing: 6,
    fontFamily: 'monospace',
    textShadowColor: '#22c55e66',
    textShadowRadius: 12,
    textShadowOffset: { width: 0, height: 0 },
    marginBottom: 4,
  },
  overlaySub: {
    fontSize: 22,
    color: '#7ab8e8',
    fontStyle: 'italic',
    marginTop: 6,
  },
  bootIdentity: {
    fontSize: 42,
    fontWeight: '900',
    color: '#f8fafc',
    letterSpacing: 2,
    textAlign: 'center',
    fontFamily: MONO,
    textShadowColor: '#60a5fa66',
    textShadowRadius: 10,
    textShadowOffset: { width: 0, height: 0 },
  },
  memoryValue: {
    fontSize: 36,
    fontWeight: '900',
    color: '#e2eaf8',
    fontFamily: MONO,
    letterSpacing: 2,
    marginVertical: 10,
    textAlign: 'center',
  },

  // ── Label selector (LABEL_ASSIGN screen) ───────────────────────────────────
  labelSelectRow: {
    flexDirection: 'row',
    gap: 12,
    marginVertical: 12,
  },
  labelOption: {
    width: 80,
    height: 80,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: '#1e4d8c',
    backgroundColor: '#0a1628',
    alignItems: 'center',
    justifyContent: 'center',
  },
  labelOptionActive: {
    borderColor: '#a78bfa',
    backgroundColor: '#2d1f5e',
    shadowColor: '#a78bfa',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.6,
    shadowRadius: 8,
    elevation: 6,
  },
  labelOptionText: {
    fontSize: 28,
    fontWeight: '900',
    color: '#5a7abf',
    fontFamily: 'monospace',
    letterSpacing: 1,
  },
  labelOptionTextActive: {
    color: '#a78bfa',
  },
  labelDesc: {
    fontSize: 22,
    color: '#c084fc',
    fontStyle: 'italic',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  iterValueSmall: {
    fontSize: 32,
    fontWeight: '900',
    color: '#cbd5e1',
    fontFamily: MONO,
    letterSpacing: 1,
  },
  iterValueActive: {
    color: '#60a5fa',
    textShadowColor: '#60a5fa66',
    textShadowRadius: 8,
    textShadowOffset: { width: 0, height: 0 },
  },

  // ── Recall Table & Erase Button ─────────────────────────────────────────
  eraseBtn: {
    backgroundColor: '#991b1b',
    borderWidth: 2,
    borderColor: '#ef4444',
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 24,
    marginVertical: 16,
    elevation: 4,
  },
  eraseBtnText: {
    color: '#fef2f2',
    fontSize: 26,
    fontWeight: '900',
    letterSpacing: 2,
    fontFamily: MONO,
  },
  iterTableContainer: {
    width: 280,
    marginTop: 10,
    marginBottom: 10,
    backgroundColor: '#050d1a',
  },
  iterTableHeader: {
    flexDirection: 'row',
    backgroundColor: '#1e3a6a',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  iterTableColHeader: {
    flex: 1,
    fontSize: 18,
    fontWeight: '700',
    color: '#9cc6ea',
    textAlign: 'center',
    fontFamily: MONO,
  },
  iterTableRow: {
    flexDirection: 'row',
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  iterTableCol1: {
    flex: 1,
    fontSize: 20,
    color: '#7ab8e8',
    textAlign: 'center',
    fontFamily: MONO,
  },
  iterTableCol2: {
    flex: 1,
    fontSize: 20,
    color: '#e2eaf8',
    fontWeight: '700',
    textAlign: 'center',
    fontFamily: MONO,
    letterSpacing: 2,
  },
  recallHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

