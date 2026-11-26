import { SaxesParser } from "saxes";
import { AppError } from "../errors.js";

// One XML element. Unlike a flat { tag: value } object, repeated tags stay
// separate, in order, under the parent they appeared in. The same AMOUNT tag
// under a ledger entry and under its bill allocation never collide.
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Direct text/CDATA only, untrimmed, so values stay exactly as in the source. */
  text: string;
  /** Source range: from "<" to just past the closing ">" (end is exclusive). */
  start: number;
  end: number;
}

export interface ParsedXml {
  root: XmlElement;
  /** encoding="..." from the XML declaration, if present. */
  declaredEncoding: string | undefined;
}

export interface ParseOptions {
  maxDepth?: number;
}

// Real Tally vouchers nest ~6 levels; the cap stops hostile, deeply nested files.
const DEFAULT_MAX_DEPTH = 64;

// Safety: DOCTYPE is rejected, so DTDs, entity expansion ("billion laughs") and
// external entities (XXE) can never apply. Processing instructions are ignored.
// Namespaces are off so Tally tags like "UDF:FIELD.LIST" are just names.
export function parseXmlTree(text: string, options: ParseOptions = {}): ParsedXml {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const parser = new SaxesParser({ xmlns: false, position: true });

  const stack: XmlElement[] = [];
  let root: XmlElement | undefined;
  let declaredEncoding: string | undefined;
  let pendingStart = 0;

  parser.on("xmldecl", (decl) => {
    declaredEncoding = decl.encoding;
  });

  parser.on("doctype", () => {
    throw new AppError(
      "DTD_NOT_ALLOWED",
      400,
      "DOCTYPE declarations are not accepted; DTDs and entity declarations are disabled.",
    );
  });

  parser.on("opentagstart", (tag) => {
    // position is just past the tag name; step back over "<" + name.
    pendingStart = parser.position - tag.name.length - 1;
  });

  parser.on("opentag", (tag) => {
    if (stack.length >= maxDepth) {
      throw new AppError("XML_TOO_DEEP", 400, `XML nesting exceeds the maximum depth of ${maxDepth}.`);
    }
    const element: XmlElement = {
      name: tag.name,
      attributes: { ...(tag.attributes as Record<string, string>) },
      children: [],
      text: "",
      start: pendingStart,
      end: parser.position,
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else root = element;

    if (tag.isSelfClosing) return; // <A/> has no content, so it is never pushed
    stack.push(element);
  });

  parser.on("closetag", (tag) => {
    const top = stack[stack.length - 1];
    if (top && top.name === tag.name && !tag.isSelfClosing) {
      stack.pop();
      top.end = parser.position;
    }
  });

  parser.on("text", (value) => {
    const top = stack[stack.length - 1];
    if (top) top.text += value;
  });

  parser.on("cdata", (value) => {
    const top = stack[stack.length - 1];
    if (top) top.text += value;
  });

  try {
    parser.write(text).close();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError("MALFORMED_XML", 400, `The uploaded file is not well-formed XML: ${describe(err)}`);
  }

  if (!root) {
    throw new AppError("MALFORMED_XML", 400, "The uploaded file has no root element.");
  }
  return { root, declaredEncoding };
}

// saxes errors look like "3:7: unclosed tag"; safe to return, but capped in length.
function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}

// Finds which element a sanitizer removal happened in, so the warning can name
// the exact path (e.g. VOUCHER/NARRATION) and the voucher it belongs to.
export function locateOffset(
  root: XmlElement,
  offset: number,
): { element: XmlElement; ancestry: XmlElement[] } | undefined {
  if (offset < root.start || offset > root.end) return undefined;
  const ancestry: XmlElement[] = [root];
  let current = root;
  for (;;) {
    const next = current.children.find((c) => offset >= c.start && offset < c.end);
    if (!next) return { element: current, ancestry };
    ancestry.push(next);
    current = next;
  }
}
