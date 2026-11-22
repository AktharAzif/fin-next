// Staff · Role (AdminRoleEditor, a new board mirroring the dashboard's RoleEditor with the staff
// catalogue; spec 02 §8.1, §8.3, §8.4, §10.7, §15.3): a custom staff role's name, description and
// permissions; a new role (`/staff/roles/new`, `?from=` to duplicate); or a prebuilt role,
// read-only. Needs are ticked with what needs them; Admin-only permissions and those the member of
// staff lacks are locked with the reason. Saving asks "Confirm it's you" for its intent; a stale
// version is refused; a role deleted meanwhile is read again and shown as not found. Read-only
// without `staffRoles.manage`. The server decides; this only asks.
//
// @pendingDesign UR-16: AdminRoleEditor has no board yet ([UI-04]); this is composed from @fin/ui's
// controls and tokens after the dashboard's RoleEditor board, and enters the manifest as `new`.
import type { StaffViewer } from "@fin/app-contracts";
import { RouterLink, useFin } from "@fin/frame";
import { CopyIcon } from "@fin/icons";
import {
  Badge,
  Button,
  buttonClasses,
  Checkbox,
  ErrorState,
  Field,
  InlineAlert,
  Input,
  PageHeader,
  SkeletonSection,
  Textarea,
  toast,
} from "@fin/ui";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { withStepUpSubject } from "../step-up/reasons.ts";
import { createStaffRole, type StaffRoleRow, saveStaffRole } from "./contracts.ts";
import {
  actorOf,
  CATALOGUE,
  countLine,
  type Draft,
  draftProblems,
  duplicateHref,
  givableCopy,
  groupShort,
  groupState,
  holdersText,
  lockReason,
  MANAGE,
  NO_MANAGE,
  normalised,
  type Permission,
  problemSentence,
  READ_ONLY_NOTICE,
  roleHref,
  toggle,
  toggleGroup,
  toPermissions,
  whySaveIsOff,
} from "./editor.ts";
import type { EditorData } from "./load.ts";
import { roleActionError } from "./messages.ts";

const CRUMBS = [
  { label: "Staff", href: "/staff" },
  { label: "Roles", href: "/staff/roles" },
];

/** The editor before its first answer: the header and the sections' shapes, never a spinner. */
export function RoleEditorSkeleton() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title="Role" breadcrumbs={CRUMBS} linkAs={RouterLink} />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-8">
          <SkeletonSection label="role details" rows={2} />
          <SkeletonSection label="permissions" rows={6} />
        </div>
        <SkeletonSection label="role summary" rows={5} />
      </div>
    </div>
  );
}

export function RoleEditorPage(props: {
  data: EditorData;
  roleKey: string;
  from: string | undefined;
}) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const { data } = props;
  if (data.kind === "notAllowed") return null;
  if (data.kind === "notFound") {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Role" breadcrumbs={CRUMBS} linkAs={RouterLink} />
        <ErrorState
          size="page"
          headingLevel={2}
          title="This role doesn’t exist"
          description="It may have been deleted, or the link is wrong."
          action={
            <RouterLink href="/staff/roles" className={buttonClasses("secondary", "md")}>
              Back to roles
            </RouterLink>
          }
        />
      </div>
    );
  }
  if (data.kind === "failed") {
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Role" breadcrumbs={CRUMBS} linkAs={RouterLink} />
        <ErrorState
          size="page"
          headingLevel={2}
          title="Couldn’t load this role"
          description={
            data.offline
              ? "Check your connection and try again."
              : "Something went wrong on our side. Try again in a moment."
          }
          {...(data.requestId === null ? {} : { requestId: data.requestId })}
          retrying={retrying}
          onRetry={async () => {
            setRetrying(true);
            try {
              await router.invalidate();
            } finally {
              setRetrying(false);
            }
          }}
        />
      </div>
    );
  }
  const isNew = props.roleKey === "new";
  const taken = data.roles
    .filter((role) => !role.builtIn && role.key !== (isNew ? "" : props.roleKey))
    .map((role) => role.label);
  // Keyed by the role and its source, not its version: a save's own reload brings a new version,
  // and the editor takes it in place, so "Saved" stays until the draft next changes.
  return (
    <Editor
      key={`${props.roleKey}:${props.from ?? ""}`}
      isNew={isNew}
      role={data.role}
      takenNames={taken}
    />
  );
}

/** A saved role's draft: its name, description and permissions as the server holds them. */
function savedDraft(role: StaffRoleRow | null): Draft {
  return {
    name: role?.label ?? "",
    description: role?.description ?? "",
    permissions: toPermissions(role?.permissions ?? []),
  };
}

function Editor(props: { isNew: boolean; role: StaffRoleRow | null; takenNames: string[] }) {
  const fin = useFin<StaffViewer>();
  const navigate = useNavigate();
  const router = useRouter();
  const viewer = fin.viewer.get();
  const { role, isNew } = props;
  const actorNow = viewer?.state === "ok" ? actorOf(viewer) : null;
  const actor = toPermissions(actorNow?.permissions ?? []);
  const manage = actorNow?.permissions.has(MANAGE) === true;
  const prebuilt = !isNew && role?.builtIn === true;
  const outranked =
    !isNew && !prebuilt && role?.permissions.some((p) => !actor.has(p as Permission)) === true;
  const readOnly = prebuilt || !manage || outranked;
  const [draft, setDraft] = useState<Draft>(() =>
    isNew
      ? {
          name: role === null ? "" : `${role.label} copy`.slice(0, 40),
          description: role === null || role.builtIn ? "" : role.description,
          // A duplicate keeps only what this member of staff may give, so it can always be saved.
          permissions: givableCopy(role?.permissions ?? [], actor),
        }
      : savedDraft(role),
  );
  // What a duplicate could not keep, said once beside the summary.
  const [leftOut] = useState(
    () =>
      isNew &&
      role !== null &&
      [...toPermissions(role.permissions)].some((key) => !draft.permissions.has(key)),
  );
  // The version the draft builds on, which a save sends: the one it was read at, then the one this
  // editor's own save made. A reload's newer version is taken only with the draft rebuilt from it,
  // so a save never claims a version whose contents the draft did not take in (§8.4's conflict).
  const [base, setBase] = useState(role?.version ?? null);
  const [drawn, setDrawn] = useState(role?.version ?? null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  if (!isNew && role !== null && role.version !== drawn) {
    setDrawn(role.version);
    if (state === "saved") {
      setDraft(savedDraft(role));
      setBase(role.version);
    }
  }
  const [failed, setFailed] = useState<string | null>(null);
  const [serverFields, setServerFields] = useState<{ name?: string; description?: string }>({});
  const [touched, setTouched] = useState(false);
  const edit = (change: (d: Draft) => Draft) => {
    setDraft(change);
    setServerFields({});
    setState((s) => (s === "saved" ? "idle" : s));
  };
  const problems = readOnly ? [] : draftProblems(draft, actor, props.takenNames);
  const why = whySaveIsOff(problems, draft.name);
  const nameProblem =
    serverFields.name ??
    (touched
      ? (problems
          .filter((p) => p !== "description")
          .map(problemSentence)
          .find((s) => s !== null) ?? null)
      : null);
  const descriptionProblem =
    serverFields.description ??
    (touched && problems.includes("description") ? problemSentence("description") : null);
  const count = draft.permissions.size;
  const title = isNew ? "New role" : (role?.label ?? "Role");
  const givable = (key: Permission) => lockReason(key, actor) === null;
  const busy = state === "saving";

  const save = async () => {
    setTouched(true);
    if (problems.length > 0) return;
    setState("saving");
    setFailed(null);
    const body = {
      name: normalised(draft.name),
      description: normalised(draft.description),
      permissions: [...draft.permissions],
    };
    try {
      if (isNew) {
        const created = await withStepUpSubject({ role: body.name }, () =>
          fin.api(createStaffRole, body),
        );
        toast.success(`${body.name} was created`);
        await navigate({ href: roleHref(created.roleId), replace: true });
        return;
      }
      if (role === null || role.builtIn || base === null) return;
      // The holders the editor counts: a save that adds a permission raises exactly those.
      const saved = await withStepUpSubject({ role: body.name }, () =>
        fin.api(saveStaffRole, {
          roleId: role.key,
          ...body,
          version: base,
          holders: [...role.holderIds],
        }),
      );
      setBase(saved.version);
      setState("saved");
      await router.invalidate();
    } catch (error) {
      setState("idle");
      const refused = roleActionError(error, "edit");
      if (refused.stale === "gone") {
        // Deleted meanwhile: read again, the page says this role doesn't exist.
        await router.invalidate();
        return;
      }
      setServerFields(refused.fields);
      setFailed(refused.message);
    }
  };

  const meta = prebuilt ? <Badge variant="secondary">Prebuilt</Badge> : undefined;
  const notice = prebuilt ? (
    <InlineAlert tone="info" title="Prebuilt roles can’t be changed.">
      {manage ? "Duplicate it to start a role of your own." : null}
    </InlineAlert>
  ) : outranked && manage ? (
    <InlineAlert tone="info" title="This role can do more than yours.">
      You can see it, but only someone whose role can do everything it does can change it.
    </InlineAlert>
  ) : !manage ? (
    <InlineAlert tone="info" title={READ_ONLY_NOTICE} />
  ) : null;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={title}
        breadcrumbs={CRUMBS}
        {...(meta === undefined ? {} : { meta })}
        linkAs={RouterLink}
      />
      {notice}
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-8">
          <section aria-labelledby="details-heading" className="flex flex-col gap-4">
            <h2 id="details-heading" className="m-0 text-heading text-text-primary">
              Details
            </h2>
            {prebuilt ? (
              <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-3 text-body">
                <dt className="text-text-secondary">Name</dt>
                <dd className="m-0 text-text-primary">{role?.label}</dd>
                <dt className="text-text-secondary">What it can do</dt>
                <dd className="m-0 text-text-primary">{role?.summary}</dd>
              </dl>
            ) : (
              <>
                <Field
                  label="Name"
                  readOnly={readOnly}
                  {...(nameProblem === null || nameProblem === undefined
                    ? {}
                    : { error: nameProblem })}
                >
                  <Input
                    value={draft.name}
                    placeholder="For example, Support desk"
                    maxLength={40}
                    readOnly={readOnly}
                    disabled={busy}
                    onValueChange={(name) => edit((d) => ({ ...d, name }))}
                  />
                </Field>
                <Field
                  label="Description"
                  optional
                  helper="Up to 120 characters."
                  readOnly={readOnly}
                  {...(descriptionProblem === null || descriptionProblem === undefined
                    ? {}
                    : { error: descriptionProblem })}
                >
                  <Textarea
                    value={draft.description}
                    rows={2}
                    maxLength={120}
                    readOnly={readOnly}
                    disabled={busy}
                    onChange={(event) => {
                      const description = event.currentTarget.value;
                      edit((d) => ({ ...d, description }));
                    }}
                  />
                </Field>
              </>
            )}
          </section>
          <section aria-labelledby="permissions-heading" className="flex flex-col gap-6">
            <h2 id="permissions-heading" className="m-0 text-heading text-text-primary">
              Permissions
            </h2>
            {CATALOGUE.groups.map((group) => {
              const keys = group.permissions as readonly Permission[];
              const groupNow = groupState(draft.permissions, keys);
              const held = keys.filter((key) => draft.permissions.has(key)).length;
              const anyGivable = keys.some(givable);
              return (
                <fieldset
                  key={group.key}
                  className="m-0 flex flex-col gap-3 border-0 border-t border-border p-0 pt-4"
                >
                  <legend className="sr-only">{group.label}</legend>
                  <Checkbox
                    label={<span className="text-label">{group.label}</span>}
                    description={`${held} of ${keys.length}`}
                    checked={
                      groupNow === "all" ? true : groupNow === "some" ? "indeterminate" : false
                    }
                    disabled={readOnly || busy || !anyGivable}
                    onCheckedChange={(checked) =>
                      edit((d) => ({
                        ...d,
                        permissions: toggleGroup(d.permissions, keys, checked === true, givable),
                      }))
                    }
                  />
                  <div className="flex flex-col gap-3 pl-6">
                    {keys.map((key) => {
                      const def = CATALOGUE.permissions[key];
                      // A locked permission can't be ticked; one already ticked can always be
                      // unticked, so a draft can always be brought within what the editor gives.
                      const lock = readOnly || prebuilt ? null : lockReason(key, actor);
                      return (
                        <Checkbox
                          key={key}
                          label={def.label}
                          description={lock ?? def.description}
                          checked={draft.permissions.has(key)}
                          disabled={
                            readOnly || busy || (lock !== null && !draft.permissions.has(key))
                          }
                          onCheckedChange={(checked) =>
                            edit((d) => ({
                              ...d,
                              permissions: toggle(d.permissions, key, checked === true),
                            }))
                          }
                        />
                      );
                    })}
                  </div>
                </fieldset>
              );
            })}
          </section>
        </div>
        <aside
          aria-label="Summary"
          className="flex flex-col gap-5 rounded-md border border-border bg-surface-raised p-6 lg:sticky lg:top-6"
        >
          <p className="m-0 text-label text-text-primary">{countLine(draft.name, count)}</p>
          <dl className="m-0 flex flex-col gap-2 text-body">
            {CATALOGUE.groups.map((group) => {
              const keys = group.permissions as readonly Permission[];
              const held = keys.filter((key) => draft.permissions.has(key)).length;
              return (
                <div key={group.key} className="flex items-baseline justify-between gap-4">
                  <dt className="text-text-secondary">{group.label}</dt>
                  <dd className="m-0 text-text-primary">
                    {groupShort(groupState(draft.permissions, keys), held, keys.length)}
                  </dd>
                </div>
              );
            })}
          </dl>
          {isNew || role === null ? null : (
            <p className="m-0 text-body text-text-secondary">
              {role.holders === 0
                ? "Nobody has this role."
                : `${holdersText(role.holders)} ${role.holders === 1 ? "has" : "have"} this role.`}
            </p>
          )}
          {leftOut ? (
            <InlineAlert tone="info" title="Some permissions aren’t in the copy.">
              Only the Admin role can have them, or you can’t give them, so they were left out.
            </InlineAlert>
          ) : null}
          {state === "saved" ? (
            <InlineAlert
              tone="success"
              title="Saved. Changes apply on each person’s next request."
              live="polite"
            />
          ) : null}
          {failed === null ? null : (
            <InlineAlert tone="danger" title="The role wasn’t saved" live="assertive">
              {failed}
            </InlineAlert>
          )}
          <div className="flex flex-wrap gap-2">
            {readOnly ? (
              <>
                <RouterLink href="/staff/roles" className={buttonClasses("secondary", "md")}>
                  Back to roles
                </RouterLink>
                {manage && role !== null ? (
                  <RouterLink
                    href={duplicateHref(role.key)}
                    className={buttonClasses("primary", "md")}
                  >
                    <CopyIcon />
                    Duplicate
                  </RouterLink>
                ) : null}
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  {...(busy ? { disabledReason: "Wait for this to finish." } : {})}
                  onClick={() => navigate({ href: "/staff/roles" })}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={busy}
                  {...(!manage
                    ? { disabledReason: NO_MANAGE }
                    : why !== null
                      ? { disabledReason: why }
                      : {})}
                  onClick={save}
                >
                  {isNew ? "Create role" : "Save"}
                </Button>
              </>
            )}
          </div>
          {!readOnly && why !== null ? (
            <p className="m-0 text-caption text-text-tertiary">{why}</p>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
