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
import { abandonLaunch, acquireLaunch, createWorkItem, ensureDocument, reportLaunchProgress, stageImages, type StagedImageFile } from "../../shared/contracts";
import { computeCreationFingerprint } from "../../shared/fingerprint";
import { TODO_IMAGES_SETTINGS_ID, TodoImagesSchema } from "../../shared/images";
import { TODO_SETTINGS_ID, TodoDocumentSchema } from "../../shared/schema";
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

test("card images are staged as files on the daemon host and reach the agent as uploaded files", async () => {
  const staged = await temporary("todo-plugin-images-");
  await cp(pluginRoot, staged, { recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules") });
  const workspaceDirectory = await temporary("todo-images-workspace-");
  // The plugin process inherits the daemon's environment; keep its writes inside this test.
  const home = await temporary("todo-images-home-");
  process.env.PASEO_HOME = home;

  const prompts: unknown[] = [];
  const daemon = await createTestPaseoDaemon({
    agentClients: { ...createTestAgentClients(), pi: createTestAgentClient("pi", { onStartTurn: (prompt) => prompts.push(prompt) }) },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws`, appVersion: "0.8.0" });
  const rpc = async <Output>(name: string, input: unknown): Promise<Output> =>
    (await client.invokePluginRpc("todo", name, input)) as Output;
  const settings = settingsRpc(TODO_SETTINGS_ID);
  const images = settingsRpc(TODO_IMAGES_SETTINGS_ID);
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

    // The client writes the bytes, as the editor does, before the card references them.
    const bytes = Buffer.from("not really a png");
    const initial = images.read.output.parse(await rpc(images.read.name, {}));
    if (initial.status !== "ready") throw new Error("image store unavailable");
    const values = TodoImagesSchema.parse({
      images: { img_e2e1: { id: "img_e2e1", data: bytes.toString("base64"), mimeType: "image/png", name: "api.png", byteLength: bytes.length, addedAt: new Date().toISOString() } },
    });
    await expect(rpc(images.write.name, { revision: initial.revision, values })).resolves.toMatchObject({ status: "saved" });

    const stagedResult = await rpc<{ status: string; files: StagedImageFile[]; missing: string[] }>(stageImages.name, { ids: ["img_e2e1", "img_unknown"] });
    expect(stagedResult).toMatchObject({ status: "ok", missing: ["img_unknown"] });
    const file = stagedResult.files[0]!;
    expect(file).toMatchObject({ id: "img_e2e1", fileName: "api.png", mimeType: "image/png", size: bytes.length });
    expect(file.path).toBe(path.join(home, "plugin-data", "todo", "images", "img_e2e1.png"));
    expect(await readFile(file.path)).toEqual(bytes);

    const content = { id: "wi_images_0000000000000001", projectId, title: "Build the page", details: "", defaultPrompt: "" };
    await rpc(createWorkItem.name, {
      expectedIncarnationId: incarnationId,
      ...content,
      projectNameSnapshot: "Workspace",
      creationFingerprint: computeCreationFingerprint(content),
      images: [{ id: "img_e2e1", mimeType: "image/png", name: "api.png", byteLength: bytes.length }],
    });
    const item = (await readDocument()).workItems[content.id]!;
    const paseo = createPaseoApi(client as never) as unknown as RunInput["paseo"];
    const result = await runWorkItemNow({
      paseo,
      item,
      incarnationId,
      seedPrompt: "Build the page",
      seedPromptSource: "work-item-default",
      initiatorLabel: "E2E",
      target: { kind: "existing", workspaceId: workspace.workspace!.id },
      config: { providerModel: "pi/test" },
      images: [{ data: bytes.toString("base64"), mimeType: "image/png" }],
      files: stagedResult.files,
      rpcs: {
        acquire: (input) => rpc(acquireLaunch.name, input),
        progress: (input) => rpc(reportLaunchProgress.name, input),
        abandon: (input) => rpc(abandonLaunch.name, input),
      },
      onChange: () => undefined,
    });
    expect(result).toMatchObject({ status: "started" });
    if (result.status !== "started") return;
    // The provider gets the text, the inline image, and the file it can open again later.
    await expect.poll(() => prompts.length, { timeout: 15_000 }).toBe(1);
    expect(prompts[0]).toEqual([
      { type: "text", text: "Build the page" },
      { type: "image", data: bytes.toString("base64"), mimeType: "image/png" },
      { type: "uploaded_file", ...file },
    ]);
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
});
