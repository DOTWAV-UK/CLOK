#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// DOTWAV CLOK Bridge v2.0
//
// MODE: send  (default)
//   Reads MIDI Timecode (MTC) from Pro Tools via a virtual MIDI bus.
//   Feeds an authoritative CLOK engine — timecode advances from a
//   wall-clock anchor, not from MTC fragments. No drift, no guessing.
//
// MODE: receive
//   Listens for decoded LTC frames posted by the CLOK web app over WebSocket
//   and generates MTC quarter-frame messages out to a virtual MIDI port.
//
// Usage:
//   node bridge.js                         (send mode  — MTC in → WebSocket)
//   node bridge.js --mode receive          (receive mode — LTC frames → MTC out)
//   node bridge.js --port 0                (select MIDI port by index)
//   node bridge.js --list                  (list available MIDI ports)
//   node bridge.js --ws-port 9999          (change WebSocket port, default 9999)
// ─────────────────────────────────────────────────────────────────────────────

const midi      = require('midi');
const WebSocket = require('ws');

let chalk;
try { chalk = require('chalk'); } catch(e) {
  chalk = { green:s=>s, yellow:s=>s, red:s=>s, cyan:s=>s, gray:s=>s,
            magenta:s=>s, bold:{ white:s=>s } };
}

const args    = process.argv.slice(2);
const getArg  = (flag, def) => { const i = args.indexOf(flag); return i !== -1 && args[i+1] !== undefined ? args[i+1] : def; };
const hasFlag = flag => args.includes(flag);

const WS_PORT    = parseInt(getArg('--ws-port', '9999'));
const MIDI_PORT  = parseInt(getArg('--port', '0'));
const LIST_PORTS = hasFlag('--list');
const MODE       = getArg('--mode', 'send');

const pad      = n => String(n).padStart(2, '0');
const formatTC = t => `${pad(t.hh)}:${pad(t.mm)}:${pad(t.ss)}:${pad(t.ff)}`;
function log(...a) { console.log(...a); }

const FPS_TABLE = [24, 25, 29.97, 30];
const FPS_CODE  = { 24:0, 25:1, 29.97:2, 30:3 };

// =============================================================================
//  CLOK ENGINE — authoritative wall-clock timecode
//
//  MTC delivers a complete TC position once every 2 frames (8 quarter-frames).
//  The old approach patched the received position with advanceFrames(tc, +2) —
//  a fixed guess that accumulated drift whenever QF timing was uneven.
//
//  The CLOK engine instead:
//    1. Records the decoded TC position and the wall-clock instant as an anchor
//    2. On every query, computes current TC = anchor + elapsed_real_time
//    3. MTC re-anchors the engine every 2 frames — correcting any clock skew
//
//  Result: timecode from a single deterministic source, no drift.
// =============================================================================

const clok = {
  // Anchor: TC position + wall-clock instant at last hard sync point
  anchorTC:     { hh:0, mm:0, ss:0, ff:0 },
  anchorTime:   0,       // performance.now() at last anchor

  fps:          25,
  running:      false,
  lastSyncMs:   0,       // Date.now() of last MTC — stale detection

  // PLL state
  // Rather than snapping to each incoming MTC anchor immediately (causing
  // micro-jumps), we measure the error between engine position and MTC
  // position and apply a gentle correction to the engine's effective rate.
  // This smooths out network jitter and uneven QF delivery.
  pll: {
    driftMs:      0,     // current measured drift in ms (engine - MTC)
    correction:   0,     // active rate correction in ms (added to anchorTime)
    gain:         0.15,  // correction aggressiveness (0.1 = slow, 0.3 = fast)
    maxCorrect:   8,     // max ms correction per cycle (prevents overcorrection)
    snapThresh:   2,     // frames — if drift > this, snap immediately (locate)
    history:      [],    // last N drift measurements for smoothing
    histLen:      8,     // number of measurements to average
  },

  // Convert a TC position to total milliseconds from zero
  tcToMs(tc) {
    const fps = tc.fps || this.fps;
    return ((tc.hh * 3600) + (tc.mm * 60) + tc.ss) * 1000 + (tc.ff * (1000 / fps));
  },

  // Called on every QF8 decode. tc is the corrected anchor position.
  // wallTime is performance.now() at the moment QF8 was decoded.
  sync(tc, wallTime) {
    const fps        = tc.fps || this.fps;
    const msPerFrame = 1000 / fps;
    const snapFrames = this.pll.snapThresh;

    if (!this.running) {
      // Engine not yet started — hard anchor, no PLL
      this.anchorTC   = { hh:tc.hh, mm:tc.mm, ss:tc.ss, ff:tc.ff };
      this.anchorTime = wallTime;
      this.fps        = fps;
      this.lastSyncMs = Date.now();
      return;
    }

    // Compute drift: engine position vs incoming MTC position
    const engineMs = this.tcToMs(this.now());
    const mtcMs    = this.tcToMs({ ...tc, fps });
    const rawDrift = engineMs - mtcMs;  // positive = engine ahead, negative = behind

    // If drift exceeds snap threshold, this is a locate — hard snap, reset PLL
    if (Math.abs(rawDrift) > snapFrames * msPerFrame) {
      this.anchorTC       = { hh:tc.hh, mm:tc.mm, ss:tc.ss, ff:tc.ff };
      this.anchorTime     = wallTime;
      this.fps            = fps;
      this.lastSyncMs     = Date.now();
      this.pll.driftMs    = 0;
      this.pll.correction = 0;
      this.pll.history    = [];
      return;
    }

    // PLL: smooth the drift measurement over history window
    const hist = this.pll.history;
    hist.push(rawDrift);
    if (hist.length > this.pll.histLen) hist.shift();
    const smoothDrift = hist.reduce((a, b) => a + b, 0) / hist.length;

    // Compute correction: proportional to smoothed drift, clamped
    const rawCorrection  = smoothDrift * this.pll.gain;
    const clampCorrection = Math.max(-this.pll.maxCorrect, Math.min(this.pll.maxCorrect, rawCorrection));

    // Apply correction by nudging the anchorTime forward or back
    // This shifts the engine's effective position without changing the anchor TC
    this.pll.correction   = clampCorrection;
    this.anchorTime      += clampCorrection;
    this.pll.driftMs      = smoothDrift;
    this.fps              = fps;
    this.lastSyncMs       = Date.now();
  },

  // Hard anchor — used for Full Frame SysEx (locates) and initial start
  setAnchor(tc, wallTime) {
    this.anchorTC       = { hh:tc.hh, mm:tc.mm, ss:tc.ss, ff:tc.ff };
    this.anchorTime     = wallTime;
    this.fps            = tc.fps || 25;
    this.lastSyncMs     = Date.now();
    this.pll.driftMs    = 0;
    this.pll.correction = 0;
    this.pll.history    = [];
  },

  now() {
    if (!this.running) return { ...this.anchorTC, fps: this.fps };
    const elapsed    = performance.now() - this.anchorTime;
    const frameCount = Math.floor(elapsed / (1000 / this.fps));
    return advanceFramesFrom(this.anchorTC, frameCount, this.fps);
  },

  start() { this.running = true; },
  stop()  {
    this.running        = false;
    this.pll.driftMs    = 0;
    this.pll.correction = 0;
    this.pll.history    = [];
  }
};

// Pure: advance a TC value by n frames. Does not mutate input.
function advanceFramesFrom(tc, n, fps) {
  const fpsInt = Math.round(fps);
  let { hh, mm, ss, ff } = tc;
  ff += n;
  const sExtra = Math.floor(ff / fpsInt); ff = ((ff % fpsInt) + fpsInt) % fpsInt;
  ss += sExtra;
  const mExtra = Math.floor(ss / 60); ss = ss % 60;
  mm += mExtra;
  const hExtra = Math.floor(mm / 60); mm = mm % 60;
  hh = (hh + hExtra) % 24;
  return { hh, mm, ss, ff, fps };
}

// =============================================================================
//  SEND MODE — MTC input → CLOK engine → WebSocket
// =============================================================================

let playing    = false;
let locating   = false;
let frameCount = 0;
let syncErrors = 0;
const qf       = new Uint8Array(8);

function onQuarterFrame(data1) {
  const type = (data1 >> 4) & 0x7;
  const val  = data1 & 0xF;
  qf[type]   = val;

  if (type === 7) {
    const fpsCode = (val >> 1) & 0x3;
    const fps     = FPS_TABLE[fpsCode];
    const fpsInt  = Math.round(fps);
    const rawTC = {
      fps,
      ff: Math.min((qf[1] & 0x1) << 4 | qf[0], fpsInt - 1),
      ss: Math.min((qf[3] & 0x3) << 4 | qf[2], 59),
      mm: Math.min((qf[5] & 0x3) << 4 | qf[4], 59),
      hh: Math.min((qf[7] & 0x1) << 4 | qf[6], 23),
    };
    // The 8 QF messages span 2 frames — correct the incoming position by +2,
    // then feed it to the PLL sync. On first call this hard-anchors;
    // on subsequent calls the PLL smooths the correction to eliminate jitter.
    const corrected = advanceFramesFrom(rawTC, 2, fps);
    clok.sync(corrected, performance.now());
    clok.start();
    playing  = true;
    locating = false;
    frameCount++;
    broadcast({ type:'tc', ...clok.now(), playing:true, source:'clok' });
  }
}

function onFullFrameSysEx(bytes) {
  if (bytes.length < 10) return;
  if (bytes[1] !== 0x7F || bytes[3] !== 0x01 || bytes[4] !== 0x01) return;
  const hrByte  = bytes[5];
  const fpsCode = (hrByte >> 5) & 0x3;
  const tc = {
    fps: FPS_TABLE[fpsCode],
    hh:  hrByte & 0x1F,
    mm:  bytes[6] & 0x3F,
    ss:  bytes[7] & 0x3F,
    ff:  bytes[8] & 0x1F,
  };
  clok.setAnchor(tc, performance.now());
  clok.stop();
  locating = true;
  playing  = false;
  broadcast({ type:'tc', ...tc, playing:false, source:'fullframe', locating:true });
  log(chalk.yellow(`\u27BF  Locate \u2192 ${formatTC(tc)} @ ${tc.fps} fps`));
}

function onMidiStop() {
  clok.stop();
  playing = false;
  broadcast({ type:'transport', playing:false });
  log(chalk.yellow('\u25A0  Transport stopped'));
}

// Stale detection — engine stops if no MTC arrives for >200ms
setInterval(() => {
  if (MODE !== 'send' || !playing) return;
  if (Date.now() - clok.lastSyncMs > 200) {
    clok.stop();
    playing = false;
    broadcast({ type:'transport', playing:false });
  }
}, 100);

// Broadcast ticker — sends wall-clock TC to clients at ~25fps
// Clients receive smooth TC driven by the real clock, not MTC event timing.
setInterval(() => {
  if (MODE !== 'send' || !playing) return;
  broadcast({ type:'tc', ...clok.now(), fps:clok.fps, playing:true, source:'clok' });
}, 40);

// =============================================================================
//  RECEIVE MODE — WebSocket LTC frames → MTC quarter-frame output
// =============================================================================

let qfOutput = {
  active:false, hh:0, mm:0, ss:0, ff:0, fps:25, fpsCode:1,
  qfIndex:0, interval:null, lastFrameTime:0, prevTC:null,
};

function buildQFByte(index, hh, mm, ss, ff, fpsCode) {
  const n = [ ff&0x0F, (ff>>4)&0x01, ss&0x0F, (ss>>4)&0x03,
              mm&0x0F, (mm>>4)&0x03, hh&0x0F, ((fpsCode&0x03)<<1)|((hh>>4)&0x01) ];
  return (index << 4) | (n[index] & 0x0F);
}

function sendFullFrame(output, hh, mm, ss, ff, fpsCode) {
  const hr = ((fpsCode & 0x03) << 5) | (hh & 0x1F);
  output.sendMessage([0xF0, 0x7F, 0x7F, 0x01, 0x01, hr, mm&0x3F, ss&0x3F, ff&0x1F, 0xF7]);
  log(chalk.magenta(`\u27BF  Full Frame SysEx \u2192 ${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)} @ ${FPS_TABLE[fpsCode]} fps`));
}

function isSequential(prev, next, fps) {
  if (!prev) return false;
  const f = t => t.hh*3600*fps + t.mm*60*fps + t.ss*fps + t.ff;
  const d = f(next) - f(prev);
  return d >= 0 && d <= 3;
}

function onLTCFrame(msg, output) {
  const { hh, mm, ss, ff, fps } = msg;
  const fpsCode = FPS_CODE[fps] !== undefined ? FPS_CODE[fps] : FPS_CODE[25];
  const fps_r   = Math.round(fps);
  const qfMs    = (1000 / fps) / 8;
  const newTC   = { hh, mm, ss, ff };
  if (!isSequential(qfOutput.prevTC, newTC, fps_r)) {
    sendFullFrame(output, hh, mm, ss, ff, fpsCode);
    qfOutput.qfIndex = 0;
  }
  Object.assign(qfOutput, { hh, mm, ss, ff, fps, fpsCode, lastFrameTime:Date.now(), prevTC:{...newTC} });
  if (!qfOutput.active) {
    qfOutput.active = true;
    log(chalk.green(`\u25B6  MTC output started \u2014 generating QFs @ ${fps} fps (${qfMs.toFixed(2)}ms/QF)`));
    startQFStream(output, qfMs);
  }
  broadcast({ type:'tc-echo', hh, mm, ss, ff, fps, playing:true });
}

function startQFStream(output, qfMs) {
  if (qfOutput.interval) clearInterval(qfOutput.interval);
  qfOutput.interval = setInterval(() => {
    if (Date.now() - qfOutput.lastFrameTime > 500) {
      stopQFStream();
      broadcast({ type:'transport', playing:false });
      log(chalk.yellow('\u25A0  MTC output stopped \u2014 no LTC frames received'));
      return;
    }
    const { hh, mm, ss, ff, fpsCode, qfIndex } = qfOutput;
    output.sendMessage([0xF1, buildQFByte(qfIndex, hh, mm, ss, ff, fpsCode)]);
    qfOutput.qfIndex = (qfIndex + 1) % 8;
    if (qfOutput.qfIndex === 0) {
      const fps_r = Math.round(qfOutput.fps);
      if (++qfOutput.ff >= fps_r) { qfOutput.ff = 0; if (++qfOutput.ss >= 60) { qfOutput.ss = 0; if (++qfOutput.mm >= 60) { qfOutput.mm = 0; if (++qfOutput.hh >= 24) qfOutput.hh = 0; } } }
    }
  }, Math.round(qfMs));
}

function stopQFStream() {
  if (qfOutput.interval) { clearInterval(qfOutput.interval); qfOutput.interval = null; }
  Object.assign(qfOutput, { active:false, prevTC:null, qfIndex:0 });
}

// =============================================================================
//  WebSocket server
// =============================================================================

const wss     = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

wss.on('listening', () => log(chalk.green(`\u25CE  WebSocket server listening on ws://localhost:${WS_PORT}`)));

wss.on('connection', ws => {
  clients.add(ws);
  log(chalk.cyan(`\u2295  Client connected (${clients.size} total)`));
  ws.send(JSON.stringify({ type:'hello', bridge:'DOTWAV CLOK Bridge v2.0', mode:MODE, ...clok.now(), playing, fps:clok.fps, source:MODE==='send'?'clok':'ltc-receive' }));

  ws.on('close', () => {
    clients.delete(ws);
    log(chalk.gray(`\u2296  Client disconnected (${clients.size} remaining)`));
    if (MODE === 'receive' && clients.size === 0) stopQFStream();
  });
  ws.on('error', () => clients.delete(ws));
  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') ws.send(JSON.stringify({ type:'pong', mode:MODE }));
      if (msg.type === 'status') ws.send(JSON.stringify({ type:'status', mode:MODE, playing, frameCount, syncErrors, midiPort:activePortName, wsClients:clients.size, engine:{ running:clok.running, anchorTC:clok.anchorTC, fps:clok.fps, currentTC:clok.now(), pll:{ driftMs:clok.pll.driftMs.toFixed(2), correction:clok.pll.correction.toFixed(2), gain:clok.pll.gain } }, ...(MODE==='receive'?{ qfActive:qfOutput.active, qfIndex:qfOutput.qfIndex, outTC:formatTC(qfOutput) }:{}) }));
      if (msg.type === 'ltc-frame' && MODE === 'receive') onLTCFrame(msg, midiOutput);
    } catch(e) {}
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) { try { client.send(data); } catch(e) { clients.delete(client); } }
  }
}

// =============================================================================
//  MIDI setup
// =============================================================================

const midiInput    = new midi.Input();
const midiOutput   = new midi.Output();
let activePortName = '';

function listPorts() {
  const ic = midiInput.getPortCount(), oc = midiOutput.getPortCount();
  if (!ic && !oc) {
    log(chalk.red('No MIDI ports found.'));
    log(chalk.yellow('Mac: Audio MIDI Setup \u2192 MIDI Studio \u2192 enable IAC Driver'));
    log(chalk.yellow('Windows: install loopMIDI \u2192 create a virtual port'));
    return { inputs:[], outputs:[] };
  }
  return {
    inputs:  Array.from({ length:ic }, (_,i) => ({ index:i, name:midiInput.getPortName(i) })),
    outputs: Array.from({ length:oc }, (_,i) => ({ index:i, name:midiOutput.getPortName(i) })),
  };
}

if (LIST_PORTS) {
  const { inputs, outputs } = listPorts();
  log('\nMIDI Inputs:');  inputs.forEach(p  => log(`  [${p.index}] ${p.name}`));
  log('\nMIDI Outputs:'); outputs.forEach(p => log(`  [${p.index}] ${p.name}`));
  log('\nRun: node bridge.js --port <index> [--mode receive]\n');
  process.exit(0);
}

function pickBestPort(ports) {
  if (hasFlag('--port')) return Math.min(MIDI_PORT, ports.length - 1);
  const iac = ports.findIndex(p => /iac|loopmidi|clok|bus/i.test(p.name));
  return iac !== -1 ? iac : 0;
}

function openPorts() {
  const { inputs, outputs } = listPorts();
  if (MODE === 'send' || MODE === 'both') {
    if (!inputs.length) { log(chalk.red('No MIDI inputs — retrying in 3s')); setTimeout(openPorts, 3000); return; }
    const idx = pickBestPort(inputs); activePortName = inputs[idx].name;
    midiInput.openPort(idx);
    log(chalk.green(`\u25CE  MIDI input  opened: [${idx}] ${activePortName}`));
  }
  if (MODE === 'receive' || MODE === 'both') {
    if (!outputs.length) { log(chalk.red('No MIDI outputs — retrying in 3s')); setTimeout(openPorts, 3000); return; }
    const idx = pickBestPort(outputs); const outName = outputs[idx].name;
    midiOutput.openPort(idx);
    log(chalk.green(`\u25CE  MIDI output opened: [${idx}] ${outName}`));
    if (!activePortName) activePortName = outName;
  }
}

midiInput.ignoreTypes(false, false, true);
midiInput.on('message', (dt, message) => {
  if (MODE === 'receive') return;
  const [status, d1] = message;
  if (status === 0xF1) { onQuarterFrame(d1);        return; }
  if (status === 0xF0) { onFullFrameSysEx(message); return; }
  if (status === 0xFC) { onMidiStop();               return; }
  if (status === 0xFB) { clok.start(); playing = true; broadcast({ type:'transport', playing:true }); }
});

// =============================================================================
//  Startup
// =============================================================================
log('');
log(chalk.bold.white('  DOTWAV CLOK Bridge v2.0'));
log(chalk.gray('  ─────────────────────────────────'));
log(chalk.cyan(`  Mode: ${MODE === 'receive' ? 'RECEIVE  (LTC \u2192 MTC out)' : 'SEND  (MTC in \u2192 WebSocket)'}`));
log(chalk.gray('  Engine: wall-clock anchored (no drift)'));
log('');

openPorts();

let lastDisplayTC = '';
setInterval(() => {
  if (MODE === 'send') {
    const tcStr = formatTC(clok.now());
    if (playing && tcStr !== lastDisplayTC) {
      const driftStr = Math.abs(clok.pll.driftMs) > 0.5 ? chalk.yellow(` drift:${clok.pll.driftMs.toFixed(1)}ms`) : chalk.gray(' locked');
      process.stdout.write(`\r  ${chalk.green('\u25B6')}  ${chalk.cyan(tcStr)}  ${chalk.gray(clok.fps + ' fps')}${driftStr}  ${chalk.gray(clients.size + ' client(s)')}  `);
      lastDisplayTC = tcStr;
    } else if (!playing && lastDisplayTC !== 'stopped') {
      process.stdout.write(`\r  ${chalk.yellow('\u25A0')}  ${chalk.gray(formatTC(clok.anchorTC) + '  stopped')}  ${chalk.gray(clients.size + ' client(s)')}     `);
      lastDisplayTC = 'stopped';
    }
  } else {
    const tcStr = formatTC(qfOutput);
    if (qfOutput.active && tcStr !== lastDisplayTC) {
      process.stdout.write(`\r  ${chalk.magenta('\u25CF')}  MTC out  ${chalk.cyan(tcStr)}  ${chalk.gray(qfOutput.fps + ' fps')}  QF[${qfOutput.qfIndex}]  ${chalk.gray(clients.size + ' client(s)')}  `);
      lastDisplayTC = tcStr;
    } else if (!qfOutput.active && lastDisplayTC !== 'idle') {
      process.stdout.write(`\r  ${chalk.gray('\u25CB')}  Waiting for LTC frames from CLOK\u2026  ${chalk.gray(clients.size + ' client(s)')}     `);
      lastDisplayTC = 'idle';
    }
  }
}, 40);

process.on('SIGINT', () => {
  log('\n\n' + chalk.yellow('  Shutting down CLOK Bridge...'));
  stopQFStream(); midiInput.closePort(); try { midiOutput.closePort(); } catch(e) {} wss.close(); process.exit(0);
});

process.on('uncaughtException', err => {
  log(chalk.red('\n  Error: ' + err.message));
  if (err.message.includes('midi')) log(chalk.yellow('  Hint: check that your IAC Driver / MIDI port is still available'));
});
