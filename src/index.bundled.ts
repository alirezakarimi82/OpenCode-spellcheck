/**
 * index.bundled.ts
 * ----------------
 * Entry point used for the *self-contained* build. It statically imports
 * `nspell` and the embedded (gzip+base64) dictionary so that esbuild inlines
 * both into a single `dist/tui.mjs`. No runtime `bun install`, no on-disk
 * dictionary files.
 *
 * It reuses the exact same plugin factory as the dev entry; it only pre-loads
 * the spell-check assets and injects them via the plugin's `__assets` option.
 */

import nspell from "nspell"

import plugin from "./index"
import { embeddedDictionary } from "./generated/dict-data"

export default {
  id: plugin.id,
  tui(api: any, options?: any, meta?: any) {
    const opts = { ...(options ?? {}) }
    opts.__assets = {
      nspellFactory: (dict: any) => nspell(dict),
      dictionary: () => ({
        aff: embeddedDictionary.aff,
        dic: embeddedDictionary.dic,
      }),
    }
    return plugin.tui(api, opts, meta)
  },
}
