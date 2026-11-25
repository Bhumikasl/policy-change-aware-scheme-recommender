require("dotenv").config();
const app = require("./app");
const connectDB = require("./config/db");
const { startScheduler } = require("./scheduler/cron");
const { bootstrapAdmin } = require("./config/bootstrapAdmin");
const logger = require("./utils/logger");

async function main() {
  await connectDB();

  // After the database, before the port opens: an admin created here is ready
  // by the time the first request can arrive. Non-fatal — failing to create the
  // bootstrap account is a reason to log and keep serving, not to refuse to
  // start, since every other route works without it.
  try {
    await bootstrapAdmin();
  } catch (err) {
    logger.error("Bootstrap admin failed; continuing without it", { error: err.message });
  }

  startScheduler();

  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    logger.info(`Server listening on http://localhost:${port}`);
  });
}

main().catch((err) => {
  logger.error("Fatal startup error", { error: err.message });
  process.exit(1);
});
