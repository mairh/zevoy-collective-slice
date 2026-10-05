import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const TARGET_ROOT = join(REPO_ROOT, "target-app");
export const OPENAPI_PATH = join(REPO_ROOT, "fixtures", "openapi.yaml");
export const STATE_DIR = join(REPO_ROOT, ".zevoy");
export const BASELINE_DIR = join(REPO_ROOT, "fixtures", "visual-baselines");

export interface AllowlistConfig {
  allow: string[];
  deny: string[];
}

export interface ForbiddenConfig {
  networkCallees: string[];
  dynamicEvaluation: string[];
  suppressionMarkers: string[];
  skipCalls: string[];
  bankingClient: { modules: string[]; allowedImporters: string[] };
  envAccess: string[];
}

export type Sensitivity = "public" | "internal" | "financial";

export interface RiskConfig {
  amountFieldPattern: string;
  moneyComponents: string[];
  moneyFormatters: string[];
  permissionCallees: string[];
  presentationalAttributes: string[];
  financialPaths: string[];
  internalPaths: string[];
  agentClearance: Sensitivity;
}

export interface SliceConfig {
  allowlist: AllowlistConfig;
  forbidden: ForbiddenConfig;
  risk: RiskConfig;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Loads the three committed config files. They are data, not code, so reviewers can audit policy without reading TypeScript. */
export function loadConfig(configDir: string = join(REPO_ROOT, "config")): SliceConfig {
  return {
    allowlist: readJson<AllowlistConfig>(join(configDir, "allowlist.json")),
    forbidden: readJson<ForbiddenConfig>(join(configDir, "forbidden.json")),
    risk: readJson<RiskConfig>(join(configDir, "risk.json")),
  };
}
