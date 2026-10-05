import { existsSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { build, type Plugin } from "esbuild";
import pixelmatch from "pixelmatch";
import { type Browser, chromium } from "playwright-core";
import { PNG } from "pngjs";
import { REPO_ROOT } from "../config";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rendered element with a content-derived identity, so the same element can be found before and after a diff. */
export interface RenderedElement {
  key: string;
  description: string;
  rect: Rect;
}

export interface Rendering {
  png: Buffer;
  image: PNG;
  elements: RenderedElement[];
  errors: string[];
}

export class BrowserUnavailableError extends Error {}

/** Launches headless Chrome via playwright-core: installed Google Chrome first, then CHROME_PATH. */
export async function launchBrowser(): Promise<Browser> {
  const failures: string[] = [];
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch (error) {
    failures.push(error instanceof Error ? (error.message.split("\n")[0] ?? "chrome") : "chrome");
  }
  const executablePath = process.env.CHROME_PATH;
  if (executablePath) {
    try {
      return await chromium.launch({ executablePath, headless: true });
    } catch (error) {
      failures.push(error instanceof Error ? (error.message.split("\n")[0] ?? "CHROME_PATH") : "CHROME_PATH");
    }
  }
  throw new BrowserUnavailableError(`no Chrome found (${failures.join("; ")}). Install Chrome or set CHROME_PATH.`);
}

/** Every `*.fixture.tsx` under the repo's src, as repo-relative paths. */
export function findFixtures(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && entry.name !== "node_modules") {
        walk(full);
      } else if (entry.name.endsWith(".fixture.tsx")) {
        out.push(relative(root, full).split("\\").join("/"));
      }
    }
  };
  const src = join(root, "src");
  if (existsSync(src)) {
    walk(src);
  }
  return out.sort();
}

/** Stable file name for a fixture's committed baseline. */
export function baselineName(fixture: string): string {
  return `${fixture
    .replace(/\.fixture\.tsx$/, "")
    .split("/")
    .join("__")}.png`;
}

const LOADERS: Record<string, "ts" | "tsx" | "js" | "jsx"> = { ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx" };

/** esbuild plugin that serves post-diff file contents from memory, so the diff never touches the working tree. */
function overlayPlugin(root: string, overrides: Map<string, string>): Plugin {
  const absolute = new Map([...overrides].map(([path, content]) => [resolve(root, path), content]));
  return {
    name: "diff-overlay",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^\./ }, (args) => {
        const base = resolve(args.resolveDir, args.path);
        for (const suffix of ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]) {
          if (absolute.has(`${base}${suffix}`)) {
            return { path: `${base}${suffix}` };
          }
        }
        return undefined;
      });
      pluginBuild.onLoad({ filter: /\.(tsx?|jsx?)$/ }, (args) => {
        const contents = absolute.get(args.path);
        return contents === undefined
          ? undefined
          : { contents, loader: LOADERS[extname(args.path)] ?? "tsx", resolveDir: dirname(args.path) };
      });
    },
  };
}

async function bundleFixture(root: string, fixture: string, overrides: Map<string, string>): Promise<string> {
  const entry = [
    `import Fixture from "./${fixture.replace(/\.tsx$/, "")}";`,
    `import { createElement } from "react";`,
    `import { flushSync } from "react-dom";`,
    `import { createRoot } from "react-dom/client";`,
    `const container = document.getElementById("root");`,
    `if (container) { const root = createRoot(container); flushSync(() => root.render(createElement(Fixture))); }`,
    `window.__harnessReady = true;`,
  ].join("\n");
  const result = await build({
    stdin: { contents: entry, resolveDir: root, loader: "tsx", sourcefile: "harness-entry.tsx" },
    bundle: true,
    write: false,
    format: "iife",
    jsx: "automatic",
    platform: "browser",
    nodePaths: [join(REPO_ROOT, "node_modules")],
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
    plugins: [overlayPlugin(root, overrides)],
  });
  const output = result.outputFiles[0];
  if (!output) {
    throw new Error(`esbuild produced no output for ${fixture}`);
  }
  return output.text;
}

/**
 * Renders one fixture in isolation: bundled with esbuild, mounted in a blank page with all network requests aborted,
 * screenshotted at a fixed viewport, and every identifiable element located.
 */
export async function renderFixture(
  browser: Browser,
  root: string,
  fixture: string,
  overrides: Map<string, string> = new Map(),
): Promise<Rendering> {
  const code = await bundleFixture(root, fixture, overrides);
  const context = await browser.newContext({ viewport: { width: 480, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      errors.push(message.text());
    }
  });
  await page.route("**/*", (route) => route.abort());
  await page.setContent(
    '<!doctype html><html><body style="margin:0;padding:16px;background:#f4f5f7"><div id="root"></div></body></html>',
  );
  await page.addScriptTag({ content: code });
  await page.waitForFunction(() => Reflect.get(window, "__harnessReady") === true, undefined, { timeout: 5000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const elements = await page.evaluate(() => {
    const attributes = [
      "id",
      "name",
      "type",
      "role",
      "for",
      "aria-checked",
      "aria-label",
      "placeholder",
      "data-testid",
      "inputmode",
    ];
    const interactive = new Set(["INPUT", "BUTTON", "SELECT", "TEXTAREA", "LABEL"]);
    const seen = new Map<string, number>();
    const found: { key: string; description: string; rect: { x: number; y: number; width: number; height: number } }[] =
      [];
    const container = document.getElementById("root");
    for (const element of container ? Array.from(container.querySelectorAll("*")) : []) {
      const ownText = Array.from(element.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE)
        .map((child) => (child.textContent ?? "").trim())
        .join(" ")
        .trim();
      const attrs = attributes
        .filter((name) => element.hasAttribute(name))
        .map((name) => `${name}=${element.getAttribute(name)}`);
      if (ownText === "" && attrs.length === 0 && !interactive.has(element.tagName)) {
        continue;
      }
      const box = element.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) {
        continue;
      }
      const tag = element.tagName.toLowerCase();
      const base = `${tag}|${ownText}|${attrs.join(",")}`;
      const index = seen.get(base) ?? 0;
      seen.set(base, index + 1);
      found.push({
        key: `${base}#${index}`,
        description: ownText ? `<${tag}> "${ownText.slice(0, 40)}"` : `<${tag} ${attrs[0] ?? ""}>`,
        rect: {
          x: Math.round(box.x + window.scrollX),
          y: Math.round(box.y + window.scrollY),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
      });
    }
    return found;
  });
  const png = await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" });
  await context.close();
  return { png, image: PNG.sync.read(png), elements, errors };
}

function crop(image: PNG, rect: Rect): PNG {
  const x = Math.max(0, rect.x);
  const y = Math.max(0, rect.y);
  const width = Math.max(1, Math.min(rect.width, image.width - x));
  const height = Math.max(1, Math.min(rect.height, image.height - y));
  const out = new PNG({ width, height });
  for (let row = 0; row < height; row += 1) {
    const start = ((y + row) * image.width + x) * 4;
    image.data.copy(out.data, row * width * 4, start, start + width * 4);
  }
  return out;
}

export interface PixelDiff {
  sameSize: boolean;
  mismatched: number;
  ratio: number;
  sizes: string;
}

/** Pixel comparison with pixelmatch. Anti-aliasing differences are ignored by pixelmatch itself. */
export function comparePngs(a: PNG, b: PNG): PixelDiff {
  const sizes = `${a.width}x${a.height} vs ${b.width}x${b.height}`;
  if (a.width !== b.width || a.height !== b.height) {
    return { sameSize: false, mismatched: Number.POSITIVE_INFINITY, ratio: 1, sizes };
  }
  const mismatched = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: 0.1 });
  return { sameSize: true, mismatched, ratio: mismatched / (a.width * a.height), sizes };
}

/** Compares the same element in two renderings. */
export function compareElement(before: Rendering, after: Rendering, a: RenderedElement, b: RenderedElement): PixelDiff {
  return comparePngs(crop(before.image, a.rect), crop(after.image, b.rect));
}
