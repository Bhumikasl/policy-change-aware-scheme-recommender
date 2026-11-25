require('dotenv').config({path: '../.env'});
const mongoose = require('mongoose');
const Scheme = require('./models/Scheme');
const { buildCandidates } = require('./services/recommendationPropagation');
const { rankCandidates } = require('./services/relevanceRanker');
const { checkRules } = require('./services/matcher');

async function testAccuracy() {
  await mongoose.connect(process.env.MONGODB_URI);
  const schemes = await Scheme.find({ status: { $ne: 'Closed' } });

  const userA = {
    profile: {
      age: 20,
      gender: 'Female',
      annualIncome: 20000,
      education: 'Graduate', // Undergraduate
      course: 'B.Tech CSE',  // B.Tech
      occupation: 'Student',
      state: 'Karnataka',
      categories: ['OBC']
    }
  };

  const userB = {
    profile: {
      age: 35,
      gender: 'Male',
      annualIncome: 800000,
      education: 'Graduate',
      course: '',
      occupation: 'Entrepreneur',
      state: 'Tamil Nadu',
      categories: ['General']
    }
  };

  let report = '# MATCHING PIPELINE VALIDATION REPORT\n\n';

  const users = [
    { name: 'User A', obj: userA },
    { name: 'User B', obj: userB }
  ];

  for (const { name, obj } of users) {
    report += `## 1. Test Profile: ${name}\n`;
    report += '```json\n' + JSON.stringify(obj.profile, null, 2) + '\n```\n\n';

    const eligible = buildCandidates(obj, schemes, { allowUnknown: false });
    const ranked = rankCandidates(eligible, obj);
    const top20 = ranked.slice(0, 20);

    let correctlyEligible = 0;
    let incorrectlyEligible = 0;
    let needsMoreInfo = 0;

    report += `## 2. Recommendation Breakdown (Top 20 for ${name})\n\n`;

    for (const cand of top20) {
      const s = cand.scheme;
      const rules = s.eligibilityRules;
      const diag = checkRules(obj, rules, { strict: true });
      
      report += '### ' + s.name + '\n';
      report += '**Scheme ID:** ' + s.schemeId + '\n';
      const relTotal = cand.relevanceBreakdown && cand.relevanceBreakdown.total ? cand.relevanceBreakdown.total : (cand.relevance || 0);
      report += '**Relevance Score:** ' + Number(relTotal).toFixed(2) + '\n';
      report += '#### Scheme Eligibility Rules\n';
      report += '- **Passed:** ' + JSON.stringify(diag.positive) + '\n';
      report += '- **Failed:** ' + JSON.stringify(diag.failed) + '\n';
      report += '- **Unknown (Needs Info):** ' + JSON.stringify(diag.unknown) + '\n';
      report += '- **No Constraint:** ' + JSON.stringify(diag.noConstraint) + '\n';
      
      if (diag.failed.length > 0) {
        report += '**Final Verdict:** ❌ FALSE POSITIVE (Incorrectly Eligible)\n\n';
        incorrectlyEligible++;
      } else if (diag.unknown.length > 0) {
        report += '**Final Verdict:** ⚠️ NEEDS MORE INFORMATION\n\n';
        needsMoreInfo++;
      } else {
        report += '**Final Verdict:** ✅ CORRECTLY ELIGIBLE\n\n';
        correctlyEligible++;
      }
    }

    report += `## 3. Summary for ${name}\n`;
    report += '- **Total Checked:** ' + top20.length + '\n';
    report += '- **Correctly Eligible:** ' + correctlyEligible + '\n';
    report += '- **Incorrectly Eligible (False Positives):** ' + incorrectlyEligible + '\n';
    report += '- **Needs More Information:** ' + needsMoreInfo + '\n\n';
  }

  const fs = require('fs');
  fs.writeFileSync('C:/Users/mathg/.gemini/antigravity-ide/brain/6fc531ec-1b79-436f-8b98-2e4282c924e9/validation_report.md', report);
  console.log('Report generated.');
  process.exit(0);
}
testAccuracy().catch(console.error);
