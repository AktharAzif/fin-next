# Lens: infra

Question: do Dockerfiles, `ops/**` and the workflows grant only what they need, pin what they run,
and keep secrets out?

- Privileges: a container running as root, a workflow `permissions:` wider than its jobs need, a
  token passed to a step that does not use it.
- Pins: every action by full commit SHA, every image by digest, every downloaded tool by checksum.
- Secrets: never in a command line, a log, an artefact, a cache key or a build argument; a job
  holds only its own secrets.
- Untrusted input: `pull_request_target`, a branch name or title in a `run:` line, a cache that a
  pull request can write and `main` reads.
- Drift: a setting that differs from what the declared configuration in the tree says.
