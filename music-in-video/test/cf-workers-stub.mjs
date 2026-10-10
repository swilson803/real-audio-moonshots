// Stand-in for the Workers runtime module `cloudflare:workers` under Node
// (test/cf-register.mjs). The tests never construct a Container; they bind
// PROCESSOR to a local stand-in instead.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
