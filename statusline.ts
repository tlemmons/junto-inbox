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
  session_id?: string | null
  last_update?: string
  pid?: number
  error?: string
  source?: string
  backoff_ms?: number
  autopilot?: {
    current_count?: number
    hourly_budget?: number
    depth_cap?: number
    enabled?: boolean
    paused_at?: string | null
    paused_reason?: string | null
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
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const RED = '\x1b[31m'
const GREY = '\x1b[90m'
const DIM = '\x1b[2m'

let glyph: string
let label: string

if (payload.state === 'shutdown') {
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
const ap = payload.autopilot
if (ap && typeof ap.current_count === 'number' && typeof ap.hourly_budget === 'number') {
  const ratio = ap.hourly_budget > 0 ? ap.current_count / ap.hourly_budget : 0
  // Pause state wins over ratio coloring; an explicitly disabled receiver is
  // not "healthy at 0/N" — it's actively gated.
  let color = GREEN
  if (ap.enabled === false || ap.paused_at) color = RED
  else if (ratio >= 1) color = RED
  else if (ratio >= 0.8) color = YELLOW
  budget = ` ${color}${ap.current_count}/${ap.hourly_budget}${RESET}`
}

const out = `${glyph} junto-inbox ${DIM}${project}/${agent}${RESET} ${label}${budget}`
process.stdout.write(out)
