# Paseo Todo plugin

Host-local work items that launch Paseo agents — started directly from Todo, or handed to the
native composer — and track every attempt, claim, and linked agent across all clients of one
daemon.

Normative design: `/home/yangfei/Private/Dw-Plans/paseo-todo-plugin-hybrid-plan.md`.
Paseo baseline: `main@d7c7044dfc91d1d18721dc8757ac3bb913d8c232` plus the `feat/todo-plugin-hybrid`
branch, which adds the two generic core extensions this plugin needs:

1. `server.registerSettings(...)` returns a typed daemon-side document handle and
   `PluginServerContext.paseo` is available during contribution startup.
2. `navigation.openAgentLaunch(...)` seeds the existing workspace draft or `/new` flow with immutable
   correlation labels and a stable `clientMessageId`, backed by a device-local launch journal.

## Layout

| Path | Owns |
| --- | --- |
| `shared/schema.ts` | Settings document (`todo-data`, version 1): work items, claims, attempts, agent links, retired IDs. |
| `shared/prefs.ts` | Second settings document (`todo-prefs`, version 1): launch mode, model, mode, thinking, and last-used workspace per project. Client-written; no business data. |
| `shared/contracts.ts` | Typed RPCs. Every mutation carries `expectedIncarnationId`; errors are stable codes. |
| `shared/attempt.ts`, `shared/state.ts` | Field-level lattice joins for attempt facts; canonical state mirror and aggregation. |
| `shared/limits.ts` | Field limits and frozen capacity tiers (see `test/benchmark/RESULTS.md`). |
| `server/store.ts` | One serialized `document.update` per business write: incarnation fence, `seq`, capacity admission. |
| `server/mutations.ts`, `server/apply.ts` | Pure mutations; snapshot apply with correlation discovery ahead of the projection gate. |
| `server/reconcile.ts` | Bootstrap scan (single subscribe), live upserts/removes, targeted refresh, periodic scan ∪ known-ID refresh, in-process watermarks and dirty reruns, bounded timeline search. |
| `client/run.ts` | Direct run: acquire, request-start milestones, `workspace.agents.create`, agent-observation. Same attempt records the composer path writes. |
| `client/` | React Native surface, sidebar item, workspace panel, settings screen, launch flows, recovery screen. |

## Trust and data lifecycle

- Todo targets the `daemon.manage` trust domain. Any client that can manage the daemon can read and
  change every item; project grouping is a filter, not a security boundary.
- Data lives in the host-scoped Settings document. Daemon restart, plugin reload, disable, and update
  keep it. Removing the plugin deletes it; there is no daemon-side restore.
- Launch drafts and journals live on the device that started them. Other devices can check status
  and open known agents but cannot take over a draft. Same-key serialization covers one JavaScript
  runtime; two browser tabs sharing storage are a documented residual risk.
- Projects that are removed and re-added get a new ID. Items become "unavailable" until the user
  rebinds them explicitly.
- After any request-start, every negative result is `outcome_unknown`. Todo never retries or resends;
  "Retry anyway" always creates a new, distinguishable attempt.
- Execute has two paths. **Start the agent now** creates the agent in an existing workspace and sends
  the prompt as its first message; **Open the composer** seeds the native draft and you press send.
  Both write the same claim, attempt and correlation labels, so they read and reconcile identically.
- Direct execution offers the selected model's **Thinking** options, using the same provider
  catalog as agent profiles. Successful launches remember the choices across clients and reloads.
  Each project remembers its own workspace; a saved workspace takes precedence over the current
  panel, and an unavailable workspace falls back to the current panel or an available target.
- An attempt stays actionable for its whole life: abandon is keyed to the attempt's own claim
  generation, not to whoever holds the claim now, and a finished attempt can be removed from the
  history with `todo.launch.forget` (Todo records only; the agent and workspace are untouched).

## Requirements

`paseo-plugin.json` declares `>=0.8.0 <0.9.0`, matching the private `rw-main` deployment model used
by local plugins such as Codeup. Semver identifies the compatible Paseo series; it does not prove
that a particular branch contains this plugin's host extensions. The server therefore verifies
`server.paseo` and the Settings document handle at startup, while the client checks
`openAgentLaunch` before offering the composer hand-off — a build without it still runs agents
directly. A stock or partial 0.8.x build fails those capability
guards with a clear upgrade/build message instead of pretending that an upstream patch release is
required.

## Develop

```bash
npm run typecheck            # tsc against the checkout's SDK, protocol, and client packages
npm test                     # unit tests: store, mutations, apply, reconciler, state fixtures, gates
npm run test:e2e             # real in-process daemon: install, RPCs, reconciliation, reload
npm run benchmark            # capacity benchmark → test/benchmark/RESULTS.md
npm run audit:client         # DOM/CSS leakage audit for client/
```

`node_modules` links to the sibling Paseo checkout (`../../paseo`) so SDK and protocol types match
the local commit. The E2E test copies this directory to a temporary location and installs it with
the same `>=0.8.0 <0.9.0` manifest used by the private `rw-main` deployment.

## Deploy

Requires the Todo host extensions to be integrated into the daemon and app build (for example by
merging `feat/todo-plugin-hybrid` into `rw-main`) and `pluginsEnabled: true` in the daemon's
`config.json`. No upstream version bump is required. Then:

```bash
npm run typecheck
paseo plugin install /home/yangfei/Projects/paseo-plugins/todolist
paseo plugin ls
paseo plugin logs todo
```
