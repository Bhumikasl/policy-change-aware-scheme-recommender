require('dotenv').config({ path: './.env' });
const mongoose = require('mongoose');
const User = require('./src/models/User');
const { buildCandidates } = require('./src/services/recommendationPropagation');
const { rankCandidates } = require('./src/services/relevanceRanker');
const Scheme = require('./src/models/Scheme');

mongoose.connect(process.env.MONGODB_URI).then(async () => {

  // Fix both accounts — same profile, correct state name
  const EMAILS = ['bhumikalokare@gmail.com', 'hihelloo@gmail.com'];

  for (const email of EMAILS) {
    await User.findOneAndUpdate(
      { email },
      {
        $set: {
          'profile.state':          'Karnataka',   // valid state name
          'profile.gender':         'Female',
          'profile.age':            22,
          'profile.occupation':     'Student',
          'profile.annualIncome':   20000,
          'profile.education':      'Graduate',
          'profile.course':         'Engineering',
          'profile.categories':     ['OBC', 'Woman'],
          'profile.marksPercentage': null,
          'profile.disability':     null,
          'profile.singleGirlChild': null,
        }
      }
    );
    console.log('✅ Updated:', email);
  }

  // Show actual matches for bhumikalokare (the one showing in browser)
  const user = await User.findOne({ email: 'bhumikalokare@gmail.com' });
  const allSchemes = await Scheme.find({}).lean();
  const activeSchemes = allSchemes.filter(s => String(s.status ?? '').toLowerCase() !== 'closed');

  const candidates = buildCandidates(user, activeSchemes, { allowUnknown: false });
  const ranked     = rankCandidates(candidates, user);

  console.log('\n=== MATCHES FOR bhumikalokare@gmail.com ===');
  console.log('Profile:', JSON.stringify(user.profile, null, 2));
  console.log('\nELIGIBLE matches:', candidates.length);
  console.log('\nTop 10:');
  ranked.slice(0, 10).forEach((c, i) => {
    console.log(`  ${i+1}. [${c.relevance}] ${c.scheme.name.slice(0, 60)}`);
  });

  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
