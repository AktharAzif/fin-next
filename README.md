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

**Planning, 21 Nov 2026.** No code yet. As the owner asked (R13), the plan is the first thing
committed to this public repository (R12), ahead of any code. The build starts on Saturday 21 Nov
2026, and production is not promised for any date.

## The plan

Start with [docs/plan/README.md](docs/plan/README.md). It holds:

- the summary;
- the stack;
- the hosts and routing;
- the decisions of 21 Nov 2026;
- a table that traces each of the owner's requirements, R1 to R16, to where it is covered;
- the timeline;
- what the owner provides before the build starts;
- links to the architecture, the decision register, the execution plan and the eight
  specifications.

## Nothing here is a credential

This repository is public, so nothing in it is a secret. No file holds any of these:

- a credential, key, token or password;
- an account, workspace, team or tunnel ID, or a wallet or provider token;
- an internal address, a zone name, a staff address or a local machine path;
- the name of another private repository, or a commit or pull request reference from one;
- a real person's data.

Hosts are written as placeholders, such as `<app>.<zone>`. Private settings live outside the
repository, in a private overlay that is given at a secure prompt. Credentials are typed only into
that prompt and are never committed. If you find something here that looks like a secret, report it
through the repository's private vulnerability reporting. Do not open a public issue.

## Licence

All rights are reserved. This is the default of decision G-03 in
[docs/plan/DECISIONS.md](docs/plan/DECISIONS.md), which the owner may change: no open-source
licence, with the source public so that it can be reviewed and built in CI, not as an open-source
release. Fin's name, logo and other brand assets are reserved.

The repository's first commit holds only the plan and this page. A `LICENSE` file that says the
same arrives with the repository's root files in Phase 0, together with the notices for the
third-party code, icons and fonts that later commits carry. Until it does, this section is the
licence statement.
