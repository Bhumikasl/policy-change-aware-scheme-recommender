const winston = require("winston");
const fs = require("fs");
const path = require("path");

/**
 * Application logger.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS TEST-AWARE
 * ---------------------------------------------------------------------------
 * The suite exercises failure paths on purpose — retry sweeps that fail, guards
 * that reject a hallucination, propagation errors that must stay non-fatal.
 * Each one logs, correctly. Under Jest that produced thousands of console lines,
 * every one carrying its own stack frame, and the result that actually matters
 * — which suites passed and which assertions failed — became impossible to find
 * in the noise.
 *
 * Two things change under test, and NEITHER touches an assertion:
 *
 *   1. the Console transport is silenced;
 *   2. the File transports are omitted, so a test run neither creates `logs/`
 *      nor leaves open file handles behind. (Open handles are also why Jest
 *      warns that it "did not exit one second after the test run completed".)
 *
 * No test in this project asserts on, spies on, or mocks this module, so
 * silencing it cannot change a single result. `logger.info(...)` still succeeds
 * — winston's `silent` suppresses the OUTPUT, not the call.
 *
 * To see logs while debugging one test, set TEST_LOGS=1:
 *     PowerShell:  $env:TEST_LOGS=1; npx jest tests/notificationAgent.test.js
 *     bash:        TEST_LOGS=1 npx jest tests/notificationAgent.test.js
 */

// Jest sets NODE_ENV=test automatically unless it is already set.
const isTest = process.env.NODE_ENV === "test";
const wantTestLogs = process.env.TEST_LOGS === "1" || process.env.TEST_LOGS === "true";
const quiet = isTest && !wantTestLogs;

const transports = [new winston.transports.Console({ silent: quiet })];

// File transports only outside tests. Directory creation is deferred with them,
// so a test run leaves nothing on disk.
if (!isTest) {
  const logsDir = path.join(__dirname, "..", "..", "logs");
  if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
  transports.push(
    new winston.transports.File({ filename: path.join(logsDir, "error.log"), level: "error" }),
    new winston.transports.File({ filename: path.join(logsDir, "combined.log") })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
      return `[${timestamp}] ${level.toUpperCase()}: ${message}${metaStr}`;
    })
  ),
  transports,
});

module.exports = logger;
