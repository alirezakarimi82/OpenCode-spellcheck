/**
 * prompt-adapter.ts
 * -----------------
 * OpenCode's TUI plugin surface (`@opencode-ai/plugin/tui`) is officially in
 * BETA and its exact shape shifts between releases. To keep this plugin robust
 * we never hard-depend on a single method name: we *feature-detect* against
 * whatever `api` object the running OpenCode hands us.
 *
 * Inline extmark decoration was attempted but the prompt-extmark surface is not
 * exposed to TUI plugins in opencode v1.18.x, so this module now only provides
 * `notify()` (toast) — the guaranteed-working status baseline. The tokenizer +
 * engine still detect misspellings; we surface them via toasts instead of
 * drawing on the prompt.
 */

/** Surface a short message via the real `api.ui.toast(...)` (TuiToast). */
export function notify(
  api: any,
  message: string,
  title?: string | null,
  duration?: number,
): void {
  const t = api?.ui?.toast
  if (typeof t === "function") {
    try {
      t({ variant: "warning", title: title ?? "Spelling", message, duration: duration ?? 6000 })
      return
    } catch {
      /* fall through */
    }
  }
  // Legacy / alternate shapes, kept for forward-compat.
  //
  // Each candidate returns whether it actually found and invoked a function,
  // not just whether the call avoided throwing. Optional chaining alone
  // can't tell "this method doesn't exist" apart from "it exists and
  // succeeded" — both simply don't throw — so a naive `n(); return` loop
  // stops after the very first candidate regardless of whether `api.toast`
  // was really there. Explicitly checking `typeof fn === "function"` first
  // (matching the primary `api.ui.toast` check above) lets the probe
  // actually fall through to a working candidate further down the list.
  const notifiers: Array<() => boolean> = [
    () => {
      const fn = api?.toast
      if (typeof fn !== "function") return false
      fn({ title, message })
      return true
    },
    () => {
      const fn = api?.toast?.show
      if (typeof fn !== "function") return false
      fn(message)
      return true
    },
    () => {
      const fn = api?.notify
      if (typeof fn !== "function") return false
      fn(message)
      return true
    },
    () => {
      const fn = api?.attention?.notify
      if (typeof fn !== "function") return false
      fn({ message })
      return true
    },
    () => {
      const fn = api?.status?.set
      if (typeof fn !== "function") return false
      fn(message)
      return true
    },
  ]
  for (const n of notifiers) {
    try {
      if (n()) return
    } catch {
      /* this candidate exists but threw — keep probing */
    }
  }
}
