import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { OutLine, Change } from '../types'

// roblox-studio mod for Claude Code
// Commands: /roblox-setup, /roblox-test, /roblox-review, /roblox-output,
//           /roblox-autotest [on|off], /roblox-restore [n]
// Hooks:    guard on execute_luau, status line, script backups before edits,
//           auto-playtest after Claude edits scripts.
// Token use: the output pane, backups and passing playtests run as local code
// and cost nothing. Only a failing auto-playtest starts a (short) Claude turn.

const DEFAULT_SERVER = 'Roblox_Studio'
const MAC_BIN = '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP'
const STUDIO_TOOL = /^mcp__.*roblox.*studio.*__/i
const PANE = 'roblox-output'
const BACKUP_DIR = '.roblox-backups'
const POLL_MS = 3000
const PLAY_SECONDS = 6
const MAX_AUTO_ROUNDS = 2

const DATASTORE_WRITE = /\b(SetAsync|UpdateAsync|RemoveAsync|IncrementAsync)\b/
const MASS_DELETE = /\b(workspace|game)\s*[:.]\s*ClearAllChildren\s*\(/i
const ERROR_LINE = /\berror\b|exception|stack begin|attempt to (index|call|perform|compare|concatenate)|is not a valid member|infinite yield|script timeout/i
const WARN_LINE = /\bwarn(ing)?\b/i
const ARG_ERROR = /invalid|missing|required|unknown|unexpected|param|argument|schema|field/i

const lines = atom({ plugin: 'roblox-studio', key: 'lines' } as const, [] as OutLine[])
const note = atom({ plugin: 'roblox-studio', key: 'note' } as const, '')
// Off in every chat until /roblox turns it on (kept for the session, across reloads)
const active = atom({ plugin: 'roblox-studio', key: 'active' } as const, false)
const GATED = new Set(['roblox-setup', 'roblox-test', 'roblox-review', 'roblox-output', 'roblox-autotest', 'roblox-restore', 'roblox-design', 'roblox-ship', 'roblox-errors', 'roblox-changes', 'roblox-learn', 'roblox-skills'])
const changes = atom({ plugin: 'roblox-studio', key: 'changes' } as const, [] as Change[])
const CHANGES_PANE = 'roblox-changes'

async function isOn($: any): Promise<boolean> {
  return Boolean(await read($, active))
}

// Learned from Claude's own Studio calls, so the mod talks to Studio the same way
let server = DEFAULT_SERVER
let studioId: string | undefined
let studioCalls = 0
let poller: { cancel(): void } | undefined
let editedThisTurn = false
let testing = false
let autoRounds = 0
let ourSubmit = false
let designNudged = false

type Shape = Record<string, unknown>

// ---------- helpers ----------

function toolName(e: any): string {
  return e.tool || e.name || ''
}

function textOf(res: any): string {
  return (res?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
}

function classify(text: string): OutLine['level'] {
  if (ERROR_LINE.test(text)) return 'error'
  if (WARN_LINE.test(text)) return 'warn'
  return 'info'
}

function submit($: any, text: string) {
  ourSubmit = true
  $.prompt.submit({ text, asUser: true }).catch(() => { ourSubmit = false })
}

// Calls a Studio tool, trying argument shapes until one is accepted, then remembers it.
async function callStudio($: any, tools: string[], shapes: Shape[]): Promise<any> {
  // Remember which tool name and argument shape worked (not the values), per tool
  const key = 'shape:' + tools[0]
  const cached: any = await $.store.get(key)
  const tries: { tool: string; i: number; withId: boolean }[] = []
  for (const tool of tools) {
    shapes.forEach((_s, i) => {
      if (studioId) tries.push({ tool, i, withId: true })
      tries.push({ tool, i, withId: false })
    })
  }
  if (cached) {
    const at = tries.findIndex(t => t.tool === cached.tool && t.i === cached.i && t.withId === cached.withId)
    if (at > 0) tries.unshift(...tries.splice(at, 1))
  }
  let last: any
  for (const t of tries) {
    const args = t.withId ? { studio_id: studioId, ...shapes[t.i] } : shapes[t.i]
    try {
      const res = await $.mcp.call(server, t.tool, args)
      if (res.isError && ARG_ERROR.test(textOf(res))) { last = res; continue }
      await $.store.set(key, { tool: t.tool, i: t.i, withId: t.withId })
      return res
    } catch (err) {
      last = err
    }
  }
  throw new Error('Studio did not accept ' + tools[0] + ': ' + (last?.message || textOf(last) || 'no answer'))
}

async function ensureStudio($: any) {
  if (studioId) return
  try {
    const res = await $.mcp.call(server, 'list_roblox_studios', {})
    const text = textOf(res)
    try {
      const data = JSON.parse(text)
      const list = Array.isArray(data) ? data : data.studios ?? data.instances ?? [data]
      const id = list[0]?.studio_id ?? list[0]?.id ?? list[0]?.studioId
      if (id) { studioId = String(id); return }
    } catch {}
    const m = text.match(/studio[_ ]?id["'\s:=]+([\w-]+)/i) || text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
    if (m) studioId = m[1] ?? m[0]
  } catch {}
}

// Checks the Studio connection without involving Claude (no tokens)
async function checkStudio($: any): Promise<{ ok: boolean; text: string }> {
  let res: any
  try {
    res = await $.mcp.call(server, 'list_roblox_studios', {})
  } catch (err: any) {
    const msg = String(err?.message || err)
    const missing = /not (found|configured|connected)|unknown server|no such server|no server/i.test(msg)
    return {
      ok: false,
      text: missing
        ? 'Roblox Studio is not connected to Claude Code. Run /roblox-setup, enable "Studio as MCP server" in Studio, then restart Claude Code.'
        : 'Could not reach Roblox Studio (' + msg.slice(0, 100) + '). Open Studio and check Assistant → … → Manage MCP Servers.',
    }
  }
  const text = textOf(res)
  if (res.isError) return { ok: false, text: 'Studio MCP answered with an error: ' + text.slice(0, 120) }
  let names: string[] = []
  try {
    const data = JSON.parse(text)
    const list = Array.isArray(data) ? data : data.studios ?? data.instances ?? []
    names = list.map((x: any) => String(x.name ?? x.place_name ?? x.placeName ?? x.studio_id ?? x.id ?? '?'))
    const id = list[0]?.studio_id ?? list[0]?.id ?? list[0]?.studioId
    if (id && !studioId) studioId = String(id)
  } catch {
    names = text.trim() ? [text.trim().split('\n')[0]!.slice(0, 60)] : []
  }
  if (!names.length || /no (studio|instance)s?/i.test(text)) {
    return { ok: false, text: 'Studio MCP is connected, but no Studio window is open. Open your place in Roblox Studio.' }
  }
  if (!studioId) await ensureStudio($)
  return { ok: true, text: 'Connected to Roblox Studio: ' + names.slice(0, 3).join(', ') + (names.length > 3 ? ` (+${names.length - 3} more)` : '') }
}

async function getConsole($: any): Promise<string[]> {
  await ensureStudio($)
  const res = await callStudio($, ['get_console_output', 'console_output'], [{}])
  return textOf(res).split(/\r?\n/).filter(l => l.trim() !== '')
}

function newLines(before: string[], after: string[]): string[] {
  if (before.length && after.length >= before.length && after[before.length - 1] === before[before.length - 1]) {
    return after.slice(before.length)
  }
  const lastSeen = before[before.length - 1]
  const at = lastSeen ? after.lastIndexOf(lastSeen) : -1
  return at >= 0 ? after.slice(at + 1) : after
}

async function setPlay($: any, start: boolean) {
  await ensureStudio($)
  return callStudio($, ['start_stop_play'], start
    ? [{ mode: 'start_play' }, { action: 'start' }, { play: true }, { start: true }, { is_start: true }]
    : [{ mode: 'stop' }, { action: 'stop' }, { play: false }, { start: false }, { is_start: false }])
}

function findPath(e: any): [string, string] | [] {
  for (const k of ['path', 'script_path', 'file_path', 'target', 'instance_path']) {
    if (typeof e[k] === 'string' && e[k]) return [k, e[k]]
  }
  for (const [k, v] of Object.entries(e)) {
    if (typeof v === 'string' && /^game[.:]/.test(v)) return [k, v]
  }
  return []
}

function cleanSource(text: string): string {
  let src = text.replace(/^```\w*\n/, '').replace(/\n```\s*$/, '')
  const ls = src.split('\n')
  const nonBlank = ls.filter(l => l.trim())
  const numbered = nonBlank.filter(l => /^\s*\d+\s*[|:\t]\s?/.test(l))
  if (nonBlank.length && numbered.length / nonBlank.length >= 0.8) {
    src = ls.map(l => l.replace(/^\s*\d+\s*[|:\t]\s?/, '')).join('\n')
  }
  return src
}

function safeName(path: string): string {
  return path.replace(/[^\w.-]+/g, '_')
}

async function backupScript($: any, key: string, path: string): Promise<string | undefined> {
  await ensureStudio($)
  let res: any
  try {
    res = await callStudio($, ['script_read'], [{ [key]: path }, { path }, { script_path: path }])
  } catch { return undefined }
  if (!res || res.isError) return undefined // new script: nothing to back up
  const cwd = await $.session.cwd()
  const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-')
  const file = cwd + '/' + BACKUP_DIR + '/' + safeName(path) + '/' + stamp + '.luau'
  await $.fs.write(file, cleanSource(textOf(res)))
  const index: any[] = (await $.store.get('backups')) ?? []
  index.push({ path, file, time: stamp })
  await $.store.set('backups', index.slice(-300))
  return file
}

async function runLuau($: any, code: string): Promise<any> {
  await ensureStudio($)
  return callStudio($, ['execute_luau'], [
    { code, datamodel_type: 'Edit' }, { luau: code, datamodel_type: 'Edit' }, { code }, { command: code },
  ])
}

// Puts a saved version back, after backing up what's there now
async function restoreFile($: any, path: string, file: string): Promise<string> {
  const src = String(await $.fs.read(file))
  await backupScript($, 'path', path)
  const res = await runLuau($, restoreLuau(path, src))
  return res.isError ? 'Restore failed: ' + textOf(res).slice(0, 120) : 'Restored ' + path
}

// ---------- error memory (local; adds text only when an error repeats) ----------

let pendingFix: string[] = []
let turnScripts = new Set<string>()

function errorSig(line: string): string {
  return line.replace(/^[\d:.\s-]*(?:-\s*)?/, '').replace(/:\d+/g, ':N').replace(/\b\d+(\.\d+)?\b/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 200)
}

async function memKey($: any) { return 'errmem:' + (await $.session.cwd()) }

// Counts each distinct error and returns what memory says about the repeat ones
async function rememberErrors($: any, errs: string[]): Promise<string[]> {
  const key = await memKey($)
  const mem: Record<string, any> = (await $.store.get(key)) ?? {}
  const notes: string[] = []
  const sigs = [...new Set(errs.map(errorSig))]
  const now = new Date(await $.clock.now()).toISOString()
  for (const sig of sigs) {
    const m = mem[sig] ?? { count: 0, sample: errs.find(l => errorSig(l) === sig)?.slice(0, 200) }
    m.count += 1
    m.time = now
    if (m.count >= 2 && m.lastFix) {
      notes.push(`"${m.sample}" has now appeared ${m.count} times. Last attempted fix (it did not hold): ${m.lastFix}` +
        (m.scripts?.length ? ` [edited: ${m.scripts.join(', ')}]` : '') + '. Try a different approach.')
    }
    mem[sig] = m
  }
  // keep the 100 most recent
  const keep = Object.entries(mem).sort((a: any, b: any) => String(b[1].time).localeCompare(String(a[1].time))).slice(0, 100)
  await $.store.set(key, Object.fromEntries(keep))
  pendingFix = sigs
  return notes
}

async function rememberFix($: any, answer: string) {
  if (!pendingFix.length) return
  const key = await memKey($)
  const mem: Record<string, any> = (await $.store.get(key)) ?? {}
  for (const sig of pendingFix) {
    if (!mem[sig]) continue
    mem[sig].lastFix = answer.replace(/\s+/g, ' ').trim().slice(0, 240)
    mem[sig].scripts = [...turnScripts].slice(0, 5)
  }
  await $.store.set(key, mem)
  pendingFix = []
}

async function sendErrorsToClaude($: any, intro: string, errs: string[]) {
  const notes = await rememberErrors($, errs)
  const list = errs.slice(0, 10).join('\n').slice(0, 1500)
  submit($, intro + '\n' + list + (notes.length ? '\n\nError memory:\n- ' + notes.join('\n- ').slice(0, 1200) : ''))
}

// ---------- publish checklist (/roblox-ship) ----------

const AUDIT_LUAU = `
local HttpService = game:GetService("HttpService")
local out = { scripts = {}, unanchored = 0, samples = {} }
local names = { "Workspace", "ServerScriptService", "ReplicatedStorage", "ReplicatedFirst", "StarterGui",
  "StarterPack", "StarterPlayer", "ServerStorage", "Lighting", "SoundService", "Teams" }
for _, name in names do
  local ok, svc = pcall(game.GetService, game, name)
  if ok and svc then
    for _, d in svc:GetDescendants() do
      if d:IsA("LuaSourceContainer") then
        local okS, src = pcall(function() return d.Source end)
        if okS then table.insert(out.scripts, { path = d:GetFullName(), class = d.ClassName, source = src }) end
      elseif name == "Workspace" and d:IsA("BasePart") and not d.Anchored then
        local model = d:FindFirstAncestorOfClass("Model")
        local isCharacter = model and model:FindFirstChildOfClass("Humanoid")
        if not isCharacter and #d:GetJoints() == 0 then
          out.unanchored += 1
          if #out.samples < 5 then table.insert(out.samples, d:GetFullName()) end
        end
      end
    end
  end
end
return HttpService:JSONEncode(out)
`

type Finding = { level: 'high' | 'medium' | 'low'; text: string }
type Audit = { scripts: { path: string; class?: string; source: string }[]; unanchored: number; samples: string[] }

const DS_CALL = /:(GetAsync|SetAsync|UpdateAsync|RemoveAsync|IncrementAsync)\s*\(/

function parseAudit(text: string): Audit {
  const a = text.indexOf('{'), b = text.lastIndexOf('}')
  if (a < 0 || b < a) throw new Error('Studio returned no audit data')
  let raw = text.slice(a, b + 1)
  try { return JSON.parse(raw) } catch { return JSON.parse(JSON.parse('"' + raw.replace(/"/g, '\\"') + '"')) }
}

function shipReport(audit: Audit): Finding[] {
  const f: Finding[] = []
  let usesDataStore = false
  let hasBindToClose = false
  for (const sc of audit.scripts) {
    const clean = stripComments(sc.source)
    const lines = clean.split('\n')
    if (/DataStoreService/.test(sc.source) && /GetDataStore|GetOrderedDataStore/.test(clean)) usesDataStore = true
    if (/BindToClose\s*\(/.test(clean)) hasBindToClose = true
    if (/\bloadstring\s*\(/.test(clean)) f.push({ level: 'high', text: `${sc.path}: uses loadstring — common in backdoors; remove unless you wrote it` })
    if (/\brequire\s*\(\s*\d{5,}\s*\)/.test(clean)) f.push({ level: 'high', text: `${sc.path}: require(<asset id>) loads remote code — classic free-model backdoor` })
    for (const r of unvalidatedRemotes(sc.source)) f.push({ level: 'high', text: `${sc.path}: remote handler without input checks — ${r}` })
    lines.forEach((l, i) => {
      if (DS_CALL.test(l) && !/pcall/.test(lines.slice(Math.max(0, i - 2), i + 1).join(' '))) {
        f.push({ level: 'high', text: `${sc.path}:${i + 1}: DataStore call not wrapped in pcall` })
      }
    })
    const old = deprecatedIn(sc.source)
    if (old.length) f.push({ level: 'medium', text: `${sc.path}: deprecated ${old.join(', ')}` })
    const prints = (clean.match(/(^|[^.\w:])print\s*\(/g) ?? []).length
    if (prints >= 3) f.push({ level: 'low', text: `${sc.path}: ${prints} print() calls — remove debug output` })
  }
  if (usesDataStore && !hasBindToClose) f.push({ level: 'high', text: 'DataStores are used but no script calls game:BindToClose — data can be lost when servers shut down' })
  if (audit.unanchored > 0) f.push({ level: 'medium', text: `${audit.unanchored} loose unanchored part(s) in Workspace (e.g. ${audit.samples.join(', ')})` })
  const order = { high: 0, medium: 1, low: 2 }
  return f.sort((a, b) => order[a.level] - order[b.level])
}

function restoreLuau(path: string, src: string): string {
  let n = 0
  while (src.includes(']' + '='.repeat(n) + ']')) n++
  const eq = '='.repeat(n)
  return [
    'local path = ' + JSON.stringify(path),
    'local inst = game',
    'for name in string.gmatch((path:gsub("^game[%.:]?", "")), "[^%.]+") do',
    '  inst = inst:FindFirstChild(name)',
    '  if not inst then error("Script not found: " .. path) end',
    'end',
    'local src = [' + eq + '[\n' + src + ']' + eq + ']',
    'game:GetService("ScriptEditorService"):UpdateSourceAsync(inst, function() return src end)',
    'return "restored " .. path',
  ].join('\n')
}

function startPolling($: any) {
  poller?.cancel()
  const tick = async () => {
    try {
      const all = await getConsole($)
      await update($, lines, () => all.slice(-300).map(text => ({ text, level: classify(text) })))
      await update($, note, () => '')
    } catch (err: any) {
      await update($, note, () => 'Waiting for Studio… (' + String(err.message || err).slice(0, 120) + ')')
    }
  }
  void tick()
  poller = $.clock.every(POLL_MS, tick)
}

async function autoPlaytest($: any) {
  testing = true
  let before: string[] = []
  try {
    before = await getConsole($)
    await setPlay($, true)
    $.ui.status('Studio · auto-playtest running…')
  } catch (err: any) {
    testing = false
    $.ui.status(undefined)
    $.ui.toast('Auto-playtest skipped: ' + String(err.message || err).slice(0, 120))
    return
  }
  $.clock.after(PLAY_SECONDS * 1000, async () => {
    try {
      const after = await getConsole($)
      await setPlay($, false).catch(() => $.ui.toast('Could not stop play mode — stop it in Studio.'))
      const errs = newLines(before, after).filter(l => classify(l) === 'error')
      if (errs.length === 0) {
        autoRounds = 0
        pendingFix = []
        $.ui.toast('Auto-playtest passed ✓')
        return
      }
      if (autoRounds >= MAX_AUTO_ROUNDS) {
        $.ui.toast('Auto-playtest still failing; stopped auto-fixing. See /roblox-output.')
        return
      }
      autoRounds += 1
      await sendErrorsToClaude($, `Auto-playtest after your last edit found ${errs.length} error(s). ` +
        'Fix them with minimal changes (roblox-dev skill). Errors:', errs)
    } catch (err: any) {
      $.ui.toast('Auto-playtest failed: ' + String(err.message || err).slice(0, 120))
    } finally {
      testing = false
      $.ui.status(undefined)
    }
  })
}


// ---------- code checks (local, free) ----------

const DESIGN_FILE = 'GAME.md'
const DESIGN_LIMIT = 3000
const SKIP_KEYS = /^(tool|tool_use_id|agentId|requestMeta|studio_id|datamodel_type|path|script_path|file_path|target|instance_path)$|old|search|find|match/i
const DEPRECATED: { re: RegExp; fix: string }[] = [
  { re: /(^|[^.\w:])wait\s*\(/, fix: 'wait() → task.wait()' },
  { re: /(^|[^.\w:])spawn\s*\(/, fix: 'spawn() → task.spawn()' },
  { re: /(^|[^.\w:])delay\s*\(/, fix: 'delay() → task.delay()' },
  { re: /\bgame\.Workspace\b/, fix: 'game.Workspace → workspace or game:GetService("Workspace")' },
  { re: /\bgame\.Players\b/, fix: 'game.Players → game:GetService("Players")' },
  { re: /\bgame\.ReplicatedStorage\b/, fix: 'game.ReplicatedStorage → game:GetService("ReplicatedStorage")' },
]
const REMOTE_HANDLER = /\.(OnServerEvent|OnServerInvoke)\b/
const VALIDATION = /typeof\s*\(|\btype\s*\(|assert\s*\(|tonumber\s*\(|if\s+not\b|:IsA\s*\(|math\.clamp|cooldown|debounce|ratelimit|rate_limit|validate|sanity|isValid|~=\s*nil|==\s*nil/i

// The new code an edit writes: string values, skipping paths and "old"/search text
function newCode(e: any): string {
  const out: string[] = []
  const walk = (v: any, key: string) => {
    if (SKIP_KEYS.test(key)) return
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach(x => walk(x, ''))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k)
  }
  for (const [k, v] of Object.entries(e)) walk(v, k)
  return out.join('\n')
}

function stripComments(code: string): string {
  return code.replace(/--\[(=*)\[[\s\S]*?\]\1\]/g, '').replace(/--[^\n]*/g, '').replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""')
}

function deprecatedIn(code: string): string[] {
  const clean = stripComments(code)
  return DEPRECATED.filter(d => d.re.test(clean)).map(d => d.fix)
}

// RemoteEvent/RemoteFunction handlers whose first ~20 lines show no input checks
function unvalidatedRemotes(code: string): string[] {
  const ls = stripComments(code).split('\n')
  const hits: string[] = []
  ls.forEach((l, i) => {
    if (!REMOTE_HANDLER.test(l)) return
    const body = ls.slice(i, i + 20).join('\n')
    if (!VALIDATION.test(body)) hits.push(l.trim().slice(0, 100))
  })
  return hits
}

async function readDesign($: any): Promise<{ text: string; words: number } | undefined> {
  const file = (await $.session.cwd()) + '/' + DESIGN_FILE
  if (!(await $.fs.exists(file))) return undefined
  const full = String(await $.fs.read(file)).trim()
  if (!full) return undefined
  return { text: full.slice(0, DESIGN_LIMIT), words: full.split(/\s+/).filter(Boolean).length }
}

const DESIGN_WORDS = 300
const DESIGN_RULES = [
  `Keep ${DESIGN_FILE} (project root) as the single source of truth for this Roblox game's design. Maintain it yourself, in the same turn as the work:`,
  '- When you add a game system, item, enemy, currency, stat, price, reward or rule, add it as one short line under the right heading.',
  '- When a value changes (a price, stat, rate or rule), edit that line in place so only the new value remains. Never keep old values, history or a changelog.',
  '- Remove lines for anything deleted from the game. Merge duplicates.',
  `- Keep it under ${DESIGN_WORDS} words: terse bullets, numbers over prose, no explanations of code.`,
  '- Follow these values in all code. If code and the doc disagree, ask the user which is right.',
].join('\n')

const DESIGN_TEMPLATE = `# Game design

Keep this short (under ~300 words). Claude reads it every turn.

## Game
- Genre / core loop:

## Economy
- Currency:
- Earn rates:
- Prices:

## Player
- Health / speed / stats:

## Rules
- Naming, folders, or style rules Claude must follow:
`


// ---------- Roblox API lookup + self-made skills ----------

const SELF = 'mcp__roblox-studio__'
const API_TOOL = 'roblox_api'
const SKILL_TOOL = 'roblox_skill_save'
const DOCS = 'https://create.roblox.com/docs/en-us/reference/engine/'
const KINDS = ['classes', 'datatypes', 'enums', 'libraries', 'globals']
const API_CAP = 3500
const CACHE_DAYS = 7

async function homeDir($: any): Promise<string> {
  const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE'))
  if (!home) throw new Error('Could not find your home folder')
  return String(home).replace(/\\/g, '/')
}

// "TweenService:Create" -> { name: 'TweenService', member: 'Create' }; "Enum.EasingStyle" -> enum
function parseQuery(q: string): { name: string; member?: string; kinds: string[] } {
  let t = q.trim().replace(/\(.*$/, '').replace(/^game:GetService\(["']?(\w+)["']?\)/, '$1')
  let kinds = KINDS
  if (/^Enum\./.test(t)) { t = t.slice(5); kinds = ['enums'] }
  const m = t.match(/^([A-Za-z_][\w]*)(?:[.:]([A-Za-z_]\w*))?(?:[.:](\w+))?/)
  if (!m) return { name: t, kinds }
  if (kinds[0] === 'enums') return { name: m[1]!, member: m[2], kinds }
  return { name: m[1]!, member: m[2], kinds }
}

async function fetchDoc($: any, name: string, kinds: string[]): Promise<{ kind: string; text: string } | undefined> {
  const cacheDir = (await homeDir($)) + '/.claude/roblox-api-cache/'
  const now = await $.clock.now()
  for (const kind of kinds) {
    const file = cacheDir + kind + '-' + name + '.md'
    try {
      if (await $.fs.exists(file)) {
        const st: any = await $.fs.stat(file)
        const age = now - Number(st?.mtimeMs ?? st?.modifiedMs ?? st?.mtime ?? 0)
        if (age >= 0 && age < CACHE_DAYS * 864e5) return { kind, text: String(await $.fs.read(file)) }
      }
    } catch {}
    const res = await $.http.fetch(DOCS + kind + '/' + encodeURIComponent(name) + '.md')
    if (res.ok && /^#|\n# /.test(res.text)) {
      await $.fs.write(file, res.text).catch(() => {})
      return { kind, text: res.text }
    }
  }
  return undefined
}

function sectionOf(md: string, member: string): string | undefined {
  const lines = md.split('\n')
  const re = new RegExp('^###\\s+\\w+:\\s*[\\w.]*[.:]' + member + '\\b', 'i')
  const start = lines.findIndex(l => re.test(l))
  if (start < 0) return undefined
  let end = lines.findIndex((l, i) => i > start && /^#{2,3}\s/.test(l))
  if (end < 0) end = lines.length
  return lines.slice(start, end).join('\n').trim()
}

function overviewOf(md: string, kind: string): string {
  const body = md.replace(/^---[\s\S]*?\n---\n/, '')
  const title = (body.match(/^# .*$/m) ?? [''])[0]
  const desc = (body.split(/^## Description\s*$/m)[1] ?? body).split(/^## /m)[0]!.trim().slice(0, 1200)
  const own = body.split(/^## Inherited Members/m)[0]!
  const members = [...own.matchAll(/^### (\w+): ([\w.:]+)/gm)].map(m => `${m[1]} ${m[2]}`)
  const inherited = [...body.matchAll(/^### From \[(\w+)\]/gm)].map(m => m[1])
  const sample = (own.split(/^## Code Samples\s*$/m)[1] ?? '').split(/^## /m)[0]!.match(/```[\s\S]*?```/)
  return [
    title + (kind !== 'classes' ? ` (${kind})` : ''),
    desc,
    members.length ? 'Members:\n' + members.join('\n') : '',
    inherited.length ? 'Inherits from: ' + inherited.join(', ') : '',
    sample ? 'Example:\n' + sample[0].slice(0, 1200) : '',
    'Ask again with a member name (e.g. "Class:Member") for its full signature and notes.',
  ].filter(Boolean).join('\n\n')
}

async function lookupApi($: any, query: string): Promise<string> {
  const q = parseQuery(query)
  const doc = await fetchDoc($, q.name, q.kinds)
  if (!doc) return `No Roblox API page found for "${q.name}". Check the spelling or try the class name alone.`
  if (q.member) {
    const sec = sectionOf(doc.text, q.member)
    if (sec) return sec.slice(0, API_CAP)
    return `"${q.member}" not found on ${q.name}'s own page (it may be inherited or not exist).\n\n` + overviewOf(doc.text, doc.kind).slice(0, API_CAP)
  }
  return overviewOf(doc.text, doc.kind).slice(0, API_CAP)
}

const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/

async function saveSkill($: any, e: any): Promise<string> {
  const topic = String(e.name ?? '').toLowerCase().replace(/^roblox-/, '')
  if (!SKILL_NAME.test(topic) || topic.length > 40) return 'Refused: name must be short kebab-case, e.g. "tweening" or "datastore-sessions".'
  const description = String(e.description ?? '').replace(/\s+/g, ' ').trim()
  if (!description || description.length > 200) return 'Refused: description must be 1-200 characters saying when to use the skill.'
  const content = String(e.content ?? '').trim()
  if (content.length < 80) return 'Refused: content is too short to be useful.'
  if (content.length > 6000) return `Refused: content is ${content.length} characters; keep it under 6000 (verified signatures, one short example, gotchas).`
  const name = 'roblox-' + topic
  const file = (await homeDir($)) + '/.claude/skills/' + name + '/SKILL.md'
  const existed = await $.fs.exists(file)
  await $.fs.write(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${content}\n`)
  $.ui.toast((existed ? 'Updated' : 'Saved') + ' skill ' + name)
  return `${existed ? 'Updated' : 'Saved'} ${file}. It loads in new sessions; you already have its content for this one.`
}

const SKILLS_GUIDE = [
  'Roblox API and skills (tools from the roblox-studio mod; load them with tool search if needed):',
  `- ${SELF}${API_TOOL}: look up the official Roblox API. Call it before using any class, method, property, event, enum or library you are not certain of, and never guess a signature. Ask for "Class:Member" to get just that member.`,
  `- ${SELF}${SKILL_TOOL}: save what you verified as a reusable skill (user-level, shared across the user's Roblox projects). Save one when you have worked out something reusable: a service (TweenService), a system (DataStore sessions, pathfinding, round loop), or a fix for a mistake you made.`,
  '- Before saving, check the skill list for an existing roblox-* skill on that topic and update it instead (same name, merged content). One topic per skill.',
  '- Skill content: When to use; Verified API (exact signatures from the lookup); a short working Luau example; Gotchas. Facts you checked only, no padding.',
].join('\n')

// ---------- the mod ----------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const cmds = [
      { name: 'roblox', description: 'Turn the Roblox mod on for this chat and check the Studio connection', argumentHint: '[off|status]' },
      { name: 'roblox-setup', description: 'Connect Claude Code to Roblox Studio' },
      { name: 'roblox-test', description: 'Playtest the open place and report errors', argumentHint: '[what to check]' },
      { name: 'roblox-review', description: 'Review scripts for bugs, exploits and deprecated APIs', argumentHint: '[script or area]' },
      { name: 'roblox-output', description: 'Show Studio output in a live pane (no tokens)' },
      { name: 'roblox-autotest', description: 'Auto-playtest after Claude edits scripts', argumentHint: '[on|off]' },
      { name: 'roblox-restore', description: 'List script backups, or restore one by number', argumentHint: '[n]' },
      { name: 'roblox-design', description: 'Have Claude draft GAME.md from your place, or check its size' },
      { name: 'roblox-ship', description: 'Pre-publish checklist (free). Add "fix" to have Claude fix the findings', argumentHint: '[fix]' },
      { name: 'roblox-errors', description: 'Show remembered recurring errors and their last fixes', argumentHint: '[clear]' },
      { name: 'roblox-changes', description: 'Pane of scripts Claude changed this chat, with undo' },
      { name: 'roblox-learn', description: 'Have Claude research a Roblox topic in the API docs and save it as a skill', argumentHint: '<topic>' },
      { name: 'roblox-skills', description: 'List the Roblox skills Claude has saved' },
    ]
    try {
      await $.tool.register({
        name: API_TOOL,
        isDeferred: true,
        description: 'Look up the official Roblox Engine API (classes, datatypes, enums, libraries like task). ' +
          'Pass "TweenService" for an overview with its member list, or "TweenService:Create", "Instance.Parent", "Enum.EasingStyle", "task.wait" for one member. Only works while the Roblox mod is on (/roblox).',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Class, or Class:Member / Class.Member' } }, required: ['query'] },
      })
      await $.tool.register({
        name: SKILL_TOOL,
        isDeferred: true,
        description: 'Save or update a Roblox development skill (~/.claude/skills/roblox-<name>/SKILL.md) from API facts you verified with roblox_api. ' +
          'Same name updates the existing skill. Content: When to use, Verified API, short Luau example, Gotchas; under 6000 characters.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'kebab-case topic, e.g. "tweening" (saved as roblox-tweening)' },
            description: { type: 'string', description: 'One sentence: when Claude should use this skill (max 200 chars)' },
            content: { type: 'string', description: 'Markdown body of the skill' },
          },
          required: ['name', 'description', 'content'],
        },
      })
    } catch (err: any) { $.ui.log(String(err.message || err)) }
    for (const c of cmds) {
      try { await $.command.register(c) } catch (err: any) { $.ui.log(String(err.message || err)) }
    }
    return next(e)
  })

  // ----- on/off switch -----
  on('command.run', { command: 'roblox' }, async ($, e) => {
    const arg = String(e.args || '').trim()
    if (/^status$/i.test(arg)) {
      const st = await checkStudio($)
      $.ui.toast((await isOn($) ? 'Roblox mod on · ' : 'Roblox mod off · ') + st.text)
      if (await isOn($)) $.ui.status(st.ok ? 'Studio · connected' : 'Studio · not connected')
      return {}
    }
    const off = /^(off|stop|disable)$/i.test(arg)
    await update($, active, () => !off)
    if (off) {
      poller?.cancel(); poller = undefined
      $.ui.status(undefined)
      $.ui.toast('Roblox mod off for this chat')
      return {}
    }
    const studio = await checkStudio($)
    $.ui.toast('Roblox mod on · ' + (studio.ok ? studio.text : 'Studio not connected — see transcript'))
    $.ui.status(studio.ok ? 'Studio · connected' : 'Studio · not connected')
    if (!studio.ok) $.ui.log(studio.text)
    $.ui.log('Roblox mod on: /roblox-setup · /roblox-output · /roblox-changes · /roblox-test · /roblox-review · /roblox-ship · /roblox-design · /roblox-errors · /roblox-learn · /roblox-skills · /roblox-restore · /roblox-autotest · /roblox off')
    return {}
  }).catch(($, e, next) => { $.ui.toast('roblox failed: ' + next.error?.message); return {} })

  // Hide and refuse the other commands until the mod is on
  on('command.describe', async ($, e, next) => {
    const r = await next(e)
    return GATED.has(e.command) && !(await isOn($)) ? { ...r, isHidden: true } : r
  }).catch(($, e, next) => next(e))

  on('command.run', async ($, e, next) => {
    if (GATED.has(e.command) && !(await isOn($))) {
      $.ui.toast('Run /roblox first to turn the Roblox mod on in this chat')
      return {}
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // The roblox-dev skill stays dormant until the mod is on
  on('skill.prompt', async ($, e, next) => {
    if (/(^|:)roblox-/.test(e.skill) && !(await isOn($))) {
      return { text: 'The Roblox mod is off in this chat. Continue without it; if the user wants it, they can run /roblox.' }
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  // ----- setup -----
  on('command.run', { command: 'roblox-setup' }, async ($) => {
    const localAppData = await $.env.get('LOCALAPPDATA')
    const isWindows = Boolean(localAppData)
    let serverCmd: string[]
    if (isWindows && (await $.fs.exists(localAppData + '\\Roblox\\mcp.bat'))) {
      serverCmd = ['cmd.exe', '/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat']
    } else if (!isWindows && (await $.fs.exists(MAC_BIN))) {
      serverCmd = [MAC_BIN]
    } else {
      return { text: 'Roblox Studio MCP not found. Update Roblox Studio, open it once, then run /roblox-setup again.' }
    }
    const claude = (args: string[]) => isWindows ? ['cmd.exe', '/c', 'claude', ...args] : ['claude', ...args]
    try {
      const existing = await $.process.run(claude(['mcp', 'get', DEFAULT_SERVER]))
      if (existing.exitCode !== 0) {
        const added = await $.process.run(claude(['mcp', 'add', '--scope', 'user', DEFAULT_SERVER, '--', ...serverCmd]))
        if (added.exitCode !== 0) return { text: 'Could not add the server:\n' + (added.stderr || added.stdout) }
      }
    } catch (err: any) {
      return { text: 'Could not run the claude CLI (' + (err.message || err) + '). Run this in your shell instead:\nclaude mcp add --scope user ' + DEFAULT_SERVER + ' -- ' + serverCmd.join(' ') }
    }
    return {
      text: [
        'Roblox Studio MCP server is registered.',
        'Finish in Studio: Assistant → … → Manage MCP Servers → turn on "Enable Studio as MCP server".',
        'Then restart Claude Code. A green dot in that Studio panel means it connected.',
      ].join('\n'),
    }
  }).catch(($, e, next) => ({ text: 'roblox-studio: ' + next.error?.message }))

  // ----- prompts that Claude runs -----
  on('command.run', { command: 'roblox-test' }, async ($, e) => {
    submit($, 'Playtest my open Roblox Studio place. Use the roblox-dev skill. ' +
      'Start play mode, ' + (e.args ? 'check this: ' + e.args + '. ' : 'exercise the main gameplay loop. ') +
      'Read the console output, stop play mode, then list every error and warning with the script and line, ' +
      'the likely cause, and a proposed fix. Do not edit anything until I approve.')
    return {}
  }).catch(($, e, next) => ({ text: 'roblox-studio: ' + next.error?.message }))

  on('command.run', { command: 'roblox-review' }, async ($, e) => {
    submit($, 'Review the scripts in my open Roblox Studio place' + (e.args ? ', focusing on ' + e.args : '') + '. Use the roblox-dev skill. ' +
      'Look for: bugs, client-trusted RemoteEvent/RemoteFunction handlers (exploits), deprecated APIs (wait, spawn, delay), ' +
      'memory leaks from unconnected events, unsafe DataStore code, and performance problems. ' +
      'Report findings by severity with script paths. Do not edit anything until I approve.')
    return {}
  }).catch(($, e, next) => ({ text: 'roblox-studio: ' + next.error?.message }))

  // ----- Studio output pane (no tokens unless you press Fix) -----

  on('command.run', { command: 'roblox-output' }, async ($) => {
    await $.ui.open({ id: PANE, title: 'Roblox Studio output' })
    startPolling($)
    return {}
  }).catch(($, e, next) => ({ text: 'roblox-studio: ' + next.error?.message }))

  on('ui.close', async ($, e, next) => {
    if ((e as any).id === PANE) { poller?.cancel(); poller = undefined }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, lines)
    const msg = await read($, note)
    const room = Math.max(3, (e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 24) - 3)
    const shown = list.slice(-room)
    const errors = list.filter(l => l.level === 'error').length
    const color = (l: OutLine) => (l.level === 'error' ? 'red' : l.level === 'warn' ? 'yellow' : undefined)

    return (
      <Box flexDirection="column">
        <Text dimColor>{msg || `${list.length} lines · ${errors} errors · refreshes every ${POLL_MS / 1000}s`}</Text>
        {shown.length === 0 && !msg && <Text dimColor>No output yet. Press Play in Studio.</Text>}
        {shown.map((l, i) =>
          l.level === 'error' ? (
            <Box key={'l' + i} flexDirection="row" gap={1}>
              <Button
                key={'fix' + i}
                label="Fix"
                onPress={() => { void sendErrorsToClaude($, 'Fix this Roblox Studio error. Use the roblox-dev skill and keep the change minimal:', [l.text.slice(0, 500)]) }}
              />
              <Text color="red" wrap="truncate">{l.text}</Text>
            </Box>
          ) : (
            <Text key={'l' + i} color={color(l)} dimColor={l.level === 'info'} wrap="truncate">{l.text}</Text>
          ),
        )}
      </Box>
    )
  })

  // ----- auto-playtest -----
  on('command.run', { command: 'roblox-autotest' }, async ($, e) => {
    const arg = String(e.args || '').trim().toLowerCase()
    const current = (await $.store.get('autotest')) !== false
    const next = arg === 'on' ? true : arg === 'off' ? false : !current
    await $.store.set('autotest', next)
    $.ui.toast('Auto-playtest ' + (next ? 'on' : 'off'))
    return {}
  }).catch(($, e, next) => ({ text: 'roblox-studio: ' + next.error?.message }))

  on('prompt.submit', async ($, e, next) => {
    if (ourSubmit) ourSubmit = false
    else autoRounds = 0 // a new request from you resets the auto-fix limit
    return next(e)
  }).catch(($, e, next) => next(e))


  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!(await isOn($))) { editedThisTurn = false; designNudged = false; return r }
    if (editedThisTurn) await rememberFix($, String((e as any).answer ?? '')).catch(() => {})
    turnScripts = new Set()
    if (editedThisTurn && !testing && (await $.store.get('autotest')) !== false) {
      editedThisTurn = false
      $.clock.after(0, () => autoPlaytest($))
    }
    editedThisTurn = false
    designNudged = false
    return r
  })

  // ----- backups: /roblox-restore -----
  on('command.run', { command: 'roblox-restore' }, async ($, e) => {
    const index: any[] = (((await $.store.get('backups')) ?? []) as any[]).slice().reverse()
    const n = parseInt(String(e.args || '').trim(), 10)
    if (!n) {
      if (index.length === 0) { $.ui.toast('No script backups yet.'); return {} }
      $.ui.log('Script backups (newest first) — run /roblox-restore <n>:\n' +
        index.slice(0, 20).map((b, i) => `${i + 1}. ${b.path}  ${b.time}`).join('\n'))
      return {}
    }
    const b = index[n - 1]
    if (!b) { $.ui.toast('No backup #' + n); return {} }
    $.ui.toast(await restoreFile($, b.path, b.file))
    return {}
  }).catch(($, e, next) => { $.ui.toast('Restore failed: ' + next.error?.message); return {} })

  // ----- publish checklist -----
  on('command.run', { command: 'roblox-ship' }, async ($, e) => {
    $.ui.status('Studio · checking place before publish…')
    const res = await runLuau($, AUDIT_LUAU)
    $.ui.status(undefined)
    if (res.isError) { $.ui.toast('Ship check failed: ' + textOf(res).slice(0, 120)); return {} }
    const findings = shipReport(parseAudit(textOf(res)))
    const count = (lv: string) => findings.filter(f => f.level === lv).length
    const summary = `Ship check: ${count('high')} high · ${count('medium')} medium · ${count('low')} low`
    if (!findings.length) { $.ui.toast('Ship check passed ✓ — nothing found'); return {} }
    $.ui.log(summary + '\n' + findings.map(f => `[${f.level}] ${f.text}`).join('\n'))
    $.ui.toast(summary + (/^fix$/i.test(String(e.args || '').trim()) ? ' — sending to Claude' : ' — run /roblox-ship fix to have Claude fix them'))
    if (/^fix$/i.test(String(e.args || '').trim())) {
      const list = findings.filter(f => f.level !== 'low').concat(findings.filter(f => f.level === 'low').slice(0, 5))
      submit($, 'Fix these pre-publish issues in my Roblox place (roblox-dev skill). High first; keep changes minimal; ' +
        'for anything that might be intentional, ask me instead of changing it:\n' + list.map(f => `[${f.level}] ${f.text}`).join('\n').slice(0, 2500))
    }
    return {}
  }).catch(($, e, next) => { $.ui.status(undefined); $.ui.toast('Ship check failed: ' + next.error?.message); return {} })

  // ----- error memory -----
  on('command.run', { command: 'roblox-errors' }, async ($, e) => {
    const key = await memKey($)
    if (/^clear$/i.test(String(e.args || '').trim())) { await $.store.delete(key); $.ui.toast('Error memory cleared'); return {} }
    const mem: Record<string, any> = (await $.store.get(key)) ?? {}
    const rows = Object.values(mem).sort((a: any, b: any) => b.count - a.count).slice(0, 15)
    if (!rows.length) { $.ui.toast('No errors remembered yet'); return {} }
    $.ui.log('Remembered errors (most frequent first):\n' + rows.map((m: any) =>
      `${m.count}× ${m.sample}` + (m.lastFix ? `\n    last fix: ${m.lastFix}` : '')).join('\n'))
    return {}
  }).catch(($, e, next) => { $.ui.toast('roblox-errors failed: ' + next.error?.message); return {} })

  // ----- change log pane -----
  on('command.run', { command: 'roblox-changes' }, async ($) => {
    await $.ui.open({ id: CHANGES_PANE, title: 'Roblox changes this chat' })
    return {}
  }).catch(($, e, next) => { $.ui.toast('roblox-changes failed: ' + next.error?.message); return {} })

  on('ui.render', { component: 'Pane', requestId: CHANGES_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = (await read($, changes)).slice().reverse()
    const undo = (c: Change, file: string | undefined, label: string) => async () => {
      if (!file) return
      const msg = await restoreFile($, c.path, file)
      $.ui.toast(msg)
      if (msg.startsWith('Restored')) await update($, changes, l => l.map(x => x.path === c.path ? { ...x, restored: label } : x))
    }
    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No script changes yet this chat.</Text>}
        {list.map((c, i) => (
          <Box key={'c' + i} flexDirection="column">
            <Text bold wrap="truncate">{c.path}</Text>
            <Text dimColor>
              {c.edits} edit{c.edits === 1 ? '' : 's'} · last {c.time}
              {c.restored ? ' · ' + c.restored : ''}
              {!c.firstFile ? ' · new script (nothing to undo)' : ''}
            </Text>
            {c.firstFile && (
              <Box flexDirection="row" gap={1}>
                <Button key={'last' + i} label="Undo last edit" onPress={undo(c, c.lastFile, 'last edit undone')} />
                {c.edits > 1 && <Button key={'all' + i} label="Undo all" onPress={undo(c, c.firstFile, 'all edits undone')} />}
              </Box>
            )}
          </Box>
        ))}
      </Box>
    )
  })

  // ----- game design doc -----
  on('command.run', { command: 'roblox-design' }, async ($) => {
    const file = (await $.session.cwd()) + '/' + DESIGN_FILE
    if (!(await $.fs.exists(file))) {
      submit($, 'Create ' + DESIGN_FILE + ' in the project root by reading my open Roblox Studio place (scripts, configs, ' +
        'leaderstats, shop and enemy data). Use headings: Game, Economy, Player, Items, Enemies, Rules. ' +
        'One line per fact, real numbers from the code, under ' + DESIGN_WORDS + ' words. Use this as the shape:\n\n' + DESIGN_TEMPLATE)
      return {}
    }
    const text = String(await $.fs.read(file))
    const words = text.split(/\s+/).filter(Boolean).length
    $.ui.toast(DESIGN_FILE + ': ' + words + ' words' + (words > DESIGN_WORDS ? ' — over ' + DESIGN_WORDS + '; Claude will trim it next turn' : ' ✓') +
      (text.length > DESIGN_LIMIT ? ' (only the first ' + DESIGN_LIMIT + ' characters are used)' : ''))
    return {}
  }).catch(($, e, next) => { $.ui.toast('roblox-design failed: ' + next.error?.message); return {} })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!(await isOn($))) return r
    const design = await readDesign($)
    const robloxSession = (e.tools ?? []).some((t: string) => STUDIO_TOOL.test(t) && !t.startsWith(SELF))
    if (!design && !robloxSession) {
      return { sections: [...r.sections, { id: 'roblox-skills', scope: 'session' as const, text: SKILLS_GUIDE }] }
    }
    const body = design
      ? '\n\nCurrent ' + DESIGN_FILE + ':\n' + design.text +
        (design.words > DESIGN_WORDS ? `\n\n(${DESIGN_FILE} is ${design.words} words. Trim it under ${DESIGN_WORDS} the next time you edit it.)` : '')
      : `\n\n${DESIGN_FILE} does not exist yet. Create it the first time you build or change a game system.`
    return {
      sections: [...r.sections, {
        id: 'roblox-game-design',
        scope: 'session' as const,
        text: 'The roblox-studio mod is on in this chat: use the roblox-dev skill for Roblox work.\n\n' + SKILLS_GUIDE + '\n\n# Game design doc\n' + DESIGN_RULES + body,
      }],
    }
  }).catch(($, e, next) => next(e))

  // ----- API lookup + skills -----
  on('tool.call', { tool: 'mcp__roblox-studio__roblox_api' as any }, async ($, e: any) => {
    if (!(await isOn($))) return { result: 'The Roblox mod is off in this chat; the user can run /roblox to turn it on.' }
    $.ui.status('Roblox API · ' + String(e.query).slice(0, 40))
    try { return { result: await lookupApi($, String(e.query ?? '')) } }
    finally { $.ui.status(undefined) }
  }).catch(($, e, next) => ({ result: 'Lookup failed: ' + next.error?.message }))

  on('tool.call', { tool: 'mcp__roblox-studio__roblox_skill_save' as any }, async ($, e: any) => {
    if (!(await isOn($))) return { result: 'The Roblox mod is off in this chat; the user can run /roblox to turn it on.' }
    return { result: await saveSkill($, e) }
  }).catch(($, e, next) => ({ result: 'Saving the skill failed: ' + next.error?.message }))

  on('command.run', { command: 'roblox-learn' }, async ($, e) => {
    const topic = String(e.args || '').trim()
    if (!topic) { $.ui.toast('Usage: /roblox-learn <topic>, e.g. /roblox-learn TweenService'); return {} }
    submit($, `Research "${topic}" for Roblox development using ${SELF}${API_TOOL} (look up the classes and members it involves; ` +
      `don't guess). Then save or update one concise skill with ${SELF}${SKILL_TOOL}. Reply with one line naming the skill.`)
    return {}
  }).catch(($, e, next) => { $.ui.toast('roblox-learn failed: ' + next.error?.message); return {} })

  on('command.run', { command: 'roblox-skills' }, async ($) => {
    const dir = (await homeDir($)) + '/.claude/skills'
    const entries: any[] = (await $.fs.exists(dir)) ? await $.fs.list(dir) : []
    const mine = entries.filter(x => x.kind === 'directory' || x.kind === 'dir' ? /^roblox-/.test(x.name) : false).map(x => x.name)
    if (!mine.length) { $.ui.toast('No Roblox skills saved yet — try /roblox-learn TweenService'); return {} }
    $.ui.log('Roblox skills in ' + dir + ':\n' + mine.map(n => '- ' + n).join('\n') + '\nDelete a folder there to remove a skill.')
    return {}
  }).catch(($, e, next) => { $.ui.toast('roblox-skills failed: ' + next.error?.message); return {} })

  // ----- every Studio tool call: learn, guard, back up, status -----
  on('tool.call', async ($, e, next) => {
    const name = toolName(e)
    if (!STUDIO_TOOL.test(name) || name.startsWith(SELF) || !(await isOn($))) return next(e)

    const parts = name.split('__')
    server = parts[1] || server
    const action = parts[parts.length - 1]
    if (typeof (e as any).studio_id === 'string') studioId = (e as any).studio_id

    if (action === 'execute_luau') {
      const payload = JSON.stringify(e)
      if (DATASTORE_WRITE.test(payload)) {
        return { deny: 'roblox-studio mod: execute_luau must not write to DataStores; it can change real player data. Write the code into a script instead, or ask the user to run it themselves.' }
      }
      if (MASS_DELETE.test(payload)) {
        return { deny: 'roblox-studio mod: refusing to clear all children of game/workspace. Delete specific instances, and confirm with the user first.' }
      }
    }

    const isEdit = action === 'multi_edit'
    const code = isEdit ? newCode(e) : ''
    let editPath: string | undefined
    let editBackup: string | undefined
    if (isEdit) {
      const old = deprecatedIn(code)
      if (old.length) {
        $.ui.toast('Blocked deprecated Luau: ' + old.join(', '))
        return { deny: 'roblox-studio mod: this edit uses deprecated APIs. Rewrite it: ' + old.join('; ') + '. Then retry the edit.' }
      }
    }
    if (isEdit) {
      const [key, path] = findPath(e)
      if (key && path) {
        editPath = path
        editBackup = await backupScript($, key, path).catch(() => undefined)
      }
    }

    studioCalls += 1
    $.ui.status('Studio · ' + action + ' · ' + studioCalls + ' actions')
    const r: any = await next(e)
    if (isEdit && !r?.deny && !r?.isError) {
      editedThisTurn = true
      if (editPath) {
        const p = editPath
        turnScripts.add(p)
        const time = new Date(await $.clock.now()).toISOString().slice(11, 19)
        await update($, changes, list => {
          const old = list.find(c => c.path === p)
          const rest = list.filter(c => c.path !== p)
          const entry: Change = old
            ? { ...old, edits: old.edits + 1, time, lastFile: editBackup, restored: undefined }
            : { path: p, edits: 1, time, firstFile: editBackup, lastFile: editBackup }
          return [...rest, entry].slice(-100)
        })
      }
      const notes: string[] = []
      const risky = unvalidatedRemotes(code)
      if (risky.length) {
        $.ui.toast('Exploit check: ' + risky.length + ' remote handler(s) without input checks')
        notes.push('roblox-studio exploit check: these remote handlers show no server-side validation: ' +
          risky.join(' | ') + '. Validate argument types, ranges, ownership and rate limits on the server before acting, then fix the script.')
      }
      if (!designNudged) {
        designNudged = true
        notes.push(`If this changed or added a game value, system or rule, update ${DESIGN_FILE} before you finish (replace old values in place).`)
      }
      if (notes.length) return { ...r, context: [...(r.context ?? []), ...notes] }
    }
    return r
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'roblox-studio: its guard failed; try again.' }))
}
