// The plan-speed fixture (spec 07 §13.1, T-RV-20): a fin-next-shaped tree of exactly 2,000
// tracked files and a pull-request head that touches a wide spread of them. Optionally some of
// those entries are symbolic links, some of them aimed at packages/core/src, a folder the head
// changes, so the speed covers the links a changed path is reached through.
//
// Deterministic: the same call always returns the same files, so timings compare across runs.

/** A file's content, or a symbolic link to `symlink`. */
export type FixtureEntry = string | { readonly symlink: string };

export interface PlanSpeedFixture {
  /** Every entry of the base commit: exactly `fileCount` paths. */
  readonly base: Record<string, FixtureEntry>;
  /** The head's changes on top of the base (null deletes a path). */
  readonly head: Record<string, FixtureEntry | null>;
}

export interface PlanSpeedOptions {
  /** How many of the base's entries are symbolic links (none by default). */
  readonly links?: number;
  /** How many of those links reach packages/core/src (a fifth by default). */
  readonly coreLinks?: number;
  /** The head changes one source file in this many (9 by default: about 220 of them). */
  readonly changeEvery?: number;
  /** How many files the head adds under packages/core/src, the folder a fifth of the links reach (20 by default). */
  readonly addedToCore?: number;
}

const WEB_APPS = ["console", "admin", "verify", "docs"];
const SERVICE_APPS = ["edge", "api", "payments", "connector"];
const PACKAGES = [
  "core",
  "server",
  "web-host",
  "db",
  "crypto",
  "identity",
  "access",
  "orgs",
  "staff",
  "audit",
  "keys",
  "kyc",
  "money",
  "events",
  "email",
  "contract",
  "app-contracts",
  "tokens",
  "icons",
  "motion",
  "ui",
  "frame",
  "testing",
];
/** The packages that hold links: every one but core, whose src some links reach (a link inside its own target would loop). */
const LINK_HOSTS = PACKAGES.filter((name) => name !== "core");

function manifest(name: string, deps: string[]): string {
  const dependencies: Record<string, string> = {};
  for (const dep of deps) dependencies[`@fin/${dep}`] = "workspace:*";
  return `${JSON.stringify({ name: `@fin/${name}`, private: true, type: "module", dependencies }, null, 2)}\n`;
}

function source(path: string, n: number): string {
  return `// ${path}\nexport const value${n} = ${n};\nexport function f${n}(x: number): number {\n  return x + ${n};\n}\n`;
}

/**
 * The links: link i sits in packages/<host>/src/links and reaches packages/core/src (a folder the
 * head changes) for the first `coreLinks` of them, and one of the m0..m6 folders of a package
 * other than core for the rest.
 */
export function fixtureLinks(
  count: number,
  coreLinks = Math.ceil(count / 5),
): Record<string, { symlink: string }> {
  const out: Record<string, { symlink: string }> = {};
  const others = PACKAGES.slice(1);
  for (let i = 0; i < count; i++) {
    const host = LINK_HOSTS[i % LINK_HOSTS.length] ?? "server";
    const target =
      i < coreLinks
        ? "core/src"
        : `${others[(i * 7 + 3) % others.length] ?? "server"}/src/m${i % 7}`;
    out[`packages/${host}/src/links/l${i}`] = { symlink: `../../../${target}` };
  }
  return out;
}

/** Builds the fixture with the given layout text as tools/layout.json. */
export function generatePlanSpeedFixture(
  layoutText: string,
  fileCount = 2000,
  options: PlanSpeedOptions = {},
): PlanSpeedFixture {
  const base: Record<string, FixtureEntry> = {
    "package.json": `${JSON.stringify({ name: "fin-next", private: true }, null, 2)}\n`,
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "README.md": "# fin-next\n",
    "tools/layout.json": layoutText,
  };
  const owners: Array<{ dir: string; kind: "app" | "package" }> = [];
  for (const app of [...WEB_APPS, ...SERVICE_APPS]) {
    const deps =
      app === "docs"
        ? ["contract"]
        : ["server", "core", ...(WEB_APPS.includes(app) ? ["ui", "frame"] : ["db"])];
    base[`apps/${app}/package.json`] = manifest(app, deps);
    owners.push({ dir: `apps/${app}`, kind: "app" });
  }
  PACKAGES.forEach((name, index) => {
    const deps = index === 0 ? [] : [PACKAGES[Math.floor(index / 2)] ?? "core"];
    base[`packages/${name}/package.json`] = manifest(name, deps);
    owners.push({ dir: `packages/${name}`, kind: "package" });
  });
  for (let d = 0; d < 6; d++) base[`docs/plan/section-${d}/README.md`] = `# section ${d}\n`;
  Object.assign(base, fixtureLinks(options.links ?? 0, options.coreLinks));

  let n = 0;
  while (Object.keys(base).length < fileCount) {
    const owner = owners[n % owners.length];
    if (owner === undefined) break;
    const area = owner.kind === "app" ? (n % 3 === 0 ? "src/client" : "src/server") : "src";
    const sub = `m${Math.floor(n / owners.length) % 7}`;
    const stem = `file-${n}`;
    const path =
      n % 11 === 0
        ? `${owner.dir}/${area}/${sub}/${stem}.test.ts`
        : `${owner.dir}/${area}/${sub}/${stem}.ts`;
    base[path] = source(path, n);
    n++;
  }

  const changeEvery = options.changeEvery ?? 9;
  const paths = Object.keys(base).filter((path) => path.endsWith(".ts"));
  const head: Record<string, FixtureEntry | null> = {};
  paths.forEach((path, index) => {
    const content = base[path];
    const text = typeof content === "string" ? content : "";
    if (index % changeEvery === 0)
      head[path] = `${text}// changed\n`; // about 220 modified files by default
    else if (index % 61 === 0)
      head[path] = null; // about 30 deletions
    else if (index % 67 === 0) {
      // about 30 renames, same content, so git reports them as renames
      head[path] = null;
      head[path.replace(/\.ts$/, ".moved.ts")] = text;
    }
  });
  for (let i = 0; i < (options.addedToCore ?? 20); i++)
    head[`packages/core/src/added ${i % 20}/new file ${i}.ts`] = source(`added-${i}`, 10_000 + i);
  head["docs/plan/section-0/README.md"] = "# section 0, changed\n";
  return { base, head };
}
