import { defineConfig } from "vite";
import { opensslLab } from "./server/plugin.ts";

function sqlJsBundlerFix() {
  return {
    name: "sqljs-bundler-fix",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.includes("sql-wasm-browser.js")) return null;
      let next = code.replace("module = undefined;", "void 0;");
      if (!next.includes("export default initSqlJs")) next += "\nexport default initSqlJs;\n";
      return next === code ? null : next;
    },
  };
}

export default defineConfig({
  plugins: [sqlJsBundlerFix(), opensslLab()],
  optimizeDeps: {
    exclude: ["sql.js"],
  },
  server: {
    host: true,
    port: 5173,
    allowedHosts: ["lucca"],
  },
});
