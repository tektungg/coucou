// The conversation, shared by every provider. Ported from upstream (b2ad213),
// plus the Claude Code session the CLI resumes.
//
// It is kept twice: in the wire format of the provider that answered last
// (Claude's carries web search blocks no other provider would understand), and
// as plain text turns. Switching provider mid-conversation rebuilds the history
// from the plain turns, so nothing in one provider's format is ever sent to
// another. Only a successful turn is recorded, and an answer that lands after
// "New chat" or after another provider took over is dropped.

use std::sync::Mutex;

use serde_json::{json, Value};

#[derive(Default)]
pub struct Chat {
    inner: Mutex<Conversation>,
}

#[derive(Default)]
struct Conversation {
    /// Bumped by every reset, so an answer that lands after "New chat" is dropped.
    epoch: u64,
    /// The provider `native` belongs to.
    owner: Option<String>,
    native: Vec<Value>,
    /// `{"role", "content": text}` turns, the same whoever answered.
    plain: Vec<Value>,
    /// The Claude Code session the CLI continues with `--resume`. It belongs to
    /// the CLI as owner: any switch of provider starts the next CLI turn fresh.
    cli_session: Option<String>,
}

/// What a provider needs to build one turn.
pub struct Turn {
    epoch: u64,
    provider: String,
    /// No earlier turn: the file or window context rides along with this one.
    pub first: bool,
    /// The earlier turns, in this provider's format.
    pub history: Vec<Value>,
    /// The CLI session to resume, when the CLI answered the previous turns.
    pub session: Option<String>,
}

/// One finished turn: the user message and the answer in the provider's
/// format, their plain text, and the CLI session it ran in, if any.
pub struct Exchange {
    user: Value,
    assistant: Value,
    question: String,
    answer: String,
    session: Option<String>,
}

impl Exchange {
    pub fn new(user: Value, assistant: Value, question: &str, answer: &str) -> Self {
        Exchange { user, assistant, question: question.to_string(), answer: answer.to_string(), session: None }
    }

    /// A turn whose provider keeps plain text turns only (the CLI).
    pub fn plain(question: &str, answer: &str) -> Self {
        let user = json!({ "role": "user", "content": question });
        let assistant = json!({ "role": "assistant", "content": answer });
        Exchange::new(user, assistant, question, answer)
    }

    pub fn with_session(mut self, session: Option<String>) -> Self {
        self.session = session;
        self
    }
}

impl Chat {
    pub fn reset(&self) {
        let mut c = self.inner.lock().unwrap();
        let epoch = c.epoch + 1;
        *c = Conversation { epoch, ..Default::default() };
    }

    /// Starts a turn with `provider`, converting the history if another
    /// provider answered the previous turns.
    pub fn begin(&self, provider: &str) -> Turn {
        let mut c = self.inner.lock().unwrap();
        if c.owner.as_deref() != Some(provider) {
            c.native = c.plain.clone();
            c.owner = Some(provider.to_string());
            c.cli_session = None;
        }
        Turn {
            epoch: c.epoch,
            provider: provider.to_string(),
            first: c.plain.is_empty(),
            history: c.native.clone(),
            session: c.cli_session.clone(),
        }
    }

    /// Records a finished turn, unless the chat was reset or another provider
    /// took over since it began: the history always matches what the model saw.
    pub fn commit(&self, turn: &Turn, exchange: Exchange) {
        let mut c = self.inner.lock().unwrap();
        if c.epoch != turn.epoch || c.owner.as_deref() != Some(turn.provider.as_str()) {
            return;
        }
        c.native.push(exchange.user);
        c.native.push(exchange.assistant);
        c.plain.push(json!({ "role": "user", "content": exchange.question }));
        c.plain.push(json!({ "role": "assistant", "content": exchange.answer }));
        if exchange.session.is_some() {
            c.cli_session = exchange.session;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn_texts(history: &[Value]) -> Vec<(String, Value)> {
        history
            .iter()
            .map(|m| (m["role"].as_str().unwrap().to_string(), m["content"].clone()))
            .collect()
    }

    fn qa(q: &str, a: &str) -> Exchange {
        Exchange::plain(q, a)
    }

    #[test]
    fn a_turn_is_recorded_only_once_it_succeeds() {
        let chat = Chat::default();
        let t = chat.begin("anthropic");
        assert!(t.first);
        assert!(t.history.is_empty());
        // A failed turn records nothing: the next one is still the first.
        let t = chat.begin("anthropic");
        assert!(t.first);
        let user = json!({"role":"user","content":[{"type":"text","text":"hi"}]});
        let assistant = json!({"role":"assistant","content":[{"type":"text","text":"hello"}]});
        chat.commit(&t, Exchange::new(user, assistant, "hi", "hello"));
        let t = chat.begin("anthropic");
        assert!(!t.first);
        assert_eq!(t.history.len(), 2);
        assert!(t.history[0]["content"].is_array());
    }

    #[test]
    fn switching_provider_never_sends_claude_blocks_to_another_one() {
        let chat = Chat::default();
        let t = chat.begin("anthropic");
        let blocks = json!([
            {"type":"server_tool_use","id":"srvtoolu_1","name":"web_search","input":{"query":"x"}},
            {"type":"web_search_tool_result","tool_use_id":"srvtoolu_1","content":[]},
            {"type":"text","text":"Found it."}
        ]);
        let user = json!({"role":"user","content":[{"type":"text","text":"look"}]});
        let assistant = json!({"role":"assistant","content":blocks});
        chat.commit(&t, Exchange::new(user, assistant, "look", "Found it."));

        let t = chat.begin("openai");
        assert!(!t.first);
        assert_eq!(
            turn_texts(&t.history),
            vec![("user".into(), json!("look")), ("assistant".into(), json!("Found it."))]
        );
        let raw = serde_json::to_string(&t.history).unwrap();
        assert!(!raw.contains("web_search"), "{raw}");

        // And back: Claude gets the plain turns too, including OpenAI's answer.
        chat.commit(&t, qa("more", "Sure."));
        let t = chat.begin("anthropic");
        assert_eq!(t.history.len(), 4);
        assert_eq!(t.history[3], json!({"role":"assistant","content":"Sure."}));
        assert!(!serde_json::to_string(&t.history).unwrap().contains("web_search"));
    }

    #[test]
    fn an_answer_that_lands_after_a_reset_or_a_switch_is_dropped() {
        let chat = Chat::default();
        let t = chat.begin("openai");
        chat.reset();
        chat.commit(&t, qa("q", "a"));
        assert!(chat.begin("openai").first);

        let t = chat.begin("openai");
        let _other = chat.begin("google");
        chat.commit(&t, qa("q", "a"));
        assert!(chat.begin("google").first);
    }

    #[test]
    fn the_cli_session_is_kept_for_the_next_cli_turn() {
        let chat = Chat::default();
        let t = chat.begin("claude-cli");
        assert_eq!(t.session, None);
        chat.commit(&t, qa("q", "a").with_session(Some("s1".into())));
        let t = chat.begin("claude-cli");
        assert_eq!(t.session.as_deref(), Some("s1"));
        // A turn that brings no session id keeps the one it resumed.
        chat.commit(&t, qa("q2", "a2"));
        assert_eq!(chat.begin("claude-cli").session.as_deref(), Some("s1"));
    }

    #[test]
    fn the_cli_session_goes_with_a_reset_and_a_late_one_is_dropped() {
        let chat = Chat::default();
        let t = chat.begin("claude-cli");
        chat.commit(&t, qa("q", "a").with_session(Some("s1".into())));
        chat.reset();
        assert_eq!(chat.begin("claude-cli").session, None);

        // An answer from before the reset brings no session back.
        let t = chat.begin("claude-cli");
        chat.reset();
        chat.commit(&t, qa("q", "a").with_session(Some("late".into())));
        let t = chat.begin("claude-cli");
        assert_eq!(t.session, None);
        assert!(t.first);
    }

    #[test]
    fn a_switch_away_from_the_cli_and_back_starts_a_fresh_session_with_the_whole_history() {
        let chat = Chat::default();
        let t = chat.begin("claude-cli");
        chat.commit(&t, qa("q1", "a1").with_session(Some("s1".into())));
        let t = chat.begin("openai");
        assert_eq!(t.session, None);
        chat.commit(&t, qa("q2", "a2"));
        let t = chat.begin("claude-cli");
        assert_eq!(t.session, None, "the old session does not know about OpenAI's turn");
        assert_eq!(t.history.len(), 4);
        assert_eq!(t.history[3], json!({"role":"assistant","content":"a2"}));
    }
}
