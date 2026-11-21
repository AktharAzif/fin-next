// Settings · Role (RoleEditor board; spec 02 §8.1, §8.4, §15.2, §15.2.1): a custom role's name,
// description and permissions, a new role (`/settings/roles/new`, `?from=` to duplicate), or a
// built-in role read-only. Needs are ticked with what needs them; permissions the editor cannot
// give are locked with the reason. Saving asks for its intent; a stale version is refused. A
// custom role's menu has "View in audit log" with `auditLog.read`.
import type { ConsoleViewer } from "@fin/app-contracts";
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
  SkeletonPage,
  SkeletonSection,
  Textarea,
  toast,
} from "@fin/ui";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { failureSentence, toldElsewhere } from "../../../api/actions.ts";
import {
  createRole,
  type RoleDetail,
  roleDetail,
  roles as rolesContract,
  saveRole,
} from "../../../api/contracts/roles.ts";
import { codeOf, failureOf, problemField } from "../../../api/failures.ts";
import { useResource } from "../../../api/resource.ts";
import {
  QuietArrowLink,
  ROLE_REASON,
  SectionFailure,
  useSignedIn,
} from "../../../components/page.tsx";
import {
  CATALOGUE,
  countLine,
  type Draft,
  draftProblems,
  givableCopy,
  groupShort,
  groupState,
  lockReason,
  type Permission,
  problemSentence,
  toggle,
  toggleGroup,
  toPermissions,
  whySaveIsOff,
} from "../../../components/role-editor.ts";
import { holdersText, roleHref } from "../../../format/text.ts";
import { withReasonValues } from "../../../step-up/reasons.ts";

export const Route = createFileRoute("/settings/roles/$roleKey")({
  staticData: { frame: "app", navId: "settings", pageName: "Settings", needs: ["member.read"] },
  validateSearch: (search: Record<string, unknown>): { from?: string } =>
    typeof search.from === "string" && search.from !== "" ? { from: search.from.slice(0, 80) } : {},
  pendingComponent: () => <SkeletonPage label="this role" rows={8} />,
  component: RoleEditorPage,
});

const CRUMBS = [
  { label: "Settings", href: "/settings/organisation" },
  { label: "Roles", href: "/settings/roles" },
];

function EditorLoading({ title }: { title: string }) {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader title={title} breadcrumbs={CRUMBS} linkAs={RouterLink} />
      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-8">
          <SkeletonSection label="customer permissions" rows={4} />
          <SkeletonSection label="money movement permissions" rows={4} />
        </div>
        <SkeletonSection label="role summary" rows={5} />
      </div>
    </div>
  );
}

function RoleEditorPage() {
  const fin = useFin<ConsoleViewer>();
  const { roleKey } = Route.useParams();
  const { from } = Route.useSearch();
  const signedIn = useSignedIn();
  const orgId = signedIn?.viewer.currentOrgId ?? "";
  const isNew = roleKey === "new";
  const sourceKey = isNew ? (from ?? null) : roleKey;
  const source = useResource(
    `role:${orgId}:${sourceKey ?? ""}`,
    (signal) => fin.api(roleDetail, { roleKey: sourceKey ?? "" }, { signal }),
    { enabled: sourceKey !== null },
  );
  const names = useResource(`roles:${orgId}`, (signal) => fin.api(rolesContract, {}, { signal }));

  if (sourceKey !== null && source.status === "error" && source.data === null) {
    const missing = failureOf(source.error) === "notFound";
    return (
      <div className="flex flex-col gap-8">
        <PageHeader title="Role" breadcrumbs={CRUMBS} linkAs={RouterLink} />
        {missing ? (
          <ErrorState
            size="page"
            headingLevel={2}
            title="This role doesn’t exist"
            description="It may have been deleted, or the link is wrong."
            action={
              <RouterLink href="/settings/roles" className={buttonClasses("secondary", "md")}>
                Back to roles
              </RouterLink>
            }
          />
        ) : (
          <SectionFailure
            size="page"
            title="Couldn’t load this role"
            error={source.error}
            onRetry={source.reload}
          />
        )}
      </div>
    );
  }
  if (sourceKey !== null && source.data === null) {
    return <EditorLoading title={isNew ? "New role" : "Role"} />;
  }

  const detail = source.data;
  const taken = (names.data?.roles ?? [])
    .filter((role) => !role.builtIn && role.roleKey !== (isNew ? "" : roleKey))
    .map((role) => role.label);
  // Keyed by the role, not its version: the save's own reload brings a new version, and the editor
  // takes it in place rather than starting again, so "saved" stays until the draft next changes.
  return (
    <Editor
      key={`${roleKey}:${from ?? ""}`}
      isNew={isNew}
      detail={detail}
      takenNames={taken}
      onSaved={source.reload}
    />
  );
}

/** A saved role's draft: its name, description and permissions as the server holds them. */
function savedDraft(detail: RoleDetail | null): Draft {
  return {
    name: detail?.label ?? "",
    description: detail?.description ?? "",
    permissions: toPermissions(detail?.permissions ?? []),
  };
}

function Editor(props: {
  isNew: boolean;
  detail: RoleDetail | null;
  takenNames: string[];
  onSaved: () => Promise<void>;
}) {
  const fin = useFin<ConsoleViewer>();
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const { detail, isNew } = props;
  const builtIn = !isNew && detail?.builtIn === true;
  const manage = signedIn?.can("role.manage") === true;
  const auditLink = signedIn?.can("auditLog.read") === true;
  const actor = toPermissions(signedIn?.viewer.permissions ?? []);
  const outranked =
    !isNew && !builtIn && detail?.permissions.some((p) => !actor.has(p as Permission)) === true;
  const readOnly = builtIn || !manage || outranked;
  const [draft, setDraft] = useState<Draft>(() =>
    isNew
      ? {
          name: detail === null ? "" : `${detail.label} copy`,
          description: detail?.description ?? "",
          // A duplicate keeps only what this editor may give, so it can always be saved.
          permissions: givableCopy(detail?.permissions ?? [], actor),
        }
      : savedDraft(detail),
  );
  // What a duplicate could not keep, said once beside the summary.
  const [leftOut] = useState(
    () =>
      isNew &&
      detail !== null &&
      [...toPermissions(detail.permissions)].some((key) => !draft.permissions.has(key)),
  );
  // The version the draft was read at. A newer one (the save's own reload) is taken in place. While
  // nothing has changed since the save, the draft becomes what the server now holds and "saved"
  // stays on screen; a change made while the reload was on its way is kept, unsaved, on top of it.
  const [version, setVersion] = useState(detail?.version ?? null);
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  if (!isNew && detail !== null && detail.version !== version) {
    setVersion(detail.version);
    if (state === "saved") setDraft(savedDraft(detail));
  }
  const [failed, setFailed] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  // Every change to the draft goes through here: a change made after a save is not saved yet.
  const edit = (change: (d: Draft) => Draft) => {
    setDraft(change);
    setState((s) => (s === "saved" ? "idle" : s));
  };
  const problems = readOnly ? [] : draftProblems(draft, actor, props.takenNames);
  const why = whySaveIsOff(problems, draft.name);
  const fieldProblem = problems.map(problemSentence).find((s) => s !== null) ?? null;
  const count = draft.permissions.size;
  const title = isNew ? "New role" : (detail?.label ?? "Role");
  const givable = (key: Permission) => lockReason(key, actor) === null;

  const save = async () => {
    setTouched(true);
    if (problems.length > 0) return;
    setState("saving");
    setFailed(null);
    const body = {
      name: draft.name.trim().replace(/\s+/g, " "),
      description: draft.description.trim().replace(/\s+/g, " "),
      permissions: [...draft.permissions],
    };
    try {
      if (isNew) {
        const created = await withReasonValues("role.create", { role: body.name }, () =>
          fin.api(createRole, body),
        );
        toast.success(`${body.name} was created`);
        await navigate({ href: roleHref(created.roleId), replace: true });
        return;
      }
      if (detail === null || detail.roleId === null || detail.version === null) return;
      await withReasonValues("role.update", { role: body.name }, () =>
        fin.api(saveRole, {
          roleId: detail.roleId as string,
          ...body,
          version: detail.version as number,
        }),
      );
      setState("saved");
      await props.onSaved();
    } catch (error) {
      setState("idle");
      if (toldElsewhere(error)) return;
      const code = codeOf(error);
      if (code === "conflict")
        setFailed(
          "Someone else changed this role meanwhile. Reload the page to see their changes.",
        );
      else if (code === "giving_refused" || code === "outranked")
        setFailed(
          problemField(error, "problem") === "beyond" || code === "outranked"
            ? "This role can do more than yours, so you can’t save it."
            : "You can’t save this role.",
        );
      else if (code === "limit_reached")
        setFailed("This organisation has 30 roles of its own. Delete one first.");
      else setFailed(failureSentence(error));
    }
  };

  const meta = builtIn ? <Badge variant="secondary">Built in</Badge> : undefined;
  const busy = state === "saving";

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={title}
        breadcrumbs={CRUMBS}
        {...(meta === undefined ? {} : { meta })}
        linkAs={RouterLink}
      />
      {builtIn ? (
        <InlineAlert tone="info" title="Built-in roles can’t be changed.">
          Duplicate it to start a role of your own.
        </InlineAlert>
      ) : outranked && manage ? (
        <InlineAlert tone="info" title="This role can do more than yours.">
          You can see it, but only someone whose role can do everything it does can change it.
        </InlineAlert>
      ) : !manage ? (
        <InlineAlert
          tone="info"
          title="You can see this role. Changing it needs Create and change roles."
        />
      ) : null}
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-8">
          <section aria-labelledby="details-heading" className="flex flex-col gap-4">
            <h2 id="details-heading" className="m-0 text-heading text-text-primary">
              Details
            </h2>
            {builtIn ? (
              <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-8 gap-y-3 text-body">
                <dt className="text-text-secondary">Name</dt>
                <dd className="m-0 text-text-primary">{detail?.label}</dd>
                <dt className="text-text-secondary">What it can do</dt>
                <dd className="m-0 text-text-primary">
                  {CATALOGUE.builtIns.find((role) => role.key === detail?.roleKey)?.summary ?? ""}
                </dd>
              </dl>
            ) : (
              <>
                <Field
                  label="Name"
                  readOnly={readOnly}
                  {...(touched && fieldProblem !== null ? { error: fieldProblem } : {})}
                >
                  <Input
                    value={draft.name}
                    placeholder="For example, Support"
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
                      const lock = readOnly ? null : lockReason(key, actor);
                      return (
                        <Checkbox
                          key={key}
                          label={
                            <span className="inline-flex flex-wrap items-center gap-2">
                              {def.label}
                              {def.sandboxOnly ? (
                                <Badge variant="outline" size="sm">
                                  Sandbox
                                </Badge>
                              ) : null}
                            </span>
                          }
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
          {isNew || detail === null ? null : (
            <p className="m-0 text-body text-text-secondary">
              {detail.holders === 0
                ? "Nobody has this role."
                : `${holdersText(detail.holders)} ${detail.holders === 1 ? "has" : "have"} this role.`}
            </p>
          )}
          {auditLink && !isNew && !builtIn && detail?.roleId ? (
            <QuietArrowLink
              href={`/audit-log?${new URLSearchParams({ target: detail.roleId }).toString()}`}
            >
              View in audit log
            </QuietArrowLink>
          ) : null}
          {leftOut ? (
            <InlineAlert tone="info" title="Some permissions aren’t in the copy.">
              You can’t give them, so they were left out.
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
            {builtIn || readOnly ? (
              <>
                <RouterLink href="/settings/roles" className={buttonClasses("secondary", "md")}>
                  Back to roles
                </RouterLink>
                {manage && detail !== null ? (
                  <RouterLink
                    href={`/settings/roles/new?${new URLSearchParams({ from: detail.roleKey }).toString()}`}
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
                  onClick={() => navigate({ href: "/settings/roles" })}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  loading={busy}
                  {...(!manage
                    ? { disabledReason: ROLE_REASON }
                    : why !== null
                      ? { disabledReason: why }
                      : {})}
                  onClick={save}
                >
                  Save
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
