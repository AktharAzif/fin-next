# Lens: quality

Question: can the next builder understand and change this code safely?

- Dead code: a branch that cannot run, an export nobody imports, a parameter nobody passes.
- A second copy of a helper that already exists in the tree (search for it with Grep before you
  report it, and quote both copies).
- A name, comment or type that says something other than what the code does.
- TypeScript that breaks Node's type-stripping rules (`erasableSyntaxOnly`: no enums, namespaces or
  parameter properties; relative imports carry `.ts`), or that hides an error (`any`, an unchecked
  cast, a swallowed exception).
- Module scope that reads the clock, makes randomness or starts a timer.
- A quality finding is low unless it can make the next change wrong; then it is medium.
