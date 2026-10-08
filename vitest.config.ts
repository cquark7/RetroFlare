import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __RETROFLARE_LOCAL_DEVELOPMENT__: "false"
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          DEV_AUTH: "enabled",
          APP_ORIGIN: "https://retroflare.test",
          DEV_DEFAULT_IDENTITY: "alex",
          DEV_ADMIN_IDENTITY: "alex",
          TEAM_OBJECT_NAME: "team-v1"
        }
      }
    })
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    fileParallelism: false
  }
});
