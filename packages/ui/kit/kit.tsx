// The kit page (test build only): every wave 0 and wave 1 component of @fin/ui in its states, live,
// plus the probes AC-P0-16 reads. Every section carries data-fin-kit and a data-kit name the
// Playwright spec finds it by. Sample data uses example.com addresses only.
import {
  ArrowRightIcon,
  BankIcon,
  CaretLeftIcon,
  DownloadSimpleIcon,
  GearSixIcon,
  KeyIcon,
  PlusIcon,
  ShieldCheckIcon,
  SignOutIcon,
  TrashIcon,
  UserCircleIcon,
} from "@fin/icons";
import { type ReactNode, useEffect, useState } from "react";
import {
  AuthCard,
  Avatar,
  Badge,
  Button,
  Checkbox,
  ConfirmDialog,
  CopyField,
  DropdownMenu,
  EmptyState,
  ErrorState,
  FailureReporterProvider,
  Field,
  IconButton,
  InlineAlert,
  Input,
  Logo,
  MenuGroup,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  Modal,
  OTPInput,
  type OTPStatus,
  PageHeader,
  SecretReveal,
  Skeleton,
  SkeletonPage,
  SkeletonSection,
  SkeletonText,
  Spinner,
  StatusBadge,
  Switch,
  Tab,
  TabLink,
  TabLinks,
  Table,
  TableAmount,
  type TableColumn,
  TableId,
  type TableSort,
  TabPanel,
  Tabs,
  TabsList,
  Textarea,
  TextButton,
  Toaster,
  Tooltip,
  TooltipProvider,
  toast,
} from "../src/index.ts";
import { PolicyProbes } from "../src/kit.tsx";

function Section(props: { name: string; title: string; children: ReactNode }) {
  return (
    <section
      data-fin-kit=""
      data-kit={props.name}
      aria-labelledby={`kit-${props.name}`}
      className="flex flex-col gap-4"
    >
      <h2 id={`kit-${props.name}`} className="m-0 text-heading">
        {props.title}
      </h2>
      <div className="flex min-w-0 flex-col gap-4 rounded-md border border-transparent bg-surface p-4 shadow-ring sm:p-6">
        {props.children}
      </div>
    </section>
  );
}

function Row(props: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{props.children}</div>;
}

// Sample values shaped like secrets are joined at run time, so the source holds no string the
// public-safety check would take for a credential (CONTRIBUTING, "Tests that need a
// secret-shaped value").
const SAMPLE_SIGNING_SECRET = ["whsec", "kit", "sample", "only"].join("_");
const SAMPLE_CLIENT_SECRET = ["sk", "sandbox", "kit", "sample"].join("_");

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Member = {
  id: string;
  name: string;
  email: string;
  role: string;
  amount: number;
  status: "Active" | "Invited";
};
const MEMBERS: Member[] = [
  {
    id: "mem_01",
    name: "Maya Rivera",
    email: "maya@example.com",
    role: "Super admin",
    amount: 1250000,
    status: "Active",
  },
  {
    id: "mem_02",
    name: "Daniel Okoye",
    email: "daniel@example.com",
    role: "Admin",
    amount: 98000,
    status: "Active",
  },
  {
    id: "mem_03",
    name: "Priya Shah",
    email: "priya@example.com",
    role: "Developer",
    amount: 500,
    status: "Invited",
  },
  {
    id: "mem_04",
    name: "Lena Fischer",
    email: "lena@example.org",
    role: "Compliance",
    amount: 3000000,
    status: "Active",
  },
];

const COLUMNS: TableColumn<Member>[] = [
  {
    id: "name",
    header: "Name",
    kind: "text",
    sortable: true,
    cell: (m) => m.name,
    leading: (m) => <Avatar name={m.name} size={24} />,
  },
  {
    id: "email",
    header: "Email",
    cell: (m) => <span className="text-text-secondary">{m.email}</span>,
  },
  {
    id: "status",
    header: "Status",
    kind: "status",
    cell: (m) => (
      <StatusBadge tone={m.status === "Active" ? "success" : "info"}>{m.status}</StatusBadge>
    ),
  },
  {
    id: "id",
    header: "ID",
    kind: "id",
    hideBelow: "xl",
    cell: (m) => <TableId value={`${m.id}_7f3a9c21d4e8b6a0`} label="Member ID" />,
  },
  {
    id: "amount",
    header: "Limit",
    kind: "amount",
    sortable: true,
    cell: (m) => <TableAmount minor={m.amount} currency="USD" />,
  },
];

function TableDemo() {
  const [sort, setSort] = useState<TableSort>({ columnId: "name", direction: "ascending" });
  const [opened, setOpened] = useState<string | null>(null);
  const [status, setStatus] = useState<"ready" | "loading" | "error" | "empty">("ready");
  const rows = [...MEMBERS].sort((a, b) => {
    const dir = sort.direction === "ascending" ? 1 : -1;
    return sort.columnId === "amount"
      ? (a.amount - b.amount) * dir
      : a.name.localeCompare(b.name) * dir;
  });
  return (
    <>
      <Row>
        {(["ready", "loading", "error", "empty"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === status ? "primary" : "secondary"}
            onClick={() => setStatus(s)}
          >
            {`Show ${s}`}
          </Button>
        ))}
        <span data-kit="table-opened" className="text-caption text-text-tertiary">
          {opened === null ? "No row opened" : `Opened ${opened}`}
        </span>
      </Row>
      <Table
        caption="Team members"
        noun={{ singular: "member", plural: "members" }}
        columns={COLUMNS}
        rows={status === "ready" ? rows : []}
        status={status === "empty" ? "ready" : status}
        error={{ onRetry: () => setStatus("ready"), requestId: "req_7d1c9a" }}
        getRowId={(m) => m.id}
        getRowLabel={(m) => `${m.name}, ${m.role}`}
        getRowHref={(m) => `?view=${m.id}`}
        onRowClick={(m) => setOpened(m.id)}
        {...(opened === null ? {} : { activeRowId: opened })}
        sort={sort}
        onSortChange={setSort}
        loadingRows={4}
        empty={
          <EmptyState
            variant="first-use"
            title="You’re the only member"
            description="Invite your team to share access."
          />
        }
        pagination={{ page: 1, pageCount: 3, total: 41, pageSize: 20, onPageChange: () => {} }}
      />
    </>
  );
}

function OtpDemo() {
  const [status, setStatus] = useState<OTPStatus>("idle");
  const [handed, setHanded] = useState<string[]>([]);
  const [sent, setSent] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <OTPInput
        label="Verification code"
        description="We sent a 6-digit code to maya@example.com."
        status={status}
        attemptsLeft={2}
        onComplete={(code) => {
          setHanded((h) => [...h, code]);
          setStatus(code === "123456" ? "success" : "invalid");
        }}
        onValueChange={() => setStatus((s) => (s === "invalid" ? "idle" : s))}
        onResend={() => wait(300)}
        resendCooldown={30}
        initialCooldown={0}
      />
      <span data-kit="otp-handed" className="text-caption text-text-tertiary">
        {handed.join(",")}
      </span>
      {/* The code runs out while the person is elsewhere on the page (here, on this button). */}
      <Button
        variant="secondary"
        size="sm"
        data-kit="otp-expire"
        onClick={() => setStatus("expired")}
      >
        Let the code expire
      </Button>
      {/* Mounts expired, and its resend is refused (as a rate limit would be). */}
      <OTPInput
        label="Emailed code"
        length={8}
        status="expired"
        onResend={async () => {
          await wait(100);
          throw new Error("kit: resend refused");
        }}
        resendCooldown={60}
        initialCooldown={0}
      />
      {/* Mounts with the cooldown running, as a sign-in code page does when it opens (R-12). */}
      <Button variant="secondary" size="sm" data-kit="otp-mount" onClick={() => setSent(true)}>
        Show a code just sent
      </Button>
      {sent ? (
        <OTPInput label="Sign-in code" length={8} onResend={() => wait(300)} resendCooldown={45} />
      ) : null}
    </div>
  );
}

/** A secret shown in place, and another key made in the same place: each needs its own tick. */
function SecretRevealDemo() {
  const [round, setRound] = useState(1);
  return (
    <div className="flex flex-col gap-3">
      <SecretReveal
        status="ready"
        environment="Sandbox"
        clientId="cli_7f3a9c21d4e8"
        secret={round === 1 ? SAMPLE_CLIENT_SECRET : `${SAMPLE_CLIENT_SECRET}_${round}`}
      />
      <Button
        variant="secondary"
        size="sm"
        data-kit="another-key"
        onClick={() => setRound((r) => r + 1)}
      >
        Make another sample key
      </Button>
    </div>
  );
}

function OverlayDemo() {
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(0);
  const [typedConfirm, setTypedConfirm] = useState(false);
  const [typedBusy, setTypedBusy] = useState(false);
  const [typedDeleted, setTypedDeleted] = useState<string[]>([]);
  return (
    <Row>
      <Button variant="secondary" onClick={() => setModal(true)}>
        Create API key
      </Button>
      <Button variant="danger" onClick={() => setConfirm(true)}>
        Delete webhook
      </Button>
      <span
        data-kit="deleted"
        className="text-caption text-text-tertiary"
      >{`Deleted ${deleted}`}</span>
      <Button variant="danger" onClick={() => setTypedConfirm(true)}>
        Delete Production webhook
      </Button>
      <span data-kit="deleted-typed" className="text-caption text-text-tertiary">
        {typedDeleted.join(",")}
      </span>
      {/* A typed confirmation, closed by the page after its request, as screens do. */}
      <ConfirmDialog
        open={typedConfirm}
        onOpenChange={setTypedConfirm}
        title="Delete this Production webhook?"
        description="Events stop going to https://example.com/hooks. This can’t be undone."
        confirmLabel="Delete webhook"
        tone="danger"
        confirmText="acme-hooks"
        cue="This changes Production."
        busy={typedBusy}
        onConfirm={async () => {
          setTypedBusy(true);
          await wait(100);
          setTypedBusy(false);
          setTypedDeleted((d) => [...d, "acme-hooks"]);
          setTypedConfirm(false);
        }}
      />
      <Modal
        open={modal}
        onOpenChange={setModal}
        title="Create API key"
        description="The key is shown once, after you create it."
        footer={
          <>
            <Button variant="secondary" onClick={() => setModal(false)}>
              Cancel
            </Button>
            <Button onClick={() => setModal(false)}>Create key</Button>
          </>
        }
      >
        <Field label="Key name" helper="Only you see it, in this list.">
          <Input placeholder="Production server" />
        </Field>
      </Modal>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete this webhook?"
        description="Events stop going to https://example.com/hooks. This can’t be undone."
        confirmLabel="Delete webhook"
        tone="danger"
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          await wait(200);
          setBusy(false);
          setDeleted((d) => d + 1);
          setConfirm(false);
        }}
      />
    </Row>
  );
}

export function Kit(props: { onReady: () => void }) {
  useEffect(() => props.onReady(), [props]);
  const [tab, setTab] = useState("overview");
  const [checked, setChecked] = useState<boolean | "indeterminate">("indeterminate");
  const [theme, setTheme] = useState("system");
  return (
    <FailureReporterProvider report={() => document.body.setAttribute("data-reported", "")}>
      <TooltipProvider delay={300}>
        <div className="mx-auto flex max-w-drawer-l flex-col gap-12 p-4 sm:p-8">
          <PageHeader
            title="UI kit"
            description="Every @fin/ui component of waves 0 and 1, live."
            breadcrumbs={[{ label: "Tests", href: "#" }]}
            meta={<Badge>Sample data</Badge>}
            actions={
              <Button variant="secondary" leadingIcon={<DownloadSimpleIcon />}>
                Export CSV
              </Button>
            }
            primaryAction={<Button leadingIcon={<PlusIcon />}>New transfer</Button>}
          />

          <Section name="buttons" title="Button and IconButton">
            {(["primary", "secondary", "ghost", "danger"] as const).map((variant) => (
              <Row key={variant}>
                <Button variant={variant}>Continue</Button>
                <Button variant={variant} disabled>
                  Disabled
                </Button>
                <Button variant={variant} loading>
                  Loading
                </Button>
                <IconButton variant={variant} label={`Add ${variant}`} icon={<PlusIcon />} />
              </Row>
            ))}
            <Row>
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
              <Button
                data-kit="pending-button"
                onClick={() => wait(400)}
                trailingIcon={<ArrowRightIcon />}
              >
                Save changes
              </Button>
              <Button
                data-kit="throwing-button"
                variant="secondary"
                onClick={() => {
                  throw new Error("kit failure");
                }}
              >
                Run failing action
              </Button>
              <Button
                data-kit="reason-button"
                disabledReason="Production isn’t enabled for your account yet."
              >
                Create Production API key
              </Button>
            </Row>
            <Row>
              <IconButton
                data-kit="edge-toggle"
                variant="secondary"
                size="xs"
                className="rounded-full"
                label="Collapse sidebar"
                aria-expanded
                icon={<CaretLeftIcon size={12} />}
                tooltipSide="right"
              />
              <IconButton size="sm" label="Copy transaction ID" icon={<KeyIcon />} />
              <IconButton size="lg" label="Delete key" variant="danger" icon={<TrashIcon />} />
              <Spinner />
              <Spinner size={24} />
              <span className="text-body">
                Couldn’t load rails.{" "}
                <TextButton
                  data-kit="throwing-text-button"
                  onClick={async () => {
                    await wait(50);
                    throw new Error("kit failure");
                  }}
                >
                  Retry
                </TextButton>
              </span>
            </Row>
          </Section>

          <Section name="tooltip" title="Tooltip">
            <Row>
              <Tooltip content="Opens the docs in a new tab">
                <Button variant="secondary">Read webhook docs</Button>
              </Tooltip>
              <Tooltip content={SAMPLE_SIGNING_SECRET} mono>
                <Button variant="ghost">Signing secret</Button>
              </Tooltip>
            </Row>
          </Section>

          <Section name="fields" title="Field, Input and Textarea">
            <div className="grid max-w-form gap-6">
              <Field label="Work email" helper="We send sign-in links here.">
                <Input type="email" placeholder="name@example.com" />
              </Field>
              <Field
                label="Endpoint URL"
                error="Enter an https:// URL."
                helper="Fin posts events here."
              >
                <Input defaultValue="http://example.com/hooks" />
              </Field>
              <Field label="Description" optional>
                <Textarea placeholder="What this key is for" />
              </Field>
              <Field label="Client ID" readOnly>
                <Input defaultValue="cli_7f3a9c21d4e8" />
              </Field>
              <Field label="Organisation" disabled>
                <Input defaultValue="Acme Remit" />
              </Field>
            </div>
          </Section>

          <Section name="alerts" title="InlineAlert">
            <InlineAlert
              tone="info"
              title="You have 2 invitations waiting."
              action={
                <Button size="sm" variant="secondary">
                  View invitations
                </Button>
              }
            />
            <InlineAlert tone="success" title="Webhook created">
              Events start arriving within a minute.
            </InlineAlert>
            <InlineAlert tone="warning" title="This rate expired.">
              Get a new rate to continue.
            </InlineAlert>
            <InlineAlert tone="danger" title="That didn’t work." onDismiss={() => {}}>
              Try again in a moment.
            </InlineAlert>
            <InlineAlert tone="highlight" title="Copy your secret now">
              You won’t be able to see it again.
            </InlineAlert>
          </Section>

          <Section name="brand" title="Logo, Badge, StatusBadge and Avatar">
            <Row>
              <Logo />
              <Logo variant="mark" />
              <Logo variant="mark" height={18} />
            </Row>
            <Row>
              <Badge>Sample data</Badge>
              <Badge variant="secondary">Sandbox</Badge>
              <Badge variant="default">Default</Badge>
              <Badge variant="destructive">Destructive</Badge>
              <Badge color="blue">ACH</Badge>
              <Badge color="purple" size="sm">
                Polygon
              </Badge>
            </Row>
            <Row>
              <StatusBadge tone="success">Approved</StatusBadge>
              <StatusBadge tone="info">In review</StatusBadge>
              <StatusBadge tone="warning">Action required</StatusBadge>
              <StatusBadge tone="danger">Rejected</StatusBadge>
              <StatusBadge tone="neutral">Cancelled</StatusBadge>
              <StatusBadge tone="success" presentation="dot">
                Completed
              </StatusBadge>
            </Row>
            <Row>
              <Avatar name="Maya Rivera" size={40} country="US" />
              <Avatar name="" email="maya@example.com" size={32} />
              <Avatar name="Acme Remit" kind="business" size={24} />
              <Avatar name="Lena Fischer" size={20} />
            </Row>
          </Section>

          <Section name="skeletons" title="The Skeleton family">
            <Row>
              <Skeleton shape="text" className="w-40" />
              <Skeleton shape="badge" />
              <Skeleton shape="control" />
              <Skeleton shape="circle" />
            </Row>
            <SkeletonText lines={3} />
            <SkeletonSection label="beneficiaries" rows={2} />
            <SkeletonPage label="transactions" toolbar rows={2} />
          </Section>

          <Section name="menu" title="DropdownMenu">
            <Row>
              <DropdownMenu
                trigger={
                  <Button variant="secondary" data-kit="menu-trigger">
                    Actions
                  </Button>
                }
                className="w-72"
              >
                <MenuGroup label="Maya Rivera">
                  <MenuItem icon={<ShieldCheckIcon />} caption="Passkeys and second factors">
                    Account security
                  </MenuItem>
                  <MenuItem icon={<GearSixIcon />} onSelect={() => wait(300)}>
                    Save settings
                  </MenuItem>
                </MenuGroup>
                <MenuSeparator />
                <MenuRadioGroup
                  label="Theme"
                  value={theme}
                  onValueChange={(v) => setTheme(String(v))}
                >
                  <MenuRadioItem value="light">Light</MenuRadioItem>
                  <MenuRadioItem value="dark">Dark</MenuRadioItem>
                  <MenuRadioItem value="system">System</MenuRadioItem>
                </MenuRadioGroup>
                <MenuSeparator />
                <MenuItem icon={<TrashIcon />} destructive>
                  Delete webhook
                </MenuItem>
                <MenuItem icon={<SignOutIcon />}>Log out</MenuItem>
              </DropdownMenu>
              <span data-kit="theme-choice" className="text-caption text-text-tertiary">
                {theme}
              </span>
            </Row>
          </Section>

          <Section name="tabs" title="Tabs and TabLinks">
            <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
              <TabsList aria-label="Customer">
                <Tab value="overview">Overview</Tab>
                <Tab value="details">Details</Tab>
                <Tab value="money" count={3}>
                  Money
                </Tab>
              </TabsList>
              <TabPanel value="overview">The overview.</TabPanel>
              <TabPanel value="details">The details.</TabPanel>
              <TabPanel value="money">The money.</TabPanel>
            </Tabs>
            <TabLinks label="Settings">
              <TabLink href="#organisation" current>
                Organisation
              </TabLink>
              <TabLink href="#team">Team</TabLink>
              <TabLink href="#roles">Roles</TabLink>
            </TabLinks>
          </Section>

          <Section name="states" title="EmptyState and ErrorState">
            <EmptyState
              variant="first-use"
              title="No webhooks yet"
              description="Get notified when payments change status."
              action={<Button leadingIcon={<PlusIcon />}>Create webhook</Button>}
              docs={{ label: "Read webhook docs", href: "#docs" }}
            />
            <EmptyState
              variant="no-results"
              title="No transactions match these filters"
              filters={[{ id: "status", label: "Status: Refunded", onRemove: () => {} }]}
              onClearFilters={() => {}}
            />
            <EmptyState
              variant="no-permission"
              title="Your role (Developer) can’t view transactions"
              description="Ask an admin in your organisation."
            />
            <EmptyState
              variant="not-configured"
              title="Sandbox isn’t connected yet"
              description="Create a Sandbox API key to see data here."
            />
            <EmptyState
              variant="section"
              title="No beneficiaries for this customer."
              action={
                <Button size="sm" variant="secondary">
                  Add beneficiary
                </Button>
              }
            />
            <ErrorState
              title="Couldn’t load webhooks"
              onRetry={() => wait(300)}
              requestId="req_01HZX4K9M2"
            />
            <ErrorState size="inline" title="Couldn’t load rails" onRetry={() => {}} />
          </Section>

          <Section name="toasts" title="Toaster">
            <Row>
              <Button
                variant="secondary"
                data-kit="toast-success"
                onClick={() => toast.success("Webhook created")}
              >
                Toast success
              </Button>
              <Button
                variant="secondary"
                data-kit="toast-error"
                onClick={() =>
                  toast.error({
                    title: "Couldn’t create webhook",
                    description: "Check your connection and try again.",
                  })
                }
              >
                Toast error
              </Button>
              <Button
                variant="secondary"
                data-kit="toast-info"
                onClick={() =>
                  toast.info({
                    title: "Fin was updated",
                    action: { label: "Reload", altText: "Reload the page", onAction: () => {} },
                  })
                }
              >
                Toast info
              </Button>
              <Button
                variant="secondary"
                data-kit="toast-undo"
                onClick={() =>
                  toast({
                    title: "Webhook deleted",
                    action: {
                      label: "Undo",
                      altText: "Create the webhook again from Webhooks",
                      onAction: async () => {
                        await wait(50);
                        throw new Error("kit failure");
                      },
                    },
                  })
                }
              >
                Toast with a failing Undo
              </Button>
            </Row>
          </Section>

          <Section name="auth" title="AuthCard">
            <AuthCard title="Sign in to Fin" description="New to Fin? Create an account">
              <Field label="Work email">
                <Input type="email" />
              </Field>
              <Button size="lg" className="w-full">
                Continue
              </Button>
            </AuthCard>
          </Section>

          <Section name="otp" title="OTPInput">
            <OtpDemo />
          </Section>

          <Section name="choices" title="Checkbox and Switch">
            <Checkbox
              data-kit="checkbox"
              label="Select all"
              checked={checked}
              onCheckedChange={(next) => setChecked(next)}
            />
            <Checkbox
              label="Send me a weekly summary"
              description="Every Monday, by email."
              defaultChecked
            />
            <Checkbox label="I accept the terms" error="Accept the terms to continue." />
            <Switch
              data-kit="switch"
              label="Email me when a payout fails"
              description="Sent to maya@example.com."
            />
            <Switch label="Two-factor required" placement="end" defaultChecked />
          </Section>

          <Section name="overlays" title="Modal and ConfirmDialog">
            <OverlayDemo />
          </Section>

          <Section name="copy" title="CopyField and SecretReveal">
            <CopyField label="Transaction ID" value="trf_7f3a9c21d4e8b6a0c1d2" />
            <CopyField
              label="Webhook URL"
              variant="block"
              value="https://example.com/hooks/payments"
            />
            <CopyField label="Signing secret" variant="secret" value={SAMPLE_SIGNING_SECRET} />
            <SecretRevealDemo />
            <SecretReveal
              status="masked"
              environment="Production"
              clientId="cli_1b2c3d4e5f6a"
              secretLastFour="4f3a"
            />
          </Section>

          <Section name="table" title="Table">
            <TableDemo />
          </Section>

          <Section name="icons" title="Icons in controls">
            <Row>
              <Button variant="ghost" leadingIcon={<BankIcon />}>
                Virtual accounts
              </Button>
              <Button variant="ghost" leadingIcon={<UserCircleIcon />}>
                Your sign-in
              </Button>
            </Row>
          </Section>

          <Section name="probes" title="Page-policy probes">
            <PolicyProbes />
          </Section>
        </div>
        <Toaster />
      </TooltipProvider>
    </FailureReporterProvider>
  );
}
