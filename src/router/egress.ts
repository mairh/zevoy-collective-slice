import type { DataClass } from "./router";

/** One outbound HTTP call made by the slice, recorded whether it was allowed or refused. */
export interface EgressRecord {
  at: string;
  host: string;
  path: string;
  purpose: string;
  dataClass: DataClass;
  allowed: boolean;
}

export class EgressDeniedError extends Error {}

const records: EgressRecord[] = [];
let allowList = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Replaces the egress allow-list (hostnames). Loaded from config/router.json by the router. */
export function setEgressAllowList(hosts: string[]): void {
  allowList = new Set([...hosts, ...hosts.filter((host) => host.includes(":")).map((host) => `[${host}]`)]);
}

/** Clears the in-process egress log (one log per run or test). */
export function resetEgressLog(): void {
  records.length = 0;
}

/** Every outbound call so far, allowed and refused. Answers "did anything leave?" from data, not memory. */
export function egressLog(): readonly EgressRecord[] {
  return records;
}

/**
 * The only way code in this slice reaches the network. Hosts outside the allow-list are refused before a socket
 * opens, and every attempt is logged with its purpose and data class.
 */
export async function guardedFetch(
  url: string,
  init: RequestInit,
  meta: { purpose: string; dataClass: DataClass },
): Promise<Response> {
  const parsed = new URL(url);
  const allowed = allowList.has(parsed.hostname);
  records.push({
    at: new Date().toISOString(),
    host: parsed.host,
    path: parsed.pathname,
    purpose: meta.purpose,
    dataClass: meta.dataClass,
    allowed,
  });
  if (!allowed) {
    throw new EgressDeniedError(
      `egress to ${parsed.host} refused (${meta.purpose}, ${meta.dataClass}); allow-list: ${[...allowList].join(", ")}`,
    );
  }
  // Redirects are refused: following one would reach a host the allow-list never checked.
  return fetch(url, { ...init, redirect: "error" });
}
