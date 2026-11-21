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
