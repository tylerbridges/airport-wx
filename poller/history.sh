#!/usr/bin/env bash
# Git side of the history recording, used by .github/workflows/poll.yml (and testable locally
# against a bare repo).
#   poller/history.sh prepare <dir> <remote-url>
#       Make <dir> a checkout of branch `history`. If actions/checkout already did that, nothing
#       happens. Otherwise: if the remote has the branch, fetch it (depth 1); if the remote
#       definitely doesn't (ls-remote exit 2), start an orphan branch; any other error fails, so a
#       network blip never creates a second, unrelated history.
#   poller/history.sh push <dir>
#       Commit everything as github-actions[bot] ("record <ISO time>") and push; on rejection
#       `git pull --rebase` once and retry.
set -euo pipefail

cmd=${1:?usage: history.sh prepare <dir> <remote-url> | push <dir>}
dir=${2:?missing dir}

case "$cmd" in
  prepare)
    url=${3:?missing remote url}
    if git -C "$dir" rev-parse -q --verify HEAD >/dev/null 2>&1 \
       && [ "$(git -C "$dir" rev-parse --abbrev-ref HEAD)" = "history" ]; then
      echo "history: using existing checkout"
      exit 0
    fi
    rm -rf "$dir"
    mkdir -p "$dir"
    git -C "$dir" init -q
    git -C "$dir" remote add origin "$url"
    set +e
    git -C "$dir" ls-remote --exit-code --heads origin history >/dev/null 2>&1
    rc=$?
    set -e
    if [ "$rc" -eq 0 ]; then
      git -C "$dir" fetch -q --depth=1 origin history
      git -C "$dir" checkout -q -b history FETCH_HEAD
      echo "history: fetched existing branch"
    elif [ "$rc" -eq 2 ]; then
      git -C "$dir" checkout -q --orphan history
      echo "history: remote has no history branch yet; starting an orphan branch"
    else
      echo "history: could not reach the remote (ls-remote exit $rc)" >&2
      exit 1
    fi
    ;;
  push)
    cd "$dir"
    git config user.name "github-actions[bot]"
    git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
    git add -A
    if git diff --cached --quiet 2>/dev/null && git rev-parse -q --verify HEAD >/dev/null; then
      echo "history: nothing new to record"
      exit 0
    fi
    git commit -q -m "record $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if ! git push -q origin HEAD:refs/heads/history; then
      echo "history: push rejected; rebasing once and retrying"
      # Runs are serialized (workflow concurrency group), so a conflict here means someone else
      # appended to the same day file; give up on this record rather than guess.
      if ! git pull -q --rebase origin history; then
        git rebase --abort >/dev/null 2>&1 || true
        echo "history: rebase conflicted; this poll's record was not pushed" >&2
        exit 1
      fi
      git push -q origin HEAD:refs/heads/history
    fi
    echo "history: pushed $(git rev-parse --short HEAD)"
    ;;
  *)
    echo "unknown command: $cmd" >&2
    exit 2
    ;;
esac
