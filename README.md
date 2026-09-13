# Paseo local plugins

Trusted local plugins loaded by the Paseo daemon straight from this directory
(`~/.paseo/config.json` → `plugins.<id> = { source: "directory", path: … }`). Nothing is copied
into `~/.paseo`, so editing here plus a plugin reload is the whole deploy step.

| Plugin | Directory | Purpose |
| --- | --- | --- |
| `codeup` | `codeup/` | See `codeup/README.md`. |
| `todo` | `todolist/` | Host-local work items that launch and track Paseo agents. See `todolist/README.md`. |

## Relationship to the Paseo checkout

Both plugins depend on the sibling checkout at `../paseo` through `file:` dependencies
(`@getpaseo/plugin`, `@getpaseo/client`, `@getpaseo/protocol`), which resolve to symlinks into
`../paseo/packages/*`. The coupling is one-way: the plugins read the host SDK, and no plugin code
lives in the Paseo repository.

That makes an upstream sync of the Paseo checkout the one event that can break a plugin without
touching this repository. After any sync, re-verify each plugin from its own directory:

```bash
cd todolist && npm run typecheck && npm test
```

Host-side changes (new plugin SDK surface, new host navigation) belong on the Paseo branch and must
be built there first; plugin-only changes belong here.
