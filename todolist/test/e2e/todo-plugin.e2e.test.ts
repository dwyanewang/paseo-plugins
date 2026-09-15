import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { settingsRpc } from "@getpaseo/plugin";
import { DaemonClient } from "@server/server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "@server/server/test-utils/paseo-daemon.js";
import { createTestAgentClient, createTestAgentClients } from "@server/server/test-utils/fake-agent-client.js";
import { acquireLaunch, checkLaunch, createWorkItem, ensureDocument, reportLaunchProgress } from "../../shared/contracts";
import { computeCreationFingerprint, computeRequestFingerprint } from "../../shared/fingerprint";
import { buildTodoLabels } from "../../shared/labels";
import { TODO_SETTINGS_ID, TodoDocumentSchema } from "../../shared/schema";
import { TODO_PREFS_SETTINGS_ID, TodoPrefsSchema } from "../../shared/prefs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function stagePlugin(): Promise<string> {
  const staged = await mkdtemp(path.join(tmpdir(), "todo-plugin-e2e-"));
  roots.push(staged);
  // Copy the whole plugin directory, minus installed dependencies, so this exercises the real
  // deployment artifact: extra directories such as test/ and scripts/ must not break compilation.
  await cp(pluginRoot, staged, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("node_modules"),
  });
  return staged;
}

test("todo plugin installs, reconciles native launches without the app, and survives reload", async () => {
  const staged = await stagePlugin();
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "todo-plugin-workspace-"));
  roots.push(workspaceDirectory);
  const daemon = await createTestPaseoDaemon({
    agentClients: { ...createTestAgentClients(), pi: createTestAgentClient("pi") },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const settings = settingsRpc(TODO_SETTINGS_ID);
  const prefs = settingsRpc(TODO_PREFS_SETTINGS_ID);
  const rpc = async <Output>(name: string, input: unknown): Promise<Output> =>
    (await client.invokePluginRpc("todo", name, input)) as Output;
  const readDocument = async () => {
    const result = settings.read.output.parse(await rpc(settings.read.name, {}));
    if (result.status !== "ready") throw new Error(`document ${result.status}`);
    return TodoDocumentSchema.parse(result.values);
  };
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await expect(client.installDirectoryPlugin(staged)).resolves.toMatchObject({ id: "todo", status: "running" });

    // Bootstrap initializes the incarnation without any client write.
    await expect.poll(async () => (await readDocument()).incarnationId, { timeout: 15_000 }).toMatch(/^inc_/);
    const ensured = await rpc<{ status: string; incarnationId: string }>(ensureDocument.name, {});
    expect(ensured.status).toBe("ok");
    const incarnationId = ensured.incarnationId;

    const workspace = await client.createWorkspace({ source: { kind: "directory", path: workspaceDirectory } });
    if (!workspace.workspace) throw new Error("workspace was not created");
    const projectId = workspace.workspace.projectId;

    // Existing preferences gain defaults for the new fields, and launch choices persist on reload.
    const initialPrefs = prefs.read.output.parse(await rpc(prefs.read.name, {}));
    if (initialPrefs.status !== "ready") throw new Error("Preferences unavailable");
    const savedPrefs = TodoPrefsSchema.parse({
      providerModel: "pi/test",
      thinkingOptionId: "high",
      workspaceByProject: { [projectId]: workspace.workspace.id, "another-project": "another-workspace" },
    });
    await expect(rpc(prefs.write.name, { revision: initialPrefs.revision, values: savedPrefs })).resolves.toMatchObject({ status: "saved", values: savedPrefs });

    const itemId = "wi_e2e_00000000000000001";
    const content = { id: itemId, projectId, title: "Ship the thing", details: "notes", defaultPrompt: "Ship it" };
    const created = await rpc<{ status: string; workItem: { version: number } }>(createWorkItem.name, {
      expectedIncarnationId: incarnationId,
      ...content,
      projectNameSnapshot: workspace.workspace.projectDisplayName,
      creationFingerprint: computeCreationFingerprint(content),
    });
    expect(created.status).toBe("ok");
    // Same ID + fingerprint retry is idempotent; a stale incarnation is fenced.
    await expect(rpc(createWorkItem.name, { expectedIncarnationId: incarnationId, ...content, projectNameSnapshot: "x", creationFingerprint: computeCreationFingerprint(content) })).resolves.toMatchObject({ status: "ok", created: false });
    await expect(rpc(createWorkItem.name, { expectedIncarnationId: "inc_stale", ...content, projectNameSnapshot: "x", creationFingerprint: computeCreationFingerprint(content) })).resolves.toMatchObject({ status: "stale_document" });

    const attemptId = "att_e2e_0000000000000001";
    const clientMessageId = "msg_e2e_0000000000000001";
    const labels = buildTodoLabels(itemId, attemptId);
    const requestFingerprint = computeRequestFingerprint({ projectId, workItemId: itemId, attemptId, clientMessageId, labels, seedPrompt: "Ship it" });
    const acquire = { expectedIncarnationId: incarnationId, workItemId: itemId, attemptId, requestFingerprint, clientMessageId, seedPrompt: "Ship it", seedPromptSource: "work-item-default", initiatorLabel: "E2E" };
    const acquired = await rpc<{ status: string; claim: { generation: number; state: string } }>(acquireLaunch.name, acquire);
    expect(acquired).toMatchObject({ status: "ok", claim: { generation: 1, state: "pending" } });
    await expect(rpc(acquireLaunch.name, acquire)).resolves.toMatchObject({ status: "ok", created: false });
    await expect(rpc(acquireLaunch.name, { ...acquire, attemptId: "att_e2e_0000000000000002", requestFingerprint: "other" })).resolves.toMatchObject({ status: "claim_held" });

    // What the host does after persisting agent_request_started: report the fact, then create.
    await rpc(reportLaunchProgress.name, { expectedIncarnationId: incarnationId, attemptId, generation: 1, facet: "agent-request", factVersion: 1, facts: { agentRequestStartedAt: new Date().toISOString(), workspaceIdHint: workspace.workspace.id } });
    const agent = await client.createAgent({
      config: { provider: "pi", model: "test", cwd: workspaceDirectory },
      workspaceId: workspace.workspace.id,
      initialPrompt: "Ship it",
      clientMessageId,
      labels,
    });
    expect(agent.labels).toEqual(labels);

    // No app is connected on the plugin's behalf: the daemon-side reconciler links the agent.
    await expect
      .poll(async () => {
        const doc = await readDocument();
        const link = doc.agentLinks[agent.id];
        return link ? { attemptId: link.attemptId, claim: doc.claims[itemId]?.state, delivery: link.promptDelivery, observed: Boolean(doc.attempts[attemptId]?.firstAgentObservedAt) } : null;
      }, { timeout: 20_000, interval: 250 })
      .toEqual({ attemptId, claim: "resolved", delivery: "observed", observed: true });
    await expect(rpc(checkLaunch.name, { expectedIncarnationId: incarnationId, workItemId: itemId, attemptId })).resolves.toMatchObject({ status: "ok", enqueuedAgentIds: [agent.id] });

    // Labels removed by the user: the known ID still updates through targeted refresh.
    await client.updateAgent(agent.id, { labels: { other: "value" } });
    await client.archiveAgent(agent.id);
    await expect
      .poll(async () => (await readDocument()).agentLinks[agent.id]?.displayState, { timeout: 20_000, interval: 250 })
      .toBe("closed");

    // A new attempt is allowed once the agent is closed; the old link stays.
    const second = await rpc<{ status: string }>(acquireLaunch.name, { ...acquire, attemptId: "att_e2e_0000000000000003", requestFingerprint: computeRequestFingerprint({ projectId, workItemId: itemId, attemptId: "att_e2e_0000000000000003", clientMessageId: "msg-2", labels: buildTodoLabels(itemId, "att_e2e_0000000000000003"), seedPrompt: "Ship it" }), clientMessageId: "msg-2" });
    expect(second.status).toBe("ok");

    // Reload keeps the document and the plugin running; the incarnation does not change.
    await expect(client.reloadPlugin("todo")).resolves.toMatchObject({ id: "todo", status: "running" });
    await expect.poll(async () => (await readDocument()).incarnationId, { timeout: 15_000 }).toBe(incarnationId);
    const reloaded = await readDocument();
    await expect(rpc(prefs.read.name, {})).resolves.toMatchObject({ status: "ready", values: savedPrefs });
    expect(reloaded.agentLinks[agent.id]).toMatchObject({ attemptId, displayState: "closed" });
    expect(reloaded.claims[itemId]).toMatchObject({ attemptId: "att_e2e_0000000000000003", state: "pending" });
    const status = await rpc<{ status: string; degraded: unknown }>("todo.document.status", {});
    expect(status).toMatchObject({ status: "ok", degraded: null });
  } catch (error) {
    console.error(await client.getPluginLogs("todo").catch(() => []));
    throw error;
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 180_000);
