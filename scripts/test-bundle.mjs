#!/usr/bin/env node
/**
 * test-bundle.mjs
 * ---------------
 * Smoke + regression test for the self-contained build. Loads dist/tui.mjs
 * with mock TUI apis and *asserts* (not just prints) that:
 *   - real typos are flagged, with a sane top suggestion (teh -> the, not
 *     tech — regression test for the LCS transposition-blindness bug)
 *   - code references are skipped: @mentions, bare paths (src/engine.ts),
 *     and bare filenames (config.yaml)
 *   - notify() falls back to a working legacy method (api.notify) when
 *     api.ui.toast/api.toast are both absent — regression test for the
 *     fallback loop that used to stop after the first, usually-absent
 *     candidate
 *   - the session_prompt slot path forwards sessionID/onSubmit/visible to
 *     the real Prompt component — regression test for the bug where a
 *     resumed session rendered with no continuation context
 *   - disposing the plugin stops cleanly; slot registrations are scoped to
 *     OpenCode's plugin lifecycle
 *
 * Exits non-zero if any assertion fails, so `npm test` actually catches
 * regressions instead of only checking that the bundle loads without
 * throwing.
 */
import { fileURLToPath } from "node:url"
import path from "node:path"
import assert from "node:assert/strict"

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, "..", "dist", "tui.mjs")

let failures = 0
async function test(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (err) {
    failures++
    console.log(`FAIL   ${name}`)
    console.log(`       ${err.message}`)
  }
}

function makeBaseApi(overrides = {}) {
  let appendHandler = null
  const api = {
    event: {
      on: (type, handler) => {
        if (type === "tui.prompt.append") appendHandler = handler
        return () => {}
      },
    },
    lifecycle: {
      onDispose: (fn) => {
        api.lifecycle.disposer = fn
      },
    },
    ...overrides,
  }
  return { api, getAppendHandler: () => appendHandler }
}

async function typeIntoBuffer(appendHandler, text, settleMs = 120) {
  for (const chunk of text.split(/(\s+)/)) {
    if (appendHandler) appendHandler({ properties: { text: chunk } })
  }
  await new Promise((r) => setTimeout(r, settleMs))
}

// ---------------------------------------------------------------------
// Event-based fallback path (no slots/Prompt API on the host)
// ---------------------------------------------------------------------

await test("flags real typos via the event-based fallback, ranked sensibly", async () => {
  const { default: plugin } = await import(bundlePath)
  let toastMsg = null
  const { api, getAppendHandler } = makeBaseApi({
    ui: { toast: (msg) => { toastMsg = msg.message } },
  })
  plugin.tui(api, { debounceMs: 10, showStatusLine: true, minLength: 3 })
  await new Promise((r) => setTimeout(r, 30))
  await typeIntoBuffer(
    getAppendHandler(),
    "Please recieve teh files and chekc the databse. Fix @src/main.ts now.",
  )
  assert.ok(toastMsg, "expected a toast to fire")
  assert.match(toastMsg, /teh→the(\s|$)/, `expected "teh→the", got: ${toastMsg}`)
  assert.doesNotMatch(toastMsg, /teh→tech/, `regression: "teh" suggested "tech" again`)
  assert.doesNotMatch(toastMsg, /\bsrc\b/, `"@src/main.ts" leaked "src" as a flagged word: ${toastMsg}`)
  api.lifecycle.disposer?.()
})

await test("generates dictionary-backed suggestions when nspell returns none", async () => {
  const { default: plugin } = await import(bundlePath)
  let toastMsg = null
  const { api, getAppendHandler } = makeBaseApi({
    ui: { toast: (msg) => { toastMsg = msg.message } },
  })
  plugin.tui(api, { debounceMs: 10, showStatusLine: true, minLength: 3 })
  await new Promise((r) => setTimeout(r, 30))
  await typeIntoBuffer(
    getAppendHandler(),
    "be miscellenous let me be grammer and metcoulous",
  )
  assert.ok(toastMsg, "expected a toast to fire")
  // miscellenous: nspell.suggest() returns [] for this one — the fix must
  // come from the dictionary-generate fallback
  assert.match(
    toastMsg,
    /miscellenous→miscellaneous/,
    `miscellenous should suggest miscellaneous, got: ${toastMsg}`,
  )
  // grammer: one substitution away from both "grammar" and "crammer" —
  // the left-common tiebreak must pick "grammar"
  assert.match(
    toastMsg,
    /grammer→grammar/,
    `grammer should rank grammar first (not crammer), got: ${toastMsg}`,
  )
  assert.match(
    toastMsg,
    /metcoulous→meticulous/,
    `metcoulous should suggest meticulous, got: ${toastMsg}`,
  )
  api.lifecycle.disposer?.()
})

await test("does not flag bare relative paths or bare filenames", async () => {
  const { default: plugin } = await import(bundlePath)
  let toastMsg = null
  const { api, getAppendHandler } = makeBaseApi({
    ui: { toast: (msg) => { toastMsg = msg.message } },
  })
  plugin.tui(api, { debounceMs: 10, showStatusLine: true, minLength: 3 })
  await new Promise((r) => setTimeout(r, 30))
  await typeIntoBuffer(
    getAppendHandler(),
    "please fix the bug in src/engine.ts and update config.yaml today",
  )
  assert.equal(toastMsg, null, `expected no toast, got: ${toastMsg}`)
  api.lifecycle.disposer?.()
})

await test("does not flag paths surrounded by punctuation", async () => {
  const { default: plugin } = await import(bundlePath)
  let toastMsg = null
  const { api, getAppendHandler } = makeBaseApi({
    ui: { toast: (msg) => { toastMsg = msg.message } },
  })
  plugin.tui(api, { debounceMs: 10, showStatusLine: true, minLength: 3 })
  await new Promise((r) => setTimeout(r, 30))
  await typeIntoBuffer(getAppendHandler(), 'please review (src/engine.ts) and "lib/util.ts"')
  assert.equal(toastMsg, null, `expected no toast, got: ${toastMsg}`)
  api.lifecycle.disposer?.()
})

// ---------------------------------------------------------------------
// notify() fallback when the primary toast surfaces are both absent
// ---------------------------------------------------------------------

await test("falls back to a legacy notifier when ui.toast/toast are absent", async () => {
  const { default: plugin } = await import(bundlePath)
  let legacyMsg = null
  const { api, getAppendHandler } = makeBaseApi({
    notify: (msg) => { legacyMsg = msg },
  })
  plugin.tui(api, { debounceMs: 10, showStatusLine: true, minLength: 3 })
  await new Promise((r) => setTimeout(r, 30))
  await typeIntoBuffer(getAppendHandler(), "this has a recieve typo")
  assert.ok(legacyMsg, "expected the legacy api.notify fallback to fire")
  api.lifecycle.disposer?.()
})

// ---------------------------------------------------------------------
// Slot-based path: session prop forwarding, ref polling, and disposal
// ---------------------------------------------------------------------

await test("session_prompt forwards props, debounces polling, and disposes cleanly", async () => {
  const { default: plugin } = await import(bundlePath)
  let promptCallProps = null
  const Prompt = (props) => {
    promptCallProps = props
    return null
  }
  let registeredSlots = null
  let toastMsg = null
  const { api } = makeBaseApi({
    ui: { toast: (msg) => { toastMsg = msg.message }, Prompt },
    slots: {
      register: (cfg) => {
        registeredSlots = cfg.slots
        return "slot-123"
      },
    },
  })
  plugin.tui(api, { debounceMs: 10, showStatusLine: true, minLength: 3 })
  await new Promise((r) => setTimeout(r, 30))

  assert.ok(registeredSlots?.session_prompt, "expected session_prompt slot to be registered")

  registeredSlots.session_prompt(
    {},
    {
      session_id: "sess-abc",
      on_submit: () => {},
      visible: true,
      disabled: false,
      ref: () => {}, // the host's own downstream ref callback, unused here
    },
  )
  assert.equal(promptCallProps?.sessionID, "sess-abc", "sessionID was not forwarded to Prompt")
  assert.equal(typeof promptCallProps?.onSubmit, "function", "onSubmit was not forwarded to Prompt")
  assert.equal(promptCallProps?.visible, true, "visible was not forwarded to Prompt")

  // Simulate the (mocked) Prompt component invoking the ref it was given,
  // the way the real component does on mount, then typing a typo into it.
  const mockRefTarget = { current: { input: "" } }
  promptCallProps.ref(mockRefTarget)
  mockRefTarget.current.input = "please recieve this"
  await new Promise((r) => setTimeout(r, 100))

  assert.ok(toastMsg, "expected the ref-polling path to detect the typo and toast")
  assert.match(toastMsg, /recieve→receive/, `expected recieve→receive, got: ${toastMsg}`)

  assert.doesNotThrow(() => api.lifecycle.disposer?.(), "cleanup should not throw")
})

await test("clearing and retyping a typo produces a new notification", async () => {
  const { default: plugin } = await import(bundlePath)
  let promptCallProps = null
  let toastCount = 0
  const Prompt = (props) => {
    promptCallProps = props
    return null
  }
  const { api } = makeBaseApi({
    ui: { toast: () => { toastCount++ }, Prompt },
    slots: { register: (cfg) => { promptCallProps = null; api.slots.registered = cfg.slots; return "slot-456" } },
  })
  plugin.tui(api, { debounceMs: 10, showStatusLine: true, minLength: 3 })
  await new Promise((r) => setTimeout(r, 30))
  api.slots.registered.session_prompt({}, { session_id: "sess-abc" })
  const ref = { current: { input: "" } }
  promptCallProps.ref(ref)

  ref.current.input = "please recieve this"
  await new Promise((r) => setTimeout(r, 100))
  ref.current.input = ""
  await new Promise((r) => setTimeout(r, 100))
  ref.current.input = "please recieve this"
  await new Promise((r) => setTimeout(r, 100))

  assert.equal(toastCount, 2, "retyping after a clear should notify again")
  api.lifecycle.disposer?.()
})

console.log("")
if (failures > 0) {
  console.log(`❌ ${failures} test(s) failed.`)
  process.exit(1)
}
console.log("✅ all tests passed.")
process.exit(0)
