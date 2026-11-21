// The library's tables, declared in Drizzle for the Better Auth adapter (spec 02 §13.1 to §13.3).
// Property names are the library's field names; column names are snake_case. The SQL that
// creates them is hand-written in migrations/ (ARCHITECTURE §6.4); SP-10's pin test compares
// these declarations, the installed plugins' schema and the database's columns.
//
// Spec 02 §20.1 places these declarations in packages/db/src/schema/{identity,staff}.ts; this
// lane owns only packages/identity/**, so they live here until packages/db lands and are moved
// there by a follow-up pull request.
import { boolean, integer, pgSchema, smallint, text, timestamp } from "drizzle-orm/pg-core";

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

function realmTables(schemaName: "identity" | "staff", userModel: "user" | "member") {
  const schema = pgSchema(schemaName);

  const user =
    userModel === "user"
      ? schema.table("user", {
          id: text("id").primaryKey(),
          name: text("name").notNull(),
          email: text("email").notNull().unique(),
          emailVerified: boolean("email_verified").notNull(),
          image: text("image"),
          twoFactorEnabled: boolean("two_factor_enabled").notNull(),
          createdAt: tz("created_at").notNull(),
          updatedAt: tz("updated_at").notNull(),
        })
      : schema.table("member", {
          id: text("id").primaryKey(),
          name: text("name").notNull(),
          email: text("email").notNull().unique(),
          emailVerified: boolean("email_verified").notNull(),
          image: text("image"),
          twoFactorEnabled: boolean("two_factor_enabled").notNull(),
          roleKey: text("role_key").notNull(),
          status: text("status").notNull(),
          factorEnrolledAt: tz("factor_enrolled_at"),
          addedBy: text("added_by").notNull(),
          lastSignedInAt: tz("last_signed_in_at"),
          removedAt: tz("removed_at"),
          createdAt: tz("created_at").notNull(),
          updatedAt: tz("updated_at").notNull(),
        });

  const session =
    userModel === "user"
      ? schema.table("session", {
          id: text("id").primaryKey(),
          userId: text("user_id").notNull(),
          token: text("token").notNull().unique(),
          expiresAt: tz("expires_at").notNull(),
          ipAddress: text("ip_address"),
          userAgent: text("user_agent"),
          assurance: text("assurance").notNull(),
          absoluteExpiresAt: tz("absolute_expires_at").notNull(),
          createdVia: text("created_via").notNull(),
          mailboxProvedAt: tz("mailbox_proved_at"),
          trustedBrowserId: text("trusted_browser_id"),
          stepUpFailures: smallint("step_up_failures").notNull(),
          currentOrganizationId: text("current_organization_id"),
          createdAt: tz("created_at").notNull(),
          updatedAt: tz("updated_at").notNull(),
        })
      : schema.table("session", {
          id: text("id").primaryKey(),
          userId: text("user_id").notNull(),
          token: text("token").notNull().unique(),
          expiresAt: tz("expires_at").notNull(),
          ipAddress: text("ip_address"),
          userAgent: text("user_agent"),
          assurance: text("assurance").notNull(),
          absoluteExpiresAt: tz("absolute_expires_at").notNull(),
          createdVia: text("created_via").notNull(),
          accessSub: text("access_sub").notNull(),
          enrolmentOpenUntil: tz("enrolment_open_until"),
          stepUpFailures: smallint("step_up_failures").notNull(),
          createdAt: tz("created_at").notNull(),
          updatedAt: tz("updated_at").notNull(),
        });

  const account = schema.table("account", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: tz("access_token_expires_at"),
    refreshTokenExpiresAt: tz("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  });

  const verification = schema.table("verification", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tz("expires_at").notNull(),
    createdAt: tz("created_at").notNull(),
    updatedAt: tz("updated_at").notNull(),
  });

  const passkey = schema.table("passkey", {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("public_key").notNull(),
    userId: text("user_id").notNull(),
    credentialID: text("credential_id").notNull().unique(),
    counter: integer("counter").notNull(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull(),
    transports: text("transports"),
    aaguid: text("aaguid"),
    createdAt: tz("created_at"),
  });

  const twoFactor = schema.table("two_factor", {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id").notNull().unique(),
    verified: boolean("verified").notNull(),
    failedVerificationCount: integer("failed_verification_count").notNull(),
    lockedUntil: tz("locked_until"),
  });

  return { user, session, account, verification, passkey, twoFactor };
}

const developer = realmTables("identity", "user");
const staffRealm = realmTables("staff", "member");

/** The adapter's schema object for the developer realm, keyed by the library's model names. */
export const developerSchema = {
  user: developer.user,
  session: developer.session,
  account: developer.account,
  verification: developer.verification,
  passkey: developer.passkey,
  twoFactor: developer.twoFactor,
};

/** The staff realm's, with the user model named `member` (S2-23). */
export const staffSchema = {
  member: staffRealm.user,
  session: staffRealm.session,
  account: staffRealm.account,
  verification: staffRealm.verification,
  passkey: staffRealm.passkey,
  twoFactor: staffRealm.twoFactor,
};
