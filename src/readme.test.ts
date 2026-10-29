import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Every export has a README section. A new subpath or root export fails here until the README covers it.
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  exports: Record<string, unknown>;
};
const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The root export blocks, from `export { ... } from "./x.js"` and `export type { ... } from`.
const rootBlocks = [...index.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s*from/g)];
const rootNames = rootBlocks
  .flatMap((match) => match[1].split(","))
  .map((name) => name.trim().replace(/^type\s+/, ""))
  .filter((name) => name !== "");
const exportLines = index.match(/^export\b/gm) ?? [];

// The names are checked in the Library API section only, so a word in another section does not count.
const libraryStart = readme.indexOf("\n## Library API\n");
const libraryEnd = readme.indexOf("\n## ", libraryStart + 1);
const libraryApi = readme.slice(libraryStart, libraryEnd);

describe("README covers every export", () => {
  it("reads the export lists", () => {
    expect(Object.keys(pkg.exports).length).toBeGreaterThan(5);
    expect(rootNames.length).toBeGreaterThan(20);
    expect(libraryStart).toBeGreaterThan(0);
  });

  it("parses every export line in src/index.ts", () => {
    expect(exportLines.length).toBe(rootBlocks.length);
  });

  for (const key of Object.keys(pkg.exports)) {
    const specifier = key === "." ? pkg.name : `${pkg.name}/${key.slice(2)}`;

    it(`documents ${specifier} with an import example`, () => {
      expect(readme, `README mentions \`${specifier}\``).toContain(`\`${specifier}\``);
      const example = new RegExp(`(from|import) "${escape(specifier)}"`);
      expect(readme, `README has an import from "${specifier}"`).toMatch(example);
    });
  }

  for (const name of rootNames) {
    it(`documents the root export ${name}`, () => {
      expect(libraryApi, `README Library API names \`${name}\``).toContain(`\`${name}\``);
    });
  }
});
