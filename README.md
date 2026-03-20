# DOTWAV CLOK — LTC Engine

**Professional SMPTE Linear Timecode in your browser.**

Generate and decode LTC, sync to Pro Tools via MTC, or convert between LTC and MTC — no plugins, no hardware required.

→ **[clok.dotwav.uk](https://clok.dotwav.uk)**

---

## What it does

CLOK has two halves that work independently or together:

**Generator** — produces real biphase mark encoded SMPTE LTC audio at 48kHz via the Web Audio API. Route the output to any audio device on your system, or loop it internally to the decoder.

**Decoder** — decodes LTC from any audio input source. Detects frame rate automatically, displays timecode, logs frame history.

**CLOK Bridge** (`bridge.js`) — a small Node.js server that connects your DAW to the browser app over WebSocket. Runs locally on your machine.

---

## Browser app — no setup required

Open [clok.dotwav.uk](https://clok.dotwav.uk) in Chrome, Safari, Firefox, or Edge and click **Launch CLOK**. No account, no install, no subscription.

The app requires microphone/audio permission the first time you use a physical audio input.

> **Note:** The app must be served over HTTPS (which clok.dotwav.uk is). If you're running it locally from a file, use a local server — `npx serve .` works fine.

---

## CLOK Bridge — local setup

The bridge is needed for two workflows:

1. **Pro Tools → CLOK** (send mode) — receive MTC from Pro Tools and display it in CLOK
2. **LTC → Pro Tools** (receive mode) — decode incoming LTC audio in CLOK and output MTC to your DAW

### Requirements

- Node.js 20 LTS (do not use Node 21+ — native MIDI bindings are not yet compatible)
- Mac: IAC Driver enabled (Audio MIDI Setup → MIDI Studio)
- Windows: [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html) installed with a virtual port

### Install

```bash
git clone https://github.com/dotwav/clok.git
cd clok
npm install
```

### Run — send mode (Pro Tools MTC → CLOK browser)

```bash
node bridge.js
```

In Pro Tools: **Setup → Peripherals → Synchronisation → MTC Out → IAC Driver Bus 1** (or your loopMIDI port).

In CLOK: Decoder → **CLOK Bridge**, hit **Listen**. Play in Pro Tools — locks within a couple of frames.

### Run — receive mode (LTC audio → MTC → DAW)

```bash
node bridge.js --mode receive
```

In CLOK: connect your LTC source to an audio input, hit **Listen** on the decoder. Once locked, open **MTC output → DAW** in the decoder panel, point it at `ws://localhost:9999`, and click **Enable MTC out**.

In your DAW: set MTC input to the IAC Driver / loopMIDI port. The DAW will lock to the incoming LTC.

### Bridge options

```bash
node bridge.js --list                 # list available MIDI ports
node bridge.js --port 2               # use MIDI port by index
node bridge.js --ws-port 9998         # change WebSocket port (default 9999)
node bridge.js --mode receive         # LTC-to-MTC mode
```

---

## Workflows

### Generate LTC from a DAW project

Start the generator, route output to an audio interface channel, connect that channel to your camera, recorder, or timecode reader.

### Sync a DAW to incoming LTC

Connect the LTC source to an audio input → CLOK decoder locks → enable **MTC output → DAW** → DAW chases via MTC.

### MTC → LTC conversion (Pro Tools driving LTC output)

Run `node bridge.js` (send mode) → CLOK decoder locks to Pro Tools via bridge → enable **Chase mode** in the generator panel → generator follows the decoder frame-for-frame → route generator audio output to wherever you need LTC.

### Jam sync

Press **Jam sync to decoded input** to snap the generator's current position to the decoder's position once. The generator then free-runs from that point. Useful for matching a tape machine or camera at the start of a session.

### Chase mode vs jam sync

| | Jam sync | Chase mode |
|---|---|---|
| How it works | One-shot snap | Continuous follow |
| After sync | Generator free-runs | Generator stays slaved |
| Use when | You need a starting point | You need continuous lock |

---

## Frame rates

| Rate | Use case |
|---|---|
| 23.976 | Film / NTSC video |
| 24 | Film |
| 25 | PAL / European broadcast |
| 29.97 DF | NTSC broadcast (drop frame) |
| 30 | American broadcast / audio post |

Frame rate is auto-detected on decode.

---

## Technical notes

- Audio engine: Web Audio API at 48kHz, biphase mark encoding
- Decoder: AudioWorklet-based zero-crossing detector (no ScriptProcessor)
- Bridge: WebSocket on port 9999, MTC quarter-frame messages, Full Frame SysEx on locate
- Single HTML file — no build step, no framework, no dependencies in the browser
- HTTPS required for audio input and AudioWorklet in production

---

## Dependencies (bridge only)

```json
{
  "midi": "^2.0.0",
  "ws": "^8.0.0",
  "chalk": "^4.1.2"
}
```

---

## Roadmap

- [ ] Real-world testing and validation
- [ ] Session presets (save/load generator settings)
- [ ] Timecode log export (CSV)
- [ ] LTC reader for video files (drag and drop)
- [ ] Electron wrapper (direct MIDI access without bridge)
- [ ] CLOK native DAW plugin (AAX / AU / VST3)

---

## Licence

© 2025 Alexander Wilson-Thame / DOTWAV. All rights reserved.

CLOK is proprietary software. You may use it freely for personal and professional purposes. You may not copy, modify, redistribute, or incorporate it into other products without explicit written permission.

See [LICENSE](./LICENSE) for the full terms.

---

## Credits

Built by Alexander Wilson-Thame · DOTWAV  
A DOTWAV Creation — alex@dotwav.uk
