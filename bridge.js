#!/usr/bin/env node
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// DOTWAV CLOK Bridge
//
// MODE: send  (default)
//   Reads MIDI Timecode (MTC) from Pro Tools via a virtual MIDI bus
//   and broadcasts frame-accurate TC to CLOK web app over WebSocket.
//
// MODE: receive
//   Listens for decoded LTC frames posted by the CLOK web app over WebSocket
//   and generates MTC quarter-frame messages out to a virtual MIDI port,
//   so Pro Tools (or any DAW) can lock to timecode from a remote LTC source.
//
// Usage:
//   node bridge.js                         (send mode — MTC → WebSocket)
//   node bridge.js --mode receive          (receive mode — LTC frames → MTC out)
//   node bridge.js --port 0                (select MIDI port by index)
//   node bridge.js --list                  (list available MIDI ports)
//   node bridge.js --ws-port 9999          (change WebSocket port, default 9999)
// ─────────────────────────────────────────────────────────────────────────────

const midi      = require('midi');
const WebSocket = require('ws');

// ── Chalk v4 (CommonJS) ──────────────────────────────────────────────────────
let chalk;
try { chalk = require('chalk'); } catch(e) {
  chalk = { green: s=>s, yellow: s=>s, red: s=>s, cyan: s=>s, gray: s=>s,
            magenta: s=>s, bold: { white: s=>s } };
}

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i+1] !== undefined ? args[i+1] : def;
};
const hasFlag = flag => args.includes(flag);

const WS_PORT    = parseInt(getArg('--ws-port', '9999'));
const MIDI_PORT  = parseInt(getArg('--port', '0'));
const LIST_PORTS = hasFlag('--list');
const MODE       = getArg('--mode', 'send'); // 'send' or 'receive'

const pad = n => String(n).padStart(2, '0');
const formatTC = t => `${pad(t.hh)}:${pad(t.mm)}:${pad(t.ss)}:${pad(t.ff)}`;
function log(...a) { console.log(...a); }

// ── FPS table (MTC type codes) ────────────────────────────────────────────────
const FPS_TABLE     = [24, 25, 29.97, 30];
const FPS_CODE      = { 24: 0, 25: 1, 29.97: 2, 30: 3 }; // reverse lookup

// ─────────────────────────────────────────────────────────────────────────────
//  SEND MODE — MTC input → WebSocket broadcast (original behaviour)
// ─────────────────────────────────────────────────────────────────────────────

let tc        = { hh: 0, mm: 0, ss: 0, ff: 0, fps: 25 };
let tcDisplay = { hh: 0, mm: 0, ss: 0, ff: 0, fps: 25 };
let playing    = false;
let lastMTCTime = 0;
let frameCount  = 0;
let syncErrors  = 0;
let locating    = false;
const qf        = new Uint8Array(8);

function onQuarterFrame(data1) {
  const type = (data1 >> 4) & 0x7;
  const val  = data1 & 0xF;
  qf[type]   = val;

  if (type === 7) {
    const fpsCode = (val >> 1) & 0x3;
    tc.fps = FPS_TABLE[fpsCode];
    tc.ff  = (qf[1] & 0x1) << 4 | qf[0];
    tc.ss  = (qf[3] & 0x3) << 4 | qf[2];
    tc.mm  = (qf[5] & 0x3) << 4 | qf[4];
    tc.hh  = (qf[7] & 0x1) << 4 | qf[6];
    tc.ff  = Math.min(tc.ff, Math.round(tc.fps) - 1);
    tc.ss  = Math.min(tc.ss, 59);
    tc.mm  = Math.min(tc.mm, 59);
    tc.hh  = Math.min(tc.hh, 23);
    tcDisplay = advanceFrames({ ...tc }, 2);
    playing    = true;
    locating   = false;
    lastMTCTime = Date.now();
    frameCount++;
    broadcast({ type: 'tc', ...tcDisplay, playing: true, source: 'mtc' });
  }
}

function onFullFrameSysEx(bytes) {
  if (bytes.length < 10) return;
  if (bytes[1] !== 0x7F || bytes[3] !== 0x01 || bytes[4] !== 0x01) return;
  const hrByte = bytes[5];
  const fpsCode = (hrByte >> 5) & 0x3;
  tc.hh  = hrByte & 0x1F;
  tc.mm  = bytes[6] & 0x3F;
  tc.ss  = bytes[7] & 0x3F;
  tc.ff  = bytes[8] & 0x1F;
  tc.fps = FPS_TABLE[fpsCode];
  tcDisplay = { ...tc };
  locating  = true;
  playing   = false;
  broadcast({ type: 'tc', ...tcDisplay, playing: false, source: 'fullframe', locating: true });
  log(chalk.yellow(`⟿  Locate → ${formatTC(tcDisplay)} @ ${tc.fps} fps`));
}

function onMidiStop() {
  playing = false;
  broadcast({ type: 'transport', playing: false });
  log(chalk.yellow('■  Transport stopped'));
}

function advanceFrames(t, n) {
  const fps = Math.round(t.fps);
  t.ff += n;
  if (t.ff >= fps) { t.ff -= fps; t.ss++; }
  if (t.ss >= 60)  { t.ss = 0;   t.mm++; }
  if (t.mm >= 60)  { t.mm = 0;   t.hh++; }
  if (t.hh >= 24)    t.hh = 0;
  return t;
}

// Stale detection
setInterval(() => {
  if (MODE === 'send' && playing && Date.now() - lastMTCTime > 200) {
    playing = false;
    broadcast({ type: 'transport', playing: false });
  }
}, 100);

// ─────────────────────────────────────────────────────────────────────────────
//  RECEIVE MODE — WebSocket LTC frames → MTC quarter-frame output
// ─────────────────────────────────────────────────────────────────────────────

// Quarter-frame generator state
let qfOutput = {
  active:    false,     // currently generating QFs
  hh: 0, mm: 0, ss: 0, ff: 0,
  fps:       25,
  fpsCode:   1,
  qfIndex:   0,         // 0–7, which QF message to send next
  interval:  null,      // the setInterval handle
  lastFrameTime: 0,     // Date.now() when last LTC frame arrived
  prevTC:    null,      // previous TC for sequential-check
};

// Build one MTC quarter-frame byte for the current TC position
// MTC QF data byte = (type << 4) | nibble
// type 0: FF lsn   type 1: FF msn
// type 2: SS lsn   type 3: SS msn
// type 4: MM lsn   type 5: MM msn
// type 6: HH lsn   type 7: (fpsCode << 1) | HH msn
function buildQFByte(index, hh, mm, ss, ff, fpsCode) {
  const nibbles = [
    ff  & 0x0F,                         // type 0: frame  lsn
    (ff  >> 4) & 0x01,                  // type 1: frame  msn
    ss  & 0x0F,                         // type 2: second lsn
    (ss  >> 4) & 0x03,                  // type 3: second msn
    mm  & 0x0F,                         // type 4: minute lsn
    (mm  >> 4) & 0x03,                  // type 5: minute msn
    hh  & 0x0F,                         // type 6: hour   lsn
    ((fpsCode & 0x03) << 1) | ((hh >> 4) & 0x01), // type 7: fps + hour msn
  ];
  return (index << 4) | (nibbles[index] & 0x0F);
}

// Send a Full Frame SysEx for instant locate in the DAW
// F0 7F 7F 01 01 hr mn sc fr F7
// hr byte = (fpsCode << 5) | hh
function sendFullFrame(output, hh, mm, ss, ff, fpsCode) {
  const hr = ((fpsCode & 0x03) << 5) | (hh & 0x1F);
  output.sendMessage([0xF0, 0x7F, 0x7F, 0x01, 0x01, hr, mm & 0x3F, ss & 0x3F, ff & 0x1F, 0xF7]);
  log(chalk.magenta(`⟿  Full Frame SysEx → ${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)} @ ${FPS_TABLE[fpsCode]} fps`));
}

// Check whether a new TC position is sequential (within ~2 frames of expected)
function isSequential(prev, next, fps) {
  if (!prev) return false;
  const toFrames = t => t.hh * 3600 * fps + t.mm * 60 * fps + t.ss * fps + t.ff;
  const diff = toFrames(next) - toFrames(prev);
  return diff >= 0 && diff <= 3; // allow up to 3 frames slip
}

// Called each time the browser posts a decoded LTC frame
function onLTCFrame(msg, output) {
  const { hh, mm, ss, ff, fps } = msg;
  const fpsCode = FPS_CODE[fps] !== undefined ? FPS_CODE[fps] : FPS_CODE[25];
  const fps_r   = Math.round(fps);
  const qfMs    = (1000 / fps) / 8; // ms per quarter-frame

  const newTC = { hh, mm, ss, ff };

  // If this is a locate (non-sequential jump), send Full Frame first
  if (!isSequential(qfOutput.prevTC, newTC, fps_r)) {
    sendFullFrame(output, hh, mm, ss, ff, fpsCode);
    // Reset QF index so we start a fresh 8-message cycle
    qfOutput.qfIndex = 0;
  }

  qfOutput.prevTC = { ...newTC };

  // Update target TC
  qfOutput.hh      = hh;
  qfOutput.mm      = mm;
  qfOutput.ss      = ss;
  qfOutput.ff      = ff;
  qfOutput.fps     = fps;
  qfOutput.fpsCode = fpsCode;
  qfOutput.lastFrameTime = Date.now();

  // Start QF stream if not already running
  if (!qfOutput.active) {
    qfOutput.active = true;
    log(chalk.green(`▶  MTC output started — generating QFs @ ${fps} fps (${qfMs.toFixed(2)}ms/QF)`));
    startQFStream(output, qfMs);
  }

  broadcast({ type: 'tc-echo', hh, mm, ss, ff, fps, playing: true });
}

function startQFStream(output, qfMs) {
  if (qfOutput.interval) clearInterval(qfOutput.interval);

  qfOutput.interval = setInterval(() => {
    // Stale — browser stopped sending frames
    if (Date.now() - qfOutput.lastFrameTime > 500) {
      stopQFStream();
      broadcast({ type: 'transport', playing: false });
      log(chalk.yellow('■  MTC output stopped — no LTC frames received'));
      return;
    }

    const { hh, mm, ss, ff, fpsCode, qfIndex } = qfOutput;
    const byte = buildQFByte(qfIndex, hh, mm, ss, ff, fpsCode);
    output.sendMessage([0xF1, byte]);

    // Advance QF index; after completing type 7, advance the TC by one frame
    qfOutput.qfIndex = (qfIndex + 1) % 8;
    if (qfOutput.qfIndex === 0) {
      // One full cycle done — advance internal TC by 1 frame
      // (the browser will keep sending updated frames to correct drift)
      const fps_r = Math.round(qfOutput.fps);
      qfOutput.ff++;
      if (qfOutput.ff >= fps_r) { qfOutput.ff = 0; qfOutput.ss++; }
      if (qfOutput.ss >= 60)    { qfOutput.ss = 0; qfOutput.mm++; }
      if (qfOutput.mm >= 60)    { qfOutput.mm = 0; qfOutput.hh++; }
      if (qfOutput.hh >= 24)      qfOutput.hh = 0;
    }
  }, Math.round(qfMs));
}

function stopQFStream() {
  if (qfOutput.interval) { clearInterval(qfOutput.interval); qfOutput.interval = null; }
  qfOutput.active  = false;
  qfOutput.prevTC  = null;
  qfOutput.qfIndex = 0;
}

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss     = new WebSocket.Server({ port: WS_PORT });
const clients = new Set();

wss.on('listening', () => {
  log(chalk.green(`◉  WebSocket server listening on ws://localhost:${WS_PORT}`));
});

wss.on('connection', ws => {
  clients.add(ws);
  log(chalk.cyan(`⊕  Client connected (${clients.size} total)`));

  ws.send(JSON.stringify({
    type:    'hello',
    bridge:  'DOTWAV CLOK Bridge v1.1',
    mode:    MODE,
    ...tcDisplay,
    playing,
    fps:     tc.fps,
    source:  MODE === 'send' ? 'mtc' : 'ltc-receive'
  }));

  ws.on('close', () => {
    clients.delete(ws);
    log(chalk.gray(`⊖  Client disconnected (${clients.size} remaining)`));
    // If no clients left in receive mode, stop MTC output
    if (MODE === 'receive' && clients.size === 0) stopQFStream();
  });

  ws.on('error', () => clients.delete(ws));

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', mode: MODE }));
      }
      if (msg.type === 'status') {
        ws.send(JSON.stringify({
          type: 'status', mode: MODE,
          playing, frameCount, syncErrors,
          midiPort: activePortName,
          wsClients: clients.size,
          ...(MODE === 'receive' ? {
            qfActive:  qfOutput.active,
            qfIndex:   qfOutput.qfIndex,
            outTC:     formatTC(qfOutput)
          } : {})
        }));
      }
      // Receive mode: browser posts decoded LTC frames here
      if (msg.type === 'ltc-frame' && MODE === 'receive') {
        onLTCFrame(msg, midiOutput);
      }
    } catch(e) {}
  });
});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(data); } catch(e) { clients.delete(client); }
    }
  }
}

// ── MIDI setup ────────────────────────────────────────────────────────────────
const midiInput  = new midi.Input();
const midiOutput = new midi.Output();
let activePortName = '';

function listPorts() {
  const inCount  = midiInput.getPortCount();
  const outCount = midiOutput.getPortCount();
  if (inCount === 0 && outCount === 0) {
    log(chalk.red('No MIDI ports found.'));
    log(chalk.yellow('Mac: Audio MIDI Setup → MIDI Studio → enable IAC Driver'));
    log(chalk.yellow('Windows: install loopMIDI → create a virtual port'));
    return { inputs: [], outputs: [] };
  }
  const inputs  = Array.from({ length: inCount  }, (_, i) => ({ index: i, name: midiInput.getPortName(i)  }));
  const outputs = Array.from({ length: outCount }, (_, i) => ({ index: i, name: midiOutput.getPortName(i) }));
  return { inputs, outputs };
}

if (LIST_PORTS) {
  const { inputs, outputs } = listPorts();
  log('\nMIDI Inputs:');
  inputs.forEach(p  => log(`  [${p.index}] ${p.name}`));
  log('\nMIDI Outputs:');
  outputs.forEach(p => log(`  [${p.index}] ${p.name}`));
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
    if (inputs.length === 0) {
      log(chalk.red('No MIDI inputs available — retrying in 3s'));
      setTimeout(openPorts, 3000);
      return;
    }
    const idx = pickBestPort(inputs);
    activePortName = inputs[idx].name;
    midiInput.openPort(idx);
    log(chalk.green(`◎  MIDI input  opened: [${idx}] ${activePortName}`));
  }

  if (MODE === 'receive' || MODE === 'both') {
    if (outputs.length === 0) {
      log(chalk.red('No MIDI outputs available — retrying in 3s'));
      setTimeout(openPorts, 3000);
      return;
    }
    const idx = pickBestPort(outputs);
    const outName = outputs[idx].name;
    midiOutput.openPort(idx);
    log(chalk.green(`◎  MIDI output opened: [${idx}] ${outName}`));
    if (!activePortName) activePortName = outName;
  }
}

// Sysex enabled, timing disabled, active sensing ignored
midiInput.ignoreTypes(false, false, true);

midiInput.on('message', (deltaTime, message) => {
  if (MODE === 'receive') return; // ignore MIDI input in receive mode
  const [status, d1] = message;
  if (status === 0xF1)  { onQuarterFrame(d1); return; }
  if (status === 0xF0)  { onFullFrameSysEx(message); return; }
  if (status === 0xFC)  { onMidiStop(); return; }
  if (status === 0xFB)  { playing = true; broadcast({ type: 'transport', playing: true }); }
});

// ── Startup ───────────────────────────────────────────────────────────────────
log('');
log(chalk.bold.white('  DOTWAV CLOK Bridge v1.1'));
log(chalk.gray('  ─────────────────────────────────'));
log(chalk.cyan(`  Mode: ${MODE === 'receive' ? 'RECEIVE  (LTC → MTC out)' : 'SEND  (MTC in → WebSocket)'}`));
log('');

openPorts();

// ── Status ticker ─────────────────────────────────────────────────────────────
let lastDisplayTC = '';
setInterval(() => {
  if (MODE === 'send') {
    const tcStr = formatTC(tcDisplay);
    if (tcStr !== lastDisplayTC && playing) {
      process.stdout.write(`\r  ${chalk.green('▶')}  ${chalk.cyan(tcStr)}  ${chalk.gray(tc.fps + ' fps')}  ${chalk.gray(clients.size + ' client(s)')}  `);
      lastDisplayTC = tcStr;
    } else if (!playing && lastDisplayTC !== 'stopped') {
      process.stdout.write(`\r  ${chalk.yellow('■')}  ${chalk.gray(formatTC(tcDisplay) + '  stopped')}  ${chalk.gray(clients.size + ' client(s)')}     `);
      lastDisplayTC = 'stopped';
    }
  } else {
    const tcStr = formatTC(qfOutput);
    if (qfOutput.active && tcStr !== lastDisplayTC) {
      process.stdout.write(`\r  ${chalk.magenta('●')}  MTC out  ${chalk.cyan(tcStr)}  ${chalk.gray(qfOutput.fps + ' fps')}  QF[${qfOutput.qfIndex}]  ${chalk.gray(clients.size + ' client(s)')}  `);
      lastDisplayTC = tcStr;
    } else if (!qfOutput.active && lastDisplayTC !== 'idle') {
      process.stdout.write(`\r  ${chalk.gray('○')}  Waiting for LTC frames from CLOK…  ${chalk.gray(clients.size + ' client(s)')}     `);
      lastDisplayTC = 'idle';
    }
  }
}, 40);

// ── Graceful shutdown ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  log('\n\n' + chalk.yellow('  Shutting down CLOK Bridge...'));
  stopQFStream();
  midiInput.closePort();
  try { midiOutput.closePort(); } catch(e) {}
  wss.close();
  process.exit(0);
});

process.on('uncaughtException', err => {
  log(chalk.red('\n  Error: ' + err.message));
  if (err.message.includes('midi')) {
    log(chalk.yellow('  Hint: check that your IAC Driver / MIDI port is still available'));
  }
});
