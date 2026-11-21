# Runbook: `pnpm fin routes apply <env>`

Writes the Workers routes and then the DNS records of every Fin host (spec 01 §7.2, §7.5; [FD-18];
EXECUTION §2.5 steps 6 and 8). It is the only command that writes those records.

## What it writes, in this order

1. **Workers routes**, for each static deployment:
   - `<host>/*` to its assets-only deployment (`fin-next-<env>-<app>-static`);
   - `<host>/api/*` with **no Worker**, on every app host but the docs host, so `/api/` falls through
     to the host's DNS origin (the tunnel). Never `<host>/api*`, which also matches `/apix`; the
     guard refuses it by name.
   The API host has no route; a route found on it, or any other route on a Fin host that the
   settings do not list, is deleted (with `--confirm-delete <n>`), whatever its path (a stale
   `<host>/api*` included).
2. **Proxied CNAMEs** to `<tunnel id>.cfargotunnel.com`, read at run time: the API, console, verify,
   selfie and docs hosts to the public tunnel; the staff (admin) host to the admin tunnel. No record
   for the database host until the db tunnel exists (hardening).

Routes and records on any other host are never written. A name that already holds another record
type (an A record, say) is held, not overwritten: resolve it by hand.

A route of any other shape that still matches one of Fin's hosts (another product's `*.<zone>/*` or
`*gateway.<zone>/*`, which would send the API host's requests to that product's Worker) makes the
command refuse before it sends anything (exit 77), naming the pattern. It never deletes such a
route: it belongs to another name (§7.5). Resolve it by hand with the owner, then re-run.

The routes need their static deployments to exist, so the first run comes after the first static
deploy.

## Run it

```sh
export FIN_OVERLAY_FILE=<overlay> FIN_CF_TOKEN_FILE=<operator token file>
node ops/fin/src/main.ts routes apply staging --dry-run
node ops/fin/src/main.ts routes apply staging
```

## Check it

- `curl -s https://<console host>/` answers the app; `curl -s https://<console host>/api/health`
  answers the API half through the tunnel; `/api` without the slash answers the app.
- `curl -s https://<docs host>/api/x` answers the docs app, never Railway.
- A second `--dry-run` prints `nothing to change`.

## If it fails

The run stops at the failed write; re-run after fixing the cause. If a route was written but its
host's record was not, the host answers Cloudflare's error page until the re-run: nothing reaches
Railway that should not. Every write is checked before the run registers, so a safety refusal
(exit 77) sends nothing at all. Errors name records and routes by role (`<dns:console>`), never by
ID.
