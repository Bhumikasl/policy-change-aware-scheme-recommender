/**
 * Deep diagnostic: for the exact test profile, show every matched scheme
 * and WHY each one passed — exposing false positives.
 */
require('dotenv').config({ path: './.env' });
const mongoose = require('mongoose');
const { evaluateEligibility } = require('./src/services/matcher');
const { buildCandidates } = require('./src/services/recommendationPropagation');
const { rankCandidates } = require('./src/services/relevanceRanker');
const Scheme = require('./src/models/Scheme');

const TEST_USER = {
  _id: new mongoose.Types.ObjectId(),
  email: 'test@profile.com',
  profile: {
    age: 20,
    gender: 'Female',
    state: 'Karnataka',
    annualIncome: 20000,
    categories: ['OBC', 'Woman'],
    occupation: 'Student',
    education: 'Graduate',           // UG = pursuing Graduate
    course: 'Engineering',           // B.Tech
    marksPercentage: null,
    disability: null,
    disabilityPercentage: null,
    singleGirlChild: null,
    documentsAvailable: []
  }
};

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const allSchemes = await Scheme.find({}).lean();
  const active = allSchemes.filter(s => String(s.status ?? '').toLowerCase() !== 'closed');

  const candidates = buildCandidates(TEST_USER, active, { allowUnknown: false });
  const ranked = rankCandidates(candidates, TEST_USER);

  console.log(`\nTotal eligible: ${candidates.length}\nTop 30 matches:\n`);

  const suspectKeywords = [
    'phd', 'doctorate', 'post.doc', 'post.graduate', 'postgraduate', 'pg ',
    'faculty', 'scientist', 'researcher', 'construction worker', 'farmer', 'kisan',
    'fisherman', 'weaver', 'artisan', 'ngo', 'voluntary org', 'shg', 'self.help group',
    'maharashtra', 'minority', 'dnT', 'nomadic', 'head of household',
    'class 11', 'class 12', '11th', '12th standard', 'post matric'
  ];

  ranked.slice(0, 30).forEach((c, i) => {
    const v = c.verdict;
    const rules = c.scheme.eligibilityRules || {};
    const name = c.scheme.name.slice(0, 60);

    // Check for suspicious matches
    const nameL = c.scheme.name.toLowerCase();
    const descL = (c.scheme.description || '').toLowerCase().slice(0, 500);
    const isSuspect = suspectKeywords.some(k => nameL.includes(k.replace('.', '\\s?')) || descL.includes(k.replace('.', '\\s?')));

    const positiveRules = v.positiveMatches.map(m => m.rule).join(', ');
    const rulesInfo = [
      rules.minEducationLevel && `minEdu:${rules.minEducationLevel}`,
      rules.maxEducationLevel && `maxEdu:${rules.maxEducationLevel}`,
      (rules.occupations||[]).length && `occs:[${rules.occupations.join('|')}]`,
      (rules.categories||[]).length && `cats:[${rules.categories.join('|')}]`,
      (rules.states||[]).length && `states:[${rules.states.join('|')}]`,
      rules.disabilityRequired && `disability:required`,
      rules.singleGirlChildRequired && `singleGirl:required`,
    ].filter(Boolean).join(' | ');

    const flag = isSuspect ? ' ⚠️  SUSPECT' : '';
    console.log(`${i+1}. [rel:${c.relevance}]${flag}`);
    console.log(`   "${name}"`);
    console.log(`   Matched on: ${positiveRules}`);
    console.log(`   SchemeRules: ${rulesInfo || '(no restrictions)'}`);
    console.log();
  });

  // Now show ONLY the suspect ones with full rules
  console.log('\n=== SUSPECT SCHEMES (detailed) ===');
  ranked.slice(0, 50).forEach((c, i) => {
    const nameL = c.scheme.name.toLowerCase();
    const descL = (c.scheme.description || '').toLowerCase().slice(0, 500);
    const isSuspect = suspectKeywords.some(k => nameL.includes(k.replace('.', '\\s?')));
    if (!isSuspect) return;

    const rules = c.scheme.eligibilityRules || {};
    console.log(`\n"${c.scheme.name}"`);
    console.log('  eligibilityRules:', JSON.stringify({
      eligibilityType: rules.eligibilityType,
      minEducationLevel: rules.minEducationLevel,
      maxEducationLevel: rules.maxEducationLevel,
      occupations: rules.occupations,
      categories: rules.categories,
      categoryGroups: rules.categoryGroups,
      states: rules.states,
      minAge: rules.minAge, maxAge: rules.maxAge,
    }, null, 2).split('\n').join('\n  '));
    console.log('  Positive:', c.verdict.positiveMatches.map(m => `${m.rule}: ${m.reason}`).join(' | '));
    console.log('  noConstraint:', c.verdict.noConstraint.map(m => m.rule).join(', '));
  });

  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
