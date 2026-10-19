#!/usr/bin/env node
// doom-band host: runs the doomgeneric engine (Emscripten build from the
// @muhammedaksam/opentui-doom npm package) headless in Node, writes frames to
// a raw RGBA file for the terminal to draw, and reads key events from a JSON
// file the plugin writes. Protocol on stdout, one line each:
//   S:<text>          status for the band
//   D:<dir>           the run directory (keys.json, frame.rgba live there)
//   R:<width>x<height> frame size in pixels
//   F:<n>             frame n is on disk
//   E:<text>          a fatal error
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ENGINE_VERSION = '0.4.0'
const ENGINE_BASE = `https://cdn.jsdelivr.net/npm/@muhammedaksam/opentui-doom@${ENGINE_VERSION}/doom/build/`
const FREEDOOM_ZIP = 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip'
const FREEDOOM_WAD = 'freedoom1.wad'
const SRC_W = 1280
const SRC_H = 800
const SCALE = 2 // 1280x800 -> 640x400
const OUT_W = SRC_W / SCALE
const OUT_H = SRC_H / SCALE
const TICK_MS = 1000 / 35
const KEY_HOLD_MS = 250

const args = parseArgs(process.argv.slice(2))
const cacheDir = args.cache || path.join(os.homedir(), '.cache', 'doom-band')
const fps = Number(args.fps) === 35 ? 35 : 17
const frameEvery = Math.max(1, Math.round(35 / fps))

function parseArgs(list) {
  const out = {}
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i]
    if (a.startsWith('--')) {
      out[a.slice(2)] = list[i + 1] ?? ''
      i += 1
    }
  }
  return out
}

function say(line) {
  process.stdout.write(line + '\n')
}

async function download(url, dest, label) {
  say(`S:downloading ${label}…`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest + '.part', bytes)
  fs.renameSync(dest + '.part', dest)
}

async function ensureEngine() {
  fs.mkdirSync(cacheDir, { recursive: true })
  for (const name of ['doom.js', 'doom.wasm']) {
    const dest = path.join(cacheDir, name)
    if (!fs.existsSync(dest)) await download(ENGINE_BASE + name, dest, `engine (${name})`)
  }
}

async function ensureWad() {
  if (args.wad) {
    if (!fs.existsSync(args.wad)) throw new Error(`IWAD not found: ${args.wad}`)
    return args.wad
  }
  const dest = path.join(cacheDir, FREEDOOM_WAD)
  if (fs.existsSync(dest)) return dest
  const zip = path.join(cacheDir, 'freedoom.zip')
  await download(FREEDOOM_ZIP, zip, 'Freedoom (24 MB, once)')
  say('S:unpacking Freedoom…')
  execFileSync('unzip', ['-j', '-o', '-q', zip, `*/${FREEDOOM_WAD}`, '-d', cacheDir])
  fs.rmSync(zip, { force: true })
  if (!fs.existsSync(dest)) throw new Error('freedoom1.wad missing after unzip')
  return dest
}

async function loadEngine(wadPath) {
  const require = createRequire(import.meta.url)
  const createDoomModule = require(path.join(cacheDir, 'doom.js'))
  const wadBytes = fs.readFileSync(wadPath)
  let memory = null
  const Module = await createDoomModule({
    locateFile: (p) => path.join(cacheDir, p),
    print: (s) => process.stderr.write(`[doom] ${s}\n`),
    printErr: (s) => process.stderr.write(`[doom] ${s}\n`),
    instantiateWasm(imports, ok) {
      const bytes = fs.readFileSync(path.join(cacheDir, 'doom.wasm'))
      WebAssembly.instantiate(bytes, imports).then(({ instance }) => {
        memory = instance.exports.memory
        ok(instance)
      }, (error) => {
        say(`E:wasm: ${error.message}`)
        process.exit(1)
      })
      return {}
    },
    preRun: [
      (M) => {
        M.FS.mkdir('/doom')
        M.FS.writeFile('/doom/doom.wad', wadBytes)
      },
    ],
    initAudio() {},
    shutdownAudio() {},
    playSound() {},
    playMusic() {},
    stopMusic() {},
    setMusicVolume() {},
    quitGame() {
      say('S:DOOM quit')
      process.exit(0)
    },
  })
  const argv = ['doom', '-iwad', '/doom/doom.wad']
  const ptrs = argv.map((a) => {
    const bytes = Buffer.from(a + '\0', 'utf8')
    const p = Module._malloc(bytes.length)
    new Uint8Array(memory.buffer, p, bytes.length).set(bytes)
    return p
  })
  const argvPtr = Module._malloc(ptrs.length * 4)
  ptrs.forEach((p, i) => Module.setValue(argvPtr + i * 4, p, 'i32'))
  Module._doomgeneric_Create(ptrs.length, argvPtr)
  const fbPtr = Module._DG_GetFrameBuffer()
  return { Module, memory, fbPtr }
}

function main() {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doom-band-'))
  const keysPath = path.join(runDir, 'keys.json')
  const framePath = path.join(runDir, 'frame.rgba')
  fs.writeFileSync(keysPath, JSON.stringify({ seq: 0, events: [] }))
  say(`D:${runDir}`)
  return { runDir, keysPath, framePath }
}

async function run() {
  await ensureEngine()
  const wadPath = await ensureWad()
  const { keysPath, framePath } = main()
  say('S:starting the engine…')
  const { Module, memory, fbPtr } = await loadEngine(wadPath)
  say(`R:${OUT_W}x${OUT_H}`)

  const out = Buffer.alloc(OUT_W * OUT_H * 4)
  let frameNo = 0
  let tickNo = 0
  let lastSeq = 0
  let lastKeysMtime = 0
  const holds = new Map()
  const started = Date.now()
  let done = 0

  function pushKey(pressed, key) {
    Module._DG_PushKeyEvent(pressed ? 1 : 0, key & 0xff)
  }

  function pollKeys() {
    let mtime
    try {
      mtime = fs.statSync(keysPath).mtimeMs
    } catch {
      return
    }
    if (mtime === lastKeysMtime) return
    lastKeysMtime = mtime
    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(keysPath, 'utf8'))
    } catch {
      lastKeysMtime = 0 // a half-written file: read it again next tick
      return
    }
    if (parsed && parsed.quit) {
      say('S:stopped')
      process.exit(0)
    }
    const events = Array.isArray(parsed?.events) ? parsed.events : []
    for (const entry of events) {
      if (!Array.isArray(entry) || entry.length < 2) continue
      const [seq, key] = entry
      if (typeof seq !== 'number' || typeof key !== 'number' || seq <= lastSeq) continue
      lastSeq = seq
      const existing = holds.get(key)
      if (existing) clearTimeout(existing)
      else pushKey(true, key)
      holds.set(
        key,
        setTimeout(() => {
          holds.delete(key)
          pushKey(false, key)
        }, KEY_HOLD_MS),
      )
    }
  }

  function writeFrame() {
    const src = new Uint32Array(memory.buffer, fbPtr, SRC_W * SRC_H)
    let o = 0
    for (let y = 0; y < OUT_H; y += 1) {
      let i = y * SCALE * SRC_W
      for (let x = 0; x < OUT_W; x += 1) {
        const v = src[i]
        out[o] = (v >> 16) & 0xff
        out[o + 1] = (v >> 8) & 0xff
        out[o + 2] = v & 0xff
        out[o + 3] = 255
        o += 4
        i += SCALE
      }
    }
    fs.writeFileSync(framePath + '.tmp', out)
    fs.renameSync(framePath + '.tmp', framePath)
    frameNo += 1
    say(`F:${frameNo}`)
  }

  setInterval(() => {
    pollKeys()
    const due = Math.floor((Date.now() - started) / TICK_MS)
    let budget = 3 // catch up at most three ticks per interval
    while (done < due && budget > 0) {
      Module._doomgeneric_Tick()
      done += 1
      budget -= 1
      tickNo += 1
      if (tickNo % frameEvery === 0) writeFrame()
    }
    if (done < due - 35) done = due // more than a second behind: drop it
  }, TICK_MS)
}

run().catch((error) => {
  say(`E:${error && error.message ? error.message : String(error)}`)
  process.exit(1)
})
