/**
 * engine.ts
 * ---------
 * A thin, resilient wrapper around a Hunspell-backed spell checker (`nspell`
 * + `dictionary-en`). It adds:
 *   - a per-word LRU-ish result cache (checking is called on every keystroke)
 *   - a user "personal dictionary" (words you add are never flagged again)
 *   - lazy async initialisation that never throws into the TUI render loop
 *
 * If the optional dependencies are unavailable, the engine degrades to a
 * no-op (returns "everything is spelled correctly") so the plugin can never
 * break the prompt.
 */

import { promises as fs } from "node:fs"
import path from "node:path"

export interface SpellResult {
  correct: boolean
  suggestions: string[]
}

export type Nspell = {
  correct(word: string): boolean
  suggest(word: string): string[]
  add(word: string): void
}

export interface HunspellData {
  aff: Uint8Array | Buffer
  dic: Uint8Array | Buffer
}

export interface EngineOptions {
  /** absolute path to a newline-delimited personal dictionary file */
  personalDictPath?: string
  /** extra words to always accept (e.g. project jargon: CAISO, BESS, ...) */
  extraWords?: string[]
  /** max suggestions to compute per word */
  maxSuggestions?: number
  /**
   * Pre-loaded Hunspell data. When provided (the *bundled* build supplies this
   * from embedded, gzip-compressed data) the engine skips the dynamic import of
   * `dictionary-en`, making the plugin fully self-contained.
   */
  dictionary?: HunspellData | (() => Promise<HunspellData>)
  /**
   * Factory that builds an Nspell instance from Hunspell data. The bundled
   * build passes the statically-imported `nspell` here so esbuild inlines it.
   */
  nspellFactory?: (dict: HunspellData) => Nspell
}

export class SpellEngine {
  private nspell: Nspell | null = null
  private ready: Promise<void>
  private cache = new Map<string, SpellResult>()
  private personal = new Set<string>()
  private readonly maxSuggestions: number
  private readonly personalDictPath?: string
  private readonly dictionaryOpt?: EngineOptions["dictionary"]
  private readonly nspellFactory?: EngineOptions["nspellFactory"]
  public available = false

  constructor(opts: EngineOptions = {}) {
    this.maxSuggestions = opts.maxSuggestions ?? 5
    this.personalDictPath = opts.personalDictPath
    this.dictionaryOpt = opts.dictionary
    this.nspellFactory = opts.nspellFactory
    for (const w of opts.extraWords ?? []) this.personal.add(w.toLowerCase())
    this.ready = this.init()
  }

  private async init(): Promise<void> {
    // Load personal dictionary first (cheap, always safe).
    if (this.personalDictPath) {
      try {
        const raw = await fs.readFile(this.personalDictPath, "utf8")
        for (const line of raw.split("\n")) {
          const w = line.trim().toLowerCase()
          if (w) this.personal.add(w)
        }
      } catch {
        /* file may not exist yet – fine */
      }
    }

    // Resolve the Hunspell data and an Nspell factory. The bundled build injects
    // both (embedded dictionary + statically-imported nspell); dev/source mode
    // falls back to dynamic imports so a missing dep can never crash the TUI.
    try {
      const factory =
        this.nspellFactory ??
        (((await import("nspell")) as any).default as EngineOptions["nspellFactory"])

      let dict: HunspellData
      if (this.dictionaryOpt) {
        dict =
          typeof this.dictionaryOpt === "function"
            ? await this.dictionaryOpt()
            : this.dictionaryOpt
      } else {
        const mod: any = await import("dictionary-en")
        const maybe = mod.default ?? mod
        dict = await new Promise<HunspellData>((resolve, reject) => {
          // dictionary-en exports either a callback fn or a promise of {aff,dic}
          if (typeof maybe === "function") {
            maybe((err: Error | null, d: any) => (err ? reject(err) : resolve(d)))
          } else {
            Promise.resolve(maybe).then(resolve, reject)
          }
        })
      }

      this.nspell = factory!(dict) as Nspell
      this.available = true
    } catch (err) {
      // Optional deps not installed → graceful no-op mode.
      this.available = false
    }
  }

  /** Wait until initialisation has settled. */
  async whenReady(): Promise<void> {
    await this.ready
  }

  /**
   * Synchronous check used inside the render/keystroke path. Returns a cached
   * or freshly-computed result. If the engine isn't ready yet it optimistically
   * reports "correct" (nothing is flagged until the dictionary is loaded).
   */
  check(word: string): SpellResult {
    const key = word.toLowerCase()
    if (this.personal.has(key)) return { correct: true, suggestions: [] }
    if (!this.nspell) return { correct: true, suggestions: [] }

    const cached = this.cache.get(key)
    if (cached) return cached

    const correct = this.nspell.correct(word) || this.nspell.correct(key)
    let suggestions = this.nspell.suggest(word).slice(0, this.maxSuggestions)
    
    // Improve suggestion ordering for common typo patterns
    if (!correct && suggestions.length > 0) {
      suggestions = this._rankSuggestions(word, suggestions)
    }

    const result: SpellResult = correct
      ? { correct: true, suggestions: [] }
      : {
          correct: false,
          suggestions,
        }

    // Keep the cache from growing without bound.
    if (this.cache.size > 5000) this.cache.clear()
    this.cache.set(key, result)
    return result
  }

  /**
   * Re-rank spellcheck suggestions to prioritize more likely corrections.
   * Common typos like "recive" should suggest "receive" first, not "revive".
   */
  private _rankSuggestions(word: string, suggestions: string[]): string[] {
    const target = word.toLowerCase()
    
    return suggestions.sort((a, b) => {
      const scoreA = this._scoreSuggestion(target, a)
      const scoreB = this._scoreSuggestion(target, b)
      return scoreA - scoreB
    })
  }

  /**
   * Score a suggestion: lower is better (more likely to be the correct fix).
   * Uses longest common subsequence (LCS) to measure letter preservation.
   * A higher LCS ratio means more letters from the original word are preserved,
   * which is a strong signal that the suggestion is a valid typo fix.
   */
  private _scoreSuggestion(target: string, suggestion: string): number {
    const s = suggestion.toLowerCase()
    
    // Calculate longest common subsequence
    const lcs = this._lcsLength(target, s)
    const lcsRatio = lcs / target.length
    
    let score = 0
    
    // Strong bonus for high LCS ratio (preserved letters in order)
    score -= lcsRatio * 100
    
    // Moderate penalty for length differences (common typos usually differ by 1 char)
    const lenDiff = Math.abs(s.length - target.length)
    if (lenDiff > 1) {
      score += lenDiff * 20
    }
    
    return score
  }

  /**
   * Calculate length of longest common subsequence between two strings.
   * Used to measure how many letters from the original word are preserved
   * in the suggestion (in the same relative order).
   */
  private _lcsLength(a: string, b: string): number {
    const m = a.length
    const n = b.length
    const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
    
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1])
        }
      }
    }
    return dp[m][n]
  }

  /** Add a word to the in-memory + on-disk personal dictionary. */
  async addWord(word: string): Promise<void> {
    const key = word.toLowerCase()
    if (this.personal.has(key)) return
    this.personal.add(key)
    this.cache.delete(key)
    this.nspell?.add(word)
    if (this.personalDictPath) {
      try {
        await fs.mkdir(path.dirname(this.personalDictPath), { recursive: true })
        await fs.appendFile(this.personalDictPath, word + "\n", "utf8")
      } catch {
        /* non-fatal */
      }
    }
  }
}
