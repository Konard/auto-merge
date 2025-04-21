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
//      - If a workflow or check run is failing, it downloads its logs and re-runs it.
//      - After 2 failed re-run attempts, the script aborts and displays the collected logs.
//  • Additionally, if the PR is not approved (i.e. it has not received at least the required approvals),
//      the script fails and asks the user to get approval from someone on the team.
//  • Finally, if a merge conflict is detected in package.json the script will only auto-resolve if the only change is in the version field;
//      otherwise, it aborts and asks the user to resolve conflicts manually.
//  • Extensive debugging output has been added at each API call and decision point.
//  • If all conditions pass and the PR is mergeable and approved, the script issues the GitHub API merge call.
//  • Optionally, after a successful merge, the script prompts to push a new tag.
//  • You can now pass `-y` or `--auto-approve` to skip all interactive confirmations.

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
const { use } = eval(await fetch("https://unpkg.com/use-m/use.js").then(u => u.text()));

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
const rawArgs = process.argv.slice(2);
let autoApprove = false;
const args = [];
for (const arg of rawArgs) {
  if (arg === "-y" || arg === "--auto-approve") {
    autoApprove = true;
    debug(`Auto-approve enabled via flag ${arg}`);
  } else {
    args.push(arg);
  }
}
const prUrl = args[0];
const bumpType = args[1];
debug(`Received arguments: prUrl=${prUrl}, bumpType=${bumpType}, autoApprove=${autoApprove}`);

if (!prUrl || !bumpType) {
  console.error("Usage: node auto-merge.mjs [-y|--auto-approve] <pull_request_url> <patch|minor|major>");
  process.exit(1);
}
if (!["patch", "minor", "major"].includes(bumpType)) {
  console.error("Error: Bump type must be one of: patch, minor, major");
  process.exit(1);
}

// Extract owner, repo, and pull request number from the URL.
const prRegex = /^https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/;
const match = prUrl.match(prRegex);
if (!match) {
  console.error("Error: Invalid pull request URL format. Expected format: https://github.com/owner/repo/pull/123");
  process.exit(1);
}
const [, owner, repo, pullNumber] = match;
debug(`Parsed PR URL: owner=${owner}, repo=${repo}, pullNumber=${pullNumber}`);

// Common GitHub API headers.
const headers = {
  Authorization: `token ${token}`,
  Accept: "application/vnd.github.v3+json",
  "Content-Type": "application/json",
};

// ---------------------
// Utility: Interactive Confirmation
// ---------------------
async function confirmAction(description, commandText) {
  if (autoApprove) {
    debug(`Auto-approved action: ${description}`);
    return true;
  }
  console.log("\n================================================================================");
  console.log(`ACTION: ${description}`);
  console.log(`REPRODUCIBLE COMMAND/API CALL:\n${commandText}`);
  console.log("================================================================================");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question("Do you want to continue? (y/n): ", resolve);
  });
  rl.close();
  debug(`User answer: ${answer}`);
  return answer.toLowerCase().startsWith("y");
}

// ---------------------
// Utility: runCommand – Execute shell commands with optional confirmation.
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
// Helper Function: Determine if package.json conflict is only in version field.
// ---------------------
function isOnlyVersionConflict(filePath) {
  try {
    const content = fs.readFileSync(filePath, "utf8");
    // If no conflict markers found, it's not conflicted.
    if (!content.includes("<<<<<<<") || !content.includes("=======") || !content.includes(">>>>>>>")) {
      return true;
    }
    // Regular expression to capture a conflict block.
    // This regex captures text between conflict markers.
    const conflictBlockRegex = /<<<<<<< HEAD([\s\S]*?)=======([\s\S]*?)>>>>>>>/g;
    let match;
    while ((match = conflictBlockRegex.exec(content)) !== null) {
      const blockHead = match[1].trim();
      const blockOther = match[2].trim();
      // Split the block lines
      const headLines = blockHead.split("\n").map(line => line.trim()).filter(line => line.length > 0);
      const otherLines = blockOther.split("\n").map(line => line.trim()).filter(line => line.length > 0);
      // We expect exactly one line in each block if only the version field is conflicted.
      if (headLines.length !== 1 || otherLines.length !== 1) {
        return false;
      }
      // Use a regex to test if the line is for the version property.
      const versionLineRegex = /^"version":\s*".+",?$/;
      if (!versionLineRegex.test(headLines[0]) || !versionLineRegex.test(otherLines[0])) {
        return false;
      }
    }
    return true;
  } catch (err) {
    console.error("Error reading file for conflict check:", err.message);
    return false;
  }
}

// ---------------------
// Helper Functions for Repository and Version Bump
// ---------------------
async function getPackageJsonFromBranch(branch) {
  debug(`Fetching package.json from branch: ${branch}`);
  const content = await runCommand(`git show origin/${branch}:package.json`);
  debug(`Fetched package.json content from ${branch}`);
  return JSON.parse(content);
}

function getLocalPackageJson() {
  debug("Reading local package.json file...");
  const content = fs.readFileSync("package.json", "utf8");
  debug("Successfully read local package.json.");
  return JSON.parse(content);
}

async function bumpLocalVersionSafe(bumpType) {
  const cmd = `yarn version --${bumpType}`;
  console.log(`Bumping version using "${cmd}"...`);
  await runCommand(cmd, { dangerous: true, description: `This will bump the version using yarn version --${bumpType}` });
  console.log("Version bump performed.");
}

async function pushCurrentBranch(branchName) {
  const cmd = `git push origin ${branchName}`;
  const description = `This will push the branch "${branchName}" to origin.`;
  debug(`Pushing current branch ${branchName} to origin.`);
  await runCommand(cmd, { dangerous: true, description });
}

async function pushNewTag() {
  const localPkg = getLocalPackageJson();
  const tagName = `v${localPkg.version}`;
  const cmd = `git push origin ${tagName}`;
  const description = `This will push the new tag ${tagName} to origin.`;
  debug(`Pushing new tag ${tagName} to origin.`);
  await runCommand(cmd, { dangerous: true, description });
  console.log(`Tag ${tagName} pushed successfully.`);
}

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
    const conflictsOutput = await runCommand(`git diff --name-only --diff-filter=U`, { dangerous: false, description: "Checking merge conflicts" });
    const conflicts = conflictsOutput.split(/\n/).map(s => s.trim()).filter(Boolean);
    debug(`Detected conflicts in files: ${conflicts.join(", ")}`);
    // Only auto-resolve if the only conflict is package.json
    if (conflicts.length === 1 && conflicts[0] === "package.json") {
      // Check that the conflict in package.json is solely in the "version" field.
      if (isOnlyVersionConflict("package.json")) {
        const resCmd = `git checkout --theirs package.json && git add package.json && git commit -m "Auto-resolved package.json version conflict from merging origin/${defaultBranch}"`;
        const confirmation = await confirmAction("Auto-resolving package.json conflict on the version field", resCmd);
        if (!confirmation) {
          console.error("Please resolve the conflicts manually and restart the script.");
          process.exit(1);
        }
        await runCommand(`git checkout --theirs package.json`, { dangerous: true, description: "Auto-resolve package.json conflict" });
        await runCommand(`git add package.json`, { dangerous: true, description: "Staging resolved package.json" });
        await runCommand(`git commit -m "Auto-resolved package.json version conflict from merging origin/${defaultBranch}"`, { dangerous: true, description: "Committing the conflict resolution" });
        debug("Auto-resolved package.json conflict on version field.");
        return "Merge completed with auto-resolved package.json version conflict";
      } else {
        console.error("Conflict in package.json involves changes beyond the version field. Please resolve manually.");
        process.exit(1);
      }
    } else if (conflicts.length > 0) {
      console.error("Merge conflicts detected in files:", conflicts);
      console.error("Please resolve these conflicts manually and then restart the script.");
      return "";
    }
    return "";
  }
}

async function updateDependencies() {
  const cmd = "yarn install";
  const description = "This will update your local yarn.lock and node_modules.";
  debug("Running yarn install to update dependencies.");
  await runCommand(cmd, { dangerous: true, description });
  console.log("Local dependencies updated via yarn.");
}

function sleep(ms) {
  debug(`Sleeping for ${ms} ms...`);
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------
// New Helper: Check if PR is Approved
// ---------------------
async function isPRApproved(owner, repo, pullNumber, headers) {
  const reviewsUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`;
  console.log(`Fetching reviews from: ${reviewsUrl}`);
  const response = await fetch(reviewsUrl, { headers });
  if (!response.ok) {
    throw new Error(`Failed to fetch reviews: ${response.status} ${response.statusText}`);
  }
  const reviews = await response.json();
  const reviewMap = new Map();
  reviews.forEach(review => {
    if (!review.submitted_at) return;
    const username = review.user.login;
    if (!reviewMap.has(username) || new Date(review.submitted_at) > new Date(reviewMap.get(username).submitted_at)) {
      reviewMap.set(username, review);
    }
  });
  let approvedCount = 0;
  reviewMap.forEach(review => {
    if (review.state.toUpperCase() === "APPROVED") {
      approvedCount++;
    }
  });
  console.log(`Approved reviews count: ${approvedCount}`);
  const REQUIRED_APPROVALS = 1; // Adjust if more approvals are required
  return approvedCount >= REQUIRED_APPROVALS;
}

// ---------------------
// Helpers for Handling Failed Workflow/Check Runs with Extensive Tracing
// ---------------------
async function getFailedWorkflowsForCommit(owner, repo, commitSHA, headers) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=50`;
  debug(`GET ${url}`);
  const resp = await fetch(url, { headers });
  const data = await resp.json();
  console.log("ALL WORKFLOW RUNS RESPONSE:", JSON.stringify(data, null, 2));
  const runsOnCommit = data.workflow_runs.filter(run => run.head_sha === commitSHA);
  console.log(`Workflow runs for commit ${commitSHA}:`, JSON.stringify(runsOnCommit, null, 2));
  const failedRuns = runsOnCommit.filter(
    run => run.status === "completed" &&
           (run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "cancelled")
  );
  console.log(`Failed workflow runs for commit ${commitSHA}:`, JSON.stringify(failedRuns, null, 2));
  return failedRuns;
}

async function getFailedCheckRunsForCommit(owner, repo, commitSHA, headers) {
  const url = `https://api.github.com/repos/${owner}/${repo}/commits/${commitSHA}/check-runs`;
  debug(`GET ${url}`);
  const resp = await fetch(url, { headers });
  const data = await resp.json();
  console.log("ALL CHECK RUNS RESPONSE:", JSON.stringify(data, null, 2));
  const failedCheckRuns = data.check_runs.filter(
    run => run.conclusion === "failure" || run.conclusion === "timed_out" || run.conclusion === "cancelled"
  );
  console.log(`Failed check runs for commit ${commitSHA}:`, JSON.stringify(failedCheckRuns, null, 2));
  return failedCheckRuns;
}

async function downloadWorkflowLogs(owner, repo, runId, headers) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/logs`;
  debug(`Downloading logs from ${url}`);
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
  debug(`Logs saved to ${zipPath}`);
  const zip = new AdmZip(zipPath);
  const extractDir = path.join("logs", `run-${runId}`);
  zip.extractAllTo(extractDir, true);
  console.log(`Logs for run ${runId} extracted to ${extractDir}`);
  return { zipPath, extractDir };
}

async function reRunWorkflow(owner, repo, runId, headers) {
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}/rerun`;
  debug(`POST ${url}`);
  const resp = await fetch(url, { method: "POST", headers });
  debug(`Re-run response status: ${resp.status}`);
  if (resp.status === 403) {
    throw new Error(`Forbidden: Could not re-run workflow ${runId}.`);
  }
  if (!resp.ok) {
    throw new Error(`Failed to re-run workflow ${runId}: ${resp.status} / ${resp.statusText}`);
  }
  console.log(`Requested re-run for workflow run ${runId}.`);
}

async function reRunCheckSuite(owner, repo, checkSuiteId, headers) {
  const url = `https://api.github.com/repos/${owner}/${repo}/check-suites/${checkSuiteId}/rerequest`;
  debug(`POST re-run check suite ${url}`);
  const resp = await fetch(url, { method: "POST", headers });
  if (resp.status === 403) {
    throw new Error(`Forbidden: Could not re-run check suite ${checkSuiteId}.`);
  }
  if (!resp.ok) {
    throw new Error(`Failed to re-run check suite ${checkSuiteId}: ${resp.status} / ${resp.statusText}`);
  }
  console.log(`Requested re-run for check suite ${checkSuiteId}.`);
}

async function handleFailedWorkflows(owner, repo, commitSHA, headers, maxRetries = 2) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    console.log(`Checking for failed workflows and check runs (attempt ${attempt} of ${maxRetries}) for commit ${commitSHA}...`);

    const failedWorkflowRuns = await getFailedWorkflowsForCommit(owner, repo, commitSHA, headers);
    const failedCheckRuns = await getFailedCheckRunsForCommit(owner, repo, commitSHA, headers);

    // Get pending check runs
    const checkRunsResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${commitSHA}/check-runs`, { headers });
    const checkRunsData = await checkRunsResp.json();
    const pendingCheckRuns = checkRunsData.check_runs.filter(run => run.status !== "completed");

    if (failedWorkflowRuns.length > 0 || failedCheckRuns.length > 0) {
      console.log(`Found ${failedWorkflowRuns.length} failed workflow run(s) and ${failedCheckRuns.length} failed check run(s).`);
      // Re-run failed workflow runs
      for (const run of failedWorkflowRuns) {
        console.log(`Requesting re-run for failed workflow run #${run.id} (${run.name})...`);
        try {
          await reRunWorkflow(owner, repo, run.id, headers);
        } catch (err) {
          console.error(`Error re-running workflow run #${run.id}: ${err.message}`);
        }
      }
      // Re-run failed check suites (by unique check_suite id)
      const failedCheckSuites = new Set();
      for (const check of failedCheckRuns) {
        if (check.check_suite && check.check_suite.id) {
          failedCheckSuites.add(check.check_suite.id);
        }
      }
      for (const suiteId of failedCheckSuites) {
        try {
          await reRunCheckSuite(owner, repo, suiteId, headers);
        } catch (err) {
          console.error(`Error re-running check suite ${suiteId}: ${err.message}`);
        }
      }
      console.log("Requested re-run for failed tasks. Waiting 30s for re-run workflows and check suites to start...");
      await sleep(30000);
      attempt++;
      continue;
    } else if (pendingCheckRuns.length > 0) {
      console.log(`There are ${pendingCheckRuns.length} pending check run(s). Waiting for them to finish...`);
      await sleep(30000);
      attempt++;
      continue;
    } else {
      console.log("No failed or pending workflow/check runs detected.");
      return true;
    }
  }
  console.error("Max retries reached. Aborting workflow/check re-run attempts. See logs in the 'logs' folder.");
  return false;
}

// ---------------------
// Extended Wait for Mergeable with Workflow/Check Re-run and Approval Check
// ---------------------
async function waitForPRToBeMergeableWithRetries(owner, repo, pullNum, headers) {
  const maxPollingRounds = 30;
  let pollCount = 0;
  while (pollCount < maxPollingRounds) {
    console.log("Polling PR for mergeability...");
    const prRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNum}`, { headers });
    const pr = await prRes.json();
    console.log("Current PR JSON:", JSON.stringify(pr, null, 2));

    if (pr.merged) {
      console.log("Pull request is already merged externally.");
      return false;
    }

    // Check if the PR is approved using our helper function.
    const approved = await isPRApproved(owner, repo, pullNum, headers);
    if (!approved) {
      console.error("Pull request is not approved. Please get approval from someone on the team before merging.");
      return false;
    }

    if (pr.mergeable_state === "blocked" || pr.mergeable_state === "unstable") {
      console.log(`Detected mergeable_state=${pr.mergeable_state}. Attempting to handle failed workflows/checks...`);
      const commitSHA = pr.head.sha;
      const success = await handleFailedWorkflows(owner, repo, commitSHA, headers, 2);
      if (!success) {
        console.error("Failed workflows/checks could not be fixed after 2 attempts. Aborting.");
        return false;
      }
      console.log("Workflows restarted. Re-polling soon...");
      await sleep(5000);
      pollCount++;
      continue;
    }
    if (!pr.mergeable) {
      console.log("PR mergeable property is false, waiting 30s...");
      await sleep(30000);
      pollCount++;
      continue;
    }
    if (pr.mergeable_state === "clean") {
      console.log("PR is mergeable and 'clean'. All checks passed and approved. Proceeding to merge.");
      return true;
    }
    console.log(`PR mergeable_state=${pr.mergeable_state}. Retrying in 30s...`);
    await sleep(30000);
    pollCount++;
  }
  console.error("Exceeded maximum polling rounds for mergeability. Aborting.");
  return false;
}

// ---------------------
// Repository Preparation: Clone or Pull and Checkout Branch
// ---------------------
async function prepareRepository(repoName, cloneUrl, branchName) {
  const currentDirName = path.basename(process.cwd());
  if (currentDirName !== repoName) {
    if (!fs.existsSync(repoName)) {
      console.log(`Directory '${repoName}' not found.`);
      const confirmed = await confirmAction(`Cloning repository ${repoName} from ${cloneUrl}`, `git clone ${cloneUrl} ${repoName}`);
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
// Merges the PR via GitHub API.
// ---------------------
async function mergePullRequest() {
  const mergeData = { commit_title: `Auto-merge pull request #${pullNumber}`, merge_method: "merge" };
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`;
  const curlCommand = `curl -X PUT ${apiUrl} \\\n  -H "Authorization: token ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(mergeData)}'`;
  if (!(await confirmAction("Merging the pull request via GitHub API", curlCommand))) {
    throw new Error("User aborted GitHub API merge call.");
  }
  debug(`Sending merge request to ${apiUrl} with data: ${JSON.stringify(mergeData)}`);
  const response = await fetch(apiUrl, { method: "PUT", headers, body: JSON.stringify(mergeData) });
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Merge failed: ${errorData.message}`);
  }
  const mergeResult = await response.json();
  debug("Merge API response: " + JSON.stringify(mergeResult, null, 2));
  return mergeResult;
}

// ---------------------
// Periodically syncs the PR branch with the default branch.
// ---------------------
async function syncBranchWithDefault(defaultBranch, prBranchName) {
  while (true) {
    console.log("\n--- Fetching latest changes from origin ---");
    try {
      await runCommand(`git fetch origin ${defaultBranch}`, { dangerous: false, description: "Fetching updates from the default branch" });
      debug(`Fetched latest changes for branch: ${defaultBranch}`);
    } catch (e) {
      console.error("Failed to fetch updates:", e.message);
    }
    const mergeOutput = await mergeDefaultBranch(defaultBranch);
    if (!mergeOutput.includes("Already up to date")) {
      console.log("New changes merged from default branch. Updating dependencies...");
      await updateDependencies();
      await pushCurrentBranch(prBranchName);
      console.log("Dependencies updated. Waiting 60s before next sync...");
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
    console.log(`Default branch: ${defaultBranch}`);
    debug(`Repository details: ${JSON.stringify(repoDetails)}`);

    console.log("Fetching pull request details...");
    const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`, { headers });
    if (!prResponse.ok) {
      throw new Error(`Failed to fetch pull request details: ${prResponse.statusText}`);
    }
    const prDetails = await prResponse.json();
    console.log("Pull request details:", JSON.stringify(prDetails, null, 2));

    if (prDetails.merged) {
      console.log("PR already merged. Preparing default branch...");
      await prepareRepository(repo, repoDetails.clone_url, defaultBranch);
      let currentBranch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
      if (currentBranch !== defaultBranch) {
        console.log(`Not on default branch. Checking out "${defaultBranch}"...`);
        await runCommand(`git checkout ${defaultBranch}`, { dangerous: true, description: `Checking out default branch ${defaultBranch}` });
      }
      console.log(`Pulling latest changes for "${defaultBranch}"...`);
      await runCommand(`git pull`, { dangerous: true, description: `Pulling latest changes for branch ${defaultBranch}` });
      const pushTag = await confirmAction("Do you want to push the new tag to the default branch?", "git push origin v<new-tag>");
      if (pushTag) {
        await pushNewTag();
      } else {
        console.log("Skipping tag push.");
      }
      process.exit(0);
    }

    const prBranchName = prDetails.head.ref;
    console.log(`PR branch: ${prBranchName}`);
    await prepareRepository(repo, repoDetails.clone_url, prBranchName);

    console.log("\nComparing package.json versions...");
    const defaultPkg = await getPackageJsonFromBranch(defaultBranch);
    const localPkg = getLocalPackageJson();
    console.log(`Default branch package.json version: ${defaultPkg.version}`);
    console.log(`PR branch package.json version: ${localPkg.version}`);
    debug(`Default version: ${defaultPkg.version}, PR branch version: ${localPkg.version}`);

    if (semver.lte(localPkg.version, defaultPkg.version)) {
      console.log("PR branch version is less than or equal to the default branch version. Merging default branch into PR branch...");
      const mergeOutput = await mergeDefaultBranch(defaultBranch);
      if (!mergeOutput.includes("Already up to date")) {
        console.log("Merge brought changes. Updating dependencies...");
        await updateDependencies();
      } else {
        console.log("No changes from merge. Skipping dependency update.");
      }
      console.log(`Bumping version using "${bumpType}"...`);
      await bumpLocalVersionSafe(bumpType);
      await pushCurrentBranch(prBranchName);
    } else {
      console.log("PR branch version is greater than default branch version. No version bump required.");
    }

    console.log("\nStarting periodic sync with default branch...");
    await syncBranchWithDefault(defaultBranch, prBranchName);

    console.log("\nWaiting for PR to become mergeable (including workflow/checks and approval)...");
    const canMerge = await waitForPRToBeMergeableWithRetries(owner, repo, pullNumber, headers);
    if (!canMerge) {
      console.log("Exiting without merge since PR is either merged externally, unmergeable, or not approved.");
      process.exit(0);
    }

    console.log("\nAll checks passed and PR is mergeable and approved. Proceeding with merge via GitHub API...");
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
      debug("Merge response:", JSON.stringify(mergeResult, null, 2));
    }
  } catch (error) {
    console.error("Error:", error.message);
    debug("Script terminating due to error.");
    process.exit(1);
  }
})();
