import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Fixed test secrets; these override any local .dev.vars.
        bindings: { APP_TOKEN: "test-app-token", ADMIN_TOKEN: "test-admin-token" },
      },
    }),
  ],
});
