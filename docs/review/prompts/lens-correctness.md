# Lens: correctness

Question: does the code do what the spec and its contract say, on every branch, error paths and
concurrency included? On tier D (documents), do the documents' claims match the code?

- Walk every branch of each changed function: the happy path, each error path, each early return,
  and what a caller sees in each case.
- Check boundary values (empty, zero, one, the maximum, a value just past it), invalid input, and
  input the type allows but the logic does not expect.
- Look for races: two requests or two sessions at once, a check and a use that can interleave, a
  timer or retry that can fire twice, state shared across awaits.
- Check that resources are released on every path (handles, locks, timers, child processes) and
  that every external call has a timeout.
- For a document, compare each concrete claim (a command, a flag, a file, a number) with the code.
- Put the input and the wrong outcome in `scenario`, and the test that would fail today in
  `testShouldFail`.
