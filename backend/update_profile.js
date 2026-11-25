require('dotenv').config({ path: './.env' });
const mongoose = require('mongoose');
const User = require('./src/models/User');
const { buildCandidates } = require('./src/services/recommendationPropagation');
const { rankCandidates } = require('./src/services/relevanceRanker');
const Scheme = require('./src/models/Scheme');

mongoose.connect(process.env.MONGODB_URI).then(async () => {

  const TARGET_EMAIL = 'hihelloo@gmail.com';

  // --- 1. Update the profile ---
  const updated = await User.findOneAndUpdate(
    { email: TARGET_EMAIL },
    {
      $set: {
        'profile.gender':          'Female',
        'profile.age':             22,
        'profile.occupation':      'Student',
        'profile.annualIncome':    20000,
        'profile.education':       'Graduate',
        'profile.course':          'Engineering',   // B.Tech maps to Engineering
        'profile.categories':      ['OBC', 'Woman'],
        'profile.marksPercentage': null,
        'profile.disability':      null,
        'profile.singleGirlChild': null,
      }
    },
    { new: true }
  );

  if (!updated) { console.error('User not found:', TARGET_EMAIL); process.exit(1); }

  console.log('✅ Profile updated for', TARGET_EMAIL);
  console.log(JSON.stringify(updated.profile, null, 2));

  // --- 2. Run the same pipeline as /matches ---
  const allSchemes = await Scheme.find({}).lean();
  const activeSchemes = allSchemes.filter(s => String(s.status ?? '').toLowerCase() !== 'closed');

  const candidates = buildCandidates(updated, activeSchemes, { allowUnknown: false });
  const ranked     = rankCandidates(candidates, updated, { intent: '' });

  console.log('\n=== MATCH RESULTS ===');
  console.log('Active schemes   :', activeSchemes.length);
  console.log('ELIGIBLE matches :', candidates.length);
  console.log('\nTop 15 recommendations:');
  ranked.slice(0, 15).forEach((c, i) => {
    const rules = c.verdict.positiveMatches.map(m => m.rule).join(', ');
    console.log(`  ${String(i+1).padStart(2)}. [rel:${String(c.relevance).padStart(6)}] ${c.scheme.name.slice(0,55)}`);
    console.log(`       matched: ${rules}`);
  });

  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
