# Todo hybrid implementation checklist

Normative source: `/home/yangfei/Private/Dw-Plans/paseo-todo-plugin-hybrid-plan.md`
(SHA-256 `6a9e374891c3584710e6ee82debddee50a40dce595360b7b18f332a83b6ba155`, 1280 lines)
Paseo baseline: `main@d7c7044dfc91d1d18721dc8757ac3bb913d8c232`
Implementation branch: `feat/todo-plugin-hybrid` (uncommitted working tree)

## Phase A — daemon Settings access

- [x] Typed Settings document handle and stable safe errors
- [x] Shared serialized loader/update path and `PluginServerContext.paseo`
- [x] Unit coverage for defaults, invalid, migration, no-op, CAS, reentry and poisoning (12 tests)
- [x] Server E2E for startup read, handler update, lifecycle update and client consistency
- [x] Settings example updated (`plugin-examples/settings`)
- [x] Maintainer and public reference documentation updated

## Phase B — native Agent launch

- [x] Public launch contracts and host navigation binding by server/plugin (adds `no_eligible_workspace`)
- [x] Versioned device-local journal and persisted draft metadata (draft store v6)
- [x] Stable labels/message identity wired through existing, `/new`, and background paths
- [x] Request-start milestones and journal-backed outcome-unknown create behavior
- [x] Journal unit tests: persistence failure, replay, conflict, wrong-device, plugin-isolation, GC (17 tests)
- [x] Draft migration/identity tests
- [x] Existing, `/new`, and background integration tests (create-flow, create-agent-request, background-handoff)
- [x] Completed/discarded behavior (tombstone, explicit discard on abandoned draft) and read-only UI enforcement
- [x] Native launch documentation (public reference "Native agent launch", docs/plugins.md)

## Phase C — Todo server and data

- [x] Plugin scaffold, private-host manifest (`>=0.8.0 <0.9.0`), runtime capability guards, schema and RPC contracts
- [x] Canonical document mutations, incarnation fencing, versions, fingerprints and capacity rules
- [x] Claim acquire, progress lattice, abandon/check and status aggregation
- [x] Reconciliation: single subscribe, scans, refresh, watermark, dirty rerun, bounded timeline search
- [x] Data/concurrency/recovery tests (55 unit tests) and daemon-backed E2E

## Phase D — Todo client

- [x] Read-only Settings adapter and project subscribe-buffer-list cache
- [x] Global surface, sidebar item, workspace panel, settings screen, Command Center items
- [x] CRUD, ordering (drag handle + Move up/down), archive/purge, rebind and launch flows
- [x] Compact layout, theme tokens, keyboard alternatives and accessibility labels

## Phase E — release and verification

- [x] Compatibility/capability gates and manifest range (test/compat.test.ts)
- [x] Plugin/public/maintainer documentation and privacy/trust warnings
- [x] Capacity benchmark and frozen limits/retention (test/benchmark/RESULTS.md)
- [x] DOM/module-boundary audit (`npm run audit:client`, a portable Node script proven to catch DOM
      globals, HTML elements, `className`, and DOM handlers; the plugin compiler's runtime-boundary
      check runs against the complete directory in the E2E install)
- [x] Targeted tests, builds, typechecks, lint and formatting
- [ ] Platform smoke flows (Electron, browser, iOS, Android, light/dark): not run — no app or daemon
      built from this branch is running; UI is verified by typecheck, audit, and logic tests only
- [ ] Deployment to the live daemon: blocked — see the final report (live daemon runs an `rw-main` build
      without the Phase A/B core APIs and cannot be restarted; dev daemon has no `pluginsEnabled`)

## Phase F — field fixes (2026-09-13)

Reported after the first live use, all in `client/` plus one new RPC:

- [x] Android could not scroll a list with more than one item: the surface passed `styles.screen`
      (which carries `flex: 1`) as the ScrollView `contentContainerStyle`, pinning content to the
      viewport. Added `styles.scrollContent` (`flexGrow: 1`). The pointer drag handle claims the
      touch on contact, so it now renders on non-compact layouts only; compact reorders with the
      Move up/Move down buttons.
- [x] Attempts became unactionable once a newer attempt took the claim: abandon now uses the
      attempt's own `claimGeneration`, and `todo.launch.forget` removes a finished attempt and its
      links from the Todo history (agents and workspaces untouched; a late agent for a forgotten
      attempt is rejected as `unknown_attempt`).
- [x] Execute starts the agent directly (`client/run.ts`): acquire → request-start milestones →
      `workspace.agents.create({ prompt, labels })` → agent-observation. The composer hand-off is
      still available as the second launch mode and is the only way to create a new workspace.
      Launch mode and last model live in a second settings document (`todo-prefs`).
- [x] Check status was silent: `todo.launch.check` now awaits the refresh it enqueues (8s budget)
      and re-reads before answering; the surface shows a busy label and reports what was checked.
      The duplicate per-attempt button is gone — it always checked the whole work item.
- [x] Work item actions trimmed to Execute / Mark done / More; Edit, Rebind, Move, Archive and
      Purge moved behind More.
- [x] Open workspace / Open agent / Workspace collapsed into one "Open agent" per linked agent,
      with "Open workspace" only for an attempt that named a workspace but has no agent yet.

## Acceptance bus

- [x] 1. Core has no Todo naming or second storage system
- [x] 2. Settings invalid/no-op/migration/serialization semantics verified
- [x] 3. Todo writes are fenced serialized document updates
- [x] 4. Claim competition and single-runtime journal behavior verified
- [x] 5. Request-start precedes effects; negative create remains unknown
- [x] 6. Orthogonal Attempt facts use monotonic field joins
- [x] 7. All reconciliation sources share source-aware convergence
- [x] 8. Existing, `/new`, and background preserve labels/message ID
- [x] 9. Restart recovery and completed tombstone verified
- [x] 10. Unknown never auto-retries/resends; duplicates retained
- [x] 11. Rebind/trust/remove/offline/non-atomic boundaries documented
- [x] 12. Capacity thresholds and retention benchmarked and frozen
- [x] 13. History and manual completion supported
- [x] 14. Manifest gates and optional launch capability verified
