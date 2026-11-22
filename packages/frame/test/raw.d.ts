// Vite's `?raw` imports: a file's text, for tests that check the boot files as they ship.
declare module "*?raw" {
  const text: string;
  export default text;
}
