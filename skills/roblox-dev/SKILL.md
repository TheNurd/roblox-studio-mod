---
name: roblox-dev
description: Use for any Roblox game work — writing or fixing Luau, building in Roblox Studio through the Roblox_Studio MCP tools, playtesting, or reviewing scripts for bugs and exploits.
---

# Roblox development

## Working in Studio (Roblox_Studio MCP tools)

1. Call `list_roblox_studios` first. Pass that `studio_id` on every later call.
2. Look before you change: `search_game_tree`, `inspect_instance`, `script_search`, `script_grep`, `script_read`.
3. Edit scripts with `multi_edit` (datamodel_type `Edit`). It creates the script if the path doesn't exist.
4. Use `execute_luau` for quick checks and building instances, not for permanent logic. Put permanent logic in scripts.
5. Verify every change: `start_stop_play` → reproduce → `get_console_output` → `start_stop_play` to stop. Use `screen_capture` for visual checks and `character_navigation` / `user_keyboard_input` / `user_mouse_input` to drive the player.
6. Unsure about an API? Use `http_get` on the Roblox Engine API reference before guessing.
7. If no Roblox_Studio tools exist, tell the user to run `/roblox-setup`.

## Project layout

- `ServerScriptService` — server Scripts (game logic, data, anti-cheat).
- `ReplicatedStorage` — ModuleScripts and RemoteEvents shared by client and server.
- `StarterPlayer.StarterPlayerScripts` / `StarterCharacterScripts` — LocalScripts.
- `StarterGui` — UI and its LocalScripts.
- `ServerStorage` — server-only assets and modules.
- Prefer ModuleScripts. Keep Scripts/LocalScripts as thin entry points.

## Luau rules

- Start files with `--!strict` and type function parameters and returns.
- Use `task.wait`, `task.spawn`, `task.delay`, `task.defer`. Never `wait`, `spawn`, `delay`.
- Get services with `game:GetService("Name")`, not `game.Name`.
- Use `local` everywhere. No globals.
- `:WaitForChild()` on the client for replicated objects. Avoid it on the server for things the server itself creates.
- Disconnect connections you no longer need, or clean up with a Trove/Maid pattern. Watch for leaks in `PlayerAdded`/`CharacterAdded`.
- Use `Instance.new(class)` then set properties, then set `Parent` last.
- Prefer `CollectionService` tags over scanning the workspace.
- Use `RunService.Heartbeat` for per-frame server work, `RenderStepped` only for camera/visual client work.

## Security — never trust the client

- Every `RemoteEvent.OnServerEvent` / `RemoteFunction.OnServerInvoke` handler must validate types, ranges, distance, cooldowns and ownership on the server.
- The client sends intent ("I want to buy X"); the server checks price, currency and stock and applies the result.
- Never let the client set its own health, money, damage or position authority.
- Don't use `RemoteFunction:InvokeClient` from the server — a client can hang it.
- Rate-limit remotes per player.

## Data

- Use `DataStoreService` only from the server. Wrap calls in `pcall` and retry with backoff.
- Prefer `UpdateAsync` over `SetAsync` for player data. Save on `PlayerRemoving` and in `game:BindToClose`.
- Don't write to DataStores from `execute_luau`; it can touch real player data when API access is on.

## Performance

- Keep part counts and unanchored physics low. Anchor static parts.
- Use `StreamingEnabled` for big maps.
- Avoid tight loops without `task.wait()`.
- Cache `GetService` results and frequently used instances in locals.

## When finishing a task

Report what changed (instance paths and scripts), what you tested in play mode, and anything the user must do by hand (publishing, enabling API access, game settings).
