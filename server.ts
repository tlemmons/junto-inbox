#!/usr/bin/env bun
/**
 * junto-inbox: Claude Code channel plugin that bridges the shared-memory MCP
 * server's per-agent inbox into a running CC session, and exposes a reply
 * tool that posts back to other agents' inboxes.
 *
 * Part of the Junto suite (umbrella brand for the multi-agent stack: junto-memory
 * MCP server, junto-inbox channel plugin, junto-control dashboard).
 *
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
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

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
const STATUS_DIR = join(homedir(), '.claude', 'junto-inbox')
const STATUS_FILE = join(STATUS_DIR, `${PROJECT}-${AGENT}.status`)
let statusDirCreated = false

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
      ...extras,
    })
    writeFileSync(STATUS_FILE, payload)
  } catch {
    // best-effort — never let a status-file write crash the supervisor
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

const mcp = new Server(
  { name: 'junto-inbox', version: '0.0.16' },
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

  if (req.params.name !== 'send_message') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  }
  if (!sessionId || !sm) {
    return { content: [{ type: 'text', text: 'send_message: shared-memory session not yet established' }], isError: true }
  }
  // If the agent skipped get_session_id (fell back to memory_start_session),
  // a send_message tool call still proves they're live. Treat it as ready.
  markReady('send_message')
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    // Direct callTool (not callMemory) so we can inspect isError. A
    // server-side "Session not found" comes back as isError=true and was
    // previously parsed as a normal success body by callMemory, leaking
    // the error to the caller as if it were the send result.
    const result = await sm.callTool({
      name: 'memory_send_message',
      arguments: {
        session_id: sessionId,
        to_instance: args.to_agent as string,
        message: args.body as string,
        to_project: (args.to_project as string | undefined) ?? PROJECT,
        in_response_to: args.in_response_to as string | undefined,
        require_human: args.require_human as boolean | undefined,
        human_interacted: args.human_interacted as boolean | undefined,
        priority: (args.priority as string | undefined) ?? 'normal',
        category: (args.category as string | undefined) ?? 'info',
      },
    })
    const content = result.content as Array<{ type: string; text?: string }> | undefined
    const text = content?.find(c => c.type === 'text')?.text ?? ''
    if (result.isError === true) {
      // Detect the specific "session is dead" signature; on match, drop
      // our cached id and force reconnect so the next send picks up the
      // freshly bound session. Other errors pass through unchanged.
      if (/session.*not.*found/i.test(text)) {
        forceReconnect(`send_message saw stale session_id (${text})`)
      }
      return { content: [{ type: 'text', text: `send_message: ${text}` }], isError: true }
    }
    return { content: [{ type: 'text', text }] }
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `send_message: ${m}` }], isError: true }
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
// the MCP isError flag — a "Session not found" comes back as an isError result,
// not a thrown exception. Throws on transport-level errors and on isError=true.
async function heartbeatOnce(): Promise<void> {
  if (!sm || !sessionId) throw new Error('heartbeat: no bound session')
  const res = await sm.callTool({
    name: 'memory_heartbeat',
    arguments: { session_id: sessionId },
  })
  if (res.isError === true) {
    const text = (res.content as Array<{ type: string; text?: string }> | undefined)
      ?.find(c => c.type === 'text')?.text
    throw new Error(`memory_heartbeat error: ${text ?? '(no body)'}`)
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
  const client = new Client({ name: 'junto-inbox-client', version: '0.0.16' }, { capabilities: {} })
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
  writeStatus('shutdown', { reason })
  try {
    if (sm && sessionId) await callMemory('memory_end_session', { session_id: sessionId, summary: 'junto-inbox shutting down' })
  } catch {}
  process.exit(0)
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

await mcp.connect(new StdioServerTransport())
void supervisor()
process.stderr.write(`junto-inbox: subscribe-mode for ${PROJECT}/${AGENT}\n`)
