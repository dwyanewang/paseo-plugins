import { createHash } from "node:crypto";
import {
  ForgeAuthenticationError,
  ForgeCommandError,
  type PluginSecretStore,
} from "@getpaseo/plugin/server";
import {
  createForgeHttpClient,
  defaultResolveRemoteUrl,
  parseGitRemoteLocation,
  type ForgeHttpClient,
  type ForgeHttpRequest,
  type GitRemoteLocation,
} from "@getpaseo/plugin/server/forge-toolkit";
import { z } from "zod";
import { definitions } from "../shared/providers";
import type { ForgeSettings, Platform } from "../shared/settings";

export interface Dependencies {
  readSettings(): Promise<ForgeSettings>;
  secrets: PluginSecretStore;
  fetchImpl?: typeof fetch;
  resolveRemoteUrl?: (cwd: string) => Promise<string | null>;
}
export interface Connection {
  platform: Platform;
  settings: ForgeSettings;
  http: ForgeHttpClient;
  /** Opaque scope for discovery hints; a credential or configuration change isolates them. */
  cacheScope: string;
}
export interface RepositoryConnection extends Connection {
  cwd: string;
  remote: GitRemoteLocation;
  projectPath: string;
}

export function secretKey(platform: Platform, apiBaseUrl: string): string {
  return `${platform}.${createHash("sha256")
    .update(apiBaseUrl)
    .digest("hex")}.token`;
}
export function requestError(
  platform: Platform,
  cwd: string,
  message: string,
): ForgeCommandError {
  const error = new ForgeCommandError(
    {
      brand: definitions[platform].displayName,
      binary: "HTTP API",
      kind: "request",
    },
    {
      args: [],
      cwd,
      exitCode: null,
      stderr: message,
    },
  );
  error.message = message;
  return error;
}

export async function connect(
  platform: Platform,
  deps: Dependencies,
): Promise<Connection> {
  const settings = await deps.readSettings();
  const { apiBaseUrl } = settings[platform];
  // Bind credentials to the exact endpoint; changing an API URL never forwards an existing token.
  const token = await deps.secrets.get(secretKey(platform, apiBaseUrl));
  const nativeFetch = deps.fetchImpl ?? globalThis.fetch;
  const client = createForgeHttpClient({
    brand: definitions[platform].displayName,
    baseUrl: apiBaseUrl,
    resolveToken: async () => token,
    applyToken(value, { url, headers }) {
      if (platform === "codeup") headers.set("x-yunxiao-token", value);
      // Gitee documents access_token as a query parameter. It is injected here,
      // never into the request description or settings returned to clients.
      else url.searchParams.set("access_token", value);
    },
    async fetchImpl(url, init) {
      // Custom token headers must never follow a redirect to another origin.
      const response = await nativeFetch(url, { ...init, redirect: "error" });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 8 * 1024 * 1024)
            throw new Error("Forge response exceeded 8 MiB");
          chunks.push(value);
        }
      } finally {
        await reader?.cancel().catch(() => {});
      }
      // Buffer before returning so the toolkit timeout also covers the body.
      return new Response(length ? Buffer.concat(chunks) : null, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
  function sanitize(error: unknown): never {
    const clean = (text: string) =>
      (token
        ? text
            .split(token)
            .join("<redacted>")
            .split(encodeURIComponent(token))
            .join("<redacted>")
        : text
      ).slice(0, 2000);
    if (error instanceof ForgeAuthenticationError) {
      // The toolkit keeps the platform's explanation in stderr. Surface only
      // known JSON error fields, never an HTML response or a credential echo.
      let detail = "";
      try {
        const data: unknown = JSON.parse(error.stderr);
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const fields = data as Record<string, unknown>;
          detail = [
            fields.errorCode ?? fields.code,
            fields.errorMessage ?? fields.message ?? fields.error_description,
          ]
            .filter((value): value is string => typeof value === "string")
            .map((value) => clean(value).replace(/[\r\n\t]+/g, " ").slice(0, 500))
            .filter(Boolean)
            .join(": ");
        }
      } catch {
        // Keep the HTTP status when the response is not a structured API error.
      }
      throw new ForgeAuthenticationError(
        clean(`${error.message}${detail ? ` — ${detail}` : ""}`),
        { stderr: clean(error.stderr) },
      );
    }
    if (error instanceof ForgeCommandError) {
      const safe = new ForgeCommandError(
        {
          brand: definitions[platform].displayName,
          binary: new URL(apiBaseUrl).host,
          kind: "request",
        },
        {
          args: error.args.map(clean),
          cwd: error.cwd,
          exitCode: error.exitCode,
          stderr: clean(error.stderr),
        },
      );
      safe.message = `${definitions[platform].displayName}: ${clean(
        error.stderr,
      )}`;
      throw safe;
    }
    throw requestError(platform, "", "Forge HTTP request failed");
  }
  return {
    platform,
    settings,
    cacheScope: createHash("sha256")
      .update(JSON.stringify([platform, settings[platform], token]))
      .digest("hex"),
    http: {
      async request<T>(request: ForgeHttpRequest<T>): Promise<T> {
        try {
          return await client.request(request);
        } catch (error) {
          return sanitize(error);
        }
      },
      async send(request) {
        try {
          return await client.send(request);
        } catch (error) {
          return sanitize(error);
        }
      },
    },
  };
}

export async function repositoryConnection(
  platform: Platform,
  cwd: string,
  deps: Dependencies,
): Promise<RepositoryConnection> {
  const connection = await connect(platform, deps);
  const remoteUrl = await (deps.resolveRemoteUrl ?? defaultResolveRemoteUrl)(
    cwd,
  );
  const remote = remoteUrl ? parseGitRemoteLocation(remoteUrl) : null;
  if (!remote || !connection.settings[platform].hosts.includes(remote.host)) {
    throw requestError(
      platform,
      cwd,
      `Configure ${definitions[platform].displayName} for this repository's origin host first`,
    );
  }
  const segments = remote.path.split("/");
  if (
    segments.length < 2 ||
    segments.some((s) => !s || s === "." || s === "..")
  ) {
    throw requestError(
      platform,
      cwd,
      "The Git remote must contain a namespace and repository path",
    );
  }
  return { ...connection, cwd, remote, projectPath: remote.path };
}

export async function probeHost(
  platform: Platform,
  host: string,
  deps: Dependencies,
): Promise<boolean> {
  const settings = await deps.readSettings();
  return (
    settings[platform].hosts.includes(host.toLowerCase()) &&
    deps.secrets.has(secretKey(platform, settings[platform].apiBaseUrl))
  );
}

export async function authenticate(
  platform: Platform,
  deps: Dependencies,
  cwd = "",
): Promise<boolean> {
  const { http } = await connect(platform, deps);
  try {
    await http.request({
      cwd,
      path: platform === "codeup" ? "/oapi/v1/platform/user" : "/user",
      schema: z.object({ id: z.union([z.string().min(1), z.number()]) }),
    });
  } catch (error) {
    if (
      platform === "codeup" &&
      error instanceof ForgeAuthenticationError &&
      error.stderr.includes("Current token has no permission to api.")
    ) {
      throw new ForgeAuthenticationError(
        `${error.message}；当前令牌缺少“获取当前用户信息”接口（GET /oapi/v1/platform/user）的权限。请在云效个人访问令牌的“组织管理”中补充该接口的读取权限；仅有代码仓库权限不足以通过此测试。`,
        { stderr: error.stderr },
      );
    }
    throw error;
  }
  return true;
}
