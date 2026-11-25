require('dotenv').config({ path: './.env' });
const mongoose = require('mongoose');
const Scheme = require('./src/models/Scheme');
const User = require('./src/models/User');
const { buildCandidates } = require('./src/services/recommendationPropagation');

mongoose.connect(process.env.MONGODB_URI).then(async () => {

  // 1. Scheme status breakdown
  const statuses = await Scheme.aggregate([
    { $group: { _id: '$status', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
  console.log('=== SCHEME STATUS BREAKDOWN ===');
  statuses.forEach(s => console.log(`  "${s._id}"`.padEnd(22) + ': ' + s.count));

  // 2. EligibilityType breakdown
  const types = await Scheme.aggregate([
    { $group: { _id: '$eligibilityRules.eligibilityType', count: { $sum: 1 } } },
    { $sort: { count: -1 } }
  ]);
  console.log('\n=== ELIGIBILITY TYPE BREAKDOWN ===');
  types.forEach(t => console.log(`  "${t._id}"`.padEnd(22) + ': ' + t.count));

  // 3. Run matches for YOUR actual user (most recently updated)
  const email = process.argv[2];
  const user = email
    ? await User.findOne({ email: email.toLowerCase() })
    : await User.findOne({ 'profile.state': { $ne: '' } }).sort({ updatedAt: -1 });

  if (!user) { console.log('No user found'); process.exit(0); }

  console.log('\n=== YOUR USER ===');
  console.log('Email :', user.email);
  console.log('State :', user.profile.state);
  console.log('Occ   :', user.profile.occupation);
  console.log('Age   :', user.profile.age);
  console.log('Cats  :', JSON.stringify(user.profile.categories));
  console.log('Gender:', user.profile.gender);
  console.log('Edu   :', user.profile.education);

  const allSchemes = await Scheme.find({}).lean();
  const activeSchemes = allSchemes.filter(s => {
    const st = String(s.status ?? '').toLowerCase();
    return st !== 'closed';
  });

  // Strict (normal) match
  const strict = buildCandidates(user, activeSchemes, { allowUnknown: false });
  // Relaxed (include unknown eligibility schemes)
  const relaxed = buildCandidates(user, activeSchemes, { allowUnknown: true });

  console.log('\n=== MATCH COUNTS ===');
  console.log('Active schemes          :', activeSchemes.length);
  console.log('Strict matches (shown)  :', strict.length);
  console.log('Relaxed matches (debug) :', relaxed.length);

  if (strict.length === 0 && relaxed.length === 0) {
    console.log('\n❌ ZERO matches even with allowUnknown=true.');
    console.log('This means every single scheme is failing a hard rule check.');
    console.log('Most likely cause: user.profile.state is empty or not a valid Indian state name.');
    console.log('User state value:', JSON.stringify(user.profile.state));
  }

  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
