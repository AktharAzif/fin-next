# fin-next

fin-next is a from-scratch rebuild of Fin (R1), a platform for developers. A developer's
organisation uses Fin's public API and console to onboard its customers (individuals and
businesses) through Sumsub, to open virtual accounts for them and to send money through payment
providers behind one adapter, MassPay first. Fin's staff review customers and run operations in Fin
Admin. Every service and the database run on Railway (R2). Cloudflare sits in front through
Cloudflare Tunnels, and it serves the browser apps as static files (R4). Email goes through
Cloudflare Email Sending (R3), monitoring goes to Better Stack (R5), and every important action is
audited (R9). fin-next replaces a private repository, called "the old product" in these documents.

## Status

**The build started on Saturday 21 Nov 2026.** As the owner asked (R13), the plan is the first
thing committed to this public repository (R12), ahead of any code: it merged as pull request 1.
The code follows in pull requests, starting with the monorepo scaffold in pull request 2.
Production is not promised for any date.

## The plan

Start with [docs/plan/README.md](docs/plan/README.md). It holds:

- the summary;
- the stack;
- the hosts and routing;
- the decisions of 21 Nov 2026;
- a table that traces each of the owner's requirements, R1 to R16, to where it is covered;
- the timeline;
- what the owner provides, and the owner steps still open;
- links to the architecture, the decision register, the execution plan, the spike log and the
  eight specifications.

## Nothing here is a credential

This repository is public, so nothing in it is a secret. No file holds any of these:

- a credential, key, token or password;
- an account, workspace, team or tunnel ID, or a wallet or provider token;
- an internal address, a zone name, a staff address or a local machine path;
- the name of another private repository, or a commit or pull request reference from one;
- a real person's data.

Hosts are written as placeholders, such as `<app>.<zone>`. Until hardening, private settings are
kept only on the build machines (machine A and machine B), outside every repository, where
`pnpm fin` and the public-safety check read them. Giving them as a private overlay at a secure
prompt, with its encryption and escrow, moves to hardening. Credentials are given only at the
secure prompt and are never committed. Until the owner is back, the staging and sandbox
credentials the owner gave on 21 Nov are kept on the build machine, outside every repository
(decision SA-22 in [docs/plan/DECISIONS.md](docs/plan/DECISIONS.md)). If you find something here
that looks like a secret, report it through the repository's private vulnerability reporting. Do
not open a public issue.

## Licence

All rights are reserved. This is decision G-03 in
[docs/plan/DECISIONS.md](docs/plan/DECISIONS.md), which the owner took at its default on
21 Nov 2026: no open-source licence, with the source public so that it can be reviewed and built
in CI, not as an open-source release. Fin's name, logo and other brand assets are reserved.

The repository's root commit is a two-line README. The plan and this page arrived together in pull
request 1, the repository's first merge and its only change before any code. The `LICENSE` file
says the same, and it is the licence statement. It arrived with the repository's root files in pull
request 2, the monorepo scaffold. Third-party code, icons and fonts keep their own licences, and
their notices sit beside the packages that carry them.
