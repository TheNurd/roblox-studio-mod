import { test, expect, mock } from 'claude-code/testing'

const S = 'mcp__Roblox_Studio__'
function world(on: any, logs: string[] = []) {
  mock.store(on)
  on('session.cwd', async () => ({ value: '/proj' }))
  for (const ev of ['ui.status', 'ui.toast', 'ui.log']) on(ev, async (_$: any, e: any) => { logs.push(JSON.stringify(e)); return { value: undefined } })
}
async function enable($: any) {
  await $.command.run({ command: 'roblox', args: '' })
}
const text = (t: string) => ({ value: { content: [{ type: 'text', text: t }], isError: false } }) as any

test('blocks DataStore writes from execute_luau', async ($, on) => {
  world(on)
  on('tool.call', async () => ({ result: 'ran' }))
  await enable($)
  const r: any = await $.tool.call({ tool: S + 'execute_luau', code: 'store:SetAsync("k", 1)', datamodel_type: 'Server' } as any)
  expect(String(r.deny)).toContain('DataStores')
})

test('blocks clearing the whole workspace', async ($, on) => {
  world(on)
  on('tool.call', async () => ({ result: 'ran' }))
  await enable($)
  const r: any = await $.tool.call({ tool: S + 'execute_luau', code: 'workspace:ClearAllChildren()', datamodel_type: 'Edit' } as any)
  expect(String(r.deny)).toContain('clear all children')
})

test('lets normal Luau and non-Roblox tools through', async ($, on) => {
  world(on)
  on('tool.call', async () => ({ result: 'ran' }))
  await enable($)
  const a: any = await $.tool.call({ tool: S + 'execute_luau', code: 'print(1)', datamodel_type: 'Edit' } as any)
  const b: any = await $.tool.call({ tool: 'Bash', command: 'echo SetAsync' } as any)
  expect(a.deny).toBeUndefined()
  expect(b.deny).toBeUndefined()
})

test('backs up a script before Claude edits it', async ($, on) => {
  world(on)
  mock.clock(on)
  const written: { path: string; text: string }[] = []
  on('mcp.call', async (_$, e: any) =>
    e.tool === 'script_read' ? text('1 | local x = 1\n2 | print(x)') : text('ok'))
  on('fs.write', async (_$, e: any) => { written.push({ path: e.path, text: e.text }); return { value: undefined } as any })
  on('tool.call', async () => ({ result: 'edited' }))

  await enable($)
  await $.tool.call({ tool: S + 'multi_edit', studio_id: 'abc', path: 'game.ServerScriptService.Main', edits: [] } as any)

  expect(written.length).toBe(1)
  expect(written[0]!.path).toContain('.roblox-backups/game.ServerScriptService.Main/')
  expect(written[0]!.text).toBe('local x = 1\nprint(x)')
})

test('auto-playtest hands new errors to Claude', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  on('fs.write', async () => ({ value: undefined }) as any)
  let consoleText = 'old line'
  const calls: string[] = []
  const prompts: string[] = []
  on('mcp.call', async (_$, e: any) => {
    calls.push(e.tool + ':' + JSON.stringify(e.args))
    if (e.tool === 'get_console_output') return text(consoleText)
    if (e.tool === 'start_stop_play' && e.args.mode === 'start_play') consoleText += '\nServerScriptService.Main:4: attempt to index nil with Name'
    return text('ok')
  })
  on('prompt.submit', async (_$, e: any) => { prompts.push(e.text); return { drop: 'captured' } as any })
  on('tool.call', async () => ({ result: 'edited' }))
  on('turn.complete', async () => ({ text: '' }) as any)

  await enable($)
  await $.tool.call({ tool: S + 'multi_edit', studio_id: 'abc', path: 'game.ServerScriptService.Main', edits: [] } as any)
  await ($ as any).turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10_000)

  expect(calls.some(c => c.startsWith('start_stop_play') && c.includes('start_play'))).toBe(true)
  expect(calls.some(c => c.startsWith('start_stop_play') && c.includes('"stop"'))).toBe(true)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).toContain('attempt to index nil')
})

const edit = (new_string: string, old_string = 'x') =>
  ({ tool: S + 'multi_edit', studio_id: 'abc', path: 'game.ServerScriptService.Main', edits: [{ old_string, new_string }] }) as any

test('blocks edits that add deprecated APIs', async ($, on) => {
  world(on)
  mock.clock(on)
  on('mcp.call', async () => text('ok'))
  on('fs.write', async () => ({ value: undefined }) as any)
  on('tool.call', async () => ({ result: 'edited' }))
  await enable($)
  const bad: any = await $.tool.call(edit('wait(1)\nspawn(f)'))
  expect(String(bad.deny)).toContain('task.wait()')
  const ok: any = await $.tool.call(edit('task.wait(1) -- not wait(1)\nhum.Died:Wait()', 'wait(1)'))
  expect(ok.deny).toBeUndefined()
})

test('flags remote handlers without validation', async ($, on) => {
  world(on)
  mock.clock(on)
  on('mcp.call', async () => text('ok'))
  on('fs.write', async () => ({ value: undefined }) as any)
  on('tool.call', async () => ({ result: 'edited' }))
  await enable($)
  const risky: any = await $.tool.call(edit('Buy.OnServerEvent:Connect(function(p, amount)\n  p.leaderstats.Coins.Value += amount\nend)'))
  expect(String(risky.context?.join(' '))).toContain('exploit check')
  const safe: any = await $.tool.call(edit('Buy.OnServerEvent:Connect(function(p, amount)\n  if typeof(amount) ~= "number" then return end\nend)'))
  expect(safe.context?.length ?? 0).toBe(0)
})

test('adds GAME.md to the system prompt', async ($, on) => {
  world(on)
  on('fs.exists', async () => ({ value: true }) as any)
  on('fs.read', async () => ({ value: 'Coins per kill: 5' }) as any)
  on('prompt.compose', async () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' }] }) as any)
  await enable($)
  const r: any = await ($ as any).prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  expect(r.sections.at(-1).text).toContain('Coins per kill: 5')
})

test('GAME.md rules: replace in place, create when missing in Roblox sessions', async ($, on) => {
  world(on)
  on('fs.exists', async () => ({ value: false }) as any)
  on('prompt.compose', async () => ({ sections: [{ id: 'base', text: 'base', scope: 'shared' }] }) as any)
  await enable($)
  const plain: any = await ($ as any).prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: ['Bash'], outputStyle: null, traits: [] })
  expect(plain.sections.length).toBe(2)
  expect(plain.sections.at(-1).text).toContain('roblox_api')
  expect(plain.sections.at(-1).text).not.toContain('GAME.md')
  const rbx: any = await ($ as any).prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: ['Bash', S + 'script_read'], outputStyle: null, traits: [] })
  const t = rbx.sections.at(-1).text
  expect(t).toContain('edit that line in place')
  expect(t).toContain('does not exist yet')
})

test('nudges Claude to update GAME.md once per turn', async ($, on) => {
  world(on)
  mock.clock(on)
  on('mcp.call', async () => text('ok'))
  on('fs.write', async () => ({ value: undefined }) as any)
  on('tool.call', async () => ({ result: 'edited' }))
  await enable($)
  const first: any = await $.tool.call(edit('local PRICE = 50'))
  const second: any = await $.tool.call(edit('local PRICE = 60'))
  expect(String(first.context?.join(' '))).toContain('GAME.md')
  expect(second.context?.length ?? 0).toBe(0)
})

test('everything is off until /roblox is run', async ($, on) => {
  world(on)
  on('tool.call', async () => ({ result: 'ran' }))
  on('command.describe', async (_$, e: any) => ({ description: e.description, isHidden: false }) as any)
  const r: any = await $.tool.call({ tool: S + 'execute_luau', code: 'store:SetAsync("k", 1)', datamodel_type: 'Server' } as any)
  expect(r.deny).toBeUndefined()
  const d: any = await ($ as any).command.describe({ command: 'roblox-test', description: 'x', isHidden: false })
  expect(d.isHidden).toBe(true)
  await enable($)
  const d2: any = await ($ as any).command.describe({ command: 'roblox-test', description: 'x', isHidden: false })
  expect(d2.isHidden).not.toBe(true)
  const r2: any = await $.tool.call({ tool: S + 'execute_luau', code: 'store:SetAsync("k", 1)', datamodel_type: 'Server' } as any)
  expect(String(r2.deny)).toContain('DataStores')
})

test('/roblox-ship finds publish problems locally', async ($, on) => {
  const logs: string[] = []
  world(on, logs)
  const audit = {
    unanchored: 2, samples: ['Workspace.Crate'],
    scripts: [
      { path: 'ServerScriptService.Data', source: 'local DSS = game:GetService("DataStoreService")\nlocal s = DSS:GetDataStore("x")\nlocal v = s:GetAsync(key)' },
      { path: 'ServerScriptService.Shop', source: 'Buy.OnServerEvent:Connect(function(p, n)\n p.Coins.Value -= n\nend)\nrequire(1234567)' },
      { path: 'StarterPlayer.UI', source: 'print(1) print(2) print(3)' },
    ],
  }
  on('mcp.call', async (_$, e: any) => text(e.tool === 'execute_luau' ? JSON.stringify(audit) : 'ok'))
  await enable($)
  await ($ as any).command.run({ command: 'roblox-ship', args: '' })
  const out = logs.join('\n')
  expect(out).toContain('DataStore call not wrapped in pcall')
  expect(out).toContain('BindToClose')
  expect(out).toContain('remote handler without input checks')
  expect(out).toContain('backdoor')
  expect(out).toContain('unanchored')
  expect(out).toContain('print() calls')
})

test('error memory tells Claude when a fix did not hold', async ($, on) => {
  world(on)
  const clock = mock.clock(on)
  on('fs.write', async () => ({ value: undefined }) as any)
  let consoleText = 'start'
  const prompts: string[] = []
  on('mcp.call', async (_$, e: any) => {
    if (e.tool === 'get_console_output') return text(consoleText)
    if (e.tool === 'start_stop_play' && e.args.mode === 'start_play') consoleText += '\nServerScriptService.Main:4: attempt to index nil with Name'
    return text('ok')
  })
  on('prompt.submit', async (_$, e: any) => { prompts.push(e.text); return { drop: 'captured' } as any })
  on('tool.call', async () => ({ result: 'edited' }))
  on('turn.complete', async () => ({ text: '' }) as any)
  const done = (answer: string) => ($ as any).turn.complete({ answer, durationMs: 1, isAborted: false, turnId: answer, reason: 'answer' })
  await enable($)

  await $.tool.call(edit('local a = 1'))
  await done('Built the shop')
  await clock.advance(10_000)
  expect(prompts.length).toBe(1)
  expect(prompts[0]).not.toContain('Error memory')

  await $.tool.call(edit('if part then print(part.Name) end'))
  await done('Added a nil check before reading Name')
  await clock.advance(10_000)
  expect(prompts.length).toBe(2)
  expect(prompts[1]).toContain('did not hold')
  expect(prompts[1]).toContain('Added a nil check')
})

test('change log pane lists edited scripts with undo', async ($, on) => {
  world(on)
  mock.clock(on)
  on('mcp.call', async (_$, e: any) => text(e.tool === 'script_read' ? 'local old = 1' : 'ok'))
  on('fs.write', async () => ({ value: undefined }) as any)
  on('tool.call', async () => ({ result: 'edited' }))
  await enable($)
  await $.tool.call(edit('local a = 1'))
  await $.tool.call(edit('local a = 2'))
  const ui: any = await ($ as any).ui.mount({ plugin: 'roblox-studio', surface: 'terminal', component: 'Pane', requestId: 'roblox-changes', props: { title: 'x', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { bodyRows: 30 } } })
  expect((await ui.findAll({ text: /ServerScriptService.Main/ })).length).toBeGreaterThan(0)
  expect((await ui.findAll({ text: /2 edits/ })).length).toBeGreaterThan(0)
  expect((await ui.findAll({ type: 'Button', text: /Undo all/ })).length).toBe(1)
})

const TWEEN_MD = `---
name: TweenService
type: class
---

# Class: TweenService

> Creates tweens.

## Description

Used to create Tweens which interpolate properties.

## Code Samples

\`\`\`lua
local t = TweenService:Create(part, TweenInfo.new(1), {Transparency = 1})
t:Play()
\`\`\`

## Methods

### Method: TweenService:Create

Creates a new Tween.

#### Parameters
instance: Instance, tweenInfo: TweenInfo, propertyTable: Dictionary

### Method: TweenService:GetValue

Returns a new alpha value.

## Inherited Members

### From [Instance](/docs/reference/engine/classes/Instance.md)
`

test('roblox_api returns a trimmed overview or one member, and caches', async ($, on) => {
  world(on)
  mock.clock(on)
  const fetched: string[] = []
  on('env.get', async (_$, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : null }) as any)
  on('fs.exists', async () => ({ value: false }) as any)
  on('fs.write', async () => ({ value: undefined }) as any)
  on('http.fetch', async (_$, e: any) => {
    fetched.push(e.url)
    const ok = e.url.endsWith('/classes/TweenService.md')
    return { value: { ok, status: ok ? 200 : 404, headers: {}, text: ok ? TWEEN_MD : 'not found' } } as any
  })
  await enable($)
  const all: any = await $.tool.call({ tool: 'mcp__roblox-studio__roblox_api', query: 'TweenService' } as any)
  expect(String(all.result)).toContain('Method TweenService:Create')
  expect(String(all.result)).toContain('Inherits from: Instance')
  expect(String(all.result)).not.toContain('#### Parameters')
  const one: any = await $.tool.call({ tool: 'mcp__roblox-studio__roblox_api', query: 'TweenService:Create()' } as any)
  expect(String(one.result)).toContain('propertyTable: Dictionary')
  expect(String(one.result)).not.toContain('GetValue')
  const none: any = await $.tool.call({ tool: 'mcp__roblox-studio__roblox_api', query: 'NotAThing' } as any)
  expect(String(none.result)).toContain('No Roblox API page')
})

test('roblox_skill_save writes a user skill and enforces limits', async ($, on) => {
  world(on)
  const written: { path: string; text: string }[] = []
  on('env.get', async (_$, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : null }) as any)
  on('fs.exists', async () => ({ value: false }) as any)
  on('fs.write', async (_$, e: any) => { written.push({ path: e.path, text: e.text }); return { value: undefined } as any })
  await enable($)
  const ok: any = await $.tool.call({ tool: 'mcp__roblox-studio__roblox_skill_save', name: 'Tweening', description: 'Use when animating properties with TweenService.', content: '## Verified API\nTweenService:Create(instance, tweenInfo, props) -> Tween\n\n## Gotchas\nCall :Play().' } as any)
  expect(String(ok.result)).toContain('Saved /home/me/.claude/skills/roblox-tweening/SKILL.md')
  expect(written[0]!.text).toContain('name: roblox-tweening')
  const bad: any = await $.tool.call({ tool: 'mcp__roblox-studio__roblox_skill_save', name: 'Bad Name!', description: 'x', content: 'y' } as any)
  expect(String(bad.result)).toContain('Refused')
  expect(written.length).toBe(1)
})

test('lookup tools stay off until /roblox', async ($, on) => {
  world(on)
  const r: any = await $.tool.call({ tool: 'mcp__roblox-studio__roblox_api', query: 'TweenService' } as any)
  expect(String(r.result)).toContain('/roblox')
})

test('/roblox checks the Studio connection', async ($, on) => {
  const logs: string[] = []
  world(on, logs)
  let up = true
  on('mcp.call', async (_$, e: any) => {
    if (!up) return { deny: 'MCP server "Roblox_Studio" not connected' } as any
    return text(e.tool === 'list_roblox_studios' ? JSON.stringify([{ name: 'Obby World', studio_id: 's-1' }]) : 'ok')
  })
  await enable($)
  expect(logs.join('\n')).toContain('Connected to Roblox Studio: Obby World')
  up = false
  logs.length = 0
  await ($ as any).command.run({ command: 'roblox', args: 'status' })
  expect(logs.join('\n')).toContain('not connected')
})
