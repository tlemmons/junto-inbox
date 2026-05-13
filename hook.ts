#!/usr/bin/env bun
/**
 * junto-inbox PreToolUse hook (v0.0.20+).
 *
 * Wired into Claude Code via per-agent `.claude/settings.json` as a
 * `PreToolUse` hook with matcher `mcp__shared-memory__memory_*`. On every
 * matching tool call:
 *
 *   1. If the tool is in the deny-list (read-only) → allow through.
 *      Reads are idempotent and serve from live OR fail loud through the
 *      live MCP path. They never journal.
 *
 *   2. If the plugin status file at
 *      `~/.claude/junto-inbox/<project>-<agent>.status` reports
 *      `health_state == "offline"` AND the tool is in the capture-set →
 *      generate a journal entry per schema.ts §JournalEntry, append it to
 *      `~/.junto/journal/<project>-<agent>.journal.jsonl`, and return a
 *      `permissionDecision: deny` decision back to Claude Code with a
 *      structured reason ("queued to journal pending reconnect"). The call
 *      DOES NOT reach the shared-memory server.
 *
 *   3. Otherwise (online, or capture-set-unknown tool while offline, or
 *      missing/unparseable status file) → allow through. The live MCP
 *      path either succeeds or fails loud; no journaling.
 *
 * The hook is the ONLY production journal writer for the 12 non-send_message
 * mutation tools. The plugin's send_message tool handler journals its own
 * tool independently (it's a plugin tool, not a shared-memory MCP tool, so
 * the matcher does not fire on it). Both writers target the same journal
 * file and use the same v1 schema; race-windows are documented in
 * design:local-first-junto-v0-mvp v0.3.0 as a Phase 0 known limitation (the
 * server-side `__intent_id` op-log dedupe in Phase 1 is the structural fix).
 *
 * Identity sourcing: JUNTO_PROJECT and JUNTO_AGENT env vars MUST be set by
 * the launcher (launch-nimbus.ps1 already sets both). Without them, the
 * hook cannot locate the right status file or write to the right journal,
 * so it fails open (allows the call through) rather than blocking the
 * agent — graceful-degradation per spec §8.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs'
import { dirname } from 'path'
import {
  CAPTURE_SET,
  DENY_LIST,
  StatusFile,
  journalFilePath,
  makeJournalEntry,
  statusFilePath,
} from './schema.ts'

type HookInput = {
  session_id?: string
  transcript_path?: string
  cwd?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
}

function emitAllow(): void {
  // No output, exit 0 — the tool call proceeds to its normal handler.
  process.exit(0)
}

function emitDeny(reason: string): void {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }
  process.stdout.write(JSON.stringify(out))
  process.exit(0)
}

async function main(): Promise<void> {
  // Read stdin to completion. Bun supports for-await on process.stdin.
  let raw = ''
  for await (const chunk of process.stdin) {
    raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
  }

  let payload: HookInput
  try {
    payload = JSON.parse(raw) as HookInput
  } catch {
    // Malformed input → don't block the model; let CC report its own error.
    emitAllow()
    return
  }

  const toolName = payload.tool_name
  if (!toolName) {
    emitAllow()
    return
  }

  // Deny-list (read-only) always passes through, even when offline. Reads
  // are idempotent and fail-loud through the live MCP path is acceptable.
  if (DENY_LIST.has(toolName)) {
    emitAllow()
    return
  }

  // Tools we don't know about — pass through silently. The matcher should
  // already have filtered to mcp__shared-memory__memory_*, but if a new
  // mutation tool ships on the server before this hook is updated, we
  // prefer fail-open (let the live MCP path try) over blocking the agent.
  if (!CAPTURE_SET.has(toolName)) {
    emitAllow()
    return
  }

  // Identity must be available. Without it we can't locate the agent's
  // status file or journal file. Fail open per spec §8 graceful-degradation.
  const project = process.env.JUNTO_PROJECT
  const agent = process.env.JUNTO_AGENT
  if (!project || !agent) {
    emitAllow()
    return
  }

  // Health check: read the plugin's status file. If it's missing or
  // unparseable, the plugin isn't running — fail open (let the live call
  // proceed; it'll fail loud at the transport layer if the server is
  // genuinely down).
  const statusFile = statusFilePath(project, agent)
  let status: StatusFile | null = null
  try {
    if (existsSync(statusFile)) {
      const body = readFileSync(statusFile, 'utf8')
      status = JSON.parse(body) as StatusFile
    }
  } catch {
    // Unparseable status file — fail open.
  }

  if (!status || status.health_state !== 'offline') {
    // Plugin reports online, or plugin not running. Pass through.
    emitAllow()
    return
  }

  // Offline + capture-set tool. Build the journal entry and append.
  const rawArgs = payload.tool_input ?? {}
  const entry = makeJournalEntry(toolName, rawArgs, { project, agent })
  const journalFile = journalFilePath(project, agent)
  try {
    const dir = dirname(journalFile)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    // appendFileSync with a JSONL line is atomic for sub-PIPE_BUF writes on
    // POSIX and effectively atomic on Windows for our typical entry size
    // (~1KB). Concurrent appends from a second writer interleave at the
    // line boundary without corruption. See spec v0.3.0 §8 Phase 0
    // race-window note for the rare losing-write scenario when the plugin
    // process and the hook race on the same file — accepted in MVP.
    appendFileSync(journalFile, JSON.stringify(entry) + '\n')
  } catch (err) {
    // Journal write failed (disk full, permissions). Fail loud — better to
    // surface the error to the agent than silently allow the call to fail
    // at the transport layer with no record.
    const m = err instanceof Error ? err.message : String(err)
    emitDeny(`junto-inbox: OFFLINE and journal write failed (${m}); call rejected. Manual intervention required.`)
    return
  }

  emitDeny(
    `junto-inbox: shared-memory server OFFLINE. Tool call queued to journal as ${entry.queue_id} ` +
      `(intent_id=${entry.intent_id}, op_type=${entry.op_type}). ` +
      `Use junto_journal_list to review and junto_journal_replay to retry on reconnect, or junto_journal_discard to drop. ` +
      `This is the Phase 0 capture path per design:local-first-junto-v0-mvp §8.`,
  )
}

await main()
