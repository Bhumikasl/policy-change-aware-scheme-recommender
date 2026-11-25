const { safeCollect } = require("./baseCollector");
const mySchemeCollector = require("./mySchemeCollector");

/**
 * Add new collectors here (e.g. a ministry-specific one) and they
 * automatically get picked up by the scheduler — nothing else to wire up.
 *
 * PIB was intentionally removed: a press release is a policy signal, not
 * a scheme record with structured fields, so treating it as a Scheme
 * produced a lot of noisy, half-formed entries. If we want it back later
 * it should be modelled as a separate PolicyEvent, not shoehorned in here.
 */
const ALL_COLLECTORS = [mySchemeCollector];

/**
 * Runs every registered collector and returns a flat list of
 * { raw, source } pairs ready for the normalizer.
 */
async function collectAll() {
  const results = [];
  for (const collector of ALL_COLLECTORS) {
    const items = await safeCollect(collector);
    for (const raw of items) {
      results.push({ raw, source: collector.name });
    }
  }
  return results;
}

module.exports = { collectAll, ALL_COLLECTORS };
