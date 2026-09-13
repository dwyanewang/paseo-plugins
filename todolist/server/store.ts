import type { PluginSettingsDocument, PluginSettingsError } from "@getpaseo/plugin";
import type { TodoErrorCode } from "../shared/contracts";
import {
  CAPACITY,
  evaluateCapacity,
  measureDocumentBytes,
  type CapacityKind,
} from "../shared/limits";
import { TODO_SETTINGS_VERSION, type TodoDocument, type TodoDocumentSchema } from "../shared/schema";

export type TodoSettingsDocument = PluginSettingsDocument<typeof TodoDocumentSchema>;

export interface MutationError {
  status: TodoErrorCode;
  message: string;
  details?: Record<string, string | number | boolean>;
}

/** Outcome of one pure mutation. Mutations never write in place; the input is frozen. */
export type MutationOutcome<Result> =
  | { status: "commit"; values: TodoDocument; result: Result; kind?: CapacityKind }
  | { status: "unchanged"; result: Result }
  | MutationError;

export type MutateResult<Result> =
  | { status: "ok"; result: Result; seq: number; changed: boolean; document: TodoDocument }
  | MutationError;

export interface TodoStoreOptions {
  now?: () => string;
  generateIncarnationId: () => string;
  capacity?: typeof CAPACITY;
  onCapacityRejected?: (input: {
    tier: "soft" | "reserve" | "absolute";
    afterBytes: number;
    limitBytes: number;
  }) => void;
}

function invalidError(error: PluginSettingsError): MutationError {
  return {
    status: "document_invalid",
    message: error.message,
    details: { code: error.code },
  };
}

/**
 * Every business write goes through one serialized `document.update`. The expected incarnation is
 * checked first inside that update, `seq` advances only on a real commit, and capacity admission
 * runs on the serialized envelope before the commit is returned to the store.
 */
export class TodoStore {
  private readonly document: TodoSettingsDocument;
  private readonly now: () => string;
  private readonly generateIncarnationId: () => string;
  private readonly capacity: typeof CAPACITY;
  private readonly onCapacityRejected: TodoStoreOptions["onCapacityRejected"];

  constructor(document: TodoSettingsDocument, options: TodoStoreOptions) {
    this.document = document;
    this.now = options.now ?? (() => new Date().toISOString());
    this.generateIncarnationId = options.generateIncarnationId;
    this.capacity = options.capacity ?? CAPACITY;
    this.onCapacityRejected = options.onCapacityRejected;
  }

  /** Initializes `incarnationId` once per document generation (first creation or after reset). */
  async ensureIncarnation(): Promise<
    { status: "ok"; document: TodoDocument; initialized: boolean } | MutationError
  > {
    const next = this.generateIncarnationId();
    const updated = await this.document.update((current) => {
      if (current.incarnationId) return { status: "unchanged", result: false };
      return {
        status: "commit",
        values: { ...(current as TodoDocument), incarnationId: next, seq: current.seq + 1 },
        result: true,
      };
    });
    if (updated.status === "invalid") return invalidError(updated.error);
    return { status: "ok", document: updated.snapshot.values, initialized: updated.result };
  }

  async read(): Promise<{ status: "ok"; document: TodoDocument } | MutationError> {
    const result = await this.document.read();
    if (result.status === "invalid") return invalidError(result.error);
    return { status: "ok", document: result.snapshot.values };
  }

  async mutate<Result>(input: {
    expectedIncarnationId: string | null;
    kind: CapacityKind;
    mutate: (document: TodoDocument, now: string) => MutationOutcome<Result>;
  }): Promise<MutateResult<Result>> {
    const now = this.now();
    const updated = await this.document.update<MutateResult<Result> | MutationError>(
      (current) => {
        const document = current as TodoDocument;
        if (input.expectedIncarnationId !== null) {
          if (!document.incarnationId) {
            return {
              status: "unchanged",
              result: {
                status: "stale_document",
                message: "The Todo document is not initialized yet. Reload and try again.",
              },
            };
          }
          if (document.incarnationId !== input.expectedIncarnationId) {
            return {
              status: "unchanged",
              result: {
                status: "stale_document",
                message: "The Todo document was reset. Reload before continuing.",
              },
            };
          }
        }
        const outcome = input.mutate(document, now);
        if (outcome.status === "unchanged") {
          return {
            status: "unchanged",
            result: {
              status: "ok",
              result: outcome.result,
              seq: document.seq,
              changed: false,
              document,
            },
          };
        }
        if (outcome.status !== "commit") {
          return { status: "unchanged", result: outcome };
        }
        const values: TodoDocument = { ...outcome.values, seq: document.seq + 1 };
        const decision = evaluateCapacity({
          beforeBytes: measureDocumentBytes(document, TODO_SETTINGS_VERSION),
          afterBytes: measureDocumentBytes(values, TODO_SETTINGS_VERSION),
          kind: outcome.kind ?? input.kind,
          limits: this.capacity,
        });
        if (!decision.allowed) {
          const tier = decision.tier ?? "absolute";
          const limitBytes = decision.limitBytes ?? this.capacity.absoluteLimitBytes;
          this.onCapacityRejected?.({ tier, afterBytes: decision.afterBytes, limitBytes });
          return {
            status: "unchanged",
            result: {
              status: "capacity_exceeded",
              message:
                tier === "absolute"
                  ? "The Todo document is above its absolute size limit. Purge archived items to continue."
                  : tier === "reserve"
                    ? "The Todo recovery reserve is exhausted. Purge archived items to continue."
                    : "The Todo document reached its size limit. Archive and purge items before adding more.",
              details: { tier, afterBytes: decision.afterBytes, limitBytes },
            },
          };
        }
        return {
          status: "commit",
          values,
          result: {
            status: "ok",
            result: outcome.result,
            seq: values.seq,
            changed: true,
            document: values,
          },
        };
      },
    );
    if (updated.status === "invalid") return invalidError(updated.error);
    return updated.result;
  }
}
