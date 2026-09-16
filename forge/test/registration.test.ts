import { describe, expect, it } from "vitest";
import type {
  PluginServerContext,
  PluginForgeServerProviderContribution,
} from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { clientProviders } from "../client/providers";
import { ForgeSettingsSchema } from "../shared/settings";
import { harness } from "./helpers";

describe("registrations and settings RPC", () => {
  function registered() {
    const h = harness("codeup", () => ({}));
    const providers: PluginForgeServerProviderContribution[] = [];
    const handlers = new Map<string, (input: any) => Promise<any>>();
    const server = {
      secrets: h.secrets,
      registerSettings: () => ({
        read: async () => ({
          status: "ready",
          values: h.settings,
          revision: "1",
        }),
      }),
      addForgeServerProvider: (
        provider: PluginForgeServerProviderContribution
      ) => providers.push(provider),
      handle: (
        contract: { name: string },
        handler: (input: any) => Promise<any>
      ) => handlers.set(contract.name, handler),
    } as unknown as PluginServerContext;
    contribute(server);
    return { ...h, handlers, providers };
  }
  it("keeps client/server definitions identical with distinct facts families and setup screens", () => {
    const h = registered();
    expect(h.providers.map((p) => p.definition)).toEqual(
      clientProviders.map((p) => p.definition)
    );
    expect(new Set(clientProviders.map((p) => p.facts!.family)).size).toBe(2);
    for (const provider of clientProviders) {
      expect(provider.definition.signIn).toBeNull();
      expect(provider.setup.screenId).toBe("connections");
      const facts = provider.facts!.schema.parse({
        forge: provider.definition.id,
        ready: false,
        allowedMethods: ["merge"],
      });
      expect(provider.facts!.deriveMergeCapability!(facts)).toMatchObject({
        directMergeReady: false,
        canEnableAutoMerge: false,
      });
    }
    expect(h.providers[0].definition.id).not.toBe("codeup");
    expect(h.providers[0].definition.cloudHosts).toBeUndefined();
  });
  it("keeps secret values out of settings and read RPCs", async () => {
    const h = registered();
    await h.handlers.get("credentials.save")!({
      platform: "gitee",
      apiBaseUrl: h.settings.gitee.apiBaseUrl,
      token: "another-private-token",
    });
    expect(await h.handlers.get("credentials.status")!({})).toEqual({
      codeup: true,
      gitee: true,
    });
    expect(JSON.stringify(ForgeSettingsSchema.parse(h.settings))).not.toContain(
      "token"
    );
    expect([...h.handlers.keys()]).not.toContain("credentials.read");
    await h.handlers.get("credentials.delete")!({
      platform: "gitee",
      apiBaseUrl: h.settings.gitee.apiBaseUrl,
    });
    expect(await h.handlers.get("credentials.status")!({})).toEqual({
      codeup: true,
      gitee: false,
    });
  });
  it("rejects a stale settings screen saving a token for the wrong endpoint", async () => {
    const h = registered();
    h.settings.gitee.apiBaseUrl = "https://new.example/api/v5";
    await expect(
      h.handlers.get("credentials.save")!({
        platform: "gitee",
        apiBaseUrl: "https://gitee.com/api/v5",
        token: "never-store",
      })
    ).rejects.toThrow("changed");
    expect([...h.values.values()]).not.toContain("never-store");
  });
});
