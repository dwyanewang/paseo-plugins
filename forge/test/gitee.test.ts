import { describe, expect, it } from "vitest";
import { createGiteeService } from "../server/gitee";
import { giteePr, giteeRepo, harness } from "./helpers";

describe("Gitee API v5", () => {
  it("paginates and filters title/body without an unsupported search API parameter", async () => {
    const h = harness("gitee", (url) => {
      expect(url.searchParams.has("search")).toBe(false);
      expect(url.searchParams.get("per_page")).toBe("100");
      if (url.searchParams.get("page") === "1")
        return Array.from({ length: 100 }, (_, i) => ({
          ...giteePr,
          number: i + 1,
          title: "unrelated",
        }));
      return [{ ...giteePr, number: 101, title: "needle" }];
    });
    expect(
      await createGiteeService(h.deps).listPullRequests({
        cwd: "/repo",
        query: "needle",
        limit: 1,
      }),
    ).toMatchObject([{ number: 101 }]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it("looks up an explicit PR number even if the request is closed", async () => {
    const h = harness("gitee", (url) => {
      expect(url.pathname).toBe("/api/v5/repos/acme/repo/pulls/7");
      return { ...giteePr, state: "closed" };
    });
    expect(
      await createGiteeService(h.deps).searchIssuesAndPrs({
        cwd: "/repo",
        query: "!7",
      }),
    ).toMatchObject({
      items: [
        {
          number: 7,
          kind: "change_request",
          forge: "forge-gitee",
          state: "closed",
        },
      ],
      authState: "authenticated",
    });
  });
  it("recognizes open PRs with local commits and maps checks/reviews/merge gates", async () => {
    const h = harness("gitee", (url) => {
      if (url.pathname.endsWith("/pulls")) return [giteePr];
      if (url.pathname.endsWith("/check-runs"))
        return {
          total_count: 1,
          check_runs: [
            { id: 12, name: "CI", status: "completed", conclusion: "success" },
          ],
        };
      return giteePr;
    });
    expect(
      await createGiteeService(h.deps).getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature",
        headSha: "unpushed",
      }),
    ).toMatchObject({
      number: 7,
      reviewDecision: "approved",
      checksStatus: "success",
      checks: [{ name: "CI", status: "success", checkRunId: 12 }],
      forgeSpecific: { ready: true },
    });
  });
  it.each(["unrelated", undefined])(
    "ignores old terminal requests with reused branch names (%s)",
    async (headSha) => {
      const terminal = {
        ...giteePr,
        state: "merged",
        merged_at: "2026-09-16T00:00:00Z",
      };
      const h = harness("gitee", (url) =>
        url.pathname.endsWith("/pulls")
          ? url.searchParams.get("state") === "open"
            ? []
            : [terminal]
          : terminal,
      );
      expect(
        await createGiteeService(h.deps).getCurrentPullRequestStatus({
          cwd: "/repo",
          headRef: "feature",
          headSha,
        }),
      ).toBeNull();
    },
  );
  it("requires head repository identity as well as branch name", async () => {
    const h = harness("gitee", () => [
      {
        ...giteePr,
        head: {
          ...giteePr.head,
          repo: { ...giteeRepo, id: 20, full_name: "someone/repo" },
        },
      },
    ]);
    expect(
      await createGiteeService(h.deps).getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature",
      }),
    ).toBeNull();
  });
  it.each(["open", "closed"])(
    "finds a %s PR through the old path of a transferred repository",
    async (state) => {
      // Public /repos/dromara/hutool/pulls/1461 returns these canonical repo
      // identities after a transfer, while its API URL still uses the old path.
      const repo = {
        ...giteeRepo,
        id: 164748,
        full_name: "chinabugotech/hutool",
      };
      const pr = {
        ...giteePr,
        state,
        head: { ...giteePr.head, repo },
        base: { ...giteePr.base, repo },
      };
      const h = harness("gitee", (url) => {
        if (url.pathname.endsWith("/pulls"))
          return state === "closed" && url.searchParams.get("state") === "open"
            ? []
            : [pr];
        return url.pathname.endsWith("/check-runs") ? [] : pr;
      });
      h.deps.resolveRemoteUrl = async () => "git@gitee.com:dromara/hutool.git";
      expect(
        await createGiteeService(h.deps).getCurrentPullRequestStatus({
          cwd: "/repo",
          headRef: "feature",
          headSha: "source-sha",
        }),
      ).toMatchObject({ number: 7, state });
    },
  );
  it.each(["FORK/renamed", "FORK"])(
    "matches a renamed fork with repository or owner hint %s",
    async (headRepositoryOwner) => {
      const pr = {
        ...giteePr,
        head: {
          ...giteePr.head,
          repo: { ...giteeRepo, id: 20, full_name: "fork/renamed" },
        },
      };
      const h = harness("gitee", (url) =>
        url.pathname.endsWith("/pulls")
          ? [pr]
          : url.pathname.endsWith("/check-runs")
            ? []
            : pr,
      );
      expect(
        await createGiteeService(h.deps).getCurrentPullRequestStatus({
          cwd: "/repo",
          headRef: "feature",
          headRepositoryOwner,
        }),
      ).toMatchObject({ number: 7 });
    },
  );
  it("does not mark an unknown or cancelled check as successful", async () => {
    const h = harness("gitee", (url) =>
      url.pathname.endsWith("/pulls")
        ? [giteePr]
        : url.pathname.endsWith("/check-runs")
          ? [
              { id: 1, name: "Unknown", status: "completed", conclusion: null },
              {
                id: 2,
                name: "Cancelled",
                status: "completed",
                conclusion: "cancelled",
              },
            ]
          : giteePr,
    );
    expect(
      await createGiteeService(h.deps).getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature",
      }),
    ).toMatchObject({
      checksStatus: "pending",
      forgeSpecific: { ready: false },
    });
  });
  it("returns explicit fork fetch refs and uses the current transport for pushes", async () => {
    const h = harness("gitee", () => ({
      ...giteePr,
      head: {
        ...giteePr.head,
        repo: {
          ...giteeRepo,
          id: 20,
          full_name: "fork/repo",
          clone_url: "https://gitee.com/fork/repo.git",
          ssh_url: "git@gitee.com:fork/repo.git",
        },
      },
    }));
    expect(
      await createGiteeService(h.deps).getPullRequestCheckoutTarget({
        cwd: "/repo",
        number: 7,
      }),
    ).toMatchObject({
      isCrossRepository: true,
      preferredPushUrl: "git@gitee.com:fork/repo.git",
      checkoutRefs: [
        {
          remoteUrl: "git@gitee.com:fork/repo.git",
          remoteRef: "refs/heads/feature",
        },
      ],
    });
  });
  it("rejects checkout when a source fork was deleted", async () => {
    const h = harness("gitee", () => ({
      ...giteePr,
      head: { ...giteePr.head, repo: null },
    }));
    await expect(
      createGiteeService(h.deps).getPullRequestCheckoutTarget({
        cwd: "/repo",
        number: 7,
      }),
    ).rejects.toThrow("deleted");
  });
  it("supports the public API's html_url clone address and a saved fork lookup hint", async () => {
    const fork = {
      ...giteePr,
      head: {
        ...giteePr.head,
        repo: {
          id: 20,
          full_name: "fork/renamed",
          ssh_url: "git@gitee.com:fork/renamed.git",
          html_url: "https://gitee.com/fork/renamed.git",
        },
      },
    };
    const h = harness("gitee", (url) =>
      url.pathname.endsWith("/pulls")
        ? [fork]
        : url.pathname.endsWith("/check-runs")
          ? []
          : fork,
    );
    h.deps.resolveRemoteUrl = async () => "https://gitee.com/acme/repo.git";
    const service = createGiteeService(h.deps);
    const checkout = await service.getPullRequestCheckoutTarget({
      cwd: "/repo",
      number: 7,
    });
    expect(checkout).toMatchObject({
      preferredPushUrl: "https://gitee.com/fork/renamed.git",
      headOwnerLogin: "fork/renamed",
    });
    expect(
      await service.getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature",
        headRepositoryOwner: checkout.headOwnerLogin!,
      }),
    ).toMatchObject({ number: 7 });
  });
  it("posts creation fields as JSON and does not ask to close issues or delete the branch", async () => {
    const h = harness("gitee", (url, init) => {
      expect(url.pathname).toBe("/api/v5/repos/acme/repo/pulls");
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toEqual({
        title: "Title",
        body: "Body",
        head: "feature",
        base: "main",
        prune_source_branch: false,
        close_related_issue: false,
      });
      return giteePr;
    });
    expect(
      await createGiteeService(h.deps).createPullRequest({
        cwd: "/repo",
        title: "Title",
        body: "Body",
        head: "feature",
        base: "main",
      }),
    ).toEqual({ number: 7, url: giteePr.html_url });
  });
  it("refetches merge gates, checks CI, preserves branches and confirms the merge", async () => {
    let merged = false;
    const h = harness("gitee", (url, init) => {
      if (url.pathname.endsWith("/check-runs")) return [];
      if (url.pathname.endsWith("/merge")) {
        expect(init.method).toBe("PUT");
        expect(JSON.parse(String(init.body))).toEqual({
          merge_method: "rebase",
          prune_source_branch: false,
          close_related_issue: false,
        });
        merged = true;
        return { merged: true };
      }
      return { ...giteePr, state: merged ? "merged" : "open" };
    });
    expect(
      await createGiteeService(h.deps).mergePullRequest({
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: "rebase",
      }),
    ).toEqual({ success: true });
  });
  it("never posts a merge when fresh server gates disagree with the caller", async () => {
    const h = harness("gitee", (url) =>
      url.pathname.endsWith("/check-runs")
        ? []
        : { ...giteePr, can_merge_check: false },
    );
    await expect(
      createGiteeService(h.deps).mergePullRequest({
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: "merge",
      }),
    ).rejects.toThrow("ready to merge");
    expect(
      h.fetchImpl.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });
  it.each([null, undefined, false])(
    "blocks both merge capability and writes when mergeable is %s",
    async (mergeable) => {
      const pr = { ...giteePr, mergeable };
      const h = harness("gitee", (url) =>
        url.pathname.endsWith("/pulls")
          ? [pr]
          : url.pathname.endsWith("/check-runs")
            ? []
            : pr,
      );
      const service = createGiteeService(h.deps);
      expect(
        await service.getCurrentPullRequestStatus({
          cwd: "/repo",
          headRef: "feature",
        }),
      ).toMatchObject({ forgeSpecific: { ready: false } });
      await expect(
        service.mergePullRequest({
          cwd: "/repo",
          prNumber: 7,
          mergeMethod: "merge",
        }),
      ).rejects.toThrow("ready to merge");
      expect(
        h.fetchImpl.mock.calls.every(([, init]) => init?.method === "GET"),
      ).toBe(true);
    },
  );
  it("retains partial activity and surfaces a pagination failure", async () => {
    const full = Array.from({ length: 100 }, (_, id) => ({
      id,
      body: "comment",
      path: "a.ts",
      new_line: "3",
    }));
    const h = harness("gitee", () => full);
    const timeline = await createGiteeService(h.deps).getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 7,
      repoOwner: "acme",
      repoName: "repo",
    });
    expect(timeline).toMatchObject({
      truncated: true,
      error: { kind: "unknown" },
    });
    expect(timeline.items).toHaveLength(100);
    expect(timeline.items[0]).toMatchObject({
      location: { path: "a.ts", line: 3 },
    });
  });
  it("maps paged check annotations and output", async () => {
    const h = harness("gitee", (url) =>
      url.pathname.endsWith("/annotations")
        ? [
            {
              path: "a.ts",
              start_line: 4,
              message: "failed",
              annotation_level: "failure",
            },
          ]
        : {
            id: 9,
            name: "CI",
            status: "completed",
            conclusion: "failure",
            output: { summary: "failed" },
          },
    );
    expect(
      await createGiteeService(h.deps).getCheckDetails({
        cwd: "/repo",
        checkRunId: 9,
      }),
    ).toMatchObject({
      checkRunId: 9,
      output: { summary: "failed" },
      annotations: [
        {
          path: "a.ts",
          startLine: 4,
          message: "failed",
          annotationLevel: "failure",
        },
      ],
    });
  });
  it("reports unauthenticated search instead of an empty successful result", async () => {
    const h = harness("gitee", () => []);
    h.values.clear();
    expect(
      await createGiteeService(h.deps).searchIssuesAndPrs({
        cwd: "/repo",
        query: "",
      }),
    ).toMatchObject({ featuresEnabled: false, authState: "unauthenticated" });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });
  it("does not invent numeric Gitee issue IDs or claim automatic merging", async () => {
    const h = harness("gitee", () => ({ id: 1 })),
      service = createGiteeService(h.deps);
    expect(await service.listIssues({ cwd: "/repo" })).toEqual([]);
    await expect(
      service.enablePullRequestAutoMerge({
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: "merge",
      }),
    ).rejects.toThrow("does not support");
  });
});
