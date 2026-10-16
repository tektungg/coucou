// GitHub pulse and contribution calendar — the pure half of GithubPoller.swift,
// GitHubPulse.swift and GitHubActivity.swift. Parsing, alert detection and the
// staleness rule live here, away from the network, so they can be tested.
//
// The loops that use them are in poll.rs; the repository and star stats in
// integrations.rs. Ported from upstream (Louis-CFM/coucou c4e330f).

use serde::Serialize;
use serde_json::Value;

pub mod poll;
#[cfg(test)]
mod tests;

// ── CI and review states ──────────────────────────────────────────────────────

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CiState {
    Pending,
    Success,
    Failure,
    Unknown,
}

impl CiState {
    /// GitHub's `StatusState` (statusCheckRollup.state) → our four states.
    pub fn from_github(raw: Option<&str>) -> Self {
        match raw.map(str::to_ascii_uppercase).as_deref() {
            Some("PENDING") | Some("EXPECTED") => CiState::Pending,
            Some("SUCCESS") => CiState::Success,
            Some("ERROR") | Some("FAILURE") => CiState::Failure,
            _ => CiState::Unknown,
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewState {
    Approved,
    ChangesRequested,
    Pending,
    Unknown,
}

impl ReviewState {
    pub fn from_github(raw: Option<&str>) -> Self {
        match raw.map(str::to_ascii_uppercase).as_deref() {
            Some("APPROVED") => ReviewState::Approved,
            Some("CHANGES_REQUESTED") => ReviewState::ChangesRequested,
            Some("REVIEW_REQUIRED") => ReviewState::Pending,
            _ => ReviewState::Unknown,
        }
    }
}

// ── Pulse ─────────────────────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubPr {
    /// "owner/repo#number"
    pub id: String,
    pub title: String,
    pub url: String,
    pub repo: String,
    pub number: i64,
    pub is_draft: bool,
    pub ci: CiState,
    pub review: ReviewState,
    /// Oid of the PR's last commit, when GitHub returned it.
    pub head_sha: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GitHubRepoCi {
    pub repo: String,
    pub url: String,
    pub branch: String,
    pub ci: CiState,
    /// Oid of the default branch's head commit, when GitHub returned it.
    pub head_sha: Option<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GitHubPulse {
    pub login: String,
    #[serde(rename = "myPRs")]
    pub my_prs: Vec<GitHubPr>,
    #[serde(rename = "toReview")]
    pub to_review: Vec<GitHubPr>,
    #[serde(rename = "mainCI")]
    pub main_ci: Vec<GitHubRepoCi>,
    /// Unix time in milliseconds.
    #[serde(rename = "fetchedAt")]
    pub fetched_at: u64,
}

/// What a pulse poll can raise: the island turns these into a badge and a sound.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum GitHubEvent {
    #[serde(rename = "ciFailed")]
    CiFailed {
        #[serde(rename = "prId")]
        pr_id: String,
    },
    #[serde(rename = "ciPassed")]
    CiPassed {
        #[serde(rename = "prId")]
        pr_id: String,
    },
    #[serde(rename = "mainFailed")]
    MainFailed { repo: String },
    #[serde(rename = "reviewRequested")]
    ReviewRequested {
        #[serde(rename = "prId")]
        pr_id: String,
    },
}

fn str_at<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// Pull request fields shared by "my PRs" and "to review"; None when a required
/// field is missing (that node is skipped, as on macOS).
fn pr_basics(node: &Value) -> Option<(String, String, String, String, i64, bool)> {
    let number = node.get("number")?.as_i64()?;
    let title = str_at(node, "title")?.to_string();
    let url = str_at(node, "url")?.to_string();
    let repo = node.get("repository").and_then(|r| str_at(r, "nameWithOwner"))?.to_string();
    let is_draft = node.get("isDraft").and_then(Value::as_bool).unwrap_or(false);
    Some((format!("{repo}#{number}"), title, url, repo, number, is_draft))
}

fn nodes(parent: Option<&Value>) -> &[Value] {
    parent
        .and_then(|p| p.get("nodes"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

impl GitHubPulse {
    /// Parses the pulse GraphQL response. None when there is no `data.viewer`.
    pub fn parse(root: &Value, now_ms: u64) -> Option<Self> {
        let data = root.get("data")?.as_object()?;
        let viewer = data.get("viewer")?.as_object()?;
        let login = viewer.get("login").and_then(Value::as_str).unwrap_or("").to_string();

        // My pull requests, first occurrence of an id wins.
        let mut my_prs: Vec<GitHubPr> = Vec::new();
        for node in nodes(viewer.get("pullRequests")) {
            let Some((id, title, url, repo, number, is_draft)) = pr_basics(node) else { continue };
            if my_prs.iter().any(|p| p.id == id) {
                continue;
            }
            let review = ReviewState::from_github(str_at(node, "reviewDecision"));
            let commit = node
                .get("commits")
                .and_then(|c| c.get("nodes"))
                .and_then(Value::as_array)
                .and_then(|a| a.last())
                .and_then(|n| n.get("commit"));
            let ci_raw = commit
                .and_then(|c| c.get("statusCheckRollup"))
                .and_then(|r| str_at(r, "state"));
            let head_sha = commit.and_then(|c| str_at(c, "oid")).map(str::to_string);
            my_prs.push(GitHubPr {
                id,
                title,
                url,
                repo,
                number,
                is_draft,
                ci: CiState::from_github(ci_raw),
                review,
                head_sha,
            });
        }

        // Default-branch CI of the recently pushed repos, archived ones left out.
        let mut main_ci: Vec<GitHubRepoCi> = Vec::new();
        for node in nodes(viewer.get("repositories")) {
            if node.get("isArchived").and_then(Value::as_bool).unwrap_or(false) {
                continue;
            }
            let (Some(repo), Some(url)) = (str_at(node, "nameWithOwner"), str_at(node, "url")) else {
                continue;
            };
            let Some(branch_ref) = node.get("defaultBranchRef").filter(|b| b.is_object()) else {
                continue;
            };
            let Some(branch) = str_at(branch_ref, "name") else { continue };
            let target = branch_ref.get("target");
            let ci_raw = target
                .and_then(|t| t.get("statusCheckRollup"))
                .and_then(|r| str_at(r, "state"));
            let head_sha = target.and_then(|t| str_at(t, "oid")).map(str::to_string);
            main_ci.push(GitHubRepoCi {
                repo: repo.to_string(),
                url: url.to_string(),
                branch: branch.to_string(),
                ci: CiState::from_github(ci_raw),
                head_sha,
            });
        }

        // Pull requests waiting for my review.
        let mut to_review: Vec<GitHubPr> = Vec::new();
        for node in nodes(data.get("reviewRequested")) {
            let Some((id, title, url, repo, number, is_draft)) = pr_basics(node) else { continue };
            if to_review.iter().any(|p| p.id == id) {
                continue;
            }
            to_review.push(GitHubPr {
                id,
                title,
                url,
                repo,
                number,
                is_draft,
                ci: CiState::Unknown,
                review: ReviewState::Pending,
                head_sha: None,
            });
        }

        Some(GitHubPulse { login, my_prs, to_review, main_ci, fetched_at: now_ms })
    }

    /// True when a PR's CI or a default branch is still running — the next poll
    /// then comes after 60 s instead of 5 min.
    pub fn has_pending(&self) -> bool {
        self.my_prs.iter().any(|p| p.ci == CiState::Pending)
            || self.main_ci.iter().any(|r| r.ci == CiState::Pending)
    }

    /// Alerts between two polls. The first poll after launch (or after the token
    /// changed) has no `old` and stays silent.
    ///
    /// headSha rule, which catches CI runs faster than the poll interval:
    /// - same commit (or both unknown): plain state transitions;
    /// - new commit or new PR: alert at once if its CI is already done; if it is
    ///   still running, the next poll on the same commit will catch the result;
    /// - default branches only ever raise "failed", never "passed".
    pub fn events(old: Option<&GitHubPulse>, new: &GitHubPulse) -> Vec<GitHubEvent> {
        let Some(old) = old else { return Vec::new() };
        let mut out = Vec::new();

        for pr in &new.my_prs {
            // First occurrence wins, should the old list hold a duplicate.
            let prev = old.my_prs.iter().find(|p| p.id == pr.id);
            match prev {
                Some(prev) if prev.head_sha == pr.head_sha => {
                    if pr.ci == CiState::Failure && prev.ci != CiState::Failure {
                        out.push(GitHubEvent::CiFailed { pr_id: pr.id.clone() });
                    } else if pr.ci == CiState::Success && prev.ci == CiState::Pending {
                        out.push(GitHubEvent::CiPassed { pr_id: pr.id.clone() });
                    }
                }
                _ => match pr.ci {
                    CiState::Success => out.push(GitHubEvent::CiPassed { pr_id: pr.id.clone() }),
                    CiState::Failure => out.push(GitHubEvent::CiFailed { pr_id: pr.id.clone() }),
                    _ => {}
                },
            }
        }

        for repo in &new.main_ci {
            let prev = old.main_ci.iter().find(|r| r.repo == repo.repo);
            let failed = match prev {
                Some(prev) if prev.head_sha == repo.head_sha => {
                    repo.ci == CiState::Failure && prev.ci != CiState::Failure
                }
                _ => repo.ci == CiState::Failure,
            };
            if failed {
                out.push(GitHubEvent::MainFailed { repo: repo.repo.clone() });
            }
        }

        for pr in &new.to_review {
            if !old.to_review.iter().any(|p| p.id == pr.id) {
                out.push(GitHubEvent::ReviewRequested { pr_id: pr.id.clone() });
            }
        }

        out
    }
}

/// True when nothing was fetched yet or the last fetch is older than `max_age_secs`.
pub fn is_stale(fetched_at_ms: Option<u64>, now_ms: u64, max_age_secs: u64) -> bool {
    match fetched_at_ms {
        None => true,
        Some(t) => now_ms.saturating_sub(t) > max_age_secs * 1000,
    }
}

// ── Contribution calendar ─────────────────────────────────────────────────────

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ContributionDay {
    /// YYYY-MM-DD
    pub date: String,
    pub count: i64,
    /// 0…4, from NONE … FOURTH_QUARTILE.
    pub level: u8,
    /// 0 = Sunday … 6 = Saturday.
    pub weekday: u8,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct GitHubActivity {
    pub total: i64,
    /// Oldest week first; the last one is usually the current, incomplete week.
    pub weeks: Vec<Vec<ContributionDay>>,
    #[serde(rename = "fetchedAt")]
    pub fetched_at: u64,
}

fn contribution_level(raw: &str) -> u8 {
    match raw {
        "FIRST_QUARTILE" => 1,
        "SECOND_QUARTILE" => 2,
        "THIRD_QUARTILE" => 3,
        "FOURTH_QUARTILE" => 4,
        _ => 0,
    }
}

impl GitHubActivity {
    pub fn parse(root: &Value, now_ms: u64) -> Option<Self> {
        let calendar = root
            .get("data")?
            .get("viewer")?
            .get("contributionsCollection")?
            .get("contributionCalendar")?;
        let total = calendar.get("totalContributions")?.as_i64()?;
        let weeks_raw = calendar.get("weeks")?.as_array()?;

        let mut weeks = Vec::new();
        for week in weeks_raw {
            let Some(days_raw) = week.get("contributionDays").and_then(Value::as_array) else { continue };
            let days: Vec<ContributionDay> = days_raw
                .iter()
                .filter_map(|d| {
                    Some(ContributionDay {
                        date: str_at(d, "date")?.to_string(),
                        count: d.get("contributionCount")?.as_i64()?,
                        level: contribution_level(str_at(d, "contributionLevel")?),
                        weekday: u8::try_from(d.get("weekday")?.as_i64()?).ok()?,
                    })
                })
                .collect();
            if !days.is_empty() {
                weeks.push(days);
            }
        }
        Some(GitHubActivity { total, weeks, fetched_at: now_ms })
    }
}

// ── GraphQL ───────────────────────────────────────────────────────────────────

/// Same query as GithubPoller.swift.
pub const PULSE_QUERY: &str = r#"
query {
  viewer {
    login
    pullRequests(states: OPEN, first: 20, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url isDraft reviewDecision
        repository { nameWithOwner url }
        commits(last: 1) {
          nodes { commit { oid statusCheckRollup { state } } }
        }
      }
    }
    repositories(first: 10, ownerAffiliations: [OWNER], orderBy: {field: PUSHED_AT, direction: DESC}) {
      nodes {
        nameWithOwner url isArchived
        defaultBranchRef {
          name
          target { ... on Commit { oid statusCheckRollup { state } } }
        }
      }
    }
  }
  reviewRequested: search(query: "is:pr is:open review-requested:@me archived:false", type: ISSUE, first: 20) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url isDraft
        author { login }
        repository { nameWithOwner url }
      }
    }
  }
}
"#;

pub const ACTIVITY_QUERY: &str = r#"
query {
  viewer {
    login
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks {
          contributionDays {
            date contributionCount contributionLevel weekday
          }
        }
      }
    }
  }
}
"#;

/// Number of GraphQL errors in a response, for the log (never their text: it
/// can quote the query, not secrets, but there is no need for it).
pub fn graphql_error_count(root: &Value) -> usize {
    root.get("errors").and_then(Value::as_array).map(Vec::len).unwrap_or(0)
}
