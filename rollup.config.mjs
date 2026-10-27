import { readFileSync } from "node:fs";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";
import { dts } from "rollup-plugin-dts";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const banner = `/*! ${pkg.name} v${pkg.version} | ${pkg.license} License */`;
const input = { index: "src/index.ts", pino: "src/pino.ts" };

export default [
  {
    input,
    external: [/^node:/],
    plugins: [
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
        declarationMap: false,
        emitDeclarationOnly: false,
        outDir: "dist",
      }),
      terser({ compress: { toplevel: true, drop_console: true, drop_debugger: true }, ecma: 2022 }),
    ],
    output: [
      { dir: "dist", format: "es", entryFileNames: "[name].esm.js", chunkFileNames: "[name].esm.js", banner },
      { dir: "dist", format: "cjs", entryFileNames: "[name].cjs", chunkFileNames: "[name].cjs", exports: "named", banner },
    ],
  },
  // one self-contained declaration file per entry and module format (no internal .d.ts leak)
  ...["d.ts", "d.cts"].map((ext) => ({
    input,
    external: [/^node:/],
    plugins: [dts({ tsconfig: "./tsconfig.json" })],
    output: { dir: "dist", entryFileNames: `[name].${ext}`, chunkFileNames: `[name].${ext}` },
  })),
];
