import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(path: string): string {
  return readFileSync([`packages/client/${path}`, path].find((candidate) => existsSync(candidate)) as string, "utf8");
}

function rule(css: string, selector: string): string {
  return new RegExp(`(?:^|\\n)${selector.replace(".", "\\.")} \\{([^}]*)\\}`).exec(css)?.[1] ?? "";
}

describe("On-screen keyboard", () => {
  it("shrinks the page on Android when the keyboard opens, so a game can lay out its input field in the rest", () => {
    const viewport = /<meta name="viewport" content="([^"]*)"/.exec(read("index.html"))?.[1];
    expect(viewport?.split(",").map((part) => part.trim())).toEqual(["width=device-width", "initial-scale=1", "viewport-fit=cover", "interactive-widget=resizes-content"]);
  });

  it("lets the game frame follow the shrinking viewport instead of a fixed height", () => {
    const css = read("src/styles/screens.css");
    expect(rule(css, ".play")).toMatch(/position: fixed;[\s\S]*inset: 0;/);
    expect(rule(css, ".stage")).toContain("flex: 1;");
    expect(rule(css, ".play") + rule(css, ".stage")).not.toContain("vh");
  });
});
