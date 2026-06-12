# junto-inbox

Claude Code channel plugin that bridges the [shared-memory MCP server](https://github.com/tlemmons/mcp-shared-memory)'s
per-agent inbox into a running CC session and exposes a reply tool. Part of the
[Junto](https://github.com/tlemmons/junto-stack) suite.

When agent A sends a message to agent B's inbox, junto-inbox running inside B's
CC session pushes the message in as a `<channel source="junto-inbox" ...>` block.
B reads it without anyone manually walking to B's terminal.

## Status

v0.0.25 — autopilot decouple. Push-control v0 (`design:push-control-v0`
v1.1.0) moved the per-message brake to the server: per-sender
`depth_cap` / `push_budget` / `hard_ceiling` are evaluated at send time
and the server-side delivery-time filter excludes push-suppressed
messages from the inbox read unless the recipient's recency window is
open. The plugin no longer calls `memory_autopilot_check_budget`, no
longer prepends `[AUTOPILOT GATED]` markers, and no longer emits
`meta.autopilot_gated`. New opt-in `[SYSTEM NOTICE]` marker (driven by
`m.is_system_notice` and `meta.is_system_notice`) gives `system@junto`'s
push-control recovery notices distinct visual treatment. v0.0.24
(schema.ts tool-prefix rename to `mcp__junto__memory_*`), v0.0.23
(render-side gate stopped silent-dropping — superseded by v0.0.25),
v0.0.22 (60s post-subscribe `agentReady` safety net, `boot-failed`
status state), v0.0.21 (ghost-session healing — `ERROR:` text now
triggers reconnect alongside `isError`), v0.0.20 (Phase 0 `PreToolUse`
hook capturing the 13-tool mutation set when OFFLINE per
[`design:local-first-junto-v0-mvp`](https://github.com/tlemmons/junto-stack)
v0.3.0 §8), v0.0.19 (heartbeat, statusline OFFLINE, autopilot-pause,
journal at `~/.junto/journal/...`), v0.0.18 (persistent `send_message`
outbox) carry forward. See [CHANGELOG.md](CHANGELOG.md) for full
history.

Functionally: subscribe-mode against `inbox://<project>/<agent>`,
`get_session_id` tool for host-CC session sharing, paginated inbox
drain, status file for statusLine indicator, `[REQUIRES REVIEW]` marker
for messages tagged `require_human=true`, `[SYSTEM NOTICE]` marker for
messages tagged `is_system_notice=true`, 60s post-subscribe safety net
so hosts that don't call `get_session_id` early still drain, 12s health
probe with OFFLINE indicator after 3 consecutive failures, persistent
local journal at `~/.junto/journal/<project>-<agent>.journal.jsonl` for
offline mutations.

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

## Adopter setup — host prerequisites

CC's channels system requires explicit host-side opt-in beyond the
`/plugin install` step. The combinations below cover the four
adopter-path bugs hit during the v0.0.20–v0.0.23 dogfood cycle (#5
Linux managed-settings, #6 launcher `--channels` flag, #7 WSL2 corp
GPO, plus `/reload-plugins` non-determinism).

### 1. Channels must be enabled at managed-settings scope

Claude Code accepts `channelsEnabled` / `allowedChannelPlugins` in
user-level `settings.json` but **the runtime ignores them there**. They
must live in a managed-settings file the OS reads with elevated trust.

**Linux** — write `/etc/claude-code/managed-settings.json` (root:root
644):

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "plugin": "junto-inbox", "marketplace": "tlemmons-junto-inbox" }
  ]
}
```

**Windows (standard non-corp)** — write
`C:\Program Files\ClaudeCode\managed-settings.json` with the same
content (`~/.claude/managed-settings.json` is NOT read on Windows).

**Windows (corp-managed / GPO-locked HKCU) — Bug #7** — the
HKCU\\SOFTWARE\\Policies\\ClaudeCode key may be GPO-locked on
enterprise machines (the standard-user write silently fails). Apply
the same shape under HKLM via admin PowerShell:

```powershell
# Run as Administrator
New-Item -Path "HKLM:\SOFTWARE\Policies\ClaudeCode" -Force | Out-Null
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\ClaudeCode" `
  -Name "channelsEnabled" -Value "true" -Type String
Set-ItemProperty -Path "HKLM:\SOFTWARE\Policies\ClaudeCode" `
  -Name "allowedChannelPlugins" `
  -Value '[{"plugin":"junto-inbox","marketplace":"tlemmons-junto-inbox"}]' `
  -Type String
```

A full CC restart is required after HKLM changes; `/reload-plugins`
does NOT pick them up. When IT can't grant admin access, fall back to
the development path (`--dangerously-load-development-channels
server:junto-inbox`) from a local clone of this repo.

### 2. Launcher must pass `--channels` — Bug #6

Adopter launcher scripts (Nimbus's `launch-nimbus.ps1`, etc.) often
omit the flag because `/plugin install` succeeded and there's no
prompt. Without it, plugin code never starts. Add it to every launch
spawn:

```
claude --channels plugin:junto-inbox@tlemmons-junto-inbox
```

The bundled `launch/windows/junto-launch.ps1` and `junto-launch.sh`
already wire this up; mirror their `exec claude --channels …` line
into adopter launchers.

### 3. `enabledPlugins` toggle

Marketplace installs default to `enabledPlugins` true, but if a
session was started before install, or a `/plugin disable` was issued
once, the toggle persists in `~/.claude.json`. Verify with:

```
/plugin list
```

…and look for `junto-inbox@tlemmons-junto-inbox: enabled`. Re-enable
with `/plugin enable junto-inbox@tlemmons-junto-inbox` if needed.

### 4. `bun` must be on PATH

The plugin entrypoint and the optional `PreToolUse` hook both run via
`bun`. Run a one-time preflight:

```
bun --version    # Linux/macOS/Windows
which bun        # POSIX
(Get-Command bun).Source    # PowerShell
```

If the launcher uses a pinned `bun` (e.g.
`C:\Users\<you>\.bun\bin\bun.exe`), spell that exact path into the
hook's `command` field — see the
[PreToolUse hook](#pretooluse-hook-v0020) section.

### 5. Host CC should call `get_session_id` early — agentReady contract

The plugin holds inbound channel blocks until the host CC signals it
has loaded state / guidelines / backlog. The signal is the host
calling the plugin's `get_session_id` or `send_message` tool. Hosts
whose startup macro routes through `memory_start_session` directly
(including the default global `~/.claude/CLAUDE.md`) skip the signal
and sit gate-closed for up to 60s while the v0.0.22 safety-net timer
runs. Have your project CLAUDE.md call `get_session_id` early in its
go/status macro to bypass the wait.

### 6. `/reload-plugins` is non-deterministic — DON'T rely on it for upgrades

Empirically: `/reload-plugins` sometimes picks up a new cache version
cleanly, and sometimes leaves an orphan process on the old version
alongside a fresh one on the new version. The canonical safe upgrade
path is **quit the CC tab, then relaunch** — that always picks up the
latest installed marketplace version. After any `/reload-plugins`
attempt, verify with `memory_list_agents` (the plugin's bind reports
its version) before assuming the upgrade landed.

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

## Channel block markers — host adopter contract

junto-inbox prepends one or both markers to the body of a rendered
channel block when the corresponding condition holds, and sets a
matching `meta` key (all `meta` values are strings per the [notification
format gotcha](#notification-format-gotcha)).

| Marker (body prefix) | meta key set | Meaning | Adopter contract |
|----------------------|--------------|---------|------------------|
| `[REQUIRES REVIEW]` | `meta.requires_review="true"` | Sender asked the human in the loop to read this before any auto-reply (set `require_human=true` on `send_message`). | Hosts that auto-process inbound channel blocks MUST skip the auto-reply pass and defer to the human. |
| `[SYSTEM NOTICE]` | `meta.is_system_notice="true"` | A server-emitted notice (e.g. `system@junto`'s push-control recovery notice — see `design:push-control-v0` v1.1.0 §8). These messages are non-pushing-by-construction but always surface in inbox reads. v0.0.25+. | Hosts MUST treat as informational; never auto-reply. They are intended to be FOUND on the next normal inbox flush, not acted on. |

Both markers can apply to the same message; order is `[REQUIRES REVIEW]`
then `[SYSTEM NOTICE]`, space-separated, prepended to the original
body. The pre-v0.0.25 `[AUTOPILOT GATED — <reason>]` marker is removed;
the send-side push-control brake replaces it (see
`design:push-control-v0` v1.1.0).

If your host CLAUDE.md treats `<channel source="junto-inbox" …>`
blocks as trusted instructions, gate the trust on the absence of these
markers. They exist precisely so a misrouted or budget-burning
auto-reply loop becomes visible instead of silent.

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
