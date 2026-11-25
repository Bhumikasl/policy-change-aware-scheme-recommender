/**
 * Notifier tests — mock the DB models and mailer so we can verify the
 * dedup logic, "unknown scheme is not notified", and email-failure
 * resilience without a real Mongo or SMTP server.
 */
jest.mock("../src/models/User", () => ({ find: jest.fn() }));
jest.mock("../src/models/NotificationLog", () => ({ create: jest.fn() }));
jest.mock("../src/services/mailer", () => ({ sendSchemeEmail: jest.fn() }));

const User = require("../src/models/User");
const NotificationLog = require("../src/models/NotificationLog");
const { sendSchemeEmail } = require("../src/services/mailer");
const { notifyMatchingUsers } = require("../src/services/notifier");

const scheme = (overrides = {}) => ({
  schemeId: "s1",
  name: "Test",
  documents: [],
  eligibilityRules: {
    minAge: 18, maxAge: 40, genders: ["Female"],
    categories: [], occupations: [], states: [],
    minAnnualIncome: null, maxAnnualIncome: null,
    minMarksPercentage: null, minEducationLevel: null,
    source: "structured", eligibilityType: "constrained",
    confidence: 0.7, needsReview: false,
  },
  ...overrides,
});

beforeEach(() => {
  User.find.mockReset();
  NotificationLog.create.mockReset();
  sendSchemeEmail.mockReset();
});

test("new scheme → notifies eligible users, skips ineligible", async () => {
  User.find.mockResolvedValueOnce([
    { email: "a@example.com", profile: { age: 25, gender: "Female" } }, // match
    { email: "b@example.com", profile: { age: 55, gender: "Female" } }, // fail age
    { email: "c@example.com", profile: { age: 25, gender: "Male" } },   // fail gender
  ]);
  NotificationLog.create.mockResolvedValue({});
  sendSchemeEmail.mockResolvedValue();

  const sent = await notifyMatchingUsers(scheme(), "summary", "NEW", 1);
  expect(sent).toBe(1);
  expect(sendSchemeEmail).toHaveBeenCalledTimes(1);
  expect(sendSchemeEmail.mock.calls[0][0].email).toBe("a@example.com");
});

test("dedup: 11000 dup key skips silently, other users still notified", async () => {
  User.find.mockResolvedValueOnce([
    { email: "a@example.com", profile: { age: 25, gender: "Female" } },
    { email: "b@example.com", profile: { age: 25, gender: "Female" } },
  ]);
  NotificationLog.create
    .mockRejectedValueOnce({ code: 11000 })
    .mockResolvedValueOnce({});
  sendSchemeEmail.mockResolvedValue();

  const sent = await notifyMatchingUsers(scheme(), "s", "UPDATED", 2);
  expect(sent).toBe(1);
  expect(sendSchemeEmail).toHaveBeenCalledTimes(1);
});

test("unknown scheme → no notifications", async () => {
  const s = scheme();
  s.eligibilityRules.eligibilityType = "unknown";
  const sent = await notifyMatchingUsers(s, "s", "NEW", 1);
  expect(sent).toBe(0);
  expect(User.find).not.toHaveBeenCalled();
  expect(sendSchemeEmail).not.toHaveBeenCalled();
});

test("universal scheme → notifies all users", async () => {
  const s = scheme({
    eligibilityRules: {
      minAge: null, maxAge: null, genders: [], categories: [], occupations: [], states: [],
      minAnnualIncome: null, maxAnnualIncome: null,
      minMarksPercentage: null, minEducationLevel: null,
      source: "deterministic", eligibilityType: "universal", confidence: 0.6, needsReview: false,
    },
  });
  User.find.mockResolvedValueOnce([
    { email: "a@example.com", profile: {} },
    { email: "b@example.com", profile: { age: 5 } },
  ]);
  NotificationLog.create.mockResolvedValue({});
  sendSchemeEmail.mockResolvedValue();

  const sent = await notifyMatchingUsers(s, "s", "NEW", 1);
  expect(sent).toBe(2);
});

test("email failure does NOT abort the pipeline for remaining users", async () => {
  User.find.mockResolvedValueOnce([
    { email: "a@example.com", profile: { age: 25, gender: "Female" } },
    { email: "b@example.com", profile: { age: 25, gender: "Female" } },
  ]);
  NotificationLog.create.mockResolvedValue({});
  sendSchemeEmail
    .mockRejectedValueOnce(new Error("smtp down"))
    .mockResolvedValueOnce();

  const sent = await notifyMatchingUsers(scheme(), "s", "NEW", 1);
  // Both users are counted as "sent" (log inserted) — a mail-server hiccup
  // must not desync the log from reality; second user still emailed.
  expect(sent).toBe(2);
  expect(sendSchemeEmail).toHaveBeenCalledTimes(2);
});
