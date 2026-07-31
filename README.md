# opencode-spellcheck

Live, Microsoft-Word-style typo highlighting for the **OpenCode** prompt — it
watches what you type, flags likely misspellings, and offers corrections, all
inside the terminal.

> **Status:** the spell-check engine is complete and production-ready; the
> live-UI wiring targets OpenCode's **beta** TUI plugin API. Inline squiggle
> decoration was attempted but the prompt-extmark surface is **not** exposed to
> TUI plugins in opencode v1.18.x, so this plugin surfaces typos via
> **toast notifications** (the always-works baseline). The tokenizer + engine
> still detect misspellings with full offset data, so adding inline highlights
> is a one-step change once the extmark API lands.

---

## What it does

- ✍️ **As-you-type checking.** Polls the live prompt buffer and re-checks
  after a debounce (default 250 ms).
- 🧠 **Real dictionary.** Hunspell via `nspell` + `dictionary-en`, with
  LCS-ranked suggestions (`recieve → receive`, not `revive`).
- 🚫 **Code-aware.** Skips fenced/inline code, `@file` mentions, `/commands`,
  `!shell` lines, URLs, emails, paths, hex, numbers/versions, and identifiers
  (`camelCase`, `snake_case`, `ALLCAPS`).
- 📖 **Personal dictionary.** Add project jargon (CAISO, BESS, LMP…) via the
  `extraWords` option or `engine.addWord()`; never flagged again. The personal
  dictionary file lives at
  `~/.config/opencode/spellcheck-dictionary.txt`.
- 🔔 **Toast notifications.** flagged words + their top suggestion are shown
  via `api.ui.toast` (e.g. `✎ 3 typo(s): recieve→receive  teh→the  chekc→check`).
- 🛟 **Fail-safe.** Every touch of the beta TUI API is feature-detected; a
  missing capability (or missing dictionary dependency) degrades a feature
  instead of breaking the prompt. If `nspell`/`dictionary-en` aren't
  available, the engine reports "everything correct" and nothing is flagged.

## Install

### 1. Build it (produces a single, self-contained file)

```bash
git clone <this-repo> opencode-spellcheck
cd opencode-spellcheck
npm install          # dev-only: nspell, dictionary-en, esbuild, typescript
npm run build        # embeds the dictionary + bundles everything → dist/tui.mjs
npm test             # optional: smoke-test the bundle
```

`npm run build` runs two steps:

1. **`embed`** — reads the Hunspell `.aff`/`.dic` from `dictionary-en`,
   **gzip-compresses** them (level 9), base64-encodes the result, and writes
   `src/generated/dict-data.ts` (decoded back to a `Buffer` at load time via
   Node's built-in `zlib`).
2. **`bundle`** — esbuild inlines `nspell` **and** the embedded dictionary
   into one minified **`dist/tui.mjs`** (~270 KB).

The result has **zero runtime dependencies**: no `bun install` at startup, no
on-disk dictionary files. Only Node built-ins (`node:zlib`, `node:fs`, …) are
external, and those always exist in the OpenCode runtime.

> Prefer dev mode? You can still point the config at `src/index.ts`; that entry
> dynamically imports `nspell` + `dictionary-en` instead of using the embed.

### 2. Register it in `tui.json`

TUI plugins live in **`tui.json`** (not `opencode.json`). Global config is
`~/.config/opencode/tui.json`; project config is `./tui.json`.

```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["file:///ABS/PATH/opencode-spellcheck/dist/tui.mjs", {
      "debounceMs": 250,
      "showStatusLine": true,
      "minLength": 3,
      "extraWords": ["CAISO", "BESS", "LMP"]
    }]
  ]
}
```

Restart OpenCode. See [`examples/tui.json`](examples/tui.json) for the full form.

> **No runtime dependencies.** Because the dictionary and `nspell` are inlined
> into `dist/tui.mjs`, you do **not** need to install anything at runtime or
> ship the dictionary files. Just point `tui.json` at the built `dist/tui.mjs`.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `debounceMs` | number | `250` | Delay after the last buffer change before re-checking. |
| `showStatusLine` | boolean | `true` | Surface flagged typos + top suggestions via toast notifications. |
| `minLength` | number | `3` | Ignore words shorter than this. |
| `extraWords` | string[] | `[]` | Always-accepted words (project jargon), added case-insensitively. |
| `toastDuration` | number | `6000` | Milliseconds the toast stays visible. |

> The plugin also accepts `inlineHighlight` for forward-compatibility, but it
> is a **no-op** on opencode v1.18.x — the prompt-extmark surface isn't
> exposed to TUI plugins yet.

## How it reads the prompt

OpenCode's TUI plugin surface is beta and has no single stable "get prompt
text" call, so the plugin uses two layered strategies and feature-detects each:

1. **Slot-wrapped `api.ui.Prompt` (live polling).** When the host exposes
   `api.slots.register` and `api.ui.Prompt`, the plugin wraps the prompt
   component for the `home_prompt` / `session_prompt` slots, intercepts the
   render `ref`, and polls `ref.current.input` every 300 ms. This gives
   true as-you-type checks.
2. **Event-based buffer tracking (fallback).** Listens to `tui.prompt.append`
   (accumulates typed text), `tui.command.execute` (clears on `prompt.clear`),
   and `tui.session.select` (clears on session switch), then re-runs the
   checker on the debounce.

Whichever path yields a changed buffer, the tokenizer extracts the prose
tokens, the engine checks each word, and a toast summarizes the first 5 typos
with their top suggestion (deduped by signature so the toast isn't re-fired
for the same mistake on every poll).

## Add a word to your dictionary

There is no built-in command yet; "add to dictionary" is an engine API today:

```ts
// inside another plugin or a custom command
await engine.addWord("Backtesting")  // case-insensitive, persisted to disk
```

`addWord` writes to `~/.config/opencode/spellcheck-dictionary.txt` and
re-loads it on next start. Wiring it to a `spellcheck_add_word` keybind is a
planned follow-up (see [Roadmap](#roadmap)).

## Roadmap

- Wire `engine.addWord` to a registered `spellcheck_add_word` command + keybind.
- Mount `SpellStatusLine` (`src/status-line.tsx`) as a prompt-side slot for a
  persistent typo panel, in addition to toasts.
- Inline extmark underlines the instant opencode exposes a plugin extmark setter.

## Project layout

```
src/
  index.ts              TUI plugin entry (dev mode: dynamic imports)
  index.bundled.ts      self-contained entry: static nspell + embedded dict
  engine.ts             nspell wrapper: cache, personal dict, LCS-ranked
                        suggestions, graceful no-op
  tokenizer.ts          prose extraction (skips code/@/ /commands/identifiers…)
                        with start/end offsets for future inline highlights
  prompt-adapter.ts     feature-detected notify() (toast) — extmark path is
                        no-op on opencode v1.18.x
  status-line.tsx       drafted SolidJS status-slot component (not yet wired)
  types.d.ts            ambient stubs for nspell / dictionary-en
  generated/
    dict-data.ts        AUTO-GENERATED gzip+base64 dictionary (from `npm run embed`)
scripts/
  embed-dictionary.mjs  compresses & embeds the Hunspell dictionary
  test-bundle.mjs       smoke test that loads dist/tui.mjs
examples/tui.json       sample configuration
dist/
  tui.mjs               ← the single self-contained artifact you ship
```

## License

MIT
