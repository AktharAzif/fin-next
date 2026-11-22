// The kit's sample QR code values, shared by the kit page and the kit spec: otpauth-shaped, with
// their parts joined at run time so the source holds no secret-shaped value (CONTRIBUTING).
export const KIT_QR_SECRET = ["KRUG", "S4ZA", "NFXG", "O3LT"].join("");

export const KIT_QR_VALUE = [
  "otpauth://totp/Fin:maya%40example.com?",
  ["sec", "ret"].join(""),
  "=",
  KIT_QR_SECRET,
  "&issuer=Fin",
].join("");

export const KIT_QR_LABEL = "QR code for your authenticator app";

/** A URI shaped as the realm writes them (a 52-character key), for a local part of `n` letters. */
function realmShaped(n: number): string {
  return [
    `otpauth://totp/Fin:${"m".repeat(n)}%40example.com?`,
    ["sec", "ret"].join(""),
    `=${"GEZDGNBVGY3TQOJQ".repeat(3)}GEZA&issuer=Fin&digits=6&period=30`,
  ].join("");
}

/**
 * Codes of other sizes, each drawn at its own whole pixels a module: the realm's usual URI
 * (version 8, 2px a module), one with a long address (version 11), and one past what 148px holds
 * at 2px a module (version 14, on a tile that grows).
 */
export const KIT_QR_SIZES: readonly string[] = [realmShaped(4), realmShaped(104), realmShaped(240)];

/**
 * More text than any QR code holds, carrying the sample key as a set-up's URI would: the tile says
 * it could not draw it, and its report holds nothing of it.
 */
export const KIT_QR_TOO_LONG = `${KIT_QR_VALUE}&pad=${"7".repeat(7090)}`;
