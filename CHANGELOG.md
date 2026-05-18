# Changelog

All notable changes to junto-inbox are documented here. Versions before
v0.0.14 shipped under the package name `cterm-inbox`.

## v0.0.23

Render-side autopilot gate no longer silent-drops cross-agent replies.

### Symptom

A chain_depth>=1 message arriving while the receiver's autopilot is
disabled or budget-exceeded never surfaces in the host CC's input. The
message is in MongoDB (`status:pending`, `delivered:false`), the plugin
process is bound and subscribed (`live_subscribers >= 1`), `_notify_inbox_for_send`
on the server fires correctly — and nothing renders. Only an invisible
stderr line at server.ts:1014 records the drop.

Empirically caught by memory@junto on 2026-05-18: their fresh post-restart
bind rendered two self-sent probes (chain_depth=0, bypass the gate) but
did NOT render an inbound reply at chain_depth=2 from this agent. The
v0.0.22 60s safety net fired correctly; the autopilot gate then silently
swallowed the depth-2 message. Pre-existing in v0.0.21 and earlier;
caught now because the v0.0.22 safety-net fix exposed cross-agent
replies that previously never made it past the agentReady gate either.

### Cause

`deliverNew` at server.ts:1004 calls `memory_autopilot_check_budget` for
chain_depth>=1 messages. On `allowed=false` the loop did `continue`
without `seenIds.add(id)` — so the message was both undelivered and
re-evaluated on every poll. If autopilot was disabled at bind (and no
event flipped it on later), the loop continued forever. If the budget
flipped back to allowed mid-flight, the message would suddenly deliver
without any indicator it had been gated. Both outcomes are bad UX.

The deeper issue is concern-mixing: the receiver-side gate was acting
as both a render decision AND an auto-reply decision. Auto-reply belongs
on the send side (server enforces via `memory_send_message` accounting +
the `enabled=False` flip); render should be unconditional so the
human-in-the-loop can manually act.

### Fix

Render either way. Always `seenIds.add(id)`. On gate denial, prepend a
`[AUTOPILOT GATED — <reason>]` marker (alongside the existing
`[REQUIRES REVIEW]` marker if both apply) and emit
`meta.autopilot_gated="true"` so the host CC knows not to auto-reply.
Stderr log unchanged. Server-side send-time budget enforcement is the
correct boundary and is unchanged.

### Adopter notes

- Hosts that auto-process inbound channel blocks should check
  `meta.autopilot_gated`; if `"true"`, skip the auto-reply pass and
  defer to human-in-the-loop.
- This is a renderer change only — no migration, no env vars, no
  contract change with the shared-memory server.
- Cosmetic: also bumps the `junto-inbox-health` Client version string
  at server.ts:516 from `'0.0.21'` to `'0.0.23'` (was missed in v0.0.22).

## v0.0.22

Two fixes for adopter visibility — both surfaced by memory@junto's first
real `--channels` cutover dogfood (`msg_8267f2740eb6`).

### agentReady silent-drop bug

**Symptom.** Plugin is fully bound (`state: "connected"`, `live_subscribers: 1`),
the server's `_notify_inbox_for_send` fires correctly on every send, but
*no* `<channel source="junto-inbox" …>` block ever surfaces in the host
CC's input. Messages reach the server, server reaches the plugin, plugin
silently drops them. Memory hit this for ~11 minutes on a real session
until Tom verbally surfaced "you have new messages" — at which point
memory called `get_session_id` mid-turn and the inbox drained immediately.

**Cause.** v0.0.8 introduced an `agentReady` gate
(`server.ts:1042` — `if (!agentReady) return` in `readInboxAndForward`)
with explicit design intent: don't deliver channel blocks until the host
CC has loaded state spec / guidelines / backlog via its `go` macro. The
gate flips only when the host calls the plugin's `get_session_id` or
`send_message` tools. Hosts whose CLAUDE.md routes through
`memory_start_session` directly — including memory@junto's project
CLAUDE.md and the default global `~/.claude/CLAUDE.md` "Shared Memory MCP"
section — never trigger the flip and sit gate-closed indefinitely.

**Fix.** Post-subscribe 60s safety-net timer in `bindAndSubscribe`:
`setTimeout(() => markReady('post-subscribe-timeout'), 60_000)`.
`markReady` is idempotent, so well-behaved hosts (where `get_session_id`
already fired during `go`) see the timer as a no-op. For non-conforming
hosts, the timer bounds the silent-drop window to 60 seconds post-bind.
The v0.0.8 design intent is preserved for the common case; the timer is
a graceful fallback that visible-fails rather than silent-fails.

**Companion docs.** Memory@junto is drafting project-CLAUDE.md and
proposed global-CLAUDE.md amendments so well-behaved hosts call
`get_session_id` first. README install steps will also call out the
contract. Together they're belt-and-suspenders: the plugin no longer
relies *entirely* on host behavior, but a host that follows the contract
gets pushes within seconds instead of waiting 60s for the safety net.

### boot-failed status state

`PluginStatus` type extended with `'boot-failed'`. New module-level
`everConnected` flag set true on first successful `bindAndSubscribe`;
supervisor catch writes `'boot-failed'` before first success and
`'reconnecting'` after. Operators (and the statusline) can now
distinguish "never worked, check URL/network/auth" from "worked before,
currently retrying". Helps adopters diagnose initial-config issues
without grepping stderr.

## v0.0.21

Fixes the ghost-session healing loop that v0.0.16 was supposed to close
(`learning_782be7ee1b938dd1` recurred — the v0.0.16 fix did not actually
prevent it; this version does).

**Symptom.** Plugin holds a stale `session_id` indefinitely. Statusline
reports `ONLINE` and the status file's `state` field reads `"connected"`,
yet every `memory_*` call returns
`ERROR: Session 'X' not found. Call memory_start_session first to register
your session.` and no reconnect ever fires.

**Cause.** The shared-memory MCP server signals session-not-found via
*content text* with an `"ERROR:"` prefix, **not** via the MCP envelope's
`isError` flag. v0.0.16's healing paths (`heartbeatOnce`, `send_message`,
`drainJournal`, `junto_journal_replay`) all checked
`result.isError === true` only, so:

- The 30s background heartbeat silently passed forever (response body was
  `ERROR:...` but `isError` was unset).
- The supervisor's reconnect promise never rejected.
- `bindAndSubscribe` never re-ran.
- `sessionId` stayed pinned at the dead value.

**Fix.** New `unwrapToolError(res)` helper returns the error text whether
the server signalled via `isError=true` **or** via an `ERROR:` content-text
prefix; returns `null` on actual success. All four call sites use it.
Behaviour is identical when the server DOES set `isError`, so this is
forward-compat with a future server-side change to standard MCP error
semantics.

**Diagnosis.** Empirically confirmed by calling
`memory_heartbeat(session_id="<known-stale>")` directly and observing the
wrapper shape `{"result":"ERROR: Session ... not found..."}` — identical
in envelope to a success response.

No new env vars. No host-CC contract changes. No `plugin.json` bump
(stays at 0.0.17 pending the separate Tom-gated drift fix).

## v0.0.20

Phase 0 capture mechanism per `design:local-first-junto-v0-mvp` v0.3.0 §8.
The remaining 12 mutation tools beyond `send_message` are now journaled
on `OFFLINE`, plus three operator-review tools and the v1 journal entry
schema finalized.

- **`PreToolUse` hook (`hook.ts`).** Standalone Bun TS script wired into
  per-agent `.claude/settings.json` with matcher `mcp__shared-memory__memory_*`.
  Reads the plugin status file at
  `~/.claude/junto-inbox/<project>-<agent>.status`; if
  `health_state="offline"` AND the tool is in `schema.ts`'s
  `CAPTURE_SET` (13 tools), generates a v1 journal entry with a
  fresh `intent_id` (UUID4), appends it to
  `~/.junto/journal/<project>-<agent>.journal.jsonl`, and returns
  `permissionDecision: "deny"` with a structured reason — the actual
  shared-memory call is blocked. On online OR for deny-list (read)
  tools, the hook is a no-op. Hook fails open (allows the call) when
  `JUNTO_PROJECT`/`JUNTO_AGENT` env vars are missing or when the
  status file is unparseable — graceful-degradation property called
  out in spec §8.
- **Journal entry schema v1 finalized.** Each entry now carries
  `queue_id`, `queued_at`, `intent_id` (threaded to server on replay
  via `__intent_id` MCP param for op-log dedupe per spec §4.6),
  `tool_name` (full `mcp__shared-memory__memory_*` name),
  `args` (session_id stripped), `actor` (`{project, agent}`),
  `op_type` (§4.1 catalog value), and `schema_version: 1`.
  `loadJournal` upgrades legacy v0.0.18/v0.0.19 entries on read —
  back-derives `tool_name` for the send_message-only legacy case,
  fills missing fields, normalizes `op_type` (e.g.
  `"send_message"` → `"message.sent"`).
- **Operator-review tools.** Three new plugin tools registered alongside
  `send_message` and `get_session_id`:
  - `junto_journal_list()` — returns a summary of journaled entries
    (top-level `arg_keys` only; full payloads are on disk). Reloads
    from disk on each call so hook-written entries are visible
    without restarting the plugin.
  - `junto_journal_replay(queue_id)` — replays one entry through the
    bound session, threading `__intent_id=<entry.intent_id>`. On
    success: removes from journal. On isError or transport error:
    leaves entry in place so the operator can fix args / retry.
  - `junto_journal_discard(queue_id)` — drops one entry without
    replaying. Purely local; no server interaction.
- **`drainJournal` threads `__intent_id`.** The auto-drain path for
  `tool_name === SEND_MESSAGE_TOOL` now passes the entry's
  `intent_id` back to the server on every replay, so once Phase 1
  op-log ships, cross-retry duplicate writes can be deduped.
- **Shared schema module (`schema.ts`).** New file holding
  `CAPTURE_SET`, `DENY_LIST`, `TOOL_OP_TYPE_MAP`, `JournalEntry`
  type, and path/factory helpers (`statusFilePath`, `journalFilePath`,
  `makeJournalEntry`, `normalizeLegacyEntry`). Imported by both
  `server.ts` and `hook.ts` so they cannot drift on which tools are
  captured vs denied.

**Coverage boundary (explicit MVP property):** Phase 0 protects against
silent loss for the 13 capture-set tools **only when the hook is
configured in `.claude/settings.json`**. Without the hook,
`send_message` IS still journaled (plugin's tool handler), but the
other 12 mutation tools fall through to the live MCP path and may
silently succeed during a transport half-open window. The structural
fix for half-open silent-success is server-side op-log + `intent_id`
reconciliation (Phase 1).

**Known race window (accepted in MVP):** The hook and the plugin's
`send_message` handler can both write to the journal file when offline.
The plugin uses full-rewrite (`persistJournal`); the hook uses
append-only. A concurrent plugin-rewrite during a hook-append can lose
the hook entry. The window is microseconds. Phase 1's server-side
op-log `intent_id` dedupe heals any duplicate replays that result.

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
