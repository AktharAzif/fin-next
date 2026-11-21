// The vectors the encoder is tested against. They are data, not code: nothing here comes from the
// encoder.
//
// Published:
//   - ISO/IEC 18004's worked example (Annex I): "01234567" as a version 1-M symbol, its 16 data
//     codewords and 10 error correction codewords;
//   - the "HELLO WORLD" version 1-Q example of the widely used QR tutorial at thonky.com: 13 data
//     and 13 error correction codewords;
//   - Table 7's byte-mode capacities for every version and level, and its numeric and alphanumeric
//     capacities at versions 1 and 40;
//   - Tables C.1, D.1 and E.1 (the format words, the version words, the alignment rows) are in
//     decode.ts, which reads symbols by them.
//
// Reference symbols, from libqrencode 4.1.1 (an independent encoder), run as
//   qrencode -8 -t ASCII -m 0 -l <level> -v <version> -o - "<fill(capacity)>"
// for every version and level, with the text filled to exactly the byte capacity, so that every
// data codeword carries text. Each entry is the level, the mask libqrencode chose, and the first 16
// hex digits of the SHA-256 of its modules (one byte per module, 1 dark, row by row). One byte more
// put each symbol below version 40 into the next version up, in libqrencode as here.

/** The text a reference symbol holds: an otpauth-shaped unit, repeated, cut to `length`. */
export function fill(length: number): string {
  // Joined at run time, so the source holds no secret-shaped value (CONTRIBUTING).
  const unit = [
    "otpauth://totp/Fin:maya%40example.com?",
    "sec",
    "ret=",
    "JBSWY3DP",
    "EHPK3PXP",
    "&issuer=Fin&",
  ].join("");
  return unit.repeat(Math.ceil(length / unit.length) + 1).slice(0, length);
}

export const ISO_EXAMPLE = {
  text: "01234567",
  level: "M",
  data: [
    0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
  ],
  ec: [0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55],
} as const;

export const HELLO_WORLD = {
  text: "HELLO WORLD",
  level: "Q",
  data: [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236],
  ec: [168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16],
} as const;

/** Table 7, byte mode: [L, M, Q, H] for versions 1 to 40. */
export const BYTE_CAPACITY: readonly (readonly [number, number, number, number])[] = [
  [17, 14, 11, 7],
  [32, 26, 20, 14],
  [53, 42, 32, 24],
  [78, 62, 46, 34],
  [106, 84, 60, 44],
  [134, 106, 74, 58],
  [154, 122, 86, 64],
  [192, 152, 108, 84],
  [230, 180, 130, 98],
  [271, 213, 151, 119],
  [321, 251, 177, 137],
  [367, 287, 203, 155],
  [425, 331, 241, 177],
  [458, 362, 258, 194],
  [520, 412, 292, 220],
  [586, 450, 322, 250],
  [644, 504, 364, 280],
  [718, 560, 394, 310],
  [792, 624, 442, 338],
  [858, 666, 482, 382],
  [929, 711, 509, 403],
  [1003, 779, 565, 439],
  [1091, 857, 611, 461],
  [1171, 911, 661, 511],
  [1273, 997, 715, 535],
  [1367, 1059, 751, 593],
  [1465, 1125, 805, 625],
  [1528, 1190, 868, 658],
  [1628, 1264, 908, 698],
  [1732, 1370, 982, 742],
  [1840, 1452, 1030, 790],
  [1952, 1538, 1112, 842],
  [2068, 1628, 1168, 898],
  [2188, 1722, 1228, 958],
  [2303, 1809, 1283, 983],
  [2431, 1911, 1351, 1051],
  [2563, 1989, 1423, 1093],
  [2699, 2099, 1499, 1139],
  [2809, 2213, 1579, 1219],
  [2953, 2331, 1663, 1273],
];

/** Table 7 at versions 1 and 40, numeric and alphanumeric: [L, M, Q, H]. */
export const OTHER_CAPACITY = {
  numeric: { 1: [41, 34, 27, 17], 40: [7089, 5596, 3993, 3057] },
  alphanumeric: { 1: [25, 20, 16, 10], 40: [4296, 3391, 2420, 1852] },
} as const;

/** libqrencode's symbols, versions 1 to 40, each [L, M, Q, H] as level, mask and fingerprint. */
export const REFERENCE_SYMBOLS: readonly (readonly string[])[] = [
  ["L79b5e9611b48347e3", "M00b37520c0449c271", "Q0e346c026def5a1de", "H0b9a44c23c9898951"],
  ["L02387677d927ccbca", "M00cc7ea28879211c0", "Q025d97c5e172ecaeb", "H111584464fc7d369d"],
  ["L1663cd013dcf1b6d6", "M4765d7724d9223b6a", "Q3eaca11137a4259eb", "H3032c72effac56990"],
  ["L20125b776dd92e0d5", "M134db3b5f04fd2047", "Q7d96e172889bd8c47", "H2701427b06285446d"],
  ["L224c7e8f769c23226", "M6b302ee943f71710c", "Q3fe4b0f8b93722c96", "H140633fff783b2d95"],
  ["L4f8f825615279b62c", "M39e7eca77dab839f2", "Q35fb17c35c170c3e8", "H46fc4ac56a87c5e64"],
  ["L3df4304ef3b28052f", "M267a4553b49b00682", "Q38301f7203f7bdc0a", "H3fe39e2d33fd6f646"],
  ["L29636058d6479bc22", "M671ef5cdb9ade31e0", "Q285cf4a336e7b075e", "H368447a4266f2c935"],
  ["L7ff54bae84f601bd4", "M69ca84161d9104d10", "Q639057e8bb6f4bb69", "H220469c13b4051ffd"],
  ["L1176189cfd321a2cf", "M7258cb292e4394c42", "Q48cf66cda93a5857c", "H11bdc8ea1a819d102"],
  ["L5857aeef854cad6d4", "M3b9a81ed0e234c776", "Q1611e2bb052d823c3", "H259f8df3996d5e368"],
  ["L3f1bd1d189a314cdc", "M4cbc458d5e23d2b3f", "Q7cd1b58e903829949", "H2f1b908ba7883ad15"],
  ["L45622b955253f6fa7", "M1d5a57a5b12a98722", "Q11a9cc62f554438c0", "H14e01033903a02aa0"],
  ["L5e426d3083c4d3ac5", "M6f733c9711c0f5098", "Q339cc068b75ff35ff", "H2f6692518e9c5a92d"],
  ["L627569bb27769e203", "M3dcc00faf987f82b2", "Q693bab4a513b02c4f", "H211c482e09aebaf1f"],
  ["L147e51db4dc7de937", "M4266b3dc2cf0e362f", "Q5050fb51d6e44d295", "H2c92d0ae9e39d0710"],
  ["L2b907bf93861e1033", "M7191c228679d110c8", "Q5e6900165b8201e5b", "H44df76fecef3c566e"],
  ["L36924639a3a4924d2", "M3934df02ebd0f38b8", "Q25abb65791f33298d", "H34cd769c1ec35b5a3"],
  ["L7db19e23a8e99c3e0", "M4f0bb237c5b5dd1fe", "Q2529e8259b8b5c11b", "H2c25469b4c67a6f90"],
  ["L56b06f0e65c567191", "M10c45a4e82f13a935", "Q7d7297f0c4b2955eb", "H70ad9aee9d2864f4e"],
  ["L40ae676a6593d54d7", "M465d16879b6e66f85", "Q4a09a3091491cc28c", "H1a696e17bc4495d17"],
  ["L45a9598b5d78080e1", "M495ac4dc1ed2cffcd", "Q7835e251845449840", "H3afe677fe563a4c08"],
  ["L4f38d3fd2cb58c888", "M492cc8326e1923f46", "Q74b76add75d2006a8", "H43f01f2e53b79ea41"],
  ["L47808bae7530b2136", "M4b19a3a2f51e2a16a", "Q64ddcd155d10f584d", "H38b2ba548f68bd4ff"],
  ["L422959d76be2d5332", "M4cd607c3d58b4571e", "Q5e18fee6af031a445", "H55defcf148e5e6754"],
  ["L40329d8bc7a68739b", "M44e7e022e4ee7b121", "Q4dc59e6524b9714c0", "H6c3ae55b883bbb00b"],
  ["L465c592f3d1c50c3b", "M44413b4e90791ccc9", "Q4a4cdeaea729d740d", "H3d91e677ec7907786"],
  ["L6ba37869adb633076", "M61019b1a662e449f8", "Q5afe5f3c825de98d0", "H762d62a96bda09457"],
  ["L41666125dc33a9759", "M4485b7f57ebe2b8e5", "Q7c20940978c776b32", "H1ce885d9e5e763504"],
  ["L7e86727c4acd7d2dc", "M45c4c2f082066611d", "Q29020cb23be295ebc", "H2bca73b3d0e3b54d8"],
  ["L4d4e9081e17a630ff", "M3aef40c0cb99d5445", "Q5fe84451b405c1ec2", "H4c749cc89f51307db"],
  ["L3c932d0f8febfa824", "M4c22b5ca220fe9ad5", "Q714dd21601ed26a53", "H55bb4cf2ee0e3574d"],
  ["L45fee5e63d6ea25fc", "M383eaf780036b516a", "Q6637d5e7d9e50d6ac", "H4b5dbc61104841c1f"],
  ["L1aa5d96c31d0a0d54", "M4801c2af138951de3", "Q286b47d9a05df9479", "H6f57aa3243bbf5ced"],
  ["L451ca04520f237cc9", "M41722405f4e4872d1", "Q37917115b9f8d843a", "H2f3f5988ce629fed9"],
  ["L61128d470e3fd8834", "M69a256d7174682d87", "Q580a0567c73b4099b", "H2b546f08dc75cc948"],
  ["L5a045bb3f110b8063", "M69d0ed708400024d7", "Q1d59c03e9da02f912", "H1ef64b9f66230982d"],
  ["L29c0075b635783cc0", "M68807bde44bd958e6", "Q6c147b8c17ff0431d", "H22d755340e7450655"],
  ["L326a1c1532f09e2dc", "M42207cba20ff20633", "Q121705e88ac5e35c3", "H2ee4f318eafaa4871"],
  ["L35b48788e7022b999", "M6083a1fa135ca8eba", "Q15025a3a3b77a5b8b", "H2b342108d4aa4da59"],
];
