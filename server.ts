#!/usr/bin/env bun
/**
 * junto-inbox: Claude Code channel plugin that bridges the shared-memory MCP
 * server's per-agent inbox into a running CC session, and exposes a reply
 * tool that posts back to other agents' inboxes.
 *
 * Part of the Junto suite (umbrella brand for the multi-agent stack: junto-memory
 * MCP server, junto-inbox channel plugin, junto-control dashboard).
 *
 * v0.0.21 — fixes the ghost-session healing loop that v0.0.16 was supposed to
 *          close (learning_782be7ee1b938dd1 recurred). Symptom: plugin holds a
 *          stale session_id forever, statusline reports ONLINE / state:connected,
 *          every memory_* call returns "ERROR: Session 'X' not found...", and
 *          no reconnect ever fires. Cause: shared-memory server signals
 *          session-not-found via *content text* with an "ERROR:" prefix, NOT
 *          via the MCP envelope's isError flag. v0.0.16's healing paths
 *          (heartbeatOnce, send_message, drainJournal, junto_journal_replay)
 *          all checked res.isError === true only, so the 30s heartbeat
 *          silently passed forever and the supervisor never re-bound. Fix:
 *          new unwrapToolError() helper returns the error text whether the
 *          server signalled via isError=true OR via an "ERROR:" content-text
 *          prefix; null on success. All four call sites updated. Behaviour
 *          identical when the server DOES set isError, so forward-compat with
 *          a future server fix that switches to standard MCP error semantics.
 *          Diagnosed by calling memory_heartbeat with a known-stale id and
 *          observing the wrapper shape identical to a success response.
 *          No new env vars; no host-CC contract changes.
 * v0.0.20 — Phase 0 capture mechanism per design:local-first-junto-v0-mvp v0.3.0
 *          §8: CC PreToolUse hook (hook.ts) captures the 13-tool mutation set
 *          (memory_record_learning, _store, _define_spec, _register_function,
 *          _enrich_function, _add_backlog_item, _batch_backlog, _update_backlog_item,
 *          _complete_backlog_item, _change_status, _archive_by_tag, _restore_by_tag,
 *          plus _send_message which the plugin already handled) when the
 *          plugin status file reports health_state="offline". Hook is no-op
 *          when online; falls back to a graceful-degradation regime (heartbeat
 *          + send_message journal only) when not configured per-agent in
 *          .claude/settings.json. Three coordinated additions in this server:
 *          (1) shared schema module (schema.ts) holds CAPTURE_SET, DENY_LIST,
 *          TOOL_OP_TYPE_MAP, JournalEntry v1 type, and path/factory helpers;
 *          imported by both server.ts and hook.ts so they cannot drift.
 *          (2) Journal entry schema finalized at v1 (queue_id, queued_at,
 *          intent_id, tool_name, args sans session_id, actor{project,agent},
 *          op_type per §4.1 catalog, schema_version=1). loadJournal upgrades
 *          legacy v0.0.18/v0.0.19 entries on read — back-derives tool_name
 *          for send_message-only legacy case, fills missing intent_id/actor/
 *          schema_version, normalizes op_type to its §4.1 value. drainJournal
 *          now threads __intent_id back to the server on replay so the
 *          (Phase 1) op-log can dedupe across crash/retry windows per §4.6.
 *          (3) Three new tools — junto_journal_list (read; reloads from disk
 *          to pick up hook writes), junto_journal_replay(queue_id) (replays
 *          one entry through the bound session with __intent_id; success ->
 *          removes), junto_journal_discard(queue_id) (removes without replay).
 *          Operator-review surface for the 12 non-send_message captures;
 *          send_message still auto-drains. Coverage boundary: with hook NOT
 *          configured, only memory_send_message is journaled — the other 12
 *          tools fall through to the live MCP path and may silently succeed.
 *          README + sample .claude/settings.json document the hook wiring.
 * v0.0.19 — Phase 0 of design:local-first-junto-v0-mvp. Three additions on top
 *          of v0.0.18: (1) sessionless health poller calling memory_health
 *          every 12s; after 3 consecutive failures (~45s window), declares
 *          OFFLINE; recovery on next success. (2) Statusline OFFLINE indicator
 *          + journal-count badge — file format gains health_state and
 *          journal_count fields, statusline renders them. (3) While OFFLINE,
 *          readInboxAndForward becomes a no-op so the host CC doesn't try to
 *          autopilot-reply against a dead server (its replies would queue
 *          locally and never actually deliver in time to matter). On recovery
 *          (offline→online) the journal drains and the inbox is read.
 *          File-path migration: ~/.claude/junto-inbox/<P>-<A>.outbox.jsonl →
 *          ~/.junto/journal/<P>-<A>.journal.jsonl on first v0.0.19 startup
 *          (one-shot, idempotent — won't clobber if new path already exists).
 *          Internal rename: outbox → journal everywhere. Entries gain an
 *          op_type field (forward-compat; legacy entries default to
 *          "send_message"). Status file moves from ~/.claude/junto-inbox/...
 *          stays put — statusline.ts reads that path; the journal file is the
 *          only thing that moves. Honest scope: this v0.0.19 still only
 *          captures send_message; the other 12 mutation tools listed in
 *          memory's Phase 0 spec await a capture-mechanism decision (proxy vs
 *          PreToolUse hook). Heartbeat + statusline + autopilot-pause are
 *          fully shipped. Coverage is partial vs the spec's full Phase 0 list,
 *          and partial vs the silent-success-on-write failure class memory
 *          flagged in its reply (that's Phase 1+ territory).
 * v0.0.18 — persistent outbox for offline send_message. When the shared-memory
 *          link is down (VPN drop, server restart, transport error mid-call),
 *          send_message now writes the request to
 *          ~/.claude/junto-inbox/<project>-<agent>.outbox.jsonl and returns
 *          {queued:true, queue_id, queue_position} to the caller instead of
 *          erroring. The supervisor drains the outbox in order on every
 *          successful bind, before the inbox-forward step. Capped at 1000
 *          entries; over-cap enqueues return isError. Transport-level failures
 *          mid-drain stop the drain and leave remaining items for the next
 *          reconnect; server-side isError responses (other than stale session)
 *          drop the offending entry and continue. Original use case: work
 *          machines that reach junto-memory over a flaky VPN — previously a
 *          send_message during a VPN drop was lost to the void.
 * v0.0.17 — loosens session-bind autopilot defaults from depth_cap=1, budget=10
 *          to depth_cap=5, budget=30. Coordinated with junto-memory's
 *          gate-ordering fix (commit 1e5b095): once that fix deploys,
 *          budget-breach actually triggers auto-disable, so the prior
 *          tight defaults would false-pause busy human-driven sessions
 *          where every reply is human_interacted=true (Bug B, backlog
 *          ae420dedf280, still open — counter currently ticks regardless
 *          of human_interacted). depth_cap=5 sits at the system
 *          CHAIN_DEPTH_HARD_CAP, with Phase D2 recency_bypass still in
 *          force; Tom's call, "team is working together well." Knobs
 *          unchanged: JUNTO_AUTOPILOT_DEPTH_CAP, JUNTO_AUTOPILOT_BUDGET
 *          override the new defaults.
 * v0.0.16 — fixes stale-session-id survival across /clear + go (backlog_ebee2551b430).
 *          The plugin's session_id was effectively pinned for the plugin
 *          process lifetime; the v0.0.11 30s heartbeat detected death but
 *          left a window where a new persona's `go` macro called
 *          get_session_id between heartbeat ticks and got the stale ID
 *          back. Two changes: (a) get_session_id now fires heartbeatOnce
 *          inline as a liveness check, and on failure nulls sessionId,
 *          triggers supervisor reconnect, and returns not_ready (the
 *          persona's CLAUDE.md retry loop then picks up the fresh ID
 *          within ~2-6s); (b) send_message now inspects isError on the
 *          memory_send_message response — "Session not found" coming back
 *          via isError=true had been silently parsed as a normal success
 *          payload by callMemory, so send_message returned an
 *          error-message-as-success body to the caller. Both paths now
 *          share a triggerReconnect module ref that the supervisor
 *          installs as its current Promise reject. No new env vars; no
 *          changes to the host CC contract — get_session_id's not_ready
 *          shape was already documented in v0.0.4.
 * v0.0.15 — drops the v0.0.14 CT_* env-var deprecation fallback (JUNTO_* only
 *          now). Adds `human_interacted: boolean` (default false) to the
 *          send_message tool input schema and passes it through to
 *          memory_send_message — sender-asserted flag that the server uses to
 *          reset effective_chain_depth=0 on autopilot replies that followed a
 *          human prompt (per design Approach A; see learning_8f5). Adds
 *          memory_autopilot_count poll on each heartbeat and writes the
 *          {current_count, hourly_budget, depth_cap, enabled, paused_at,
 *          paused_reason} block into the status file so statusline.ts can
 *          render a `5/10` budget indicator next to the dot. autopilot_count
 *          is a no-event observability tool (vs autopilot_check_budget which
 *          inserts an event), so polling it on the heartbeat is cheap and does
 *          not eat the receiver's own budget.
 * v0.0.14 — rename cterm-inbox -> junto-inbox. Reads JUNTO_* env vars first and
 *          falls back to CT_* (deprecated; removed in v0.0.15). Server name +
 *          Client name + Server instructions string + status directory
 *          (~/.claude/junto-inbox/) + debug-log filename all updated. CT_*
 *          fallback emitted a one-shot stderr deprecation line per env var seen.
 *          Channel source string is expected to render as "junto-inbox" for
 *          path-loaded plugins (verified empirically for cterm-inbox in v0.0.10
 *          commit; needs production re-verification on first restart).
 * v0.0.13 — stops silently dropping messages tagged require_human=true. They
 *          now deliver as normal channel blocks but with meta.requires_review
 *          = "true" and a leading [REQUIRES REVIEW] marker on the body so the
 *          agent (and Tom in the terminal) sees them clearly. Safety stays on
 *          the agent side via the CLAUDE.md trust scope (T7) — refuse
 *          destructive ops without explicit terminal-side confirmation. Fixes
 *          the dominant failure mode where shared-memory's destructive_match
 *          regex over-fires on benign prose ("deploy", "production", DELETE)
 *          and every flagged message vanished without trace.
 * v0.0.12 — writes a status file at ~/.claude/cterm-inbox/<project>-<agent>.status
 *          on every state transition (connect / heartbeat success / heartbeat
 *          fail / supervisor catch / shutdown). Designed to be read by a
 *          statusLine script in Claude Code's settings.json so the user can
 *          see plugin health at a glance. Best-effort writes — failures are
 *          swallowed so a flaky filesystem can't crash the supervisor.
 * v0.0.11 — adds 30s heartbeat (memory_heartbeat) on the bound session.
 *          Defends against silent server-side session invalidation
 *          (cleanup_stale_sessions, server restart): the HTTP transport stays
 *          connected so transport.onclose never fires, but the session_id is
 *          dead — every subsequent tool call gets "Session not found" and the
 *          plugin holds a corpse. Heartbeat both keeps the session warm AND
 *          detects death within 30s, then triggers supervisor reconnect by
 *          rejecting the supervisor's wait-promise.
 *          Also stops resetting agentReady=false on reconnect: the host CC
 *          process owns the plugin's lifetime; if the plugin is alive at all,
 *          the host is alive, and once the host has acknowledged readiness
 *          there's no reason to require a fresh ack after every reconnect
 *          (which the host has no trigger to perform).
 * v0.0.10 — reverts v0.0.9 source-string regression. Empirical verification
 *          (msg_99353bf7e843 → msg_301823a90450) confirms the harness
 *          renders path-loaded plugins with source = server name only,
 *          not `plugin:<alias>:<server>`.
 * v0.0.8 — defer all channel delivery until the agent signals readiness.
 *          The agent's `go` macro is what loads state spec / guidelines /
 *          backlog; before that runs, the agent has no context for inbound
 *          peer messages. Plugin now holds the inbox until the agent calls
 *          `get_session_id` or `send_message` (either is treated as "I am
 *          live, drain to me"). Side-effect: new messages that arrive between
 *          bind and ready are NOT lost — the next readInboxAndForward picks
 *          them up at flush.
 * v0.0.7 — optional auto-enable of receiver autopilot at bind time. Set
 *          CT_AUTOPILOT_ENABLE=1 to have the plugin call memory_set_autopilot
 *          for (project, agent) right after session establishment so chain
 *          replies (depth>=1) flow without manual config. Knobs:
 *          CT_AUTOPILOT_DEPTH_CAP (default 1), CT_AUTOPILOT_BUDGET (default 10).
 *          (Defaults raised to 5/30 in v0.0.17.)
 *          Idempotent: re-applies on every reconnect. Server-side budget
 *          breach can still flip enabled=false; that flip persists until the
 *          next plugin reconnect re-applies the env-driven config.
 * v0.0.6 — env-gates the cterm-inbox-debug.log writes behind CT_DEBUG=1.
 *          Default install is silent; set CT_DEBUG=1 to capture per-event
 *          traces in ./cterm-inbox-debug.log. process.stderr is unchanged
 *          (CC captures it in ~/.claude/debug/<session>.txt).
 * v0.0.5 — paginates the inbox drain via memory_get_messages(cursor=...) so
 *          backlogs >20 messages don't get stuck. Capped at 50 pages per
 *          read to bound the worst case.
 * v0.0.4 — adds get_session_id tool so the host CC's CLAUDE.md `go` macro can
 *          consume the plugin's existing session instead of opening a duplicate
 *          memory_start_session for the same (project, agent).
 * v0.0.3 — adds client-side autopilot_check_budget gate for chain_depth >= 1
 *          messages (chain_depth=0 / human-originated always delivered).
 * v0.0.2 — subscribe-mode against shared-memory C2 (commits 559ef06 + d3b2391).
 *
 * Lifecycle (per msg_313ad7f23de6 — must run on the SAME MCP client connection):
 *   1. memory_start_session(project, claude_instance) — binds transport to agent identity
 *   2. subscribeResource("inbox://<project>/<agent>")
 *   3. on ResourceUpdatedNotification(uri): readResource(uri), forward new messages
 *   4. memory_end_session on shutdown
 *
 * Reconnect: subscriptions and the agent binding live in the server's process
 * memory only — not durable across server restart. On reconnect re-run the
 * full lifecycle from step 1.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import {
  CAPTURE_SET,
  JournalEntry,
  SEND_MESSAGE_TOOL,
  TOOL_OP_TYPE_MAP,
  journalFilePath,
  makeJournalEntry,
  normalizeLegacyEntry,
  statusFilePath,
} from './schema.ts'

function envVar(name: string): string | undefined {
  const v = process.env[`JUNTO_${name}`]
  return v !== undefined && v !== '' ? v : undefined
}

const DEBUG = envVar('DEBUG') === '1' || envVar('DEBUG') === 'true'
const DEBUG_LOG = join(process.cwd(), 'junto-inbox-debug.log')

function debugLog(line: string): void {
  if (!DEBUG) return
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    // best-effort
  }
}

if (DEBUG) {
  const juntoEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith('JUNTO_')),
  )
  debugLog(`pid=${process.pid} cwd=${process.cwd()} env=${JSON.stringify(juntoEnv)}`)
}

const URL_DEFAULT = 'http://localhost:8080/mcp'
const SHARED_URL = envVar('SHARED_MEMORY_URL') ?? URL_DEFAULT
const PROJECT = envVar('PROJECT')
const AGENT = envVar('AGENT')
const API_KEY = envVar('API_KEY') ?? null
const ROLE = envVar('ROLE') ?? null
const AUTOPILOT_ENABLE = envVar('AUTOPILOT_ENABLE') === '1' || envVar('AUTOPILOT_ENABLE') === 'true'
const AUTOPILOT_DEPTH_CAP = Number(envVar('AUTOPILOT_DEPTH_CAP') ?? 5)
const AUTOPILOT_BUDGET = Number(envVar('AUTOPILOT_BUDGET') ?? 30)

if (!PROJECT || !AGENT) {
  process.stderr.write('junto-inbox: JUNTO_PROJECT and JUNTO_AGENT must be set\n')
  debugLog(`pid=${process.pid} EXIT 2: missing JUNTO_PROJECT or JUNTO_AGENT`)
  process.exit(2)
}

const INBOX_URI = `inbox://${PROJECT}/${AGENT}`
const STATUS_FILE = statusFilePath(PROJECT, AGENT)
const STATUS_DIR = dirname(STATUS_FILE)
const JOURNAL_FILE = journalFilePath(PROJECT, AGENT)
const JOURNAL_DIR = dirname(JOURNAL_FILE)
const LEGACY_OUTBOX_FILE = join(STATUS_DIR, `${PROJECT}-${AGENT}.outbox.jsonl`)
const JOURNAL_CAP = 1000
const HEALTH_INTERVAL_MS = 12_000
const OFFLINE_FAIL_THRESHOLD = 3
const ACTOR = { project: PROJECT, agent: AGENT }
let statusDirCreated = false
let journalDirCreated = false

type PluginStatus = 'connected' | 'reconnecting' | 'shutdown'

function writeStatus(state: PluginStatus, extras: Record<string, unknown> = {}): void {
  try {
    if (!statusDirCreated) {
      mkdirSync(STATUS_DIR, { recursive: true })
      statusDirCreated = true
    }
    const payload = JSON.stringify({
      state,
      project: PROJECT,
      agent: AGENT,
      session_id: sessionId,
      pid: process.pid,
      last_update: new Date().toISOString(),
      health_state: healthState,
      journal_count: journal.length,
      ...extras,
    })
    writeFileSync(STATUS_FILE, payload)
  } catch {
    // best-effort — never let a status-file write crash the supervisor
  }
}

// Persistent journal for offline mutation tool calls. v0.0.20 finalizes the
// schema at v1 per design:local-first-junto-v0-mvp §8: each entry carries
// queue_id, queued_at, intent_id, tool_name (full mcp__shared-memory__...
// name), args (session_id stripped), actor {project, agent}, op_type (§4.1
// catalog value), and schema_version. Three populations of writers now:
//   1. send_message tool handler (this file) — when the bound session is
//      down OR a transport error fires mid-call. Capture target since v0.0.18.
//   2. PreToolUse hook script (hook.ts) — when the plugin is OFFLINE per the
//      health poller. Captures the 13-tool capture-set. New in v0.0.20.
//   3. (Phase 1) on-server failure response. Not in scope here.
// The plugin auto-drains tool_name === SEND_MESSAGE_TOOL entries on bind
// recovery (the only auto-replay-safe op_type); other entries wait for
// operator review via junto_journal_replay (idempotent through intent_id).
let journal: JournalEntry[] = []
let isDraining = false

function migrateOutboxToJournal(): void {
  try {
    if (!existsSync(LEGACY_OUTBOX_FILE)) return
    if (existsSync(JOURNAL_FILE)) {
      // New file already present — never clobber. The legacy file is stale.
      process.stderr.write(`junto-inbox: legacy outbox ${LEGACY_OUTBOX_FILE} present but journal already exists at new path — leaving legacy alone\n`)
      debugLog(`migrateOutboxToJournal: both files present, no-op`)
      return
    }
    if (!journalDirCreated) {
      mkdirSync(JOURNAL_DIR, { recursive: true })
      journalDirCreated = true
    }
    renameSync(LEGACY_OUTBOX_FILE, JOURNAL_FILE)
    process.stderr.write(`junto-inbox: migrated ${LEGACY_OUTBOX_FILE} → ${JOURNAL_FILE}\n`)
    debugLog(`migrateOutboxToJournal: success`)
  } catch (err) {
    debugLog(`migrateOutboxToJournal: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function loadJournal(): void {
  try {
    if (!existsSync(JOURNAL_FILE)) return
    const raw = readFileSync(JOURNAL_FILE, 'utf8')
    journal = raw
      .split('\n')
      .filter((line: string) => line.trim().length > 0)
      .map((line: string): JournalEntry | null => {
        try {
          const parsed = JSON.parse(line) as Partial<JournalEntry> & { op_type?: string }
          // normalizeLegacyEntry handles every pre-v0.0.20 shape: it back-
          // derives tool_name from op_type for the send_message-only legacy
          // case, fills missing intent_id/actor/schema_version, and
          // normalizes op_type to its §4.1 catalog value.
          return normalizeLegacyEntry(parsed, ACTOR)
        } catch {
          return null
        }
      })
      .filter((x: JournalEntry | null): x is JournalEntry => x !== null)
    if (journal.length > 0) {
      process.stderr.write(`junto-inbox: loaded ${journal.length} journaled mutation(s) from journal\n`)
      debugLog(`loadJournal: ${journal.length} entries`)
    }
  } catch (err) {
    debugLog(`loadJournal: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function persistJournal(): void {
  try {
    if (!journalDirCreated) {
      mkdirSync(JOURNAL_DIR, { recursive: true })
      journalDirCreated = true
    }
    const body = journal.length === 0 ? '' : journal.map(q => JSON.stringify(q)).join('\n') + '\n'
    writeFileSync(JOURNAL_FILE, body)
  } catch (err) {
    debugLog(`persistJournal: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function enqueueJournal(toolName: string, args: Record<string, unknown>): { queue_id: string; queue_position: number; intent_id: string } | null {
  if (journal.length >= JOURNAL_CAP) {
    process.stderr.write(`junto-inbox: journal at cap (${JOURNAL_CAP}); refusing to queue\n`)
    return null
  }
  const entry = makeJournalEntry(toolName, args, ACTOR)
  journal.push(entry)
  persistJournal()
  debugLog(`enqueueJournal: ${entry.queue_id} tool=${entry.tool_name} op=${entry.op_type} pos=${journal.length}`)
  return { queue_id: entry.queue_id, queue_position: journal.length, intent_id: entry.intent_id }
}

async function drainJournal(): Promise<void> {
  if (isDraining || journal.length === 0 || !sm || !sessionId) return
  if (healthState === 'offline') {
    // Don't drain while the health poller has the server marked unreachable —
    // sends would just fail and we'd burn cycles. noteHealth's offline→online
    // transition explicitly retriggers this when the server is back.
    debugLog(`drainJournal: skipped, healthState=offline`)
    return
  }
  isDraining = true
  const total = journal.length
  let drained = 0
  let dropped = 0
  try {
    process.stderr.write(`junto-inbox: draining journal (${total} entry(s))\n`)
    debugLog(`drainJournal: start total=${total}`)
    while (journal.length > 0) {
      if (!sm || !sessionId) break
      const head = journal[0]
      // Only send_message auto-replays. Other captured tools (hook-written
      // mutations) wait for operator review via junto_journal_replay — they
      // can't be safely batch-replayed without a human looking at the args
      // first, and the replay path needs to thread __intent_id back to the
      // server for op-log dedupe (§4.6). Stopping at the first non-send
      // entry preserves order: every send_message ahead of a foreign entry
      // drains; nothing after a foreign entry drains until operator clears
      // the head. See learning_e6e.
      if (head.tool_name !== SEND_MESSAGE_TOOL) {
        debugLog(`drainJournal: pausing at non-send_message entry ${head.queue_id} tool=${head.tool_name}`)
        break
      }
      try {
        const result = await sm.callTool({
          name: 'memory_send_message',
          arguments: { session_id: sessionId, ...head.args, __intent_id: head.intent_id },
        })
        const errText = unwrapToolError(result)
        if (errText !== null) {
          if (/session.*not.*found/i.test(errText)) {
            // Leave head in place; supervisor will rebind and try again.
            forceReconnect(`drainJournal saw stale session_id (${errText})`)
            break
          }
          // Other server-side rejection (malformed args, missing parent, etc).
          // Retrying won't help — drop the entry and continue.
          process.stderr.write(`junto-inbox: dropping journal entry ${head.queue_id}: ${errText}\n`)
          debugLog(`drainJournal: drop ${head.queue_id} reason="${errText}"`)
          journal.shift()
          persistJournal()
          dropped++
          continue
        }
        journal.shift()
        persistJournal()
        drained++
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        process.stderr.write(`junto-inbox: drainJournal interrupted (${m}); will retry on next reconnect\n`)
        debugLog(`drainJournal: transport error ${m}`)
        break
      }
    }
  } finally {
    isDraining = false
    debugLog(`drainJournal: end drained=${drained} dropped=${dropped} remaining=${journal.length}`)
  }
}

// Sessionless health probe — runs continuously regardless of bound-session
// state. After OFFLINE_FAIL_THRESHOLD consecutive failures (~45s at 12s
// interval), the plugin enters OFFLINE state: statusline indicator goes red,
// readInboxAndForward becomes a no-op (so the host CC doesn't autopilot-reply
// against a dead server, which would queue locally and never deliver in
// time to matter). On next successful probe, returns to ONLINE and resumes.
let healthState: 'online' | 'offline' = 'online'
let healthFailCount = 0
let healthTimer: ReturnType<typeof setInterval> | null = null
let healthClient: Client | null = null

async function probeServerHealth(): Promise<boolean> {
  try {
    if (!healthClient) {
      const transport = new StreamableHTTPClientTransport(new URL(SHARED_URL))
      const client = new Client({ name: 'junto-inbox-health', version: '0.0.21' }, { capabilities: {} })
      await client.connect(transport)
      healthClient = client
    }
    const result = await healthClient.callTool({
      name: 'memory_health',
      arguments: { include_storage: true },
    })
    if (result.isError === true) return false
    const content = result.content as Array<{ type: string; text?: string }> | undefined
    const text = content?.find(c => c.type === 'text')?.text
    if (!text) return false
    try {
      const parsed = JSON.parse(text) as { status?: string }
      // 'ok' is the green path; 'degraded' still means server reachable.
      // Anything else (or missing) → unhealthy. memory_health was introduced
      // server-side 2026-05-13 — old servers will return tool-not-found
      // isError, which falls through to false above.
      return parsed.status === 'ok' || parsed.status === 'degraded'
    } catch {
      return false
    }
  } catch {
    // Transport-level failure. Reset client so next attempt rebuilds it.
    try { await healthClient?.close() } catch {}
    healthClient = null
    return false
  }
}

function noteHealth(newHealth: 'online' | 'offline'): void {
  if (healthState === newHealth) return
  const prev = healthState
  healthState = newHealth
  if (newHealth === 'offline') {
    process.stderr.write(`junto-inbox: server unreachable (${OFFLINE_FAIL_THRESHOLD} consecutive memory_health failures) — OFFLINE\n`)
    debugLog(`noteHealth: ${prev}→offline`)
  } else {
    process.stderr.write(`junto-inbox: server reachable — ONLINE\n`)
    debugLog(`noteHealth: ${prev}→online`)
  }
  // Reflect in status file using whichever pluginState the supervisor is in.
  const currentPluginState: PluginStatus = sm ? 'connected' : 'reconnecting'
  writeStatus(currentPluginState, { source: 'health-poller', health_transition: `${prev}->${newHealth}` })
  // On recovery, drain journal and read inbox opportunistically. If we're
  // not bound, the supervisor's bindAndSubscribe will do this; if we ARE
  // bound (transient health flap during a still-alive session), do it now.
  // First reload from disk to pick up any entries the PreToolUse hook
  // appended while we were offline — the plugin's in-memory journal does
  // not observe hook writes until reload.
  if (newHealth === 'online' && sm && sessionId) {
    loadJournal()
    void drainJournal()
    void readInboxAndForward()
  }
}

function startHealthPoller(): void {
  stopHealthPoller()
  healthTimer = setInterval(() => {
    void probeServerHealth().then(ok => {
      if (ok) {
        healthFailCount = 0
        if (healthState === 'offline') noteHealth('online')
      } else {
        healthFailCount++
        debugLog(`probeServerHealth: fail #${healthFailCount}`)
        if (healthFailCount >= OFFLINE_FAIL_THRESHOLD && healthState === 'online') {
          noteHealth('offline')
        }
      }
    })
  }, HEALTH_INTERVAL_MS)
}

function stopHealthPoller(): void {
  if (healthTimer !== null) {
    clearInterval(healthTimer)
    healthTimer = null
  }
}

let sm: Client | null = null
let sessionId: string | null = null
let agentReady = false
const seenIds = new Set<string>()

// Set by the supervisor to its current Promise reject so tool handlers can
// abort the current bind iteration when they detect a dead session
// (heartbeat failure or "Session not found" response). Cleared on
// supervisor catch. Calling it more than once per iteration is a no-op:
// the first call triggers the iteration's catch, which nulls this ref.
let triggerReconnect: ((err: Error) => void) | null = null

function forceReconnect(reason: string): void {
  const err = new Error(reason)
  process.stderr.write(`junto-inbox: ${reason}; forcing reconnect\n`)
  debugLog(`forceReconnect: ${reason}`)
  sessionId = null
  triggerReconnect?.(err)
}

function markReady(via: string): void {
  if (agentReady) return
  agentReady = true
  process.stderr.write(`junto-inbox: agent ready (${via}), draining inbox\n`)
  debugLog(`markReady: signal=${via}, draining inbox`)
  // Fire-and-forget: don't block the tool-call response on the drain.
  void readInboxAndForward()
}

async function callMemory(name: string, args: Record<string, unknown>) {
  if (!sm) throw new Error('shared-memory client not connected')
  const result = await sm.callTool({ name, arguments: args })
  const content = result.content as Array<{ type: string; text?: string }> | undefined
  const textBlock = content?.find(c => c.type === 'text')?.text
  if (!textBlock) return null
  try {
    const parsed = JSON.parse(textBlock)
    return typeof parsed === 'object' && parsed !== null && 'result' in parsed
      ? JSON.parse((parsed as { result: string }).result)
      : parsed
  } catch {
    return textBlock
  }
}

// v0.0.21: shared-memory MCP server signals errors two ways — (a) standard
// MCP isError=true with the error in content text, and (b) a "successful"
// response wrapping an "ERROR: ..." string in content text without isError.
// Session-not-found rejections from memory_heartbeat, memory_send_message,
// and others ship via (b); v0.0.16's isError-only checks missed them and
// left the plugin pinned to a server-rejected sessionId. Returns the error
// text on either shape, null on actual success.
function unwrapToolError(res: { isError?: boolean; content?: unknown }): string | null {
  const text = (res.content as Array<{ type: string; text?: string }> | undefined)
    ?.find(c => c.type === 'text')?.text ?? ''
  if (res.isError === true) return text || '(no body)'
  if (/^ERROR:/i.test(text)) return text
  return null
}

const mcp = new Server(
  { name: 'junto-inbox', version: '0.0.21' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      `Messages from peer agents on the shared-memory MCP server arrive as ` +
      `<channel source="junto-inbox" from_agent="X" chain_depth="N" msg_id="..." project="${PROJECT}">body</channel>. ` +
      `When chain_depth >= 1 you are auto-processing a peer's request; your reply is autopilot-eligible. ` +
      `Reply via the send_message tool, passing the sender as to_agent and the msg_id as in_response_to. ` +
      `Set human_interacted=true on send_message ONLY when a human prompt entered between message receipt and your reply; ` +
      `false on autopilot replies. Honest assertion — the audit log catches abuse retroactively.`,
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_message',
      description: 'Send a message to another agent on the shared-memory MCP server.',
      inputSchema: {
        type: 'object',
        properties: {
          to_agent: { type: 'string', description: 'Target agent name (e.g. "coordinator", "*")' },
          body: { type: 'string', description: 'Message content' },
          to_project: { type: 'string', description: 'Target project (defaults to JUNTO_PROJECT)' },
          in_response_to: { type: 'string', description: 'Parent message id (sets chain_depth = parent + 1)' },
          require_human: { type: 'boolean', description: 'Force human review on the recipient side' },
          human_interacted: {
            type: 'boolean',
            description:
              'Set true ONLY when a human prompt entered between message receipt and this reply; false on autopilot replies. ' +
              'Sender-asserted; the server uses it to reset effective_chain_depth=0 so a fresh human turn does not blow the depth cap. Audit log catches abuse retroactively.',
          },
          priority: { type: 'string', enum: ['urgent', 'normal', 'low'] },
          category: { type: 'string', enum: ['contract', 'task', 'question', 'info', 'review', 'blocker'] },
        },
        required: ['to_agent', 'body'],
      },
    },
    {
      name: 'get_session_id',
      description:
        'Returns the junto-inbox plugin\'s active shared-memory session_id, project, and agent. ' +
        'Call this from the host CC\'s startup macro instead of memory_start_session to avoid ' +
        'opening a duplicate session for the same (project, agent). Returns ' +
        '{status:"not_ready"} if the plugin has not yet bound (cold start or mid-reconnect) — ' +
        'caller should retry after a short delay or fall back to memory_start_session.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'junto_journal_list',
      description:
        'List journal entries written by the PreToolUse hook (or the plugin\'s send_message handler) ' +
        'while the shared-memory server was OFFLINE. Returns a summary array with queue_id, queued_at, ' +
        'tool_name, op_type, intent_id, and an args-summary (top-level keys only — full payloads are not ' +
        'returned to keep the operator-review surface compact). Use junto_journal_replay to retry an ' +
        'entry or junto_journal_discard to drop it. Reloads from disk on every call so hook writes ' +
        'made during the current session are visible without restarting the plugin.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'junto_journal_replay',
      description:
        'Replay one journal entry through the currently bound shared-memory session. Threads the entry\'s ' +
        'intent_id back to the server via the __intent_id MCP param so the Phase 1 op-log can dedupe ' +
        'cross-replay duplicates (spec §4.6). On success: removes the entry from the journal. On server ' +
        'isError: leaves the entry in place and returns the error so the operator can inspect args. ' +
        'On transport error: leaves the entry in place. Requires bound session (sm + sessionId).',
      inputSchema: {
        type: 'object',
        properties: {
          queue_id: { type: 'string', description: 'queue_id of the journal entry to replay' },
        },
        required: ['queue_id'],
      },
    },
    {
      name: 'junto_journal_discard',
      description:
        'Drop one journal entry without replaying. Use when the operator has determined the entry is ' +
        'no longer relevant (stale, duplicate, or otherwise undesired). No server interaction; purely ' +
        'a local journal modification.',
      inputSchema: {
        type: 'object',
        properties: {
          queue_id: { type: 'string', description: 'queue_id of the journal entry to discard' },
        },
        required: ['queue_id'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'get_session_id') {
    // get_session_id is the canonical "I am live" signal from the host CC's
    // go macro. Even if the plugin's underlying session isn't ready yet,
    // mark the agent ready so any later inbox drain delivers to them.
    markReady('get_session_id')
    if (sessionId && sm) {
      // Liveness check: a /clear + go cycle on the host can have ended
      // the plugin's session via the prior persona's memory_end_session,
      // and the 30s heartbeat may not have fired yet. Verify the session
      // is still alive on the server before handing it back; if not,
      // null it out, kick the supervisor into a rebind, and return
      // not_ready so the caller falls back per CLAUDE.md.
      try {
        await heartbeatOnce()
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        forceReconnect(`get_session_id liveness check failed (${m})`)
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'not_ready', project: PROJECT, agent: AGENT }) }],
        }
      }
    }
    if (!sessionId) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ status: 'not_ready', project: PROJECT, agent: AGENT }) }],
      }
    }
    return {
      content: [{ type: 'text', text: JSON.stringify({ status: 'ready', session_id: sessionId, project: PROJECT, agent: AGENT }) }],
    }
  }

  if (req.params.name === 'junto_journal_list') {
    // Reload from disk so hook-written entries land in the operator view
    // even if the plugin process hasn't seen a health transition since.
    loadJournal()
    const summary = journal.map(e => ({
      queue_id: e.queue_id,
      queued_at: e.queued_at,
      intent_id: e.intent_id,
      tool_name: e.tool_name,
      op_type: e.op_type,
      actor: e.actor,
      // top-level keys of args only — full payloads can be large (storing
      // entire learning bodies, spec content, etc.). Operator can dig
      // deeper via the journal file on disk if needed.
      arg_keys: Object.keys(e.args),
    }))
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ count: summary.length, entries: summary, journal_file: JOURNAL_FILE }),
      }],
    }
  }

  if (req.params.name === 'junto_journal_replay') {
    if (!sm || !sessionId) {
      return { content: [{ type: 'text', text: 'junto_journal_replay: no bound session; cannot replay until reconnect' }], isError: true }
    }
    loadJournal()
    const args = (req.params.arguments ?? {}) as { queue_id?: string }
    const queueId = args.queue_id
    if (typeof queueId !== 'string' || queueId.length === 0) {
      return { content: [{ type: 'text', text: 'junto_journal_replay: queue_id required' }], isError: true }
    }
    const idx = journal.findIndex(e => e.queue_id === queueId)
    if (idx < 0) {
      return { content: [{ type: 'text', text: `junto_journal_replay: queue_id ${queueId} not found` }], isError: true }
    }
    const entry = journal[idx]
    // Strip the mcp__shared-memory__ prefix to get the bare tool name the
    // shared-memory MCP server actually exposes. The hook stores the full
    // CC-visible tool_name so it survives across version-skew on adopter
    // agents; the plugin's sm client uses the bare names.
    const bareName = entry.tool_name.replace(/^mcp__shared-memory__/, '')
    try {
      const result = await sm.callTool({
        name: bareName,
        arguments: { session_id: sessionId, ...entry.args, __intent_id: entry.intent_id },
      })
      const errText = unwrapToolError(result)
      if (errText !== null) {
        if (/session.*not.*found/i.test(errText)) {
          forceReconnect(`junto_journal_replay saw stale session_id (${errText})`)
        }
        return { content: [{ type: 'text', text: `junto_journal_replay: server error: ${errText}` }], isError: true }
      }
      const text = (result.content as Array<{ type: string; text?: string }> | undefined)
        ?.find(c => c.type === 'text')?.text ?? ''
      // Success — remove the entry from the journal.
      journal.splice(idx, 1)
      persistJournal()
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            replayed: true,
            queue_id: queueId,
            intent_id: entry.intent_id,
            tool_name: entry.tool_name,
            server_response: text,
            remaining: journal.length,
          }),
        }],
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      return { content: [{ type: 'text', text: `junto_journal_replay: transport error (${m}); entry left in journal` }], isError: true }
    }
  }

  if (req.params.name === 'junto_journal_discard') {
    loadJournal()
    const args = (req.params.arguments ?? {}) as { queue_id?: string }
    const queueId = args.queue_id
    if (typeof queueId !== 'string' || queueId.length === 0) {
      return { content: [{ type: 'text', text: 'junto_journal_discard: queue_id required' }], isError: true }
    }
    const idx = journal.findIndex(e => e.queue_id === queueId)
    if (idx < 0) {
      return { content: [{ type: 'text', text: `junto_journal_discard: queue_id ${queueId} not found` }], isError: true }
    }
    const dropped = journal.splice(idx, 1)[0]
    persistJournal()
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          discarded: true,
          queue_id: queueId,
          tool_name: dropped.tool_name,
          op_type: dropped.op_type,
          remaining: journal.length,
        }),
      }],
    }
  }

  if (req.params.name !== 'send_message') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  }
  // If the agent skipped get_session_id (fell back to memory_start_session),
  // a send_message tool call still proves they're live. Treat it as ready.
  markReady('send_message')
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const sendArgs: Record<string, unknown> = {
    to_instance: args.to_agent as string,
    message: args.body as string,
    to_project: (args.to_project as string | undefined) ?? PROJECT,
    in_response_to: args.in_response_to as string | undefined,
    require_human: args.require_human as boolean | undefined,
    human_interacted: args.human_interacted as boolean | undefined,
    priority: (args.priority as string | undefined) ?? 'normal',
    category: (args.category as string | undefined) ?? 'info',
  }

  // Link known-down → queue. Supervisor's drainJournal will deliver on reconnect.
  if (!sessionId || !sm) {
    const q = enqueueJournal(SEND_MESSAGE_TOOL, sendArgs)
    if (!q) {
      return { content: [{ type: 'text', text: `send_message: journal at capacity (${JOURNAL_CAP}); message rejected` }], isError: true }
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          queued: true,
          queue_id: q.queue_id,
          queue_position: q.queue_position,
          note: 'shared-memory link is down; message will be delivered on reconnect',
        }),
      }],
    }
  }

  try {
    // Direct callTool (not callMemory) so we can inspect both error shapes
    // the server uses (isError=true AND "ERROR:"-prefixed text without
    // isError). v0.0.21: route through unwrapToolError so a stale session
    // is always detected and queued for reconnect; the prior isError-only
    // check missed the more common ERROR-text variant entirely, letting
    // a pinned-sessionId plugin keep silently returning errors to the
    // caller without ever attempting to rebind.
    const result = await sm.callTool({
      name: 'memory_send_message',
      arguments: { session_id: sessionId, ...sendArgs },
    })
    const errText = unwrapToolError(result)
    if (errText !== null) {
      // Stale session — null id, kick supervisor, AND queue the message so
      // it actually goes out once the rebind completes. Prior versions
      // dropped the message on the floor here.
      if (/session.*not.*found/i.test(errText)) {
        forceReconnect(`send_message saw stale session_id (${errText})`)
        const q = enqueueJournal(SEND_MESSAGE_TOOL, sendArgs)
        if (q) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                queued: true,
                queue_id: q.queue_id,
                queue_position: q.queue_position,
                note: 'session was stale; message queued and will be delivered on reconnect',
              }),
            }],
          }
        }
      }
      return { content: [{ type: 'text', text: `send_message: ${errText}` }], isError: true }
    }
    const content = result.content as Array<{ type: string; text?: string }> | undefined
    const text = content?.find(c => c.type === 'text')?.text ?? ''
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    // Transport-level failure (VPN dropped mid-call). Queue rather than lose.
    const m = err instanceof Error ? err.message : String(err)
    const q = enqueueJournal(SEND_MESSAGE_TOOL, sendArgs)
    forceReconnect(`send_message transport error (${m})`)
    if (!q) {
      return { content: [{ type: 'text', text: `send_message: ${m} (journal at capacity; message lost)` }], isError: true }
    }
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          queued: true,
          queue_id: q.queue_id,
          queue_position: q.queue_position,
          note: `transport error (${m}); message queued and will be delivered on reconnect`,
        }),
      }],
    }
  }
})

async function deliverNew(messages: Array<Record<string, unknown>>) {
  for (const m of messages) {
    const id = String(m.id ?? m._id ?? '')
    if (!id || seenIds.has(id)) continue

    const chainDepth = Number(m.chain_depth ?? 0)
    const requiresReview = m.require_human === true

    // chain_depth=0 → human-originated, always deliver.
    // chain_depth>=1 → autopilot reply chain, gate via the receiver's autopilot config.
    // Server flips enabled=False on budget breach and sends a system blocker — no client retry.
    if (chainDepth >= 1) {
      const gate = (await callMemory('memory_autopilot_check_budget', {
        session_id: sessionId,
        project: PROJECT,
        agent: AGENT,
        message_id: id,
        chain_depth: chainDepth,
        require_human: false,
      })) as { allowed?: boolean; reason?: string } | null
      if (gate?.allowed !== true) {
        process.stderr.write(`junto-inbox: msg ${id} (depth ${chainDepth}) gated: ${gate?.reason ?? 'denied'}\n`)
        continue
      }
    }

    // Past the budget gate (or depth=0). Mark seen now so a later retry
    // doesn't re-fire the gate or duplicate-deliver. Gated messages above
    // re-evaluate on next readInbox if autopilot config flips.
    seenIds.add(id)

    const body = String(m.message ?? m.body ?? '')
    const content = requiresReview ? `[REQUIRES REVIEW] ${body}` : body

    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content,
        meta: {
          msg_id: id,
          from_agent: String(m.from ?? m.from_instance ?? 'unknown'),
          from_project: String(m.from_project ?? PROJECT),
          chain_depth: String(chainDepth),
          category: String(m.category ?? 'info'),
          priority: String(m.priority ?? 'normal'),
          ts: String(m.created ?? new Date().toISOString()),
          requires_review: String(requiresReview),
        },
      },
    })
    debugLog(`deliverNew: emitted channel notif id=${id} depth=${chainDepth} review=${requiresReview}`)
  }
}

const MAX_PAGES = 50

type InboxPage = {
  messages?: Array<Record<string, unknown>>
  next_cursor?: string | null
  has_more?: boolean
  error?: string
}

async function readInboxAndForward() {
  if (!sm) return
  if (healthState === 'offline') {
    // Server unreachable (3+ consecutive health failures). Skip delivery so
    // the host CC doesn't autopilot-reply against a dead server — its
    // replies would queue in the journal but the original sender is waiting
    // and the chain breaks. On health recovery (noteHealth offline→online)
    // this function is invoked again to drain whatever piled up.
    debugLog(`readInboxAndForward: skipped, healthState=offline`)
    return
  }
  if (!agentReady) {
    debugLog(`readInboxAndForward: skipped, agent not ready (waiting for get_session_id or send_message)`)
    return
  }
  let cursor: string | null = null
  let pages = 0
  let more = true

  while (more && pages < MAX_PAGES) {
    pages++
    let body: InboxPage
    try {
      if (cursor === null) {
        const result = await sm.readResource({ uri: INBOX_URI })
        const text = (result.contents?.[0] as { text?: string } | undefined)?.text
        if (!text) return
        body = JSON.parse(text) as InboxPage
      } else {
        const res = (await callMemory('memory_get_messages', { session_id: sessionId, cursor })) as InboxPage | null
        if (!res) return
        body = res
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      process.stderr.write(`junto-inbox: read failed (page ${pages}): ${m}\n`)
      debugLog(`readInbox p${pages}: throw=${m}`)
      return
    }

    if (body.error) {
      process.stderr.write(`junto-inbox: read error (page ${pages}): ${body.error}\n`)
      debugLog(`readInbox p${pages}: error=${body.error}`)
      return
    }

    const messages = body.messages ?? []
    debugLog(`readInbox p${pages}: ${messages.length} msgs (ids=${messages.map(m => m.id).join(',')}) has_more=${body.has_more === true} cursor=${body.next_cursor ?? 'null'}`)
    if (messages.length > 0) await deliverNew(messages)

    cursor = body.next_cursor ?? null
    more = body.has_more === true && cursor !== null
  }

  if (more) {
    process.stderr.write(`junto-inbox: pagination cap (${MAX_PAGES}) hit — older messages remain unread\n`)
    debugLog(`readInbox: pagination cap hit at ${pages} pages, has_more still true`)
  }
}

const HEARTBEAT_INTERVAL_MS = 30_000

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
}

// Calls memory_heartbeat directly (not through callMemory) so we can inspect
// both error shapes the server uses. v0.0.21: a "Session not found" comes
// back as content text starting with "ERROR:" without the MCP isError flag
// being set, so we route the response through unwrapToolError to catch
// both isError=true AND the ERROR-text-prefix variant. Throws on either
// signal AND on transport-level errors.
async function heartbeatOnce(): Promise<void> {
  if (!sm || !sessionId) throw new Error('heartbeat: no bound session')
  const res = await sm.callTool({
    name: 'memory_heartbeat',
    arguments: { session_id: sessionId },
  })
  const errText = unwrapToolError(res)
  if (errText !== null) {
    throw new Error(`memory_heartbeat error: ${errText}`)
  }
}

type AutopilotSnapshot = {
  current_count?: number
  hourly_budget?: number
  depth_cap?: number
  enabled?: boolean
  paused_at?: string | null
  paused_reason?: string | null
}

// Read-only poll — no autopilot_event recorded. Safe to call on every
// heartbeat. Returns null on any failure so a flaky observability call never
// breaks the heartbeat path.
async function fetchAutopilotSnapshot(): Promise<AutopilotSnapshot | null> {
  if (!sm || !sessionId) return null
  try {
    const res = (await callMemory('memory_autopilot_count', {
      session_id: sessionId,
      project: PROJECT,
      agent: AGENT,
    })) as AutopilotSnapshot | null
    if (!res || typeof res !== 'object') return null
    return {
      current_count: res.current_count,
      hourly_budget: res.hourly_budget,
      depth_cap: res.depth_cap,
      enabled: res.enabled,
      paused_at: res.paused_at ?? null,
      paused_reason: res.paused_reason ?? null,
    }
  } catch (err) {
    debugLog(`fetchAutopilotSnapshot: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function startHeartbeat(onFailure: (err: Error) => void): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    void heartbeatOnce()
      .then(async () => {
        const autopilot = await fetchAutopilotSnapshot()
        writeStatus('connected', autopilot ? { autopilot } : {})
      })
      .catch((err: unknown) => {
        const m = err instanceof Error ? err.message : String(err)
        process.stderr.write(`junto-inbox: heartbeat failed (${m}); forcing reconnect\n`)
        debugLog(`heartbeat: failed (${m})`)
        stopHeartbeat()
        writeStatus('reconnecting', { error: m, source: 'heartbeat' })
        onFailure(err instanceof Error ? err : new Error(m))
      })
  }, HEARTBEAT_INTERVAL_MS)
}

async function bindAndSubscribe(): Promise<void> {
  const transport = new StreamableHTTPClientTransport(new URL(SHARED_URL))
  const client = new Client({ name: 'junto-inbox-client', version: '0.0.21' }, { capabilities: {} })
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async notif => {
    if (notif.params.uri === INBOX_URI) await readInboxAndForward()
  })
  await client.connect(transport)
  sm = client

  const start = await callMemory('memory_start_session', {
    project: PROJECT,
    claude_instance: AGENT,
    task_description: 'junto-inbox channel plugin',
    ...(ROLE ? { role_description: ROLE } : {}),
    ...(API_KEY ? { api_key: API_KEY } : {}),
  })
  sessionId = (start as { session_id?: string } | null)?.session_id ?? null
  if (!sessionId) throw new Error('no session_id returned from memory_start_session')

  if (AUTOPILOT_ENABLE) {
    try {
      await callMemory('memory_set_autopilot', {
        session_id: sessionId,
        project: PROJECT,
        agent: AGENT,
        enabled: true,
        depth_cap: AUTOPILOT_DEPTH_CAP,
        hourly_budget: AUTOPILOT_BUDGET,
      })
      process.stderr.write(`junto-inbox: autopilot enabled (depth_cap=${AUTOPILOT_DEPTH_CAP}, hourly_budget=${AUTOPILOT_BUDGET})\n`)
      debugLog(`bindAndSubscribe: autopilot set enabled=true depth_cap=${AUTOPILOT_DEPTH_CAP} budget=${AUTOPILOT_BUDGET}`)
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err)
      process.stderr.write(`junto-inbox: memory_set_autopilot failed (continuing): ${m}\n`)
      debugLog(`bindAndSubscribe: memory_set_autopilot failed: ${m}`)
    }
  }

  await client.subscribeResource({ uri: INBOX_URI })
  process.stderr.write(`junto-inbox: connected, session=${sessionId}, subscribed=${INBOX_URI}\n`)
  debugLog(`bindAndSubscribe: connected session=${sessionId} sub=${INBOX_URI}`)
  writeStatus('connected', { source: 'bind' })

  await drainJournal()
  await readInboxAndForward()
}

async function supervisor(): Promise<void> {
  let backoff = 1000
  while (true) {
    try {
      await bindAndSubscribe()
      backoff = 1000
      await new Promise<void>((_, reject) => {
        const t = sm?.transport
        if (!t) return reject(new Error('no transport'))
        t.onclose = () => reject(new Error('transport closed'))
        t.onerror = e => reject(e instanceof Error ? e : new Error(String(e)))
        triggerReconnect = reject
        startHeartbeat(reject)
      })
    } catch (err) {
      triggerReconnect = null
      stopHeartbeat()
      const errMsg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`junto-inbox: link down (${errMsg}) -- reconnecting in ${backoff}ms\n`)
      writeStatus('reconnecting', { error: errMsg, backoff_ms: backoff, source: 'supervisor' })
      sm = null
      sessionId = null
      // Keep agentReady true across reconnects. The host CC owns the plugin's
      // process lifetime, so a live plugin implies a live host. Resetting
      // agentReady stranded coordinator-class agents whose `go` macro fired
      // once and had no trigger to re-fire after a silent session expiry.
      await new Promise(r => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 30000)
    }
  }
}

async function shutdown(reason: string) {
  process.stderr.write(`junto-inbox: shutdown (${reason})\n`)
  stopHeartbeat()
  stopHealthPoller()
  writeStatus('shutdown', { reason })
  try {
    if (sm && sessionId) await callMemory('memory_end_session', { session_id: sessionId, summary: 'junto-inbox shutting down' })
  } catch {}
  try { await healthClient?.close() } catch {}
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

migrateOutboxToJournal()
loadJournal()
startHealthPoller()
await mcp.connect(new StdioServerTransport())
void supervisor()
process.stderr.write(`junto-inbox: subscribe-mode for ${PROJECT}/${AGENT}\n`)
