import { describe, expect, it } from "vitest";
import { createCodeupService } from "../server/codeup";
import { codeupMr, codeupRepo, harness } from "./helpers";

describe("Codeup OpenAPI", () => {
  it("uses direct REST resources, preserves nested repository paths, and creates with string repository IDs", async () => {
    const h = harness("codeup", (url, init) => {
      if (url.pathname.endsWith("/repositories/org%2Fteam%2Frepo"))
        return codeupRepo;
      expect(url.pathname).toBe(
        "/oapi/v1/codeup/organizations/org/repositories/10/changeRequests",
      );
      expect(init.method).toBe("POST");
      expect(JSON.parse(String(init.body))).toMatchObject({
        sourceProjectId: "10",
        targetProjectId: "10",
        sourceBranch: "feature",
        targetBranch: "main",
        title: "A title",
        description: "正文",
      });
      return { localId: "7", detailUrl: codeupMr.detailUrl };
    });
    await expect(
      createCodeupService(h.deps).createPullRequest({
        cwd: "/repo",
        title: "A title",
        head: "feature",
        base: "main",
        body: "正文",
      }),
    ).resolves.toEqual({ number: 7, url: codeupMr.detailUrl });
  });
  it("supports explicit Region endpoints without organizations in resource paths", async () => {
    const h = harness("codeup", (url) => {
      expect(url.pathname).not.toContain("/organizations/");
      return url.pathname.endsWith("org%2Fteam%2Frepo") ? codeupRepo : codeupMr;
    });
    h.settings.codeup.edition = "region";
    expect(
      (
        await createCodeupService(h.deps).getPullRequest({
          cwd: "/repo",
          number: 7,
        })
      ).number,
    ).toBe(7);
  });
  it("keeps an open MR attached to local unpushed commits and rejects another source repository", async () => {
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      if (url.pathname.endsWith("/changeRequests"))
        return [{ ...codeupMr, localId: 8, sourceProjectId: 20 }, codeupMr];
      expect(url.pathname).toMatch(/\/changeRequests\/7$/);
      return codeupMr;
    });
    const status = await createCodeupService(
      h.deps,
    ).getCurrentPullRequestStatus({
      cwd: "/repo",
      headRef: "feature",
      headSha: "local-unpushed",
    });
    expect(status).toMatchObject({
      number: 7,
      isMerged: false,
      checksStatus: "success",
      forgeSpecific: { ready: true },
    });
  });
  it.each(["wrong-sha", "merge-commit-sha", undefined])(
    "does not attach a terminal MR by a reused branch or merge SHA (%s)",
    async (headSha) => {
      const h = harness("codeup", (url) => {
        if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
        if (url.pathname.endsWith("/changeRequests"))
          return url.searchParams.get("state") === "opened"
            ? []
            : [{ ...codeupMr, status: "MERGED" }];
        return {
          ...codeupMr,
          status: "MERGED",
          mergedRevision: "merge-commit-sha",
        };
      });
      expect(
        await createCodeupService(h.deps).getCurrentPullRequestStatus({
          cwd: "/repo",
          headRef: "feature",
          headSha,
        }),
      ).toBeNull();
    },
  );
  it("matches terminal source patch versions when sourceCommitId is absent", async () => {
    const terminal = { ...codeupMr, status: "CLOSED", sourceCommitId: null };
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      if (url.pathname.endsWith("/changeRequests"))
        return url.searchParams.get("state") === "opened" ? [] : [terminal];
      if (url.pathname.endsWith("/diffs/patches"))
        return [
          {
            relatedMergeItemType: "MERGE_SOURCE",
            commitId: "old-sha",
            versionNo: 1,
          },
          {
            relatedMergeItemType: "MERGE_SOURCE",
            commitId: "new-sha",
            versionNo: 2,
          },
          {
            relatedMergeItemType: "MERGE_TARGET",
            commitId: "target-sha",
            versionNo: 3,
          },
        ];
      return terminal;
    });
    expect(
      await createCodeupService(h.deps).getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature",
        headSha: "new-sha",
      }),
    ).toMatchObject({ state: "closed" });
  });
  it("uses source clone URLs for fork checkout and HTTPS pushes", async () => {
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      if (url.pathname.endsWith("/repositories/20"))
        return {
          ...codeupRepo,
          id: 20,
          pathWithNamespace: "org/fork/repo",
          httpUrlToRepo: "https://codeup.aliyun.com/org/fork/repo.git",
        };
      return { ...codeupMr, sourceProjectId: 20 };
    });
    h.deps.resolveRemoteUrl = async () =>
      "https://codeup.aliyun.com/org/team/repo.git";
    expect(
      await createCodeupService(h.deps).getPullRequestCheckoutTarget({
        cwd: "/repo",
        number: 7,
      }),
    ).toMatchObject({
      isCrossRepository: true,
      preferredPushUrl: "https://codeup.aliyun.com/org/fork/repo.git",
      checkoutRefs: [
        {
          remoteUrl: "https://codeup.aliyun.com/org/fork/repo.git",
          remoteRef: "refs/heads/feature",
        },
      ],
    });
  });
  it("checks fresh merge gates even when the caller supplied stale ready facts", async () => {
    const h = harness("codeup", (url) =>
      url.pathname.endsWith("org%2Fteam%2Frepo")
        ? codeupRepo
        : { ...codeupMr, allRequirementsPass: false },
    );
    await expect(
      createCodeupService(h.deps).mergePullRequest({
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: "squash",
        status: { forgeSpecific: { forge: "forge-codeup", ready: true } },
      }),
    ).rejects.toThrow("requirements");
    expect(
      h.fetchImpl.mock.calls.every(([, init]) => init?.method === "GET"),
    ).toBe(true);
  });
  it.each(["CHECKING", "FAILED", null, undefined, "HAS_CONFLICT"])(
    "blocks both merge capability and writes for conflict state %s",
    async (conflictCheckStatus) => {
      const mr = { ...codeupMr, conflictCheckStatus };
      const h = harness("codeup", (url) => {
        if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
        return url.pathname.endsWith("/changeRequests") ? [mr] : mr;
      });
      const service = createCodeupService(h.deps);
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
      ).rejects.toThrow("requirements");
      expect(
        h.fetchImpl.mock.calls.every(([, init]) => init?.method === "GET"),
      ).toBe(true);
    },
  );
  it("honors the source repository hint persisted by cross-repository checkout", async () => {
    const fork = { ...codeupMr, sourceProjectId: 20 };
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      if (url.pathname.endsWith("/repositories/20"))
        return { ...codeupRepo, id: 20, pathWithNamespace: "org/fork/repo" };
      return url.pathname.endsWith("/changeRequests") ? [fork] : fork;
    });
    expect(
      await createCodeupService(h.deps).getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature",
        headRepositoryOwner: "org/fork/repo",
      }),
    ).toMatchObject({ number: 7, state: "open" });
  });
  it("maps merge strategy, retains the source branch, and confirms completion with a read", async () => {
    let didMerge = false;
    const h = harness("codeup", (url, init) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      if (url.pathname.endsWith("/merge")) {
        expect(JSON.parse(String(init.body))).toEqual({
          mergeType: "no-fast-forward",
          removeSourceBranch: false,
        });
        didMerge = true;
        return { result: true };
      }
      return { ...codeupMr, status: didMerge ? "MERGED" : codeupMr.status };
    });
    await expect(
      createCodeupService(h.deps).mergePullRequest({
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: "merge",
      }),
    ).resolves.toEqual({ success: true });
  });
  it("refuses a 200 merge response that did not actually merge", async () => {
    const h = harness("codeup", (url) =>
      url.pathname.endsWith("org%2Fteam%2Frepo")
        ? codeupRepo
        : url.pathname.endsWith("/merge")
          ? { result: false }
          : codeupMr,
    );
    await expect(
      createCodeupService(h.deps).mergePullRequest({
        cwd: "/repo",
        prNumber: 7,
        mergeMethod: "merge",
      }),
    ).rejects.toThrow("not confirmed completion");
  });
  it("uses perPage pagination and detects a repeated full page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      ...codeupMr,
      localId: i + 1,
    }));
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      expect(url.searchParams.get("perPage")).toBe("100");
      expect(url.searchParams.get("projectIds")).toBe("10");
      return full;
    });
    await expect(
      createCodeupService(h.deps).listPullRequests({
        cwd: "/repo",
        limit: 150,
      }),
    ).rejects.toThrow("repeated");
  });
  it("bounds each poll to three pages per state and resumes older requests", async () => {
    const pages: string[] = [];
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      const page = Number(url.searchParams.get("page"));
      const state = url.searchParams.get("state") ?? "all";
      pages.push(`${state}:${page}`);
      return Array.from({ length: 100 }, (_, i) => ({
        ...codeupMr,
        localId: (page - 1) * 100 + i + 1,
        sourceBranch: "another-branch",
      }));
    });
    const service = createCodeupService(h.deps);
    const input = { cwd: "/repo", headRef: "feature", headSha: "source-sha" };
    expect(await service.getCurrentPullRequestStatus(input)).toBeNull();
    expect(pages).toEqual([
      "opened:1",
      "opened:2",
      "opened:3",
      "all:1",
      "all:2",
      "all:3",
    ]);
    expect(h.fetchImpl).toHaveBeenCalledTimes(7);
    pages.length = 0;
    expect(await service.getCurrentPullRequestStatus(input)).toBeNull();
    expect(pages).toEqual([
      "opened:1",
      "opened:4",
      "opened:5",
      "all:1",
      "all:4",
      "all:5",
    ]);
  });
  it("eventually finds a terminal MR beyond 10000 records without failing or rescanning it", async () => {
    const old = { ...codeupMr, localId: 10001, status: "MERGED" };
    const pages: number[] = [];
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      if (url.pathname.endsWith("/changeRequests/10001")) return old;
      if (url.searchParams.get("state") === "opened") return [];
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      if (page === 101) return [old];
      return Array.from({ length: 100 }, (_, i) => ({
        ...codeupMr,
        localId: (page - 1) * 100 + i + 1,
        status: "CLOSED",
        sourceBranch: "another-branch",
      }));
    });
    const service = createCodeupService(h.deps);
    const input = { cwd: "/repo", headRef: "feature", headSha: "source-sha" };
    for (let poll = 0; poll < 49; poll++) {
      const count = pages.length;
      expect(await service.getCurrentPullRequestStatus(input)).toBeNull();
      expect(pages.length - count).toBe(3);
    }
    expect(await service.getCurrentPullRequestStatus(input)).toMatchObject({
      number: 10001,
      isMerged: true,
    });
    expect(pages.at(-1)).toBe(101);
    const count = pages.length;
    expect(await service.getCurrentPullRequestStatus(input)).toMatchObject({
      number: 10001,
    });
    expect(pages.length).toBe(count);
  });
  it("revisits earlier pages when updates move an unseen MR behind the refreshed first page", async () => {
    const old = Array.from({ length: 800 }, (_, i) => ({
      ...codeupMr,
      localId: i + 1,
      sourceBranch: "another-branch",
      status: "CLOSED",
    }));
    const target = { ...codeupMr, localId: 1151, status: "MERGED" };
    let history = old;
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      if (url.pathname.endsWith("/changeRequests/1151")) return target;
      if (url.searchParams.get("state") === "opened") return [];
      const page = Number(url.searchParams.get("page"));
      return history.slice((page - 1) * 100, page * 100);
    });
    const service = createCodeupService(h.deps);
    const input = { cwd: "/repo", headRef: "feature", headSha: "source-sha" };
    expect(await service.getCurrentPullRequestStatus(input)).toBeNull();
    const updates = Array.from({ length: 300 }, (_, i) => ({
      ...old[0],
      localId: 1001 + i,
    }));
    updates[150] = target;
    history = [...updates, ...old];
    let found: Awaited<ReturnType<typeof service.getCurrentPullRequestStatus>> =
      null;
    for (let poll = 0; poll < 10 && !found; poll++)
      found = await service.getCurrentPullRequestStatus(input);
    expect(found).toMatchObject({ number: 1151 });
  });
  it("does not mistake a shifted page after new MRs arrive for a broken pagination cursor", async () => {
    let rows = Array.from({ length: 600 }, (_, i) => ({
      ...codeupMr,
      localId: i + 1,
      sourceBranch: "another-branch",
    }));
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      const page = Number(url.searchParams.get("page"));
      return rows.slice((page - 1) * 100, page * 100);
    });
    const service = createCodeupService(h.deps);
    const input = { cwd: "/repo", headRef: "feature" };
    expect(await service.getCurrentPullRequestStatus(input)).toBeNull();
    rows = [
      ...Array.from({ length: 100 }, (_, i) => ({
        ...rows[0],
        localId: 1000 + i,
      })),
      ...rows,
    ];
    await expect(
      service.getCurrentPullRequestStatus(input),
    ).resolves.toBeNull();
  });
  it("rechecks cached MR details and prefers a newly opened MR over an old terminal match", async () => {
    let old = { ...codeupMr };
    let newRequest: typeof codeupMr | null = null;
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      if (url.pathname.endsWith("/changeRequests/7")) return old;
      if (url.pathname.endsWith("/changeRequests/8")) return newRequest;
      if (url.pathname.endsWith("/changeRequests"))
        return newRequest ? [newRequest] : [old];
      throw new Error(`Unexpected request ${url.pathname}`);
    });
    const service = createCodeupService(h.deps);
    const input = { cwd: "/repo", headRef: "feature", headSha: "source-sha" };
    expect(await service.getCurrentPullRequestStatus(input)).toMatchObject({
      number: 7,
      forgeSpecific: { ready: true },
    });
    old = { ...old, conflictCheckStatus: "CHECKING" };
    expect(
      await service.getCurrentPullRequestStatus({
        ...input,
        force: true,
        reason: "review",
      }),
    ).toMatchObject({ number: 7, forgeSpecific: { ready: false } });
    old = { ...old, status: "MERGED" };
    newRequest = { ...codeupMr, localId: 8 };
    expect(await service.getCurrentPullRequestStatus(input)).toMatchObject({
      number: 8,
      isMerged: false,
    });
  });
  it.each(["credential", "endpoint", "invalidate", "dispose"])(
    "discards lookup hints after %s changes",
    async (change) => {
      let available = true;
      let details = 0;
      const h = harness("codeup", (url) => {
        if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
        if (url.pathname.endsWith("/changeRequests"))
          return available ? [codeupMr] : [];
        details++;
        return codeupMr;
      });
      const service = createCodeupService(h.deps);
      const input = { cwd: "/repo", headRef: "feature", headSha: "source-sha" };
      expect(await service.getCurrentPullRequestStatus(input)).toMatchObject({
        number: 7,
      });
      available = false;
      if (change === "credential") {
        for (const key of h.values.keys())
          h.values.set(key, "replacement-token");
      } else if (change === "endpoint") {
        h.settings.codeup.apiBaseUrl = "https://region.example.com";
        h.deps.secrets.get = async () => "replacement-token";
      } else if (change === "invalidate")
        await service.invalidate({ cwd: "/repo" });
      else await service.dispose();
      expect(await service.getCurrentPullRequestStatus(input)).toBeNull();
      expect(details).toBe(1);
    },
  );
  it("drops a missing cached MR and discovers its replacement", async () => {
    let replaced = false;
    const h = harness("codeup", (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      if (replaced && url.pathname.endsWith("/changeRequests/7"))
        return new Response("Not found", { status: 404 });
      const mr = { ...codeupMr, localId: replaced ? 8 : 7 };
      return url.pathname.endsWith("/changeRequests") ? [mr] : mr;
    });
    const service = createCodeupService(h.deps);
    const input = { cwd: "/repo", headRef: "feature" };
    expect(await service.getCurrentPullRequestStatus(input)).toMatchObject({
      number: 7,
    });
    replaced = true;
    expect(await service.getCurrentPullRequestStatus(input)).toMatchObject({
      number: 8,
    });
  });
  it("coalesces concurrent discovery for the same branch", async () => {
    let lists = 0;
    const h = harness("codeup", async (url) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      lists++;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return [];
    });
    const service = createCodeupService(h.deps);
    const input = { cwd: "/repo", headRef: "feature", headSha: "source-sha" };
    expect(
      await Promise.all([
        service.getCurrentPullRequestStatus(input),
        service.getCurrentPullRequestStatus(input),
      ]),
    ).toEqual([null, null]);
    expect(lists).toBe(2);
  });
  it("still detects a server ignoring the page number during bounded discovery", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({
      ...codeupMr,
      localId: i + 1,
      sourceBranch: "another-branch",
    }));
    const h = harness("codeup", (url) =>
      url.pathname.endsWith("org%2Fteam%2Frepo") ? codeupRepo : full,
    );
    await expect(
      createCodeupService(h.deps).getCurrentPullRequestStatus({
        cwd: "/repo",
        headRef: "feature",
        headSha: "source-sha",
      }),
    ).rejects.toThrow("repeated");
    expect(h.fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("loads resolved and unresolved inline/global comments, replies and reviews without duplicates", async () => {
    const h = harness("codeup", (url, init) => {
      if (url.pathname.endsWith("org%2Fteam%2Frepo")) return codeupRepo;
      if (!url.pathname.endsWith("/comments/list")) return codeupMr;
      expect(init.method).toBe("POST");
      return [
        {
          comment_biz_id: "c1",
          content: "Comment",
          comment_time: "2026-09-16T00:00:00Z",
          state: "OPENED",
          child_comments_list: [
            {
              comment_biz_id: "c2",
              content: "Reply",
              state: "OPENED",
              filePath: "a.ts",
              line_number: "8",
            },
            { comment_biz_id: "c3", state: "DRAFT", content: "draft" },
          ],
        },
      ];
    });
    const timeline = await createCodeupService(h.deps).getPullRequestTimeline({
      cwd: "/repo",
      prNumber: 7,
      repoOwner: "org/team",
      repoName: "repo",
    });
    expect(timeline.items.map((item) => item.id).sort()).toEqual([
      "comment:c1",
      "comment:c2",
      "review:u1",
    ]);
    expect(timeline.error).toBeNull();
    expect(
      h.fetchImpl.mock.calls.filter(([url]) =>
        String(url).includes("/comments/list"),
      ),
    ).toHaveLength(4);
  });
});
