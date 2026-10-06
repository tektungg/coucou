// Romanized lyrics for the Music pill: Korean (Revised Romanization),
// Japanese (Hepburn-style romaji) and Chinese (pinyin with tone marks). All
// offline: Korean is computed from the Hangul block itself, Japanese readings
// come from the IPADIC dictionary embedded with lindera, Chinese from the
// pinyin crate's table. Nothing here touches the network or the log.
//
// The song's language is decided once from all its lines (`detect`), so a
// kanji line in a Japanese song is read as Japanese, not as Chinese.

use std::borrow::Cow;
use std::sync::OnceLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ja,
    Ko,
    Zh,
}

impl Lang {
    pub fn code(self) -> &'static str {
        match self {
            Lang::Ja => "ja",
            Lang::Ko => "ko",
            Lang::Zh => "zh",
        }
    }
}

fn is_hangul(c: char) -> bool {
    matches!(c, '\u{AC00}'..='\u{D7A3}' | '\u{1100}'..='\u{11FF}' | '\u{3130}'..='\u{318F}')
}

fn is_kana(c: char) -> bool {
    // Hiragana and katakana, not the prolonged mark alone (ー), which some
    // Chinese and Korean lines borrow.
    matches!(c, '\u{3041}'..='\u{3096}' | '\u{30A1}'..='\u{30FA}' | '\u{31F0}'..='\u{31FF}' | '\u{FF66}'..='\u{FF9D}')
}

fn is_han(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}')
}

/// Below this many characters of a script, a song is not in it: a stray
/// kanji or a "사랑" in an English song does not earn a toggle.
const MIN_CHARS: usize = 4;

/// The song's language from all its lines, or None when nothing needs romanizing.
pub fn detect<'a>(lines: impl IntoIterator<Item = &'a str>) -> Option<Lang> {
    let (mut hangul, mut kana, mut han) = (0usize, 0usize, 0usize);
    for line in lines {
        for c in line.chars() {
            if is_hangul(c) {
                hangul += 1;
            } else if is_kana(c) {
                kana += 1;
            } else if is_han(c) {
                han += 1;
            }
        }
    }
    if hangul >= MIN_CHARS && hangul >= kana + han {
        Some(Lang::Ko)
    } else if kana >= MIN_CHARS || (kana > 0 && kana + han >= MIN_CHARS) {
        // Any kana makes the kanji Japanese.
        Some(Lang::Ja)
    } else if han >= MIN_CHARS {
        Some(Lang::Zh)
    } else {
        None
    }
}

/// One line in Latin letters. Text with nothing to romanize comes back as is.
pub fn romanize(lang: Lang, line: &str) -> String {
    let out = match lang {
        Lang::Ko => korean(line),
        Lang::Ja => japanese(line),
        Lang::Zh => chinese(line),
    };
    tidy(&out)
}

/// Single spaces, none before , . ! ? and none inside the line's ends.
fn tidy(s: &str) -> String {
    let mut out = s.split_whitespace().collect::<Vec<_>>().join(" ");
    for p in [",", ".", "!", "?"] {
        out = out.replace(&format!(" {p}"), p);
    }
    hug_quotes(&out)
}

/// `" sayonara "` → `"sayonara"`: an opening quote takes no space after it,
/// a closing one none before it.
fn hug_quotes(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut open = false;
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            if open && out.ends_with(' ') {
                out.pop();
            }
            out.push(c);
            if !open {
                while chars.peek() == Some(&' ') {
                    chars.next();
                }
            }
            open = !open;
        } else {
            out.push(c);
        }
    }
    out
}

// ── Korean: Revised Romanization ──────────────────────────────────────────────

const INITIALS: [&str; 19] = ["g", "kk", "n", "d", "tt", "r", "m", "b", "pp", "s", "ss", "", "j", "jj", "ch", "k", "t", "p", "h"];
const MEDIALS: [&str; 21] = [
    "a", "ae", "ya", "yae", "eo", "e", "yeo", "ye", "o", "wa", "wae", "oe", "yo", "u", "wo", "we", "wi", "yu", "eu", "ui", "i",
];
/// A final consonant at the end of a word or before another consonant.
const FINALS: [&str; 28] = [
    "", "k", "k", "k", "n", "n", "n", "t", "l", "k", "m", "l", "l", "l", "p", "l", "m", "p", "p", "t", "t", "ng", "t", "t", "k",
    "t", "p", "t",
];
/// A final consonant carried onto a following silent ㅇ (먹어 → meogeo):
/// what stays in the first syllable, what opens the second.
const LIAISON: [(&str, &str); 28] = [
    ("", ""),
    ("", "g"),
    ("", "kk"),
    ("k", "s"),
    ("", "n"),
    ("n", "j"),
    ("", "n"),
    ("", "d"),
    ("", "r"),
    ("l", "g"),
    ("l", "m"),
    ("l", "b"),
    ("l", "s"),
    ("l", "t"),
    ("l", "p"),
    ("", "r"),
    ("", "m"),
    ("", "b"),
    ("p", "s"),
    ("", "s"),
    ("", "ss"),
    ("ng", ""),
    ("", "j"),
    ("", "ch"),
    ("", "k"),
    ("", "t"),
    ("", "p"),
    ("", ""),
];

// Indices into the tables above.
const I_G: usize = 0;
const I_N: usize = 2;
const I_D: usize = 3;
const I_R: usize = 5;
const I_M: usize = 6;
const I_B: usize = 7;
const I_SILENT: usize = 11;
const I_J: usize = 12;
const I_H: usize = 18;
const M_I: usize = 20;
const F_N: usize = 4;
const F_D: usize = 7;
const F_L: usize = 8;
const F_M: usize = 16;
const F_NG: usize = 21;
const F_T: usize = 25;
const F_H: usize = 27;

struct Syllable {
    initial: usize,
    medial: usize,
    final_: usize,
}

fn syllable(c: char) -> Option<Syllable> {
    let code = (c as u32).checked_sub(0xAC00)?;
    if code > 11171 {
        return None;
    }
    Some(Syllable { initial: (code / 588) as usize, medial: ((code % 588) / 28) as usize, final_: (code % 28) as usize })
}

/// The sound a final consonant ends in before a consonant: k, t, p or itself.
fn final_sound(f: usize) -> &'static str {
    FINALS[f]
}

/// How a final and the next initial sound together, as (coda, onset) text.
fn junction(f: usize, next: &Syllable) -> (String, String) {
    let i = next.initial;
    let plain = || (FINALS[f].to_string(), INITIALS[i].to_string());
    if f == 0 {
        return (String::new(), INITIALS[i].to_string());
    }
    // Carried onto a silent ㅇ, with ㄷ/ㅌ + 이 palatalized (굳이 guji, 같이 gachi).
    if i == I_SILENT {
        if next.medial == M_I && f == F_D {
            return (String::new(), "j".into());
        }
        if next.medial == M_I && f == F_T {
            return (String::new(), "ch".into());
        }
        let (stay, onset) = LIAISON[f];
        return (stay.to_string(), onset.to_string());
    }
    // ㅎ final aspirates the next stop (좋고 joko) and vanishes before ㄴ (좋네 jonne).
    if f == F_H {
        return match i {
            I_G => (String::new(), "k".into()),
            I_D => (String::new(), "t".into()),
            I_J => (String::new(), "ch".into()),
            I_N => ("n".into(), "n".into()),
            _ => plain(),
        };
    }
    let sound = final_sound(f);
    // A stop before ㅎ is aspirated (축하 chuka, 입학 ipak).
    if i == I_H {
        return match sound {
            "k" => (String::new(), "k".into()),
            "t" => (String::new(), "t".into()),
            "p" => (String::new(), "p".into()),
            _ => plain(),
        };
    }
    // ㄹ meets ㄴ or ㄹ: both become l (신라 silla, 설날 seollal, 몰라 molla).
    if (f == F_N && i == I_R) || (f == F_L && (i == I_N || i == I_R)) {
        return ("l".into(), "l".into());
    }
    // ㄹ after ㅁ, ㅇ or a stop is said n (종로 jongno), and the stop nasalizes (국력 gungnyeok).
    if i == I_R {
        return match (f, sound) {
            (F_M, _) | (F_NG, _) => (FINALS[f].to_string(), "n".into()),
            (_, "k") => ("ng".into(), "n".into()),
            (_, "p") => ("m".into(), "n".into()),
            (_, "t") => ("n".into(), "n".into()),
            _ => plain(),
        };
    }
    // Stops nasalize before ㄴ and ㅁ (국물 gungmul, 합니다 hamnida, 꽃말 kkonmal).
    if i == I_N || i == I_M {
        let coda = match sound {
            "k" => "ng",
            "t" => "n",
            "p" => "m",
            other => other,
        };
        return (coda.to_string(), INITIALS[i].to_string());
    }
    let _ = I_B;
    plain()
}

fn korean(line: &str) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::with_capacity(line.len() * 2);
    // The onset the previous syllable decided for the current one.
    let mut onset: Option<String> = None;
    for (k, &c) in chars.iter().enumerate() {
        let Some(s) = syllable(c) else {
            onset = None;
            out.push(c);
            continue;
        };
        out.push_str(onset.take().as_deref().unwrap_or(INITIALS[s.initial]));
        out.push_str(MEDIALS[s.medial]);
        match chars.get(k + 1).and_then(|&n| syllable(n)) {
            // Inside a word: the final and the next initial sound together.
            Some(next) => {
                let (coda, next_onset) = junction(s.final_, &next);
                out.push_str(&coda);
                onset = Some(next_onset);
            }
            // At the end of a word: the final as it sounds alone.
            None => out.push_str(FINALS[s.final_]),
        }
    }
    out
}

// ── Japanese: romaji from the dictionary's readings ──────────────────────────

static SEGMENTER: OnceLock<Option<lindera::segmenter::Segmenter>> = OnceLock::new();

/// The IPADIC segmenter, loaded once (the dictionary is embedded in the app).
fn segmenter() -> Option<&'static lindera::segmenter::Segmenter> {
    SEGMENTER
        .get_or_init(|| {
            let dictionary = lindera::dictionary::load_dictionary("embedded://ipadic").ok()?;
            Some(lindera::segmenter::Segmenter::new(lindera::mode::Mode::Normal, dictionary, None))
        })
        .as_ref()
}

/// Kana (either script) → romaji, ー spelled as the vowel it lengthens.
pub(crate) fn kana_to_romaji(kana: &str) -> String {
    use wana_kana::ConvertJapanese;
    kana.to_hiragana().to_romaji()
}

/// What a token adds to the line: kana still to be spelled (spelled per word,
/// so 待っ・てる keeps its っ: matteru), or text that is final as it is.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Piece {
    Kana(String),
    Text(String),
}

/// One token's piece, and whether it belongs to the previous word.
pub(crate) fn token_piece(surface: &str, details: &[&str]) -> (Piece, bool) {
    let pos = details.first().copied().unwrap_or("");
    let sub = details.get(1).copied().unwrap_or("");
    let reading = details.get(7).copied().filter(|r| *r != "*" && !r.is_empty());

    if surface.trim().is_empty() {
        return (Piece::Text(String::new()), false);
    }
    if pos == "記号" {
        let mark = match surface {
            "、" | "，" => ",",
            "。" | "．" => ".",
            "！" => "!",
            "？" => "?",
            "「" | "」" | "『" | "』" => "\"",
            "・" | "…" | "～" | "〜" => " ",
            other => other,
        };
        let glue = matches!(mark, "," | "." | "!" | "?");
        return (Piece::Text(mark.to_string()), glue);
    }
    if pos == "助詞" {
        let piece = match surface {
            "は" => Piece::Text("wa".into()),
            "へ" => Piece::Text("e".into()),
            "を" => Piece::Text("o".into()),
            _ => Piece::Kana(reading.unwrap_or(surface).to_string()),
        };
        // て/で after a verb is part of it (聞いて kiite); other particles stand alone.
        return (piece, sub == "接続助詞" && matches!(surface, "て" | "で"));
    }
    // Words with no reading: Latin, digits, or kana the dictionary does not know.
    let piece = match reading {
        Some(r) => Piece::Kana(r.to_string()),
        None if surface.chars().any(is_kana) => Piece::Kana(surface.to_string()),
        None => Piece::Text(surface.to_string()),
    };
    // Inflections, helper verbs and suffixes are spelled as one word with
    // what they follow (聞こえ・ない kikoenai, 溶け・て・ゆく toketeyuku,
    // 君・たち kimitachi). よう, こと, もの stay words of their own.
    let glue = pos == "助動詞" || sub == "接尾" || (sub == "非自立" && matches!(pos, "動詞" | "形容詞"));
    (piece, glue)
}

/// Words IPADIC splits into a number and a counter and so misreads
/// (二人 → ni nin), with the reading every song means.
const READINGS: &[(&str, &str)] = &[
    ("一人", "ひとり"),
    ("二人", "ふたり"),
    ("一つ", "ひとつ"),
    ("二つ", "ふたつ"),
    ("一言", "ひとこと"),
    ("一緒", "いっしょ"),
    ("大人", "おとな"),
    ("明日", "あした"),
];

/// A word's pieces as text: neighbouring kana spelled together.
fn spell(pieces: &[Piece]) -> String {
    let mut out = String::new();
    let mut kana = String::new();
    for piece in pieces {
        match piece {
            Piece::Kana(k) => kana.push_str(k),
            Piece::Text(t) => {
                if !kana.is_empty() {
                    out.push_str(&kana_to_romaji(&kana));
                    kana.clear();
                }
                out.push_str(t);
            }
        }
    }
    if !kana.is_empty() {
        out.push_str(&kana_to_romaji(&kana));
    }
    out
}

fn japanese(line: &str) -> String {
    let Some(segmenter) = segmenter() else {
        return line.to_string();
    };
    let mut text = line.to_string();
    for (word, reading) in READINGS {
        text = text.replace(word, reading);
    }
    let Ok(mut tokens) = segmenter.segment(Cow::Owned(text)) else {
        return line.to_string();
    };
    let mut words: Vec<Vec<Piece>> = Vec::new();
    let mut prev_pos = String::new();
    for token in tokens.iter_mut() {
        let surface = token.surface.to_string();
        let details = token.details();
        let (piece, glue) = token_piece(&surface, &details);
        let pos = details.first().copied().unwrap_or("").to_string();
        // An auxiliary after a particle starts a word (だけ・だった dake datta).
        let glue = glue && !(pos == "助動詞" && prev_pos == "助詞");
        prev_pos = pos;
        if piece == Piece::Text(String::new()) || piece == Piece::Text(" ".into()) {
            // A space or a separator ends the word.
            words.push(Vec::new());
            continue;
        }
        match words.last_mut() {
            Some(last) if glue && !last.is_empty() => last.push(piece),
            _ => words.push(vec![piece]),
        }
    }
    words.iter().filter(|w| !w.is_empty()).map(|w| spell(w)).collect::<Vec<_>>().join(" ")
}

// ── Chinese: pinyin ───────────────────────────────────────────────────────────

fn chinese(line: &str) -> String {
    use pinyin::ToPinyin;
    let mut out = String::with_capacity(line.len() * 3);
    let mut last_was_han = false;
    for c in line.chars() {
        match c.to_pinyin() {
            Some(p) => {
                // One syllable per character, spaced from its neighbours.
                if !out.is_empty() && !out.ends_with(' ') {
                    out.push(' ');
                }
                out.push_str(p.with_tone());
                last_was_han = true;
            }
            None => {
                let mapped = match c {
                    '，' | '、' => ',',
                    '。' => '.',
                    '！' => '!',
                    '？' => '?',
                    '：' => ':',
                    '“' | '”' | '「' | '」' => '"',
                    other => other,
                };
                if last_was_han && mapped.is_alphanumeric() {
                    out.push(' ');
                }
                out.push(mapped);
                // "，baby" → ", baby"; tidy() drops a doubled or trailing space.
                if mapped != c && matches!(mapped, ',' | '.' | '!' | '?' | ':') {
                    out.push(' ');
                }
                last_was_han = false;
            }
        }
    }
    out
}

/// Romanizes every line of a song in its language, or None when it has none
/// to romanize. The same number of lines comes back, in order.
pub fn lines<'a>(lang: Lang, lines: impl IntoIterator<Item = &'a str>) -> Vec<String> {
    lines.into_iter().map(|l| romanize(lang, l)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_the_song_language() {
        assert_eq!(detect(["눈과 귀를 막고", "Love shot"]), Some(Lang::Ko));
        assert_eq!(detect(["君の声が聞こえる"]), Some(Lang::Ja));
        // Kanji-only lines in a song with kana elsewhere are Japanese.
        assert_eq!(detect(["永遠", "夢を見ていた"]), Some(Lang::Ja));
        assert_eq!(detect(["我爱你", "你是我的"]), Some(Lang::Zh));
        assert_eq!(detect(["Saturday mornin', jumped outta bed"]), None);
        // A stray character is not a language.
        assert_eq!(detect(["Love you 사랑"]), None);
        assert_eq!(detect([]), None);
    }

    #[test]
    fn korean_plain_syllables() {
        assert_eq!(romanize(Lang::Ko, "사랑해"), "saranghae");
        assert_eq!(romanize(Lang::Ko, "안녕하세요"), "annyeonghaseyo");
        assert_eq!(romanize(Lang::Ko, "서울"), "seoul");
    }

    #[test]
    fn korean_liaison_and_palatalization() {
        assert_eq!(romanize(Lang::Ko, "먹어"), "meogeo");
        assert_eq!(romanize(Lang::Ko, "좋아"), "joa");
        assert_eq!(romanize(Lang::Ko, "같이"), "gachi");
        assert_eq!(romanize(Lang::Ko, "굳이"), "guji");
        assert_eq!(romanize(Lang::Ko, "읽어"), "ilgeo");
        assert_eq!(romanize(Lang::Ko, "싫어"), "sireo");
    }

    #[test]
    fn korean_nasalization_and_liquids() {
        assert_eq!(romanize(Lang::Ko, "국물"), "gungmul");
        assert_eq!(romanize(Lang::Ko, "감사합니다"), "gamsahamnida");
        assert_eq!(romanize(Lang::Ko, "신라"), "silla");
        assert_eq!(romanize(Lang::Ko, "몰라"), "molla");
        assert_eq!(romanize(Lang::Ko, "종로"), "jongno");
        assert_eq!(romanize(Lang::Ko, "국력"), "gungnyeok");
    }

    #[test]
    fn korean_aspiration() {
        assert_eq!(romanize(Lang::Ko, "좋고"), "joko");
        assert_eq!(romanize(Lang::Ko, "축하해"), "chukahae");
    }

    #[test]
    fn korean_lines_keep_words_and_latin() {
        assert_eq!(romanize(Lang::Ko, "눈과 귀를 막고"), "nungwa gwireul makgo");
        assert_eq!(romanize(Lang::Ko, "Love shot, 나나나나"), "Love shot, nananana");
        assert_eq!(romanize(Lang::Ko, "Yeah, yeah, yeah"), "Yeah, yeah, yeah");
        assert_eq!(romanize(Lang::Ko, ""), "");
    }

    #[test]
    fn chinese_pinyin() {
        assert_eq!(romanize(Lang::Zh, "我爱你"), "wǒ ài nǐ");
        assert_eq!(romanize(Lang::Zh, "我爱你，baby"), "wǒ ài nǐ, baby");
        assert_eq!(romanize(Lang::Zh, "Say 我爱你"), "Say wǒ ài nǐ");
        assert_eq!(romanize(Lang::Zh, "Only English"), "Only English");
    }

    #[test]
    fn kana_spelling() {
        assert_eq!(kana_to_romaji("キミ"), "kimi");
        assert_eq!(kana_to_romaji("スーパー"), "suupaa");
        assert_eq!(kana_to_romaji("がっこう"), "gakkou");
    }

    fn token_romaji(surface: &str, details: &[&str]) -> (String, bool) {
        let (piece, glue) = token_piece(surface, details);
        (spell(&[piece]), glue)
    }

    #[test]
    fn japanese_tokens() {
        // Topic particle は is read wa, を o, へ e.
        assert_eq!(token_romaji("は", &["助詞", "係助詞", "*", "*", "*", "*", "は", "ハ", "ワ"]), ("wa".into(), false));
        assert_eq!(token_romaji("を", &["助詞", "格助詞", "一般", "*", "*", "*", "を", "ヲ", "オ"]), ("o".into(), false));
        // An auxiliary sticks to its verb.
        assert_eq!(token_romaji("ない", &["助動詞", "*", "*", "*", "特殊・ナイ", "基本形", "ない", "ナイ", "ナイ"]), ("nai".into(), true));
        // て after a verb too.
        assert_eq!(token_romaji("て", &["助詞", "接続助詞", "*", "*", "*", "*", "て", "テ", "テ"]), ("te".into(), true));
        // No reading: Latin passes, kana is spelled.
        assert_eq!(token_romaji("love", &["名詞", "一般", "*", "*", "*", "*", "*", "*", "*"]), ("love".into(), false));
        assert_eq!(token_romaji("ゆらゆら", &["名詞", "一般", "*", "*", "*", "*", "*", "*", "*"]), ("yurayura".into(), false));
        assert_eq!(token_romaji("、", &["記号", "読点", "*", "*", "*", "*", "、", "、", "、"]), (",".into(), true));
    }

    #[test]
    fn japanese_lines() {
        assert_eq!(romanize(Lang::Ja, "君の声が聞こえる"), "kimi no koe ga kikoeru");
        assert_eq!(romanize(Lang::Ja, "私は歌う"), "watashi wa utau");
        assert_eq!(romanize(Lang::Ja, "聞こえない"), "kikoenai");
        assert_eq!(romanize(Lang::Ja, "Baby, 君を待ってる"), "Baby, kimi o matteru");
        assert_eq!(romanize(Lang::Ja, "Only English"), "Only English");
        // A small っ split from its word by the dictionary is still spelled.
        assert_eq!(romanize(Lang::Ja, "待ってる"), "matteru");
        // Misread number words, よう as its own word, an auxiliary after a particle.
        assert_eq!(romanize(Lang::Ja, "二人だけの空"), "futari dake no sora");
        assert_eq!(romanize(Lang::Ja, "沈むように"), "shizumu you ni");
        assert_eq!(romanize(Lang::Ja, "さよならだけだった"), "sayonara dake datta");
        assert_eq!(romanize(Lang::Ja, "「さよなら」"), "\"sayonara\"");
    }

    #[test]
    fn lines_stay_aligned() {
        let out = lines(Lang::Ko, ["사랑해", "", "Yeah"]);
        assert_eq!(out, vec!["saranghae".to_string(), String::new(), "Yeah".to_string()]);
    }
}
