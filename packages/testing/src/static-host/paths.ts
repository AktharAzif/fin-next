// How the zone reads a request path before it picks the static deployment or the tunnel, and how
// the tunnel then matches it (spec 01 §7.3, §7.5, §7.6; EXECUTION §2.6's S-01 (g) and (j)).
//
// The zone keeps Cloudflare's default URL normalisation for incoming URLs: routes and rules see
// the normalised path, and the origin receives the request-target as the client sent it. The
// normalisation is RFC 3986's (percent-encodings upper-cased, unreserved characters decoded, dot
// segments removed) plus Cloudflare's own two steps (backslashes become slashes, runs of slashes
// merge into one).

/** Splits an origin-form request-target into its path and its query (with the `?`, or ""). */
export function splitTarget(target: string): { path: string; query: string } {
  const hash = target.indexOf("#");
  const withoutHash = hash === -1 ? target : target.slice(0, hash);
  const mark = withoutHash.indexOf("?");
  return mark === -1
    ? { path: withoutHash, query: "" }
    : { path: withoutHash.slice(0, mark), query: withoutHash.slice(mark) };
}

const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

/** Upper-cases every percent-encoding and decodes the ones that name an unreserved character. */
export function normalisePercentEncoding(path: string): string {
  return path.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) => {
    const char = String.fromCharCode(Number.parseInt(hex, 16));
    return UNRESERVED.test(char) ? char : `%${hex.toUpperCase()}`;
  });
}

/** RFC 3986 §5.2.4, for an absolute path. */
export function removeDotSegments(path: string): string {
  const output: string[] = [];
  const segments = path.split("/").slice(1);
  for (const [index, segment] of segments.entries()) {
    const last = index === segments.length - 1;
    if (segment === ".") {
      if (last) output.push("");
    } else if (segment === "..") {
      output.pop();
      if (last) output.push("");
    } else {
      output.push(segment);
    }
  }
  return `/${output.join("/")}`;
}

/**
 * The path the zone's routes and rules see. `/x/../api/ping`, `//api/ping` and `/%61pi/ping` all
 * become `/api/ping`; `/api%2Fping` keeps its encoded slash (a reserved character is never decoded),
 * and `/API/ping` keeps its case, so neither reaches the tunnel.
 */
export function normaliseEdgePath(rawPath: string): string {
  let path = rawPath.replaceAll("\\", "/");
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  path = normalisePercentEncoding(path);
  return removeDotSegments(path);
}

/** True when the zone sends the path to the tunnel: the route `<app host>/api/*`. */
export function isApiRoute(normalisedPath: string): boolean {
  return normalisedPath.startsWith("/api/");
}

/**
 * The tunnel's own match, `path: ^/api/` (spec 01 §7.3). cloudflared receives the target as the
 * client sent it and matches its decoded path, so a request the zone sent to the tunnel only
 * because normalisation turned it into `/api/...` falls to the catch-all `http_status:404`.
 */
export function tunnelMatches(rawPath: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return false;
  }
  return /^\/api\//.test(decoded);
}

/** The zone refuses every source map path with 404 (AC-P0-23), whatever the deployment holds. */
export function isSourceMapPath(normalisedPath: string): boolean {
  return normalisedPath.endsWith(".map");
}

/**
 * The asset path a deployment looks up: each segment percent-decoded. Returns undefined when a
 * segment decodes to a character that cannot be part of a file name in the manifest (a slash, a
 * backslash or NUL), which then answers like any unknown path.
 */
export function decodeAssetPath(normalisedPath: string): string | undefined {
  const segments = normalisedPath.split("/");
  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      value = segment;
    }
    if (/[/\\\0]/.test(value)) return undefined;
    decoded.push(value);
  }
  return decoded.join("/");
}

/** The canonical, encoded form of an asset path, as a redirect's `Location` carries it. */
export function encodeAssetPath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}
