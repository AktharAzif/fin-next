// A small reader for fin-motion.css, for the tests: each style rule with the at-rule it sits in,
// its selector and its declarations. Enough for this file (style rules at the top level or one
// @media deep, @keyframes skipped); not a general CSS parser.

export type Rule = { context: string; selector: string; declarations: Map<string, string> };

const squash = (text: string) =>
  text.replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();

/** Every style rule outside @keyframes, with its enclosing @media prelude ("" at the top level). */
export function readRules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const walk = (body: string, context: string) => {
    let i = 0;
    while (i < body.length) {
      const open = body.indexOf("{", i);
      if (open === -1) break;
      const prelude = squash(body.slice(i, open));
      let depth = 1;
      let j = open + 1;
      for (; j < body.length && depth > 0; j++) {
        if (body[j] === "{") depth++;
        else if (body[j] === "}") depth--;
      }
      const inner = body.slice(open + 1, j - 1);
      if (prelude.startsWith("@media")) walk(inner, prelude);
      else if (!prelude.startsWith("@keyframes")) {
        rules.push({ context, selector: prelude, declarations: readDeclarations(inner) });
      }
      i = j;
    }
  };
  walk(text, "");
  return rules;
}

/** A rule body's declarations, in order; a property declared twice in one rule throws. */
export function readDeclarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const name = part.slice(0, colon).trim();
    if (name === "") continue;
    if (out.has(name)) throw new Error(`${name} is declared twice in one rule`);
    out.set(name, squash(part.slice(colon + 1)));
  }
  return out;
}

/** The glyph names (`fin-ico--<Name>`, never the `fin-ico--duo` modifier) a selector names. */
export function glyphsOf(selector: string): string[] {
  return [...selector.matchAll(/\.fin-ico--([A-Z][A-Za-z]*)(?![\w-])/g)].map((m) => m[1] ?? "");
}
