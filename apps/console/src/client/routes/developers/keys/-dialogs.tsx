// The API keys page's surfaces (ApiKeys, ApiKeyCreate and ApiKeyActions boards): the key's detail,
// the create form, the secret shown once, the edit, the roll and the revoke. Each change goes through
// api(), whose `403 step_up_required` opens the root StepUp dialog and re-sends the request once
// with the intent (spec 02 §7.5); what the role cannot do is drawn disabled with the reason, and the
// server refuses regardless ([SA-16]).
//
// @fin/ui has no drawer or radio group yet: the boards' drawers are drawn as Modals and their radio
// groups composed from native radios and the design system's tokens, as Team's role picker is.
// @pendingDesign UR-22: a RadioGroup in @fin/ui (ApiKeyCreate's environment, access and expiry;
// ApiKeyActions' overlap).
// @pendingDesign UR-23: a Drawer in @fin/ui (ApiKeys' key drawer, ApiKeyCreate's form and secret).
import { RouterLink, useFin } from "@fin/frame";
import { CopyIcon } from "@fin/icons";
import {
  Button,
  Checkbox,
  ConfirmDialog,
  CopyField,
  Field,
  InlineAlert,
  Input,
  Modal,
  StatusBadge,
  toast,
  useCopy,
} from "@fin/ui";
import { type ReactNode, useId, useState } from "react";
import { failureSentence, toastFailure, toldElsewhere } from "../../../api/actions.ts";
import { codeOf, problemField } from "../../../api/failures.ts";
import { formatDay } from "../../../format/dates.ts";
import { createKey, type KeyRow, revokeKey, rollKey, updateKey } from "./-api.ts";
import {
  type CreateDraft,
  type DraftProblems,
  draftProblems,
  EXPIRY_LABELS,
  type ExpiryChoice,
  environmentLabel,
  envLine,
  fieldSentence,
  lastUsedLine,
  type ModeAbilities,
  parseAllowlist,
  SANDBOX_ONLY,
  SCOPE_ORDER,
  STATUS,
  statusLine,
  withinRole,
} from "./-model.ts";

export interface Abilities {
  manage: boolean;
  fullAccess: boolean;
  scopes: string[];
}

const ROLE_REASON = "You can’t make a key that can do more than your role.";
const ALLOWLIST_REASON =
  "You can’t change where a key works from while it can do more than your role.";

function Radios<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; description?: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  horizontal?: boolean;
}) {
  const name = `radio${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0" disabled={props.disabled}>
      <legend className="mb-2 p-0 text-label-sm text-text-secondary">{props.label}</legend>
      <div
        className={
          props.horizontal === true ? "flex flex-wrap gap-x-6 gap-y-2" : "flex flex-col gap-1"
        }
      >
        {props.options.map((option) => (
          <label
            key={option.value}
            className={
              option.disabled === true
                ? "flex cursor-not-allowed items-start gap-3 rounded-md py-1.5"
                : "flex cursor-pointer items-start gap-3 rounded-md py-1.5"
            }
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={props.value === option.value}
              disabled={option.disabled}
              onChange={() => props.onChange(option.value)}
              className="mt-0.5 size-4 shrink-0 accent-action-primary"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span
                className={
                  option.disabled === true
                    ? "text-label text-text-disabled"
                    : "text-label text-text-primary"
                }
              >
                {option.label}
              </span>
              {option.description === undefined ? null : (
                <span className="text-caption text-text-tertiary">{option.description}</span>
              )}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Detail(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <dt className="text-label-sm text-text-secondary">{props.label}</dt>
      <dd className="m-0 text-body text-text-primary">{props.children}</dd>
    </div>
  );
}

/** The key's detail (the board's drawer): what it can do, its life, and its actions. */
export function KeyDetail(props: {
  keyRow: KeyRow;
  canManage: boolean;
  rollReason: string | undefined;
  canAudit: boolean;
  onClose: () => void;
  onEdit: () => void;
  onRoll: () => void;
  onRevoke: () => void;
}) {
  const k = props.keyRow;
  const ended = k.status === "revoked" || k.status === "expired";
  return (
    <Modal
      open
      onOpenChange={(open) => (open ? undefined : props.onClose())}
      title={k.name}
      description={`${environmentLabel(k.mode)} key`}
      footer={
        props.canManage && !ended ? (
          <>
            <Button variant="danger" onClick={props.onRevoke}>
              Revoke key
            </Button>
            {k.status === "active" ? (
              <>
                <Button onClick={props.onEdit}>Edit key</Button>
                <Button
                  variant="primary"
                  {...(props.rollReason === undefined ? {} : { disabledReason: props.rollReason })}
                  onClick={props.onRoll}
                >
                  Roll key
                </Button>
              </>
            ) : null}
          </>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        <div>
          <StatusBadge tone={STATUS[k.status].tone}>{STATUS[k.status].label}</StatusBadge>
        </div>
        {k.flags.secretUnseen && !ended ? (
          <InlineAlert tone="warning" title="Nobody has this key’s secret">
            It replaced a key when the person who made it left. Roll it to get a secret.
          </InlineAlert>
        ) : null}
        {k.flags.makerLacksPermissions && !ended ? (
          <InlineAlert tone="warning" title="Its maker’s role no longer allows this key">
            Roll or revoke it if it should not keep this access.
          </InlineAlert>
        ) : null}
        <dl className="m-0 flex flex-col gap-3">
          <Detail label="Prefix">
            <CopyField value={k.prefix} label="Key prefix" head={9} tail={4} />
          </Detail>
          <Detail label="Access">{k.access}</Detail>
          <Detail label="Expires">{statusLine(k)}</Detail>
          <Detail label="Created">{`${formatDay(k.createdAt)} by ${k.createdBy.name || "someone who left"}`}</Detail>
          <Detail label="Last used">{lastUsedLine(k)}</Detail>
          {k.ipAllowlist.length === 0 ? null : (
            <Detail label="IP allowlist">{`Only from ${k.ipAllowlist.join(", ")}`}</Detail>
          )}
          <Detail label="Scopes">
            {k.kind === "sk" ? (
              "All scopes"
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {k.scopes.map((scope) => (
                  <li key={scope} className="font-mono text-mono">
                    {scope}
                  </li>
                ))}
              </ul>
            )}
          </Detail>
        </dl>
        {props.canAudit ? (
          <RouterLink
            href={`/audit-log?${new URLSearchParams({ target: k.keyId }).toString()}`}
            className="text-label-sm text-text-secondary no-underline hover:text-text-primary"
          >
            View in audit log →
          </RouterLink>
        ) : null}
      </div>
    </Modal>
  );
}

/** The secret, shown once (README "Show-once secrets"): Done waits for the tick; closing asks first. */
export function SecretPanel(props: {
  title: string;
  secret: string;
  keyRow: KeyRow;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [asking, setAsking] = useState(false);
  const copyEnv = useCopy(envLine(props.secret));
  const k = props.keyRow;
  return (
    <>
      <Modal
        open
        title={props.title}
        description={`${environmentLabel(k.mode)} key`}
        onOpenChange={(open) => {
          if (open) return;
          if (saved) props.onDone();
          else setAsking(true);
        }}
        footer={
          <Button
            variant="primary"
            {...(saved
              ? {}
              : { disabledReason: "Tick “I have stored this key somewhere safe” first." })}
            onClick={props.onDone}
          >
            Done
          </Button>
        }
      >
        <div className="flex flex-col gap-6">
          <InlineAlert tone="highlight" title="Copy your secret now">
            This is the only time Fin shows it. Fin keeps a hash, so a lost key is rolled, never
            recovered.
          </InlineAlert>
          <div className="flex flex-col items-start gap-3">
            <CopyField variant="block" label="Secret key" value={props.secret} className="w-full" />
            <Button size="sm" leadingIcon={<CopyIcon />} onClick={() => void copyEnv.copy()}>
              Copy as FIN_KEY=…
            </Button>
          </div>
          <dl className="m-0 flex flex-col gap-3">
            <Detail label="Name">{k.name}</Detail>
            <Detail label="Access">{k.access}</Detail>
            <Detail label="Environment">{environmentLabel(k.mode)}</Detail>
            <Detail label="Expires">
              {k.expiresAt === null ? "Never" : formatDay(k.expiresAt)}
            </Detail>
          </dl>
          <CopyField
            variant="block"
            label="Try it"
            value={'curl "$FIN_API_URL/v4/whoami" -H "Authorization: Bearer $FIN_KEY"'}
            className="w-full"
          />
          <Checkbox
            label="I have stored this key somewhere safe"
            checked={saved}
            onCheckedChange={(next) => setSaved(next === true)}
          />
        </div>
      </Modal>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title="Close without copying?"
        description="This is the only time Fin shows it. Fin keeps a hash, so a lost key is rolled, never recovered."
        confirmLabel="Close without copying"
        tone="danger"
        onConfirm={() => {
          setAsking(false);
          props.onDone();
        }}
      />
    </>
  );
}

/** Create a key (ApiKeyCreate): name, environment, access, scopes, expiry and the allowlist. */
export function CreateKeyDialog(props: {
  test: Abilities;
  live: Abilities & { approved: boolean };
  onClose: () => void;
  onCreated: (made: { secret: string; key: KeyRow }) => void;
}) {
  const fin = useFin();
  const [draft, setDraft] = useState<CreateDraft>({
    name: "",
    mode: "test",
    kind: "rk",
    scopes: props.test.scopes.filter((s) => s === "customers:read" || s === "money:read"),
    allowlist: "",
    expiresIn: "90d",
  });
  const [problems, setProblems] = useState<DraftProblems>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abilities = draft.mode === "live" ? props.live : props.test;
  const set = (patch: Partial<CreateDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const liveReason = !props.live.approved
    ? "Production unlocks when Fin approves your organisation."
    : !props.live.manage
      ? "Your role doesn’t allow Production keys."
      : undefined;

  const submit = async () => {
    const found = draftProblems(draft);
    setProblems(found);
    setFailed(null);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const made = await fin.api(createKey, {
        name: draft.name.trim(),
        mode: draft.mode,
        kind: draft.kind,
        scopes: draft.kind === "sk" ? [] : SCOPE_ORDER.filter((s) => draft.scopes.includes(s)),
        ipAllowlist: parseAllowlist(draft.allowlist),
        expiresIn: draft.expiresIn,
      });
      props.onCreated(made);
    } catch (error) {
      if (toldElsewhere(error)) return;
      const fields = problemField(error, "fields");
      if (codeOf(error) === "invalid" && Array.isArray(fields) && fields.length > 0) {
        const first = fields[0] as { path: string; code: string };
        const sentence = fieldSentence(first.path, first.code);
        setProblems({ [sentence.field]: sentence.text });
      } else if (codeOf(error) === "limit_reached") {
        setFailed("Your organisation has 50 working keys. Revoke one first.");
      } else if (codeOf(error) === "forbidden") {
        setFailed(ROLE_REASON);
      } else {
        setFailed(failureSentence(error));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      busy={busy}
      title="Create a key"
      description="Use one key per service, so you can revoke it on its own."
      onOpenChange={(open) => (open ? undefined : props.onClose())}
      footer={
        <>
          <Button
            {...(busy ? { disabledReason: "Wait for this to finish." } : {})}
            onClick={props.onClose}
          >
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Create key
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {failed === null ? null : (
          <InlineAlert tone="danger" title="Couldn’t create the key" live="assertive">
            {failed}
          </InlineAlert>
        )}
        <Field label="Name" helper="Up to 60 characters." error={problems.name}>
          <Input value={draft.name} disabled={busy} onValueChange={(name) => set({ name })} />
        </Field>
        <Radios
          label="Environment"
          value={draft.mode}
          disabled={busy}
          onChange={(mode) =>
            set({
              mode,
              scopes: draft.scopes.filter((s) => mode === "test" || !SANDBOX_ONLY.has(s)),
            })
          }
          options={[
            { value: "test", label: "Sandbox" },
            {
              value: "live",
              label: "Production",
              ...(liveReason === undefined ? {} : { description: liveReason, disabled: true }),
            },
          ]}
        />
        <Radios
          label="Access"
          value={draft.kind}
          disabled={busy}
          onChange={(kind) => set({ kind })}
          options={[
            {
              value: "sk",
              label: "Full access",
              ...(abilities.fullAccess ? {} : { description: ROLE_REASON, disabled: true }),
            },
            { value: "rk", label: "Restricted" },
          ]}
        />
        {draft.kind === "rk" ? (
          <fieldset className="m-0 flex flex-col gap-3 border-0 p-0" disabled={busy}>
            <legend className="mb-3 p-0 text-label-sm text-text-secondary">Scopes</legend>
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              {SCOPE_ORDER.filter((s) => draft.mode === "test" || !SANDBOX_ONLY.has(s)).map(
                (scope) => {
                  const allowed = abilities.scopes.includes(scope);
                  return (
                    <Checkbox
                      key={scope}
                      aria-label={scope}
                      label={<span className="font-mono text-mono">{scope}</span>}
                      checked={draft.scopes.includes(scope)}
                      disabled={!allowed || busy}
                      invalid={problems.scopes !== undefined}
                      onCheckedChange={(next) =>
                        set({
                          scopes:
                            next === true
                              ? [...draft.scopes, scope]
                              : draft.scopes.filter((s) => s !== scope),
                        })
                      }
                    />
                  );
                },
              )}
            </div>
            {problems.scopes === undefined ? null : (
              <p role="alert" className="m-0 text-caption text-status-danger-fg">
                {problems.scopes}
              </p>
            )}
          </fieldset>
        ) : null}
        <Radios
          label="Expires"
          value={draft.expiresIn}
          disabled={busy}
          horizontal
          onChange={(expiresIn) => set({ expiresIn })}
          options={(["90d", "30d", "1y", "never"] as ExpiryChoice[]).map((value) => ({
            value,
            label: EXPIRY_LABELS[value],
          }))}
        />
        <Field
          label="IP allowlist"
          optional
          helper="IPv4 and IPv6 addresses or ranges (CIDR), up to 20, separated by commas."
          error={problems.allowlist}
        >
          <Input
            value={draft.allowlist}
            disabled={busy}
            placeholder="203.0.113.0/24"
            className="font-mono text-mono"
            onValueChange={(allowlist) => set({ allowlist })}
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Edit a key: its name, fewer scopes, a shorter life, its allowlist (spec 05 §4.6). */
export function EditKeyDialog(props: {
  keyRow: KeyRow;
  /** What the role may make in the key's mode: an allowlist change needs the key, as edited, within it. */
  abilities: ModeAbilities | undefined;
  onClose: () => void;
  onSaved: (key: KeyRow) => void;
}) {
  const fin = useFin();
  const k = props.keyRow;
  const [name, setName] = useState(k.name);
  const [scopes, setScopes] = useState<string[]>(k.scopes);
  const [allowlist, setAllowlist] = useState(k.ipAllowlist.join(", "));
  const [shorten, setShorten] = useState<"keep" | "7d" | "30d">("keep");
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shorter = (days: number) =>
    k.expiresAt === null || Date.parse(k.expiresAt) > Date.now() + days * 86_400_000;
  const allowlistLocked = !withinRole(props.abilities, k.kind, scopes);

  const save = async () => {
    setProblem(null);
    const body: {
      keyId: string;
      name?: string;
      scopes?: string[];
      expiresAt?: string;
      ipAllowlist?: string[];
    } = {
      keyId: k.keyId,
    };
    if (name.trim() !== k.name) body.name = name.trim();
    if (k.kind === "rk" && scopes.length !== k.scopes.length) body.scopes = scopes;
    const entries = parseAllowlist(allowlist);
    if (entries.join(",") !== k.ipAllowlist.join(",")) body.ipAllowlist = entries;
    if (shorten !== "keep") {
      body.expiresAt = new Date(
        Date.now() + (shorten === "7d" ? 7 : 30) * 86_400_000,
      ).toISOString();
    }
    if (Object.keys(body).length === 1) {
      setProblem("Change something first.");
      return;
    }
    if (k.kind === "rk" && scopes.length === 0) {
      setProblem("Keep at least one scope.");
      return;
    }
    if (body.ipAllowlist !== undefined && allowlistLocked) {
      setProblem(ALLOWLIST_REASON);
      return;
    }
    setBusy(true);
    try {
      const saved = await fin.api(updateKey, body);
      props.onSaved(saved.key);
    } catch (error) {
      if (toldElsewhere(error)) return;
      const fields = problemField(error, "fields");
      setProblem(
        Array.isArray(fields) && fields.length > 0
          ? fieldSentence(
              (fields[0] as { path: string }).path,
              (fields[0] as { code: string }).code,
            ).text
          : failureSentence(error),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      busy={busy}
      title={`Edit ${k.name}`}
      description="A key can lose scopes and life, never gain them."
      onOpenChange={(open) => (open ? undefined : props.onClose())}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-6">
        {problem === null ? null : (
          <InlineAlert tone="danger" title="Couldn’t save the key" live="assertive">
            {problem}
          </InlineAlert>
        )}
        <Field label="Name" helper="Up to 60 characters.">
          <Input value={name} disabled={busy} onValueChange={setName} />
        </Field>
        {k.kind === "rk" ? (
          <fieldset className="m-0 flex flex-col gap-3 border-0 p-0" disabled={busy}>
            <legend className="mb-3 p-0 text-label-sm text-text-secondary">Scopes</legend>
            {k.scopes.map((scope) => (
              <Checkbox
                key={scope}
                aria-label={scope}
                label={<span className="font-mono text-mono">{scope}</span>}
                checked={scopes.includes(scope)}
                onCheckedChange={(next) =>
                  setScopes(next === true ? [...scopes, scope] : scopes.filter((s) => s !== scope))
                }
              />
            ))}
          </fieldset>
        ) : null}
        <Radios
          label="Expires"
          value={shorten}
          disabled={busy}
          onChange={setShorten}
          options={[
            {
              value: "keep",
              label: k.expiresAt === null ? "Never (as now)" : `${formatDay(k.expiresAt)} (as now)`,
            },
            { value: "30d", label: "In 30 days", ...(shorter(30) ? {} : { disabled: true }) },
            { value: "7d", label: "In 7 days", ...(shorter(7) ? {} : { disabled: true }) },
          ]}
        />
        <Field
          label="IP allowlist"
          optional
          helper={
            allowlistLocked
              ? ALLOWLIST_REASON
              : "Up to 20 addresses or ranges, separated by commas."
          }
        >
          <Input
            value={allowlist}
            disabled={busy || allowlistLocked}
            className="font-mono text-mono"
            onValueChange={setAllowlist}
          />
        </Field>
      </div>
    </Modal>
  );
}

/** Roll a key (ApiKeyActions' roll): a new key with the same access and life; the old one's overlap. */
export function RollKeyDialog(props: {
  keyRow: KeyRow;
  onClose: () => void;
  onRolled: (made: { secret: string; key: KeyRow; replaced: KeyRow }) => void;
}) {
  const fin = useFin();
  const [overlap, setOverlap] = useState<"24h" | "1h" | "now">("24h");
  const [busy, setBusy] = useState(false);
  const roll = async () => {
    setBusy(true);
    try {
      props.onRolled(await fin.api(rollKey, { keyId: props.keyRow.keyId, overlap }));
    } catch (error) {
      toastFailure(error, "Couldn’t roll the key");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      busy={busy}
      title={`Roll ${props.keyRow.name}?`}
      description="You get a new key with the same access and the same lifetime. Choose how long the old one keeps working while you deploy the new one."
      onOpenChange={(open) => (open ? undefined : props.onClose())}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => void roll()}>
            Roll key
          </Button>
        </>
      }
    >
      <Radios
        label="Keep the old key valid for"
        value={overlap}
        disabled={busy}
        onChange={setOverlap}
        options={[
          { value: "24h", label: "24 hours" },
          { value: "1h", label: "1 hour" },
          { value: "now", label: "Revoke the old key now" },
        ]}
      />
    </Modal>
  );
}

/** Revoke a key (ApiKeyActions' revoke): a destructive confirm. */
export function RevokeKeyDialog(props: {
  keyRow: KeyRow;
  onClose: () => void;
  onRevoked: (key: KeyRow) => void;
}) {
  const fin = useFin();
  const [busy, setBusy] = useState(false);
  return (
    <ConfirmDialog
      open
      busy={busy}
      onOpenChange={(open) => (open ? undefined : props.onClose())}
      title={`Revoke ${props.keyRow.name}?`}
      description={`${props.keyRow.prefix} stops working at once. This can’t be undone; anything still using it will get 401 errors.`}
      confirmLabel="Revoke key"
      tone="danger"
      onConfirm={async () => {
        setBusy(true);
        try {
          const done = await fin.api(revokeKey, { keyId: props.keyRow.keyId });
          toast.success({
            title: "Key revoked",
            description: `${props.keyRow.name} no longer works.`,
          });
          props.onRevoked(done.key);
        } catch (error) {
          toastFailure(error, "Couldn’t revoke the key");
        } finally {
          setBusy(false);
        }
      }}
    />
  );
}
