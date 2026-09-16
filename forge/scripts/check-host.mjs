import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const checkout =
  process.env.PASEO_CHECKOUT ??
  resolve(await realpath(join(root, "node_modules/@getpaseo/plugin")), "../..");
const hostRequire = createRequire(join(checkout, "package.json"));
const { PluginRuntime } = await import(
  pathToFileURL(
    join(checkout, "packages/server/dist/server/server/plugins/runtime.js")
  )
);
const pino = hostRequire("pino");
const temporary = await mkdtemp(join(tmpdir(), "paseo-forge-host-"));
const runtime = new PluginRuntime(pino({ level: "silent" }), "0.8.0", {
  settingsDirectory: temporary,
  sessionHost: {
    async attachPluginSocket(_id, socket) {
      const closed = new Promise((done) => socket.once("close", done));
      socket.on("message", (data) => {
        if (typeof data !== "string" || JSON.parse(data).type !== "hello")
          return;
        socket.send(
          JSON.stringify({
            type: "session",
            message: {
              type: "status",
              payload: {
                status: "server_info",
                serverId: "forge-isolated-test",
                hostname: "test",
                version: "0.8.0",
                features: {},
              },
            },
          })
        );
      });
      return { closed };
    },
  },
});
try {
  await runtime.startPlugin("forge", root);
  assert.equal(runtime.catalog().length, 1);
  assert.deepEqual(
    runtime.forgeProviders("forge").map((p) => p.definition.id),
    ["forge-codeup", "forge-gitee"]
  );
  assert.deepEqual(await runtime.invoke("forge", "credentials.status", {}), {
    codeup: false,
    gitee: false,
  });
  const settings = await runtime.invoke(
    "forge",
    "settings.connections.read",
    {}
  );
  assert.equal(settings.status, "ready");
  assert.equal(
    settings.values.codeup.apiBaseUrl,
    "https://openapi-rdc.aliyuncs.com"
  );
  for (const providerId of ["forge-codeup", "forge-gitee"]) {
    assert.equal(
      await runtime.invokeForge(
        "forge",
        providerId,
        "probeHost",
        "unconfigured.invalid"
      ),
      false
    );
    await assert.rejects(
      runtime.invokeForge("forge", providerId, "isAuthenticated", {
        cwd: temporary,
      }),
      /access token/
    );
  }
  await runtime.invoke("forge", "credentials.save", {
    platform: "codeup",
    apiBaseUrl: settings.values.codeup.apiBaseUrl,
    token: "isolated-test-token",
  });
  assert.deepEqual(await runtime.invoke("forge", "credentials.status", {}), {
    codeup: true,
    gitee: false,
  });
  assert.equal(
    await runtime.invokeForge(
      "forge",
      "forge-codeup",
      "probeHost",
      "codeup.aliyun.com"
    ),
    true
  );
  const updated = await runtime.invoke("forge", "settings.connections.write", {
    revision: settings.revision,
    values: {
      ...settings.values,
      gitee: { ...settings.values.gitee, hosts: ["git.example.com"] },
    },
  });
  assert.equal(updated.status, "saved");
  const conflict = await runtime.invoke("forge", "settings.connections.write", {
    revision: settings.revision,
    values: settings.values,
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(await runtime.stopPluginById("forge"), true);
  assert.equal(runtime.catalog().length, 0);
  await runtime.startPlugin("forge", root);
  assert.deepEqual(await runtime.invoke("forge", "credentials.status", {}), {
    codeup: true,
    gitee: false,
  });
  assert.deepEqual(
    (await runtime.invoke("forge", "settings.connections.read", {})).values
      .gitee.hosts,
    ["git.example.com"]
  );
  await runtime.invoke("forge", "credentials.delete", {
    platform: "codeup",
    apiBaseUrl: settings.values.codeup.apiBaseUrl,
  });
  assert.equal(
    await runtime.invokeForge(
      "forge",
      "forge-codeup",
      "probeHost",
      "codeup.aliyun.com"
    ),
    false
  );
  console.log(
    "Host compiler, subprocess registration, settings CAS, secret persistence, auth errors, stop and reload passed."
  );
} finally {
  await runtime.stopPluginById("forge");
  await rm(temporary, { recursive: true, force: true });
}
