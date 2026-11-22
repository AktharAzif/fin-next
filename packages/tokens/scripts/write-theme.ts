// Writes theme.css: reads tokens.css on standard input and prints what scripts/theme.ts builds
// from it. `pnpm --filter @fin/tokens theme` runs it; it needs nothing but Node.
import { buildTheme } from "./theme.ts";

declare const process: {
  stdin: AsyncIterable<Uint8Array>;
  stdout: { write(text: string): boolean };
};

const decoder = new TextDecoder();
let tokens = "";
for await (const chunk of process.stdin) tokens += decoder.decode(chunk, { stream: true });
tokens += decoder.decode();
process.stdout.write(buildTheme(tokens));
