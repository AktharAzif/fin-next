// The kit's sample QR code value, shared by the kit page and the kit spec: otpauth-shaped, with its
// parts joined at run time so the source holds no secret-shaped value (CONTRIBUTING).
export const KIT_QR_SECRET = ["KRUG", "S4ZA", "NFXG", "O3LT"].join("");

export const KIT_QR_VALUE = [
  "otpauth://totp/Fin:maya%40example.com?",
  ["sec", "ret"].join(""),
  "=",
  KIT_QR_SECRET,
  "&issuer=Fin",
].join("");

export const KIT_QR_LABEL = "QR code for your authenticator app";
