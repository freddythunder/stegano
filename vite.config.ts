import { defineConfig } from "vite";
import { opensslLab } from "./server/plugin.ts";

export default defineConfig({
  plugins: [opensslLab()],
  server: {
    host: true,
    port: 5173,
    allowedHosts: ["lucca"],
  },
});
