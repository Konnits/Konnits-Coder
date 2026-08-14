import * as esbuild from "esbuild";
import { rmSync } from "node:fs";

const watch = process.argv.includes("--watch");
for (const staleOutput of [
  "dist/extension.js",
  "dist/extension.js.map",
  "dist/qwen-cli-launcher.cjs",
  "dist/qwen-cli-launcher.cjs.map",
]) {
  rmSync(staleOutput, { force: true });
}
const shared = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

const extension = {
  ...shared,
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode", "@qwen-code/sdk"],
};

const webview = {
  ...shared,
  entryPoints: ["webview/src/index.tsx"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  define: { "process.env.NODE_ENV": '"production"' },
};

const qwenCliLauncher = {
  ...shared,
  entryPoints: ["src/qwen/qwen-cli-launcher.ts"],
  outfile: "dist/qwen-cli-launcher.mjs",
  platform: "node",
  format: "esm",
  target: "node22",
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extension),
    esbuild.context(webview),
    esbuild.context(qwenCliLauncher),
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all([
    esbuild.build(extension),
    esbuild.build(webview),
    esbuild.build(qwenCliLauncher),
  ]);
}
