// A stand-in for the GitHub Actions runner's reading of a step's output, for the tests: it knows
// only the commands that matter here, `add-mask` and `stop-commands`, in the runner's two forms (a
// line whose first non-blank characters are `::`, and the older `##[` form), and masks every
// registered value wherever it appears in a later line, as the runner does (inside words too).

export interface JobLog {
  /** The values registered with add-mask, unescaped. */
  masks: string[];
  /** Whether a stop-commands ever took effect. */
  stopped: boolean;
  /** The job log as a reader sees it: plain lines, masked. */
  text: string;
}

function unescapeData(data: string): string {
  return data.replace(/%0A/gi, "\n").replace(/%0D/gi, "\r").replace(/%25/g, "%");
}

/** What the runner would show for this output (both streams, in order). */
export function jobLog(output: string): JobLog {
  const masks: string[] = [];
  const shown: string[] = [];
  let resumeToken: string | undefined;
  let stopped = false;
  const plain = (line: string) => {
    let text = line;
    for (const value of masks) if (value !== "") text = text.split(value).join("***");
    shown.push(text);
  };
  for (const line of output.split("\n")) {
    if (resumeToken !== undefined) {
      if (line.trim() === `::${resumeToken}::`) resumeToken = undefined;
      else plain(line);
      continue;
    }
    const v2 = /^::([A-Za-z-]+)(?: [^:]*)?::(.*)$/.exec(line.trimStart());
    const legacyAt = line.indexOf("##[");
    const legacy =
      legacyAt < 0 ? null : /^##\[([A-Za-z-]+)[^\]]*\](.*)$/.exec(line.slice(legacyAt));
    const command = v2 ?? legacy;
    if (command?.[1] === "add-mask") masks.push(unescapeData(command[2] ?? ""));
    else if (command?.[1] === "stop-commands") {
      resumeToken = command[2] ?? "";
      stopped = true;
    } else plain(line);
  }
  return { masks, stopped, text: shown.join("\n") };
}
