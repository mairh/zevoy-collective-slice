import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Contract } from "../analysis/openapi";
import { REPO_ROOT } from "../config";
import type { RetrievedContext } from "../retrieve/resolve";
import { ollamaAvailable, ollamaChatJson } from "../router/ollama";
import { type RouteDecision, type RouterConfig, route } from "../router/router";
import { type ChangeSet, parseChangeSet, pathEscapesRoot } from "../workspace/changeSet";
import { buildImplementerPrompt, PROMPT_VERSION } from "./prompt";

export interface ChangeRequest {
  id: string;
  request: string;
}

export interface RecordingMeta {
  requestId: string;
  provenance: "hand-authored" | "ollama";
  model: string;
  promptVersion: string;
  recordedAt: string;
  note?: string;
}

export interface ImplementerResult {
  changeSet: ChangeSet;
  mode: "live" | "replay";
  meta: RecordingMeta;
  summary: string;
  /** Live: the routing decision used. Replay: the decision the router would make now (null if none can serve). */
  route: RouteDecision | null;
}

export interface ImplementerOptions {
  mode: "live" | "replay";
  root: string;
  contract: Contract;
  record?: boolean;
  router: RouterConfig;
  /** Acceptance criteria from the intent agent, passed to the model. */
  acceptance?: string[];
}

export interface ModelFile {
  path: string;
  content: string;
}

function recordingPaths(id: string) {
  const dir = join(REPO_ROOT, "fixtures", "recorded");
  return { patch: join(dir, `${id}.patch`), meta: join(dir, `${id}.meta.json`) };
}

/** Parses implementer JSON into whole-file answers. Throws on malformed JSON. */
export function parseModelOutput(raw: string): { summary: string; files: ModelFile[] } {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("implementer returned non-object JSON");
  }
  const summary = Reflect.get(parsed, "summary");
  const files = Reflect.get(parsed, "files");
  if (!Array.isArray(files)) {
    throw new Error("implementer JSON has no files array");
  }
  const valid: ModelFile[] = [];
  for (const file of files) {
    const path: unknown = typeof file === "object" && file !== null ? Reflect.get(file, "path") : undefined;
    const content: unknown = typeof file === "object" && file !== null ? Reflect.get(file, "content") : undefined;
    if (typeof path === "string" && typeof content === "string") {
      valid.push({ path: path.replace(/^\.\//, ""), content });
    }
  }
  return { summary: typeof summary === "string" ? summary : "", files: valid };
}

/** Turns whole-file answers into a unified diff against the repo. Paths that escape the root are never read. */
export function filesToPatch(root: string, files: ModelFile[]): string {
  return files
    .map((file) => {
      const absolute = join(root, file.path);
      const exists = !pathEscapesRoot(file.path) && existsSync(absolute);
      const before = exists ? readFileSync(absolute, "utf8") : "";
      return createTwoFilesPatch(
        exists ? `a/${file.path}` : "/dev/null",
        `b/${file.path}`,
        before,
        file.content,
        undefined,
        undefined,
        {
          context: 3,
        },
      );
    })
    .join("");
}

/**
 * The implementer: change request plus graph-resolved context in, unified diff out. Nothing it produces is trusted;
 * the diff goes straight to the gates. It reads raw repository source, so it is routed as proprietary-source data:
 * self-hosted tiers only. Replay mode reads a committed recording and says so.
 */
export async function implement(
  request: ChangeRequest,
  context: RetrievedContext,
  options: ImplementerOptions,
): Promise<ImplementerResult> {
  const paths = recordingPaths(request.id);
  if (options.mode === "replay") {
    if (!existsSync(paths.patch)) {
      throw new Error(`No recording for ${request.id}. Run with --live --record first.`);
    }
    const meta = JSON.parse(readFileSync(paths.meta, "utf8")) as RecordingMeta;
    const patch = readFileSync(paths.patch, "utf8");
    const decision = await route("code-generation", "proprietary-source", options.router, ollamaAvailable).catch(
      () => null,
    );
    return {
      changeSet: parseChangeSet(request.id, patch, options.root),
      mode: "replay",
      meta,
      summary: meta.note ?? "",
      route: decision,
    };
  }

  const decision = await route("code-generation", "proprietary-source", options.router, ollamaAvailable);
  const prompt = buildImplementerPrompt(request.request, context, options.contract, options.acceptance ?? []);
  const raw = await ollamaChatJson(decision.model, prompt, {
    agent: "implementer",
    changeId: request.id,
    dataClass: "proprietary-source",
    maxTokens: 6000,
  });
  const output = parseModelOutput(raw);
  const patch = filesToPatch(options.root, output.files);
  const meta: RecordingMeta = {
    requestId: request.id,
    provenance: "ollama",
    model: decision.model.model,
    promptVersion: PROMPT_VERSION,
    recordedAt: new Date().toISOString(),
    note: output.summary,
  };
  if (options.record) {
    writeFileSync(paths.patch, patch);
    writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
  }
  return {
    changeSet: parseChangeSet(request.id, patch, options.root),
    mode: "live",
    meta,
    summary: output.summary,
    route: decision,
  };
}
