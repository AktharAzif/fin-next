// Builds the template database once before the integration tests' workers start.
import { ensureTemplate, testDatabaseUrl } from "./db.ts";

export default async function setup(): Promise<void> {
  if (testDatabaseUrl() === null) {
    throw new Error("the integration tests need FIN_TEST_DATABASE_URL (a Postgres 18 server)");
  }
  await ensureTemplate();
}
