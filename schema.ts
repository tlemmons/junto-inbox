/**
 * Shared schema + capture-set + op_type mapping for junto-inbox v0.0.20+.
 *
 * Imported by both the plugin (server.ts) and the PreToolUse hook script
 * (hook.ts) so they agree on:
 *   - the journal-entry shape (`design:local-first-junto-v0-mvp` v0.3.0 §8 v1)
 *   - which `mcp__junto__memory_*` tool calls are captured vs denied
 *   - the §4.1 op_type mapping for each captured tool
 *   - the canonical file paths (status file + journal file)
 *
 * Keep this file framework-free (no node-only or bun-only APIs in the type
 * surface; the helpers below use only `os`, `path`, and `crypto` which exist
 * in both runtimes).
 */

import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'

export const JOURNAL_SCHEMA_VERSION = 1

export const SEND_MESSAGE_TOOL = 'mcp__junto__memory_send_message'

/**
 * The 13 mutation tools the inbox plugin is responsible for journaling when
 * the shared-memory server is offline (spec v0.3.0 §8). All entries in this
 * set MUST also appear in TOOL_OP_TYPE_MAP.
 */
export const CAPTURE_SET = new Set<string>([
  'mcp__junto__memory_send_message',
  'mcp__junto__memory_record_learning',
  'mcp__junto__memory_store',
  'mcp__junto__memory_define_spec',
  'mcp__junto__memory_register_function',
  'mcp__junto__memory_enrich_function',
  'mcp__junto__memory_add_backlog_item',
  'mcp__junto__memory_batch_backlog',
  'mcp__junto__memory_update_backlog_item',
  'mcp__junto__memory_complete_backlog_item',
  'mcp__junto__memory_change_status',
  'mcp__junto__memory_archive_by_tag',
  'mcp__junto__memory_restore_by_tag',
])

/**
 * Read tools — never journaled, never blocked, even when offline. Reads can
 * fail loud through the live MCP path (eventually they'll serve from local
 * cache once Phase 2 lands). Spec v0.3.0 §8 deny-list.
 *
 * Matched by exact prefix; `*_list`, `*_get`, etc. all collapse here because
 * we match by the tool name itself, not regex over its semantics.
 */
export const DENY_LIST = new Set<string>([
  'mcp__junto__memory_query',
  'mcp__junto__memory_search_global',
  'mcp__junto__memory_find_function',
  'mcp__junto__memory_health',
  'mcp__junto__memory_autopilot_status',
  'mcp__junto__memory_autopilot_count',
  'mcp__junto__memory_autopilot_check_budget',
  'mcp__junto__memory_autopilot_digest',
  'mcp__junto__memory_checklist',
  'mcp__junto__memory_db',
  // get_* family (read-only)
  'mcp__junto__memory_get_emission_stats',
  'mcp__junto__memory_get_messages',
  'mcp__junto__memory_get_spec',
  'mcp__junto__memory_get_by_id',
  'mcp__junto__memory_get_active_work',
  'mcp__junto__memory_get_agent_status',
  'mcp__junto__memory_get_enrichment_queue',
  'mcp__junto__memory_get_locks',
  // list_* family (read-only)
  'mcp__junto__memory_list_agents',
  'mcp__junto__memory_list_backlog',
  'mcp__junto__memory_list_projects',
  'mcp__junto__memory_list_specs',
  // misc read
  'mcp__junto__memory_project',
  'mcp__junto__memory_guidelines',
])

/**
 * Map captured tool → §4.1 op_type catalog value (spec v0.3.0 §4.1).
 *
 * Notes on the imprecise cases:
 *   - memory_define_spec maps to "spec.updated"; spec.defined applies only on
 *     the first version, but the hook can't know that. Server-side op-log
 *     (Phase 1) will correctly differentiate. For Phase 0 journal metadata,
 *     spec.updated covers both cases for observability without lying about
 *     intent.
 *   - memory_change_status maps to "learning.superseded"; in practice the
 *     target may be a store, learning, or function. The catalog lists this
 *     value as the canonical change_status op_type (§4.1, target=learning).
 *     Server-side op-log will resolve the actual target.
 *   - batch_backlog and add_backlog_item both → backlog.added (multi-op
 *     batches are observability-flattened in Phase 0; Phase 1 op-log
 *     emits one entry per added item).
 */
export const TOOL_OP_TYPE_MAP: Record<string, string> = {
  'mcp__junto__memory_send_message': 'message.sent',
  'mcp__junto__memory_record_learning': 'learning.recorded',
  'mcp__junto__memory_store': 'store.created',
  'mcp__junto__memory_define_spec': 'spec.updated',
  'mcp__junto__memory_register_function': 'function.registered',
  'mcp__junto__memory_enrich_function': 'function.enriched',
  'mcp__junto__memory_add_backlog_item': 'backlog.added',
  'mcp__junto__memory_batch_backlog': 'backlog.added',
  'mcp__junto__memory_update_backlog_item': 'backlog.updated',
  'mcp__junto__memory_complete_backlog_item': 'backlog.updated',
  'mcp__junto__memory_change_status': 'learning.superseded',
  'mcp__junto__memory_archive_by_tag': 'store.tagged',
  'mcp__junto__memory_restore_by_tag': 'store.tagged',
}

export type JournalEntry = {
  queue_id: string
  queued_at: string
  intent_id: string
  tool_name: string
  args: Record<string, unknown>
  actor: { project: string; agent: string }
  op_type: string
  schema_version: number
}

export function statusFilePath(project: string, agent: string): string {
  return join(homedir(), '.claude', 'junto-inbox', `${project}-${agent}.status`)
}

export function journalFilePath(project: string, agent: string): string {
  return join(homedir(), '.junto', 'journal', `${project}-${agent}.journal.jsonl`)
}

export function journalDirPath(): string {
  return join(homedir(), '.junto', 'journal')
}

/**
 * Make a new journal entry. Strips `session_id` from args (spec §8: "args:
 * full call args sans session_id") — server fills it on replay.
 */
export function makeJournalEntry(
  toolName: string,
  rawArgs: Record<string, unknown>,
  actor: { project: string; agent: string },
): JournalEntry {
  const args: Record<string, unknown> = { ...rawArgs }
  delete args.session_id
  return {
    queue_id: randomUUID(),
    queued_at: new Date().toISOString(),
    intent_id: randomUUID(),
    tool_name: toolName,
    args,
    actor,
    op_type: TOOL_OP_TYPE_MAP[toolName] ?? 'audit.event',
    schema_version: JOURNAL_SCHEMA_VERSION,
  }
}

/**
 * Coerce a partially-parsed entry from disk into the v1 schema. v0.0.18 and
 * v0.0.19 entries were send_message-only and lacked intent_id, tool_name,
 * actor, schema_version. Filling them at load time treats them as v1 since
 * that's what they always were by construction — the fields are just now
 * being recorded explicitly. v0.0.19 entries did carry op_type, but it was
 * a free-form value like "send_message" rather than the §4.1 catalog value
 * "message.sent"; normalize here.
 */
export function normalizeLegacyEntry(
  raw: Partial<JournalEntry> & { op_type?: string },
  defaultActor: { project: string; agent: string },
): JournalEntry | null {
  if (typeof raw.queue_id !== 'string') return null
  if (typeof raw.queued_at !== 'string') return null
  if (!raw.args || typeof raw.args !== 'object') return null

  // op_type → tool_name back-derivation for the only legacy case
  // (send_message). Future legacy hops should never appear, but if they do
  // they're rejected (null return) since we can't construct a tool_name.
  let toolName: string | undefined = raw.tool_name
  let opType: string | undefined = raw.op_type
  if (!toolName) {
    if (opType === 'send_message' || opType === 'message.sent' || !opType) {
      toolName = SEND_MESSAGE_TOOL
      opType = 'message.sent'
    } else {
      return null
    }
  }
  // v0.0.24: server renamed from shared_memory → junto. Forward-port any
  // pre-v0.0.24 journal entries whose tool_name was captured with the old
  // mcp__shared-memory__ prefix so TOOL_OP_TYPE_MAP lookups and replay both
  // see the current prefix. server.ts:845 also accepts either prefix during
  // replay; this normalization keeps the rest of the load-path single-prefix.
  if (toolName.startsWith('mcp__shared-memory__')) {
    toolName = 'mcp__junto__' + toolName.slice('mcp__shared-memory__'.length)
  }
  if (!opType) opType = TOOL_OP_TYPE_MAP[toolName] ?? 'audit.event'

  return {
    queue_id: raw.queue_id,
    queued_at: raw.queued_at,
    intent_id: typeof raw.intent_id === 'string' ? raw.intent_id : randomUUID(),
    tool_name: toolName,
    args: raw.args as Record<string, unknown>,
    actor:
      raw.actor && typeof raw.actor === 'object' && typeof raw.actor.project === 'string' && typeof raw.actor.agent === 'string'
        ? raw.actor
        : defaultActor,
    op_type: opType,
    schema_version: typeof raw.schema_version === 'number' ? raw.schema_version : JOURNAL_SCHEMA_VERSION,
  }
}

export type StatusFile = {
  state?: 'connected' | 'reconnecting' | 'shutdown'
  health_state?: 'online' | 'offline'
  journal_count?: number
  project?: string
  agent?: string
  // ...other fields written by server.ts; the hook only reads the ones above.
}
