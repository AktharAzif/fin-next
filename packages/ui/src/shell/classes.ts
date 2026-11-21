// Joins class names, dropping the empty ones. The shell's own small helper; screens use @fin/ui's `cn`.
export function classes(...names: (string | false | null | undefined)[]): string {
  return names.filter((name): name is string => typeof name === "string" && name !== "").join(" ");
}
