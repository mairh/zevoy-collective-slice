import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASELINE_DIR, TARGET_ROOT } from "../config";
import { baselineName, findFixtures, launchBrowser, renderFixture } from "../visual/harness";

/** Renders every fixture from the current tree and writes the committed baselines. Run only after human review. */
const browser = await launchBrowser();
mkdirSync(BASELINE_DIR, { recursive: true });
try {
  for (const fixture of findFixtures(TARGET_ROOT)) {
    const rendering = await renderFixture(browser, TARGET_ROOT, fixture);
    if (rendering.errors.length > 0) {
      throw new Error(`${fixture} rendered with errors: ${rendering.errors.join("; ")}`);
    }
    const path = join(BASELINE_DIR, baselineName(fixture));
    writeFileSync(path, rendering.png);
    console.log(
      `baseline ${path} (${rendering.image.width}x${rendering.image.height}, ${rendering.elements.length} elements)`,
    );
  }
} finally {
  await browser.close();
}
