/**
 * Structured, privacy-safe plugin logging. Only identifiers, facet transitions, counters, and
 * error codes are logged; titles, details, prompts, timeline text, and label values other than
 * IDs never appear here.
 */
export type LogLevel = "info" | "warn" | "error";

export interface TodoLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
  /** Logs once per dedupe key until `clear(key)` runs, so timers cannot flood the tail. */
  once(key: string, level: LogLevel, event: string, fields?: Record<string, unknown>): void;
  clear(key: string): void;
}

export function createTodoLogger(
  sink: { log: (line: string) => void; error: (line: string) => void } = {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  },
): TodoLogger {
  const seen = new Set<string>();
  const write = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ plugin: "todo", level, event, ...(fields ?? {}) });
    if (level === "info") sink.log(line);
    else sink.error(line);
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    once(key, level, event, fields) {
      if (seen.has(key)) return;
      seen.add(key);
      write(level, event, fields);
    },
    clear(key) {
      seen.delete(key);
    },
  };
}
