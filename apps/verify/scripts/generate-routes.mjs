#!/usr/bin/env node
// Writes src/client/routeTree.gen.ts from the file routes, as the router plugin does at the start of
// `vite build` and `vite dev`, so `tsc` and Vitest can run without a build (spec 06 §1.1: the file is
// generated, never committed). The settings are tsr.config.json's, which the plugin reads too.
import { unpluginRouterGeneratorFactory } from "@tanstack/router-plugin";

const generator = unpluginRouterGeneratorFactory({});
await generator.vite.configResolved({ root: process.cwd() });
