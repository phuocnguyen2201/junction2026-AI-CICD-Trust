// Browser wiring for the sign-up page. Talks to the API in api/routes.js.

import { formatAttendee, formatErrors } from './format.js';

const form = document.getElementById('signup');
const list = document.getElementById('attendees');
const error = document.getElementById('error');

async function refresh() {
  const res = await fetch('/attendees');
  const attendees = await res.json();
  list.replaceChildren(
    ...attendees.map((a) => {
      const li = document.createElement('li');
      li.textContent = formatAttendee(a);
      return li;
    }),
  );
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = { name: form.name.value, email: form.email.value };
  const res = await fetch('/attendees', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    error.textContent = '';
    form.reset();
    await refresh();
  } else {
    const data = await res.json();
    error.textContent = formatErrors(data.issues ?? []);
  }
});

refresh();
