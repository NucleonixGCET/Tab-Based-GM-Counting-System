/**
 * GM Counting System — App.js
 * Implements Section 4.2.1: Acquisition Mode Selection
 *
 * ACQ Modes  : PRESET_TIME (default) | CPS | CPM
 * PROG Cycle : OFF → ACQ_SELECT → HV_ADJUST → OFF
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
  TouchableOpacity,
  StyleSheet,
  Alert,
  StatusBar,
  SafeAreaView,
  PanResponder,
  Animated,
  Image,
} from 'react-native';

// ─── Constants ───────────────────────────────────────────────────────────────
const HV_MIN = 0;
const HV_MAX = 1200;
const HV_STEP = 10;
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
const PROG_ACQ_SELECT = 'ACQ_SELECT';    // ① ▲/▼ cycle ACQ mode
const PROG_TIME_ADJUST = 'TIME_ADJUST';   // ② ▲ increment digit · ▼ move cursor left
const PROG_HV_ADJUST = 'HV_ADJUST';    // ③ ▲/▼ adjust HV
const PROG_SAVE_CONFIRM = 'SAVE_CONFIRM';  // ④ press ▲/▼ to save · PROG to discard
const PROG_SHOW_OK = 'SHOW_OK';       // transient 1-second OK flash

/** Convert a 1–9999 number into [thousands, hundreds, tens, units] digit array */
const numToDigits = (n) => {
  const s = String(Math.max(0, Math.min(9999, n))).padStart(4, '0');
  return s.split('').map(Number);
};
/** Convert a digit array back to a number (min 1) */
const digitsToNum = (d) => Math.max(1, d[0] * 1000 + d[1] * 100 + d[2] * 10 + d[3]);

const SLIDER_WIDTH = 280; // px — width of the HV slider track

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

  // Acquisition
  const [acqMode, setAcqMode] = useState('PRESET_TIME');
  const [progSub, setProgSub] = useState(PROG_OFF);   // PROG cycle state

  // Preset-time digit editing (used during PROG_TIME_ADJUST)
  const [cursorPos, setCursorPos] = useState(0);           // 0=thousands … 3=units
  const [draftDigits, setDraftDigits] = useState([0, 0, 1, 0]);   // default 0010 = 10
  const savedPresetTimeRef = useRef(DEFAULT_PR_TIME); // rollback snapshot
  const okTimeoutRef = useRef(null);

  // Counting state
  const [counts, setCounts] = useState(0);
  const [displayedCounts, setDisplayedCounts] = useState(0); // last completed window
  const [presetTime, setPresetTime] = useState(DEFAULT_PR_TIME);
  const [isRunning, setIsRunning] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);

  const intervalRef = useRef(null);
  const windowCountsRef = useRef(0);  // accumulator for current CPS/CPM window
  const windowElapsedRef = useRef(0);  // seconds elapsed within current window

  // ── Counting loop ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isRunning) return;

    intervalRef.current = setInterval(() => {
      // Simulate one tick of GM tube counts
      const tick = Math.floor(COUNT_RATE + (Math.random() - 0.5) * 40);

      if (acqMode === 'PRESET_TIME') {
        // ── Preset Time: accumulate and auto-stop at presetTime ────────────
        setCounts((c) => c + tick);
        setElapsedTime((prev) => {
          const next = prev + 1;
          if (next >= presetTime) {
            clearInterval(intervalRef.current);
            setIsRunning(false);
            return prev;
          }
          return next;
        });

      } else if (acqMode === 'CPS') {
        // ── CPS: show count for every individual second, reset each second ─
        windowCountsRef.current += tick;
        const cpsValue = windowCountsRef.current;
        setDisplayedCounts(cpsValue);   // update display every second
        windowCountsRef.current = 0;    // reset for next second
        setElapsedTime((t) => t + 1);

      } else if (acqMode === 'CPM') {
        // ── CPM: accumulate for 60 s, snapshot, reset, repeat ─────────────
        windowCountsRef.current += tick;
        windowElapsedRef.current += 1;
        setElapsedTime((t) => t + 1);

        if (windowElapsedRef.current >= 60) {
          setDisplayedCounts(windowCountsRef.current); // snapshot completed minute
          windowCountsRef.current = 0;               // reset
          windowElapsedRef.current = 0;
        }
      }
    }, 1000);

    return () => clearInterval(intervalRef.current);
  }, [isRunning, acqMode, presetTime]);

  // ── PROG cycle handler ────────────────────────────────────────────────────
  const handlePROG = () => {
    if (isRunning) return;
    setProgSub((prev) => {
      if (prev === PROG_OFF) {
        return PROG_ACQ_SELECT;
      }
      if (prev === PROG_ACQ_SELECT) {
        // Snapshot current presetTime and split into digits for editing
        savedPresetTimeRef.current = presetTime;
        setDraftDigits(numToDigits(presetTime));
        setCursorPos(0); // start cursor at thousands digit
        return PROG_TIME_ADJUST;
      }
      if (prev === PROG_TIME_ADJUST) {
        return PROG_HV_ADJUST;
      }
      if (prev === PROG_HV_ADJUST) {
        return PROG_SAVE_CONFIRM;
      }
      if (prev === PROG_SAVE_CONFIRM) {
        // PROG pressed without ▲/▼ confirmation → discard edits
        setPresetTime(savedPresetTimeRef.current);
        setDraftDigits(numToDigits(savedPresetTimeRef.current));
        return PROG_OFF;
      }
      // PROG_SHOW_OK: ignore while OK is flashing
      return prev;
    });
  };

  // ── ▲ / ▼ handlers ────────────────────────────────────────────────────────
  const handleUp = () => {
    if (isRunning) return;

    if (progSub === PROG_ACQ_SELECT) {
      setAcqMode((m) => {
        const idx = ACQ_MODE_ORDER.indexOf(m);
        return ACQ_MODE_ORDER[(idx + 1) % ACQ_MODE_ORDER.length];
      });

    } else if (progSub === PROG_TIME_ADJUST) {
      // ▲ → increment the digit at cursorPos (0–9 wrap)
      setDraftDigits((prev) => {
        const next = [...prev];
        next[cursorPos] = (next[cursorPos] + 1) % 10;
        setPresetTime(digitsToNum(next)); // keep live presetTime in sync
        return next;
      });

    } else if (progSub === PROG_HV_ADJUST) {
      setHv((v) => Math.min(v + hvStep, HV_MAX));

    } else if (progSub === PROG_SAVE_CONFIRM) {
      // ▲ on SAVE screen → commit save, flash OK
      setProgSub(PROG_SHOW_OK);
      okTimeoutRef.current = setTimeout(() => setProgSub(PROG_OFF), 1000);
    }
  };

  const handleDown = () => {
    if (isRunning) return;

    if (progSub === PROG_ACQ_SELECT) {
      setAcqMode((m) => {
        const idx = ACQ_MODE_ORDER.indexOf(m);
        return ACQ_MODE_ORDER[(idx - 1 + ACQ_MODE_ORDER.length) % ACQ_MODE_ORDER.length];
      });

    } else if (progSub === PROG_TIME_ADJUST) {
      // ▼ → move cursor one position to the LEFT (wraps 0 → 3)
      setCursorPos((pos) => (pos === 0 ? 3 : pos - 1));

    } else if (progSub === PROG_HV_ADJUST) {
      setHv((v) => Math.max(v - hvStep, HV_MIN));

    } else if (progSub === PROG_SAVE_CONFIRM) {
      // ▼ on SAVE screen → also commits save, flash OK
      setProgSub(PROG_SHOW_OK);
      okTimeoutRef.current = setTimeout(() => setProgSub(PROG_OFF), 1000);
    }
  };

  // ── SRT / STP ─────────────────────────────────────────────────────────────
  const handleSRT = () => {
    if (isRunning) return;
    setCounts(0);
    setDisplayedCounts(0);
    setElapsedTime(0);
    windowCountsRef.current = 0;
    windowElapsedRef.current = 0;
    setProgSub(PROG_OFF);
    setIsRunning(true);
  };

  const handleSTP = () => {
    clearInterval(intervalRef.current);
    setIsRunning(false);
  };

  // ── STORE ─────────────────────────────────────────────────────────────────
  const handleSTORE = () => {
    if (isRunning) return;
    Alert.alert(
      'Configuration Stored',
      `ACQ Mode    : ${ACQ_LABELS[acqMode]}\nPreset Time : ${presetTime} s\nHigh Voltage: ${hv} V`,
      [{ text: 'OK' }]
    );
    setProgSub(PROG_OFF);
  };

  // ── Derived display values ────────────────────────────────────────────────
  const remainingTime = acqMode === 'PRESET_TIME'
    ? Math.max(presetTime - elapsedTime, 0)
    : acqMode === 'CPM'
      ? Math.max(60 - windowElapsedRef.current, 0)  // seconds left in current CPM window
      : 0;

  // What to show in the Counts row
  const displayResult = (acqMode === 'CPS' || acqMode === 'CPM')
    ? displayedCounts
    : counts;

  const formatCounts = (n) => String(n).padStart(6, '0');
  const formatPRTime = (n) => String(n).padStart(4, '0');
  const formatHV = (n) => String(n).padStart(4, ' ');

  // ── PROG cycle label helpers ──────────────────────────────────────────────
  const progLabel =
    progSub === PROG_ACQ_SELECT ? '▲ / ▼  →  Select ACQ Mode'
      : progSub === PROG_TIME_ADJUST ? '▲ → Increment digit  ·  ▼ → Move cursor left'
        : progSub === PROG_HV_ADJUST ? '▲ / ▼  →  Adjust HV'
          : progSub === PROG_SAVE_CONFIRM ? 'Press ▲ or ▼ to SAVE  ·  Press PROG to discard'
            : progSub === PROG_SHOW_OK ? 'Settings saved!'
              : 'Press PROG to enter programming mode';

  const isProgOn = progSub !== PROG_OFF;

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
          {isProgOn && (
            <View style={[styles.badge, styles.badgeProg]}>
              <Text style={styles.badgeProgText}>
                {progSub === PROG_ACQ_SELECT
                  ? 'ACQ SELECT'
                  : progSub === PROG_TIME_ADJUST
                    ? 'TIME ADJUST'
                    : progSub === PROG_HV_ADJUST
                      ? 'HV ADJUST'
                      : progSub === PROG_SAVE_CONFIRM
                        ? 'SAVE?'
                        : 'SAVED ✓'}
              </Text>
            </View>
          )}
          {isRunning && (
            <View style={[styles.badge, styles.badgeRun]}>
              <Text style={styles.badgeRunText}>● COUNTING</Text>
            </View>
          )}
        </View>

        {/* ─── Main display + HV slider in a row ─────────────────────────── */}
        <View style={styles.mainRow}>

          {/* ── LCD Display panel ──────────────────────────────────────────── */}
          <View style={styles.displayBox}>

            {/* ══ SAVE? confirmation overlay ══════════════════════════════════ */}
            {progSub === PROG_SAVE_CONFIRM && (
              <View style={styles.overlayScreen}>
                <Text style={styles.overlayLine1}>SAVE?</Text>
                <Text style={styles.overlayLine2}>(PRG)</Text>
                <Text style={styles.overlaySub}>▲ or ▼  →  Confirm Save</Text>
                <Text style={styles.overlaySub}>PROG  {'→'}  Discard {'&'} Exit</Text>
              </View>
            )}

            {/* ══ OK flash overlay ════════════════════════════════════════════ */}
            {progSub === PROG_SHOW_OK && (
              <View style={styles.overlayScreen}>
                <Text style={styles.overlayOK}>OK</Text>
                <Text style={styles.overlaySub}>Settings saved!</Text>
              </View>
            )}

            {/* ══ Normal display rows (hidden during overlays) ════════════════ */}
            {progSub !== PROG_SAVE_CONFIRM && progSub !== PROG_SHOW_OK && (
              <>
                {/* ACQ MODE row */}
                <View style={styles.displayRow}>
                  <Text style={styles.displayLabel}>ACQ MODE :</Text>
                  <View style={[
                    styles.modeTag,
                    acqMode === 'CPS' && styles.modeTagCPS,
                    acqMode === 'CPM' && styles.modeTagCPM,
                    progSub === PROG_ACQ_SELECT && styles.modeTagEditing,
                  ]}>
                    <Text style={styles.modeTagText}>{ACQ_LABELS[acqMode]}</Text>
                  </View>
                </View>

                <View style={styles.displayDivider} />

                {/* Counts row */}
                <View style={styles.displayRow}>
                  <Text style={styles.displayLabel}>
                    {acqMode === 'CPM' ? 'CPM :' : acqMode === 'CPS' ? 'CPS :' : 'Counts :'}
                  </Text>
                  <Text style={styles.displayValue}>{formatCounts(displayResult)}</Text>
                </View>

                <View style={styles.displayDivider} />

                {/* PR.TIME row — digit-by-digit editor when in TIME_ADJUST */}
                {progSub === PROG_TIME_ADJUST ? (
                  <View style={{ paddingVertical: 4 }}>
                    {/* Line 1 */}
                    <Text style={styles.progEditHeader}>PRESET</Text>
                    {/* Line 2: TIME + individual digits with cursor */}
                    <View style={styles.progEditRow}>
                      <Text style={styles.progEditLabel}>TIME</Text>
                      <View style={styles.digitRow}>
                        {draftDigits.map((digit, idx) => (
                          <View key={idx} style={styles.digitCell}>
                            {/* Cursor arrow above the active digit */}
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
                    {/* Line 3: HV */}
                    <View style={styles.progEditRow}>
                      <Text style={styles.progEditLabel}>HV  </Text>
                      <Text style={styles.progEditHv}>{formatHV(hv)}</Text>
                      <Text style={styles.displayUnit}> V</Text>
                    </View>
                  </View>
                ) : (
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

                <View style={styles.displayDivider} />

                {/* HV row */}
                <View style={styles.displayRow}>
                  <Text style={[
                    styles.playIndicator,
                    isRunning && styles.playIndicatorActive,
                  ]}>▶</Text>
                  <Text style={styles.displayLabel}>HV :</Text>
                  <Text style={[
                    styles.displayValue,
                    progSub === PROG_HV_ADJUST && styles.displayValueEditing,
                  ]}>
                    {formatHV(hv)}
                  </Text>
                  <Text style={styles.displayUnit}> V</Text>
                </View>
              </>
            )}

          </View>

          {/* ── HV Helipot Slider ───────────────────────────────────────────── */}
          <HVSlider hv={hv} setHv={setHv} disabled={isRunning}
            hvStep={hvStep} setHvStep={setHvStep} />

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
                      : progSub === PROG_HV_ADJUST ? '③'
                        : progSub === PROG_SAVE_CONFIRM ? '④'
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
              style={styles.btn}
              onPress={handleSTORE}
              activeOpacity={0.7}>
              <Text style={styles.btnText}>STORE</Text>
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
  const thumbX = useRef(new Animated.Value(hvToX(hv))).current;
  const dragStartHvRef = useRef(hv);

  // Keep thumb in sync when hv changes via ▲/▼ buttons
  useEffect(() => {
    thumbX.setValue(hvToX(hv));
    dragStartHvRef.current = hv;
  }, [hv]);

  function hvToX(v) {
    return ((v - HV_MIN) / (HV_MAX - HV_MIN)) * SLIDER_WIDTH;
  }

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,
      onPanResponderGrant: () => {
        dragStartHvRef.current = hv;
      },
      onPanResponderMove: (_, gestureState) => {
        // Quantize drag into deliberate movement buckets to avoid oversensitive updates.
        const PX_PER_STEP = 18;
        const dragSteps = Math.round(gestureState.dx / PX_PER_STEP);
        const nextHv = Math.max(
          HV_MIN,
          Math.min(HV_MAX, dragStartHvRef.current + dragSteps * hvStep)
        );
        setHv(nextHv);
        thumbX.setValue(hvToX(nextHv));
      },
      onPanResponderRelease: () => {
        // Snap thumb to the nearest hvStep boundary
        setHv((v) => {
          const snapped = Math.round(v / hvStep) * hvStep;
          thumbX.setValue(hvToX(snapped));
          return snapped;
        });
      },
    })
  ).current;

  const pct = ((hv - HV_MIN) / (HV_MAX - HV_MIN)) * 100;

  return (
    <View style={styles.sliderContainer}>
      <Text style={styles.sliderTitle}>HIGH VOLTAGE</Text>
      <Text style={styles.sliderTitle}>CONTROL</Text>

      {/* Knob label */}
      <View style={styles.knobRing}>
        <Text style={styles.knobValue}>{hv}</Text>
        <Text style={styles.knobUnit}>V</Text>
      </View>

      {/* Track */}
      <View style={styles.sliderTrack} {...panResponder.panHandlers}>
        {/* Fill */}
        <View style={[styles.sliderFill, { width: `${pct}%` }]} />
        {/* Thumb */}
        <Animated.View
          style={[
            styles.sliderThumb,
            { left: thumbX },
            disabled && styles.sliderThumbDisabled,
          ]}
        />
      </View>

      <View style={styles.sliderLabels}>
        <Text style={styles.sliderEdge}>◄ CCW</Text>
        <Text style={styles.sliderEdge}>CW ►</Text>
      </View>

      {/* ── HV Step selector ───────────────────────────────── */}
      <Text style={styles.stepLabel}>HV STEP</Text>
      <View style={styles.stepRow}>
        {[30, 50].map((val) => (
          <TouchableOpacity
            key={val}
            style={[
              styles.stepBtn,
              hvStep === val && styles.stepBtnActive,
            ]}
            onPress={() => setHvStep(val)}
            activeOpacity={0.7}
          >
            <Text style={[
              styles.stepBtnText,
              hvStep === val && styles.stepBtnTextActive,
            ]}>{val} V</Text>
          </TouchableOpacity>
        ))}
      </View>

      <Text style={styles.sliderHint}>
        {disabled ? 'HV locked during count' : `Step: ±${hvStep} V`}
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
    width: '95%',
    maxWidth: 900,
    backgroundColor: PANEL_BG,
    borderWidth: 3,
    borderColor: BORDER,
    borderRadius: 6,
    paddingVertical: 20,
    paddingHorizontal: 24,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 3, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },

  logo: {
    width: 180,
    height: 60,
    alignSelf: 'center',
    marginBottom: 6,
  },

  title: {
    fontSize: 26,
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
  badgeProgText: { color: PROG_COLOR, fontWeight: '700', fontSize: 12, letterSpacing: 0.8 },
  badgeRun: { backgroundColor: '#14532d55', borderColor: GO_COLOR },
  badgeRunText: { color: GO_COLOR, fontWeight: '700', fontSize: 12 },

  // ── Main row (display + slider side by side) ──────────────────────────────
  mainRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 20,
    marginBottom: 16,
  },

  // ── Display box ───────────────────────────────────────────────────────────
  displayBox: {
    flex: 1,
    backgroundColor: DISPLAY_BG,
    borderWidth: 2.5,
    borderColor: BORDER,
    borderRadius: 4,
    paddingVertical: 12,
    paddingHorizontal: 18,
  },
  displayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 5,
    minHeight: 38,
  },
  displayDivider: {
    height: 1,
    backgroundColor: '#1e4d8c66',
    marginVertical: 1,
  },
  displayLabel: {
    fontSize: 17,
    fontWeight: '600',
    color: '#7ab8e8',
    width: 120,
    fontFamily: MONO,
  },
  displayValue: {
    fontSize: 22,
    fontWeight: '700',
    color: '#e2eaf8',
    letterSpacing: 3,
    fontFamily: MONO,
  },
  displayValueDim: {
    color: '#888',
  },
  displayValueEditing: {
    color: PROG_COLOR,
  },
  timeInput: {
    fontSize: 22,
    fontWeight: '700',
    color: '#e2eaf8',
    letterSpacing: 3,
    fontFamily: MONO,
    minWidth: 72,
    borderBottomWidth: 2,
    borderBottomColor: PROG_COLOR,
    paddingVertical: 2,
    paddingHorizontal: 4,
  },
  displayUnit: {
    fontSize: 14,
    color: '#7ab8e8',
    fontFamily: MONO,
    marginLeft: 2,
  },
  playIndicator: {
    fontSize: 16,
    color: '#aaa',
    width: 22,
    fontFamily: MONO,
  },
  playIndicatorActive: {
    color: GO_COLOR,
  },

  // ── ACQ mode tag ──────────────────────────────────────────────────────────
  modeTag: {
    backgroundColor: '#0f3460',
    borderWidth: 1.5,
    borderColor: '#2a6abf',
    borderRadius: 4,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  modeTagCPS: { backgroundColor: '#0f2d50', borderColor: '#3a7adf' },
  modeTagCPM: { backgroundColor: '#1a2a50', borderColor: '#5a8adf' },
  modeTagEditing: { borderColor: PROG_COLOR, borderWidth: 2.5 },
  modeTagText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#c8e0ff',
    letterSpacing: 1,
    fontFamily: MONO,
  },

  // ── HV Slider ─────────────────────────────────────────────────────────────
  sliderContainer: {
    width: 150,
    alignItems: 'center',
    backgroundColor: '#0c1e3a',
    borderWidth: 2,
    borderColor: BORDER,
    borderRadius: 6,
    paddingVertical: 12,
    paddingHorizontal: 8,
  },
  sliderTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: '#7ab8e8',
    letterSpacing: 0.8,
    textAlign: 'center',
  },
  knobRing: {
    width: 80,
    height: 80,
    borderRadius: 40,
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
    fontSize: 22,
    fontWeight: '900',
    color: '#e2eaf8',
    fontFamily: MONO,
  },
  knobUnit: {
    fontSize: 11,
    color: '#7ab8e8',
    fontFamily: MONO,
  },
  sliderTrack: {
    width: SLIDER_WIDTH * 0.5,
    height: 20,
    backgroundColor: '#0a1828',
    borderRadius: 10,
    marginTop: 4,
    overflow: 'visible',
    justifyContent: 'center',
  },
  sliderFill: {
    height: '100%',
    backgroundColor: '#2563eb',
    borderRadius: 10,
  },
  sliderThumb: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#60a5fa',
    borderWidth: 3,
    borderColor: '#1d4ed8',
    top: -4,
    marginLeft: -14,
    shadowColor: '#000',
    shadowOffset: { width: 1, height: 2 },
    shadowOpacity: 0.5,
    shadowRadius: 2,
    elevation: 4,
  },
  sliderThumbDisabled: {
    backgroundColor: '#334155',
    borderColor: '#475569',
  },
  sliderLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: 6,
    paddingHorizontal: 4,
  },
  sliderEdge: {
    fontSize: 10,
    color: '#7ab8e8',
    fontWeight: '600',
  },
  sliderHint: {
    marginTop: 4,
    fontSize: 10,
    color: '#5a8abf',
    fontStyle: 'italic',
    textAlign: 'center',
  },

  // ── HV Step toggle ────────────────────────────────────────────────────────
  stepLabel: {
    marginTop: 10,
    fontSize: 10,
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
    paddingVertical: 5,
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
    fontSize: 11,
    fontWeight: '700',
    color: '#7ab8e8',
  },
  stepBtnTextActive: {
    color: '#60a5fa',
  },

  // ── Button grid ───────────────────────────────────────────────────────────
  buttonGrid: {
    width: '100%',
    gap: 12,
  },
  buttonRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 14,
  },
  btn: {
    flex: 1,
    height: 64,
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
    fontSize: 19,
    fontWeight: '800',
    color: TEXT_DARK,
    letterSpacing: 1.4,
  },
  btnArrow: { flex: 0.65 },
  arrowText: { fontSize: 24, color: '#c8deff', fontWeight: '900' },

  btnProgActive: { backgroundColor: '#1a3460', borderColor: PROG_COLOR },
  btnTextProg: { color: PROG_COLOR },
  progSubLabel: { fontSize: 12, color: PROG_COLOR, fontWeight: '700' },

  btnSRT: { backgroundColor: '#14532d', borderColor: GO_COLOR },
  btnSRTText: { color: GO_COLOR, fontWeight: '900' },

  btnSTP: { backgroundColor: '#7f1d1d', borderColor: STOP_COLOR },
  btnSTPText: { color: '#fca5a5', fontWeight: '900' },

  btnDisabled: { backgroundColor: '#0a1628', borderColor: '#1e3a5f', opacity: 0.45 },

  hintText: {
    marginTop: 12,
    fontSize: 13,
    color: '#5a8abf',
    letterSpacing: 0.4,
    fontStyle: 'italic',
  },

  // ── Preset Time digit-editor UI ────────────────────────────────────────────────
  progEditHeader: {
    fontSize: 13,
    fontWeight: '800',
    color: '#7ab8e8',
    letterSpacing: 2,
    fontFamily: 'monospace',
    marginBottom: 2,
  },
  progEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 2,
  },
  progEditLabel: {
    fontSize: 17,
    fontWeight: '700',
    color: '#7ab8e8',
    fontFamily: 'monospace',
    width: 52,
  },
  progEditHv: {
    fontSize: 20,
    fontWeight: '700',
    color: '#e2eaf8',
    letterSpacing: 3,
    fontFamily: 'monospace',
  },

  // Digit cells
  digitRow: {
    flexDirection: 'row',
    gap: 4,
  },
  digitCell: {
    alignItems: 'center',
    width: 26,
  },
  cursorArrow: {
    fontSize: 11,
    fontWeight: '900',
    height: 14,
    lineHeight: 14,
  },
  cursorArrowActive: {
    color: '#60a5fa',        // PROG_COLOR
  },
  cursorArrowHidden: {
    color: 'transparent',
  },
  digitChar: {
    fontSize: 24,
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
    fontSize: 32,
    fontWeight: '900',
    color: '#f59e0b',       // amber — attention
    letterSpacing: 3,
    fontFamily: 'monospace',
  },
  overlayLine2: {
    fontSize: 20,
    fontWeight: '700',
    color: '#fbbf24',
    letterSpacing: 2,
    fontFamily: 'monospace',
    marginBottom: 8,
  },
  overlayOK: {
    fontSize: 48,
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
    fontSize: 12,
    color: '#7ab8e8',
    fontStyle: 'italic',
    marginTop: 2,
  },
});
