# Todo hybrid implementation checklist

Normative source: `/home/yangfei/Private/Dw-Plans/paseo-todo-plugin-hybrid-plan.md`
(SHA-256 `6a9e374891c3584710e6ee82debddee50a40dce595360b7b18f332a83b6ba155`, 1280 lines)
Paseo baseline: `main@d7c7044dfc91d1d18721dc8757ac3bb913d8c232`
Implementation branch: `feat/todo-plugin-hybrid`, merged into `rw-main` (`ea8794802`, 2026-09-12)

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
- Dropped (2026-09-15): wide layout with two columns or side details (plan §13.4). Every width
  renders the single-column list while a different layout is under consideration.

## Phase E — release and verification

- [x] Compatibility/capability gates and manifest range (test/compat.test.ts)
- [x] Plugin/public/maintainer documentation and privacy/trust warnings
- [x] Capacity benchmark and frozen limits/retention (test/benchmark/RESULTS.md)
- [x] DOM/module-boundary audit (`npm run audit:client`, a portable Node script proven to catch DOM
      globals, HTML elements, `className`, and DOM handlers; the plugin compiler's runtime-boundary
      check runs against the complete directory in the E2E install)
- [x] Targeted tests, builds, typechecks, lint and formatting
- [ ] Platform smoke flows (Electron, browser, iOS, Android, light/dark): not run as a recorded
      matrix. Field use on the live `rw-main` build surfaced the Phase F fixes, but UI is otherwise
      verified by typecheck, audit, and logic tests only
- [x] Deployment to the live daemon: `rw-main` contains `feat/todo-plugin-hybrid`, the daemon
      `config.json` has `pluginsEnabled: true`, and `todo` is installed from this directory

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

Deviation from the normative plan: §1 and §3.1.4 leave Provider, Model, Mode and Thinking to the
native flow, and §13.3 blocks every launch before acquire when `openAgentLaunch` is missing. Direct
execution picks the model in Todo and needs only `workspace.agents.create`, so the capability guard
now gates the composer hand-off alone.

## Phase G — launch preferences (2026-09-15)

- [x] Direct execution offers the selected model's Thinking options from the same provider catalog as
      agent profiles; switching models drops a thinking level the new model does not support.
- [x] `todo-prefs` stays version 1 with two defaulted fields, `thinkingOptionId` and
      `workspaceByProject`; existing documents keep their saved model and mode.
- [x] Each project remembers its last successful launch target, shared by the surface and the
      workspace panel. An explicit choice in the dialog wins, then the saved workspace, then the
      current panel; a removed or foreign workspace falls back to an available target.
- [x] Execute stays disabled while preferences or workspaces load; a launch that succeeds but cannot
      save its choices reports it with a toast instead of failing silently.
- [x] Tests: `test/launch-defaults.test.ts` (9), `test/run.test.ts` (3), and the E2E preference
      round trip across a plugin reload.

## Phase H — board view (in progress)

Normative source: `/home/yangfei/Private/Dw-Plans/paseo-todo-kanban-plan.md`, branch
`feat/todo-kanban`.

- [x] Stage 1, data and rules:
  - `todo-data` version 2 with six statuses, `number`, `statusChangedAt`, `statusReason` and
    `nextWorkItemNumber`, plus the version 1 migration;
  - `todo.work-items.move` (last-writer-wins, best-effort placement) replaces `set-status`;
  - create takes an initial status;
  - acquire refuses Done and Cancelled;
  - automatic moves R1–R3 with `auto_move` logs;
  - the list UI shows the status and maps Mark done / Reopen onto moves.

  Tests: `test/board.test.ts` (14), `test/migration.test.ts` (5), move, number and acquire cases in
  `test/mutations.test.ts`, one reconciler path, and the E2E launch → In progress → In review →
  move flow. A dry run on a copy of the live document migrated both open items to In review.
- [x] Stage 2, board UI:
  - one project per board, with a picker remembered in `todo-prefs.boardProjectId`;
  - Active / All / Backlog / Cancelled / Archived filters and search by number, title and details;
  - columns side by side when they fit (240 px each), a horizontally scrolling row when at least two
    fit, and status tabs below that; the page itself keeps scrolling vertically;
  - cards with number, title, details excerpt, attention badges and the latest agent line;
  - the move menu (column chips, Move up / Move down), creating into a column, and the card detail
    that replaces the expanded list row. Actions that open another dialog close the detail first.

  The old list (`todo-list.tsx`, `work-item-row.tsx`) is gone. Tests: board grouping, filters,
  search, neighbours, layout, relative time and latest agent in `test/board.test.ts`.

  Verified in the web app against an isolated dev daemon at 1440 px and 400 px wide: create into a
  column, Move up, move from the menu and the detail, archive, the Archived list, search, status tabs,
  the move menu, detail and editor bottom sheets, Execute opening from the detail, and switching
  projects across a reload. That pass also fixed a card that nested buttons (invalid on the web),
  exposed chip selection to assistive technology, and narrowed columns so four fit beside the host
  sidebar.

  Not verified yet:
  - Android and iOS native;
  - the agent line with real agents, since the dev daemon had no provider;
  - an unavailable project.

  Known issue predating the board: a project added while Todo is open only reaches the plugin's
  project list after a reload.
- [x] Stage 3, moving a card into In progress gets an agent working:
  - `resolveInProgressIntent` decides:
    - an agent running or a launch in flight → move only, with a toast;
    - an agent waiting for permission → open it;
    - a finished, failed or closed agent → the follow-up dialog;
    - otherwise → the execute dialog with Move only.
  - The card moves when the user confirms, never optimistically.
  - The follow-up dialog (`client/continue-modal.tsx`, `client/follow-up.ts`):
    - keeps one message ID per opening and locks the text after a send;
    - offers only "Retry the same message" after an unconfirmed send;
    - re-checks the live card before sending, because a send interrupts a running turn.
  - The card detail gains Continue agent.

  V1/V2 were checked against the server source and a fake-provider test daemon:
  - a same-ID resend is delivered once;
  - the same ID with other text is a conflict;
  - an ambiguous earlier send is never replayed;
  - an archived agent is unarchived and runs;
  - an error-state agent was confirmed from the source only.

  Tests: intent cases in `test/board.test.ts` and `test/follow-up.test.ts`.

  Verified in the web app against a fake-provider test daemon:
  - follow-up from the move menu → the agent ran → the card went back to In review;
  - Move only from the execute dialog;
  - Done → In progress then Cancel leaves the card in Done;
  - Continue agent from the detail;
  - an unconfirmed send after deleting the agent, and the stale link hiding Continue.

  That pass split the card's agent line into two rows and separated "running" from "unreachable"
  in the dialog's notices.

  Observation, predating stage 3: while an agent's first snapshots arrived out of order, R2/R3
  briefly bounced a card In review → In progress → In review within 30 ms. The final state was
  correct.
- [ ] Stage 4: drag and drop on wide layouts
- [ ] Stage 5: docs, benchmark, smoke flows, data backup before deploy

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
