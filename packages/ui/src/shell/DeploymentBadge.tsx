// Fin Admin's header left (spec 06 §4.3; AdminFrame `staging`, `development`, `unknownDeployment`):
// the deployment Fin Admin runs in, from the viewer's `environment`, as an outline Badge, a fact
// about the whole view. Never a status colour.
import { Badge } from "../foundation/badge.tsx";

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
    <span data-deployment={known ? environment : "unknown"} className="inline-flex shrink-0">
      <Badge variant="outline">{deploymentLabel(environment)}</Badge>
    </span>
  );
}
