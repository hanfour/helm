/** Built from an escape rather than a raw control character in source. */
const ANSI = new RegExp('\\u001b\\[[0-9;]*m', 'g')

/**
 * Code point ranges that occupy two terminal columns. Only the ranges helm can
 * actually emit are listed — project names, Chinese labels, and the pin emoji.
 *
 * U+25CF (●) is deliberately absent. It is East Asian Ambiguous, which means
 * one column in a Western terminal and two in a CJK-configured one; both
 * Terminal.app and iTerm2 default to narrow, so narrow is the assumption that
 * lines up for most users. Nothing worse than a one-column drift follows from
 * being wrong.
 */
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],   // Hangul Jamo
  [0x2e80, 0x303e],   // CJK radicals, Kangxi, CJK symbols and punctuation
  [0x3041, 0x33ff],   // Kana, Hangul compatibility Jamo, CJK compatibility
  [0x3400, 0x4dbf],   // CJK Extension A
  [0x4e00, 0x9fff],   // CJK Unified Ideographs
  [0xa960, 0xa97f],   // Hangul Jamo Extended-A
  [0xac00, 0xd7a3],   // Hangul syllables
  [0xf900, 0xfaff],   // CJK compatibility ideographs
  [0xfe30, 0xfe6f],   // CJK compatibility forms
  [0xff00, 0xff60],   // Fullwidth forms
  [0xffe0, 0xffe6],   // Fullwidth signs
  [0x1f300, 0x1f64f], // Emoji: symbols and pictographs, emoticons
  [0x1f680, 0x1faff], // Emoji: transport, supplemental symbols
  [0x20000, 0x3fffd], // CJK Extension B and beyond
]

/** Zero-width: combining marks and the variation selectors emoji carry. */
const ZERO: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
]

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([lo, hi]) => cp >= lo && cp <= hi)
}

/**
 * Terminal columns a string occupies. `padEnd` counts UTF-16 units, so it
 * cannot align a column containing Chinese: 「等輸入」 is three units but six
 * columns wide.
 */
export function displayWidth(text: string): number {
  return [...text.replace(ANSI, '')].reduce((sum, ch) => {
    const cp = ch.codePointAt(0) ?? 0
    if (inRanges(cp, ZERO)) return sum
    return sum + (inRanges(cp, WIDE) ? 2 : 1)
  }, 0)
}

/** Pads with spaces to `columns`; never truncates — losing a name is worse. */
export function padTo(text: string, columns: number): string {
  return text + ' '.repeat(Math.max(0, columns - displayWidth(text)))
}
