# junto-inbox

Claude Code channel plugin that bridges the [shared-memory MCP server](https://github.com/tlemmons/mcp-shared-memory)'s
per-agent inbox into a running CC session and exposes a reply tool. Part of the
[Junto](https://github.com/tlemmons/junto-stack) suite.

When agent A sends a message to agent B's inbox, junto-inbox running inside B's
CC session pushes the message in as a `<channel source="junto-inbox" ...>` block.
B reads it without anyone manually walking to B's terminal.

## Status

v0.0.20 — Phase 0 capture mechanism per
[`design:local-first-junto-v0-mvp`](https://github.com/tlemmons/junto-stack) v0.3.0 §8.
Adds a CC `PreToolUse` hook (`hook.ts`) that captures the 13-tool
mutation set when the plugin is `OFFLINE` per its health poller, plus
three operator-review tools (`junto_journal_list`, `_replay`, `_discard`).
v0.0.19 (heartbeat, statusline OFFLINE, autopilot-pause, journal at
`~/.junto/journal/...`), v0.0.18 (persistent `send_message` outbox),
v0.0.17 (loosened autopilot defaults: `depth_cap=5, budget=30`) carry
forward. See [CHANGELOG.md](CHANGELOG.md) for full history.

Functionally: subscribe-mode against `inbox://<project>/<agent>`,
client-side `memory_autopilot_check_budget` gate for `chain_depth >= 1`,
`get_session_id` tool for host-CC session sharing, paginated inbox drain,
status file for statusLine indicator, `[REQUIRES REVIEW]` marker for
messages tagged `require_human=true`, 12s health probe with OFFLINE
indicator after 3 consecutive failures, persistent local journal at
`~/.junto/journal/<project>-<agent>.journal.jsonl` for offline mutations.

Auth-bound: the agent identifier passed to `memory_start_session` MUST equal the
URI's `<agent>` segment, otherwise subscribe raises and reads return
`{"error":"permission denied"}`.

## Configuration

Per-launch env vars (all `JUNTO_<name>`; the `CT_<name>` deprecation
fallback was removed in v0.0.15):

- `JUNTO_PROJECT` (required) — e.g. `nimbus`
- `JUNTO_AGENT` (required) — e.g. `server-team`. Determines both the agent
  identity for `memory_start_session` and the inbox URI.
- `JUNTO_ROLE` (optional) — `role_description` for the agent directory
  (set once, persists across sessions).
- `JUNTO_SHARED_MEMORY_URL` (default `http://localhost:8080/mcp`) — point this at wherever your shared-memory MCP server is reachable.
- `JUNTO_API_KEY` (only if shared-memory has `MCP_AUTH_ENABLED=true`)
- `JUNTO_AUTOPILOT_ENABLE`, `JUNTO_AUTOPILOT_DEPTH_CAP` (default 5),
  `JUNTO_AUTOPILOT_BUDGET` (default 30) — opt-in autopilot configuration
  applied at bind time.
- `JUNTO_DEBUG=1` — write per-event traces to `./junto-inbox-debug.log`.

## Install

### Recommended: from the bundled marketplace

The repo ships `.claude-plugin/marketplace.json` so you can install with
two `/plugin` slash-commands inside Claude Code:

```
/plugin marketplace add tlemmons/junto-inbox
/plugin install junto-inbox@tlemmons-junto-inbox
```

Marketplace install gives you persistent trust (`hasTrustDialogAccepted`
in `~/.claude.json`); no per-launch confirmation dialog.

### Development: clone and run via stdio

Clone the repo and run `claude` from inside the checkout (the bundled
`.mcp.json` registers `junto-inbox` as a spawnable stdio server). This
path requires confirming the `--dangerously-load-development-channels`
dialog on every launch.

**bash / zsh:**
```bash
JUNTO_PROJECT=nimbus JUNTO_AGENT=server-team \
  claude --dangerously-load-development-channels server:junto-inbox
```

**PowerShell:**
```powershell
$env:JUNTO_PROJECT="nimbus"; $env:JUNTO_AGENT="server-team"; `
  claude --dangerously-load-development-channels server:junto-inbox
```

**cmd.exe:**
```cmd
set JUNTO_PROJECT=nimbus && set JUNTO_AGENT=server-team && claude --dangerously-load-development-channels server:junto-inbox
```

## Launch (after install)

```
JUNTO_PROJECT=nimbus JUNTO_AGENT=server-team \
  claude --channels plugin:junto-inbox@tlemmons-junto-inbox
```

If the plugin process exits without registering an agent (check
`memory_list_agents`), CC swallows the stderr — look at
`~/.claude/debug/<session-id>.txt` for the actual failure.

## Architecture

```
CC session ──stdio──▶ junto-inbox (this plugin)
                          │
                          │ HTTP MCP (StreamableHTTP)
                          ▼
                  shared-memory MCP server
                  (subscribe inbox://...,
                   memory_send_message)
```

A single MCP client connection to shared-memory carries:
1. `memory_start_session(project, claude_instance=AGENT, role_description?)` — binds the transport's ServerSession to the agent identity.
2. `subscribeResource({uri: "inbox://<project>/<agent>"})` — registers for `notifications/resources/updated`.
3. On each notification: `readResource` → JSON-parse → emit `notifications/claude/channel` for new messages (deduped by id; `require_human=true` rendered with `[REQUIRES REVIEW]` prefix and `meta.requires_review="true"`).
4. `memory_end_session` on shutdown.

The supervisor wraps this in a reconnect-with-backoff outer loop because
subscriptions and the agent binding live in the server's process memory
only — they do not survive server restart. A 30s heartbeat detects silent
session invalidation and forces reconnect.

## Tools exposed to Claude

- `send_message(to_agent, body, [to_project], [in_response_to], [require_human], [human_interacted], [priority], [category])` — calls `memory_send_message`. Pass the inbound message's `msg_id` as `in_response_to` for chain-depth threading. Set `human_interacted=true` ONLY when a human prompt entered between message receipt and your reply; `false` on autopilot replies. The flag is sender-asserted; the server uses it to reset `effective_chain_depth=0` so a fresh human turn does not blow the depth cap.
- `get_session_id()` — returns `{status:"ready",session_id,project,agent}` or `{status:"not_ready",project,agent}`. Host CC's `go` macro uses this to share the plugin's session instead of opening a duplicate `memory_start_session`.
- `junto_journal_list()` — returns a summary of journal entries written while the shared-memory server was OFFLINE (top-level `arg_keys` only; full args are on disk). Reloads from disk on every call so hook-written entries are visible.
- `junto_journal_replay(queue_id)` — replays one entry through the bound session, threading the entry's `intent_id` as `__intent_id` so the Phase 1 op-log can dedupe. On success, removes from journal; on isError or transport error, leaves entry in place.
- `junto_journal_discard(queue_id)` — drop one entry without replaying. Operator decides; no server interaction.

## PreToolUse hook (v0.0.20)

The Phase 0 capture mechanism for the **12 non-`send_message` mutation
tools** lives in `hook.ts` — a `PreToolUse` hook configured per-agent
in `.claude/settings.json`. It fires on `mcp__shared-memory__memory_*`
tool calls and:

1. **Reads** are allowed through unconditionally (`memory_query`,
   `memory_get_*`, `memory_list_*`, `memory_find_function`,
   `memory_health`, `memory_search_global`, `memory_checklist`,
   `memory_db`, autopilot reads). Reads serve from live or fail loud;
   they never journal.
2. **Captured mutations** (the 13 tools in `schema.ts`'s `CAPTURE_SET`)
   journal **only when the plugin reports `health_state="offline"`** in
   `~/.claude/junto-inbox/<project>-<agent>.status`. The hook generates
   an `intent_id` (UUID4), writes a v1 journal entry, and returns
   `permissionDecision: "deny"` with a structured reason — the call
   does NOT reach the server.
3. **Online or status-file missing/unparseable** → the hook is a
   no-op. Tool calls proceed normally.

### Sample `.claude/settings.json` snippet

For an agent launched from `C:\code\claudeTerminal\app\cterm-inbox\`:

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "mcp__shared-memory__memory_*",
        "hooks": [
          {
            "type": "command",
            "command": "bun C:\\code\\claudeTerminal\\app\\cterm-inbox\\hook.ts",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Notes:

- The hook reads `JUNTO_PROJECT` and `JUNTO_AGENT` from the CC process
  environment. The same launcher that sets these for the plugin already
  has them in scope, so no extra env wiring is needed.
- `bun` must be on `PATH`. If your launcher uses a pinned bun (e.g.
  `C:\Users\<you>\.bun\bin\bun.exe`), spell that out in `command`.
- Adopter agents that **do not** configure this hook get
  **graceful-degradation**: `send_message` is still journaled (the
  plugin's own tool handler does that), but the 12 other mutation
  tools fall through to the live MCP path and may silently succeed
  during a transport half-open window. See the "Coverage boundary"
  callout below.

### Coverage boundary

Phase 0 protects against silent loss for the 13 capture-set tools
**only when the `PreToolUse` hook is configured in
`.claude/settings.json`**. Without the hook:

- `memory_send_message` IS still journaled (plugin handles it directly).
- The other 12 mutation tools are NOT journaled.
- All reads pass through unaffected.

The structural fix for the silent-success class — a server-side op-log
with `intent_id` reconciliation — is Phase 1
(see `design:local-first-junto-v0-mvp` §4.6).

## Status file

The plugin writes `~/.claude/junto-inbox/<project>-<agent>.status` on every
state transition. `statusline.ts` in this directory reads it and prints a
single-line health indicator suitable for Claude Code's `statusLine` setting.

## Known limitations

- **Pagination cap** — `readInboxAndForward` walks at most 50 pages
  (≤1000 messages) per drain. Beyond that, older messages are left in
  the inbox and a stderr warning is logged. The next live notification
  triggers another drain, so the cap is unlikely to bite in practice.
- **Sender allowlist / payload validation** — none. Cross-agent
  messages should still be treated as low-trust input by the receiving
  Claude; per-project CLAUDE.md trust elevation is the safety boundary.
- **Permission relay** — `claude/channel/permission` capability not
  declared (deferred to a later phase).
- **`human_interacted` is sender-asserted** — the server trusts the flag.
  Audit log catches abuse retroactively. See `learning_8f5` on the
  shared-memory server for the design history (Approach A vs server-derived
  Approach C, the latter documented as the upgrade path for third-party
  adopters).

## Notification format gotcha

`notifications/claude/channel` `params.meta` is `Record<string, string>`.
Coerce **every** meta value via `String(...)` — number/boolean values
cause CC to silently drop the notification (no error, no render). Keys
with hyphens are also silently dropped; use snake_case only.

## License

MIT — see [LICENSE](https://github.com/tlemmons/junto-inbox/blob/main/LICENSE).
