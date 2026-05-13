# Changelog

All notable changes to junto-inbox are documented here. Versions before
v0.0.14 shipped under the package name `cterm-inbox`.

## v0.0.19

Phase 0 of `design:local-first-junto-v0-mvp` v0.2.0. Three additions on top
of v0.0.18's outbox foundation.

- **Sessionless health poller.** Background loop calls `memory_health` every
  12s via an independent MCP client (no session required, added server-side
  by junto-memory v1.29.0). After 3 consecutive failures (~45s window) the
  plugin enters `health_state="offline"`; recovers to `"online"` on the next
  success. Failure detection is independent of the bound-session heartbeat:
  the latter only watches our specific session's aliveness, while
  `memory_health` watches whether the server is reachable at all.
- **Statusline OFFLINE indicator + journal-count badge.** Status-file format
  gains `health_state` (`online`/`offline`) and `journal_count` (queued
  mutations). `statusline.ts` renders OFFLINE in bold red overriding the
  normal connected/reconnecting glyph coloring, plus a `j:N` badge whenever
  the journal is non-empty (yellow online — catching up; red offline — stuck).
- **Autopilot pause while OFFLINE.** `readInboxAndForward` becomes a no-op
  while `health_state="offline"` so the host CC doesn't autopilot-reply
  against a dead server (its replies would queue locally and never deliver
  in time to matter). On health recovery (`offline`→`online`) the journal
  drains and the inbox is read opportunistically.
- **File-path migration: outbox → journal at new path.** `~/.claude/junto-inbox/
  <P>-<A>.outbox.jsonl` → `~/.junto/journal/<P>-<A>.journal.jsonl` on first
  v0.0.19 startup. One-shot, idempotent (won't clobber if the new path
  already exists). Internal rename: `outbox` → `journal` everywhere.
  Status file stays at `~/.claude/junto-inbox/` — `statusline.ts` reads
  that path, no change needed there. Per memory's coordination: once the
  journal spans more than just plugin-internal state, the `~/.junto/`
  namespace fits better than the Claude-Code-local `~/.claude/`.
- **Entry format gains `op_type`.** Forward-compat for the broader Phase 0
  mutation list (memory_record_learning, memory_store, memory_define_spec,
  etc — 13 tools total per memory's spec §4.1 op_type catalog). v0.0.19
  still only captures `send_message`; the other 12 await a capture-mechanism
  decision (plugin proxy vs PreToolUse hook — coordination in flight with
  memory@junto). Legacy v0.0.18 entries lack `op_type` and default to
  `"send_message"` on load.

**Honest scope vs the full Phase 0 spec:**
- Heartbeat + statusline + autopilot-pause + file migration: shipped.
- Journal capture: still send_message only (matches v0.0.18 scope).
- Operator-review tools (`junto_journal_list/_replay/_discard`): not in
  this version — only needed once non-send_message entries can land.
- Silent-success-on-write coverage: NOT addressed by Phase 0 at all per
  memory's reply — that's the half-open-TCP failure class that requires
  Phase 1+ server-side op-log. v0.0.19's journal protects against
  `sm==null` and explicit transport errors only.

## v0.0.18

- **Persistent outbox for offline `send_message`.** When the shared-memory link
  is down (VPN drop, server restart, transport error mid-call), `send_message`
  now writes the request to
  `~/.claude/junto-inbox/<project>-<agent>.outbox.jsonl` and returns
  `{queued:true, queue_id, queue_position, note}` to the caller instead of
  erroring. The supervisor drains the outbox in FIFO order on every successful
  bind, before the inbox-forward step. Capped at 1000 entries; over-cap
  enqueues return `isError`. Transport-level failures mid-drain stop the drain
  and leave remaining items for the next reconnect; server-side `isError`
  responses (other than stale session) drop the offending entry and continue.
  Stale-session detection on a live `send_message` now also queues the message
  rather than dropping it on the floor. Original use case: work machines that
  reach junto-memory over a flaky VPN — previously a `send_message` during a
  VPN drop was lost to the void.

## v0.0.17

- **Loosen session-bind autopilot defaults** from `depth_cap=1, budget=10` to
  `depth_cap=5, budget=30`. Coordinated with the junto-memory gate-ordering fix
  (memory commit `1e5b095`): once that fix is deployed, budget-breach actually
  triggers auto-disable. The old tight defaults would false-pause busy
  human-driven sessions because Bug B (autopilot counter ticks even on
  `human_interacted=true` traffic) is still open. `depth_cap=5` sits at the
  system `CHAIN_DEPTH_HARD_CAP`; Phase D2 recency_bypass remains in force after
  any human interaction. Override knobs unchanged:
  `JUNTO_AUTOPILOT_DEPTH_CAP`, `JUNTO_AUTOPILOT_BUDGET`.

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
