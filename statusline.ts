#!/usr/bin/env bun
/**
 * junto-inbox statusline indicator.
 *
 * Reads the plugin's status file at ~/.claude/junto-inbox/<project>-<agent>.status
 * and prints a colored single-line health indicator. Designed for Claude Code's
 * settings.json:
 *
 *   "statusLine": {
 *     "type": "command",
 *     "command": "bun C:/code/claudeTerminal/app/cterm-inbox/statusline.ts"
 *   }
 *
 * Resolves (project, agent) from JUNTO_PROJECT and JUNTO_AGENT (preferred) or
 * legacy CT_PROJECT and CT_AGENT, set by launch-nimbus.ps1 (and equivalent on
 * Linux) and inherited by the CC parent. If unset, prints nothing — non-junto
 * terminals get a clean line.
 *
 * Glyph legend:
 *   green ●  connected, last update <60s ago
 *   yellow ● connected, last update 60-120s ago (one missed heartbeat)
 *   red ●    reconnecting, or stale >120s
 *   grey ●   shutdown
 *
 * v0.0.19 additions:
 *   OFFLINE  health_state==='offline' (3+ consecutive memory_health failures).
 *            Overrides connected/reconnecting coloring — server is unreachable
 *            regardless of bound-session state. Renders as bold-red OFFLINE
 *            label so the operator sees it independent of glyph color.
 *   j:N      journal_count > 0 — count of queued mutations awaiting drain.
 *
 * Exits 0 in all cases. Failures are silent so a missing file or unparseable
 * payload doesn't garble the user's status line.
 */
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const project = process.env.JUNTO_PROJECT
const agent = process.env.JUNTO_AGENT

// Claude Code pipes a JSON workspace blob on stdin. We don't need it, but
// drain it so CC's stdin write doesn't backpressure.
try {
  process.stdin.resume()
  process.stdin.on('data', () => {})
  process.stdin.on('end', () => {})
} catch {}

if (!project || !agent) {
  process.exit(0)
}

const file = join(homedir(), '.claude', 'junto-inbox', `${project}-${agent}.status`)

type Status = {
  state?: 'connected' | 'reconnecting' | 'shutdown'
  health_state?: 'online' | 'offline'
  journal_count?: number
  session_id?: string | null
  last_update?: string
  pid?: number
  error?: string
  source?: string
  backoff_ms?: number
  emission?: {
    count?: number
    push_budget?: number
    hard_ceiling?: number
    suspended?: boolean
  }
  lanes?: {
    action_open?: number
    fyi_waiting?: number
    // v0.0.29 — soft FYI-aging guidance (passed through from the server's
    // lane_counts). When the oldest waiting FYI nears the TTL, the badge hints
    // "drain soon" so info isn't lost to the 48h TTL unseen.
    fyi_oldest_age_hours?: number
    fyi_ttl_hours?: number
  }
}

let payload: Status
let mtimeMs: number
try {
  const raw = readFileSync(file, 'utf-8')
  payload = JSON.parse(raw) as Status
  mtimeMs = statSync(file).mtimeMs
} catch {
  process.exit(0)
}

const lastMs = payload.last_update ? new Date(payload.last_update).getTime() : mtimeMs
const ageS = Math.max(0, Math.floor((Date.now() - lastMs) / 1000))

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const GREY = '\x1b[90m'
const DIM = '\x1b[2m'

let glyph: string
let label: string

// OFFLINE (health_state==='offline') overrides connected/reconnecting
// coloring because the server is unreachable regardless of whether we still
// have a bound session locally. v0.0.19+.
if (payload.health_state === 'offline') {
  glyph = `${RED}●${RESET}`
  label = `${BOLD}${RED}OFFLINE${RESET}`
} else if (payload.state === 'shutdown') {
  glyph = `${GREY}●${RESET}`
  label = 'shutdown'
} else if (payload.state === 'reconnecting') {
  glyph = `${RED}●${RESET}`
  label = 'reconnecting'
} else if (payload.state === 'connected' && ageS < 60) {
  glyph = `${GREEN}●${RESET}`
  label = 'live'
} else if (payload.state === 'connected' && ageS < 120) {
  glyph = `${YELLOW}●${RESET}`
  label = `stale ${ageS}s`
} else {
  glyph = `${RED}●${RESET}`
  label = `stale ${ageS}s`
}

let budget = ''
const em = payload.emission
if (em && typeof em.count === 'number' && typeof em.push_budget === 'number') {
  const ratio = em.push_budget > 0 ? em.count / em.push_budget : 0
  // Suspended wins over ratio coloring: a suspended sender is actively gated,
  // not "healthy at 0/N". At idle the server's synthetic zero-row still resolves
  // the live suspended flag (design:autopilot-removal-v0 §4(a)), so a suspended
  // idle agent stays red instead of blanking to healthy. hard_ceiling (the
  // 100/hr hard stop) shows in dim parens after the soft push_budget ratio.
  let color = GREEN
  if (em.suspended) color = RED
  else if (typeof em.hard_ceiling === 'number' && em.count >= em.hard_ceiling) color = RED
  else if (ratio >= 1) color = RED
  else if (ratio >= 0.8) color = YELLOW
  const ceiling = typeof em.hard_ceiling === 'number' ? ` ${DIM}(${em.hard_ceiling})${RESET}` : ''
  budget = ` ${color}${em.count}/${em.push_budget}${RESET}${ceiling}`
}

// v0.0.29 — lanes-A badge: [N open · M FYI]. Both counts are now server-sourced
// (lane_counts, read-inert under per-message-unread). action_open is the count of
// unresolved obligations owed to this agent (yellow — needs a reply); fyi_waiting
// is the count of unseen FYIs (dim — informational, drained on go/reconcile).
// When the oldest FYI nears the server's TTL (>=75%), the FYI part turns yellow
// and gains a "·aging" hint so info isn't lost unseen. Omitted entirely when both
// are 0 so a quiet inbox keeps a clean line.
let laneBadge = ''
const ln = payload.lanes
if (ln) {
  const open = typeof ln.action_open === 'number' ? ln.action_open : 0
  const fyi = typeof ln.fyi_waiting === 'number' ? ln.fyi_waiting : 0
  if (open > 0 || fyi > 0) {
    const parts: string[] = []
    if (open > 0) parts.push(`${YELLOW}${open} open${RESET}`)
    if (fyi > 0) {
      const age = ln.fyi_oldest_age_hours
      const ttl = ln.fyi_ttl_hours
      const aging =
        typeof age === 'number' && typeof ttl === 'number' && ttl > 0 && age >= ttl * 0.75
      if (aging) parts.push(`${YELLOW}${fyi} FYI·aging${RESET}`)
      else parts.push(`${DIM}${fyi} FYI${RESET}`)
    }
    laneBadge = ` ${DIM}[${RESET}${parts.join(`${DIM} · ${RESET}`)}${DIM}]${RESET}`
  }
}

let journalBadge = ''
if (typeof payload.journal_count === 'number' && payload.journal_count > 0) {
  // YELLOW when queue is non-empty during ONLINE (catching up), RED when
  // OFFLINE (queue still growing or stuck). Bare digit count to keep the
  // statusline tight; operator can drill in via the file directly.
  const color = payload.health_state === 'offline' ? RED : YELLOW
  journalBadge = ` ${color}j:${payload.journal_count}${RESET}`
}

const out = `${glyph} junto-inbox ${DIM}${project}/${agent}${RESET} ${label}${budget}${laneBadge}${journalBadge}`
process.stdout.write(out)
