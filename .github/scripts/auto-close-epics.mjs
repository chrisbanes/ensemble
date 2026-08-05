import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REQUIRED_LABEL_IDS = [
  "LA_kwDORzdwYM8AAAACuWX7NA", // epic
  "LA_kwDORzdwYM8AAAACu3F6Tg", // auto-close-epic
];
const CLOSE_COMMENT =
  "All native sub-issues are closed and no native blocker remains open. " +
  "Closing this opted-in epic automatically.";

export class GhClient {
  constructor(runGh) {
    this.runGh = runGh;
  }

  async getParent({ repository, number }) {
    let output;
    try {
      output = this.runGh([
        "api",
        `repos/${repository}/issues/${number}/parent`,
      ]).trim();
    } catch (error) {
      try {
        const response = JSON.parse(String(error.stdout));
        if (
          response.status === "404" &&
          response.message === "No parent issue found"
        ) {
          return null;
        }
      } catch {
        // The original GitHub CLI failure is more useful than a parse error.
      }
      throw error;
    }
    if (!output) return null;

    return JSON.parse(output);
  }

  async closeIssue({ repository, number }) {
    this.runGh([
      "issue",
      "close",
      String(number),
      "--repo",
      repository,
      "--reason",
      "completed",
      "--comment",
      CLOSE_COMMENT,
    ]);
  }
}

function ineligibleReason(issue) {
  const labelIds = new Set(issue.labels?.map(({ node_id }) => node_id) ?? []);
  const subIssues = issue.sub_issues_summary;
  const dependencies = issue.issue_dependencies_summary;

  if (issue.state !== "open") return "parent is not open";
  if (!REQUIRED_LABEL_IDS.every((labelId) => labelIds.has(labelId))) {
    return "parent is not opted in";
  }
  if (
    !Number.isInteger(subIssues?.total) ||
    !Number.isInteger(subIssues?.completed) ||
    !Number.isInteger(dependencies?.blocked_by)
  ) {
    return "GitHub omitted required completion metadata";
  }
  if (subIssues.total === 0) return "parent has no native sub-issues";
  if (subIssues.completed !== subIssues.total) {
    return `${subIssues.total - subIssues.completed} native sub-issue(s) remain open`;
  }
  if (dependencies.blocked_by > 0) {
    return `${dependencies.blocked_by} native blocker(s) remain open`;
  }
  return null;
}

export function canAutoCloseEpic(issue) {
  return ineligibleReason(issue) === null;
}

export async function closeEligibleAncestors({
  repository,
  issueNumber,
  client,
  logger = console,
}) {
  let current = { repository, number: issueNumber };

  while (true) {
    const issue = await client.getParent(current);
    if (!issue) return;

    const parent = {
      repository: issue.repository?.full_name,
      number: issue.number,
    };
    if (!parent.repository || !Number.isSafeInteger(parent.number)) {
      throw new Error("GitHub returned incomplete parent identity metadata");
    }
    if (parent.repository !== repository) {
      logger.warn(
        `Skipping cross-repository parent ${parent.repository}#${parent.number}`,
      );
      return;
    }
    if (issue.state === "closed") {
      current = parent;
      continue;
    }

    const reason = ineligibleReason(issue);
    if (reason) {
      logger.info(`Leaving ${repository}#${parent.number} open: ${reason}`);
      return;
    }

    await client.closeIssue(parent);
    logger.info(`Closed ${repository}#${parent.number}`);
    current = parent;
  }
}

function runGh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 30_000,
  });
}

export async function main(environment = process.env) {
  const repository = environment.GITHUB_REPOSITORY;
  const issueNumber = Number(environment.ISSUE_NUMBER);
  if (!repository || !Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error("GITHUB_REPOSITORY and a positive ISSUE_NUMBER are required");
  }

  await closeEligibleAncestors({
    repository,
    issueNumber,
    client: new GhClient(runGh),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
