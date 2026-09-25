import type { PluginSecretStore } from "@getpaseo/plugin/server";
import { smtpConfigSchema, type SmtpConfig } from "../shared/smtp";

const KEYS = {
  host: "smtp.host",
  port: "smtp.port",
  user: "smtp.user",
  password: "smtp.password",
  to: "smtp.to",
} as const;

export interface SmtpCredentials extends SmtpConfig {
  password: string;
}

// Every field lives in `server.secrets`: the address pair is personal data, and settings documents
// are readable by every connected client.
export async function readConfig(secrets: PluginSecretStore): Promise<SmtpConfig | null> {
  const [host, port, user, to] = await Promise.all([
    secrets.get(KEYS.host),
    secrets.get(KEYS.port),
    secrets.get(KEYS.user),
    secrets.get(KEYS.to),
  ]);
  const parsed = smtpConfigSchema.safeParse({ host, port: Number(port), user, to });
  return parsed.success ? parsed.data : null;
}

export async function hasPassword(secrets: PluginSecretStore): Promise<boolean> {
  return secrets.has(KEYS.password);
}

export async function readCredentials(secrets: PluginSecretStore): Promise<SmtpCredentials | null> {
  const [config, password] = await Promise.all([readConfig(secrets), secrets.get(KEYS.password)]);
  return config && password ? { ...config, password } : null;
}

export async function writeConfig(
  secrets: PluginSecretStore,
  config: SmtpConfig,
  password: string,
): Promise<"saved" | "missing-password"> {
  if (!password && !(await secrets.has(KEYS.password))) return "missing-password";
  await secrets.set(KEYS.host, config.host);
  await secrets.set(KEYS.port, String(config.port));
  await secrets.set(KEYS.user, config.user);
  await secrets.set(KEYS.to, config.to);
  if (password) await secrets.set(KEYS.password, password);
  return "saved";
}
