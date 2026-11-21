# 04. Providers and money (Monday 23 Nov 2026, R8)

Status: the build specification for Monday's lanes L-MON-01 to L-MON-10, written on Saturday 21 Nov
2026 from ARCHITECTURE.md, DECISIONS.md, EXECUTION.md and the owner's decisions of 21 Nov. Builders
build from this file alone. Where ARCHITECTURE.md already says something, this file names the
section instead of repeating it; where it was silent, this file decides, and each such choice is a
**spec decision** `MS-nn`, listed in §38 for the owner to confirm or overturn.

**Public by design (R12).** This file names no credential, token, provider catalogue token, wallet
reference, account or workspace ID, internal address or real person. Hosts are written
`<app>.<zone>`: the generic names stand for the roles and for production. Staging is on the shared
staging zone, `<staging-zone>`, where each role has the name [FD-09] gives it: `console.` keeps its
name, the public API is `gateway.<staging-zone>` and Fin Admin is `staff.<staging-zone>`. MassPay's
published sandbox host and its published sandbox test bank numbers are vendor documentation and
appear where tests need them. The MassPay method table (its `dest_`, `orgn_` and `attr_` tokens)
lives only in `payments`' sealed variables ([G-09], MS-09).

## How to read it

**Precedence.** The plan's one order of precedence, highest first: (1) the owner's decisions of
21 Nov 2026; (2) DECISIONS.md, appendix C included; (3) ARCHITECTURE.md; (4) EXECUTION.md; (5) the
specifications, and between two specifications the one that owns the area, as README §8.3 lists
the owners. The owner's decisions are those DECISIONS.md records as the owner's: the overnight
ones, which spec 01 §1 lists as OD-1 to OD-6, and the answers of Saturday morning, which spec 01
§1.2 lists. The decisions taken while the owner was away, such as the build's [BD-08] and [BD-11],
are register entries, for the owner's review. Among the specifications, this file owns providers,
money, the ledger and reconciliation; the
sibling owns any other area (spec 02 for permissions and step-up, spec 03 for onboarding, spec 05 for
the public API's conventions, webhooks and events, spec 06 for components, frames and states); and
spec 08 owns the cross-cutting rules of audit, security email, personal data, scrubbing, secrets and
observability. A spec decision (MS-nn, §38) binds where everything above it is silent; one that
differs from ARCHITECTURE.md or EXECUTION.md binds only once that file is changed to match. The
steward copies each into DECISIONS.md in a later pull request of the plan. DECISIONS appendix C
found none that changes a register entry; if one is found later, the register holds until appendix
C settles it.

| Mark | Meaning |
|---|---|
| `[MO-07]` | A decision in DECISIONS.md. Owner decisions due Monday 08:00 apply their default from 09:00 ([MO-03], [MO-04], [MO-05], [MO-08], [MO-13], [MO-16], [DA-12]); §37 says what changes if one is overturned |
| `§13.2` | A section of this file |
| `ARCH §12.4` | A section of ARCHITECTURE.md |
| `BRIEF §11.2` | A section of the design brief for the two canvases (round 2 is its §11) |
| `EX §5.1` | A section of EXECUTION.md |
| `MS-nn` | A spec decision taken here where the plan is silent (§38) |
| `SF-nn` | A spec decision settled in the register before the first commit, folded or not adopted (DECISIONS appendix C) |
| `XC-nn` | A cross-spec contract: something another day's lane must provide or call (§38.2) |
| `L-MON-nn`, `AC-MON-nn`, `CUT-nn`, `PG-nn`, `SP-nn`, `NB-nn` | Lanes, acceptance criteria, cut lines, production gates, spikes and never-cut rules, as in EXECUTION.md. `AC-MON-01` to `AC-MON-16` are EXECUTION's; this file adds `AC-MON-17` onwards |
| `T-MON-nn` | A test this file requires (§33) |
| `MQ-nn` | A rule from the private MassPay provider note, each with a test; §21.6 lists the neutral rules the public plan keeps |
| `CS-nn` | A conformance scenario (§23) |
| "the owner's decisions of 21 Nov" | The overnight ones (spec 01 §1, OD-1 to OD-6): the front door on cloudflared tunnels for every host; each web app an assets-only static deployment with `<app>.<zone>/api/*` falling through to the tunnel; host-only `__Host-` cookies; single-page apps on the UI SDK (`@ui-sdk/react`); the sidebar edge toggle. They override any older text in ARCH §3.4 about Hono serving static files or vendoring the design system's private source. The answers of Saturday morning (spec 01 §1.2) are cited by their entries, such as [FD-09], [G-06] and [SA-05] |

## Requirement map

| Req | What this spec gives it | Where |
|---|---|---|
| R1 Production-ready, from scratch | The money domain written fresh from this spec ([G-04]); the gates before live money as PG-14 | §36 |
| R2 Everything on Railway | `payments` is a Railway service with static egress; money jobs run in it under its own scheduler lease; Postgres on Railway holds the ledger | §2, §19 |
| R3 Cloudflare Email Sending | The beneficiary-added security email goes through `email.enqueue()` and the worker | §29.2 |
| R4 Cloudflare in front of Railway | MassPay webhooks reach `api.<zone>` through the public tunnel; the console's money routes under `console.<zone>/api/` go through the same tunnel; Fin Admin's through the admin tunnel behind Access | §18, §26, §27 |
| R5 Better Stack | `provider.call` and `job.run` lines, group F alerts, heartbeats, dashboard panels | §30 |
| R6 Roles | Dashboard `money.*` permissions and staff `money.read`, `money.operate`; step-up intents on every beneficiary change, send and cancel | §24, §26, §27 |
| R7 Onboarding | A holder is provisioned when a customer is approved; the KYC share uses `api`'s holder door | §10, §24.3 |
| R8 Providers, MassPay first, several providers | The adapter interface, capabilities, routing, link tables, sealed numbers, the MassPay adapter, the Fin simulator, the conformance suite | §3 to §8, §21 to §23 |
| R9 Everything audited | Every money write by every actor, every provider-driven change, every sealed-number opening, every reconciliation break; database guards on beneficiaries, transfers and ledger entries | §28 |
| R10, R11 fin-review | Every money lane is tier S; the attack pass runs the Monday profiles with the models R11 allows | §32, §34.4 |
| R12 Public repository | Provider tokens, method tables and thresholds stay in sealed variables and the private overlay | MS-09, §30 |
| R13 Plan first | This file is part of the plan in `docs/plan/` | |
| R14 New designs | The one Money tab (the design brief's round 2, BRIEF §11.2) and the money boards of the "Fin Dashboard · new design" canvas, state by state | §26 |
| R15 Node | Adapters use only Web APIs (`fetch`, `AbortSignal`, WebCrypto through `packages/crypto`) | §3.4 |
| R16 Public API and docs | The money routes, the fee quote, Sandbox money routes, their OpenAPI fragment and Try it on Sandbox keys | §25 |

---

## 0. Summary

- **`payments` owns money** ([MO-06]): the `money` schema, the provider credentials, the money door,
  the provider hook door and the money jobs. Nothing else touches provider APIs or money tables.
- **One adapter interface** ([MO-01]) speaks in effects: `ok`, `refused`, `retry`, or `unknown` with
  a resolution hint. A call that may have moved money is never treated as one that did not.
- **Fin owns the money facts** ([MO-02]): a double-entry, append-only ledger in minor units with
  holds. Spendable is the ledger balance minus active holds, and a payout is also checked against the
  provider's own balance before it is submitted.
- **Sandbox runs on the Fin simulator, live on MassPay** ([MO-05]): MassPay's sandbox in staging's
  live mode, MassPay live in production after PG-14.
- **Full bank numbers are sealed in Fin** ([MO-03], [MO-04]), opened only in memory, audited each
  time, so a beneficiary can be registered with any provider, on any rail, at any time.
- **One permanent idempotency key per transfer** ([MO-07]); the provider's business ID derives from
  the developer's idempotency scope, so a lost row still maps to the same provider payout.
- **A payout is submitted only after its row is durable** ([MO-18]), only outside a transaction, and
  only while no kill switch stops it.
- **Webhooks are verified and stored as references, then read back** (§18); a status sweep with
  backoff, an orphan search every 5 minutes and a daily reconciliation catch what webhooks miss
  ([MO-23]); breaks trip the money switch ([OP-01]).
- **One Money tab** on the customer page holds the virtual account, beneficiaries and transfers
  (BRIEF §11.2); money flows are size L drawer wizards; the screens take rails and methods from the
  API, not from a list of MassPay rails.

---

## 1. Scope

### 1.1 Must-have on Monday

EX §5.1 is the list. This file covers all fifteen items:

| EX §5.1 item | Section |
|---|---|
| 1 Money schema, link tables, ledger, intent log, inbox, method table | §7, §9 |
| 2 The adapter interface, capabilities, routing | §3 to §6 |
| 3 The Fin simulator and the conformance suite | §22, §23 |
| 4 The MassPay adapter (sandbox) | §21 |
| 5 The `payments` service, its door and its checks | §2, §24 |
| 6 Money domain | §10 to §17 |
| 7 Sandbox on the simulator, live on MassPay's sandbox in staging | §6 |
| 8 Provider events and reconciliation with automatic trips | §18 to §20, §31 |
| 9 Step-up and email | §24, §26, §29 |
| 10 Audit | §28 |
| 11 Money API | §25 |
| 12 Screens | §26 |
| 13 Fin Admin money view (read-only) | §27 |
| 14 Monitoring | §30 |
| 15 Docs reference with Try it | §25.8 |

### 1.2 Stretch (Monday if time, else hardening)

1. Fin Admin money operations (§27.3), with intents ([MO-13]).
2. A second adapter skeleton that passes the read-only part of the conformance suite (§23.4).
3. The money-movement guide and the idempotency, pagination and webhooks guides (H-08).
4. Real inbound deposits on the live path: the MassPay `payin_status` events, pay-in polling and the
   ledger walk creating inbound transfers (§14.2). Needed before live money (PG-14, [MO-14]).

### 1.3 Not in R8 on Monday (recorded, with where it goes)

| Item | Goes to |
|---|---|
| Daily value caps, the second approver above a threshold ([MO-19]) | H-04; the first-payout delay mechanism lands Monday with a zero delay in Sandbox (MS-21) |
| Revealing a beneficiary's full number in the console | Not built; no board. The door supports the `display` purpose for later (§8.4) |
| Bank ownership checks (MassPay's AVS) | Later; capability `ownershipCheck: false` |
| Businesses as holders | Wait for business enrolment ([MO-09]) |
| Third-party payees | Wait for MassPay and the owner ([MO-10]) |
| Currencies other than USD | Later ([MO-11]); every type carries a currency |
| Purging Sandbox money rows | H-09 (MS-26) |

### 1.4 Cut lines that apply (EX §8.2)

- **CUT-05** at 13:00: if the interface, the simulator or the conformance suite is not green, the
  MassPay adapter waits, Sandbox runs on the simulator only, and the Fin Admin money view moves.
- **CUT-06** at 18:00: if the console's send-money journey is not green against the simulator, the
  fee quote route goes (the review shows "Quoted by the bank as it's sent, and added on top", which
  is SendMoney's `feeUnavailable` state), then the docs guides, then the second adapter skeleton.
- **Never cut** (NB-13 and EX §8.2): Fin's ledger is the balance; no provider call inside a database
  transaction; every payout's row is durable and its permanent key saved before the call; step-up
  intents; audit with tests; scrubbing; the attack pass on tier S.

---

## 2. Where money runs

### 2.1 Services and trust

| Service | Money role | Holds |
|---|---|---|
| `payments` | The only service that reads or writes `money.*`, calls a provider, or opens a sealed bank field. Serves the money door, the money hook door and the money jobs (ARCH §2.3 F11 to F13) | `FIN_MONEY_SEAL_KEY_<n>`, `FIN_MONEY_INDEX_KEY_<n>`, `FIN_CURSOR_KEY_<n>`, MassPay key and webhook secrets, the MassPay method table, its caller signing key, its database logins `fin_payments_a`/`_b` |
| `edge` | Takes `POST /hooks/money/<provider>/<instance>` on `api.<zone>` and forwards the raw body to `payments`' hook door; checks keys for public money routes | nothing for money |
| `api` | Validates public money routes against the contract and forwards the edge's assertion unchanged to `payments` (ARCH §2.3, F1 and F11); serves the holder door to `payments` (§24.3) | no money key |
| `console` | Its money app API routes call `payments` with signed session assertions | no money key |
| `admin` | Its money routes call `payments` with the Access token and the staff session | no money key |
| `worker` | Anchors the daily ledger head to the R2 audit bucket from a view (MS-14); no other money duty | no money key |

`payments` enforces every door operation's declared checks itself, from its own read-only views and
the database's clock ([SA-36], ARCH §7.9). Its static outbound IPs are what MassPay allowlists (ARCH §4.4,
CR-14). Its pool is 6 plus one `LISTEN` connection (ARCH §4.5).

### 2.2 Packages and files

| Path | What | Lane |
|---|---|---|
| `packages/money/package.json`, `src/index.ts` | Package root | L-MON-01 |
| `packages/money/src/schema/**` | Drizzle table definitions for every `money.*` table except `money.sim_*` | L-MON-01 |
| `packages/money/src/ledger/**` | Accounts, posting builders, holds, invariants, the ledger sequencer's TypeScript check | L-MON-01 |
| `packages/money/src/domain/**` | Holders, virtual accounts, beneficiaries, transfers, deposits, quotes, balances, limits, idempotency, sealed fields, statuses and reasons, money errors | L-MON-01 |
| `packages/money/src/provider/**` | The `ProviderAdapter` types, capabilities, outcomes, routing, the call sink | L-MON-02 |
| `packages/money/src/conformance/**` | The conformance suite | L-MON-02 |
| `packages/money/src/providers/fin-simulator/**` | The Fin simulator adapter and its `money.sim_*` schema | L-MON-02 |
| `packages/money/src/providers/masspay/**` | The MassPay adapter, its HTTP client, mapping, fixtures | L-MON-03 |
| `apps/payments/**` except `src/hooks/**` and `src/jobs/**` | The service: `src/main.ts`, `src/server.node.ts`, `src/config/**`, `src/door/**`, `src/adapters.ts`, `src/tasks/**` | L-MON-03 |
| `apps/payments/src/hooks/**`, `apps/payments/src/jobs/**` | The hook door and the money jobs | L-MON-04 |

The full lane table, with every shared fragment, is §34.

### 2.3 Configuration of `payments`

Read once in `main()` and validated with Zod (ARCH §3.5); a missing or malformed value exits 78 naming
the setting, never its value.

| Variable | Kind | Meaning |
|---|---|---|
| `FIN_ENVIRONMENT` | plain | `development`, `ci`, `staging` or `production` |
| `FIN_MONEY_SEAL_KEY_<n>`, `FIN_MONEY_SEAL_KEY_IN_USE` | sealed | ARCH §6.6 |
| `FIN_MONEY_INDEX_KEY_<n>`, `FIN_MONEY_INDEX_KEY_IN_USE` | sealed | ARCH §6.6 |
| `FIN_CURSOR_KEY_<n>` | sealed | Pagination cursors (ARCH §13.4) |
| `FIN_MONEY_DURABILITY` | plain | `sync_standby` (required in production) or `single_node` (allowed in development, CI and staging only) (MS-12) |
| `MASSPAY_API_KEY` | sealed | One per instance; opaque, never logged |
| `MASSPAY_WEBHOOK_SECRETS` | sealed | Comma-separated `<label>:<secret>` pairs, all accepted during a rotation |
| `MASSPAY_METHODS` | sealed | The method table as JSON (§21.2), validated at start (MS-09) |
| `MASSPAY_FUNDING_WALLET` | sealed | Fin's treasury wallet reference for staging's live mode; must be absent in production |
| `MASSPAY_EMAIL_DOMAIN` | sealed | The domain Fin controls for generated holder emails; private, because it can name a zone |
| `FIN_SIM_PAYOUT_SETTLE_SECONDS` | plain | Default 600: how long a simulated payout stays `processing` before the simulator completes it |
| `FIN_SIM_ACH_DEPOSIT_SETTLE_SECONDS` | plain | Default 60 |

The set of provider instances is code, not configuration (§6.1): a variable can never add a host,
switch an instance to live, or route live mode to the simulator.

---

## 3. The provider adapter interface

### 3.1 The types

`packages/money/src/provider/types.ts`. This is normative: names and shapes are as written. Amounts
are integer minor units in a JavaScript `number`, checked with `Number.isSafeInteger` at every
boundary; nothing in money code uses floating-point arithmetic.

```ts
export type ProviderName = "masspay" | "fin-simulator" | (string & {});
export type ProviderEnvironment = "sandbox" | "live";
export type Mode = "sandbox" | "live";
export type Currency = "USD";
export type PayoutRail = "ach_same_day" | "ach_standard" | "ach_next_day" | "fedwire" | "rtp";
export type InboundRail = "ach" | "wire" | "rtp";

/** One provider, one provider environment, one credential. Stored on every link row. */
export interface ProviderInstance {
  readonly provider: ProviderName;
  readonly instance: string;               // ^[a-z][a-z0-9-]{2,39}$, e.g. "masspay-sandbox"
  readonly environment: ProviderEnvironment;
}

export type RefKind =
  | "holder" | "balance" | "virtual_account" | "counterparty" | "payout" | "funding" | "deposit";

/** An opaque handle an adapter made. Fin stores it and hands it back unchanged. Staff-only. */
export interface ProviderRef {
  readonly provider: ProviderName;
  readonly instance: string;
  readonly kind: RefKind;
  readonly id: string;                      // ^[A-Za-z0-9_-]{1,128}$
  readonly parts?: Readonly<Record<string, string>>;
}

/** Saved by Fin before the call. The same key always means the same request. */
export interface OpKey {
  readonly idempotencyKey: string;          // 1..255 visible ASCII
  readonly finId: string;                   // the Fin row the call acts for: cus_, vac_, ben_, trf_, tfu_
  readonly businessId: string;              // the provider's client ID; length <= idempotency.businessIdMaxLength
}

export type RefusalCode =
  | "holder_locked" | "holder_closed" | "holder_conflict" | "holder_details_missing"
  | "insufficient_funds" | "fee_above_limit" | "amount_out_of_range"
  | "counterparty_invalid" | "counterparty_needs_more" | "rail_unsupported"
  | "quote_expired" | "not_cancellable" | "not_found" | "simulation_refused" | "refused";

export type FaultCode =
  | "unauthorized" | "forbidden" | "rate_limited" | "server_error" | "unavailable"
  | "timeout" | "network" | "redirect" | "invalid_response" | "idempotency_mismatch"
  | "host_refused" | "invalid_request";

export type Outcome<T> =
  /** Done. */
  | { readonly kind: "ok"; readonly value: T }
  /** Definitely not done, and will not be done as asked. Safe to end the Fin row. */
  | { readonly kind: "refused"; readonly code: RefusalCode; readonly field?: CounterpartyField;
      readonly httpStatus?: number }
  /** Definitely not done; the same OpKey may be sent again after afterMs. */
  | { readonly kind: "retry"; readonly code: FaultCode; readonly afterMs: number }
  /** MAY have been done. Never end the Fin row as "no money moved" on this. */
  | { readonly kind: "unknown"; readonly code: FaultCode;
      readonly resolve: "retry_same_key" | "read_back" | "after_key_lapse"; readonly afterMs: number };

export type HolderFieldName =
  | "first_name" | "middle_name" | "last_name" | "date_of_birth"
  | "address_line1" | "address_line2" | "city" | "region" | "postal_code" | "country";

export interface HolderFields {
  readonly firstName: string; readonly middleName?: string; readonly lastName: string;
  readonly dateOfBirth?: string;            // YYYY-MM-DD
  readonly address: { readonly line1: string; readonly line2?: string; readonly city: string;
    readonly region?: string; readonly postalCode: string; readonly country: string /* alpha-2 */ };
}

/** For a real provider `fields` holds values; for the simulator it is null and only `present` is sent (MS-05). */
export interface HolderInput {
  readonly finCustomerId: string;           // cus_...
  readonly type: "individual";              // businesses are never sent ([MO-09])
  readonly fields: HolderFields | null;
  readonly present: readonly HolderFieldName[];
}

export type HolderStatus = "active" | "locked" | "review" | "closed";

export type CounterpartyField =
  | "holder_name" | "account_number" | "routing_number" | "account_type" | "bank_name"
  | "id_type" | "id_number";

/** Opened from Fin's sealed values for this call only. Never logged, never kept by the adapter. */
export interface BankDetails {
  readonly holderName: string;
  readonly accountNumber: string;           // ^\d{4,17}$
  readonly routingNumber: string;           // ^\d{9}$
  readonly accountType?: "checking" | "savings";
  readonly bankName?: string;
  readonly identity?: { readonly type: "PASSPORT" | "DRIVER LICENCE" | "ID CARD" | "NATIONAL IDENTIFICATION NUMBER";
                        readonly number: string };   // ^[A-Z0-9]{4,30}$
}

/** Full numbers: Fin seals them in the transaction that applies the answer. */
export interface DepositInstructions {
  readonly bankName: string | null; readonly bankAddress: string | null;
  readonly routingNumber: string; readonly accountNumber: string;
  readonly accountName: string | null; readonly swiftCode: string | null;
}

export interface PayoutQuoteInput {
  readonly holder: ProviderRef; readonly balance: ProviderRef; readonly counterparty: ProviderRef;
  readonly rail: PayoutRail; readonly amountMinor: number; readonly currency: Currency;
}

export interface PayoutInput extends PayoutQuoteInput {
  /** What Fin held for the fee. Above it the adapter stops and refuses fee_above_limit. */
  readonly maxFeeMinor: number;
  readonly op: OpKey;
}

export interface PayoutRefInput {
  readonly holder: ProviderRef;
  readonly payout: ProviderRef | null;      // null when the answer that carried it was lost
  readonly op: OpKey;
}

export type PayoutReason =
  | "quote_expired" | "insufficient_funds" | "holder_locked" | "counterparty_refused"
  | "fee_above_limit" | "refused" | "cancelled" | "bank_return";

export interface PayoutState {
  readonly ref: ProviderRef | null;
  readonly status: "pending" | "processing" | "completed" | "failed" | "cancelled" | "returned";
  readonly committed: boolean;              // money left, or may have left, the provider balance
  readonly cancelPending: boolean;          // a cancellation was asked and is not yet decided
  readonly reason: PayoutReason | null;
  readonly returnCode: string | null;       // ^R\d{2}$
  readonly feeMinor: number | null;
  readonly providerStatus: string;          // raw, staff-only
  readonly occurredAt: Date | null;
}

/** Adapter-owned state Fin persists on transfer_provider.state between calls. */
export type Continuation = Readonly<Record<string, string | number | boolean | null>>;
/** Fin persists the continuation in one short transaction before the adapter's next provider call. */
export type Checkpoint = (state: Continuation) => Promise<void>;

export interface DepositState {
  readonly ref: ProviderRef;
  readonly status: "pending" | "completed" | "failed" | "returned";
  readonly amountMinor: number; readonly feeMinor: number;
  readonly rail: InboundRail | null; readonly occurredAt: Date | null; readonly returnCode: string | null;
}

export interface FundingState {
  readonly ref: ProviderRef; readonly status: "completed" | "scheduled" | "cancelled"; readonly amountMinor: number;
}

export interface ProviderEvent {
  readonly kind: "payout" | "deposit" | "deposit_return" | "funding" | "holder" | "virtual_account" | "other";
  readonly ref: Pick<ProviderRef, "kind" | "id">;
  readonly status: string;
  readonly occurredAt: Date;
  readonly dedupeKey: string;               // <= 200 characters
}

export interface ProviderLedgerEntry {
  readonly id: string; readonly at: Date;
  readonly amountMinor: number;             // signed: positive into the balance
  readonly currency: Currency;
  readonly type: "payout" | "payout_reversal" | "deposit" | "deposit_return" | "funding"
               | "funding_reversal" | "fee" | "other";
  readonly relatesTo: Pick<ProviderRef, "kind" | "id"> | null;
}
```

### 3.2 The adapter

`packages/money/src/provider/adapter.ts`:

```ts
export interface ProviderAdapter {
  readonly instance: ProviderInstance;
  capabilities(): ProviderCapabilities;

  ensureHolder(input: HolderInput, op: OpKey): Promise<Outcome<{ holder: ProviderRef; status: HolderStatus }>>;
  readHolder(holder: ProviderRef): Promise<Outcome<{ status: HolderStatus; providerStatus: string }>>;
  ensureBalance(holder: ProviderRef, currency: Currency, op: OpKey): Promise<Outcome<ProviderRef>>;
  readBalance(balance: ProviderRef): Promise<Outcome<{ availableMinor: number; currency: Currency }>>;

  openVirtualAccount(holder: ProviderRef, balance: ProviderRef, op: OpKey):
    Promise<Outcome<{ account: ProviderRef; instructions: DepositInstructions | null }>>;
  /** "Already closed" and "not found" are ok. */
  closeVirtualAccount(account: ProviderRef, op: OpKey): Promise<Outcome<void>>;
  readDeposits(account: ProviderRef, since: Date | null): Promise<Outcome<readonly DepositState[]>>;

  /** Registered per provider and rail, from details Fin opens for this call only. */
  registerCounterparty(holder: ProviderRef, rail: PayoutRail, details: BankDetails, op: OpKey):
    Promise<Outcome<ProviderRef>>;

  /** Holds nothing at the provider. */
  pricePayout(input: PayoutQuoteInput): Promise<Outcome<{ feeMinor: number }>>;
  submitPayout(input: PayoutInput, state: Continuation | null, checkpoint: Checkpoint): Promise<Outcome<PayoutState>>;
  readPayout(input: PayoutRefInput, state: Continuation | null): Promise<Outcome<PayoutState>>;
  /** Before commit it guarantees Fin never commits later; after commit it is a request. */
  cancelPayout(input: PayoutRefInput, state: Continuation | null, why: "requested" | "stopped",
               checkpoint: Checkpoint): Promise<Outcome<PayoutState>>;

  // Capability-gated. Each refuses simulation_refused on a live instance in production (§6.4).
  fundFromTreasury?(holder: ProviderRef, balance: ProviderRef, amountMinor: number, op: OpKey):
    Promise<Outcome<FundingState>>;
  readFunding?(holder: ProviderRef, op: OpKey): Promise<Outcome<FundingState | null>>;
  treasuryBalance?(): Promise<Outcome<{ availableMinor: number; currency: Currency }>>;
  simulateInbound?(account: ProviderRef, rail: InboundRail, amountMinor: number, op: OpKey):
    Promise<Outcome<DepositState>>;
  simulateOutcome?(payout: PayoutRefInput, outcome: "complete" | "fail" | "return", returnCode?: string):
    Promise<Outcome<PayoutState>>;

  verifyEvents(req: { headers: Headers; rawBody: Uint8Array; receivedAt: Date }):
    { ok: true; events: readonly ProviderEvent[] } | { ok: false; reason: "bad_signature" | "stale" | "malformed" };
  readLedger(balance: ProviderRef, cursor: string | null):
    Promise<Outcome<{ entries: readonly ProviderLedgerEntry[]; next: string | null }>>;
  /** Read-only: credentials work, the host is right, the treasury is readable where it exists. */
  probe(): Promise<Outcome<{ ok: true }>>;
}
```

### 3.3 Building an adapter

Adapters are stateless and built per unit of work (a request or a job item), never at module scope
(principle 14):

```ts
export interface AdapterContext {
  readonly clock: Clock;                         // from packages/core
  readonly fetch: (request: Request) => Promise<Response>;  // plain fetch; provider hosts only
  readonly sink: ProviderCallSink;               // writes provider.call lines and provider_operation rows
  readonly unit: { readonly requestId: string | null; readonly runId: string | null };
}

export interface ProviderCallRecord {
  readonly instance: string; readonly operation: string; readonly subjectId: string | null;
  readonly opKey: string | null; readonly businessId: string | null; readonly requestHash: string | null;
  readonly outcome: Outcome<unknown>["kind"]; readonly code: string | null;
  readonly httpStatus: number | null; readonly effect: "none" | "done" | "maybe";
  readonly attempt: number; readonly durationMs: number;
}

export interface ProviderCallSink {
  /** Called once per provider call, after it ends. Never throws; failures are swallowed and logged. */
  record(call: ProviderCallRecord): void;
}

export type AdapterFactory = (ctx: AdapterContext) => ProviderAdapter;
```

`apps/payments/src/adapters.ts` maps each instance name to its factory. The sink writes the
`provider.call` line at once and inserts the `money.provider_operation` row after the unit's current
transaction, through the background registry (ARCH §3.5); the row is the intent log, the line is the
monitoring (§30.1).

### 3.4 Runtime rules for adapters

- Web APIs only: `fetch` with `redirect: "manual"`, `AbortSignal.timeout()`, `TextEncoder`, and
  HMAC through `packages/crypto` (which wraps `node:crypto` behind the portability rules of ARCH §3.2).
  No `node:http`, no undici dispatcher, no provider SDK, no new dependency.
- Every provider host comes from the adapter's own allowlist in code; a base URL outside it refuses
  to build the adapter (`host_refused`) and `payments` exits 78 at start.
- No provider name, status, reference or body leaves `payments` towards a developer
  ([AP-14], ARCH §12.1). A lint rule fails any provider name from `packages/money/src/provider/names.ts`
  outside `packages/money/src/providers/<name>/`, `apps/payments/src/config/`, `ops/`, `docs/` and
  Fin Admin's money routes (T-MON-40).

---

## 4. Rules around every provider call

These are ARCH §12.4's rules made exact. `packages/money/src/domain/drive.ts` implements them once; no
domain code calls an adapter except through it.

1. **Row first.** Before any provider write, one transaction saves the Fin row, its `OpKey` parts
   (`transfer_provider.business_id`, `op_key_base`, `attempt`) and, for a payout, the hold of
   `amount + fee ceiling` (§15.2). The audit row and the developer event go in the same transaction.
2. **Durable before a payout.** `submitPayout` is called only after the transaction that created the
   transfer is confirmed durable (MS-12): with `FIN_MONEY_DURABILITY=sync_standby`, the transaction
   ran with `SET LOCAL synchronous_commit = 'remote_apply'` and read
   `current_setting('synchronous_standby_names')` as non-empty before committing; if it was empty,
   the transfer is committed with `durability = 'unconfirmed'`, no provider call is made, the job
   re-checks every 30 seconds, and `money.durability_unconfirmed` is written (alert §30.3). With
   `single_node`, `durability = 'single_node'` is recorded. This is AC-MON-03's last clause.
3. **Outside any transaction.** The call runs with no transaction open on the unit's client; the test
   hook of ARCH §3.5 fails any outbound `fetch` started while a client is held (AC-MON-04).
4. **One driver at a time.** The driver holds the row's lease (`lease_until`, `leased_by`, 2 minutes,
   renewed at each checkpoint). A checkpoint writes the continuation only
   `WHERE leased_by = $me AND lease_until > now()`; zero rows updated means the lease was lost, and
   the driver stops at once without calling the provider again (fencing).
5. **Apply in a new transaction**, with the posting, the audit row and the developer event:
   - `ok`: apply the state and its postings.
   - `refused`: end the row with the mapped reason (§13.3) and release the hold.
   - `retry`: keep the row; `next_check_at = now + afterMs`.
   - `unknown`: keep the row; store `resolve`; `next_check_at = now + afterMs`. **Never** release a
     hold or say no money moved on `unknown`.
6. **Cancel is written first.** `cancel_requested_at`, its actor and its audit row commit before
   `cancelPayout` is called; after that `submitPayout` is never called for the transfer again.
7. **A pending deadline.** A transfer still `pending` 10 minutes after creation is no longer driven
   forward; the driver calls `cancelPayout(why: "stopped")` and reads until the adapter says what
   happened.
8. **A refused commit is read back.** Before Fin ends a payout as "no money moved" after any
   commit-stage refusal, the adapter has read the payout (§21.5); the domain trusts the adapter's
   `committed` flag.
9. **The source comes from Fin's row.** Holder, balance and counterparty references come from link
   rows, never from a request.
10. **Budgets.** One adapter operation: 10 seconds including every retry and the body read. A
    request that drives a payout (`transfer.create`) stops driving after 15 seconds and answers the
    transfer as it stands; the job continues. A job item stops before half its lease.
11. **Kill switches are read before every write call** (§31), with no cache.

---

## 5. Capabilities

### 5.1 The type

`packages/money/src/provider/capabilities.ts`:

```ts
export interface RailCapability {
  readonly rail: PayoutRail;
  readonly currencies: readonly Currency[];
  readonly minMinor: number | null; readonly maxMinor: number | null;
  readonly extraFields: readonly CounterpartyField[];      // beyond account and routing number
}

export interface ProviderCapabilities {
  readonly currencies: readonly Currency[];
  readonly holders: {
    readonly individual: boolean;
    readonly business: "none" | "as_user" | "enrolment";
    readonly emailPolicy: "none" | "any" | "unique_global";
    readonly requiredFields: readonly HolderFieldName[];
  };
  readonly kycShare: readonly ("fields" | "documents" | "idv_link" | "provider_hosted")[];
  readonly balance: { readonly model: "provider_wallet_per_holder" | "pooled_fbo"; readonly reportedExcludesHolds: boolean };
  readonly virtualAccounts: null | {
    readonly persistence: "persistent" | "per_request"; readonly instructionsReadable: "once" | "always";
    readonly closeable: boolean; readonly multipleDeposits: boolean; readonly inboundRails: readonly InboundRail[];
  };
  readonly payouts: {
    readonly rails: readonly RailCapability[];
    readonly flow: "single_shot" | "two_phase"; readonly pricing: "dry_run" | "quote" | "static";
    readonly cancel: "pre_commit_only" | "request" | "none";
    readonly returnsAfterCompletion: boolean; readonly reversals: boolean;
  };
  readonly counterparties: { readonly storage: "provider_stored" | "per_payout"; readonly carriesHolderName: boolean;
                             readonly thirdParty: "none" | "sender_attribution" | "native" };
  readonly idempotency: { readonly ttlMs: number; readonly replaysServerErrors: boolean; readonly businessIdMaxLength: number };
  readonly events: { readonly webhooks: boolean };
  readonly ledger: { readonly readable: boolean };
  readonly ownershipCheck: boolean;
  readonly sandbox: { readonly simulateInbound: boolean; readonly simulateOutcomes: boolean;
                      readonly treasuryFunding: boolean; readonly syntheticDataOnly: boolean };
}
```

### 5.2 The declared values

| Dimension | MassPay (both instances) | Fin simulator |
|---|---|---|
| `currencies` | `["USD"]` | `["USD"]` |
| `holders` | individual `true`; business `"none"`; `emailPolicy: "unique_global"`; `requiredFields`: first and last name, date of birth, address line 1, city, region, postal code, country | the same as the live route (§22.1) |
| `kycShare` | `["fields"]` | `["fields"]` |
| `balance` | `provider_wallet_per_holder`, `reportedExcludesHolds: false` | `provider_wallet_per_holder`, `reportedExcludesHolds: true` |
| `virtualAccounts` | `per_request`, `instructionsReadable: "once"`, closeable, many deposits, inbound `["ach", "wire"]` | `persistent`, `"always"`, closeable, many deposits, inbound `["ach", "wire"]` |
| `payouts.rails` | `ach_same_day` (extra none); `ach_standard` (extra `bank_name`); `fedwire` (extra `id_type`, `id_number`); each USD, `minMinor: 1`, `maxMinor: 1000000` until MassPay's live limits are known ([MO-17]) | the same three rails and limits |
| `payouts` other | `two_phase`, `dry_run`, `cancel: "request"`, returns after completion, reversals `true` | `two_phase`, `quote`, `cancel: "request"`, returns after completion, reversals `false` |
| `counterparties` | `provider_stored`, `carriesHolderName: false`, `thirdParty: "sender_attribution"` | `provider_stored`, `false`, `"none"` |
| `idempotency` | `ttlMs: 86400000`, `replaysServerErrors: true`, `businessIdMaxLength: 50` | `ttlMs: 2592000000`, `false`, `50` |
| `events`, `ledger` | webhooks `true`; ledger readable `true` | webhooks `true` (in-process, §22.4); readable `true` |
| `ownershipCheck` | `false` (AVS exists but is not used on Monday) | `false` |
| `sandbox` | `simulateInbound: false`, `simulateOutcomes: false`, `treasuryFunding: true` (staging's MassPay sandbox only), `syntheticDataOnly: true` | all `true`; `syntheticDataOnly: false` |

The simulator mirrors the rails, limits, holder fields and business rule of the provider that live
mode routes to in that environment, so Sandbox never promises what Production cannot do (ARCH §12.13).
A unit test compares the two declarations field by field and fails on any difference outside the
`balance`, `virtualAccounts.persistence`, `instructionsReadable`, `pricing`, `reversals`,
`idempotency`, `thirdParty` and `sandbox` fields (T-MON-12).

### 5.3 Where capabilities are checked

| Check | Where | Refusal |
|---|---|---|
| A holder's type and required fields | holder provisioning (§10) | holder `skipped` with `missing_fields` or `business_not_supported` |
| A beneficiary's rail group can be paid by the routed instance | `beneficiary.create` | 409 `rail_unsupported` |
| A transfer's kind is a rail the beneficiary is saved under and the instance offers, in the currency, within its limits | `transfer.create`, `transfer.quote` | 400 `invalid_transfer` (`field: "kind"` or `"amount"`), 409 `rail_unavailable` |
| Simulations | Sandbox routes | 403 `sandbox_only`; 409 `not_simulatable` |
| The rails offered to screens | `money_tab.get` returns `rails` from the routed instance's capabilities and method table | the screens build their choices from it ([UI-02]; the design system's rule that options come from the API) |

---

## 6. Provider instances and routing

### 6.1 Instances are code

`apps/payments/src/config/instances.ts` declares, per `FIN_ENVIRONMENT`, every instance `payments`
may build. A change to this file is a reviewed tier S change.

| Environment | Instance | Provider | Provider environment | Serves mode | Enabled |
|---|---|---|---|---|---|
| development, ci | `fin-simulator` | `fin-simulator` | sandbox | sandbox | yes |
| development, ci | `masspay-stub` | `masspay` | sandbox | live | yes, against the `test` image's MassPay stand-in only |
| staging | `fin-simulator` | `fin-simulator` | sandbox | sandbox | yes |
| staging | `masspay-sandbox` | `masspay` | sandbox | live | yes |
| production | `fin-simulator` | `fin-simulator` | sandbox | sandbox | yes |
| production | `masspay-live` | `masspay` | live | live | **no**: `liveEnabled: false` until PG-14, changed only by a reviewed pull request |

Each entry names its base URL key (`masspay.sandbox` or `masspay.live`, resolved through the
adapter's allowlist, §21.1), the names of its credential variables, its method table version and,
for MassPay, the funding wallet and email domain variable names. At start `payments` upserts each
entry into `money.provider_instance` (§7.2) so rows can reference it, and refuses to start if:
a live-serving instance is the simulator in production; `masspay-live` is enabled while
`FIN_ENVIRONMENT` is not `production`; `MASSPAY_FUNDING_WALLET` is set in production; an enabled
instance's credentials are missing.

**Live money per environment** (MS-02): staging serves live mode (on MassPay's sandbox, synthetic
data only); production serves no live mode until PG-14. A live-mode money call in an environment
whose live instance is disabled answers 403 `sandbox_only` (ARCH §13.1 rule 6).

### 6.2 Routing rules

`money.routing_rule` rows are upserted at start from `apps/payments/src/config/routing.ts`, so
changes are reviewed code and every decision can name its rule.

| Rule | Mode | Customer type | Country | Currency | Instance (staging) | Instance (production) |
|---|---|---|---|---|---|---|
| `sandbox-individual-usd` | sandbox | individual | any | USD | `fin-simulator` | `fin-simulator` |
| `live-individual-usd` | live | individual | any | USD | `masspay-sandbox` | `masspay-live` (disabled) |

No rule matches a business, so a business holder is `skipped` with `business_not_supported` and
every money write for it answers 409 `not_supported` ([MO-09]).

### 6.3 The routing procedure

`packages/money/src/provider/routing.ts` exports
`route(input: { mode; customerType; country; currency; railsWanted: readonly PayoutRail[] }, rules, instances): RouteDecision | RouteRefusal`.

1. Keep the enabled rules whose mode, customer type, country (or any) and currency match, in
   ascending `priority`.
2. Drop rules whose instance is disabled, or whose instance's capabilities lack the customer type or
   any wanted rail in the currency.
3. Take the first. None left: `{ refused: "not_supported" }` for a business, otherwise
   `{ refused: "no_route" }` (holder `failed`, `state_reason = 'no_route'`, alert
   `provisioning-failed`).
4. Record the decision on `money.holder` (`instance`, `routing_rule`) and as the staff-scope audit
   event `money.routing_decided` (§28).

What follows the holder: a virtual account opens at the holder's instance; a payout goes to the
instance holding the source balance, which must offer the rail and currency, else 409
`rail_unavailable`; a counterparty is registered at that instance and rail from the sealed details.
**No failover for anything that moves money** ([MO-15]): a payout that may have happened at one
instance is never sent to another, and a holder is never re-routed while it has a balance, a hold
or a non-final transfer.

### 6.4 What can never run on a live production instance

`packages/money/src/provider/guards.ts` exports `assertSimulationAllowed(instance, environment)`,
which every implementation of `fundFromTreasury`, `simulateInbound` and `simulateOutcome` calls
first; on `instance.environment === "live" && environment === "production"` it returns
`{ kind: "refused", code: "simulation_refused" }` and writes `money.simulation_refused` ([MO-21],
T-MON-15, AC-MON-10). The router refuses a rule that maps live mode to `fin-simulator` in
production, at start and in `route()`.

---

## 7. Data model

### 7.1 Conventions

- Schema `money`, owned by `fin_owner`, written and read by `fin_payments` only (ARCH §6.1), with the two
  exceptions in §7.6.
- IDs as ARCH §6.2. New prefixes for `packages/core/src/ids.ts` (XC-01): `phd` (provider holder), `pbl`
  (provider balance), `pcp` (provider counterparty), `pdp` (provider deposit), `tfu` (treasury
  funding), `tni` (transfer intent), `rcr` (reconciliation run). Existing: `vac`, `ben`, `trf`, `lac`,
  `len`, `hld`, `pev`, `pop`, `rbk`.
- Every table carries `created_at timestamptz NOT NULL DEFAULT now()`; mutable tables also
  `updated_at`. Every list read starts `(organization_id, mode, ...)` and has an index proven by an
  `EXPLAIN` test (T-MON-30).
- Money columns are `bigint` minor units with a `CHECK` that the value fits a safe integer
  (`< 9007199254740992`). `currency char(3) NOT NULL CHECK (currency = 'USD')` until [MO-11] widens it.
- Actor columns hold `user:usr_...`, `key:<10-character key ID>`, `staff:stf_...`, `operator`,
  `system` or `provider:<instance>`, checked by one `CHECK` pattern.
- No foreign key to `kyc.customer` or `identity.organization` ([DA-12], ARCH §12.7): money rows outlive
  both. `ON DELETE` is never `CASCADE` between money tables.
- `epoch int NOT NULL` on holder, virtual account, beneficiary and transfer: the organisation's
  Sandbox epoch at insert (always 0 in live mode). A Sandbox reset increments the epoch, and lists
  show the current epoch only (MS-25).
- Migrations: `packages/db/migrations/<YYYYMMDDHHMMSS>_money_<what>.sql`, hand-written, each with
  `lock_timeout` and `statement_timeout` (ARCH §6.4).

### 7.2 Configuration mirrors

**`money.provider_instance`** (upserted by `payments` at start, §6.1)

| Column | Type | Rules |
|---|---|---|
| `instance` | text PK | `^[a-z][a-z0-9-]{2,39}$` |
| `provider` | text | |
| `provider_environment` | text | `sandbox` or `live` |
| `serves_mode` | text | `sandbox` or `live` |
| `enabled` | boolean | from code |
| `method_table_version` | text | |
| `capabilities` | jsonb | the declared `ProviderCapabilities`, for Fin Admin |
| `updated_at` | timestamptz | |

**`money.routing_rule`**: `rule text PK`, `priority int`, `mode`, `customer_type`, `country char(2)
NULL`, `currency`, `rails text[] NULL`, `instance` (FK), `enabled boolean`, `updated_at`.

**`money.provider_method`** (from the instance's method table at start; MassPay's from
`MASSPAY_METHODS`, the simulator's from code)

| Column | Type | Rules |
|---|---|---|
| `instance` | text FK | |
| `rail` | text | a `PayoutRail`, or `inbound:<InboundRail>` for pay-in methods |
| `currency` | char(3) | |
| `version` | text | |
| `external_method_ref` | text | the provider's method reference; for MassPay a catalogue token, never shown outside Fin Admin |
| `fields` | jsonb | neutral field name to provider field reference and pattern |
| `fee_ceiling_minor` | bigint | the fee held on top of the amount (§15.2) |
| `min_minor`, `max_minor` | bigint | |
| PK | | `(instance, rail, currency, version)` |

### 7.3 Holders and balances

**`money.holder`** (one per customer)

| Column | Type | Rules |
|---|---|---|
| `customer_id` | text PK | `cus_...` |
| `organization_id`, `mode` | text | |
| `customer_type` | text | `individual` or `business`, mirrored from `api` (§10.1) |
| `customer_status` | text | the KYC status mirrored from `api`: `incomplete`, `in_review`, `approved`, `action_required`, `unapproved`, `rejected`, `deleted` |
| `customer_status_seq` | bigint | `api`'s monotonic status sequence; a lower or equal value is ignored |
| `country` | char(2) | |
| `state` | text | `owed`, `creating`, `active`, `locked`, `failed`, `skipped`, `closed` |
| `state_reason` | text NULL | `not_approved`, `missing_fields`, `business_not_supported`, `no_route`, `holder_conflict`, `refused`, `provider_locked`, `provider_closed`, `customer_deleted`, `sandbox_reset`, `attempts_exhausted` |
| `missing_fields` | text[] | field names only |
| `instance`, `routing_rule` | text NULL | the routing decision |
| `attempts` | int | |
| `next_attempt_at` | timestamptz NULL | due for the provisioning job |
| `lease_until`, `leased_by` | | ARCH §4.6 claim |
| `last_error_code` | text NULL | a `RefusalCode` or `FaultCode` |
| `kyc_shared_at` | timestamptz NULL | |
| `auto_open_virtual_account` | boolean | default true |
| `epoch` | int | |

Indexes: `(organization_id, mode, state)`; `(next_attempt_at) WHERE next_attempt_at IS NOT NULL`.

**`money.provider_holder`**: `id phd_ PK`, `customer_id` (FK holder), `provider`, `instance`,
`external_id`, `parts jsonb`, `holder_status` (`HolderStatus`), `raw_status`, `updated_at`; unique
`(provider, instance, external_id)` and `(customer_id, instance)`.

**`money.provider_balance`**: `id pbl_ PK`, `provider_holder_id` (FK), `customer_id`,
`organization_id`, `mode`, `provider`, `instance`, `currency`, `external_id`, `parts jsonb`; unique
`(provider_holder_id, currency)` and `(provider, instance, external_id)`.

### 7.4 Virtual accounts, beneficiaries, counterparties

**`money.virtual_account`**

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | `vac_...` |
| `organization_id`, `mode`, `customer_id`, `instance` | text | |
| `provider_balance_id` | text FK | |
| `status` | text | `opening`, `open`, `closed`, `failed` |
| `failure_code` | text NULL | a `RefusalCode`, or `instructions_unreadable` |
| `bank_name`, `bank_address`, `swift_code` | text NULL | clear |
| `routing_number` | char(9) NULL | clear |
| `account_number_sealed` | text NULL | sealed, AAD `<organization>:money.virtual_account.account_number` |
| `account_last4` | char(4) NULL | |
| `name_on_account_sealed` | text NULL | sealed, AAD `<organization>:money.virtual_account.name_on_account` |
| `inbound_rails` | text[] | |
| `requested_by` | text | actor |
| `opened_at`, `closed_at` | timestamptz NULL | |
| `close_reason` | text NULL | `customer_deleted`, `sandbox_reset`, `staff`, `holder_closed`, `replaced` |
| `epoch` | int | |

Unique partial index `(customer_id) WHERE status IN ('opening', 'open')`: one live account per
customer. A `CHECK` requires the sealed number and last four together when `status = 'open'`.
Indexes: `(organization_id, mode, epoch, created_at DESC, id DESC)`; `(customer_id, created_at DESC)`.

**`money.provider_virtual_account`**: `virtual_account_id PK FK`, `provider`, `instance`,
`external_id NULL`, `parts jsonb`, `op_key`, `close_requested_at`, `close_confirmed_at`,
`close_attempts int`; unique `(provider, instance, external_id)`.

**`money.beneficiary`**

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | `ben_...` |
| `organization_id`, `mode`, `customer_id` | text | |
| `rail_group` | text | `ach` or `fedwire` (the public `rail`) |
| `rails` | text[] | `PayoutRail`s it may be paid by: `ach` gives `{ach_same_day}`, plus `ach_standard` when a bank name is given; `fedwire` gives `{fedwire}` |
| `holder_name_sealed` | text | AAD `<organization>:money.beneficiary.holder_name` |
| `account_number_sealed` | text | AAD `<organization>:money.beneficiary.account_number` ([MO-03]) |
| `account_last4` | char(4) | |
| `routing_number` | char(9) | clear |
| `account_type` | text NULL | `checking` or `savings` (ACH only) |
| `bank_name` | text NULL | ACH only |
| `fedwire_id_type_sealed`, `fedwire_id_number_sealed` | text NULL | Fedwire only ([MO-04]); AAD per column |
| `fingerprint` | bytea | 32 bytes (§8.3) |
| `fingerprint_version` | int | the index key version |
| `status` | text | `active` or `removed` |
| `first_payout_after` | timestamptz | `created_at` plus the instance's first-payout delay (MS-21) |
| `create_key_sha256` | bytea NULL | the create request's idempotency key, hashed (MS-17) |
| `request_hash` | bytea NULL | |
| `created_by`, `removed_by` | text | actors |
| `removed_at` | timestamptz NULL | |
| `epoch` | int | |

Unique partial `(customer_id, rail_group, fingerprint) WHERE status = 'active'`; unique partial
`(organization_id, mode, create_key_sha256) WHERE create_key_sha256 IS NOT NULL`. Index
`(customer_id, status, created_at DESC, id DESC)`.

**`money.provider_counterparty`**

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | `pcp_...` |
| `beneficiary_id` | text FK | |
| `provider`, `instance`, `provider_holder_id`, `rail` | text | |
| `external_id` | text NULL | |
| `parts` | jsonb | MassPay: `{method, attrSet}` |
| `state` | text | `registering`, `registered`, `refused`, `stale` |
| `refusal_code`, `refusal_field` | text NULL | |
| `op_key` | text | |
| `registered_at` | timestamptz NULL | |

Unique `(beneficiary_id, instance, rail)`.

### 7.5 Transfers, deposits, funding, intents

**`money.transfer`**

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | `trf_...` |
| `organization_id`, `mode`, `customer_id`, `instance` | text | |
| `direction` | text | `in` or `out` |
| `kind` | text | out: a `PayoutRail`; in: `deposit`, `sandbox_deposit`, `funding` |
| `rail` | text NULL | `ach`, `wire` or `rtp` for `deposit` only |
| `beneficiary_id` | text NULL | required when `direction = 'out'` |
| `virtual_account_id` | text NULL | set for `deposit` |
| `amount_minor` | bigint | `> 0` |
| `fee_minor`, `total_minor` | bigint NULL | known after commit (out) or credit (in) |
| `fee_ceiling_minor` | bigint NULL | out only (§15.2) |
| `currency` | char(3) | |
| `status` | text | `pending`, `processing`, `completed`, `failed`, `cancelled`, `returned` |
| `reason` | text NULL | §13.3 |
| `return_code` | text NULL | `^R\d{2}$` |
| `idempotency_key_sha256` | bytea NULL | required for out, `sandbox_deposit` and Sandbox bank deposits |
| `request_hash` | bytea NULL | §16.1 |
| `external_id` | text NULL | at most 255 characters, no control characters |
| `origin` | text | `api`, `console`, `admin`, `provider`, `operator`, `simulator` |
| `created_by` | text | actor |
| `durability` | text NULL | `confirmed`, `single_node`, `unconfirmed` (out only, §4 rule 2) |
| `cancel_requested_at`, `cancel_requested_by` | | |
| `simulated` | boolean | true for every transfer on the simulator instance |
| `outcome_simulated_at` | timestamptz NULL | set when a Sandbox simulation decided the outcome |
| `committed_at`, `completed_at`, `ended_at` | timestamptz NULL | |
| `next_check_at` | timestamptz NULL | due for the sweep |
| `check_step` | smallint | position in the backoff ladder (§19.2) |
| `watch_until` | timestamptz NULL | the return watch after completion (5 days) |
| `lease_until`, `leased_by` | | §4 rule 4 |
| `epoch` | int | |

Constraints: unique `(organization_id, mode, idempotency_key_sha256)`; `CHECK` pairs of direction and
kind; `CHECK (direction = 'out') = (beneficiary_id IS NOT NULL)`. Indexes:
`(organization_id, mode, epoch, created_at DESC, id DESC)`;
`(organization_id, mode, epoch, status, created_at DESC, id DESC)`;
`(customer_id, created_at DESC, id DESC)`; `(next_check_at) WHERE next_check_at IS NOT NULL`;
`(organization_id, mode, beneficiary_id, created_at DESC)` (the similar-transfer warning).

**`money.transfer_provider`** (one per transfer: there is no failover)

| Column | Type | Rules |
|---|---|---|
| `transfer_id` | text PK FK | |
| `provider`, `instance`, `provider_holder_id`, `provider_balance_id` | text | from Fin's rows |
| `provider_counterparty_id` | text NULL | out only |
| `business_id` | text | §16.2; unique `(instance, business_id)` |
| `op_key_base` | text | §16.2 |
| `attempt` | smallint | starts at 1 |
| `external_id` | text NULL | unique `(provider, instance, external_id)` when set |
| `raw_status` | text NULL | staff-only |
| `state` | jsonb NULL | the adapter's continuation |
| `state_version` | int | incremented by each checkpoint |
| `resolve` | text NULL | the last `unknown` hint |
| `committed` | boolean | |
| `submitted_at`, `last_provider_at`, `occurred_at` | timestamptz NULL | |

**`money.provider_deposit`**: `id pdp_ PK`, `transfer_id` (FK, unique), `provider`, `instance`,
`virtual_account_id`, `external_id`, `status`, `raw_status`, `occurred_at`; unique
`(provider, instance, external_id)` ([MO-22]).

**`money.treasury_funding`**: `id tfu_ PK`, `instance`, `organization_id`, `mode`, `customer_id`,
`transfer_id` (FK, unique), `amount_minor`, `status`, `external_id NULL`, `created_by`. Every
`sandbox_deposit` (simulator) and every staging `funding` transfer has one.

**`money.transfer_intent`** (the console's Send money and Simulate a deposit drawers, [MO-07], MS-16)

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | `tni_...`; used as the transfer's idempotency key |
| `kind` | text | `send` or `deposit` |
| `organization_id`, `mode`, `customer_id` | text | |
| `user_id`, `session_id` | text | the member and session that opened the drawer |
| `expires_at` | timestamptz | `created_at + 30 minutes` |
| `transfer_id` | text NULL | set by the transfer it created |

A transfer created with a `tni_` key must match the intent's organisation, mode, customer, kind and
user, and the intent must be unexpired; otherwise 422 `idempotency_key_reused`.

**`money.daily_counter`** (quotas counted exactly under a row lock, §17): `scope_id` (an organisation
or customer ID), `mode`, `day date` (UTC), `counter` (`transfers_out`, `deposits`, `deposit_minor`,
`beneficiaries_added`, `funding_minor_all`), `value bigint`; PK `(scope_id, mode, day, counter)`.

**`money.sandbox_epoch`**: `organization_id PK`, `epoch int NOT NULL DEFAULT 0`.

### 7.6 Provider records, ledger, reconciliation

**`money.provider_operation`** (the intent log, IDs only, kept 13 months): `id pop_`, `instance`,
`operation`, `subject_id`, `op_key`, `business_id`, `request_hash`, `outcome`, `code`, `http_status`,
`effect`, `attempt`, `duration_ms`, `request_id`, `run_id`, `started_at`. Index `(subject_id,
started_at DESC)`.

**`money.provider_event`** (the inbox, kept 90 days)

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | `pev_...` |
| `provider`, `instance` | text | |
| `event_type` | text | the provider's own, staff-only |
| `kind` | text | `ProviderEvent.kind` |
| `ref_kind`, `ref_id` | text | |
| `status` | text | raw |
| `occurred_at`, `received_at` | timestamptz | |
| `dedupe_key` | text | unique `(provider, instance, dedupe_key)` |
| `outcome` | text NULL | `applied`, `stale`, `unmatched`, `failed` |
| `outcome_code` | text NULL | |
| `processed_at` | timestamptz NULL | |
| `attempts` | int | |
| `lease_until`, `leased_by` | | |
| `matched_transfer_id`, `matched_customer_id` | text NULL | |

Index `(received_at) WHERE outcome IS NULL`. No payload column exists.

The ledger tables (`money.ledger_account`, `money.ledger_entry`, `money.ledger_line`,
`money.ledger_hold`, `money.ledger_head`) are §9.2. The reconciliation tables
(`money.reconciliation_run`, `money.reconciliation_break`, `money.reconciliation_cursor`) are §20.5.

The simulator's tables (`money.sim_*`) are §22.2.

### 7.7 Grants, guards and triggers

- `packages/db/roles/grants/money.json` (L-MON-01) and `money-simulator.json` (L-MON-02):
  `fin_payments` has `SELECT, INSERT, UPDATE` on every money table, `DELETE` on none except
  `money.provider_event` and `money.provider_operation` (retention sweeps) and the simulator's
  idempotency table; `EXECUTE` on `money.sequence_ledger()`.
- `fin_worker` has `SELECT` on the view `money.ledger_head_v` only, for anchoring (MS-14). This adds a
  cell to the grant matrix of ARCH §6.3.
- `fin_readonly` has `SELECT` on money tables with every `*_sealed` column revoked.
- `fin_backup` reads everything (the hourly high-value dump includes `money`, ARCH §4.5).
- Every other role: nothing. T-MON-31 runs each forbidden statement and expects SQLSTATE 42501.
- **Audit guards** (ARCH §8.2): deferred constraint triggers on `money.beneficiary`, `money.transfer` and
  `money.ledger_entry` refuse a commit unless the same transaction wrote an `audit.event` row whose
  `target` or `refs` name the row's ID (stored as `target_id` and `ref_ids`, spec 08 §3.5; T-MON-32).
- **Append-only**: `money.ledger_entry` and `money.ledger_line` refuse `UPDATE`, `DELETE` and
  `TRUNCATE`, except that `money.sequence_ledger()` (a `SECURITY DEFINER` function owned by
  `fin_owner`, `search_path` pinned) may set `seq`, `prev_hash` and `hash` once. `money.ledger_hold`
  allows only `status` and `closed_at` to change, once, from `active`.
- **Balance check**: a deferred constraint trigger on `money.ledger_line` refuses a commit in which
  any entry's lines do not sum to zero per currency, or an entry has fewer than two lines (T-MON-33).
- **Deletion guard** (BC-07, [MO-22]): `money.customer_deletable(customer_id)` and
  `money.organization_deletable(organization_id, mode)` return false while a customer account has a
  non-zero balance, an active hold or a non-final transfer; `payments` exposes them as door
  operations (§24.2) and `api` must call them before deleting (XC-05).

---

## 8. Sealed bank details and fingerprints

### 8.1 Families

As ARCH §6.6: `FIN_MONEY_SEAL_KEY_<n>` (AES-256-GCM, random 96-bit IV, value
`fdk<n>.<iv b64url>.<ciphertext b64url>`, HKDF-SHA256 salt `fin-seal-v1`, info `money:<organization>`,
AAD `<organization>:<table>.<column>`) and `FIN_MONEY_INDEX_KEY_<n>` (HMAC-SHA256, HKDF info
`fingerprint:beneficiary:<organization>`). Both are held by `payments` only. The code is
`packages/crypto`'s seal and keyed-hash functions; `packages/money/src/domain/sealed.ts` names the
fields and is the only caller.

### 8.2 What is sealed and what is clear

| Field | Stored | Shown to developers |
|---|---|---|
| Beneficiary full account number | sealed | last four only |
| Beneficiary holder name | sealed | in the console's Money tab and drawers (opened per read, like a customer's display name; not in the API) (MS-06) |
| Fedwire ID type and number | sealed | never |
| Beneficiary routing number, account type, bank name | clear | yes |
| Virtual account number | sealed | last four; full only in deposit instructions after a reveal (§11.4) |
| Virtual account name on account | sealed | with the deposit instructions |
| Virtual account bank, address, routing number, SWIFT | clear | yes |

### 8.3 The fingerprint

`fingerprint = HMAC-SHA256(subkey, "<routing_number>:<account_number>")`, 32 bytes, with
`fingerprint_version` naming the index key. It refuses a second active beneficiary with the same
account on the same rail group for the same customer (409 `beneficiary_exists`). A new index key is
rolled by dual writing and backfilling, as ARCH §6.6.

### 8.4 When a sealed value is opened

Only `openSealed(beneficiary, purpose)` and `openInstructions(virtualAccount, purpose)` open values,
in memory, for one of these purposes, each of which first writes its audit event in a short
transaction (§28):

| Purpose | Who | Audit event |
|---|---|---|
| `register` (a counterparty at a provider) | system, in `payments` | `beneficiary.sealed_opened` (staff scope) |
| `ownership_check` | system | `beneficiary.sealed_opened` (not used on Monday) |
| `display` (a beneficiary's full number to a member with `money.read` and a window) | member | `beneficiary.number_revealed` (organisation scope; built later, §1.3) |
| `instructions` (a virtual account's full deposit instructions) | member through the console with a window, or an API key with `money:read` | `virtual_account.instructions_revealed` (organisation scope) |
| `holder_name_display` | member, through the console | none: a log line with counts (MS-06) |

A value opened for one purpose is never passed to code for another, never logged (the scrubbers cover
9 to 17 digit runs and bank field names, §21.7) and never put in an error.

---

## 9. The ledger, holds and balances

### 9.1 Principles

ARCH §12.8 holds. In short: double-entry, append-only, integer minor units, postings in the same
transaction as the transfer's status change and its audit row; a deposit is credited only when the
provider confirms it completed; spendable is the ledger balance minus active holds, and never more
than the provider's own balance minus Fin's open holds at submit time (§13.3 step 4); simulator
entries live on the simulator instance and real-provider reconciliation never sees them.

### 9.2 Tables

**`money.ledger_account`**

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | `lac_...` |
| `kind` | text | `customer`, `external`, `provider_fees`, `treasury` |
| `instance` | text | |
| `currency` | char(3) | |
| `organization_id`, `mode`, `customer_id`, `provider_balance_id` | text NULL | set for `customer` accounts only |
| `balance_minor` | bigint | maintained by a trigger on `ledger_line` |
| `held_minor` | bigint | maintained by a trigger on `ledger_hold` |

Unique `(provider_balance_id, currency) WHERE kind = 'customer'` and `(kind, instance, currency)
WHERE kind <> 'customer'`. Customer accounts are created with the provider balance (§10.3); the three
instance accounts per instance and currency are created at start.

**`money.ledger_entry`**: `id len_ PK`, `instance`, `organization_id NULL`, `mode NULL`, `kind`
(§9.3), `transfer_id NULL`, `funding_id NULL`, `break_id NULL`, `occurred_at`, `posted_at`,
`simulated boolean`, `seq bigint NULL`, `prev_hash bytea NULL`, `hash bytea NULL`. Unique
`(transfer_id, kind) WHERE transfer_id IS NOT NULL` ([MO-22]); unique `(seq)`.

**`money.ledger_line`**: `entry_id` (FK), `line_no smallint`, `account_id` (FK), `amount_minor bigint`
(signed, never zero), `currency`; PK `(entry_id, line_no)`.

**`money.ledger_hold`**: `id hld_ PK`, `account_id` (FK, a customer account), `transfer_id` (FK,
unique), `amount_minor`, `status` (`active`, `converted`, `released`), `closed_at`.

**`money.ledger_head`**: `seq bigint PK`, `entry_id`, `hash bytea`, `computed_at`. The view
`money.ledger_head_v` shows the newest row only.

### 9.3 Postings

Sign convention: an account's balance is the sum of its lines; every entry sums to zero. A customer
account's positive balance is money the customer holds; `external` goes negative as money enters
from outside.

| Entry `kind` | When | Lines (A amount, F fee, C fee ceiling) | Hold |
|---|---|---|---|
| `deposit_credit` | a deposit is confirmed completed | external `-A`; customer `+(A - F)`; provider_fees `+F` | |
| `deposit_return` | a completed deposit is returned | customer `-(A - F)`; external `+(A - F)` | |
| `sandbox_deposit_credit` | a Sandbox plain deposit completes (simulator) | treasury `-A`; customer `+A` | |
| `funding_credit` | a staging treasury load completes (§14.4) | treasury `-A`; customer `+A` | |
| (none) | a payout is created | | a hold of `A + C` |
| `payout_debit` | the provider accepts the commit (`committed: true`) | customer `-(A + F)`; external `+A`; provider_fees `+F` | the hold becomes `converted` |
| (none) | a payout ends before commit (refused, cancelled, stopped, timed out) | | the hold becomes `released` |
| `payout_reversal` | a committed payout fails or is cancelled | customer `+(A + F')`; external `-A`; provider_fees `-F'` (F' the fee the provider gave back, else 0, and then a `provider_fees` line is omitted) | |
| `payout_return` | a payout is returned (while processing or after completion) | customer `+A`; external `-A`; the fee is not returned unless the provider's read says so | |
| `correction` | staff resolve a break with a correcting entry (stretch, §27.3) | any balanced set naming the break | |

`F'` and the returned fee come from the adapter's `PayoutState.feeMinor` on the read that reports the
end; MassPay charges nothing for a cancellation before commit and does not return the fee on a bank
return (MassPay's payout documentation, read 21 Nov 2026). `payout_return` after `payout_reversal` cannot happen because each is final, and the
unique `(transfer_id, kind)` stops a second posting of either.

**Sent after it ended** (§13.4): when a provider reports a commit for a transfer Fin had ended, the
domain posts `payout_debit` even if it takes the customer account below zero, records a
`sent_after_end` break, trips the instance switch and pages (§20.4).

### 9.4 Balances

- `balance = ledger_account.balance_minor`, `held = held_minor`,
  `spendable = max(0, balance - held)`.
- Every write that checks spendable takes `SELECT ... FOR UPDATE` on the customer account first, so
  20 concurrent sends serialise on that row and the balance never goes below zero (AC-MON-02).
- A nightly job recomputes every account's balance and held from lines and holds and writes a
  `ledger_drift` break on any difference (T-MON-34).

### 9.5 The ledger head (MS-14)

- A `payments` duty, the ledger sequencer, runs every 10 seconds under the money scheduler lease:
  it calls `money.sequence_ledger()`, which gives each unsequenced entry of a finished transaction a
  gapless `seq`, the previous entry's hash and its own `hash` (SHA-256 over length-prefixed fields:
  `seq`, entry ID, instance, kind, transfer ID, `occurred_at`, then each line's account ID, amount and
  currency in `line_no` order), and inserts a `money.ledger_head` row.
- Unsequenced entries older than 60 seconds write `money.ledger_unsequenced` (alert §30.3).
- Once a day the worker reads `money.ledger_head_v` and writes the write-once object
  `ledger/head/e<epoch>/<seq, 12 digits>-<first 16 hex of hash>` to the R2 audit bucket, and ships a
  `ledger.head` line (ARCH §8.4). The worker-side code is `apps/api/src/worker/ledger-anchor/**` (L-MON-04).
- A TypeScript recomputation of the chain is in `packages/money/src/ledger/chain.ts` and is tested
  against the SQL function (T-MON-35).

---

## 10. Holders (provisioning)

### 10.1 How `payments` learns about customers (XC-02)

`payments` cannot read `kyc`. `api` tells it, in the same transaction as each customer change, by
calling `ops.enqueue_job('money.customer_changed', payload)` (a checked function in the [DA-14]
pattern: `fin_api` may enqueue only `money.*` kinds, and only `fin_payments` may claim them), then
`NOTIFY payments_jobs`. The payload is IDs and codes only:

```json
{ "customer_id": "cus_...", "organization_id": "org_...", "mode": "sandbox",
  "type": "individual", "status": "approved", "status_seq": 7, "country": "MX",
  "event": "status_changed" }
```

`event` is one of `status_changed`, `deleted`, `erased`, `sandbox_reset` (with `organization_id` and
`mode` only). `api` sends it on every customer status change, on delete, on erasure and on a Sandbox
reset. The Sunday spec owns the calls; this spec owns the payload and the handler
(`apps/payments/src/jobs/customer-changed.ts`).

The handler, in one transaction: ignores a payload whose `status_seq` is not greater than the
holder's; creates the holder on the first `approved` (state `owed`, `next_attempt_at = now`,
`epoch` from `money.sandbox_epoch`), or for a business creates it `skipped` with
`business_not_supported`; mirrors `customer_status` on every change; on `approved` again resets a
`failed` or `skipped` (not a business) holder to `owed` with attempts 0; on `deleted`, `erased` or
`sandbox_reset` sets `closed` with the reason and marks its open virtual account for closing.
Leaving `approved` does not close anything: it refuses new money writes (409 `not_approved`) while
reads continue.

### 10.2 States

| State | Meaning | Next |
|---|---|---|
| `owed` | approved, nothing at the provider yet | claimed by the provisioning job |
| `creating` | a job holds it and is calling the provider | `active`, `locked`, `failed`, `skipped`, or `owed` with backoff |
| `active` | holder and balance exist at the instance | `locked`, `closed` |
| `locked` | the provider locked the holder (an RFI or review) | re-read hourly; back to `active` when unlocked |
| `failed` | a refusal no retry mends, or 8 attempts spent | `owed` on the next approval |
| `skipped` | a business, or fields missing | `owed` on the next approval; a `missing_fields` holder is also made due once a day |
| `closed` | customer deleted, erased or Sandbox reset | final |

### 10.3 The provisioning job (`holders`, every minute and on wake)

Claims due holders one at a time (ARCH §4.6 claim, lease 2 minutes, at most 20 a run, at most 5 per
organisation a run, no new item after 25 seconds), then:

1. Customer status not `approved`: back to `owed`, `next_attempt_at = null`, reason `not_approved`.
2. No instance yet: route (§6.3). A business: `skipped`. No route: `failed`.
3. Ask `api`'s holder door (§24.3) for the instance's `requiredFields`. A missing field: `skipped`,
   `missing_fields` with the names. For the simulator the door returns presence only (MS-05).
4. `ensureHolder` with `OpKey { idempotencyKey: "<cus>.holder.<first 16 hex of SHA-256 of the canonical input>", finId: cus, businessId: cus }`.
   Then one transaction writes `money.provider_holder`, sets `kyc_shared_at` and writes
   `money.holder.state_changed` (§28). (`api` has already written `money.holder_details_shared` in
   the holder door's own transaction.)
5. Holder status `locked`: `locked`, re-read in 1 hour. `closed`: `failed`, `provider_closed`.
6. `ensureBalance(holder, "USD")` with key `<cus>.balance.usd`; write `money.provider_balance` and
   the customer's `money.ledger_account`.
7. If `auto_open_virtual_account` and the customer has no `opening` or `open` account: insert one
   `opening` (§11.2) and drive it.
8. `active`, attempts 0.

**Failure policy:** `retry` outcomes and the faults `unauthorized`, `forbidden` and
`invalid_response`: `owed` with backoff `min(60, 2^(n-1))` minutes. `unknown` with `after_key_lapse`
(a MassPay 500): `owed` at `now + 24 hours + 10 minutes`. `refused/holder_conflict`: `failed`
(staff-visible). 8 attempts: `failed`, `attempts_exhausted`, alert `provisioning-failed`. A locked
holder is read hourly (`readHolder`) and alerts `holder-locked` once. Once a day the job sets every
`skipped` holder whose reason is `missing_fields` due again, so details completed after approval are
picked up.

---

## 11. Virtual accounts

### 11.1 States

`opening` (a row exists; the provider call may be under way), `open` (instructions sealed), `closed`,
`failed`. One `opening` or `open` per customer.

### 11.2 Opening

Triggered by provisioning (§10.3 step 7), `va.open` from the console or the API (§24.2), or staff
retry (stretch). `va.open` answers the existing `opening` or `open` account if there is one.

1. Preconditions, under the holder's row lock: holder `active` (else 409 `account_not_ready` with
   `reason`: `opening`, `needs_details`, `refused`, `under_review`, `closed`); customer status
   `approved` (else 409 `not_approved`); a business: 409 `not_supported`.
2. Test-seal a constant with the organisation's money key first, so a broken keyring opens nothing.
3. Insert the `opening` row, its `provider_virtual_account` (`op_key = "<vac>.open"`), and the audit
   event `virtual_account.requested`; commit.
4. `openVirtualAccount(holder, balance, { idempotencyKey: "<vac>.open", finId: vac, businessId: vac })`,
   outside any transaction, within 8 seconds in a request; the job continues otherwise.
5. Apply:
   - `ok` with instructions: seal account number and name on account, store the clear fields and
     last four, `open`, `opened_at`; audit `virtual_account.opened`; developer event
     `virtual_account.created`.
   - `ok` with `instructions: null` (opened but unreadable, MQ-05): close it at once with key
     `<vac>.close.<base36 ms>`, set `failed`, `instructions_unreadable`; the job opens a new one
     after 5 minutes, at most 3 times, then alerts `provisioning-failed`.
   - `refused`: `failed` with the code; audit `virtual_account.open_failed`.
   - `retry` or `unknown`: stays `opening`; the job calls again with the same key (an idempotent
     replay returns the same account, so `unknown` resolves with `retry_same_key`).
6. If another opener won the race (the unique index), the loser's provider account is closed.

### 11.3 Closing

On holder close, staff close (stretch), or replacement: set `closed` with `close_reason` and audit
`virtual_account.closed` and developer event `virtual_account.closed`; then
`closeVirtualAccount` with `<vac>.close.<base36 ms>` (a new key per attempt, so a stored server
error is never met again). "Already closed" or "not found" counts as closed. Unconfirmed closes are
retried with backoff and counted by reconciliation (`accounts-not-closing`, §20).

### 11.4 Revealing deposit instructions

- **API:** `GET /v4/customers/{id}/virtual_account` answers the open account with full
  `deposit_instructions` and writes `virtual_account.instructions_revealed` (actor the key) in a
  transaction before answering (AC-MON-08).
- **Console:** the Money tab shows bank, address, routing number and name on account, and the
  account number masked as `•••• 4821` with a "Show account number" control. Showing it needs a
  factor in the last 5 minutes (a window, ARCH §7.4) and writes the same event (MS-07). The copy buttons
  copy the full number only after it is shown.
- `GET /v4/customers/{id}/virtual_accounts` and the console's lists never carry instructions.

---

## 12. Beneficiaries and counterparties

### 12.1 Input and validation (`packages/money/src/domain/beneficiaries.ts`)

| Field | Rule | Error (400 `invalid_beneficiary` with `field`) |
|---|---|---|
| `rail` | `ach` or `fedwire` | `rail` |
| `holder_name` | `packages/identity/src/names.ts` person-name rules, at most 60 characters | `holder_name` |
| `account_number` | `^\d{4,17}$` | `account_number` |
| `routing_number` | `^\d{9}$`; no ABA checksum in Fin, because the provider's own pattern is checked at registration and the documented failing test number must pass this step (MS-18) | `routing_number` |
| `account_type` | ACH: required, `checking` or `savings`; Fedwire: must be absent | `account_type` |
| `bank_name` | ACH: optional, at most 100 characters, names rules; Fedwire: must be absent | `bank_name` |
| `id_type` | Fedwire: required, `PASSPORT`, `DRIVER LICENCE`, `ID CARD`, `NATIONAL IDENTIFICATION NUMBER`; ACH: absent | `id_type` |
| `id_number` | Fedwire: spaces and dashes removed, upper-cased, then `^[A-Z0-9]{4,30}$`; ACH: absent | `id_number` |

Unknown fields: 400 `invalid_field` (ARCH §13.1 rule 2).

### 12.2 Adding

`beneficiary.create` (§24.2), with a step-up intent from the console ([SA-08]):

1. Holder `active`, customer `approved`, an individual (else 409 as §11.2 step 1).
2. The routed instance offers at least one rail of the rail group: else 409 `rail_unsupported`.
3. Idempotency (MS-17): an `Idempotency-Key`, when sent, is hashed; an existing beneficiary with the
   same key and request hash is answered again (200, `Idempotent-Replayed: true`); the same key with
   another request is 422 `idempotency_key_reused`.
4. One transaction under the customer's `money.daily_counter` row lock: at most 10 added per customer
   per UTC day, removed ones included (429 `beneficiary_limit`); fingerprint unique among active ones
   (409 `beneficiary_exists`); insert sealed; `first_payout_after = now + delay` (MS-21); audit
   `beneficiary.added`; developer event `beneficiary.created`; `email.enqueue('money/beneficiary-added', ...)`
   to the organisation's Super admins and Admins (§29.2), which bypasses per-kind limits and, if it
   cannot be queued, fails the whole transaction ([SA-41]).
5. After commit, in the request within 10 seconds: register a counterparty for each rail in `rails`
   at the routed instance (§12.3). Rails not registered in time are left to the `counterparties` job.
6. Answer 201 with the beneficiary.

### 12.3 Registering a counterparty

`registerCounterparty(holder, rail, details, op)` with
`op = { idempotencyKey: "<ben>.<rail>.<instance>", finId: ben, businessId: ben }`:

1. Insert or reuse the `provider_counterparty` row in `registering`; commit.
2. Open the sealed fields for `register` (audit `beneficiary.sealed_opened`, staff scope).
3. Call; apply in a new transaction: `ok` sets `registered`, `external_id`, `parts`, and audit
   `beneficiary.registered` (staff scope, with instance and rail); `refused` sets `refused` with code
   and field (`counterparty_invalid`, `counterparty_needs_more`), and the same event with
   `outcome: "refused"`; `retry` or `unknown` stays `registering` for the job.

A counterparty the provider later reports missing becomes `stale` and is registered again from the
sealed details with a new key `<ben>.<rail>.<instance>.<base36 ms>`, which is why [MO-03] keeps the
full number.

### 12.4 Removing

`beneficiary.remove` (intent from the console): `removed`, `removed_by`, `removed_at`, audit
`beneficiary.removed`, developer event `beneficiary.deleted`. Not gated on approval. Nothing is sent
to the provider (MassPay has no delete). A transfer already moving carries on; a new one is 409
`beneficiary_removed`.

---

## 13. Transfers out

### 13.1 States

```
pending ──commit accepted──▶ processing ──▶ completed ──return (within 5 days)──▶ returned
   │                            │  └──fail / cancel after commit──▶ failed | cancelled
   │                            └──return while processing──▶ returned
   ├──refused before commit, or stopped with nothing sent──▶ failed
   └──cancelled before commit──▶ cancelled
```

`failed`, `cancelled` and `returned` are final. The one exception is "sent after it ended" (§13.4).
`completed` is watched for returns until `watch_until` (5 days).

### 13.2 Creating (`transfer.create`)

Input (from the API or the console): `customer_id`, `beneficiary_id`, `kind` (a `PayoutRail`),
`amount`, `currency`, `external_id?`, and the idempotency key (the `Idempotency-Key` header, or the
console's `tni_` ID).

1. **Authorise** per caller (§24.1). Read the kill switches `live_money` (live mode) and
   `provider_instance:<instance>` (§31): on, 503 `temporarily_unavailable` with `Retry-After: 60`.
2. **Idempotency** (§16.1): hash the key; compute the request hash. An existing transfer in scope with
   the same hash is answered as it is now (`Idempotent-Replayed: true`, 200); with another hash, 422
   `idempotency_key_reused`.
3. **Holder and customer**: no holder or customer not `approved`: 409 `not_approved` (with
   `current_status`); a business: 409 `not_supported`; holder `locked`: 409 `money_locked`; holder not
   `active`: 409 `account_not_ready` with `reason`.
4. **Beneficiary**: not this customer's, organisation's or mode's: 404 `not_found`; `removed`: 409
   `beneficiary_removed`; `kind` not in `rails`: 400 `invalid_transfer` (`field: "kind"`);
   `first_payout_after > now`: 409 `beneficiary_not_ready` (MS-21).
5. **Route and limits**: the holder's instance must offer `kind` in `currency` (else 409
   `rail_unavailable`); `amount` from 1 to the rail's `maxMinor` and at most 1,000,000 (400
   `invalid_transfer`, `field: "amount"`).
6. **One transaction**: lock the customer's ledger account (`FOR UPDATE`) and the organisation's
   `transfers_out` counter row; at most 100 transfers out per organisation and mode per UTC day (429
   `transfer_limit`); `spendable >= amount + fee_ceiling` (else 409 `insufficient_funds`, nothing
   written); insert the transfer (`pending`, `next_check_at = now + 2 minutes`, lease held by this
   request), `transfer_provider` (§16.2), the hold; audit `transfer.created`; developer event
   `transfer.created`; mark the `tni_` intent used (console); set durability (§4 rule 2); commit.
7. **Drive** (§13.3) for up to 15 seconds.
8. **Answer** 201 with the transfer as it now stands. A `retry` or `unknown` outcome leaves it
   `pending`; the answer never names the provider or carries a provider error.

### 13.3 Driving and applying outcomes

`driveOut(transfer)` runs in the request and in the sweep, always holding the lease:

1. Re-read the row. Cancel asked: go to stop (step 6). Older than 10 minutes and still `pending`: go
   to stop. Durability `unconfirmed`: re-check; still unconfirmed, `next_check_at = now + 30 s`, end.
2. Read the kill switches; on, end (the deadline will stop it).
3. Ensure the counterparty for `(beneficiary, instance, kind)` is `registered`, registering it now if
   not (§12.3). `refused`: end the transfer `failed`, `beneficiary_refused`.
4. **Balance guard**: `readBalance(provider_balance)`. If the provider's available amount minus Fin's
   other open holds on that balance (and, where `reportedExcludesHolds` is false, minus Fin's open
   quotes, which are those holds) is below `amount + fee_ceiling`: end `failed`,
   `insufficient_funds`, release the hold, and record a `balance_guard` break when Fin's ledger said
   there was enough (§20). A `retry` or `unknown` read: `next_check_at = now + afterMs`, end; nothing
   is submitted on an unread balance.
5. `submitPayout({ holder, balance, counterparty, rail: kind, amountMinor, currency, maxFeeMinor: fee_ceiling, op }, state, checkpoint)`.
   Apply the outcome:

   | Outcome | Transfer | Ledger | Event |
   |---|---|---|---|
   | `ok`, `committed: true`, status `processing` | `processing`, `fee`, `total = amount + fee`, `committed_at` | `payout_debit`; hold `converted` | `transfer.updated` |
   | `ok`, status `completed` (single-shot providers) | `completed` | `payout_debit` | `transfer.completed` |
   | `ok`, `committed: false`, status `pending` | unchanged | | |
   | `ok`, status `failed` or `cancelled`, `committed: false` | `failed` or `cancelled` with the mapped reason | hold `released` | `transfer.failed` |
   | `refused` | `failed`, mapped reason | hold `released` | `transfer.failed` |
   | `retry` | unchanged, `next_check_at = now + afterMs` | | |
   | `unknown` | unchanged, `resolve` stored, `next_check_at = now + afterMs` | | |

6. **Stop**: `cancelPayout(ref, state, why, checkpoint)` with `why: "requested"` when a cancel was
   asked, else `"stopped"`; apply as the table above (`cancelled` with reason `cancelled` for a
   requested cancel, `failed` with `timed_out` for a deadline stop). `unknown` keeps reading. A stop
   never ends the row until the adapter returns `ok` or `refused`.

**Reasons** (public `reason`, with the screens' sentence):

| `PayoutReason` or domain cause | Public `reason` | Screens |
|---|---|---|
| `quote_expired` | `quote_expired` | "The bank's quote ran out before it was sent. Nothing was sent." |
| `insufficient_funds` | `insufficient_funds` | "The balance wasn't enough for the amount and the fee." |
| `holder_locked` | `customer_locked` | "The bank is reviewing this customer's account." |
| `counterparty_refused` and the `counterparty_*` refusals | `beneficiary_refused` | "The bank refused the beneficiary's details." |
| `fee_above_limit` | `fee_changed` (new, MS-19) | "The bank's fee went up after the review, so it wasn't sent." |
| `refused` | `refused` | "The bank refused it." |
| `cancelled` | `cancelled` | "It was cancelled." |
| `bank_return` | `bank_return` | "The receiving bank sent it back." |
| customer left `approved` while pending | `customer_not_approved` | "The customer isn't approved any more." |
| the 10-minute deadline | `timed_out` | "Fin couldn't confirm it with the bank in time, so it was stopped. Nothing was sent." |

Return reasons for Sandbox simulations: `account_closed` (R02), `no_account` (R03),
`invalid_account_number` (R04), `refused_by_receiver` (R23).

### 13.4 Sent after it ended

If an adapter read reports `committed: true` for a transfer Fin had ended `failed` or `cancelled`
(another writer ended it, or the provider took a commit late), the domain moves it to the reported
state (`processing` or `completed`) in one transaction with `payout_debit`, writes audit
`transfer.status_changed` with `source: "reconciliation"` and `exception: "sent_after_end"`, records a
`sent_after_end` break, and calls `ops.trip_switch('provider_instance:<instance>', 'sent_after_end')`
(§31). The alert `transfer-sent-after-end` pages.

### 13.5 Cancelling (`transfer.cancel`)

Out only; `pending` or `processing`; otherwise 409 `not_cancellable` with `current_status`. With a
step-up intent bound to the transfer ID from the console.

1. One transaction: `cancel_requested_at`, `cancel_requested_by`, audit `transfer.cancel_requested`.
   If `transfer_provider.submitted_at` is null (nothing was ever sent): also `cancelled`, reason
   `cancelled`, hold `released`, event `transfer.failed`; commit and answer.
2. Otherwise commit, then `cancelPayout(why: "requested")` within 10 seconds, and apply:
   `ok` `cancelled` (with `payout_reversal` if committed); `ok` with `cancelPending: true`: unchanged,
   the answer says the bank was asked; `refused/not_cancellable`: 409 `not_cancellable`; `retry` or
   `unknown`: unchanged, the sweep resolves it.

### 13.6 Watching and the sweep

The sweep is §19.2. A `completed` transfer is read every 6 hours until `watch_until`
(`completed_at + 5 days`) for a return. Stuck: `processing` for more than 24 hours, or `pending` for
more than 1 hour, counts towards `transfers-stuck` (§30.3).

---

## 14. Money in

### 14.1 Inbound states

`processing` (the provider has the deposit and it is not complete) or `pending` (a Sandbox plain
deposit before its call), then `completed` or `failed`; `completed` may become `returned`
(`deposit_return`). The posting happens only on `completed`.

### 14.2 Real deposits to a virtual account (live path; stretch on Monday, needed for PG-14)

Found three ways, all converging on one function, `recordDeposit(instance, depositRef, state)`:

1. A provider event of kind `deposit` (§18), read back with `readDeposits`.
2. The sweep polling `readDeposits(account, since)` for every `open` account with activity in the
   last 30 days, every 15 minutes, and daily for the rest.
3. The ledger walk finding an unmatched inbound entry (§20.3).

`recordDeposit`, in one transaction: insert `money.provider_deposit` (unique by provider reference;
a duplicate is a no-op, [MO-22]) and the inbound transfer (`kind: "deposit"`, `rail` from the
provider, `origin: "provider"`), audit `transfer.created` with actor `provider:<instance>`, developer
event `transfer.created`; if `completed`, also `deposit_credit`, `completed_at`, audit
`transfer.status_changed`, developer event `transfer.completed`. A later `completed` for a known
deposit applies the credit once (unique `(transfer_id, kind)`). A return reported by the provider
posts `deposit_return` and moves it to `returned` with `return_code`.

### 14.3 Sandbox deposits (simulator)

Routes §25.6 and the console's SimulateDeposit (§26.6). Sandbox mode only, `sandbox:deposit` scope or
`simulator.use` and `money.simulate` permissions, a window step-up from the console ([BC-01]).

| Kind | Adapter call | Result |
|---|---|---|
| `sandbox_deposit` (plain) | `fundFromTreasury` on the simulator, `op` `<tfu>.fund` | `completed` at once, `sandbox_deposit_credit` |
| bank deposit, `rail: "wire"` | `simulateInbound(account, "wire", amount, op)` | `completed` at once, `deposit_credit` |
| bank deposit, `rail: "ach"` | `simulateInbound(account, "ach", amount, op)` | `processing`; the simulator completes it after `FIN_SIM_ACH_DEPOSIT_SETTLE_SECONDS` through its own event (§22.4), or at once by "Complete now" |

Rules: `Idempotency-Key` required (400 `idempotency_key_missing`), stored hashed on the transfer;
amount 1 to 1,000,000; at most 20 deposits and 2,000,000 minor units per organisation per UTC day,
both kinds together, failed ones excluded (429 `deposit_limit`); a bank deposit needs an `open`
virtual account (409 `account_not_ready`). The old product's funding-wallet causes are gone, because
the simulator has no shared balance (MS-24). Audit `transfer.created` (kind and rail in metadata);
developer events `transfer.created` and, when completed, `transfer.completed`.

### 14.4 Treasury funding in staging's live mode (MS-23)

A live-mode customer in staging gets money for the AC-MON-13 drill only through
`pnpm fin money fund staging --customer cus_... --amount <minor> --reason "<text>"`. It registers an
operator run and starts a one-off Railway task on the `payments` image
(`dist/main.js --task treasury-fund --customer ... --amount ...`), which calls `fundFromTreasury` on
`masspay-sandbox` with `op = { idempotencyKey: "<tfu>.load", finId: tfu, businessId: tfu }`, records
a `funding` transfer and `funding_credit` on completion, audit `treasury.funding_created` (actor
`operator`). The task refuses when `FIN_ENVIRONMENT` is `production` and, separately, the adapter
refuses on any live production instance ([MO-21]). Daily cap across organisations: 10,000,000 minor
units (`funding_minor_all`). The rules for a load's answers are in §21.4.

---

## 15. Fees and quotes

### 15.1 Rules

- Only fees the provider quotes for the payout are shown and held, never a catalogue's (ARCH
  §12.12). Fin adds no fee of its own.
- The fee is on top of the amount and taken from the customer's balance. Deposits record the fee the
  provider reports (0 on MassPay loads).

### 15.2 The fee ceiling (MS-20)

Each `(instance, rail, currency)` has `fee_ceiling_minor` in `money.provider_method`. A payout holds
`amount + fee_ceiling` and the adapter refuses `fee_above_limit` (after stopping the quote) when the
quoted fee is higher. At commit the hold is converted and the debit is `amount + actual fee`, so the
difference returns to spendable at once. Fin's starting ceilings, set in the method table and
checked against the provider's quotes before live (PG-14):

| Rail | Ceiling (minor units) |
|---|---|
| `ach_same_day` | 500 |
| `ach_standard` | 500 |
| `fedwire` | 3500 |

The provider's quoted fees are commercial data and stay in the private provider note. The simulator
charges fees from its own method table, set below the ceilings, so Sandbox reviews show realistic
numbers without publishing a provider's prices.

### 15.3 The quote (`transfer.quote`, [MO-16])

`POST /v4/transfers/quote` and the console's review step. The same checks as §13.2 steps 1, 3, 4 and 5
(no idempotency, no quota, no row written), then `pricePayout` (registering the counterparty first if
it is not registered, §12.3), then answer `{ amount, fee, total, currency, kind }`. It holds nothing.
A provider failure is 502 `upstream_unavailable`. The console's call also returns `similar_recent`
(§26.5). Quota: 60 quotes per minute per organisation and mode (429 `rate_limited`). Scope
`money:read` (MS-22); console permission `money.transfer`.

---

## 16. Idempotency, three layers

### 16.1 Developer to Fin

- **Transfers and Sandbox deposits:** `Idempotency-Key` required (400 `idempotency_key_missing`),
  1 to 255 visible ASCII characters, quoted or bare form accepted (ARCH §13.3). Stored as
  `idempotency_key_sha256` on the transfer, bound for good. Scope `(organization_id, mode, key)`.
  The request hash is SHA-256 over the canonical JSON (sorted keys, no whitespace) of
  `{direction, customer_id, beneficiary_id, kind, rail, amount, currency, external_id}` with absent
  values as `null`. A replay answers the transfer as it is now with `Idempotent-Replayed: true`; a
  concurrent duplicate meets the unique index, reads the winner and answers it the same way (money
  never answers 409 `idempotency_request_in_progress`).
- **Beneficiary create:** key accepted, bound for good when sent (MS-17).
- **Virtual account open, cancel, removal, simulations:** key accepted and not stored; each is
  idempotent by state.
- **Console:** the Send money drawer's `tni_` ID is the key (§26.5); the SimulateDeposit drawer makes
  one key per drawer opening the same way, from a `tni_` row with `kind: "deposit"` (MS-16).

### 16.2 Fin to the provider ([MO-07], [MO-18])

| Call | `idempotencyKey` | `businessId` |
|---|---|---|
| `ensureHolder` | `<cus>.holder.<16 hex of the input hash>` | `<cus>` |
| `ensureBalance` | `<cus>.balance.<currency lower>` | `<cus>` |
| `openVirtualAccount` | `<vac>.open` | `<vac>` |
| `closeVirtualAccount` | `<vac>.close.<base36 ms>` | `<vac>` |
| `registerCounterparty` | `<ben>.<rail>.<instance>` (a re-registration adds `.<base36 ms>`) | `<ben>` |
| payout steps (inside the adapter) | `<op_key_base>.<step>` where `<step>` is `quote`, `commit`, `cancel-funds`, `cancel-stop` or `cancel.<base36 ms>` | `<business_id>` |
| `fundFromTreasury` | `<tfu>.load` (MassPay) or `<tfu>.fund` (simulator) | `<tfu>` |
| `pricePayout` | none (holds nothing) | none |

**The payout business ID** is derived from the developer's idempotency scope, not from Fin's row:

```
scope_hash  = SHA-256( organization_id + "\n" + mode + "\n" + idempotency_key )
base32      = Crockford base32 (lower case) of scope_hash, first 40 characters
business_id = "ft" + base32 + "-" + attempt          // attempt 1, then 2 on a re-quote; at most 45 characters
op_key_base = business_id
```

So if a failover loses the transfer row and the developer retries with the same key, the new row maps
to the same provider payout, which `readPayout` finds and adopts instead of paying twice
(T-MON-21). The derivation lives in `packages/money/src/domain/idempotency.ts` and is the only
place a business ID is made.

### 16.3 Provider business IDs

Each adapter checks `businessId.length <= capabilities().idempotency.businessIdMaxLength` before
sending (MassPay: 50). MassPay takes a `client_transfer_id` even while its payout is only a quote, so
a re-quote uses attempt 2 (MQ-08).

---

## 17. Limits and quotas

All counted in Postgres under row locks (`money.daily_counter`), enforced inside `payments` whatever
the caller, failing closed (ARCH §13.6).

| Limit | Value | Refusal |
|---|---|---|
| Transfer amount | 1 to 1,000,000 minor units, and within the rail's `minMinor` and `maxMinor` | 400 `invalid_transfer` (`field: "amount"`) |
| Transfers out | 100 per organisation and mode per UTC day | 429 `transfer_limit` |
| Beneficiaries added | 10 per customer per UTC day, removed ones included | 429 `beneficiary_limit` |
| Sandbox deposits | 20, or 2,000,000 minor units, per organisation per UTC day; each at most 1,000,000 | 429 `deposit_limit`; 400 `invalid_transfer` |
| Staging treasury funding | 10,000,000 minor units per day across organisations | task refuses |
| Quotes | 60 per minute per organisation and mode | 429 `rate_limited` |
| Console money writes that reach a provider | 120 per minute per organisation (the old `MONEY_LIMIT`), through the realm's Postgres limiter | 429 `rate_limited` |
| Door volume per calling service | a ceiling across organisations in the private overlay ([OB-13]) | 429 and alert `money-door-volume` |
| First payout to a new beneficiary | delay 0 in Sandbox; a delay set in the overlay for live (MS-21) | 409 `beneficiary_not_ready` |
| Daily value caps, second approver | not on Monday ([MO-19], H-04) | |

---

## 18. Provider events (the money hook door)

### 18.1 The path (F12)

1. The provider posts to `https://api.<zone>/hooks/money/<provider>/<instance>` (no API key). The
   Cloudflare rate rule excludes `/hooks/` (ARCH §5.7); an optional custom rule may allow only MassPay's
   published source addresses on `/hooks/money/masspay/*` in production only (staging's five custom
   rules are all in use, spec 01 §7.6), but the signature is the control.
2. `edge` (`apps/edge`, a route owned by L-MON-04 as `apps/edge/src/hooks/money.ts`, XC-07):
   `<provider>` and `<instance>` must name an enabled instance in the door matrix's hook list, else
   404 without forwarding; body at most 256 KB (413); a per-address limit from the overlay; forwards
   the raw bytes and only `content-type` and the provider's signature header
   (`x-masspay-signature`) to `payments` at `POST /door/hooks/money/<provider>/<instance>`, signed
   with the edge's caller key (audience `payments`).
3. `payments` (`apps/payments/src/hooks/money.ts`): verifies the caller signature; builds the
   instance's adapter; `verifyEvents({ headers, rawBody, receivedAt })`.
   - `{ ok: false }`: 401 `{ "error": "bad_signature" }` (or `stale`, `malformed`), and a
     `money.webhook_refused` line with `reason` and `instance`. Alert `provider-webhook-refused`.
   - `{ ok: true, events }`: insert each into `money.provider_event` with
     `ON CONFLICT (provider, instance, dedupe_key) DO NOTHING`; `NOTIFY money_events`; answer 200
     `{ "received": <n> }`. The whole handler has a 2-second budget, inside MassPay's 3 seconds.
4. No payload is stored. Holder events, which carry personal data, are dropped unparsed (MQ-19).

### 18.2 Processing (`provider-events` job, on wake and every minute)

Claims unprocessed events in `received_at` order (lease 2 minutes, at most 50 a run):

| `kind` | Match | Read back | Apply |
|---|---|---|---|
| `payout` | `transfer_provider.external_id`, else the business ID in the event | `readPayout` | §13.3's table, if the read's `occurredAt` is newer than `transfer_provider.occurred_at`, else `stale`; reset `check_step` to 0 |
| `deposit`, `deposit_return` | the virtual account's provider reference | `readDeposits(account, null)` | `recordDeposit` for each (§14.2) |
| `funding` | `treasury_funding.external_id` or business ID | `readFunding` | complete or fail the funding transfer |
| `holder` | `provider_holder.external_id` | `readHolder` | holder `locked` or back to `active` |
| `virtual_account`, `other` | | | `applied` with no change, or `unmatched` |

An event with no match is `unmatched`; a `payout` with no match is also handed to the orphan search
(§20.3). A handler failure sets `failed` after 5 attempts with backoff and alerts. Every state change
an event causes is audited with actor `provider:<instance>` and `via: "webhook"` (§28); the inbox row
itself is the record of receipt.

### 18.3 Webhook secrets and registration

The MassPay webhook (URL and event types) is created by `pnpm fin money webhook create <env>`, which
asks for the MassPay key at the secure prompt (on staging, until the owner is back, it reads the
sandbox key from its local secret file, [SA-22]), calls MassPay, and writes the returned secret
straight into `payments`' sealed `MASSPAY_WEBHOOK_SECRETS` without printing it (MS-10, L-MON-09).
Rotation: `pnpm fin money webhook rotate <env>` creates a second webhook, adds its secret, waits for
an event verified by it, then deletes the old webhook and secret. The event types subscribed:
`payout.created`, `payout.status`, `payin.created`, `payin.status`, `payin_deposit.returned`,
`payin_deposit.return_completed`, `load.created`, `load.status`, `load.reversed`, `user.status`.

---

## 19. Money jobs in `payments`

### 19.1 Duties

One scheduler lease row `payments` in `ops.scheduler_lease` (ARCH §4.6); one loop per duty with its own
still-running guard; each records `ops.duty_state` and writes one `job.run` line per run.

| Duty (`job` field) | Cadence | Work | Heartbeat or success alert |
|---|---|---|---|
| `holders` | every minute and on wake (`payments_jobs`) | §10.3 provisioning and lock re-reads | `provider-sync` (heartbeat, pinged by the combined money loop) |
| `customer-changed` | on wake and every minute | §10.1 job handler (`ops.job` kinds `money.*`) | `duty-stalled-customer-changed` |
| `transfers` | every minute and on wake | the sweep (§19.2) | `provider-sync` |
| `provider-events` | on wake (`money_events`) and every minute | §18.2 | `duty-stalled-provider-events` |
| `counterparties` | every minute | registrations left `registering` | `duty-stalled-counterparties` |
| `virtual-accounts` | every minute | `opening` accounts, closes to confirm, replacements | `duty-stalled-virtual-accounts` |
| `deposits-poll` | every 15 minutes | §14.2 polling (stretch) | `duty-stalled-deposits-poll` |
| `orphans` | every 5 minutes | §20.3 payouts | `duty-stalled-orphans` |
| `ledger-sequencer` | every 10 seconds | §9.5 | `ledger-unsequenced` |
| `reconcile-daily` | daily 02:15 UTC, or overdue | §20.2 to §20.4 | `reconcile-daily` (heartbeat) |
| `ledger-recompute` | daily 03:15 UTC | §9.4 drift check | its `job.run` line |
| `sim-settle` | every minute | the simulator's own progressions (§22.4) | `duty-stalled-sim-settle` |
| `conformance-nightly` | nightly 04:00 UTC, staging only | CS-01 to CS-30 against `masspay-sandbox` on synthetic data | notifies only |
| `retention` | hourly | delete provider events older than 90 days and provider operations older than 13 months | `duty-stalled-money-retention` |

A run's `job.run` line carries `processed`, `failed`, `stuck`, `oldestDueS` and `provider`.

### 19.2 The status sweep ([MO-23])

Claims transfers with `next_check_at <= now()` (lease 2 minutes, at most 20 a run, at most 5 per
organisation, pending first), within a per-instance call budget (MassPay: 5 calls per second from
the sweep, far under its limit). For each:

- `pending`: `driveOut` (§13.3).
- `processing`, or `completed` within its watch: `readPayout`, apply (§13.3).
- `outcome_simulated_at` set on a Sandbox transfer: the simulator answers from its own state.

Next check after a read that changed nothing: the ladder 1, 2, 5, 10, 30 minutes, then hourly
(`check_step` 0 to 5, then 6 onwards); `completed` in its watch every 6 hours; final: `null`. A
webhook resets `check_step` to 0. One full pass over every non-final transfer runs daily inside
`reconcile-daily`.

---

## 20. Reconciliation and automatic trips

### 20.1 What runs

Per real-provider instance (`masspay-*`), scheduled in `payments` ([MO-02], ARCH §12.11). The simulator
instance runs the same checks against its own tables in CI and staging, so the code paths are
exercised (AC-MON-06).

### 20.2 Balance check (daily)

For each `provider_balance`: `readBalance`, compared with the customer ledger account's `balance`.
For a `two_phase` provider whose `reportedExcludesHolds` is false, Fin's open holds are not
subtracted from the provider's figure (MQ-07). A difference is a
`balance_mismatch` break with expected and actual amounts.

### 20.3 Ledger walk (daily) and orphans (every 5 minutes)

- **Ledger walk:** for each provider balance, `readLedger(balance, cursor)` from
  `money.reconciliation_cursor`, page by page, saving the cursor after each page. Each entry is
  matched by `relatesTo` to a transfer's provider reference, a provider deposit or a treasury funding.
  Unmatched inbound (a deposit): `readDeposits` and `recordDeposit` (how a real deposit is found
  without an event). Unmatched outbound payout: an `orphan_payout` break. Amount differences:
  `amount_mismatch`.
- **Orphan payouts, every 5 minutes:** for each holder with money activity in the last 48 hours
  (a transfer created, or any `unknown` outcome), list the provider's payouts for the holder (MassPay:
  every payout of the user, matched by `client_transfer_id`) and look for any whose business ID has
  no `transfer_provider` row. One is an `orphan_payout` break. A full pass over every holder runs
  daily. A Fin transfer that is final while the provider still shows an open quote is an `open_quote`
  break, closed by cancelling the quote, and resolved automatically when the cancel is confirmed.
- **Unclosed accounts:** accounts `closed` in Fin whose provider close is unconfirmed after 3 attempts
  are counted and alert `accounts-not-closing`.

### 20.4 Breaks and trips

| Break `kind` | Raised by | Trips `provider_instance:<instance>` |
|---|---|---|
| `orphan_payout` | §20.3 | always |
| `sent_after_end` | §13.4 | always |
| `idempotency_mismatch` | an adapter `unknown` with code `idempotency_mismatch` (a Fin bug) | always |
| `balance_mismatch`, `amount_mismatch`, `unmatched_ledger_entry`, `status_mismatch`, `balance_guard`, `ledger_drift` | §20.2, §20.3, §13.3, §9.4 | when the count in a rolling hour or any single amount passes its threshold (overlay, [OB-13]) |
| `open_quote`, `unclosed_account` | §20.3 | never |

Each break is one `money.reconciliation_break` row, one staff-scope audit event
`money.reconciliation_break`, one `money.reconciliation_break` line, and the `reconciliation-break`
alert. A trip calls `ops.trip_switch(name, reason)`, which writes its own audit event and pages
`money-switch-tripped`; a person clears it (§31). Staff resolve breaks with `money.operate` and an
intent (stretch, §27.3).

### 20.5 Tables

**`money.reconciliation_run`**: `id rcr_`, `instance`, `kind` (`orphans`, `daily`), `started_at`,
`finished_at`, `result` (`ok`, `failed`, `partial`), `checked int`, `breaks int`.

**`money.reconciliation_break`**

| Column | Type | Rules |
|---|---|---|
| `id` | text PK | `rbk_...` |
| `run_id` | text NULL | |
| `instance` | text | |
| `kind` | text | §20.4 |
| `organization_id`, `mode`, `customer_id`, `transfer_id`, `provider_ref` | text NULL | |
| `expected_minor`, `actual_minor` | bigint NULL | |
| `currency` | char(3) NULL | |
| `status` | text | `open`, `resolved` |
| `tripped` | boolean | |
| `resolved_by`, `resolution_code`, `resolved_at` | NULL | `resolution_code` from a closed list: `provider_corrected`, `fin_corrected`, `explained`, `duplicate` |

**`money.reconciliation_cursor`**: `provider_balance_id PK`, `cursor text NULL`, `updated_at`.

---

## 21. The MassPay adapter

Rebuilt from this specification, the private provider note (§21.6) and MassPay's own documentation,
never copied from the old product ([G-04]).
Lives in `packages/money/src/providers/masspay/` (L-MON-03): `adapter.ts` (the interface),
`http.ts` (the client), `operations/*.ts` (one per MassPay call), `map.ts` (statuses, errors,
amounts), `events.ts` (`verifyEvents`), `config.ts`, `fixtures/` (synthetic answers for CI).

### 21.1 Configuration

- **Hosts, an allowlist in code:** `masspay.sandbox` is `https://staging-api.masspay.io/v1.0.0`;
  `masspay.live` is `https://api.masspay.io/v1.0.0`. Any other value refuses the build
  (`host_refused`). The live host is also refused unless the instance is `masspay-live` with
  `liveEnabled: true`, which only a reviewed change sets (PG-14).
- **Per instance:** the API key, webhook secrets, method table, email domain and (staging only) the
  funding wallet, from §2.3's variables.
- **Static egress:** `payments` has static outbound IPs on; MassPay's IP allowlist names them where
  MassPay offers it (CR-14). Nothing in code depends on the addresses; `pnpm fin verify` checks the
  service setting (ARCH §4.3).

### 21.2 The method table (`MASSPAY_METHODS`, MS-09)

JSON validated at start by `config.ts`:

```json
{ "version": "staging-2026-11-23",
  "payout": {
    "ach_same_day": { "method": "<dest token>", "currency": "USD", "feeCeilingMinor": 500 },
    "ach_standard": { "method": "<dest token>", "currency": "USD", "feeCeilingMinor": 500 },
    "fedwire":      { "method": "<dest token>", "currency": "USD", "feeCeilingMinor": 3500,
                      "idNumberAttribute": "<attr token>" } },
  "payin": { "bank_deposit": { "method": "<orgn token>", "currency": "USD" } } }
```

The repository holds only the schema and an example with placeholder values; the real tokens come
from an offline catalogue read and live only in the sealed variable. Field names and patterns are read
live from MassPay at registration (§21.4), never hard-coded.

### 21.3 HTTP rules (`http.ts`)

- `Authorization: Bearer <key>`; `Accept: application/json`; JSON bodies; `redirect: "manual"` (any 3xx
  is the fault `redirect`).
- A 10-second budget per operation covering every try and the body read (`AbortSignal.timeout`).
- Retries only on network errors, 429, 503 and 504: at most 3 tries, 500 ms doubling with half
  jitter, inside the budget, with the same key and the same body. **A 500 on a write is never
  retried**: its outcome is `unknown`, resolved by reading back or by waiting until the provider has
  forgotten the key (MQ-23).
- Every path segment is checked against `^[A-Za-z0-9_-]{1,128}$` before sending (else `invalid_request`).
- The provider's notifications to the holder are turned off on every holder, payout and load.
- Every field of an answer or an event that carries a credential, a link, an image or personal data
  Fin does not need is dropped at once, before any other code sees it (MQ-19, MQ-20). The private
  provider note lists the fields.
- Amounts: Fin sends a decimal string built from minor units (`12345` becomes `"123.45"`), and parses
  the provider's numbers back to minor units with exact decimal parsing, refusing more than two
  decimal places (MQ-10). A minor-unit value that is not a safe positive integer is refused before
  sending.
- Tokens are compared in one normalised form (`sameToken`, MQ-15).
- The key is never logged, never in an error, never in a `provider.call` line.

### 21.4 Operations

Each operation's ok rule checks the HTTP status, the body's status, the echoed tokens and the
amounts; anything else is the fault `invalid_response`. An answer is never classified by its HTTP
status alone. The provider's calls, fields and answer shapes, and the exact mapping of each answer,
are in the private provider note, one section per operation; L-MON-03 builds from it and from
MassPay's own documentation. The public plan fixes the outcomes each operation may give:

| Interface method | Rule and outcomes |
|---|---|
| `ensureHolder` | Look up by Fin's customer ID first and create only when none exists, with the generated email `<cus>@<email domain>` (MQ-01), never the customer's typed address. The holder's status maps to `active`, `locked` or `closed`. A conflict with another record: `refused/holder_conflict` |
| `readHolder` | The same token is echoed; an unknown holder is `refused/not_found` (MQ-16) |
| `ensureBalance` | One balance per holder and currency, created or found, owned by that holder |
| `readBalance` | The same token is echoed; the balance in minor units |
| `openVirtualAccount` | The deposit instructions (account `^\d{4,34}$`, routing `^\d{9}$`, bank, address, name on account) are validated and sealed from the creation answer at once. Missing or malformed instructions: `ok` with `instructions: null` (MQ-05). A declined opening: `refused/refused` |
| `closeVirtualAccount` | Closed, already closed or not found: `ok` |
| `readDeposits` | Each deposit's status maps to `completed`, `returned`, `failed` or `pending`, with its amount and rail; sender fields are never kept |
| `registerCounterparty` | The method's fields and patterns are read live, and each value is checked against them before sending, options matched without case. A required field Fin has no value for: `refused/counterparty_needs_more` with the field. The Fedwire identification number is always sent from Fin's row (MQ-14); the holder name is never sent (MQ-13). A validation refusal: `refused/counterparty_invalid`, with the field when the answer names one |
| `pricePayout` | A dry run that holds nothing; the fee and the echoed amount are checked (MQ-09) |
| `submitPayout` | The two-phase driver, §21.5 |
| `readPayout` | The provider's statuses map to `pending`, `processing`, `completed`, `cancelled`, `returned` (with its return code, MQ-27) and `failed`; a payout whose quote answer was lost is found by `client_transfer_id`; a forced status update is never asked for |
| `cancelPayout` | `ok` cancelled; `ok` with `cancelPending: true`; or `refused/not_cancellable`, except before commit, where an uncertain cancel is `unknown/read_back` until the quote has lapsed plus 2 minutes (MQ-07). Every spelling of the status field that the note lists is read (MQ-18) |
| `fundFromTreasury` (staging) | Only the answer the note names as a created load counts as `ok`, whatever the HTTP status (MQ-28). A duplicate: `unknown/read_back`; short funds: `refused/insufficient_funds`; any other refusal `refused/refused`; a 500 or an unreadable answer: `unknown/read_back` |
| `readFunding` | Matched on `client_load_id`; an unexpected page shape is `invalid_response` |
| `treasuryBalance` | The configured client wallet, by `sameToken` |
| `verifyEvents` | `X-MassPay-Signature: t=<unix ms>,s=<hex>`; HMAC-SHA512 with each active secret over `` `${t}\|${rawBody}` ``; a constant-time compare; `abs(now - t) <= 5 minutes`. Events map to `payout`, `deposit`, `deposit_return`, `funding` and `holder`; the dedupe key is `<event_type>:<token>:<status>:<occurred_at>`; the adapter branches on the event type, never the topic |
| `readLedger` | A cursor of 100 entries; only the answer shapes the note lists are accepted (MQ-17); entry types map to `payout`, `payout_reversal`, `deposit`, `deposit_return`, `funding`, `funding_reversal`, `fee` or `other`, with the entries they relate to |
| `probe` | Read-only account reads, used by `pnpm fin verify` and the deploy smoke |

### 21.5 The payout driver inside `submitPayout`

Continuation: `{ attempt, payoutToken, expiresAt, committedAsked }`, checkpointed after every step.

1. **Quote** (`attempt` 1, or 2 after an expired quote): a quote with the source wallet from Fin's
   row (MQ-11), the method, the attribute set, the amount and `client_transfer_id = business_id` for
   that attempt, key `<op_key_base>.quote`. A pending quote with the fee and the echoes: checkpoint
   `payoutToken` and `expiresAt` (2 minutes). Duplicate client ID: `unknown/read_back` (the quote
   exists, MQ-08). Short funds: `refused/insufficient_funds`. A locked or inactive holder:
   `refused/holder_locked` (MQ-24). A validation refusal: `refused/counterparty_invalid`. A 500:
   `unknown/read_back`. Timeout or network: `unknown/retry_same_key`.
2. **Fee check:** `fee > maxFeeMinor`: cancel with `.cancel-funds`, then `refused/fee_above_limit`.
3. **Commit:** checkpoint `committedAsked: true`, then the commit with key `<op_key_base>.commit`:
   - accepted: `ok` processing, `committed: true`, the fee from the quote;
   - the quote expired: one re-quote with attempt 2 (back to step 1), then `refused/quote_expired`;
   - short funds: `refused/insufficient_funds`; more counterparty data needed:
     `refused/counterparty_needs_more`;
   - **any other refusal or failure, whatever its HTTP status or body says** (MQ-02, MQ-03,
     MQ-04): `readHolder` and `readPayout` first; moved on: that state; still pending: stop (step 4);
   - a 500: `unknown/read_back` until the quote has lapsed plus 2 minutes;
   - timeout or network: `unknown/retry_same_key`.
4. **Stop:** cancel with `.cancel-stop`; then `unknown/read_back` with `afterMs` to `expiresAt + 2
   minutes`; the next read decides (expired, cancelled or never committed: `refused`; committed: the
   committed state).

### 21.6 The adapter's rules (MQ-01 to MQ-28, each one test, T-MON-50)

The behaviour Fin observed on its own MassPay sandbox account, which these rules answer, is kept in
the private provider note that the private overlay names ([G-09]), never in this repository: answer
shapes, fees, the account relationship, the credential's shape and token formats, and defects. Before
any observed behaviour of MassPay or Sumsub is published, here or in the adapter's code, tests and
fixtures, the owner checks the provider's API and sandbox terms (MS-30). The steward reports the
behaviours behind MQ-10 and MQ-11 to MassPay privately. Each rule has one test in
`masspay/rules.test.ts`, named by the neutral rule it proves.

| ID | Neutral rule |
|---|---|
| MQ-01 | One generated email per holder, `<cus>@<email domain>`; never the customer's typed address |
| MQ-02, MQ-03, MQ-04, MQ-28 | Every answer is classified by the operation's ok rule, never by its HTTP status alone; a refusal on a commit is believed only after the payout has been read back |
| MQ-05, MQ-06 | Deposit instructions are sealed from the creation answer at once; one virtual account per customer, reused |
| MQ-07 | A quote holds funds until it reads final, whatever the reported balance says; an uncertain cancel before commit waits for the quote to lapse |
| MQ-08 | A business ID that any call has used is never reused for a different request; a re-quote takes a new attempt number |
| MQ-09 | A dry run holds nothing and is never committed; auto-commit is never used |
| MQ-10 | A fraction of a minor unit is refused before sending; Fin never relies on the provider to refuse one |
| MQ-11, MQ-12 | The source balance of a payout always comes from Fin's row, never from the request or from anything the provider would accept |
| MQ-13, MQ-14 | Only the fields the method lists are sent, plus the Fedwire identification from Fin's row; a holder name is never sent, so payouts go in the customer's name ([MO-10]) |
| MQ-15 | Tokens are compared in one normalised form |
| MQ-16 | Every "not found" answer the note lists is read as not found, never as an error to retry |
| MQ-17 | Only the ledger shapes the note lists are accepted |
| MQ-18 | Every spelling of a status field that the note lists is read |
| MQ-19, MQ-20 | Credentials, links, images and personal data are dropped from answers and events at the adapter's edge |
| MQ-21 | Only fees the provider quotes for the payout are used, never a catalogue's |
| MQ-22 | Catalogue reads never happen in a request |
| MQ-23 | A 500 on a write is never retried under the same key: wait for the key to lapse, or read back |
| MQ-24 | A locked holder is refused every money operation and raises `holder-locked` for staff |
| MQ-25 | Method references come from the method table, never from documentation |
| MQ-26 | Sandbox mode never routes to the provider: its sandbox takes synthetic data only ([MO-05]) |
| MQ-27 | A return is recognised by its return code, whatever sequence of statuses carries it |

### 21.7 Logs and scrubbing

One `provider.call` line per call (§30.1), IDs only. `packages/core/src/scrub.ts` gains (XC-08):
MassPay's link hosts and paths, runs of 9 to 17 digits, the bank field names (`account_number`,
`routing_number`, `id_number` and the provider's own names for them, from the private note), the
provider's token shapes in free text, and the `X-MassPay-Signature` value. A scrubber test proves
each (T-MON-41).

### 21.8 Tests

- `http.test.ts`: the host guard; Bearer sent and absent from errors; the budget; no redirects; the
  key sent on each write and on retry with the same body; the retry list; never retrying a 500 on a
  write; each ok rule; amounts. Against a local stand-in server, never MassPay.
- `rules.test.ts`: MQ-01 to MQ-28, each named by its neutral rule.
- The conformance suite with a recorded-answer stand-in (§23). Fixtures are synthetic: fake tokens in
  the provider's shapes, never real sandbox answers or tokens (MS-11), and they carry no observed
  defect as a named case until MS-30 is answered.
- Nightly in staging: the conformance suite against MassPay's sandbox on synthetic data with the
  published test numbers; the key never enters CI.

### 21.9 SP-13, Monday 08:00 to 09:00 on staging (with CR-14)

Pass rule, recorded in `docs/plan/spikes.md`: (a) a signed webhook from MassPay's sandbox verifies
with HMAC-SHA512 over `t|raw body`; (b) after a quote whose answer is dropped by the stand-in proxy,
`GET /payout/{u}` finds the payout by `client_transfer_id`; (c) the duplicate client ID answer's
shape; (d) both ledger shapes, or the one the sandbox answers; (e) the new key works from `payments`'
static addresses and is refused from elsewhere if the allowlist is on; (f) whether two keys can be
live at once (rotation overlap). A failing (b) changes `readPayout`'s lost-answer path to "wait for
the quote to lapse, then treat as not sent unless the ledger walk finds it", recorded as a risk.

---

## 22. The Fin simulator adapter

### 22.1 What it is

`fin-simulator` implements the whole interface in `payments`' own tables, on its own instance, for
Sandbox mode in every environment ([MO-05], ARCH §12.13). It declares the live route's rails, limits,
holder fields and business rule (§5.2). It is the conformance suite's reference. It can never be the
routed adapter of a live production instance (§6.4). Its external IDs are
`fsim_<kind>_<26 Crockford characters>`.

### 22.2 Tables (`money.sim_*`, L-MON-02, migration `*_money_simulator_*.sql`)

| Table | Holds |
|---|---|
| `money.sim_holder` | external ID, Fin customer ID, status (`active`, `locked`, `review`, `closed`), fields present |
| `money.sim_balance` | external ID, holder, currency, `available_minor`, `held_minor` |
| `money.sim_account` | external ID, balance, status, account number (synthetic, generated `9600` plus 6 digits), routing number `000000001` (assigned to no bank, so no real payment can reach it; Fin does not check ABA checksums, MS-18), bank name "Sandbox Bank" |
| `money.sim_counterparty` | external ID, holder, rail, routing number, last four, `fails_at` (`none`, `commit`) from the test values |
| `money.sim_payout` | external ID, business ID, holder, counterparty, rail, amount, fee, status, committed, `settle_at`, return code |
| `money.sim_deposit` | external ID, account, rail, amount, status, `settle_at` |
| `money.sim_funding` | external ID, business ID, holder, amount, status |
| `money.sim_idempotency` | op key, request hash, stored outcome JSON, `expires_at` (30 days) |
| `money.sim_ledger` | ordered entries per balance, for `readLedger` |
| `money.sim_event` | events waiting for `sim-settle` to deliver in-process |

The simulator stores no personal data: `ensureHolder` receives presence only (MS-05), and
`registerCounterparty` keeps routing number and last four, never the full account number or name.

### 22.3 Behaviour

- Idempotency: the same op key and request hash returns the stored outcome; the same key with
  another hash is `unknown/idempotency_mismatch` (which trips the switch, as it would live).
- Holders: `requiredFields` present: `active`; otherwise `refused/holder_details_missing`.
- Virtual accounts: persistent, instructions always readable, inbound ACH and wire.
- Payouts: `two_phase` internally (a quote then a commit, both instant); fees per §15.2; a
  counterparty whose routing number is a "fails at commit" test value is refused at commit with
  `counterparty_invalid`; committed payouts settle to `completed` at `settle_at`
  (`FIN_SIM_PAYOUT_SETTLE_SECONDS`, default 600) through `sim-settle`.
- `simulateOutcome`: `complete` (processing only), `fail` (processing only, never pending, because a
  pending payout may have been committed), `return` (processing or completed, with a return code).
- Deposits: `simulateInbound` wire completes at once; ACH settles after
  `FIN_SIM_ACH_DEPOSIT_SETTLE_SECONDS`.
- Funding: `fundFromTreasury` completes at once from an unlimited simulator treasury.

### 22.4 Events

`sim-settle` (every minute) moves due payouts and deposits on, writes a `money.sim_event`, and
inserts the matching `money.provider_event` rows directly (an in-process webhook with the same
dedupe rules), then `NOTIFY money_events`. So Sandbox exercises the same inbox, read-back and apply
path as live.

### 22.5 Test values (one catalogue)

`packages/contract/src/money/test-values.ts` (browser-safe, L-MON-02) is shared by the simulator,
the console's Add beneficiary "Test details" box and the docs ([AP-09], ARCH §12.13). It uses MassPay's
published sandbox numbers so the same values also work on staging's live mode:

| Fill | Rail | Routing | Account | Account type | Outcome |
|---|---|---|---|---|---|
| "Fill ACH" | ACH | 021000021 | 13849131 | Checking | sent |
| "Fill Fedwire" | Fedwire | 021000021 | 13849131 | (ID type Passport, ID number X1234567) | sent |
| "Fill a failing account" | ACH | 021000022 | 13849131 | Checking | refused when the money is sent |

Holder names in the fills are made up and never a real person.

### 22.6 Test-only controls

In the `test` image target only ([SA-38]), `packages/testing/src/money/simulator-controls.ts`
exposes: `failNext(operation, outcome)`, `loseNextAnswer(operation)` (the call takes effect and the
adapter answers `unknown`), `replayServerError(opKey)`, `forgetAnswers()`, `holdNextCommit()`,
`lockHolder(customer)`, `dropNextEvent()`, `setBalance(balance, minor)`, `advanceSettle(seconds)`.
The release image has none, and CI's seam job proves it (exit 78, ARCH §3.5).

---

## 23. The conformance suite

### 23.1 Shape

`packages/money/src/conformance/` (L-MON-02) exports
`runConformance(name, makeAdapter, controls, options)`, a Vitest suite factory. Each scenario
declares the capabilities it needs and is skipped, with a printed reason, when the adapter does not
declare them. Three runs: the simulator in CI; the MassPay adapter against the recorded-answer
stand-in in CI; MassPay's sandbox nightly from staging (§19.1). AC-MON-01.

### 23.2 Scenarios

| ID | Scenario | Expect |
|---|---|---|
| CS-01 | `ensureHolder` twice with the same key | one holder, the same ref |
| CS-02 | `ensureHolder` finds an existing holder by the Fin customer ID before creating | no second holder |
| CS-03 | `ensureBalance` twice | one balance per currency |
| CS-04 | `openVirtualAccount` then replay with the same key | the same account and number |
| CS-05 | Instructions unreadable on open | `ok` with `instructions: null` |
| CS-06 | `closeVirtualAccount` twice, and on an unknown account | `ok` each time |
| CS-07 | `registerCounterparty` with a value the provider refuses | `refused/counterparty_invalid` with the field |
| CS-08 | `pricePayout` | a fee, nothing held, balance unchanged |
| CS-09 | `submitPayout` happy path | `processing`, `committed: true`, fee within `maxFeeMinor` |
| CS-10 | Quote fee above `maxFeeMinor` | `refused/fee_above_limit`, nothing committed |
| CS-11 | Quote answer lost | `unknown`; `readPayout` with `payout: null` finds it by business ID |
| CS-12 | Commit answer lost | `unknown/retry_same_key`; the replay with the same key is the same payout, committed once |
| CS-13 | Commit returns 500 | `unknown/read_back` or `after_key_lapse`; never `refused` |
| CS-14 | Commit refused (any 4xx) after which the payout is not committed | `refused` only after a read |
| CS-15 | Quote expired at commit | one re-quote with attempt 2, then `refused/quote_expired` |
| CS-16 | Insufficient funds at quote | `refused/insufficient_funds` |
| CS-17 | Holder locked | `refused/holder_locked` on every write |
| CS-18 | Cancel before commit | `ok` cancelled, and no later commit by Fin |
| CS-19 | Cancel racing a commit | the final read decides; never both cancelled and debited |
| CS-20 | Cancel after commit | `ok` cancelled, or `cancelPending`, or `refused/not_cancellable` |
| CS-21 | Same op key with a different body | `unknown/idempotency_mismatch` |
| CS-22 | A duplicate funding load | `unknown/read_back`; `readFunding` finds one load |
| CS-23 | A return after completion | `readPayout` reports `returned` with a return code |
| CS-24 | A webhook signed right, wrong, stale and replayed | ok; `bad_signature`; `stale`; the same dedupe key |
| CS-25 | A webhook that never arrives | the sweep's read finds the change |
| CS-26 | `readLedger` paging with a cursor | every entry once, in order |
| CS-27 | `readDeposits` with a completed and a pending deposit | two states, amounts exact |
| CS-28 | Amounts: 1 minor unit, the rail maximum, and a value over it | exact; the last refused before sending |
| CS-29 | `probe` | `ok`, and no write made |
| CS-30 | `simulate*` and `fundFromTreasury` on a live instance in production | `refused/simulation_refused` |

### 23.3 What conformance does not replace

The domain's integration tests (§33) cover the ledger, holds, durability, concurrency and audit; the
suite covers only what an adapter promises.

### 23.4 A second adapter skeleton (stretch)

`packages/money/src/providers/skeleton/` implements `capabilities()`, `probe()`, `verifyEvents()` and
the read methods against a local stand-in, and passes CS-24, CS-26, CS-27 and CS-29, to prove the
interface takes a second provider without domain changes.

---

## 24. Door operations

### 24.1 What `payments` checks for each caller (ARCH §7.9, [SA-36])

| Caller | Assertion | `payments` re-checks itself |
|---|---|---|
| `api` (public API) | the edge's signed key assertion, forwarded unchanged inside `api`'s own signed call | the key record through `keys.key_lookup`: exists, not revoked, not expired, organisation, mode and scopes match; a live key with `money:write` or `beneficiaries:write` carries an IP allowlist ([MO-20], else 403 `forbidden` with `reason: "ip_allowlist_required"`); the client IP in the assertion is inside it; the organisation's live status for live mode |
| `console` | user, session, organisation, mode, and for writes the step-up intent ID or window proof | the session is live and the user's; membership with the permission; the privileged-factor hold ([SA-05]); the intent exists, is unused, belongs to the session, names the operation and its parameter digest matches the request; then consumes it in the operation's transaction |
| `admin` | the raw Access JWT, the staff session, the proof | the Access token (signature, `iss`, `aud`, `exp`, `nbf`, staff list); the staff session at `aal2` with the staff permission; the intent for an operation |
| always | | organisation and mode on every row touched; the customer and beneficiary belong together; kill switches; quotas; the balance; door volume per caller |

Intent parameter digests (ARCH §7.4), computed by `packages/identity` from these fields, in this order:

| Operation | Digest fields |
|---|---|
| `beneficiary.create` | `organization_id, mode, customer_id, rail, routing_number, account_last4, account_type, bank_name` (never the full number or the name) |
| `beneficiary.remove` | `organization_id, mode, customer_id, beneficiary_id` |
| `transfer.create` | `organization_id, mode, customer_id, beneficiary_id, kind, amount, currency, source` where `source` is the customer's `provider_balance_id` read by the server, plus the `tni_` ID ([SA-08]) |
| `transfer.cancel` | `organization_id, mode, transfer_id` |

### 24.2 The money door (`payments`, `packages/server/src/doors/payments.ts`, L-MON-03)

Path `POST /door/money/<operation>`; JSON in and out; every answer `Cache-Control: no-store`. Errors
are Fin's problem codes (§25.6), which `api` and the web apps pass on.

| Operation | Callers | Permission or scope | Step-up (console) | Mode | Notes |
|---|---|---|---|---|---|
| `money_tab.get` | console | `money.read` | none | both | §26.3 |
| `balance.get` | api, console | `money:read` / `money.read` | none | both | ledger only, no provider call |
| `va.get` | api | `money:read` | | both | full instructions; writes `virtual_account.instructions_revealed` |
| `va.reveal` | console | `money.read` | window | both | the same, for the console |
| `va.list_for_customer` | api, console | `money:read` / `money.read` | none | both | no instructions |
| `va.list` | console | `money.read` (+ `customers.read`) | none | both | organisation-wide |
| `va.open` | api, console | `money:write` / `money.transfer` | window | both | §11.2 |
| `beneficiary.list` | api, console | `money:read` / `money.read` | none | both | the console's answer carries holder names; `api`'s never does |
| `beneficiary.get` | api, console | as above | none | both | |
| `beneficiary.create` | api, console | `beneficiaries:write` / `money.beneficiaries` | intent | both | §12.2 |
| `beneficiary.remove` | api, console | as above | intent | both | §12.4 |
| `transfer_intent.create` | console | `money.transfer` (or `money.simulate` for `kind: "deposit"`) | none | both | §26.5 |
| `transfer.quote` | api, console | `money:read` / `money.transfer` | none | both | §15.3 |
| `transfer.create` | api, console | `money:write` / `money.transfer` | intent | both | §13.2 |
| `transfer.get`, `transfer.list` | api, console | `money:read` / `money.read` | none | both | |
| `transfer.cancel` | api, console | `money:write` / `money.transfer` | intent | both | §13.5 |
| `sandbox.deposit`, `sandbox.bank_deposit` | api, console | `sandbox:deposit` / `simulator.use` + `money.simulate` | window | sandbox only | §14.3 |
| `sandbox.transfer_simulate` | api, console | `sandbox:simulate` + `money:read` / `simulator.use` | window | sandbox only | §22.3 |
| `customer.deletable`, `organization.deletable` | api, console | (internal) | | both | BC-07, XC-05 |
| `admin.*` | admin | staff `money.read`, `money.operate` | intent for operate | both | §27 |

Every operation is in the door matrix with its quota; anything else is 403 with an alerting
`api.outside_request` line.

### 24.3 `api`'s holder door (L-MON-05, `apps/api/src/doors/holder/**`, `packages/server/src/doors/api-holder.ts`)

`POST /door/holder/details` from `payments` only:

```json
{ "customer_id": "cus_...", "organization_id": "org_...", "mode": "live",
  "instance_kind": "provider", "fields": ["first_name", "last_name", "date_of_birth", "..."] }
```

`api` checks: the customer exists in that organisation and mode, is an `approved` individual; at most
10 reads per customer per day; `fields` is a subset of the allowed holder fields. For
`instance_kind: "provider"` it opens the values from Sumsub (live, one of ARCH §6.5's reads, now a sixth
place, recorded in MS-05) or from the sealed Sandbox values, and answers `{ "fields": { ... },
"present": [...] }`; for `instance_kind: "simulator"` it answers `{ "fields": null, "present": [...] }`
and never opens a value. It writes `money.holder_details_shared` (organisation scope; metadata the
field names and the instance kind, never values or the provider's name) in the same transaction as
the rate-window update.

---

## 25. Public API routes (R16)

### 25.1 Conventions

ARCH §13.1 to ARCH §13.6 apply. Money specifics: amounts as `amount`, `fee`, `total` in integer minor units
with `currency` ([MO-08]); USD only; no provider named anywhere; provider failures are 502
`upstream_unavailable`; live keys with money scopes must carry an IP allowlist ([MO-20]); a live-mode
money call while the environment's live instance is disabled is 403 `sandbox_only`; every write is
audited with `via: "api"`, the key ID and the mode, and money events carry the idempotency key's
hash (ARCH §13.1 rule 12).

Spec 05 owns the public API's names and conventions (README §8.3): the operation IDs, paths and scopes
in spec 05 §6.8 and §6.9, and the paging and filter parameters of spec 05 §3.5. This section owns the
money routes' bodies, answers, codes and door operations, and spec 05 §6.8 follows it on those.

Routes are defined once in `packages/contract/src/money/*.ts` with `@hono/zod-openapi` and generate
`packages/contract/openapi/money.json` (L-MON-05). `api`'s handlers
(`apps/api/src/routes/{virtual-accounts,balances,beneficiaries,transfers,quotes,sandbox/money}/**`)
validate, check the customer exists in the key's organisation and mode (404 otherwise), and forward to
the money door with the edge's assertion.

### 25.2 Resources

```
VirtualAccount {
  object: "virtual_account", id, customer_id,
  status: "opening" | "open" | "closed" | "failed",
  currency: "USD", account_last4: string | null, inbound_rails: ("ach" | "wire")[],
  deposit_instructions: null | { bank_name: string | null, bank_address: string | null,
    routing_number: string, account_number: string, account_name: string | null, swift_code: string | null },
  opened_at: string | null, closed_at: string | null, created_at: string }

Balance { object: "balance", customer_id, currency: "USD", balance: int, held: int, spendable: int }

Beneficiary {
  object: "beneficiary", id, customer_id, rail: "ach" | "fedwire",
  kinds: ("ach_same_day" | "ach_standard" | "fedwire")[],
  account_type: "checking" | "savings" | null, bank_name: string | null,
  routing_number: string, account_last4: string, status: "active" | "removed",
  first_payout_after: string | null, created_at: string, removed_at: string | null }

Transfer {
  object: "transfer", id, customer_id, direction: "in" | "out",
  kind: "ach_same_day" | "ach_standard" | "fedwire" | "deposit" | "sandbox_deposit" | "funding",
  rail: "ach" | "wire" | "rtp" | null, beneficiary_id: string | null, virtual_account_id: string | null,
  amount: int, fee: int | null, total: int | null, currency: "USD",
  status: "pending" | "processing" | "completed" | "failed" | "cancelled" | "returned",
  reason: string | null, return_code: string | null, external_id: string | null,
  created_at: string, committed_at: string | null, completed_at: string | null, simulated: boolean }

TransferQuote { object: "transfer_quote", customer_id, beneficiary_id, kind, amount, fee, total, currency }
```

`deposit_instructions` is present only on `GET /v4/customers/{id}/virtual_account`. `kind: "funding"`
appears only in staging's live mode. Enums may gain values; the docs tell developers to accept
unknown values (MS-27). `Balance.balance` comes from Fin's ledger, never from a provider read.

### 25.3 Routes

| Operation ID | Route | Scope | Request | Answer | Errors |
|---|---|---|---|---|---|
| `getVirtualAccount` | `GET /v4/customers/{id}/virtual_account` | `money:read` | | 200 `VirtualAccount` with instructions (audited reveal) | 404; 409 `account_not_ready` (`reason`), `not_supported`, `not_approved` |
| `listVirtualAccounts` | `GET /v4/customers/{id}/virtual_accounts` | `money:read` | `limit`, `cursor` | 200 list, no instructions | 400, 404 |
| `openVirtualAccount` | `POST /v4/customers/{id}/virtual_account` | `money:write` | empty; `Idempotency-Key` accepted | 201 new (`opening` or `open`), 200 the existing one | 404; 409 `not_approved`, `not_supported`, `money_locked`, `account_not_ready`; 502; 503 |
| `getBalance` | `GET /v4/customers/{id}/balance` | `money:read` | | 200 `Balance` | 404; 409 `not_supported` |
| `addBeneficiary` | `POST /v4/customers/{id}/beneficiaries` | `beneficiaries:write` | §12.1 fields; `Idempotency-Key` accepted | 201 `Beneficiary` (200 on replay) | 400 `invalid_beneficiary`, `invalid_field`; 404; 409 `beneficiary_exists`, `rail_unsupported`, `not_approved`, `not_supported`, `money_locked`, `account_not_ready`; 413; 415; 422 `idempotency_key_reused`; 429 `beneficiary_limit`; 502; 503 |
| `listBeneficiaries` | `GET /v4/customers/{id}/beneficiaries` | `money:read` | `include_removed`, `limit`, `cursor` | 200 list | 400, 404 |
| `getBeneficiary` | `GET /v4/customers/{id}/beneficiaries/{beneficiary_id}` | `money:read` | | 200 | 404 |
| `removeBeneficiary` | `DELETE /v4/customers/{id}/beneficiaries/{beneficiary_id}` | `beneficiaries:write` | | 200 `Beneficiary` with `status: "removed"` | 404 |
| `quoteTransfer` | `POST /v4/transfers/quote` | `money:read` | `customer_id`, `beneficiary_id`, `kind`, `amount`, `currency` | 200 `TransferQuote` | 400 `invalid_transfer`; 404; 409 as `createTransfer` except limits; 429 `rate_limited`; 502 |
| `createTransfer` | `POST /v4/transfers` | `money:write` | `Idempotency-Key` required; `customer_id`, `beneficiary_id`, `kind`, `amount`, `currency`, `external_id?` | 201 `Transfer` (200 with `Idempotent-Replayed: true` on replay) | 400 `idempotency_key_missing`, `invalid_transfer`; 403 `sandbox_only`, `forbidden`; 404; 409 `insufficient_funds`, `beneficiary_removed`, `beneficiary_not_ready`, `rail_unavailable`, `not_approved`, `not_supported`, `money_locked`, `account_not_ready`; 413; 415; 422 `idempotency_key_reused`; 429 `transfer_limit`; 502; 503 `temporarily_unavailable` |
| `listTransfers` | `GET /v4/transfers` | `money:read` | `customer_id`, `status`, `direction`, `created_gte`, `created_lt`, `limit`, `cursor`, `ending_before` (the Transfers screens page both ways, [AP-17]) | 200 list | 400 |
| `getTransfer` | `GET /v4/transfers/{id}` | `money:read` | | 200 | 404 |
| `cancelTransfer` | `POST /v4/transfers/{id}/cancel` | `money:write` | `Idempotency-Key` accepted | 200 `Transfer` | 404; 409 `not_cancellable`; 502; 503 |

### 25.4 Sandbox money routes (Sandbox keys only)

| Operation ID | Route | Scope | Request | Answer |
|---|---|---|---|---|
| `simulateDeposit` | `POST /v4/sandbox/customers/{id}/deposit` | `sandbox:deposit` | `Idempotency-Key` required; `amount`, `currency`, `external_id?` | 201 `Transfer` (`kind: "sandbox_deposit"`, `completed`) |
| `simulateBankDeposit` | `POST /v4/sandbox/customers/{id}/bank_deposit` | `sandbox:deposit` | `Idempotency-Key` required; `rail` (`ach`, `wire`), `amount`, `currency`, `external_id?` | 201 `Transfer` (`kind: "deposit"`) |
| `simulateTransferCompleted` | `POST /v4/sandbox/transfers/{id}/complete` | `sandbox:simulate` and `money:read` | | 200 `Transfer` |
| `simulateTransferFailed` | `POST /v4/sandbox/transfers/{id}/fail` | both | | 200 |
| `simulateTransferReturned` | `POST /v4/sandbox/transfers/{id}/return` | both | `reason` (`account_closed`, `no_account`, `invalid_account_number`, `refused_by_receiver`) | 200 |

Errors: 400 `invalid_transfer`, `idempotency_key_missing`; 403 `sandbox_only` with a live key; 404;
409 `not_simulatable` (`current_status`), `account_not_ready`; 422 `idempotency_key_reused`; 429
`deposit_limit`. `POST /v4/sandbox/reset` ([AP-16]) is Sunday's; its money part is the
`sandbox_reset` job (§10.1, MS-25).

### 25.5 Developer events

§29.1.

### 25.6 Errors (public codes this spec adds or keeps)

| Code | HTTP | Extensions | When |
|---|---|---|---|
| `sandbox_only` | 403 | | live mode where live money is off; a Sandbox route with a live key |
| `forbidden` | 403 | `reason: "ip_allowlist_required"` | a live money key without an allowlist |
| `not_supported` | 409 | | a business customer |
| `not_found` | 404 | | another organisation's or mode's resource; a malformed ID |
| `not_approved` | 409 | `current_status` | |
| `account_not_ready` | 409 | `reason` (`opening`, `needs_details`, `refused`, `under_review`, `closed`, `no_account`), `missing` | |
| `money_locked` | 409 | | the provider locked the holder |
| `invalid_beneficiary` | 400 | `field`, `errors` | |
| `beneficiary_exists` | 409 | | |
| `beneficiary_limit` | 429 | | |
| `beneficiary_removed` | 409 | | |
| `beneficiary_not_ready` | 409 | | inside the first-payout delay (new, MS-21) |
| `rail_unsupported` | 409 | | the beneficiary's rail group is not offered (new) |
| `rail_unavailable` | 409 | | the kind is not offered by the holder's instance (new) |
| `invalid_transfer` | 400 | `field`, `errors` | |
| `insufficient_funds` | 409 | | |
| `idempotency_key_missing` | 400 | | |
| `idempotency_key_reused` | 422 | | |
| `transfer_limit` | 429 | | |
| `deposit_limit` | 429 | | |
| `not_cancellable` | 409 | `current_status` | |
| `not_simulatable` | 409 | `current_status` | |
| `rate_limited` | 429 | `violated_policies` | |
| `upstream_unavailable` | 502 | | a provider fault reached the caller |
| `temporarily_unavailable` | 503 | | a kill switch; `Retry-After` |

The old `money_not_enabled` and `deposit_unavailable` codes are not carried (MS-24). Each code has its
error page (ARCH §13.2) in `packages/contract/src/errors/money.ts`, and the error-page test fails for a
code with no page or a page with no thrower.

### 25.7 What `api` and the web apps pass on

The door's problem documents pass through unchanged, after `api` checks the code is public. An
internal code (for example a fault) never reaches a developer: `api` maps it to 500 `internal` and
reports it.

### 25.8 Docs and Try it (L-MON-08)

- The reference renders `money.json` with Scalar (ARCH §13.10). Each money operation has request and
  response examples using the test values of §22.5 and `fin_test_...` keys; no example holds a
  key-shaped string with a valid checksum.
- Try it (ARCH §13.11) works for every money route with a Sandbox key; the request hook fills an
  `Idempotency-Key` (a fresh UUID) when the developer leaves it empty on `createTransfer`,
  `simulateDeposit` and `simulateBankDeposit`, once SP-14 confirms the installed Scalar hook.
- The getting-started guide ends with "Move money in Sandbox": open a virtual account, simulate a
  deposit, add a beneficiary with the test values, quote, send, and simulate the outcome.
- The money-movement guide (statuses, reasons, fees, cancellation, returns, idempotency, the Sandbox
  simulations, "individuals only") is stretch (H-08). Its tables are generated from the code's
  constants (ARCH §13.10).
- The provider-name build check ([AP-14]) runs over the built docs (T-MON-40).

---

## 26. Console: money routes and screens (R14)

### 26.1 Hosting, per the owner's decisions of 21 Nov

- The console's static build is served at `console.<zone>` by an assets-only static deployment with
  no script; `console.<zone>/api/*` has a route with no Worker, falls through to the proxied CNAME of
  the public tunnel, and the tunnel's ingress sends `console.<zone>` plus `^/api/` to the `console`
  service on Railway. The money routes below are therefore same-origin: no CORS.
- Every non-GET money route passes the origin gate: `Origin` equals `https://console.<zone>` exactly,
  `Sec-Fetch-Site` (when present) is `same-origin`, `X-Fin-App: console` is present, and the body is
  `application/json`. GETs stay simple. Every answer is `Cache-Control: no-store`.
- SP-25, the routing spike (EX §2.6's S-01), passed on 21 Nov (recorded in `docs/plan/spikes.md`), so
  the shape above holds and these routes stay same-origin. The fallback (`console-api.<zone>`,
  cross-origin and same-site) is not needed. It stays documented (ARCH §5.17): under it, these routes
  would move host unchanged, and only the client's API base URL and the CORS settings would change,
  as the routing research of 21 Nov sets out.
- Screens are single-page routes on TanStack Router, built only from `@fin/ui` (Fin's components on
  `@ui-sdk/react` 0.1.0-beta.13, pinned exactly); no screen imports the UI SDK, Phosphor or a colour directly.
  Drawers open with `?view=` and never refetch the list behind them (FW-C11).

### 26.2 App API routes (`apps/console/src/server/routes/money/**`, policy `apps/console/src/server/policy/money.ts`)

Contracts in `packages/app-contracts/src/money/**` (Zod, browser-safe), one contract test per route.
Every route sits under the one prefix `console.<zone>/api/money/` (EXECUTION §5.1 item 12); the
customer-scoped ones sit under `/api/money/customers/:customerId/`. Each carries `Fin-Organization`
(spec 02 IF-02). Guard `requireActor` everywhere; "intent" and "window" are ARCH §7.4's kinds.

| Method and path | Permission | Step-up | Door operation | Audit |
|---|---|---|---|---|
| `GET /api/money/customers/:customerId` | `money.read` | | `money_tab.get` | log line |
| `GET /api/money/customers/:customerId/balance` | `money.read` | | `balance.get` | log line |
| `POST /api/money/customers/:customerId/virtual-account` | `money.transfer` | window | `va.open` | `virtual_account.requested` |
| `POST /api/money/customers/:customerId/virtual-account/reveal` | `money.read` | window | `va.reveal` | `virtual_account.instructions_revealed` |
| `GET /api/money/customers/:customerId/beneficiaries` | `money.read` | | `beneficiary.list` | log line |
| `POST /api/money/customers/:customerId/beneficiaries` | `money.beneficiaries` | intent | `beneficiary.create` | `beneficiary.added` |
| `DELETE /api/money/customers/:customerId/beneficiaries/:beneficiaryId` | `money.beneficiaries` | intent | `beneficiary.remove` | `beneficiary.removed` |
| `GET /api/money/customers/:customerId/transfers?cursor=&limit=` | `money.read` | | `transfer.list` | log line |
| `POST /api/money/transfer-intents` | `money.transfer`, or `money.simulate` for `kind: "deposit"` | | `transfer_intent.create` | log line |
| `POST /api/money/transfers/quote` | `money.transfer` | | `transfer.quote` | log line |
| `POST /api/money/transfers` | `money.transfer` | intent | `transfer.create` | `transfer.created` |
| `GET /api/money/transfers/:transferId` | `money.read` | | `transfer.get` | log line |
| `POST /api/money/transfers/:transferId/cancel` | `money.transfer` | intent | `transfer.cancel` | `transfer.cancel_requested` |
| `POST /api/money/transfers/:transferId/simulate` | `simulator.use` | window | `sandbox.transfer_simulate` | `transfer.simulated` |
| `POST /api/money/customers/:customerId/deposits` | `simulator.use` and `money.simulate` | window | `sandbox.deposit` or `sandbox.bank_deposit` | `transfer.created` |
| `GET /api/money/virtual-accounts?cursor=&limit=` | `customers.read` and `money.read` | | `va.list` | log line |
| `GET /api/money/transfers?status=&cursor=&limit=` | `customers.read` and `money.read` | | `transfer.list` | log line |

Writes that reach a provider count against 120 per minute per organisation (§17). The two list routes
return `total` exactly while it is at most 10,000, else `total_estimate: true` (ARCH §13.4); the pager
pages with `cursor` and `ending_before`.

### 26.3 The Money tab's summary (`MoneyTab`)

```ts
export interface MoneyTab {
  state: "open" | "no_account" | "opening" | "needs_details" | "refused" | "under_review"
       | "closed" | "not_approved" | "business" | "money_off";
  virtualAccount: null | { id: string; status: "opening" | "open" | "closed" | "failed";
    bankName: string | null; bankAddress: string | null; routingNumber: string | null;
    accountLast4: string | null; nameOnAccount: string | null; currency: "USD"; openedAt: string | null };
  rails: { group: "ach" | "fedwire"; kinds: { kind: PayoutRail; label: string; extraFields: CounterpartyField[] }[] }[];
  inboundRails: ("ach" | "wire")[];
  limits: { maxTransferMinor: number; maxDepositMinor: number };
  sandbox: boolean;
  can: { openAccount: boolean; addBeneficiary: boolean; send: boolean; simulate: boolean; simulateOutcome: boolean };
}
```

`state` comes from the holder and account (§10.2, §11.1), with `money_off` when the mode's instance
is disabled or a kill switch stops it, and `business` or `not_approved` from the mirrored customer
type and status. `rails` and `kinds` come from the routed instance's capabilities and method table,
with Fin's labels ("Same Day ACH", "Standard ACH", "Fedwire"); the screens never list rails of their
own. `can` mirrors the member's permissions; the server refuses regardless.

### 26.4 CustomerMoney (`/customers/$id?tab=money`, the one Money tab)

BRIEF §11.2: tabs Overview · Details · People (businesses) · Documents · Money · Activity; the Money tab
holds the virtual account panel (balance, Send money as the primary, Simulate a deposit as the
secondary in Sandbox, deposit instructions), a Beneficiaries section with Add beneficiary, and a
Transfers section whose rows open TransferDetails. Files:
`apps/console/src/client/routes/customers/$id/-money/**` (a `-` folder, so the router makes no
`/customers/$id/money` route; spec 06 S6-02). Data: `MoneyTab`, then balance,
beneficiaries and transfers in parallel.

| Board state | Reached when | Monday |
|---|---|---|
| `open` | `state: "open"` with data | must |
| `sent` | after a send: the toast "Transfer created" with View, the new row on top | must (with SendMoney) |
| `empty` | open, balance 0, no beneficiaries, no transfers | must |
| `balanceReading` | the balance request pending | must |
| `balanceFailed` | the balance request failed: "Couldn't read the balance. {reason}" with Try again | must |
| `instructionsFailed` | the reveal failed | must |
| `noLongerOpen` | the reveal answers 409 `account_not_ready` with `reason: "closed"` | H-02 |
| `refreshFailed` | a reload after a change failed: at the top of the tab | H-02 |
| `listsFailed` | the beneficiaries or transfers request failed | H-02 |
| `removeConfirm`, `removing`, `removeFailed`, `removed` | removing a beneficiary (ConfirmDialog, intent) | `removeConfirm` and `removed` must; the rest H-02 |
| `noAccount` | `no_account`; primary "Open virtual account" (window) | must |
| `opening` | `opening` | must |
| `needsDetails` | `needs_details` | must |
| `refused` | `refused` | must |
| `underReview` | `under_review` | must |
| `closed` | `closed` | must |
| `readOnly` | the member lacks `money.transfer` and `money.beneficiaries` | must |
| `notApproved` | `not_approved` | must |
| `business` | `business`: one calm card, "Virtual accounts for businesses are coming." | must |
| `moneyOff` | `money_off` | must |
| `loading` | `MoneyTab` pending: content-shaped skeletons with shimmer | must |
| `failed` | `MoneyTab` failed: "Couldn't load money" with Try again | must |

### 26.5 SendMoney (`?view=send-money`, size L drawer wizard)

Opening the drawer calls `POST /api/money/transfer-intents` `{customer_id}` and keeps the `tni_` ID
for every retry of this drawer ([MO-07]); closing the drawer discards it. Steps: Beneficiary (a
Combobox of active beneficiaries), How it's sent (when the beneficiary has several kinds), Amount
(with the balance), Review (quote: fee and total), then the step-up intent, then the result. The
review's quote call also answers `similar_recent: { transfer_id, amount, created_at } | null` for a
transfer to the same beneficiary with the same amount in the last 24 hours, and the review then shows
an InlineAlert: "You sent {amount} to {name} {when}. Send it again only if you mean to." (a pending
composition with a UI request, MS-08).

| Board state | Reached when | Monday |
|---|---|---|
| `beneficiary`, `beneficiaryOpen`, `beneficiaryError` | step 1, open list, none chosen | must |
| `loading` | beneficiaries loading | must |
| `speedError`, `fedwire`, `sameDayOnly` | the kinds step and its variants | must |
| `amount`, `amountReading`, `amountUnread`, `amountOver`, `amountLimit` | the amount step; over spendable less the fee ceiling; over 10,000.00 USD | must |
| `review`, `feeLoading` | the quote request | must |
| `feeUnavailable` | the quote failed (or CUT-06 removed the route) | must |
| `stepUp` | 403 `step_up_required` from `POST /api/money/transfers` | must |
| `submitting` | the send request pending | must |
| `success` | 201, the transfer not failed | must |
| `failed` | 201 with a transfer already `failed` | must |
| `balanceRefused` | 409 `insufficient_funds` | must |
| `notApproved` | 409 `not_approved` | must |
| `lostAnswer` | a network failure or timeout: retry re-sends with the same `tni_` (and the same body), so it can never pay twice | must |
| `reused` | 422 `idempotency_key_reused` (the body changed after a lost answer) | must |
| `rateLimited` | 429 | must |
| `partnerDown` | 502 `upstream_unavailable` | must |
| similar recent transfer | `similar_recent` set (pending composition) | must |
| money off | 503 `temporarily_unavailable` (pending composition) | must |

### 26.6 AddBeneficiary (`?view=add-beneficiary`, size L drawer wizard)

Steps: How they get paid (rails from `MoneyTab.rails`), Account, Review, step-up, result. The
Sandbox "Test details" box fills from §22.5's catalogue.

| Board state | Monday |
|---|---|
| `rail`, `railError`, `accountEmpty`, `account`, `accountErrors`, `fedwire`, `idTypeOpen`, `fedwireErrors` | must |
| `failing` (filled with the failing account) | must |
| `review`, `reviewFedwire`, `stepUp`, `submitting`, `success`, `failed` | must |
| first-payout delay notice (live mode only, when the delay is above zero; pending composition) | must |

Server sentences for `failed`: `beneficiary_exists` "This account is already a beneficiary of this
customer."; `beneficiary_limit` "This customer has added 10 beneficiaries today. Try again tomorrow.";
`rail_unsupported` "Fin can't pay this kind of account for this customer yet."; others the server's
sentence.

### 26.7 SimulateDeposit (`?view=simulate-deposit`, Sandbox only, size L drawer wizard)

One wizard for both Sandbox actions: a bank deposit by ACH or wire (needs an open account) and the
plain Sandbox deposit. A drawer-scoped `tni_` with `kind: "deposit"` is the idempotency key
(MS-16). States `kind`, `kindError`, `amount`, `amountErrors`, `review`, `stepUp`, `submitting`,
`success`, `plainReview`, `plainSuccess`, `failed`, `lostAnswer`, `reused`: all must, except
`kindError` and `amountErrors`, which are H-02. Success copy: "{amount} deposited. {status}." and
"ACH deposit: {amount} deposited. Processing."

### 26.8 TransferDetails (`?view=<trf_id>` on the Money tab and on `/transfers`, size M drawer)

Header (direction and status), MoneyRoute (the customer's balance to the beneficiary, or the deposit
into the account), Progress (a Timeline of the statuses with times in UTC), Amount and parties,
Details (ID, created, completed, return code, "Moved in Sandbox: Fin's record only." when
`outcome_simulated_at` is set), "How it ends" (Sandbox, `simulator.use`): Complete now, Fail, Return
with a return reason, only as §22.3 allows; Cancel transfer in the footer (out, `pending` or
`processing`, `money.transfer`, ConfirmDialog then intent; result "Cancelled." or "Cancellation asked of
the bank.").

| Board state | Monday |
|---|---|
| `processing`, `pending`, `completed`, `failed`, `returned`, `cancelled`, `onramp` | must |
| `returnOpen`, `stepUp`, `returning`, `returnDone` | must |
| `cancelConfirm`, `cancelling`, `cancelAsked` | must |
| `notFound` (404) | must |
| `actionFailed`, `loading`, `loadFailed`, `readOnly` | H-02 |

### 26.9 VirtualAccounts (`/virtual-accounts`) and Transfers (`/transfers`)

Files `apps/console/src/client/routes/{virtual-accounts,transfers}/**`; sidebar items under "Money
movement" for `customers.read` and `money.read` (nav fragment
`packages/frame/src/nav/console/money.ts`, EXECUTION §1.3). VirtualAccounts: columns Customer, Bank,
Last four, Status, Opened; rows open the customer's Money tab;
states `list`, `empty`, `failed` must; `refreshing`, `loading`, `pageFailed`, `noPermission` H-02.
Transfers: status pills All, Pending, Processing, Completed, Failed, Cancelled, Returned; columns
Customer, Direction, Kind, Amount, Fee, Status, Date; rows open TransferDetails; states `list`,
`filtered`, `filteredEmpty`, `empty`, `failed` must; `refreshing`, `loading`, `pageFailed`,
`readOnly`, `noPermission` H-02. A deleted customer's row reads "Deleted customer" and opens no page.

### 26.10 Copy that changes from the inventory and the canvas

Each change is mirrored on the "Fin Dashboard · new design" canvas by L-MON-10 the same day:

| Where | Today | Becomes | Why |
|---|---|---|---|
| Add beneficiary, Test details | "MassPay's Sandbox test account. The failing one is refused when the money is sent." | "Sandbox test account. The failing one is refused when the money is sent." | No provider is named to developers ([AP-14], ARCH §12.1) |
| Add beneficiary, ID number hint | "Sent to the bank only. Fin doesn't keep it." | "Kept encrypted in Fin and sent to the bank." | [MO-04]'s default keeps it sealed |
| Money tab, deposit instructions | the full account number with a copy button | `•••• 4821` with "Show account number" (asks "Confirm it's you" when no factor in 5 minutes), then the full number and its copy button | A full number is a reveal (ARCH §7.4, AC-MON-08; MS-07) |
| Send money, review | none | the similar-transfer InlineAlert (§26.5) | [MO-07] |
| Add beneficiary | none | live mode only: "Fin sends the first payment to a new beneficiary after {n} hours." | [MO-19] mechanism (MS-21) |
| Money tab and wizards, kill switch | "Money movement isn't switched on here yet." for every off case | that line when live money is not on in this environment; "Money movement is paused for now. Try again later." when a switch stops it | §31 |
| The inventory's "Check Transactions" | | "Check Transfers" (the canvas already did this) | the page's name |

### 26.11 Browser tests (`apps/console/e2e/mon/**`, L-MON-06)

Against the `test` image with the simulator and the test-only controls (§22.6):

| Spec | Proves |
|---|---|
| `open-account.spec.ts` | an approved individual's Money tab reaches `open`; "Open virtual account" after a close asks for the factor once |
| `reveal-instructions.spec.ts` | the number is masked until shown; showing needs a window; the audit log shows the reveal |
| `add-beneficiary.spec.ts` | ACH and Fedwire with the fills; the intent dialog; refused without it (`page.route` cannot skip it: the server refuses); the security email reaches the sink |
| `simulate-deposit.spec.ts` | plain, wire and ACH deposits; ACH completes on "Complete now" |
| `send-money.spec.ts` | beneficiary, kind, amount, review with fee, intent, success, the new row; then simulate complete in TransferDetails |
| `send-money-lost-answer.spec.ts` | the first send's answer is aborted with `page.route`; Try again re-sends the same `tni_`; exactly one transfer exists |
| `send-money-states.spec.ts` | `balanceRefused`, `rateLimited`, `partnerDown`, `feeUnavailable`, similar-transfer warning, `reused` |
| `cancel-transfer.spec.ts` | cancel a pending transfer (held by `holdNextCommit`), and a processing one ("Cancellation asked of the bank.") |
| `money-tab-states.spec.ts` | `business`, `notApproved`, `moneyOff` (a kill switch), `readOnly`, `underReview` (`lockHolder`) |
| `lists.spec.ts` | `/virtual-accounts` and `/transfers` with a status filter and paging; a drawer opens without refetching the list |

Each spec fails if a `securitypolicyviolation` fires and if any request leaves the console's own
origin (FW-C17).

---

## 27. Fin Admin money view ([MO-13])

### 27.1 Hosting

`admin.<zone>` (Fin Admin's own zone, [FD-10]) is an assets-only static deployment behind Access;
`admin.<zone>/api/*` falls through to the admin tunnel; `admin` checks the Access token on every
request (ARCH §5.10). No board exists: screens are built from design-system patterns (Table, Drawer,
DetailList, StatusBadge, EmptyState, ErrorState), marked pending design parity with a UI request
(EX §5.5, [UI-03]).

### 27.2 Read-only view (must-have, L-MON-07)

Sidebar item "Money" (Bank glyph) for staff `money.read`, route `/money` with tabs:

| Tab | Route | Shows | Door operation |
|---|---|---|---|
| Transfers | `/money/transfers` | organisation, customer ID, direction, kind, amount, fee, status, reason, instance, provider reference and raw status, next check, created; filters by status, instance and organisation; a row opens a drawer with the provider operations (from `money.provider_operation`) and events (from `money.provider_event`) for it | `admin.transfers.list`, `admin.transfer.get` |
| Holders | `/money/holders` | customer ID, organisation, mode, state and reason, instance, provider holder status, attempts, next attempt, last error code | `admin.holders.list`, `admin.holder.get` |
| Breaks | `/money/breaks` | open and resolved reconciliation breaks with kind, instance, amounts, whether it tripped | `admin.breaks.list`, `admin.break.get` |
| Providers | `/money/providers` | each instance: enabled, serves mode, capabilities, last probe outcome, calls and failures in the last hour, inbox backlog, switch state | `admin.instances.status` |

No personal data is shown: customers by ID only, no holder names, no bank numbers. List reads are log
lines (AU-01). Files `apps/admin/src/client/routes/money/**`, `apps/admin/src/server/routes/money/**`,
`apps/admin/src/server/policy/money.ts`, the nav fragment `packages/frame/src/nav/admin/money.ts`,
contracts `packages/app-contracts/src/admin/money/**`. Browser test `apps/admin/e2e/mon/view.spec.ts`
(with the Access stand-in): each tab lists, a viewer without `money.read` sees no item and gets 403.

### 27.3 Operations (stretch, `money.operate`, each with a step-up intent)

| Action | Door operation | Effect | Audit |
|---|---|---|---|
| Retry a holder | `admin.holder.retry` | a `failed` or `skipped` holder back to `owed` | `money.holder.retry_requested` |
| Close a virtual account | `admin.va.close` | §11.3 with `close_reason: "staff"` | `virtual_account.closed` |
| Resolve a break | `admin.break.resolve` with a `resolution_code` and, for `fin_corrected`, a balanced correcting entry | the break `resolved`; a `correction` posting where given | `money.reconciliation_break_resolved` |

No staff action starts a payout ([MO-13]). Clearing a tripped switch is `switches.manage` on
Saturday's switches screen (ARCH §15.1).

---

## 28. Audit events (R9)

`packages/audit/src/events/money.ts` (L-MON-01). Category `money` for all. `recordAudit()` takes the
actor (ARCH §8.2: `user`, `api_key`, `staff`, `system`, `provider`, `operator`) with `via` (`console`,
`api`, `admin`, `job`, `webhook`, `reconciliation`, `operator`), the intent ID and factor method for a
stepped-up action, the `target` and `refs` (spec 08 §3.3), and flat metadata. The Targets column
below lists the IDs that `target` and `refs` carry between them. They always name the row the event
names, so the database guards of §7.7 can find it (spec 08 §3.5 and D08-35 match `target_id` or any
of `ref_ids`). Metadata never holds a bank number, a last four, a
holder name, a provider token or body, or the idempotency key (its hash only). The organisation's log
never shows a provider's name: organisation-scope events carry `partner: "bank"` or `"sandbox"`;
staff-scope events carry the instance.

| Event | Scope | Written by | Actor and `via` | Targets | Metadata |
|---|---|---|---|---|---|
| `money.holder.created` | organisation | payments | system, job | customer | `state`, `customer_type` |
| `money.holder.state_changed` | organisation | payments | system, job (or provider, webhook) | customer | `from`, `to`, `reason`, `missing_fields` (names) |
| `money.holder.retry_requested` | staff | payments | staff, admin | customer | `from` |
| `money.routing_decided` | staff | payments | system, job | customer | `instance`, `rule` |
| `money.holder_details_shared` | organisation | api | system, job | customer | `fields` (names), `partner` |
| `virtual_account.requested` | organisation | payments | user or api_key | customer, virtual account | `via` |
| `virtual_account.opened` | organisation | payments | system (job or request) | virtual account | `inbound_rails` |
| `virtual_account.open_failed` | organisation | payments | system | virtual account | `code` |
| `virtual_account.closed` | organisation | payments | system or staff | virtual account | `reason` |
| `virtual_account.instructions_revealed` | organisation | payments | user (window) or api_key | virtual account | `purpose: "instructions"` |
| `beneficiary.added` | organisation | payments | user (intent) or api_key | customer, beneficiary | `rail`, `kinds`, `first_payout_after` |
| `beneficiary.removed` | organisation | payments | user (intent) or api_key | beneficiary | |
| `beneficiary.sealed_opened` | staff | payments | system | beneficiary | `purpose`, `instance`, `rail` |
| `beneficiary.registered` | staff | payments | system | beneficiary, counterparty | `instance`, `rail`, `outcome`, `code` |
| `transfer.created` | organisation | payments | user (intent), api_key, provider, operator or system | transfer, ledger entries if any | `customer_id`, `beneficiary_id`, `direction`, `kind`, `rail`, `amount`, `currency`, `status`, `idempotency_key_sha256` (hex) |
| `transfer.status_changed` | organisation | payments | system (job, reconciliation), provider (webhook), or user and api_key when their request drove it | transfer, ledger entries, hold | `from`, `to`, `reason`, `return_code`, `fee`, `source` (`request`, `job`, `webhook`, `reconciliation`, `simulation`), `exception` (`sent_after_end` or absent) |
| `transfer.cancel_requested` | organisation | payments | user (intent) or api_key | transfer | `status_at_request` |
| `transfer.simulated` | organisation | payments | user (window) or api_key | transfer, ledger entries | `action`, `from`, `to`, `return_reason` |
| `treasury.funding_created` | staff | payments | operator | transfer, funding | `instance`, `amount` |
| `money.reconciliation_break` | staff | payments | system, reconciliation | break | `kind`, `instance`, `expected`, `actual`, `tripped` |
| `money.reconciliation_break_resolved` | staff | payments | staff (intent), admin | break, correction entry | `resolution_code` |

Ledger entries are always written in a transaction that also writes one of the transfer events above,
naming each entry, which is what the guard checks. Holds and provider operations have no audit row of
their own: holds are named in their transfer's event, and provider calls are `provider.call` lines
and `money.provider_operation` rows (ARCH §8.1).

**`audit.record()` allowlist** (ARCH §8.2): `fin_payments` may record every event above except
`money.holder_details_shared`, which only `fin_api` may record. `fin_console` and `fin_admin` record
none of them: their actions are recorded by `payments`, which owns the transaction (MS-15). A role
test proves each refusal (T-MON-36).

**Tests:** one per event that fails when the event is not written (T-MON-37), a scope test that no
staff event reaches the organisation's page, and the join check of EX §5.4: each transfer status has
its audit event, developer event and ledger posting (T-MON-38).

---

## 29. Developer events and emails

### 29.1 Developer events (`packages/events/src/types/money.ts`, L-MON-01)

Emitted by `payments` through `events.emit()` in the same transaction as the change, which accepts
only these types from `fin_payments` ([DA-14]). Payloads are thin (ARCH §13.7):

| Event | When | `data` |
|---|---|---|
| `virtual_account.created` | an account becomes `open` | `{object, id, customer_id, status}` |
| `virtual_account.closed` | an account becomes `closed` | the same |
| `beneficiary.created` | added | `{object, id, customer_id, rail, status}` |
| `beneficiary.deleted` | removed | the same |
| `transfer.created` | any transfer row inserted | `{object, id, customer_id, direction, kind, status, reason}` |
| `transfer.updated` | `pending` to `processing`, or a fee becomes known | the same |
| `transfer.completed` | `completed` | the same |
| `transfer.failed` | `failed` or `cancelled` | the same |
| `transfer.returned` | `returned` | the same |

### 29.2 Emails (`packages/email/src/templates/money/**`, L-MON-01)

| Template | To | When | Parameters |
|---|---|---|---|
| `money/beneficiary-added` | the organisation's Super admins and Admins (security email, ARCH §8.7) | a beneficiary is added, in Sandbox and live | `organization_id`, `customer_id`, `beneficiary_id`, `actor_id`, and from a closed allowlist `rail` and `account_last4` (MS-13). The worker resolves names; the holder name is never sent |

Copy (Fin's words; typed values only in labelled boxes): subject "A beneficiary was added"; body
"Someone added a beneficiary for one of your customers. If this wasn't expected, remove it and check
your team's access." with boxes "Customer", "Added by", "Paid by" (ACH or Fedwire), "Account ending",
and a button "Open the customer". It uses the security sending subdomain, never drops (ARCH §7.5), and is
ranked to bypass per-kind limits. `email.enqueue()` allows `money/*` templates for `fin_payments`
only.

---

## 30. Monitoring and alerts (R5)

### 30.1 Lines

| Line | Written by | Fields beyond ARCH §10.2's common set |
|---|---|---|
| `request` | `payments` for every door and hook call | `route` (the operation), `actor` (`api_key`, `session`, `staff`, `provider_webhook`, `service`), `orgId`, `mode`, `outcome`, `reason`, `providerMs`, `providerCalls` |
| `provider.call` | the adapter's sink, one per provider call | `provider`, `instance`, `operation`, `status`, `durationMs`, `outcome`, `failure`, `retry`, `effect`, `subjectId` |
| `job.run`, `job.step` | each money duty | `job`, `processed`, `failed`, `stuck`, `oldestDueS`, `provider` |
| `money.webhook_refused` | the hook door | `instance`, `reason` |
| `money.reconciliation_break` | reconciliation | `instance`, `kind`, `tripped` |
| `money.idempotency_mismatch`, `money.transfer_sent_after_end`, `money.orphan_payout` | domain and reconciliation | `instance`, `transferId` |
| `money.durability_unconfirmed` | the transfer path | `transferId` |
| `money.ledger_unsequenced` | the ledger sequencer | `oldestS`, `count` |
| `money.holder_locked`, `money.provisioning_failed`, `money.accounts_not_closing` | the jobs | `instance`, counts or IDs |
| `money.funding_low` | `reconcile-daily` in staging | `instance` |
| `money.simulation_refused` | the guard of §6.4 | `instance`, `operation` |
| `money.balance_guard` | the submit path | `instance`, `transferId` |
| `switch.refused` | §31 | `switch` |

Amounts may appear in a line; a bank number, last four, name, token, key, signature or provider body
never does. Each event name is in `ops/monitoring/catalog/money-*.ts`
(§34.2) with its kind and its alerts or a written reason for none; `monitoring:check` fails otherwise.

### 30.2 Metrics

From the lines (ARCH §10.4), labelled by `provider` and `operation`, never by an ID: provider calls by
`outcome` and `failure`; provider `durationMs` p95 and p99; transfers created and ended by `status`
and `reason`; `stuck`; breaks by `kind`; inbox backlog (`oldestDueS` of `provider-events`); holders by
state; ledger sequencer lag.

### 30.3 Alerts (group F, `ops/monitoring/<env>/alerts/money-*.json`)

Thresholds are in the private overlay ([OB-13]); every alert names its runbook in
`docs/runbooks/money-<name>.md` (L-MON-09). P pages in production; N notifies; staging is email only.

| Alert | Sev | Means | First check | Fires on |
|---|---|---|---|---|
| `provider-failing` | P | an instance's calls fail above the threshold | the provider's status page, then `provider.call` failures by `failure` | `provider.call` with `outcome` `retry` or `unknown` |
| `provider-auth-failing` | P | the provider refuses Fin's key or address | key expiry and MassPay's IP allowlist against `payments`' static IPs | `failure` `unauthorized` or `forbidden` |
| `provider-rate-limited` | N | the provider is throttling Fin | the sweep's call budget | `failure` `rate_limited` |
| `provider-latency` | N | p95 above the threshold | MassPay's status; slow operations by name | `provider.call` duration |
| `provider-webhook-refused` | P | signed hooks fail to verify | the secret set during a rotation; a forged sender | `money.webhook_refused` |
| `provider-sync-stalled` | P | the money loop stopped | `payments` replicas, the scheduler lease | heartbeat `provider-sync` |
| `transfers-stuck` | P | transfers processing over 24 hours or pending over 1 hour | the sweep's `stuck`; the transfer's provider operations in Fin Admin | `job.run.stuck > 0` |
| `transfer-sent-after-end` | P, trips | the provider took a commit Fin had ended | the transfer's provider operations; the break | `money.transfer_sent_after_end` |
| `idempotency-mismatch` | P, trips | the same provider key went out with another body: a Fin bug | the operation log for the key | `money.idempotency_mismatch` |
| `reconciliation-break` | P | a break exists; above its threshold it tripped the switch | the break in Fin Admin | `money.reconciliation_break` |
| `orphan-payout` | P, trips | a provider payout with no Fin row | the provider's payout list for the holder; a lost row after a failover | `money.orphan_payout` |
| `money-switch-tripped` | P | a money switch was tripped automatically | the trip's reason in the audit log | `switch.tripped` with a money switch |
| `money-durability-unconfirmed` | P (production) | payouts are waiting because no synchronous standby is confirming | `sync-standby-missing`, Patroni state | `money.durability_unconfirmed` |
| `ledger-unsequenced` | P | ledger entries are not being chained | the sequencer duty and its lease | `money.ledger_unsequenced` |
| `holder-locked` | N | a provider locked a holder | the provider's RFI for the user | `money.holder_locked` |
| `provisioning-failed` | N | holders failing or out of attempts | the holder's last error code | `money.provisioning_failed` |
| `accounts-not-closing` | N | closes not confirmed | the provider's pay-in status | `money.accounts_not_closing` |
| `funding-low` | staging, email | staging's MassPay treasury is low | ask MassPay to top up the sandbox balance | `money.funding_low` |
| `provider-events-backlog` | N | the inbox is not draining | the `provider-events` duty | `oldestDueS` |
| `money-door-volume` | N | a caller exceeds its door volume | the calling service's recent deploys; a compromise | door ceiling refusals |
| `simulation-refused` | P | something asked for a simulation on live production | the caller; this must never happen | `money.simulation_refused` |
| `duty-stalled-<duty>` | P for `orphans`, `provider-events`, `ledger-sequencer`; N for the rest | a money duty has not succeeded for three times its cadence | the duty's last `job.run` | ARCH §4.6 success alerts |

### 30.4 Heartbeats and dashboard

Heartbeats (ARCH §10.7): `scheduler-payments` (60 s), `provider-sync` (60 s), `reconcile-daily` (1 day);
added to `ops/monitoring/<env>/heartbeats.json` by L-MON-09. The "Fin Services" dashboard gains panels:
provider calls, failures and p95 by instance and operation; transfers by status and stuck; breaks by
kind; inbox backlog; holders by state; ledger sequencer lag; money switch state.

---

## 31. Kill switches

The switch table and its reads are Saturday's (ARCH §15.1, [OP-01]). Money uses two names (XC-03):

| Switch | Stops | Set by |
|---|---|---|
| `live_money` | every live-mode money write (creates, submits, opens, registrations, funding) | Fin Admin `switches.manage` with an intent, or `pnpm fin switch` |
| `provider_instance:<instance>` | every money write on that instance, in either mode | the same, and automatic trips (§20.4) |

Reads are with no cache, before every door write and before every provider write call (§4 rule 11).
A stopped request answers 503 `temporarily_unavailable` with `Retry-After: 60` and writes
`switch.refused`. Jobs skip writes on a stopped instance and keep reading, so pending transfers reach
their deadline and are stopped and read safely. A prepared Cloudflare WAF rule on `api.<zone>`'s money
routes (`/v4/transfers*`, `/v4/customers/*/beneficiaries*`, `/v4/customers/*/virtual_account*`) is
created disabled, as `killswitch-money` (spec 08 §8.6), in hardening with `pnpm fin killswitch`
(H-04, [OP-01]; it moves there from L-MON-09; ARCH §15.1). On the shared staging zone it is
written and toggled like every fin-next zone rule: one rule at a time through the per-rule
endpoint, with the `fin_next_` ref prefix, never by replacing a whole phase, and with each write
checked against [FD-09]'s allow-list ([BD-11]). Tests: each switch stops what it names and nothing
else (T-MON-29).

---

## 32. Security

### 32.1 The Monday attack profiles (EX §1.7), and where each is answered

| Profile | Answer |
|---|---|
| Payout replay and idempotency abuse | §16: permanent keys bound to the transfer; request hash; business ID from the scope; T-MON-20, T-MON-21 |
| Double spend under concurrency | §9.4 row lock; holds; T-MON-22 (20 concurrent sends) |
| A forged or replayed MassPay webhook | §18: signature over raw bytes, 5-minute window, dedupe, read-back before apply; T-MON-25 |
| Ledger imbalance or a double posting | §7.7 sum-to-zero trigger; unique `(transfer_id, kind)`; T-MON-33, T-MON-23 |
| A lost provider answer treated as "no money moved" | §4 rule 5 and §13.3; CS-11 to CS-14; T-MON-24 |
| A payout from a row a failover lost | §4 rule 2 durability; §16.2 business ID; the orphan search; T-MON-21, T-MON-26 |
| Provider names or bodies leaking to developers | §3.4 lint; §25.7 mapping; T-MON-40 |
| A Sandbox key moving live money | mode routing (§6); the key's mode is re-read by `payments`; T-MON-15 |
| A console-signed call skipping `payments`' checks | §24.1: `payments` re-checks session, permission and intent itself; T-MON-27 |
| Try it leaking a key | ARCH §13.11's five layers; AC-MON-12 |

### 32.2 Other rules

- Only `payments` holds money keys and provider credentials (NB-10); `pnpm fin verify` proves no other
  service has a `MASSPAY_*` or `FIN_MONEY_*` variable (AC-MON-14).
- No money work runs in `worker` or `api` (AC-MON-14), apart from the worker's anchoring read.
- `deliveryFetch` is not used for providers: provider hosts are fixed and allowlisted in code (ARCH §4.4).
- Every money list read is bounded and indexed; a door call never returns another organisation's row,
  proven per operation (T-MON-28).

---

## 33. Tests

Labels as EX §0: `[U]` unit, `[I]` integration on real Postgres 18, `[C]` conformance or contract,
`[E2E]` Playwright, `[STG]` on staging.

| ID | Label | Proves | Lane |
|---|---|---|---|
| T-MON-01 | U | outcome mapping tables (§13.3) for every `PayoutState` and refusal | L-MON-01 |
| T-MON-02 | U | the business ID derivation: deterministic, at most 45 characters, attempt suffix | L-MON-01 |
| T-MON-03 | U | the request hash canonicalisation | L-MON-01 |
| T-MON-04 | U | beneficiary validation table (§12.1), including the failing test routing number passing | L-MON-01 |
| T-MON-05 | U | posting builders: every `kind` sums to zero; fee and return variants | L-MON-01 |
| T-MON-06 | U | holder and transfer state machines refuse every transition not drawn | L-MON-01 |
| T-MON-10 | U | routing (§6.3): rules, capabilities, businesses, disabled instances | L-MON-02 |
| T-MON-11 | U | `Outcome` type guards; no `unknown` path ends a row | L-MON-02 |
| T-MON-12 | U | the simulator's capabilities match the live route's (§5.2) | L-MON-02 |
| T-MON-15 | I | `simulate*` and `fundFromTreasury` refused on a live production instance; live mode never routes to the simulator in production; a Sandbox key cannot reach a live instance | L-MON-02, L-MON-03 |
| T-MON-20 | I | a replayed `POST /v4/transfers` with the same key creates one transfer and answers it as it is now; a different body is 422 | L-MON-05 |
| T-MON-21 | I | a transfer row deleted after submit (a simulated failover) and retried with the same key adopts the same provider payout | L-MON-01 |
| T-MON-22 | I | 20 concurrent sends on one balance: the balance never goes below zero, holds exact (EX §5.4) | L-MON-01 |
| T-MON-23 | I | the same return or deposit applied by the webhook, the sweep and the walk posts once | L-MON-04 |
| T-MON-24 | I | a lost provider answer is never marked failed until the read-back says it did not happen | L-MON-01 |
| T-MON-25 | I | webhook: wrong signature, old timestamp, replayed body; a valid one triggers a read-back and a provider-actor audit event | L-MON-04 |
| T-MON-26 | I | `submitPayout` is never called before durability is confirmed; with `sync_standby` and an empty standby list, nothing is submitted | L-MON-01 |
| T-MON-27 | I | `payments` refuses a console-signed call for a dead session, a member without the permission, a missing, used, foreign or mismatched intent; a revoked key's forwarded assertion; a live money key without an allowlist | L-MON-03 |
| T-MON-28 | I | every door read is confined to the caller's organisation and mode | L-MON-03 |
| T-MON-29 | I | each money switch stops what it names and nothing else; an automatic trip refuses new payouts | L-MON-04 |
| T-MON-30 | I | `EXPLAIN` on every list read uses its index | L-MON-01 |
| T-MON-31 | I | the grant matrix: each forbidden statement on `money.*` fails with 42501 | L-MON-01 |
| T-MON-32 | I | committing a beneficiary, transfer or ledger entry with no audit row fails | L-MON-01 |
| T-MON-33 | I | an unbalanced entry or a one-line entry fails at commit; ledger rows refuse update and delete | L-MON-01 |
| T-MON-34 | I | the nightly recompute finds an injected drift | L-MON-04 |
| T-MON-35 | I | the TypeScript chain recomputation equals `money.sequence_ledger()`'s hashes | L-MON-04 |
| T-MON-36 | I | `audit.record()` refuses each money event from a role not allowed it | L-MON-01 |
| T-MON-37 | I | one test per audit event of §28 that fails when it is not written | L-MON-01 |
| T-MON-38 | I | the join check: each transfer status has its audit event, developer event and posting | L-MON-01 |
| T-MON-39 | I | no provider call happens inside a transaction (the hook fails any `fetch` while a client is held) | L-MON-01 |
| T-MON-40 | U, CI | no provider name, status or reference in developer answers, events, error pages, OpenAPI examples, console bundles or built docs | L-MON-05 |
| T-MON-41 | U | scrubbers remove each money shape (§21.7) | L-MON-03 |
| T-MON-42 | I | a full number is stored only sealed; API and screens show last four; a reveal needs a window and writes its event, as does an API instructions read | L-MON-01, L-MON-06 |
| T-MON-43 | I | the holder door returns presence only for the simulator and never opens a value; it refuses a non-approved or business customer | L-MON-05 |
| T-MON-44 | I | a stale `customer_changed` job (lower `status_seq`) changes nothing | L-MON-04 |
| T-MON-45 | I | reconciliation with an injected difference writes a break, raises the alert line, and above the threshold trips the switch | L-MON-04 |
| T-MON-46 | I | the deletion guard refuses a customer with a balance, hold or non-final transfer | L-MON-03 |
| T-MON-50 | U | MQ-01 to MQ-28 | L-MON-03 |
| T-MON-51 | U | the MassPay HTTP client rules (§21.8) | L-MON-03 |
| T-MON-60 | C | the conformance suite on the simulator (CI) | L-MON-02 |
| T-MON-61 | C | the conformance suite on the MassPay adapter with recorded answers (CI) | L-MON-03 |
| T-MON-62 | C | OpenAPI route parity and negative tests for money (ARCH §13.8) | L-MON-05 |
| T-MON-63 | C | one contract test per console and Fin Admin money route | L-MON-06, L-MON-07 |
| T-MON-70 | E2E | the console journeys of §26.11 | L-MON-06 |
| T-MON-71 | E2E | the Fin Admin money view | L-MON-07 |
| T-MON-72 | E2E | Try it on money routes with a Sandbox key; a Production key refused | L-MON-08 |
| T-MON-80 | STG | AC-MON-13 to AC-MON-15 | L-MON-09 |

Integration tests run in CI's `db` job on Postgres 18 ([CI-12]); journeys in `e2e`; the nightly
MassPay conformance only from staging's `payments`.

---

## 34. Build lanes

### 34.1 Lanes, machines and order

EX §5.2 holds; the files are made exact here.

| Lane | Machine | Starts | Owns (and only these) | Delivers |
|---|---|---|---|---|
| L-MON-01 Money core | A | 08:00 | `packages/money/{package.json,src/index.ts}`; `packages/money/src/{schema,ledger,domain}/**`; `packages/db/migrations/*_money_*.sql` except `*_money_simulator_*`; `packages/db/roles/grants/money.json`; `packages/audit/src/events/money.ts`; `packages/events/src/types/money.ts`; `packages/email/src/templates/money/**`; `packages/testing/src/seed/money.ts`; `ops/monitoring/catalog/money-domain.ts`; `ops/monitoring/{staging,production}/alerts/money-domain.json` | §7 to §17, §28, §29 |
| L-MON-02 Provider interface | B | 08:00 (Sunday evening for the pure types) | `packages/money/src/{provider,conformance}/**`; `packages/money/src/providers/fin-simulator/**`; `packages/money/src/providers/skeleton/**`; `packages/db/migrations/*_money_simulator_*.sql`; `packages/db/roles/grants/money-simulator.json`; `packages/contract/src/money/test-values.ts`; `packages/testing/src/money/**` | §3 to §6, §22, §23 |
| L-MON-03 MassPay adapter and `payments` | A | 10:00 (on L-MON-02's types) | `packages/money/src/providers/masspay/**`; `apps/payments/**` except `src/{hooks,jobs}/**`; `packages/server/src/doors/payments.ts`; `ops/monitoring/catalog/money-provider.ts`; `ops/monitoring/{staging,production}/alerts/money-provider.json` | §2, §21, §24.1, §24.2 |
| L-MON-04 Money jobs and hooks | B | 11:00 | `apps/payments/src/{hooks,jobs}/**`; `apps/edge/src/hooks/money.ts`; `apps/api/src/worker/ledger-anchor/**`; `ops/monitoring/catalog/money-jobs.ts`; `ops/monitoring/{staging,production}/alerts/money-jobs.json` | §9.5, §10.1, §18 to §20 |
| L-MON-05 Money API | A | 12:00 | `apps/api/src/routes/{virtual-accounts,balances,beneficiaries,transfers,quotes,sandbox/money}/**`; `apps/api/src/doors/holder/**`; `packages/server/src/doors/api-holder.ts`; `packages/contract/src/money/**` except `test-values.ts`; `packages/contract/openapi/money.json`; `packages/contract/src/errors/money.ts` | §24.3, §25 |
| L-MON-06 Console money | B | 12:00 | `apps/console/src/client/routes/{customers/$id/-money,virtual-accounts,transfers}/**`; `packages/frame/src/nav/console/money.ts`; `apps/console/src/server/routes/money/**`; `apps/console/src/server/policy/money.ts`; `packages/app-contracts/src/money/**`; `apps/console/e2e/mon/**` | §26 |
| L-MON-07 Fin Admin money | B | 14:00 | `apps/admin/src/client/routes/money/**`; `packages/frame/src/nav/admin/money.ts`; `apps/admin/src/server/routes/money/**`; `apps/admin/src/server/policy/money.ts`; `packages/app-contracts/src/admin/money/**`; `apps/admin/e2e/mon/**` | §27 |
| L-MON-08 Docs | A | 08:00 | `apps/docs/**` | §25.8 |
| L-MON-09 Ops | B | 08:00 | `ops/fin/**` (money commands: `money fund`, `money webhook create|rotate|delete`); `ops/environments/*.json` (money settings); `ops/credentials.json` (money entries); `ops/monitoring/{staging,production}/heartbeats.json`; `ops/monitoring/dashboards/**`; `docs/runbooks/money-*.md`; `docs/flows/**` money flows (F11, F12, F13) | CR-14 set on `payments` only; `payments`' static IPs; SP-13; the MassPay webhook; heartbeats; runbooks; AC-MON-13 to AC-MON-15 (the prepared WAF rule moves to hardening, H-04, [OP-01]) |
| L-MON-10 Design | canvas | 08:00 | the canvases (outside the repository) | §26.10's copy changes in light, dark and phone; a Fin Admin money board (stretch) |
| L-MON-11 UI kit, money | B | 08:00 | `packages/{tokens,icons,motion,ui,frame}/**` (EX §5.2; spec 06 §11), except the area lanes' `packages/frame/src/nav/{console,admin}/money.ts` | The money components L-MON-06 and L-MON-07 build on (AmountInput, AmountPair, QuoteLine, MoneyRoute, the asset, network and rail icons, TableAmount, the identifier helpers, the businesses' "coming" state, the L-drawer wizards), before 13:00 |

```
L-MON-02 types + routing + simulator + conformance ──► L-MON-03 MassPay adapter ──► payments door
            │                                                        │
L-MON-01 schema + ledger + domain ◄──────────────────────────────────┘
            ├──► L-MON-04 jobs, hooks, reconciliation, ledger head
            ├──► L-MON-05 API ──► L-MON-06 console screens ──► money journeys
            └──► L-MON-07 Fin Admin view
L-MON-08 docs: the reference regenerated after L-MON-05; L-MON-09 from 08:00 (SP-13 first)
L-MON-11 money components ──► L-MON-06 console screens, L-MON-07 Fin Admin view
```

Milestones: by **13:00 (C2)** L-MON-02's interface, simulator and CS-01 to CS-30 on the simulator are
green, and L-MON-01's schema, ledger and transfer path pass T-MON-20 to T-MON-24 against the
simulator, else CUT-05. By **18:00 (C3)** the console send-money journey (T-MON-70's
`send-money.spec.ts`) is green against the simulator, else CUT-06. By **22:00 (C4)** the staging deploy
carries everything merged, and AC-MON-13 is attempted with CR-14.

### 34.2 Shared files and how lanes add to them

| Shared thing | Rule |
|---|---|
| `packages/core/src/ids.ts` | The new prefixes of §7.1 go in one pull request from L-MON-01 to the file's owner first thing Monday (XC-01) |
| `packages/core/src/scrub.ts` | The money shapes of §21.7 go in one pull request from L-MON-03 to its owner (XC-08) |
| `packages/access` catalogues | Unchanged: the dashboard's `money.*` and staff `money.read`, `money.operate` exist from Saturday |
| Monitoring catalogue and alerts | Split by lane (`money-domain`, `money-provider`, `money-jobs`), so no two lanes edit one file |
| `pnpm-lock.yaml` and dependencies | No new dependency is needed for money. Scalar is in [G-06]'s set |
| `tools/layout.json` | `packages/money` and `apps/payments` are listed from Phase 0; the paths above must match it. `packages/money` is a `planned` entry, so creating it makes `layout:check` warn, not fail, and no money lane edits this control path ([BD-08]) |

### 34.3 Definition of done for a money pull request

EX §1.5, plus: the conformance suite passes for every adapter the change touches; the join check
holds; no new provider name outside the allowed folders; the money routes' OpenAPI fragment is
regenerated; any screen change is mirrored on the canvas.

### 34.4 Review

Every money lane is tier S (EX §5.4): the `pr` gate runs the security, correctness, performance,
quality, rules and test-truth lenses and the attack pass with the Monday profiles (§32.1), on the
models and efforts R11 and [RV-03] allow (defaults: overall `claude-opus-5-5` at `xhigh`, attack
`claude-fable-5-2` at `high`, EX-10). The MassPay adapter's review includes the neutrality check. The
nightly review at 01:00 Tuesday covers Monday's packages.

---

## 35. Acceptance criteria

AC-MON-01 to AC-MON-16 are EX §5.6's, unchanged; this spec's tests prove them as listed. AC-MON-17
onwards are added here.

| ID | Statement | Proven by |
|---|---|---|
| AC-MON-01 [C] | The simulator and the MassPay adapter pass the same conformance suite, including lost answers, replays, quote expiry, holds and returns | T-MON-60, T-MON-61 |
| AC-MON-02 [I] | Debits equal credits; spendable equals balance minus holds; no balance below zero under 20 concurrent sends; a return or deposit seen three ways posts once | T-MON-05, T-MON-22, T-MON-23, T-MON-33 |
| AC-MON-03 [I] | A lost answer is never marked failed before the read-back; a retried key creates one transfer; the console's retries reuse one `tni_`; no submit before durability | T-MON-20, T-MON-24, T-MON-26, T-MON-70 |
| AC-MON-04 [I] | No provider call inside a transaction | T-MON-39 |
| AC-MON-05 [I] | Wrong, stale or replayed webhooks refused or stored once; a valid one reads back and audits with a system actor | T-MON-25 |
| AC-MON-06 [I] | An injected reconciliation difference writes a break, alerts, and above the threshold trips the switch, which refuses new payouts | T-MON-45, T-MON-29 |
| AC-MON-07 [I] | No provider name, status or reference reaches developers | T-MON-40 |
| AC-MON-08 [I] | Full numbers only sealed; last four shown; reveals need step-up and are audited, as are API instruction reads | T-MON-42 |
| AC-MON-09 [I] | Adding a beneficiary and sending money are refused without an intent; a send's intent fits only its transfer, once | T-MON-27 |
| AC-MON-10 [I] | A Sandbox key cannot reach a live host; the live host only by a reviewed change; treasury and simulations refused on live production | T-MON-15 |
| AC-MON-11 [E2E] | The console money journey end to end, each step in the audit log | T-MON-70 |
| AC-MON-12 [E2E] | Try it with a Sandbox key works; a Production key refused; nothing kept | T-MON-72 |
| AC-MON-13 [STG] | A staging live-mode customer completes a transfer through MassPay's sandbox from `payments`' static IPs; the webhook arrives through the edge and verifies | T-MON-80 |
| AC-MON-14 [STG] | MassPay credentials only on `payments`; no money duty in `worker` | `pnpm fin verify` |
| AC-MON-15 [STG] | `provider.call` lines in Better Stack; the "calls failing" alert fires in a drill | T-MON-80 |
| AC-MON-16 [I] | `payments` itself refuses dead sessions, missing permissions or intents, revoked keys and live money keys without an allowlist | T-MON-27 |
| AC-MON-17 [I] | A customer approval in `api` creates a holder in `payments` through the job, and the holder reaches `active` with a balance and an open virtual account on the simulator within one minute; a stale job changes nothing | T-MON-44 and an integration test across `api` and `payments` |
| AC-MON-18 [I] | The holder door never opens a value for the simulator, and refuses business and non-approved customers | T-MON-43 |
| AC-MON-19 [I] | Every money list read is confined to its organisation and mode and uses its index | T-MON-28, T-MON-30 |
| AC-MON-20 [I] | Committing a beneficiary, transfer or ledger entry with no audit row fails; ledger rows cannot be changed; the ledger chain recomputes | T-MON-32, T-MON-33, T-MON-35 |
| AC-MON-21 [E2E] | The Money tab's must-have states of §26.4 to §26.9 are reached in the browser or by a component test | T-MON-70 and the state manifest |
| AC-MON-22 [I] | A customer or organisation with money cannot be deleted | T-MON-46 |

---

## 36. Production gates for money

EX §7.3 holds. The money parts:

| Gate | Money evidence |
|---|---|
| PG-05 Drills | the live-money switch and an instance switch toggled, and the prepared WAF rule; a forged MassPay webhook refused; an orphan payout injected on staging and detected within 5 minutes; a restore followed by the ledger walk and orphan listing before money is unfrozen (ARCH §15.3) |
| PG-07 Data and legal | a consent step naming the provider before a holder's details are shared ([MO-12]) |
| PG-14 Live money | MassPay's answers on live limits, cut-offs, fees, virtual account lifetime and businesses; `payments`' static IPs on MassPay's allowlist; real inbound deposits seen and posted (§14.2); reconciliation running, alerting and tripping in production; the fee ceilings re-read from live quotes; value caps, the first-payout delay and the second approver set ([MO-19]); live money keys with allowlists ([MO-20]); synchronous standby confirmed and payouts durable before submission ([MO-18], [P-10]); the beneficiary security email; `masspay-live` enabled by a reviewed change and the switch tested; a small live transfer drill end to end |

---

## 37. Owner decisions due Monday, and what a different answer changes

Defaults apply from 09:00 Monday (DECISIONS "Monday").

| Decision | Default built | If overturned |
|---|---|---|
| [MO-03] seal full beneficiary numbers | sealed, lazy registration | No `account_number_sealed`: every rail is registered at add time, a beneficiary can never move provider or rail, and `stale` counterparties cannot be repaired; §12.3's re-registration goes |
| [MO-04] seal Fedwire ID | sealed | No ID columns; the Fedwire registration happens at add time only; the ID hint keeps its old copy |
| [MO-05] Sandbox on the simulator | §6.2's rules | Sandbox routes to `masspay-sandbox`: developers' Sandbox data would break MassPay's synthetic-data terms (MQ-26); the shared treasury caps of the old product return; the simulator stays for CI |
| [MO-08] `amount` and `currency` | as §25.2 | the fields become `amount_cents`, `fee_cents`, `total_cents`, and the balance's `*_cents`; contract and screens only |
| [MO-13] Fin Admin money | the read-only view plus stretch operations | views only: drop §27.3 |
| [MO-16] the fee quote route | `POST /v4/transfers/quote` | no public route; the console keeps its quote call through the door, or shows `feeUnavailable` |
| [DA-12] keep money records on organisation deletion | kept, personal fields blanked | nothing in Monday's code changes: money tables never cascade |
| [AP-11], [AP-12] | the Scalar exception; a theme from tokens | the docs lane follows the answer |

---

## 38. Spec decisions and cross-spec contracts

### 38.1 Spec decisions (for the owner to confirm; builders proceed on them)

| ID | Decision | Why |
|---|---|---|
| MS-01 | Provider instances and routing rules are code in `apps/payments/src/config/`, mirrored to tables at start | ARCH §12.6 calls them configuration; code makes each change reviewed and stops a variable from adding a host or a live route |
| MS-02 | Live money is on in staging (MassPay's sandbox, synthetic data) and off in production until PG-14; a live call where it is off is 403 `sandbox_only` | AC-MON-13 needs staging's live mode; ARCH §13.1 rule 6 |
| MS-03 | `payments` mirrors each customer's type and KYC status from `api` jobs and trusts only those rows for writes | `payments` has no `kyc` grants; reads may use a caller's claim for display only |
| MS-04 | `api` tells `payments` about customer changes through `ops.enqueue_job('money.customer_changed', ...)` with a status sequence | [DA-14]'s checked-function pattern; ordered, idempotent and transactional with the change |
| MS-05 | The holder door returns values only for a real provider and presence only for the simulator; for live customers it is a sixth place that reads Sumsub (ARCH §6.5) | Sandbox personal data never crosses into `payments`; the KYC share needs the verified record |
| MS-06 | Beneficiary holder names are opened for the console's Money tab per read without a reveal audit event, like a customer's display name, and never returned by the API | They are the developer's own record, shown in their own console; [AU-01] audits reveals of numbers and personal details |
| MS-07 | The console masks the virtual account number and shows it after a window step-up, audited | AC-MON-08 and ARCH §7.4's window for a full number; the canvas showed it in full |
| MS-08 | The similar-transfer warning is a review-step InlineAlert for the same beneficiary and amount within 24 hours, from the quote call | [MO-07] asks for a warning; the board has no state for it |
| MS-09 | The MassPay method table (catalogue tokens) lives in a sealed variable, validated at start and mirrored to `money.provider_method` | Tokens may not be published (R12); no hard-coded tokens in the domain |
| MS-10 | `pnpm fin money webhook create|rotate|delete` asks for the MassPay key at the secure prompt (on staging, until the owner is back, it reads the sandbox key from its local secret file, [SA-22]) and writes the secret straight into `payments`' variables | The key lives only on `payments`; nothing prints a secret |
| MS-11 | MassPay test fixtures in the repository are synthetic, never real sandbox answers | Sandbox tokens of Fin's account may not be published |
| MS-12 | Durability: `synchronous_commit = remote_apply` plus a non-empty `synchronous_standby_names` check in production; `single_node` recorded in staging; payouts wait when unconfirmed | [MO-18] needs a buildable check; services reach the primary only through HAProxy |
| MS-13 | The beneficiary email may carry `rail` and `account_last4` as non-ID parameters from a closed allowlist | The worker cannot read money tables; the notice must say which account |
| MS-14 | `payments` chains ledger entries (a sequencer every 10 seconds); the worker anchors the daily head from the view `money.ledger_head_v`, its only money grant | The R2 audit bucket has one writer (the worker); the worker has no money grants otherwise |
| MS-15 | Every money audit event is written by `payments` in its own transaction, never by the console or Fin Admin | The guard needs the audit row in the transaction that writes the critical row |
| MS-16 | The console's drawers use `money.transfer_intent` rows (`kind` `send` or `deposit`) as idempotency keys | One key per drawer opening, reused across retries, never made in the browser |
| MS-17 | `Idempotency-Key` on beneficiary create is bound for good to the beneficiary when sent | A lost answer would otherwise give 409 `beneficiary_exists` instead of a replay |
| MS-18 | No ABA checksum on routing numbers in Fin | The documented failing test number must reach the provider's refusal; the provider checks its own pattern |
| MS-19 | A new public reason `fee_changed` for a payout stopped because the fee rose above the ceiling | Developers need to know why; additive |
| MS-20 | A payout holds `amount + fee_ceiling` per rail from the method table; the debit at commit uses the actual fee | A deterministic hold without a provider call before the row exists |
| MS-21 | The first-payout delay mechanism (`first_payout_after`, 409 `beneficiary_not_ready`) is built Monday with 0 in Sandbox and the live delay in the overlay; caps and the second approver stay H-04 | EX §5.5 lists the notice as a Monday state; [MO-19] puts the rest in hardening |
| MS-22 | The quote route takes `money:read`; the console's needs `money.transfer` | A fee is information; the console's review belongs to a sender |
| MS-23 | Staging live-mode funding is an operator task (`pnpm fin money fund staging`), refused in production | AC-MON-13 needs money in a live staging balance; Sandbox routes take Sandbox keys only |
| MS-24 | `money_not_enabled` and `deposit_unavailable` are not carried | Instances are code; the simulator has no shared balance |
| MS-25 | A Sandbox reset closes the organisation's Sandbox holders and bumps a Sandbox epoch; lists show the current epoch; nothing in the ledger is deleted | The ledger is append-only |
| MS-26 | Purging old Sandbox money rows waits for H-09, through a `fin_owner` function that touches Sandbox rows only | Retention design is H-09's |
| MS-27 | Public money enums may gain values; the docs say to accept unknown values | New rails and kinds arrive with providers |
| MS-28 | Virtual account status gains `opening` and `failed` in the API | The screens' states need them; before any developer depends on the shape |
| MS-29 | Orphan payouts are searched every 5 minutes for holders with activity in the last 48 hours, and daily for all | A bounded, affordable 5-minute search that still covers a failover |
| MS-30 | MassPay's observed behaviour (answer shapes, fees, the account relationship, the credential's shape, token formats and defects) lives in a private provider note named by the overlay, not in the repository; the public plan, code, tests and fixtures carry only the neutral rules of §21.6 until the owner has checked MassPay's and Sumsub's API and sandbox terms; the behaviours behind MQ-10 and MQ-11 are reported to MassPay privately | A public plan must not publish another company's defects or prices, or tell an attacker what a stolen provider key is worth |

### 38.2 Cross-spec contracts (owned elsewhere, needed by Monday)

| ID | Contract | Owner |
|---|---|---|
| XC-01 | The ID prefixes `phd`, `pbl`, `pcp`, `pdp`, `tfu`, `tni`, `rcr` added to `packages/core/src/ids.ts` | the `packages/core` owner (Phase 0) |
| XC-02 | `api` calls `ops.enqueue_job('money.customer_changed', ...)` with §10.1's payload on every customer status change, delete, erasure and Sandbox reset, and `ops.enqueue_job` exists as a checked function with a per-role kind allowlist | Sunday's KYC spec; Saturday's `ops` area |
| XC-03 | The switch names `live_money` and `provider_instance:<instance>` exist in `ops.kill_switch`, with `ops.trip_switch()` callable by `fin_payments` | Saturday's operations spec |
| XC-04 | The step-up intent store accepts the money operations and digests of §24.1 | Saturday's identity spec |
| XC-05 | `api` (customer delete) and the console (organisation delete) call `customer.deletable` and `organization.deletable` before deleting | Sunday's and Saturday's specs |
| XC-06 | The customer page's tab row includes "Money" for `money.read` and mounts §26.4's tab | Sunday's console spec |
| XC-07 | The edge's router mounts `apps/edge/src/hooks/money.ts` and lists money hook instances in the door matrix | the edge's owner (Sunday) |
| XC-08 | The money scrubber shapes of §21.7 in `packages/core/src/scrub.ts` | the `packages/core` owner |
| XC-09 | The worker's anchoring duty writes the ledger head daily from `money.ledger_head_v` (code in `apps/api/src/worker/ledger-anchor/**`, owned by L-MON-04) | the audit area's owner, for the shared anchoring loop |
| XC-10 | `audit.record()`'s per-role allowlist includes §28's events for `fin_payments` and `money.holder_details_shared` for `fin_api`; `events.emit()`'s allowlist includes §29.1's types for `fin_payments`; `email.enqueue()` allows `money/*` for `fin_payments` | the audit, events and email owners |
