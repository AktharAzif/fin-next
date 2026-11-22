# Runbook: rotate the Railway project token (staging)

The staging project token (CR-04) can set any image and any variable on every staging service, so
whoever holds it holds every staging secret (ARCHITECTURE §11.8). It lives as a file on the
operator's machine (`FIN_RAILWAY_TOKEN_FILE`) and, once CI deploys staging, as the `staging`
environment's `RAILWAY_TOKEN`. Rotate every 90 days and at once on any Railway notice or exposure.

1. In Railway, create a new project token for the staging project's environment.
2. Write it to a new file (`chmod 600`), point `FIN_RAILWAY_TOKEN_FILE` at it, and prove it reads:
   `node ops/fin/src/main.ts railway verify staging`.
3. If CI holds it, replace the `staging` environment secret `RAILWAY_TOKEN` (the owner's account).
4. Revoke the old token in Railway, then delete its file.
5. Update `ops/credentials.json`'s `railway-project-token` row.

If it leaked, revoke it first, then export Railway's workspace audit log and compare every
deployment and variable change with the registered runs; any change outside one is an incident.
Because a project token reads sealed variables through a deployed image, treat every staging secret
as exposed and rotate each family by its runbook.
