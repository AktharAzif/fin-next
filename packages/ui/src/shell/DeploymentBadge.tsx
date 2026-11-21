// Fin Admin's header left (spec 06 §4.3; AdminFrame `staging`, `development`, `unknownDeployment`):
// the deployment Fin Admin runs in, from the viewer's `environment`, as an outline badge, a fact about
// the whole view. Never a status colour.

const LABELS: Readonly<Record<string, string>> = {
  production: "Production",
  staging: "Staging",
  development: "Development",
};

export function deploymentLabel(environment: string): string {
  return Object.hasOwn(LABELS, environment) ? (LABELS[environment] ?? "Unknown") : "Unknown";
}

export function DeploymentBadge({ environment }: { environment: string }) {
  const known = Object.hasOwn(LABELS, environment);
  return (
    <span
      data-deployment={known ? environment : "unknown"}
      className="inline-flex h-5 shrink-0 items-center rounded-badge border border-border-strong px-1.5 text-caption font-medium text-text-secondary"
    >
      {deploymentLabel(environment)}
    </span>
  );
}
