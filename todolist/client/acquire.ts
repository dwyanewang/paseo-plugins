import type { z } from "zod";
import type { acquireLaunch } from "../shared/contracts";
import type { TodoError } from "../shared/contracts";
import type { Attempt, LaunchClaim } from "../shared/schema";
import type { LaunchRpcs } from "./launch";

type AcquireInput = z.input<typeof acquireLaunch.input>;

/**
 * What the acquire step ended up being, from the caller's point of view.
 *
 * `unknown` is not an error the user can act on by retrying the same button: a claim may be held
 * by an attempt this device never saw, so the surface reloads and lets the attempt card decide.
 */
export type AcquireOutcome =
  | { status: "ok"; attempt: Attempt; claim: LaunchClaim; created: boolean }
  | { status: "error"; error: TodoError }
  | { status: "unknown"; message: string };

function describe(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Acquires the claim, and resolves a lost reply instead of guessing.
 *
 * A rejected RPC does not prove the daemon left the document alone: the claim may have been
 * written and only the response lost. Acquire is keyed by `attemptId` and `requestFingerprint`, so
 * sending the identical request again is not a second launch — it either finds the attempt that
 * already landed and returns it, or creates the one that never did. Only when that second request
 * also fails to reach the daemon is the outcome genuinely unknown.
 */
export async function acquireLaunchWithRecovery(
  acquire: LaunchRpcs["acquire"],
  request: AcquireInput,
): Promise<AcquireOutcome> {
  let firstError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result = await acquire(request);
      if (result.status !== "ok") return { status: "error", error: result as unknown as TodoError };
      return { status: "ok", attempt: result.attempt, claim: result.claim, created: result.created };
    } catch (error) {
      if (attempt === 0) firstError = error;
    }
  }
  return {
    status: "unknown",
    message: describe(firstError, "Could not reach the daemon, and whether this launch was recorded is unknown."),
  };
}
