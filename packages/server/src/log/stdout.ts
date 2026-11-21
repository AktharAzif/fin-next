// The one place a Fin process writes to standard output (biome allows the console only under
// packages/server/src/log/). Every line reaching here has already been scrubbed and capped.

export type StdoutWriter = (line: string) => void;

/** Writes one line to stdout. Railway keeps it as its copy; Better Stack gets the shipped one. */
export const writeStdout: StdoutWriter = (line) => {
  process.stdout.write(`${line}\n`);
};
