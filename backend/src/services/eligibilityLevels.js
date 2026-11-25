/**
 * Ranked education levels. Higher rank means "more education" — a scheme
 * requiring minEducationLevel="Graduate" is satisfied by a user whose
 * education is Graduate, Post Graduate, or Doctorate but not by Undergraduate, Diploma, or 12th.
 *
 * Distinguishes between:
 * - "Undergraduate" (pursuing bachelor degree / B.Tech / UG college student)
 * - "Graduate" (completed bachelor degree / passed graduation / graduate engineer)
 */
const EDUCATION_LEVELS = [
  "Below 10th",
  "10th Standard",
  "12th Standard",
  "Diploma",
  "Undergraduate",
  "Graduate",
  "Post Graduate",
  "Doctorate",
];

const EDUCATION_RANK = Object.fromEntries(
  EDUCATION_LEVELS.map((level, idx) => [level, idx])
);

const EDUCATION_ALIASES = {
  "below 10th": "Below 10th",
  "below 10": "Below 10th",
  "primary": "Below 10th",
  "middle school": "Below 10th",
  "10th": "10th Standard",
  "10th standard": "10th Standard",
  "10th pass": "10th Standard",
  "matric": "10th Standard",
  "matriculation": "10th Standard",
  "ssc": "10th Standard",
  "12th": "12th Standard",
  "12th standard": "12th Standard",
  "12th pass": "12th Standard",
  "intermediate": "12th Standard",
  "higher secondary": "12th Standard",
  "hsc": "12th Standard",
  "diploma": "Diploma",
  "polytechnic": "Diploma",
  "undergraduate": "Undergraduate",
  "under graduate": "Undergraduate",
  "ug": "Undergraduate",
  "b.tech": "Undergraduate",
  "btech": "Undergraduate",
  "be": "Undergraduate",
  "b.sc": "Undergraduate",
  "bsc": "Undergraduate",
  "b.com": "Undergraduate",
  "bcom": "Undergraduate",
  "bba": "Undergraduate",
  "bca": "Undergraduate",
  "graduate": "Graduate",
  "graduation": "Graduate",
  "degree": "Graduate",
  "bachelors": "Graduate",
  "bachelor": "Graduate",
  "post graduate": "Post Graduate",
  "postgraduate": "Post Graduate",
  "pg": "Post Graduate",
  "masters": "Post Graduate",
  "master": "Post Graduate",
  "m.tech": "Post Graduate",
  "mtech": "Post Graduate",
  "m.sc": "Post Graduate",
  "msc": "Post Graduate",
  "mba": "Post Graduate",
  "doctorate": "Doctorate",
  "phd": "Doctorate",
  "ph.d": "Doctorate",
  "post doc": "Doctorate",
  "post doctoral": "Doctorate",
};

function canonicalizeEducationLevel(val) {
  if (!val) return null;
  const s = String(val).trim();
  if (EDUCATION_RANK[s] !== undefined) return s;
  const lower = s.toLowerCase();
  return EDUCATION_ALIASES[lower] || null;
}

/**
 * Returns true if `userLevel` meets or exceeds `requiredLevel`.
 * Unknown strings are treated conservatively as "does not meet" — a rule
 * we can't map is not a rule we can safely say the user satisfies.
 */
function meetsEducation(userLevel, requiredLevel) {
  if (!requiredLevel) return true;
  if (!userLevel) return false;
  const uKey = canonicalizeEducationLevel(userLevel);
  const rKey = canonicalizeEducationLevel(requiredLevel);
  if (!uKey || !rKey) return false;
  const u = EDUCATION_RANK[uKey];
  const r = EDUCATION_RANK[rKey];
  if (u === undefined || r === undefined) return false;
  return u >= r;
}

/**
 * Returns true if `userLevel` is at or below `maxLevel` — the mirror of
 * meetsEducation, for schemes that stop applying once a person has
 * "too much" education (e.g. a pre-matric scholarship, or a scheme for
 * students who have not yet completed graduation).
 */
function withinMaxEducation(userLevel, maxLevel) {
  if (!maxLevel) return true;
  if (!userLevel) return false;
  const uKey = canonicalizeEducationLevel(userLevel);
  const mKey = canonicalizeEducationLevel(maxLevel);
  if (!uKey || !mKey) return false;
  const u = EDUCATION_RANK[uKey];
  const m = EDUCATION_RANK[mKey];
  if (u === undefined || m === undefined) return false;
  return u <= m;
}

module.exports = {
  EDUCATION_LEVELS,
  EDUCATION_RANK,
  canonicalizeEducationLevel,
  meetsEducation,
  withinMaxEducation,
};
