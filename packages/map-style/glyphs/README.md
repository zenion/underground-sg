# Glyphs

Signed-distance-field glyph PBFs for MapLibre text layers, so the style needs no third-party glyph server. OneMap's official style points its glyphs at `mapbox://fonts/sla/...`, which MapLibre can't load ([0009](../../../docs/decisions/0009-hosting-and-budget.md)).

| | |
| --- | --- |
| Font | Noto Sans Regular, the font stack `Noto Sans Regular` (`FONT_STACK` in `src/style.ts`) |
| Licence | SIL Open Font License 1.1, copyright 2022 The Noto Project Authors: [OFL.txt](OFL.txt). The PBFs are rendered from the font, so they are covered by the same licence and ship with it |
| Source | [protomaps/basemaps-assets](https://github.com/protomaps/basemaps-assets), `fonts/Noto Sans Regular/`, at commit `028c18f713baecad011301ff7a69acc39bcc2ae7` (2025-10-31), built with MapLibre's [font-maker](https://github.com/maplibre/font-maker). Downloaded 2026-10-15 |

| File | Unicode range | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `Noto Sans Regular/0-255.pbf` | Basic Latin and Latin-1 Supplement (U+0000-00FF) | 76044 | `62c6d49b15fa836eb6aa45e259c7ca6762f44b011b09e47776efbe4a6db1b397` |
| `Noto Sans Regular/256-511.pbf` | Latin Extended-A and part of Extended-B (U+0100-01FF) | 127726 | `2eca7561f9f566bcacfda5dd04fb5880baec1328ec0f5484678289a13994de8a` |
| `Noto Sans Regular/8192-8447.pbf` | General Punctuation, currency symbols and more (U+2000-20FF): curly quotes as in "McDonald’s", dashes, the euro sign | 64220 | `8ea977a587352fe31b4159ffdbc9a40be79056f2472017c742ea1e4a931864b9` |

`test/glyphs.test.ts` checks each file against this table and decodes it: one font stack, its range, and a glyph for every printable character in 0-255.

## Serving them

The apps serve this directory as static files and pass its URL template to `createMapStyle`, for example `glyphs: "/glyphs/{fontstack}/{range}.pbf"`. MapLibre fills in `{fontstack}` with `Noto Sans Regular` (the browser sends the spaces as `%20`) and `{range}` with ranges such as `0-255`. The package exports the files as `@usg/map-style/glyphs/*`.

Text outside these ranges:

- CJK ideographs, Hangul and kana: MapLibre GL JS draws them with a local font (its `localIdeographFontFamily` option, `sans-serif` by default) and never requests their ranges, so Chinese shop names render without more files.
- Grapheme clusters of several code points (Tamil and Thai syllables, emoji sequences): MapLibre GL JS 6.14 never requests a range for them and always draws them locally, with the browser's fonts.
- Any other character outside these ranges, such as the "ở" of a Vietnamese "Phở" (Latin Extended Additional, U+1E00-1EFF): MapLibre requests its range, gets a 404, logs "Unable to load glyph range ... Rendering codepoint ... locally instead" once, and draws the character locally in whatever font the browser finds for the font stack's name. The text still shows, but one label can mix two typefaces. When names need a range, add it from the same source and commit, and add it to the table above and to `GLYPH_RANGES` in `src/style.ts`. Latin Extended Additional (`7680-7935.pbf`) and the rest of Latin Extended-B (`512-767.pbf`) are the likely next ones (in the backlog).
