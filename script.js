// ===================================================================
// Reseller Insights — correlation engine
// Each score is a weighted average of whatever inputs are available
// (weights are renormalized when an input is missing), so the form
// does not require every field to be filled in. The final outputs
// (diagnosis, next action, email) are composed from independently
// triggered rule blocks rather than one fixed text per combination —
// that's what lets a small rule set produce many distinct answers.
//
// Every tuning constant (weights, scaling factors, penalties, bands) lives
// in config.js — loaded before this file — so the model can be recalibrated
// in one place, and the methodology page always describes this exact model.
// ===================================================================

const STORAGE_KEY = 'reseller-insights:inputs:v1';

const form = document.getElementById('input-form');
const emptyHint = document.getElementById('empty-hint');
const resultsBody = document.getElementById('results-body');
const renewalRateInput = document.getElementById('renewalRate');
const renewalRateError = document.getElementById('renewalRate-error');

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const rawInputs = readInputs();
  // any subset of Renewed/Partial/Not-Renewed that's provided must not sum
  // to more than an explicitly-entered Total — catches a typo even when
  // only some of the three counts were filled in
  const providedParts = [rawInputs.agreementsRenewed, rawInputs.agreementsPartial, rawInputs.agreementsNotRenewed].filter(v => v !== null);
  const partsSum = providedParts.reduce((sum, v) => sum + v, 0);
  const agreementsMismatch = rawInputs.agreementsTotal !== null && providedParts.length > 0 && (
    providedParts.length === 3 ? partsSum !== rawInputs.agreementsTotal : partsSum > rawInputs.agreementsTotal
  );

  const inputs = deriveRenewalFields(rawInputs);
  inputs.agreementsMismatch = agreementsMismatch;

  if (inputs.renewalRate === null) {
    renewalRateError.hidden = false;
    renewalRateInput.setAttribute('aria-invalid', 'true');
    renewalRateInput.focus();
    return;
  }
  renewalRateError.hidden = true;
  renewalRateInput.removeAttribute('aria-invalid');

  const metrics = computeMetrics(inputs);
  render(inputs, metrics);
  emptyHint.hidden = true;
  resultsBody.hidden = false;
  resultsBody.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

document.getElementById('fill-sample').addEventListener('click', fillSample);
document.getElementById('copy-email').addEventListener('click', copyEmail);

// ---------- helpers ----------

function num(id) {
  const v = document.getElementById(id).value;
  return v === '' ? null : parseFloat(v);
}

function val(id) {
  const v = document.getElementById(id).value;
  return v === '' ? null : v;
}

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

// percentage input (already 0-100) -> 0-100 score
function pctToScore(pct) {
  return clamp(pct);
}

// a % delta (can be negative) -> 0-100 score, 0% = 50
function deltaToScore(deltaPct, scale = 2) {
  return clamp(50 + deltaPct * scale);
}

// piecewise-linear interpolation through [x, y] points, clamped at the ends
function interpolate(x, points) {
  if (x <= points[0][0]) return points[0][1];
  for (let k = 0; k < points.length - 1; k++) {
    const [x0, y0] = points[k];
    const [x1, y1] = points[k + 1];
    if (x <= x1) return y0 + (x - x0) * (y1 - y0) / (x1 - x0);
  }
  return points[points.length - 1][1];
}

// weighted average that ignores nulls and renormalizes remaining weights,
// so a missing input never silently drags a score toward a fixed default
function weightedAvg(pairs) {
  let wsum = 0, vsum = 0;
  for (const [w, v] of pairs) {
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    wsum += w;
    vsum += w * v;
  }
  if (wsum === 0) return null;
  return vsum / wsum;
}

function fmt(v, digits = 0) {
  return v === null ? '—' : v.toFixed(digits);
}

// an upsell path's volume: prefer the license count, fall back to the
// agreement count when licenses weren't given — never sum both, since an
// agreement typically bundles multiple licenses and adding them would
// double-count the same opportunity
function upsellVolume(p) {
  const count = p.lic !== null ? p.lic : (p.agr !== null ? p.agr : 0);
  const unit = p.lic !== null ? 'licenses' : 'agreements';
  return { count, unit };
}

// ---------- read form ----------

function readInputs() {
  return {
    resellerName: val('resellerName'),
    contactName: val('contactName'),
    quarter: val('quarter') || 'this quarter',
    renewalRate: num('renewalRate'),
    agreementsTotal: num('agreementsTotal'),
    agreementsRenewed: num('agreementsRenewed'),
    agreementsPartial: num('agreementsPartial'),
    agreementsNotRenewed: num('agreementsNotRenewed'),
    clmStatus: val('clmStatus'),

    vr: {
      low: [num('vr_0_1'), num('vr_1_5'), num('vr_5_10')].filter(v => v !== null),
      high: [num('vr_10_25'), num('vr_25_50'), num('vr_50_plus')].filter(v => v !== null),
    },

    arrGrowth: num('arrGrowth'),
    salesCurrent12m: num('salesCurrent12m'),
    salesPrevious12m: num('salesPrevious12m'),
    monthlyAverage: num('monthlyAverage'),
    currentMonthExtrap: num('currentMonthExtrap'),

    nsbValue: num('nsbValue'),
    nsbDelta: num('nsbDelta'),
    licenses: num('licenses'),
    licensesDelta: num('licensesDelta'),
    endUsers: num('endUsers'),
    endUsersDelta: num('endUsersDelta'),

    countrySales12m: num('countrySales12m'),
    countryLicenses: num('countryLicenses'),

    arPct: num('arPct'),
    arValue: num('arValue'),
    notArValue: num('notArValue'),
    arCountry: num('arCountry'),
    arEurope: num('arEurope'),

    upsell: {
      studio: { lic: num('up_studio_lic'), agr: num('up_studio_agr') },
      proplus: { lic: num('up_proplus_lic'), agr: num('up_proplus_agr') },
      ent4: { lic: num('up_ent4_lic'), agr: num('up_ent4_agr') },
    },
  };
}

// Fills in agreementsTotal and renewalRate from whichever raw counts were
// given, so the user only has to supply the % OR the counts, not both.
// Sets renewalRateDerived so computeMetrics can avoid double-counting the
// same agreements data as both the renewal rate and the not-renewed/partial
// ratios.
function deriveRenewalFields(i) {
  if (i.agreementsTotal === null) {
    const parts = [i.agreementsRenewed, i.agreementsPartial, i.agreementsNotRenewed];
    if (parts.some(v => v !== null)) {
      i.agreementsTotal = parts.reduce((sum, v) => sum + (v || 0), 0);
    }
  }

  i.renewalRateDerived = false;
  if (i.renewalRate === null && i.agreementsTotal) {
    if (i.agreementsRenewed !== null) {
      i.renewalRate = clamp((i.agreementsRenewed / i.agreementsTotal) * 100);
      i.renewalRateDerived = true;
    } else if (i.agreementsNotRenewed !== null) {
      const impliedRenewed = i.agreementsTotal - i.agreementsNotRenewed - (i.agreementsPartial || 0);
      i.renewalRate = clamp((impliedRenewed / i.agreementsTotal) * 100);
      i.renewalRateDerived = true;
    }
  }
  return i;
}

// ---------- compute ----------

function computeMetrics(i) {
  const W = CONFIG.weights;

  // --- renewal ratios ---
  let notRenewedRatio = null, partialRatio = null;
  if (i.agreementsTotal && i.agreementsTotal > 0) {
    if (i.agreementsNotRenewed !== null) notRenewedRatio = i.agreementsNotRenewed / i.agreementsTotal;
    if (i.agreementsPartial !== null) partialRatio = i.agreementsPartial / i.agreementsTotal;
  }

  // --- value-range concentration risk ---
  const VR = CONFIG.diagnosticThresholds.valueRangeRisk;
  let valueRangeRisk = null; // 'systemic' | 'high' | 'low' | null
  const lowMin = i.vr.low.length ? Math.min(...i.vr.low) : null;
  const highMin = i.vr.high.length ? Math.min(...i.vr.high) : null;
  if (lowMin !== null && highMin !== null && lowMin < VR.systemicThreshold && highMin < VR.systemicThreshold) {
    valueRangeRisk = 'systemic';
  } else if (highMin !== null && highMin < VR.highThreshold && (lowMin === null || highMin <= lowMin)) {
    valueRangeRisk = 'high';
  } else if (lowMin !== null && lowMin < VR.lowThreshold) {
    valueRangeRisk = 'low';
  }

  // --- auto-renew ---
  let arPct = i.arPct;
  if (arPct === null && i.arValue !== null && i.notArValue !== null && (i.arValue + i.notArValue) > 0) {
    arPct = (i.arValue / (i.arValue + i.notArValue)) * 100;
  }
  const arBenchmark = i.arEurope !== null ? i.arEurope : i.arCountry;
  let autoRenewScore = null;
  if (arPct !== null && arBenchmark !== null) autoRenewScore = deltaToScore(arPct - arBenchmark, CONFIG.autoRenewBenchmarkScale);
  else if (arPct !== null) autoRenewScore = pctToScore(arPct);

  // --- renewal health ---
  const clmActiveScore = i.clmStatus === 'active' ? CONFIG.clmScore.active : (i.clmStatus === 'inactive' ? CONFIG.clmScore.inactive : null);
  // when the renewal rate was derived from these same agreements counts,
  // notRenewed/partial ratios carry no independent information — including
  // them too would double-weight the same underlying numbers. Also treat a
  // manually-typed rate as effectively derived when it's within rounding
  // of what the agreements counts would produce, so typing both doesn't
  // double-count the same fact either.
  let renewalRateEffectivelyDerived = i.renewalRateDerived;
  if (!renewalRateEffectivelyDerived && i.renewalRate !== null && i.agreementsTotal && i.agreementsRenewed !== null) {
    const impliedRate = (i.agreementsRenewed / i.agreementsTotal) * 100;
    if (Math.abs(impliedRate - i.renewalRate) < 0.5) renewalRateEffectivelyDerived = true;
  }
  const useAgreementBreakdown = !renewalRateEffectivelyDerived;
  let renewalHealth = weightedAvg([
    [W.renewalHealth.renewalRate, i.renewalRate !== null ? pctToScore(i.renewalRate) : null],
    [W.renewalHealth.clm, clmActiveScore],
    [W.renewalHealth.notRenewed, useAgreementBreakdown && notRenewedRatio !== null ? clamp(100 - notRenewedRatio * CONFIG.notRenewedPenaltyScale) : null],
    [W.renewalHealth.partial, useAgreementBreakdown && partialRatio !== null ? clamp(100 - partialRatio * CONFIG.partialPenaltyScale) : null],
    [W.renewalHealth.autoRenew, autoRenewScore],
  ]);
  if (renewalHealth !== null) {
    if (valueRangeRisk === 'systemic') renewalHealth = clamp(renewalHealth - CONFIG.valueRangeRiskPenalty.systemic);
    else if (valueRangeRisk === 'high') renewalHealth = clamp(renewalHealth - CONFIG.valueRangeRiskPenalty.high);
    else if (valueRangeRisk === 'low') renewalHealth = clamp(renewalHealth - CONFIG.valueRangeRiskPenalty.low);
  }

  // --- growth ---
  let salesGrowthPct = null;
  if (i.salesCurrent12m !== null && i.salesPrevious12m) {
    salesGrowthPct = ((i.salesCurrent12m - i.salesPrevious12m) / i.salesPrevious12m) * 100;
  }
  let paceRatio = null;
  if (i.currentMonthExtrap !== null && i.monthlyAverage) {
    paceRatio = i.currentMonthExtrap / i.monthlyAverage;
  }
  const DS = CONFIG.deltaScale;
  const growthScore = weightedAvg([
    [W.growth.arr, i.arrGrowth !== null ? deltaToScore(i.arrGrowth, DS.arr) : null],
    [W.growth.sales, salesGrowthPct !== null ? deltaToScore(salesGrowthPct, DS.sales) : null],
    [W.growth.nsb, i.nsbDelta !== null ? deltaToScore(i.nsbDelta, DS.nsb) : null],
    [W.growth.licenses, i.licensesDelta !== null ? deltaToScore(i.licensesDelta, DS.licenses) : null],
    [W.growth.endUsers, i.endUsersDelta !== null ? deltaToScore(i.endUsersDelta, DS.endUsers) : null],
  ]);

  // --- size / segment ---
  let sizeShare = null;
  if (i.salesCurrent12m !== null && i.countrySales12m) sizeShare = (i.salesCurrent12m / i.countrySales12m) * 100;
  else if (i.licenses !== null && i.countryLicenses) sizeShare = (i.licenses / i.countryLicenses) * 100;
  const sizeScoreForPriority = sizeShare !== null ? interpolate(sizeShare, CONFIG.sizeScorePoints) : null;

  // --- upsell ---
  const u = i.upsell;
  const studioVol = upsellVolume(u.studio);
  const proplusVol = upsellVolume(u.proplus);
  const ent4Vol = upsellVolume(u.ent4);
  const upsellLicTotal = studioVol.count + proplusVol.count + ent4Vol.count;
  const anyUpsellData = [u.studio.lic, u.studio.agr, u.proplus.lic, u.proplus.agr, u.ent4.lic, u.ent4.agr].some(v => v !== null);
  let upsellRatio = null;
  if (i.licenses && i.licenses > 0) upsellRatio = (upsellLicTotal / i.licenses) * 100;
  let upsellScore = null;
  if (upsellRatio !== null) upsellScore = clamp(upsellRatio * CONFIG.upsellRatioScale);
  else if (anyUpsellData) upsellScore = clamp(upsellLicTotal * CONFIG.upsellFallback.scale, 0, CONFIG.upsellFallback.cap);

  // dominant upgrade path: Enterprise Edition 4 > Pro Plus > Studio on ties
  const paths = [
    { key: 'ent4', label: 'Creative Cloud Pro Plus → Enterprise Edition 4', ...ent4Vol },
    { key: 'proplus', label: 'Creative Cloud Pro → Pro Plus', ...proplusVol },
    { key: 'studio', label: 'Acrobat Standard/Pro → Studio', ...studioVol },
  ];
  const dominantPath = anyUpsellData
    ? paths.reduce((best, p) => p.count > best.count ? p : best, paths[0])
    : null;

  // --- overall priority ---
  const overallPriority = weightedAvg([
    [W.priority.upsell, upsellScore],
    [W.priority.growth, growthScore],
    [W.priority.renewalRisk, renewalHealth !== null ? 100 - renewalHealth : null],
    [W.priority.autoRenewGap, autoRenewScore !== null ? 100 - autoRenewScore : null],
    [W.priority.size, sizeScoreForPriority],
  ]);

  return {
    notRenewedRatio, partialRatio, valueRangeRisk,
    arPct, arBenchmark, autoRenewScore,
    renewalHealth, salesGrowthPct, paceRatio, growthScore,
    sizeShare, sizeScoreForPriority,
    upsellLicTotal, upsellRatio, upsellScore, dominantPath, anyUpsellData,
    upsellByPath: { studio: studioVol, proplus: proplusVol, ent4: ent4Vol },
    overallPriority,
  };
}

// ---------- bands ----------

function band(score, breakpoints) {
  // breakpoints: [[min, label, status], ...] sorted descending by min
  if (score === null) return { label: 'No data', status: 'neutral' };
  for (const [min, label, status] of breakpoints) {
    if (score >= min) return { label, status };
  }
  return breakpoints[breakpoints.length - 1];
}

const riskBand = (h) => band(h, CONFIG.bands.renewalHealth);
const growthBand = (g) => band(g, CONFIG.bands.growth);
const autoRenewBand = (a) => band(a, CONFIG.bands.autoRenew);
const upsellBand = (u) => band(u, CONFIG.bands.upsell);
const priorityBand = (p) => band(p, CONFIG.bands.priority);

function sizeBand(share) {
  return share === null ? { label: 'Undetermined', status: 'neutral' } : band(share, CONFIG.bands.size);
}

// ---------- diagnostic bullets ----------

function buildDiagnostic(i, m) {
  const T = CONFIG.diagnosticThresholds;
  const b = [];

  if (i.agreementsMismatch) {
    b.push("Agreements figures don't add up: Renewed + Partial + Not Renewed ≠ Total — double-check these numbers.");
  }

  if (i.renewalRate !== null) {
    if (i.renewalRate < T.renewalRate.critical) b.push(`Critical renewal rate (${fmt(i.renewalRate,1)}%) in ${i.quarter} — high risk of revenue loss.`);
    else if (i.renewalRate < T.renewalRate.belowTarget) b.push(`Renewal rate below target (${fmt(i.renewalRate,1)}%) in ${i.quarter}.`);
    else if (i.renewalRate >= T.renewalRate.excellent) b.push(`Excellent renewal rate (${fmt(i.renewalRate,1)}%) in ${i.quarter}.`);
  }
  if (m.notRenewedRatio !== null && m.notRenewedRatio > T.notRenewedRatio) {
    b.push(`${(m.notRenewedRatio*100).toFixed(0)}% of agreements did not renew in ${i.quarter}.`);
  }
  if (m.partialRatio !== null && m.partialRatio > T.partialRatio) {
    b.push(`Significant share of partial renewals (${(m.partialRatio*100).toFixed(0)}%) — possible seat downgrades.`);
  }
  if (i.clmStatus === 'inactive') {
    b.push('CLM not active — reseller is outside the lifecycle management program, higher risk of silent churn.');
  } else if (i.clmStatus === 'active') {
    b.push('CLM active — reseller benefits from structured account monitoring.');
  }
  if (m.valueRangeRisk === 'systemic') {
    b.push('Renewal weakness is broad-based across both low- and high-value accounts, not isolated to one segment.');
  } else if (m.valueRangeRisk === 'high') {
    b.push('Renewal losses are concentrated in high-value accounts ($10k+) — disproportionate revenue impact.');
  } else if (m.valueRangeRisk === 'low') {
    b.push('Renewal losses are concentrated in low-value accounts — limited revenue impact but worth monitoring.');
  }

  if (i.arrGrowth !== null) {
    if (i.arrGrowth < T.arrGrowth.declineBelow) b.push(`ARR declining (${fmt(i.arrGrowth,1)}%) in ${i.quarter}.`);
    else if (i.arrGrowth > T.arrGrowth.strongAbove) b.push(`Strong ARR growth (${fmt(i.arrGrowth,1)}%) in ${i.quarter}.`);
  }
  if (m.salesGrowthPct !== null) {
    if (m.salesGrowthPct < T.salesGrowth.declineBelow) b.push(`Trailing 12-month sales down (${fmt(m.salesGrowthPct,1)}%) vs. the prior period.`);
    else if (m.salesGrowthPct > T.salesGrowth.robustAbove) b.push(`Robust trailing 12-month sales growth (+${fmt(m.salesGrowthPct,1)}%).`);
  }
  if (m.paceRatio !== null) {
    if (m.paceRatio < T.paceRatio.belowAverage) b.push('Current month is pacing below the monthly average.');
    else if (m.paceRatio > T.paceRatio.aboveAverage) b.push('Current month is pacing above the monthly average.');
  }
  if (i.nsbDelta !== null) {
    if (i.nsbDelta < T.nsbDelta.declineBelow) b.push(`NSB down (${fmt(i.nsbDelta,1)}%) over the trailing 12 months.`);
    else if (i.nsbDelta > T.nsbDelta.strongAbove) b.push(`NSB expanding strongly (+${fmt(i.nsbDelta,1)}%) over the trailing 12 months.`);
  }
  if (i.licensesDelta !== null) {
    if (i.licensesDelta < T.licensesDelta.declineBelow) b.push(`License base shrinking (${fmt(i.licensesDelta,1)}%).`);
    else if (i.licensesDelta > T.licensesDelta.expandingAbove) b.push(`License base expanding (+${fmt(i.licensesDelta,1)}%).`);
  }
  if (i.endUsersDelta !== null) {
    if (i.endUsersDelta < T.endUsersDelta.declineBelow) b.push('End-user count is declining.');
    else if (i.endUsersDelta > T.endUsersDelta.healthyAbove) b.push('Healthy growth in end-user count.');
  }

  if (m.sizeShare !== null) {
    const sb = sizeBand(m.sizeShare);
    b.push(`"${sb.label}"-sized reseller — represents ${fmt(m.sizeShare,1)}% of the in-country business.`);
  }

  if (m.arPct !== null && m.arBenchmark !== null) {
    const gap = m.arPct - m.arBenchmark;
    if (gap < T.autoRenewGap.wellBelow) b.push(`Auto-renew well below the reference (${fmt(m.arPct,1)}% vs ${fmt(m.arBenchmark,1)}%) — operational risk of passive churn.`);
    else if (gap > T.autoRenewGap.above) b.push(`Auto-renew above the reference (${fmt(m.arPct,1)}% vs ${fmt(m.arBenchmark,1)}%) — good protection against passive churn.`);
  }

  const uv = m.upsellByPath;
  if (uv.studio.count) b.push(`${uv.studio.count} ${uv.studio.unit} eligible for Acrobat Standard/Pro → Studio upgrade.`);
  if (uv.proplus.count) b.push(`${uv.proplus.count} ${uv.proplus.unit} eligible for Creative Cloud Pro → Pro Plus upgrade.`);
  if (uv.ent4.count) b.push(`${uv.ent4.count} ${uv.ent4.unit} eligible for Creative Cloud Pro Plus → Enterprise Edition 4 upgrade.`);
  if (m.upsellRatio !== null && m.upsellRatio > T.upsellRatio.highPotentialAbove) {
    b.push(`High upsell potential: ${fmt(m.upsellRatio,0)}% of the license base has an identified upgrade path.`);
  }

  if (b.length === 0) b.push('Not enough data to generate a diagnosis — fill in more fields.');
  return b;
}

// ---------- next action (data-driven rule table, first match wins) ----------

// a rule's `when` matches the current band labels if every listed
// dimension's actual label equals (or is included in, for an array) the
// expected value; an empty `when` matches unconditionally
function ruleMatches(when, bandLabels) {
  return Object.entries(when).every(([key, expected]) => {
    const actual = bandLabels[key];
    return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
  });
}

function buildNextAction(i, m) {
  const bandLabels = {
    renewalHealth: riskBand(m.renewalHealth).label,
    growth: growthBand(m.growthScore).label,
    upsell: upsellBand(m.upsellScore).label,
    size: sizeBand(m.sizeShare).label,
    autoRenew: autoRenewBand(m.autoRenewScore).label,
  };
  const rule = CONFIG.nextActionRules.find(r => ruleMatches(r.when, bandLabels));
  return rule.action;
}

// ---------- product recommendation ----------

function buildProductRecommendation(i, m) {
  if (!m.anyUpsellData || !m.dominantPath || m.dominantPath.count === 0) {
    return 'No upgrade opportunities identified in the data provided.';
  }
  const p = m.dominantPath;
  return `Recommended focus: ${p.label} (${p.count} ${p.unit} eligible). This is the highest-volume upgrade path identified for this reseller.`;
}

// ---------- email draft ----------

function buildEmail(i, m) {
  const rBand = riskBand(m.renewalHealth);
  const name = i.resellerName;
  const subject = name ? `${name} — Partnership check-in and next steps` : 'Partnership check-in and next steps';
  const possessive = name ? name + (/s$/i.test(name) ? '’' : '’s') : null;
  const numbersFor = possessive
    ? `${possessive} ${i.quarter}`
    : (i.quarter === 'this quarter' ? i.quarter : `the ${i.quarter}`);

  const parts = [];
  parts.push(`Subject: ${subject}`);
  parts.push('');
  parts.push(`Hi ${i.contactName || '[Contact Name]'},`);
  parts.push('');

  if (rBand.status === 'critical' || rBand.status === 'serious') {
    parts.push(`Looking at ${numbersFor} numbers, we noticed a renewal rate of ${i.renewalRate !== null ? fmt(i.renewalRate,1) + '%' : 'unavailable'}, below where we'd like it to be. We'd like to understand the context better and see how we can support retention on these accounts.`);
  } else if (i.renewalRate !== null) {
    parts.push(`Looking at ${numbersFor} numbers, the renewal rate stands at ${fmt(i.renewalRate,1)}%, a solid result — thank you for the continued partnership.`);
  }

  if (m.growthScore !== null) {
    const gBand = growthBand(m.growthScore);
    if (gBand.label === 'Strong growth' || gBand.label === 'Growth') {
      parts.push('We also noticed positive momentum in the business over the past few months — congratulations on the results.');
    } else if (gBand.label === 'Decline') {
      parts.push('We also noticed some recent slowdown in growth and would like to understand if there is anything we can help with.');
    }
  }

  if (m.anyUpsellData && m.dominantPath && m.dominantPath.count > 0) {
    parts.push(`We also identified an upgrade opportunity in ${m.dominantPath.label}, which could bring additional value to your end customers. We'd love to walk you through the details.`);
  }

  parts.push('');
  parts.push('Could we schedule a call in the next few days?');
  parts.push('');
  parts.push('Best regards,');
  parts.push('[Your Name]');

  return parts.join('\n');
}

// ---------- render ----------

function setTile(id, value, bandInfo) {
  const tile = document.getElementById(id);
  tile.querySelector('.tile-value').textContent = value;
  const badgeEl = tile.querySelector('.tile-band');
  badgeEl.textContent = bandInfo.label;
  badgeEl.className = 'tile-band badge ' + bandInfo.status;
}

function renderMeters(rows) {
  const container = document.getElementById('meters');
  container.innerHTML = '';
  const statusColor = {
    good: 'var(--status-good)',
    warning: 'var(--status-warning)',
    serious: 'var(--status-serious)',
    critical: 'var(--status-critical)',
    neutral: 'var(--status-neutral)',
  };
  for (const r of rows) {
    const row = document.createElement('div');
    row.className = 'meter-row';
    const score = r.score === null ? 0 : r.score;
    row.innerHTML = `
      <span class="meter-name">${r.name}</span>
      <span class="meter-track"><span class="meter-fill" style="width:${score}%;background:${statusColor[r.status]}"></span></span>
      <span class="meter-num">${r.score === null ? '—' : Math.round(r.score)}</span>
    `;
    container.appendChild(row);
  }
}

function render(i, m) {
  const rBand = riskBand(m.renewalHealth);
  const gBand = growthBand(m.growthScore);
  const aBand = autoRenewBand(m.autoRenewScore);
  const uBand = upsellBand(m.upsellScore);
  const sBand = sizeBand(m.sizeShare);
  const pBand = priorityBand(m.overallPriority);

  document.getElementById('results-name').textContent = i.resellerName || 'Reseller diagnosis';
  document.getElementById('results-meta').textContent = `${i.quarter} · Overall priority: ${pBand.label}`;

  setTile('tile-priority', m.overallPriority === null ? '—' : Math.round(m.overallPriority), pBand);
  setTile('tile-risk', m.renewalHealth === null ? '—' : Math.round(m.renewalHealth), rBand);
  setTile('tile-growth', m.growthScore === null ? '—' : Math.round(m.growthScore), gBand);
  setTile('tile-autorenew', m.autoRenewScore === null ? '—' : Math.round(m.autoRenewScore), aBand);
  setTile('tile-upsell', m.upsellScore === null ? '—' : Math.round(m.upsellScore), uBand);
  setTile('tile-size', m.sizeShare === null ? '—' : fmt(m.sizeShare,1) + '%', sBand);

  renderMeters([
    { name: 'Renewal Health', score: m.renewalHealth, status: rBand.status },
    { name: 'Growth', score: m.growthScore, status: gBand.status },
    { name: 'Auto-Renew', score: m.autoRenewScore, status: aBand.status },
    { name: 'Upsell Opportunity', score: m.upsellScore, status: uBand.status },
    { name: 'Overall Priority', score: m.overallPriority, status: pBand.status },
  ]);

  const list = document.getElementById('diagnostic-list');
  list.innerHTML = '';
  for (const bullet of buildDiagnostic(i, m)) {
    const li = document.createElement('li');
    li.textContent = bullet;
    list.appendChild(li);
  }

  document.getElementById('product-recommendation').textContent = buildProductRecommendation(i, m);
  document.getElementById('next-action').textContent = buildNextAction(i, m);
  document.getElementById('email-draft').textContent = buildEmail(i, m);
}

// ---------- copy email ----------

async function copyEmail() {
  const text = document.getElementById('email-draft').textContent;
  const btn = document.getElementById('copy-email');
  try {
    await navigator.clipboard.writeText(text);
    flashCopyButton(btn, 'Copied!');
  } catch (err) {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('email-draft'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    flashCopyButton(btn, 'Select & copy');
  }
}

function flashCopyButton(btn, label) {
  const original = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1500);
}

// ---------- local persistence (this browser only, nothing is sent anywhere) ----------

const persistedFieldIds = Array.from(form.querySelectorAll('input, select'))
  .map(el => el.id)
  .filter(Boolean);

function saveToStorage() {
  const data = {};
  for (const id of persistedFieldIds) data[id] = document.getElementById(id).value;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (err) { /* storage unavailable, ignore */ }
}

function loadFromStorage() {
  let data;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    data = JSON.parse(raw);
  } catch (err) {
    return;
  }
  for (const id of persistedFieldIds) {
    if (data[id] !== undefined) document.getElementById(id).value = data[id];
  }
}

form.addEventListener('input', saveToStorage);
form.addEventListener('change', saveToStorage);
form.addEventListener('reset', () => {
  try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* ignore */ }
  resultsBody.hidden = true;
  emptyHint.hidden = false;
  renewalRateError.hidden = true;
  renewalRateInput.removeAttribute('aria-invalid');
});

loadFromStorage();

// ---------- sample data (for quick testing) ----------

function fillSample() {
  const sample = {
    resellerName: 'Nordic Digital Solutions',
    contactName: 'Erik Larsen',
    quarter: 'Q3 2026',
    renewalRate: 68,
    agreementsTotal: 40,
    agreementsRenewed: 27,
    agreementsPartial: 6,
    agreementsNotRenewed: 7,
    clmStatus: 'active',
    vr_0_1: 82, vr_1_5: 75, vr_5_10: 70, vr_10_25: 58, vr_25_50: 50, vr_50_plus: 45,
    arrGrowth: 6,
    salesCurrent12m: 420000,
    salesPrevious12m: 380000,
    monthlyAverage: 35000,
    currentMonthExtrap: 31000,
    nsbValue: 95000,
    nsbDelta: 9,
    licenses: 260,
    licensesDelta: 4,
    endUsers: 610,
    endUsersDelta: 3,
    countrySales12m: 6200000,
    countryLicenses: 5400,
    arPct: 41,
    arCountry: 55,
    arEurope: 58,
    up_studio_lic: 34, up_studio_agr: 12,
    up_proplus_lic: 9, up_proplus_agr: 4,
    up_ent4_lic: 3, up_ent4_agr: 1,
  };
  for (const [key, value] of Object.entries(sample)) {
    const el = document.getElementById(key);
    if (el) el.value = value;
  }
  saveToStorage();
}
