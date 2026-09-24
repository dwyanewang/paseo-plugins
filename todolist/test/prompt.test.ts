import { describe, expect, it } from "vitest";
import { PROMPT_MAX_BYTES, validateSeedPrompt } from "../shared/limits";
import { appendImagePaths, deriveSeedPrompt } from "../shared/prompt";

describe("Todo launch seed prompt", () => {
  it("uses an explicit non-blank default prompt", () => {
    expect(
      deriveSeedPrompt({
        title: "Update styles",
        details: "Use the new tokens",
        defaultPrompt: "Apply the design-system update.",
      }),
    ).toBe("Apply the design-system update.");
  });

  it("falls back to the title and details when the default is blank", () => {
    expect(
      deriveSeedPrompt({
        title: "  Update styles  ",
        details: "  Use the new tokens.  ",
        defaultPrompt: "   ",
      }),
    ).toBe("Update styles\n\nUse the new tokens.");
  });

  it("falls back to the title alone when details are blank", () => {
    expect(
      deriveSeedPrompt({
        title: "Update styles",
        details: "   ",
        defaultPrompt: "",
      }),
    ).toBe("Update styles");
  });

  it("rejects empty and oversized launch prompts", () => {
    expect(validateSeedPrompt(" \n ")).toEqual({ field: "seedPrompt", reason: "empty" });
    expect(validateSeedPrompt("x".repeat(PROMPT_MAX_BYTES))).toBeNull();
    expect(validateSeedPrompt("x".repeat(PROMPT_MAX_BYTES + 1))).toEqual({
      field: "seedPrompt",
      reason: "too_long",
    });
  });
});

describe("Todo image paths in a composer prompt", () => {
  it("lists each staged file after the prompt", () => {
    expect(appendImagePaths("Build the page", [{ path: "/p/img_a.png" }, { path: "/p/img_b.jpg" }])).toBe(
      "Build the page\n\nImages attached to this task (open them to view):\n- /p/img_a.png\n- /p/img_b.jpg",
    );
  });

  it("leaves the prompt alone without files", () => {
    expect(appendImagePaths("Build the page", [])).toBe("Build the page");
  });
});
