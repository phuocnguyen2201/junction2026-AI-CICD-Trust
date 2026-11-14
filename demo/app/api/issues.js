// Collects data-quality issues from the local attendee file and from imported partner lists.
// Local issues always carry a location ({ file, line }); line is null for file-level issues.
// Imported issues come from a partner system and have no location at all.

export function collectIssues({ local = [], imported = [] }) {
  return [
    ...local.map((i) => ({ ...i, source: 'local' })),
    ...imported.map((i) => ({ ...i, source: 'imported' })),
  ];
}
