// What Mochi is told: the system prompt, the window line, and the plain-text
// record of a question. Ported from upstream (b2ad213), plus the transcript a
// fresh Claude Code session gets after another provider answered.

use serde_json::Value;

use super::ChatContext;

const TRANSCRIPT_INTRO: &str = "Our conversation so far, from before this session:";
const TRANSCRIPT_OUTRO: &str = "Continue the conversation from there. My next message:";

/// Mochi's instructions. Greets the user by their first name when the account
/// has one worth using (identity.rs), and only claims web search where the
/// provider runs it (Claude, through the API or the CLI).
pub fn system_prompt(web_search: bool) -> String {
    system_prompt_for(super::identity::first_name(), web_search)
}

fn system_prompt_for(first_name: Option<&str>, web_search: bool) -> String {
    let opening = match first_name {
        Some(name) => format!("You are Mochi, {name}'s personal AI assistant living at the top of their screen."),
        None => "You are Mochi, a personal AI assistant living at the top of the user's screen.".to_string(),
    };
    let abilities = if web_search {
        "You have web search access and can help with absolutely anything: research, coding, finding places, recommendations, tasks, questions."
    } else {
        "You can help with absolutely anything: research, coding, recommendations, tasks, questions. You have no web access: say so when something needs current information."
    };
    format!(
        "{opening} {abilities} \
Respond in the user's language. Be thorough and complete, with as much detail as the task requires. \
Use light Markdown when it helps: short paragraphs, bullet lists, **bold**, `inline code` and fenced code blocks. Avoid tables and big headings: the chat window is small."
    )
}

/// The window context line sent with the first question.
pub fn window_line(app_name: &str, title: &str, url: Option<&str>) -> String {
    let mut text = format!("Context: App: {app_name}, Window: {title}");
    if let Some(url) = url {
        text.push_str(&format!(", URL: {url}"));
    }
    text
}

/// The plain-text record of what the user asked, context included.
pub fn plain_question(first: bool, context: Option<&ChatContext>, query: &str) -> String {
    match context.filter(|_| first) {
        Some(ChatContext::File { name, .. }) => format!("File: {name}\n\n{query}"),
        Some(ChatContext::Window { app_name, title, url }) => {
            format!("{}\n\n{query}", window_line(app_name, title, url.as_deref()))
        }
        None => query.to_string(),
    }
}

/// The earlier plain turns as one block of text, for a provider that starts
/// without them (a fresh Claude Code session), or None when there are none.
pub fn transcript(history: &[Value]) -> Option<String> {
    let lines: Vec<String> = history.iter().filter_map(transcript_line).collect();
    if lines.is_empty() {
        return None;
    }
    Some(format!("{TRANSCRIPT_INTRO}\n\n{}\n\n{TRANSCRIPT_OUTRO}", lines.join("\n\n")))
}

fn transcript_line(message: &Value) -> Option<String> {
    let who = match message.get("role")?.as_str()? {
        "user" => "User",
        "assistant" => "Mochi",
        _ => return None,
    };
    let text = message.get("content")?.as_str()?.trim();
    (!text.is_empty()).then(|| format!("{who}: {text}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_prompt_greets_by_first_name_and_claims_web_search_only_for_claude() {
        let p = system_prompt_for(Some("Louis"), true);
        assert!(p.starts_with("You are Mochi, Louis's personal AI assistant living at the top of their screen."));
        assert!(p.contains("web search access"));
        assert!(p.contains("light Markdown"));
        let p = system_prompt_for(None, false);
        assert!(p.starts_with("You are Mochi, a personal AI assistant living at the top of the user's screen."));
        assert!(!p.contains("web search"));
        assert!(p.contains("no web access"));
    }

    #[test]
    fn context_goes_with_the_first_question_only() {
        let file = ChatContext::File { name: "a.txt".into(), path: "/x/a.txt".into() };
        assert_eq!(plain_question(true, Some(&file), "why?"), "File: a.txt\n\nwhy?");
        assert_eq!(plain_question(false, Some(&file), "why?"), "why?");
        let win = ChatContext::Window { app_name: "Code".into(), title: "main.rs".into(), url: None };
        assert_eq!(plain_question(true, Some(&win), "q"), "Context: App: Code, Window: main.rs\n\nq");
        assert_eq!(
            window_line("Edge", "Docs", Some("https://x.dev")),
            "Context: App: Edge, Window: Docs, URL: https://x.dev"
        );
    }

    #[test]
    fn the_transcript_names_who_said_what_and_skips_the_rest() {
        assert_eq!(transcript(&[]), None);
        let history = vec![
            json!({"role":"user","content":"Remember 7316."}),
            json!({"role":"assistant","content":" OK. "}),
            json!({"role":"assistant","content":[{"type":"text","text":"blocks"}]}),
            json!({"role":"system","content":"x"}),
            json!({"role":"user","content":"   "}),
        ];
        let text = transcript(&history).unwrap();
        assert_eq!(
            text,
            format!("{TRANSCRIPT_INTRO}\n\nUser: Remember 7316.\n\nMochi: OK.\n\n{TRANSCRIPT_OUTRO}")
        );
    }
}
