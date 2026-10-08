import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig(({ command, mode }) => {
  const localDevelopmentBuild = command === "serve";
  const e2eBuild = localDevelopmentBuild && mode === "e2e";

  return {
    define: {
      __RETROFLARE_LOCAL_DEVELOPMENT__: JSON.stringify(localDevelopmentBuild)
    },
    plugins: [
      react(),
      cloudflare({
        configPath: localDevelopmentBuild
          ? e2eBuild
            ? "./wrangler.e2e.jsonc"
            : "./wrangler.local.jsonc"
          : "./wrangler.jsonc",
        ...(e2eBuild ? { persistState: false } : {})
      })
    ]
  };
});
