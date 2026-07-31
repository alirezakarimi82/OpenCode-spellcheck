// Ambient stubs for optional runtime dependencies. The real types come from the
// packages themselves once installed via `bun install` in the OpenCode env.
declare module "nspell" {
  interface Nspell {
    correct(word: string): boolean
    suggest(word: string): string[]
    add(word: string): void
  }
  function nspell(dict: { aff: Buffer; dic: Buffer }): Nspell
  export default nspell
}

declare module "dictionary-en" {
  const dictionary: unknown
  export default dictionary
}
