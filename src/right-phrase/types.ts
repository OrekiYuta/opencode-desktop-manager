export type RightPhraseMode = "say" | "reply"

export interface PhraseOption {
  tone: string
  english: string
  meaning: string
}

export interface RightPhraseResult {
  translation?: string
  options: PhraseOption[]
}
