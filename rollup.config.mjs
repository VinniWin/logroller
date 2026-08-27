import { readFileSync } from "node:fs";
import typescript from "@rollup/plugin-typescript";

const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
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
  ],
  output: [
    { file: "dist/index.esm.js", format: "es", banner },
    { file: "dist/index.cjs", format: "cjs", exports: "named", banner },
  ],
};
