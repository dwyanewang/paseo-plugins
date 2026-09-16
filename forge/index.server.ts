import {
  defineForgeServerProvider,
  type PluginServerContext,
} from "@getpaseo/plugin/server";
import { definitions } from "./shared/providers";
import { forgeSettings, platforms } from "./shared/settings";
import {
  deleteToken,
  saveToken,
  testConnection,
  tokenStatus,
} from "./shared/rpc";
import {
  authenticate,
  probeHost,
  secretKey,
  type Dependencies,
} from "./server/connection";
import { createCodeupService } from "./server/codeup";
import { createGiteeService } from "./server/gitee";

export default function contribute(server: PluginServerContext) {
  if (!server.secrets || typeof server.addForgeServerProvider !== "function") {
    throw new Error(
      "Forge requires the host APIs from feat/plugin-host-infrastructure"
    );
  }
  const document = server.registerSettings(forgeSettings);
  if (!document?.read)
    throw new Error("Forge requires server-side settings document access");
  const deps: Dependencies = {
    secrets: server.secrets,
    async readSettings() {
      const result = await document.read();
      if (result.status !== "ready")
        throw new Error(
          "Forge settings are invalid; recover them in the Forge settings screen"
        );
      return result.values;
    },
  };
  const services = {
    codeup: createCodeupService(deps),
    gitee: createGiteeService(deps),
  };
  for (const platform of platforms)
    server.addForgeServerProvider(
      defineForgeServerProvider({
        definition: definitions[platform],
        service: services[platform],
        probeHost: (host) => probeHost(platform, host, deps),
      })
    );
  async function target(input: {
    platform: "codeup" | "gitee";
    apiBaseUrl: string;
  }) {
    const config = (await deps.readSettings())[input.platform];
    if (config.apiBaseUrl !== input.apiBaseUrl)
      throw new Error(
        "API address changed; reload the settings before changing credentials"
      );
    return secretKey(input.platform, config.apiBaseUrl);
  }
  server.handle(tokenStatus, async () => {
    const settings = await deps.readSettings();
    const [codeup, gitee] = await Promise.all(
      platforms.map((p) =>
        server.secrets.has(secretKey(p, settings[p].apiBaseUrl))
      )
    );
    return { codeup, gitee };
  });
  server.handle(saveToken, async (input) => {
    await server.secrets.set(await target(input), input.token);
    return { saved: true as const };
  });
  server.handle(deleteToken, async (input) => {
    await server.secrets.delete(await target(input));
    return { deleted: true as const };
  });
  server.handle(testConnection, async (input) => {
    await target(input);
    try {
      await authenticate(input.platform, deps);
      return { authenticated: true, message: "连接成功，令牌有效" };
    } catch (error) {
      return {
        authenticated: false,
        message: error instanceof Error ? error.message : "连接失败",
      };
    }
  });
  return () => {};
}
