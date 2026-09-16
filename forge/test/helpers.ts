import { vi } from "vitest";
import type { PluginSecretStore } from "@getpaseo/plugin/server";
import { ForgeSettingsSchema } from "../shared/settings";
import { secretKey, type Dependencies } from "../server/connection";

export function harness(
  platform: "codeup" | "gitee",
  route: (url: URL, init: RequestInit) => unknown | Promise<unknown>
) {
  const settings = ForgeSettingsSchema.parse({});
  const values = new Map<string, string>([
    [secretKey(platform, settings[platform].apiBaseUrl), "test-private-token"],
  ]);
  const secrets: PluginSecretStore = {
    get: async (key) => values.get(key) ?? null,
    has: async (key) => values.has(key),
    keys: async () => [...values.keys()],
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
  };
  const fetchImpl = vi.fn<typeof fetch>(async (url, init = {}) => {
    const result = await route(new URL(String(url)), init);
    return result instanceof Response
      ? result
      : new Response(JSON.stringify(result), {
          headers: { "content-type": "application/json" },
        });
  });
  const deps: Dependencies = {
    secrets,
    readSettings: async () => settings,
    fetchImpl,
    resolveRemoteUrl: async () =>
      platform === "codeup"
        ? "git@codeup.aliyun.com:org/team/repo.git"
        : "git@gitee.com:acme/repo.git",
  };
  return { deps, settings, secrets, values, fetchImpl };
}
export const codeupRepo = {
  id: 10,
  pathWithNamespace: "org/team/repo",
  webUrl: "https://codeup.aliyun.com/org/team/repo",
  sshUrlToRepo: "git@codeup.aliyun.com:org/team/repo.git",
  httpUrlToRepo: "https://codeup.aliyun.com/org/team/repo.git",
};
export const codeupMr = {
  localId: 7,
  title: "Fix permissions",
  description: "Details",
  sourceBranch: "feature",
  targetBranch: "main",
  sourceProjectId: "10",
  targetProjectId: "10",
  status: "TO_BE_MERGED",
  sourceCommitId: "source-sha",
  allRequirementsPass: true,
  conflictCheckStatus: "NO_CONFLICT",
  detailUrl: "https://codeup.aliyun.com/org/team/repo/change/7",
  updateTime: "2026-09-16T00:00:00Z",
  reviewers: [
    {
      userId: "u1",
      name: "Reviewer",
      reviewOpinionStatus: "PASS",
      hasReviewed: true,
      reviewTime: "2026-09-15T00:00:00Z",
    },
  ],
};
export const giteeRepo = {
  id: 10,
  full_name: "acme/repo",
  ssh_url: "git@gitee.com:acme/repo.git",
  clone_url: "https://gitee.com/acme/repo.git",
};
export const giteePr = {
  number: 7,
  title: "Fix permissions",
  body: "Details",
  html_url: "https://gitee.com/acme/repo/pulls/7",
  state: "open",
  draft: false,
  mergeable: true,
  can_merge_check: true,
  updated_at: "2026-09-16T00:00:00Z",
  head: { ref: "feature", sha: "source-sha", repo: giteeRepo },
  base: { ref: "main", sha: "base-sha", repo: giteeRepo },
  assignees: [{ login: "reviewer", accept: true }],
};
