// Formats collected issues for the organiser's data-quality report (GET /issues).

export function formatIssue(issue) {
  const where = issue.location.line === null ? issue.location.file : `${issue.location.file}:${issue.location.line}`;
  return `[${issue.source}] ${issue.message} (${where})`;
}

export function buildReport(issues) {
  return issues.map(formatIssue);
}
