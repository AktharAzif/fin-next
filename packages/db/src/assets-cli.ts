// The database files' command line (assets.ts), run with Node from the repository and never bundled:
//   node packages/db/src/assets-cli.ts stage <dir>   the image build: copies every package's bootstrap,
//                                                    migrations and grants to <dir>, keeping their
//                                                    paths, and checks the copy yields the same set
//   node packages/db/src/assets-cli.ts migrations    the release manifest: prints one JSON line,
//                                                    {"migrations":[names in order],"minimumSchemaVersion":newest}
// Exit 0 on success; 64 on a usage error; 1 when the files break the rule (a duplicate name, a root
// with none of a kind), naming the file only.
import { isAbsolute } from "node:path";
import { listMigrations, sourceRoot, stageDbAssets } from "./assets.ts";
import { MigrationError } from "./errors.ts";

function fail(code: number, text: string): never {
  process.stderr.write(`db-assets: ${text}\n`);
  process.exit(code);
}

const [command, target, ...rest] = process.argv.slice(2);
const root = sourceRoot();
if (root === null) fail(1, "not run from the source tree");
try {
  if (command === "stage" && target !== undefined && isAbsolute(target) && rest.length === 0) {
    const staged = stageDbAssets(root, target);
    process.stdout.write(
      `db-assets: staged bootstrap=${staged.bootstrap.length} migrations=${staged.migrations.length} grants=${staged.grants.length}\n`,
    );
  } else if (command === "migrations" && target === undefined) {
    const migrations = listMigrations(root);
    process.stdout.write(
      `${JSON.stringify({ migrations, minimumSchemaVersion: migrations.at(-1) ?? null })}\n`,
    );
  } else {
    fail(64, "usage: assets-cli.ts stage <absolute dir> | migrations");
  }
} catch (error) {
  if (error instanceof MigrationError) fail(1, `${error.code}: ${error.message}`);
  throw error;
}
