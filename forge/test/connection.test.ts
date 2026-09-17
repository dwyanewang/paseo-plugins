import { describe, expect, it } from "vitest";
import { ForgeAuthenticationError } from "@getpaseo/plugin/server";
import {
  authenticate,
  probeHost,
  repositoryConnection,
  secretKey,
} from "../server/connection";
import { ForgeSettingsSchema } from "../shared/settings";
import { harness } from "./helpers";

describe("HTTP connections", () => {
  it("uses Codeup PAT headers and refuses redirects", async () => {
    const h = harness("codeup", (url, init) => {
      expect(url.pathname).toBe("/oapi/v1/platform/user");
      expect(new Headers(init.headers).get("x-yunxiao-token")).toBe(
        "test-private-token"
      );
      expect(url.searchParams.has("access_token")).toBe(false);
      expect(init.redirect).toBe("error");
      return { id: "user" };
    });
    expect(await authenticate("codeup", h.deps)).toBe(true);
  });
  it("uses Gitee's documented access_token query parameter", async () => {
    const h = harness("gitee", (url) => {
      expect(url.pathname).toBe("/api/v5/user");
      expect(url.searchParams.get("access_token")).toBe("test-private-token");
      return { id: 12 };
    });
    expect(await authenticate("gitee", h.deps)).toBe(true);
  });
  it("has no anonymous fallback and binds tokens to the API root", async () => {
    const h = harness("gitee", () => {
      throw new Error("must not fetch");
    });
    h.settings.gitee.apiBaseUrl = "https://other.example/api/v5";
    await expect(authenticate("gitee", h.deps)).rejects.toBeInstanceOf(
      ForgeAuthenticationError
    );
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(h.values.has(secretKey("gitee", "https://gitee.com/api/v5"))).toBe(
      true
    );
  });
  it("does not probe or request credentials for an unconfigured Git host", async () => {
    const h = harness("codeup", () => {
      throw new Error("must not fetch");
    });
    h.deps.resolveRemoteUrl = async () => "git@untrusted.invalid:org/repo.git";
    expect(await probeHost("codeup", "untrusted.invalid", h.deps)).toBe(false);
    await expect(
      repositoryConnection("codeup", "/repo", h.deps)
    ).rejects.toThrow("origin host");
    expect(h.fetchImpl).not.toHaveBeenCalled();
    expect(await probeHost("codeup", "codeup.aliyun.com", h.deps)).toBe(true);
  });
  it.each([401, 403, 500])(
    "redacts echoed tokens from HTTP %s errors",
    async (status) => {
      const h = harness(
        "gitee",
        () => new Response("echo test-private-token", { status })
      );
      try {
        await authenticate("gitee", h.deps);
        throw new Error("expected rejection");
      } catch (error) {
        expect(String(error)).not.toContain("test-private-token");
        expect((error as { stderr: string }).stderr).not.toContain(
          "test-private-token"
        );
        expect((error as { kind: string }).kind).toBe(
          status < 500 ? "auth-failure" : "command-error"
        );
      }
    }
  );
  it("rejects HTML and malformed successful user responses", async () => {
    const h = harness("codeup", () => new Response("<html>Login</html>"));
    await expect(authenticate("codeup", h.deps)).rejects.toThrow("valid JSON");
  });
  it("explains Codeup user-info permission failures without hiding the API error", async () => {
    const h = harness("codeup", () => new Response(JSON.stringify({
      errorCode: "Forbidden",
      errorMessage: "Current token has no permission to api.",
    }), { status: 403 }));
    await expect(authenticate("codeup", h.deps)).rejects.toMatchObject({
      kind: "auth-failure",
      message: expect.stringContaining("Forbidden: Current token has no permission to api."),
    });
    await expect(authenticate("codeup", h.deps)).rejects.toThrow("组织管理");
  });
  it("redacts token echoes in structured auth messages and omits other fields", async () => {
    const h = harness("gitee", () => new Response(JSON.stringify({
      message: "Denied test-private-token",
      debug: "internal-only-details",
    }), { status: 403 }));
    await expect(authenticate("gitee", h.deps)).rejects.toMatchObject({
      message: "Gitee rejected the request (HTTP 403) — Denied <redacted>",
      stderr: expect.not.stringContaining("test-private-token"),
    });
  });
  it.each(["<html>Forbidden</html>", "null", "[]", "{broken"])(
    "keeps the HTTP status for unstructured auth errors: %s",
    async (body) => {
      const h = harness("codeup", () => new Response(body, { status: 403 }));
      await expect(authenticate("codeup", h.deps)).rejects.toMatchObject({
        message: "Codeup rejected the request (HTTP 403)",
      });
    },
  );
  it("validates settings without client DOM globals and rejects unsafe URLs and host overlap", () => {
    expect(ForgeSettingsSchema.parse({}).codeup.edition).toBe("central");
    for (const apiBaseUrl of [
      "http://example.com",
      "https://token@example.com",
      "https://example.com?token=x",
      "https://example.com#x",
    ]) {
      expect(
        ForgeSettingsSchema.safeParse({ gitee: { apiBaseUrl } }).success
      ).toBe(false);
    }
    expect(
      ForgeSettingsSchema.safeParse({ codeup: { hosts: ["gitee.com"] } })
        .success
    ).toBe(false);
  });
});
