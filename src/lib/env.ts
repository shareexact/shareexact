/**
 * Environment access that survives being bundled into the browser.
 *
 * Modules like `feeds.ts` and `rpc.ts` are imported (transitively) by client
 * components because they sit next to a server function. Reading `process.env`
 * at module scope in that situation throws `process is not defined` during
 * module initialisation, which happens before React mounts — so the whole app
 * renders as a blank page with a single console error and no component stack.
 *
 * Every environment read in shared modules goes through here. Server-only
 * modules may still use `env.server.ts` directly.
 */

export function readEnv(key: string): string | undefined {
  if (typeof process === "undefined" || !process.env) return undefined;
  const value = process.env[key];
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function readEnvNumber(key: string, fallback: number): number {
  const raw = readEnv(key);
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** True when running on the server. Client bundles get `false`. */
export const isServer = typeof window === "undefined";
