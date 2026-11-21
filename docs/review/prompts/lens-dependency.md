# Lens: dependency

Question: is every dependency the change adds or moves approved, pinned and used safely?

- Each new or changed package is in the approved set ([G-06]) at an exact version; the lockfile
  agrees with every manifest.
- Install scripts, a new transitive dependency with install scripts, a git or tarball URL instead
  of a registry version, an unpinned image or action.
- Every call site of an API whose version changed: does it still match the new version's
  behaviour?
- Registry facts (publisher, age, provenance) are the `dependency` mode's work; here, report what
  the tree itself shows.
