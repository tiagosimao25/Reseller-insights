// ===================================================================
// Partner Pulse — shared tuning constants
// Loaded before script.js (the dashboard) and methodology.js (the "how
// it works" page), so both always describe the exact same model —
// nothing here is duplicated as hardcoded text anywhere else.
// ===================================================================

const CONFIG = {
  weights: {
    renewalHealth: { renewalRate: 0.50, clm: 0.15, notRenewed: 0.15, partial: 0.10, autoRenew: 0.10 },
    growth: { arr: 0.30, sales: 0.25, nsb: 0.20, licenses: 0.15, endUsers: 0.10 },
    priority: { upsell: 0.30, growth: 0.25, renewalRisk: 0.20, autoRenewGap: 0.15, size: 0.10 },
  },
  clmScore: { active: 80, inactive: 30 },
  notRenewedPenaltyScale: 250, // 40% not-renewed -> renewal-composition sub-score of 0
  partialPenaltyScale: 200,    // 50% partial -> sub-score of 0
  valueRangeRiskPenalty: { systemic: 10, high: 8, low: 3 },
  autoRenewBenchmarkScale: 2.5,
  // a "large" % swing means different things for a volatile quarterly
  // figure vs. a smoothed trailing-12m one, so each delta gets its own scale
  deltaScale: { arr: 1.6, sales: 2.5, nsb: 2.2, licenses: 3, endUsers: 2.5 },
  upsellRatioScale: 2.5,
  // without a licenses total to normalize against, the raw-count fallback
  // is capped well below "High" so it never overstates confidence
  upsellFallback: { scale: 5, cap: 60 },
  // reseller-size score, interpolated between these [share%, score] points —
  // pinned to the same 2/8/20% thresholds as the Small/Medium/Large/Strategic
  // labels so a "Strategic" reseller actually scores near the top
  sizeScorePoints: [[0, 0], [2, 25], [8, 55], [20, 80], [40, 100]],
  // score -> label bands, shared by the dashboard's badges/meters and by
  // the methodology page's reference tables
  bands: {
    renewalHealth: [[70, 'Low', 'good'], [50, 'Medium', 'warning'], [30, 'High', 'serious'], [0, 'Critical', 'critical']],
    growth: [[75, 'Strong growth', 'good'], [55, 'Growth', 'good'], [40, 'Stable', 'warning'], [0, 'Decline', 'critical']],
    autoRenew: [[60, 'Above average', 'good'], [40, 'At average', 'warning'], [0, 'Below average', 'critical']],
    upsell: [[65, 'High', 'good'], [35, 'Medium', 'warning'], [15, 'Low', 'serious'], [0, 'None', 'neutral']],
    priority: [[75, 'Very High', 'critical'], [55, 'High', 'serious'], [35, 'Medium', 'warning'], [0, 'Low', 'good']],
    size: [[20, 'Strategic', 'good'], [8, 'Large', 'good'], [2, 'Medium', 'warning'], [0, 'Small', 'neutral']],
  },
  // every raw-value cutoff that triggers a diagnosis bullet or a
  // value-range risk level — kept here (not inline in script.js) so the
  // methodology page can list them, same as every other tuning constant
  diagnosticThresholds: {
    renewalRate: { critical: 60, belowTarget: 80, excellent: 90 },
    notRenewedRatio: 0.2,
    partialRatio: 0.15,
    arrGrowth: { declineBelow: 0, strongAbove: 10 },
    salesGrowth: { declineBelow: 0, robustAbove: 20 },
    paceRatio: { belowAverage: 0.85, aboveAverage: 1.15 },
    nsbDelta: { declineBelow: 0, strongAbove: 15 },
    licensesDelta: { declineBelow: 0, expandingAbove: 10 },
    endUsersDelta: { declineBelow: 0, healthyAbove: 10 },
    autoRenewGap: { wellBelow: -15, above: 10 },
    upsellRatio: { highPotentialAbove: 25 },
    valueRangeRisk: { systemicThreshold: 70, highThreshold: 75, lowThreshold: 70 },
  },
  // Next Action decision table, walked top to bottom — the first rule
  // whose `when` conditions all match the current band labels wins. A
  // condition value can be a single label or an array of acceptable
  // labels. An empty `when` always matches (used as the final fallback).
  // methodology.js renders this same array, so the "How it works" page
  // can't drift from the actual logic in script.js's buildNextAction.
  nextActionRules: [
    {
      id: 'escalateLarge',
      when: { renewalHealth: 'Critical', size: ['Large', 'Strategic'] },
      action: 'Urgent action: escalate to a senior account manager and schedule a retention call this week — a large reseller is at critical risk.',
    },
    {
      id: 'retentionImmediate',
      when: { renewalHealth: 'Critical' },
      action: 'Contact immediately for a retention plan; confirm the reason for non-renewal with the reseller.',
    },
    {
      id: 'dualOpportunity',
      when: { renewalHealth: 'High', upsell: 'High' },
      action: 'Dual opportunity: address the renewal risk and pitch the upgrade in the same relationship meeting with the reseller.',
    },
    {
      id: 'accountReview',
      when: { renewalHealth: 'High' },
      action: 'Schedule an account review to understand the causes of the renewal drop before the next cycle.',
    },
    {
      id: 'upsellStrongGrowth',
      when: { growth: 'Strong growth', upsell: 'High' },
      action: 'Ideal moment for an upsell pitch — schedule a demo of the higher-tier product while growth is strong.',
    },
    {
      id: 'upsellProposal',
      when: { upsell: 'High' },
      action: 'Prepare a commercial upgrade proposal and send a dedicated business case to the reseller.',
    },
    {
      id: 'autoRenewPromote',
      when: { autoRenew: 'Below average' },
      action: 'Promote auto-renew activation with the reseller to reduce future passive-churn risk.',
    },
    {
      id: 'investigateGrowthSlowdown',
      when: { growth: 'Decline', renewalHealth: ['Low', 'Medium'] },
      action: 'Investigate the causes of the growth slowdown despite a healthy renewal rate.',
    },
    {
      id: 'emergingInvestment',
      when: { size: 'Small', growth: 'Strong growth' },
      action: 'Emerging reseller with strong growth — consider additional investment in the partnership.',
    },
    {
      id: 'regularMonitoring',
      when: {},
      action: 'Keep up regular monitoring; no urgent action identified at this time.',
    },
  ],
};
