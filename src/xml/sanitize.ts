// Tally exports can contain characters XML 1.0 forbids (e.g. "&#4;"), which
// would make the whole file unparseable. We remove them and report each removal
// so the import can record a warning. The original bytes are kept elsewhere.

export type RemovalKind = "characterReference" | "literalCharacter";

export interface Removal {
  kind: RemovalKind;
  codePoint: number;
  /** What was removed, e.g. "&#4;" or "U+0004". */
  source: string;
  /** Where it was, as an offset in the cleaned text (used to find the owning element). */
  offset: number;
}

export interface SanitizeResult {
  text: string;
  removals: Removal[];
}

// Control chars, U+FFFE/U+FFFF and unpaired surrogates.
const LITERAL_ILLEGAL =
  "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]" +
  "|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])" +
  "|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]";

// Comments and CDATA are matched first so "&#4;" inside them, which is plain
// text there, is left alone.
const SCANNER = new RegExp(
  "<!--[\\s\\S]*?-->|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>|&#(?:x([0-9A-Fa-f]+)|([0-9]+));|" + LITERAL_ILLEGAL,
  "g",
);
const LITERAL_ILLEGAL_GLOBAL = new RegExp(LITERAL_ILLEGAL, "g");

// XML 1.0 "Char" production.
export function isLegalXmlCodePoint(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

export function sanitizeXmlText(input: string): SanitizeResult {
  const removals: Removal[] = [];
  let removedLength = 0; // shifts input offsets to cleaned-text offsets

  const text = input.replace(
    SCANNER,
    (match: string, hex: string | undefined, dec: string | undefined, offset: number): string => {
      const outputOffset = offset - removedLength;

      if (match.startsWith("<!--") || match.startsWith("<![CDATA[")) {
        // Keep the section, but raw control chars are illegal even here.
        const cleaned = match.replace(LITERAL_ILLEGAL_GLOBAL, (ch) => {
          removals.push(literalRemoval(ch, outputOffset));
          return "";
        });
        removedLength += match.length - cleaned.length;
        return cleaned;
      }

      if (hex !== undefined || dec !== undefined) {
        const codePoint = hex !== undefined ? parseInt(hex, 16) : parseInt(dec as string, 10);
        if (isLegalXmlCodePoint(codePoint)) return match;
        removals.push({ kind: "characterReference", codePoint, source: match, offset: outputOffset });
        removedLength += match.length;
        return "";
      }

      removals.push(literalRemoval(match, outputOffset));
      removedLength += match.length;
      return "";
    },
  );

  return { text, removals };
}

function literalRemoval(ch: string, offset: number): Removal {
  const codePoint = ch.charCodeAt(0);
  return {
    kind: "literalCharacter",
    codePoint,
    source: `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`,
    offset,
  };
}
