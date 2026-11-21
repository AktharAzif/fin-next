// The plan-speed fixture (spec 07 §13.1, T-RV-20): a fin-next-shaped tree of exactly 2,000
// tracked files and a pull-request head that touches a wide spread of them.
//
// Deterministic: the same call always returns the same files, so timings compare across runs.

export interface PlanSpeedFixture {
  /** Every file of the base commit: exactly `fileCount` paths. */
  readonly base: Record<string, string>;
  /** The head's changes on top of the base (null deletes a path). */
  readonly head: Record<string, string | null>;
}

const WEB_APPS = ["console", "admin", "verify", "docs"];
const SERVICE_APPS = ["edge", "api", "payments", "connector"];
const PACKAGES = [
  "core", "server", "web-host", "db", "crypto", "identity", "access", "orgs", "staff", "audit", "keys", "kyc",
  "money", "events", "email", "contract", "app-contracts", "tokens", "icons", "motion", "ui", "frame", "testing",
];

function manifest(name: string, deps: string[]): string {
  const dependencies: Record<string, string> = {};
  for (const dep of deps) dependencies[`@fin/${dep}`] = "workspace:*";
  return `${JSON.stringify({ name: `@fin/${name}`, private: true, type: "module", dependencies }, null, 2)}\n`;
}

function source(path: string, n: number): string {
  return `// ${path}\nexport const value${n} = ${n};\nexport function f${n}(x: number): number {\n  return x + ${n};\n}\n`;
}

/** Builds the fixture with the given layout text as tools/layout.json. */
export function generatePlanSpeedFixture(layoutText: string, fileCount = 2000): PlanSpeedFixture {
  const base: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "fin-next", private: true }, null, 2)}\n`,
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n  - packages/*\n",
    "README.md": "# fin-next\n",
    "tools/layout.json": layoutText,
  };
  const owners: Array<{ dir: string; kind: "app" | "package" }> = [];
  for (const app of [...WEB_APPS, ...SERVICE_APPS]) {
    const deps = app === "docs" ? ["contract"] : ["server", "core", ...(WEB_APPS.includes(app) ? ["ui", "frame"] : ["db"])];
    base[`apps/${app}/package.json`] = manifest(app, deps);
    owners.push({ dir: `apps/${app}`, kind: "app" });
  }
  PACKAGES.forEach((name, index) => {
    const deps = index === 0 ? [] : [PACKAGES[Math.floor(index / 2)] ?? "core"];
    base[`packages/${name}/package.json`] = manifest(name, deps);
    owners.push({ dir: `packages/${name}`, kind: "package" });
  });
  for (let d = 0; d < 6; d++) base[`docs/plan/section-${d}/README.md`] = `# section ${d}\n`;

  let n = 0;
  while (Object.keys(base).length < fileCount) {
    const owner = owners[n % owners.length];
    if (owner === undefined) break;
    const area = owner.kind === "app" ? (n % 3 === 0 ? "src/client" : "src/server") : "src";
    const sub = `m${Math.floor(n / owners.length) % 7}`;
    const stem = `file-${n}`;
    const path = n % 11 === 0 ? `${owner.dir}/${area}/${sub}/${stem}.test.ts` : `${owner.dir}/${area}/${sub}/${stem}.ts`;
    base[path] = source(path, n);
    n++;
  }

  const paths = Object.keys(base).filter((path) => path.endsWith(".ts"));
  const head: Record<string, string | null> = {};
  paths.forEach((path, index) => {
    if (index % 9 === 0) head[path] = `${base[path] ?? ""}// changed\n`; // about 220 modified files
    else if (index % 61 === 0) head[path] = null; // about 30 deletions
    else if (index % 67 === 0) {
      // about 30 renames, same content, so git reports them as renames
      head[path] = null;
      head[path.replace(/\.ts$/, ".moved.ts")] = base[path] ?? "";
    }
  });
  for (let i = 0; i < 20; i++) head[`packages/core/src/added ${i}/new file ${i}.ts`] = source(`added-${i}`, 10_000 + i);
  head["docs/plan/section-0/README.md"] = "# section 0, changed\n";
  return { base, head };
}
