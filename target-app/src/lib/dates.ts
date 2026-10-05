const dateFormatter = new Intl.DateTimeFormat("fi-FI", { day: "numeric", month: "short", year: "numeric" });

/** Formats an ISO timestamp as a short Finnish date. */
export function formatDate(iso: string): string {
  return dateFormatter.format(new Date(iso));
}
