# Runbook: rotate the ingress proofs (staging)

Each Fin host's ingress proof is a 32-byte value that a request-header transform rule adds as
`Fin-Ingress-Proof` and that the host's service checks with the connector peer (spec 01 §6.7, §7.6;
[FD-12]). Rotate every 90 days, and at once if a `FIN_INGRESS_PROOFS` value or a rule's value was
exposed. Services accept two values (current and previous), so a rotation has no outage.

`pnpm fin zone apply` keeps existing proofs and only makes new ones for hosts that have none. Until
a `--rotate-ingress-proofs` step exists, rotate one host by hand-off to the command:

1. In Cloudflare, disable (do not delete) the host's rule `fin_next_ingress_proof_<role>` in the
   request header transform phase. Requests to that host now arrive without a proof and get 403
   `ingress.untrusted_peer`: do this in a quiet window.
2. Delete that one rule, then run `node ops/fin/src/main.ts zone apply staging --only rules`. It
   generates a new proof for the role and sets it sealed in `FIN_INGRESS_PROOFS` on the service
   that checks it, in a commit that starts no deployment, read back until it shows. Then it
   redeploys that service as a step of its own (the rotation, `pnpm-fin.md`: `~ update redeploy
   <service> [FIN_INGRESS_PROOFS]`, a `run.step` and a `rotation.redeployed` line), waits for
   `SUCCESS`, reads back again, and only then writes the rule that sends the new proof. If the
   redeploy or a read-back fails, no rule is written and the output says the rotation is not done:
   fix the cause and run the same command again (the rule is still missing, so it makes a proof
   once more and redeploys).
3. Check: `/api/health` answers through the host; no `ingress.untrusted_peer` lines after the
   redeploy.

The two-value overlap (add the new value to the service, deploy, switch the rule, remove the old
value) arrives with the rotation step in hardening; until then the window in step 1 is the cost.
