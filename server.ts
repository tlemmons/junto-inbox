#!/usr/bin/env bun
/**
 * junto-inbox: Claude Code channel plugin that bridges the shared-memory MCP
 * server's per-agent inbox into a running CC session, and exposes a reply
 * tool that posts back to other agents' inboxes.
 *
 * Part of the Junto suite (umbrella brand for the multi-agent stack: junto-memory
 * MCP server, junto-inbox channel plugin, junto-control dashboard).
 *
 * v0.0.32 — API-key file source (backlog_80f9bbb265cc, security). The plugin's
 *          shared-memory API key was env-only (JUNTO_API_KEY), and process.env
 *          is inherited by every child claude spawns (Bash tool, hooks, other
 *          MCP servers) — an env-only key is a real exfil surface. New: a
 *          resolveApiKey() with precedence JUNTO_API_KEY_FILE (a path to a file
 *          holding the key; children inherit only the PATH, not the secret) WINS,
 *          falling back to JUNTO_API_KEY (direct env, back-compat) when the file
 *          is absent/empty/unreadable, else null (keyless). FILE-WINS is
 *          deliberate: a launcher can set BOTH during a mixed-plugin-version
 *          rollout — old plugins (≤0.0.31, env-only) read the env var, new
 *          plugins prefer the file — a zero-downtime migration. Deliberately NO
 *          silent default path (~/.junto is the launcher git clone; a stale key
 *          there would be hard-rejected — invalid key → 401, no keyless
 *          fallback). A set-but-broken _FILE → stderr warn + FALL BACK (to env,
 *          then keyless), never hard-exit (launcher allows keyless on open-auth
 *          servers). File contents trimmed (key files carry a trailing newline;
 *          untrimmed → invalid → 401). POSIX perms warning if the key file is
 *          group/world-readable (skipped on win32). Registry source out of scope.
 *          Version strings 0.0.31 → 0.0.32.
 * v0.0.31 — blocker statusline (Tom UX, msg_709fcaee2baf). Plugin half of a
 *          high-signal BLOCKER badge. (1) LaneCounts gains pending_blocker_open
 *          (subset of pending_action_open: category=blocker, obligation ∈
 *          open|responded|None — server-computed). (2) the status file's `lanes`
 *          block gains blocker_open = pending_blocker_open ?? 0. (3) statusline.ts
 *          prepends a RED `${n} BLOCKER` headline when >0; `open` stays the FULL
 *          action_open (Tom render choice: headline + full open, no subtraction).
 *          Back-compat: absent field (server pre-deploy / old server) → 0 → no
 *          BLOCKER part, identical to the prior line. Field lights up only once
 *          the server deploys pending_blocker_open. Version strings 0.0.30 → 0.0.31.
 * v0.0.30 — attach_session: the new PRIMARY startup call (backlog_c3d7bca5ab9c,
 *          Tom-decided 2026-06-18). PROBLEM it fixes: agents starting via the
 *          plugin path called get_session_id, which returns only {status,
 *          session_id, project, agent} — so they came up WITHOUT the server
 *          guidelines (mandatory_memory_query/"MEMORY FIRST", anti_sycophancy,
 *          db_write_safety, …) that memory_start_session returns. Result: agents
 *          re-asked Tom for keys/paths/build-steps already in junto. FIX: a new
 *          attach_session tool returns the FULL onboarding bundle — {status,
 *          session_id, project, agent, ...the cached memory_start_session
 *          response} (guidelines + locks + signals + interface_updates) — a true
 *          drop-in for start_session minus the duplicate-session creation, since
 *          the plugin already opened the session at bind. DESIGN NOTES: (1) the
 *          bundle is the start_session response CACHED at bindAndSubscribe (new
 *          module var sessionOnboarding), NOT a live re-fetch — memory_guidelines
 *          list returns the UNFILTERED superset (all projects' scoped rules), so
 *          the plugin must not re-derive the applicable set; the server already
 *          computed it at bind. Guidelines are therefore bind-time fresh (refresh
 *          on every reconnect/restart), which is the right tradeoff: absent →
 *          bind-time is the fix, and it matches exactly what start_session would
 *          have returned at the same moment. (2) get_session_id is KEPT, UNCHANGED
 *          (byte-for-byte same return) and demoted to a pure id/readiness accessor
 *          — backward-compatible for existing callers. (3) attach_session shares
 *          get_session_id's liveness contract (markReady + heartbeatOnce probe +
 *          not_ready fallback). Launcher templates + CLAUDE.md go macros repoint
 *          to attach_session separately (parts b/c of the backlog item). Client
 *          version strings 0.0.29 → 0.0.30 (3 sites).
 * v0.0.29 — server-authoritative delivery, STEP 2 (the strip) of
 *          design:server-authoritative-delivery-v0 v0.5.3 (§E/§SEQUENCING). The
 *          inject-latency smoke-test gate PASSED (announce surfaced at the host's
 *          next turn boundary mid-long-turn, full body inline), so the announce
 *          push is now the SOLE live-delivery path and the old window-read delivery
 *          is removed. Changes: (1) DELETE deliverNew + seenIds — the resource path
 *          no longer forwards messages, so there is nothing to dedup; the announce
 *          handler delivers action-lane messages live, and info/fyi are badge-only,
 *          surfaced on the host's go/reconcile pull. (2) DELETE the plugin FYI
 *          digest entirely — fyiQueue, flushFyiDigest, the 15-min timer, the 10-cap,
 *          the JUNTO_FYI_DIGEST kill switch, the FyiItem type (Tom: FYI = BADGE-ONLY,
 *          no server digest either). (3) readInboxAndForward → refreshLaneCounts: a
 *          single read-INERT resource read that captures the server's lane_counts for
 *          the badge and writes the status file — NO message emit. Wired to the same
 *          callers (resource_updated, bind, markReady, health-recovery). (4) BADGE
 *          M = server lane_counts.pending_fyi_waiting (per-message-unread + read-inert
 *          server-side → no longer zeroes on the plugin's glancing read, which is why
 *          the v0.0.27 fyiQueue-as-M workaround can retire). (5) soft FYI-AGING nudge:
 *          lane_counts now also carries pending_fyi_oldest_age_hours + fyi_ttl_hours
 *          (=48); statusline shows a dim "aging" hint as the oldest FYI nears the TTL.
 *          (6) forwardAnnounce drops the transitional [announce·<mode>] prefix +
 *          meta.source="announce" (no parallel path left to attribute against).
 *          Client version strings 0.0.28 → 0.0.29 (3 sites).
 * v0.0.28 — server-authoritative announce handler, STEP 1 of
 *          design:server-authoritative-delivery-v0 v0.5.3 (§E) — smoke-test prep,
 *          NO strip yet. Registers a handler for the custom JSON-RPC notification
 *          `notifications/junto/announce` that the server now CONTENT-PUSHES over
 *          the SSE stream to each connected subscriber on every action-lane send
 *          (info/fyi are NOT pushed — badge-only). Params are flat under `params`
 *          (no wrapper): {mode, from_agent, from_project, category, priority,
 *          msg_id, chain_depth, in_response_to, obligation_state, subject,
 *          require_human, is_system_notice, created_at} + inline `body` iff
 *          mode==="inject". On receipt the handler emits a notifications/claude/
 *          channel — full body inline for inject, a one-line header for header —
 *          then forgets. STATELESS: no seenIds, no cursor, no head-at-connect, no
 *          digest, no dedup (a deliberate re-push is just another notification we
 *          forward). The handler is ADDITIVE alongside the existing
 *          resource_updated→readInboxAndForward path (§E7: server keeps sending
 *          resource_updated too, so a server-new/plugin-old state degrades to
 *          quiet, never a flood). CONSEQUENCE during this transitional step: an
 *          ACTION message DOUBLE-EMITS — once via the announce handler, once via
 *          the resource path (info does not double; it has no announce push). To
 *          keep that attributable through the parallel run, announce-sourced
 *          emits carry meta.source="announce" + a `[announce·<mode>]` content
 *          prefix; both are removed in STEP 2 when the window-read path is
 *          dropped. STEP 2 (gated on the inject-latency smoke test passing): strip
 *          seenIds + plugin FYI digest + fyiQueue-as-M, drop the
 *          window-read-on-resource_updated announce path, render server lane_counts
 *          (M = pending_fyi_waiting) + the soft FYI-aging nudge. zod added as a
 *          direct dep (was transitive via the SDK; same resolved 4.3.6). Client
 *          version strings 0.0.27 → 0.0.28 (3 sites).
 * v0.0.27 — lanes-A render (Stage 3 of design:unified-messaging-v0; wire shape
 *          interface:lanes-a-server-wire-v0 v0.3.0, server half deployed b32f1a8).
 *          Two plugin-side renders of the server's per-msg lane/tier + top-level
 *          lane_counts. (1) BADGE: the status file gains a `lanes` block
 *          {action_open, fyi_waiting}; statusline.ts renders [N open · M FYI].
 *          action_open = server lane_counts.pending_action_open (watermark-
 *          INDEPENDENT → correct despite the plugin's continuous reads);
 *          fyi_waiting = the plugin's OWN held-FYI queue length, NOT the server's
 *          pending_fyi_waiting (which zeroes on watermark-advance the moment the
 *          plugin reads, before the human sees the FYI — only the plugin can
 *          honestly count "held, not yet shown"). (2) FYI DIGEST: lane==="fyi"
 *          messages divert from immediate per-msg delivery into fyiQueue and
 *          surface as ONE consolidated channel notif on flush — piggyback on the
 *          next action wake, a 15-min timer, or a 10-msg cap. action/cleared/
 *          unknown-lane/requires_review/system_notice still deliver immediately
 *          (fail-visible; never batch something that may need attention). Old
 *          server (no lane field) → everything immediate + no badge = identical
 *          to v0.0.26. Kill switch JUNTO_FYI_DIGEST=0 reverts FYI batching
 *          (badge then shows only [N open]). Client version strings 0.0.26 →
 *          0.0.27 (3 sites).
 * v0.0.26 — autopilot removal (plugin side; Phase 1 of design:autopilot-removal-v0).
 *          Statusline observability repoints from memory_autopilot_count to
 *          memory_get_emission_stats (push-control's live counters): the chip reads
 *          its own (agent, project) row {count, push_budget, hard_ceiling, suspended}
 *          and renders count/push_budget (hard_ceiling), red when suspended /
 *          over-ceiling / over-budget. Drops the opt-in AUTOPILOT_ENABLE bind block
 *          + JUNTO_AUTOPILOT_{ENABLE,DEPTH_CAP,BUDGET} env vars. Server-side
 *          autopilot_* tools are NOT deleted yet: sequencing is keep-then-delete
 *          (removal spec §3), NOT the memory_autopilot_* → memory_push_* alias regime
 *          the v0.0.25 note below assumed — no tool-alias infra exists and there is
 *          no memory_push_* tool to alias to. Idle case: the server's synthetic
 *          zero-row (removal spec §4(a), shipped c48f23c) returns live caps for a
 *          zero-emission agent so the idle chip shows 0/N (ceiling); the plugin also
 *          tolerates an empty stats[] (omits the budget segment) against an older
 *          server. Client version strings bumped
 *          0.0.25 → 0.0.26 (3 sites).
 * v0.0.25 — autopilot decouple. Push-control v0 (memory commit e82214d, spec
 *          design:push-control-v0 v1.1.0) moved the brake to the server send-side:
 *          per-sender depth_cap / push_budget / hard_ceiling are evaluated at
 *          send time, and the server-side delivery-time filter excludes
 *          push-suppressed messages from the inbox-resource read response unless
 *          the recipient's recency window is open. deliverNew no longer calls
 *          memory_autopilot_check_budget, no longer prepends [AUTOPILOT GATED]
 *          markers, and no longer emits meta.autopilot_gated. The memory_autopilot_*
 *          → memory_push_* 30-day alias keeps any leftover v0.0.24 callers working;
 *          v0.0.25 simply stops calling them. Also adds an opt-in [SYSTEM NOTICE]
 *          marker driven by m.is_system_notice for distinct visual treatment of
 *          system@junto's recovery notices (push-control §8). MCP Client name
 *          version strings bumped 0.0.24 → 0.0.25 (3 sites).
 * v0.0.24 — schema.ts tool-prefix rename to track the junto MCP server's
 *          shared_memory → junto serverInfo rename (Phase 2 client-label edits).
 *          CAPTURE_SET, DENY_LIST, TOOL_OP_TYPE_MAP, and SEND_MESSAGE_TOOL all
 *          flip from mcp__shared-memory__memory_* to mcp__junto__memory_*. The
 *          journal-replay path at line 845 now strips either prefix so
 *          pre-v0.0.24 entries on disk remain replayable. normalizeLegacyEntry
 *          maps legacy tool_name strings forward to the new prefix on load so
 *          TOOL_OP_TYPE_MAP lookups don't degrade to 'audit.event'. Adopters
 *          must also flip the PreToolUse hook matcher in .claude/settings.json
 *          from mcp__shared-memory__memory_* to mcp__junto__memory_*; without
 *          that flip the hook silently no-ops post-rename (graceful
 *          degradation — send_message is still journaled by the plugin's own
 *          handler). Server wire protocol unchanged; URL unchanged.
 * v0.0.23 — render-side autopilot gate no longer silent-drops. deliverNew used
 *          to `continue` (skipping both seenIds.add and the channel emit) when
 *          memory_autopilot_check_budget returned allowed=false for a
 *          chain_depth>=1 message — so cross-agent replies arriving while the
 *          receiver's autopilot was disabled or budget-exceeded were silently
 *          dropped, with only an invisible stderr line. Now: render either way,
 *          prepend [AUTOPILOT GATED — <reason>] marker, emit
 *          meta.autopilot_gated=true so the host knows not to auto-reply. The
 *          send-side budget enforcement (server flips enabled=False on breach,
 *          send_message tool errors loudly) is unchanged and remains the
 *          correct boundary; render is now unconditional. Diagnosed from
 *          memory@junto's msg_5e4d9055906c bind-replay anomaly: my reply
 *          msg_9948fb5c8bcb (chain_depth=2) failed to render while two
 *          self-sent probes (chain_depth=0) rendered cleanly.
 * v0.0.22 — agentReady safety net + boot-failed status state. (1) Post-subscribe
 *          60s timer auto-flips agentReady if the host CC's `go` macro never
 *          calls get_session_id or send_message (memory@junto's CLAUDE.md routes
 *          through memory_start_session; default global ~/.claude/CLAUDE.md does
 *          the same; both leave the v0.0.8 gate closed indefinitely and silently
 *          drop every channel push). Timer is idempotent — well-behaved hosts
 *          where markReady already fired see it as a no-op. v0.0.8's design
 *          intent (don't deliver before host context loaded) preserved for the
 *          common case; 60s bounds the silent-drop window for non-conforming
 *          hosts. (2) New 'boot-failed' status state distinguishes "never
 *          successfully connected" from "previously connected, currently
 *          retrying". everConnected flag set true on first successful bind;
 *          supervisor catch writes 'boot-failed' before first success and
 *          'reconnecting' after. Operators get a clear signal: boot-failed =
 *          check URL/network/auth; reconnecting = transient, will recover.
 *          Diagnosis credit: memory@junto's msg_8267f2740eb6 — three
 *          messages from this side silently dropped on memory's CC despite
 *          status file healthy, live_subscribers=1, and server-side _notify
 *          firing correctly. Tom had to verbally poke memory to surface them.
 *          Workaround in flight that turn: memory called the plugin's
 *          get_session_id tool mid-turn, which flipped agentReady, drained.
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
 * v0.0.6 — env-gates the debug-log writes behind CT_DEBUG=1. Default install
 *          is silent. (Current code: the gate is JUNTO_DEBUG=1 and the file
 *          is ./junto-inbox-debug.log — renamed in the v0.0.15 CT_*→JUNTO_*
 *          migration.) process.stderr is unchanged (CC captures it in
 *          ~/.claude/debug/<session>.txt).
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
  NotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'fs'
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

// Read a bare API key from a file. Returns the trimmed key, or null (with a
// warning + debug line) if the file is missing / unreadable / empty. Never logs
// the key value — only its source/path.
function readKeyFile(path: string): string | null {
  if (!existsSync(path)) {
    process.stderr.write(
      `junto-inbox: JUNTO_API_KEY_FILE points to a missing file (${path}); falling back to JUNTO_API_KEY / keyless\n`,
    )
    debugLog(`api-key: JUNTO_API_KEY_FILE missing (${path}) -> fallback`)
    return null
  }

  // Best-effort perms warning: a key file readable by group/other is a leak.
  // mode bits are only meaningful on POSIX; skip on Windows.
  if (process.platform !== 'win32') {
    try {
      const mode = statSync(path).mode
      if ((mode & 0o077) !== 0) {
        process.stderr.write(
          `junto-inbox: JUNTO_API_KEY_FILE (${path}) is group/world-readable; chmod 600 recommended\n`,
        )
      }
    } catch {
      // best-effort only
    }
  }

  let contents: string
  try {
    contents = readFileSync(path, 'utf8')
  } catch (err) {
    process.stderr.write(
      `junto-inbox: JUNTO_API_KEY_FILE (${path}) unreadable (${(err as Error).message}); falling back to JUNTO_API_KEY / keyless\n`,
    )
    debugLog(`api-key: JUNTO_API_KEY_FILE unreadable (${path}) -> fallback`)
    return null
  }

  // Trim: key files carry a trailing newline; an untrimmed key is invalid and
  // hard-rejected server-side. Tokens are opaque and whitespace-free, so trim
  // is safe. An empty/whitespace-only file falls back.
  const key = contents.trim()
  if (key === '') {
    debugLog(`api-key: JUNTO_API_KEY_FILE (${path}) empty -> fallback`)
    return null
  }
  debugLog(`api-key: sourced from JUNTO_API_KEY_FILE (${path})`)
  return key
}

// Resolve the shared-memory API key without forcing it into the process env
// (env is inherited by every child claude spawns — Bash, hooks, other MCP
// servers — so an env-only key is a real exfil surface, backlog_80f9bbb265cc).
// Precedence: JUNTO_API_KEY_FILE (a path to a file holding the key; children
// inherit only the PATH) WINS, falling back to JUNTO_API_KEY (direct env) when
// the file is absent/empty/unreadable, else null (keyless). File-wins lets a
// launcher set BOTH during a mixed-plugin-version rollout: old plugins (≤0.0.31,
// env-only) read the env var while new plugins prefer the file — a zero-downtime
// migration. No silent default path: ~/.junto is the launcher git clone, and a
// stale key file there would be hard-rejected (invalid key → 401, no keyless
// fallback). A set-but-broken JUNTO_API_KEY_FILE warns but falls back rather than
// hard-exiting (the launcher deliberately allows keyless launch on open-auth servers).
function resolveApiKey(): string | null {
  const keyFile = envVar('API_KEY_FILE')
  if (keyFile !== undefined) {
    const fromFile = readKeyFile(keyFile)
    if (fromFile !== null) return fromFile
  }
  return envVar('API_KEY') ?? null
}

const URL_DEFAULT = 'http://localhost:8080/mcp'
const SHARED_URL = envVar('SHARED_MEMORY_URL') ?? URL_DEFAULT
const PROJECT = envVar('PROJECT')
const AGENT = envVar('AGENT')
const API_KEY = resolveApiKey()
const ROLE = envVar('ROLE') ?? null

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

type PluginStatus = 'connected' | 'reconnecting' | 'shutdown' | 'boot-failed'

// v0.0.29 — lanes-A badge render (server-authoritative). The server tags every
// message with lane ("action"|"cleared"|"fyi") + tier and returns top-level
// lane_counts; the plugin renders the BADGE only — the status file's `lanes` block
// {action_open, fyi_waiting} is shown by statusline.ts as [N open · M FYI]. BOTH
// counts now come straight from the server's lane_counts: action_open =
// pending_action_open, fyi_waiting = pending_fyi_waiting. Under per-message-unread
// (read_by) these are read-INERT through the resource read — the plugin's glancing
// counts-refresh never marks anything read, so pending_fyi_waiting no longer zeroes
// before the human sees the FYI, which retires the v0.0.27 fyiQueue-as-M workaround.
// FYI = BADGE-ONLY (Tom): there is no plugin FYI digest and no server digest — info
// surfaces on the host's go/reconcile pull. The soft FYI-aging nudge
// (pending_fyi_oldest_age_hours vs fyi_ttl_hours) is passed through for statusline
// to hint "FYIs aging, drain soon" as the oldest nears the 48h TTL.
type EmissionSnapshot = {
  count?: number
  push_budget?: number
  hard_ceiling?: number
  suspended?: boolean
}
type LaneCounts = {
  pending_action_open?: number
  pending_action_responded?: number
  // v0.0.31 — blocker statusline (Tom UX). Subset of pending_action_open:
  // unresolved blockers addressed to this agent (category=blocker, obligation
  // ∈ open|responded|None). Absent on pre-deploy/old servers → treated as 0.
  pending_blocker_open?: number
  pending_fyi_waiting?: number
  // v0.0.29 — soft FYI-aging guidance (not a force; nothing auto-expires here).
  // The server reports the oldest waiting FYI's age and the info TTL so the
  // statusline can nudge "drain soon" before info ages out at the TTL.
  pending_fyi_oldest_age_hours?: number
  fyi_ttl_hours?: number
}

// v0.0.28 — server-authoritative announce push (design:server-authoritative-
// delivery-v0 v0.5.3 §E3). The server content-pushes this custom JSON-RPC
// notification to each connected subscriber session on every action-lane send.
// Params are FLAT under `params` (no params.data wrapper). The schema is
// deliberately LENIENT — only the fields we need to render are required; the
// rest are optional/nullish and the params object is loose — so a minor server
// type surprise degrades render, never DROPS the wake (a strict-parse failure
// would throw inside the SDK handler and lose the announce; durable-unread would
// still catch the message at go, but the live wake would be silently lost).
const AnnounceNotificationSchema = NotificationSchema.extend({
  method: z.literal('notifications/junto/announce'),
  params: z.looseObject({
    mode: z.enum(['inject', 'header']),
    from_agent: z.string(),
    from_project: z.string().nullish(),
    category: z.string().nullish(),
    priority: z.string().nullish(),
    msg_id: z.string(),
    chain_depth: z.number().nullish(),
    in_response_to: z.string().nullish(),
    obligation_state: z.string().nullish(),
    subject: z.string().nullish(),
    require_human: z.boolean().nullish(),
    is_system_notice: z.boolean().nullish(),
    created_at: z.string().nullish(),
    body: z.string().nullish(),
  }),
})
type AnnouncePacket = z.infer<typeof AnnounceNotificationSchema>['params']

let lastEmission: EmissionSnapshot | null = null
let lastLaneCounts: LaneCounts | null = null

function writeStatus(state: PluginStatus, extras: Record<string, unknown> = {}): void {
  try {
    if (!statusDirCreated) {
      mkdirSync(STATUS_DIR, { recursive: true })
      statusDirCreated = true
    }
    // lanes block: included once we've ever seen server lane_counts. Both counts
    // are server-sourced (read-inert under per-message-unread). The aging fields
    // pass straight through for statusline's soft "FYIs aging" nudge. Omitted
    // entirely for an old server (no lane_counts) → clean statusline, no badge.
    const lanes = lastLaneCounts
      ? {
          action_open: lastLaneCounts.pending_action_open ?? 0,
          // v0.0.31 — blocker_open: subset of action_open (high-signal, usually
          // 0). `?? 0` keeps the field present+zero for a deployed server and
          // back-compat for a pre-deploy one (no pending_blocker_open → 0).
          blocker_open: lastLaneCounts.pending_blocker_open ?? 0,
          fyi_waiting: lastLaneCounts.pending_fyi_waiting ?? 0,
          ...(typeof lastLaneCounts.pending_fyi_oldest_age_hours === 'number'
            ? { fyi_oldest_age_hours: lastLaneCounts.pending_fyi_oldest_age_hours }
            : {}),
          ...(typeof lastLaneCounts.fyi_ttl_hours === 'number'
            ? { fyi_ttl_hours: lastLaneCounts.fyi_ttl_hours }
            : {}),
        }
      : null
    const payload = JSON.stringify({
      state,
      project: PROJECT,
      agent: AGENT,
      session_id: sessionId,
      pid: process.pid,
      last_update: new Date().toISOString(),
      health_state: healthState,
      journal_count: journal.length,
      ...(lastEmission ? { emission: lastEmission } : {}),
      ...(lanes ? { lanes } : {}),
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
// interval), the plugin enters OFFLINE state: statusline indicator goes red and
// refreshLaneCounts becomes a no-op (no point reading the inbox resource against
// a dead server). On next successful probe, returns to ONLINE and resumes.
let healthState: 'online' | 'offline' = 'online'
let healthFailCount = 0
let healthTimer: ReturnType<typeof setInterval> | null = null
let healthClient: Client | null = null

async function probeServerHealth(): Promise<boolean> {
  try {
    if (!healthClient) {
      const transport = new StreamableHTTPClientTransport(new URL(SHARED_URL))
      const client = new Client({ name: 'junto-inbox-health', version: '0.0.32' }, { capabilities: {} })
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
    void refreshLaneCounts()
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
// v0.0.30: the full memory_start_session response captured at bindAndSubscribe,
// minus nothing — attach_session hands it back so the host gets the server
// guidelines + locks/signals/interface_updates without opening a duplicate
// session. Server-computed applicable guideline set; bind-time fresh (re-set on
// every reconnect, cleared on disconnect). NOT a live re-fetch (see v0.0.30 note).
let sessionOnboarding: Record<string, unknown> | null = null
let agentReady = false
// v0.0.22: distinguishes "never connected" (boot-failed) from "previously
// connected, currently disconnected" (reconnecting) in the supervisor catch.
// First successful bindAndSubscribe sets this true; never reset.
let everConnected = false

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
  process.stderr.write(`junto-inbox: agent ready (${via})\n`)
  debugLog(`markReady: signal=${via}`)
  // Refresh the badge once the host is ready. No message drain: action-lane
  // messages arrive live via the announce push; anything that landed while the
  // host was away is durable-unread and reconciled by the host's go-pull.
  void refreshLaneCounts()
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
  { name: 'junto-inbox', version: '0.0.32' },
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
      name: 'attach_session',
      description:
        'PRIMARY STARTUP CALL — call this first, instead of memory_start_session. ' +
        'Attaches the host CC to the junto-inbox plugin\'s already-open shared-memory ' +
        'session and returns the full onboarding bundle: {status:"ready", session_id, ' +
        'project, agent, guidelines (server-managed behavioral rules you MUST read and ' +
        'obey), plus active locks / signals / interface_updates}. A true drop-in for ' +
        'memory_start_session minus the duplicate-session creation, and it REPLACES the ' +
        'old two-step (get_session_id then memory_guidelines) — guidelines now come back ' +
        'in the same call. Use the returned session_id for ALL mcp__junto__memory_* calls. ' +
        'Returns {status:"not_ready"} if the plugin has not bound yet (cold start / ' +
        'mid-reconnect) — call once more after a short delay, then fall back to ' +
        'memory_start_session. Guidelines are bind-time fresh (refresh on plugin ' +
        'reconnect/restart).',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'get_session_id',
      description:
        'Pure id/readiness accessor: returns {status, session_id, project, agent} only — ' +
        'NO guidelines bundle. For STARTUP use attach_session instead (it returns the ' +
        'guidelines too). Use get_session_id for the narrow case of re-fetching the ' +
        'session id after the plugin reconnected and the prior id went stale. Returns ' +
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
  if (req.params.name === 'attach_session') {
    // attach_session (v0.0.30, backlog_c3d7bca5ab9c) — the primary startup call.
    // True drop-in for memory_start_session's onboarding minus the duplicate
    // session: the plugin opened the session at bind and cached that response in
    // sessionOnboarding; the host ATTACHES and gets briefed (session_id + server
    // guidelines + locks/signals/interface_updates). Same liveness contract as
    // get_session_id: it is also a "host is live" signal, so markReady, and the
    // session may have been ended by a prior /clear+go persona, so heartbeat-probe
    // before handing back.
    markReady('attach_session')
    if (sessionId && sm) {
      try {
        await heartbeatOnce()
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err)
        forceReconnect(`attach_session liveness check failed (${m})`)
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
    // Spread the cached start_session onboarding (guidelines/locks/signals/
    // interface_updates, and its own session_id == sessionId), then pin the
    // canonical readiness/identity fields on top so they always win.
    const bundle = {
      ...(sessionOnboarding ?? {}),
      status: 'ready',
      session_id: sessionId,
      project: PROJECT,
      agent: AGENT,
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(bundle) }],
    }
  }

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
    // Strip the mcp__junto__ (current) or mcp__shared-memory__ (pre-v0.0.24)
    // prefix to get the bare tool name the junto MCP server actually exposes.
    // The hook stores the full CC-visible tool_name so it survives across
    // version-skew on adopter agents; the plugin's sm client uses the bare
    // names. The legacy prefix branch keeps pre-rename journal entries
    // replayable through v0.0.24+ plugins.
    const bareName = entry.tool_name.replace(/^mcp__(junto|shared-memory)__/, '')
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

// v0.0.29 — STEP 2 removed deliverNew + the plugin FYI digest entirely. The
// announce push (forwardAnnounce) is the sole live-delivery path for action-lane
// messages; info/fyi are badge-only and reconciled by the host's go-pull. The
// resource read survives only as refreshLaneCounts (badge counts, no emit).

// Announce handler (the sole live-delivery path as of v0.0.29 STEP 2). Receives a
// server-pushed `notifications/junto/announce` and emits a single
// notifications/claude/channel toward the host CC, then forgets. STATELESS: no
// seenIds, no dedup, no cursor — the server only pushes action-lane sends and a
// deliberate re-push (escalation/release) is just another notification we forward.
// We gate on agentReady so we never push to a host that hasn't loaded its
// state/guidelines yet; an announce missed while not-ready (or while the host is
// offline at push) is recovered from the durable unread set at the host's next
// `go`. v0.0.29 dropped the transitional [announce·<mode>] prefix + meta.source
// (no parallel resource path left to attribute against).
async function forwardAnnounce(p: AnnouncePacket): Promise<void> {
  if (!agentReady) {
    debugLog(`forwardAnnounce: dropped (agent not ready) msg_id=${p.msg_id} mode=${p.mode}`)
    return
  }
  const requiresReview = p.require_human === true
  const isSystemNotice = p.is_system_notice === true
  const markers: string[] = []
  if (requiresReview) markers.push('[REQUIRES REVIEW]')
  if (isSystemNotice) markers.push('[SYSTEM NOTICE]')
  const prefix = markers.length ? `${markers.join(' ')} ` : ''

  let content: string
  if (p.mode === 'inject' && typeof p.body === 'string' && p.body.length > 0) {
    // inject: full body inline (latency-to-attention tier).
    content = `${prefix}${p.body}`
  } else {
    // header: no body on the wire — render a one-line header from the fields.
    const subj = p.subject ? `: ${p.subject}` : ''
    const from = `${p.from_agent}@${p.from_project ?? PROJECT}`
    const tags = `[${p.category ?? 'info'}/${p.priority ?? 'normal'}]`
    content = `${prefix}${from} ${tags}${subj} (msg ${p.msg_id})`
  }

  // meta values must all be strings, snake_case keys (CC channel meta is
  // Record<string,string>). Null/absent optionals are omitted, not stringified.
  const meta: Record<string, string> = {
    mode: p.mode,
    msg_id: p.msg_id,
    from_agent: p.from_agent,
    from_project: String(p.from_project ?? PROJECT),
    chain_depth: String(p.chain_depth ?? 0),
    category: String(p.category ?? 'info'),
    priority: String(p.priority ?? 'normal'),
    ts: String(p.created_at ?? new Date().toISOString()),
    requires_review: String(requiresReview),
    is_system_notice: String(isSystemNotice),
  }
  if (p.in_response_to) meta.in_response_to = String(p.in_response_to)
  if (p.obligation_state) meta.obligation_state = String(p.obligation_state)

  try {
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content, meta },
    })
    debugLog(`forwardAnnounce: emitted mode=${p.mode} msg_id=${p.msg_id} from=${meta.from_agent}@${meta.from_project} review=${requiresReview} system_notice=${isSystemNotice}`)
  } catch (err) {
    // Best-effort, like every other channel emit. A dropped push is recovered
    // by the durable-unread go/park reconcile; we do not requeue (stateless).
    debugLog(`forwardAnnounce: emit failed msg_id=${p.msg_id}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

type InboxPage = {
  error?: string
  lane_counts?: LaneCounts
}

// v0.0.29 — counts-only refresh (replaces the old readInboxAndForward delivery
// path). A single read-INERT resource read that captures the server's lane_counts
// for the badge and writes the status file. It does NOT forward messages:
// action-lane delivery is the announce push (forwardAnnounce), and info/fyi are
// badge-only, reconciled by the host's go-pull. lane_counts is computed
// server-side over the FULL inbox, so page 1 of the resource is sufficient — no
// pagination. Read-inert under per-message-unread (read_by), so glancing for the
// badge never marks anything read and never zeroes pending_fyi_waiting.
async function refreshLaneCounts() {
  if (!sm) return
  if (healthState === 'offline') {
    // Server unreachable — no point reading the inbox resource. Recovery
    // (noteHealth offline→online) calls this again.
    debugLog(`refreshLaneCounts: skipped, healthState=offline`)
    return
  }
  let body: InboxPage
  try {
    const result = await sm.readResource({ uri: INBOX_URI })
    const text = (result.contents?.[0] as { text?: string } | undefined)?.text
    if (!text) return
    body = JSON.parse(text) as InboxPage
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err)
    process.stderr.write(`junto-inbox: lane-counts read failed: ${m}\n`)
    debugLog(`refreshLaneCounts: throw=${m}`)
    return
  }
  if (body.error) {
    process.stderr.write(`junto-inbox: lane-counts read error: ${body.error}\n`)
    debugLog(`refreshLaneCounts: error=${body.error}`)
    return
  }
  if (body.lane_counts) {
    lastLaneCounts = body.lane_counts
    debugLog(`refreshLaneCounts: lane_counts=${JSON.stringify(body.lane_counts)}`)
    writeStatus('connected')
  } else {
    // Old server with no lane_counts → leave the badge as-is (omitted entirely
    // if we've never seen counts), matching the pre-lanes clean statusline.
    debugLog(`refreshLaneCounts: no lane_counts in resource`)
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

// Read-only poll of push-control's per-sender emission counters. No event
// recorded. Safe to call on every heartbeat. Returns null on any failure so a
// flaky observability call never breaks the heartbeat path.
//
// get_emission_stats(agent, project) returns {count, stats:[row]} where the
// explicit agent= filter narrows to this plugin's own current-hour row
// server-side. An empty stats[] means zero emissions this hour: until the
// server ships the synthetic zero-row (design:autopilot-removal-v0 §4(a)) that
// case yields null → the chip omits the budget segment. Once the zero-row
// lands, stats[0] carries count:0 + live caps + the resolved suspended flag and
// the idle chip renders normally.
async function fetchEmissionSnapshot(): Promise<EmissionSnapshot | null> {
  if (!sm || !sessionId) return null
  try {
    const res = (await callMemory('memory_get_emission_stats', {
      session_id: sessionId,
      agent: AGENT,
      project: PROJECT,
    })) as { stats?: Array<Record<string, unknown>> } | null
    const row = res?.stats?.[0]
    if (!row || typeof row !== 'object') return null
    return {
      count: typeof row.count === 'number' ? row.count : undefined,
      push_budget: typeof row.push_budget === 'number' ? row.push_budget : undefined,
      hard_ceiling: typeof row.hard_ceiling === 'number' ? row.hard_ceiling : undefined,
      suspended: typeof row.suspended === 'boolean' ? row.suspended : undefined,
    }
  } catch (err) {
    debugLog(`fetchEmissionSnapshot: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function startHeartbeat(onFailure: (err: Error) => void): void {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    void heartbeatOnce()
      .then(async () => {
        lastEmission = await fetchEmissionSnapshot()
        writeStatus('connected')
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
  const client = new Client({ name: 'junto-inbox-client', version: '0.0.32' }, { capabilities: {} })
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, async notif => {
    // v0.0.29 — resource_updated now only refreshes the badge counts; it no
    // longer forwards messages (that's the announce push). Read-inert.
    if (notif.params.uri === INBOX_URI) await refreshLaneCounts()
  })
  // Server-authoritative announce push (the live-delivery path). Custom-method
  // notifications are dispatched by method literal exactly like resource_updated;
  // an unregistered method would silently no-op, so registering this is the whole
  // opt-in.
  client.setNotificationHandler(AnnounceNotificationSchema, async notif => {
    await forwardAnnounce(notif.params)
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
  // v0.0.30: stash the whole onboarding response for attach_session. This is the
  // server's already-computed applicable guideline set (global + this project)
  // plus locks/signals/interface_updates — handed back verbatim so attach_session
  // is a true drop-in for start_session without a second session.
  sessionOnboarding = start && typeof start === 'object' ? (start as Record<string, unknown>) : null

  await client.subscribeResource({ uri: INBOX_URI })
  process.stderr.write(`junto-inbox: connected, session=${sessionId}, subscribed=${INBOX_URI}\n`)
  debugLog(`bindAndSubscribe: connected session=${sessionId} sub=${INBOX_URI}`)
  writeStatus('connected', { source: 'bind' })
  everConnected = true

  // v0.0.22: post-subscribe agentReady safety net. The agent's `go` macro
  // normally flips agentReady via the get_session_id tool call (per v0.0.8's
  // design — channel delivery is gated until the host has loaded state spec /
  // guidelines / backlog). Hosts whose CLAUDE.md routes through
  // memory_start_session directly (memory@junto's project CLAUDE.md, the
  // default global ~/.claude/CLAUDE.md "Shared Memory MCP" macro) leave the
  // gate closed indefinitely, silently dropping every push. 60s is generous
  // for well-behaved hosts (markReady has already fired, this is a no-op) and
  // bounds the silent-drop window for non-conforming hosts. Idempotent —
  // re-arms harmlessly on every reconnect since markReady early-returns when
  // agentReady is already true.
  setTimeout(() => markReady('post-subscribe-timeout'), 60_000)

  await drainJournal()
  await refreshLaneCounts()
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
      const failState: PluginStatus = everConnected ? 'reconnecting' : 'boot-failed'
      process.stderr.write(`junto-inbox: link down (${errMsg}) -- ${failState} in ${backoff}ms\n`)
      writeStatus(failState, { error: errMsg, backoff_ms: backoff, source: 'supervisor' })
      sm = null
      sessionId = null
      sessionOnboarding = null // stale once the session is gone; re-set on rebind
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
