// node --import ./test/cf-register.mjs: lets Node load src/worker.js, whose
// Container class comes from @cloudflare/containers. Two things only a
// bundler (Wrangler) handles are resolved here, for tests: the Workers
// runtime module `cloudflare:workers` (-> a local stub), and the package's
// extensionless relative imports (-> .js).
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: ${JSON.stringify(new URL('./cf-workers-stub.mjs', import.meta.url).href)}, shortCircuit: true };
  if (specifier.startsWith('.') && !/\\.[cm]?js$/.test(specifier) && context.parentURL?.includes('/@cloudflare/containers/')) return next(specifier + '.js', context);
  return next(specifier, context);
}`));
