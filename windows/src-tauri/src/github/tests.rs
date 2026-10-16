// Tests for github/ (GitHubPulseTests.swift, GitHubActivityTests.swift),
// ported from upstream (Louis-CFM/coucou c4e330f).
use super::*;
use serde_json::json;

fn valid_pulse() -> Value {
    json!({
      "data": {
        "viewer": {
          "login": "testuser",
          "pullRequests": { "nodes": [
            {
              "number": 42, "title": "Add feature",
              "url": "https://github.com/testuser/myrepo/pull/42",
              "isDraft": false, "reviewDecision": "APPROVED",
              "repository": {"nameWithOwner": "testuser/myrepo", "url": "https://github.com/testuser/myrepo"},
              "commits": {"nodes": [{"commit": {"oid": "aaa", "statusCheckRollup": {"state": "SUCCESS"}}}]}
            },
            {
              "number": 43, "title": "Fix bug",
              "url": "https://github.com/testuser/myrepo/pull/43",
              "isDraft": true, "reviewDecision": null,
              "repository": {"nameWithOwner": "testuser/myrepo", "url": "https://github.com/testuser/myrepo"},
              "commits": {"nodes": [{"commit": {"statusCheckRollup": null}}]}
            }
          ]},
          "repositories": { "nodes": [
            {
              "nameWithOwner": "testuser/myrepo", "url": "https://github.com/testuser/myrepo",
              "isArchived": false,
              "defaultBranchRef": {"name": "main", "target": {"oid": "bbb", "statusCheckRollup": {"state": "PENDING"}}}
            },
            {
              "nameWithOwner": "testuser/archived", "url": "https://github.com/testuser/archived",
              "isArchived": true,
              "defaultBranchRef": {"name": "main", "target": {"statusCheckRollup": {"state": "SUCCESS"}}}
            }
          ]}
        },
        "reviewRequested": {
          "issueCount": 1,
          "nodes": [{
            "number": 7, "title": "Review this",
            "url": "https://github.com/other/repo/pull/7",
            "isDraft": false, "author": {"login": "otheruser"},
            "repository": {"nameWithOwner": "other/repo", "url": "https://github.com/other/repo"}
          }]
        }
      }
    })
}

fn empty_pulse() -> GitHubPulse {
    let root = json!({
      "data": {
        "viewer": {"login": "testuser", "pullRequests": {"nodes": []}, "repositories": {"nodes": []}},
        "reviewRequested": {"issueCount": 0, "nodes": []}
      }
    });
    GitHubPulse::parse(&root, 0).unwrap()
}

fn pr(id: &str, ci: CiState, sha: Option<&str>) -> GitHubPr {
    GitHubPr {
        id: id.into(),
        title: "T".into(),
        url: String::new(),
        repo: id.split('#').next().unwrap().into(),
        number: 1,
        is_draft: false,
        ci,
        review: ReviewState::Unknown,
        head_sha: sha.map(str::to_string),
    }
}

fn repo(name: &str, ci: CiState, sha: Option<&str>) -> GitHubRepoCi {
    GitHubRepoCi { repo: name.into(), url: String::new(), branch: "main".into(), ci, head_sha: sha.map(str::to_string) }
}

#[test]
fn parses_a_full_pulse() {
    let p = GitHubPulse::parse(&valid_pulse(), 5).unwrap();
    assert_eq!(p.login, "testuser");
    assert_eq!(p.my_prs.len(), 2);
    assert_eq!(p.my_prs[0].id, "testuser/myrepo#42");
    assert_eq!(p.my_prs[0].ci, CiState::Success);
    assert_eq!(p.my_prs[0].review, ReviewState::Approved);
    assert_eq!(p.my_prs[0].head_sha.as_deref(), Some("aaa"));
    assert_eq!(p.my_prs[1].ci, CiState::Unknown, "null rollup");
    assert_eq!(p.my_prs[1].review, ReviewState::Unknown, "null review");
    assert!(p.my_prs[1].is_draft);
    assert_eq!(p.main_ci.len(), 1, "archived repo filtered out");
    assert_eq!(p.main_ci[0].repo, "testuser/myrepo");
    assert_eq!(p.main_ci[0].ci, CiState::Pending);
    assert_eq!(p.main_ci[0].branch, "main");
    assert_eq!(p.main_ci[0].head_sha.as_deref(), Some("bbb"));
    assert_eq!(p.to_review.len(), 1);
    assert_eq!(p.to_review[0].id, "other/repo#7");
    assert_eq!(p.to_review[0].review, ReviewState::Pending);
    assert!(p.has_pending(), "default branch pending");
    assert_eq!(p.fetched_at, 5);
}

#[test]
fn parses_an_empty_pulse() {
    let p = empty_pulse();
    assert!(p.my_prs.is_empty() && p.main_ci.is_empty() && p.to_review.is_empty());
    assert!(!p.has_pending());
}

#[test]
fn rejects_bad_pulse_data() {
    assert!(GitHubPulse::parse(&json!("garbage"), 0).is_none());
    assert!(GitHubPulse::parse(&json!({}), 0).is_none());
    assert!(GitHubPulse::parse(&json!({"data": null}), 0).is_none());
}

#[test]
fn keeps_the_first_of_duplicate_prs() {
    let root = json!({
      "data": {
        "viewer": {
          "login": "testuser",
          "pullRequests": {"nodes": [
            {"number": 42, "title": "Add feature", "url": "u", "isDraft": false, "reviewDecision": "APPROVED",
             "repository": {"nameWithOwner": "testuser/myrepo"},
             "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "SUCCESS"}}}]}},
            {"number": 42, "title": "Duplicate entry", "url": "u", "isDraft": true, "reviewDecision": null,
             "repository": {"nameWithOwner": "testuser/myrepo"},
             "commits": {"nodes": [{"commit": {"statusCheckRollup": {"state": "FAILURE"}}}]}}
          ]},
          "repositories": {"nodes": []}
        },
        "reviewRequested": {"issueCount": 0, "nodes": []}
      }
    });
    let p = GitHubPulse::parse(&root, 0).unwrap();
    assert_eq!(p.my_prs.len(), 1);
    assert_eq!(p.my_prs[0].title, "Add feature");
    assert_eq!(p.my_prs[0].ci, CiState::Success);
}

#[test]
fn maps_ci_states() {
    assert_eq!(CiState::from_github(None), CiState::Unknown);
    assert_eq!(CiState::from_github(Some("PENDING")), CiState::Pending);
    assert_eq!(CiState::from_github(Some("EXPECTED")), CiState::Pending);
    assert_eq!(CiState::from_github(Some("SUCCESS")), CiState::Success);
    assert_eq!(CiState::from_github(Some("FAILURE")), CiState::Failure);
    assert_eq!(CiState::from_github(Some("ERROR")), CiState::Failure);
    assert_eq!(CiState::from_github(Some("WAITING")), CiState::Unknown);
}

#[test]
fn first_poll_is_silent() {
    let p = GitHubPulse::parse(&valid_pulse(), 0).unwrap();
    assert!(GitHubPulse::events(None, &p).is_empty());
}

#[test]
fn pending_to_success_passes() {
    let mut old = empty_pulse();
    old.my_prs = vec![pr("r/p#1", CiState::Pending, None)];
    let mut new = old.clone();
    new.my_prs[0].ci = CiState::Success;
    assert_eq!(GitHubPulse::events(Some(&old), &new), vec![GitHubEvent::CiPassed { pr_id: "r/p#1".into() }]);
}

#[test]
fn success_to_failure_fails() {
    let mut old = empty_pulse();
    old.my_prs = vec![pr("r/p#2", CiState::Success, None)];
    let mut new = old.clone();
    new.my_prs[0].ci = CiState::Failure;
    assert_eq!(GitHubPulse::events(Some(&old), &new), vec![GitHubEvent::CiFailed { pr_id: "r/p#2".into() }]);
}

#[test]
fn default_branch_breaking_alerts() {
    let mut old = empty_pulse();
    old.main_ci = vec![repo("a/b", CiState::Success, None)];
    let mut new = old.clone();
    new.main_ci[0].ci = CiState::Failure;
    assert_eq!(GitHubPulse::events(Some(&old), &new), vec![GitHubEvent::MainFailed { repo: "a/b".into() }]);
}

#[test]
fn default_branch_turning_green_is_quiet() {
    let mut old = empty_pulse();
    old.main_ci = vec![repo("a/b", CiState::Pending, Some("x"))];
    let mut new = old.clone();
    new.main_ci[0].ci = CiState::Success;
    assert!(GitHubPulse::events(Some(&old), &new).is_empty());
    new.main_ci[0].head_sha = Some("y".into());
    assert!(GitHubPulse::events(Some(&old), &new).is_empty());
}

#[test]
fn new_review_request_alerts_once() {
    let mut review = pr("o/r#7", CiState::Unknown, None);
    review.review = ReviewState::Pending;
    let mut old = empty_pulse();
    let mut new = old.clone();
    new.to_review = vec![review.clone()];
    assert_eq!(
        GitHubPulse::events(Some(&old), &new),
        vec![GitHubEvent::ReviewRequested { pr_id: "o/r#7".into() }]
    );
    old.to_review = vec![review];
    assert!(GitHubPulse::events(Some(&old), &new).is_empty(), "already known");
}

#[test]
fn duplicate_ids_in_old_fire_once() {
    let mut old = empty_pulse();
    let p = pr("r/p#1", CiState::Pending, None);
    old.my_prs = vec![p.clone(), p.clone()];
    let mut new = empty_pulse();
    let mut passed = p;
    passed.ci = CiState::Success;
    new.my_prs = vec![passed];
    let events = GitHubPulse::events(Some(&old), &new);
    assert_eq!(events.iter().filter(|e| matches!(e, GitHubEvent::CiPassed { .. })).count(), 1);
}

#[test]
fn new_pr_already_green_passes() {
    let old = empty_pulse();
    let mut new = old.clone();
    new.my_prs = vec![pr("r/p#10", CiState::Success, Some("abc111"))];
    assert_eq!(GitHubPulse::events(Some(&old), &new), vec![GitHubEvent::CiPassed { pr_id: "r/p#10".into() }]);
}

#[test]
fn new_pr_still_pending_is_quiet() {
    let old = empty_pulse();
    let mut new = old.clone();
    new.my_prs = vec![pr("r/p#11", CiState::Pending, Some("abc222"))];
    assert!(GitHubPulse::events(Some(&old), &new).is_empty());
}

#[test]
fn new_commit_already_red_fails() {
    let mut old = empty_pulse();
    old.my_prs = vec![pr("r/p#12", CiState::Success, Some("sha-old"))];
    let mut new = old.clone();
    new.my_prs[0].ci = CiState::Failure;
    new.my_prs[0].head_sha = Some("sha-new".into());
    assert_eq!(GitHubPulse::events(Some(&old), &new), vec![GitHubEvent::CiFailed { pr_id: "r/p#12".into() }]);
}

#[test]
fn new_commit_already_green_passes_even_from_green() {
    // A fast CI ran entirely between two polls: success → (new sha) success.
    let mut old = empty_pulse();
    old.my_prs = vec![pr("r/p#14", CiState::Success, Some("one"))];
    let mut new = old.clone();
    new.my_prs[0].head_sha = Some("two".into());
    assert_eq!(GitHubPulse::events(Some(&old), &new), vec![GitHubEvent::CiPassed { pr_id: "r/p#14".into() }]);
}

#[test]
fn same_sha_success_stays_quiet() {
    let mut old = empty_pulse();
    old.my_prs = vec![pr("r/p#13", CiState::Success, Some("same"))];
    let new = old.clone();
    assert!(GitHubPulse::events(Some(&old), &new).is_empty());
}

#[test]
fn new_commit_on_main_red_fails() {
    let mut old = empty_pulse();
    old.main_ci = vec![repo("a/b", CiState::Success, Some("sha-old"))];
    let mut new = old.clone();
    new.main_ci[0].ci = CiState::Failure;
    new.main_ci[0].head_sha = Some("sha-new".into());
    assert_eq!(GitHubPulse::events(Some(&old), &new), vec![GitHubEvent::MainFailed { repo: "a/b".into() }]);
}

#[test]
fn staleness() {
    let now = 1_000_000;
    assert!(is_stale(None, now, 60));
    assert!(!is_stale(Some(now), now, 60));
    assert!(!is_stale(Some(now - 60_000), now, 60));
    assert!(is_stale(Some(now - 61_000), now, 60));
    assert!(!is_stale(Some(now + 5_000), now, 60), "clock skew is not stale");
}

#[test]
fn events_serialise_for_the_island() {
    let v = serde_json::to_value(GitHubEvent::CiFailed { pr_id: "a/b#1".into() }).unwrap();
    assert_eq!(v, json!({"kind": "ciFailed", "prId": "a/b#1"}));
    let v = serde_json::to_value(GitHubEvent::MainFailed { repo: "a/b".into() }).unwrap();
    assert_eq!(v, json!({"kind": "mainFailed", "repo": "a/b"}));
    let p = serde_json::to_value(GitHubPulse::parse(&valid_pulse(), 7).unwrap()).unwrap();
    assert!(p.get("myPRs").is_some() && p.get("toReview").is_some() && p.get("mainCI").is_some());
    assert_eq!(p["myPRs"][0]["isDraft"], json!(false));
    assert_eq!(p["myPRs"][0]["headSha"], json!("aaa"));
    assert_eq!(p["myPRs"][0]["ci"], json!("success"));
    assert_eq!(p["myPRs"][0]["review"], json!("approved"));
    assert_eq!(p["fetchedAt"], json!(7));
}

// ── Activity ──────────────────────────────────────────────────────────────

fn day(date: &str, count: i64, level: &str, weekday: i64) -> Value {
    json!({"date": date, "contributionCount": count, "contributionLevel": level, "weekday": weekday})
}

fn valid_activity() -> Value {
    json!({
      "data": { "viewer": { "login": "testuser", "contributionsCollection": { "contributionCalendar": {
        "totalContributions": 42,
        "weeks": [
          {"contributionDays": [
            day("2026-01-05", 0, "NONE", 0),
            day("2026-01-06", 1, "FIRST_QUARTILE", 1),
            day("2026-01-07", 4, "SECOND_QUARTILE", 2),
            day("2026-01-08", 8, "THIRD_QUARTILE", 3),
            day("2026-01-09", 12, "FOURTH_QUARTILE", 4),
            day("2026-01-10", 2, "FIRST_QUARTILE", 5),
            day("2026-01-11", 0, "NONE", 6)
          ]},
          {"contributionDays": [
            day("2026-01-12", 5, "SECOND_QUARTILE", 0),
            day("2026-01-13", 10, "THIRD_QUARTILE", 1)
          ]}
        ]
      }}}}
    })
}

#[test]
fn parses_the_contribution_calendar() {
    let a = GitHubActivity::parse(&valid_activity(), 3).unwrap();
    assert_eq!(a.total, 42);
    assert_eq!(a.weeks.len(), 2);
    assert_eq!(a.weeks[0].len(), 7);
    assert_eq!(a.weeks[1].len(), 2, "incomplete current week");
    let levels: Vec<u8> = a.weeks[0][..5].iter().map(|d| d.level).collect();
    assert_eq!(levels, vec![0, 1, 2, 3, 4]);
    assert_eq!(a.weeks[0][0].date, "2026-01-05");
    assert_eq!(a.weeks[0][0].count, 0);
    assert_eq!(a.weeks[0][0].weekday, 0);
    assert_eq!(a.weeks[1][1].date, "2026-01-13");
    assert_eq!(a.weeks[1][1].count, 10);
    assert_eq!(a.fetched_at, 3);
}

#[test]
fn unknown_contribution_level_is_zero() {
    let root = json!({"data": {"viewer": {"contributionsCollection": {"contributionCalendar": {
        "totalContributions": 1,
        "weeks": [{"contributionDays": [day("2026-03-01", 1, "EXTRA_SPECIAL", 0)]}]
    }}}}});
    assert_eq!(GitHubActivity::parse(&root, 0).unwrap().weeks[0][0].level, 0);
}

#[test]
fn rejects_bad_activity_data() {
    assert!(GitHubActivity::parse(&json!("garbage"), 0).is_none());
    assert!(GitHubActivity::parse(&json!({}), 0).is_none());
}

#[test]
fn counts_graphql_errors() {
    assert_eq!(graphql_error_count(&json!({"data": {}})), 0);
    assert_eq!(graphql_error_count(&json!({"errors": [{}, {}]})), 2);
}
