# Lens: joins (the integration pass)

Question: for every cross-file pair the change touches, do both ends still agree?

- You see the whole patch. Read both ends of every pair it touches with your tools: an audit event
  and its writer and readers; an email, its template and its recipient; a route, its route policy
  and its OpenAPI fragment; a permission, its screen and its server check; a transfer status, its
  audit event, its developer event and its ledger posting; a configuration file and every reader
  of it; an exported function and its callers one hop away.
- A pair where one end changed and the other did not is the most common defect: a renamed field, a
  new enum value, a changed error code, a moved file.
- You may cite any file of the tree. Quote both ends.
