// The api image's one runtime entry (ARCHITECTURE §3.2): Vite's SSR build bundles this file into
// dist/server/main.js, which the image runs as dist/main.js (with `--worker`, `--migrate` or
// `--task <name>` from Railway's start command).
import { main } from "./main.ts";

void main(process.argv.slice(2));
