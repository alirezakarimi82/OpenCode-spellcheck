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
  const notifiers: Array<() => unknown> = [
    () => api?.toast?.({ title, message }),
    () => api?.toast?.show?.(message),
    () => api?.notify?.(message),
    () => api?.attention?.notify?.({ message }),
    () => api?.status?.set?.(message),
  ]
  for (const n of notifiers) {
    try {
      n()
      return
    } catch {
      /* keep probing */
    }
  }
}
