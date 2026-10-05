import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { Contract } from "../analysis/openapi";
import { REPO_ROOT } from "../config";
import { OLLAMA_URL, ollamaHasModel } from "../ingest/embed";
import type { RetrievedContext } from "../retrieve/resolve";
import { type ChangeSet, parseChangeSet, pathEscapesRoot } from "../workspace/changeSet";
import { buildImplementerPrompt, PROMPT_VERSION } from "./prompt";

export const DEFAULT_MODEL = process.env.ZEVOY_MODEL ?? "qwen2.5-coder:7b";

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
}

export interface ImplementerOptions {
  mode: "live" | "replay";
  root: string;
  contract: Contract;
  record?: boolean;
  model?: string;
}

interface ModelFile {
  path: string;
  content: string;
}

function recordingPaths(id: string) {
  const dir = join(REPO_ROOT, "fixtures", "recorded");
  return { patch: join(dir, `${id}.patch`), meta: join(dir, `${id}.meta.json`) };
}

function parseModelOutput(raw: string): { summary: string; files: ModelFile[] } {
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

async function generate(model: string, system: string, user: string): Promise<string> {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      stream: false,
      format: "json",
      options: { temperature: 0, seed: 7, num_ctx: 16384 },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`Ollama chat failed with ${response.status}`);
  }
  const body = (await response.json()) as { message?: { content?: string } };
  return body.message?.content ?? "";
}

/**
 * The implementer: change request plus graph-resolved context in, unified diff out. Nothing it produces is trusted;
 * the diff goes straight to the gates. Replay mode reads a committed recording and says so.
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
    return {
      changeSet: parseChangeSet(request.id, patch, options.root),
      mode: "replay",
      meta,
      summary: meta.note ?? "",
    };
  }

  const model = options.model ?? DEFAULT_MODEL;
  if (!(await ollamaHasModel(model))) {
    throw new Error(
      `Live mode needs Ollama at ${OLLAMA_URL} with ${model}. Install Ollama, then: ollama pull ${model}`,
    );
  }
  const prompt = buildImplementerPrompt(request.request, context, options.contract);
  const raw = await generate(model, prompt.system, prompt.user);
  const output = parseModelOutput(raw);
  const patch = filesToPatch(options.root, output.files);
  const meta: RecordingMeta = {
    requestId: request.id,
    provenance: "ollama",
    model,
    promptVersion: PROMPT_VERSION,
    recordedAt: new Date().toISOString(),
    note: output.summary,
  };
  if (options.record) {
    writeFileSync(paths.patch, patch);
    writeFileSync(paths.meta, `${JSON.stringify(meta, null, 2)}\n`);
  }
  return { changeSet: parseChangeSet(request.id, patch, options.root), mode: "live", meta, summary: output.summary };
}
