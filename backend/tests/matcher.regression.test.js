const { evaluateEligibility, normalizeCourse } = require('../src/services/matcher');

describe('matcher regression: sparse profile non-strict behavior', () => {
  test('user with sparse profile should not be silently NOT_ELIGIBLE', () => {
    const user = {
      profile: {
        state: 'Haryana',
        // only one known field -> should trigger non-strict heuristic elsewhere
      }
    };
    const scheme = {
      schemeId: 'test-scheme-1',
      status: 'active',
      eligibilityRules: {
        eligibilityType: 'constrained',
        states: ['Haryana'],
        genders: ['female'],
      }
    };

    // In strict mode the missing gender yields NEEDS_MORE_INFORMATION
    const strict = evaluateEligibility(user, scheme, { allowUnknown: false, strict: true });
    expect(strict.status).toBe('NEEDS_MORE_INFORMATION');

    // In non-strict mode the missing gender is treated as noConstraint
    const nonStrict = evaluateEligibility(user, scheme, { allowUnknown: false, strict: false });
    // Since user state matches, and gender is noConstraint, constrained scheme
    // should yield ELIGIBLE because at least one positive exists and no failures.
    expect(nonStrict.status).toBe('ELIGIBLE');
  });
});
