import os from "node:os"
import path from "node:path"
import { appendFileSync } from "node:fs"

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
  __assets?: {
    nspellFactory?: (dict: any) => any
    dictionary?: () => Promise<any> | any
  }
}

export default {
  id: PLUGIN_ID,
  async tui(api: any, options?: Options, meta?: any) {
    const debug = (msg: string) => {
      try {
        appendFileSync(
          "/tmp/spellcheck-debug.log",
          `[${new Date().toISOString()}] ${msg}\n`,
        )
      } catch {}
    }
    debug(
      `tui() entry. slots=${typeof api?.slots?.register} toast=${typeof api?.ui?.toast} Prompt=${typeof api?.ui?.Prompt}`,
    )
    const debounceMs = options?.debounceMs ?? DEBOUNCE_MS
    const wantStatus = options?.showStatusLine ?? true
    const minLength = options?.minLength ?? 3
    const toastDuration = options?.toastDuration ?? 6000

    const personalDictPath = path.join(
      process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "opencode",
      "spellcheck-dictionary.txt",
    )

    const engine = new SpellEngine({
      personalDictPath,
      extraWords: options?.extraWords,
      nspellFactory: options?.__assets?.nspellFactory,
      dictionary: options?.__assets?.dictionary,
    })

    // Poller state
    let pollHandle: ReturnType<typeof setInterval> | null = null
    let capturedRef: any = null
    let lastInput = ""
    let lastToastSignature = ""

    const readInput = (): string => {
      const ref = capturedRef
      if (!ref) return ""
      try {
        const v = ref.current?.input
        if (typeof v === "string") return v
        if (typeof ref.input === "string") return ref.input
      } catch {}
      return ""
    }

    const startPolling = () => {
      if (pollHandle) clearInterval(pollHandle)
      pollHandle = setInterval(runPoll, 300)
    }

    const runPoll = () => {
      if (!engine.available) return
      const input = readInput()
      if (!input || input === lastInput) return
      lastInput = input
      debug(`poll input=${JSON.stringify(input.slice(0, 80))}`)
      const tokens = tokenize(input, { minLength })
      const bad: Token[] = []
      for (const t of tokens) {
        if (!engine.check(t.word).correct) bad.push(t)
      }
      debug(`poll bad=${JSON.stringify(bad.map((t: Token) => t.word))}`)

      if (wantStatus && bad.length > 0) {
        const sig = `${bad.length}:${bad.slice(0, 8).map((t: Token) => t.word).join("|")}`
        if (sig !== lastToastSignature) {
          const shown = bad.slice(0, 5).map((t: Token) => {
            const s = engine.check(t.word).suggestions[0]
            return s ? `${t.word}\u2192${s}` : t.word
          }).join("  ")
          const more = bad.length > 5 ? ` (+${bad.length - 5})` : ""
          notify(api, `\u270e ${bad.length} typo(s): ${shown}${more}`, undefined, toastDuration)
          lastToastSignature = sig
        }
      } else {
        lastToastSignature = ""
      }
    }

    // Register home_prompt / session_prompt to capture the prompt ref.
    // We render api.ui.Prompt to preserve the host's normal prompt UI while
    // intercepting the ref for polling.
    let disposeSlots: (() => void) | null = null
    if (api?.slots?.register && api?.ui?.Prompt) {
      const Prompt = api.ui.Prompt
      const wrapPrompt = (_ctx: any, props: any) => {
        const hostRef = props?.ref
        const ourRef = (r: any) => {
          capturedRef = r && (r.current || r) ? r : null
          if (capturedRef) startPolling()
          try { hostRef?.(r) } catch {}
        }
        return Prompt({ ref: ourRef } as any) as unknown as any
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
        disposeSlots = () => {
          try { stopPolling(); api.slots.unregister?.(slotId) } catch {}
        }
      } catch (e: any) {
        debug(`slots error: ${e?.message ?? e}`)
      }
    }

    // Event listeners for buffer tracking (backup approach)
    const disposableEvents: Array<() => void> = []
    let promptBuffer = ""
    let lastCheckBuf = ""
    let lastBufSignature = ""

    const runBufferCheck = async () => {
      if (promptBuffer === lastCheckBuf) return
      lastCheckBuf = promptBuffer
      await engine.whenReady()
      const tokens = tokenize(promptBuffer, { minLength })
      const bad: Token[] = []
      for (const t of tokens) {
        if (!engine.check(t.word).correct) bad.push(t)
      }
      if (wantStatus && bad.length) {
        const sig = `${bad.length}:${bad.slice(0, 8).map((t: Token) => t.word).join("|")}`
        if (sig !== lastToastSignature) {
          const msg = buildToastMsg(bad)
          notify(api, msg, null, toastDuration)
          lastToastSignature = sig
        }
      }
    }

    let bufTimer: any = null
    const scheduleBuf = () => {
      if (bufTimer) clearTimeout(bufTimer)
      bufTimer = setTimeout(runBufferCheck, debounceMs)
    }

    function buildToastMsg(bad: Token[]): string {
      const shown = bad.slice(0, 5).map((t: Token) => {
        const s = engine.check(t.word).suggestions[0]
        return s ? `${t.word}\u2192${s}` : t.word
      }).join("  ")
      const more = bad.length > 5 ? ` (+${bad.length - 5})` : ""
      return `\u270e ${bad.length} typo(s): ${shown}${more}`
    }

    try {
      const off1 = api.event.on("tui.prompt.append", (e: any) => {
        const t = e?.properties?.text ?? ""
        if (typeof t === "string") promptBuffer += t
        scheduleBuf()
      })
      disposableEvents.push(off1)

      const off2 = api.event.on("tui.command.execute", (e: any) => {
        if (e?.properties?.command === "prompt.clear") {
          promptBuffer = ""; lastCheckBuf = ""; lastToastSignature = ""
        }
      })
      disposableEvents.push(off2)

      const off3 = api.event.on("tui.session.select", () => {
        promptBuffer = ""; lastCheckBuf = ""; lastToastSignature = ""
      })
      disposableEvents.push(off3)
    } catch (e: any) {
      debug(`event listeners error: ${e?.message ?? e}`)
    }

    // Cleanup
    const onDispose = api?.lifecycle?.onDispose
    const cleanup = () => {
      if (pollHandle) clearInterval(pollHandle)
      if (bufTimer) clearTimeout(bufTimer)
      if (disposeSlots) try { disposeSlots() } catch {}
      for (const d of disposableEvents) try { d() } catch {}
      try { onDispose?.() } catch {}
    }
    if (onDispose) onDispose(cleanup)
  },
}