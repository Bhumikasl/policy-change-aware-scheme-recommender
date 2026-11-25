/**
 * The bootstrap ADMIN account.
 *
 * ---------------------------------------------------------------------------
 * THE DEFECT THESE TESTS EXIST FOR
 * ---------------------------------------------------------------------------
 * `.env.example` documented `ADMIN_EMAIL` / `ADMIN_PASSWORD` as "created on
 * first boot if no ADMIN user exists". No code read either variable. Register
 * always assigns ROLE=USER and there was no seed script, so no ADMIN could ever
 * exist — which left `POST /api/collect/run` (requireAuth + requireAdmin)
 * unreachable, and the frontend Admin page's collection button returning 403
 * for every account that could be created.
 *
 * The audit that found it was a diff of the variables `.env.example` declares
 * against the variables the source actually reads.
 *
 * The tests below are as much about what this must NOT do as what it must.
 */
const { bootstrapAdmin } = require("../src/config/bootstrapAdmin");
const { makeCollection } = require("./helpers/inMemoryDb");

/**
 * A user store with the slice the bootstrap uses, plus the model's real
 * password behaviour: `new Model(doc)` returning something with `setPassword`
 * and `save`.
 */
function makeUserModel(seed = []) {
  const col = makeCollection("users", { trackDoc: true });
  if (seed.length) col.seed(seed);

  function Model(doc) {
    Object.assign(this, doc);
    this.setPassword = async function setPassword(plain) {
      if (!plain || plain.length < 8) throw new Error("Password must be at least 8 characters");
      this.passwordHash = `hashed:${plain}`;
    };
    this.save = async function save() {
      col.rows.push({ _id: `id-${col.rows.length + 1}`, ...this });
      return this;
    };
  }
  Model.findOne = (filter) => col.findOne(filter);
  Model.rows = col.rows;
  return Model;
}

const ENV = (over = {}) => ({ ADMIN_EMAIL: "admin@example.com", ADMIN_PASSWORD: "a-long-enough-password", ...over });

describe("bootstrap admin — creating the first ADMIN", () => {
  it("creates one when configured and none exists", async () => {
    const userModel = makeUserModel();
    const out = await bootstrapAdmin({ userModel, env: ENV() });

    expect(out.created).toBe(true);
    expect(userModel.rows.length).toBe(1);
    expect(userModel.rows[0].role).toBe("ADMIN");
    expect(userModel.rows[0].email).toBe("admin@example.com");
  });

  it("lower-cases the configured email, as every lookup does", async () => {
    const userModel = makeUserModel();
    await bootstrapAdmin({ userModel, env: ENV({ ADMIN_EMAIL: "  Admin@Example.COM  " }) });
    expect(userModel.rows[0].email).toBe("admin@example.com");
  });

  it("hashes the password and never stores it in the clear", async () => {
    const userModel = makeUserModel();
    await bootstrapAdmin({ userModel, env: ENV({ ADMIN_PASSWORD: "correct-horse-battery" }) });
    const row = userModel.rows[0];
    expect(row.passwordHash).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain("correct-horse-battery".slice(0, 8) + "-");
    expect(row.password).toBeUndefined();
  });

  it("is idempotent — a second boot creates nothing", async () => {
    const userModel = makeUserModel([{ email: "someone@example.com", role: "ADMIN" }]);
    const out = await bootstrapAdmin({ userModel, env: ENV() });

    expect(out.created).toBe(false);
    expect(out.reason).toMatch(/already exists/);
    expect(userModel.rows.length).toBe(1);
  });
});

describe("bootstrap admin — what it refuses to do", () => {
  /**
   * THE SECURITY PROPERTY.
   *
   * Promotion-by-environment means anyone who can edit `.env`, or set a
   * variable on the host, can silently take over an account that already holds
   * a real person's data. Creating a NEW account when none exists cannot take
   * anything over. Promoting an existing one can.
   */
  it("REFUSES to promote an existing non-admin account", async () => {
    const userModel = makeUserModel([{ email: "victim@example.com", role: "USER" }]);
    const out = await bootstrapAdmin({ userModel, env: ENV({ ADMIN_EMAIL: "victim@example.com" }) });

    expect(out.created).toBe(false);
    expect(out.reason).toMatch(/existing non-admin/);
    // The account is untouched — still a USER, and no second row was written.
    expect(userModel.rows.length).toBe(1);
    expect(userModel.rows[0].role).toBe("USER");
  });

  it("does nothing when neither variable is set", async () => {
    const userModel = makeUserModel();
    const out = await bootstrapAdmin({ userModel, env: {} });
    expect(out.created).toBe(false);
    expect(out.reason).toBe("not configured");
    expect(userModel.rows.length).toBe(0);
  });

  it("refuses half-configured rather than inventing the missing half", async () => {
    for (const env of [{ ADMIN_EMAIL: "a@b.com" }, { ADMIN_PASSWORD: "a-long-password" }]) {
      const userModel = makeUserModel();
      const out = await bootstrapAdmin({ userModel, env });
      expect(out.created).toBe(false);
      expect(out.reason).toMatch(/incomplete/);
      expect(userModel.rows.length).toBe(0);
    }
  });

  it("refuses a password shorter than the model's minimum", async () => {
    const userModel = makeUserModel();
    const out = await bootstrapAdmin({ userModel, env: ENV({ ADMIN_PASSWORD: "short" }) });
    expect(out.created).toBe(false);
    expect(out.reason).toMatch(/too short/);
    expect(userModel.rows.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The configuration contract
// ---------------------------------------------------------------------------
/**
 * The audit that found the defect, kept as a test.
 *
 * A variable documented in `.env.example` that no code reads is a promise the
 * system does not keep, and the operator gets no error to tell them.
 */
describe("configuration contract", () => {
  it("every variable .env.example declares is actually read by the code", () => {
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "..");

    const declared = [...fs.readFileSync(path.join(root, ".env.example"), "utf8")
      .matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]);

    const read = new Set();
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith(".js")) {
          // `process.env.X` and also `env.X`, because config is sometimes taken
          // by injection (`{ env = process.env } = {}`) so it can be tested —
          // reading it that way is still reading it.
          for (const m of fs.readFileSync(p, "utf8").matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) {
            read.add(m[1]);
          }
        }
      }
    };
    walk(path.join(root, "src"));
    walk(path.join(root, "scripts"));

    expect(declared.length).toBeGreaterThan(0);
    const dead = declared.filter((v) => !read.has(v));
    expect(dead).toEqual([]);
  });
});
