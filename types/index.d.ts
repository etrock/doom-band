/** What the band shows: whether DOOM is on, hidden, its status line and the frame count. */
export type DoomState = {
  isOn: boolean
  isHidden: boolean
  status: string
  frame: number
}

declare module 'claude-code' {
  interface PluginState {
    'doom-band': {
      isOn: boolean
      isHidden: boolean
      status: string
      frame: number
    }
  }
}
