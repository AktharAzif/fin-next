# Lens: test-truth

Question: would each changed or guarding test fail without its guard? Tests are judged against the
spec, never against the code.

- For each changed test, name the guard it is meant to prove and say whether removing or breaking
  that guard would make the test fail. A test that would still pass is class `test-cannot-fail`.
- For each guard the change adds or touches on tier S (a permission check, a validation, a limit, a
  lock), find the test that proves it; a guard with no test that can fail is a finding.
- A mock or fake that answers the way the code wants, an assertion on the value the test itself
  set, a `try` that swallows the failure, a test that is skipped or never awaited: each is a finding.
- When a fix is under review, say whether its test would fail on the code before the fix.
