import { build } from "esbuild";
import { expect, test } from "vitest";
import * as Y from "yjs";
import { createReview, stamp } from "agentic-documents/review";

test("published review entry bundles for a browser and accepts its exported actors", async () => {
  const output = await build({ entryPoints: ["dist/review.js"], bundle: true, platform: "browser", write: false });
  expect(output.outputFiles[0].text).toContain("createReview");
  const review = createReview(new Y.Doc(), stamp({ kind: "human", name: "Ada" }));
  expect(review.threads).toEqual([]);
  review.close();
});
