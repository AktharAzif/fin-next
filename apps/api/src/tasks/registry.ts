// The operator tasks `migrate --task <name>` runs. Each lane adds its own task file here (staff-bootstrap
// is L-SAT-04's, journal-replay and auth-reencrypt come later); this list is the one place the image
// knows them, so a bundled build includes exactly these.
import { auditNote } from "./audit-note.ts";
import { startEpoch } from "./start-epoch.ts";
import type { TaskDefinition } from "./types.ts";

// biome-ignore lint/suspicious/noExplicitAny: each task's parameters are checked by its own schema.
export const TASKS: Readonly<Record<string, TaskDefinition<any>>> = Object.freeze({
  [auditNote.name]: auditNote,
  [startEpoch.name]: startEpoch,
});
