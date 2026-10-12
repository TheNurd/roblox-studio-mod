# roblox-studio — Claude Code mod

Makes Claude Code a better Roblox developer.

**Off by default in every chat.** Run `/roblox` to turn it on for that chat; it also checks the Studio connection and tells you if Studio isn't connected or open (no tokens). `/roblox status` rechecks; `/roblox off` turns it off. Until then its other commands are hidden, its checks and auto-playtest don't run, nothing is added to Claude's instructions, and the `roblox-dev` skill and saved `roblox-*` skills stay dormant.

- `/roblox-setup` — connects Claude Code to Roblox Studio's built-in MCP server (Windows + macOS).
- `/roblox-test [what to check]` — Claude playtests your open place, reads the output and reports errors with fixes.
- `/roblox-review [area]` — Claude reviews your scripts for bugs, exploits, deprecated APIs and leaks.
- `/roblox-output` — live Studio output in a side pane, errors in red, a **Fix** button on each error. Polls every 3 s while open. No tokens unless you press Fix.
- Auto-playtest — after Claude edits a script, plays for 6 s and reads new output. Passing: a toast, no tokens. Errors: hands up to 10 lines to Claude to fix, at most 2 rounds per request. `/roblox-autotest on|off` to toggle.
- Script backups — saves each script to `.roblox-backups/` in your project folder before Claude edits it. `/roblox-restore` lists them; `/roblox-restore 3` puts one back (the current version is backed up first).
- Deprecated API guard — blocks script edits that add `wait`/`spawn`/`delay` or `game.Workspace`-style service access, and tells Claude the modern replacement. Free.
- Exploit check — after an edit, flags RemoteEvent/RemoteFunction handlers with no server-side input checks and tells Claude to fix them. A few tokens, only when flagged.
- `GAME.md` — a self-maintaining design doc. Claude creates it the first time it builds a game system, adds new items/stats/rules as one-line bullets, and edits changed values in place (no history), keeping it under ~300 words. `/roblox-design` has Claude draft it from your place now, or reports its size.
- `/roblox-ship [fix]` — pre-publish checklist run inside Studio and checked locally (free): DataStore calls without `pcall`, missing `BindToClose`, unvalidated remotes, `require(<asset id>)`/`loadstring` backdoors, deprecated APIs, loose unanchored parts, `print` spam. Findings go to the transcript; `fix` sends them to Claude.
- Error memory — remembers each error from auto-playtest and the Fix button, plus what Claude did about it. If the same error comes back, Claude is told the last fix didn't hold so it tries something else. Stored per project; adds text only for repeat errors. `/roblox-errors` to view, `/roblox-errors clear` to reset.
- `/roblox-changes` — pane of scripts Claude edited this chat, with **Undo last edit** and **Undo all** buttons (uses the backups). Free.
- Roblox API lookup — a `roblox_api` tool Claude calls before using any API it isn't sure of. It fetches the official docs (create.roblox.com), caches them for 7 days in `~/.claude/roblox-api-cache/`, and returns only an overview or the one member asked for (≤3,500 characters).
- Self-made skills — a `roblox_skill_save` tool Claude uses to turn what it verified into skills at `~/.claude/skills/roblox-<topic>/SKILL.md` (When to use, Verified API, example, Gotchas; under 6,000 characters). Same topic = update, not duplicate. Shared across all your Roblox projects. `/roblox-learn <topic>` has Claude research and save one now; `/roblox-skills` lists them. Delete a folder there to remove one.
- `roblox-dev` skill — Luau style, project layout, anti-exploit and DataStore rules, and the Studio tool workflow.
- Guard — blocks `execute_luau` from writing to DataStores or clearing the whole workspace.
- Status line — shows the last Studio action and a running count.

## Install

Needs Claude Code 2.1.287+ (terminal) or 2.1.286+ (Desktop app Code tab). Check with `claude --version`.

1. In the Claude app's add-plugin box enter `TheNurd/roblox-studio-mod`, or in Claude Code:
   ```
   /plugin marketplace add TheNurd/roblox-studio-mod
   /plugin install roblox-studio@roblox-studio-local
   ```
3. Run `/roblox`, then `/roblox-setup`, then in Studio: Assistant → … → Manage MCP Servers → turn on **Enable Studio as MCP server**.
4. Restart Claude Code. A green dot in that Studio panel means it's connected.

### Auto mode

In auto permission mode Claude Code refuses the mod's own calls to Studio (`/roblox status` says so), because a slash command has no model turn for the classifier to judge. Allow the tools the mod uses in `~/.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__Roblox_Studio__list_roblox_studios",
      "mcp__Roblox_Studio__get_studio_state",
      "mcp__Roblox_Studio__get_console_output",
      "mcp__Roblox_Studio__script_read",
      "mcp__Roblox_Studio__start_stop_play",
      "mcp__Roblox_Studio__execute_luau"
    ]
  }
}
```

The first four are read-only and cover `/roblox status`, the output pane and backups. `start_stop_play` and `execute_luau` are for auto-playtest, `/roblox-ship` and `/roblox-restore`; with them allowed, Claude's own Luau runs in your place skip the classifier too, so leave them out if you want that review.

Notes: the pane, auto-playtest and backups need Studio connected (server name `Roblox_Studio`). The mod also learns from Claude's own Studio calls, so it gets more reliable after Claude's first one. Pane and band drawing work in the terminal and the Desktop Code tab, not the VS Code panel.

Inspect before installing: `claude plugin validate ~/claude-mods/roblox-studio`
