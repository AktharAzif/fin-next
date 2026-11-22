// The address a person typed before a code was sent, kept in memory only for the next page (the
// code entry), never in the URL, storage or a log. A reload loses it, and the code page then asks
// for the address again (its `noAddress` state).

let pending: string | null = null;

export function rememberEmail(email: string): void {
  pending = email.trim();
}

export function pendingEmail(): string | null {
  return pending;
}

export function forgetEmail(): void {
  pending = null;
}

/** The structural check the boards' "That email address doesn't look right." answers. */
export function looksLikeEmail(value: string): boolean {
  const email = value.trim();
  if (email.length < 3 || email.length > 254) return false;
  const at = email.lastIndexOf("@");
  if (at < 1 || at !== email.indexOf("@")) return false;
  const domain = email.slice(at + 1);
  return /^[^\s@]+$/.test(email.slice(0, at)) && /^[^\s@.]+(\.[^\s@.]+)+$/.test(domain);
}
