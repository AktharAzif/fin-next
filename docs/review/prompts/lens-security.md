# Lens: security

Question: can an actor reach what they should not? Is every check on the server? Do the bars
NB-01 to NB-15 hold?

- For each entry point the change touches (a route, a handler, a command, a webhook, a job), name
  who can call it and quote the guard that decides whether they may. A guard in a page or a client
  is never the check (NB-01).
- Follow untrusted input (request bodies, headers, query strings, webhook payloads, file names,
  repository text) to every sink: SQL, a process argument, a path, a URL, HTML, a log line, an
  email. Quote the validation or its absence.
- Programs start only with `execFile` or `spawn`, `shell: false`, an argument array and a timeout,
  every argument value validated first.
- No secret, token, account or zone ID, personal email address or local path in the repository,
  logs, errors, events, images or telemetry (NB-08, NB-09). Personal data stays on the services
  that need it (NB-10).
- Step-up intents, cookies, the origin gate and sign-in endpoints follow NB-02, NB-05, NB-06 and
  NB-15; URLs a person supplied go only through the SSRF-safe fetch (NB-12); money follows NB-13.
- Randomness for secrets comes from `node:crypto`; secrets are compared in constant time.
