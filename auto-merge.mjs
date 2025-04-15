#!/usr/bin/env node
// auto-merge.mjs
//
// This script will:
//  • Accept a GitHub pull request URL and a version-bump type (patch/minor/major)
//  • Use the GitHub API (with built‑in global fetch) to fetch PR details and commit statuses
//  • Get the pull request’s branch (which may be any name provided by the developer)
//  • Compare package.json versions on the default branch versus the PR branch
//  • If the PR branch version is lower or equal to the default branch version and the PR is not already merged:
//      - Merge in the default branch,
//      - Run yarn install (only if the merge actually brought in new changes),
//      - And finally perform a yarn version bump (with patch/minor/major as specified)
//  • Every dangerous action (file system writes, git changes or API calls) asks for interactive confirmation.
//  • Periodically (every 1 minute) the script will sync the PR branch with the default branch.
//  • Before merging via GitHub API, the script polls GitHub to verify that all required checks/workflows are passing.
//      - If a workflow is failing, it downloads its logs and re-runs it.
//      - After 2 failed re-run attempts, the script aborts and displays the collected logs.
//  • Finally, if all conditions pass and the PR is marked as mergeable, the script issues the GitHub API merge call.
//  • Optionally, after a successful merge, the script prompts to push a new tag.

import path from "path";
import fs from "fs";
import { execSync } from "child_process";
import readline from "readline";

// ---------------------
// Utility: Debug Tracing
// ---------------------
function debug(msg) {
  console.log(`[DEBUG] ${msg}`);
}

// ---------------------
// Dynamic Imports via use-m for non built-in modules
// ---------------------
debug("Importing use-m to enable dynamic module loading...");
const { use } = eval(
  await fetch('https://unpkg.com/use-m/use.js').then(u => u.text())
);

// Dynamically import dotenv to load environment variables.
debug("Importing dotenv module...");
const dotenv = await use("dotenv");
debug("Importing semver module...");
const semver = await use("semver");
debug("Importing adm-zip module...");
const AdmZip = await use("adm-zip");
dotenv.config();
debug("Environment variables loaded.");

// ---------------------
// Check required environment variable: GITHUB_TOKEN
// ---------------------
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("Error: Please set GITHUB_TOKEN as an environment variable.");
  process.exit(1);
}
debug("GITHUB_TOKEN is set.");

// ---------------------
// Configuration and Input Parsing
// ---------------------
const prUrl = process.argv[2];
const bumpType = process.argv[3];
debug(`Received arguments: prUrl=${prUrl}, bumpType=${bumpType}`);

if (!prUrl || !bumpType) {
  console.error("Usage: node auto-merge.mjs <pull_request_url> <patch|minor|major>");
  process.exit(1);
}
if (!["patch", "minor", "major"].includes(bumpType)) {
  console.error("Error: Bump type must be one of: patch, minor, major");
  process.exit(1);
}

// Extract owner, repo, and pull request number from the URL.
// Expected format: https://github.com/<owner>/<repo>/pull/<number>
const prRegex = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/;
const match = prUrl.match(prRegex);
if (!match) {
  console.error("Error: Invalid pull request URL format. Expected format: https://github.com/owner/repo/pull/123");
  process.exit(1);
}
const [ , owner, repo, pullNumber ] = match;
debug(`Parsed PR URL: owner=${owner}, repo=${repo}, pullNumber=${pullNumber}`);

// Common GitHub API headers.
const headers = {
  "Authorization": `token ${token}`,
  "Accept": "application/vnd.github.v3+json",
  "Content-Type": "application/json",
};

// ---------------------
// Utility: Interactive Confirmation
// ---------------------
async function confirmAction(description, commandText) {
  console.log("\n================================================================================");
  console.log(`ACTION: ${description}`);
  console.log(`REPRODUCIBLE COMMAND/API CALL:\n${commandText}`);
  console.log("================================================================================");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await new Promise((resolve) => {
    rl.question("Do you want to continue? (y/n): ", resolve);
  });
  rl.close();
  debug(`User answer: ${answer}`);
  return answer.toLowerCase().startsWith("y");
}

// ---------------------
// Utility: runCommand – async version with confirmation for dangerous operations.
// ---------------------
async function runCommand(cmd, options = { dangerous: false, description: "" }) {
  debug(`Preparing to run command: ${cmd}`);
  if (options.dangerous) {
    const confirmed = await confirmAction(options.description, cmd);
    if (!confirmed) {
      throw new Error(`Operation aborted by user: ${options.description}`);
    }
  }
  try {
    const output = execSync(cmd, { encoding: "utf8", stdio: "pipe" });
    debug(`Command output: ${output}`);
    return output;
  } catch (err) {
    debug(`Command error output: ${err.message}`);
    throw new Error(`Command failed: ${cmd}\n${err.message}`);
  }
}

// ---------------------
// Helper Functions for Repository and Version Bump
// ---------------------

// Fetch package.json from a given branch (via "git show").
async function getPackageJsonFromBranch(branch) {
  debug(`Fetching package.json from branch: ${branch}`);
  const content = await runCommand(`git show origin/${branch}:package.json`);
  debug(`Fetched package.json content from ${branch}`);
  return JSON.parse(content);
}

// Read local package.json.
function getLocalPackageJson() {
  debug("Reading local package.json file...");
  const content = fs.readFileSync("package.json", "utf8");
  debug("Successfully read local package.json.");
  return JSON.parse(content);
}

// bumpLocalVersionSafe: bumps the version using Yarn's built-in version bump flags.
async function bumpLocalVersionSafe(bumpType) {
  const cmd = `yarn version --${bumpType}`;
  console.log(`Bumping version using "${cmd}"...`);
  await runCommand(cmd, { dangerous: true, description: `This will bump the version using yarn version --${bumpType}` });
  console.log("Version bump performed.");
}

// Pushes the current branch to origin.
async function pushCurrentBranch(branchName) {
  const cmd = `git push origin ${branchName}`;
  const description = `This will push the branch "${branchName}" to origin.`;
  debug(`Pushing current branch ${branchName} to origin.`);
  await runCommand(cmd, { dangerous: true, description });
}

// Pushes the new tag to origin.
async function pushNewTag() {
  const localPkg = getLocalPackageJson();
  const tagName = `v${localPkg.version}`;
  const cmd = `git push origin ${tagName}`;
  const description = `This will push the new tag ${tagName} to origin.`;
  debug(`Pushing new tag ${tagName} to origin.`);
  await runCommand(cmd, { dangerous: true, description });
  console.log(`Tag ${tagName} pushed successfully.`);
}

// Merges the default branch into the current branch.
// If only package.json is in conflict, auto-resolves that conflict.
// Returns the merge command output.
async function mergeDefaultBranch(defaultBranch) {
  const mergeCmd = `git merge origin/${defaultBranch} --no-edit`;
  const description = `This will merge origin/${defaultBranch} into the current branch.`;
  debug(`Merging default branch (${defaultBranch}) into current branch.`);
  try {
    const mergeOutput = await runCommand(mergeCmd, { dangerous: true, description });
    debug(`Merge output: ${mergeOutput}`);
    return mergeOutput;
  } catch (e) {
    debug("Merge command failed, checking for conflicts...");
    let conflictsOutput = await runCommand(`git diff --name-only --diff-filter=U`, { dangerous: false, description: "Checking merge conflicts" });
    const conflicts = conflictsOutput.split(/\n/).map(s => s.trim()).filter(Boolean);
    debug(`Detected conflicts in files: ${conflicts.join(", ")}`);
    if (conflicts.length === 1 && conflicts[0] === "package.json") {
      const resCmd = `git checkout --theirs package.json && git add package.json && git commit -m "Auto-resolved package.json conflict from merging origin/${defaultBranch}"`;
      const confirmation = await confirmAction("Auto-resolving package.json conflict", resCmd);
      if (!confirmation) {
        console.error("Please resolve the conflicts manually and restart the script.");
        process.exit(1);
      }
      await runCommand(`git checkout --theirs package.json`, { dangerous: true, description: "Auto-resolve package.json conflict" });
      await runCommand(`git add package.json`, { dangerous: true, description: "Staging resolved package.json" });
      await runCommand(`git commit -m "Auto-resolved package.json conflict from merging origin/${defaultBranch}"`, { dangerous: true, description: "Committing the conflict resolution" });
      debug("Auto-resolved package.json conflict.");
      return "Merge completed with auto-resolved conflicts";
    } else if (conflicts.length > 0) {
      console.error("Merge conflicts detected in files:", conflicts);
      console.error("Please resolve these conflicts manually and then restart the script.");
      return "";
    }
    return "";
  }
}

// Runs 'yarn install' to update yarn.lock and node_modules.
async function updateDependencies() {
  const cmd = "yarn install";
  const description = `This will update your local yarn.lock and node_modules.`;
  debug("Running yarn install to update dependencies.");
  await runCommand(cmd, { dangerous: true, description });
  console.log("Local dependencies updated via yarn.");
}

// Helper to pause execution.
function sleep(ms) {
  debug(`Sleeping for ${ms} ms...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------
// Helpers for Handling Failed Workflow Runs
// ---------------------

// getFailedWorkflowsForCommit: Retrieves failed workflow runs for a given commit SHA.
async function getFailedWorkflowsForCommit(owner, repo, commitSHA, headers) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=50`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`Failed to list workflow runs: ${resp.status} / ${resp.statusText}`);
  }
  const data = await resp.json();
  const runsOnCommit = data.workflow_runs.filter(run => run.head_sha === commitSHA);
  const failedRuns = runsOnCommit.filter(run => 
    run.status === "completed" &&
    (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "cancelled")
  );
  return failedRuns;
}

// downloadWorkflowLogs: Downloads logs (.zip) for a given run_id and extracts them.
async function downloadWorkflowLogs(owner, repo, runId, headers) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`;
  const resp = await fetch(url, { headers });
  if (!resp.ok) {
    throw new Error(`Failed to download logs for run ${runId}: ${resp.status} / ${resp.statusText}`);
  }
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (!fs.existsSync("logs")) {
    fs.mkdirSync("logs");
  }
  const zipPath = path.join("logs", `run-${runId}.zip`);
  fs.writeFileSync(zipPath, buffer);
  const zip = new AdmZip(zipPath);
  const extractDir = path.join("logs", `run-${runId}`);
  zip.extractAllTo(extractDir, true);
  console.log(`Logs for run ${runId} saved in ${extractDir}`);
  return { zipPath, extractDir };
}

// reRunWorkflow: Attempts to re-run a given workflow run.
async function reRunWorkflow(owner, repo, runId, headers) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/rerun`;
  const resp = await fetch(url, {
    method: "POST",
    headers,
  });
  if (resp.status === 403) {
    throw new Error(`Forbidden: Could not re-run workflow ${runId}.`);
  }
  if (!resp.ok) {
    throw new Error(`Failed to re-run workflow ${runId}: ${resp.status} / ${resp.statusText}`);
  }
  console.log(`Requested re-run for workflow run ${runId}.`);
}

// handleFailedWorkflows: If failed workflows are detected, downloads logs, re-runs them,
// and retries (up to maxRetries) until they pass or abort.
async function handleFailedWorkflows(owner, repo, commitSHA, headers, maxRetries = 2) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    const failedRuns = await getFailedWorkflowsForCommit(owner, repo, commitSHA, headers);
    if (failedRuns.length === 0) {
      return true;
    }
    console.log(`Found ${failedRuns.length} failed run(s). Attempt ${attempt} of ${maxRetries}.`);
    for (const run of failedRuns) {
      console.log(`Downloading logs for failed run #${run.id} (${run.name}).`);
      try {
        await downloadWorkflowLogs(owner, repo, run.id, headers);
      } catch (err) {
        console.error(`Error downloading logs for run #${run.id}: ${err.message}`);
      }
    }
    if (attempt === maxRetries) {
      console.error("Max retries reached. Aborting workflow re-run attempts. See logs in the 'logs' folder.");
      return false;
    }
    for (const run of failedRuns) {
      try {
        await reRunWorkflow(owner, repo, run.id, headers);
      } catch (err) {
        console.error(`Error re-running workflow #${run.id}: ${err.message}`);
      }
    }
    console.log("Waiting 30s for re-run to start...");
    await sleep(30000);
    attempt++;
  }
  return false;
}

// ---------------------
// Extended Wait for Mergeable with Workflow Re-run
// ---------------------
async function waitForPRToBeMergeableWithRetries(owner, repo, pullNum, headers) {
  const maxPollingRounds = 30;
  let pollCount = 0;
  while (pollCount < maxPollingRounds) {
    console.log("Checking if PR is mergeable (waiting for checks/reviews)...");
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNum}`, { headers });
    if (!prRes.ok) {
      throw new Error(`Failed to fetch PR details: ${prRes.statusText}`);
    }
    const pr = await prRes.json();
    if (pr.merged) {
      console.log("Pull request is already merged externally.");
      return false;
    }
    if (!pr.mergeable) {
      console.log(`mergeable=${pr.mergeable}, mergeable_state=${pr.mergeable_state}. Possibly waiting on checks or reviews.`);
      if (pr.mergeable_state === "blocked" || pr.mergeable_state === "unstable") {
        console.log(`mergeable_state=${pr.mergeable_state} => Attempting to handle failed workflows...`);
        const commitSHA = pr.head.sha;
        const success = await handleFailedWorkflows(owner, repo, commitSHA, headers, 2);
        if (!success) {
          console.error("Failed workflows could not be fixed after 2 attempts. Aborting.");
          return false;
        }
      }
      await sleep(30000);
      pollCount++;
      continue;
    }
    switch (pr.mergeable_state) {
      case "clean":
        console.log("PR is mergeable and 'clean'. All checks have passed. Proceeding...");
        return true;
      case "blocked":
      case "behind":
      case "unstable":
      case "has_hooks":
        console.log(`mergeable_state=${pr.mergeable_state}. Will wait and retry in 30s...`);
        await sleep(30000);
        break;
      case "draft":
      case "dirty":
      case "unknown":
      default:
        console.log(`mergeable_state=${pr.mergeable_state}. Possibly a draft or conflict. Retrying in 30s...`);
        await sleep(30000);
        break;
    }
    pollCount++;
  }
  console.error("Exceeded max polling rounds waiting for PR to become mergeable. Aborting.");
  return false;
}

// ---------------------
// Repository Preparation: Clone or Pull as needed and checkout a given branch
// ---------------------
async function prepareRepository(repoName, cloneUrl, branchName) {
  const currentDirName = path.basename(process.cwd());
  if (currentDirName !== repoName) {
    if (!fs.existsSync(repoName)) {
      console.log(`Directory '${repoName}' not found.`);
      const confirmed = await confirmAction(
        `Cloning repository ${repoName} from ${cloneUrl}`,
        `git clone ${cloneUrl} ${repoName}`
      );
      if (!confirmed) {
        console.error("Clone aborted by user.");
        process.exit(1);
      }
      debug(`Cloning repository ${repoName}...`);
      await runCommand(`git clone ${cloneUrl} ${repoName}`, { dangerous: true, description: `Cloning repository ${repoName}` });
      process.chdir(repoName);
    } else {
      process.chdir(repoName);
    }
  }
  let currentBranch;
  try {
    currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
    debug(`Current branch is: ${currentBranch}`);
  } catch (e) {
    console.error("Failed to get current branch:", e.message);
    process.exit(1);
  }
  if (currentBranch === branchName) {
    console.log(`Already on branch "${branchName}", pulling latest changes...`);
    await runCommand(`git pull`, { dangerous: true, description: `Pulling latest changes for branch ${branchName}` });
  } else {
    console.log(`Checking out branch "${branchName}"...`);
    await runCommand(`git checkout -B ${branchName} origin/${branchName}`, { dangerous: true, description: `Checking out branch ${branchName}` });
    console.log(`Pulling latest changes for branch "${branchName}"...`);
    await runCommand(`git pull`, { dangerous: true, description: `Pulling latest changes for branch ${branchName}` });
  }
  debug(`Repository '${repoName}' prepared on branch '${branchName}'. Current directory: ${process.cwd()}`);
}

// ---------------------
// Merges the pull request via GitHub API.
async function mergePullRequest() {
  const mergeData = {
    commit_title: `Auto-merge pull request #${pullNumber}`,
    merge_method: "merge",
  };
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`;
  const curlCommand = `curl -X PUT ${apiUrl} \\\n  -H "Authorization: token ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(mergeData)}'`;
  if (!(await confirmAction("Merging the pull request via GitHub API", curlCommand))) {
    throw new Error("User aborted GitHub API merge call.");
  }
  debug(`Sending merge request to GitHub API at ${apiUrl}...`);
  const response = await fetch(apiUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify(mergeData),
  });
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Merge failed: ${errorData.message}`);
  }
  debug("GitHub API merge successful.");
  return response.json();
}

// ---------------------
// Periodically syncs the PR branch with the default branch, merging and updating dependencies.
async function syncBranchWithDefault(defaultBranch, prBranchName) {
  while (true) {
    console.log("\n--- Fetching latest changes from origin ---");
    try {
      await runCommand(`git fetch origin ${defaultBranch}`, { dangerous: false, description: "Fetching updates from the default branch" });
      debug(`Fetched latest changes for branch: ${defaultBranch}`);
    } catch (e) {
      console.error("Failed to fetch the default branch:", e.message);
    }
    const mergeOutput = await mergeDefaultBranch(defaultBranch);
    if (!mergeOutput.includes("Already up to date")) {
      console.log("New changes merged from default branch, updating dependencies via yarn install...");
      await updateDependencies();
      await pushCurrentBranch(prBranchName);
      console.log("Dependencies updated. Checking merge status in 1 minute...");
      await sleep(60000);
    } else {
      console.log("PR branch is up-to-date with the default branch. Skipping yarn install.");
      break;
    }
  }
}

// ---------------------
// Main Flow
// ---------------------
(async () => {
  try {
    debug("Starting main flow...");
    console.log("Fetching repository details...");
    const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoResponse.ok) {
      throw new Error(`Failed to fetch repository details: ${repoResponse.statusText}`);
    }
    const repoDetails = await repoResponse.json();
    const defaultBranch = repoDetails.default_branch;
    console.log(`Default branch is: ${defaultBranch}`);
    debug(`Repository details: ${JSON.stringify(repoDetails)}`);

    console.log("Fetching pull request details...");
    const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`, { headers });
    if (!prResponse.ok) {
      throw new Error(`Failed to fetch pull request details: ${prResponse.statusText}`);
    }
    const prDetails = await prResponse.json();

    // If the pull request is already merged, checkout default branch and optionally push tag.
    if (prDetails.merged) {
      console.log("Pull request is already merged.");
      await prepareRepository(repo, repoDetails.clone_url, defaultBranch);
      let currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
      if (currentBranch !== defaultBranch) {
        console.log(`Not on default branch. Checking out default branch "${defaultBranch}"...`);
        await runCommand(`git checkout ${defaultBranch}`, { dangerous: true, description: `Checking out default branch ${defaultBranch}` });
      }
      console.log(`Pulling latest changes for default branch "${defaultBranch}"...`);
      await runCommand(`git pull`, { dangerous: true, description: `Pulling latest changes for default branch ${defaultBranch}` });
      const pushTag = await confirmAction("Do you want to push the new tag to the default branch?", "git push origin v<new-tag>");
      if (pushTag) {
        await pushNewTag();
      } else {
        console.log("Skipping tag push.");
      }
      process.exit(0);
    }

    const prBranchName = prDetails.head.ref;
    console.log(`Pull request branch: ${prBranchName}`);
    await prepareRepository(repo, repoDetails.clone_url, prBranchName);

    console.log("\nComparing package.json versions between default branch and PR branch...");
    const defaultPkg = await getPackageJsonFromBranch(defaultBranch);
    const localPkg = getLocalPackageJson();
    console.log(`Default branch package.json version: ${defaultPkg.version}`);
    console.log(`PR branch package.json version: ${localPkg.version}`);
    debug(`Default pkg version: ${defaultPkg.version}, PR branch pkg version: ${localPkg.version}`);

    if (semver.lte(localPkg.version, defaultPkg.version)) {
      console.log("PR branch version is lower or equal to the default branch version.");
      console.log("Merging default branch into PR branch...");
      const mergeOutput = await mergeDefaultBranch(defaultBranch);
      if (!mergeOutput.includes("Already up to date")) {
        console.log("Merge brought in new changes, updating dependencies via yarn install...");
        await updateDependencies();
      } else {
        console.log("No changes detected from merging default branch, skipping yarn install.");
      }
      console.log(`Bumping version using "${bumpType}"...`);
      await bumpLocalVersionSafe(bumpType);
      await pushCurrentBranch(prBranchName);
    } else {
      console.log("PR branch version is greater than the default branch version. No version bump required.");
    }

    console.log("\nStarting periodic sync with default branch...");
    await syncBranchWithDefault(defaultBranch, prBranchName);

    // Wait for the PR to be fully mergeable (including passing workflows)
    const canMerge = await waitForPRToBeMergeableWithRetries(owner, repo, pullNumber, headers);
    if (!canMerge) {
      console.log("Exiting without merge, because the PR was either merged externally or is unmergeable/failing.");
      process.exit(0);
    }

    console.log("\nAll updates and checks passed, and the PR is mergeable. Proceeding to merge via GitHub API...");
    const mergeResult = await mergePullRequest();
    if (mergeResult.merged) {
      console.log("Pull request merged successfully!");
      debug("Merge result: " + JSON.stringify(mergeResult));
      const pushTag = await confirmAction("Do you want to push the new tag to the default branch?", "git push origin v<new-tag>");
      if (pushTag) {
        await pushNewTag();
      } else {
        console.log("Skipping tag push.");
      }
    } else {
      console.error("Merge failed:", mergeResult.message);
      debug("Merge result: " + JSON.stringify(mergeResult));
    }
  } catch (error) {
    console.error("Error:", error.message);
    debug("Script terminating due to error.");
    process.exit(1);
  }
})();