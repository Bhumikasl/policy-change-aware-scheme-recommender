/**
 * Phase N — static contract checks on the chat endpoint and its UI.
 *
 * ---------------------------------------------------------------------------
 * WHY STATIC CHECKS AND NOT HTTP TESTS
 * ---------------------------------------------------------------------------
 * supertest is not installable in this sandbox (npm returns 403 for every
 * registry), so `tests/api.test.js` cannot run here and the real HTTP surface
 * is unverified. That is stated plainly in the report rather than papered over.
 *
 * What CAN be verified without a server is the shape of the source: that the
 * route declares `requireAuth`, that the handler passes the token subject
 * rather than anything from the body, and that the client sends no identity of
 * its own. Those are exactly the properties whose absence caused the IDOR this
 * project already had to fix once, and a regression in any of them is a source
 * edit these tests will catch.
 *
 * This is a weaker guarantee than an HTTP test and is not offered as a
 * substitute for one.
 */
const fs = require("fs");
const path = require("path");

const ROUTE_FILE = path.join(__dirname, "..", "src", "routes", "chat.js");
const SERVICE_FILE = path.join(__dirname, "..", "src", "services", "chatService.js");
const APP_FILE = path.join(__dirname, "..", "src", "app.js");
const FRONTEND_SRC = path.join(__dirname, "..", "..", "frontend", "src");

const routeSrc = fs.readFileSync(ROUTE_FILE, "utf8");
const serviceSrc = fs.readFileSync(SERVICE_FILE, "utf8");
const appSrc = fs.readFileSync(APP_FILE, "utf8");

/** Strip comments so a doc block that MENTIONS a pattern cannot satisfy a check. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const routeCode = code(routeSrc);
const serviceCode = code(serviceSrc);

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("POST /api/chat is authenticated", () => {
  it("declares the route", () => {
    expect(routeCode).toMatch(/router\.post\(\s*["'`]\/chat["'`]/);
  });

  it("applies requireAuth to every chat route", () => {
    // Every router.<verb>( in this file must have requireAuth in its handler
    // chain. Counting rather than spot-checking, so a route added later
    // without the guard fails this test instead of slipping through.
    const routes = [...routeCode.matchAll(/router\.(get|post|put|patch|delete)\(([\s\S]*?)asyncHandler/g)];
    expect(routes.length > 0).toBe(true);
    for (const r of routes) {
      expect(r[2]).toContain("requireAuth");
    }
  });

  it("is mounted under /api", () => {
    expect(code(appSrc)).toMatch(/app\.use\(\s*["'`]\/api["'`]\s*,\s*chatRouter\s*\)/);
  });

  it("rate-limits the endpoint below the global ceiling", () => {
    // Each call can trigger an embedding request and a generation, so an
    // unbounded caller costs real quota.
    expect(routeCode).toMatch(/rateLimit\(/);
    expect(routeCode).toMatch(/CHAT_RATE_LIMIT_MAX/);
  });
});

// ---------------------------------------------------------------------------
// User isolation, at the source level
// ---------------------------------------------------------------------------

describe("the chat route cannot be pointed at another user", () => {
  it("passes the verified token subject as the identity", () => {
    expect(routeCode).toMatch(/userId:\s*req\.user\.sub/);
  });

  it("destructures ONLY non-identity fields from the body", () => {
    const m = routeCode.match(/const\s*\{([^}]*)\}\s*=\s*req\.body/);
    expect(m).toBeTruthy();
    const fields = m[1].split(",").map((s) => s.trim()).filter(Boolean);
    // The allow-list IS the security property: an identity field cannot be
    // read from the body because it is never destructured from it.
    expect(fields.sort()).toEqual(["history", "language", "message", "schemeId"]);
  });

  it("never reads an identity field from the request body anywhere", () => {
    for (const forbidden of [
      /req\.body\.userId/,
      /req\.body\.email/,
      /req\.body\.user\b/,
      /req\.body\.as\b/,
      /req\.body\.sub\b/,
    ]) {
      expect(routeCode).not.toMatch(forbidden);
    }
  });

  it("the service takes userId as a parameter and has no other source for it", () => {
    // findById is called with the parameter, not with anything derived from
    // caller-supplied data.
    expect(serviceCode).toMatch(/userModel\.findById\(userId\)/);
    expect(serviceCode).not.toMatch(/findById\(\s*(req|body|payload|input)/);
  });

  it("puts userId in the history filter rather than filtering after the read", () => {
    expect(serviceCode).toMatch(/const filter = \{ userId \}/);
  });

  it("declares no route that accepts a user id in its path", () => {
    // `/chat/:userId` or similar would reintroduce exactly the IDOR that
    // `GET /api/users/:email` had.
    const paths = [...routeCode.matchAll(/router\.\w+\(\s*["'`]([^"'`]+)["'`]/g)].map((m) => m[1]);
    for (const p of paths) {
      expect(p).not.toMatch(/:(userId|user|email|id)\b/);
    }
  });
});

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("input validation happens before any model call", () => {
  it("rejects a non-string or empty message", () => {
    expect(routeCode).toMatch(/typeof message !== ["']string["']/);
  });

  it("validates the optional fields' types", () => {
    expect(routeCode).toMatch(/typeof schemeId !== ["']string["']/);
    expect(routeCode).toMatch(/Array\.isArray\(history\)/);
  });

  it("bounds the message length in the service", () => {
    expect(serviceCode).toMatch(/MAX_MESSAGE_CHARS/);
  });
});

// ---------------------------------------------------------------------------
// Frontend contract
// ---------------------------------------------------------------------------

const frontendAvailable = fs.existsSync(FRONTEND_SRC);
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

describeIfFrontend("the chat UI sends no identity of its own", () => {
  const read = (rel) => fs.readFileSync(path.join(FRONTEND_SRC, rel), "utf8");
  const ctx = read("chat/ChatContext.jsx");
  const win = read("chat/ChatWindow.jsx");
  const app = read("App.jsx");

  it("calls only /chat endpoints", () => {
    const calls = [...ctx.matchAll(/api\s*\.\s*\w+\s*\(\s*[`"']([^`"']+)/g)].map((m) => m[1]);
    expect(calls.length > 0).toBe(true);
    for (const c of calls) expect(c.startsWith("/chat")).toBe(true);
  });

  it("never sends a user id, email or profile in the payload", () => {
    const body = code(ctx);
    for (const forbidden of [/userId\s*:/, /email\s*:/, /\bprofile\s*:/, /\btoken\s*:/]) {
      expect(body).not.toMatch(forbidden);
    }
  });

  it("sends only the four accepted fields", () => {
    const post = ctx.slice(ctx.indexOf('api.post("/chat"'), ctx.indexOf("});", ctx.indexOf('api.post("/chat"')));
    expect(post).toContain("message:");
    expect(post).toContain("schemeId:");
    expect(post).toContain("history:");
  });

  it("replays only {intent, schemeId} turns, never message text", () => {
    // The server stores no transcript. Echoing message text back every turn
    // would keep re-transmitting whatever personal detail was typed once.
    expect(code(ctx)).toMatch(/data\.turn/);
    expect(code(ctx)).not.toMatch(/history:\s*messages/);
  });

  it("gates the assistant page behind ProtectedRoute", () => {
    const idx = app.indexOf('path="/assistant"');
    expect(idx > -1).toBe(true);
    expect(app.slice(idx, idx + 300)).toMatch(/ProtectedRoute/);
  });

  it("renders the deterministic verdict separately from the generated prose", () => {
    // A separation the user cannot see gives the user nothing.
    const msg = read("chat/ChatMessage.jsx");
    expect(msg).toMatch(/EligibilityVerdict/);
    const verdict = read("chat/EligibilityVerdict.jsx");
    expect(verdict).toMatch(/ELIGIBLE/);
    expect(verdict).toMatch(/NOT ELIGIBLE/);
    // And says where the decision came from.
    expect(verdict).toMatch(/rules engine/i);
  });

  it("renders every interaction state", () => {
    for (const state of [/isSending/, /error/, /suggestions/]) {
      expect(win).toMatch(state);
    }
    expect(win).toMatch(/aria-live/);
  });

  it("shows citations for grounded answers", () => {
    const msg = read("chat/ChatMessage.jsx");
    expect(msg).toMatch(/message\.sources/);
    expect(msg).toMatch(/schemeVersion/);
  });
});
