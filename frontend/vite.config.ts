import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 9091,
    proxy: {
      "/api": { target: "http://127.0.0.1:9090", ws: true },
      "/preview": "http://127.0.0.1:9090",
    },
  },
});
