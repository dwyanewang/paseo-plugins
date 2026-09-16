import {
  compareTimelineItems,
  createUnavailableSearchResult,
  ForgeAuthenticationError,
  normalizeForgeSearchKinds,
  parseOptionalTime,
  type ForgeService,
  type PullRequestCheckoutTarget,
  type PullRequestSummary,
  type PullRequestTimeline,
  type PullRequestTimelineError,
} from "@getpaseo/plugin/server";
import {
  createForgePageGuard,
  parseGitRemoteLocation,
} from "@getpaseo/plugin/server/forge-toolkit";
import type { Platform } from "../shared/settings";
import { definitions } from "../shared/providers";
import { authenticate, requestError, type Dependencies } from "./connection";

export const PAGE_SIZE = 100;
export function limitOf(limit = 20): number {
  return Math.max(1, Math.min(500, Math.floor(limit)));
}
export async function* pages<T>(
  platform: Platform,
  fetchPage: (page: number) => Promise<T[]>,
  key: (item: T) => string,
): AsyncGenerator<T[]> {
  const guard = createForgePageGuard({
    brand: definitions[platform].displayName,
    pageSize: PAGE_SIZE,
  });
  for (let page = 1; page <= 100; page++) {
    const items = await fetchPage(page);
    guard.assertProgress({ itemCount: items.length, pageKeys: items.map(key) });
    yield items;
    if (
      !guard.hasNextPage({
        itemCount: items.length,
        page,
        visited: page * PAGE_SIZE,
        total: undefined,
      })
    )
      return;
  }
  throw requestError(platform, "", "Forge pagination exceeded 100 pages");
}
export function numberQuery(query?: string): number | null {
  const match = query?.trim().match(/^[#!]?(\d+)$/);
  const number = match ? Number(match[1]) : 0;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
export function timelineError(error: unknown): PullRequestTimelineError {
  const status =
    error && typeof error === "object" && "exitCode" in error
      ? error.exitCode
      : null;
  return {
    kind:
      status === 404
        ? "not_found"
        : error instanceof ForgeAuthenticationError
          ? "forbidden"
          : "unknown",
    message: error instanceof Error ? error.message : "Failed to load activity",
  };
}
export function sortTimeline(
  timeline: PullRequestTimeline,
): PullRequestTimeline {
  const unique = new Map(timeline.items.map((item) => [item.id, item]));
  return {
    ...timeline,
    items: [...unique.values()].sort(compareTimelineItems),
  };
}
export function checkoutTarget(params: {
  number: number;
  base: string;
  head: string;
  cross: boolean;
  ssh: string | null;
  https: string | null;
  useHttps: boolean;
  owner: string | null;
}): PullRequestCheckoutTarget {
  const url = params.useHttps
    ? (params.https ?? params.ssh)
    : (params.ssh ?? params.https);
  if (params.cross && (!url || !parseGitRemoteLocation(url)))
    throw new Error("The source repository has no usable clone URL");
  return {
    number: params.number,
    baseRefName: params.base,
    headRefName: params.head,
    checkoutRefs: [
      {
        ...(params.cross && url
          ? { remoteUrl: url }
          : { remoteName: "origin" }),
        remoteRef: `refs/heads/${params.head}`,
      },
    ],
    ...(params.cross && url ? { preferredPushUrl: url } : {}),
    headOwnerLogin: params.owner,
    headRepositorySshUrl: params.ssh,
    headRepositoryUrl: params.https,
    isCrossRepository: params.cross,
  };
}

export function completeService(
  platform: Platform,
  deps: Dependencies,
  service: Pick<
    ForgeService,
    | "listPullRequests"
    | "getPullRequest"
    | "getCurrentPullRequestStatus"
    | "getPullRequestCheckoutTarget"
    | "getPullRequestTimeline"
    | "getCheckDetails"
    | "createPullRequest"
    | "mergePullRequest"
  >,
): ForgeService {
  return {
    ...service,
    authProbeCanThrow: true,
    supportsCrossRepoCheckoutWithoutRefs: false,
    isAuthenticated: ({ cwd }) => authenticate(platform, deps, cwd),
    async getPullRequestHeadRef(input) {
      return (await service.getPullRequest(input)).headRefName;
    },
    // Codeup has no repository issue resource; Gitee issue IDs are alphanumeric
    // and cannot be represented by the host's numeric IssueSummary contract.
    async listIssues() {
      return [];
    },
    async searchIssuesAndPrs(input) {
      try {
        let requests: PullRequestSummary[] = [];
        if (normalizeForgeSearchKinds(input.kinds).includes("change_request"))
          requests = await service.listPullRequests(input);
        else await authenticate(platform, deps, input.cwd);
        return {
          items: requests
            .map((pr) => ({
              ...pr,
              kind: "change_request" as const,
              forge: definitions[platform].id,
            }))
            .sort(
              (a, b) =>
                parseOptionalTime(b.updatedAt) - parseOptionalTime(a.updatedAt),
            ),
          featuresEnabled: true,
          authState: "authenticated" as const,
        };
      } catch (error) {
        if (error instanceof ForgeAuthenticationError)
          return createUnavailableSearchResult("unauthenticated");
        throw error;
      }
    },
    async enablePullRequestAutoMerge({ cwd }) {
      throw requestError(
        platform,
        cwd,
        "This adapter does not support automatic merging",
      );
    },
    async disablePullRequestAutoMerge({ cwd }) {
      throw requestError(
        platform,
        cwd,
        "This adapter does not support automatic merging",
      );
    },
    // Adapters with discovery hints override these lifecycle hooks.
    invalidate() {},
    dispose() {},
  };
}
