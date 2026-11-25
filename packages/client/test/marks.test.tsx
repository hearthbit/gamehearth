// @vitest-environment happy-dom
import { existsSync, readFileSync } from "node:fs";
import { render } from "preact";
import { act } from "preact/test-utils";
import { describe, expect, it } from "vitest";
import { ThemeMarks } from "../src/ui/marks";

function css(name: string): string {
  const path = [`packages/client/src/styles/${name}`, `src/styles/${name}`].find((candidate) => existsSync(candidate)) as string;
  return readFileSync(path, "utf8");
}

describe("Logo mark per theme", () => {
  it("draws one flame joystick per theme with its own filter ids and without inline styles the platform's CSP would block", () => {
    const root = document.createElement("div");
    act(() => render(<ThemeMarks />, root));
    const svgs = [...root.querySelectorAll(".mark > svg")];
    expect(svgs.map((svg) => svg.getAttribute("class"))).toEqual(["mark-neon", "mark-crt", "mark-front"]);
    expect(root.querySelector(".mark")?.getAttribute("aria-hidden")).toBe("true");
    const ids = [...root.querySelectorAll("[id]")].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const reference of root.innerHTML.matchAll(/url\(#([^)]+)\)/g)) {
      expect(ids).toContain(reference[1]);
    }
    expect(root.innerHTML).not.toMatch(/style=|<style|<script|href=/);
  });

  it("shows exactly the mark of the current theme", () => {
    const screens = css("screens.css");
    expect(screens).toMatch(/\.mark > svg \{\s*display: none;/);
    for (const theme of ["neon", "crt", "front"]) {
      expect(screens).toContain(`[data-theme="${theme}"] .mark > .mark-${theme} {\n  display: block;`);
    }
  });
});
