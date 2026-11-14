// Input validation for POST /attendees. Returns a list of issues; empty means valid.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAttendee(input) {
  const issues = [];
  if (!input || typeof input !== 'object') {
    return [{ code: 'invalid_body', field: null, message: 'Body must be a JSON object' }];
  }
  if (typeof input.name !== 'string' || input.name.length === 0) {
    issues.push({ code: 'missing_name', field: 'name', message: 'Name missing' });
  }
  if (typeof input.email !== 'string' || !EMAIL.test(input.email)) {
    issues.push({ code: 'invalid_email', field: 'email', message: 'Email is not valid' });
  }
  return issues;
}
