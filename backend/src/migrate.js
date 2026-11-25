require('dotenv').config({path: '../.env'});
const mongoose = require('mongoose');
const Scheme = require('./models/Scheme');

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI);
  const schemes = await Scheme.find({});
  let count = 0;
  for (let s of schemes) {
    let changed = false;
    let cats = s.eligibilityRules.categories || [];
    if (cats.includes('BPL') || cats.includes('EWS')) {
      cats = cats.filter(c => c !== 'BPL' && c !== 'EWS');
      if (!cats.includes('BPL / Economically Weaker')) {
        cats.push('BPL / Economically Weaker');
      }
      s.eligibilityRules.categories = cats;
      changed = true;
    }
    
    // Also fix state if empty
    let states = s.eligibilityRules.states || [];
    if (states.length === 0 && s.state && s.state !== 'All India') {
      s.eligibilityRules.states = [s.state];
      changed = true;
    }
    
    if (changed) {
      s.markModified('eligibilityRules');
      await s.save();
      count++;
    }
  }
  console.log('Migrated ' + count + ' schemes.');
  process.exit(0);
}
migrate().catch(console.error);
