/* ════════════════════════════════════════════════════════════════════════
   DOTWAV CLOK — Web MIDI Module (clok-webmidi.js)
   ────────────────────────────────────────────────────────────────────────
   Drop-in replacement for the bridge.js / WebSocket transport, for browsers
   that support the Web MIDI API (Chrome, Edge, Opera, Firefox 108+).

   This file is self-contained. The ENGINE CORE section below is copied
   verbatim from bridge.js (CLOK_VERSION, ClokTC, ClokState, ClokEngine,
   MtcParser, MtcGenerator) — no logic has been changed, only the trailing
   CommonJS/browser-global export block was removed since this file does
   its own exporting at the bottom. index.html does NOT currently define
   these classes itself (it has its own separate inline decoder logic), so
   no extraction step elsewhere is required — just load this one file.

   If you later split bridge.js into clok-engine.js / mtc-parser.js /
   mtc-generator.js as separate files and load those on the page BEFORE
   this script, the guard near the bottom of the ENGINE CORE section will
   detect the existing globals and skip redefining them, so this file
   keeps working unmodified either way.

   Safari / iOS has no Web MIDI support and none is planned (WebKit team has
   cited device-fingerprinting concerns for years with no roadmap change).
   Feature-detect with ClokWebMIDI.isSupported() and fall back to the
   WebSocket bridge connection path on unsupported browsers.

   Public API (mirrors the shape of connectBridge/connectRxBridge in
   index.html, so wiring this in is a small diff, not a rewrite):

     ClokWebMIDI.isSupported()
     ClokWebMIDI.requestAccess()                  → Promise<boolean>
     ClokWebMIDI.listInputs()  / listOutputs()     → [{id, name}]
     ClokWebMIDI.preferredPortId(ports)            → id | undefined
     ClokWebMIDI.startSend({ inputId, onFrame, onLocate, onStop })
     ClokWebMIDI.stopSend()
     ClokWebMIDI.startReceive({ outputId })
     ClokWebMIDI.stopReceive()
     ClokWebMIDI.pushLtcFrame(hh, mm, ss, ff, fps)   (receive-mode input)
   ════════════════════════════════════════════════════════════════════════ */

(function (global) {
  'use strict';

  // ════════════════════════════════════════════════════════════════════
  // ENGINE CORE — copied verbatim from bridge.js. Nothing in this section
  // knows about MIDI, WebSocket, Web Audio, or the DOM — it's the same
  // environment-agnostic timecode logic bridge.js already runs in Node.
  // Skipped if these globals already exist on the page (e.g. you've
  // split bridge.js into shared files and loaded them first).
  // ════════════════════════════════════════════════════════════════════

  if (!global.ClokTC || !global.ClokState || !global.ClokEngine ||
      !global.MtcParser || !global.MtcGenerator) {

    const CLOK_VERSION = '3.0.0';

    // ── ClokTC — Timecode Maths ──────────────────────────────────────────
    // All pure functions. No state. Safe to call from anywhere.
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
       * Refine a coarse fps detection using the drop-frame flag from a
       * decoded LTC frame. 30fps + DF flag → 29.97DF.
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

    // ── ClokState — Shared vocabulary ────────────────────────────────────
    // Defines the canonical state machine values and the shared payload
    // shape used by both bridge.js and the browser application.
    const ClokState = {

      STATE: {
        IDLE:      'idle',       // not running
        SEARCHING: 'searching',  // running but not yet locked
        LOCKED:    'locked',     // running and tracking cleanly
        LOCATING:  'locating',   // position jump detected, re-acquiring
        STOPPED:   'stopped',    // transport stopped
      },

      SOURCE: {
        LTC:      'ltc',      // decoded from LTC audio
        MTC:      'mtc',      // received via MIDI Timecode
        INTERNAL: 'internal', // free-running generator
        BRIDGE:   'bridge',   // forwarded from CLOK Bridge over WebSocket
      },

      MSG: {
        TC_FRAME:  'tc_frame',
        TRANSPORT: 'transport',
        ENGINE:    'engine',
        DRIFT:     'drift',
        LTC_FRAME: 'ltc-frame',
        PING:      'ping',
        PONG:      'pong',
      },

      /**
       * Factory: build a canonical engine payload. Both bridge.js and the
       * browser always produce this shape when describing the current
       * timecode state.
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
        seqNum     = 0,
        wallMs     = 0,
      } = {}) {
        return {
          tc:   ClokTC.format(hh, mm, ss, ff),
          hh, mm, ss, ff,
          fps,
          df,
          state,
          source,
          playing,
          locating,
          driftMs,
          corrMs,
          seqNum,
          wallMs,
          v: CLOK_VERSION,
        };
      },
    };

    // ── ClokEngine — Wall-clock anchored timecode with PLL drift correction ─
    class ClokEngine {
      constructor({ fps = 25, pll = {} } = {}) {
        this.fps = fps;

        this._anchorMs     = 0;
        this._anchorWall   = 0;
        this._running      = false;
        this._playing      = false;
        this._state        = ClokState.STATE.IDLE;
        this._lastSyncWall = 0;

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

      get fps() { return this._fps; }
      set fps(v) { this._fps = v; }
      get running() { return this._running; }
      get playing() { return this._playing; }
      get state() { return this._state; }
      get driftMs() { return this._pll.driftMs; }
      get corrMs() { return this._pll.corrMs; }
      get lastSyncWall() { return this._lastSyncWall; }

      anchor(hh, mm, ss, ff, wallMs) {
        this._writeAnchor(hh, mm, ss, ff, wallMs);
        this._playing = true;
        this._setState(ClokState.STATE.SEARCHING);
      }

      locate(hh, mm, ss, ff, wallMs) {
        this._writeAnchor(hh, mm, ss, ff, wallMs);
        this._setState(ClokState.STATE.LOCATING);
      }

      sync(hh, mm, ss, ff, wallMs) {
        const fps          = this._fps;
        const msPerFrame   = ClokTC.msPerFrame(fps);
        const incomingMs   = ClokTC.toMs(hh, mm, ss, ff, fps);

        const engineMs     = this._anchorMs + (wallMs - this._anchorWall);
        const driftMs      = engineMs - incomingMs;
        const driftFrames  = Math.abs(driftMs) / msPerFrame;

        this._lastSyncWall = wallMs;

        if (driftFrames > this._pll.snapFrames) {
          this.locate(hh, mm, ss, ff, wallMs);
          return;
        }

        const pll = this._pll;
        pll.history.push(driftMs);
        if (pll.history.length > pll.histLen) pll.history.shift();

        const smoothDrift = pll.history.reduce((a, b) => a + b, 0) / pll.history.length;
        const correction  = Math.max(-pll.maxCorrect,
                             Math.min(pll.maxCorrect, smoothDrift * pll.gain));

        this._anchorWall  += correction;
        pll.driftMs        = smoothDrift;
        pll.corrMs         = correction;

        if (pll.history.length >= pll.histLen &&
            Math.abs(smoothDrift) < msPerFrame * 0.5) {
          this._setState(ClokState.STATE.LOCKED);
        } else if (this._state === ClokState.STATE.LOCATING) {
          this._setState(ClokState.STATE.SEARCHING);
        }
      }

      stop() {
        this._playing        = false;
        this._pll.driftMs    = 0;
        this._pll.corrMs     = 0;
        this._setState(ClokState.STATE.STOPPED);
      }

      idle() {
        this._running        = false;
        this._playing         = false;
        this._pll.history    = [];
        this._pll.driftMs    = 0;
        this._pll.corrMs     = 0;
        this._setState(ClokState.STATE.IDLE);
      }

      now(wallMs) {
        if (!this._running) return { hh: 0, mm: 0, ss: 0, ff: 0 };
        const w  = wallMs ?? this._wallNow();
        const ms = this._anchorMs + (w - this._anchorWall);
        return ClokTC.fromMs(ms, this._fps);
      }

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
        return performance.now();
      }
    }

    // ── MtcParser — Reconstructs full timecode from MTC messages ────────────
    const FPS_TABLE = [24, 25, 29.97, 30];

    class MtcParser {
      constructor({ onFrame = () => {}, onLocate = () => {}, onStop = () => {} } = {}) {
        this._onFrame  = onFrame;
        this._onLocate = onLocate;
        this._onStop   = onStop;

        this._reset();
      }

      message(bytes) {
        const status = bytes[0];

        if (status === 0xF1) {
          this._quarterFrame(bytes[1]);
        } else if (status === 0xF0) {
          this._sysex(bytes);
        } else if (status === 0xFC || status === 0xFA || status === 0xFB) {
          // 0xFC = Stop, 0xFA = Start, 0xFB = Continue
          // Pro Tools often doesn't send 0xFC — stop is inferred from QF silence.
          // But if it does send one of these, treat stop explicitly.
          if (status === 0xFC) this._onStop();
        }
      }

      reset() {
        this._reset();
      }

      _reset() {
        this._qf       = new Uint8Array(8);
        this._qfCount  = 0;
        this._lastQF   = -1;
        this._prevTC   = null;
      }

      _quarterFrame(data1) {
        const msgNum = (data1 >> 4) & 0x7;
        const nibble =  data1       & 0xF;

        // Enforce strict sequence: each QF must follow the previous in order.
        // If we get an out-of-sequence message, reset and start fresh from here.
        // This prevents mixed-frame decodes when QFs are dropped or reordered.
        const expected = (this._lastQF + 1) & 0x7;
        if (this._lastQF !== -1 && msgNum !== expected) {
          // Sequence broken — discard buffer, start accumulating from this message
          this._reset();
        }

        this._qf[msgNum] = nibble;
        this._qfCount++;
        this._lastQF = msgNum;

        // Decode when we receive message 7 and have a full clean sequence of 8
        if (msgNum === 7 && this._qfCount >= 8) {
          this._decodeQF();
          this._qfCount = 0; // require fresh 8 for next decode
        }
      }

      _decodeQF() {
        const q  = this._qf;

        // MTC encodes each TC field split across two QF messages.
        // Even QF = low nibble, odd QF = high bits. Reconstruction is binary,
        // NOT decimal — the high bits are a binary extension of the value,
        // not a BCD tens digit. * 10 is wrong for values >= 16.
        const ff = ((q[1] & 0x1) << 4) | (q[0] & 0xF);  // 0-29
        const ss = ((q[3] & 0x3) << 4) | (q[2] & 0xF);  // 0-59
        const mm = ((q[5] & 0x3) << 4) | (q[4] & 0xF);  // 0-59
        const hh = ((q[7] & 0x1) << 4) | (q[6] & 0xF);  // 0-23

        const fpsCode = (q[7] >> 1) & 0x3;
        const fps     = FPS_TABLE[fpsCode] ?? 25;
        const df      = fpsCode === 2;

        // Sanity check — discard corrupt frames
        if (ff >= Math.ceil(fps) || ss >= 60 || mm >= 60 || hh >= 24) return;

        const isLoc = this._prevTC
          ? !ClokTC.isSequential(
              this._prevTC.hh, this._prevTC.mm, this._prevTC.ss, this._prevTC.ff,
              hh, mm, ss, ff, fps)
          : false;

        const payload = {
          ...(ClokState.payload({
                hh, mm, ss, ff,
                fps, df,
                source:   ClokState.SOURCE.MTC,
                locating: isLoc,
              })),
          rawQF: Array.from(q),
        };

        this._prevTC = { hh, mm, ss, ff };
        this._onFrame(payload);
      }

      _sysex(bytes) {
        // Full Frame SysEx: F0 7F 7F 01 01 <hr> <mn> <sc> <fr> F7
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

        this._reset();

        const payload = {
          ...(ClokState.payload({
                hh, mm, ss, ff,
                fps, df,
                source:   ClokState.SOURCE.MTC,
                locating: true,
              })),
        };

        this._prevTC = { hh, mm, ss, ff };
        this._onLocate(payload);
      }
    }

    // ── MtcGenerator — Generates MTC quarter-frame + Full Frame SysEx ───────
    const FPS_CODE_MAP = { 24: 0, 25: 1, 29.97: 2, 30: 3, 23.976: 0 };

    class MtcGenerator {
      constructor({ send, fps = 25, onEvent = null } = {}) {
        if (typeof send !== 'function') throw new Error('MtcGenerator: send(bytes, when) required');
        // send(bytes, when) — 'when' is a DOMHighResTimeStamp on the same
        // timebase as performance.now(). Passing it through to
        // MIDIOutput.send() lets the browser/OS MIDI layer dispatch each
        // message at the right moment even if our JS thread is busy right
        // then — see _scheduleAhead() below for why this matters.
        this._send   = send;
        this._fps    = fps;
        this._running = false;
        // DIAGNOSTIC HOOK (temporary) — fires on every start/locate/stop/
        // drift/sched-late so we can see from the console what's actually
        // happening instead of guessing. Safe no-op if not provided.
        this._onEvent = typeof onEvent === 'function' ? onEvent : () => {};

        // ── Real-time position anchor ─────────────────────────────────
        // _anchorMs is a ClokTC millisecond value that was true at
        // performance.now() === _anchorTime; the actual "current" position
        // at any later instant is _anchorMs + (now - _anchorTime). This is
        // what update()'s drift check compares against, and what the
        // hh/mm/ss/ff getters report.
        //
        // This is intentionally separate from the scheduler's lookahead
        // state below. Earlier version of this fix advanced a single
        // "confirmed position" as a side effect of filling the QF
        // schedule buffer — but that buffer is deliberately kept ~400ms
        // ahead of real time (see _scheduleAhead), so every real-time-
        // accurate incoming decoded frame looked ~400ms "behind" and
        // tripped the drift threshold almost every call. Tracking the
        // real-time anchor independently of the schedule fixes that.
        this._anchorMs   = 0;
        this._anchorTime = 0;

        // ── Lookahead scheduler state ────────────────────────────────
        // Console logging showed setInterval-per-tick firing 30-80ms late
        // routinely and 200-276ms late under load, against an expected
        // ~10ms cadence — because the same main thread also runs both
        // panels' UI updates and the LTC bit-decode math. No amount of
        // setInterval tuning fixes that; the thread being busy IS the
        // problem. Instead: pre-compute a short run of upcoming QF
        // messages and hand each to Web MIDI with a future timestamp via
        // MIDIOutput.send(data, timestamp) — the browser dispatches them
        // at the right time regardless of what our JS is doing at that
        // instant. We just need a periodic top-up call (itself allowed to
        // be late, as long as it runs before the buffer empties). This
        // state is purely for generating correct QF byte content ahead of
        // time — it does NOT feed the drift comparison or the getters.
        this._schedTimer      = null;
        this._schedHH = 0; this._schedMM = 0; this._schedSS = 0; this._schedFF = 0;
        this._schedQfIndex    = 0;
        this._nextQfTime      = 0;    // performance.now() timebase of next unscheduled QF
        this._lookaheadMs     = 400;  // keep this much runway scheduled at all times
        this._schedIntervalMs = 100;  // how often we try to top the buffer back up
      }

      get fps() { return this._fps; }
      get running() { return this._running; }

      _currentMs() {
        return this._anchorMs + (performance.now() - this._anchorTime);
      }
      get hh() { return ClokTC.fromMs(this._currentMs(), this._fps).hh; }
      get mm() { return ClokTC.fromMs(this._currentMs(), this._fps).mm; }
      get ss() { return ClokTC.fromMs(this._currentMs(), this._fps).ss; }
      get ff() { return ClokTC.fromMs(this._currentMs(), this._fps).ff; }

      start(hh, mm, ss, ff, fps, reason = 'start') {
        this._onEvent({ type: 'start', reason, hh, mm, ss, ff, fps: fps || this._fps, t: performance.now() });
        this.stop('restart');
        if (fps) this._fps = fps;

        const now = performance.now();
        this._anchorMs   = ClokTC.toMs(hh, mm, ss, ff, this._fps);
        this._anchorTime = now;

        this._sendFullFrame(hh, mm, ss, ff, this._fps, now);

        this._schedHH = hh; this._schedMM = mm; this._schedSS = ss; this._schedFF = ff;
        this._schedQfIndex = 0;
        this._nextQfTime = now;
        this._running = true;

        this._scheduleAhead();
        this._schedTimer = setInterval(() => this._scheduleAhead(), this._schedIntervalMs);
      }

      locate(hh, mm, ss, ff, fps, reason = 'locate') {
        this._onEvent({ type: 'locate', reason, hh, mm, ss, ff, fps: fps || this._fps, t: performance.now() });
        if (fps) this._fps = fps;

        const now = performance.now();
        this._anchorMs   = ClokTC.toMs(hh, mm, ss, ff, this._fps);
        this._anchorTime = now;

        this._sendFullFrame(hh, mm, ss, ff, this._fps, now);

        // Re-seed the scheduler from "now". Anything already handed to
        // Web MIDI with a timestamp before this point can't be recalled
        // and will still go out, but everything scheduled from here on
        // reflects the corrected position.
        this._schedHH = hh; this._schedMM = mm; this._schedSS = ss; this._schedFF = ff;
        this._schedQfIndex = 0;
        this._nextQfTime = now;
        this._scheduleAhead();
      }

      update(hh, mm, ss, ff, fps) {
        if (fps && Math.abs(fps - this._fps) > 0.01) {
          this._onEvent({ type: 'fps-mismatch', from: this._fps, to: fps, t: performance.now() });
          this.start(hh, mm, ss, ff, fps, 'fps-mismatch');
          return;
        }
        // Allow incoming frame to be up to 8 frames off the generator's
        // real-time-projected position before treating it as a genuine
        // jump — small jitter either direction is normal and shouldn't
        // trigger a locate.
        const aMs = this._currentMs();
        const bMs = ClokTC.toMs(hh, mm, ss, ff, this._fps);
        const diffFrames = (bMs - aMs) / ClokTC.msPerFrame(this._fps);

        if (diffFrames < -8 || diffFrames > 8) {
          this._onEvent({ type: 'drift', diffFrames, hh, mm, ss, ff, t: performance.now() });
          this.locate(hh, mm, ss, ff, undefined, 'drift');
        } else {
          // In-tolerance: lightly re-sync the anchor to the real decoded
          // position rather than letting error accumulate. This is what
          // naturally absorbs ordinary jitter between the generator and
          // the decoder without ever touching the outgoing QF schedule.
          this._anchorMs   = bMs;
          this._anchorTime = performance.now();
        }
      }

      stop(reason = 'stop') {
        if (this._running || this._schedTimer) {
          this._onEvent({ type: 'stop', reason, t: performance.now() });
        }
        if (this._schedTimer) { clearInterval(this._schedTimer); this._schedTimer = null; }
        this._running = false;
      }

      _fpsCode() {
        return FPS_CODE_MAP[this._fps] ?? 1;
      }

      // Fill the schedule with every QF message due between "now" and
      // "now + lookaheadMs", each carrying its own future timestamp for
      // Web MIDI to honor. Safe to call late or to skip a call entirely —
      // as long as SOME call lands before the runway empties, playback
      // stays gapless regardless of main-thread load at the exact instant
      // a given quarter-frame was technically "due".
      _scheduleAhead() {
        if (!this._running) return;
        const now = performance.now();
        const horizon = now + this._lookaheadMs;
        const qfMs = 1000 / this._fps / 4;

        // If we've fallen behind by more than a full lookahead window,
        // the main thread was starved for longer than we buffered for —
        // distinct from normal operation, worth knowing about explicitly.
        if (this._nextQfTime < now - this._lookaheadMs) {
          this._onEvent({ type: 'sched-late', behindMs: Math.round(now - this._nextQfTime), t: now });
        }

        let scheduled = 0;
        while (this._nextQfTime < horizon) {
          this._sendQFAt(this._nextQfTime);
          this._nextQfTime += qfMs;
          this._schedQfIndex = (this._schedQfIndex + 1) % 8;
          if (this._schedQfIndex === 0) this._advanceSchedFrame();
          if (++scheduled > 2000) break; // safety valve — should never trigger
        }
      }

      _sendQFAt(when) {
        const hh = this._schedHH, mm = this._schedMM, ss = this._schedSS, ff = this._schedFF;
        const i = this._schedQfIndex;
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

        this._send(new Uint8Array([0xF1, (i << 4) | (nibble & 0xF)]), when);
      }

      _advanceSchedFrame() {
        // MTC spec: 4 quarter-frame messages are sent per frame period, and
        // a complete 8-message group (one full timecode value) therefore
        // spans 2 real frame periods. Each new group must represent a frame
        // count 2 HIGHER than the previous one to stay synchronized with
        // real elapsed time — incrementing by 1 here (as this used to)
        // makes the encoded clock run at exactly half real-time speed,
        // which is what was actually causing the repeated relocate/jump
        // behavior all along (confirmed via the drift-event log: diffFrames
        // climbing by ~9-11 every ~1-1.2s is exactly the signature of a
        // clock running at ~half rate before each correction snaps it back).
        const fps = Math.round(this._fps);
        this._schedFF += 2;
        if (this._schedFF >= fps) { this._schedFF -= fps; this._schedSS++; }
        if (this._schedSS >= 60)  { this._schedSS = 0; this._schedMM++; }
        if (this._schedMM >= 60)  { this._schedMM = 0; this._schedHH++; }
        if (this._schedHH >= 24)    this._schedHH = 0;
      }

      _sendFullFrame(hh, mm, ss, ff, fps, when) {
        const fpsCode = FPS_CODE_MAP[fps] ?? 1;
        const hr      = ((fpsCode & 0x3) << 5) | (hh & 0x1F);
        this._send(new Uint8Array([
          0xF0, 0x7F, 0x7F, 0x01, 0x01,
          hr, mm & 0x3F, ss & 0x3F, ff & 0x1F,
          0xF7
        ]), when);
      }
    }

    // Expose as page globals — same names bridge.js's Node bundle uses,
    // so any future code (or console debugging) behaves consistently.
    global.CLOK_VERSION = CLOK_VERSION;
    global.ClokTC        = ClokTC;
    global.ClokState     = ClokState;
    global.ClokEngine    = ClokEngine;
    global.MtcParser     = MtcParser;
    global.MtcGenerator  = MtcGenerator;
  }

  // ════════════════════════════════════════════════════════════════════
  // WEB MIDI LAYER — the actual new code. Everything above this point is
  // the unmodified engine; everything below replaces bridge.js's Node
  // MIDI I/O (require('midi')) with the browser's native Web MIDI API.
  // ════════════════════════════════════════════════════════════════════

  const ClokTC       = global.ClokTC;
  const MtcParser     = global.MtcParser;
  const MtcGenerator  = global.MtcGenerator;

  // ── Module state ────────────────────────────────────────────────────
  let midiAccess   = null;   // MIDIAccess object once granted
  let activeInput  = null;   // currently-open MIDIInput (send mode)
  let activeOutput = null;   // currently-open MIDIOutput (receive mode)
  let parser       = null;   // MtcParser instance for send mode
  let generator    = null;   // MtcGenerator instance for receive mode
  let staleTimer   = null;   // receive-mode no-signal timeout

  // ── Support detection ───────────────────────────────────────────────

  function isSupported() {
    return typeof navigator !== 'undefined' &&
           typeof navigator.requestMIDIAccess === 'function';
  }

  /**
   * Request MIDI access. Must be called from a user gesture (click) in
   * most browsers' permission models — same UX pattern as mic/camera.
   * sysex:true is required because Full Frame locate messages are SysEx.
   * Chrome will show a permission prompt; the choice persists per-origin.
   */
  async function requestAccess() {
    if (!isSupported()) return false;
    try {
      midiAccess = await navigator.requestMIDIAccess({ sysex: true });
      return true;
    } catch (err) {
      console.warn('[ClokWebMIDI] MIDI access denied or unavailable:', err);
      midiAccess = null;
      return false;
    }
  }

  function ensureAccess() {
    if (!midiAccess) {
      throw new Error('[ClokWebMIDI] Call requestAccess() first (must follow a user gesture).');
    }
  }

  // ── Port enumeration ────────────────────────────────────────────────
  // Mirrors bridge.js's pickBestPort() preference for IAC / loopMIDI /
  // CLOK-named ports, surfaced here for UI port pickers.

  function listInputs() {
    ensureAccess();
    return Array.from(midiAccess.inputs.values()).map(p => ({
      id: p.id, name: p.name || '(unnamed input)', manufacturer: p.manufacturer || ''
    }));
  }

  function listOutputs() {
    ensureAccess();
    return Array.from(midiAccess.outputs.values()).map(p => ({
      id: p.id, name: p.name || '(unnamed output)', manufacturer: p.manufacturer || ''
    }));
  }

  function preferredPortId(ports) {
    const match = ports.find(p => /iac|loopmidi|clok/i.test(p.name));
    return (match || ports[0] || {}).id;
  }

  // ── SEND MODE — MTC in (from DAW) → parsed → callbacks ─────────────
  // Direct equivalent of bridge.js's midiInput.on('message', ...) handler
  // feeding parser.message(bytes). No WebSocket hop — runs in the same
  // tab as the UI, so callbacks fire straight into page state.

  let sendStopTimeout = null;
  let sendIsPlaying   = false;

  function startSend({ inputId, onFrame, onLocate, onStop } = {}) {
    ensureAccess();
    stopSend();

    const inputs = listInputs();
    const id = inputId || preferredPortId(inputs);
    activeInput = midiAccess.inputs.get(id);

    if (!activeInput) {
      throw new Error('[ClokWebMIDI] No MIDI input found. Check IAC Driver / loopMIDI is enabled.');
    }

    // Pro Tools often doesn't send 0xFC (Stop) — bridge.js detects stop by
    // QF silence instead, using a 300ms timeout (~7 frames at 25fps, enough
    // to distinguish a genuine stop from normal frame jitter). Mirrored here
    // so Web MIDI send mode has the same stop-detection reliability.
    function armStopTimeout() {
      if (sendStopTimeout) clearTimeout(sendStopTimeout);
      sendStopTimeout = setTimeout(() => {
        if (sendIsPlaying) {
          sendIsPlaying = false;
          onStop && onStop();
        }
        sendStopTimeout = null;
      }, 300);
    }

    parser = new MtcParser({
      onFrame: (payload) => {
        sendIsPlaying = true;
        onFrame && onFrame({ ...payload, playing: true });
      },
      onLocate: (payload) => {
        onLocate && onLocate({ ...payload, playing: sendIsPlaying });
      },
      onStop: () => {
        sendIsPlaying = false;
        onStop && onStop();
      },
    });

    activeInput.onmidimessage = (e) => {
      // e.data is a Uint8Array — identical shape to what bridge.js's
      // midi.Input 'message' event hands to parser.message() already.
      const bytes = e.data;
      parser.message(bytes);

      // Re-arm stop timeout on every incoming QF or SysEx, same as bridge.js
      if (bytes[0] === 0xF1 || bytes[0] === 0xF0) armStopTimeout();
    };

    return { id: activeInput.id, name: activeInput.name };
  }

  function stopSend() {
    if (activeInput) {
      activeInput.onmidimessage = null;
      activeInput = null;
    }
    if (sendStopTimeout) { clearTimeout(sendStopTimeout); sendStopTimeout = null; }
    sendIsPlaying = false;
    parser = null;
  }

  // ── RECEIVE MODE — decoded LTC → MTC out → DAW ──────────────────────
  // Direct equivalent of bridge.js's onLtcFrame()/startQFStream(). Reuses
  // MtcGenerator exactly as-is — output.send(bytes) replaces
  // midiOutput.sendMessage(bytes), same byte arrays either way.
  //
  // NOTE ON STALE_TIMEOUT_MS: bridge.js runs the decode math in a Node
  // process with nothing else competing for its event loop, so 500ms of
  // silence reliably means "the DAW actually stopped". In the browser,
  // pushLtcFrame() is fed from the SAME main JS thread that's also doing
  // the zero-crossing/bit decode (onZCBatch/tryDecode) and repainting both
  // the Generator and Decoder panels — so a harmless ~500ms-1s scheduling
  // hiccup on that thread (GC, layout, tab briefly busy) can starve
  // pushLtcFrame() even while the underlying LTC audio never lost lock.
  // Under the old 500ms value this tripped generator.stop() constantly,
  // which is what caused Pro Tools to intermittently drop chase and
  // relocate back to session Start every 1-2s (confirmed via screen
  // recording: LOCK TIME/FRAMES DEC climbed continuously the whole time
  // — the decoder never lost signal — while Pro Tools' counter cycled).
  //
  // Widening this to 2s gives the main thread enough slack to absorb a
  // brief stall via generator.update()'s existing drift-correction path
  // (which sends a locate but keeps the QF stream running, so Pro Tools
  // never sees silence) instead of tearing the whole stream down. A true
  // stop (decoder actually loses lock, or the user hits Stop) still gets
  // caught, just a couple seconds later than before.
  const STALE_TIMEOUT_MS = 2000;

  function startReceive({ outputId } = {}) {
    ensureAccess();
    stopReceive();

    const outputs = listOutputs();
    const id = outputId || preferredPortId(outputs);
    activeOutput = midiAccess.outputs.get(id);

    if (!activeOutput) {
      throw new Error('[ClokWebMIDI] No MIDI output found. Check IAC Driver / loopMIDI is enabled.');
    }

    generator = new MtcGenerator({
      // 'when' is a performance.now()-timebase DOMHighResTimeStamp from the
      // lookahead scheduler — passing it straight to MIDIOutput.send lets
      // Chrome's MIDI backend dispatch each message at the right time even
      // if our JS thread is busy with something else at that exact instant.
      send: (bytes, when) => activeOutput.send(bytes, when),
      fps: 25,
      // TEMPORARY DIAGNOSTIC LOGGING — remove once we've confirmed the fix.
      // Look in the browser console for [MTC-OUT] lines while reproducing.
      // 'start'/'stop' = full teardown+rebuild of the QF schedule (a real
      // stop, or the fps-mismatch/first-lock case). 'locate' via reason
      // 'drift' = position correction only, schedule keeps running.
      // 'sched-late' = the periodic top-up call itself got delayed by more
      // than a full lookahead window (400ms) — if this shows up, the main
      // thread is starved badly enough that even a 400ms buffer isn't
      // enough runway, which would point at the decode math (onZCBatch/
      // tryDecode) needing to move off the main thread too.
      onEvent: (ev) => {
        if (ev.type === 'sched-late') {
          console.warn('[MTC-OUT] ⚠ SCHED LATE', ev.behindMs + 'ms behind', JSON.stringify(ev));
        } else {
          console.log('[MTC-OUT]', ev.type, ev.reason || '', JSON.stringify(ev));
        }
      },
    });

    return { id: activeOutput.id, name: activeOutput.name };
  }

  function stopReceive() {
    if (generator) { generator.stop(); generator = null; }
    if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
    activeOutput = null;
  }

  /**
   * Feed a decoded LTC frame from CLOK's own audio decoder into the MTC
   * generator. Call this exactly where index.html currently calls
   * postLTCFrame(hh, mm, ss, ff, fps) over WebSocket — same arguments,
   * no WebSocket round-trip.
   */
  function pushLtcFrame(hh, mm, ss, ff, fps) {
    if (!generator) return;

    if (!generator.running) {
      generator.start(hh, mm, ss, ff, fps);
    } else {
      generator.update(hh, mm, ss, ff, fps);
    }

    if (staleTimer) clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      // No LTC frames for 500ms — mirror bridge.js's stopQFStream() behaviour
      if (generator) generator.stop();
    }, STALE_TIMEOUT_MS);
  }

  // ── Public API ───────────────────────────────────────────────────────

  global.ClokWebMIDI = {
    isSupported,
    requestAccess,
    listInputs,
    listOutputs,
    preferredPortId,
    startSend,
    stopSend,
    startReceive,
    stopReceive,
    pushLtcFrame,
  };

})(typeof window !== 'undefined' ? window : globalThis);
