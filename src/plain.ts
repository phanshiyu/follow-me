const DIGITS = "0123456789";

/**
 * Rebuilds `text` one character at a time from `alphabet`, and throws on a character outside it. What comes
 * back is made only of characters that were checked, so a port read from a file or an id sent by the server
 * cannot carry anything else into a request address or a file.
 */
export function plainText(text: string, alphabet: string): string {
  let out = "";
  for (const char of text) {
    const at = alphabet.indexOf(char);
    if (at < 0) throw new Error(`unexpected character ${JSON.stringify(char)}`);
    out += alphabet.charAt(at);
  }
  return out;
}

/** A whole number, rebuilt from its digits; throws on anything else. */
export function plainNumber(value: number): number {
  return Number(plainText(String(value), DIGITS));
}
