// The engine's own checker for the subset of JSON Schema its schemas use (spec 07 §2.8 rule 1; no
// schema library): type, enum, const, pattern, minLength and maxLength (in code points), minimum and
// maximum, minItems and maxItems, required, properties, additionalProperties (false or a schema)
// and items. A schema that uses any other keyword is refused when it is compiled, so a keyword is
// never silently ignored.

export interface SchemaError {
  /** A JSON Pointer to the offending value ("" for the root). */
  readonly path: string;
  readonly message: string;
}

const TYPES = ["object", "array", "string", "integer", "number", "boolean", "null"] as const;
type TypeName = (typeof TYPES)[number];

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description"]);
const KEYWORDS = new Set([
  "type",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "required",
  "properties",
  "additionalProperties",
  "items",
]);

interface Compiled {
  readonly types: readonly TypeName[] | null;
  readonly enumValues: readonly unknown[] | null;
  readonly constValue: { value: unknown } | null;
  readonly pattern: RegExp | null;
  readonly minLength: number | null;
  readonly maxLength: number | null;
  readonly minimum: number | null;
  readonly maximum: number | null;
  readonly minItems: number | null;
  readonly maxItems: number | null;
  readonly required: readonly string[];
  readonly properties: ReadonlyMap<string, Compiled>;
  /** true: any extra property; false: none; a schema: each extra property's schema. */
  readonly additional: boolean | Compiled;
  readonly items: Compiled | null;
}

export class SchemaDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaDefinitionError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new SchemaDefinitionError(`${where} must be a non-negative integer`);
  }
  return value;
}

function compile(schema: unknown, where: string): Compiled {
  if (!isPlainObject(schema)) throw new SchemaDefinitionError(`${where} must be an object`);
  for (const key of Object.keys(schema)) {
    if (!KEYWORDS.has(key) && !ANNOTATIONS.has(key)) throw new SchemaDefinitionError(`${where} uses unsupported keyword ${JSON.stringify(key)}`);
  }
  let types: TypeName[] | null = null;
  if (Object.hasOwn(schema, "type")) {
    const raw = schema["type"];
    const list = Array.isArray(raw) ? raw : [raw];
    if (list.length === 0) throw new SchemaDefinitionError(`${where}.type is empty`);
    types = [];
    for (const item of list) {
      if (typeof item !== "string" || !(TYPES as readonly string[]).includes(item)) {
        throw new SchemaDefinitionError(`${where}.type holds ${JSON.stringify(item)}`);
      }
      types.push(item as TypeName);
    }
  }
  let enumValues: unknown[] | null = null;
  if (Object.hasOwn(schema, "enum")) {
    const raw = schema["enum"];
    if (!Array.isArray(raw) || raw.length === 0) throw new SchemaDefinitionError(`${where}.enum must be a non-empty array`);
    enumValues = [...raw];
  }
  const constValue = Object.hasOwn(schema, "const") ? { value: schema["const"] } : null;
  let pattern: RegExp | null = null;
  if (Object.hasOwn(schema, "pattern")) {
    const raw = schema["pattern"];
    if (typeof raw !== "string") throw new SchemaDefinitionError(`${where}.pattern must be a string`);
    try {
      pattern = new RegExp(raw, "u");
    } catch {
      throw new SchemaDefinitionError(`${where}.pattern is not a valid regular expression`);
    }
  }
  const num = (key: string): number | null => {
    if (!Object.hasOwn(schema, key)) return null;
    const raw = schema[key];
    if (typeof raw !== "number" || !Number.isFinite(raw)) throw new SchemaDefinitionError(`${where}.${key} must be a number`);
    return raw;
  };
  const count = (key: string): number | null => (Object.hasOwn(schema, key) ? nonNegativeInteger(schema[key], `${where}.${key}`) : null);
  const required: string[] = [];
  if (Object.hasOwn(schema, "required")) {
    const raw = schema["required"];
    if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
      throw new SchemaDefinitionError(`${where}.required must be an array of strings`);
    }
    required.push(...(raw as string[]));
  }
  const properties = new Map<string, Compiled>();
  if (Object.hasOwn(schema, "properties")) {
    const raw = schema["properties"];
    if (!isPlainObject(raw)) throw new SchemaDefinitionError(`${where}.properties must be an object`);
    for (const [name, sub] of Object.entries(raw)) properties.set(name, compile(sub, `${where}.properties.${name}`));
  }
  let additional: boolean | Compiled = true;
  if (Object.hasOwn(schema, "additionalProperties")) {
    const raw = schema["additionalProperties"];
    additional = typeof raw === "boolean" ? raw : compile(raw, `${where}.additionalProperties`);
  }
  const items = Object.hasOwn(schema, "items") ? compile(schema["items"], `${where}.items`) : null;
  return {
    types,
    enumValues,
    constValue,
    pattern,
    minLength: count("minLength"),
    maxLength: count("maxLength"),
    minimum: num("minimum"),
    maximum: num("maximum"),
    minItems: count("minItems"),
    maxItems: count("maxItems"),
    required,
    properties,
    additional,
    items,
  };
}

/** Deep equality of JSON values, for enum and const. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
  }
  return false;
}

function typeOf(value: unknown): TypeName | "other" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isFinite(value) ? (Number.isInteger(value) ? "integer" : "number") : "other";
  if (isPlainObject(value)) return "object";
  return "other";
}

function pointer(base: string, key: string | number): string {
  return `${base}/${String(key).replace(/~/g, "~0").replace(/\//g, "~1")}`;
}

const MAX_ERRORS = 50;

function check(node: Compiled, value: unknown, path: string, errors: SchemaError[]): void {
  if (errors.length >= MAX_ERRORS) return;
  const actual = typeOf(value);
  if (node.types !== null) {
    const ok = node.types.some((type) => type === actual || (type === "number" && actual === "integer"));
    if (!ok) {
      errors.push({ path, message: `must be ${node.types.join(" or ")}, not ${actual}` });
      return;
    }
  }
  if (node.enumValues !== null && !node.enumValues.some((item) => jsonEqual(item, value))) {
    errors.push({ path, message: "is not one of the allowed values" });
  }
  if (node.constValue !== null && !jsonEqual(node.constValue.value, value)) errors.push({ path, message: "is not the required value" });
  if (typeof value === "string") {
    const length = [...value].length;
    if (node.minLength !== null && length < node.minLength) errors.push({ path, message: `is shorter than ${node.minLength} characters` });
    if (node.maxLength !== null && length > node.maxLength) errors.push({ path, message: `is longer than ${node.maxLength} characters` });
    if (node.pattern !== null && !node.pattern.test(value)) errors.push({ path, message: "does not match the pattern" });
  }
  if (typeof value === "number") {
    if (node.minimum !== null && value < node.minimum) errors.push({ path, message: `is below ${node.minimum}` });
    if (node.maximum !== null && value > node.maximum) errors.push({ path, message: `is above ${node.maximum}` });
  }
  if (Array.isArray(value)) {
    if (node.minItems !== null && value.length < node.minItems) errors.push({ path, message: `has fewer than ${node.minItems} items` });
    if (node.maxItems !== null && value.length > node.maxItems) errors.push({ path, message: `has more than ${node.maxItems} items` });
    if (node.items !== null) value.forEach((item, index) => check(node.items as Compiled, item, pointer(path, index), errors));
  }
  if (isPlainObject(value)) {
    for (const name of node.required) {
      if (!Object.hasOwn(value, name)) errors.push({ path, message: `is missing ${JSON.stringify(name)}` });
    }
    for (const [name, item] of Object.entries(value)) {
      const sub = node.properties.get(name);
      if (sub !== undefined) check(sub, item, pointer(path, name), errors);
      else if (node.additional === false) errors.push({ path: pointer(path, name), message: "is not allowed" });
      else if (node.additional !== true) check(node.additional, item, pointer(path, name), errors);
    }
  }
}

export interface Validator {
  (value: unknown): SchemaError[];
}

/** Compiles `schema`; throws SchemaDefinitionError for a schema outside the supported subset. */
export function compileSchema(schema: unknown): Validator {
  const root = compile(schema, "$");
  return (value: unknown): SchemaError[] => {
    const errors: SchemaError[] = [];
    check(root, value, "", errors);
    return errors;
  };
}

/** One line naming the first few errors. */
export function describeErrors(errors: readonly SchemaError[], max = 3): string {
  const shown = errors.slice(0, max).map((error) => `${error.path === "" ? "(root)" : error.path} ${error.message}`);
  const more = errors.length > max ? ` (and ${errors.length - max} more)` : "";
  return `${shown.join("; ")}${more}`;
}
