import { OLLAMA_URL } from "../ingest/embed";
import { guardedFetch } from "./egress";
import { meter } from "./meter";
import type { DataClass, ModelSpec } from "./router";

/** True when the local Ollama server has this model pulled. */
export async function ollamaAvailable(model: ModelSpec): Promise<boolean> {
  if (model.provider !== "ollama") {
    return false;
  }
  try {
    const response = await guardedFetch(
      `${OLLAMA_URL}/api/tags`,
      { signal: AbortSignal.timeout(800) },
      { purpose: "model availability check", dataClass: "public" },
    );
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { models?: { name: string }[] };
    return (body.models ?? []).some((entry) => entry.name === model.model || entry.name === `${model.model}:latest`);
  } catch {
    return false;
  }
}

/** One JSON-mode chat completion against local Ollama, through the egress guard and the meter. */
export async function ollamaChatJson(
  model: ModelSpec,
  messages: { system: string; user: string },
  attribution: { agent: string; changeId: string; dataClass: DataClass; maxTokens: number },
): Promise<string> {
  const started = performance.now();
  const response = await guardedFetch(
    `${OLLAMA_URL}/api/chat`,
    {
      method: "POST",
      signal: AbortSignal.timeout(240_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: model.model,
        stream: false,
        format: "json",
        // num_predict caps runaway generation: small models in JSON mode can loop for thousands of tokens.
        options: { temperature: 0, seed: 7, num_ctx: 16384, num_predict: attribution.maxTokens },
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
      }),
    },
    { purpose: `${attribution.agent} generation`, dataClass: attribution.dataClass },
  );
  if (!response.ok) {
    throw new Error(`Ollama chat failed with ${response.status}`);
  }
  const body = (await response.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };
  meter({
    agent: attribution.agent,
    changeId: attribution.changeId,
    model: model.model,
    promptTokens: body.prompt_eval_count ?? 0,
    completionTokens: body.eval_count ?? 0,
    ms: Math.round(performance.now() - started),
  });
  return body.message?.content ?? "";
}
