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
  edit-distance-ranked suggestions that account for transpositions
  (`recieve → receive` not `revive`; `teh → the` not `tech`).
- 🚫 **Code-aware.** Skips fenced/inline code, `@file` mentions, `/commands`,
  `!shell` lines, URLs, emails, hex, numbers/versions, identifiers
  (`camelCase`, `snake_case`, `ALLCAPS`), file paths whether bare or prefixed
  (`src/engine.ts`, `./src/engine.ts`, `~/.bashrc`), and bare filenames with a
  recognized code/config extension (`config.yaml`, `README.md`).
- 📖 **Project vocabulary.** Add project jargon (CAISO, BESS, LMP…) via the
  `extraWords` option so it is never flagged.
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

`npm run build` typechecks first (fails the build on a type error, rather
than shipping one silently into the bundle), then runs two steps:

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
| `debugLog` | boolean | `false` | Write diagnostic info to `/tmp/spellcheck-debug.log`. Off by default: this is a synchronous file write and it logs prompt text verbatim, so opt in only when actually debugging the plugin. |

> The plugin also accepts `inlineHighlight` for forward-compatibility, but it
> is a **no-op** on opencode v1.18.x — the prompt-extmark surface isn't
> exposed to TUI plugins yet.

## How it reads the prompt

OpenCode's TUI plugin surface is beta and has no single stable "get prompt
text" call, so the plugin picks one of two strategies and feature-detects
which is available — never both at once, since running them concurrently
against the same prompt used to cause redundant checks and, occasionally,
inconsistent toasts:

1. **Slot-wrapped `api.ui.Prompt` (live polling) — used when available.**
   When the host exposes `api.slots.register` and `api.ui.Prompt`, the
   plugin wraps the prompt component for the `home_prompt` / `session_prompt`
   slots, intercepts the render `ref`, and samples `ref.current.input` while
   applying the configured debounce. This gives true as-you-type checks. The
   wrapper also forwards
   `session_prompt`'s `session_id`/`on_submit`/`visible`/`disabled` fields
   through to the real `Prompt` component (as `sessionID`/`onSubmit`/etc.) —
   dropping these previously broke session continuity, since the host had no
   way to tell the rendered prompt which session it belonged to. The prompt is
   sampled frequently and checked after the configured debounce delay.
2. **Event-based buffer tracking — fallback, used only when (1) isn't
   available.** Listens to `tui.prompt.append` (accumulates typed text),
   `tui.command.execute` (clears on `prompt.clear`), and `tui.session.select`
   (clears on session switch), then re-runs the checker on the debounce.

Whichever path is active, the tokenizer extracts the prose tokens, the engine
checks each word, and a toast summarizes the first 5 typos with their top
suggestion (deduped by signature so the toast isn't re-fired for the same
mistake on every poll, but does re-fire if you fix a typo and then
reintroduce the same one later).

## Roadmap

- Mount `SpellStatusLine` (`src/status-line.tsx`) as a prompt-side slot for a
  persistent typo panel, in addition to toasts.
- Inline extmark underlines the instant opencode exposes a plugin extmark setter.

## Project layout

```
src/
  index.ts              TUI plugin entry (dev mode: dynamic imports)
  index.bundled.ts      self-contained entry: static nspell + embedded dict
  engine.ts             nspell wrapper: cache, project vocabulary,
                        edit-distance-ranked suggestions, graceful no-op
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

## Changelog

### 0.2.0

Fix release — remove the obsolete `spellcheck_add_word` keybinding from any
existing `tui.json`; project vocabulary is configured through `extraWords`.

- Fixed: resuming a past session rendered with no continuation context
  (`session_prompt`'s `session_id`/`on_submit` weren't reaching the real
  `Prompt` component).
- Fixed: cleanup now stops the poller; slot registrations are released by the
  OpenCode plugin lifecycle.
- Fixed: the toast fallback chain stopped after the first candidate even
  when it didn't exist, so hosts without `api.ui.toast`/`api.toast` but with
  an alternate notify surface got no toasts at all.
- Fixed: suggestion ranking was blind to letter transpositions and could
  rank a plausible-looking insertion above the obvious fix (`teh → tech`
  instead of `teh → the`). Ranking now uses edit distance with a
  transposition tiebreaker.
- Fixed: bare relative paths and bare filenames (`src/engine.ts`,
  `config.yaml`) weren't recognized as code references and got flagged as
  prose typos.
- Fixed: the two prompt-tracking strategies could run concurrently and
  share toast-dedup state inconsistently; the event-based path is now a
  true fallback, only active when slot registration isn't available.
- Fixed: the buffer-tracking path never reset its toast-dedup signature on
  a clean check, so fixing a typo and later retyping the same one wouldn't
  re-notify.
- Changed: debug logging to `/tmp/spellcheck-debug.log` is now opt-in via
  `debugLog` (previously always on, writing prompt text on every
  keystroke-driven check).
- Changed: suggestion computation is skipped for correctly-spelled words,
  and candidates are ranked before truncating to `maxSuggestions` rather
  than after.

## License

MIT
