# Todo capacity benchmark

Generated 2026-09-15T08:08:34.314Z by test/benchmark/capacity.ts.

Measurement: UTF-8 bytes of `JSON.stringify({ version, values })`, identical to the server admission check.

## Per-record cost

| Record | Bytes |
| --- | --- |
| Empty document | 181 |
| Work item (400 B details, 600 B prompt) | 1592 |
| Attempt + claim (600 B seed prompt) | 2027 |
| AgentLink | 502 |
| Retired ID entry | 119 |

## Scenarios

| Scenario | Document | Soft (512 KiB) | Reserve (+64 KiB) | Absolute (1 MiB) |
| --- | --- | --- | --- | --- |
| personal (50 items, 1 attempt) | 207.9 KiB | ok | ok | ok |
| team (200 items, 2 attempts) | 1383.6 KiB | exceeds | exceeds | exceeds |
| heavy (500 items, 3 attempts) | 5470.8 KiB | exceeds | exceeds | exceeds |
| history-heavy (300 items, 6 attempts) | 5227.1 KiB | exceeds | exceeds | exceeds |
| max fields (20 items, 1 attempt, 32 KiB details, 64 KiB prompts) | 3256.5 KiB | exceeds | exceeds | exceeds |

## Write amplification

Every commit re-sends `plugin_settings_changed`; each connected client re-reads the full document over IPC/WebSocket.

| Scenario | Writes/hour (busy) | Clients | Bytes/hour |
| --- | --- | --- | --- |
| personal (50 items, 1 attempt) | 120 | 1 | 24952.0 KiB |
| personal (50 items, 1 attempt) | 120 | 3 | 74856.1 KiB |
| personal (50 items, 1 attempt) | 120 | 5 | 124760.2 KiB |
| team (200 items, 2 attempts) | 120 | 1 | 166026.3 KiB |
| team (200 items, 2 attempts) | 120 | 3 | 498079.0 KiB |
| team (200 items, 2 attempts) | 120 | 5 | 830131.6 KiB |
| heavy (500 items, 3 attempts) | 120 | 1 | 656491.3 KiB |
| heavy (500 items, 3 attempts) | 120 | 3 | 1969473.9 KiB |
| heavy (500 items, 3 attempts) | 120 | 5 | 3282456.4 KiB |
| history-heavy (300 items, 6 attempts) | 120 | 1 | 627253.0 KiB |
| history-heavy (300 items, 6 attempts) | 120 | 3 | 1881759.0 KiB |
| history-heavy (300 items, 6 attempts) | 120 | 5 | 3136265.0 KiB |
| max fields (20 items, 1 attempt, 32 KiB details, 64 KiB prompts) | 120 | 1 | 390782.3 KiB |
| max fields (20 items, 1 attempt, 32 KiB details, 64 KiB prompts) | 120 | 3 | 1172347.0 KiB |
| max fields (20 items, 1 attempt, 32 KiB details, 64 KiB prompts) | 120 | 5 | 1953911.7 KiB |

## Frozen decisions

- user-growth soft limit: 512.0 KiB — ordinary create/edit/acquire growth stops here.
- best-effort recovery reserve: 64.0 KiB above the soft limit for AgentLink/abandon/retired-ID writes; it is a budget, not a guarantee for unbounded pending attempts.
- absolute serialization limit: 1024.0 KiB — only strictly shrinking mutations run above it.
- field limits: title 200 code points; details 32 KiB; defaultPrompt and each seedPromptSnapshot 64 KiB.
- retired ring: 256 entries / 30 days. Launch journal: 128 entries, terminal retention 30 days.

At typical sizes one work item with one full attempt and one agent link costs about 4.2 KiB, so the 512.0 KiB soft limit admits roughly 123 such items before ordinary growth stops. The personal scenario fits; the team, heavy, history-heavy, and max-field scenarios exceed the soft limit and must archive and purge, which is the intended v1 answer rather than a database migration. Replication cost is the reason the limits stay this low: a 1024.0 KiB document replicated to 3 busy clients costs 368640.0 KiB per hour on the whole-document Settings path. The per-field maxima are caps for single records, not a sustainable steady state at hundreds of items.
