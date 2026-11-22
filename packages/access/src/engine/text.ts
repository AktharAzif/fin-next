// Text that draws as nothing (spec 02 §8.4, §8.6): what the role editor's floor refuses in a name
// or a description, what a name's reading leaves out, and what a summary does not count as said.

// Characters that draw as nothing, or as blank space that is not white space: control, format
// (invisible and bidirectional), surrogate, private-use and unassigned characters (\p{C}); the
// default-ignorable ones, which include the variation selectors, the combining grapheme joiner and
// the Hangul fillers U+115F, U+1160, U+3164 and U+FFA0 (Unicode files the fillers as letters and the
// selectors as marks, so \p{C} alone misses them); and three blanks that are neither, U+2800
// BRAILLE PATTERN BLANK, U+1D159 MUSICAL SYMBOL NULL NOTEHEAD and U+16FE4 KHITAN SMALL SCRIPT
// FILLER.
const INVISIBLE = /[\p{C}\p{Default_Ignorable_Code_Point}\u{2800}\u{1d159}\u{16fe4}]/u;
const EVERY_INVISIBLE = /[\p{C}\p{Default_Ignorable_Code_Point}\u{2800}\u{1d159}\u{16fe4}]/gu;

/** Whether the text holds a character that draws as nothing (see above). */
export function hasInvisible(text: string): boolean {
  return INVISIBLE.test(text);
}

/** The text with every character that draws as nothing removed. */
export function withoutInvisible(text: string): string {
  return text.replace(EVERY_INVISIBLE, "");
}

/** Whether the text shows anything: a character that is neither invisible nor white space. */
export function hasVisibleText(text: string): boolean {
  return withoutInvisible(text).trim() !== "";
}
