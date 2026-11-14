// In-memory attendee store for the synthetic event sign-up demo.
// Test mode "legacy" (ID_FORMAT=legacy) uses numeric ids, like an older client expects.

export function createStore() {
  const attendees = [];
  let nextId = 1;
  const legacy = process.env.ID_FORMAT === 'legacy';

  return {
    add(input) {
      const id = legacy ? nextId++ : `att_${nextId++}`;
      const attendee = { id, name: input.name, email: input.email.toLowerCase() };
      attendees.push(attendee);
      return attendee;
    },
    list() {
      return attendees.slice();
    },
    findByEmail(email) {
      return attendees.find((a) => a.email === email.toLowerCase()) ?? null;
    },
  };
}
