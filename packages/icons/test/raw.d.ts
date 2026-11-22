// Vite's `?raw` imports: a file's text, which the tests read without node:fs.
declare module "*?raw" {
  const text: string;
  export default text;
}
