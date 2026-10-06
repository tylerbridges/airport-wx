// Recover a stuck Pages environment gate without bypassing approval or wait rules.
import { pathToFileURL } from "node:url";

export async function recoverPoll({ api, now = Date.now(), maxAgeMs = 20 * 60000, log = console.log }) {
  const { workflow_runs = [] } = await api("actions/workflows/poll.yml/runs?status=waiting&per_page=100");
  const cancelled = [];
  for (const run of workflow_runs) {
    const age = now - Date.parse(run.updated_at);
    if (run.head_branch !== "main" || !Number.isFinite(age) || age < maxAgeMs) continue;
    const gates = await api(`actions/runs/${run.id}/pending_deployments`);
    if (!gates.length || gates.some(g => g.environment?.name !== "github-pages" || g.wait_timer !== 0 || !Array.isArray(g.reviewers) || g.reviewers.length)) continue;
    await api(`actions/runs/${run.id}/cancel`, { method: "POST" });
    cancelled.push(run.id);
    log(`Cancelled stalled Pages run ${run.id} (${Math.floor(age / 60000)} min waiting); next poll can proceed.`);
  }
  return cancelled;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.GH_TOKEN, repo = process.env.REPO;
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new Error("GH_TOKEN and REPO required");
  await recoverPoll({ api: async (path, opts = {}) => {
    const res = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
      ...opts, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
    return res.status === 204 || res.status === 202 ? null : res.json();
  } });
}
