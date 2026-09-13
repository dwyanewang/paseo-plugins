import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";
import { assertHostCapabilities } from "../index.server";
import { resolveLaunchCapability } from "../client/launch-guard";

const manifest = JSON.parse(
  readFileSync(path.resolve(__dirname, "../paseo-plugin.json"), "utf8"),
) as { id: string; requirements: { paseo: string } };

describe("manifest gates", () => {
  it("admits private 0.8.x host builds and keeps the 0.9 upper bound", () => {
    expect(manifest.id).toBe("todo");
    expect(manifest.requirements.paseo).toBe(">=0.8.0 <0.9.0");
  });

  it("app gate accepts 0.8.x builds and rejects versions outside the supported series", () => {
    const check = (version: string, runtime: "app" | "daemon") =>
      assertPluginCompatibility({ id: manifest.id, requirements: manifest.requirements, version, runtime });
    expect(() => check("0.7.9", "app")).toThrow("Your app is 0.7.9");
    expect(() => check("0.8.0", "app")).not.toThrow();
    expect(() => check("0.8.2-beta.1", "app")).not.toThrow();
    expect(() => check("0.9.0", "app")).toThrow("Your app is 0.9.0");
  });

  it("daemon gate accepts 0.8.x builds and leaves branch capabilities to runtime guards", () => {
    expect(() =>
      assertPluginCompatibility({ id: manifest.id, requirements: manifest.requirements, version: "0.7.9", runtime: "daemon" }),
    ).toThrow("Your daemon is 0.7.9");
    expect(() =>
      assertPluginCompatibility({ id: manifest.id, requirements: manifest.requirements, version: "0.8.0", runtime: "daemon" }),
    ).not.toThrow();
  });
});

describe("runtime capability guards", () => {
  it("server refuses a same-version daemon that lacks server.paseo or the document handle", () => {
    expect(() => assertHostCapabilities({})).toThrow("server.paseo");
    expect(() => assertHostCapabilities({ paseo: {} as never })).toThrow("server.paseo");
    expect(() => assertHostCapabilities({ paseo: {} as never, registerSettings: () => undefined as never })).not.toThrow();
  });

  it("client blocks execution before acquire when openAgentLaunch is missing", () => {
    expect(resolveLaunchCapability(undefined)).toEqual({ available: false, reason: "navigation_missing" });
    expect(resolveLaunchCapability({ openAgent: () => undefined, openWorkspace: () => undefined })).toEqual({
      available: false,
      reason: "launch_missing",
    });
    const openAgentLaunch = async () => ({ status: "rejected" as const, code: "wrong_device" as const, message: "" });
    expect(resolveLaunchCapability({ openAgent: () => undefined, openWorkspace: () => undefined, openAgentLaunch })).toEqual({
      available: true,
      openAgentLaunch,
    });
  });
});
