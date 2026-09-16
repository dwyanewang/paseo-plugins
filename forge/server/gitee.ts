import { z } from "zod";
import {
  computeChecksStatus,
  formatCheckDuration,
  parseOptionalTime,
  type CurrentPullRequestStatus,
  type PullRequestCheck,
  type PullRequestSummary,
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

const text = z.string().nullish();
const RepoSchema = z.object({
  id: z.number(),
  full_name: z.string(),
  ssh_url: text,
  clone_url: text,
  html_url: text,
});
const RefSchema = z.object({
  ref: z.string(),
  sha: text,
  repo: RepoSchema.nullable(),
});
const UserSchema = z.object({
  login: text,
  name: text,
  html_url: text,
  avatar_url: text,
  accept: z.boolean().optional(),
});
const PullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string().url(),
  state: z.string(),
  body: text,
  updated_at: text,
  merged_at: text,
  merged: z.boolean().optional(),
  draft: z.boolean().optional(),
  mergeable: z.boolean().nullish(),
  can_merge_check: z.boolean().nullish(),
  head: RefSchema,
  base: RefSchema,
  labels: z.array(z.object({ name: z.string() })).nullish(),
  assignees: z.array(UserSchema).nullish(),
});
type Pull = z.infer<typeof PullSchema>;
const CheckSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  status: z.string(),
  conclusion: text,
  html_url: text,
  details_url: text,
  started_at: text,
  completed_at: text,
  output: z.object({ title: text, summary: text, text }).nullish(),
});
type Check = z.infer<typeof CheckSchema>;
const CommentSchema = z.object({
  id: z.number(),
  body: text,
  html_url: text,
  created_at: text,
  user: UserSchema.nullish(),
  path: text,
  new_line: z.union([z.number(), z.string()]).nullish(),
  in_reply_to_id: z.number().nullish(),
});
const AnnotationSchema = z.object({
  path: text,
  start_line: z.number().optional(),
  end_line: z.number().optional(),
  annotation_level: text,
  message: text,
  title: text,
  raw_details: text,
});

function root(ctx: RepositoryConnection): string {
  const segments = ctx.projectPath.split("/");
  if (segments.length !== 2)
    throw requestError(
      "gitee",
      ctx.cwd,
      "Gitee requires an owner/repository remote path",
    );
  return `/repos/${segments.map(encodeURIComponent).join("/")}`;
}
const merged = (pr: Pull) =>
  pr.merged === true || Boolean(pr.merged_at) || pr.state === "merged";
function matchesSource(pr: Pull, ownerHint?: string): boolean {
  const source = pr.head.repo;
  if (!source) return false;
  // Old remote paths can remain usable after a repository transfer. IDs remain
  // stable even when the API returns the repository's new canonical path.
  if (!ownerHint) return source.id === pr.base.repo?.id;
  const path = source.full_name.toLowerCase();
  const hint = ownerHint.toLowerCase();
  return hint.includes("/") ? path === hint : path.split("/")[0] === hint;
}
function summary(pr: Pull, ctx: RepositoryConnection): PullRequestSummary {
  return {
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    state: merged(pr) ? "merged" : pr.state,
    body: pr.body ?? null,
    projectPath: ctx.projectPath,
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    labels: (pr.labels ?? []).map((l) => l.name),
    updatedAt: pr.updated_at ?? "",
  };
}
function checkStatus(check: Check): PullRequestCheck["status"] {
  if (check.status !== "completed") return "pending";
  switch (check.conclusion) {
    case "success":
      return "success";
    case "neutral":
    case "skipped":
      return "skipped";
    case "cancelled":
      return "cancelled";
    case "failure":
    case "timed_out":
    case "action_required":
    case "startup_failure":
      return "failure";
    default:
      return "pending";
  }
}
function toCheck(check: Check): PullRequestCheck {
  return {
    name: check.name,
    status: checkStatus(check),
    url: check.html_url ?? check.details_url ?? null,
    checkRunId: check.id,
    duration: formatCheckDuration(check.started_at, check.completed_at),
    ...(check.conclusion === "action_required"
      ? { traits: ["action_required"] }
      : {}),
  };
}
async function get(ctx: RepositoryConnection, number: number): Promise<Pull> {
  return ctx.http.request({
    cwd: ctx.cwd,
    path: `${root(ctx)}/pulls/${number}`,
    schema: PullSchema,
  });
}
async function checks(
  ctx: RepositoryConnection,
  pr: Pull,
): Promise<PullRequestCheck[]> {
  if (!pr.head.sha)
    throw requestError(
      "gitee",
      ctx.cwd,
      "Gitee did not return the pull request head SHA",
    );
  const result: PullRequestCheck[] = [];
  const schema = z.union([
    z.array(CheckSchema),
    z.object({
      check_runs: z.array(CheckSchema),
      total_count: z.number().optional(),
    }),
  ]);
  for await (const batch of pages(
    "gitee",
    async (page) => {
      const response = await ctx.http.request({
        cwd: ctx.cwd,
        path: `${root(ctx)}/commits/${encodeURIComponent(
          pr.head.sha!,
        )}/check-runs`,
        query: { page, per_page: PAGE_SIZE, filter: "latest" },
        schema,
      });
      return Array.isArray(response) ? response : response.check_runs;
    },
    (check) => String(check.id),
  ))
    result.push(...batch.map(toCheck));
  return result;
}
function status(
  pr: Pull,
  ctx: RepositoryConnection,
  checks: PullRequestCheck[],
): CurrentPullRequestStatus {
  const open = pr.state === "open" && !merged(pr);
  return {
    ...summary(pr, ctx),
    repoOwner: ctx.projectPath.split("/")[0],
    repoName: ctx.projectPath.split("/")[1],
    isMerged: merged(pr),
    isDraft: pr.draft === true,
    mergeable:
      pr.mergeable === true
        ? "MERGEABLE"
        : pr.mergeable === false
          ? "CONFLICTING"
          : "UNKNOWN",
    checks,
    checksStatus: computeChecksStatus(checks),
    reviewDecision: pr.assignees?.length
      ? pr.assignees.every((r) => r.accept === true)
        ? "approved"
        : "pending"
      : null,
    forgeSpecific: {
      forge: "forge-gitee",
      ready:
        open &&
        !pr.draft &&
        pr.can_merge_check === true &&
        pr.mergeable === true &&
        checks.every((c) => c.status === "success" || c.status === "skipped"),
      allowedMethods: ["merge", "squash", "rebase"],
    },
  };
}

export function createGiteeService(deps: Dependencies) {
  const context = (cwd: string) => repositoryConnection("gitee", cwd, deps);
  return completeService("gitee", deps, {
    async listPullRequests(input) {
      const ctx = await context(input.cwd);
      const number = numberQuery(input.query);
      if (number) return [summary(await get(ctx, number), ctx)];
      const result: PullRequestSummary[] = [];
      const query = input.query?.trim().toLowerCase() ?? "";
      for await (const batch of pages(
        "gitee",
        (page) =>
          ctx.http.request({
            cwd: ctx.cwd,
            path: `${root(ctx)}/pulls`,
            query: {
              state: "open",
              sort: "updated",
              direction: "desc",
              page,
              per_page: PAGE_SIZE,
            },
            schema: z.array(PullSchema),
          }),
        (pr) => String(pr.number),
      )) {
        result.push(
          ...batch
            .filter(
              (pr) =>
                !query ||
                `${pr.title} ${pr.body ?? ""}`.toLowerCase().includes(query),
            )
            .map((pr) => summary(pr, ctx)),
        );
        if (result.length >= limitOf(input.limit)) break;
      }
      return result.slice(0, limitOf(input.limit));
    },
    async getPullRequest(input) {
      const ctx = await context(input.cwd);
      return summary(await get(ctx, input.number), ctx);
    },
    async getCurrentPullRequestStatus(input) {
      const ctx = await context(input.cwd);
      // Open requests survive local unpushed commits. Terminal requests require
      // the exact recorded source SHA, since branch names can be reused.
      for (const state of ["open", "all"]) {
        if (state === "all" && !input.headSha) break;
        for await (const batch of pages(
          "gitee",
          (page) =>
            ctx.http.request({
              cwd: ctx.cwd,
              path: `${root(ctx)}/pulls`,
              query: {
                state,
                head: input.headRef,
                sort: "updated",
                direction: "desc",
                page,
                per_page: PAGE_SIZE,
              },
              schema: z.array(PullSchema),
            }),
          (pr) => String(pr.number),
        )) {
          for (const candidate of batch) {
            if (
              candidate.head.ref !== input.headRef ||
              !matchesSource(candidate, input.headRepositoryOwner)
            )
              continue;
            const pr = await get(ctx, candidate.number);
            if (
              pr.head.ref !== input.headRef ||
              !matchesSource(pr, input.headRepositoryOwner)
            )
              continue;
            const open = pr.state === "open" && !merged(pr);
            if (!open && (!input.headSha || pr.head.sha !== input.headSha))
              continue;
            return status(pr, ctx, await checks(ctx, pr));
          }
        }
      }
      return null;
    },
    async getPullRequestCheckoutTarget(input) {
      const ctx = await context(input.cwd),
        pr = await get(ctx, input.number);
      if (!pr.head.repo || !pr.base.repo)
        throw requestError(
          "gitee",
          ctx.cwd,
          "The source or target repository was deleted",
        );
      return checkoutTarget({
        number: pr.number,
        base: pr.base.ref,
        head: pr.head.ref,
        cross: pr.head.repo.id !== pr.base.repo.id,
        ssh: pr.head.repo.ssh_url ?? null,
        https: pr.head.repo.clone_url ?? pr.head.repo.html_url ?? null,
        useHttps:
          ctx.remote.transport === "https" || ctx.remote.transport === "http",
        owner:
          pr.head.repo.id !== pr.base.repo.id ? pr.head.repo.full_name : null,
      });
    },
    async getPullRequestTimeline(input) {
      const identity = {
        prNumber: input.prNumber,
        repoOwner: input.repoOwner,
        repoName: input.repoName,
      };
      const items: PullRequestTimelineItemArray = [];
      try {
        const ctx = await context(input.cwd);
        for await (const batch of pages(
          "gitee",
          (page) =>
            ctx.http.request({
              cwd: ctx.cwd,
              path: `${root(ctx)}/pulls/${input.prNumber}/comments`,
              query: { page, per_page: PAGE_SIZE, direction: "asc" },
              schema: z.array(CommentSchema),
            }),
          (c) => String(c.id),
        )) {
          items.push(
            ...batch.map((c) => ({
              kind: "comment" as const,
              id: `comment:${c.id}`,
              body: c.body ?? "",
              author: c.user?.name ?? c.user?.login ?? "",
              authorUrl: c.user?.html_url ?? null,
              avatarUrl: c.user?.avatar_url ?? null,
              createdAt: parseOptionalTime(c.created_at),
              url: c.html_url ?? "",
              ...(c.in_reply_to_id
                ? { threadId: String(c.in_reply_to_id) }
                : {}),
              ...(c.path
                ? {
                    location: {
                      path: c.path,
                      ...(Number(c.new_line) > 0
                        ? { line: Number(c.new_line) }
                        : {}),
                    },
                  }
                : {}),
            })),
          );
        }
        return sortTimeline({
          ...identity,
          items,
          truncated: false,
          error: null,
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
      const ctx = await context(input.cwd);
      if (input.checkRunId === undefined)
        throw requestError("gitee", ctx.cwd, "A checkRunId is required");
      const path = `${root(ctx)}/check-runs/${input.checkRunId}`;
      const check = await ctx.http.request({
        cwd: ctx.cwd,
        path,
        schema: CheckSchema,
      });
      const annotations: z.infer<typeof AnnotationSchema>[] = [];
      for await (const batch of pages(
        "gitee",
        (page) =>
          ctx.http.request({
            cwd: ctx.cwd,
            path: `${path}/annotations`,
            query: { page, per_page: PAGE_SIZE },
            schema: z.array(AnnotationSchema),
          }),
        (a) => JSON.stringify(a),
      ))
        annotations.push(...batch);
      return {
        checkRunId: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion ?? null,
        url: check.html_url ?? null,
        detailsUrl: check.details_url ?? null,
        output: check.output ?? null,
        annotations: annotations.map((a) => ({
          path: a.path ?? undefined,
          startLine: a.start_line,
          endLine: a.end_line,
          annotationLevel: a.annotation_level ?? undefined,
          message: a.message ?? undefined,
          title: a.title ?? undefined,
          rawDetails: a.raw_details ?? undefined,
        })),
        failedJobs: [],
        truncated: false,
      };
    },
    async createPullRequest(input) {
      const ctx = await context(input.cwd);
      const result = await ctx.http.request({
        cwd: ctx.cwd,
        path: `${root(ctx)}/pulls`,
        method: "POST",
        body: {
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body ?? "",
          prune_source_branch: false,
          close_related_issue: false,
        },
        schema: z.object({
          number: z.number().int().positive(),
          html_url: z.string().url(),
        }),
      });
      return { number: result.number, url: result.html_url };
    },
    async mergePullRequest(input) {
      const ctx = await context(input.cwd),
        pr = await get(ctx, input.prNumber);
      const current = status(pr, ctx, await checks(ctx, pr));
      if (current.forgeSpecific?.ready !== true)
        throw requestError(
          "gitee",
          ctx.cwd,
          "Gitee has not confirmed this pull request is ready to merge",
        );
      await ctx.http.send({
        cwd: ctx.cwd,
        path: `${root(ctx)}/pulls/${input.prNumber}/merge`,
        method: "PUT",
        body: {
          merge_method: input.mergeMethod,
          prune_source_branch: false,
          close_related_issue: false,
        },
      });
      if (!merged(await get(ctx, input.prNumber)))
        throw requestError(
          "gitee",
          ctx.cwd,
          "Merge was submitted, but Gitee has not confirmed completion; refresh before retrying",
        );
      return { success: true };
    },
  });
}
type PullRequestTimelineItemArray =
  import("@getpaseo/plugin/server").PullRequestTimelineItem[];
