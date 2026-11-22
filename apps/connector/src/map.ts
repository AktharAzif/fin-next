// The ingress map (ARCHITECTURE §5.3; spec 01 §7.3; [FD-13]). Host roles and fixed targets only,
// never hostnames: the hostnames come from FIN_TUNNEL_HOSTS at start. No setting can point a public
// host at `payments`, Postgres or any other private address; that needs a new, reviewed image.
// `docs` has no rule, so only the tunnel's catch-all (http_status:404) could ever answer it.

export const TUNNEL_ROLES = ["public", "admin"] as const;
export type TunnelRole = (typeof TUNNEL_ROLES)[number];

export type MappedRole = "api" | "console" | "verify" | "selfie" | "admin";

export interface MapEntry {
  readonly role: MappedRole;
  /** cloudflared matches the path but forwards it whole, so each API half mounts Hono at /api. */
  readonly path?: "^/api/";
  readonly service: string;
  /** The admin tunnel validates the Access token at the connector as well. */
  readonly access?: true;
}

export const INGRESS_MAP: Readonly<Record<TunnelRole, readonly MapEntry[]>> = Object.freeze({
  public: Object.freeze([
    { role: "api", service: "http://edge.railway.internal:8080" },
    { role: "console", path: "^/api/", service: "http://console.railway.internal:8080" },
    { role: "verify", path: "^/api/", service: "http://verify.railway.internal:8080" },
    { role: "selfie", path: "^/api/", service: "http://verify.railway.internal:8080" },
  ] as const),
  admin: Object.freeze([
    {
      role: "admin",
      path: "^/api/",
      service: "http://admin.railway.internal:8080",
      access: true,
    },
  ] as const),
});

/** The last rule of every tunnel: anything unmatched is 404, never another service. */
export const CATCH_ALL = "http_status:404";

/** The only targets a rendered configuration may name. */
export const ALLOWED_TARGETS: ReadonlySet<string> = new Set([
  ...Object.values(INGRESS_MAP).flatMap((entries) => entries.map((entry) => entry.service)),
  CATCH_ALL,
]);
