/**
 * K0.3 — the frontend/backend API contract.
 *
 * The security phase locked down the API and nobody updated the frontend, so
 * every protected call returned 401 and the app could not talk to its own
 * server. Nothing caught it, because no test looked at both sides at once.
 *
 * This does. It reads the actual endpoint strings out of the frontend source
 * and checks each one against the routes the backend actually declares. It is
 * a static cross-check, not an HTTP test — but it is the check that was
 * missing, and it fails the moment either side moves without the other.
 */
const fs = require("fs");
const path = require("path");

const BACKEND_ROUTES = path.join(__dirname, "..", "src", "routes");
// The frontend lives beside the backend in this repo layout.
const FRONTEND_SRC = path.join(__dirname, "..", "..", "frontend", "src");

const frontendAvailable = fs.existsSync(FRONTEND_SRC);

/** Every path string the backend router files declare, with its method. */
function backendEndpoints() {
  const found = [];
  for (const file of fs.readdirSync(BACKEND_ROUTES)) {
    if (!file.endsWith(".js")) continue;
    const src = fs.readFileSync(path.join(BACKEND_ROUTES, file), "utf8");
    for (const m of src.matchAll(/router\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/g)) {
      found.push({ method: m[1].toUpperCase(), route: m[2], file });
    }
  }
  return found;
}

/** Every API path the frontend calls through the axios client. */
function frontendCalls() {
  const calls = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.jsx?$/.test(entry.name)) continue;
      const src = fs.readFileSync(full, "utf8");
      // `api` and `.get(` are often on separate lines:
      //     api
      //       .get("/users/me/recommendation-history", ...)
      // A regex requiring them adjacent silently skips those calls, which
      // makes the orphan check below pass by not looking.
      for (const m of src.matchAll(
        /\bapi\s*\.\s*(get|post|put|patch|delete)\s*\(\s*[`"']([^`"']+)/g
      )) {
        calls.push({
          method: m[1].toUpperCase(),
          route: m[2],
          file: path.relative(FRONTEND_SRC, full),
        });
      }
    }
  };
  walk(FRONTEND_SRC);
  return calls;
}

/**
 * Does a frontend path match a backend route pattern?
 * `${...}` interpolations and `:params` both stand for one path segment.
 */
function matches(frontendPath, backendRoute) {
  const fe = frontendPath.replace(/\$\{[^}]*\}/g, "•").replace(/\/+$/, "");
  const be = backendRoute.replace(/:[A-Za-z0-9_]+/g, "•").replace(/\/+$/, "");
  return fe === be;
}

/**
 * The frontend must be reachable from here. This assertion is NOT inside
 * `describeIfFrontend` on purpose.
 *
 * The contract suites below skip themselves when the frontend path misses. That
 * is right when someone checks out the backend alone — but during the H–P merge
 * the path still pointed at the development sandbox's `frontend/frontend/src`,
 * which does not exist in the real repository. The suites skipped, 41 tests
 * silently vanished, and the run still reported green.
 *
 * A skip that hides a broken path is worse than a failure. This makes the miss
 * loud.
 */
describe("repository layout", () => {
  it("resolves the frontend source from the backend tests", () => {
    expect({ FRONTEND_SRC, exists: frontendAvailable }).toEqual({
      FRONTEND_SRC,
      exists: true,
    });
  });
});

const describeIfFrontend = frontendAvailable ? describe : describe.skip;

describeIfFrontend("frontend calls resolve to real backend routes", () => {
  const backend = backendEndpoints();
  const calls = frontendCalls();

  it("finds the frontend source and some API calls in it", () => {
    // Guard against the whole suite passing vacuously because the path moved.
    expect(calls.length).toBeGreaterThan(3);
  });

  it("has no call to an endpoint the backend does not declare", () => {
    const orphans = calls.filter(
      (c) => !backend.some((b) => b.method === c.method && matches(c.route, b.route))
    );
    // POST /users was the specific casualty: removed in favour of
    // POST /api/auth/register and PUT /api/users/me, with the frontend left
    // calling the dead route.
    expect(
      orphans.map((o) => `${o.method} ${o.route} (${o.file})`)
    ).toEqual([]);
  });

  it("no longer calls the removed anonymous profile upsert", () => {
    const dead = calls.filter((c) => c.method === "POST" && c.route === "/users");
    expect(dead).toEqual([]);
  });

  it("uses the authenticated profile-update route instead", () => {
    expect(backend.some((b) => b.method === "PUT" && b.route === "/users/me")).toBe(true);
  });

  it("can reach the recommendation history endpoint", () => {
    expect(
      backend.some((b) => b.method === "GET" && b.route === "/users/me/recommendation-history")
    ).toBe(true);
    expect(
      calls.some((c) => c.method === "GET" && c.route === "/users/me/recommendation-history")
    ).toBe(true);
  });
});

describeIfFrontend("the frontend sends credentials correctly", () => {
  const client = fs.readFileSync(path.join(FRONTEND_SRC, "api", "client.js"), "utf8");

  it("attaches an Authorization header via an interceptor", () => {
    expect(client).toMatch(/interceptors\.request\.use/);
    expect(client).toMatch(/Authorization/);
    expect(client).toMatch(/Bearer/);
  });

  it("clears the token on 401 but NOT on 403", () => {
    // 403 means the token is VALID and the action is not allowed. Clearing it
    // would sign a user out for opening an admin page they cannot use.
    const i401 = client.indexOf("status === 401");
    const i403 = client.indexOf("status === 403");
    expect(i401).toBeGreaterThan(-1);
    expect(i403).toBeGreaterThan(-1);
    expect(i401).toBeLessThan(i403);

    const block401 = client.slice(i401, i403);
    const block403 = client.slice(i403);
    expect(block401).toMatch(/tokenStore\.clear\(\)/);
    expect(block403).not.toMatch(/tokenStore\.clear\(\)/);
  });

  it("contains no hardcoded token or secret", () => {
    // A JWT literal or an API key in frontend source ships to every visitor.
    expect(client).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // JWT literal
    expect(client).not.toMatch(/(api[_-]?key|secret)\s*[:=]\s*["'][^"']{8,}/i);
  });
});

describeIfFrontend("protected pages are gated in the UI", () => {
  const app = fs.readFileSync(path.join(FRONTEND_SRC, "App.jsx"), "utf8");

  it("wraps the signed-in routes in ProtectedRoute", () => {
    for (const route of ["/matches", "/history", "/admin"]) {
      const idx = app.indexOf(`path="${route}"`);
      expect(idx).toBeGreaterThan(-1);
      // The element for this route should mention the guard.
      const window = app.slice(idx, idx + 400);
      expect(window).toMatch(/ProtectedRoute/);
    }
  });

  it("marks the admin route as admin-only", () => {
    const idx = app.indexOf('path="/admin"');
    expect(app.slice(idx, idx + 300)).toMatch(/requireAdmin/);
  });
});

describe("backend route ordering", () => {
  it("declares /users/me routes before /users/:email", () => {
    // Express matches in declaration order. If /users/:email came first it
    // would swallow "/users/me/recommendation-history" and treat the literal
    // string "me" as an email address.
    const src = fs.readFileSync(path.join(BACKEND_ROUTES, "users.js"), "utf8");
    const meIdx = src.indexOf('"/users/me/recommendation-history"');
    const emailIdx = src.indexOf('"/users/:email"');
    expect(meIdx).toBeGreaterThan(-1);
    expect(emailIdx).toBeGreaterThan(-1);
    expect(meIdx).toBeLessThan(emailIdx);
  });
});

describeIfFrontend("notification UI contract", () => {
  const read = (rel) => fs.readFileSync(path.join(FRONTEND_SRC, rel), "utf8");
  const ctx = read("notifications/NotificationContext.jsx");
  const item = read("notifications/NotificationItem.jsx");
  const bell = read("notifications/NotificationBell.jsx");
  const page = read("pages/Notifications.jsx");
  const app = read("App.jsx");

  it("calls only the authenticated me-scoped endpoints", () => {
    // A public notification route would be an IDOR waiting to happen.
    const calls = [...ctx.matchAll(/api\s*\.\s*\w+\s*\(\s*[`"']([^`"']+)/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.startsWith("/users/me/notifications")).toBe(true);
  });

  it("never sends a user id of its own", () => {
    // The server derives identity from the token. A client-supplied id would
    // be something to tamper with.
    expect(ctx).not.toMatch(/userId/);
    expect(ctx).not.toMatch(/params:\s*{[^}]*email/);
  });

  it("renders no internal or operational field", () => {
    // Strip comments first: the components document which fields deliberately
    // never arrive, and naming them in prose must not read as using them.
    const codeOnly = (src) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const forbidden = [
      "retryCount", "lastError", "processingJobId", "failureKind",
      "nextAttemptAt", "userEmail", "recommendationHistoryId",
    ];
    for (const f of forbidden) {
      expect(codeOnly(item)).not.toContain(f);
      expect(codeOnly(page)).not.toContain(f);
      expect(codeOnly(bell)).not.toContain(f);
    }
  });

  it("shows every state a user can land in", () => {
    for (const state of ["loading", "error", "ready"]) {
      expect(page).toContain(state);
    }
    // An empty dropdown that silently shows nothing is indistinguishable from
    // one that failed.
    expect(bell).toMatch(/Nothing yet/);
    expect(page).toMatch(/Nothing yet/);
  });

  it("supports read, mark-all-read and paging", () => {
    expect(ctx).toMatch(/markRead/);
    expect(ctx).toMatch(/markAllRead/);
    expect(ctx).toMatch(/loadMore/);
    expect(page).toMatch(/Load more/);
  });

  it("reverts an optimistic mark-read when the server refuses", () => {
    // Otherwise a failed request leaves a permanently wrong unread count.
    const fn = ctx.slice(ctx.indexOf("const markRead"), ctx.indexOf("const markAllRead"));
    expect(fn).toMatch(/catch/);
    expect(fn).toMatch(/read: false/);
  });

  it("clears one user's notifications when another signs in", () => {
    expect(ctx).toMatch(/reset\(\)/);
  });

  it("gates the inbox route behind authentication", () => {
    const idx = app.indexOf('path="/notifications"');
    expect(idx).toBeGreaterThan(-1);
    expect(app.slice(idx, idx + 300)).toMatch(/ProtectedRoute/);
  });

  it("shows the bell only to a signed-in user", () => {
    const navBlock = app.slice(app.indexOf("isAuthenticated ? ("), app.indexOf("Sign out"));
    expect(navBlock).toContain("NotificationBell");
  });
});
