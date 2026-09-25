import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findFiles, pruneFiles, safeFileName, writeFilePiece } from "../server/card-files";
import { uploadFile, type PickedFile } from "../client/files";
import { FILE_CHUNK_BYTES } from "../shared/limits";

const b64 = (text: string) => Buffer.from(text).toString("base64");

describe("storing attached files on the daemon host", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "todo-files-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("assembles pieces in order and names the finished file after the original", async () => {
    const first = await writeFilePiece({ id: "file_a", name: "spec.md", size: 11, offset: 0, data: b64("hello ") }, root);
    expect(first).toEqual({ status: "ok", received: 6 });
    // Only the finished file is found; a half-written one is not.
    expect(await findFiles(["file_a"], root)).toEqual({ files: [], missing: ["file_a"] });
    const last = await writeFilePiece({ id: "file_a", name: "spec.md", size: 11, offset: 6, data: b64("world") }, root);
    const target = path.join(root, "file_a", "spec.md");
    expect(last).toEqual({ status: "ok", received: 11, file: { id: "file_a", size: 11, path: target } });
    expect(await readFile(target, "utf8")).toBe("hello world");
    expect(await findFiles(["file_a", "file_gone", "../escape"], root)).toEqual({
      files: [{ id: "file_a", size: 11, path: target }],
      missing: ["file_gone", "../escape"],
    });
  });

  it("answers a repeated last piece with the finished file, and a piece out of place with where the file ends", async () => {
    await writeFilePiece({ id: "file_b", name: "a.txt", size: 4, offset: 0, data: b64("ab") }, root);
    expect(await writeFilePiece({ id: "file_b", name: "a.txt", size: 4, offset: 0, data: b64("ab") }, root)).toEqual({ status: "ok", received: 2 });
    expect(await writeFilePiece({ id: "file_b", name: "a.txt", size: 4, offset: 3, data: b64("d") }, root)).toMatchObject({ status: "conflict", details: { received: 2 } });
    const done = await writeFilePiece({ id: "file_b", name: "a.txt", size: 4, offset: 2, data: b64("cd") }, root);
    expect(done).toMatchObject({ status: "ok", received: 4, file: { size: 4 } });
    expect(await writeFilePiece({ id: "file_b", name: "a.txt", size: 4, offset: 2, data: b64("cd") }, root)).toEqual(done);
  });

  it("takes an empty file, and refuses foreign ids and pieces past the end", async () => {
    expect(await writeFilePiece({ id: "file_c", name: "empty.txt", size: 0, offset: 0, data: "" }, root)).toMatchObject({ status: "ok", file: { size: 0 } });
    expect(await writeFilePiece({ id: "../x", name: "a", size: 1, offset: 0, data: b64("a") }, root)).toMatchObject({ status: "invalid_input" });
    expect(await writeFilePiece({ id: "file_d", name: "a", size: 1, offset: 0, data: b64("ab") }, root)).toMatchObject({ status: "invalid_input" });
  });

  it("keeps a file name to one safe path segment with its extension", () => {
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileName(".env")).toBe("env");
    expect(safeFileName("  ")).toBe("file");
    const long = safeFileName(`${"文".repeat(120)}.docx`);
    expect(long.endsWith(".docx")).toBe(true);
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(200);
  });

  it("prunes files no card references once they are past the grace period", async () => {
    for (const id of ["file_kept", "file_fresh", "file_old"]) await writeFilePiece({ id, name: "a.txt", size: 1, offset: 0, data: b64("a") }, root);
    await writeFile(path.join(root, "notes.txt"), "not ours");
    const now = Date.now();
    const old = new Date(now - 10 * 24 * 60 * 60 * 1000);
    await utimes(path.join(root, "file_old"), old, old);
    await utimes(path.join(root, "file_kept"), old, old);
    expect(await pruneFiles(new Set(["file_kept"]), now, root)).toBe(1);
    expect((await readdir(root)).sort()).toEqual(["file_fresh", "file_kept", "notes.txt"]);
  });
});

describe("uploading a picked file", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "todo-upload-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function picked(bytes: Buffer): PickedFile {
    return { name: "data.bin", mimeType: "", size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length).toString("base64") };
  }

  it("sends a large file in pieces and reports progress", async () => {
    const bytes = Buffer.alloc(FILE_CHUNK_BYTES * 2 + 10, 7);
    const progress: number[] = [];
    await uploadFile(picked(bytes), "file_big", (input) => writeFilePiece(input, root), (uploaded) => progress.push(uploaded));
    expect(progress).toEqual([FILE_CHUNK_BYTES, FILE_CHUNK_BYTES * 2, bytes.length]);
    expect(await readFile(path.join(root, "file_big", "data.bin"))).toEqual(bytes);
  });

  it("carries on after a lost reply, whether or not the piece had landed", async () => {
    const bytes = Buffer.alloc(FILE_CHUNK_BYTES * 3, 1);
    let calls = 0;
    await uploadFile(picked(bytes), "file_lossy", async (input) => {
      calls += 1;
      // The third call is lost before it lands.
      if (calls === 4) throw new Error("socket closed");
      const result = await writeFilePiece(input, root);
      // The second piece lands, but its reply is lost.
      if (calls === 2) throw new Error("socket closed");
      return result;
    }, () => undefined);
    // The first piece, the lost reply, the resend that learns where the file ends, the lost call, its resend.
    expect(calls).toBe(5);
    expect(await readFile(path.join(root, "file_lossy", "data.bin"))).toEqual(bytes);
  });

  it("stops once the file is no longer wanted, and gives up on a refusal", async () => {
    const bytes = Buffer.alloc(FILE_CHUNK_BYTES * 2, 1);
    let wanted = true;
    await expect(
      uploadFile(picked(bytes), "file_dropped", (input) => writeFilePiece(input, root), () => {
        wanted = false;
      }, () => !wanted),
    ).rejects.toThrow("stopped");
    await expect(uploadFile(picked(bytes), "not-an-id", (input) => writeFilePiece(input, root), () => undefined)).rejects.toThrow("Unknown file id.");
  });
});
