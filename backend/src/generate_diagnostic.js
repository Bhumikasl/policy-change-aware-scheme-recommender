require('dotenv').config({ path: '../.env' });
const mongoose = require('mongoose');
const { buildCandidates } = require('./services/recommendationPropagation');
const { rankCandidates } = require('./services/relevanceRanker');
const Scheme = require('./models/Scheme');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const user = {
    _id: new mongoose.Types.ObjectId(),
    email: 'usera@test.com',
    profile: {
      age: 22,
      gender: 'Male',
      state: 'Karnataka',
      annualIncome: 250000,
      categories: ['OBC'],
      occupation: 'Student',
      education: 'Graduate',
      course: '',
      marksPercentage: null,
      disability: false,
      singleGirlChild: false,
      documentsAvailable: []
    }
  };

  const schemes = await Scheme.find({ status: 'Active' }).lean();
  const candidates = buildCandidates(user, schemes, { allowUnknown: true });
  const ranked = rankCandidates(candidates, user, { intent: '' });

  let report = '# Diagnostic Report\n';
  report += '**Logged-in User ID:** ' + user._id + '\n';
  report += '**Profile Values:**\n';
  report += '```json\n' + JSON.stringify(user.profile, null, 2) + '\n```\n';

  report += '**Scheme Counts:**\n';
  report += '- Total Active Schemes: ' + schemes.length + '\n';
  report += '- Eligible/Unknown Schemes: ' + candidates.length + '\n';

  report += '\n## Top 20 Recommendations\n';
  ranked.slice(0, 20).forEach((c, idx) => {
    report += `\n### #${idx + 1}: ${c.scheme.name} (${c.scheme.state})\n`;
    report += `- Relevance Score: ${c.relevance}\n`;
    report += `- Verdict: ${c.verdict.status} (${c.verdict.mode}) - Score: ${c.verdict.score}\n`;
    report += `\n**Relevance Breakdown:**\n\`\`\`json\n${JSON.stringify(c.relevanceBreakdown, null, 2)}\n\`\`\`\n`;
  });

  const fs = require('fs');
  fs.writeFileSync('C:/Users/mathg/.gemini/antigravity-ide/brain/6fc531ec-1b79-436f-8b98-2e4282c924e9/diagnostic_report.md', report);

  console.log('Report generated at artifact path.');
  process.exit(0);
}
main().catch(console.error);
