const logger = require("../utils/logger");

/**
 * A predictable, non-leaking error shape for the whole API.
 *
 * Two rules drive this:
 *  1. Never send a stack trace to a client. Stacks disclose absolute paths,
 *     dependency versions and internal structure.
 *  2. Never echo a message that might carry a secret. Driver errors in
 *     particular can contain the full connection URI including the password.
 */

class ApiError extends Error {
  constructor(status, message, code = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.expected = true; // deliberately thrown, safe to show the client
  }
}

const badRequest = (m, c) => new ApiError(400, m, c);
const unauthorized = (m = "Authentication required") => new ApiError(401, m, "UNAUTHENTICATED");
const forbidden = (m = "Not permitted") => new ApiError(403, m, "FORBIDDEN");
const notFound = (m = "Not found") => new ApiError(404, m, "NOT_FOUND");

/** Strip `//user:pass@` out of anything before it reaches a log or a client. */
function scrub(message) {
  return String(message || "").replace(/\/\/[^@\s]*@/g, "//<redacted>@");
}

// eslint-disable-next-line no-unused-vars -- Express identifies error
// middleware by arity; `next` must stay in the signature.
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const safeMessage = scrub(err.message);

  if (status >= 500) {
    // Full detail to the server log only.
    logger.error("Unhandled request error", {
      method: req.method,
      path: req.path,
      status,
      error: safeMessage,
      stack: err.stack,
    });
  } else {
    logger.warn("Request rejected", { method: req.method, path: req.path, status, error: safeMessage });
  }

  res.status(status).json({
    error: err.expected || status < 500 ? safeMessage : "Internal server error",
    ...(err.code ? { code: err.code } : {}),
  });
}

module.exports = { errorHandler, ApiError, badRequest, unauthorized, forbidden, notFound, scrub };
