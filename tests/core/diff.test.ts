import { describe, expect, it } from "vitest";
import { filterFiles } from "../../src/core/diff.js";

describe("filterFiles allowed path boundaries", () => {
  it("matches the allowed directory but not sibling prefixes", () => {
    expect(
      filterFiles(["src/index.ts", "src-extra/index.ts", "src"], {
        allowedPaths: ["src"],
      }),
    ).toEqual(["src/index.ts", "src"]);
  });

  it("rejects paths that escape the repository", () => {
    expect(
      filterFiles(["../secret.txt", "src/index.ts"], { allowedPaths: ["src"] }),
    ).toEqual(["src/index.ts"]);
  });
});
