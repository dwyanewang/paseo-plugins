import type { PluginSettingsDecision, PluginSettingsErrorCode } from "@getpaseo/plugin";
import type { PluginSettings, PluginSettingsState } from "@getpaseo/plugin/server";
import type { z, ZodType } from "zod";

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as object)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

function detached<Value>(value: Value): Value {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as Value);
}

/**
 * In-memory stand-in for the daemon-side settings document handle. It mirrors the core store's
 * observable contract: one serialized queue, deep-frozen detached values for mutators, `unchanged`
 * never writes, `commit` validates the whole next document, and every commit fires the change
 * callback once.
 */
export class FakeSettingsDocument<Schema extends ZodType> implements PluginSettings<Schema> {
  raw: string | null = null;
  changes = 0;
  invalidError: { code: PluginSettingsErrorCode; message: string } | null = null;
  private readonly listeners = new Set<(state: PluginSettingsState<Schema>) => void | Promise<void>>();
  private queue: Promise<unknown> = Promise.resolve();
  private revisionCounter = 0;

  constructor(private readonly schema: Schema) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(work);
    this.queue = pending.catch(() => undefined);
    return pending;
  }

  current(): z.output<Schema> {
    return this.schema.parse(this.raw === null ? {} : JSON.parse(this.raw)) as z.output<Schema>;
  }

  private revision(): string {
    return this.raw === null ? "missing" : `rev-${this.revisionCounter}`;
  }

  subscribe(listener: (state: PluginSettingsState<Schema>) => void | Promise<void>) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  read() {
    return this.serial(async () => {
      if (this.invalidError) {
        return {
          status: "invalid" as const,
          revision: this.revision(),
          error: this.invalidError.message,
          code: this.invalidError.code,
        };
      }
      return {
        status: "ready" as const,
        values: this.current(),
        revision: this.revision(),
      };
    });
  }

  update<Result>(
    mutate: (current: never) => PluginSettingsDecision<z.input<Schema>, Result>,
  ) {
    return this.serial(async () => {
      if (this.invalidError) {
        return {
          status: "invalid" as const,
          revision: this.revision(),
          error: this.invalidError.message,
          code: this.invalidError.code,
        };
      }
      const values = this.current();
      let decision: PluginSettingsDecision<z.input<Schema>, Result>;
      try {
        decision = mutate(detached(values) as never);
      } catch {
        return {
          status: "invalid" as const,
          revision: this.revision(),
          error: "mutator threw",
          code: "mutator_threw" as const,
        };
      }
      if (decision.status === "unchanged") {
        return {
          status: "unchanged" as const,
          values,
          revision: this.revision(),
          result: decision.result,
        };
      }
      const parsed = this.schema.safeParse(decision.values);
      if (!parsed.success) {
        return {
          status: "invalid" as const,
          revision: this.revision(),
          error: "next invalid",
          code: "next_invalid" as const,
        };
      }
      this.raw = JSON.stringify(parsed.data);
      this.revisionCounter += 1;
      this.changes += 1;
      const next = parsed.data as z.output<Schema>;
      for (const listener of this.listeners) {
        void listener({ status: "ready", values: next, revision: this.revision() });
      }
      return {
        status: "saved" as const,
        values: next,
        revision: this.revision(),
        result: decision.result,
      };
    });
  }
}
