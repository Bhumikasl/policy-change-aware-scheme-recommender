require("dotenv").config();
const connectDB = require("../config/db");
const { runCollectionCycle } = require("../services/pipeline");
const logger = require("../utils/logger");

(async () => {
  await connectDB();
  const summary = await runCollectionCycle();
  logger.info("Done", summary);
  process.exit(0);
})();
