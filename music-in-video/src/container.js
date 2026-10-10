// The Processor container's Durable Object (Cloudflare Containers, MS-007):
// one instance per name; the JOBS consumer (src/scan.js) spreads jobs over
// PROCESSOR_INSTANCES of them. The image is processor/Dockerfile (Node +
// Python with Demucs; instance standard-4: 4 vCPU, 12 GiB); the container
// sleeps after 60 s without a request. Its environment is set from
// the Worker's variables and secrets (names only; values in the dashboard):
//   SUPABASE_URL, SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY): moonshots
//   CLOUDFLARE_ACCOUNT_ID, R2_REF_BUCKET: where the reference copy is
//   R2_REF_ACCESS_KEY_ID, R2_REF_SECRET_ACCESS_KEY: read-only R2 token
import { Container } from '@cloudflare/containers';

export class Processor extends Container {
  defaultPort = 8080;
  sleepAfter = '60s';

  constructor(ctx, env) {
    super(ctx, env);
    this.envVars = {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_SECRET_KEY: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY,
      R2_REF_ENDPOINT: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      R2_REF_BUCKET: env.R2_REF_BUCKET,
      R2_REF_ACCESS_KEY_ID: env.R2_REF_ACCESS_KEY_ID,
      R2_REF_SECRET_ACCESS_KEY: env.R2_REF_SECRET_ACCESS_KEY,
    };
  }
}
