// finLayerOrder: a build plugin that keeps `@layer ui-sdk;` the first statement of every emitted
// stylesheet (FW-C06, spec 06 §3.2 and §6.4 check 3).
//
// Each app's stylesheet starts with `@layer ui-sdk;`, so the UI SDK's adopted sheets land in the
// lowest layer and Fin's utilities beat its reset. Tailwind 4 then inserts its own
// `@layer properties;` (the @property fallback for older engines) ahead of every other statement,
// and the minifier folds it into the fallback block, so the built file no longer starts with the
// ui-sdk layer. The order between those two layers changes nothing (the fallback only gives
// --tw-* variables their initial values), but the contract and static:check want ui-sdk first:
// this puts the declaration back in front. Apps add it to their vite.config.ts plugins.
import type { Plugin } from "vite";

const LEADING_TRIVIA = /^(?:﻿|\s|\/\*[\s\S]*?\*\/)*/;

/**
 * The stylesheet with `@layer ui-sdk;` as its first statement (comments may precede it). A first
 * statement that already declares the layer itself, alone, first in a list or as a block, is left
 * alone; a longer name (`ui-sdk-extra`, `ui-sdk.inner`) is not the layer. static:check reads the
 * built file the same way.
 */
export function withUiSdkLayerFirst(css: string): string {
  const body = css.replace(LEADING_TRIVIA, "");
  if (/^@layer\s+ui-sdk\s*[;,{]/.test(body)) return css;
  if (/^@charset\b/i.test(body)) throw new Error("a stylesheet with @charset is not expected here");
  return `@layer ui-sdk;\n${css}`;
}

export function finLayerOrder(): Plugin {
  return {
    name: "fin:layer-order",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== "asset" || !file.fileName.endsWith(".css")) continue;
        const text =
          typeof file.source === "string" ? file.source : new TextDecoder().decode(file.source);
        file.source = withUiSdkLayerFirst(text);
      }
    },
  };
}
