import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { runEntries, verifyAudit } from "../audit/log";
import { STATE_DIR } from "../config";

const path = join(STATE_DIR, "audit.jsonl");
const program = new Command().name("trail").description("Verify and replay the hash-chained audit trail");
program
  .command("verify")
  .description("recompute the hash chain")
  .action(() => {
    const result = verifyAudit(path);
    console.log(
      result.ok
        ? pc.green(`chain verified: ${result.entries} entries`)
        : pc.red(`chain BROKEN at entry #${result.brokenAt}: ${result.reason}`),
    );
    process.exitCode = result.ok ? 0 : 1;
  });
program
  .command("show <runId>")
  .description("replay every recorded event for one run")
  .action((runId: string) => {
    for (const entry of runEntries(path, runId)) {
      console.log(
        `${pc.dim(`#${entry.seq} ${entry.at}`)} ${pc.bold(entry.type)} ${JSON.stringify(entry.data).slice(0, 200)}`,
      );
    }
  });
program.parse();
