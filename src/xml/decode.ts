import { AppError } from "../errors.js";

export type DetectedEncoding = "UTF-8" | "UTF-16LE" | "UTF-16BE";

export interface DecodedDocument {
  /** Decoded text, BOM removed. */
  text: string;
  encoding: DetectedEncoding;
  bom: boolean;
}

// Turns uploaded bytes into text. Decoding is strict: a broken byte is rejected
// instead of becoming "�", which could silently corrupt an amount or a name.
export function decodeXmlBytes(bytes: Uint8Array): DecodedDocument {
  if (bytes.length === 0) {
    throw new AppError("EMPTY_DOCUMENT", 400, "The uploaded file is empty.");
  }

  const { encoding, bom } = detectEncoding(bytes);
  const body = bom ? bytes.subarray(encoding === "UTF-8" ? 3 : 2) : bytes;

  if (encoding !== "UTF-8" && body.length % 2 !== 0) {
    throw new AppError(
      "INVALID_ENCODING",
      400,
      `The uploaded file looks like ${encoding} but has an odd number of bytes.`,
    );
  }

  let text: string;
  try {
    // The leading BOM is already stripped; ignoreBOM keeps any later one as data.
    text = new TextDecoder(encoding.toLowerCase(), { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    throw new AppError("INVALID_ENCODING", 400, `The uploaded file is not valid ${encoding}.`);
  }

  return { text, encoding, bom };
}

// A BOM decides first; otherwise "<?" encoded as UTF-16 gives it away
// (XML 1.0 Appendix F). Anything else is treated as UTF-8.
function detectEncoding(bytes: Uint8Array): { encoding: DetectedEncoding; bom: boolean } {
  const [b0, b1, b2, b3] = bytes;
  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) return { encoding: "UTF-8", bom: true };
  if (b0 === 0xff && b1 === 0xfe) return { encoding: "UTF-16LE", bom: true };
  if (b0 === 0xfe && b1 === 0xff) return { encoding: "UTF-16BE", bom: true };
  if (b0 === 0x3c && b1 === 0x00 && b2 === 0x3f && b3 === 0x00) return { encoding: "UTF-16LE", bom: false };
  if (b0 === 0x00 && b1 === 0x3c && b2 === 0x00 && b3 === 0x3f) return { encoding: "UTF-16BE", bom: false };
  return { encoding: "UTF-8", bom: false };
}

// Does <?xml encoding="..."?> match the bytes? Used to warn, not to reject.
export function isDeclaredEncodingConsistent(
  declared: string | undefined,
  detected: DetectedEncoding,
): boolean {
  if (declared === undefined || declared === "") return true;
  const normalized = declared.trim().toUpperCase().replace(/_/g, "-");
  if (detected === "UTF-8") return normalized === "UTF-8" || normalized === "UTF8";
  return normalized === "UTF-16" || normalized === detected;
}
