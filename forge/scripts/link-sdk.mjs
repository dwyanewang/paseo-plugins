import { lstat, mkdir, readFile, symlink, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const checkout = resolve(
  process.argv[2] ?? process.env.PASEO_CHECKOUT ?? resolve(root, "../../paseo")
);
const manifest = JSON.parse(
  await readFile(resolve(checkout, "packages/plugin/package.json"), "utf8")
);
if (!manifest.exports["./server/forge-toolkit"]) {
  throw new Error(
    "Use a built checkout containing feat/plugin-host-infrastructure (Forge toolkit is missing)."
  );
}
// Validate every target before changing this plugin's development links.
for (const name of ["plugin", "client", "protocol"]) {
  await readFile(
    resolve(
      checkout,
      `packages/${name}/dist/${name === "protocol" ? "messages" : "index"}.d.ts`
    )
  );
  const target = resolve(root, `node_modules/@getpaseo/${name}`);
  const stat = await lstat(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (stat && !stat.isSymbolicLink())
    throw new Error(`Refusing to replace a non-symlink: ${target}`);
}
await mkdir(resolve(root, "node_modules/@getpaseo"), { recursive: true });
for (const name of ["plugin", "client", "protocol"]) {
  const target = resolve(root, `node_modules/@getpaseo/${name}`);
  await unlink(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  await symlink(resolve(checkout, `packages/${name}`), target, "junction");
}
console.log(`Linked this plugin's SDK dependencies to ${checkout}`);
