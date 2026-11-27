import type { XmlElement } from "../xml/tree.js";
import { COUNTER_NAMES, type CounterName, type TallyResponseResult } from "./types.js";
import { IssueLog, segment } from "./walk.js";

const NON_NEGATIVE_INT = /^\d+$/;

// Reads a Tally <RESPONSE>. Its business outcome is separate from our upload
// status: a file can be accepted (201) while Tally reports that the operation failed.
export function parseTallyResponse(root: XmlElement, log: IssueLog): TallyResponseResult {
  const counters: Partial<Record<CounterName, string>> = {};
  const lineErrors: string[] = [];
  const seen = new Map<string, number>();

  for (const child of root.children) {
    const index = seen.get(child.name) ?? 0;
    seen.set(child.name, index + 1);
    const path = `RESPONSE/${segment(child.name, index)}`;

    if (child.name === "LINEERROR") {
      lineErrors.push(child.text);
    } else if ((COUNTER_NAMES as readonly string[]).includes(child.name)) {
      const name = child.name as CounterName;
      if (index > 0) {
        log.warn("DUPLICATE_SCALAR", `${name} appears more than once; the first value was used.`, `RESPONSE/${name}[${index}]`);
        continue;
      }
      counters[name] = child.text;
      if (!NON_NEGATIVE_INT.test(child.text.trim())) {
        log.warn("COUNTER_NOT_NUMERIC", `${name} is not a whole number: "${child.text.slice(0, 50)}".`, path);
      }
    } else {
      log.warn(
        "UNKNOWN_NODE_NOT_NORMALIZED",
        `${child.name} is not part of the normalized response; it is kept in the raw upload only.`,
        path,
      );
    }
  }

  return {
    businessStatus: isFailure(counters.ERRORS, lineErrors) ? "failed" : "succeeded",
    counters,
    lineError: lineErrors[0] ?? null,
    lineErrors,
  };
}

// Failed when ERRORS > 0 or any LINEERROR has text. An ERRORS value we can't read
// also counts as failed: we never report success we couldn't confirm.
function isFailure(errors: string | undefined, lineErrors: string[]): boolean {
  if (lineErrors.some((e) => e.trim() !== "")) return true;
  if (errors === undefined) return false;
  const trimmed = errors.trim();
  if (!NON_NEGATIVE_INT.test(trimmed)) return true;
  return BigInt(trimmed) > 0n; // BigInt: no precision loss on huge counts
}
