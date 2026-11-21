// Look-alike rows derived from Unicode's confusables data (UTS #39, Unicode Security Mechanisms,
// confusables.txt version 18.0.0, dated 2026-08-06) and the names of the Latin letters
// (UnicodeData.txt 18.0.0), for the role editor's reading of a name (src/engine/role-editor.ts).
// Each entry is one character and what it is drawn as: Latin letters, a digit or sign that stands
// for one, punctuation, or letters of no Latin reading.
//
// The rows come from every entry of the file, for the characters Unicode 17.0 (Node 26's)
// assigns, less what the reading already gets right: ASCII, compatibility folding, and the
// hand-made rows in role-editor.ts, which take precedence. Each of Unicode's classes (the entries
// that share a prototype, with the prototype) reads as one: a letter other letters are drawn as
// reads as they do (ß as β, b). A Latin letter the file does not draw reads as the letter its name
// says it is a form of ("D WITH CURL" is d). The reading ignores case, which adds two rules: a
// small letter drawn as no Latin letter reads as its capital does (Cyrillic ь as Ь, b), and a
// capital reads as its small letter only when the file draws it so (Greek Γ is not y, though γ
// is), so a capital has a row of its own, or none, when it is drawn otherwise.
//
// src/engine/look-alikes.test.ts holds the rows to Unicode's data, committed as
// src/test-support/confusables.ts and src/test-support/latin-letters.ts: every entry must read as
// its prototype is drawn, the members of each class alike, each capital and each named letter as
// the data says, and every row must be one the data asks for. To refresh them for a newer file,
// replace the data and add or change the rows each failing test names (the package README
// describes the selection).
//
// This file, src/engine/drawn-order.ts and the files in src/test-support/ named above hold data
// derived from Unicode's data files:
//
// UNICODE LICENSE V3
//
// COPYRIGHT AND PERMISSION NOTICE
//
// Copyright © 1991-2026 Unicode, Inc.
//
// NOTICE TO USER: Carefully read the following legal agreement. BY
// DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
// SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
// TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
// DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of data files and any associated documentation (the "Data Files") or
// software and any associated documentation (the "Software") to deal in the
// Data Files or Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, and/or sell
// copies of the Data Files or Software, and to permit persons to whom the
// Data Files or Software are furnished to do so, provided that either (a)
// this copyright and permission notice appear with all copies of the Data
// Files or Software, or (b) this copyright and permission notice appear in
// associated Documentation.
//
// THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
// KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
// THIRD PARTY RIGHTS.
//
// IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
// BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
// OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
// WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
// ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
// FILES OR SOFTWARE.
//
// Except as contained in this notice, the name of a copyright holder shall
// not be used in advertising or otherwise to promote the sale, use or other
// dealings in these Data Files or Software without prior written
// authorization of the copyright holder.

const UNICODE_LOOK_ALIKES = Object.freeze({
  version: "18.0.0",
  /**
   * Letters compatibility folding would turn into a letter drawn otherwise: read before folding
   * (Greek lunate sigma is drawn as c, though it folds to a sigma).
   */
  beforeFolding: Object.freeze([
    // Arabic
    "\u{1ee61}\u{628}l \u{1ee62}\u{62c}l \u{1ee64}ol \u{1ee67}\u{62d}l \u{1ee68}\u{637}l",
    "\u{1ee69}\u{649}l \u{1ee6a}\u{643}l \u{1ee6c}\u{645}l \u{1ee6d}\u{646}l \u{1ee6e}\u{633}l",
    "\u{1ee6f}\u{639}l \u{1ee70}\u{641}l \u{1ee71}\u{635}l \u{1ee72}\u{642}l \u{1ee74}\u{633}l",
    "\u{1ee75}\u{62a}l \u{1ee76}\u{649}l \u{1ee77}\u{62e}l \u{1ee79}\u{636}l \u{1ee7a}\u{638}l",
    "\u{1ee7b}\u{63a}l \u{1ee7c}\u{649}l \u{1ee7e}\u{6a1}l",
    // Greek
    "\u{3f2}c \u{3f9}c",
    // Common: the vertical em dash, drawn as l, read as the bar
    "\u{fe31}|",
  ]),
  /**
   * Capitals drawn as a Latin letter their small letters are not, by their entries or their names:
   * read before lower-casing.
   */
  capitals: Object.freeze([
    // Warang Citi
    "\u{118a6}e \u{118b5}o \u{118bc}t",
    // Armenian
    "\u{545}3",
    // Coptic
    "\u{3ec}6 \u{2c9c}3 \u{2cdc}6",
    // Georgian (An, drawn as insular T)
    "\u{10a0}t",
    // Latin, by name (V WITH HOOK, though its small letter is drawn as u)
    "\u{1b2}v",
  ]),
  /**
   * Capitals Unicode does not draw as their small letters, whose small letters are drawn as Latin
   * ones (Greek Γ, though γ is y; Armenian Ա, though ա is w): read as no Latin letter.
   */
  unlikeCapitals: Object.freeze([
    "\u{de}\u{14a}\u{194}\u{19c}\u{1f7}\u{393}\u{3a3}\u{3a9}\u{3f7}\u{40b}\u{40f}\u{413}\u{490}",
    "\u{492}\u{4bc}\u{4be}\u{500}\u{531}\u{533}\u{536}\u{53c}\u{540}\u{542}\u{54c}\u{551}\u{552}",
    "\u{554}\u{556}\u{13b1}\u{1c97}\u{1ca7}\u{1cb3}\u{2c6d}\u{2c84}\u{a646}\u{a694}\u{a760}",
    "\u{a780}\u{a79e}\u{118a1}\u{118aa}\u{118b6}\u{118b7}",
  ]),
  /**
   * Latin letters Unicode's confusables data does not draw, read as the letter their names say:
   * a letter "WITH" a stroke, hook, curl or tail ("LATIN SMALL LETTER D WITH CURL" is d), and a
   * small capital ("LATIN LETTER SMALL CAPITAL F" is f) (UnicodeData.txt 18.0.0). A capital reads
   * as its small letter.
   */
  named: Object.freeze([
    "\u{221}d \u{234}l \u{235}n \u{236}t \u{23f}s \u{240}z \u{24b}q \u{255}c \u{26c}l \u{291}z",
    "\u{29b}g \u{1d0c}l \u{1d6c}b \u{1d6d}d \u{1d71}p \u{1d79}g \u{1d80}b \u{1d81}d \u{1d82}f",
    "\u{1d84}k \u{1d85}l \u{1d86}m \u{1d87}n \u{1d88}p \u{1d89}r \u{1d8a}s \u{1d8d}x \u{1d8e}z",
    "\u{1d8f}a \u{1d91}d \u{1d92}e \u{1d96}i \u{1d99}u \u{2c61}l \u{2c65}a \u{2c71}v \u{2c73}w",
    "\u{2c74}v \u{2c78}e \u{2c7a}o \u{a730}f \u{a743}k \u{a745}k \u{a747}l \u{a749}l \u{a74d}o",
    "\u{a751}p \u{a753}p \u{a755}p \u{a757}q \u{a759}q \u{a75f}v \u{a77c}f \u{a783}r \u{a785}s",
    "\u{a787}t \u{a78e}l \u{a791}n \u{a794}c \u{a797}b \u{a7a1}g \u{a7a3}k \u{a7a5}n \u{a7a7}r",
    "\u{a7a9}s \u{a7af}q \u{a7b9}u \u{a7c1}o \u{a7c3}w \u{a7c8}d \u{a7ca}s \u{a7cd}s \u{a7d1}g",
    "\u{a7d9}s \u{a7ff}m \u{ab33}e \u{ab34}e \u{ab36}g \u{ab37}l \u{ab38}l \u{ab39}l \u{ab3a}m",
    "\u{ab3b}n \u{ab45}r \u{ab46}r \u{ab49}r \u{ab4b}r \u{ab4c}r \u{ab56}x \u{ab57}x \u{ab58}x",
    "\u{ab59}x \u{1df04}l \u{1df09}t \u{1df11}l \u{1df13}l \u{1df16}r \u{1df1a}i \u{1df1b}o",
    "\u{1df1d}c \u{1df1e}s \u{1df25}d \u{1df26}l \u{1df27}n \u{1df28}r \u{1df29}s \u{1df2a}t",
  ]),
  /** Letters, after lower-casing, and what each is drawn as. */
  letters: Object.freeze([
    // Latin
    "\u{e6}ae \u{fe}p \u{14b}n \u{153}oe \u{183}b \u{185}b \u{18c}d \u{18d}g \u{192}f \u{1a8}2",
    "\u{1ab}t \u{1bb}2 \u{1bd}s \u{1bf}p \u{21d}3 \u{223}8 \u{242}? \u{24f}y \u{25c}3 \u{25f}j",
    "\u{263}y \u{26e}l3 \u{26f}w \u{276}oe \u{27c}r \u{284}f \u{290}z \u{292}3 \u{294}?",
    "\u{29d}j \u{2a0}q \u{2a3}dz \u{2a4}d3 \u{2a5}dz \u{2a6}ts \u{2a7}t\u{283}",
    "\u{2a8}tc \u{2a9}fn \u{2aa}ls \u{2ab}lz \u{1d08}3 \u{1d11}o \u{1d14}\u{1dd}o",
    "\u{1d24}2 \u{1d6b}ue \u{1d6e}f \u{1d6f}m \u{1d70}n \u{1d72}r \u{1d73}r \u{1d74}s \u{1d75}t",
    "\u{1d76}z \u{1d7b}i \u{1d7c}i \u{1d7d}p \u{1d7e}u \u{1d83}g \u{1d8c}y \u{1e9d}f \u{1efb}ll",
    "\u{1eff}y \u{2c66}t \u{2c68}h \u{2c6a}k \u{2c6c}z \u{a729}t3 \u{a72b}e \u{a733}aa",
    "\u{a735}ao \u{a737}au \u{a739}av \u{a73b}av \u{a73d}ay \u{a741}k \u{a74b}o \u{a74f}oo",
    "\u{a75b}2 \u{a761}w \u{a76b}3 \u{a76f}9 \u{a777}tf \u{a778}& \u{a781}l \u{a78f}\u{b7}",
    "\u{a799}f \u{a79f}u \u{a7b5}b \u{a7b7}w \u{a7f7}\u{30fc} \u{a7fa}w \u{a7fe}l \u{ab32}e",
    "\u{ab35}f \u{ab3d}o \u{ab3e}o \u{ab41}\u{1dd}o \u{ab42}\u{1dd}o \u{ab43}co \u{ab44}co",
    "\u{ab47}r \u{ab48}r \u{ab4e}u \u{ab51}m \u{ab52}u \u{ab53}x \u{ab55}x \u{ab5a}y",
    "\u{ab62}\u{254}e \u{ab63}uo \u{ab64}a",
    // Latin letters other letters are drawn as, read as those letters are: sharp s as β (b), kra
    // as κ (k), turned w as м (m), c with bar as ε (e); Middle Scots s as sharp s; and two letters
    // drawn as letters whose names say what they are (insular D, q with hook tail)
    "\u{df}b \u{138}k \u{28d}m \u{a793}e \u{a7d7}b \u{a77a}d \u{1d90}q",
    // Canadian Aboriginal
    "\u{1424}\u{b0} \u{1427}\u{b7} \u{1428}\u{2c9} \u{1429}+ \u{142f}v \u{1433}>",
    "\u{1437}\u{b7}> \u{1438}< \u{143a}\u{b7}v \u{143b}v\u{b7} \u{1440}\u{b7}> \u{1441}>\u{b7}",
    "\u{1444}\u{b7}< \u{1445}<\u{b7} \u{144a}' \u{144c}u \u{144e}n \u{1457}\u{b7}u",
    "\u{1458}u\u{b7} \u{1459}\u{b7}n \u{145a}n\u{b7} \u{1467}u' \u{1468}n' \u{146d}p \u{146f}d",
    "\u{1472}b \u{1473}b \u{1476}\u{b7}p \u{1477}p\u{b7} \u{147a}\u{b7}d \u{147b}d\u{b7}",
    "\u{147e}\u{b7}b \u{147f}b\u{b7} \u{1480}\u{b7}b \u{1481}b\u{b7} \u{1486}p' \u{1487}d'",
    "\u{1488}b' \u{148d}j \u{1498}\u{b7}j \u{1499}j\u{b7} \u{14aa}l \u{14b6}\u{b7}l",
    "\u{14b7}l\u{b7} \u{14bf}2 \u{150e}\u{150b}b \u{152f}\u{b7}4 \u{1530}4\u{b7} \u{1540}+",
    "\u{1541}x \u{156f}** \u{157c}h \u{157d}x \u{157f}\u{1550}p \u{1581}\u{1550}d",
    "\u{1583}\u{1550}b \u{1584}\u{1550}b \u{1587}r \u{1591}\u{1595}j \u{15af}b \u{15b4}f",
    "\u{15c5}a \u{15de}d \u{15ea}d \u{15ef}w \u{15f0}m \u{15f7}b \u{1616}2 \u{1673}\u{1596}j",
    "\u{18d4}^ \u{18de}\u{b0} \u{18ed}w\u{b7} \u{11abc}z \u{11abe}n",
    // Cyrillic
    "\u{431}6 \u{433}r \u{437}3 \u{448}w \u{44a}\u{2c9}b \u{44b}bi \u{44c}b \u{44e}lo \u{45b}h",
    "\u{45f}u \u{461}w \u{463}b \u{473}o \u{479}oy \u{47d}w \u{48d}b \u{491}r' \u{493}r",
    "\u{499}3 \u{49b}k \u{49f}k \u{4a3}h \u{4ab}c \u{4ad}t \u{4b1}y \u{4b3}x \u{4bd}e \u{4bf}e",
    "\u{4c8}h \u{4ca}h \u{4ce}m \u{4d5}ae \u{4e1}3 \u{4e9}o \u{50d}g \u{511}e \u{1c82}o",
    "\u{1c83}c \u{1c84}7 \u{a645}2 \u{a647}i \u{a64d}w \u{a651}\u{2c9}bi \u{a68d}t \u{a695}h",
    "\u{a699}oo \u{454}e",
    // Hangul
    "\u{110b}o \u{111b}\u{1105}o \u{111d}\u{1106}o \u{112b}\u{1107}o \u{112c}\u{1107}\u{1107}o",
    "\u{1135}\u{1109}o \u{1141}o\u{1100} \u{1142}o\u{1103} \u{1143}o\u{1106} \u{1144}o\u{1107}",
    "\u{1145}o\u{1109} \u{1146}o\u{1140} \u{1147}oo \u{1148}o\u{110c} \u{1149}o\u{110e}",
    "\u{114a}o\u{1110} \u{114b}o\u{1111} \u{114d}\u{110c}o \u{1157}\u{1111}o \u{1173}\u{30fc}",
    "\u{1196}\u{30fc}\u{30fc} \u{11bc}o \u{11d5}\u{1105}\u{1107}o \u{11e2}\u{1106}o",
    "\u{11e6}\u{1107}o \u{11ec}o\u{1100} \u{11ed}o\u{1100}\u{1100} \u{11ee}oo \u{11ef}o\u{110f}",
    "\u{11f1}o\u{1109} \u{11f2}o\u{1140} \u{11f4}\u{1111}o \u{a96b}\u{1105}\u{1107}o",
    "\u{a976}o\u{1105} \u{a977}o\u{1112} \u{d7dd}\u{1105}o \u{d7eb}\u{1109}\u{1107}o",
    "\u{d7f4}\u{1140}\u{1107}o",
    // Coptic
    "\u{3e9}2 \u{3ed}o \u{2c83}b \u{2c85}r \u{2c89}e \u{2c8d}z \u{2c8f}h \u{2c91}o \u{2c93}i",
    "\u{2c95}k \u{2c99}m \u{2c9b}n \u{2c9f}o \u{2ca3}p \u{2ca5}c \u{2ca7}t \u{2ca9}y \u{2cad}x",
    "\u{2cb1}w \u{2cb3}- \u{2cb5}<\u{b7} \u{2cb7}\u{2261} \u{2cbb}- \u{2cbd}w \u{2cc5}3",
    "\u{2cc7}/ \u{2ccb}9 \u{2ccd}3 \u{2ccf}p \u{2cd1}l \u{2cd3}6",
    // Lisu
    "\u{a4d0}b \u{a4d1}p \u{a4d2}d \u{a4d3}d \u{a4d4}t \u{a4d6}g \u{a4d7}k \u{a4d9}j \u{a4da}c",
    "\u{a4dc}z \u{a4dd}f \u{a4df}m \u{a4e0}n \u{a4e1}l \u{a4e2}s \u{a4e3}r \u{a4e6}v \u{a4e7}h",
    "\u{a4ea}w \u{a4eb}x \u{a4ec}y \u{a4ee}a \u{a4f0}e \u{a4f2}l \u{a4f3}o \u{a4f4}u \u{a4f5}n",
    // Cherokee
    "\u{13fa}h \u{13fb}g \u{ab74}o \u{ab79}y \u{ab7e}? \u{ab81}r \u{ab8d}y \u{ab8e}o \u{ab8f}t",
    "\u{ab92}h \u{ab97}w \u{ab9b}e \u{ab9c}u \u{ab9e}4 \u{ab9f}b \u{aba2}r \u{aba4}w \u{aba5}s",
    "\u{abb7}d \u{abbb}o \u{abbe}6 \u{13f8}b",
    // Warang Citi
    "\u{118c0}v \u{118c1}s \u{118c2}f \u{118c3}i \u{118c4}y \u{118c6}7 \u{118c8}o \u{118c9}z",
    "\u{118ca}3 \u{118cc}9 \u{118ce}e \u{118cf}4 \u{118d2}l \u{118d5}6 \u{118d6}9 \u{118d7}o",
    "\u{118d8}u \u{118db}5 \u{118dc}y",
    // Miao
    "\u{16f08}v \u{16f0a}t \u{16f16}l \u{16f28}l \u{16f2d}e \u{16f35}r \u{16f3a}s \u{16f3b}3",
    "\u{16f3f}> \u{16f40}a \u{16f42}u \u{16f43}y",
    // Tifinagh
    "\u{2d31}o \u{2d38}v \u{2d39}e \u{2d41}o \u{2d48}\u{b7}\u{b7}\u{b7} \u{2d4a}l \u{2d4f}l",
    "\u{2d51}! \u{2d54}o \u{2d55}q \u{2d5d}x \u{2d66}<",
    // Elbasan
    "\u{10507}z \u{1050e}l \u{10513}n \u{10516}o \u{10518}k \u{1051b}c \u{1051d}v \u{1051e}o",
    "\u{10525}f \u{10526}l \u{10527}x",
    // Georgian
    "\u{10d5}3 \u{10d7}o \u{10e7}y \u{10f3}3 \u{10f7}2 \u{10fd}s \u{10ff}o \u{2d19}h \u{2d1d}s",
    "\u{2d27}2 \u{2d2d}z",
    // Old Italic
    "\u{10301}b \u{10302}c \u{10309}l \u{1030f}o \u{10311}m \u{10315}t \u{10317}x \u{1031a}8",
    "\u{1031c}b \u{1031f}* \u{1032d}<",
    // Arabic
    "\u{627}l \u{629}o \u{647}o \u{672}l\u{674} \u{673}l \u{6be}o \u{6c1}o \u{6c3}o \u{6d5}o",
    "\u{6ff}o",
    // Armenian
    "\u{560}m \u{561}w \u{563}q \u{572}n \u{575}j \u{57c}n \u{57f}s \u{582}i \u{584}f \u{586}$",
    // Bamum
    "\u{a6a2}o \u{a6b2}y \u{a6c9}z \u{a6dd}9\u{b7} \u{a6df}v \u{16869}+ \u{1699b}o \u{169c1}9",
    "\u{169fe}8 \u{16a19}r",
    // Carian
    "\u{102a0}a \u{102a1}b \u{102a2}c \u{102a5}f \u{102ab}o \u{102b0}m \u{102b1}t \u{102b2}y",
    "\u{102b4}x \u{102cf}h",
    // Lycian
    "\u{10282}b \u{10286}e \u{10287}f \u{1028a}l \u{10290}x \u{10292}o \u{10295}p \u{10296}s",
    "\u{10297}t \u{1029b}+",
    // Vai
    "\u{a50b}t \u{a516}lll \u{a543}6 \u{a557}b \u{a56f}l \u{a576}s \u{a589}8 \u{a5cb}e",
    "\u{a613}e",
    // Greek
    "\u{3b3}y \u{3b8}o \u{3c3}o \u{3dd}f \u{3f8}p \u{3fb}m \u{1d26}r \u{1d29}p",
    // Hebrew
    "\u{5d5}l \u{5d8}v \u{5d9}' \u{5df}l \u{5e1}o \u{5f0}ll \u{5f1}l' \u{5f2}''",
    // Runic
    "\u{16b2}< \u{16b7}x \u{16c1}l \u{16c5}l \u{16cc}' \u{16d0}l \u{16d5}k \u{16d6}m",
    // Han
    "\u{4e00}\u{30fc} \u{4e05}t \u{4e2b}y \u{4e36}\\ \u{4e3f}/ \u{21fe8}\u{276c}",
    // Nko
    "\u{7ca}l \u{7cb}o \u{7cc}y \u{7d3}f \u{7d5}b \u{7e0}t",
    // Old Turkic
    "\u{10c13}x \u{10c17}o \u{10c1f}v \u{10c20}y \u{10c21}m \u{10c3e}l",
    // Ahom
    "\u{11700}m \u{11706}v \u{1170a}w \u{1170e}w \u{1170f}w",
    // Bassa Vah
    "\u{16ad1}n \u{16ad6}s \u{16ae4}l \u{16ae9}o \u{16aec}<",
    // Deseret
    "\u{10429}e \u{1042c}o \u{1043d}c \u{10443}l \u{10448}s",
    // Ethiopic
    "\u{1200}u \u{1260}n \u{12d0}o \u{1340}o",
    // Myanmar
    "\u{1004}c \u{1010}o \u{101d}o \u{105a}c",
    // Osage
    "\u{104dc}r \u{104ea}o \u{104f6}u \u{104fa}7",
    // other scripts
    "\u{11dda}l \u{16ec5}l \u{16ed1}b \u{1e6e9}+",
    // Bopomofo
    "\u{3111}\u{276c} \u{3112}t \u{311a}y",
    // Malayalam
    "\u{d1f}s \u{d20}o \u{d5f}o\u{d30}o",
    // Chakma
    "\u{11116}o \u{11124}o",
    // Devanagari
    "\u{97d}? \u{a8f6}3",
    // Lydian
    "\u{10926}l \u{1092c}o",
    // Old Hungarian
    "\u{10cc2}x \u{10ce5}l",
    // Tai Tham
    "\u{1a32}o \u{1a45}o",
    // Anatolian Hieroglyphs
    "\u{145c1}_",
    // Batak
    "\u{1bc7}\u{30fc}",
    // Buhid
    "\u{174d}-",
    // Common
    "\u{1cf5}x",
    // Hanifi Rohingya
    "\u{10d07}o",
    // Hanunoo
    "\u{172a}7",
    // Hiragana
    "\u{304f}\u{276c}",
    // Katakana
    "\u{30ce}/",
    // Kirat Rai
    "\u{16d63}l",
    // Mandaic
    "\u{840}o",
    // Oriya
    "\u{b20}o",
    // Tagalog
    "\u{1702}3",
    // Tagbanwa
    "\u{1763}x",
    // Tirhuta
    "\u{114c5}w",
  ]),
  /**
   * Digits, punctuation, symbols and spacing marks drawn as Latin letters, each of which may stand
   * for them.
   */
  signs: Object.freeze([
    // Common
    "\u{a2}c \u{a5}y \u{d7}x \u{964}l \u{965}ll \u{16ed}t \u{2016}ll \u{2030}oo \u{2031}ooo",
    "\u{2052}o \u{20a1}c \u{20a5}m \u{20a9}w \u{20ab}d \u{20ad}k \u{20ae}t \u{20b6}lt \u{212e}e",
    "\u{21bf}l \u{2205}o \u{2214}t \u{221e}oo \u{2223}l \u{2225}ll \u{2228}v \u{2229}n",
    "\u{222a}u \u{2296}o \u{229d}o \u{22a4}t \u{22c1}v \u{22c2}n \u{22c3}u \u{22ff}e \u{2300}o",
    "\u{2361}t \u{2365}o \u{236c}o \u{2373}i \u{2374}p \u{2375}w \u{2376}a \u{2378}i \u{2379}w",
    "\u{237a}a \u{23e8}lo \u{23fd}l \u{2502}l \u{2503}l \u{2573}x \u{2795}t \u{27d9}t \u{292b}x",
    "\u{292c}x \u{296e}l \u{29e2}w \u{2a22}t \u{2a23}t \u{2a24}t \u{2a25}t \u{2a26}t \u{2a27}tz",
    "\u{2a2f}x \u{2a30}x \u{a830}l \u{10196}x \u{10197}v \u{10198}lls \u{10199}ll \u{102f5}z",
    "\u{1d100}l \u{1d134}c \u{1d373}t \u{1d377}l \u{1ed01}l \u{1f10f}s \u{1f16d}cc \u{1f16e}c",
    "\u{1f700}qe \u{1f707}ar \u{1f708}v \u{1f714}o \u{1f74c}c \u{1f75c}sss \u{1f768}t",
    "\u{1f76b}mb \u{1f76c}vb",
    // Common: symbols drawn as c with bar, which reads as ε does
    "\u{22f4}e \u{2377}e",
    // Greek
    "\u{1017e}f \u{1018b}d \u{1018e}n \u{1d206}e \u{1d207}b \u{1d20c}w \u{1d20d}v \u{1d212}t",
    "\u{1d213}f \u{1d216}r \u{1d21a}o \u{1d221}e \u{1d222}w \u{1d22a}l \u{1d245}n",
    // Arabic
    "\u{609}oo \u{60a}ooo \u{661}l \u{665}o \u{667}v \u{66a}o \u{6f1}l \u{6f5}o \u{6f7}v",
    // Warang Citi
    "\u{118e0}o \u{118e3}m \u{118e5}z \u{118e6}w \u{118e9}c \u{118ec}x \u{118ef}w \u{118f2}c",
    // other scripts
    "\u{110c0}l \u{110c1}ll \u{11de0}o \u{11de1}l",
    // Bengali
    "\u{9e6}o \u{9ea}b \u{9ed}g",
    // Brahmi
    "\u{11047}l \u{11048}ll \u{11055}t",
    // Gurmukhi
    "\u{a66}o \u{a67}g \u{a6a}b",
    // Medefaidrin
    "\u{16e80}o \u{16e82}a \u{16e8a}t",
    // Myanmar
    "\u{1040}o \u{104a}l \u{104b}ll",
    // Nyiakeng Puachue Hmong
    "\u{1e140}o \u{1e141}l \u{1e145}v",
    // Bhaiksuki
    "\u{11c41}l \u{11c42}ll",
    // Canadian Aboriginal
    "\u{166d}x \u{166e}x",
    // Chakma
    "\u{11141}l \u{11142}ll",
    // Devanagari
    "\u{966}o \u{969}e",
    // Gujarati
    "\u{ae6}o \u{ae9}e",
    // Malayalam
    "\u{d02}o \u{d66}o \u{d6d}g",
    // Mende Kikakui
    "\u{1e8c7}l \u{1e8cb}b",
    // Modi
    "\u{11641}l \u{11642}ll",
    // Newa
    "\u{11445}b \u{1144b}l \u{1144c}ll",
    // Old Hungarian
    "\u{10cfa}l \u{10cfc}x",
    // Old Italic
    "\u{10320}l \u{10322}x",
    // Oriya
    "\u{b03}b \u{b66}o \u{b68}g",
    // Saurashtra
    "\u{a8ce}l \u{a8cf}ll",
    // Sharada
    "\u{111c5}l \u{111c6}ll",
    // Tai Tham
    "\u{1a80}o \u{1a90}o",
    // Tulu Tigalari
    "\u{113d4}l \u{113d5}ll",
    // Wancho
    "\u{1e2f0}o \u{1e2f2}g",
    // Bamum
    "\u{a6ef}z",
    // Cham
    "\u{aa5d}l",
    // Han
    "\u{3007}o",
    // Hebrew
    "\u{5c0}l",
    // Kannada
    "\u{c82}o \u{ce6}o",
    // Khmer
    "\u{17e0}o",
    // Lao
    "\u{ed0}o",
    // Nko
    "\u{7c0}o",
    // Siddham
    "\u{115c5}l",
    // Tamil
    "\u{be6}o",
    // Telugu
    "\u{c02}o \u{c66}o",
    // Thai
    "\u{e50}o",
    // Tirhuta
    "\u{114d0}o",
    // Batak, Grantha and Sinhala vowel signs and anusvaras (spacing marks)
    "\u{1bea}o \u{1bec}x \u{11302}o \u{d82}o",
  ]),
});

export { UNICODE_LOOK_ALIKES };
