// Decoding, sanitizing and parsing: the layer that turns bytes into a tree.
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { decodeXmlBytes } from "../src/xml/decode.js";
import { sanitizeXmlText } from "../src/xml/sanitize.js";
import { parseXmlTree } from "../src/xml/tree.js";

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    return err instanceof AppError ? err.code : `not AppError: ${String(err)}`;
  }
  return undefined;
};

describe("decodeXmlBytes", () => {
  it("detects UTF-16LE and UTF-16BE without a BOM from the leading '<?'", () => {
    const le = Buffer.from(`<?xml version="1.0"?><R/>`, "utf16le");
    expect(decodeXmlBytes(le)).toMatchObject({ encoding: "UTF-16LE", bom: false, text: `<?xml version="1.0"?><R/>` });
    expect(decodeXmlBytes(Buffer.from(le).swap16())).toMatchObject({ encoding: "UTF-16BE", bom: false });
  });

  it("strips the BOM from the decoded text", () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<R/>")]);
    expect(decodeXmlBytes(bytes)).toEqual({ text: "<R/>", encoding: "UTF-8", bom: true });
  });

  it("rejects invalid UTF-8 instead of replacing bytes", () => {
    expect(codeOf(() => decodeXmlBytes(Buffer.from([0x3c, 0x52, 0x3e, 0xff, 0x3c, 0x2f, 0x52, 0x3e])))).toBe("INVALID_ENCODING");
  });

  it("rejects odd-length UTF-16 and empty files", () => {
    expect(codeOf(() => decodeXmlBytes(Buffer.from([0xff, 0xfe, 0x3c, 0x00, 0x52])))).toBe("INVALID_ENCODING");
    expect(codeOf(() => decodeXmlBytes(Buffer.alloc(0)))).toBe("EMPTY_DOCUMENT");
  });
});

describe("sanitizeXmlText", () => {
  it("removes illegal numeric references but keeps legal ones", () => {
    const result = sanitizeXmlText("<R>a&#4;b&#x1F;c&#65;&#x9;</R>");
    expect(result.text).toBe("<R>abc&#65;&#x9;</R>");
    expect(result.removals.map((r) => r.source)).toEqual(["&#4;", "&#x1F;"]);
  });

  it("removes literal control characters", () => {
    const result = sanitizeXmlText("<R>a\u0004b\u0000</R>");
    expect(result.text).toBe("<R>ab</R>");
    expect(result.removals.map((r) => r.source)).toEqual(["U+0004", "U+0000"]);
  });

  it("leaves &#4; inside CDATA and comments alone (it is plain text there)", () => {
    const input = "<R><![CDATA[a&#4;b]]><!-- &#4; --></R>";
    expect(sanitizeXmlText(input)).toEqual({ text: input, removals: [] });
  });

  it("does not touch an escaped reference like &amp;#4;", () => {
    expect(sanitizeXmlText("<R>&amp;#4;</R>").removals).toEqual([]);
  });
});

describe("parseXmlTree", () => {
  it("keeps repeated siblings in order under their parent", () => {
    const { root } = parseXmlTree("<R><A>1</A><B>x</B><A>2</A></R>");
    expect(root.children.map((c) => `${c.name}=${c.text}`)).toEqual(["A=1", "B=x", "A=2"]);
  });

  it("rejects DOCTYPE, so external entities (XXE) and entity expansion never run", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY e SYSTEM "file:///etc/passwd">]><R>&e;</R>`;
    const laughs = `<!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><R>&b;</R>`;
    expect(codeOf(() => parseXmlTree(xxe))).toBe("DTD_NOT_ALLOWED");
    expect(codeOf(() => parseXmlTree(laughs))).toBe("DTD_NOT_ALLOWED");
  });

  it("rejects undefined entities and malformed XML", () => {
    expect(codeOf(() => parseXmlTree("<R>&nope;</R>"))).toBe("MALFORMED_XML");
    expect(codeOf(() => parseXmlTree("<R><A></R>"))).toBe("MALFORMED_XML");
    expect(codeOf(() => parseXmlTree("plain text"))).toBe("MALFORMED_XML");
  });

  it("caps nesting depth", () => {
    expect(codeOf(() => parseXmlTree("<a>".repeat(100) + "</a>".repeat(100)))).toBe("XML_TOO_DEEP");
  });
});
