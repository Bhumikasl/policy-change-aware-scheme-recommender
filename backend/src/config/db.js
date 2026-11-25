const mongoose = require("mongoose");
const logger = require("../utils/logger");

/**
 * Render a connection string safe for logs: protocol + host + database only.
 *
 * A MongoDB URI embeds the password in the userinfo section
 * (mongodb+srv://user:PASSWORD@host/db). Logging it raw leaks the database
 * password into stdout, into logs/ on disk, and into any terminal output the
 * developer pastes into a chat or an issue tracker. That is exactly how the
 * Atlas password for this project ended up in plain text repeatedly.
 */
function redactUri(uri) {
  try {
    const u = new URL(uri);
    const db = u.pathname && u.pathname !== "/" ? u.pathname : "";
    return `${u.protocol}//${u.hostname}${db}`;
  } catch {
    return "(unparseable MONGODB_URI)";
  }
}

/** Strip any `//user:pass@` that a driver error message may echo back. */
function redactError(message) {
  return String(message || "").replace(/\/\/[^@\s]*@/g, "//<redacted>@");
}

async function connectDB() {
  const uri = process.env.MONGODB_URI || "mongodb://localhost:27017/scheme_monitor";
  try {
    await mongoose.connect(uri);
    logger.info(`MongoDB connected -> ${redactUri(uri)}`);
  } catch (err) {
    logger.error("MongoDB connection failed", { error: redactError(err.message) });
    process.exit(1);
  }
}

module.exports = connectDB;
module.exports.redactUri = redactUri;
module.exports.redactError = redactError;
