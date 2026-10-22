import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

const isOn = atom({ plugin: 'doom-band', key: 'isOn' } as const, false)
const isHidden = atom({ plugin: 'doom-band', key: 'isHidden' } as const, false)
const status = atom({ plugin: 'doom-band', key: 'status' } as const, '')
const frame = atom({ plugin: 'doom-band', key: 'frame' } as const, 0)

// doomkeys.h
const KEY_STRAFE_L = 0xa0
const KEY_STRAFE_R = 0xa1
const KEY_USE = 0xa2
const KEY_FIRE = 0xa3
const KEY_LEFT = 0xac
const KEY_UP = 0xad
const KEY_RIGHT = 0xae
const KEY_DOWN = 0xaf
const KEY_ENTER = 13
const KEY_ESCAPE = 27
const KEY_TAB = 9

type Context = {
  wad: string
  fps: string
  running: boolean
  quitRequested: boolean
  visible: boolean
  requestId: string | null
  keysPath: string | null
  framePath: string | null
  width: number
  height: number
  frameNo: number
  seq: number
  events: [number, number][]
}

const ctx: Context = {
  wad: '',
  fps: '17',
  running: false,
  quitRequested: false,
  visible: false,
  requestId: null,
  keysPath: null,
  framePath: null,
  width: 640,
  height: 400,
  frameNo: 0,
  seq: 0,
  events: [],
}

/** Queues DOOM key codes for the host and writes them out. */
async function sendKeys($: EngineInterface, codes: number[]): Promise<void> {
  if (codes.length === 0 || !ctx.keysPath) return
  for (const code of codes) {
    ctx.seq += 1
    ctx.events.push([ctx.seq, code])
  }
  ctx.events = ctx.events.slice(-64)
  await writeKeys($)
}

/**
 * The band's hotkey buttons: one lowercase letter each, armed while the band holds
 * the keyboard (ctrl+x tab). `cols` is the label's width in cells (an emoji is 2).
 */
type Hotkey = { hotkey: string; label: string; cols: number; codes: number[] }
const MOVE_KEYS: Hotkey[] = [
  { hotkey: 'w', label: '↑', cols: 1, codes: [KEY_UP] },
  { hotkey: 's', label: '↓', cols: 1, codes: [KEY_DOWN] },
  { hotkey: 'a', label: '←', cols: 1, codes: [KEY_LEFT] },
  { hotkey: 'd', label: '→', cols: 1, codes: [KEY_RIGHT] },
  { hotkey: 'z', label: '⇐', cols: 1, codes: [KEY_STRAFE_L, 0x2c] },
  { hotkey: 'c', label: '⇒', cols: 1, codes: [KEY_STRAFE_R, 0x2e] },
]
const ACTION_KEYS: Hotkey[] = [
  { hotkey: 'f', label: '🔫', cols: 2, codes: [KEY_FIRE] },
  { hotkey: 'e', label: '✋', cols: 2, codes: [KEY_USE, 0x20] },
  { hotkey: 'm', label: '☰', cols: 1, codes: [KEY_ESCAPE] },
  { hotkey: 't', label: '🧭', cols: 2, codes: [KEY_TAB] },
  { hotkey: 'y', label: '✅', cols: 2, codes: [0x79] },
  { hotkey: 'n', label: '❌', cols: 2, codes: [0x6e] },
]
/** A plain hotkey button draws as `w: label`: three cells and the label. */
const hotkeyWidth = (keys: Hotkey[]) => keys.reduce((sum, k) => sum + 3 + k.cols, 0) + (keys.length - 1)
const ENTER_WIDTH = '[ ⏎ Enter ]'.length
const HIDE_WIDTH = '[ Hide ]'.length
const QUIT_WIDTH = '[ Quit ]'.length
/** The side columns beside the picture: movement keys left, everything else right. */
const LEFT_WIDTH = Math.max(...MOVE_KEYS.map(k => 3 + k.cols))
const RIGHT_WIDTH = Math.max(...ACTION_KEYS.map(k => 3 + k.cols), ENTER_WIDTH, HIDE_WIDTH, QUIT_WIDTH)
/** Action keys, a blank, Enter, Hide, Quit. */
const RIGHT_ROWS = ACTION_KEYS.length + 4

async function writeKeys($: EngineInterface, extra: { quit?: true } = {}): Promise<void> {
  if (!ctx.keysPath) return
  await $.fs.write(ctx.keysPath, JSON.stringify({ seq: ctx.seq, events: ctx.events, ...extra }))
}

async function handleLine($: EngineInterface, line: string): Promise<void> {
  const kind = line.slice(0, 2)
  const rest = line.slice(2)
  if (kind === 'S:') {
    await update($, status, () => rest)
    $.ui.status(`👹 DOOM: ${rest}`)
  } else if (kind === 'D:') {
    ctx.keysPath = `${rest}/keys.json`
    ctx.framePath = `${rest}/frame.rgba`
  } else if (kind === 'R:') {
    const [w, h] = rest.split('x').map(Number)
    if (w && h) {
      ctx.width = w
      ctx.height = h
    }
  } else if (kind === 'F:') {
    ctx.frameNo = Number(rest) || ctx.frameNo + 1
    if ((await read($, frame)) === 0) {
      $.ui.status(undefined)
      await update($, frame, () => ctx.frameNo)
    } else if (ctx.visible && ctx.requestId && ctx.framePath) {
      await $.ui.blit({
        requestId: ctx.requestId,
        key: 'doom',
        source: { file: ctx.framePath, format: 'rgba', width: ctx.width, height: ctx.height, generation: ctx.frameNo },
      })
    }
  } else if (kind === 'E:') {
    $.ui.toast(`👹 DOOM failed: ${rest}`)
    await update($, status, () => `failed: ${rest}`)
  }
}

async function runHost($: EngineInterface): Promise<void> {
  ctx.running = true
  ctx.quitRequested = false
  ctx.frameNo = 0
  ctx.keysPath = null
  ctx.framePath = null
  let buffer = ''
  let ended: { code: number | null; signal: string | null } | null = null
  try {
    const child = $.process.spawn({
      argv: ['node', `${$.plugin.root}/bin/doom-host.mjs`, '--wad', ctx.wad, '--fps', ctx.fps],
    })
    await update($, frame, () => 0)
    await update($, status, () => 'starting…')
    for (;;) {
      const step = await child.next()
      if (step.done) {
        ended = step.value
        break
      }
      const { stream, text } = step.value
      if (stream === 'stderr') {
        $.ui.log(text.trimEnd(), { to: 'debug' })
        continue
      }
      buffer += text
      let at = buffer.indexOf('\n')
      while (at !== -1) {
        await handleLine($, buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf('\n')
      }
      if (ctx.quitRequested) break
    }
  } catch (error) {
    $.ui.toast(`👹 DOOM could not start: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    ctx.running = false
    try {
      $.ui.status(undefined)
      if (!ctx.quitRequested && (await read($, isOn))) {
        // The child went away on its own: keep the last picture, say why, /doom restarts it.
        const why = ended ? (ended.signal ? `signal ${ended.signal}` : `exit code ${ended.code}`) : 'stream closed'
        await update($, status, () => `ended (${why}) · /doom restarts it`)
        $.ui.toast(`👹 DOOM ended (${why})`)
      }
    } catch {
      /* the module is already unloading: nothing left to tell */
    }
  }
}

async function stopHost($: EngineInterface): Promise<void> {
  ctx.quitRequested = true
  await update($, isOn, () => false)
  await writeKeys($, { quit: true })
}

export const register: Register = (on, options) => {
  ctx.wad = String(options.wad ?? '')
  ctx.fps = String(options.fps ?? '17')

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'doom',
      description: 'DOOM in the band above the prompt (/doom to start or show, /doom off to stop)',
      argumentHint: '[off]',
    })
    if ((await read($, isOn)) && !ctx.running) {
      void runHost($)
    }
    return next(e)
  })

  on('command.run', { command: 'doom' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off' || arg === 'stop' || arg === 'quit') {
      if (!ctx.running) return { text: '👹 DOOM is not running.' }
      await stopHost($)
      return { text: '👹 DOOM stopped.' }
    }
    await update($, isOn, () => true)
    await update($, isHidden, () => false)
    if (ctx.running) return { text: '👹 DOOM is back in the band above the prompt.' }
    void runHost($)
    return {
      text: '👹 DOOM is starting in the band above the prompt. The first start downloads the engine and Freedoom (about 25 MB). Press ctrl+x tab to give DOOM the keys; Esc gives them back.',
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const enabled = await read($, isOn)
    const hidden = await read($, isHidden)
    if (!enabled || hidden || e.props.hasSurvey) {
      ctx.visible = false
      return next(e)
    }
    ctx.visible = true
    ctx.requestId = e.requestId
    const text = await read($, status)
    const hasFrame = (await read($, frame)) > 0

    const onHide = () => update($, isHidden, () => true)
    const onQuit = () => stopHost($)

    if (e.surface !== 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="warning" borderDimColor paddingX={1}>
          <Text>
            <Text color="warning" bold>
              👹 DOOM
            </Text>
            <Text dimColor> · runs in the terminal band only ({text})</Text>
          </Text>
          <Box>
            <Button key="hide" hotkey="x" label="Hide" dimColor onPress={onHide} />
            <Text> </Text>
            <Button key="quit" label="Quit" dimColor onPress={onQuit} />
          </Box>
        </Box>
      )
    }

    const { Box, Text, Button, Image } = $.ui.resolve(e)
    const button = (entry: Hotkey) => (
      <Button key={`k-${entry.hotkey}`} hotkey={entry.hotkey} plain label={entry.label} onPress={() => sendKeys($, entry.codes)} />
    )
    const enter = <Button key="enter" autoFocus label="⏎ Enter" onPress={() => sendKeys($, [KEY_ENTER])} />
    const hide = <Button key="hide" hotkey="x" label="Hide" dimColor onPress={onHide} />
    const quit = <Button key="quit" label="Quit" dimColor onPress={onQuit} />
    const inner = Math.max(20, e.props.bodyColumns - 4)
    // The flex centring cuts hotkey labels short, so the rows are centred by hand.
    const pad = (width: number) => ' '.repeat(Math.max(0, Math.floor((inner - width) / 2)))
    const headerWidth = '👹 DOOM · ctrl+x tab gives DOOM the keys, Esc gives them back'.length + 1
    const header = (
      <Box>
        <Text>{pad(headerWidth)}</Text>
        <Text color="warning" bold>
          👹 DOOM
        </Text>
        {(!hasFrame || !ctx.running) && <Text dimColor> · {text}</Text>}
        <Text dimColor> · ctrl+x tab gives DOOM the keys, Esc gives them back</Text>
      </Box>
    )

    if (!hasFrame || !ctx.framePath) {
      // No picture yet: every button on one row under the header.
      const spaced = (keys: Hotkey[], prefix: string) =>
        keys.flatMap((entry, index) => (index === 0 ? [button(entry)] : [<Text key={`${prefix}${index}`}> </Text>, button(entry)]))
      const rowWidth = hotkeyWidth(MOVE_KEYS) + 2 + hotkeyWidth(ACTION_KEYS) + 2 + ENTER_WIDTH + 2 + HIDE_WIDTH + 1 + QUIT_WIDTH
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="warning" borderDimColor paddingX={1}>
          {header}
          <Box>
            <Text>{pad(rowWidth)}</Text>
            {spaced(MOVE_KEYS, 'sp')}
            <Text>  </Text>
            {spaced(ACTION_KEYS, 'sq')}
            <Text>  </Text>
            {enter}
            <Text>  </Text>
            {hide}
            <Text> </Text>
            {quit}
          </Box>
        </Box>
      )
    }

    // Movement keys down the left side, the rest down the right, the picture between:
    // header + picture + the border = picture rows + 3. The right column needs RIGHT_ROWS rows.
    const rows = Math.max(RIGHT_ROWS, Math.min(e.props.maxRows - 3, 40))
    const room = inner - LEFT_WIDTH - RIGHT_WIDTH - 2
    const columns = Math.max(16, Math.min(room, Math.round(rows * 3.2)))
    const column = (key: string, width: number, items: RenderChildren[]) => {
      const top = Math.max(0, Math.floor((rows - items.length) / 2))
      return (
        <Box key={key} flexDirection="column" width={width}>
          {Array.from({ length: top }, (_, i) => (
            <Text key={`${key}-${i}`}> </Text>
          ))}
          {items}
        </Box>
      )
    }
    const left = column('left', LEFT_WIDTH, MOVE_KEYS.map(button))
    const right = column('right', RIGHT_WIDTH, [...ACTION_KEYS.map(button), <Text key="gap"> </Text>, enter, hide, quit])

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="warning" borderDimColor paddingX={1}>
        {header}
        <Box>
          <Text>{pad(LEFT_WIDTH + 1 + columns + 1 + RIGHT_WIDTH)}</Text>
          {left}
          <Text> </Text>
          <Image
            key="doom"
            source={{ file: ctx.framePath, format: 'rgba', width: ctx.width, height: ctx.height, generation: ctx.frameNo }}
            columns={columns}
            rows={rows}
            alt="DOOM is running, but this terminal cannot show pictures (kitty graphics: Ghostty, kitty)."
          />
          <Text> </Text>
          {right}
        </Box>
      </Box>
    )
  })
}
