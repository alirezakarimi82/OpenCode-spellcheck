/**
 * engine.ts
 * ---------
 * A thin, resilient wrapper around a Hunspell-backed spell checker (`nspell`
 * + `dictionary-en`). It adds:
 *   - a per-word LRU-ish result cache (checking is called on every keystroke)
 *   - a project vocabulary supplied through the plugin's `extraWords` option
 *   - lazy async initialisation that never throws into the TUI render loop
 *
 * If the optional dependencies are unavailable, the engine degrades to a
 * no-op (returns "everything is spelled correctly") so the plugin can never
 * break the prompt.
 */

export interface SpellResult {
  correct: boolean
  suggestions: string[]
}

export type Nspell = {
  correct(word: string): boolean
  suggest(word: string): string[]
}

export interface HunspellData {
  aff: Uint8Array | Buffer
  dic: Uint8Array | Buffer
}

export interface EngineOptions {
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
  private readonly dictionaryOpt?: EngineOptions["dictionary"]
  private readonly nspellFactory?: EngineOptions["nspellFactory"]
  public available = false

  constructor(opts: EngineOptions = {}) {
    this.maxSuggestions = opts.maxSuggestions ?? 5
    this.dictionaryOpt = opts.dictionary
    this.nspellFactory = opts.nspellFactory
    for (const w of opts.extraWords ?? []) this.personal.add(w.toLowerCase())
    this.ready = this.init()
  }

  private async init(): Promise<void> {
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
    let suggestions: string[] = []
    if (!correct) {
      // Only pay for nspell.suggest() — the expensive part of a Hunspell
      // check — when the word actually needs a correction; most words in
      // real prose are already correct. Rank the *full* raw candidate list
      // before truncating to maxSuggestions, so a strong match that isn't
      // in nspell's own top N doesn't get discarded before it's compared.
      suggestions = this._rankSuggestions(word, this.nspell.suggest(word)).slice(
        0,
        this.maxSuggestions,
      )
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
   * Uses Damerau-Levenshtein edit distance — insertions, deletions,
   * substitutions, and *adjacent transpositions* each cost one edit.
   *
   * A pure longest-common-subsequence measure is blind to transpositions:
   * "teh" is a perfect, order-preserving subsequence of "tech" (LCS ratio
   * 1.0 — just insert a "c"), but only a partial match against "the" (the
   * swap breaks the subsequence), even though "the" is exactly as close a
   * fix — one transposition — as "tech" is one insertion. Edit distance
   * alone fixes that, but real Hunspell suggestion lists also contain a
   * pile of single-*substitution* candidates the same distance away (for
   * "teh": ten, tea, ted, tel, tex, ...) — so distance alone leaves "the"
   * tied with all of them. Adjacent transpositions are overwhelmingly the
   * most common typo type in practice, so they get a small tiebreaking
   * bonus among equal-distance candidates; the length-difference term
   * breaks any remaining ties by preferring the candidate closest in
   * length to the typo.
   */
  private _scoreSuggestion(target: string, suggestion: string): number {
    const s = suggestion.toLowerCase()
    const dist = this._editDistance(target, s)
    const lenDiff = Math.abs(s.length - target.length)
    const transposition = this._isAdjacentTransposition(target, s) ? 10 : 0
    return dist * 100 + lenDiff - transposition
  }

  /**
   * True if `b` is exactly `a` with one pair of adjacent letters swapped
   * (and otherwise identical) — the "teh"/"the" case specifically, as
   * opposed to a substitution, insertion, or deletion that happens to cost
   * the same single edit.
   */
  private _isAdjacentTransposition(a: string, b: string): boolean {
    if (a.length !== b.length) return false
    let i = 0
    while (i < a.length && a[i] === b[i]) i++
    if (i >= a.length - 1) return false
    return (
      a[i] === b[i + 1] &&
      a[i + 1] === b[i] &&
      a.slice(i + 2) === b.slice(i + 2)
    )
  }

  /**
   * Damerau-Levenshtein edit distance (restricted / "optimal string
   * alignment" variant): the minimum number of insertions, deletions,
   * substitutions, and adjacent-pair transpositions needed to turn `a`
   * into `b`.
   */
  private _editDistance(a: string, b: string): number {
    const m = a.length
    const n = b.length
    const d: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))

    for (let i = 0; i <= m; i++) d[i][0] = i
    for (let j = 0; j <= n; j++) d[0][j] = j

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1
        d[i][j] = Math.min(
          d[i - 1][j] + 1, // deletion
          d[i][j - 1] + 1, // insertion
          d[i - 1][j - 1] + cost, // substitution
        )
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1) // transposition
        }
      }
    }
    return d[m][n]
  }

}
