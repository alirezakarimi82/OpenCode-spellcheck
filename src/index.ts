import { appendFileSync } from "node:fs"
import type { TuiPluginApi, TuiPromptRef } from "@opencode-ai/plugin/tui"

import { SpellEngine } from "./engine"
import { tokenize, type Token } from "./tokenizer"
import { notify } from "./prompt-adapter"

const PLUGIN_ID = "spellcheck"
const DEBOUNCE_MS = 250

interface Options {
  debounceMs?: number
  extraWords?: string[]
  showStatusLine?: boolean
  inlineHighlight?: boolean
  minLength?: number
  toastDuration?: number
  /**
   * Write timing/diagnostic info to /tmp/spellcheck-debug.log. Off by
   * default: this was previously an unconditional synchronous file write
   * on every keystroke-driven check, which also logs prompt text verbatim.
   * Opt in only when actually debugging the plugin itself.
   */
  debugLog?: boolean
  __assets?: {
    nspellFactory?: (dict: any) => any
    dictionary?: () => Promise<any> | any
  }
}

export default {
  id: PLUGIN_ID,
  async tui(api: TuiPluginApi, options?: Options, meta?: any) {
    const debug = options?.debugLog
      ? (msg: string) => {
          try {
            appendFileSync(
              "/tmp/spellcheck-debug.log",
              `[${new Date().toISOString()}] ${msg}\n`,
            )
          } catch {}
        }
      : (_msg: string) => {}
    debug(
      `tui() entry. slots=${typeof api?.slots?.register} toast=${typeof api?.ui?.toast} Prompt=${typeof api?.ui?.Prompt}`,
    )
    const configuredDebounce = options?.debounceMs ?? DEBOUNCE_MS
    const debounceMs = Number.isFinite(configuredDebounce)
      ? Math.max(0, configuredDebounce)
      : DEBOUNCE_MS
    const wantStatus = options?.showStatusLine ?? true
    const configuredMinLength = options?.minLength ?? 3
    const minLength = Number.isFinite(configuredMinLength)
      ? Math.max(1, Math.floor(configuredMinLength))
      : 3
    const configuredToastDuration = options?.toastDuration ?? 6000
    const toastDuration = Number.isFinite(configuredToastDuration)
      ? Math.max(0, configuredToastDuration)
      : 6000

    const engine = new SpellEngine({
      extraWords: Array.isArray(options?.extraWords)
        ? options.extraWords.filter((word): word is string => typeof word === "string")
        : [],
      nspellFactory: options?.__assets?.nspellFactory,
      dictionary: options?.__assets?.dictionary,
    })

    // Poller state
    let pollHandle: ReturnType<typeof setInterval> | null = null
    let pollDebounceHandle: ReturnType<typeof setTimeout> | null = null
    let capturedRef: TuiPromptRef | null = null
    let lastInput = ""
    let lastToastSignature = ""

    const readInput = (): string => {
      const ref = capturedRef
      if (!ref) return ""
      try {
        const v = ref.current?.input
        if (typeof v === "string") return v
        const legacyRef = ref as unknown as { input?: unknown }
        if (typeof legacyRef.input === "string") return legacyRef.input
      } catch {}
      return ""
    }

    const startPolling = () => {
      if (pollHandle) clearInterval(pollHandle)
      pollHandle = setInterval(runPoll, 50)
      runPoll()
    }

    const stopPolling = () => {
      if (pollHandle) clearInterval(pollHandle)
      pollHandle = null
      if (pollDebounceHandle) clearTimeout(pollDebounceHandle)
      pollDebounceHandle = null
    }

    function buildToastMsg(bad: Token[]): string {
      const shown = bad.slice(0, 5).map((t: Token) => {
        const s = engine.check(t.word).suggestions[0]
        return s ? `${t.word}\u2192${s}` : t.word
      }).join("  ")
      const more = bad.length > 5 ? ` (+${bad.length - 5})` : ""
      return `\u270e ${bad.length} typo(s): ${shown}${more}`
    }

    // Shared by both tracking strategies below so a clean check always
    // resets the dedup signature the same way. This used to be duplicated
    // inline in each strategy, and the buffer-based one was missing the
    // "no typos -> reset signature" branch, so re-typing an
    // already-shown-then-fixed typo wouldn't re-notify the second time.
    const notifyIfTypos = (bad: Token[]) => {
      if (wantStatus && bad.length > 0) {
        const sig = `${bad.length}:${bad.slice(0, 8).map((t: Token) => t.word).join("|")}`
        if (sig !== lastToastSignature) {
          notify(api, buildToastMsg(bad), undefined, toastDuration)
          lastToastSignature = sig
        }
      } else {
        lastToastSignature = ""
      }
    }

    const checkPolledInput = (input: string) => {
      if (!engine.available) return
      debug(`poll input=${JSON.stringify(input.slice(0, 80))}`)
      const tokens = tokenize(input, { minLength })
      const bad: Token[] = []
      for (const t of tokens) {
        if (!engine.check(t.word).correct) bad.push(t)
      }
      debug(`poll bad=${JSON.stringify(bad.map((t: Token) => t.word))}`)
      notifyIfTypos(bad)
    }

    const runPoll = () => {
      if (!engine.available) return
      const input = readInput()
      if (input === lastInput) return
      lastInput = input
      if (!input) {
        notifyIfTypos([])
        return
      }
      if (pollDebounceHandle) clearTimeout(pollDebounceHandle)
      pollDebounceHandle = setTimeout(() => {
        pollDebounceHandle = null
        // A newer keystroke may have arrived while this timer was pending.
        if (readInput() === input) checkPolledInput(input)
      }, debounceMs)
    }

    // Register home_prompt / session_prompt to capture the prompt ref.
    // We render api.ui.Prompt to preserve the host's normal prompt UI while
    // intercepting the ref for polling. `usingSlotStrategy` also gates the
    // event-based fallback further down so the two tracking strategies
    // never run concurrently against the same prompt.
    let disposeSlots: (() => void) | null = null
    let usingSlotStrategy = false
    if (api?.slots?.register && api?.ui?.Prompt) {
      const Prompt = api.ui.Prompt
      const wrapPrompt = (_ctx: any, props: any) => {
        const hostRef = props?.ref
        const ourRef = (r: TuiPromptRef | undefined) => {
          capturedRef = r || null
          if (capturedRef) startPolling()
          try { hostRef?.(r) } catch {}
        }
        // The slot map hands us snake_case fields (session_id, on_submit)
        // that don't match Prompt's own camelCase props (sessionID,
        // onSubmit) — they must be translated explicitly, not spread
        // through as-is, or the real Prompt component never learns which
        // session it's rendering for. Dropping sessionID here (the
        // previous `Prompt({ ref: ourRef })`) is what caused resumed
        // sessions to render with no continuation context.
        return Prompt({
          sessionID: props?.session_id,
          onSubmit: props?.on_submit,
          visible: props?.visible,
          disabled: props?.disabled,
          ref: ourRef,
        } as any) as unknown as any
      }
      try {
        const slotId = api.slots.register({
          order: 300,
          slots: {
            home_prompt: wrapPrompt,
            session_prompt: wrapPrompt,
          },
        })
        debug(`slots ok id=${JSON.stringify(slotId)}`)
        usingSlotStrategy = true
        // Slot registrations are scoped to the plugin lifecycle by OpenCode;
        // there is intentionally no public unregister API.
        disposeSlots = () => stopPolling()
      } catch (e: any) {
        debug(`slots error: ${e?.message ?? e}`)
      }
    }

    // Event-based buffer tracking — a *true* fallback now: the append
    // listener only registers when the slot/ref strategy above isn't
    // available, so the two approaches never run at once (they used to,
    // sharing lastToastSignature between two different reconstructions of
    // the prompt buffer, risking duplicate work and inconsistent toasts).
    // The clear/session listeners still register either way since they
    // only reset shared dedup state, which is safe and useful regardless
    // of which tracking strategy is active.
    const disposableEvents: Array<() => void> = []
    let promptBuffer = ""
    let lastCheckBuf = ""

    const runBufferCheck = async () => {
      if (promptBuffer === lastCheckBuf) return
      lastCheckBuf = promptBuffer
      await engine.whenReady()
      const tokens = tokenize(promptBuffer, { minLength })
      const bad: Token[] = []
      for (const t of tokens) {
        if (!engine.check(t.word).correct) bad.push(t)
      }
      notifyIfTypos(bad)
    }

    let bufTimer: any = null
    const scheduleBuf = () => {
      if (bufTimer) clearTimeout(bufTimer)
      bufTimer = setTimeout(runBufferCheck, debounceMs)
    }

    try {
      if (!usingSlotStrategy) {
        const off1 = api.event.on("tui.prompt.append", (e: any) => {
          const t = e?.properties?.text ?? ""
          if (typeof t === "string") promptBuffer += t
          scheduleBuf()
        })
        disposableEvents.push(off1)
      }

      const off2 = api.event.on("tui.command.execute", (e: any) => {
        if (e?.properties?.command === "prompt.clear") {
          promptBuffer = ""; lastCheckBuf = ""; lastInput = ""; lastToastSignature = ""
          if (pollDebounceHandle) clearTimeout(pollDebounceHandle)
          pollDebounceHandle = null
        }
      })
      disposableEvents.push(off2)

      const off3 = api.event.on("tui.session.select", () => {
        promptBuffer = ""; lastCheckBuf = ""; lastInput = ""; lastToastSignature = ""
        if (pollDebounceHandle) clearTimeout(pollDebounceHandle)
        pollDebounceHandle = null
      })
      disposableEvents.push(off3)
    } catch (e: any) {
      debug(`event listeners error: ${e?.message ?? e}`)
    }

    // Cleanup
    const onDispose = api?.lifecycle?.onDispose
    const cleanup = () => {
      stopPolling()
      if (bufTimer) clearTimeout(bufTimer)
      if (disposeSlots) try { disposeSlots() } catch {}
      for (const d of disposableEvents) try { d() } catch {}
    }
    if (onDispose) onDispose(cleanup)
  },
}
