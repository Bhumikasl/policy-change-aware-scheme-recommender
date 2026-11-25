const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const schemesRouter = require("./routes/schemes");
const usersRouter = require("./routes/users");
const authRouter = require("./routes/auth");
const chatRouter = require("./routes/chat");
// ADDITIVE: newly-eligible / eligibility-updated feature (Phase EU)
const eligibilityUpdatesRouter = require("./routes/eligibilityUpdates");
const { errorHandler, notFound } = require("./middleware/errorHandler");

const app = express();

// Behind a proxy (Render/Railway/nginx) so express-rate-limit sees the real
// client IP instead of rate-limiting the proxy as one caller.
app.set("trust proxy", 1);

// Secure headers: CSP, HSTS, X-Content-Type-Options, frameguard, and removal
// of X-Powered-By (which otherwise advertises Express to a scanner).
app.use(helmet());

/**
 * CORS allowlist.
 *
 * The previous `app.use(cors())` accepted every origin, so any site a
 * logged-in user visited could call this API from their browser.
 * FRONTEND_ORIGIN takes a comma-separated list. Requests with no Origin
 * header (curl, server-to-server, health checks) are still allowed.
 */
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      // In local development accept localhost/127.0.0.1 origins on any port
      if (process.env.NODE_ENV !== "production") {
        const devLocalRe = /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/;
        if (devLocalRe.test(origin)) return cb(null, true);
      }
      return cb(new Error("Origin not allowed by CORS"));
    },
    credentials: true,
  })
);

// Cap request bodies — without a limit one large POST can pin the process.
app.use(express.json({ limit: "100kb" }));

// Baseline limit for the whole API. Tighter limits sit on the sensitive
// routers (auth 10/15min, collection 2/hour).
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.RATE_LIMIT_MAX) || 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please slow down" },
  })
);

app.get("/health", (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

app.use("/api", authRouter);
app.use("/api", schemesRouter);
app.use("/api", usersRouter);
app.use("/api", chatRouter);
// ADDITIVE: newly-eligible / eligibility-updated feature (Phase EU)
app.use("/api", eligibilityUpdatesRouter);

// 404 for anything unmatched, then the single error formatter.
// Both must come after all routes.
app.use((req, res, next) => next(notFound(`No route for ${req.method} ${req.path}`)));
app.use(errorHandler);

module.exports = app;
