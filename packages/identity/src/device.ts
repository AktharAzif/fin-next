// Fin's device summary from a user agent ("Chrome on Mac"), at most 60 characters (spec 02 §5.3).
// It names passkeys, known and trusted browsers, and fills the `device` of security emails. It
// never carries the raw user agent, which is personal data (spec 08 §5.1).

const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bCriOS\/|\bChrome\//, "Chrome"],
  [/\bVersion\/[\d.]+.*Safari\//, "Safari"],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bMac OS X\b|\bMacintosh\b/, "Mac"],
  [/\bWindows\b/, "Windows"],
  [/\bLinux\b/, "Linux"],
];

export function deviceSummary(userAgent: string | null | undefined): string {
  const ua = userAgent ?? "";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1] ?? "A browser";
  const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
  const summary = system === undefined ? browser : `${browser} on ${system}`;
  return summary.slice(0, 60);
}
