const logger = require("../utils/logger");

/**
 * Every collector must export an object with:
 *   - name: string identifying the source (used as `source` in normalizer)
 *   - collect(): async () => Array<RawScheme>
 *
 * RawScheme is a loose object — it does NOT need to match models/Scheme.js.
 * The normalizer is responsible for turning it into the strict shape.
 * Minimal required raw fields: { schemeId, name }.
 *
 * Wrapping every collector's run in this helper means one broken site
 * (changed HTML, timeout, block) never crashes the whole collection cycle —
 * it just logs and returns an empty array for that source.
 */
async function safeCollect(collector) {
  try {
    const results = await collector.collect();
    logger.info(`Collector [${collector.name}] returned ${results.length} schemes`);
    return results;
  } catch (err) {
    logger.error(`Collector [${collector.name}] failed`, { error: err.message });
    return [];
  }
}

module.exports = { safeCollect };
