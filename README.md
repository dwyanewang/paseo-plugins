# Paseo local plugins

Plugins for [Paseo](https://paseo.sh/). They run only inside Paseo, as trusted local plugins that
the Paseo daemon loads straight from this directory
(`~/.paseo/config.json` → `plugins.<id> = { source: "directory", path: … }`). Nothing is copied
into `~/.paseo`, so editing here plus a plugin reload is the whole deploy step.

| Plugin  | Directory   | Purpose                                                                             |
| ------- | ----------- | ----------------------------------------------------------------------------------- |
| `forge` | `forge/`    | Codeup and Gitee change requests over their HTTP APIs. See `forge/README.md`.       |
| `todo`  | `todolist/` | Host-local work items that launch and track Paseo agents. See `todolist/README.md`. |
| `wechat-notify` | `wechat-notify/` | Daemon-side lifecycle notifications delivered directly to personal WeChat via Tencent iLink. See `wechat-notify/README.md`. |

## Host requirement

These plugins do not work on a released Paseo build. They need host changes that are not in any
release yet: [getpaseo/paseo#4985](https://github.com/getpaseo/paseo/pull/4985), a draft pull
request from the
[`feat/plugin-host-infrastructure`](https://github.com/dwyanewang/paseo/tree/feat/plugin-host-infrastructure)
branch of `dwyanewang/paseo`. That branch still reports version `0.8.0`, so the manifests' version
range cannot tell it apart from a stock `0.8.0`; each plugin checks for the capabilities it needs at
startup instead.

Both the daemon and the app must run a build of that branch:

- `forge` needs Forge providers from plugins, `server.secrets`, the settings server handle, and the
  plugin settings screen.
- `todo` needs `server.paseo`, the settings server handle, and `navigation.openAgentLaunch`.

To set it up, clone both repositories side by side and build the host SDK:

```bash
git clone -b feat/plugin-host-infrastructure https://github.com/dwyanewang/paseo.git paseo
git clone https://github.com/dwyanewang/paseo-plugins.git paseo-plugins
cd paseo && npm install && npm run build:client && npm run build:plugin
```

Then run the daemon and app from that checkout (see its `docs/development.md`), set
`pluginsEnabled: true` in the daemon's `config.json`, and install each plugin as its README
describes. Once #4985 or its follow-ups ship in a Paseo release, a released build will do.

## Relationship to the Paseo checkout

The plugins depend on the sibling checkout at `../paseo` through `file:` dependencies
(`@getpaseo/plugin`, `@getpaseo/client`, `@getpaseo/protocol`), which resolve to symlinks into
`../paseo/packages/*`. The coupling is one-way: the plugins read the host SDK, and no plugin code
lives in the Paseo repository.

The Forge plugin can link its SDK dependencies to a separate host worktree with
`npm run link:sdk -- /path/to/host-checkout` from `forge/`. This only changes that plugin's
development links.

That makes an upstream sync of the Paseo checkout the one event that can break a plugin without
touching this repository. After any sync, re-verify each plugin from its own directory:

```bash
(cd forge && npm run typecheck && npm test)
(cd todolist && npm run typecheck && npm test)
```

Host-side changes (new plugin SDK surface, new host navigation) belong on the Paseo branch and must
be built there first; plugin-only changes belong here.
