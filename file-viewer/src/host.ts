import type { DotDirGlobalApi } from "@dotdirfm/extension-api";

/** Host API injected by the extension iframe bootstrap (`iframeBootstrap.inline.js`). */
export function getHost(): DotDirGlobalApi {
  const d = (globalThis as typeof globalThis & { dotdir?: DotDirGlobalApi }).dotdir;
  if (!d) {
    throw new Error("globalThis.dotdir is not available (extension must run inside .dir’s viewer iframe)");
  }
  return d;
}
