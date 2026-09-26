import type { PluginSecretStore } from "@getpaseo/plugin/server";
import { ntfyConfigSchema, type NtfyConfig } from "../shared/ntfy";

const KEYS = {
  server: "ntfy.server",
  topic: "ntfy.topic",
  token: "ntfy.token",
} as const;

export interface NtfyCredentials extends NtfyConfig {
  token: string | null;
}

export async function readConfig(secrets: PluginSecretStore): Promise<NtfyConfig | null> {
  const [server, topic] = await Promise.all([secrets.get(KEYS.server), secrets.get(KEYS.topic)]);
  const parsed = ntfyConfigSchema.safeParse({ server, topic });
  return parsed.success ? parsed.data : null;
}

export async function hasToken(secrets: PluginSecretStore): Promise<boolean> {
  return secrets.has(KEYS.token);
}

export async function readCredentials(secrets: PluginSecretStore): Promise<NtfyCredentials | null> {
  const [config, token] = await Promise.all([readConfig(secrets), secrets.get(KEYS.token)]);
  return config ? { ...config, token } : null;
}

export async function writeConfig(
  secrets: PluginSecretStore,
  config: NtfyConfig,
  token: string,
  clearToken: boolean,
): Promise<void> {
  await secrets.set(KEYS.server, config.server);
  await secrets.set(KEYS.topic, config.topic);
  if (clearToken) await secrets.delete(KEYS.token);
  else if (token) await secrets.set(KEYS.token, token);
}
