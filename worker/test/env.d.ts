import type { Env as WorkerEnv } from "../src/index";

declare global {
  namespace Cloudflare {
    // Tests run against a miniflare R2 binding (see vitest.config.ts).
    interface Env extends WorkerEnv {
      BUCKET: R2Bucket;
    }
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}
