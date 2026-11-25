/**
 * Quick diagnostic: shows scheme counts + why a user gets 0 matches.
 * Usage: node src/run_diagnostic.js [email]
 * If no email given, shows the first user in the DB.
 */
require('dotenv').config({ path: './.env' });
const mongoose = require('mongoose');
const { buildCandidates } = require('./services/recommendationPropagation');
const { rankCandidates } = require('./services/relevanceRanker');
const { evaluateEligibility } = require('./services/matcher');
const Scheme = require('./models/Scheme');
const User = require('./models/User');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  const email = process.argv[2];
  const user = email
    ? await User.findOne({ email: email.toLowerCase() })
    : await User.findOne({});

  if (!user) {
    console.error('No user found. Pass an email: node src/run_diagnostic.js user@example.com');
    process.exit(1);
  }

  console.log('=== USER PROFILE ===');
  console.log('Email:', user.email);
  console.log(JSON.stringify(user.profile, null, 2));

  // --- Scheme universe ---
  const allSchemes = await Scheme.find({}).lean();
  const activeSchemes = allSchemes.filter(s => {
    const st = String(s.status ?? '').toLowerCase();
    return st !== 'closed';
  });
  const structuredSchemes = activeSchemes.filter(s =>
    ['universal', 'constrained'].includes(s.eligibilityRules?.eligibilityType)
  );

  console.log('\n=== SCHEME COUNTS ===');
  console.log('Total schemes in DB      :', allSchemes.length);
  console.log('Active (not Closed)      :', activeSchemes.length);
  console.log('With parsed eligibility  :', structuredSchemes.length);
  console.log('Universal schemes        :', activeSchemes.filter(s => s.eligibilityRules?.eligibilityType === 'universal').length);
  console.log('Constrained schemes      :', activeSchemes.filter(s => s.eligibilityRules?.eligibilityType === 'constrained').length);
  console.log('Unknown/unparsed         :', activeSchemes.filter(s => !['universal','constrained'].includes(s.eligibilityRules?.eligibilityType)).length);

  // --- Run the same pipeline as /matches ---
  const candidates = buildCandidates(user, activeSchemes, { allowUnknown: false });
  console.log('\n=== MATCHING RESULT ===');
  console.log('ELIGIBLE candidates      :', candidates.length);

  if (candidates.length === 0) {
    console.log('\n⚠️  Zero matches. Investigating why...\n');

    // Sample up to 30 schemes and show why they failed
    const sample = structuredSchemes.slice(0, 30);
    const failReasons = {};
    let eligible = 0, needsInfo = 0, notEligible = 0;

    for (const scheme of structuredSchemes) {
      const v = evaluateEligibility(user, scheme, { allowUnknown: false, strict: true });
      if (v.status === 'ELIGIBLE') eligible++;
      else if (v.status === 'NEEDS_MORE_INFORMATION') {
        needsInfo++;
        for (const u of v.unknown) {
          failReasons[u.rule] = (failReasons[u.rule] || 0) + 1;
        }
      } else {
        notEligible++;
        for (const f of v.failed) {
          failReasons[f.rule] = (failReasons[f.rule] || 0) + 1;
        }
      }
    }

    console.log('Among ALL structured schemes:');
    console.log('  ELIGIBLE             :', eligible);
    console.log('  NEEDS_MORE_INFO      :', needsInfo);
    console.log('  NOT_ELIGIBLE         :', notEligible);
    console.log('\nTop reasons for non-match (rule → count):');
    const sorted = Object.entries(failReasons).sort((a, b) => b[1] - a[1]);
    sorted.forEach(([rule, count]) => console.log(`  ${rule.padEnd(25)}: ${count}`));

    // Show 5 examples with full verdict
    console.log('\n--- 5 example verdicts ---');
    for (const scheme of sample.slice(0, 5)) {
      const v = evaluateEligibility(user, scheme, { allowUnknown: false, strict: true });
      console.log(`\n"${scheme.name.slice(0, 60)}" [${scheme.eligibilityRules?.eligibilityType}]`);
      console.log('  Status  :', v.status);
      if (v.failed.length)   console.log('  Failed  :', v.failed.map(f => `${f.rule}: ${f.reason}`).join(' | '));
      if (v.unknown.length)  console.log('  Unknown :', v.unknown.map(u => u.rule).join(', '));
      if (v.matched.length)  console.log('  Matched :', v.matched.map(m => m.rule).join(', '));
    }
  } else {
    const ranked = rankCandidates(candidates, user);
    console.log('\nTop 10 recommendations:');
    ranked.slice(0, 10).forEach((c, i) => {
      console.log(`  ${i+1}. [${c.verdict.status}] "${c.scheme.name.slice(0,55)}" — relevance: ${c.relevance}`);
    });
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
