import { execFileSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { settingsRpc } from "@getpaseo/plugin";
import { DaemonClient } from "@server/server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "@server/server/test-utils/paseo-daemon.js";
import { createTestAgentClient, createTestAgentClients } from "@server/server/test-utils/fake-agent-client.js";
import { runWorkItemNow, type RunInput } from "../../client/run";
import { abandonLaunch, acquireLaunch, createWorkItem, ensureDocument, reportLaunchProgress } from "../../shared/contracts";
import { computeCreationFingerprint } from "../../shared/fingerprint";
import { TODO_SETTINGS_ID, TodoDocumentSchema } from "../../shared/schema";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("a direct run can cut a new worktree and start its agent there", async () => {
  const staged = await mkdtemp(path.join(tmpdir(), "todo-plugin-worktree-"));
  roots.push(staged);
  await cp(pluginRoot, staged, { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") });
  const repo = await mkdtemp(path.join(tmpdir(), "todo-worktree-repo-"));
  roots.push(repo);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=todo@example.com", "-c", "user.name=Todo", ...args], { cwd: repo });
  git("init", "-q", "-b", "main");
  git("commit", "-q", "--allow-empty", "-m", "init");

  const daemon = await createTestPaseoDaemon({ agentClients: { ...createTestAgentClients(), pi: createTestAgentClient("pi") } });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const rpc = async <Output>(name: string, input: unknown): Promise<Output> =>
    (await client.invokePluginRpc("todo", name, input)) as Output;
  const settings = settingsRpc(TODO_SETTINGS_ID);
  const readDocument = async () => {
    const result = settings.read.output.parse(await rpc(settings.read.name, {}));
    if (result.status !== "ready") throw new Error(`document ${result.status}`);
    return TodoDocumentSchema.parse(result.values);
  };
  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(staged);
    await expect.poll(async () => (await readDocument()).incarnationId, { timeout: 15_000 }).toMatch(/^inc_/);
    const { incarnationId } = await rpc<{ incarnationId: string }>(ensureDocument.name, {});
    const workspace = await client.createWorkspace({ source: { kind: "directory", path: repo } });
    const projectId = workspace.workspace!.projectId;

    const content = { id: "wi_worktree_00000000000001", projectId, title: "Cut a worktree", details: "", defaultPrompt: "Make a change" };
    await rpc(createWorkItem.name, { expectedIncarnationId: incarnationId, ...content, projectNameSnapshot: "Repo", creationFingerprint: computeCreationFingerprint(content) });
    const item = (await readDocument()).workItems[content.id]!;

    const paseo = createPaseoApi(client as never) as unknown as RunInput["paseo"];
    const result = await runWorkItemNow({
      paseo,
      item,
      incarnationId,
      seedPrompt: "Make a change",
      seedPromptSource: "work-item-default",
      initiatorLabel: "E2E",
      target: { kind: "new_worktree", branchName: "todo-1-cut-a-worktree-e2e1", projectRootPath: repo },
      config: { providerModel: "pi/test" },
      rpcs: {
        acquire: (input) => rpc(acquireLaunch.name, input),
        progress: (input) => rpc(reportLaunchProgress.name, input),
        abandon: (input) => rpc(abandonLaunch.name, input),
      },
      onChange: () => undefined,
    });
    expect(result).toMatchObject({ status: "started" });
    if (result.status !== "started") return;

    const branches = execFileSync("git", ["branch", "--list", "todo-1-cut-a-worktree-e2e1"], { cwd: repo }).toString();
    expect(branches).toContain("todo-1-cut-a-worktree-e2e1");
    expect(result.workspaceId).not.toBe(workspace.workspace!.id);
    // The reconciler links the agent to the attempt and the card follows the launch.
    await expect
      .poll(async () => {
        const document = await readDocument();
        const link = document.agentLinks[result.agentId];
        return link ? { attempt: link.attemptId, workspace: document.attempts[link.attemptId]?.workspaceIdHint } : null;
      }, { timeout: 20_000, interval: 250 })
      .toEqual({ attempt: result.attempt.id, workspace: result.workspaceId });
    expect(["in_progress", "in_review"]).toContain((await readDocument()).workItems[content.id]!.status);
  } catch (error) {
    console.error(await client.getPluginLogs("todo").catch(() => []));
    throw error;
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 180_000);
