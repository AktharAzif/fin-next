// The public settings: `ops/environments/<env>.json`, the desired state `pnpm fin` applies and
// checks (ARCHITECTURE §3.1, §11.8). It names things and holds settings; every hostname, ID and
// threshold comes from the overlay at run time. Validated in full before any command reads it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "./errors.ts";
import type { HostRole } from "./overlay.ts";
import { HOST_ROLES } from "./overlay.ts";

export const ENVIRONMENTS = ["staging"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * The DMARC policy each environment's sending subdomains keep. Staging stays at `p=reject`, as
 * Cloudflare wrote the records when it onboarded the subdomains ([BD-17], spec 01 §7.8); a file
 * that says otherwise is refused, so no command can weaken them from the desired state.
 */
export const DMARC_POLICY: Readonly<Record<Environment, "none" | "quarantine" | "reject">> = {
  staging: "reject",
};

export type TunnelRole = "public" | "admin";
export type HeaderProfile = "app" | "hosted" | "selfie" | "docs";
export type RestartPolicy = "ALWAYS" | "NEVER" | "ON_FAILURE";

export interface TunnelSettings {
  name: string;
  connector: string;
  standby: string;
  hosts: HostRole[];
}

export interface StaticSettings {
  script: string;
  host: HostRole;
  app: string;
  dir: string;
  profile: HeaderProfile;
  apiRoute: boolean;
}

export interface ServiceSettings {
  image?: string;
  startCommand?: string;
  replicas: number;
  healthcheck?: string | null;
  overlapSeconds?: number;
  drainingSeconds?: number;
  restart?: RestartPolicy;
  memoryMb?: number;
  staticEgress: boolean;
  noToken?: boolean;
  task?: boolean;
  cron?: string;
  template?: boolean;
}

export interface Settings {
  environment: Environment;
  zone: {
    shared: boolean;
    settings: Record<string, unknown>;
    watchedOnly: string[];
  };
  hostRoles: { browser: HostRole[]; apiPaths: HostRole[]; api: HostRole };
  tunnels: Record<TunnelRole, TunnelSettings>;
  static: Record<string, StaticSettings>;
  staticOrder: string[];
  access: {
    application: string;
    policy: string;
    host: HostRole;
    sessionDuration: string;
    identityProvider: "onetimepin";
  };
  email: {
    subdomains: string[];
    dmarcPolicy: "none" | "quarantine" | "reject";
    token: {
      name: string;
      permissionGroup: string;
      expiryDays: number;
      service: string;
      variable: string;
    };
  };
  rules: {
    rate: {
      threshold: string;
      periodSeconds: number;
      mitigationTimeoutSeconds: number;
      pathPrefix: string;
    };
  };
  railway: {
    project: string;
    region: string;
    imageRepository: string;
    deployOrder: string[];
    connectorOrder: string[];
    sealedVariables: string[];
    services: Record<string, ServiceSettings>;
  };
}

class Checker {
  readonly problems: string[] = [];

  obj(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.problems.push(`${path} must be an object`);
      return {};
    }
    return value as Record<string, unknown>;
  }

  str(value: unknown, path: string, pattern?: RegExp): string {
    if (typeof value !== "string" || value === "") {
      this.problems.push(`${path} must be a non-empty string`);
      return "";
    }
    if (pattern !== undefined && !pattern.test(value))
      this.problems.push(`${path} has the wrong shape`);
    return value;
  }

  num(value: unknown, path: string): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      this.problems.push(`${path} must be a non-negative integer`);
      return 0;
    }
    return value;
  }

  bool(value: unknown, path: string): boolean {
    if (typeof value !== "boolean") {
      this.problems.push(`${path} must be true or false`);
      return false;
    }
    return value;
  }

  list(value: unknown, path: string): string[] {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v === "")) {
      this.problems.push(`${path} must be an array of strings`);
      return [];
    }
    return value as string[];
  }

  role(value: unknown, path: string): HostRole {
    if (typeof value !== "string" || !(HOST_ROLES as readonly string[]).includes(value)) {
      this.problems.push(`${path} must be a host role`);
      return "console";
    }
    return value as HostRole;
  }

  roles(value: unknown, path: string): HostRole[] {
    return this.list(value, path).map((v, i) => this.role(v, `${path}[${i}]`));
  }

  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
    if (typeof value !== "string" || !(options as readonly string[]).includes(value)) {
      this.problems.push(`${path} must be one of ${options.join(", ")}`);
      return options[0] as T;
    }
    return value as T;
  }
}

const OWN_NAME = (env: string) => new RegExp(`^fin-next-${env}-[a-z0-9-]+$`);
const SERVICE = /^[a-z][a-z0-9-]*$/;

export function parseSettings(raw: unknown, environment: Environment): Settings {
  const c = new Checker();
  const top = c.obj(raw, "settings");
  if (top.environment !== environment) {
    c.problems.push(`environment must be "${environment}"`);
  }
  const own = OWN_NAME(environment);

  const zone = c.obj(top.zone, "zone");
  const hostRoles = c.obj(top.hostRoles, "hostRoles");
  const tunnelsRaw = c.obj(top.tunnels, "tunnels");
  const tunnels = {} as Record<TunnelRole, TunnelSettings>;
  for (const role of ["public", "admin"] as const) {
    const t = c.obj(tunnelsRaw[role], `tunnels.${role}`);
    tunnels[role] = {
      name: c.str(t.name, `tunnels.${role}.name`, own),
      connector: c.str(t.connector, `tunnels.${role}.connector`, SERVICE),
      standby: c.str(t.standby, `tunnels.${role}.standby`, SERVICE),
      hosts: c.roles(t.hosts, `tunnels.${role}.hosts`),
    };
  }
  const staticRaw = c.obj(top.static, "static");
  const statics: Record<string, StaticSettings> = {};
  for (const [name, value] of Object.entries(staticRaw)) {
    if (!SERVICE.test(name)) {
      c.problems.push("static has a key that is not a deployment name");
      continue;
    }
    const s = c.obj(value, `static.${name}`);
    statics[name] = {
      script: c.str(s.script, `static.${name}.script`, own),
      host: c.role(s.host, `static.${name}.host`),
      app: c.str(s.app, `static.${name}.app`, SERVICE),
      dir: c.str(s.dir, `static.${name}.dir`, /^[a-z0-9/_-]+$/),
      profile: c.oneOf(s.profile, `static.${name}.profile`, ["app", "hosted", "selfie", "docs"]),
      apiRoute: c.bool(s.apiRoute, `static.${name}.apiRoute`),
    };
  }
  const access = c.obj(top.access, "access");
  const email = c.obj(top.email, "email");
  const token = c.obj(email.token, "email.token");
  const rules = c.obj(top.rules, "rules");
  const rate = c.obj(rules.rate, "rules.rate");
  const railway = c.obj(top.railway, "railway");
  const servicesRaw = c.obj(railway.services, "railway.services");
  const services: Record<string, ServiceSettings> = {};
  for (const [name, value] of Object.entries(servicesRaw)) {
    if (!SERVICE.test(name)) {
      c.problems.push("railway.services has a key that is not a service name");
      continue;
    }
    const s = c.obj(value, `railway.services.${name}`);
    const p = `railway.services.${name}`;
    const service: ServiceSettings = {
      replicas: c.num(s.replicas, `${p}.replicas`),
      staticEgress: c.bool(s.staticEgress, `${p}.staticEgress`),
    };
    if (s.template === true) service.template = true;
    else {
      service.image = c.str(s.image, `${p}.image`, /^fin-next-[a-z0-9-]+$/);
      service.healthcheck =
        s.healthcheck === null ? null : c.str(s.healthcheck, `${p}.healthcheck`, /^\/[a-z]+$/);
      service.overlapSeconds = c.num(s.overlapSeconds, `${p}.overlapSeconds`);
      service.drainingSeconds = c.num(s.drainingSeconds, `${p}.drainingSeconds`);
      service.restart = c.oneOf(s.restart, `${p}.restart`, ["ALWAYS", "NEVER", "ON_FAILURE"]);
      service.memoryMb = c.num(s.memoryMb, `${p}.memoryMb`);
      if (s.startCommand !== undefined) {
        service.startCommand = c.str(s.startCommand, `${p}.startCommand`, /^[A-Za-z0-9 ./_=-]+$/);
      }
      if (s.noToken !== undefined) service.noToken = c.bool(s.noToken, `${p}.noToken`);
      if (s.task !== undefined) service.task = c.bool(s.task, `${p}.task`);
      if (s.cron !== undefined) service.cron = c.str(s.cron, `${p}.cron`, /^[0-9*/, -]+$/);
    }
    services[name] = service;
  }

  const settings: Settings = {
    environment,
    zone: {
      shared: c.bool(zone.shared, "zone.shared"),
      settings: c.obj(zone.settings, "zone.settings"),
      watchedOnly: c.list(zone.watchedOnly, "zone.watchedOnly"),
    },
    hostRoles: {
      browser: c.roles(hostRoles.browser, "hostRoles.browser"),
      apiPaths: c.roles(hostRoles.apiPaths, "hostRoles.apiPaths"),
      api: c.role(hostRoles.api, "hostRoles.api"),
    },
    tunnels,
    static: statics,
    staticOrder: c.list(top.staticOrder, "staticOrder"),
    access: {
      application: c.str(access.application, "access.application", own),
      policy: c.str(access.policy, "access.policy", own),
      host: c.role(access.host, "access.host"),
      sessionDuration: c.str(access.sessionDuration, "access.sessionDuration", /^\d+h$/),
      identityProvider: c.oneOf(access.identityProvider, "access.identityProvider", ["onetimepin"]),
    },
    email: {
      subdomains: c.list(email.subdomains, "email.subdomains"),
      dmarcPolicy: c.oneOf(email.dmarcPolicy, "email.dmarcPolicy", [
        "none",
        "quarantine",
        "reject",
      ]),
      token: {
        name: c.str(token.name, "email.token.name", own),
        permissionGroup: c.str(token.permissionGroup, "email.token.permissionGroup"),
        expiryDays: c.num(token.expiryDays, "email.token.expiryDays"),
        service: c.str(token.service, "email.token.service", SERVICE),
        variable: c.str(token.variable, "email.token.variable", /^[A-Z][A-Z0-9_]+$/),
      },
    },
    rules: {
      rate: {
        threshold: c.str(rate.threshold, "rules.rate.threshold"),
        periodSeconds: c.num(rate.periodSeconds, "rules.rate.periodSeconds"),
        mitigationTimeoutSeconds: c.num(
          rate.mitigationTimeoutSeconds,
          "rules.rate.mitigationTimeoutSeconds",
        ),
        pathPrefix: c.str(rate.pathPrefix, "rules.rate.pathPrefix", /^\/[a-z0-9]+\/$/),
      },
    },
    railway: {
      project: c.str(railway.project, "railway.project", new RegExp(`^fin-next-${environment}$`)),
      region: c.str(railway.region, "railway.region"),
      imageRepository: c.str(
        railway.imageRepository,
        "railway.imageRepository",
        /^ghcr\.io\/[a-z0-9-]+\/$/,
      ),
      deployOrder: c.list(railway.deployOrder, "railway.deployOrder"),
      connectorOrder: c.list(railway.connectorOrder, "railway.connectorOrder"),
      sealedVariables: c.list(railway.sealedVariables, "railway.sealedVariables"),
      services,
    },
  };

  // Cross-references: every name a list uses must exist, as the map's own key (never a name every
  // object inherits, such as constructor).
  for (const name of [...settings.railway.deployOrder, ...settings.railway.connectorOrder]) {
    if (!Object.hasOwn(services, name))
      c.problems.push(`railway order names ${name}, which has no service`);
  }
  for (const t of Object.values(tunnels)) {
    for (const service of [t.connector, t.standby]) {
      if (!Object.hasOwn(services, service))
        c.problems.push(`tunnel ${t.name} names ${service}, which has no service`);
    }
  }
  for (const name of settings.staticOrder) {
    if (!Object.hasOwn(statics, name))
      c.problems.push(`staticOrder names ${name}, which has no static deployment`);
  }
  if (!Object.hasOwn(services, settings.email.token.service)) {
    c.problems.push("email.token.service names a service that does not exist");
  }
  if (settings.email.dmarcPolicy !== DMARC_POLICY[environment]) {
    c.problems.push(
      `email.dmarcPolicy must be ${DMARC_POLICY[environment]} on ${environment} ([BD-17])`,
    );
  }
  if (settings.email.token.expiryDays < 1 || settings.email.token.expiryDays > 180) {
    c.problems.push("email.token.expiryDays must be between 1 and 180");
  }
  if (
    settings.rules.rate.periodSeconds !== 10 ||
    settings.rules.rate.mitigationTimeoutSeconds !== 10
  ) {
    c.problems.push("rules.rate: the Free plan allows only a 10 s period and timeout");
  }
  if (c.problems.length > 0) {
    throw new ConfigError(
      `ops/environments/${environment}.json is invalid: ${c.problems.join("; ")}`,
    );
  }
  return settings;
}

export function isEnvironment(value: string): value is Environment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

/** Loads and validates `ops/environments/<env>.json` from the repository. */
export function loadSettings(repoRoot: string, environment: Environment): Settings {
  const file = join(repoRoot, "ops", "environments", `${environment}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ConfigError(`ops/environments/${environment}.json is missing or not valid JSON`);
  }
  return parseSettings(raw, environment);
}

/** Whether a variable name is one the settings say must be sealed (`*` matches a name part). */
export function mustBeSealed(settings: Settings, name: string): boolean {
  return settings.railway.sealedVariables.some((pattern) => {
    const re = new RegExp(
      `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[A-Z0-9_]+")}$`,
    );
    return re.test(name);
  });
}
