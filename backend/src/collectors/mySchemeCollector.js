const axios = require("axios");
const logger = require("../utils/logger");

/**
 * myScheme's public frontend calls two separate REST endpoints under
 * api.myscheme.gov.in (found via DevTools -> Network -> Fetch/XHR on
 * myscheme.gov.in/search and myscheme.gov.in/schemes/<slug>):
 *
 *   1. SEARCH_URL  - paginated list of all schemes. Gives us slug, name,
 *      ministry, category, tags, deadline, state - enough to detect NEW
 *      schemes and to know which slugs to fetch details for.
 *   2. DETAIL_URL  - per-scheme detail, keyed by ?slug=X. Gives us the
 *      richer fields needed for diffing: eligibilityDescription_md,
 *      benefits_md, applicationProcess.
 *
 * Both require an `x-api-key` header. This key is NOT a privileged secret -
 * it's embedded in myScheme's own public frontend JS bundle, sent from every
 * visitor's browser - but it can change whenever myScheme redeploys their
 * frontend. If this collector starts failing with 401s, re-extract the key:
 *   DevTools -> Network -> any api.myscheme.gov.in request -> Headers -> x-api-key
 * and update MYSCHEME_API_KEY in .env.
 *
 * A THIRD endpoint, DOCUMENTS_URL, provides "documents required" - but it's
 * keyed by the scheme's internal Mongo _id (from the detail response), not
 * by slug: /schemes/v6/public/schemes/<id>/documents?lang=en. So this one
 * is fetched *after* the detail call, once we know the scheme's _id.
 *
 * RATE LIMITING: myScheme's API returns 429 if hit too hard. With ~4763
 * schemes x 2 follow-up calls each (~9500 requests), even modest concurrency
 * will eventually get throttled. requestWithRetry() below retries 429s with
 * exponential backoff (honoring a Retry-After header if myScheme sends one),
 * and DETAIL_CONCURRENCY is kept deliberately low with a small stagger delay
 * between batches so we mostly avoid tripping the limit in the first place.
 */

const SEARCH_URL = "https://api.myscheme.gov.in/search/v6/schemes";
const DETAIL_URL = "https://api.myscheme.gov.in/schemes/v6/public/schemes";
const DOCUMENTS_URL = (id) => `https://api.myscheme.gov.in/schemes/v6/public/schemes/${id}/documents`;
const PAGE_SIZE = 100;
const DETAIL_CONCURRENCY = 4; // lowered from 8 - myScheme's API throttles hard past this
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000;

function apiHeaders() {
  const apiKey = process.env.MYSCHEME_API_KEY;
  if (!apiKey) {
    throw new Error("MYSCHEME_API_KEY is not set in .env");
  }
  return {
    "x-api-key": apiKey,
    Origin: "https://www.myscheme.gov.in",
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json",
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps axios.get with retry-on-429 (and 5xx) using exponential backoff.
 * Honors a `Retry-After` header (seconds or HTTP-date) if myScheme sends one;
 * otherwise backs off as BASE_BACKOFF_MS * 2^attempt, plus a little jitter so
 * concurrent workers don't all retry in lockstep.
 *
 * Throws on non-retryable errors (4xx other than 429) or after MAX_RETRIES
 * is exhausted - callers already catch and log, so a single stubborn scheme
 * never aborts the whole run.
 */
async function requestWithRetry(url, config, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await axios.get(url, config);
    } catch (err) {
      const status = err.response?.status;
      const isRetryable = status === 429 || (status >= 500 && status < 600);

      if (!isRetryable || attempt === MAX_RETRIES) {
        throw err;
      }

      let waitMs;
      const retryAfter = err.response?.headers?.["retry-after"];
      if (retryAfter) {
        const asSeconds = Number(retryAfter);
        waitMs = !Number.isNaN(asSeconds) ? asSeconds * 1000 : Math.max(0, new Date(retryAfter).getTime() - Date.now());
      } else {
        waitMs = BASE_BACKOFF_MS * 2 ** attempt;
      }
      waitMs += Math.random() * 300; // jitter

      logger.warn(`${label} got ${status}, retrying in ${Math.round(waitMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(waitMs);
    }
  }
}

/**
 * Paginates the search endpoint until an empty page comes back.
 * Returns an array of { slug, listFields } - listFields is the raw
 * `fields` object from the search hit (name, ministry, category, etc).
 */
async function fetchAllSlugs() {
  const results = [];
  let from = 0;

  // Cap at 60 pages (6000 schemes) so a bug in the loop can't run forever;
  // myScheme currently reports ~4762 total.
  for (let page = 0; page < 60; page++) {
    let data;
    try {
      const res = await requestWithRetry(
        SEARCH_URL,
        {
          params: { lang: "en", q: "[]", keyword: "", sort: "", from, size: PAGE_SIZE },
          headers: apiHeaders(),
          timeout: REQUEST_TIMEOUT_MS,
        },
        `myScheme search (from=${from})`
      );
      data = res.data;
    } catch (err) {
      logger.warn(`myScheme search API failed at from=${from}`, { error: err.message });
      break;
    }

    const items = data?.data?.hits?.items || [];
    if (!items.length) break;

    for (const item of items) {
      if (item?.fields?.slug) {
        results.push({ slug: item.fields.slug, listFields: item.fields });
      }
    }

    from += PAGE_SIZE;
    const total = data?.data?.summary?.total ?? Infinity;
    if (from >= total) break;

    // Dev-only: MYSCHEME_LIMIT lets you cap the run (e.g. "10") for fast
    // local testing instead of waiting through all ~4762 schemes x 2 more
    // requests each. Leave unset in production.
    const limit = Number(process.env.MYSCHEME_LIMIT);
    if (limit > 0 && results.length >= limit) break;
  }

  const limit = Number(process.env.MYSCHEME_LIMIT);
  return limit > 0 ? results.slice(0, limit) : results;
}

/**
 * Fetches the detail payload for a single scheme by slug.
 * Returns { id, en } where `id` is the scheme's internal Mongo _id (needed
 * for the documents call) and `en` is the localized detail content.
 * Returns null on failure (never throws - a single bad scheme shouldn't
 * abort the whole collection run).
 */
async function fetchDetail(slug) {
  try {
    const res = await requestWithRetry(
      DETAIL_URL,
      {
        params: { slug, lang: "en" },
        headers: apiHeaders(),
        timeout: REQUEST_TIMEOUT_MS,
      },
      `myScheme detail (slug=${slug})`
    );
    const id = res.data?.data?._id;
    const en = res.data?.data?.en;
    if (!id || !en) return null;
    return { id, en };
  } catch (err) {
    logger.warn(`myScheme detail fetch failed for slug=${slug}`, { error: err.message });
    return null;
  }
}

/**
 * Fetches "documents required" for a scheme by its internal _id.
 * Returns the documentsRequired_md string, or "" on failure/missing data -
 * documents are a nice-to-have field, never worth failing the whole scheme over.
 */
async function fetchDocuments(id) {
  try {
    const res = await requestWithRetry(
      DOCUMENTS_URL(id),
      {
        params: { lang: "en" },
        headers: apiHeaders(),
        timeout: REQUEST_TIMEOUT_MS,
      },
      `myScheme documents (id=${id})`
    );
    return res.data?.data?.en?.documentsRequired_md || "";
  } catch (err) {
    logger.warn(`myScheme documents fetch failed for id=${id}`, { error: err.message });
    return "";
  }
}

/**
 * Runs async fn(item) over items with at most `limit` in flight at once.
 * Hand-rolled instead of pulling in p-limit as a dependency, since this is
 * the only place we need it. A small stagger delay is added per dispatched
 * item (not per retry - retries already back off on their own) to spread
 * load more evenly across the run instead of firing every worker's first
 * request in the same instant.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await fn(items[current], current);
      await sleep(50); // small stagger between an individual worker's items
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function extractPlainText(markdown) {
  // benefits_md / eligibilityDescription_md are markdown-ish strings with
  // leading/trailing newlines and "- " bullets. Good enough as plain text
  // for diffing/display without pulling in a markdown parser.
  if (!markdown || typeof markdown !== "string") return "";
  return markdown.replace(/^-\s*/gm, "").trim();
}

function extractListItems(markdown) {
  // documentsRequired_md uses "1. " for every list item (not incrementing
  // numbers) plus occasional bold section headers like "**For cases...**".
  // Split into one string per line, stripping list/markdown markers.
  if (!markdown || typeof markdown !== "string") return [];
  return markdown
    .split("\n")
    .map((line) => line.replace(/^\d+\.\s*/, "").replace(/\*\*/g, "").trim())
    .filter((line) => line && !/^<[^>]+>$/.test(line)); // drop stray HTML tags like a bare "<br>"
}

// Tags myScheme uses that correspond to profile facets. Anything not in
// these buckets stays in `tags` for fallback matching but doesn't populate
// a specific structured field.
const GENDER_TAGS = new Set(["Female", "Male", "Other"]);
const CATEGORY_TAGS = new Set([
  "SC", "ST", "OBC", "Minority", "BPL", "Woman", "Widow",
  "Person with Disability", "Senior Citizen", "Ex-Servicemen",
  "Migrant Worker", "Single Parent", "EWS", "Economically Weaker",
]);
const OCCUPATION_TAGS = new Set([
  "Student", "Farmer", "Entrepreneur", "Salaried Employee",
  "Self-Employed", "Unemployed", "Homemaker", "Retired",
  "Artisan / Weaver", "Fisherman", "Worker", "Employee",
]);

/**
 * Build the eligibilityRules subdocument from myScheme's structured API
 * fields. We do NOT call Gemini here — that happens in a separate pass
 * (see scripts/extractEligibility.js) so collection stays fast and cheap.
 * Fields we can't fill leave as null/[] and `source` stays "structured"
 * with a confidence that reflects how much we actually got.
 */
function buildStructuredRules(listFields, basic) {
  const states = (listFields.beneficiaryState || [])
    .map((s) => (s === "All" ? null : s))
    .filter(Boolean);

  const rawTags = Array.isArray(listFields.tags) ? listFields.tags : [];
  const genders = [];
  const categories = [];
  const occupations = [];
  for (const t of rawTags) {
    if (typeof t !== "string") continue;
    if (GENDER_TAGS.has(t)) genders.push(t);
    else if (CATEGORY_TAGS.has(t)) categories.push(t);
    else if (OCCUPATION_TAGS.has(t)) occupations.push(t);
  }

  // myScheme's `basicDetails` sometimes carries structured age/income under
  // eligibilityCriteria — we surface what's there but tolerate absence.
  const minAge = Number.isFinite(basic?.minAge) ? basic.minAge : null;
  const maxAge = Number.isFinite(basic?.maxAge) ? basic.maxAge : null;
  const maxAnnualIncome = Number.isFinite(basic?.maxAnnualIncome) ? basic.maxAnnualIncome : null;

  // If we got literally no structured targeting from myScheme (no states,
  // no gender/category/occupation from tags, no age/income), mark this
  // "unparsed" so it falls to the legacy tag-overlap matcher instead of
  // the rules engine — otherwise a scheme with zero constraints would
  // match every user (the "650 matches" bug). The LLM extractor is what
  // eventually promotes these back to "llm-extracted" with real rules.
  const gotAnyTargeting =
    states.length > 0 ||
    genders.length + categories.length + occupations.length > 0 ||
    minAge !== null ||
    maxAge !== null ||
    maxAnnualIncome !== null;

  if (!gotAnyTargeting) {
    // Nothing from structured tags — leave classification to the hybrid
    // extractor in the pipeline (it'll read the free-text eligibility
    // blob). Mark eligibilityType="unknown" defensively so we never
    // accidentally match everyone in the interim.
    return {
      minAge: null, maxAge: null,
      maxAnnualIncome: null, minAnnualIncome: null,
      minMarksPercentage: null, minEducationLevel: null,
      genders: [], categories: [], occupations: [], states: [],
      source: "unparsed",
      eligibilityType: "unknown",
      confidence: 0,
      needsReview: true,
      extractedAt: new Date(),
    };
  }

  // Confidence heuristic: 0.3 baseline for "we tried", +0.2 if we got states,
  // +0.2 if we got at least one gender/category/occupation from tags. Capped at 0.9.
  let confidence = 0.3;
  if (states.length > 0) confidence += 0.2;
  if (genders.length + categories.length + occupations.length > 0) confidence += 0.2;
  if (minAge !== null || maxAge !== null || maxAnnualIncome !== null) confidence += 0.2;
  confidence = Math.min(confidence, 0.9);

  return {
    minAge,
    maxAge,
    maxAnnualIncome,
    minAnnualIncome: null,
    minMarksPercentage: null,
    minEducationLevel: null,
    genders,
    categories,
    occupations,
    states,
    source: "structured",
    // Has at least one signal → constrained. The hybrid extractor may
    // upgrade this later (e.g. if the free text says "open to all
    // residents of X", the states signal keeps it constrained).
    eligibilityType: "constrained",
    confidence,
    needsReview: confidence < 0.5,
    extractedAt: new Date(),
  };
}

function mapToRaw(slug, listFields, detail, documentsMd) {
  try {
    const basic = detail?.basicDetails || {};
    const content = detail?.schemeContent || {};
    const eligibility = detail?.eligibilityCriteria || {};
    const applicationProcess = Array.isArray(detail?.applicationProcess)
      ? detail.applicationProcess
      : [];

    const rawLink =
      applicationProcess.find((p) => p?.url)?.url ||
      `https://www.myscheme.gov.in/schemes/${slug}`;
    const applicationLink = /^https?:\/\//i.test(rawLink) ? rawLink : `https://${rawLink}`;

    return {
      schemeId: `myscheme-${slug}`,
      name: basic.schemeName || listFields.schemeName || "",
      description: content.briefDescription || listFields.briefDescription || "",
      eligibility: extractPlainText(eligibility.eligibilityDescription_md),
      eligibilityRules: buildStructuredRules(listFields, basic),
      benefits: extractPlainText(content.benefits_md),
      documents: extractListItems(documentsMd),
      lastDate: basic.schemeCloseDate || listFields.schemeCloseDate || "",
      applicationLink,
      ministry: basic.nodalMinistryName?.label || listFields.nodalMinistryName || "",
      // Kept for display only. Matching uses eligibilityRules.states.
      state: (listFields.beneficiaryState || ["All India"])
        .map((s) => (s === "All" ? "All India" : s))
        .join(", "),
      category: (basic.schemeCategory || listFields.schemeCategory || []).map((c) =>
        typeof c === "string" ? c : c.label
      ),
      tags: listFields.tags || [],
      status: basic.schemeCloseDate && new Date(basic.schemeCloseDate) < new Date() ? "Closed" : "Active",
      sourceUrl: `https://www.myscheme.gov.in/schemes/${slug}`,
    };
  } catch (err) {
    logger.warn(`Skipping malformed myScheme item for slug=${slug}`, { error: err.message });
    return null;
  }
}

module.exports = {
  name: "myScheme",
  async collect() {
    const slugEntries = await fetchAllSlugs();
    logger.info(`myScheme: discovered ${slugEntries.length} schemes, fetching details...`);

    const rawItems = await mapWithConcurrency(slugEntries, DETAIL_CONCURRENCY, async ({ slug, listFields }) => {
      const detail = await fetchDetail(slug);
      if (!detail) return null;
      const documentsMd = await fetchDocuments(detail.id);
      return mapToRaw(slug, listFields, detail.en, documentsMd);
    });

    return rawItems.filter(Boolean);
  },
};