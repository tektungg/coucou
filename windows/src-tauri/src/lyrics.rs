// Lyrics for the Music pill, from LRCLIB (https://lrclib.net), a free and
// open lyrics database that needs no key. Only the song's title, artist,
// album and length leave the machine, and only while the "Lyrics" toggle in
// Settings is on. Neither the request nor the lyrics reach the log.
//
// Everything that decides something (parsing LRC, which search result fits
// the song) is a pure function tested below; `fetch` only does the I/O.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};

const API: &str = "https://lrclib.net/api";
const TIMEOUT: Duration = Duration::from_secs(8);
/// LRCLIB asks clients to say who they are.
const USER_AGENT: &str = concat!("Coucou/", env!("CARGO_PKG_VERSION"), " (https://github.com/tektungg/coucou)");
/// A result whose length is further off than this is another recording
/// (a live take, a sped-up edit, a 3 s fan upload), not this song.
const DURATION_TOLERANCE_MS: i64 = 3_000;
/// Songs kept in memory. A "not found" is kept too, so a song LRCLIB lacks is
/// asked for once per run, not on every card rebuild.
const CACHE_SIZE: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Line {
    /// Milliseconds from the start of the song.
    pub t: u32,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// Time-stamped lines, sorted. Empty when LRCLIB only has plain text.
    pub synced: Vec<Line>,
    pub plain: Option<String>,
    pub instrumental: bool,
}

/// One LRCLIB record, as `/api/get` and `/api/search` return it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub instrumental: bool,
    #[serde(default)]
    pub plain_lyrics: Option<String>,
    #[serde(default)]
    pub synced_lyrics: Option<String>,
}

impl Record {
    fn has_synced(&self) -> bool {
        self.synced_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty())
    }

    fn has_plain(&self) -> bool {
        self.plain_lyrics.as_deref().is_some_and(|s| !s.trim().is_empty())
    }

    fn into_lyrics(self) -> Option<Lyrics> {
        let synced = self.synced_lyrics.as_deref().map(parse_lrc).unwrap_or_default();
        let plain = self.plain_lyrics.filter(|s| !s.trim().is_empty());
        if synced.is_empty() && plain.is_none() && !self.instrumental {
            return None;
        }
        Some(Lyrics { synced, plain, instrumental: self.instrumental })
    }
}

/// "mm:ss", "mm:ss.x", "mm:ss.xx", "mm:ss.xxx" or "mm:ss:xx" → milliseconds.
fn parse_stamp(tag: &str) -> Option<i64> {
    let (min, rest) = tag.split_once(':')?;
    let (sec, frac) = match rest.find(['.', ':']) {
        Some(i) => (&rest[..i], &rest[i + 1..]),
        None => (rest, ""),
    };
    if min.is_empty() || sec.is_empty() || !min.bytes().all(|b| b.is_ascii_digit()) || !sec.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if !frac.bytes().all(|b| b.is_ascii_digit()) || frac.len() > 3 {
        return None;
    }
    let min: i64 = min.parse().ok()?;
    let sec: i64 = sec.parse().ok()?;
    if sec >= 60 {
        return None;
    }
    // ".5" is half a second, ".05" fifty milliseconds, ".005" five.
    let frac_ms = match frac.len() {
        0 => 0,
        n => frac.parse::<i64>().ok()? * 10_i64.pow(3 - n as u32),
    };
    Some(min * 60_000 + sec * 1_000 + frac_ms)
}

/// Drops the word-level "<mm:ss.xx>" stamps of enhanced LRC.
fn strip_word_stamps(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(open) = rest.find('<') {
        let Some(close) = rest[open..].find('>') else { break };
        if parse_stamp(&rest[open + 1..open + close]).is_some() {
            out.push_str(&rest[..open]);
            rest = &rest[open + close + 1..];
        } else {
            out.push_str(&rest[..=open]);
            rest = &rest[open + 1..];
        }
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// LRC text → lines sorted by time. A line may carry several stamps (a chorus
/// written once), "[offset:±ms]" shifts everything (positive = earlier, as
/// the format defines it), metadata tags ("[ar:…]", "[length:…]") and lines
/// without a stamp are ignored. Empty lines are kept: they are the gaps
/// between verses, where the card shows a pause instead of a stale line.
pub fn parse_lrc(text: &str) -> Vec<Line> {
    let mut offset_ms: i64 = 0;
    let mut stamped: Vec<(i64, String)> = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut stamps: Vec<i64> = Vec::new();
        while rest.starts_with('[') {
            let Some(close) = rest.find(']') else { break };
            let tag = rest[1..close].trim();
            if let Some(ms) = parse_stamp(tag) {
                stamps.push(ms);
            } else if let Some(v) = tag.strip_prefix("offset:") {
                offset_ms = v.trim().trim_start_matches('+').parse().unwrap_or(0);
            }
            rest = rest[close + 1..].trim_start();
        }
        if stamps.is_empty() {
            continue;
        }
        let text = strip_word_stamps(rest);
        for ms in stamps {
            stamped.push((ms, text.clone()));
        }
    }
    // Stable: two lines on the same stamp keep the order they were written in.
    stamped.sort_by_key(|(ms, _)| *ms);
    stamped
        .into_iter()
        .map(|(ms, text)| Line { t: (ms - offset_ms).clamp(0, u32::MAX as i64) as u32, text })
        .collect()
}

/// Index of the search result that is this song: within the length
/// tolerance (when the length is known), synced lyrics over plain ones over
/// an instrumental flag, then the closest length, then LRCLIB's own order.
pub(crate) fn pick_best(results: &[Record], duration_ms: Option<u64>) -> Option<usize> {
    results
        .iter()
        .enumerate()
        .filter(|(_, r)| r.has_synced() || r.has_plain() || r.instrumental)
        .filter_map(|(i, r)| {
            let off = match (duration_ms, r.duration) {
                (Some(want), Some(have)) => {
                    let off = (have * 1000.0 - want as f64).abs() as i64;
                    if off > DURATION_TOLERANCE_MS {
                        return None;
                    }
                    off
                }
                _ => 0,
            };
            let rank = if r.has_synced() { 0 } else if r.has_plain() { 1 } else { 2 };
            Some(((rank, off, i), i))
        })
        .min_by_key(|(key, _)| *key)
        .map(|(_, i)| i)
}

/// "Song (feat. X) - Remastered 2011" → "Song". Players add these, LRCLIB
/// files the plain title, so the second search tries without them.
pub(crate) fn clean_title(title: &str) -> String {
    const NOISE: &[&str] = &["feat", "ft.", "with ", "remaster", "version", "edit", "live", "mono", "stereo"];
    let head = title.split(" - ").next().unwrap_or(title);
    let mut out = String::with_capacity(head.len());
    let mut rest = head;
    while let Some(start) = rest.find(['(', '[']) {
        let close = if rest[start..].starts_with('(') { ')' } else { ']' };
        let Some(len) = rest[start..].find(close) else { break };
        let inner = rest[start + 1..start + len].to_ascii_lowercase();
        out.push_str(&rest[..start]);
        if !NOISE.iter().any(|n| inner.contains(n)) {
            out.push_str(&rest[start..=start + len]);
        }
        rest = &rest[start + len + 1..];
    }
    out.push_str(rest);
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// "A, B & C feat. D" → "A": players join every artist, LRCLIB files the first.
pub(crate) fn primary_artist(artist: &str) -> String {
    let lower = artist.to_ascii_lowercase();
    let mut cut = artist.len();
    for sep in [",", " & ", " x ", " feat", " ft.", ";", "/"] {
        if let Some(i) = lower.find(sep) {
            cut = cut.min(i);
        }
    }
    artist[..cut].trim().to_string()
}

pub(crate) fn cache_key(title: &str, artist: &str, album: &str, duration_ms: Option<u64>) -> String {
    // Rounded to the second: the same song reported 161 004 then 160 998 ms
    // is one song.
    let secs = duration_ms.map(|d| (d + 500) / 1000).unwrap_or(0);
    format!("{}\u{1f}{}\u{1f}{}\u{1f}{secs}", title.trim().to_lowercase(), artist.trim().to_lowercase(), album.trim().to_lowercase())
}

struct Cache {
    map: HashMap<String, Option<Lyrics>>,
    order: VecDeque<String>,
}

static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

fn cached(key: &str) -> Option<Option<Lyrics>> {
    CACHE.lock().unwrap().as_ref().and_then(|c| c.map.get(key).cloned())
}

fn remember(key: String, value: Option<Lyrics>) {
    let mut guard = CACHE.lock().unwrap();
    let cache = guard.get_or_insert_with(|| Cache { map: HashMap::new(), order: VecDeque::new() });
    if cache.map.insert(key.clone(), value).is_none() {
        cache.order.push_back(key);
    }
    while cache.order.len() > CACHE_SIZE {
        if let Some(old) = cache.order.pop_front() {
            cache.map.remove(&old);
        }
    }
}

/// A reqwest error names the URL, and the URL names the song: drop it.
fn net(e: reqwest::Error) -> String {
    e.without_url().to_string()
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .map_err(net)
}

/// `/api/get`: LRCLIB's exact match on title, artist, album and length.
async fn get_exact(
    client: &reqwest::Client,
    title: &str,
    artist: &str,
    album: &str,
    duration_ms: Option<u64>,
) -> Result<Option<Record>, String> {
    let mut query: Vec<(&str, String)> = vec![("track_name", title.to_string()), ("artist_name", artist.to_string())];
    if !album.is_empty() {
        query.push(("album_name", album.to_string()));
    }
    if let Some(d) = duration_ms {
        query.push(("duration", ((d + 500) / 1000).to_string()));
    }
    let res = client.get(format!("{API}/get")).query(&query).send().await.map_err(net)?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("lrclib answered {}", res.status()));
    }
    res.json::<Record>().await.map(Some).map_err(net)
}

async fn search(client: &reqwest::Client, title: &str, artist: &str) -> Result<Vec<Record>, String> {
    let res = client
        .get(format!("{API}/search"))
        .query(&[("track_name", title), ("artist_name", artist)])
        .send()
        .await
        .map_err(net)?;
    if !res.status().is_success() {
        return Err(format!("lrclib answered {}", res.status()));
    }
    res.json::<Vec<Record>>().await.map_err(net)
}

/// Lyrics for this song, or None when LRCLIB has none. Err is a network or
/// server failure, which is not cached: the next card asks again.
pub async fn fetch(title: &str, artist: &str, album: &str, duration_ms: Option<u64>) -> Result<Option<Lyrics>, String> {
    let title = title.trim();
    if title.is_empty() {
        return Ok(None);
    }
    let duration_ms = duration_ms.filter(|d| *d > 0);
    let key = cache_key(title, artist, album, duration_ms);
    if let Some(hit) = cached(&key) {
        return Ok(hit);
    }
    let client = client()?;

    // The exact match first: one request, and right for most songs.
    if let Some(record) = get_exact(&client, title, artist.trim(), album.trim(), duration_ms).await? {
        if record.has_synced() || record.has_plain() || record.instrumental {
            let lyrics = record.into_lyrics();
            remember(key, lyrics.clone());
            return Ok(lyrics);
        }
    }

    // Then a search, as reported and then with the noise stripped.
    let mut tries = vec![(title.to_string(), artist.trim().to_string())];
    let simpler = (clean_title(title), primary_artist(artist));
    if simpler != tries[0] && !simpler.0.is_empty() {
        tries.push(simpler);
    }
    for (t, a) in tries {
        let results = search(&client, &t, &a).await?;
        if let Some(i) = pick_best(&results, duration_ms) {
            let lyrics = results.into_iter().nth(i).and_then(Record::into_lyrics);
            remember(key, lyrics.clone());
            return Ok(lyrics);
        }
    }
    remember(key, None);
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(duration: f64, synced: bool, plain: bool, instrumental: bool) -> Record {
        Record {
            duration: Some(duration),
            instrumental,
            plain_lyrics: plain.then(|| "la la".to_string()),
            synced_lyrics: synced.then(|| "[00:01.00]la la".to_string()),
        }
    }

    fn times(lines: &[Line]) -> Vec<u32> {
        lines.iter().map(|l| l.t).collect()
    }

    #[test]
    fn stamps_in_every_precision() {
        assert_eq!(parse_stamp("00:00"), Some(0));
        assert_eq!(parse_stamp("01:02"), Some(62_000));
        assert_eq!(parse_stamp("01:02.5"), Some(62_500));
        assert_eq!(parse_stamp("01:02.05"), Some(62_050));
        assert_eq!(parse_stamp("01:02.005"), Some(62_005));
        assert_eq!(parse_stamp("01:02:50"), Some(62_500));
        assert_eq!(parse_stamp("123:00.00"), Some(7_380_000));
    }

    #[test]
    fn non_stamps_are_rejected() {
        for tag in ["ar:ILLIT", "length:2:41", "1:60", ":12", "12:", "aa:bb", "01:02.1234", "01:02.x", ""] {
            assert_eq!(parse_stamp(tag), None, "{tag}");
        }
    }

    #[test]
    fn parses_a_plain_lrc() {
        let lrc = "[ar:ILLIT]\n[ti:Magnetic]\n[00:01.50] Baby\n[00:03.20]I'm just trying\n\n[00:06.00]\n";
        let lines = parse_lrc(lrc);
        assert_eq!(times(&lines), vec![1_500, 3_200, 6_000]);
        assert_eq!(lines[0].text, "Baby");
        assert_eq!(lines[1].text, "I'm just trying");
        // The gap line stays, empty.
        assert_eq!(lines[2].text, "");
    }

    #[test]
    fn repeated_stamps_and_unsorted_input() {
        let lrc = "[00:30.00][01:30.00]Chorus\n[00:10.00]Verse\n[01:00.00]Bridge";
        let lines = parse_lrc(lrc);
        assert_eq!(times(&lines), vec![10_000, 30_000, 60_000, 90_000]);
        assert_eq!(lines[1].text, "Chorus");
        assert_eq!(lines[3].text, "Chorus");
    }

    #[test]
    fn same_stamp_keeps_written_order() {
        let lines = parse_lrc("[00:05.00]first\n[00:05.00]second");
        assert_eq!(lines[0].text, "first");
        assert_eq!(lines[1].text, "second");
    }

    #[test]
    fn offset_shifts_earlier_and_clamps_at_zero() {
        let lines = parse_lrc("[offset:+500]\n[00:00.20]a\n[00:02.00]b");
        assert_eq!(times(&lines), vec![0, 1_500]);
        let lines = parse_lrc("[offset:-250]\n[00:01.00]a");
        assert_eq!(times(&lines), vec![1_250]);
    }

    #[test]
    fn enhanced_word_stamps_are_dropped() {
        let lines = parse_lrc("[00:01.00]<00:01.00> You <00:01.40> you <00:01.80>you");
        assert_eq!(lines[0].text, "You you you");
        // A "<" that is not a stamp is lyrics.
        let lines = parse_lrc("[00:01.00]I <3 you");
        assert_eq!(lines[0].text, "I <3 you");
    }

    #[test]
    fn lines_without_stamps_and_garbage_are_skipped() {
        assert!(parse_lrc("").is_empty());
        assert!(parse_lrc("just text\n[ar:x]\n[broken").is_empty());
        assert_eq!(parse_lrc("[00:01.00]ok\nnot a line").len(), 1);
    }

    #[test]
    fn crlf_and_unicode() {
        let lines = parse_lrc("[00:01.00]내 심장이 love-dub\r\n[00:02.00]자꾸만 뛰어\r\n");
        assert_eq!(lines[0].text, "내 심장이 love-dub");
        assert_eq!(lines[1].text, "자꾸만 뛰어");
    }

    /// The real "Magnetic" search, which mixes in a 3 s upload, a 50 s clip
    /// and a 235 s edit around the 161 s song.
    #[test]
    fn pick_ignores_other_recordings() {
        let results = vec![
            rec(235.0, true, true, false),
            rec(3.0, true, true, false),
            rec(50.0, true, true, false),
            rec(161.0, true, true, false),
            rec(140.0, true, true, false),
        ];
        assert_eq!(pick_best(&results, Some(160_500)), Some(3));
        // Nothing near the length: nothing, rather than another song's lyrics.
        assert_eq!(pick_best(&results, Some(400_000)), None);
    }

    #[test]
    fn pick_prefers_synced_then_closest() {
        let results = vec![rec(161.0, false, true, false), rec(162.5, true, true, false), rec(161.2, true, true, false)];
        assert_eq!(pick_best(&results, Some(161_000)), Some(2));
        let results = vec![rec(161.0, false, false, true), rec(161.0, false, true, false)];
        assert_eq!(pick_best(&results, Some(161_000)), Some(1));
    }

    #[test]
    fn pick_without_length_takes_the_first_synced() {
        let results = vec![rec(10.0, false, true, false), rec(300.0, true, true, false), rec(20.0, true, true, false)];
        assert_eq!(pick_best(&results, None), Some(1));
    }

    #[test]
    fn pick_skips_empty_records() {
        let results = vec![rec(161.0, false, false, false)];
        assert_eq!(pick_best(&results, Some(161_000)), None);
        assert_eq!(pick_best(&[], Some(161_000)), None);
    }

    #[test]
    fn record_to_lyrics() {
        let r = rec(161.0, true, true, false);
        let l = r.into_lyrics().unwrap();
        assert_eq!(l.synced.len(), 1);
        assert_eq!(l.plain.as_deref(), Some("la la"));
        let l = rec(161.0, false, false, true).into_lyrics().unwrap();
        assert!(l.instrumental && l.synced.is_empty() && l.plain.is_none());
        assert_eq!(rec(161.0, false, false, false).into_lyrics(), None);
    }

    #[test]
    fn cleans_titles() {
        assert_eq!(clean_title("Magnetic"), "Magnetic");
        assert_eq!(clean_title("Hey Jude - Remastered 2015"), "Hey Jude");
        assert_eq!(clean_title("Stay (feat. Justin Bieber)"), "Stay");
        assert_eq!(clean_title("Song [Live] (with Someone)"), "Song");
        // Parentheses that are part of the title stay.
        assert_eq!(clean_title("(I Can't Get No) Satisfaction"), "(I Can't Get No) Satisfaction");
        // A noise group after a real one still goes.
        assert_eq!(clean_title("(I Can't Get No) Satisfaction (Mono Version)"), "(I Can't Get No) Satisfaction");
        assert_eq!(clean_title("Unclosed (feat. X"), "Unclosed (feat. X");
    }

    #[test]
    fn primary_artists() {
        assert_eq!(primary_artist("ILLIT"), "ILLIT");
        assert_eq!(primary_artist("Calvin Harris, Dua Lipa"), "Calvin Harris");
        assert_eq!(primary_artist("Simon & Garfunkel"), "Simon");
        assert_eq!(primary_artist("Artist feat. Other"), "Artist");
        assert_eq!(primary_artist(""), "");
    }

    #[test]
    fn cache_keys_round_the_length() {
        assert_eq!(cache_key("Magnetic", "ILLIT", "", Some(161_004)), cache_key("magnetic ", "illit", "", Some(160_998)));
        assert_ne!(cache_key("Magnetic", "ILLIT", "", Some(161_000)), cache_key("Magnetic", "ILLIT", "", Some(200_000)));
    }

    #[test]
    fn cache_is_bounded() {
        for i in 0..CACHE_SIZE + 10 {
            remember(format!("bounded-{i}"), None);
        }
        let guard = CACHE.lock().unwrap();
        let cache = guard.as_ref().unwrap();
        assert!(cache.map.len() <= CACHE_SIZE);
        assert!(!cache.map.contains_key("bounded-0"));
    }

    #[test]
    fn lyrics_serialize_for_the_island() {
        let l = Lyrics { synced: vec![Line { t: 1500, text: "Baby".into() }], plain: None, instrumental: false };
        let json = serde_json::to_value(&l).unwrap();
        assert_eq!(json["synced"][0]["t"], 1500);
        assert_eq!(json["synced"][0]["text"], "Baby");
        assert_eq!(json["instrumental"], false);
    }

    /// Live eval against lrclib.net. Prints counts only, never lyrics.
    #[test]
    #[ignore]
    fn lyrics_live() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        // As Spotify reports it: the album LRCLIB files differs ("- EP"), so
        // this exercises the search fallback and the length match.
        let found = rt.block_on(fetch("Magnetic", "ILLIT", "SUPER REAL ME", Some(160_900))).unwrap().expect("found");
        println!("lyrics_live: synced={} plain={}", found.synced.len(), found.plain.is_some());
        assert!(found.synced.len() > 10);
        assert!(found.synced.windows(2).all(|w| w[0].t <= w[1].t));
        let missing = rt.block_on(fetch("zzqx no such song 93847", "nobody 2938", "", Some(123_000))).unwrap();
        assert!(missing.is_none());
    }
}
