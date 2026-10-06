// Lyrics for the Music pill, from LRCLIB (https://lrclib.net), a free and
// open lyrics database that needs no key. Only the song's title, artist,
// album and length leave the machine, and only while the "Lyrics" toggle in
// Settings is on. Neither the request nor the lyrics reach the log.
//
// Matching prefers synced lyrics whose length is the song's. When it still
// gets a song wrong, the lyrics detail lets the user search LRCLIB and pick
// a record; that choice is remembered per song in lyrics-choices.json.
//
// Everything that decides something (parsing LRC, which search result fits
// the song, the choices list) is a pure function tested below; `fetch`,
// `search` and `choose` only do the I/O.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
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
/// Within this, a record is the same length as the song: an exact match
/// with synced lyrics this close is taken without searching further.
const SAME_DURATION_MS: i64 = 2_000;
/// Songs kept in memory. A "not found" is kept too, so a song LRCLIB lacks is
/// asked for once per run, not on every card rebuild.
const CACHE_SIZE: usize = 64;
/// Results the manual search shows.
const HITS_MAX: usize = 30;
/// Songs whose manual choice is remembered; the oldest go first.
const CHOICES_MAX: usize = 500;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Line {
    /// Milliseconds from the start of the song.
    pub t: u32,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// The LRCLIB record these come from, so the search can mark it.
    pub id: Option<i64>,
    /// Time-stamped lines, sorted. Empty when LRCLIB only has plain text.
    pub synced: Vec<Line>,
    pub plain: Option<String>,
    pub instrumental: bool,
    /// Picked by hand in the search rather than matched.
    pub chosen: bool,
}

/// One LRCLIB record, as `/api/get` and `/api/search` return it.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Record {
    #[serde(default)]
    pub id: Option<i64>,
    #[serde(default)]
    pub track_name: Option<String>,
    #[serde(default)]
    pub artist_name: Option<String>,
    #[serde(default)]
    pub album_name: Option<String>,
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

    fn into_lyrics(self, chosen: bool) -> Option<Lyrics> {
        let synced = self.synced_lyrics.as_deref().map(parse_lrc).unwrap_or_default();
        let plain = self.plain_lyrics.filter(|s| !s.trim().is_empty());
        if synced.is_empty() && plain.is_none() && !self.instrumental {
            return None;
        }
        Some(Lyrics { id: self.id, synced, plain, instrumental: self.instrumental, chosen })
    }

    /// How far the record's length is from the song's; None when either is unknown.
    fn off_ms(&self, duration_ms: Option<u64>) -> Option<i64> {
        match (duration_ms, self.duration) {
            (Some(want), Some(have)) => Some((have * 1000.0 - want as f64).abs() as i64),
            _ => None,
        }
    }
}

/// One row of the manual search.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    pub id: i64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: Option<u64>,
    pub synced: bool,
    pub plain: bool,
    pub instrumental: bool,
}

/// Sort key of a record for this song, smaller is better: a length that
/// fits (or is unknown) first, then synced over plain over instrumental over
/// empty, then the closest length. `.0 == 0 && .1 < 3` means usable.
fn score(r: &Record, duration_ms: Option<u64>) -> (u8, u8, i64) {
    let off = r.off_ms(duration_ms);
    let fits = off.is_none_or(|o| o <= DURATION_TOLERANCE_MS);
    let kind = if r.has_synced() {
        0
    } else if r.has_plain() {
        1
    } else if r.instrumental {
        2
    } else {
        3
    };
    (u8::from(!fits), kind, off.unwrap_or(0))
}

/// The search's rows, best first by the same rules the automatic match uses,
/// so the right one is usually on top. Records without an id cannot be
/// picked and are dropped, as are duplicates.
pub(crate) fn hits(records: Vec<Record>, duration_ms: Option<u64>) -> Vec<Hit> {
    let mut seen = std::collections::HashSet::new();
    let mut scored: Vec<((u8, u8, i64), usize, Record)> = records
        .into_iter()
        .enumerate()
        .filter(|(_, r)| r.id.is_some_and(|id| seen.insert(id)))
        .map(|(i, r)| (score(&r, duration_ms), i, r))
        .collect();
    scored.sort_by_key(|(s, i, _)| (*s, *i));
    scored
        .into_iter()
        .take(HITS_MAX)
        .map(|(_, _, r)| Hit {
            id: r.id.unwrap_or_default(),
            synced: r.has_synced(),
            plain: r.has_plain(),
            instrumental: r.instrumental,
            title: r.track_name.unwrap_or_default(),
            artist: r.artist_name.unwrap_or_default(),
            album: r.album_name.unwrap_or_default(),
            duration_ms: r.duration.filter(|d| *d > 0.0).map(|d| (d * 1000.0).round() as u64),
        })
        .collect()
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

/// Index of the record that is this song: within the length tolerance (when
/// the length is known), synced lyrics over plain ones over an instrumental
/// flag, then the closest length, then the order given. None rather than
/// another recording's lyrics.
pub(crate) fn pick_best(results: &[Record], duration_ms: Option<u64>) -> Option<usize> {
    results
        .iter()
        .enumerate()
        .map(|(i, r)| (score(r, duration_ms), i))
        .filter(|((fits, kind, _), _)| *fits == 0 && *kind < 3)
        .min()
        .map(|(_, i)| i)
}

/// Whether `r` settles the search on its own: synced and the song's length.
fn is_sure(r: &Record, duration_ms: Option<u64>) -> bool {
    r.has_synced() && r.off_ms(duration_ms).map_or(true, |o| o <= SAME_DURATION_MS)
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

/// `/api/get/{id}`: one record, as picked in the manual search.
async fn get_by_id(client: &reqwest::Client, id: i64) -> Result<Option<Record>, String> {
    let res = client.get(format!("{API}/get/{id}")).send().await.map_err(net)?;
    if res.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !res.status().is_success() {
        return Err(format!("lrclib answered {}", res.status()));
    }
    res.json::<Record>().await.map(Some).map_err(net)
}

async fn search_with(client: &reqwest::Client, query: &[(&str, &str)]) -> Result<Vec<Record>, String> {
    let res = client.get(format!("{API}/search")).query(query).send().await.map_err(net)?;
    if !res.status().is_success() {
        return Err(format!("lrclib answered {}", res.status()));
    }
    res.json::<Vec<Record>>().await.map_err(net)
}

fn forget(key: &str) {
    let mut guard = CACHE.lock().unwrap();
    if let Some(cache) = guard.as_mut() {
        cache.map.remove(key);
        cache.order.retain(|k| k != key);
    }
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

    // A record the user picked for this song wins over any match.
    if let Some(id) = choices::get(&key) {
        if let Some(record) = get_by_id(&client, id).await? {
            let lyrics = record.into_lyrics(true);
            remember(key, lyrics.clone());
            return Ok(lyrics);
        }
    }

    // The exact match first: one request, and enough when it is synced and
    // the song's length. Otherwise it only joins the pool below, where a
    // synced record of the right length can still beat it.
    let mut pool: Vec<Record> = Vec::new();
    if let Some(record) = get_exact(&client, title, artist.trim(), album.trim(), duration_ms).await? {
        if is_sure(&record, duration_ms) {
            let lyrics = record.into_lyrics(false);
            remember(key, lyrics.clone());
            return Ok(lyrics);
        }
        pool.push(record);
    }

    // Then searches, widest last, until one gives a sure record: as reported,
    // with the noise stripped, then free text (another spelling of the artist).
    let simpler = (clean_title(title), primary_artist(artist));
    let free = format!("{} {}", simpler.0, simpler.1);
    let mut tries: Vec<Vec<(&str, &str)>> = vec![vec![("track_name", title), ("artist_name", artist.trim())]];
    if (simpler.0.as_str(), simpler.1.as_str()) != (title, artist.trim()) && !simpler.0.is_empty() {
        tries.push(vec![("track_name", &simpler.0), ("artist_name", &simpler.1)]);
    }
    tries.push(vec![("q", free.trim())]);
    for query in tries {
        match search_with(&client, &query).await {
            Ok(results) => pool.extend(results),
            // A later search failing does not waste what the earlier ones found.
            Err(err) if pool.is_empty() => return Err(err),
            Err(_) => break,
        }
        if pool.iter().any(|r| is_sure(r, duration_ms)) {
            break;
        }
    }
    let lyrics = pick_best(&pool, duration_ms).and_then(|i| pool.swap_remove(i).into_lyrics(false));
    remember(key, lyrics.clone());
    Ok(lyrics)
}

/// The manual search: LRCLIB's free-text search, best rows for this song first.
pub async fn search(query: &str, duration_ms: Option<u64>) -> Result<Vec<Hit>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let client = client()?;
    let records = search_with(&client, &[("q", query)]).await?;
    Ok(hits(records, duration_ms.filter(|d| *d > 0)))
}

/// Uses record `id` for this song from now on, remembered across runs.
/// `None` forgets the choice and goes back to the automatic match.
pub async fn choose(
    title: &str,
    artist: &str,
    album: &str,
    duration_ms: Option<u64>,
    id: Option<i64>,
) -> Result<Option<Lyrics>, String> {
    let duration_ms = duration_ms.filter(|d| *d > 0);
    let key = cache_key(title.trim(), artist, album, duration_ms);
    let Some(id) = id else {
        choices::set(&key, None)?;
        forget(&key);
        return fetch(title, artist, album, duration_ms).await;
    };
    let client = client()?;
    let record = get_by_id(&client, id).await?.ok_or("That record is gone from LRCLIB")?;
    let lyrics = record.into_lyrics(true).ok_or("That record has no lyrics")?;
    choices::set(&key, Some(id))?;
    remember(key, Some(lyrics.clone()));
    Ok(Some(lyrics))
}

/// The songs whose lyrics were picked by hand, in lyrics-choices.json next to
/// settings.json: `[{ "key": "<cache_key>", "id": <lrclib id> }]`, newest last.
mod choices {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    pub(crate) struct Choice {
        pub key: String,
        pub id: i64,
    }

    /// Puts or removes the choice for `key`, keeping the newest CHOICES_MAX.
    pub(crate) fn apply(list: &mut Vec<Choice>, key: &str, id: Option<i64>) {
        list.retain(|c| c.key != key);
        if let Some(id) = id {
            list.push(Choice { key: key.to_string(), id });
        }
        if list.len() > CHOICES_MAX {
            let extra = list.len() - CHOICES_MAX;
            list.drain(..extra);
        }
    }

    pub(crate) fn load(path: &Path) -> Vec<Choice> {
        std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
    }

    pub(crate) fn save(path: &Path, list: &[Choice]) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            crate::platform::ensure_private_dir(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    fn path() -> PathBuf {
        crate::settings::config_dir().join("lyrics-choices.json")
    }

    /// Read once, then kept in memory.
    static LIST: Mutex<Option<Vec<Choice>>> = Mutex::new(None);

    pub(crate) fn get(key: &str) -> Option<i64> {
        let mut guard = LIST.lock().unwrap();
        let list = guard.get_or_insert_with(|| load(&path()));
        list.iter().find(|c| c.key == key).map(|c| c.id)
    }

    pub(crate) fn set(key: &str, id: Option<i64>) -> Result<(), String> {
        let mut guard = LIST.lock().unwrap();
        let list = guard.get_or_insert_with(|| load(&path()));
        apply(list, key, id);
        save(&path(), list)
    }
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
            ..Record::default()
        }
    }

    fn with_id(id: i64, r: Record) -> Record {
        Record { id: Some(id), track_name: Some(format!("t{id}")), ..r }
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
        let l = r.into_lyrics(false).unwrap();
        assert_eq!(l.synced.len(), 1);
        assert_eq!(l.plain.as_deref(), Some("la la"));
        let l = rec(161.0, false, false, true).into_lyrics(true).unwrap();
        assert!(l.chosen);
        assert!(l.instrumental && l.synced.is_empty() && l.plain.is_none());
        assert_eq!(rec(161.0, false, false, false).into_lyrics(false), None);
        assert_eq!(with_id(7, rec(161.0, true, false, false)).into_lyrics(false).unwrap().id, Some(7));
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
        let l = Lyrics {
            id: Some(3),
            synced: vec![Line { t: 1500, text: "Baby".into() }],
            plain: None,
            instrumental: false,
            chosen: true,
        };
        let json = serde_json::to_value(&l).unwrap();
        assert_eq!(json["synced"][0]["t"], 1500);
        assert_eq!(json["synced"][0]["text"], "Baby");
        assert_eq!(json["instrumental"], false);
        assert_eq!(json["id"], 3);
        assert_eq!(json["chosen"], true);
    }

    /// The exact match only had plain lyrics; a synced record of the same
    /// length from the search must win over it.
    #[test]
    fn synced_same_length_beats_an_exact_plain_match() {
        let pool = vec![rec(161.0, false, true, false), rec(240.0, true, true, false), rec(161.4, true, true, false)];
        assert_eq!(pick_best(&pool, Some(161_000)), Some(2));
    }

    #[test]
    fn sure_means_synced_and_the_same_length() {
        assert!(is_sure(&rec(161.0, true, false, false), Some(162_500)));
        assert!(!is_sure(&rec(161.0, true, false, false), Some(163_500)));
        assert!(!is_sure(&rec(161.0, false, true, false), Some(161_000)));
        // Length unknown: synced is all there is to check.
        assert!(is_sure(&rec(161.0, true, false, false), None));
    }

    #[test]
    fn hits_rank_like_the_automatic_match() {
        let records = vec![
            with_id(1, rec(240.0, true, true, false)),
            with_id(2, rec(161.0, false, true, false)),
            with_id(3, rec(161.5, true, true, false)),
            with_id(4, rec(161.0, false, false, true)),
            with_id(5, rec(3.0, true, false, false)),
        ];
        let ids: Vec<i64> = hits(records, Some(161_000)).iter().map(|h| h.id).collect();
        // Fitting ones first (synced, plain, instrumental), then the rest, closest length first.
        assert_eq!(ids, vec![3, 2, 4, 1, 5]);
    }

    #[test]
    fn hits_drop_unpickable_and_duplicate_records() {
        let records = vec![
            rec(161.0, true, true, false),
            with_id(9, rec(161.0, true, true, false)),
            with_id(9, rec(161.0, true, true, false)),
        ];
        let h = hits(records, Some(161_000));
        assert_eq!(h.len(), 1);
        assert_eq!(h[0].id, 9);
        assert_eq!(h[0].title, "t9");
        assert_eq!(h[0].duration_ms, Some(161_000));
        assert!(h[0].synced && h[0].plain && !h[0].instrumental);
    }

    #[test]
    fn hits_are_capped_and_serialize_camel_case() {
        let records: Vec<Record> = (0..50).map(|i| with_id(i, rec(161.0, true, false, false))).collect();
        let h = hits(records, None);
        assert_eq!(h.len(), HITS_MAX);
        let json = serde_json::to_value(&h[0]).unwrap();
        assert_eq!(json["durationMs"], 161_000);
        assert_eq!(json["synced"], true);
    }

    #[test]
    fn choices_replace_remove_and_stay_bounded() {
        let mut list = Vec::new();
        choices::apply(&mut list, "a", Some(1));
        choices::apply(&mut list, "b", Some(2));
        choices::apply(&mut list, "a", Some(3));
        assert_eq!(list.iter().map(|c| (c.key.as_str(), c.id)).collect::<Vec<_>>(), vec![("b", 2), ("a", 3)]);
        choices::apply(&mut list, "b", None);
        assert_eq!(list.len(), 1);
        for i in 0..CHOICES_MAX + 5 {
            choices::apply(&mut list, &format!("k{i}"), Some(i as i64));
        }
        assert_eq!(list.len(), CHOICES_MAX);
        // The oldest went first.
        assert!(!list.iter().any(|c| c.key == "a"));
        assert_eq!(list.last().unwrap().key, format!("k{}", CHOICES_MAX + 4));
    }

    #[test]
    fn choices_survive_a_restart() {
        let dir = std::env::temp_dir().join(format!("coucou-lyrics-test-{}", std::process::id()));
        let path = dir.join("lyrics-choices.json");
        let mut list = Vec::new();
        choices::apply(&mut list, "magnetic", Some(7_424_652));
        choices::save(&path, &list).unwrap();
        assert_eq!(choices::load(&path), list);
        // A broken or missing file is an empty list, not an error.
        std::fs::write(&path, b"{nope").unwrap();
        assert!(choices::load(&path).is_empty());
        assert!(choices::load(&dir.join("missing.json")).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
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
        // The manual search puts a synced record of the right length on top.
        let rows = rt.block_on(search("Magnetic ILLIT", Some(160_900))).unwrap();
        println!("lyrics_live: search rows={}", rows.len());
        let top = rows.first().expect("rows");
        assert!(top.synced);
        assert!(top.duration_ms.is_some_and(|d| d.abs_diff(160_900) <= 3_000));
    }
}
