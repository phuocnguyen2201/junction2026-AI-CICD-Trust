// Pure display helpers for the sign-up page (tested without a browser).

export function formatAttendee(attendee) {
  return `${attendee.name} <${attendee.email}>`;
}

export function formatErrors(issues) {
  return issues.map((i) => i.message).join('. ');
}
