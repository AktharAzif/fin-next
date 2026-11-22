// Small text helpers that read each character at most once, never with a pattern that could
// backtrack: an unanchored `/x+$/` retries at every character of an inner run of x, quadratic in
// its length.

/**
 * `text` without the characters of `chars` at its end: one backward pass, which reads each
 * character it drops and one more.
 */
export function trimEnd(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(String.fromCharCode(text.charCodeAt(end - 1)))) end -= 1;
  return text.slice(0, end);
}
