/** Token and latency usage for one model call, attributed to an agent and a change. */
export interface Usage {
  agent: string;
  changeId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  ms: number;
}

const usages: Usage[] = [];

/** Records one call's usage. */
export function meter(usage: Usage): void {
  usages.push(usage);
}

/** Clears the in-process usage log. */
export function resetUsage(): void {
  usages.length = 0;
}

/** Every recorded call. */
export function usageLog(): readonly Usage[] {
  return usages;
}

/** Totals per agent, for the demo summary and the audit trail. */
export function usageByAgent(): Map<string, { calls: number; tokens: number; ms: number }> {
  const totals = new Map<string, { calls: number; tokens: number; ms: number }>();
  for (const usage of usages) {
    const current = totals.get(usage.agent) ?? { calls: 0, tokens: 0, ms: 0 };
    totals.set(usage.agent, {
      calls: current.calls + 1,
      tokens: current.tokens + usage.promptTokens + usage.completionTokens,
      ms: current.ms + usage.ms,
    });
  }
  return totals;
}
