import { createSignal } from "solid-js"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { tokenize, type Token } from "./tokenizer"
import type { SpellEngine } from "./engine"

export interface SpellIssueView {
  word: string
  suggestion?: string
}

// Shared reactive state used by the SpellStatusLine slot component.
const [issues, setIssues] = createSignal<SpellIssueView[]>([])

export let _engineRef: SpellEngine | null = null
let _minLength = 3
let _getInput: (() => string | null) | null = null
let _pollHandle: ReturnType<typeof setInterval> | null = null
let _lastInput = ""

export function initSpellStatus(
  engine: SpellEngine,
  opts: { minLength: number; getInput?: () => string | null },
): void {
  _engineRef = engine
  _minLength = opts.minLength
  _getInput = opts.getInput ?? null
  startPolling()
}

export function stopSpellPolling(): void {
  if (_pollHandle) clearInterval(_pollHandle)
  _pollHandle = null
}

function startPolling(): void {
  if (_pollHandle) clearInterval(_pollHandle)
  _pollHandle = setInterval(runPoll, 300)
}

function runPoll(): void {
  const engine = _engineRef
  if (!engine || !engine.available) return
  const input = _getInput?.()
  if (!input || input === _lastInput) return
  _lastInput = input
  const tokens = tokenize(input, { minLength: _minLength })
  const bad: Token[] = []
  for (const t of tokens) {
    if (!engine.check(t.word).correct) bad.push(t)
  }
  setIssues(
    bad.map((t) => ({
      word: t.word,
      suggestion: engine.check(t.word).suggestions[0],
    })),
  )
}

/** Slot renderer for `home_prompt_right` / `session_prompt_right`. */
export function SpellStatusLine(): JSX.Element {
  return (
    <text>
      {(() => {
        const list = issues()
        if (list.length === 0) return <text fg="green">✓</text>
        const shown = list.slice(0, 5)
        const more = list.length > 5 ? ` (+${list.length - 5})` : ""
        const nodes: JSX.Element[] = []
        nodes.push(
          <text fg="yellow">{`✎ ${list.length} `}</text> as unknown as JSX.Element,
        )
        shown.forEach((it, i) => {
          if (i > 0)
            nodes.push(<text>{"  "}</text> as unknown as JSX.Element)
          nodes.push(<text fg="red">{it.word}</text> as unknown as JSX.Element)
          if (it.suggestion) {
            nodes.push(<text fg="gray">→</text> as unknown as JSX.Element)
            nodes.push(
              <text fg="green">{it.suggestion}</text> as unknown as JSX.Element,
            )
          }
        })
        nodes.push(<text fg="gray">{more}</text> as unknown as JSX.Element)
        return nodes as unknown as JSX.Element
      })()}
    </text>
  ) as unknown as JSX.Element
}