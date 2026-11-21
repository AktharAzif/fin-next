// Developers · API keys (ApiKeys board; spec 02 §12.3, §12.4; spec 05 §4): the Sandbox keys and,
// once Fin approves the organisation, the Production keys, each with its access, status, maker and
// "last used"; create with the secret shown once, edit, roll with its overlap, revoke, each after the
// StepUp dialog. The board's states: list, the key's drawer and its menu, created and rolled (the
// toast is the outcome), empty, loading, failed, a role that may only read (actions disabled with
// the reason) and no permission (the frame's page for a route whose `needs` the viewer lacks).
import type { ConsoleViewer } from "@fin/app-contracts";
import { RouterLink, useFin } from "@fin/frame";
import { DotsThreeIcon, KeyIcon, LockSimpleIcon, PlusIcon } from "@fin/icons";
import {
  Button,
  DropdownMenu,
  EmptyState,
  IconButton,
  MenuItem,
  MenuSeparator,
  PageHeader,
  SkeletonPage,
  StatusBadge,
  Table,
  type TableColumn,
  toast,
} from "@fin/ui";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useResource } from "../../../api/resource.ts";
import { ROLE_REASON, SectionFailure, useSignedIn } from "../../../components/page.tsx";
import { formatDay } from "../../../format/dates.ts";
import { type KeyRow, type KeysAnswer, keysList } from "./-api.ts";
import {
  CreateKeyDialog,
  EditKeyDialog,
  KeyDetail,
  RevokeKeyDialog,
  RollKeyDialog,
  SecretPanel,
} from "./-dialogs.tsx";
import { lastUsedLine, STATUS, statusLine } from "./-model.ts";

export const Route = createFileRoute("/developers/keys/")({
  staticData: { frame: "app", navId: "api-keys", pageName: "API keys", needs: ["apiKey.read"] },
  pendingComponent: () => <SkeletonPage label="API keys" rows={4} />,
  component: ApiKeysPage,
});

const DESCRIPTION =
  "Send a key as Authorization: Bearer to the API. The prefix picks the environment. No token exchange, nothing to refresh.";
const BEYOND_ROLE = "You can’t make a key that can do more than your role.";

type Surface =
  | null
  | { kind: "detail"; key: KeyRow }
  | { kind: "create" }
  | { kind: "edit"; key: KeyRow }
  | { kind: "roll"; key: KeyRow }
  | { kind: "revoke"; key: KeyRow }
  | { kind: "secret"; title: string; secret: string; key: KeyRow; toast: "created" | "rolled" };

/** Whether the role may roll this key: rolling makes a key, so its access must be within the role. */
function rollReason(key: KeyRow, can: KeysAnswer["can"] | undefined): string | undefined {
  const mode = key.mode === "live" ? can?.live : can?.test;
  if (mode === undefined || !mode.manage) return ROLE_REASON;
  if (key.kind === "sk" ? !mode.fullAccess : !key.scopes.every((s) => mode.scopes.includes(s))) {
    return BEYOND_ROLE;
  }
  return undefined;
}

function ApiKeysPage() {
  const fin = useFin<ConsoleViewer>();
  const signedIn = useSignedIn();
  const orgId = signedIn?.viewer.currentOrgId ?? "";
  const live = signedIn?.membership?.liveStatus === "approved";
  const sandbox = useResource(`keys:${orgId}:test`, (signal) =>
    fin.api(keysList, { mode: "test", size: 100 }, { signal }),
  );
  const production = useResource(
    `keys:${orgId}:live`,
    (signal) => fin.api(keysList, { mode: "live", size: 100 }, { signal }),
    { enabled: live },
  );
  const [surface, setSurface] = useState<Surface>(null);
  const can = sandbox.data?.can;
  const canSandbox = signedIn?.can("apiKey.sandbox") === true;
  const canLive = signedIn?.can("apiKey.live") === true;
  const canAudit = signedIn?.can("auditLog.read") === true;
  const canManage = (key: KeyRow) => (key.mode === "live" ? canLive : canSandbox);
  const reload = async () => {
    await sandbox.reload();
    if (live) await production.reload();
  };

  const menu = (key: KeyRow) => {
    if (!canManage(key) || key.status === "revoked" || key.status === "expired") return null;
    const reason = rollReason(key, can);
    return (
      <DropdownMenu
        align="end"
        trigger={
          <IconButton size="sm" label={`Actions for ${key.name}`} icon={<DotsThreeIcon />} />
        }
      >
        {key.status === "active" ? (
          <MenuItem
            {...(reason === undefined ? {} : { disabled: true, caption: reason })}
            onSelect={() => setSurface({ kind: "roll", key })}
          >
            Roll key
          </MenuItem>
        ) : null}
        {key.status === "active" ? (
          <MenuItem onSelect={() => setSurface({ kind: "edit", key })}>Edit key</MenuItem>
        ) : null}
        {canAudit ? (
          <MenuItem href={`/audit-log?${new URLSearchParams({ target: key.keyId }).toString()}`}>
            View in audit log
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem destructive onSelect={() => setSurface({ kind: "revoke", key })}>
          Revoke key
        </MenuItem>
      </DropdownMenu>
    );
  };

  const columns: TableColumn<KeyRow>[] = [
    {
      id: "key",
      header: "Key",
      width: "xl",
      cell: (k) => (
        <div className="flex min-w-0 flex-col py-2">
          <span className="truncate text-label text-text-primary">{k.name}</span>
          <span className="truncate font-mono text-caption text-text-tertiary">{k.prefix}</span>
        </div>
      ),
    },
    { id: "access", header: "Access", width: "lg", cell: (k) => k.access },
    {
      id: "status",
      header: "Status",
      kind: "status",
      cell: (k) => (
        <div className="flex min-w-0 flex-col items-start gap-1 py-2">
          <StatusBadge tone={STATUS[k.status].tone}>{STATUS[k.status].label}</StatusBadge>
          <span className="text-caption text-text-tertiary">{statusLine(k)}</span>
        </div>
      ),
    },
    {
      id: "used",
      header: "Last used",
      width: "md",
      hideBelow: "xl",
      cell: (k) => <span className="text-body text-text-secondary">{lastUsedLine(k)}</span>,
    },
    {
      id: "created",
      header: "Created",
      kind: "date",
      width: "lg",
      cell: (k) => (
        <div className="flex min-w-0 flex-col py-2">
          <span className="text-body tabular-nums text-text-secondary">
            {formatDay(k.createdAt)}
          </span>
          <span className="truncate text-caption text-text-tertiary">
            {k.createdBy.name === "" ? "by someone who left" : `by ${k.createdBy.name}`}
          </span>
        </div>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      kind: "actions",
      width: "xs",
      hideHeader: true,
      cell: menu,
    },
  ];

  const createButton = (
    <Button
      variant="primary"
      size="sm"
      leadingIcon={<PlusIcon />}
      {...(canSandbox || canLive ? {} : { disabledReason: ROLE_REASON })}
      onClick={() => setSurface({ kind: "create" })}
    >
      Create key
    </Button>
  );
  const firstUse = sandbox.status === "ready" && sandbox.data?.keys.length === 0 && !live;

  const table = (title: string, data: typeof sandbox) => (
    <Table
      caption={title}
      noun={{ singular: "key", plural: "keys" }}
      columns={columns}
      rows={data.data?.keys ?? []}
      getRowId={(k) => k.keyId}
      getRowLabel={(k) =>
        `${k.name}, ${k.prefix}, ${STATUS[k.status].label}, created ${formatDay(k.createdAt)}`
      }
      onRowClick={(k) => setSurface({ kind: "detail", key: k })}
      {...(surface?.kind === "detail" ? { activeRowId: surface.key.keyId } : {})}
      status={
        data.status === "error"
          ? "error"
          : data.status === "loading"
            ? "loading"
            : data.status === "refreshing"
              ? "refreshing"
              : "ready"
      }
      error={{
        title: "Couldn’t load API keys",
        description: "Check your connection and try again.",
        onRetry: () => data.reload(),
      }}
      loadingRows={4}
      empty={
        <EmptyState
          variant="first-use"
          icon={<KeyIcon />}
          title="No keys yet"
          description="Create one to make your first sandbox call."
          {...(canSandbox ? { action: createButton } : {})}
        />
      }
    />
  );

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="API keys"
        description={DESCRIPTION}
        {...(firstUse ? {} : { primaryAction: createButton })}
        linkAs={RouterLink}
      />
      {sandbox.status === "error" && sandbox.data === null ? (
        <SectionFailure
          title="Couldn’t load API keys"
          error={sandbox.error}
          onRetry={() => sandbox.reload()}
        />
      ) : (
        <div className="flex flex-col gap-16">
          <section aria-labelledby="sandbox-keys" className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div className="flex items-baseline gap-3">
                <h2 id="sandbox-keys" className="m-0 text-heading text-text-primary">
                  Sandbox keys
                </h2>
                <span className="font-mono text-mono text-text-secondary">fin_test_</span>
              </div>
              <p className="m-0 text-caption text-text-tertiary">
                Secrets are shown once. Fin stores only a hash.
              </p>
            </div>
            {table("Sandbox keys", sandbox)}
          </section>
          <section aria-labelledby="production-keys" className="flex flex-col gap-4">
            <div className="flex items-baseline gap-3">
              <h2 id="production-keys" className="m-0 text-heading text-text-primary">
                Production keys
              </h2>
              <span className="font-mono text-mono text-text-secondary">fin_live_</span>
            </div>
            {live ? (
              table("Production keys", production)
            ) : (
              <div className="rounded-md bg-surface shadow-ring">
                <EmptyState
                  variant="not-configured"
                  icon={<LockSimpleIcon />}
                  title="Production keys unlock when Fin approves you"
                  description="A fin_live_ key works only for what Fin approved for your organisation."
                />
              </div>
            )}
          </section>
        </div>
      )}

      {surface?.kind === "detail" ? (
        <KeyDetail
          keyRow={surface.key}
          canManage={canManage(surface.key)}
          rollReason={rollReason(surface.key, can)}
          canAudit={canAudit}
          onClose={() => setSurface(null)}
          onEdit={() => setSurface({ kind: "edit", key: surface.key })}
          onRoll={() => setSurface({ kind: "roll", key: surface.key })}
          onRevoke={() => setSurface({ kind: "revoke", key: surface.key })}
        />
      ) : null}
      {surface?.kind === "create" && can !== undefined ? (
        <CreateKeyDialog
          test={can.test}
          live={can.live}
          onClose={() => setSurface(null)}
          onCreated={(made) => {
            setSurface({
              kind: "secret",
              title: made.key.name,
              secret: made.secret,
              key: made.key,
              toast: "created",
            });
            void reload();
          }}
        />
      ) : null}
      {surface?.kind === "edit" ? (
        <EditKeyDialog
          keyRow={surface.key}
          onClose={() => setSurface(null)}
          onSaved={(key) => {
            toast.success({ title: "Key saved", description: `${key.name} is up to date.` });
            setSurface(null);
            void reload();
          }}
        />
      ) : null}
      {surface?.kind === "roll" ? (
        <RollKeyDialog
          keyRow={surface.key}
          onClose={() => setSurface(null)}
          onRolled={(made) => {
            setSurface({
              kind: "secret",
              title: made.key.name,
              secret: made.secret,
              key: made.key,
              toast: "rolled",
            });
            void reload();
          }}
        />
      ) : null}
      {surface?.kind === "revoke" ? (
        <RevokeKeyDialog
          keyRow={surface.key}
          onClose={() => setSurface(null)}
          onRevoked={() => {
            setSurface(null);
            void reload();
          }}
        />
      ) : null}
      {surface?.kind === "secret" ? (
        <SecretPanel
          title={surface.title}
          secret={surface.secret}
          keyRow={surface.key}
          onDone={() => {
            toast.success({
              title: surface.toast === "created" ? "Key created" : "Key rolled",
              description: "It may take a few minutes to start working.",
            });
            setSurface(null);
          }}
        />
      ) : null}
    </div>
  );
}
