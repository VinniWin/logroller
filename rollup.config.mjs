import { readFileSync } from "node:fs";
import typescript from "@rollup/plugin-typescript";
import terser from "@rollup/plugin-terser";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const banner = `/*! ${pkg.name} v${pkg.version} | ${pkg.license} License */`;

export default {
  input: "src/index.ts",
  external: [/^node:/],
  plugins: [
    typescript({
      tsconfig: "./tsconfig.json",
      declaration: false,
      declarationMap: false,
      emitDeclarationOnly: false,
    }),
    terser({ compress: { toplevel: true, drop_console: true, drop_debugger: true }, ecma: 2025 }),
  ],
  output: [
    { file: "dist/index.esm.js", format: "es", banner },
    { file: "dist/index.cjs", format: "cjs", exports: "named", banner },
  ],
};
