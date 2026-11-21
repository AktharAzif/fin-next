// Text from outside the engine (a pull request's paths, package names and JSON keys; a program's
// stderr) is escaped before it reaches a terminal or a CI log: every character outside printable
// ASCII becomes \uXXXX. So a newline cannot start a GitHub workflow command (a line that begins
// with `::`), an escape sequence cannot reach a terminal, and a look-alike or bidi character is
// visible.

/** The default cap for a path or a name inside a message. */
export const MAX_SHOWN_LENGTH = 512;

/**
 * `text` with every character outside printable ASCII (U+0020 to U+007E) escaped as \uXXXX, cut
 * (at a whole character) to at most `maxLength` characters.
 */
export function escapeText(text: string, maxLength: number = MAX_SHOWN_LENGTH): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    let piece: string;
    if (code >= 0x20 && code <= 0x7e) piece = ch;
    else if (code <= 0xffff) piece = `\\u${code.toString(16).padStart(4, "0")}`;
    else {
      piece = "";
      for (let i = 0; i < ch.length; i++) piece += `\\u${ch.charCodeAt(i).toString(16).padStart(4, "0")}`;
    }
    if (out.length + piece.length > maxLength) break;
    out += piece;
  }
  return out;
}

/** `text` escaped and in double quotes, for a path or a name inside a message. */
export function shownText(text: string, maxLength: number = MAX_SHOWN_LENGTH): string {
  return `"${escapeText(text, maxLength)}"`;
}
