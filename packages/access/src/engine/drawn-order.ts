// The order a name's characters are drawn in, for the role editor's reading of a name
// (src/engine/role-editor.ts). Inside Latin text a run of letters of a script written right to
// left (Hebrew, Arabic, N'Ko and others) is drawn right to left, and so are the Arabic-Indic digits
// beside them, so two such characters that read as Latin letters are seen in the opposite order
// from the one they are stored in. `drawnOrder` puts a text's characters in the order they are
// drawn, by Unicode's bidirectional algorithm (UAX #9) for a single line with no explicit
// embeddings or isolates: their controls draw as nothing, which the role editor refuses and its
// reading removes, so here they are passed over as rule X9 passes over the boundary neutrals.
// Every other rule a line of plain text takes applies: the weak types W1 to W7, the paired brackets
// N0, the neutrals N1 and N2, the levels I1 and I2, the white space at the end of a line L1 and the
// reversal L2; and a mark is kept after the character it is drawn on.
//
// BIDI_CLASS_RANGES lists the code points of each Bidi_Class but L, the default
// (DerivedBidiClass.txt 18.0.0, with its defaults for the unassigned code points), and
// BRACKET_PAIRS each opening paired bracket and its closing one (BidiBrackets.txt 18.0.0).
// src/engine/drawn-order.test.ts holds the algorithm to Unicode's conformance tests, in the subset
// committed as src/test-support/bidi-cases.ts. The data is derived from Unicode's data files under
// the Unicode License v3, whose notice src/engine/unicode-look-alikes.ts carries.

const BIDI_VERSION = "18.0.0";

const BIDI_CLASS_RANGES = Object.freeze({
  R: Object.freeze([
    "590 5be 5c0 5c3 5c6 5ca-5ff 7c0-7ea 7f4-7f5 7fa-7fc 7fe-815 81a 824 828 82e-858 85c-85f 200f",
    "fb1d fb1f-fb28 fb2a-fb4f 10800-1091e 10920-10a00 10a04 10a07-10a0b 10a10-10a37 10a3b-10a3e",
    "10a40-10ae4 10ae7-10b38 10b40-10cff 10d4a-10d68 10d6f-10e5f 10e7f-10eaa 10ead-10ebf",
    "10f00-10f2f 10f70-10f81 10f86-10fff 1e800-1e8cf 1e8d7-1e943 1e94b-1ec6f 1ecc0-1ecff",
    "1ed50-1edff 1ef00-1efff",
  ]),
  AL: Object.freeze([
    "608 60b 60d 61b-64a 66d-66f 671-6d5 6e5-6e6 6ee-6ef 6fa-710 712-72f 74b-7a5 7b1-7bf 860-88f",
    "892-896 8a0-8c9 fb50-fbc2 fbd3-fd3d fd50-fd8f fd92-fdc7 fdf0-fdfc fe70-fefe 10d00-10d23",
    "10d28-10d2f 10d3a-10d3f 10ec0-10eca 10ed9-10eef 10f30-10f45 10f51-10f6f 1ec70-1ecbf",
    "1ed00-1ed4f 1ee00-1eeef 1eef2-1eeff",
  ]),
  EN: Object.freeze([
    "30-39 b2-b3 b9 6f0-6f9 2070 2074-2079 2080-2089 2488-249b ff10-ff19 102e1-102fb 1ccf0-1ccf9",
    "1d7ce-1d7ff 1f100-1f10a 1fbf0-1fbf9",
  ]),
  ES: Object.freeze(["2b 2d 207a-207b 208a-208b 2212 fb29 fe62-fe63 ff0b ff0d"]),
  ET: Object.freeze([
    "23-25 a2-a5 b0-b1 58f 609-60a 66a 9f2-9f3 9fb af1 bf9 e3f 17db 2030-2034 20a0-20cf 212e 2213",
    "a838-a839 fe5f fe69-fe6a ff03-ff05 ffe0-ffe1 ffe5-ffe6 11fdd-11fe0 1e2ff",
  ]),
  AN: Object.freeze([
    "600-605 660-669 66b-66c 6dd 890-891 8e2 10d30-10d39 10d40-10d49 10e60-10e7e",
  ]),
  CS: Object.freeze(["2c 2e-2f 3a a0 60c 202f 2044 fe50 fe52 fe55 ff0c ff0e-ff0f ff1a"]),
  NSM: Object.freeze([
    "300-36f 483-489 591-5bd 5bf 5c1-5c2 5c4-5c5 5c7-5c9 610-61a 64b-65f 670 6d6-6dc 6df-6e4",
    "6e7-6e8 6ea-6ed 711 730-74a 7a6-7b0 7eb-7f3 7fd 816-819 81b-823 825-827 829-82d 859-85b",
    "897-89f 8ca-8e1 8e3-902 93a 93c 941-948 94d 951-957 962-963 981 9bc 9c1-9c4 9cd 9e2-9e3 9fe",
    "a01-a02 a3c a41-a42 a47-a48 a4b-a4d a51 a70-a71 a75 a81-a82 abc ac1-ac5 ac7-ac8 acd ae2-ae3",
    "afa-aff b01 b3c b3f b41-b44 b4d b53-b56 b62-b63 b82 bc0 bcd c00 c04 c3c c3e-c40 c46-c48",
    "c4a-c4d c55-c56 c62-c63 c81 cbc ccc-ccd ce2-ce3 d00-d01 d3b-d3c d41-d44 d4d d62-d63 d81 dca",
    "dd2-dd4 dd6 e31 e34-e3a e47-e4e eb1 eb4-ebc ec8-ece f18-f19 f35 f37 f39 f71-f7e f80-f84",
    "f86-f87 f8d-f97 f99-fbc fc6 102d-1030 1032-1037 1039-103a 103d-103e 1058-1059 105e-1060",
    "1071-1074 1082 1085-1086 108d 109d 135d-135f 1712-1714 1732-1733 1752-1753 1772-1773",
    "17b4-17b5 17b7-17bd 17c6 17c9-17d3 17dd 180b-180d 180f 1885-1886 18a9 1920-1922 1927-1928",
    "1932 1939-193b 1a17-1a18 1a1b 1a56 1a58-1a5e 1a60 1a62 1a65-1a6c 1a73-1a7c 1a7f 1ab0-1af0",
    "1b00-1b03 1b34 1b36-1b39 1b6b-1b73 1b80-1b81 1ba2-1ba5 1ba8-1ba9 1bab-1bad 1be6 1be8-1be9",
    "1bed 1bef-1bf1 1c2c-1c33 1c36-1c37 1cd0-1cd2 1cd4-1ce0 1ce2-1ce8 1ced 1cf4 1cf8-1cf9",
    "1dc0-1dff 20d0-20f0 2cef-2cf1 2d7f 2de0-2dff 302a-302d 3099-309a a66f-a672 a674-a67d",
    "a69e-a69f a6f0-a6f1 a802 a806 a80b a825-a826 a82c a8c4-a8c5 a8e0-a8f1 a8ff a926-a92d",
    "a947-a951 a980-a982 a9b3 a9b6-a9b9 a9bc-a9bd a9e5 aa29-aa2e aa31-aa32 aa35-aa36 aa43 aa4c",
    "aa7c aab0 aab2-aab4 aab7-aab8 aabe-aabf aac1 aaec-aaed aaf6 abe5 abe8 abed fb1e fe00-fe0f",
    "fe20-fe2f 101fd 102e0 10376-1037a 10a01-10a03 10a05-10a06 10a0c-10a0f 10a38-10a3a 10a3f",
    "10ae5-10ae6 10d24-10d27 10d69-10d6d 10eab-10eac 10ecb-10ecf 10ef0-10eff 10f46-10f50",
    "10f82-10f85 11001 11038-11046 11070 11073-11074 1107f-11081 110b3-110b6 110b9-110ba 110c2",
    "11100-11102 11127-1112b 1112d-11134 11173 11180-11181 111b6-111be 111c9-111cc 111cf",
    "1122f-11231 11234 11236-11237 1123e 11241 112df 112e3-112ea 11300-11301 1133b-1133c 11340",
    "11366-1136c 11370-11374 113bb-113c0 113ce 113d0 113d2 113e1-113e2 11438-1143f 11442-11444",
    "11446 1145e 114b3-114b8 114ba 114bf-114c0 114c2-114c3 115b2-115b5 115bc-115bd 115bf-115c0",
    "115dc-115dd 11633-1163a 1163d 1163f-11640 116ab 116ad 116b0-116b5 116b7 1171d 1171f",
    "11722-11725 11727-1172b 1182f-11837 11839-1183a 1193b-1193c 1193e 11943 119d4-119d7",
    "119da-119db 119e0 11a01-11a06 11a09-11a0a 11a33-11a38 11a3b-11a3e 11a47 11a51-11a56",
    "11a59-11a5b 11a8a-11a96 11a98-11a99 11b60 11b62-11b64 11b66 11c30-11c36 11c38-11c3d",
    "11c92-11ca7 11caa-11cb0 11cb2-11cb3 11cb5-11cb6 11d31-11d36 11d3a 11d3c-11d3d 11d3f-11d45",
    "11d47 11d90-11d91 11d95 11d97 11df0 11ef3-11ef4 11f00-11f01 11f36-11f3a 11f40 11f42 11f5a",
    "13440 13447-13455 1611e-16129 1612d-1612f 16af0-16af4 16b30-16b36 16f4f 16f8f-16f92 16fe4",
    "1bc9d-1bc9e 1cf00-1cf2d 1cf30-1cf46 1d127-1d128 1d167-1d169 1d17b-1d182 1d185-1d18b",
    "1d1aa-1d1ad 1d242-1d244 1d25b-1d25c 1da00-1da36 1da3b-1da6c 1da75 1da84 1da9b-1da9f",
    "1daa1-1daaf 1e000-1e006 1e008-1e018 1e01b-1e021 1e023-1e024 1e026-1e02a 1e08f 1e130-1e136",
    "1e2ae 1e2ec-1e2ef 1e4ec-1e4ef 1e5ee-1e5ef 1e6e3 1e6e6 1e6ee-1e6ef 1e6f5 1e8d0-1e8d6",
    "1e944-1e94a e0100-e01ef",
  ]),
  BN: Object.freeze([
    "0-8 e-1b 7f-84 86-9f ad 180e 200b-200d 2060-2065 206a-206f fdd0-fdef feff fff0-fff8 fffe-ffff",
    "1bca0-1bca3 1d173-1d17a 1fffe-1ffff 2fffe-2ffff 3fffe-3ffff 4fffe-4ffff 5fffe-5ffff",
    "6fffe-6ffff 7fffe-7ffff 8fffe-8ffff 9fffe-9ffff afffe-affff bfffe-bffff cfffe-cffff",
    "dfffe-e00ff e01f0-e0fff efffe-effff ffffe-fffff 10fffe-10ffff",
  ]),
  B: Object.freeze(["a d 1c-1e 85 2029"]),
  S: Object.freeze(["9 b 1f"]),
  WS: Object.freeze(["c 20 1680 2000-200a 2028 205f 3000"]),
  ON: Object.freeze([
    "21-22 26-2a 3b-40 5b-60 7b-7e a1 a6-a9 ab-ac ae-af b4 b6-b8 bb-bf d7 f7 2b9-2ba 2c2-2cf",
    "2d2-2df 2e5-2ed 2ef-2ff 374-375 37e 384-385 387 3f6 58a 58d-58e 606-607 60e-60f 6de 6e9",
    "7f6-7f9 bf3-bf8 bfa c78-c7e f3a-f3d 1390-1399 1400 169b-169c 17f0-17f9 1800-180a 1940",
    "1944-1945 19de-19ff 1fbd 1fbf-1fc1 1fcd-1fcf 1fdd-1fdf 1fed-1fef 1ffd-1ffe 2010-2027",
    "2035-2043 2045-205e 207c-207e 208c-208f 2100-2101 2103-2106 2108-2109 2114 2116-2118",
    "211e-2123 2125 2127 2129 213a-213b 2140-2144 214a-214d 2150-215f 2189-218b 2190-2211",
    "2214-2335 237b-2394 2396-2429 2440-244a 2460-2487 24ea-26ab 26ad-27ff 2900-2b73 2b76-2bff",
    "2ce5-2cea 2cf9-2cff 2e00-2e5d 2e60-2e63 2e80-2e99 2e9b-2ef3 2f00-2fd5 2ff0-2fff 3001-3004",
    "3008-3020 3030 3036-3037 303d-303f 309b-309c 30a0 30fb 31c0-31e5 31ef 321d-321e 3250-325f",
    "327c-327e 32b1-32bf 32cc-32cf 3377-337a 33de-33df 33ff 4dc0-4dff a490-a4c6 a60d-a60f a673",
    "a67e-a67f a700-a721 a788 a828-a82b a874-a877 ab6a-ab6b fbc3-fbd2 fd3e-fd4f fd90-fd91",
    "fdc8-fdcf fdfd-fdff fe10-fe19 fe30-fe4f fe51 fe54 fe56-fe5e fe60-fe61 fe64-fe66 fe68 fe6b",
    "ff01-ff02 ff06-ff0a ff1b-ff20 ff3b-ff40 ff5b-ff65 ffe2-ffe4 ffe8-ffee fff9-fffd 10101",
    "10140-1018c 10190-1019c 101a0 1091f 10b39-10b3f 10d6e 10ed0-10ed8 11052-11065 11660-1166c",
    "11fd5-11fdc 11fe1-11ff1 16fe2 1cc00-1ccd5 1ccfa-1ccfc 1cd00-1ceb3 1ceba-1ced0 1ced2-1ced4",
    "1cedd-1cefd 1d1e9-1d1ea 1d200-1d241 1d245 1d300-1d356 1d6c1 1d6db 1d6fb 1d715 1d735 1d74f",
    "1d76f 1d789 1d7a9 1d7c3 1db00-1db1c 1eef0-1eef1 1f000-1f02b 1f030-1f093 1f0a0-1f0ae",
    "1f0b1-1f0bf 1f0c1-1f0cf 1f0d1-1f0f5 1f10b-1f10f 1f12f 1f16a-1f16f 1f1ad 1f260-1f265",
    "1f300-1f6d9 1f6dc-1f6ec 1f6f0-1f6fc 1f700-1f7d9 1f7db 1f7e0-1f7eb 1f7f0-1f80b 1f810-1f847",
    "1f850-1f859 1f860-1f887 1f890-1f8ad 1f8b0-1f8bb 1f8c0-1f8c1 1f8d0-1f8d8 1f900-1fa57",
    "1fa60-1fa6d 1fa70-1fa7c 1fa80-1fac6 1fac8 1facc-1fadd 1fadf-1faeb 1faef-1fafa 1fb00-1fb92",
    "1fb94-1fbef 1fbfa",
  ]),
  LRE: Object.freeze(["202a"]),
  LRO: Object.freeze(["202d"]),
  RLE: Object.freeze(["202b"]),
  RLO: Object.freeze(["202e"]),
  PDF: Object.freeze(["202c"]),
  LRI: Object.freeze(["2066"]),
  RLI: Object.freeze(["2067"]),
  FSI: Object.freeze(["2068"]),
  PDI: Object.freeze(["2069"]),
});

const BRACKET_PAIRS: readonly string[] = Object.freeze([
  "28/29 5b/5d 7b/7d f3a/f3b f3c/f3d 169b/169c 2045/2046 207d/207e 208d/208e 2308/2309 230a/230b",
  "2329/232a 2768/2769 276a/276b 276c/276d 276e/276f 2770/2771 2772/2773 2774/2775 27c5/27c6",
  "27e6/27e7 27e8/27e9 27ea/27eb 27ec/27ed 27ee/27ef 2983/2984 2985/2986 2987/2988 2989/298a",
  "298b/298c 298d/2990 298f/298e 2991/2992 2993/2994 2995/2996 2997/2998 29d8/29d9 29da/29db",
  "29fc/29fd 2e22/2e23 2e24/2e25 2e26/2e27 2e28/2e29 2e55/2e56 2e57/2e58 2e59/2e5a 2e5b/2e5c",
  "2e62/2e63 3008/3009 300a/300b 300c/300d 300e/300f 3010/3011 3014/3015 3016/3017 3018/3019",
  "301a/301b fe59/fe5a fe5b/fe5c fe5d/fe5e ff08/ff09 ff3b/ff3d ff5b/ff5d ff5f/ff60 ff62/ff63",
]);

export { BIDI_CLASS_RANGES, BIDI_VERSION, BRACKET_PAIRS };

/** A character's Bidi_Class (UAX #9, table 4). */
export type BidiClass = keyof typeof BIDI_CLASS_RANGES | "L";
/** The direction of a line. */
export type Direction = "ltr" | "rtl";

const fromHex = (hex: string) => String.fromCodePoint(Number.parseInt(hex, 16));

// Every range of every class but L, ordered by its first code point, for a binary search.
const CLASS_TABLE: readonly (readonly [number, number, BidiClass])[] = Object.entries(
  BIDI_CLASS_RANGES,
)
  .flatMap(([type, rows]) =>
    rows
      .join(" ")
      .split(" ")
      .map((item) => {
        const [from = "", to = from] = item.split("-");
        return [Number.parseInt(from, 16), Number.parseInt(to, 16), type as BidiClass] as const;
      }),
  )
  .sort((a, b) => a[0] - b[0]);

/** A character's Bidi_Class: L unless the data lists another. */
export function bidiClassOf(char: string): BidiClass {
  const cp = char.codePointAt(0) ?? 0;
  let low = 0;
  let high = CLASS_TABLE.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const [from, to, type] = CLASS_TABLE[middle] ?? [0, -1, "L"];
    if (cp < from) high = middle - 1;
    else if (cp > to) low = middle + 1;
    else return type;
  }
  return "L";
}

/**
 * A paired bracket: whether it opens a pair, and the closing bracket of its pair, in its canonical
 * form (rule BD16 compares brackets canonically: U+2329 pairs with U+3009 as U+3008 does).
 */
interface Bracket {
  readonly opens: boolean;
  readonly closer: string;
}

const BRACKETS: ReadonlyMap<string, Bracket> = new Map(
  BRACKET_PAIRS.join(" ")
    .split(" ")
    .flatMap((item): (readonly [string, Bracket])[] => {
      const [open = "", close = ""] = item.split("/").map((hex) => fromHex(hex).normalize("NFD"));
      return [
        [open, { opens: true, closer: close }],
        [close, { opens: false, closer: close }],
      ];
    }),
);

/** The paired bracket a character is, if it is one. */
const bracketOf = (char: string): Bracket | undefined => BRACKETS.get(char.normalize("NFD"));

// Rule BD16 keeps at most 63 opening brackets open; at the 64th it stops looking for pairs.
const OPEN_BRACKET_LIMIT = 63;

/**
 * The paired brackets of a line (rule BD16): each pair's opening and closing index, in the order of
 * the opening ones. Only a bracket whose type is still ON pairs.
 */
function bracketPairs(
  types: readonly BidiClass[],
  brackets: readonly (Bracket | undefined)[],
): (readonly [number, number])[] {
  const pairs: (readonly [number, number])[] = [];
  const open: { readonly closer: string; readonly at: number }[] = [];
  for (const [at, bracket] of brackets.entries()) {
    if (bracket === undefined || types[at] !== "ON") continue;
    if (bracket.opens) {
      if (open.length === OPEN_BRACKET_LIMIT) break;
      open.push({ closer: bracket.closer, at });
      continue;
    }
    const match = open.findLastIndex((entry) => entry.closer === bracket.closer);
    if (match >= 0) {
      pairs.push([open[match]?.at ?? 0, at]);
      open.length = match;
    }
  }
  return pairs.sort((a, b) => a[0] - b[0]);
}

/** The direction a resolved type counts as in rules N0 to N2: a number counts as right to left. */
function directionOf(type: BidiClass | undefined): "L" | "R" | null {
  if (type === "L") return "L";
  return type === "R" || type === "EN" || type === "AN" ? "R" : null;
}

const isNeutral = (type: BidiClass | undefined) =>
  type === "ON" || type === "WS" || type === "S" || type === "B";

/**
 * The level of each character of a line on its own, with no explicit formatting characters or
 * boundary neutrals, from its types and paired brackets, at `paragraph` level (0 for a
 * left-to-right line, 1 for a right-to-left one): rules W1 to W7, N0 to N2, I1, I2 and L1.
 */
function resolveLevels(
  original: readonly BidiClass[],
  brackets: readonly (Bracket | undefined)[],
  paragraph: 0 | 1,
): number[] {
  // The embedding direction, which is also the type before the line (sos) and after it (eos).
  const embedding = paragraph === 0 ? "L" : "R";
  const types = [...original];
  const n = types.length;
  // W1: a mark takes the type of the character before it.
  for (let i = 0; i < n; i++) if (types[i] === "NSM") types[i] = types[i - 1] ?? embedding;
  // W2: a European digit after an Arabic letter is an Arabic number. W3: an Arabic letter is R.
  let strong: BidiClass = embedding;
  for (let i = 0; i < n; i++) {
    const type = types[i];
    if (type === "L" || type === "R" || type === "AL") strong = type;
    else if (type === "EN" && strong === "AL") types[i] = "AN";
  }
  for (let i = 0; i < n; i++) if (types[i] === "AL") types[i] = "R";
  // W4: one separator between two numbers of one type joins them.
  for (let i = 1; i < n - 1; i++) {
    const before = types[i - 1];
    if (types[i] === "ES" && before === "EN" && types[i + 1] === "EN") types[i] = "EN";
    else if (types[i] === "CS" && (before === "EN" || before === "AN") && types[i + 1] === before) {
      types[i] = before;
    }
  }
  // W5: terminators beside a European number belong to it.
  for (let i = 0; i < n; i++) {
    if (types[i] !== "ET") continue;
    let end = i;
    while (types[end] === "ET") end++;
    if (types[i - 1] === "EN" || types[end] === "EN") types.fill("EN", i, end);
    i = end;
  }
  // W6: every other separator and terminator is neutral.
  for (let i = 0; i < n; i++) {
    if (types[i] === "ES" || types[i] === "ET" || types[i] === "CS") types[i] = "ON";
  }
  // W7: a European number after left-to-right text is left to right.
  strong = embedding;
  for (let i = 0; i < n; i++) {
    const type = types[i];
    if (type === "L" || type === "R") strong = type;
    else if (type === "EN" && strong === "L") types[i] = "L";
  }
  // N0: a pair of brackets takes the embedding direction when the text inside it has that
  // direction, and when only the opposite one, the direction of the text before it.
  for (const [open, close] of bracketPairs(types, brackets)) {
    let inside: "L" | "R" | null = null;
    for (let i = open + 1; i < close && inside !== embedding; i++) {
      inside = directionOf(types[i]) ?? inside;
    }
    if (inside === null) continue;
    let before: "L" | "R" = embedding;
    for (let i = open - 1; i >= 0; i--) {
      const direction = directionOf(types[i]);
      if (direction !== null) {
        before = direction;
        break;
      }
    }
    const resolved = inside === embedding ? embedding : before;
    for (const at of [open, close]) {
      types[at] = resolved;
      for (let i = at + 1; i < n && original[i] === "NSM"; i++) types[i] = resolved;
    }
  }
  // N1 and N2: a run of neutrals takes the direction of the text on both sides when they agree,
  // and the embedding direction otherwise.
  for (let i = 0; i < n; i++) {
    if (!isNeutral(types[i])) continue;
    let end = i;
    while (isNeutral(types[end])) end++;
    const before = directionOf(types[i - 1]) ?? embedding;
    const after = directionOf(types[end]) ?? embedding;
    types.fill(before === after ? before : embedding, i, end);
    i = end;
  }
  // I1 and I2.
  const levels = types.map((type) => {
    if (type === "R") return 1;
    return type === "L" && paragraph === 0 ? 0 : 2;
  });
  // L1: segment separators, and white space before one or at the end of the line, take the
  // line's level.
  let trailing = true;
  for (let i = n - 1; i >= 0; i--) {
    const type = original[i];
    if (type === "S" || type === "B") {
      levels[i] = paragraph;
      trailing = true;
    } else if (type === "WS" && trailing) {
      levels[i] = paragraph;
    } else {
      trailing = false;
    }
  }
  return levels;
}

// Characters passed over (rule X9): the boundary neutrals and the explicit formatting characters,
// the isolates included, which the role editor never reads (see above).
const PASSED_OVER: ReadonlySet<BidiClass> = new Set([
  "BN",
  "LRE",
  "LRO",
  "RLE",
  "RLO",
  "PDF",
  "LRI",
  "RLI",
  "FSI",
  "PDI",
]);

/**
 * The level of each of a text's characters, by code point, on a line whose direction is `line`
 * (UAX #9), and null for a character passed over. Exported for the tests, not from the package.
 */
export function levelsOf(text: string, line: Direction): (number | null)[] {
  const chars = [...text];
  const kept: number[] = [];
  const types: BidiClass[] = [];
  const brackets: (Bracket | undefined)[] = [];
  for (const [i, char] of chars.entries()) {
    const type = bidiClassOf(char);
    if (PASSED_OVER.has(type)) continue;
    kept.push(i);
    types.push(type);
    brackets.push(bracketOf(char));
  }
  const resolved = resolveLevels(types, brackets, line === "ltr" ? 0 : 1);
  const levels: (number | null)[] = chars.map(() => null);
  for (const [k, i] of kept.entries()) levels[i] = resolved[k] ?? null;
  return levels;
}

/**
 * The visual order of a line's items from their levels (rule L2): from the highest level down to
 * 1, every run of items at that level or higher is reversed. Exported for the tests.
 */
export function reorder(levels: readonly number[]): number[] {
  const order = levels.map((_, i) => i);
  const levelAt = (at: number) => levels[order[at] ?? 0] ?? 0;
  const highest = levels.reduce((high, level) => Math.max(high, level), 0);
  for (let level = highest; level >= 1; level--) {
    for (let i = 0; i < order.length; i++) {
      if (levelAt(i) < level) continue;
      let end = i;
      while (end < order.length && levelAt(end) >= level) end++;
      for (let low = i, high = end - 1; low < high; low++, high--) {
        [order[low], order[high]] = [order[high] ?? 0, order[low] ?? 0];
      }
      i = end;
    }
  }
  return order;
}

/**
 * The text's characters in the order they are drawn on a line whose direction is `line` (UAX #9,
 * as above): a mark (a nonspacing one, Bidi_Class NSM) and a character passed over stay after the
 * character before them, which they are drawn on or beside.
 */
export function drawnOrder(text: string, line: Direction): string {
  const levels = levelsOf(text, line);
  const clusters: string[] = [];
  const clusterLevels: number[] = [];
  for (const [i, char] of [...text].entries()) {
    const level = levels[i] ?? null;
    const last = clusters.length - 1;
    if (last >= 0 && (level === null || bidiClassOf(char) === "NSM")) {
      clusters[last] += char;
    } else {
      clusters.push(char);
      clusterLevels.push(level ?? (line === "ltr" ? 0 : 1));
    }
  }
  return reorder(clusterLevels)
    .map((i) => clusters[i])
    .join("");
}
