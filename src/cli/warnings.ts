/** Silences only the node:sqlite ExperimentalWarning so demo output stays clean; every other warning still prints. */
export function quietExperimentalSqlite(): void {
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && warning.message.includes("SQLite")) {
      return;
    }
    console.warn(`${warning.name}: ${warning.message}`);
  });
}
