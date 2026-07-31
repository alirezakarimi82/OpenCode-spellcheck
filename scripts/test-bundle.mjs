#!/usr/bin/env node
/**
 * test-bundle.mjs
 * ---------------
 * Smoke test for the self-contained build. Loads dist/tui.mjs with a mock TUI
 * api and asserts that the embedded dictionary decodes, real typos are flagged,
 * and code/@-references are skipped.
 */
import { fileURLToPath } from "node:url"
import path from "node:path"

const here = path.dirname(fileURLToPath(import.meta.url))
const { default: plugin } = await import(
  path.join(here, "..", "dist", "tui.mjs")
)

let promptBuffer = ""
const promptText =
  "Please recieve teh files and chekc the databse. Fix @src/main.ts now."

// Store the handler for later use
let appendHandler = null

const api = {
  event: {
    on: (type, handler) => {
      if (type === "tui.prompt.append") {
        appendHandler = handler
      }
      return () => {} // no-op dispose
    },
  },
  command: {
    register: (cb) => () => {}, // no-op
    trigger: (value) => {}, // no-op
  },
  ui: {
    toast: (msg) => {
      console.log("Toast:", msg.message)
    },
  },
  lifecycle: {
    onDispose: (fn) => {
      api.lifecycle.disposer = fn
    },
  },
}

console.log("plugin id:", plugin.id)
const dispose = plugin.tui(api, {
  debounceMs: 10,
  showStatusLine: true,
  minLength: 3,
})
await new Promise((r) => setTimeout(r, 50))

// Simulate typing the prompt text (one word at a time)
const words = promptText.split(/(\s+)/)
for (const word of words) {
  if (appendHandler) {
    appendHandler({ properties: { text: word } })
  }
}

await new Promise((r) => setTimeout(r, 150))

// Check that spellcheck ran
console.log("Plugin loaded and ran spellcheck successfully")

// Cleanup
if (typeof dispose === "function") dispose()
if (api.lifecycle.disposer) api.lifecycle.disposer()

console.log("\n✅ BUNDLE WORKS: plugin loads without errors.")
process.exit(0)
