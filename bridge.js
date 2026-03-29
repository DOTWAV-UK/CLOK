#!/usr/bin/env node
// DOTWAV CLOK Bridge v3.0
// This is a generated bundle. Edit the source modules and run bundle.py to rebuild.
//   Sources: clok-engine.js  mtc-parser.js  mtc-generator.js  bridge.js
//   Build:   python3 bundle.py
//   Repo:    https://github.com/dotwav/clok
'use strict';

const midi      = require('midi');
const WebSocket = require('ws');
const { performance } = require('perf_hooks');
let chalk;
try { chalk = require('chalk'); }
catch(e) { chalk = { green:s=>s, yellow:s=>s, red:s=>s, cyan:s=>s,
                     gray:s=>s, magenta:s=>s, bold:{white:s=>s} }; }

// ══════════════════════════════════════════════════════════════════
// clok-engine.js
// ══════════════════════════════════════════════════════════════════

/**
 * DOTWAV CLOK — Shared Engine Module
 * ─────────────────────────────────────────────────────────────────────────────
 * The single source of truth for all timecode logic.
 *
 * This module is environment-agnostic — it runs identically in Node.js (bridge)
 * and in the browser (loaded as a plain <script> or ES module).
 *
 * Nothing in here knows about MIDI, WebSocket, Web Audio, or the DOM.
 *
 * Exports (or assigns to globalThis in non-module environments):
 *   ClokEngine    — wall-clock anchored timecode engine with PLL
 *   ClokTC        — timecode math utilities
 *   ClokState     — shared state vocabulary + payload factory
 *   CLOK_VERSION  — semver string
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */


const CLOK_VERSION = '3.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// ClokTC — Timecode Maths
//
// All pure functions. No state. Safe to call from anywhere.
// ─────────────────────────────────────────────────────────────────────────────
const ClokTC = {

  /** Supported frame rates */
  RATES: [23.976, 24, 25, 29.97, 30],

  /** Map from fps numeric value → MTC fps code (bits 5-6 of QF message 7) */
  FPS_CODE: { 23.976: 0, 24: 0, 25: 1, 29.97: 2, 30: 3 },

  /** Milliseconds per frame for a given fps */
  msPerFrame(fps) {
    return 1000 / fps;
  },

  /** Convert a TC object to total milliseconds from 00:00:00:00 */
  toMs(hh, mm, ss, ff, fps) {
    return ((hh * 3600) + (mm * 60) + ss) * 1000 + (ff * (1000 / fps));
  },

  /** Convert total milliseconds to a TC object at a given fps */
  fromMs(totalMs, fps) {
    const msPerFrame = 1000 / fps;
    let remaining   = Math.max(0, totalMs);
    const hh = Math.floor(remaining / 3_600_000); remaining -= hh * 3_600_000;
    const mm = Math.floor(remaining / 60_000);    remaining -= mm * 60_000;
    const ss = Math.floor(remaining / 1_000);     remaining -= ss * 1_000;
    const ff = Math.min(Math.floor(remaining / msPerFrame), Math.ceil(fps) - 1);
    return { hh, mm, ss, ff };
  },

  /** Advance a TC position by n frames (handles rollover, supports negative) */
  advance(hh, mm, ss, ff, fps, n = 1) {
    const totalMs  = this.toMs(hh, mm, ss, ff, fps);
    const advanced = totalMs + (n * this.msPerFrame(fps));
    const clamped  = ((advanced % 86_400_000) + 86_400_000) % 86_400_000; // wrap at 24h
    return this.fromMs(clamped, fps);
  },

  /** Format a TC object or {hh,mm,ss,ff} as HH:MM:SS:FF */
  format(hh, mm, ss, ff) {
    const p = n => String(n).padStart(2, '0');
    return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
  },

  /** Parse "HH:MM:SS:FF" → { hh, mm, ss, ff } or null */
  parse(str) {
    const m = /^(\d{1,2}):(\d{2}):(\d{2}):(\d{2})$/.exec((str || '').trim());
    if (!m) return null;
    return { hh: +m[1], mm: +m[2], ss: +m[3], ff: +m[4] };
  },

  /** True if two TC positions represent the same frame */
  equal(a, b) {
    return a.hh === b.hh && a.mm === b.mm && a.ss === b.ss && a.ff === b.ff;
  },

  /**
   * Detect whether b follows a sequentially (within a tolerance).
   * A "locate" is a jump larger than maxJumpFrames.
   */
  isSequential(aHH, aMM, aSS, aFF, bHH, bMM, bSS, bFF, fps, maxJumpFrames = 4) {
    const aMs = this.toMs(aHH, aMM, aSS, aFF, fps);
    const bMs = this.toMs(bHH, bMM, bSS, bFF, fps);
    const diffFrames = (bMs - aMs) / this.msPerFrame(fps);
    return diffFrames >= 0 && diffFrames <= maxJumpFrames;
  },

  /**
   * Detect the nearest matching frame rate from a measured bitrate (bps).
   * bitsPerSecond = SR / bitPeriod for LTC decoder usage, or derived from
   * MTC QF timing in bridge usage.
   * Returns the closest matching SMPTE rate within 10% tolerance, or null.
   */
  detectFps(bitsPerSecond) {
    let best = null, bestDiff = Infinity;
    for (const f of this.RATES) {
      const expected = f * 80; // LTC bit rate = fps × 80 bits per frame
      const diff     = Math.abs(bitsPerSecond - expected);
      if (diff < expected * 0.10 && diff < bestDiff) {
        bestDiff = diff;
        best     = f;
      }
    }
    return best;
  },

  /**
   * Refine a coarse fps detection using the drop-frame flag from a decoded
   * LTC frame. 30fps + DF flag → 29.97DF.
   */
  refineFps(coarseFps, dfBit) {
    if (coarseFps === 30 && dfBit) return 29.97;
    return coarseFps;
  },

  /** True if fps is a drop-frame rate */
  isDropFrame(fps) {
    return Math.abs(fps - 29.97) < 0.01;
  },
};


// ─────────────────────────────────────────────────────────────────────────────
// ClokState — Shared vocabulary
//
// Defines the canonical state machine values and the shared payload shape
// used by both bridge.js and the browser application.
// ─────────────────────────────────────────────────────────────────────────────
const ClokState = {

  // ── Engine states ────────────────────────────────────────────────────────
  STATE: {
    IDLE:      'idle',       // not running
    SEARCHING: 'searching',  // running but not yet locked
    LOCKED:    'locked',     // running and tracking cleanly
    LOCATING:  'locating',   // position jump detected, re-acquiring
    STOPPED:   'stopped',    // transport stopped
  },

  // ── Signal sources ────────────────────────────────────────────────────────
  SOURCE: {
    LTC:      'ltc',      // decoded from LTC audio
    MTC:      'mtc',      // received via MIDI Timecode
    INTERNAL: 'internal', // free-running generator
    BRIDGE:   'bridge',   // forwarded from CLOK Bridge over WebSocket
  },

  // ── WebSocket message types ───────────────────────────────────────────────
  MSG: {
    // Bridge → Browser
    TC_FRAME:  'tc_frame',   // timecode position update
    TRANSPORT: 'transport',  // play/stop/locate event
    ENGINE:    'engine',     // engine state change (locked/searching/etc.)
    DRIFT:     'drift',      // PLL drift telemetry

    // Browser → Bridge
    LTC_FRAME: 'ltc_frame',  // decoded LTC frame from browser
    PING:      'ping',
    PONG:      'pong',
  },

  /**
   * Factory: build a canonical engine payload.
   * Both bridge.js and the browser always produce this shape when
   * describing the current timecode state. Consumers never need
   * to handle two different schemas.
   *
   * @param {object} opts
   * @returns {object} canonical CLOK engine payload
   */
  payload({
    hh = 0, mm = 0, ss = 0, ff = 0,
    fps        = 25,
    state      = ClokState.STATE.IDLE,
    source     = ClokState.SOURCE.INTERNAL,
    playing    = false,
    locating   = false,
    driftMs    = 0,
    corrMs     = 0,
    df         = false,
    seqNum     = 0,       // monotonically incrementing frame counter
    wallMs     = 0,       // performance.now() or Date.now() at this snapshot
  } = {}) {
    return {
      // Position
      tc:   ClokTC.format(hh, mm, ss, ff),
      hh, mm, ss, ff,
      fps,
      df,
      // Transport
      state,
      source,
      playing,
      locating,
      // Telemetry
      driftMs,
      corrMs,
      // Bookkeeping
      seqNum,
      wallMs,
      // Version — lets consumers handle schema changes gracefully
      v: CLOK_VERSION,
    };
  },
};


// ─────────────────────────────────────────────────────────────────────────────
// ClokEngine — Wall-clock anchored timecode with PLL drift correction
//
// Usage:
//   const eng = new ClokEngine({ fps: 25 });
//   eng.sync(hh, mm, ss, ff, performance.now());   // called on each anchor
//   const pos = eng.now();                          // read current position
// ─────────────────────────────────────────────────────────────────────────────
class ClokEngine {
  constructor({ fps = 25, pll = {} } = {}) {
    this.fps = fps;

    // Anchor: last known good TC position + wall-clock instant
    this._anchorMs    = 0;   // TC position at anchor, in total milliseconds
    this._anchorWall  = 0;   // wall-clock ms at anchor (performance.now())
    this._running     = false;
    this._playing     = false;
    this._state       = ClokState.STATE.IDLE;
    this._lastSyncWall = 0;  // for stale-detection

    // PLL
    this._pll = {
      driftMs:     0,
      corrMs:      0,
      gain:        pll.gain        ?? 0.15,
      maxCorrect:  pll.maxCorrect  ?? 8,
      snapFrames:  pll.snapFrames  ?? 2,
      histLen:     pll.histLen     ?? 8,
      history:     [],
    };

    this._seqNum = 0;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Current fps setting */
  get fps() { return this._fps; }
  set fps(v) { this._fps = v; }

  /** Is the engine running (playing or paused at a position) */
  get running() { return this._running; }

  /** Is transport playing */
  get playing() { return this._playing; }

  /** Current engine state string */
  get state() { return this._state; }

  /** Current PLL drift in ms */
  get driftMs() { return this._pll.driftMs; }

  /** Current PLL correction in ms */
  get corrMs() { return this._pll.corrMs; }

  /** Wall-clock ms of the last successful sync (for stale-signal detection) */
  get lastSyncWall() { return this._lastSyncWall; }

  /**
   * anchor() — engine has a clean position and is playing.
   * Use for: first MTC frame after startup, resuming after stop.
   * Sets state → SEARCHING (will promote to LOCKED once PLL stabilises).
   */
  anchor(hh, mm, ss, ff, wallMs) {
    this._writeAnchor(hh, mm, ss, ff, wallMs);
    this._playing = true;
    this._setState(ClokState.STATE.SEARCHING);
  }

  /**
   * locate() — transport jumped to a new position explicitly.
   * Use for: Full Frame SysEx, user scrub, large drift snap.
   * Sets state → LOCATING so consumers know a discontinuity occurred.
   * playing is preserved — a locate mid-roll does not stop transport.
   */
  locate(hh, mm, ss, ff, wallMs) {
    this._writeAnchor(hh, mm, ss, ff, wallMs);
    this._setState(ClokState.STATE.LOCATING);
  }

  /**
   * Soft-sync the engine to an incoming MTC/LTC position.
   * Applies PLL correction rather than hard-snapping (unless drift > threshold).
   * Call this on every decoded frame / QF8.
   *
   * @param {number} hh/mm/ss/ff  — decoded TC position
   * @param {number} wallMs       — performance.now() when this frame was decoded
   */
  sync(hh, mm, ss, ff, wallMs) {
    const fps          = this._fps;
    const msPerFrame   = ClokTC.msPerFrame(fps);
    const incomingMs   = ClokTC.toMs(hh, mm, ss, ff, fps);

    // What does our engine think the position is right now?
    const engineMs     = this._anchorMs + (wallMs - this._anchorWall);

    // Drift = how far the engine is ahead of (or behind) the incoming TC
    const driftMs      = engineMs - incomingMs;
    const driftFrames  = Math.abs(driftMs) / msPerFrame;

    this._lastSyncWall = wallMs;

    // Large jump → hard locate (transport discontinuity detected)
    if (driftFrames > this._pll.snapFrames) {
      this.locate(hh, mm, ss, ff, wallMs);
      return;
    }

    // PLL: smooth drift correction
    const pll = this._pll;
    pll.history.push(driftMs);
    if (pll.history.length > pll.histLen) pll.history.shift();

    const smoothDrift = pll.history.reduce((a, b) => a + b, 0) / pll.history.length;
    const correction  = Math.max(-pll.maxCorrect,
                         Math.min(pll.maxCorrect, smoothDrift * pll.gain));

    // Smooth phase correction: gently shift the wall-clock anchor to reduce
    // drift without hard-snapping position. This is a phase adjustment only —
    // now() still uses (anchorMs + elapsed) with no rate term. A true
    // variable-rate oscillator would require a separate playback-rate scalar.
    this._anchorWall  += correction;
    pll.driftMs        = smoothDrift;
    pll.corrMs         = correction;

    // Promote to LOCKED after sufficient stable frames
    if (pll.history.length >= pll.histLen &&
        Math.abs(smoothDrift) < msPerFrame * 0.5) {
      this._setState(ClokState.STATE.LOCKED);
    } else if (this._state === ClokState.STATE.LOCATING) {
      this._setState(ClokState.STATE.SEARCHING);
    }
  }

  /** Mark transport stopped */
  stop() {
    this._playing        = false;
    this._pll.driftMs    = 0;
    this._pll.corrMs     = 0;
    this._setState(ClokState.STATE.STOPPED);
  }

  /** Mark engine idle (no signal) */
  idle() {
    this._running        = false;
    this._playing        = false;
    this._pll.history    = [];
    this._pll.driftMs    = 0;
    this._pll.corrMs     = 0;
    this._setState(ClokState.STATE.IDLE);
  }

  /**
   * Read the current timecode position from the wall clock.
   * Returns { hh, mm, ss, ff } at the current instant.
   *
   * @param {number} [wallMs]  — wall-clock ms to evaluate at (default: now)
   */
  now(wallMs) {
    if (!this._running) return { hh: 0, mm: 0, ss: 0, ff: 0 };
    const w  = wallMs ?? this._wallNow();
    const ms = this._anchorMs + (w - this._anchorWall);
    return ClokTC.fromMs(ms, this._fps);
  }

  /**
   * Build a canonical payload snapshot at the current instant.
   * This is what gets broadcast over WebSocket or posted to the browser.
   *
   * @param {number} [wallMs]  — wall-clock ms to snapshot at (default: now)
   * @param {string} [source]  — ClokState.SOURCE value (default: SOURCE.INTERNAL)
   */
  snapshot(wallMs, source) {
    const w   = wallMs ?? this._wallNow();
    const pos = this.now(w);
    return ClokState.payload({
      ...pos,
      fps:      this._fps,
      state:    this._state,
      source:   source ?? ClokState.SOURCE.INTERNAL,
      playing:  this._playing,
      locating: this._state === ClokState.STATE.LOCATING,
      driftMs:  this._pll.driftMs,
      corrMs:   this._pll.corrMs,
      seqNum:   ++this._seqNum,
      wallMs:   w,
    });
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** Shared position write used by anchor() and locate(). */
  _writeAnchor(hh, mm, ss, ff, wallMs) {
    this._anchorMs     = ClokTC.toMs(hh, mm, ss, ff, this._fps);
    this._anchorWall   = wallMs;
    this._running      = true;
    this._lastSyncWall = wallMs;
    this._pll.history  = [];
    this._pll.driftMs  = 0;
    this._pll.corrMs   = 0;
  }

  _setState(s) {
    this._state = s;
  }

  _wallNow() {
    // performance.now() is available in all target environments:
    //   - Browser: native global
    //   - Node.js: imported from perf_hooks at module/bundle top
    // The require('perf_hooks') fallback previously here was dead code in the
    // bundle (performance already global) and incorrect in isolation (perf_hooks
    // not imported). Callers are expected to ensure performance is in scope.
    return performance.now();
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Export — works as CommonJS (Node) and as a browser global
// ─────────────────────────────────────────────────────────────────────────────
const _exports = { CLOK_VERSION, ClokTC, ClokState, ClokEngine };

if (typeof module !== 'undefined' && module.exports) {
  // Node.js / CommonJS
  module.exports = _exports;
} else if (typeof window !== 'undefined') {
  // Browser global
  Object.assign(window, _exports);
}

// ══════════════════════════════════════════════════════════════════
// mtc-parser.js
// ══════════════════════════════════════════════════════════════════

/**
 * DOTWAV CLOK — MTC Parser Module
 * ─────────────────────────────────────────────────────────────────────────────
 * Reconstructs full timecode from MIDI Timecode messages.
 * Knows nothing about WebSocket, bridge.js, or the DOM.
 *
 * Handles:
 *   - Quarter-frame messages (0xF1 <data>)
 *   - Full Frame SysEx (0xF0 0x7F 0x7F 0x01 0x01 ...)
 *   - MTC Stop (0xFC)
 *
 * Usage:
 *   const parser = new MtcParser({ onFrame, onLocate, onStop });
 *   parser.message([0xF1, 0x05]);          // quarter-frame
 *   parser.message([0xF0, 0x7F, ...]);     // full frame sysex
 *   parser.message([0xFC]);               // stop
 * ─────────────────────────────────────────────────────────────────────────────
 */


// Allow standalone use in Node without the engine module

const FPS_TABLE = [24, 25, 29.97, 30];

class MtcParser {
  /**
   * @param {object} handlers
   * @param {function} handlers.onFrame   — called with canonical payload on each complete frame
   * @param {function} handlers.onLocate  — called with canonical payload on Full Frame SysEx
   * @param {function} handlers.onStop    — called when MTC Stop is received
   */
  constructor({ onFrame = () => {}, onLocate = () => {}, onStop = () => {} } = {}) {
    this._onFrame  = onFrame;
    this._onLocate = onLocate;
    this._onStop   = onStop;

    this._reset();
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  /**
   * Feed a raw MIDI message (Uint8Array or plain array).
   * Call this from your MIDI input callback.
   */
  message(bytes) {
    const status = bytes[0];

    if (status === 0xF1) {
      this._quarterFrame(bytes[1]);
    } else if (status === 0xF0) {
      this._sysex(bytes);
    } else if (status === 0xFC) {
      this._onStop();
    }
  }

  /** Reset internal accumulator state */
  reset() {
    this._reset();
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _reset() {
    // 8 nibbles of QF data, indexed by QF message number 0-7
    this._qf       = new Uint8Array(8);
    this._qfCount  = 0;    // number of QF messages received since last complete frame
    this._lastQF   = -1;   // last message number seen (for sequence checking)
    this._prevTC   = null; // last decoded TC (for sequential detection)
  }

  _quarterFrame(data1) {
    const msgNum = (data1 >> 4) & 0x7;  // bits 4-6: message number 0-7
    const nibble =  data1       & 0xF;  // bits 0-3: 4-bit data

    this._qf[msgNum] = nibble;
    this._qfCount++;
    this._lastQF = msgNum;

    // A complete timecode value is available after message 7
    // (we need all 8 quarter-frames to have been received at least once)
    if (msgNum === 7 && this._qfCount >= 8) {
      this._decodeQF();
    }
  }

  _decodeQF() {
    const q  = this._qf;

    const ff = (q[1] & 0x1) * 10 + (q[0] & 0xF);
    const ss = (q[3] & 0x7) * 10 + (q[2] & 0xF);
    const mm = (q[5] & 0x7) * 10 + (q[4] & 0xF);
    const hh = (q[7] & 0x3) * 10 + (q[6] & 0xF);

    const fpsCode = (q[7] >> 1) & 0x3;
    const fps     = FPS_TABLE[fpsCode] ?? 25;
    const df      = fpsCode === 2; // 29.97 drop frame

    // MTC QF values describe the frame 2 frames ago (per MIDI spec),
    // so we advance by 2 to get the current position.
    let outHH, outMM, outSS, outFF;
    const advanced = ClokTC.advance(hh, mm, ss, ff, fps, 2);
    outHH = advanced.hh; outMM = advanced.mm;
    outSS = advanced.ss; outFF = advanced.ff;

    const isLoc = this._prevTC
      ? !ClokTC.isSequential(
          this._prevTC.hh, this._prevTC.mm, this._prevTC.ss, this._prevTC.ff,
          outHH, outMM, outSS, outFF, fps)
      : false;

    const payload = {
      ...(ClokState.payload({
            hh: outHH, mm: outMM, ss: outSS, ff: outFF,
            fps, df,
            source:   ClokState.SOURCE.MTC,
            locating: isLoc,
          })),
      rawQF: Array.from(q),   // diagnostic: full QF nibble state
    };

    this._prevTC = { hh: outHH, mm: outMM, ss: outSS, ff: outFF };
    this._onFrame(payload);
  }

  _sysex(bytes) {
    // Full Frame SysEx: F0 7F 7F 01 01 <hr> <mn> <sc> <fr> F7
    // hr byte: bits 7-5 = fps code, bits 4-0 = hours
    if (bytes.length < 10) return;
    if (bytes[1] !== 0x7F || bytes[2] !== 0x7F) return;
    if (bytes[3] !== 0x01 || bytes[4] !== 0x01) return;

    const hr      = bytes[5];
    const fpsCode = (hr >> 5) & 0x3;
    const hh      = hr & 0x1F;
    const mm      = bytes[6] & 0x3F;
    const ss      = bytes[7] & 0x3F;
    const ff      = bytes[8] & 0x1F;
    const fps     = FPS_TABLE[fpsCode] ?? 25;
    const df      = fpsCode === 2;

    // Full Frame SysEx is always a locate — reset QF state
    this._reset();

    const payload = {
      ...(ClokState.payload({
            hh, mm, ss, ff,
            fps, df,
            source:   ClokState.SOURCE.MTC,
            locating: true,   // Full Frame is always a locate
          })),
    };

    this._prevTC = { hh, mm, ss, ff };
    this._onLocate(payload);
  }
}

// ══════════════════════════════════════════════════════════════════
// mtc-generator.js
// ══════════════════════════════════════════════════════════════════

/**
 * DOTWAV CLOK — MTC Generator Module
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates MIDI Timecode quarter-frame messages and Full Frame SysEx locates.
 * Knows nothing about MIDI ports, WebSocket, or the DOM.
 * The caller provides a send(bytes) function.
 *
 * Usage:
 *   const gen = new MtcGenerator({
 *     send: (bytes) => midiOutput.sendMessage(bytes),
 *     fps: 25
 *   });
 *
 *   gen.locate(1, 0, 0, 0);          // send Full Frame SysEx to 01:00:00:00
 *   gen.start(1, 0, 0, 0);           // begin streaming QF messages
 *   gen.stop();                      // stop streaming
 * ─────────────────────────────────────────────────────────────────────────────
 */



const FPS_CODE_MAP = { 24: 0, 25: 1, 29.97: 2, 30: 3, 23.976: 0 };
// QF messages are sent at 4× the frame rate (4 QF per frame, 8 per 2 frames)
// MTC spec: 2 QF messages per quarter frame = 8 QF per complete frame pair
// So QF interval = 1000 / (fps * 4) ms

class MtcGenerator {
  /**
   * @param {object} opts
   * @param {function} opts.send    — send(Uint8Array) — caller provides MIDI output
   * @param {number}  [opts.fps]   — initial frame rate (default 25)
   */
  constructor({ send, fps = 25 } = {}) {
    if (typeof send !== 'function') throw new Error('MtcGenerator: send(bytes) required');
    this._send   = send;
    this._fps    = fps;
    this._timer  = null;
    this._hh = 0; this._mm = 0; this._ss = 0; this._ff = 0;
    this._qfIndex = 0;   // 0–7, which QF message to send next
    this._running = false;
  }

  // ── Public ──────────────────────────────────────────────────────────────────

  get fps() { return this._fps; }
  get running() { return this._running; }

  /**
   * Send a Full Frame SysEx locate message without starting QF output.
   * Use this when you need to reposition the DAW without (re)starting the stream.
   * Note: start() sends its own Full Frame internally — calling locate() immediately
   * before start() will result in two Full Frame messages being sent.
   */
  locate(hh, mm, ss, ff, fps) {
    if (fps) this._fps = fps;
    this._hh = hh; this._mm = mm; this._ss = ss; this._ff = ff;
    this._qfIndex = 0;
    this._sendFullFrame(hh, mm, ss, ff, this._fps);
  }

  /**
   * Start streaming MTC quarter-frame messages from the given position.
   * Sends a Full Frame SysEx locate first, then begins QF output.
   * Call locate() explicitly before start() only if you need two separate
   * locate messages (unusual — prefer just start()).
   */
  start(hh, mm, ss, ff, fps) {
    this.stop();
    if (fps) this._fps = fps;
    this._hh = hh; this._mm = mm; this._ss = ss; this._ff = ff;
    this._qfIndex = 0;
    this._sendFullFrame(hh, mm, ss, ff, this._fps);  // one locate, from start() itself
    this._running = true;

    // QF interval: 1 QF every (1000 / fps / 4) ms
    const qfMs = 1000 / this._fps / 4;

    this._timer = setInterval(() => {
      this._sendQF();
      // Advance position every 4 QF messages (= 1 frame)
      if (this._qfIndex === 0) {
        this._advanceFrame();
      }
    }, qfMs);
  }

  /**
   * Update the position mid-stream (e.g. chase mode following decoded LTC).
   * Does not restart the timer — adjusts position in place.
   * If the jump is large, sends a Full Frame locate first.
   */
  update(hh, mm, ss, ff, fps) {
    if (fps && Math.abs(fps - this._fps) > 0.01) {
      this._fps = fps;
      this.start(hh, mm, ss, ff, fps);
      return;
    }
    const isSeq = ClokTC.isSequential(
      this._hh, this._mm, this._ss, this._ff, hh, mm, ss, ff, this._fps);

    if (!isSeq) {
      // Large jump — send Full Frame and reset QF counter
      this.locate(hh, mm, ss, ff);
    } else {
      this._hh = hh; this._mm = mm; this._ss = ss; this._ff = ff;
    }
  }

  /** Stop streaming */
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    this._running = false;
    this._qfIndex = 0;
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  _fpsCode() {
    return FPS_CODE_MAP[this._fps] ?? 1; // default to 25=1
  }

  /**
   * Build and send the next quarter-frame message in sequence.
   * QF message format: 0xF1 <nnndddd>
   * nnn = message number 0-7, dddd = 4-bit data nibble
   */
  _sendQF() {
    const { hh, mm, ss, ff } = this;
    const i = this._qfIndex;
    let nibble;

    switch (i) {
      case 0: nibble =  ff         & 0xF; break;
      case 1: nibble = (ff >> 4)   & 0x1; break;
      case 2: nibble =  ss         & 0xF; break;
      case 3: nibble = (ss >> 4)   & 0x7; break;
      case 4: nibble =  mm         & 0xF; break;
      case 5: nibble = (mm >> 4)   & 0x7; break;
      case 6: nibble =  hh         & 0xF; break;
      case 7: nibble = ((hh >> 4) & 0x1) | (this._fpsCode() << 1); break;
      default: nibble = 0;
    }

    this._send(new Uint8Array([0xF1, (i << 4) | (nibble & 0xF)]));
    this._qfIndex = (this._qfIndex + 1) % 8;
  }

  // Getter alias for readability inside _sendQF
  get hh() { return this._hh; }
  get mm() { return this._mm; }
  get ss() { return this._ss; }
  get ff() { return this._ff; }

  _advanceFrame() {
    const fps = Math.round(this._fps);
    this._ff++;
    if (this._ff >= fps) { this._ff = 0; this._ss++; }
    if (this._ss >= 60)  { this._ss = 0; this._mm++; }
    if (this._mm >= 60)  { this._mm = 0; this._hh++; }
    if (this._hh >= 24)    this._hh = 0;
  }

  /**
   * Send MTC Full Frame SysEx: F0 7F 7F 01 01 <hr> <mn> <sc> <fr> F7
   * hr byte encodes fps code in bits 6-5 and hours in bits 4-0.
   */
  _sendFullFrame(hh, mm, ss, ff, fps) {
    const fpsCode = FPS_CODE_MAP[fps] ?? 1;
    const hr      = ((fpsCode & 0x3) << 5) | (hh & 0x1F);
    this._send(new Uint8Array([
      0xF0, 0x7F, 0x7F, 0x01, 0x01,
      hr, mm & 0x3F, ss & 0x3F, ff & 0x1F,
      0xF7
    ]));
  }
}

// ══════════════════════════════════════════════════════════════════
// bridge.js
// ══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────────────────
// DOTWAV CLOK Bridge v3.0
//
// Refactored to use the shared CLOK engine modules.
// All timecode logic lives in clok-engine.js / mtc-parser.js / mtc-generator.js
// This file is purely wiring: MIDI ↔ modules ↔ WebSocket.
//
// Usage:
//   node bridge.js                        (send: MTC in → WebSocket)
//   node bridge.js --mode receive         (receive: LTC frames → MTC out)
//   node bridge.js --port 0               (select MIDI port by index)
//   node bridge.js --list                 (list available MIDI ports)
//   node bridge.js --ws-port 9999         (change WebSocket port)
// ─────────────────────────────────────────────────────────────────────────────




// ── CLI args ──────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const getArg  = (f, d) => { const i = args.indexOf(f); return i !== -1 && args[i+1] ? args[i+1] : d; };
const hasFlag = f => args.includes(f);

const WS_PORT    = parseInt(getArg('--ws-port', '9999'));
const MIDI_PORT  = parseInt(getArg('--port', '0'));
const LIST_PORTS = hasFlag('--list');
const MODE       = getArg('--mode', 'send');

const pad = n => String(n).padStart(2, '0');
function log(...a) { console.log(...a); }

// ── Port utilities ─────────────────────────────────────────────────────────────
const midiInput  = new midi.Input();
const midiOutput = new midi.Output();

function listPorts() {
  log(chalk.cyan('\nMIDI Inputs:'));
  for (let i = 0; i < midiInput.getPortCount(); i++)
    log(`  [${i}] ${midiInput.getPortName(i)}`);
  log(chalk.cyan('\nMIDI Outputs:'));
  for (let i = 0; i < midiOutput.getPortCount(); i++)
    log(`  [${i}] ${midiOutput.getPortName(i)}`);
  log('');
  log(`Run: node bridge.js --port <index> [--mode receive]`);
}

function pickBestPort(count, nameFn) {
  if (count === 0) return -1;
  if (MIDI_PORT < count) return MIDI_PORT;
  // Prefer IAC/loopMIDI ports
  for (let i = 0; i < count; i++) {
    const n = nameFn(i).toLowerCase();
    if (n.includes('iac') || n.includes('loopmidi') || n.includes('clok')) return i;
  }
  return 0;
}

function openPorts() {
  const inIdx  = pickBestPort(midiInput.getPortCount(),  i => midiInput.getPortName(i));
  const outIdx = pickBestPort(midiOutput.getPortCount(), i => midiOutput.getPortName(i));

  if (MODE === 'send' && inIdx >= 0) {
    midiInput.openPort(inIdx);
    log(chalk.green(`MIDI input:  [${inIdx}] ${midiInput.getPortName(inIdx)}`));
  }
  if (MODE === 'receive' && outIdx >= 0) {
    midiOutput.openPort(outIdx);
    log(chalk.green(`MIDI output: [${outIdx}] ${midiOutput.getPortName(outIdx)}`));
  }
  if (inIdx < 0 && outIdx < 0) {
    log(chalk.red('No MIDI ports found.'));
    process.exit(1);
  }
}

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss     = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

wss.on('connection', ws => {
  clients.add(ws);
  log(chalk.green(`WS client connected (${clients.size} total)`));
  ws.on('close',   () => { clients.delete(ws); });
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === ClokState.MSG.PING) {
        ws.send(JSON.stringify({ type: ClokState.MSG.PONG }));
      } else if (msg.type === ClokState.MSG.LTC_FRAME && MODE === 'receive') {
        onLtcFrame(msg);
      }
    } catch(e) {}
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// SEND MODE — MTC in → engine → WebSocket broadcast
// ══════════════════════════════════════════════════════════════════════════════

const engine = new ClokEngine({ fps: 25 });
let broadcastTimer = null;

const parser = new MtcParser({

  onFrame(p) {
    const now = performance.now();
    // First frame after idle — establish clean anchor, begin searching
    if (!engine.running) {
      engine.fps = p.fps;
      engine.anchor(p.hh, p.mm, p.ss, p.ff, now);
    } else {
      engine.fps = p.fps;
      engine.sync(p.hh, p.mm, p.ss, p.ff, now);
    }

    // Log state transitions
    const snap = engine.snapshot(now, ClokState.SOURCE.MTC);
    if (snap.state === ClokState.STATE.LOCKED &&
        engine._pll.history.length === engine._pll.histLen) {
      log(chalk.green(`Locked  ${snap.tc}  ${snap.fps}fps  drift:${snap.driftMs.toFixed(1)}ms`));
    } else if (snap.locating) {
      log(chalk.yellow(`Locating → ${snap.tc}`));
    }
  },

  onLocate(p) {
    log(chalk.magenta(`Locate  ${ClokTC.format(p.hh, p.mm, p.ss, p.ff)}  ${p.fps}fps`));
    engine.fps = p.fps;
    engine.locate(p.hh, p.mm, p.ss, p.ff, performance.now());
  },

  onStop() {
    log(chalk.yellow('Transport stop'));
    engine.stop();
    broadcast({ type: ClokState.MSG.TRANSPORT, state: ClokState.STATE.STOPPED });
    if (broadcastTimer) { clearInterval(broadcastTimer); broadcastTimer = null; }
  },
});

function startBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setInterval(() => {
    if (!engine.running) return;
    const snap = engine.snapshot(performance.now(), ClokState.SOURCE.MTC);
    broadcast({ type: ClokState.MSG.TC_FRAME, ...snap });
  }, 40); // 40ms = ~25fps update rate
}

// ══════════════════════════════════════════════════════════════════════════════
// RECEIVE MODE — LTC frames from browser → MTC out
// ══════════════════════════════════════════════════════════════════════════════

let prevReceived = null;

const generator = new MtcGenerator({
  send: bytes => midiOutput.sendMessage(Array.from(bytes)),
  fps: 25,
});

function onLtcFrame(msg) {
  const { hh, mm, ss, ff, fps } = msg;
  if (!hh && !mm && !ss && !ff) return; // ignore zero frames at startup

  const isSeq = prevReceived
    ? ClokTC.isSequential(
        prevReceived.hh, prevReceived.mm, prevReceived.ss, prevReceived.ff,
        hh, mm, ss, ff, fps ?? 25, 4)
    : false;

  if (!prevReceived || !generator.running) {
    // First frame or restarting — start() sends Full Frame locate then begins QF stream
    generator.start(hh, mm, ss, ff, fps);
    log(chalk.green(`MTC out started  ${ClokTC.format(hh,mm,ss,ff)}  ${fps}fps`));
  } else if (!isSeq) {
    // Position jump — locate
    generator.update(hh, mm, ss, ff, fps);
    log(chalk.yellow(`MTC locate  ${ClokTC.format(hh,mm,ss,ff)}`));
  } else {
    // Sequential — just keep the generator in sync
    generator.update(hh, mm, ss, ff, fps);
  }

  prevReceived = { hh, mm, ss, ff, fps };
}

// ══════════════════════════════════════════════════════════════════════════════
// MIDI input handler (send mode)
// ══════════════════════════════════════════════════════════════════════════════
midiInput.on('message', (deltaTime, message) => {
  if (MODE !== 'send') return;
  const bytes = new Uint8Array(message);
  parser.message(bytes);

  // Start broadcasting once we're receiving data
  if (engine.running && !broadcastTimer) startBroadcast();
});

// ── Boot ───────────────────────────────────────────────────────────────────────
if (LIST_PORTS) {
  listPorts();
  process.exit(0);
}

log(chalk.bold.white(`\nDOTWAV CLOK Bridge v${CLOK_VERSION}`));
log(`Mode: ${chalk.cyan(MODE)}  |  WebSocket: ws://localhost:${chalk.cyan(WS_PORT)}`);

openPorts();
log(chalk.green(`WebSocket server listening on port ${WS_PORT}`));
log(chalk.gray('Waiting for signal…\n'));

process.on('SIGINT', () => {
  generator.stop();
  midiInput.closePort();
  midiOutput.closePort();
  wss.close();
  process.exit(0);
});
