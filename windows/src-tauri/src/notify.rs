// Messages from Discord, Slack, Telegram and WhatsApp, read from the toasts
// Windows keeps in Action Center (UserNotificationListener). No account, no
// token, no network: if the desktop app shows a toast, Mochi can see it.
// Message contents are handed to the island and nowhere else; they never
// reach the log.
//
// Toast layouts differ per app and change with app updates, so the parsing is
// a pure function (`parse_message`) with fixtures in the tests below: when an
// app changes its layout, add the new shape as a fixture and adjust there.


use std::collections::HashSet;

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: u32,
    /// "discord" | "slack" | "telegram" | "whatsapp"
    pub app: String,
    pub sender: String,
    /// Discord server, Slack workspace, Telegram or WhatsApp group.
    pub place: Option<String>,
    /// "#general" for Slack and Discord channels.
    pub channel: Option<String>,
    pub text: String,
    /// Unix milliseconds, from the toast's CreationTime.
    pub at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollResult {
    /// Toasts not seen by the previous poll, newest first.
    pub messages: Vec<Message>,
    /// True on the first poll: these were already in Action Center before we
    /// looked, so the caller must not announce them as new.
    pub first: bool,
}

pub struct Listener {
    seen: HashSet<u32>,
    primed: bool,
}

impl Default for Listener {
    fn default() -> Self {
        Self::new()
    }
}

impl Listener {
    pub fn new() -> Self {
        Self { seen: HashSet::new(), primed: false }
    }

    /// Blocking (WinRT .get()); the caller runs it in spawn_blocking.
    /// `apps` are the enabled app keys; toasts from other apps are ignored but
    /// still remembered, so enabling an app later doesn't replay its backlog.
    pub fn poll(&mut self, apps: &[String], slack_workspace: &str) -> Result<PollResult, String> {
        let toasts = imp::read_toasts()?;
        let ids: Vec<u32> = toasts.iter().map(|t| t.id).collect();
        let fresh = remember(&mut self.seen, &ids);
        let first = !self.primed;
        self.primed = true;

        let mut messages: Vec<Message> = toasts
            .into_iter()
            .filter(|t| fresh.contains(&t.id))
            .filter_map(|t| {
                let app = app_for_aumid(&t.aumid)?;
                if !apps.iter().any(|a| a.eq_ignore_ascii_case(app)) {
                    return None;
                }
                let (sender, place, channel, text) = parse_message(app, &t.texts, slack_workspace)?;
                Some(Message { id: t.id, app: app.to_string(), sender, place, channel, text, at: t.at })
            })
            .collect();
        messages.sort_by(|a, b| b.at.cmp(&a.at).then(b.id.cmp(&a.id)));
        Ok(PollResult { messages, first })
    }
}

/// What one toast says, before deciding whether it matters.
#[derive(Debug, Clone)]
pub(crate) struct Toast {
    pub id: u32,
    pub aumid: String,
    pub texts: Vec<String>,
    pub at: i64,
}

/// Returns the ids in `current` that were not in `seen`, then makes `seen`
/// exactly `current`. Dismissed toasts drop out, so the set never grows
/// beyond what Action Center holds.
pub(crate) fn remember(seen: &mut HashSet<u32>, current: &[u32]) -> HashSet<u32> {
    let current: HashSet<u32> = current.iter().copied().collect();
    let fresh = current.difference(seen).copied().collect();
    *seen = current;
    fresh
}

/// Asks once for notification access (RequestAccessAsync), returns whether allowed.
pub fn request_access() -> Result<bool, String> {
    imp::request_access()
}

/// Which messaging app sent a toast, from its AppUserModelId. Matching is on
/// a fragment, case-insensitively, because the ids differ between the
/// installer and Store builds (Slack "com.squirrel.slack.slack", WhatsApp
/// "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App").
pub fn app_for_aumid(aumid: &str) -> Option<&'static str> {
    let lower = aumid.to_ascii_lowercase();
    ["discord", "slack", "telegram", "whatsapp"].into_iter().find(|key| lower.contains(key))
}

/// WinRT DateTime (100 ns ticks since 1601-01-01 UTC) to Unix milliseconds.
pub(crate) fn winrt_ticks_to_unix_ms(ticks: i64) -> i64 {
    const UNIX_EPOCH_TICKS: i64 = 116_444_736_000_000_000;
    ticks.saturating_sub(UNIX_EPOCH_TICKS).div_euclid(10_000)
}

/// Splits a toast's texts into (sender, place, channel, text). Pure: every
/// layout it knows is a fixture in the tests. Returns None when the toast
/// doesn't look like a message (too few lines, nothing to show).
pub fn parse_message(
    app: &str,
    texts: &[String],
    slack_workspace: &str,
) -> Option<(String, Option<String>, Option<String>, String)> {
    let title = clean(texts.first()?);
    // Telegram Desktop fills a three-line template: chat, subtitle, message.
    // In a group the subtitle is the sender; with no subtitle the message
    // moves up to the second line and the third is left as template
    // whitespace (seen on Windows 11 with Telegram 5.x), which the generic
    // path below handles.
    if app == "telegram" && texts.len() >= 3 {
        let subtitle = clean(&texts[1]);
        let message = texts[2..].iter().map(|t| clean(t)).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
        if !title.is_empty() && !subtitle.is_empty() && !message.is_empty() {
            let place = (subtitle != title).then(|| title.clone());
            return Some((subtitle, place, None, message));
        }
    }
    // Anything after the title is the message. Apps sometimes split a long or
    // multi-part message across text elements; keep them as lines.
    let body = texts[1..].iter().map(|t| clean(t)).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n");
    if title.is_empty() || body.is_empty() {
        return None;
    }
    match app {
        "slack" => parse_slack(title, body, slack_workspace),
        "discord" => parse_discord(title, body),
        "telegram" | "whatsapp" => parse_chat(title, body),
        _ => None,
    }
}

type Parsed = (String, Option<String>, Option<String>, String);

// Slack never puts the workspace in the toast, so it comes from Settings.
//   channel: ["#design" or "design", "Ana Lima: text"]
//   DM:      ["Ana Lima", "text"]
//   group DM: ["Ana Lima, Bo", "Ana Lima: text"]
fn parse_slack(title: String, body: String, workspace: &str) -> Option<Parsed> {
    let workspace = workspace.trim();
    let place = (!workspace.is_empty()).then(|| workspace.to_string());
    let prefixed = split_sender(&body);
    if let Some(name) = title.strip_prefix('#') {
        let channel = channel_tag(name)?;
        return Some(match prefixed {
            Some((sender, text)) => (sender, place, Some(channel), text),
            // A channel toast without "Name:" (an app or bot post): the
            // channel itself is the best sender we have.
            None => (channel.clone(), place, Some(channel), body),
        });
    }
    if let Some((sender, text)) = prefixed {
        // Slack channel names are lowercase with no spaces; a person's name
        // almost never is. That is what tells "design" (a channel) from
        // "Ana" (a DM whose text happens to contain a colon).
        if looks_like_slack_channel(&title) {
            return Some((sender, place, channel_tag(&title), text));
        }
        // A group DM's title lists the members, the sender among them.
        if title != sender && title.contains(&sender) {
            return Some((sender, place, None, text));
        }
    }
    Some((title, place, None, body))
}

fn looks_like_slack_channel(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|c| c.is_lowercase() || c.is_numeric() || matches!(c, '-' | '_' | '.'))
        && name.chars().any(|c| c.is_alphanumeric())
}

// Discord's desktop app puts the context in the title:
//   server:   ["Ana (#general, Design Club)", "text"]
//   DM:       ["Ana", "text"]
//   group DM: ["Ana (Weekend plans)", "text"]
fn parse_discord(title: String, body: String) -> Option<Parsed> {
    let Some((author, context)) = split_trailing_parens(&title) else {
        return Some((title, None, None, body));
    };
    if let Some(rest) = context.strip_prefix('#') {
        // Channel names can't hold a comma, server names can: split once.
        let (channel, server) = match rest.split_once(',') {
            Some((c, s)) => (c.trim(), Some(s.trim().to_string()).filter(|s| !s.is_empty())),
            None => (rest.trim(), None),
        };
        return Some((author, server, channel_tag(channel), body));
    }
    // No '#': a group DM's name (which may itself contain commas).
    Some((author, Some(context), None, body))
}

// Telegram and WhatsApp: the title is the chat; in a group the body starts
// with the sender. In a private chat the title is the person.
//   group:   ["Family", "Ana: text"]
//   private: ["Ana", "text"]
fn parse_chat(title: String, body: String) -> Option<Parsed> {
    match split_sender(&body) {
        // "Ana" writing "Ana: hi" in a private chat isn't a group.
        Some((sender, text)) if sender != title => Some((sender, Some(title), None, text)),
        _ => Some((title, None, None, body)),
    }
}

/// "Ana Lima: hello" → ("Ana Lima", "hello"). Only on the first line, only a
/// short name-like prefix, so "see https://x" or a long sentence with a
/// colon stays text.
fn split_sender(body: &str) -> Option<(String, String)> {
    let first_line = body.lines().next()?;
    let (raw, _) = first_line.split_once(": ")?;
    let name = raw.trim();
    if name.is_empty() || name.chars().count() > 64 || name.contains("://") {
        return None;
    }
    // `first_line` is a prefix of `body`, so the rest (later lines included)
    // starts right after "name: ".
    let text = body[raw.len() + 2..].trim();
    if text.is_empty() {
        return None;
    }
    Some((name.to_string(), text.to_string()))
}

/// "(#general, Design Club)" at the end of "Ana (#general, Design Club)".
fn split_trailing_parens(title: &str) -> Option<(String, String)> {
    let inner = title.strip_suffix(')')?;
    let open = inner.rfind(" (")?;
    let author = inner[..open].trim();
    let context = inner[open + 2..].trim();
    if author.is_empty() || context.is_empty() {
        return None;
    }
    Some((author.to_string(), context.to_string()))
}

fn channel_tag(name: &str) -> Option<String> {
    let name = name.trim().trim_start_matches('#').trim();
    (!name.is_empty()).then(|| format!("#{name}"))
}

/// Trims, normalises line endings, and drops the invisible direction marks
/// Telegram and WhatsApp wrap names in (they break equality and look like
/// stray spaces when copied).
fn clean(s: &str) -> String {
    s.replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|c| !matches!(c, '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}'))
        .collect::<String>()
        .trim()
        .to_string()
}

#[cfg(windows)]
mod imp {
    use ::windows::UI::Notifications::Management::{UserNotificationListener, UserNotificationListenerAccessStatus};
    use ::windows::UI::Notifications::{KnownNotificationBindings, NotificationKinds, UserNotification};

    use super::{winrt_ticks_to_unix_ms, Toast};

    fn err(what: &str, e: ::windows::core::Error) -> String {
        format!("{what}: {}", e.message())
    }

    // `.get()` blocks until WinRT answers: run from spawn_blocking (an MTA
    // worker), never from the UI thread, which is an STA.
    pub fn request_access() -> Result<bool, String> {
        let listener = UserNotificationListener::Current().map_err(|e| err("notification listener", e))?;
        // RequestAccessAsync can fail outright for an unpackaged process (it
        // wants a UI thread to prompt from); what Windows already decided is
        // then the answer.
        let status = match listener.RequestAccessAsync().and_then(|op| op.get()) {
            Ok(status) => status,
            Err(_) => listener.GetAccessStatus().map_err(|e| err("notification access", e))?,
        };
        Ok(status == UserNotificationListenerAccessStatus::Allowed)
    }

    pub fn read_toasts() -> Result<Vec<Toast>, String> {
        let listener = UserNotificationListener::Current().map_err(|e| err("notification listener", e))?;
        let status = listener.GetAccessStatus().map_err(|e| err("notification access", e))?;
        if status != UserNotificationListenerAccessStatus::Allowed {
            return Err("notification access is off (Settings > Privacy & security > Notifications)".into());
        }
        let list = listener
            .GetNotificationsAsync(NotificationKinds::Toast)
            .and_then(|op| op.get())
            .map_err(|e| err("notifications", e))?;
        let generic = KnownNotificationBindings::ToastGeneric().ok();
        // A toast that can't be read (dismissed mid-read, odd template) is
        // still listed with no texts, so it counts as seen and is not retried.
        Ok(list.into_iter().filter_map(|n| read(&n, generic.as_ref())).collect())
    }

    fn read(n: &UserNotification, generic: Option<&::windows::core::HSTRING>) -> Option<Toast> {
        let id = n.Id().ok()?;
        let aumid = n.AppInfo().and_then(|a| a.AppUserModelId()).map(|s| s.to_string()).unwrap_or_default();
        let at = n.CreationTime().map(|t| winrt_ticks_to_unix_ms(t.UniversalTime)).unwrap_or(0);
        let texts = texts(n, generic).unwrap_or_default();
        Some(Toast { id, aumid, texts, at })
    }

    fn texts(n: &UserNotification, generic: Option<&::windows::core::HSTRING>) -> Option<Vec<String>> {
        let visual = n.Notification().and_then(|x| x.Visual()).ok()?;
        // ToastGeneric is what every modern app uses; legacy templates
        // (ToastText02…) have their own name, so fall back to the first one.
        let binding = generic
            .and_then(|g| visual.GetBinding(g).ok())
            .or_else(|| visual.Bindings().ok().and_then(|b| b.into_iter().next()))?;
        let elements = binding.GetTextElements().ok()?;
        Some(elements.into_iter().filter_map(|t| t.Text().ok()).map(|s| s.to_string()).collect())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::Toast;

    pub fn request_access() -> Result<bool, String> {
        Ok(false)
    }

    pub fn read_toasts() -> Result<Vec<Toast>, String> {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(texts: &[&str]) -> Vec<String> {
        texts.iter().map(|s| s.to_string()).collect()
    }

    fn p(app: &str, texts: &[&str], ws: &str) -> Option<(String, Option<String>, Option<String>, String)> {
        parse_message(app, &t(texts), ws)
    }

    fn some(sender: &str, place: Option<&str>, channel: Option<&str>, text: &str) -> Option<Parsed> {
        Some((sender.into(), place.map(Into::into), channel.map(Into::into), text.into()))
    }

    // ---- Slack ----

    #[test]
    fn slack_channel_with_hash() {
        assert_eq!(
            p("slack", &["#design-team", "Ana Lima: can you look at the mock?"], "Acme"),
            some("Ana Lima", Some("Acme"), Some("#design-team"), "can you look at the mock?")
        );
    }

    #[test]
    fn slack_channel_without_hash() {
        assert_eq!(
            p("slack", &["abc-defg-hijk", "Bo Chen: deploy is green"], "Acme"),
            some("Bo Chen", Some("Acme"), Some("#abc-defg-hijk"), "deploy is green")
        );
    }

    #[test]
    fn slack_dm() {
        assert_eq!(p("slack", &["Ana Lima", "lunch?"], "Acme"), some("Ana Lima", Some("Acme"), None, "lunch?"));
    }

    #[test]
    fn slack_dm_whose_text_has_a_colon() {
        assert_eq!(
            p("slack", &["Ana Lima", "Note: the build is red"], "Acme"),
            some("Ana Lima", Some("Acme"), None, "Note: the build is red")
        );
    }

    #[test]
    fn slack_group_dm() {
        assert_eq!(
            p("slack", &["Ana Lima, Bo Chen", "Bo Chen: on my way"], "Acme"),
            some("Bo Chen", Some("Acme"), None, "on my way")
        );
    }

    #[test]
    fn slack_channel_post_without_sender() {
        assert_eq!(
            p("slack", &["#alerts", "CPU above 90%"], ""),
            some("#alerts", None, Some("#alerts"), "CPU above 90%")
        );
    }

    #[test]
    fn slack_without_workspace_has_no_place() {
        assert_eq!(p("slack", &["Ana", "hi"], "  "), some("Ana", None, None, "hi"));
    }

    #[test]
    fn slack_lone_hash_title_is_not_a_message() {
        assert_eq!(p("slack", &["#", "Ana: hi"], "Acme"), None);
    }

    // ---- Discord ----

    #[test]
    fn discord_server_message() {
        assert_eq!(
            p("discord", &["Ana (#general, Design Club)", "who's in tonight?"], ""),
            some("Ana", Some("Design Club"), Some("#general"), "who's in tonight?")
        );
    }

    #[test]
    fn discord_server_name_with_comma() {
        assert_eq!(
            p("discord", &["Ana (#general, Cats, Dogs & Friends)", "hi"], ""),
            some("Ana", Some("Cats, Dogs & Friends"), Some("#general"), "hi")
        );
    }

    #[test]
    fn discord_channel_without_server() {
        assert_eq!(p("discord", &["Ana (#general)", "hi"], ""), some("Ana", None, Some("#general"), "hi"));
    }

    #[test]
    fn discord_dm() {
        assert_eq!(p("discord", &["Ana", "hey"], ""), some("Ana", None, None, "hey"));
    }

    #[test]
    fn discord_group_dm() {
        assert_eq!(
            p("discord", &["Ana (Weekend plans)", "saturday?"], ""),
            some("Ana", Some("Weekend plans"), None, "saturday?")
        );
        assert_eq!(
            p("discord", &["Ana (Bo, Cy, Di)", "saturday?"], ""),
            some("Ana", Some("Bo, Cy, Di"), None, "saturday?")
        );
    }

    #[test]
    fn discord_author_with_parens_in_name() {
        assert_eq!(
            p("discord", &["Ana (she/her) (#general, Club)", "hi"], ""),
            some("Ana (she/her)", Some("Club"), Some("#general"), "hi")
        );
    }

    #[test]
    fn discord_body_colon_is_text() {
        assert_eq!(p("discord", &["Ana", "Todo: buy milk"], ""), some("Ana", None, None, "Todo: buy milk"));
    }

    // ---- Telegram / WhatsApp ----

    #[test]
    fn telegram_group() {
        assert_eq!(
            p("telegram", &["Family", "Mum: dinner at 8"], ""),
            some("Mum", Some("Family"), None, "dinner at 8")
        );
    }

    #[test]
    fn telegram_private() {
        assert_eq!(p("telegram", &["Ana", "see you"], ""), some("Ana", None, None, "see you"));
    }

    #[test]
    fn telegram_private_with_own_name_prefix() {
        assert_eq!(p("telegram", &["Ana", "Ana: see you"], ""), some("Ana", None, None, "Ana: see you"));
    }

    #[test]
    fn telegram_three_line_private() {
        // Observed layout: the message on line 2, line 3 left as template whitespace.
        assert_eq!(p("telegram", &["Ana", "see you", "\n\t\t"], ""), some("Ana", None, None, "see you"));
        // Previews hidden in Telegram: the placeholder is still a message.
        assert_eq!(
            p("telegram", &["Ana", "You have a new message", "\n\t\t"], ""),
            some("Ana", None, None, "You have a new message")
        );
    }

    #[test]
    fn telegram_three_line_group() {
        assert_eq!(
            p("telegram", &["Family", "Mum", "dinner at 8\nbring bread"], ""),
            some("Mum", Some("Family"), None, "dinner at 8\nbring bread")
        );
        // Subtitle that repeats the chat isn't a group.
        assert_eq!(p("telegram", &["Ana", "Ana", "hi"], ""), some("Ana", None, None, "hi"));
        // Empty subtitle with the message on line 3.
        assert_eq!(p("telegram", &["Ana", "", "hi"], ""), some("Ana", None, None, "hi"));
    }

    #[test]
    fn whatsapp_group_and_private() {
        assert_eq!(p("whatsapp", &["Climbing", "Bo: 7pm?"], ""), some("Bo", Some("Climbing"), None, "7pm?"));
        assert_eq!(p("whatsapp", &["Bo", "ok"], ""), some("Bo", None, None, "ok"));
    }

    #[test]
    fn whatsapp_direction_marks_are_removed() {
        assert_eq!(
            p("whatsapp", &["\u{2068}Climbing\u{2069}", "\u{200E}Bo\u{200E}: 7pm?"], ""),
            some("Bo", Some("Climbing"), None, "7pm?")
        );
    }

    #[test]
    fn url_is_not_a_sender() {
        assert_eq!(
            p("telegram", &["Ana", "https://example.com: look"], ""),
            some("Ana", None, None, "https://example.com: look")
        );
    }

    // ---- Shape edge cases ----

    #[test]
    fn too_few_texts() {
        assert_eq!(p("slack", &[], "Acme"), None);
        assert_eq!(p("slack", &["Ana"], "Acme"), None);
        assert_eq!(p("discord", &["Ana (#general, Club)"], ""), None);
    }

    #[test]
    fn empty_strings() {
        assert_eq!(p("telegram", &["", "hi"], ""), None);
        assert_eq!(p("telegram", &["Ana", ""], ""), None);
        assert_eq!(p("telegram", &["  ", "   "], ""), None);
        assert_eq!(p("slack", &["Ana", "Bo: "], ""), some("Ana", None, None, "Bo:"));
    }

    #[test]
    fn unknown_app() {
        assert_eq!(p("teams", &["Ana", "hi"], ""), None);
    }

    #[test]
    fn multiline_kept_and_trimmed() {
        assert_eq!(
            p("telegram", &["  Family ", " Mum: line one\r\nline two \n"], ""),
            some("Mum", Some("Family"), None, "line one\nline two")
        );
        assert_eq!(p("discord", &["Ana", "a\n\nb"], ""), some("Ana", None, None, "a\n\nb"));
    }

    #[test]
    fn extra_text_elements_become_lines() {
        assert_eq!(p("discord", &["Ana", "one", "", "two"], ""), some("Ana", None, None, "one\ntwo"));
        assert_eq!(p("whatsapp", &["Ana", "one", " ", "two"], ""), some("Ana", None, None, "one\ntwo"));
    }

    #[test]
    fn odd_input_never_panics() {
        let weird = ["(", ")", " ()", "#", "#,", "(#,)", ": ", "::", "é: ü", "🙂 (🙂)", "a (#, )", "\u{200E}"];
        for app in ["slack", "discord", "telegram", "whatsapp"] {
            for a in weird {
                for b in weird {
                    let _ = p(app, &[a, b], "ws");
                    let _ = p(app, &[a, b, a], "");
                }
            }
        }
    }

    #[test]
    fn multibyte_sender() {
        assert_eq!(p("telegram", &["Семья", "Мама: привет"], ""), some("Мама", Some("Семья"), None, "привет"));
    }

    // ---- AUMIDs ----

    #[test]
    fn aumids() {
        assert_eq!(app_for_aumid("com.squirrel.slack.slack"), Some("slack"));
        assert_eq!(app_for_aumid("com.squirrel.Discord.Discord"), Some("discord"));
        assert_eq!(app_for_aumid("Telegram.TelegramDesktop"), Some("telegram"));
        assert_eq!(app_for_aumid("5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App"), Some("whatsapp"));
        assert_eq!(app_for_aumid("Microsoft.Windows.Explorer"), None);
        assert_eq!(app_for_aumid(""), None);
    }

    // ---- Time ----

    #[test]
    fn ticks_to_unix_ms() {
        assert_eq!(winrt_ticks_to_unix_ms(116_444_736_000_000_000), 0);
        assert_eq!(winrt_ticks_to_unix_ms(116_444_736_000_010_000), 1);
        assert_eq!(winrt_ticks_to_unix_ms(116_444_736_000_019_999), 1);
        // 2024-01-01T00:00:00Z = 1_704_067_200_000 ms.
        assert_eq!(winrt_ticks_to_unix_ms(116_444_736_000_000_000 + 1_704_067_200_000 * 10_000), 1_704_067_200_000);
        // Before 1970 rounds down, and nothing overflows.
        assert_eq!(winrt_ticks_to_unix_ms(116_444_735_999_990_000), -1);
        assert_eq!(winrt_ticks_to_unix_ms(116_444_735_999_999_999), -1);
        let _ = winrt_ticks_to_unix_ms(i64::MIN);
        let _ = winrt_ticks_to_unix_ms(i64::MAX);
    }

    // ---- Seen set ----

    #[test]
    fn remember_reports_new_and_forgets_dismissed() {
        let mut seen = HashSet::new();
        assert_eq!(remember(&mut seen, &[1, 2]), HashSet::from([1, 2]));
        assert_eq!(remember(&mut seen, &[1, 2, 3]), HashSet::from([3]));
        assert_eq!(remember(&mut seen, &[3]), HashSet::new());
        assert_eq!(seen, HashSet::from([3]));
        // An id that left and came back is new again (Windows reuses none in
        // practice, but the set must stay bounded either way).
        assert_eq!(remember(&mut seen, &[1, 3]), HashSet::from([1]));
        assert_eq!(remember(&mut seen, &[]), HashSet::new());
        assert!(seen.is_empty());
    }

    #[test]
    fn message_serializes_camel_case() {
        let m = Message {
            id: 1,
            app: "slack".into(),
            sender: "Ana".into(),
            place: None,
            channel: Some("#x".into()),
            text: "hi".into(),
            at: 5,
        };
        let json = serde_json::to_value(PollResult { messages: vec![m], first: true }).unwrap();
        assert_eq!(json["first"], true);
        assert_eq!(json["messages"][0]["channel"], "#x");
        assert!(json["messages"][0]["place"].is_null());
    }

    /// Live eval: asks for access and polls Action Center once. Prints counts
    /// per app only, never senders or contents.
    #[test]
    #[ignore]
    fn messages_live() {
        let allowed = request_access().expect("request_access");
        println!("messages_live: access allowed={allowed}");
        if !allowed {
            return;
        }
        let toasts = imp::read_toasts().expect("read_toasts");
        let mut per_app = std::collections::BTreeMap::<&str, (usize, usize)>::new();
        for toast in &toasts {
            let app = app_for_aumid(&toast.aumid).unwrap_or("other");
            let entry = per_app.entry(app).or_default();
            entry.0 += 1;
            if app != "other" && parse_message(app, &toast.texts, "ws").is_some() {
                entry.1 += 1;
            }
        }
        println!("messages_live: {} toasts in Action Center", toasts.len());
        // How many text elements each app's toasts carry: a new layout shows
        // up here as a new count before anyone has to read a message.
        let mut lengths = std::collections::BTreeMap::<(&str, usize), usize>::new();
        for toast in &toasts {
            let app = app_for_aumid(&toast.aumid).unwrap_or("other");
            *lengths.entry((app, toast.texts.len())).or_default() += 1;
        }
        for ((app, n), count) in &lengths {
            println!("messages_live: {app}: {count} toasts with {n} texts");
        }
        for (app, (total, parsed)) in &per_app {
            println!("messages_live: {app}: {total} toasts, {parsed} parsed as messages");
        }
        let all: Vec<String> = ["discord", "slack", "telegram", "whatsapp"].iter().map(|s| s.to_string()).collect();
        let mut listener = Listener::new();
        let first = listener.poll(&all, "ws").expect("poll");
        println!("messages_live: first poll first={} messages={}", first.first, first.messages.len());
        // Shape counts only: how many landed in a channel, a place, or a DM.
        let mut shapes = std::collections::BTreeMap::<&str, [usize; 3]>::new();
        for m in &first.messages {
            let s = shapes.entry(m.app.as_str()).or_default();
            s[0] += m.channel.is_some() as usize;
            s[1] += m.place.is_some() as usize;
            s[2] += (m.channel.is_none() && m.place.is_none()) as usize;
        }
        for (app, [channel, place, direct]) in &shapes {
            println!("messages_live: {app}: with channel={channel} with place={place} neither={direct}");
        }
        assert!(first.first);
        assert!(first.messages.windows(2).all(|w| w[0].at >= w[1].at), "newest first");
        let second = listener.poll(&all, "ws").expect("poll");
        println!("messages_live: second poll first={} messages={}", second.first, second.messages.len());
        assert!(!second.first);
    }
}
