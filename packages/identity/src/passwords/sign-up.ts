// A password chosen at sign-up (spec 02 §5.1, §5.7): `POST /api/sign-up` checks it and keeps only
// its argon2id hash on the sign-up request, which no account reads; the account and its password
// exist only once the mailbox is proved, when the code sign-in in the asking browser creates the
// user and the after-hook writes the credential row in the same transaction as `user.created`.
import { AuthRefusal } from "../errors.ts";
import type { UnitTx } from "../ports/db.ts";
import { newId } from "../ports/ids.ts";
import type { RealmRuntime } from "../runtime.ts";
import { assertNewPassword } from "./policy.ts";

/**
 * The hash to keep for a sign-up's password, or null when none was given. Hashed for a registered
 * address too (and thrown away), so both branches of sign-up take the same time (T-SAT-32).
 */
export async function signUpPasswordHash(
  rt: RealmRuntime,
  password: unknown,
  email: string,
): Promise<string | null> {
  if (password === undefined || password === null) return null;
  if (!rt.settings.features.passwords) {
    throw new AuthRefusal("invalid", "passwords.off", {
      fields: ["password"],
      problem: "password_not_offered",
    });
  }
  return rt.passwords.hash(assertNewPassword(password, "password", { email }));
}

/**
 * Gives the new account the password its sign-up request kept (the credential row the library's
 * own sign-in reads). Runs in the unit that wrote `user.created`, which the account table's audit
 * guard accepts for the insert.
 */
export async function applySignUpPassword(
  tx: UnitTx,
  rt: RealmRuntime,
  signUpRequestId: string,
  userId: string,
): Promise<boolean> {
  const kept = await tx.query<{ password_hash: string | null }>(
    "SELECT password_hash FROM identity.sign_up_request WHERE id = $1",
    [signUpRequestId],
  );
  const hash = kept.rows[0]?.password_hash ?? null;
  if (hash === null || !rt.settings.features.passwords) return false;
  const now = rt.clock.now();
  await tx.query(
    `INSERT INTO identity.account (id, user_id, account_id, provider_id, password, created_at, updated_at)
     VALUES ($1, $2, $2, 'credential', $3, $4, $4)`,
    [newId("acc", rt.clock), userId, hash, now],
  );
  return true;
}
