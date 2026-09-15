import type { PluginTheme } from "@getpaseo/plugin";
import { describe, expect, it } from "vitest";
import { isDarkTheme } from "../client/styles";

const theme = (surface0: string, foreground: string) => ({ colors: { surface0, foreground } }) as unknown as PluginTheme;

describe("theme tone", () => {
  it("is dark when the text is lighter than the page", () => {
    expect(isDarkTheme(theme("#1e1e2e", "#cdd6f4"))).toBe(true);
    expect(isDarkTheme(theme("#fff", "#09090b"))).toBe(false);
  });

  it("reads rgb() colors", () => {
    expect(isDarkTheme(theme("rgb(24, 24, 27)", "rgba(250, 250, 250, 1)"))).toBe(true);
  });

  it("treats colors it cannot parse as light", () => {
    expect(isDarkTheme(theme("black", "white"))).toBe(false);
  });
});
