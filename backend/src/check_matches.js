require('dotenv').config({path: '../.env'});
const mongoose = require('mongoose');
const User = require('./models/User');
const Scheme = require('./models/Scheme');
const { buildCandidates } = require('./services/recommendationPropagation');
const { rankCandidates } = require('./services/relevanceRanker');
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const user = await User.findOne({email: 'test123@gmail.com'});
  const schemes = await Scheme.find({ status: { $ne: 'Closed' } }).sort({ lastUpdatedAt: -1 });
  const eligible = buildCandidates(user, schemes, { allowUnknown: false });
  const ranked = rankCandidates(eligible, user, { intent: '' });
  console.log('TOTAL:', ranked.length);
  ranked.slice(0, 10).forEach(c => console.log(c.scheme.name, c.scheme.eligibilityRules));
  process.exit(0);
}).catch(console.error);
