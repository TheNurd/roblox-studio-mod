export type OutLine = { text: string; level: 'error' | 'warn' | 'info' }
export type Change = { path: string; edits: number; time: string; firstFile?: string; lastFile?: string; restored?: string }

declare module 'claude-code' {
  interface PluginState {
    'roblox-studio': { lines: OutLine[]; note: string; active: boolean; changes: Change[] }
  }
}
