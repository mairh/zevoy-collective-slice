import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "../config";

export const DEFAULT_BREAKER_PATH = join(STATE_DIR, "breaker.json");

export type BreakerOutcome = "blocked" | "passed";

export interface BreakerState {
  surface: string;
  consecutiveBlocks: number;
  /** Open means the swarm is suspended on this surface until a named human resets it. */
  open: boolean;
  openedAt: string | null;
}

interface ResetRecord {
  surface: string;
  by: string;
  at: string;
}

interface BreakerFile {
  surfaces: Record<string, BreakerState>;
  resets: ResetRecord[];
}

function closedState(surface: string): BreakerState {
  return { surface, consecutiveBlocks: 0, open: false, openedAt: null };
}

/**
 * Repeated-failure circuit breaker, keyed by surface (e.g. `src/ui/cards/`). After `maxConsecutiveBlocks` blocked
 * diffs in a row the breaker opens and stays open: later passes do not close it, only `reset()` by a named human.
 * State is persisted as JSON so it survives process restarts.
 */
export class CircuitBreaker {
  constructor(
    private readonly path: string = DEFAULT_BREAKER_PATH,
    private readonly maxConsecutiveBlocks: number = 3,
  ) {
    if (!Number.isInteger(maxConsecutiveBlocks) || maxConsecutiveBlocks < 1) {
      throw new Error(`maxConsecutiveBlocks must be a positive integer, got ${maxConsecutiveBlocks}`);
    }
  }

  private read(): BreakerFile {
    if (!existsSync(this.path)) {
      return { surfaces: {}, resets: [] };
    }
    return JSON.parse(readFileSync(this.path, "utf8")) as BreakerFile;
  }

  private write(file: BreakerFile): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Write-then-rename so a crash mid-write never leaves a truncated file that would silently reset the breaker.
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(temp, this.path);
  }

  /** Returns the current state for a surface; unknown surfaces are closed with zero blocks. */
  state(surface: string): BreakerState {
    return this.read().surfaces[surface] ?? closedState(surface);
  }

  /** Records a gate outcome for a surface and returns the new state. */
  record(surface: string, outcome: BreakerOutcome): BreakerState {
    const file = this.read();
    const current = file.surfaces[surface] ?? closedState(surface);
    let next: BreakerState;
    if (outcome === "blocked") {
      const consecutiveBlocks = current.consecutiveBlocks + 1;
      const opens = !current.open && consecutiveBlocks >= this.maxConsecutiveBlocks;
      next = {
        surface,
        consecutiveBlocks,
        open: current.open || opens,
        openedAt: opens ? new Date().toISOString() : current.openedAt,
      };
    } else if (current.open) {
      // A pass does not close an open breaker: suspension lifts only through a human reset.
      next = current;
    } else {
      next = closedState(surface);
    }
    file.surfaces[surface] = next;
    this.write(file);
    return next;
  }

  /** Closes the breaker for a surface. `by` must name the human taking responsibility; it is kept in an audit list. */
  reset(surface: string, by: string): void {
    if (by.trim() === "") {
      throw new Error("breaker reset requires a named human (--by)");
    }
    const file = this.read();
    file.surfaces[surface] = closedState(surface);
    file.resets.push({ surface, by: by.trim(), at: new Date().toISOString() });
    this.write(file);
  }

  /** Every surface the breaker has seen, for status output. */
  all(): BreakerState[] {
    return Object.values(this.read().surfaces);
  }
}
