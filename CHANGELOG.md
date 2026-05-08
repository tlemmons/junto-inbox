# Changelog

All notable changes to junto-inbox are documented here. Versions before
v0.0.14 shipped under the package name `cterm-inbox`.

## v0.0.16

- **Heal stale `session_id` across host `/clear + go` cycles.** The plugin's
  session_id was effectively pinned for the plugin process lifetime; the
  v0.0.11 30s heartbeat detected death but left a window where a new persona's
  `go` macro called `get_session_id` between heartbeat ticks and got back the
  stale id. `get_session_id` now fires `memory_heartbeat` inline as a liveness
  check, and `send_message` now inspects `isError` on the response. Both paths
  null `sessionId`, trigger supervisor reconnect, and surface the error so the
  caller falls back per the host CC's CLAUDE.md retry contract.

## v0.0.15

- Drops the v0.0.14 `CT_*` env-var deprecation fallback. `JUNTO_*` only.
- Adds `human_interacted: boolean` to the `send_message` tool input schema and
  passes it through to `memory_send_message`. Sender-asserted; the server
  uses it to reset `effective_chain_depth=0` on autopilot replies that
  followed a human prompt.
- Adds `memory_autopilot_count` poll on each 30s heartbeat and writes the
  snapshot into the status file so `statusline.ts` renders a `current/budget`
  indicator next to the dot.

## v0.0.14

- Rename `cterm-inbox` → `junto-inbox` (Junto suite). Reads `JUNTO_*` env vars
  first and falls back to `CT_*` (deprecated; removed in v0.0.15). Server
  name, client name, server instructions string, status directory
  (`~/.claude/junto-inbox/`), and debug-log filename all updated.

## v0.0.13

- Stop silently dropping messages tagged `require_human=true`. They now
  deliver as normal channel blocks but with `meta.requires_review = "true"`
  and a leading `[REQUIRES REVIEW]` marker on the body. Safety stays on the
  agent side via the CLAUDE.md trust scope. Fixes the dominant failure mode
  where the shared-memory server's destructive-keyword regex over-fired on
  benign prose ("deploy", "production", DELETE) and every flagged message
  vanished without trace.

## v0.0.12

- Status file at `~/.claude/junto-inbox/<project>-<agent>.status` written on
  every state transition (connect / heartbeat success / heartbeat fail /
  supervisor catch / shutdown). Designed to be read by a `statusLine` script
  in Claude Code's `settings.json`.

## v0.0.11

- 30s heartbeat (`memory_heartbeat`) on the bound session. Defends against
  silent server-side session invalidation: the HTTP transport stays connected
  even when the session is dead. Heartbeat both keeps the session warm and
  detects death within 30s, then triggers supervisor reconnect.
- `agentReady` no longer resets to `false` on reconnect — the host CC owns
  the plugin's process lifetime, so a live plugin implies a live host.

## v0.0.10

- Reverts v0.0.9 source-string regression. Empirical verification confirms
  the Channels harness renders path-loaded plugins with `source` = server name
  only, not `plugin:<alias>:<server>`.

## v0.0.8

- Defer all channel delivery until the host agent signals readiness via
  `get_session_id` or `send_message`. Prevents lost-context delivery before
  the agent's `go` macro has loaded its state spec, guidelines, and backlog.

## v0.0.7

- Optional auto-enable of receiver autopilot at bind time
  (`JUNTO_AUTOPILOT_ENABLE=1`). Knobs: `JUNTO_AUTOPILOT_DEPTH_CAP`,
  `JUNTO_AUTOPILOT_BUDGET`. Re-applied on every reconnect.

## v0.0.6

- Env-gates the per-event debug log behind `JUNTO_DEBUG=1`. Default install
  is silent; set the flag to capture traces in `./junto-inbox-debug.log`.

## v0.0.5

- Paginated inbox drain via `memory_get_messages(cursor=...)` so backlogs
  larger than 20 messages don't get stuck. Capped at 50 pages per read.

## v0.0.4

- Adds `get_session_id` tool so the host CC's `go` macro can consume the
  plugin's existing session instead of opening a duplicate
  `memory_start_session` for the same `(project, agent)`.

## v0.0.3

- Client-side `memory_autopilot_check_budget` gate for `chain_depth >= 1`
  messages. `chain_depth=0` (human-originated) always delivered.

## v0.0.2

- Subscribe-mode against the shared-memory MCP server. First production
  version.
