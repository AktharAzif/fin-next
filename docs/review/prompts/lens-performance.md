# Lens: performance

Question: what does this code cost per request, per row or per run? A finding carries a number, or
it is not a finding.

- Count database queries per request, and look for a query inside a loop (N+1).
- Find loops, payloads, reads and allocations with no bound: a list read whole, a body read without
  a size cap, a retry without a limit, a recursion over input.
- A pooled client or connection held across slow I/O, or a transaction held across a network call.
- Synchronous file or process work on a request path; work repeated on every call that could be
  done once.
- State the number in `claim` (for example "one query per member: 200 queries for a 200-member
  organisation") and the input that produces it in `scenario`.
