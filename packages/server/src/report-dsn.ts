// The shape a Better Stack Errors DSN must have (ARCHITECTURE §10.5; spec 08 §7.5). SP-06 pins the
// exact shape for region `europe` (UNVERIFIED until it reports): until then a DSN is accepted only
// as https, a key, a host under betterstackdata.com and a numeric project, and any other value
// exits 78. Release builds compile this allowlist in; no setting widens it.
export const ERRORS_DSN =
  /^https:\/\/[A-Za-z0-9]{16,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+betterstackdata\.com\/[0-9]{1,12}$/;

export function isErrorsDsn(value: string): boolean {
  return ERRORS_DSN.test(value);
}
