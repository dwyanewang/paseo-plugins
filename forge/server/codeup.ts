import { z } from "zod";
import {
  computeChecksStatus,
  ForgeCommandError,
  parseOptionalTime,
  type CurrentPullRequestStatus,
  type ForgeService,
  type PullRequestCheck,
  type PullRequestSummary,
  type PullRequestTimelineItem,
} from "@getpaseo/plugin/server";
import {
  completeService,
  checkoutTarget,
  limitOf,
  numberQuery,
  pages,
  PAGE_SIZE,
  sortTimeline,
  timelineError,
} from "./common";
import {
  repositoryConnection,
  requestError,
  type Dependencies,
  type RepositoryConnection,
} from "./connection";
import { discover, discoveryCursor } from "./codeup-discovery";

const text = z.string().nullish();
const IdSchema = z
  .union([z.string().min(1), z.number().int()])
  .transform(String);
const UserSchema = z.object({
  userId: text,
  name: text,
  username: text,
  avatar: text,
  reviewOpinionStatus: text,
  reviewTime: text,
  hasReviewed: z.boolean().nullish(),
});
const RepoSchema = z.object({
  id: IdSchema,
  pathWithNamespace: text,
  webUrl: text,
  sshUrlToRepo: text,
  httpUrlToRepo: text,
});
type Repo = z.infer<typeof RepoSchema>;
const ChangeSchema = z.object({
  localId: z.union([
    z.number().int().positive(),
    z
      .string()
      .regex(/^[1-9]\d*$/)
      .transform(Number),
  ]),
  title: z.string(),
  description: text,
  sourceBranch: z.string(),
  targetBranch: z.string(),
  sourceProjectId: IdSchema,
  targetProjectId: IdSchema,
  status: text,
  state: text,
  sourceCommitId: text,
  detailUrl: text,
  webUrl: text,
  updateTime: text,
  updatedAt: text,
  allRequirementsPass: z.boolean().nullish(),
  conflictCheckStatus: text,
  workInProgress: z.boolean().nullish(),
  reviewers: z.array(UserSchema).nullish(),
  labels: z.array(z.object({ name: z.string() })).nullish(),
  todoList: z
    .object({
      requirementCheckItems: z
        .array(z.object({ itemType: z.string(), pass: z.boolean() }))
        .optional(),
    })
    .nullish(),
});
type Change = z.infer<typeof ChangeSchema>;
const PatchSchema = z.object({
  commitId: text,
  relatedMergeItemType: text,
  versionNo: z.number().nullish(),
});
const CommentSchema = z.object({
  comment_biz_id: z.string(),
  content: text,
  comment_time: text,
  author: UserSchema.nullish(),
  is_deleted: z.boolean().nullish(),
  state: text,
  filePath: text,
  line_number: z.union([z.string(), z.number()]).nullish(),
  resolved: z.boolean().nullish(),
  root_comment_biz_id: text,
  parent_comment_biz_id: text,
  child_comments_list: z.array(z.unknown()).nullish(),
});

interface Context extends RepositoryConnection {
  apiRoot: string;
  repository: Repo;
  repositoryRoot: string;
}
async function context(cwd: string, deps: Dependencies): Promise<Context> {
  const ctx = await repositoryConnection("codeup", cwd, deps);
  const config = ctx.settings.codeup;
  const organization = config.organizationId || ctx.projectPath.split("/")[0];
  const apiRoot =
    config.edition === "region"
      ? "/oapi/v1/codeup"
      : `/oapi/v1/codeup/organizations/${encodeURIComponent(organization)}`;
  const repository = await ctx.http.request({
    cwd,
    path: `${apiRoot}/repositories/${encodeURIComponent(ctx.projectPath)}`,
    schema: RepoSchema,
  });
  return {
    ...ctx,
    apiRoot,
    repository,
    repositoryRoot: `${apiRoot}/repositories/${encodeURIComponent(
      repository.id,
    )}`,
  };
}
function state(mr: Change): string {
  switch ((mr.status ?? mr.state ?? "").toUpperCase()) {
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    case "UNDER_DEV":
    case "UNDER_REVIEW":
    case "TO_BE_MERGED":
    case "OPENED":
      return "open";
    default:
      return "unknown";
  }
}
function url(mr: {
  detailUrl?: string | null;
  webUrl?: string | null;
}): string {
  const value = mr.detailUrl || mr.webUrl;
  if (!value)
    throw requestError(
      "codeup",
      "",
      "Codeup did not return a merge request URL",
    );
  return value;
}
function summary(mr: Change, ctx: Context): PullRequestSummary {
  return {
    number: mr.localId,
    title: mr.title,
    url: url(mr),
    state: state(mr),
    body: mr.description ?? null,
    projectPath: ctx.repository.pathWithNamespace ?? ctx.projectPath,
    headRefName: mr.sourceBranch,
    baseRefName: mr.targetBranch,
    labels: (mr.labels ?? []).map((l) => l.name),
    updatedAt: mr.updateTime ?? mr.updatedAt ?? "",
  };
}
function status(mr: Change, ctx: Context): CurrentPullRequestStatus {
  const checks: PullRequestCheck[] = [
    {
      name: "Codeup merge requirements",
      status: mr.allRequirementsPass === true ? "success" : "pending",
      url: url(mr),
    },
    {
      name: "Merge conflicts",
      status:
        mr.conflictCheckStatus === "NO_CONFLICT"
          ? "success"
          : mr.conflictCheckStatus === "HAS_CONFLICT"
            ? "failure"
            : "pending",
      url: url(mr),
    },
    ...(mr.todoList?.requirementCheckItems ?? []).map((c) => ({
      name: c.itemType,
      status: c.pass ? ("success" as const) : ("failure" as const),
      url: url(mr),
    })),
  ];
  const reviewers = mr.reviewers ?? [];
  const ready =
    mr.status === "TO_BE_MERGED" &&
    mr.allRequirementsPass === true &&
    mr.conflictCheckStatus === "NO_CONFLICT" &&
    !mr.workInProgress &&
    (mr.todoList?.requirementCheckItems ?? []).every((c) => c.pass);
  return {
    ...summary(mr, ctx),
    repoOwner: ctx.projectPath.split("/").slice(0, -1).join("/"),
    repoName: ctx.projectPath.split("/").at(-1),
    isMerged: state(mr) === "merged",
    isDraft: mr.workInProgress === true || mr.status === "UNDER_DEV",
    mergeable:
      mr.conflictCheckStatus === "HAS_CONFLICT"
        ? "CONFLICTING"
        : mr.conflictCheckStatus === "NO_CONFLICT"
          ? "MERGEABLE"
          : "UNKNOWN",
    checks,
    checksStatus: computeChecksStatus(checks),
    reviewDecision: reviewers.some((r) => r.reviewOpinionStatus === "NOT_PASS")
      ? "changes_requested"
      : reviewers.length
        ? reviewers.every((r) => r.reviewOpinionStatus === "PASS")
          ? "approved"
          : "pending"
        : null,
    forgeSpecific: {
      forge: "forge-codeup",
      ready,
      allowedMethods: ["merge", "squash", "rebase"],
    },
  };
}
async function get(ctx: Context, number: number): Promise<Change> {
  return ctx.http.request({
    cwd: ctx.cwd,
    path: `${ctx.repositoryRoot}/changeRequests/${number}`,
    schema: ChangeSchema,
  });
}
function listPage(
  ctx: Context,
  page: number,
  desiredState?: string,
  search?: string,
) {
  return ctx.http.request({
    cwd: ctx.cwd,
    path: `${ctx.apiRoot}/changeRequests`,
    query: {
      projectIds: ctx.repository.id,
      state: desiredState,
      search,
      page,
      perPage: PAGE_SIZE,
      orderBy: "updated_at",
      sort: "desc",
    },
    schema: z.array(ChangeSchema),
  });
}
function list(ctx: Context, desiredState?: string, search?: string) {
  return pages(
    "codeup",
    (page) => listPage(ctx, page, desiredState, search),
    (mr) => String(mr.localId),
  );
}
async function sourceSha(ctx: Context, mr: Change): Promise<string | null> {
  if (mr.sourceCommitId) return mr.sourceCommitId;
  const patches = await ctx.http.request({
    cwd: ctx.cwd,
    path: `${ctx.repositoryRoot}/changeRequests/${mr.localId}/diffs/patches`,
    schema: z.array(PatchSchema),
  });
  return (
    patches
      .filter((p) => p.relatedMergeItemType === "MERGE_SOURCE" && p.commitId)
      .sort((a, b) => (b.versionNo ?? 0) - (a.versionNo ?? 0))[0]?.commitId ??
    null
  );
}
async function matchesSource(
  ctx: Context,
  mr: Change,
  expectedPath?: string,
): Promise<boolean> {
  if (!expectedPath) return mr.sourceProjectId === ctx.repository.id;
  const source =
    mr.sourceProjectId === ctx.repository.id
      ? ctx.repository
      : await ctx.http.request({
          cwd: ctx.cwd,
          path: `${ctx.apiRoot}/repositories/${encodeURIComponent(
            mr.sourceProjectId,
          )}`,
          schema: RepoSchema,
        });
  return source.pathWithNamespace === expectedPath;
}

function comments(values: unknown[], link: string): PullRequestTimelineItem[] {
  const items: PullRequestTimelineItem[] = [];
  const queue = [...values];
  for (let index = 0; index < queue.length; index++) {
    if (index >= 10000)
      throw requestError(
        "codeup",
        "",
        "Codeup activity exceeds 10000 comments",
      );
    const c = CommentSchema.parse(queue[index]);
    queue.push(...(c.child_comments_list ?? []));
    if (c.is_deleted || c.state === "DRAFT") continue;
    const threadId =
      c.root_comment_biz_id || c.parent_comment_biz_id || c.comment_biz_id;
    const line = Number(c.line_number);
    items.push({
      kind: "comment",
      id: `comment:${c.comment_biz_id}`,
      body: c.content ?? "",
      createdAt: parseOptionalTime(c.comment_time),
      author: c.author?.name ?? c.author?.username ?? "",
      authorUrl: null,
      avatarUrl: c.author?.avatar ?? null,
      url: link,
      threadId,
      threadIsResolved: c.resolved ?? undefined,
      ...(c.filePath
        ? {
            location: {
              path: c.filePath,
              ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
              threadId,
              isResolved: c.resolved ?? undefined,
            },
          }
        : {}),
    });
  }
  return items;
}
function reviews(mr: Change): PullRequestTimelineItem[] {
  return (mr.reviewers ?? [])
    .filter(
      (r) =>
        r.hasReviewed ||
        r.reviewOpinionStatus === "PASS" ||
        r.reviewOpinionStatus === "NOT_PASS",
    )
    .map((r, index) => ({
      kind: "review",
      id: `review:${r.userId ?? r.username ?? index}`,
      body: "",
      author: r.name ?? r.username ?? "",
      authorUrl: null,
      avatarUrl: r.avatar ?? null,
      createdAt: parseOptionalTime(r.reviewTime),
      url: url(mr),
      reviewState:
        r.reviewOpinionStatus === "PASS"
          ? "approved"
          : r.reviewOpinionStatus === "NOT_PASS"
            ? "changes_requested"
            : "commented",
    }));
}

export function createCodeupService(deps: Dependencies) {
  type LookupInput = Parameters<ForgeService["getCurrentPullRequestStatus"]>[0];
  interface Lookup {
    cwd: string;
    opened: ReturnType<typeof discoveryCursor>;
    history: ReturnType<typeof discoveryCursor>;
    number?: number;
    running?: Promise<CurrentPullRequestStatus | null>;
  }
  // Bound memory independently of repository history size. These are discovery
  // hints only: every matched MR, including its gates, is fetched again.
  const lookups = new Map<string, Lookup>();
  function forget(cwd: string) {
    for (const [key, lookup] of lookups) {
      if (lookup.cwd === cwd) lookups.delete(key);
    }
  }
  async function lookupStatus(
    ctx: Context,
    input: LookupInput,
    lookup: Lookup,
  ) {
    async function read(number: number): Promise<Change | null> {
      let mr: Change;
      try {
        mr = await get(ctx, number);
      } catch (error) {
        if (error instanceof ForgeCommandError && error.exitCode === 404)
          return null;
        throw error;
      }
      if (
        mr.sourceBranch !== input.headRef ||
        !(await matchesSource(ctx, mr, input.headRepositoryOwner))
      )
        return null;
      if (state(mr) === "open") return mr;
      if (state(mr) === "unknown" || !input.headSha) return null;
      return (await sourceSha(ctx, mr)) === input.headSha ? mr : null;
    }
    const previous =
      lookup.number === undefined ? null : await read(lookup.number);
    if (previous && state(previous) === "open") return status(previous, ctx);
    if (lookup.number !== undefined && !previous) {
      lookup.number = undefined;
      lookup.opened = discoveryCursor();
      lookup.history = discoveryCursor();
    }
    const visited = new Set<number>();
    async function match(candidate: Change) {
      if (
        visited.has(candidate.localId) ||
        candidate.sourceBranch !== input.headRef
      )
        return null;
      visited.add(candidate.localId);
      if (
        !input.headRepositoryOwner &&
        candidate.sourceProjectId !== ctx.repository.id
      )
        return null;
      if (
        state(candidate) !== "open" &&
        state(candidate) !== "unknown" &&
        (!input.headSha ||
          (candidate.sourceCommitId &&
            candidate.sourceCommitId !== input.headSha))
      )
        return null;
      return read(candidate.localId);
    }
    const opened = await discover(
      lookup.opened,
      (page) => listPage(ctx, page, "opened"),
      (mr) => String(mr.localId),
      match,
    );
    // An open MR wins over a previously matched terminal request. Recent pages
    // are refreshed even after a completed scan, so new/reopened MRs are visible.
    const mr =
      opened ??
      previous ??
      (input.headSha
        ? await discover(
            lookup.history,
            (page) => listPage(ctx, page),
            (candidate) => String(candidate.localId),
            match,
          )
        : null);
    if (!mr) return null;
    lookup.number = mr.localId;
    return status(mr, ctx);
  }
  const service = completeService("codeup", deps, {
    async listPullRequests(input) {
      const ctx = await context(input.cwd, deps),
        number = numberQuery(input.query);
      if (number) return [summary(await get(ctx, number), ctx)];
      const result: PullRequestSummary[] = [];
      for await (const batch of list(
        ctx,
        "opened",
        input.query?.trim() || undefined,
      )) {
        result.push(...batch.map((mr) => summary(mr, ctx)));
        if (result.length >= limitOf(input.limit)) break;
      }
      return result.slice(0, limitOf(input.limit));
    },
    async getPullRequest(input) {
      const ctx = await context(input.cwd, deps);
      return summary(await get(ctx, input.number), ctx);
    },
    async getCurrentPullRequestStatus(input) {
      const ctx = await context(input.cwd, deps);
      const key = JSON.stringify([
        ctx.cacheScope,
        ctx.repositoryRoot,
        input.cwd,
        input.headRef,
        input.headSha ?? null,
        input.headRepositoryOwner ?? null,
      ]);
      const lookup: Lookup = lookups.get(key) ?? {
        cwd: input.cwd,
        opened: discoveryCursor(),
        history: discoveryCursor(),
      };
      lookups.delete(key);
      lookups.set(key, lookup);
      if (lookups.size > 128) lookups.delete(lookups.keys().next().value!);
      if (!lookup.running) {
        lookup.running = lookupStatus(ctx, input, lookup).finally(() => {
          lookup.running = undefined;
        });
      }
      return lookup.running;
    },
    async getPullRequestCheckoutTarget(input) {
      const ctx = await context(input.cwd, deps),
        mr = await get(ctx, input.number);
      const cross = mr.sourceProjectId !== mr.targetProjectId;
      const source = cross
        ? await ctx.http.request({
            cwd: ctx.cwd,
            path: `${ctx.apiRoot}/repositories/${encodeURIComponent(
              mr.sourceProjectId,
            )}`,
            schema: RepoSchema,
          })
        : ctx.repository;
      return checkoutTarget({
        number: mr.localId,
        base: mr.targetBranch,
        head: mr.sourceBranch,
        cross,
        ssh: source.sshUrlToRepo ?? null,
        https: source.httpUrlToRepo ?? null,
        useHttps:
          ctx.remote.transport === "http" || ctx.remote.transport === "https",
        owner: cross ? (source.pathWithNamespace ?? null) : null,
      });
    },
    async getPullRequestTimeline(input) {
      const identity = {
        prNumber: input.prNumber,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
      };
      const items: PullRequestTimelineItem[] = [];
      try {
        const ctx = await context(input.cwd, deps),
          mr = await get(ctx, input.prNumber);
        items.push(...reviews(mr));
        const batches = await Promise.allSettled(
          ["GLOBAL_COMMENT", "INLINE_COMMENT"].flatMap((commentType) =>
            [false, true].map((resolved) =>
              ctx.http.request({
                cwd: ctx.cwd,
                path: `${ctx.repositoryRoot}/changeRequests/${input.prNumber}/comments/list`,
                method: "POST",
                body: {
                  commentType,
                  resolved,
                  state: "OPENED",
                  patchSetBizIds: [],
                },
                schema: z.array(z.unknown()),
              }),
            ),
          ),
        );
        let failure: unknown;
        for (const batch of batches) {
          if (batch.status === "fulfilled")
            items.push(...comments(batch.value, url(mr)));
          else failure = batch.reason;
        }
        return sortTimeline({
          ...identity,
          items,
          truncated: failure !== undefined,
          error: failure === undefined ? null : timelineError(failure),
        });
      } catch (error) {
        return sortTimeline({
          ...identity,
          items,
          truncated: items.length > 0,
          error: timelineError(error),
        });
      }
    },
    async getCheckDetails(input) {
      throw requestError(
        "codeup",
        input.cwd,
        "Codeup OpenAPI exposes merge gates here; open the merge request to view CI job logs",
      );
    },
    async createPullRequest(input) {
      const ctx = await context(input.cwd, deps);
      forget(input.cwd);
      const result = await ctx.http.request({
        cwd: ctx.cwd,
        path: `${ctx.repositoryRoot}/changeRequests`,
        method: "POST",
        body: {
          title: input.title,
          sourceBranch: input.head,
          targetBranch: input.base,
          description: input.body ?? "",
          sourceProjectId: ctx.repository.id,
          targetProjectId: ctx.repository.id,
          createFrom: "WEB",
          triggerAIReviewRun: false,
        },
        schema: z.object({
          localId: z.union([
            z.number().int().positive(),
            z
              .string()
              .regex(/^[1-9]\d*$/)
              .transform(Number),
          ]),
          detailUrl: text,
          webUrl: text,
        }),
      });
      return {
        number: result.localId,
        url:
          result.detailUrl || result.webUrl
            ? url(result)
            : url(await get(ctx, result.localId)),
      };
    },
    async mergePullRequest(input) {
      const ctx = await context(input.cwd, deps),
        mr = await get(ctx, input.prNumber);
      if (status(mr, ctx).forgeSpecific?.ready !== true)
        throw requestError(
          "codeup",
          ctx.cwd,
          "Codeup has not confirmed that all merge requirements pass",
        );
      forget(input.cwd);
      await ctx.http.send({
        cwd: ctx.cwd,
        path: `${ctx.repositoryRoot}/changeRequests/${input.prNumber}/merge`,
        method: "POST",
        body: {
          mergeType:
            input.mergeMethod === "merge"
              ? "no-fast-forward"
              : input.mergeMethod,
          removeSourceBranch: false,
        },
      });
      if (state(await get(ctx, input.prNumber)) !== "merged")
        throw requestError(
          "codeup",
          ctx.cwd,
          "Merge was submitted, but Codeup has not confirmed completion; refresh before retrying",
        );
      return { success: true };
    },
  });
  return {
    ...service,
    invalidate({ cwd }: { cwd: string }) {
      forget(cwd);
    },
    dispose() {
      lookups.clear();
    },
  };
}
