import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";
import { settingsRpc } from "@getpaseo/plugin";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@server/server/test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "@server/server/test-utils/paseo-daemon.js";
import { createTestAgentClient, createTestAgentClients } from "@server/server/test-utils/fake-agent-client.js";
import { abandonLaunch, acquireLaunch, createWorkItem, ensureDocument, reportLaunchProgress, resolveFiles, writeFile, type StoredFile } from "../../shared/contracts";
import { computeCreationFingerprint } from "../../shared/fingerprint";
import { FILE_CHUNK_BYTES } from "../../shared/limits";
import { TODO_SETTINGS_ID, TodoDocumentSchema } from "../../shared/schema";
import { uploadFile } from "../../client/files";
import { runWorkItemNow, type RunInput } from "../../client/run";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const roots: string[] = [];
const previousHome = process.env.PASEO_HOME;

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  roots.push(directory);
  return directory;
}

test("a file attached to a card uploads in pieces and reaches the agent as an uploaded file", async () => {
  const staged = await temporary("todo-plugin-files-");
  await cp(pluginRoot, staged, { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") });
  const workspaceDirectory = await temporary("todo-files-workspace-");
  // The plugin process inherits the daemon's environment; keep its writes inside this test.
  const home = await temporary("todo-files-home-");
  process.env.PASEO_HOME = home;

  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: { ...createTestAgentClients(), pi: createTestAgentClient("pi", { onStartTurn: (prompt) => prompts.push(prompt) }) },
  });
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
    const workspace = await client.createWorkspace({ source: { kind: "directory", path: workspaceDirectory } });
    const projectId = workspace.workspace!.projectId;

    // Bigger than one piece, so the upload takes several calls through the daemon.
    const bytes = Buffer.alloc(FILE_CHUNK_BYTES * 2 + 123, 0x61);
    const progress: number[] = [];
    await uploadFile(
      { name: "需求说明.md", mimeType: "text/markdown", size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length).toString("base64") },
      "file_e2e1",
      (input) => rpc(writeFile.name, input),
      (uploaded) => progress.push(uploaded),
    );
    expect(progress).toEqual([FILE_CHUNK_BYTES, FILE_CHUNK_BYTES * 2, bytes.length]);

    const located = await rpc<{ status: string; files: StoredFile[]; missing: string[] }>(resolveFiles.name, { ids: ["file_e2e1", "file_unknown"] });
    const target = path.join(home, "plugin-data", "todo", "files", "file_e2e1", "需求说明.md");
    expect(located).toEqual({ status: "ok", files: [{ id: "file_e2e1", size: bytes.length, path: target }], missing: ["file_unknown"] });
    expect(await readFile(target)).toEqual(bytes);

    const content = { id: "wi_files_00000000000000001", projectId, title: "Follow the spec", details: "", defaultPrompt: "" };
    const ref = { id: "file_e2e1", name: "需求说明.md", mimeType: "text/markdown", byteLength: bytes.length };
    await rpc(createWorkItem.name, {
      expectedIncarnationId: incarnationId,
      ...content,
      projectNameSnapshot: "Workspace",
      creationFingerprint: computeCreationFingerprint(content),
      files: [ref],
    });
    const item = (await readDocument()).workItems[content.id]!;
    expect(item.files).toEqual([ref]);

    const file = { id: ref.id, fileName: ref.name, mimeType: ref.mimeType, size: bytes.length, path: target };
    const paseo = createPaseoApi(client as never) as unknown as RunInput["paseo"];
    const result = await runWorkItemNow({
      paseo,
      item,
      incarnationId,
      seedPrompt: "Follow the spec",
      seedPromptSource: "work-item-default",
      initiatorLabel: "E2E",
      target: { kind: "existing", workspaceId: workspace.workspace!.id },
      config: { providerModel: "pi/test" },
      files: [file],
      rpcs: {
        acquire: (input) => rpc(acquireLaunch.name, input),
        progress: (input) => rpc(reportLaunchProgress.name, input),
        abandon: (input) => rpc(abandonLaunch.name, input),
      },
      onChange: () => undefined,
    });
    expect(result).toMatchObject({ status: "started" });
    await expect.poll(() => prompts.length, { timeout: 15_000 }).toBe(1);
    expect(prompts[0]).toEqual([
      { type: "text", text: "Follow the spec" },
      { type: "uploaded_file", ...file },
    ]);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
});
