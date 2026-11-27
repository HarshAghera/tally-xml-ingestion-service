import type { XmlElement } from "../xml/tree.js";
import type { Issue } from "./types.js";

// Collects warnings/errors during one import, in the order they were found.
export class IssueLog {
  readonly issues: Issue[] = [];

  warn(code: string, message: string, path: string | null, voucherIndex: number | null = null): void {
    this.issues.push({ severity: "warning", code, message, path, voucherIndex });
  }
}

// VOUCHER and *.LIST tags repeat, so their path segment carries the sibling index.
export function segment(name: string, index: number): string {
  return name === "VOUCHER" || name.endsWith(".LIST") ? `${name}[${index}]` : name;
}

// Builds "A/B/VOUCHER[2]/X.LIST[0]/C" from a root-to-element chain.
export function pathOfAncestry(ancestry: XmlElement[]): string {
  return ancestry
    .map((el, i) => {
      const parent = ancestry[i - 1];
      if (!parent) return el.name;
      const index = parent.children.filter((c) => c.name === el.name).indexOf(el);
      return segment(el.name, index);
    })
    .join("/");
}

export function firstChild(el: XmlElement, name: string): XmlElement | undefined {
  return el.children.find((c) => c.name === name);
}

export interface ChildSpec<K extends string> {
  /** XML tag → output field, for single-value children. */
  scalars: Record<string, K>;
  /** XML tag → handler, for repeated .LIST children (called once per occurrence, in order). */
  lists?: Record<string, (child: XmlElement, path: string) => void>;
  /** Attributes that are normalized; any other attribute gets a warning. */
  attributes?: readonly string[];
}

// Reads only the DIRECT children of `el`. This is the core ownership rule: an
// AMOUNT is only ever taken from the element it sits directly under.
// Anything not in the spec is warned about, never silently dropped or guessed.
export function readChildren<K extends string>(
  el: XmlElement,
  path: string,
  spec: ChildSpec<K>,
  log: IssueLog,
  voucherIndex: number | null,
): Record<K, string | null> {
  const values = {} as Record<K, string | null>;
  for (const field of Object.values<K>(spec.scalars)) values[field] = null;

  for (const name of Object.keys(el.attributes)) {
    if (!spec.attributes?.includes(name)) {
      log.warn(
        "UNKNOWN_ATTRIBUTE_NOT_NORMALIZED",
        `Attribute ${name} is not part of the normalized contract; it is kept in the raw upload only.`,
        `${path}/@${name}`,
        voucherIndex,
      );
    }
  }

  if (el.children.length > 0 && el.text.trim() !== "") {
    log.warn(
      "UNEXPECTED_TEXT",
      "Element mixes text with child elements; the text is kept in the raw upload only.",
      path,
      voucherIndex,
    );
  }

  const seen = new Map<string, number>();
  for (const child of el.children) {
    const index = seen.get(child.name) ?? 0;
    seen.set(child.name, index + 1);
    const childPath = `${path}/${segment(child.name, index)}`;

    // Object.hasOwn: tag names are untrusted, so never match inherited keys like "constructor".
    if (Object.hasOwn(spec.scalars, child.name)) {
      if (index > 0) {
        log.warn(
          "DUPLICATE_SCALAR",
          `${child.name} appears more than once; the first value was used and the rest are kept in the raw upload only.`,
          `${path}/${child.name}[${index}]`, // index shows which repeat was skipped
          voucherIndex,
        );
        continue;
      }
      if (child.children.length > 0) {
        log.warn(
          "UNEXPECTED_CHILDREN",
          `${child.name} should hold a value but contains elements; only its direct text was used.`,
          childPath,
          voucherIndex,
        );
      }
      for (const attr of Object.keys(child.attributes)) {
        log.warn(
          "UNKNOWN_ATTRIBUTE_NOT_NORMALIZED",
          `Attribute ${attr} is not part of the normalized contract; it is kept in the raw upload only.`,
          `${childPath}/@${attr}`,
          voucherIndex,
        );
      }
      values[spec.scalars[child.name] as K] = child.text;
      continue;
    }

    if (spec.lists && Object.hasOwn(spec.lists, child.name)) {
      spec.lists[child.name]!(child, childPath);
      continue;
    }

    log.warn(
      "UNKNOWN_NODE_NOT_NORMALIZED",
      `${child.name} is not part of the normalized contract; it is kept in the raw upload only.`,
      childPath,
      voucherIndex,
    );
  }

  return values;
}
