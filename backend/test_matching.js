const path = require('path');
const backendRoot = 'c:/Users/mathg/Downloads/final_project/final_project/backend';
require(path.join(backendRoot, 'node_modules/dotenv')).config({ path: path.join(backendRoot, '.env') });
const mongoose = require(path.join(backendRoot, 'node_modules/mongoose'));
const Scheme = require(path.join(backendRoot, 'src/models/Scheme'));
const User = require(path.join(backendRoot, 'src/models/User'));
const { evaluateEligibility, checkRules } = require(path.join(backendRoot, 'src/services/matcher'));
const { buildCandidates } = require(path.join(backendRoot, 'src/services/recommendationPropagation'));
const { rankCandidates } = require(path.join(backendRoot, 'src/services/relevanceRanker'));
const { decideRecommendation } = require(path.join(backendRoot, 'src/services/schemeVerifier'));

const userA = {
  email: 'usera@test.com',
  name: 'User A',
  profile: {
    age: 22,
    gender: 'Male',
    state: 'Karnataka',
    annualIncome: 250000,
    categories: ['OBC'],
    occupation: 'Student',
    education: 'Graduate',
    course: 'Computer Science',
    marksPercentage: 75,
    disability: false,
    singleGirlChild: false,
    documentsAvailable: ['Aadhaar Card', 'Caste Certificate', 'Income Certificate', 'Educational Certificates']
  }
};

const userB = {
  email: 'userb@test.com',
  name: 'User B',
  profile: {
    age: 35,
    gender: 'Female',
    state: 'Tamil Nadu',
    annualIncome: 800000,
    categories: ['General'],
    occupation: 'Entrepreneur',
    education: 'Graduate',
    course: '',
    marksPercentage: null,
    disability: false,
    singleGirlChild: false,
    documentsAvailable: ['Aadhaar Card', 'PAN Card', 'Bank Passbook']
  }
};

async function testUser(user, label) {
  console.log(`\n========================================`);
  console.log(`TESTING MATCHES FOR ${label}: ${user.profile.gender}, ${user.profile.age}y, ${user.profile.state}, ${user.profile.occupation}, Income: ${user.profile.annualIncome}, Cat: ${user.profile.categories.join(',')}, Edu: ${user.profile.education}`);
  console.log(`========================================`);

  const query = { status: { $ne: 'Closed' }, 'eligibilityRules.eligibilityType': { $in: ['universal', 'constrained'] } };
  const schemes = await Scheme.find(query).sort({ lastUpdatedAt: -1 });
  console.log(`Total query schemes found: ${schemes.length}`);

  const candidates = buildCandidates(user, schemes, { allowUnknown: false });
  console.log(`Candidates passing buildCandidates: ${candidates.length}`);

  const ranked = rankCandidates(candidates, user, { intent: '' });
  console.log(`Ranked candidates: ${ranked.length}`);

  const top20 = ranked.slice(0, 20);
  console.log(`\n--- Top 20 Recommendations for ${label} ---`);
  top20.forEach((item, idx) => {
    const s = item.scheme;
    const v = item.verdict;
    console.log(`\n#${idx + 1}: [${s.schemeId}] ${s.name}`);
    console.log(`  State: ${s.state} | Ministry: ${s.ministry}`);
    console.log(`  Relevance: ${item.relevance} (Lexical: ${item.relevanceBreakdown?.lexical}, Spec: ${item.relevanceBreakdown?.specificity})`);
    console.log(`  Verdict status: ${v.status}, score: ${v.score}, type: ${v.eligibilityType}`);
    console.log(`  Matched:`, v.matched?.map(m => `${m.rule}: ${m.reason}`));
    console.log(`  Failed:`, v.failed?.map(f => `${f.rule}: ${f.reason}`));
    console.log(`  Unknown:`, v.unknown?.map(u => `${u.rule}: ${u.reason}`));
    console.log(`  Rules in DB:`, JSON.stringify(s.eligibilityRules));
  });
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  await testUser(userA, 'USER A');
  await testUser(userB, 'USER B');
  await mongoose.disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
