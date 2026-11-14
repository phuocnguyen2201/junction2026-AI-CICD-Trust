// Route table and a pure request handler (easy to test without a socket).
// Every route here must also be declared in api/contract.json.

import { createStore } from './store.js';
import { validateAttendee } from './validate.js';
import { collectIssues } from './issues.js';
import { buildReport } from './report.js';

export function createApp({ store = createStore(), issueSources = { local: [], imported: [] } } = {}) {
  const routes = [
    {
      method: 'GET',
      path: '/attendees',
      handler: () => ({ status: 200, body: store.list() }),
    },
    {
      method: 'POST',
      path: '/attendees',
      handler: ({ body }) => {
        const issues = validateAttendee(body);
        if (issues.length) return { status: 400, body: { error: 'invalid_input', issues } };
        return { status: 201, body: store.add(body) };
      },
    },
    {
      method: 'GET',
      path: '/issues',
      handler: () => ({ status: 200, body: buildReport(collectIssues(issueSources)) }),
    },
  ];

  function handle({ method, path, body }) {
    const route = routes.find((r) => r.method === method && r.path === path);
    if (!route) return { status: 404, body: { error: 'not_found' } };
    return route.handler({ body });
  }

  return { routes, handle, store };
}
