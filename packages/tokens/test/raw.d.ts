// Vite's `?raw` imports: a file's text, which the tests read without node:fs (client packages
// import no node:* module, FW-C12).
declare module "*?raw" {
  const text: string;
  export default text;
}

// Vite's `?inline` imports: a binary file (a font) as a base64 data URL, for the same reason.
declare module "*?inline" {
  const url: string;
  export default url;
}
