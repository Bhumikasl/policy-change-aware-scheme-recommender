require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const Scheme = require('../models/Scheme');

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const count = await Scheme.countDocuments({
    state: { $ne: 'All India', $nin: ['', null] },
    'eligibilityRules.states': { $size: 0 }
  });
  console.log('Schemes missing state in rules: ' + count);
  mongoose.disconnect();
});
