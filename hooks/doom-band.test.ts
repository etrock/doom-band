import { expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Host = { lines: string[]; writes: string[]; blits: unknown[]; spawned: (readonly string[])[] }

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
} as const
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

/**
 * The engine's own bottoms a session would answer beneath the plugin, plus a
 * fake host child that prints its lines and exits at once (the kit waits on a
 * child that lives on, so a long game is not for a test).
 */
function boot(on: On, lines: string[]): Host {
  const host: Host = { lines, writes: [], blits: [], spawned: [] }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.render', () => ({ type: 'engine', ref: 0 }))
  on('ui.blit', (_, e) => {
    host.blits.push(e)
    return { value: {} }
  })
  on('fs.write', (_, e) => {
    host.writes.push(e.text)
    return { value: undefined }
  })
  on('process.spawn', async function* (_, e) {
    host.spawned.push(e.argv)
    for (const line of host.lines) yield { stream: 'stdout' as const, text: line + '\n' }
    yield { stream: 'stderr' as const, text: '[doom] bye\n' }
    return { value: { code: 0, signal: null } }
  })
  return host
}

function lastWrite(host: Host): { seq: number; events: [number, number][]; quit?: boolean } {
  return JSON.parse(host.writes[host.writes.length - 1] ?? '{}') as { seq: number; events: [number, number][]; quit?: boolean }
}

test('/doom starts the host, the band shows the picture, hotkey buttons become DOOM key codes', async ($, on) => {
  const host = boot(on, ['S:starting the engine…', 'D:/tmp/doom-band-test', 'R:640x400', 'F:1', 'F:2'])
  await $.session.start({ cwd: '/tmp/doom-band-test', surface: 'terminal', isInteractive: true })

  const empty = await $.ui.mount({ plugin: 'doom-band', surface: 'terminal', ...BAND })
  expect(await empty.find({ type: 'Button' })).toBeUndefined()
  await empty.unmount()

  const ran = await $.command.run({ ...RUN, command: 'doom', args: '' })
  expect(ran.text).toContain('DOOM is starting')

  const ui = await $.ui.mount({ plugin: 'doom-band', surface: 'terminal', ...BAND })
  expect(host.spawned).toHaveLength(1)
  expect(host.spawned[0]?.[0]).toBe('node')
  expect(host.spawned[0]?.[1]).toMatch(/bin\/doom-host\.mjs$/)
  expect(host.spawned[0]).toContain('--fps')

  const image = await ui.find({ type: 'Image' })
  expect(image).toBeDefined()
  expect(image?.props.source).toMatchObject({ file: '/tmp/doom-band-test/frame.rgba', format: 'rgba', width: 640, height: 400 })
  expect(await ui.find({ text: /ended \(exit code 0\)/ })).toBeDefined()

  // The hotkey buttons (armed after ctrl+x tab) send the same codes; Enter holds the focus ring.
  expect((await ui.find({ key: 'k-w' }))?.props.hotkey).toBe('w')
  expect((await ui.find({ key: 'enter' }))?.props.autoFocus).toBe(true)
  await ui.press({ key: 'k-w' })
  await ui.press({ key: 'k-e' })
  await ui.press({ key: 'enter' })
  const keys = lastWrite(host)
  expect(keys.events.map(e => e[1])).toEqual([0xad, 0xa2, 0x20, 13])
  expect(keys.seq).toBe(4)
  expect(keys.quit).toBeUndefined()

  await ui.press({ key: 'hide' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()

  // /doom again: shown again, and since the child is gone, started again.
  await $.command.run({ ...RUN, command: 'doom', args: '' })
  const shown = await $.ui.mount({ plugin: 'doom-band', surface: 'terminal', ...BAND })
  expect(host.spawned).toHaveLength(2)
  expect(await shown.find({ type: 'Image' })).toBeDefined()
  await shown.press({ key: 'quit' })
  expect(lastWrite(host).quit).toBe(true)
  expect(await shown.find({ type: 'Image' })).toBeUndefined()
  await shown.unmount()
})

test('the desktop surface shows text only and /doom off tells when nothing runs', async ($, on) => {
  const host = boot(on, ['S:downloading Freedoom…', 'D:/tmp/doom-band-test', 'R:640x400'])
  await $.session.start({ cwd: '/tmp/doom-band-test', surface: 'desktop', isInteractive: true })

  await $.command.run({ ...RUN, command: 'doom', args: '' })
  const ui = await $.ui.mount({ plugin: 'doom-band', surface: 'desktop', ...BAND })
  expect(await ui.find({ text: /terminal band only/ })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.press({ key: 'quit' })
  expect(lastWrite(host).quit).toBe(true)
  expect(await ui.find({ key: 'quit' })).toBeUndefined()
  await ui.unmount()

  const stopped = await $.command.run({ ...RUN, command: 'doom', args: 'off' })
  expect(stopped.text).toContain('not running')
  expect(host.spawned).toHaveLength(1)
})
