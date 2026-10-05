import { describe, expect, it } from "vitest";
import { TARGET_ROOT } from "../src/config";
import { evaluateGolden, loadGolden } from "../src/eval/golden";
import { testEnv } from "./helpers";

describe("golden set", () => {
  it("covers every committed diff", () => {
    expect(loadGolden().length).toBeGreaterThanOrEqual(31);
  });

  it("every diff gets exactly its expected verdict, tier and failing gates", async () => {
    const env = await testEnv();
    const results = await evaluateGolden({ root: TARGET_ROOT, ...env });
    const mismatches = results
      .filter((result) => !result.ok)
      .map((result) => ({ diff: result.expected.diff, actual: result.actual }));
    expect(mismatches).toEqual([]);
  }, 240_000);
});
