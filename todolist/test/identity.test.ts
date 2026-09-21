import { describe, expect, it } from "vitest";
import { resolveDraftIdentity } from "../client/identity";

const draft = { projectId: "project-1", title: "Ship it", details: "", defaultPrompt: "" };

describe("draft identity", () => {
  it("reuses the identity while the draft is unchanged, so a retry recreates nothing", () => {
    const first = resolveDraftIdentity(null, draft);
    expect(resolveDraftIdentity(first, draft)).toBe(first);
  });

  it("takes a new identity once the draft changes, because the daemon rejects a reused ID", () => {
    const first = resolveDraftIdentity(null, draft);
    const second = resolveDraftIdentity(first, { ...draft, title: "Ship it twice" });
    expect(second.identity.id).not.toBe(first.identity.id);
    expect(second.identity.creationFingerprint).not.toBe(first.identity.creationFingerprint);
  });
});
