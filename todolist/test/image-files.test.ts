import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TodoImagesSchema } from "../shared/images";
import { stageImageFiles } from "../server/image-files";
import { FakeSettingsDocument } from "./helpers/fake-document";

const PNG = Buffer.from("png-bytes").toString("base64");

function stored(id: string, mimeType = "image/png", name?: string) {
  return { id, data: PNG, mimeType, ...(name ? { name } : {}), byteLength: 9, addedAt: "2026-09-23T00:00:00.000Z" };
}

describe("staging card images as files", () => {
  let directory: string;
  let images: FakeSettingsDocument<typeof TodoImagesSchema>;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "todo-images-"));
    images = new FakeSettingsDocument(TodoImagesSchema);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes each image once, named by id, and reports it like an uploaded file", async () => {
    images.raw = JSON.stringify({ images: { img_a: stored("img_a", "image/png", "shot.png"), img_b: stored("img_b", "image/jpeg") } });
    const first = await stageImageFiles(images, ["img_a", "img_b"], directory);
    expect(first.missing).toEqual([]);
    expect(first.files).toEqual([
      { id: "img_a", fileName: "shot.png", mimeType: "image/png", size: 9, path: path.join(directory, "img_a.png") },
      { id: "img_b", fileName: "img_b.jpg", mimeType: "image/jpeg", size: 9, path: path.join(directory, "img_b.jpg") },
    ]);
    expect(await readFile(path.join(directory, "img_a.png"), "utf8")).toBe("png-bytes");
    const before = (await stat(path.join(directory, "img_a.png"))).mtimeMs;
    // A retried launch gets the same paths, and the file is not rewritten under an agent reading it.
    const again = await stageImageFiles(images, ["img_a"], directory);
    expect(again.files[0]?.path).toBe(path.join(directory, "img_a.png"));
    expect((await stat(path.join(directory, "img_a.png"))).mtimeMs).toBe(before);
  });

  it("reports ids without bytes, and never turns a foreign id into a file name", async () => {
    images.raw = JSON.stringify({ images: { img_a: stored("img_a") } });
    const result = await stageImageFiles(images, ["img_gone", "../escape"], directory);
    expect(result).toEqual({ files: [], missing: ["img_gone", "../escape"] });
  });

  it("removes files whose image left the store, and leaves other files alone", async () => {
    images.raw = JSON.stringify({ images: { img_a: stored("img_a") } });
    await writeFile(path.join(directory, "img_old.png"), "stale");
    await writeFile(path.join(directory, "notes.txt"), "not ours");
    await stageImageFiles(images, ["img_a"], directory);
    expect((await readdir(directory)).sort()).toEqual(["img_a.png", "notes.txt"]);
  });
});
