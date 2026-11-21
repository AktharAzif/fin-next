// Small readers for Fin's own CSS files, for the token tests: rules with their at-rule context,
// declarations, and value normalisation. Enough for tokens.css; not a general CSS parser.

export type Rule = { context: string; selector: string; declarations: Map<string, string> };

/** Strips comments, keeping line structure irrelevant. */
export function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Every style rule with its enclosing at-rule (`@media (...)`, or "" at the top level). */
export function readRules(css: string): Rule[] {
  const text = stripComments(css);
  const rules: Rule[] = [];
  const walk = (body: string, context: string) => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf("{", i);
      if (open === -1) break;
      const prelude = body.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      for (; j < body.length && depth > 0; j++) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}") depth--;
      }
      const inner = body.slice(open + 1, j - 1);
      if (prelude.startsWith("@media") || prelude.startsWith("@supports")) {
        walk(inner, prelude.replace(/\s+/g, " "));
      } else {
        rules.push({
          context,
          selector: prelude.replace(/\s+/g, " "),
          declarations: readDeclarations(inner),
        });
      }
      i = j;
    }
  };
  walk(text, "");
  return rules;
}

/** The custom properties a rule body declares, in order; a repeated name throws. */
export function readDeclarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const name = part.slice(0, colon).trim();
    if (!name.startsWith("--")) continue;
    if (out.has(name)) throw new Error(`${name} is declared twice in one rule`);
    out.set(name, part.slice(colon + 1).trim());
  }
  return out;
}

/** One spelling for equal values: lower case, single spaces, leading zeros, durations in ms. */
export function normalise(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/(^|[\s(,-])\.(\d)/g, "$10.$2")
    .replace(/\b(\d+(?:\.\d+)?)s\b/g, (_m, n: string) => `${Math.round(Number(n) * 1000)}ms`)
    .toLowerCase();
}

/** A Tailwind `@utility` block: its own declarations, and each nested block's (`@media ...`, `&...`). */
export type Utility = {
  name: string;
  declarations: Map<string, string>;
  nested: { prelude: string; declarations: Map<string, string> }[];
};

/** The index just past the `}` that closes the block whose `{` is at `open`. */
function closing(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i + 1;
  }
  throw new Error("a block is not closed");
}

/** Every `@utility` in a stylesheet, by name; one level of nested blocks is read. */
export function readUtilities(css: string): Map<string, Utility> {
  const text = stripComments(css);
  const out = new Map<string, Utility>();
  for (const match of text.matchAll(/@utility\s+([\w-]+)\s*\{/g)) {
    const name = match[1] ?? "";
    const open = (match.index ?? 0) + match[0].length - 1;
    const body = text.slice(open + 1, closing(text, open) - 1);
    let own = "";
    const nested: Utility["nested"] = [];
    let from = 0;
    for (let i = body.indexOf("{"); i !== -1; i = body.indexOf("{", from)) {
      const before = body.slice(from, i);
      const cut = before.lastIndexOf(";") + 1;
      own += before.slice(0, cut);
      const end = closing(body, i);
      nested.push({
        prelude: before.slice(cut).replace(/\s+/g, " ").trim(),
        declarations: readAllDeclarations(body.slice(i + 1, end - 1)),
      });
      from = end;
    }
    own += body.slice(from);
    if (out.has(name)) throw new Error(`@utility ${name} is defined twice`);
    out.set(name, { name, declarations: readAllDeclarations(own), nested });
  }
  return out;
}

/** Every declaration of a rule body with no nested blocks, custom properties or not. */
export function readAllDeclarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const name = part.slice(0, colon).trim();
    if (name === "") continue;
    if (out.has(name)) throw new Error(`${name} is declared twice in one rule`);
    out.set(
      name,
      part
        .slice(colon + 1)
        .replace(/\s+/g, " ")
        .trim(),
    );
  }
  return out;
}

/** The rule whose selector and context match exactly; throws when there is not exactly one. */
export function findRule(rules: Rule[], selector: string, context = ""): Rule {
  const found = rules.filter((r) => r.selector === selector && r.context === context);
  if (found.length !== 1) {
    throw new Error(`expected one rule "${selector}" in "${context}", found ${found.length}`);
  }
  const [rule] = found;
  if (rule === undefined) throw new Error("unreachable");
  return rule;
}
