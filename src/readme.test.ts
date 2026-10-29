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

// The names of the root export, from `export { ... } from "./x.js"` lines. `type` names are included.
const rootNames = [...index.matchAll(/export\s*\{([^}]*)\}\s*from/g)]
  .flatMap((match) => match[1].split(","))
  .map((name) => name.trim().replace(/^type\s+/, ""))
  .filter((name) => name !== "");

describe("README covers every export", () => {
  it("reads the export lists", () => {
    expect(Object.keys(pkg.exports).length).toBeGreaterThan(5);
    expect(rootNames.length).toBeGreaterThan(20);
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
      expect(readme, `README names \`${name}\``).toContain(`\`${name}\``);
    });
  }
});
