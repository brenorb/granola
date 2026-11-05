import { describe, expect, it } from "vitest";

// Vitest stubs CSS imports (even ?raw), so read the shipped files directly.
const nodeProcess = (globalThis as unknown as {
  process: {
    cwd(): string;
    getBuiltinModule(id: "node:fs"): { readFileSync(path: string, encoding: "utf8"): string };
  };
}).process;
const { readFileSync } = nodeProcess.getBuiltinModule("node:fs");
const css = readFileSync(`${nodeProcess.cwd()}/src/styles.css`, "utf8");
const html = readFileSync(`${nodeProcess.cwd()}/index.html`, "utf8");

function topLevelRules(source: string): Array<{ selector: string; index: number; media: string | null }> {
  const rules: Array<{ selector: string; index: number; media: string | null }> = [];
  let depth = 0;
  let media: string | null = null;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      const selector = source.slice(start, index).trim();
      if (depth === 0 && selector.startsWith("@media")) media = selector;
      else if (depth === 0 || (depth === 1 && media !== null)) {
        for (const part of selector.split(",")) rules.push({ selector: part.trim(), index, media: depth === 1 ? media : null });
      }
      depth += 1;
      start = index + 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) media = null;
      start = index + 1;
    } else if (char === ";" && depth === 0) {
      start = index + 1;
    }
  }
  return rules;
}

describe("stylesheet cascade", () => {
  it("reads the real stylesheet and its braces balance", () => {
    expect(css).toContain(".protocol-notes");
    let depth = 0;
    for (const char of css) {
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it("never lets a base rule after a max-width override cancel the mobile layout", () => {
    const rules = topLevelRules(css);
    const shadowed = rules
      .filter((rule) => rule.media?.includes("max-width"))
      .filter((override) => rules.some((base) =>
        base.media === null && base.selector === override.selector && base.index > override.index
      ))
      .map((override) => `${override.media} ${override.selector}`);
    expect(shadowed).toEqual([]);
  });
});

describe("content security policy", () => {
  it("has no inline scripts, which script-src 'self' would block", () => {
    expect(html).toContain("script-src 'self'");
    const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
    expect(inline).toEqual([]);
  });
});
