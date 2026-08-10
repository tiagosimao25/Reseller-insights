// ===================================================================
// Partner Pulse — correlation engine
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

const form = document.getElementById('input-form');
const emptyHint = document.getElementById('empty-hint');
const resultsBody = document.getElementById('results-body');
const renewalRateInput = document.getElementById('renewalRate');
const renewalRateError = document.getElementById('renewalRate-error');

// ---------- per-step validation ----------
// Returns the element to focus if step `n` is invalid, or null if it's fine.
// Called both from the wizard's "Next" button (fields already visible) and
// from the final submit handler as a safety net regardless of which path
// got the user to step 7 (see setupWizard below for why that safety net
// matters once native `required` no longer covers hidden steps).
function validateStep(n) {
  if (n === 1) {
    const el = document.getElementById('resellerCountry');
    const err = document.getElementById('resellerCountry-error');
    if (!el.value) {
      err.hidden = false;
      el.setAttribute('aria-invalid', 'true');
      return el;
    }
    err.hidden = true;
    el.removeAttribute('aria-invalid');
    return null;
  }
  if (n === 2) {
    const clmEl = document.getElementById('clmStatus');
    const clmErr = document.getElementById('clmStatus-error');
    if (!clmEl.value) {
      clmErr.hidden = false;
      clmEl.setAttribute('aria-invalid', 'true');
      return clmEl;
    }
    clmErr.hidden = true;
    clmEl.removeAttribute('aria-invalid');

    const derived = deriveRenewalFields(readInputs());
    if (derived.renewalRate === null) {
      renewalRateError.hidden = false;
      renewalRateInput.setAttribute('aria-invalid', 'true');
      return renewalRateInput;
    }
    renewalRateError.hidden = true;
    renewalRateInput.removeAttribute('aria-invalid');
    return null;
  }
  return null;
}

// Shared by the real "Generate Diagnosis" submit and by fillSample(), which
// also generates immediately instead of leaving the user to click Next
// through every step just to reach the submit button.
function generateDiagnosis() {
  const invalid1 = validateStep(1);
  if (invalid1) { goToStep(1, { skipFocus: true }); invalid1.focus(); return false; }

  const invalid2 = validateStep(2);
  if (invalid2) { goToStep(2, { skipFocus: true }); invalid2.focus(); return false; }

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

  const metrics = computeMetrics(inputs);
  render(inputs, metrics);
  emptyHint.hidden = true;
  resultsBody.hidden = false;
  resultsBody.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return true;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  generateDiagnosis();
});

document.getElementById('fill-sample').addEventListener('click', fillSample);
document.getElementById('copy-email-en').addEventListener('click', (e) => copyEmail('email-draft-en', e.currentTarget));
document.getElementById('copy-email-translated').addEventListener('click', (e) => copyEmail('email-draft-translated', e.currentTarget));

// ---------- results view toggle (Numbers scorecard <-> Graphs) ----------
// Numbers is the default view; Graphs (the radar chart) is opt-in via a
// small tab control, since a short-attention-span skim starts with the
// familiar numbers and the chart is there for whoever wants the shape.
const viewToggleNumbersBtn = document.getElementById('view-toggle-numbers');
const viewToggleGraphsBtn = document.getElementById('view-toggle-graphs');
const resultsViewNumbers = document.getElementById('results-view-numbers');
const resultsViewGraphs = document.getElementById('results-view-graphs');

function setResultsView(view) {
  const showGraphs = view === 'graphs';
  resultsViewGraphs.hidden = !showGraphs;
  resultsViewNumbers.hidden = showGraphs;
  viewToggleGraphsBtn.setAttribute('aria-selected', String(showGraphs));
  viewToggleNumbersBtn.setAttribute('aria-selected', String(!showGraphs));
}

viewToggleNumbersBtn.addEventListener('click', () => setResultsView('numbers'));
viewToggleGraphsBtn.addEventListener('click', () => setResultsView('graphs'));

// ---------- chart type toggle (Overview radar <-> Scores bars <-> By Value Range bars) ----------
const chartTypeBtns = {
  radar: document.getElementById('chart-type-radar'),
  bars: document.getElementById('chart-type-bars'),
  valuerange: document.getElementById('chart-type-valuerange'),
};
const chartTypeEls = {
  radar: document.getElementById('radar-chart'),
  bars: document.getElementById('bar-chart'),
  valuerange: document.getElementById('valuerange-chart'),
};

function setChartType(type) {
  for (const key of Object.keys(chartTypeEls)) {
    chartTypeEls[key].hidden = key !== type;
    chartTypeBtns[key].setAttribute('aria-selected', String(key === type));
  }
}

chartTypeBtns.radar.addEventListener('click', () => setChartType('radar'));
chartTypeBtns.bars.addEventListener('click', () => setChartType('bars'));
chartTypeBtns.valuerange.addEventListener('click', () => setChartType('valuerange'));

// ---------- wizard (one section visible at a time, "Next"/"Back" between them) ----------
// All 7 step containers stay mounted in the DOM at all times (toggled via
// the `hidden` attribute) rather than being built/torn down per step, so
// fillSample()/readInputs()/the thousands-formatting listeners all keep
// working unmodified regardless of which step is currently shown.

const WIZARD_STEP_TITLES = {
  1: 'Reseller',
  2: 'Renewal & Retention',
  3: 'Growth',
  4: 'NSB, Licenses & End Users',
  5: 'Country Totals',
  6: 'Auto-Renew',
  7: 'Upsell Opportunity',
};

const wizardSteps = Array.from(document.querySelectorAll('.wizard-step'));
const wizardDots = Array.from(document.querySelectorAll('.wizard-step-dot'));
const stepTitleEl = document.getElementById('step-title');
const wizardAnnouncer = document.getElementById('wizard-announcer');
const wizardBackBtn = document.getElementById('wizard-back');
const wizardNextBtn = document.getElementById('wizard-next');
const wizardSubmitBtn = document.getElementById('wizard-submit');

let currentStep = 1;
let maxStepReached = 1;

function goToStep(n, opts) {
  currentStep = n;
  if (n > maxStepReached) maxStepReached = n;

  wizardSteps.forEach(step => { step.hidden = Number(step.dataset.step) !== n; });

  wizardDots.forEach(dot => {
    const dotStep = Number(dot.dataset.step);
    const isCurrent = dotStep === n;
    dot.setAttribute('aria-current', isCurrent ? 'step' : 'false');
    dot.classList.toggle('visited', dotStep <= maxStepReached && !isCurrent);
    dot.disabled = dotStep > maxStepReached;
  });

  stepTitleEl.textContent = WIZARD_STEP_TITLES[n];
  wizardAnnouncer.textContent = `Step ${n} of 7: ${WIZARD_STEP_TITLES[n]}`;
  if (!(opts && opts.skipFocus)) stepTitleEl.focus();

  wizardBackBtn.disabled = n === 1;
  wizardNextBtn.hidden = n === 7;
  wizardSubmitBtn.hidden = n !== 7;
}

wizardBackBtn.addEventListener('click', () => {
  if (currentStep > 1) goToStep(currentStep - 1);
});

wizardNextBtn.addEventListener('click', () => {
  const invalidEl = validateStep(currentStep);
  if (invalidEl) { invalidEl.focus(); return; }
  if (currentStep < 7) goToStep(currentStep + 1);
});

wizardDots.forEach(dot => {
  dot.addEventListener('click', () => {
    const n = Number(dot.dataset.step);
    if (n <= maxStepReached) goToStep(n);
  });
});

goToStep(1, { skipFocus: true });

// ---------- thousands-formatted number fields ----------
// These fields are plain text inputs (not type="number") so they can show
// "8,500,000" while typing. Only digits are ever accepted — negative signs
// and everything else are stripped, which also makes it impossible to type
// a value these fields shouldn't have (they're all non-negative counts or
// currency amounts). num() strips the commas back out when reading values.

function formatThousands(digitsOnly) {
  return digitsOnly.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function setThousandsValue(input, rawValue) {
  input.value = rawValue === null || rawValue === undefined || rawValue === ''
    ? ''
    : formatThousands(String(rawValue).replace(/[^\d]/g, ''));
}

document.querySelectorAll('input[data-thousands]').forEach((input) => {
  input.addEventListener('input', () => {
    const digitsBeforeCursor = input.value.slice(0, input.selectionStart).replace(/[^\d]/g, '').length;
    const digits = input.value.replace(/[^\d]/g, '');
    input.value = formatThousands(digits);
    // walk forward from the start until we've passed the same number of
    // digits the cursor was after, so it lands in the same logical spot
    // even though comma insertion shifted the character offsets
    let seen = 0, pos = 0;
    while (pos < input.value.length && seen < digitsBeforeCursor) {
      if (/\d/.test(input.value[pos])) seen++;
      pos++;
    }
    input.setSelectionRange(pos, pos);
  });
});

// ---------- helpers ----------

function num(id) {
  const v = document.getElementById(id).value.replace(/,/g, '');
  return v === '' ? null : parseFloat(v);
}

function val(id) {
  const v = document.getElementById(id).value;
  return v === '' ? null : v;
}

// reads the data-lang attribute off the selected <option>, defaulting to
// English when nothing is selected (or the country has no localized draft)
function countryLang(id) {
  const el = document.getElementById(id);
  const opt = el.selectedOptions[0];
  return (opt && opt.dataset.lang) || 'en';
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
    country: val('resellerCountry'),
    countryLang: countryLang('resellerCountry'),
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

// Bullets are tagged with a severity so the most urgent findings always
// read first, regardless of which form field they came from. Same
// vocabulary as the score badges (critical > serious > warning > neutral >
// good), sorted with a stable sort so bullets within the same tier keep
// their original (field) order.
const SEVERITY_RANK = { critical: 0, serious: 1, warning: 2, neutral: 3, good: 4 };

function buildDiagnostic(i, m) {
  const T = CONFIG.diagnosticThresholds;
  const b = [];
  const push = (severity, text) => b.push({ severity, text });

  if (i.agreementsMismatch) {
    push('critical', "Agreements figures don't add up: Renewed + Partial + Not Renewed ≠ Total — double-check these numbers.");
  }

  if (i.renewalRate !== null) {
    if (i.renewalRate < T.renewalRate.critical) push('critical', `Critical renewal rate (${fmt(i.renewalRate,1)}%) in ${i.quarter} — high risk of revenue loss.`);
    else if (i.renewalRate < T.renewalRate.belowTarget) push('warning', `Renewal rate below target (${fmt(i.renewalRate,1)}%) in ${i.quarter}.`);
    else if (i.renewalRate >= T.renewalRate.excellent) push('good', `Excellent renewal rate (${fmt(i.renewalRate,1)}%) in ${i.quarter}.`);
  }
  if (m.notRenewedRatio !== null && m.notRenewedRatio > T.notRenewedRatio) {
    push('serious', `${(m.notRenewedRatio*100).toFixed(0)}% of agreements did not renew in ${i.quarter}.`);
  }
  if (m.partialRatio !== null && m.partialRatio > T.partialRatio) {
    push('warning', `Significant share of partial renewals (${(m.partialRatio*100).toFixed(0)}%) — possible seat downgrades.`);
  }
  if (i.clmStatus === 'inactive') {
    push('warning', 'CLM not active — reseller is outside the lifecycle management program, higher risk of silent churn.');
  } else if (i.clmStatus === 'active') {
    push('good', 'CLM active — reseller benefits from structured account monitoring.');
  }
  if (m.valueRangeRisk === 'systemic') {
    push('critical', 'Renewal weakness is broad-based across both low- and high-value accounts, not isolated to one segment.');
  } else if (m.valueRangeRisk === 'high') {
    push('serious', 'Renewal losses are concentrated in high-value accounts ($10k+) — disproportionate revenue impact.');
  } else if (m.valueRangeRisk === 'low') {
    push('warning', 'Renewal losses are concentrated in low-value accounts — limited revenue impact but worth monitoring.');
  }

  if (i.arrGrowth !== null) {
    if (i.arrGrowth < T.arrGrowth.declineBelow) push('serious', `ARR declining (${fmt(i.arrGrowth,1)}%) in ${i.quarter}.`);
    else if (i.arrGrowth > T.arrGrowth.strongAbove) push('good', `Strong ARR growth (${fmt(i.arrGrowth,1)}%) in ${i.quarter}.`);
  }
  if (m.salesGrowthPct !== null) {
    if (m.salesGrowthPct < T.salesGrowth.declineBelow) push('serious', `Trailing 12-month sales down (${fmt(m.salesGrowthPct,1)}%) vs. the prior period.`);
    else if (m.salesGrowthPct > T.salesGrowth.robustAbove) push('good', `Robust trailing 12-month sales growth (+${fmt(m.salesGrowthPct,1)}%).`);
  }
  if (m.paceRatio !== null) {
    if (m.paceRatio < T.paceRatio.belowAverage) push('warning', 'Current month is pacing below the monthly average.');
    else if (m.paceRatio > T.paceRatio.aboveAverage) push('good', 'Current month is pacing above the monthly average.');
  }
  if (i.nsbDelta !== null) {
    if (i.nsbDelta < T.nsbDelta.declineBelow) push('warning', `NSB down (${fmt(i.nsbDelta,1)}%) over the trailing 12 months.`);
    else if (i.nsbDelta > T.nsbDelta.strongAbove) push('good', `NSB expanding strongly (+${fmt(i.nsbDelta,1)}%) over the trailing 12 months.`);
  }
  if (i.licensesDelta !== null) {
    if (i.licensesDelta < T.licensesDelta.declineBelow) push('warning', `License base shrinking (${fmt(i.licensesDelta,1)}%).`);
    else if (i.licensesDelta > T.licensesDelta.expandingAbove) push('good', `License base expanding (+${fmt(i.licensesDelta,1)}%).`);
  }
  if (i.endUsersDelta !== null) {
    if (i.endUsersDelta < T.endUsersDelta.declineBelow) push('warning', 'End-user count is declining.');
    else if (i.endUsersDelta > T.endUsersDelta.healthyAbove) push('good', 'Healthy growth in end-user count.');
  }

  if (m.sizeShare !== null) {
    const sb = sizeBand(m.sizeShare);
    push('neutral', `"${sb.label}"-sized reseller — represents ${fmt(m.sizeShare,1)}% of the in-country business.`);
  }

  if (m.arPct !== null && m.arBenchmark !== null) {
    const gap = m.arPct - m.arBenchmark;
    if (gap < T.autoRenewGap.wellBelow) push('serious', `Auto-renew well below the reference (${fmt(m.arPct,1)}% vs ${fmt(m.arBenchmark,1)}%) — operational risk of passive churn.`);
    else if (gap > T.autoRenewGap.above) push('good', `Auto-renew above the reference (${fmt(m.arPct,1)}% vs ${fmt(m.arBenchmark,1)}%) — good protection against passive churn.`);
  }

  const uv = m.upsellByPath;
  if (uv.studio.count) push('neutral', `${uv.studio.count} ${uv.studio.unit} eligible for Acrobat Standard/Pro → Studio upgrade.`);
  if (uv.proplus.count) push('neutral', `${uv.proplus.count} ${uv.proplus.unit} eligible for Creative Cloud Pro → Pro Plus upgrade.`);
  if (uv.ent4.count) push('neutral', `${uv.ent4.count} ${uv.ent4.unit} eligible for Creative Cloud Pro Plus → Enterprise Edition 4 upgrade.`);
  if (m.upsellRatio !== null && m.upsellRatio > T.upsellRatio.highPotentialAbove) {
    push('neutral', `High upsell potential: ${fmt(m.upsellRatio,0)}% of the license base has an identified upgrade path.`);
  }

  if (b.length === 0) push('neutral', 'Not enough data to generate a diagnosis — fill in more fields.');
  return b
    .sort((a, c) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[c.severity])
    .map(x => x.text);
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

const LANG_NAMES = { en: 'English', pt: 'Portuguese', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian', nl: 'Dutch', pl: 'Polish', cs: 'Czech', ro: 'Romanian', sv: 'Swedish', no: 'Norwegian', da: 'Danish', fi: 'Finnish' };

function tr(dict, lang, label) {
  return (dict[lang] && dict[lang][label]) || label.toLowerCase();
}

const RISK_LABEL = {
  en: { Low: 'low', Medium: 'medium', High: 'high', Critical: 'critical' },
  pt: { Low: 'baixo', Medium: 'médio', High: 'alto', Critical: 'crítico' },
  es: { Low: 'bajo', Medium: 'medio', High: 'alto', Critical: 'crítico' },
  fr: { Low: 'faible', Medium: 'moyen', High: 'élevé', Critical: 'critique' },
  de: { Low: 'niedrig', Medium: 'mittel', High: 'hoch', Critical: 'kritisch' },
  it: { Low: 'basso', Medium: 'medio', High: 'alto', Critical: 'critico' },
  nl: { Low: 'laag', Medium: 'gemiddeld', High: 'hoog', Critical: 'kritiek' },
  pl: { Low: 'niskie', Medium: 'średnie', High: 'wysokie', Critical: 'krytyczne' },
  cs: { Low: 'nízké', Medium: 'střední', High: 'vysoké', Critical: 'kritické' },
  ro: { Low: 'scăzut', Medium: 'mediu', High: 'ridicat', Critical: 'critic' },
  sv: { Low: 'låg', Medium: 'medel', High: 'hög', Critical: 'kritisk' },
  no: { Low: 'lav', Medium: 'middels', High: 'høy', Critical: 'kritisk' },
  da: { Low: 'lav', Medium: 'middel', High: 'høj', Critical: 'kritisk' },
  fi: { Low: 'matala', Medium: 'keskitasoinen', High: 'korkea', Critical: 'kriittinen' },
};

const OPPORTUNITY_LABEL = {
  en: { Low: 'low', Medium: 'medium', High: 'high', None: 'none' },
  pt: { Low: 'baixa', Medium: 'média', High: 'alta', None: 'nenhuma' },
  es: { Low: 'baja', Medium: 'media', High: 'alta', None: 'ninguna' },
  fr: { Low: 'faible', Medium: 'moyenne', High: 'élevée', None: 'aucune' },
  de: { Low: 'niedrig', Medium: 'mittel', High: 'hoch', None: 'keine' },
  it: { Low: 'bassa', Medium: 'media', High: 'alta', None: 'nessuna' },
  nl: { Low: 'laag', Medium: 'gemiddeld', High: 'hoog', None: 'geen' },
  pl: { Low: 'niska', Medium: 'średnia', High: 'wysoka', None: 'brak' },
  cs: { Low: 'nízká', Medium: 'střední', High: 'vysoká', None: 'žádná' },
  ro: { Low: 'scăzută', Medium: 'medie', High: 'ridicată', None: 'niciuna' },
  sv: { Low: 'låg', Medium: 'medel', High: 'hög', None: 'ingen' },
  no: { Low: 'lav', Medium: 'middels', High: 'høy', None: 'ingen' },
  da: { Low: 'lav', Medium: 'middel', High: 'høj', None: 'ingen' },
  fi: { Low: 'matala', Medium: 'keskitasoinen', High: 'korkea', None: 'ei mitään' },
};

const PRIORITY_LABEL = {
  en: { Low: 'low', Medium: 'medium', High: 'high', 'Very High': 'very high' },
  pt: { Low: 'baixa', Medium: 'média', High: 'alta', 'Very High': 'muito alta' },
  es: { Low: 'baja', Medium: 'media', High: 'alta', 'Very High': 'muy alta' },
  fr: { Low: 'faible', Medium: 'moyenne', High: 'élevée', 'Very High': 'très élevée' },
  de: { Low: 'niedrig', Medium: 'mittel', High: 'hoch', 'Very High': 'sehr hoch' },
  it: { Low: 'bassa', Medium: 'media', High: 'alta', 'Very High': 'molto alta' },
  nl: { Low: 'laag', Medium: 'gemiddeld', High: 'hoog', 'Very High': 'zeer hoog' },
  pl: { Low: 'niski', Medium: 'średni', High: 'wysoki', 'Very High': 'bardzo wysoki' },
  cs: { Low: 'nízká', Medium: 'střední', High: 'vysoká', 'Very High': 'velmi vysoká' },
  ro: { Low: 'scăzută', Medium: 'medie', High: 'ridicată', 'Very High': 'foarte ridicată' },
  sv: { Low: 'låg', Medium: 'medel', High: 'hög', 'Very High': 'mycket hög' },
  no: { Low: 'lav', Medium: 'middels', High: 'høy', 'Very High': 'svært høy' },
  da: { Low: 'lav', Medium: 'middel', High: 'høj', 'Very High': 'meget høj' },
  fi: { Low: 'matala', Medium: 'keskitasoinen', High: 'korkea', 'Very High': 'erittäin korkea' },
};

const GROWTH_LABEL = {
  en: { 'Strong growth': 'strong growth', Growth: 'growth', Stable: 'stable', Decline: 'declining' },
  pt: { 'Strong growth': 'crescimento forte', Growth: 'crescimento', Stable: 'estável', Decline: 'em declínio' },
  es: { 'Strong growth': 'crecimiento fuerte', Growth: 'crecimiento', Stable: 'estable', Decline: 'en declive' },
  fr: { 'Strong growth': 'forte croissance', Growth: 'croissance', Stable: 'stable', Decline: 'en déclin' },
  de: { 'Strong growth': 'starkes Wachstum', Growth: 'Wachstum', Stable: 'stabil', Decline: 'rückläufig' },
  it: { 'Strong growth': 'crescita forte', Growth: 'crescita', Stable: 'stabile', Decline: 'in calo' },
  nl: { 'Strong growth': 'sterke groei', Growth: 'groei', Stable: 'stabiel', Decline: 'dalend' },
  pl: { 'Strong growth': 'silny wzrost', Growth: 'wzrost', Stable: 'stabilny', Decline: 'spadek' },
  cs: { 'Strong growth': 'silný růst', Growth: 'růst', Stable: 'stabilní', Decline: 'v poklesu' },
  ro: { 'Strong growth': 'creștere puternică', Growth: 'creștere', Stable: 'stabil', Decline: 'în declin' },
  sv: { 'Strong growth': 'stark tillväxt', Growth: 'tillväxt', Stable: 'stabil', Decline: 'nedåtgående' },
  no: { 'Strong growth': 'sterk vekst', Growth: 'vekst', Stable: 'stabil', Decline: 'nedadgående' },
  da: { 'Strong growth': 'stærk vækst', Growth: 'vækst', Stable: 'stabil', Decline: 'nedadgående' },
  fi: { 'Strong growth': 'vahva kasvu', Growth: 'kasvu', Stable: 'vakaa', Decline: 'laskeva' },
};

const AUTORENEW_LABEL = {
  en: { 'Above average': 'above average', 'At average': 'at average', 'Below average': 'below average' },
  pt: { 'Above average': 'acima da média', 'At average': 'na média', 'Below average': 'abaixo da média' },
  es: { 'Above average': 'por encima de la media', 'At average': 'en la media', 'Below average': 'por debajo de la media' },
  fr: { 'Above average': 'au-dessus de la moyenne', 'At average': 'dans la moyenne', 'Below average': 'en dessous de la moyenne' },
  de: { 'Above average': 'über dem Durchschnitt', 'At average': 'im Durchschnitt', 'Below average': 'unter dem Durchschnitt' },
  it: { 'Above average': 'sopra la media', 'At average': 'nella media', 'Below average': 'sotto la media' },
  nl: { 'Above average': 'boven gemiddeld', 'At average': 'gemiddeld', 'Below average': 'onder gemiddeld' },
  pl: { 'Above average': 'powyżej średniej', 'At average': 'na poziomie średnim', 'Below average': 'poniżej średniej' },
  cs: { 'Above average': 'nad průměrem', 'At average': 'na průměru', 'Below average': 'pod průměrem' },
  ro: { 'Above average': 'peste medie', 'At average': 'la medie', 'Below average': 'sub medie' },
  sv: { 'Above average': 'över genomsnittet', 'At average': 'på genomsnittet', 'Below average': 'under genomsnittet' },
  no: { 'Above average': 'over gjennomsnittet', 'At average': 'på gjennomsnittet', 'Below average': 'under gjennomsnittet' },
  da: { 'Above average': 'over gennemsnittet', 'At average': 'på gennemsnittet', 'Below average': 'under gennemsnittet' },
  fi: { 'Above average': 'keskiarvon yläpuolella', 'At average': 'keskiarvon tasolla', 'Below average': 'keskiarvon alapuolella' },
};

const UNIT_LABEL = {
  en: { licenses: 'licenses', agreements: 'agreements' },
  pt: { licenses: 'licenças', agreements: 'acordos' },
  es: { licenses: 'licencias', agreements: 'acuerdos' },
  fr: { licenses: 'licences', agreements: 'accords' },
  de: { licenses: 'Lizenzen', agreements: 'Vereinbarungen' },
  it: { licenses: 'licenze', agreements: 'accordi' },
  nl: { licenses: 'licenties', agreements: 'overeenkomsten' },
  pl: { licenses: 'licencje', agreements: 'umowy' },
  cs: { licenses: 'licencí', agreements: 'smluv' },
  ro: { licenses: 'licențe', agreements: 'acorduri' },
  sv: { licenses: 'licenser', agreements: 'avtal' },
  no: { licenses: 'lisenser', agreements: 'avtaler' },
  da: { licenses: 'licenser', agreements: 'aftaler' },
  fi: { licenses: 'lisenssiä', agreements: 'sopimusta' },
};

const NEXT_ACTION_TRANSLATIONS = {
  escalateLarge: {
    pt: 'Ação urgente: escale para um gestor de conta sénior e agende uma chamada de retenção esta semana — um reseller de grande dimensão está em risco crítico.',
    es: 'Acción urgente: escale el caso a un gestor de cuentas sénior y programe una llamada de retención esta semana — un reseller de gran tamaño está en riesgo crítico.',
    fr: 'Action urgente : transmettez le dossier à un gestionnaire de compte senior et planifiez un appel de rétention cette semaine — un revendeur important est en risque critique.',
    de: 'Dringende Maßnahme: An einen Senior Account Manager eskalieren und diese Woche einen Bindungs-Call vereinbaren — ein großer Reseller befindet sich in kritischem Risiko.',
    it: 'Azione urgente: escalation a un account manager senior e pianificare una chiamata di retention questa settimana — un reseller di grandi dimensioni è a rischio critico.',
    nl: 'Urgente actie: escaleer naar een senior accountmanager en plan deze week een retentiegesprek — een grote reseller loopt een kritiek risico.',
    pl: 'Pilne działanie: eskaluj sprawę do starszego opiekuna klienta i zaplanuj w tym tygodniu rozmowę retencyjną — duży reseller jest w krytycznym stanie ryzyka.',
    cs: 'Naléhavá akce: eskalujte na seniorního account manažera a naplánujte tento týden retenční hovor — velký reseller je v kritickém riziku.',
    ro: 'Acțiune urgentă: escaladați către un account manager senior și programați un apel de retenție săptămâna aceasta — un reseller mare este în risc critic.',
    sv: 'Brådskande åtgärd: eskalera till en senior account manager och boka ett retentionssamtal denna vecka — en stor återförsäljare befinner sig i kritisk risk.',
    no: 'Hastetiltak: eskaler til en senior account manager og planlegg en retensjonssamtale denne uken — en stor forhandler er i kritisk risiko.',
    da: 'Akut handling: eskalér til en senior account manager og planlæg et fastholdelsesopkald i denne uge — en stor forhandler er i kritisk risiko.',
    fi: 'Kiireellinen toimenpide: eskaloi asia vanhemmalle asiakasvastaavalle ja sovi säilyttämispuhelu tällä viikolla — suuri jälleenmyyjä on kriittisessä riskissä.',
  },
  retentionImmediate: {
    pt: 'Contacte de imediato para definir um plano de retenção; confirme com o reseller o motivo da não renovação.',
    es: 'Contacte de inmediato para definir un plan de retención; confirme con el reseller el motivo de la no renovación.',
    fr: 'Contactez immédiatement pour établir un plan de rétention ; confirmez avec le revendeur la raison du non-renouvellement.',
    de: 'Sofort kontaktieren, um einen Bindungsplan zu erstellen; den Grund für die Nichtverlängerung mit dem Reseller klären.',
    it: 'Contattare immediatamente per definire un piano di retention; confermare con il reseller il motivo del mancato rinnovo.',
    nl: 'Neem onmiddellijk contact op voor een retentieplan; bevestig met de reseller de reden voor het niet verlengen.',
    pl: 'Skontaktuj się natychmiast, aby ustalić plan retencji; potwierdź z resellerem powód braku odnowienia.',
    cs: 'Okamžitě kontaktujte reseller kvůli plánu retence; potvrďte s ním důvod neobnovení.',
    ro: 'Contactați imediat pentru un plan de retenție; confirmați cu resellerul motivul neînnoirii.',
    sv: 'Kontakta omedelbart för en retentionsplan; bekräfta orsaken till den uteblivna förnyelsen med återförsäljaren.',
    no: 'Ta kontakt umiddelbart for en retensjonsplan; bekreft årsaken til manglende fornyelse med forhandleren.',
    da: 'Kontakt straks for at lave en fastholdelsesplan; bekræft årsagen til den manglende fornyelse med forhandleren.',
    fi: 'Ota välittömästi yhteyttä säilyttämissuunnitelman laatimiseksi; vahvista jälleenmyyjältä syy uusimatta jättämiseen.',
  },
  dualOpportunity: {
    pt: 'Oportunidade dupla: aborde o risco de renovação e apresente o upgrade na mesma reunião com o reseller.',
    es: 'Oportunidad doble: aborde el riesgo de renovación y presente el upgrade en la misma reunión con el reseller.',
    fr: 'Double opportunité : traitez le risque de renouvellement et présentez la mise à niveau lors de la même réunion avec le revendeur.',
    de: 'Doppelte Gelegenheit: Das Verlängerungsrisiko ansprechen und das Upgrade im selben Gespräch mit dem Reseller vorstellen.',
    it: "Doppia opportunità: affrontare il rischio di rinnovo e proporre l'upgrade nello stesso incontro con il reseller.",
    nl: 'Dubbele kans: bespreek het verlengingsrisico en presenteer de upgrade tijdens hetzelfde gesprek met de reseller.',
    pl: "Podwójna szansa: omów ryzyko odnowienia i przedstaw propozycję upgrade'u podczas tego samego spotkania z resellerem.",
    cs: 'Dvojitá příležitost: řešte riziko obnovení a nabídněte upgrade na stejné schůzce s resellerem.',
    ro: 'Oportunitate dublă: abordați riscul de reînnoire și prezentați upgrade-ul în aceeași întâlnire cu resellerul.',
    sv: 'Dubbel möjlighet: hantera förnyelserisken och presentera uppgraderingen på samma möte med återförsäljaren.',
    no: 'Dobbel mulighet: ta tak i fornyelsesrisikoen og presenter oppgraderingen i det samme møtet med forhandleren.',
    da: 'Dobbelt mulighed: adressér fornyelsesrisikoen og præsentér opgraderingen på det samme møde med forhandleren.',
    fi: 'Kaksinkertainen mahdollisuus: käsittele uusimisriski ja esittele päivitys samassa tapaamisessa jälleenmyyjän kanssa.',
  },
  accountReview: {
    pt: 'Agende uma revisão de conta para perceber as causas da quebra na renovação antes do próximo ciclo.',
    es: 'Programe una revisión de cuenta para entender las causas de la caída en la renovación antes del próximo ciclo.',
    fr: 'Planifiez une revue de compte pour comprendre les causes de la baisse du renouvellement avant le prochain cycle.',
    de: 'Ein Account-Review planen, um die Ursachen des Rückgangs bei der Verlängerung vor dem nächsten Zyklus zu verstehen.',
    it: "Pianificare una revisione dell'account per comprendere le cause del calo dei rinnovi prima del prossimo ciclo.",
    nl: 'Plan een accountreview om de oorzaken van de terugval in verlenging te begrijpen vóór de volgende cyclus.',
    pl: 'Zaplanuj przegląd konta, aby zrozumieć przyczyny spadku odnowień przed kolejnym cyklem.',
    cs: 'Naplánujte revizi účtu, abyste pochopili příčiny poklesu obnovení před dalším cyklem.',
    ro: 'Programați o revizuire a contului pentru a înțelege cauzele scăderii reînnoirii înainte de următorul ciclu.',
    sv: 'Boka en kontogenomgång för att förstå orsakerna till det sjunkande förnyelsetalet innan nästa cykel.',
    no: 'Planlegg en kontogjennomgang for å forstå årsakene til fornyelsesnedgangen før neste syklus.',
    da: 'Planlæg en kontogennemgang for at forstå årsagerne til fornyelsesnedgangen inden næste cyklus.',
    fi: 'Sovi tilikatselmus, jotta ymmärretään uusimisen laskun syyt ennen seuraavaa kautta.',
  },
  upsellStrongGrowth: {
    pt: 'Momento ideal para uma proposta de upsell — agende uma demonstração do produto de nível superior enquanto o crescimento está forte.',
    es: 'Momento ideal para una propuesta de upsell — programe una demostración del producto de nivel superior mientras el crecimiento es fuerte.',
    fr: 'Moment idéal pour une proposition de montée en gamme — planifiez une démonstration du produit supérieur pendant que la croissance est forte.',
    de: 'Idealer Zeitpunkt für ein Upsell-Angebot — eine Demo des höherwertigen Produkts planen, solange das Wachstum stark ist.',
    it: 'Momento ideale per una proposta di upsell — pianificare una demo del prodotto di livello superiore mentre la crescita è forte.',
    nl: 'Ideaal moment voor een upsell-voorstel — plan een demo van het hogere productniveau terwijl de groei sterk is.',
    pl: 'Idealny moment na propozycję upsellu — zaplanuj demonstrację produktu wyższego poziomu, dopóki wzrost jest silny.',
    cs: 'Ideální okamžik pro nabídku upsellu — naplánujte demo produktu vyšší úrovně, dokud je růst silný.',
    ro: 'Moment ideal pentru o propunere de upsell — programați o demonstrație a produsului de nivel superior cât timp creșterea este puternică.',
    sv: 'Idealiskt tillfälle för ett upsell-erbjudande — boka en demo av produkten på högre nivå medan tillväxten är stark.',
    no: 'Ideelt tidspunkt for et upsell-tilbud — planlegg en demo av produktet på høyere nivå mens veksten er sterk.',
    da: 'Ideelt tidspunkt for et upsell-tilbud — planlæg en demo af produktet på højere niveau, mens væksten er stærk.',
    fi: 'Ihanteellinen hetki lisämyyntitarjoukselle — sovi ylemmän tason tuotteen esittely, kun kasvu on vahvaa.',
  },
  upsellProposal: {
    pt: 'Prepare uma proposta comercial de upgrade e envie um business case dedicado ao reseller.',
    es: 'Prepare una propuesta comercial de upgrade y envíe un business case dedicado al reseller.',
    fr: 'Préparez une proposition commerciale de mise à niveau et envoyez un business case dédié au revendeur.',
    de: 'Ein kommerzielles Upgrade-Angebot vorbereiten und einen eigenen Business Case an den Reseller senden.',
    it: 'Preparare una proposta commerciale di upgrade e inviare un business case dedicato al reseller.',
    nl: 'Stel een commercieel upgradevoorstel op en stuur een specifieke business case naar de reseller.',
    pl: "Przygotuj komercyjną propozycję upgrade'u i wyślij dedykowany business case do resellera.",
    cs: 'Připravte komerční nabídku upgradu a pošlete resellerovi samostatný business case.',
    ro: 'Pregătiți o propunere comercială de upgrade și trimiteți un business case dedicat resellerului.',
    sv: 'Ta fram ett kommersiellt uppgraderingsförslag och skicka ett dedikerat business case till återförsäljaren.',
    no: 'Utarbeid et kommersielt oppgraderingsforslag og send en dedikert business case til forhandleren.',
    da: 'Udarbejd et kommercielt opgraderingsforslag og send en dedikeret business case til forhandleren.',
    fi: 'Laadi kaupallinen päivitysehdotus ja lähetä jälleenmyyjälle oma business case.',
  },
  autoRenewPromote: {
    pt: 'Promova a ativação do auto-renew junto do reseller para reduzir o risco futuro de churn passivo.',
    es: 'Promueva la activación del auto-renew con el reseller para reducir el riesgo futuro de churn pasivo.',
    fr: "Encouragez l'activation du renouvellement automatique auprès du revendeur pour réduire le risque futur de churn passif.",
    de: 'Die Aktivierung der automatischen Verlängerung beim Reseller fördern, um künftiges passives Abwanderungsrisiko zu verringern.',
    it: "Promuovere l'attivazione del rinnovo automatico con il reseller per ridurre il rischio futuro di abbandono passivo.",
    nl: 'Stimuleer de activering van automatisch verlengen bij de reseller om toekomstig passief verloop te verminderen.',
    pl: 'Zachęć resellera do aktywacji automatycznego odnawiania, aby zmniejszyć przyszłe ryzyko biernej rezygnacji.',
    cs: 'Podpořte aktivaci automatického obnovení u resellera, abyste snížili budoucí riziko pasivního odchodu.',
    ro: 'Promovați activarea reînnoirii automate cu resellerul pentru a reduce riscul viitor de pierdere pasivă.',
    sv: 'Uppmuntra aktivering av automatisk förnyelse hos återförsäljaren för att minska framtida risk för passivt bortfall.',
    no: 'Fremme aktivering av automatisk fornyelse hos forhandleren for å redusere fremtidig risiko for passivt frafall.',
    da: 'Fremme aktivering af automatisk fornyelse hos forhandleren for at reducere fremtidig risiko for passivt frafald.',
    fi: 'Kannusta jälleenmyyjää aktivoimaan automaattinen uusiminen, jotta tulevaisuuden passiivinen asiakaspoistuma vähenee.',
  },
  investigateGrowthSlowdown: {
    pt: 'Investigue as causas do abrandamento do crescimento apesar de uma taxa de renovação saudável.',
    es: 'Investigue las causas de la desaceleración del crecimiento a pesar de una tasa de renovación saludable.',
    fr: 'Étudiez les causes du ralentissement de la croissance malgré un taux de renouvellement sain.',
    de: 'Die Ursachen der Wachstumsverlangsamung trotz gesunder Verlängerungsrate untersuchen.',
    it: 'Indagare le cause del rallentamento della crescita nonostante un tasso di rinnovo sano.',
    nl: 'Onderzoek de oorzaken van de groeivertraging ondanks een gezond verlengingspercentage.',
    pl: 'Zbadaj przyczyny spowolnienia wzrostu mimo zdrowego wskaźnika odnowień.',
    cs: 'Prozkoumejte příčiny zpomalení růstu i přes zdravou míru obnovení.',
    ro: 'Investigați cauzele încetinirii creșterii în ciuda unei rate de reînnoire sănătoase.',
    sv: 'Undersök orsakerna till den avtagande tillväxten trots en sund förnyelsegrad.',
    no: 'Undersøk årsakene til den avtagende veksten til tross for en sunn fornyelsesrate.',
    da: 'Undersøg årsagerne til den aftagende vækst på trods af en sund fornyelsesrate.',
    fi: 'Selvitä kasvun hidastumisen syyt terveestä uusimisasteesta huolimatta.',
  },
  emergingInvestment: {
    pt: 'Reseller emergente com crescimento forte — considere investimento adicional na parceria.',
    es: 'Reseller emergente con crecimiento fuerte — considere una inversión adicional en la asociación.',
    fr: 'Revendeur émergent avec une forte croissance — envisagez un investissement supplémentaire dans le partenariat.',
    de: 'Aufstrebender Reseller mit starkem Wachstum — zusätzliche Investition in die Partnerschaft in Erwägung ziehen.',
    it: 'Reseller emergente con forte crescita — valutare un investimento aggiuntivo nella partnership.',
    nl: 'Opkomende reseller met sterke groei — overweeg extra investering in het partnerschap.',
    pl: 'Rozwijający się reseller z silnym wzrostem — rozważ dodatkową inwestycję w partnerstwo.',
    cs: 'Rostoucí reseller se silným růstem — zvažte další investici do partnerství.',
    ro: 'Reseller emergent cu creștere puternică — luați în considerare o investiție suplimentară în parteneriat.',
    sv: 'Framväxande återförsäljare med stark tillväxt — överväg ytterligare investering i partnerskapet.',
    no: 'Fremvoksende forhandler med sterk vekst — vurder ytterligere investering i partnerskapet.',
    da: 'Fremadstormende forhandler med stærk vækst — overvej yderligere investering i partnerskabet.',
    fi: 'Nouseva jälleenmyyjä, jolla on vahva kasvu — harkitse lisäinvestointia kumppanuuteen.',
  },
  regularMonitoring: {
    pt: 'Mantenha o acompanhamento regular; não foi identificada nenhuma ação urgente neste momento.',
    es: 'Mantenga el seguimiento regular; no se ha identificado ninguna acción urgente en este momento.',
    fr: 'Poursuivez le suivi régulier ; aucune action urgente identifiée pour le moment.',
    de: 'Regelmäßige Beobachtung fortsetzen; derzeit keine dringende Maßnahme erforderlich.',
    it: 'Mantenere il monitoraggio regolare; nessuna azione urgente identificata al momento.',
    nl: 'Blijf regelmatig monitoren; op dit moment is geen dringende actie nodig.',
    pl: 'Kontynuuj regularne monitorowanie; obecnie nie zidentyfikowano pilnych działań.',
    cs: 'Pokračujte v pravidelném sledování; v tuto chvíli nebyla identifikována žádná naléhavá akce.',
    ro: 'Continuați monitorizarea regulată; nu a fost identificată nicio acțiune urgentă în acest moment.',
    sv: 'Fortsätt med regelbunden uppföljning; ingen brådskande åtgärd har identifierats för närvarande.',
    no: 'Fortsett med jevnlig oppfølging; ingen hastetiltak er identifisert på nåværende tidspunkt.',
    da: 'Fortsæt med regelmæssig opfølgning; ingen akut handling er identificeret på nuværende tidspunkt.',
    fi: 'Jatka säännöllistä seurantaa; kiireellisiä toimenpiteitä ei ole tällä hetkellä tunnistettu.',
  },
};

function buildNextAction(i, m, lang) {
  const bandLabels = {
    renewalHealth: riskBand(m.renewalHealth).label,
    growth: growthBand(m.growthScore).label,
    upsell: upsellBand(m.upsellScore).label,
    size: sizeBand(m.sizeShare).label,
    autoRenew: autoRenewBand(m.autoRenewScore).label,
  };
  const rule = CONFIG.nextActionRules.find(r => ruleMatches(r.when, bandLabels));
  if (!lang || lang === 'en') return rule.action;
  const translated = NEXT_ACTION_TRANSLATIONS[rule.id];
  return (translated && translated[lang]) || rule.action;
}

// ---------- product recommendation ----------

function buildProductRecommendation(i, m) {
  if (!m.anyUpsellData || !m.dominantPath || m.dominantPath.count === 0) {
    return 'No upgrade opportunities identified in the data provided.';
  }
  const p = m.dominantPath;
  return `Recommended focus: ${p.label} (${p.count} ${p.unit} eligible). This is the highest-volume upgrade path identified for this reseller.`;
}

// ---------- email drafts (3 pragmatic angles per diagnosis, each with an
// optional second draft translated into the reseller's country language) ----------

function money(v) {
  return v === null ? null : '$' + Math.round(v).toLocaleString('en-US');
}

// Pushes a new paragraph, inserting exactly one blank-line separator before
// it — but only when there's prior content to separate from. Prevents the
// double-blank-line bug that plain `parts.push('')` calls produce whenever
// the paragraph before them was conditionally skipped.
function pushPara(parts, text) {
  if (!text) return;
  if (parts.length && parts[parts.length - 1] !== '') parts.push('');
  parts.push(text);
}

function emailContext(i, m) {
  const rBand = riskBand(m.renewalHealth);
  const gBand = growthBand(m.growthScore);
  const name = i.resellerName;
  const subjectName = name ? `${name} — ` : '';
  const renewalPct = i.renewalRate !== null ? fmt(i.renewalRate, 1) + '%' : null;
  return { rBand, gBand, name, subjectName, renewalPct };
}

// English's possessive/article construction, kept exactly as it was before
// this file grew per-language templates — only EMAIL_PHRASES.en uses this.
function numbersForEn(name, quarter) {
  const possessive = name ? name + (/s$/i.test(name) ? '’' : '’s') : null;
  return possessive ? `${possessive} ${quarter}` : (quarter === 'this quarter' ? quarter : `the ${quarter}`);
}

const EMAIL_PHRASES = {
  en: {
    contactPlaceholder: '[Contact Name]',
    greeting: (contact) => `Hi ${contact},`,
    signoff: 'Best regards,',
    yourName: '[Your Name]',
    accountFallback: 'the account',

    retentionSubject: (quarter) => `Renewal check-in — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} renewed, ${notRenewed} not renewed out of ${total} agreements)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) =>
      `${numbersForEn(name, quarter)} renewal rate is at ${pct}${detail}${bad ? ", which is below where we'd like it." : '.'}`,
    valueRangeRiskPhrase: {
      systemic: 'spread fairly evenly across value ranges, including your highest-value accounts',
      high: 'concentrated in your high-value accounts ($10k+)',
      low: 'concentrated in your smaller accounts (under $5k)',
    },
    valueRangeSentence: (text) => `The renewal losses look ${text} — worth a closer look at what's driving that segment.`,
    clmInactiveSentence: "I also noticed CLM tracking isn't active on the account yet — turning it on would give both of us better visibility into upcoming renewal dates and reduce last-minute surprises.",
    autoRenewSentence: (pct, bench) => `Auto-renew is running at ${pct}% versus a ${bench}% benchmark — enabling it on more agreements would take passive churn off the table for future quarters.`,
    retentionProposal: (nextAction) => `Here's what I'd propose: a 20-minute call this week to walk through the accounts at risk, confirm the reasons behind any non-renewals, and agree on a concrete save plan before next quarter's cycle starts. ${nextAction}`,
    retentionClosing: 'What does your calendar look like Wednesday or Thursday?',

    growthSubject: (quarter) => `Growth opportunity — ${quarter}`,
    growthBitArr: (x) => `ARR up ${x}%`,
    growthBitSales: (x) => `sales up ${x}% year-over-year`,
    growthBitLicenses: (x) => `licenses up ${x}%`,
    growthStrongSentence: (name, quarter, detail) => `${numbersForEn(name, quarter)} numbers show real momentum${detail} — congratulations, that's a strong quarter.`,
    growthWeakSentence: (name, quarter, detail) => `${numbersForEn(name, quarter)} numbers${detail} are where I wanted to start this conversation.`,
    upsellFoundSentence1: (count, unit, label) => `While reviewing the account I found a concrete upgrade opportunity: ${count} ${unit} eligible for ${label}.`,
    upsellFoundSentence2: "At current volumes, that's a meaningful expansion opportunity for both sides — happy to put together numbers so you can see the exact impact on your book.",
    upsellNotFoundSentence: "I didn't see upsell-eligible volume flagged on the account yet — worth a quick audit together to confirm, since accounts with this growth profile usually have upgrade headroom somewhere in the license mix.",
    growthNextStep: (nextAction) => `Next step on my side: ${nextAction}`,
    growthClosing: 'Could we grab 30 minutes for a working session on this — happy to bring a draft proposal?',

    qbrSubject: (quarter) => `${quarter} business review`,
    qbrIntro: (name, quarter) => `Ahead of our quarterly check-in, here's a quick summary of where ${name} stands based on ${quarter}'s numbers:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Renewal rate: ${pct}% (${riskLabel} risk)`,
    qbrSalesBullet: (cur, priorSuffix) => `- Sales, trailing 12m: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (vs. ${prior} prior period)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Growth: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (sales ${pct}% YoY)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Auto-renew: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Upgrade opportunity: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} eligible for ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Account size: ${pct}% of the in-country business`,
    qbrOverall: (priorityLabel, nextAction) => `Overall I'd flag this account as ${priorityLabel} priority this quarter. ${nextAction}`,
    qbrClosing: "Let me know a time that works for a 30-minute review — I'll bring the full breakdown.",
  },
  pt: {
    contactPlaceholder: '[Nome do Contacto]',
    greeting: (contact) => `Olá ${contact},`,
    signoff: 'Cumprimentos,',
    yourName: '[O seu nome]',
    accountFallback: 'a conta',

    retentionSubject: (quarter) => `Ponto de situação sobre renovação — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} renovados, ${notRenewed} não renovados de um total de ${total} acordos)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `A taxa de renovação da ${name}` : 'A taxa de renovação';
      return `${subj} no ${quarter} está em ${pct}${detail}${bad ? ', o que está abaixo do que gostaríamos.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'distribuídas de forma relativamente uniforme pelos vários escalões de valor, incluindo as contas de maior valor',
      high: 'concentradas nas contas de maior valor (10 mil dólares ou mais)',
      low: 'concentradas nas contas de menor valor (abaixo de 5 mil dólares)',
    },
    valueRangeSentence: (text) => `As perdas de renovação parecem estar ${text} — vale a pena perceber melhor o que está a causar isto neste segmento.`,
    clmInactiveSentence: 'Também reparei que o acompanhamento por CLM ainda não está ativo nesta conta — ativá-lo dar-nos-ia mais visibilidade sobre as próximas datas de renovação e reduziria surpresas de última hora.',
    autoRenewSentence: (pct, bench) => `O auto-renew está atualmente em ${pct}%, face a um benchmark de ${bench}% — ativá-lo em mais acordos eliminaria o risco de churn passivo nos próximos trimestres.`,
    retentionProposal: (nextAction) => `Proponho o seguinte: uma chamada de 20 minutos esta semana para rever as contas em risco, confirmar os motivos de eventuais não renovações e definir um plano de retenção concreto antes do início do próximo ciclo. ${nextAction}`,
    retentionClosing: 'Como está a sua agenda na quarta ou quinta-feira?',

    growthSubject: (quarter) => `Oportunidade de crescimento — ${quarter}`,
    growthBitArr: (x) => `ARR a subir ${x}%`,
    growthBitSales: (x) => `vendas a subir ${x}% face ao ano anterior`,
    growthBitLicenses: (x) => `licenças a subir ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `Os números da ${name}` : 'Os números';
      return `${subj} no ${quarter} mostram um momentum real${detail} — parabéns, foi um trimestre forte.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `Os números da ${name}` : 'Os números';
      return `${subj} no ${quarter}${detail} foram o ponto de partida desta conversa.`;
    },
    upsellFoundSentence1: (count, unit, label) => `Ao rever a conta, identifiquei uma oportunidade concreta de upgrade: ${count} ${unit} elegíveis para ${label}.`,
    upsellFoundSentence2: 'Aos volumes atuais, esta é uma oportunidade de expansão significativa para ambas as partes — com todo o gosto preparo os números para mostrar o impacto exato na sua carteira.',
    upsellNotFoundSentence: 'Não identifiquei volume elegível para upsell registado na conta até ao momento — vale a pena fazermos uma auditoria rápida em conjunto, já que contas com este perfil de crescimento costumam ter margem de upgrade algures no mix de licenças.',
    growthNextStep: (nextAction) => `Próximo passo da minha parte: ${nextAction}`,
    growthClosing: 'Podemos reservar 30 minutos para uma sessão de trabalho sobre isto — com todo o gosto trago uma proposta preliminar?',

    qbrSubject: (quarter) => `Revisão de negócio — ${quarter}`,
    qbrIntro: (name, quarter) => `Antes do nosso ponto de situação trimestral, aqui fica um resumo rápido de como está a ${name} com base nos números do ${quarter}:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Taxa de renovação: ${pct}% (risco ${riskLabel})`,
    qbrSalesBullet: (cur, priorSuffix) => `- Vendas, últimos 12 meses: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (vs. ${prior} no período anterior)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Crescimento: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (vendas ${pct}% face ao ano anterior)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Auto-renew: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Oportunidade de upgrade: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} elegíveis para ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Dimensão da conta: ${pct}% do negócio no país`,
    qbrOverall: (priorityLabel, nextAction) => `No geral, classificaria esta conta como prioridade ${priorityLabel} este trimestre. ${nextAction}`,
    qbrClosing: 'Diga-me um horário que lhe seja conveniente para uma revisão de 30 minutos — levo a análise completa.',
  },
  es: {
    contactPlaceholder: '[Nombre de Contacto]',
    greeting: (contact) => `Hola ${contact},`,
    signoff: 'Saludos cordiales,',
    yourName: '[Su nombre]',
    accountFallback: 'la cuenta',

    retentionSubject: (quarter) => `Seguimiento de renovación — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} renovados, ${notRenewed} no renovados de un total de ${total} acuerdos)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `La tasa de renovación de ${name}` : 'La tasa de renovación';
      return `${subj} en ${quarter} está en ${pct}${detail}${bad ? ', lo cual está por debajo de lo deseado.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'distribuidas de forma bastante uniforme entre los distintos rangos de valor, incluidas sus cuentas de mayor valor',
      high: 'concentradas en sus cuentas de mayor valor (10.000 USD o más)',
      low: 'concentradas en sus cuentas de menor valor (menos de 5.000 USD)',
    },
    valueRangeSentence: (text) => `Las pérdidas de renovación parecen estar ${text} — vale la pena analizar más de cerca qué está impulsando esto en ese segmento.`,
    clmInactiveSentence: 'También noté que el seguimiento CLM no está activo todavía en la cuenta — activarlo nos daría a ambos mejor visibilidad sobre las próximas fechas de renovación y reduciría sorpresas de última hora.',
    autoRenewSentence: (pct, bench) => `El auto-renew está actualmente en ${pct}%, frente a un benchmark del ${bench}% — activarlo en más acuerdos eliminaría el riesgo de abandono pasivo en los próximos trimestres.`,
    retentionProposal: (nextAction) => `Esto es lo que propongo: una llamada de 20 minutos esta semana para revisar las cuentas en riesgo, confirmar los motivos de cualquier no renovación y acordar un plan de retención concreto antes de que empiece el próximo ciclo. ${nextAction}`,
    retentionClosing: '¿Cómo tiene su agenda el miércoles o el jueves?',

    growthSubject: (quarter) => `Oportunidad de crecimiento — ${quarter}`,
    growthBitArr: (x) => `ARR con un incremento del ${x}%`,
    growthBitSales: (x) => `ventas con un incremento interanual del ${x}%`,
    growthBitLicenses: (x) => `licencias con un incremento del ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `Los números de ${name}` : 'Los números';
      return `${subj} en ${quarter} muestran un impulso real${detail} — felicidades, ha sido un trimestre sólido.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `Los números de ${name}` : 'Los números';
      return `${subj} en ${quarter}${detail} son el punto de partida de esta conversación.`;
    },
    upsellFoundSentence1: (count, unit, label) => `Al revisar la cuenta encontré una oportunidad concreta de upgrade: ${count} ${unit} elegibles para ${label}.`,
    upsellFoundSentence2: 'A los volúmenes actuales, esta es una oportunidad de expansión significativa para ambas partes — con gusto preparo las cifras para que vea el impacto exacto en su cartera.',
    upsellNotFoundSentence: 'No vi volumen elegible para upsell registrado en la cuenta todavía — vale la pena hacer una auditoría rápida juntos, ya que las cuentas con este perfil de crecimiento suelen tener margen de upgrade en algún punto del mix de licencias.',
    growthNextStep: (nextAction) => `Siguiente paso de mi parte: ${nextAction}`,
    growthClosing: '¿Podemos reservar 30 minutos para una sesión de trabajo sobre esto — con gusto traigo una propuesta preliminar?',

    qbrSubject: (quarter) => `Revisión de negocio — ${quarter}`,
    qbrIntro: (name, quarter) => `Antes de nuestra reunión trimestral, aquí tiene un resumen rápido de cómo está ${name} según los números de ${quarter}:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Tasa de renovación: ${pct}% (riesgo ${riskLabel})`,
    qbrSalesBullet: (cur, priorSuffix) => `- Ventas, últimos 12 meses: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (frente a ${prior} en el período anterior)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Crecimiento: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (ventas +${pct}% interanual)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Auto-renew: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Oportunidad de upgrade: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} elegibles para ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Tamaño de la cuenta: ${pct}% del negocio en el país`,
    qbrOverall: (priorityLabel, nextAction) => `En general, calificaría esta cuenta como prioridad ${priorityLabel} este trimestre. ${nextAction}`,
    qbrClosing: 'Avíseme qué horario le conviene para una revisión de 30 minutos — llevaré el desglose completo.',
  },
  fr: {
    contactPlaceholder: '[Nom du Contact]',
    greeting: (contact) => `Bonjour ${contact},`,
    signoff: 'Cordialement,',
    yourName: '[Votre nom]',
    accountFallback: 'le compte',

    retentionSubject: (quarter) => `Point sur le renouvellement — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} renouvelés, ${notRenewed} non renouvelés sur un total de ${total} contrats)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `Le taux de renouvellement de ${name}` : 'Le taux de renouvellement';
      return `${subj} pour ${quarter} est de ${pct}${detail}${bad ? ', ce qui est en dessous de ce que nous souhaiterions.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'réparties de façon assez homogène entre les différentes tranches de valeur, y compris vos comptes à plus forte valeur',
      high: 'concentrées sur vos comptes à forte valeur (10 000 $ ou plus)',
      low: 'concentrées sur vos comptes de plus petite valeur (moins de 5 000 $)',
    },
    valueRangeSentence: (text) => `Les pertes de renouvellement semblent ${text} — cela mérite qu'on regarde de plus près ce qui se passe sur ce segment.`,
    clmInactiveSentence: "J'ai également remarqué que le suivi CLM n'est pas encore activé sur ce compte — l'activer nous donnerait à tous les deux une meilleure visibilité sur les prochaines échéances de renouvellement et réduirait les surprises de dernière minute.",
    autoRenewSentence: (pct, bench) => `Le renouvellement automatique est actuellement à ${pct}%, contre un benchmark de ${bench}% — l'activer sur davantage de contrats permettrait d'éliminer le risque de churn passif pour les prochains trimestres.`,
    retentionProposal: (nextAction) => `Voici ce que je propose : un appel de 20 minutes cette semaine pour passer en revue les comptes à risque, confirmer les raisons des éventuels non-renouvellements et convenir d'un plan de rétention concret avant le début du prochain cycle. ${nextAction}`,
    retentionClosing: 'Quelles sont vos disponibilités mercredi ou jeudi ?',

    growthSubject: (quarter) => `Opportunité de croissance — ${quarter}`,
    growthBitArr: (x) => `ARR en hausse de ${x}%`,
    growthBitSales: (x) => `ventes en hausse de ${x}% sur un an`,
    growthBitLicenses: (x) => `licences en hausse de ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `Les chiffres de ${name}` : 'Les chiffres';
      return `${subj} pour ${quarter} montrent une vraie dynamique${detail} — félicitations, c'est un trimestre solide.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `Les chiffres de ${name}` : 'Les chiffres';
      return `${subj} pour ${quarter}${detail} sont le point de départ de cette conversation.`;
    },
    upsellFoundSentence1: (count, unit, label) => `En examinant le compte, j'ai identifié une opportunité de montée en gamme concrète : ${count} ${unit} éligibles pour ${label}.`,
    upsellFoundSentence2: "Aux volumes actuels, c'est une opportunité d'expansion significative pour les deux parties — je peux volontiers préparer les chiffres pour vous montrer l'impact exact sur votre portefeuille.",
    upsellNotFoundSentence: "Je n'ai pas encore identifié de volume éligible à une montée en gamme sur ce compte — cela vaut la peine de faire un audit rapide ensemble, car les comptes avec ce profil de croissance ont généralement une marge de progression quelque part dans le mix de licences.",
    growthNextStep: (nextAction) => `Prochaine étape de mon côté : ${nextAction}`,
    growthClosing: 'Peut-on bloquer 30 minutes pour une session de travail sur ce sujet — je peux volontiers apporter une proposition préliminaire ?',

    qbrSubject: (quarter) => `Bilan trimestriel — ${quarter}`,
    qbrIntro: (name, quarter) => `Avant notre point trimestriel, voici un résumé rapide de la situation de ${name} sur la base des chiffres de ${quarter} :`,
    qbrRenewalBullet: (pct, riskLabel) => `- Taux de renouvellement : ${pct}% (risque ${riskLabel})`,
    qbrSalesBullet: (cur, priorSuffix) => `- Ventes, 12 derniers mois : ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (contre ${prior} sur la période précédente)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Croissance : ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (ventes +${pct}% sur un an)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Renouvellement automatique : ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Opportunité de montée en gamme : ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} éligibles pour ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Taille du compte : ${pct}% de l'activité dans le pays`,
    qbrOverall: (priorityLabel, nextAction) => `Globalement, je classerais ce compte en priorité ${priorityLabel} ce trimestre. ${nextAction}`,
    qbrClosing: "Dites-moi quel créneau vous conviendrait pour une revue de 30 minutes — j'apporterai le détail complet.",
  },
  de: {
    contactPlaceholder: '[Name des Kontakts]',
    greeting: (contact) => `Hallo ${contact},`,
    signoff: 'Beste Grüße,',
    yourName: '[Ihr Name]',
    accountFallback: 'das Konto',

    retentionSubject: (quarter) => `Update zur Vertragsverlängerung — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} verlängert, ${notRenewed} nicht verlängert von insgesamt ${total} Verträgen)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `Die Verlängerungsrate von ${name}` : 'Die Verlängerungsrate';
      return `${subj} liegt im ${quarter} bei ${pct}${detail}${bad ? ', was unter unserem Zielwert liegt.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'relativ gleichmäßig über die Wertsegmente verteilt, einschließlich Ihrer wertvollsten Konten',
      high: 'auf Ihre wertvollsten Konten konzentriert (10.000 $ oder mehr)',
      low: 'auf Ihre kleineren Konten konzentriert (unter 5.000 $)',
    },
    valueRangeSentence: (text) => `Die Verlängerungsverluste scheinen ${text} zu sein — es lohnt sich, genauer zu prüfen, was dieses Segment antreibt.`,
    clmInactiveSentence: 'Mir ist außerdem aufgefallen, dass das CLM-Tracking für dieses Konto noch nicht aktiv ist — eine Aktivierung würde uns beiden mehr Transparenz über anstehende Verlängerungstermine geben und Last-Minute-Überraschungen reduzieren.',
    autoRenewSentence: (pct, bench) => `Die automatische Verlängerung liegt aktuell bei ${pct}%, gegenüber einem Benchmark von ${bench}% — eine Aktivierung bei mehr Verträgen würde das Risiko passiver Abwanderung für kommende Quartale eliminieren.`,
    retentionProposal: (nextAction) => `Mein Vorschlag: ein 20-minütiges Gespräch diese Woche, um die gefährdeten Konten durchzugehen, die Gründe für etwaige Nichtverlängerungen zu klären und einen konkreten Bindungsplan vor Beginn des nächsten Zyklus zu vereinbaren. ${nextAction}`,
    retentionClosing: 'Wie sieht Ihr Kalender am Mittwoch oder Donnerstag aus?',

    growthSubject: (quarter) => `Wachstumschance — ${quarter}`,
    growthBitArr: (x) => `ARR um ${x}% gestiegen`,
    growthBitSales: (x) => `Umsatz im Jahresvergleich um ${x}% gestiegen`,
    growthBitLicenses: (x) => `Lizenzen um ${x}% gestiegen`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `Die Zahlen von ${name}` : 'Die Zahlen';
      return `${subj} im ${quarter} zeigen echte Dynamik${detail} — Glückwunsch, das war ein starkes Quartal.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `Die Zahlen von ${name}` : 'Die Zahlen';
      return `${subj} im ${quarter}${detail} sind der Ausgangspunkt für dieses Gespräch.`;
    },
    upsellFoundSentence1: (count, unit, label) => `Bei der Durchsicht des Kontos habe ich eine konkrete Upgrade-Möglichkeit gefunden: ${count} ${unit} berechtigt für ${label}.`,
    upsellFoundSentence2: 'Bei den aktuellen Volumina ist das eine bedeutende Expansionsmöglichkeit für beide Seiten — ich stelle gerne Zahlen zusammen, damit Sie die genaue Auswirkung auf Ihr Portfolio sehen können.',
    upsellNotFoundSentence: 'Ich habe bisher noch kein für ein Upsell berechtigtes Volumen auf dem Konto markiert gesehen — es lohnt sich, das gemeinsam kurz zu prüfen, da Konten mit diesem Wachstumsprofil meist irgendwo im Lizenzmix noch Upgrade-Spielraum haben.',
    growthNextStep: (nextAction) => `Nächster Schritt meinerseits: ${nextAction}`,
    growthClosing: 'Können wir 30 Minuten für eine Arbeitssitzung dazu einplanen — ich bringe gerne einen Entwurf mit?',

    qbrSubject: (quarter) => `Geschäftsüberblick ${quarter}`,
    qbrIntro: (name, quarter) => `Vor unserem Quartalsgespräch hier eine kurze Zusammenfassung, wo ${name} auf Basis der Zahlen für ${quarter} steht:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Verlängerungsrate: ${pct}% (Risiko: ${riskLabel})`,
    qbrSalesBullet: (cur, priorSuffix) => `- Umsatz, letzte 12 Monate: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (gegenüber ${prior} im Vorjahreszeitraum)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Wachstum: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (Umsatz +${pct}% im Jahresvergleich)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Automatische Verlängerung: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Upgrade-Möglichkeit: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} berechtigt für ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Kontogröße: ${pct}% des Geschäfts im Land`,
    qbrOverall: (priorityLabel, nextAction) => `Insgesamt würde ich dieses Konto diesem Quartal als Priorität ${priorityLabel} einstufen. ${nextAction}`,
    qbrClosing: 'Sagen Sie mir gerne einen passenden Termin für ein 30-minütiges Review — ich bringe die vollständige Übersicht mit.',
  },
  it: {
    contactPlaceholder: '[Nome del Contatto]',
    greeting: (contact) => `Ciao ${contact},`,
    signoff: 'Cordiali saluti,',
    yourName: '[Il tuo nome]',
    accountFallback: "l'account",

    retentionSubject: (quarter) => `Aggiornamento sul rinnovo — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} rinnovati, ${notRenewed} non rinnovati su un totale di ${total} accordi)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `Il tasso di rinnovo di ${name}` : 'Il tasso di rinnovo';
      return `${subj} nel ${quarter} è pari a ${pct}${detail}${bad ? ', un valore inferiore a quello desiderato.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'distribuite in modo abbastanza uniforme tra le diverse fasce di valore, inclusi gli account di maggior valore',
      high: 'concentrate sugli account di maggior valore (10.000 $ o più)',
      low: 'concentrate sugli account di valore più basso (sotto i 5.000 $)',
    },
    valueRangeSentence: (text) => `Le perdite di rinnovo sembrano essere ${text} — vale la pena approfondire cosa sta succedendo in questo segmento.`,
    clmInactiveSentence: "Ho anche notato che il monitoraggio CLM non è ancora attivo su questo account — attivarlo ci darebbe entrambi una migliore visibilità sulle prossime scadenze di rinnovo e ridurrebbe le sorprese dell'ultimo minuto.",
    autoRenewSentence: (pct, bench) => `Il rinnovo automatico è attualmente al ${pct}%, contro un benchmark del ${bench}% — attivarlo su più accordi eliminerebbe il rischio di abbandono passivo nei prossimi trimestri.`,
    retentionProposal: (nextAction) => `Ecco cosa propongo: una chiamata di 20 minuti questa settimana per rivedere gli account a rischio, confermare i motivi degli eventuali mancati rinnovi e concordare un piano di retention concreto prima dell'inizio del prossimo ciclo. ${nextAction}`,
    retentionClosing: "Come sei messo con l'agenda mercoledì o giovedì?",

    growthSubject: (quarter) => `Opportunità di crescita — ${quarter}`,
    growthBitArr: (x) => `ARR in crescita del ${x}%`,
    growthBitSales: (x) => `vendite in crescita del ${x}% su base annua`,
    growthBitLicenses: (x) => `licenze in crescita del ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `I numeri di ${name}` : 'I numeri';
      return `${subj} nel ${quarter} mostrano un momentum reale${detail} — complimenti, è stato un trimestre forte.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `I numeri di ${name}` : 'I numeri';
      return `${subj} nel ${quarter}${detail} sono il punto di partenza di questa conversazione.`;
    },
    upsellFoundSentence1: (count, unit, label) => `Rivedendo l'account ho individuato un'opportunità concreta di upgrade: ${count} ${unit} idonee per ${label}.`,
    upsellFoundSentence2: "Ai volumi attuali, questa è un'opportunità di espansione significativa per entrambe le parti — sono felice di preparare i numeri per mostrarti l'impatto esatto sul tuo portafoglio.",
    upsellNotFoundSentence: "Non ho ancora individuato volumi idonei per un upsell su questo account — vale la pena fare insieme un audit rapido, dato che gli account con questo profilo di crescita di solito hanno margine di upgrade da qualche parte nel mix di licenze.",
    growthNextStep: (nextAction) => `Prossimo passo da parte mia: ${nextAction}`,
    growthClosing: 'Possiamo fissare 30 minuti per una sessione di lavoro su questo — sono felice di portare una proposta preliminare?',

    qbrSubject: (quarter) => `Revisione trimestrale — ${quarter}`,
    qbrIntro: (name, quarter) => `Prima del nostro punto trimestrale, ecco un rapido riepilogo di come sta andando ${name} in base ai numeri del ${quarter}:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Tasso di rinnovo: ${pct}% (rischio ${riskLabel})`,
    qbrSalesBullet: (cur, priorSuffix) => `- Vendite, ultimi 12 mesi: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (contro ${prior} nel periodo precedente)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Crescita: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (vendite +${pct}% su base annua)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Rinnovo automatico: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Opportunità di upgrade: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} idonee per ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Dimensione dell'account: ${pct}% del business nel paese`,
    qbrOverall: (priorityLabel, nextAction) => `Nel complesso classificherei questo account come priorità ${priorityLabel} questo trimestre. ${nextAction}`,
    qbrClosing: "Fammi sapere un orario comodo per una revisione di 30 minuti — porterò l'analisi completa.",
  },
  nl: {
    contactPlaceholder: '[Naam Contactpersoon]',
    greeting: (contact) => `Hoi ${contact},`,
    signoff: 'Met vriendelijke groet,',
    yourName: '[Uw naam]',
    accountFallback: 'het account',

    retentionSubject: (quarter) => `Update verlenging — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} verlengd, ${notRenewed} niet verlengd van in totaal ${total} overeenkomsten)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `Het verlengingspercentage van ${name}` : 'Het verlengingspercentage';
      return `${subj} staat in ${quarter} op ${pct}${detail}${bad ? ', wat lager is dan gewenst.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'vrij gelijkmatig verspreid over de verschillende waardesegmenten, inclusief uw waardevolste accounts',
      high: 'geconcentreerd bij uw waardevolste accounts ($10k+)',
      low: 'geconcentreerd bij uw kleinere accounts (onder $5k)',
    },
    valueRangeSentence: (text) => `De verlengingsverliezen lijken ${text} — het is de moeite waard om beter te bekijken wat dit in dat segment veroorzaakt.`,
    clmInactiveSentence: 'Ik merkte ook dat CLM-tracking nog niet actief is op dit account — activering zou ons beiden beter zicht geven op aankomende verlengingsdata en verrassingen op het laatste moment verminderen.',
    autoRenewSentence: (pct, bench) => `Automatisch verlengen staat momenteel op ${pct}%, tegenover een benchmark van ${bench}% — activering bij meer overeenkomsten zou het risico op passief verloop voor komende kwartalen wegnemen.`,
    retentionProposal: (nextAction) => `Dit stel ik voor: een gesprek van 20 minuten deze week om de accounts met risico door te nemen, de redenen voor eventuele niet-verlengingen te bevestigen en een concreet retentieplan af te spreken vóór de start van de volgende cyclus. ${nextAction}`,
    retentionClosing: 'Hoe ziet uw agenda eruit op woensdag of donderdag?',

    growthSubject: (quarter) => `Groeikans — ${quarter}`,
    growthBitArr: (x) => `ARR met ${x}% gestegen`,
    growthBitSales: (x) => `omzet jaar-op-jaar met ${x}% gestegen`,
    growthBitLicenses: (x) => `licenties met ${x}% gestegen`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `De cijfers van ${name}` : 'De cijfers';
      return `${subj} in ${quarter} laten echte momentum zien${detail} — gefeliciteerd, dat was een sterk kwartaal.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `De cijfers van ${name}` : 'De cijfers';
      return `${subj} in ${quarter}${detail} vormen het startpunt van dit gesprek.`;
    },
    upsellFoundSentence1: (count, unit, label) => `Bij het doornemen van het account vond ik een concrete upgrademogelijkheid: ${count} ${unit} in aanmerking voor ${label}.`,
    upsellFoundSentence2: 'Bij de huidige volumes is dit een betekenisvolle uitbreidingskans voor beide partijen — ik stel graag de cijfers samen zodat u de exacte impact op uw portefeuille kunt zien.',
    upsellNotFoundSentence: 'Ik heb tot nu toe geen voor upsell in aanmerking komend volume op het account gezien — het is de moeite waard om samen een korte audit te doen, aangezien accounts met dit groeiprofiel meestal ergens in de licentiemix nog ruimte voor upgrades hebben.',
    growthNextStep: (nextAction) => `Volgende stap van mijn kant: ${nextAction}`,
    growthClosing: 'Kunnen we 30 minuten inplannen voor een werksessie hierover — ik breng graag een conceptvoorstel mee?',

    qbrSubject: (quarter) => `Kwartaaloverzicht — ${quarter}`,
    qbrIntro: (name, quarter) => `Voorafgaand aan ons kwartaaloverleg, hier een kort overzicht van hoe ${name} ervoor staat op basis van de cijfers van ${quarter}:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Verlengingspercentage: ${pct}% (risico: ${riskLabel})`,
    qbrSalesBullet: (cur, priorSuffix) => `- Omzet, afgelopen 12 maanden: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (tegenover ${prior} in de vorige periode)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Groei: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (omzet +${pct}% jaar-op-jaar)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Automatisch verlengen: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Upgrademogelijkheid: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} in aanmerking voor ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Omvang account: ${pct}% van de business in het land`,
    qbrOverall: (priorityLabel, nextAction) => `Over het geheel genomen zou ik dit account dit kwartaal als prioriteit ${priorityLabel} bestempelen. ${nextAction}`,
    qbrClosing: 'Laat weten welk tijdstip u schikt voor een review van 30 minuten — ik neem de volledige uitsplitsing mee.',
  },
  pl: {
    contactPlaceholder: '[Imię Kontaktu]',
    greeting: (contact) => `Cześć ${contact},`,
    signoff: 'Pozdrawiam,',
    yourName: '[Twoje imię]',
    accountFallback: 'konto',

    retentionSubject: (quarter) => `Aktualizacja dot. odnowienia — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} odnowionych, ${notRenewed} nieodnowionych z łącznie ${total} umów)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `Wskaźnik odnowień dla ${name}` : 'Wskaźnik odnowień';
      return `${subj} w ${quarter} wynosi ${pct}${detail}${bad ? ', co jest poniżej oczekiwanego poziomu.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'rozłożone dość równomiernie w różnych przedziałach wartości, w tym w kontach o najwyższej wartości',
      high: 'skoncentrowane w kontach o wysokiej wartości (10 000 USD lub więcej)',
      low: 'skoncentrowane w mniejszych kontach (poniżej 5000 USD)',
    },
    valueRangeSentence: (text) => `Straty odnowień wydają się ${text} — warto bliżej przyjrzeć się, co za tym stoi w tym segmencie.`,
    clmInactiveSentence: 'Zauważyłem też, że śledzenie CLM nie jest jeszcze aktywne na tym koncie — jego aktywacja dałaby nam obu lepszy wgląd w nadchodzące terminy odnowień i zmniejszyła liczbę niespodzianek w ostatniej chwili.',
    autoRenewSentence: (pct, bench) => `Automatyczne odnawianie wynosi obecnie ${pct}%, wobec benchmarku ${bench}% — aktywacja przy większej liczbie umów wyeliminowałaby ryzyko biernej rezygnacji w kolejnych kwartałach.`,
    retentionProposal: (nextAction) => `Oto co proponuję: 20-minutowa rozmowa w tym tygodniu, aby przejrzeć konta zagrożone, potwierdzić przyczyny ewentualnych nieodnowień i ustalić konkretny plan retencji przed rozpoczęciem kolejnego cyklu. ${nextAction}`,
    retentionClosing: 'Jak wygląda Twój kalendarz w środę lub czwartek?',

    growthSubject: (quarter) => `Szansa na wzrost — ${quarter}`,
    growthBitArr: (x) => `ARR wzrósł o ${x}%`,
    growthBitSales: (x) => `sprzedaż wzrosła o ${x}% rok do roku`,
    growthBitLicenses: (x) => `liczba licencji wzrosła o ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `Wyniki ${name}` : 'Wyniki';
      return `${subj} w ${quarter} pokazują realny impet${detail} — gratulacje, to był mocny kwartał.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `Wyniki ${name}` : 'Wyniki';
      return `${subj} w ${quarter}${detail} są punktem wyjścia do tej rozmowy.`;
    },
    upsellFoundSentence1: (count, unit, label) => `Podczas przeglądu konta znalazłem konkretną szansę na upgrade: ${count} ${unit} kwalifikujących się do ${label}.`,
    upsellFoundSentence2: 'Przy obecnych wolumenach to znacząca szansa na ekspansję dla obu stron — chętnie przygotuję liczby, aby pokazać dokładny wpływ na Twój portfel.',
    upsellNotFoundSentence: "Nie zauważyłem jeszcze na koncie wolumenu kwalifikującego się do upsellu — warto wspólnie przeprowadzić szybki audyt, ponieważ konta o takim profilu wzrostu zwykle mają gdzieś w miksie licencji zapas do upgrade'u.",
    growthNextStep: (nextAction) => `Kolejny krok z mojej strony: ${nextAction}`,
    growthClosing: 'Czy możemy zarezerwować 30 minut na sesję roboczą w tej sprawie — chętnie przygotuję wstępną propozycję?',

    qbrSubject: (quarter) => `Przegląd biznesowy — ${quarter}`,
    qbrIntro: (name, quarter) => `Przed naszym kwartalnym podsumowaniem, oto krótkie zestawienie sytuacji ${name} na podstawie danych za ${quarter}:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Wskaźnik odnowień: ${pct}% (ryzyko: ${riskLabel})`,
    qbrSalesBullet: (cur, priorSuffix) => `- Sprzedaż, ostatnie 12 miesięcy: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (wobec ${prior} w poprzednim okresie)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Wzrost: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (sprzedaż +${pct}% rok do roku)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Automatyczne odnawianie: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Szansa na upgrade: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} kwalifikujących się do ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Wielkość konta: ${pct}% biznesu w kraju`,
    qbrOverall: (priorityLabel, nextAction) => `Ogólnie sklasyfikowałbym to konto jako priorytet ${priorityLabel} w tym kwartale. ${nextAction}`,
    qbrClosing: 'Daj znać, jaki termin pasuje na 30-minutowy przegląd — przygotuję pełne zestawienie.',
  },
  cs: {
    contactPlaceholder: '[Jméno kontaktu]',
    greeting: (contact) => `Dobrý den ${contact},`,
    signoff: 'S pozdravem,',
    yourName: '[Vaše jméno]',
    accountFallback: 'účet',

    retentionSubject: (quarter) => `Aktualizace obnovení — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} obnoveno, ${notRenewed} neobnoveno z celkových ${total} smluv)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `Míra obnovení pro ${name}` : 'Míra obnovení';
      return `${subj} v ${quarter} je ${pct}${detail}${bad ? ', což je pod naším cílem.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'rozložené poměrně rovnoměrně napříč hodnotovými pásmy, včetně vašich nejhodnotnějších účtů',
      high: 'soustředěné na vaše nejhodnotnější účty (10 000 $ a více)',
      low: 'soustředěné na vaše menší účty (pod 5 000 $)',
    },
    valueRangeSentence: (text) => `Ztráty při obnovení vypadají jako ${text} — stojí za to se blíže podívat, co tento segment ovlivňuje.`,
    clmInactiveSentence: 'Také jsem si všiml(a), že sledování CLM není u tohoto účtu ještě aktivní — jeho aktivace by nám oběma dala lepší přehled o nadcházejících termínech obnovení a snížila počet překvapení na poslední chvíli.',
    autoRenewSentence: (pct, bench) => `Automatické obnovení je aktuálně na ${pct}% oproti benchmarku ${bench}% — jeho aktivace u více smluv by do budoucích čtvrtletí eliminovala riziko pasivního odchodu.`,
    retentionProposal: (nextAction) => `Navrhuji následující: 20minutový hovor tento týden, abychom prošli ohrožené účty, potvrdili důvody případných neobnovení a domluvili konkrétní plán retence před začátkem dalšího cyklu. ${nextAction}`,
    retentionClosing: 'Jak vypadá váš kalendář ve středu nebo ve čtvrtek?',

    growthSubject: (quarter) => `Příležitost k růstu — ${quarter}`,
    growthBitArr: (x) => `ARR vzrostlo o ${x}%`,
    growthBitSales: (x) => `tržby meziročně vzrostly o ${x}%`,
    growthBitLicenses: (x) => `počet licencí vzrostl o ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `Čísla ${name}` : 'Tato čísla';
      return `${subj} za ${quarter} ukazují skutečnou dynamiku${detail} — gratuluji, byl to silný kvartál.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `Čísla ${name}` : 'Tato čísla';
      return `${subj} za ${quarter}${detail} jsou výchozím bodem tohoto rozhovoru.`;
    },
    upsellFoundSentence1: (count, unit, label) => `Při kontrole účtu jsem našel(a) konkrétní příležitost k upgradu: ${count} ${unit} způsobilých pro ${label}.`,
    upsellFoundSentence2: 'Při aktuálních objemech jde o významnou příležitost k rozšíření pro obě strany — rád(a) připravím čísla, abyste viděli přesný dopad na váš portfolio.',
    upsellNotFoundSentence: 'Zatím jsem na účtu nezaznamenal(a) žádný objem způsobilý pro upsell — stojí za to společně provést rychlý audit, protože účty s tímto růstovým profilem obvykle mají prostor pro upgrade někde v mixu licencí.',
    growthNextStep: (nextAction) => `Další krok z mé strany: ${nextAction}`,
    growthClosing: 'Můžeme si na to vyhradit 30 minut na pracovní schůzku — rád(a) přinesu předběžný návrh?',

    qbrSubject: (quarter) => `Obchodní přehled — ${quarter}`,
    qbrIntro: (name, quarter) => `Před naším čtvrtletním setkáním zde máte rychlý přehled toho, jak si ${name} stojí na základě čísel za ${quarter}:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Míra obnovení: ${pct}% (riziko ${riskLabel})`,
    qbrSalesBullet: (cur, priorSuffix) => `- Tržby, posledních 12 měsíců: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (oproti ${prior} v předchozím období)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Růst: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (tržby +${pct}% meziročně)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Automatické obnovení: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Příležitost k upgradu: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} způsobilých pro ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Velikost účtu: ${pct}% obchodu v dané zemi`,
    qbrOverall: (priorityLabel, nextAction) => `Celkově bych toto čtvrtletí hodnotil(a) tento účet jako prioritu ${priorityLabel}. ${nextAction}`,
    qbrClosing: 'Dejte mi vědět, jaký termín vám vyhovuje na 30minutovou revizi — přinesu kompletní rozbor.',
  },
  ro: {
    contactPlaceholder: '[Numele Contactului]',
    greeting: (contact) => `Bună ${contact},`,
    signoff: 'Cu stimă,',
    yourName: '[Numele dumneavoastră]',
    accountFallback: 'contul',

    retentionSubject: (quarter) => `Actualizare privind reînnoirea — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} reînnoite, ${notRenewed} neînnoite dintr-un total de ${total} contracte)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `Rata de reînnoire pentru ${name}` : 'Rata de reînnoire';
      return `${subj} în ${quarter} este de ${pct}${detail}${bad ? ', ceea ce este sub nivelul dorit.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'distribuite destul de uniform pe intervalele de valoare, inclusiv conturile dvs. cu cea mai mare valoare',
      high: 'concentrate pe conturile dvs. cu valoare mare (10.000 $ sau mai mult)',
      low: 'concentrate pe conturile dvs. mai mici (sub 5.000 $)',
    },
    valueRangeSentence: (text) => `Pierderile de reînnoire par a fi ${text} — merită să analizăm mai atent ce cauzează acest lucru în acel segment.`,
    clmInactiveSentence: 'Am observat, de asemenea, că monitorizarea CLM nu este încă activă pe acest cont — activarea ei ne-ar oferi amândurora o vizibilitate mai bună asupra următoarelor date de reînnoire și ar reduce surprizele de ultim moment.',
    autoRenewSentence: (pct, bench) => `Reînnoirea automată este în prezent la ${pct}%, față de un benchmark de ${bench}% — activarea ei pe mai multe contracte ar elimina riscul de pierdere pasivă pentru trimestrele viitoare.`,
    retentionProposal: (nextAction) => `Iată ce propun: un apel de 20 de minute săptămâna aceasta pentru a trece în revistă conturile cu risc, a confirma motivele eventualelor neînnoiri și a stabili un plan concret de retenție înainte de începerea ciclului următor. ${nextAction}`,
    retentionClosing: 'Cum arată agenda dumneavoastră miercuri sau joi?',

    growthSubject: (quarter) => `Oportunitate de creștere — ${quarter}`,
    growthBitArr: (x) => `ARR în creștere cu ${x}%`,
    growthBitSales: (x) => `vânzări în creștere cu ${x}% față de anul trecut`,
    growthBitLicenses: (x) => `licențe în creștere cu ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `Cifrele ${name}` : 'Aceste cifre';
      return `${subj} pentru ${quarter} arată un impuls real${detail} — felicitări, a fost un trimestru solid.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `Cifrele ${name}` : 'Aceste cifre';
      return `${subj} pentru ${quarter}${detail} sunt punctul de plecare al acestei discuții.`;
    },
    upsellFoundSentence1: (count, unit, label) => `În timp ce am examinat contul, am identificat o oportunitate concretă de upgrade: ${count} ${unit} eligibile pentru ${label}.`,
    upsellFoundSentence2: 'La volumele actuale, aceasta este o oportunitate de extindere semnificativă pentru ambele părți — pot pregăti cu plăcere cifrele pentru a vedea impactul exact asupra portofoliului dumneavoastră.',
    upsellNotFoundSentence: 'Nu am observat încă volum eligibil pentru upsell semnalat pe cont — merită să facem împreună un audit rapid, deoarece conturile cu acest profil de creștere au de obicei spațiu de upgrade undeva în mixul de licențe.',
    growthNextStep: (nextAction) => `Următorul pas din partea mea: ${nextAction}`,
    growthClosing: 'Putem rezerva 30 de minute pentru o sesiune de lucru pe acest subiect — pot aduce cu plăcere o propunere preliminară?',

    qbrSubject: (quarter) => `Revizuire de business — ${quarter}`,
    qbrIntro: (name, quarter) => `Înainte de întâlnirea noastră trimestrială, iată un rezumat rapid al situației ${name} pe baza cifrelor din ${quarter}:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Rata de reînnoire: ${pct}% (risc ${riskLabel})`,
    qbrSalesBullet: (cur, priorSuffix) => `- Vânzări, ultimele 12 luni: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (față de ${prior} în perioada anterioară)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Creștere: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (vânzări +${pct}% față de anul trecut)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Reînnoire automată: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Oportunitate de upgrade: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} eligibile pentru ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Dimensiunea contului: ${pct}% din activitatea din țară`,
    qbrOverall: (priorityLabel, nextAction) => `În ansamblu, aș clasifica acest cont ca prioritate ${priorityLabel} în acest trimestru. ${nextAction}`,
    qbrClosing: 'Anunțați-mă ce interval vă convine pentru o revizuire de 30 de minute — voi aduce analiza completă.',
  },
  sv: {
    contactPlaceholder: '[Kontaktens namn]',
    greeting: (contact) => `Hej ${contact},`,
    signoff: 'Vänliga hälsningar,',
    yourName: '[Ditt namn]',
    accountFallback: 'kontot',

    retentionSubject: (quarter) => `Uppdatering om förnyelse — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} förnyade, ${notRenewed} ej förnyade av totalt ${total} avtal)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `Förnyelsegraden för ${name}` : 'Förnyelsegraden';
      return `${subj} ligger under ${quarter} på ${pct}${detail}${bad ? ', vilket är lägre än vi skulle vilja.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'ganska jämnt fördelade över värdeintervallen, inklusive era mest värdefulla konton',
      high: 'koncentrerade till era mest värdefulla konton ($10k+)',
      low: 'koncentrerade till era mindre konton (under $5k)',
    },
    valueRangeSentence: (text) => `Förnyelseförlusterna verkar vara ${text} — det är värt att titta närmare på vad som driver detta i det segmentet.`,
    clmInactiveSentence: 'Jag noterade också att CLM-spårning ännu inte är aktiverad på kontot — att aktivera det skulle ge oss båda bättre insyn i kommande förnyelsedatum och minska överraskningar i sista minuten.',
    autoRenewSentence: (pct, bench) => `Automatisk förnyelse ligger just nu på ${pct}%, jämfört med ett benchmark på ${bench}% — att aktivera det på fler avtal skulle eliminera risken för passivt bortfall kommande kvartal.`,
    retentionProposal: (nextAction) => `Här är vad jag föreslår: ett 20-minuters samtal den här veckan för att gå igenom de riskutsatta kontona, bekräfta orsakerna till eventuella uteblivna förnyelser och komma överens om en konkret räddningsplan innan nästa cykel börjar. ${nextAction}`,
    retentionClosing: 'Hur ser din kalender ut på onsdag eller torsdag?',

    growthSubject: (quarter) => `Tillväxtmöjlighet — ${quarter}`,
    growthBitArr: (x) => `ARR upp ${x}%`,
    growthBitSales: (x) => `försäljning upp ${x}% jämfört med föregående år`,
    growthBitLicenses: (x) => `licenser upp ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `${name}s siffror` : 'Dessa siffror';
      return `${subj} för ${quarter} visar verklig fart${detail} — grattis, det var ett starkt kvartal.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `${name}s siffror` : 'Dessa siffror';
      return `${subj} för ${quarter}${detail} är utgångspunkten för det här samtalet.`;
    },
    upsellFoundSentence1: (count, unit, label) => `När jag gick igenom kontot hittade jag en konkret uppgraderingsmöjlighet: ${count} ${unit} berättigade till ${label}.`,
    upsellFoundSentence2: 'Vid nuvarande volymer är detta en meningsfull expansionsmöjlighet för båda parter — jag tar gärna fram siffror så att du kan se den exakta effekten på ditt bestånd.',
    upsellNotFoundSentence: 'Jag har ännu inte sett någon upsell-berättigad volym flaggad på kontot — det är värt att göra en snabb genomgång tillsammans, eftersom konton med den här tillväxtprofilen brukar ha uppgraderingsutrymme någonstans i licensmixen.',
    growthNextStep: (nextAction) => `Nästa steg från min sida: ${nextAction}`,
    growthClosing: 'Kan vi boka 30 minuter för en arbetssession om detta — jag tar gärna med ett utkast till förslag?',

    qbrSubject: (quarter) => `Affärsgenomgång — ${quarter}`,
    qbrIntro: (name, quarter) => `Inför vår kvartalsgenomgång, här är en snabb sammanfattning av var ${name} står baserat på siffrorna för ${quarter}:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Förnyelsegrad: ${pct}% (${riskLabel} risk)`,
    qbrSalesBullet: (cur, priorSuffix) => `- Försäljning, senaste 12 månaderna: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (jämfört med ${prior} föregående period)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Tillväxt: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (försäljning +${pct}% jämfört med föregående år)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Automatisk förnyelse: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Uppgraderingsmöjlighet: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} berättigade till ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Kontostorlek: ${pct}% av affärerna i landet`,
    qbrOverall: (priorityLabel, nextAction) => `Sammantaget skulle jag flagga det här kontot som ${priorityLabel} prioritet det här kvartalet. ${nextAction}`,
    qbrClosing: 'Säg till vilken tid som passar för en 30-minuters genomgång — jag tar med hela nedbrytningen.',
  },
  no: {
    contactPlaceholder: '[Kontaktens navn]',
    greeting: (contact) => `Hei ${contact},`,
    signoff: 'Med vennlig hilsen,',
    yourName: '[Ditt navn]',
    accountFallback: 'kontoen',

    retentionSubject: (quarter) => `Oppdatering om fornyelse — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} fornyet, ${notRenewed} ikke fornyet av totalt ${total} avtaler)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `Fornyelsesraten for ${name}` : 'Fornyelsesraten';
      return `${subj} ligger i ${quarter} på ${pct}${detail}${bad ? ', noe som er lavere enn ønsket.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'fordelt ganske jevnt over verdisegmentene, inkludert dine mest verdifulle kontoer',
      high: 'konsentrert til dine mest verdifulle kontoer ($10k+)',
      low: 'konsentrert til dine mindre kontoer (under $5k)',
    },
    valueRangeSentence: (text) => `Fornyelsestapene ser ut til å være ${text} — det er verdt å se nærmere på hva som driver dette i det segmentet.`,
    clmInactiveSentence: 'Jeg la også merke til at CLM-sporing ennå ikke er aktivert på kontoen — å aktivere det ville gitt oss begge bedre innsikt i kommende fornyelsesdatoer og redusert overraskelser i siste liten.',
    autoRenewSentence: (pct, bench) => `Automatisk fornyelse ligger for øyeblikket på ${pct}%, mot en benchmark på ${bench}% — å aktivere det på flere avtaler ville eliminert risikoen for passivt frafall for kommende kvartaler.`,
    retentionProposal: (nextAction) => `Her er hva jeg foreslår: en 20-minutters samtale denne uken for å gå gjennom kontoene med risiko, bekrefte årsakene til eventuelle manglende fornyelser, og bli enige om en konkret redningsplan før neste syklus starter. ${nextAction}`,
    retentionClosing: 'Hvordan ser kalenderen din ut på onsdag eller torsdag?',

    growthSubject: (quarter) => `Vekstmulighet — ${quarter}`,
    growthBitArr: (x) => `ARR opp ${x}%`,
    growthBitSales: (x) => `salg opp ${x}% sammenlignet med året før`,
    growthBitLicenses: (x) => `lisenser opp ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `Tallene til ${name}` : 'Disse tallene';
      return `${subj} for ${quarter} viser reell fremdrift${detail} — gratulerer, det var et sterkt kvartal.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `Tallene til ${name}` : 'Disse tallene';
      return `${subj} for ${quarter}${detail} er utgangspunktet for denne samtalen.`;
    },
    upsellFoundSentence1: (count, unit, label) => `Da jeg gikk gjennom kontoen fant jeg en konkret oppgraderingsmulighet: ${count} ${unit} kvalifisert for ${label}.`,
    upsellFoundSentence2: 'Ved dagens volumer er dette en meningsfull ekspansjonsmulighet for begge parter — jeg setter gjerne sammen tall slik at du kan se den nøyaktige effekten på porteføljen din.',
    upsellNotFoundSentence: 'Jeg har ennå ikke sett noe upsell-kvalifisert volum flagget på kontoen — det er verdt å gjøre en rask revisjon sammen, siden kontoer med denne vekstprofilen som regel har oppgraderingsrom et sted i lisensmiksen.',
    growthNextStep: (nextAction) => `Neste steg fra min side: ${nextAction}`,
    growthClosing: 'Kan vi sette av 30 minutter til en arbeidsøkt om dette — jeg tar gjerne med et utkast til forslag?',

    qbrSubject: (quarter) => `Forretningsgjennomgang — ${quarter}`,
    qbrIntro: (name, quarter) => `Foran vår kvartalsgjennomgang, her er en rask oppsummering av hvor ${name} står basert på tallene for ${quarter}:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Fornyelsesrate: ${pct}% (${riskLabel} risiko)`,
    qbrSalesBullet: (cur, priorSuffix) => `- Salg, siste 12 måneder: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (mot ${prior} i forrige periode)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Vekst: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (salg +${pct}% sammenlignet med året før)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Automatisk fornyelse: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Oppgraderingsmulighet: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} kvalifisert for ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Kontostørrelse: ${pct}% av virksomheten i landet`,
    qbrOverall: (priorityLabel, nextAction) => `Samlet sett vil jeg vurdere denne kontoen som ${priorityLabel} prioritet dette kvartalet. ${nextAction}`,
    qbrClosing: 'Si gjerne fra om et tidspunkt som passer for en 30-minutters gjennomgang — jeg tar med hele oversikten.',
  },
  da: {
    contactPlaceholder: '[Kontaktpersonens navn]',
    greeting: (contact) => `Hej ${contact},`,
    signoff: 'Med venlig hilsen,',
    yourName: '[Dit navn]',
    accountFallback: 'kontoen',

    retentionSubject: (quarter) => `Opdatering om fornyelse — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} fornyet, ${notRenewed} ikke fornyet ud af i alt ${total} aftaler)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `Fornyelsesraten for ${name}` : 'Fornyelsesraten';
      return `${subj} ligger i ${quarter} på ${pct}${detail}${bad ? ', hvilket er lavere end ønsket.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'fordelt nogenlunde jævnt over værdisegmenterne, inklusive dine mest værdifulde konti',
      high: 'koncentreret om dine mest værdifulde konti ($10k+)',
      low: 'koncentreret om dine mindre konti (under $5k)',
    },
    valueRangeSentence: (text) => `Fornyelsestabene ser ud til at være ${text} — det er værd at kigge nærmere på, hvad der driver dette i det segment.`,
    clmInactiveSentence: 'Jeg bemærkede også, at CLM-sporing endnu ikke er aktiveret på kontoen — at aktivere det ville give os begge bedre indsigt i kommende fornyelsesdatoer og reducere overraskelser i sidste øjeblik.',
    autoRenewSentence: (pct, bench) => `Automatisk fornyelse ligger i øjeblikket på ${pct}%, mod et benchmark på ${bench}% — at aktivere det på flere aftaler ville fjerne risikoen for passivt frafald i kommende kvartaler.`,
    retentionProposal: (nextAction) => `Her er, hvad jeg foreslår: et 20-minutters opkald i denne uge for at gennemgå de risikofyldte konti, bekræfte årsagerne til eventuelle manglende fornyelser og aftale en konkret redningsplan, før næste cyklus starter. ${nextAction}`,
    retentionClosing: 'Hvordan ser din kalender ud på onsdag eller torsdag?',

    growthSubject: (quarter) => `Vækstmulighed — ${quarter}`,
    growthBitArr: (x) => `ARR op ${x}%`,
    growthBitSales: (x) => `salg op ${x}% år-til-år`,
    growthBitLicenses: (x) => `licenser op ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `${name}s tal` : 'Disse tal';
      return `${subj} for ${quarter} viser reel fremdrift${detail} — tillykke, det var et stærkt kvartal.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `${name}s tal` : 'Disse tal';
      return `${subj} for ${quarter}${detail} er udgangspunktet for denne samtale.`;
    },
    upsellFoundSentence1: (count, unit, label) => `Da jeg gennemgik kontoen, fandt jeg en konkret opgraderingsmulighed: ${count} ${unit} berettiget til ${label}.`,
    upsellFoundSentence2: 'Ved de nuværende volumener er dette en meningsfuld udvidelsesmulighed for begge parter — jeg samler gerne tal, så du kan se den præcise effekt på din portefølje.',
    upsellNotFoundSentence: 'Jeg har endnu ikke set noget upsell-berettiget volumen markeret på kontoen — det er værd at lave et hurtigt tjek sammen, da konti med denne vækstprofil normalt har opgraderingsrum et sted i licensmikset.',
    growthNextStep: (nextAction) => `Næste skridt fra min side: ${nextAction}`,
    growthClosing: 'Kan vi sætte 30 minutter af til en arbejdssession om dette — jeg tager gerne et udkast til forslag med?',

    qbrSubject: (quarter) => `Forretningsgennemgang — ${quarter}`,
    qbrIntro: (name, quarter) => `Forud for vores kvartalsgennemgang, her er en hurtig opsummering af, hvor ${name} står baseret på tallene for ${quarter}:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Fornyelsesrate: ${pct}% (${riskLabel} risiko)`,
    qbrSalesBullet: (cur, priorSuffix) => `- Salg, seneste 12 måneder: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (mod ${prior} i forrige periode)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Vækst: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (salg +${pct}% år-til-år)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Automatisk fornyelse: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Opgraderingsmulighed: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} berettiget til ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Kontostørrelse: ${pct}% af forretningen i landet`,
    qbrOverall: (priorityLabel, nextAction) => `Samlet set vil jeg markere denne konto som ${priorityLabel} prioritet dette kvartal. ${nextAction}`,
    qbrClosing: 'Sig til, hvilket tidspunkt der passer til en 30-minutters gennemgang — jeg tager hele opdelingen med.',
  },
  fi: {
    contactPlaceholder: '[Yhteyshenkilön nimi]',
    greeting: (contact) => `Hei ${contact},`,
    signoff: 'Ystävällisin terveisin,',
    yourName: '[Nimesi]',
    accountFallback: 'tili',

    retentionSubject: (quarter) => `Päivitys uusimisesta — ${quarter}`,
    renewalDetail: (renewed, notRenewed, total) => ` (${renewed} uusittu, ${notRenewed} ei uusittu, yhteensä ${total} sopimusta)`,
    renewalRateSentence: (name, quarter, pct, detail, bad) => {
      const subj = name ? `${name}n uusimisaste` : 'Uusimisaste';
      return `${subj} on ${quarter} ${pct}${detail}${bad ? ', mikä on toivottua alempi.' : '.'}`;
    },
    valueRangeRiskPhrase: {
      systemic: 'jakautuneet melko tasaisesti eri arvoluokkiin, myös arvokkaimpiin tileihinne',
      high: 'keskittyneet arvokkaimpiin tileihinne (10 000 $ tai enemmän)',
      low: 'keskittyneet pienempiin tileihinne (alle 5 000 $)',
    },
    valueRangeSentence: (text) => `Uusimistappiot vaikuttavat olevan ${text} — kannattaa tarkastella lähemmin, mikä tätä segmenttiä ajaa.`,
    clmInactiveSentence: 'Huomasin myös, että CLM-seuranta ei ole vielä aktiivinen tällä tilillä — sen käyttöönotto antaisi meille molemmille paremman näkyvyyden tuleviin uusimispäiviin ja vähentäisi viime hetken yllätyksiä.',
    autoRenewSentence: (pct, bench) => `Automaattinen uusiminen on tällä hetkellä ${pct}%, kun vertailuarvo on ${bench}% — sen käyttöönotto useammissa sopimuksissa poistaisi passiivisen asiakaspoistuman riskin tulevilta vuosineljänneksiltä.`,
    retentionProposal: (nextAction) => `Ehdotan seuraavaa: 20 minuutin puhelu tällä viikolla, jossa käymme läpi riskialttiit tilit, vahvistamme mahdollisten uusimatta jättämisten syyt ja sovimme konkreettisesta säilyttämissuunnitelmasta ennen seuraavan kauden alkua. ${nextAction}`,
    retentionClosing: 'Miltä kalenterisi näyttää keskiviikkona tai torstaina?',

    growthSubject: (quarter) => `Kasvumahdollisuus — ${quarter}`,
    growthBitArr: (x) => `ARR nousi ${x}%`,
    growthBitSales: (x) => `myynti nousi ${x}% vuoden takaisesta`,
    growthBitLicenses: (x) => `lisenssien määrä nousi ${x}%`,
    growthStrongSentence: (name, quarter, detail) => {
      const subj = name ? `${name}n luvut` : 'Nämä luvut';
      return `${subj} ${quarter} osoittavat todellista vauhtia${detail} — onnittelut, se oli vahva vuosineljännes.`;
    },
    growthWeakSentence: (name, quarter, detail) => {
      const subj = name ? `${name}n luvut` : 'Nämä luvut';
      return `${subj} ${quarter}${detail} ovat tämän keskustelun lähtökohta.`;
    },
    upsellFoundSentence1: (count, unit, label) => `Tiliä tarkastellessani löysin konkreettisen päivitysmahdollisuuden: ${count} ${unit} kelpoisia kohteeseen ${label}.`,
    upsellFoundSentence2: 'Nykyisillä volyymeilla tämä on merkittävä laajentumismahdollisuus molemmille osapuolille — valmistelen mielelläni luvut, jotta näet tarkan vaikutuksen salkkuusi.',
    upsellNotFoundSentence: 'En ole vielä havainnut tilillä merkittyä lisämyyntikelpoista volyymia — kannattaa tehdä yhdessä nopea tarkistus, sillä tällaisen kasvuprofiilin tileillä on yleensä päivitysvaraa jossain lisenssivalikoimassa.',
    growthNextStep: (nextAction) => `Seuraava askel minun puoleltani: ${nextAction}`,
    growthClosing: 'Voisimmeko varata 30 minuuttia työistuntoon tästä aiheesta — tuon mielelläni alustavan ehdotuksen?',

    qbrSubject: (quarter) => `Liiketoimintakatsaus — ${quarter}`,
    qbrIntro: (name, quarter) => `Ennen neljännesvuosikatsaustamme, tässä on nopea yhteenveto siitä, missä ${name} on ${quarter} lukujen perusteella:`,
    qbrRenewalBullet: (pct, riskLabel) => `- Uusimisaste: ${pct}% (riski: ${riskLabel})`,
    qbrSalesBullet: (cur, priorSuffix) => `- Myynti, viimeiset 12 kuukautta: ${cur}${priorSuffix}`,
    qbrSalesPrior: (prior) => ` (vs. ${prior} edellisellä kaudella)`,
    qbrGrowthBullet: (label, salesSuffix) => `- Kasvu: ${label}${salesSuffix}`,
    qbrGrowthSalesSuffix: (pct) => ` (myynti +${pct}% vuoden takaisesta)`,
    qbrAutoRenewBullet: (label, pctSuffix) => `- Automaattinen uusiminen: ${label}${pctSuffix}`,
    qbrAutoRenewPctSuffix: (pct) => ` (${pct}%)`,
    qbrUpsellBullet: (label, detailSuffix) => `- Päivitysmahdollisuus: ${label}${detailSuffix}`,
    qbrUpsellDetailSuffix: (count, unit, prodLabel) => ` — ${count} ${unit} kelpoisia kohteeseen ${prodLabel}`,
    qbrSizeBullet: (pct) => `- Tilin koko: ${pct}% maan liiketoiminnasta`,
    qbrOverall: (priorityLabel, nextAction) => `Kokonaisuutena luokittelisin tämän tilin ${priorityLabel} prioriteetiksi tällä vuosineljänneksellä. ${nextAction}`,
    qbrClosing: 'Ilmoita, mikä ajankohta sopii 30 minuutin katsaukselle — tuon mukanani täyden erittelyn.',
  },
};

function composeRetentionEmail(i, m, ctx, lang) {
  const P = EMAIL_PHRASES[lang] || EMAIL_PHRASES.en;
  const { rBand, name, subjectName, renewalPct } = ctx;
  const contact = i.contactName || P.contactPlaceholder;
  const quarter = i.quarter;
  const parts = [];
  parts.push(`Subject: ${subjectName}${P.retentionSubject(quarter)}`);
  parts.push('');
  parts.push(P.greeting(contact));
  parts.push('');

  if (renewalPct) {
    let detail = '';
    if (i.agreementsTotal !== null && i.agreementsNotRenewed !== null) {
      detail = P.renewalDetail(i.agreementsRenewed ?? '—', i.agreementsNotRenewed, i.agreementsTotal);
    }
    const bad = rBand.status === 'critical' || rBand.status === 'serious';
    parts.push(P.renewalRateSentence(name, quarter, renewalPct, detail, bad));
  }

  if (m.valueRangeRisk) {
    parts.push(P.valueRangeSentence(P.valueRangeRiskPhrase[m.valueRangeRisk]));
  }

  if (i.clmStatus === 'inactive') {
    parts.push(P.clmInactiveSentence);
  }

  if (m.arPct !== null && m.arBenchmark !== null && m.autoRenewScore !== null && autoRenewBand(m.autoRenewScore).status !== 'good') {
    parts.push(P.autoRenewSentence(fmt(m.arPct,1), fmt(m.arBenchmark,1)));
  }

  pushPara(parts, P.retentionProposal(buildNextAction(i, m, lang)));
  parts.push('');
  parts.push(P.retentionClosing);
  parts.push('');
  parts.push(P.signoff);
  parts.push(P.yourName);
  return parts.join('\n');
}

function composeGrowthEmail(i, m, ctx, lang) {
  const P = EMAIL_PHRASES[lang] || EMAIL_PHRASES.en;
  const { gBand, name, subjectName } = ctx;
  const contact = i.contactName || P.contactPlaceholder;
  const quarter = i.quarter;
  const parts = [];
  parts.push(`Subject: ${subjectName}${P.growthSubject(quarter)}`);
  parts.push('');
  parts.push(P.greeting(contact));
  parts.push('');

  if (m.growthScore !== null) {
    const bits = [];
    if (i.arrGrowth !== null) bits.push(P.growthBitArr(fmt(i.arrGrowth,1)));
    if (m.salesGrowthPct !== null) bits.push(P.growthBitSales(fmt(m.salesGrowthPct,1)));
    if (i.licensesDelta !== null) bits.push(P.growthBitLicenses(fmt(i.licensesDelta,1)));
    const detail = bits.length ? ` (${bits.join(', ')})` : '';
    if (gBand.label === 'Strong growth' || gBand.label === 'Growth') {
      parts.push(P.growthStrongSentence(name, quarter, detail));
    } else {
      parts.push(P.growthWeakSentence(name, quarter, detail));
    }
  }

  if (m.anyUpsellData && m.dominantPath && m.dominantPath.count > 0) {
    pushPara(parts, P.upsellFoundSentence1(m.dominantPath.count, tr(UNIT_LABEL, lang, m.dominantPath.unit), m.dominantPath.label));
    parts.push(P.upsellFoundSentence2);
  } else {
    pushPara(parts, P.upsellNotFoundSentence);
  }

  pushPara(parts, P.growthNextStep(buildNextAction(i, m, lang)));
  parts.push('');
  parts.push(P.growthClosing);
  parts.push('');
  parts.push(P.signoff);
  parts.push(P.yourName);
  return parts.join('\n');
}

function composeQbrEmail(i, m, ctx, lang) {
  const P = EMAIL_PHRASES[lang] || EMAIL_PHRASES.en;
  const { name, subjectName } = ctx;
  const contact = i.contactName || P.contactPlaceholder;
  const quarter = i.quarter;
  const pBand = priorityBand(m.overallPriority);
  const rBand = riskBand(m.renewalHealth);
  const gBand = growthBand(m.growthScore);
  const aBand = autoRenewBand(m.autoRenewScore);
  const uBand = upsellBand(m.upsellScore);

  const parts = [];
  parts.push(`Subject: ${subjectName}${P.qbrSubject(quarter)}`);
  parts.push('');
  parts.push(P.greeting(contact));
  parts.push('');
  parts.push(P.qbrIntro(name || P.accountFallback, quarter));
  parts.push('');
  if (i.renewalRate !== null) parts.push(P.qbrRenewalBullet(fmt(i.renewalRate,1), tr(RISK_LABEL, lang, rBand.label)));
  if (i.salesCurrent12m !== null) {
    const priorSuffix = i.salesPrevious12m !== null ? P.qbrSalesPrior(money(i.salesPrevious12m)) : '';
    parts.push(P.qbrSalesBullet(money(i.salesCurrent12m), priorSuffix));
  }
  if (m.growthScore !== null) {
    const salesSuffix = m.salesGrowthPct !== null ? P.qbrGrowthSalesSuffix(fmt(m.salesGrowthPct,1)) : '';
    parts.push(P.qbrGrowthBullet(tr(GROWTH_LABEL, lang, gBand.label), salesSuffix));
  }
  if (m.autoRenewScore !== null) {
    const pctSuffix = m.arPct !== null ? P.qbrAutoRenewPctSuffix(fmt(m.arPct,1)) : '';
    parts.push(P.qbrAutoRenewBullet(tr(AUTORENEW_LABEL, lang, aBand.label), pctSuffix));
  }
  if (m.upsellScore !== null) {
    const detailSuffix = (m.anyUpsellData && m.dominantPath && m.dominantPath.count > 0)
      ? P.qbrUpsellDetailSuffix(m.dominantPath.count, tr(UNIT_LABEL, lang, m.dominantPath.unit), m.dominantPath.label)
      : '';
    parts.push(P.qbrUpsellBullet(tr(OPPORTUNITY_LABEL, lang, uBand.label), detailSuffix));
  }
  if (m.sizeShare !== null) parts.push(P.qbrSizeBullet(fmt(m.sizeShare,1)));
  pushPara(parts, P.qbrOverall(tr(PRIORITY_LABEL, lang, pBand.label), buildNextAction(i, m, lang)));
  parts.push('');
  parts.push(P.qbrClosing);
  parts.push('');
  parts.push(P.signoff);
  parts.push(P.yourName);
  return parts.join('\n');
}

function buildEmailVariants(i, m) {
  const ctx = emailContext(i, m);
  const lang = i.countryLang || 'en';
  const composers = [
    { label: 'Retention-focused', fn: composeRetentionEmail },
    { label: 'Growth & upsell', fn: composeGrowthEmail },
    { label: 'Quarterly review', fn: composeQbrEmail },
  ];
  return composers.map(({ label, fn }) => {
    const textEn = fn(i, m, ctx, 'en');
    const hasTranslation = lang !== 'en' && Boolean(EMAIL_PHRASES[lang]);
    return {
      label,
      textEn,
      textTranslated: hasTranslation ? fn(i, m, ctx, lang) : null,
      lang,
      langName: LANG_NAMES[lang] || null,
    };
  });
}

// ---------- render ----------

const STATUS_COLOR = {
  good: 'var(--status-good)',
  warning: 'var(--status-warning)',
  serious: 'var(--status-serious)',
  critical: 'var(--status-critical)',
  neutral: 'var(--status-neutral)',
};

// Six-axis radar giving a one-glance shape for the whole scorecard. Each
// axis mirrors exactly what its tile shows (same 0-100 value, same band fn
// for color) so the chart and the tiles never disagree. A null axis plots
// at r=0 (dents toward center) and renders as a dashed "no data" dot rather
// than a fabricated zero score.
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  return el;
}

function renderRadar(m) {
  const cx = 150, cy = 150, maxR = 100, labelR = 128;
  // Priority is the one metric where a HIGH score is bad (urgent/critical) —
  // every other axis has high=healthy. Plotting it raw would shrink the
  // shape on that axis for a genuinely healthy account (low priority, good
  // news) exactly where the other 5 axes are stretched out, reading as a
  // false "something's wrong here" dent. plotValue inverts just the radius
  // (100-score) so "bigger = healthier/less urgent" holds on all 6 axes;
  // the dot's color still comes from the real (non-inverted) band, so a
  // truly urgent account still shows red — just close to center, matching
  // how "bad" already reads on every other axis.
  const axes = [
    { label: 'Priority',   value: m.overallPriority,      plotValue: m.overallPriority === null ? null : 100 - m.overallPriority, band: priorityBand(m.overallPriority) },
    { label: 'Risk',       value: m.renewalHealth,        plotValue: m.renewalHealth,        band: riskBand(m.renewalHealth) },
    { label: 'Growth',     value: m.growthScore,          plotValue: m.growthScore,          band: growthBand(m.growthScore) },
    { label: 'Auto-Renew', value: m.autoRenewScore,       plotValue: m.autoRenewScore,       band: autoRenewBand(m.autoRenewScore) },
    { label: 'Upsell',     value: m.upsellScore,          plotValue: m.upsellScore,          band: upsellBand(m.upsellScore) },
    { label: 'Size',       value: m.sizeScoreForPriority, plotValue: m.sizeScoreForPriority, band: sizeBand(m.sizeShare) },
  ];
  const angleFor = (idx) => (idx * 60 - 90) * Math.PI / 180;
  const pt = (r, rad) => [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];

  const svg = svgEl('svg', {
    viewBox: '-20 -15 340 330', width: '240', height: '240', role: 'img',
    'aria-label': 'Scorecard radar across all six metrics',
  });

  [0.333, 0.667, 1].forEach((frac) => {
    const pts = axes.map((_, idx) => pt(maxR * frac, angleFor(idx)).join(',')).join(' ');
    svg.appendChild(svgEl('polygon', { class: 'radar-grid-ring', points: pts }));
  });

  // No-data axes plot at a small fixed stub radius rather than the exact
  // center — at r=0 every no-data axis lands on the same point and their
  // dashed "no data" dots stack invisibly under the center readout.
  const NO_DATA_STUB_R = 26;
  const vertices = axes.map((axis, idx) => {
    const rad = angleFor(idx);
    const hasData = axis.plotValue !== null;
    const r = hasData ? (Math.max(0, Math.min(100, axis.plotValue)) / 100) * maxR : NO_DATA_STUB_R;
    const [x, y] = pt(r, rad);
    const [lx, ly] = pt(labelR, rad);
    return { x, y, lx, ly, rad, hasData, band: axis.band, label: axis.label };
  });

  vertices.forEach((v) => {
    const [ex, ey] = pt(maxR, v.rad);
    svg.appendChild(svgEl('line', { class: 'radar-spoke', x1: cx, y1: cy, x2: ex, y2: ey }));
  });

  svg.appendChild(svgEl('polygon', {
    class: 'radar-shape',
    points: vertices.map(v => `${v.x.toFixed(1)},${v.y.toFixed(1)}`).join(' '),
  }));

  vertices.forEach((v) => {
    const dot = svgEl('circle', {
      class: 'radar-dot' + (v.hasData ? '' : ' radar-dot-empty'),
      cx: v.x.toFixed(1), cy: v.y.toFixed(1), r: 4.5,
    });
    if (v.hasData) dot.style.fill = STATUS_COLOR[v.band.status] || STATUS_COLOR.neutral;
    svg.appendChild(dot);
  });

  vertices.forEach((v) => {
    const cos = Math.cos(v.rad);
    const anchor = cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle';
    const t = svgEl('text', {
      class: 'radar-axis-label' + (v.hasData ? '' : ' radar-axis-label-empty'),
      x: v.lx.toFixed(1), y: v.ly.toFixed(1), 'text-anchor': anchor,
    });
    t.textContent = v.label;
    svg.appendChild(t);
  });

  const pBand = priorityBand(m.overallPriority);
  const scoreText = svgEl('text', { class: 'radar-center-score', x: 150, y: 146, 'text-anchor': 'middle' });
  scoreText.textContent = m.overallPriority === null ? '—' : Math.round(m.overallPriority);
  const labelText = svgEl('text', { class: 'radar-center-label', x: 150, y: 163, 'text-anchor': 'middle' });
  labelText.textContent = pBand.label;
  svg.appendChild(scoreText);
  svg.appendChild(labelText);

  const container = document.getElementById('radar-chart');
  container.innerHTML = '';
  container.appendChild(svg);
}

// Shared renderer for the two bar-chart views (Scores, By Value Range).
// Each row is { label, width (0-100 or null), display (string or null),
// band }. A row with width===null renders muted with a "—" instead of a
// fabricated zero-length bar; if every row is null, shows one empty-state
// message instead of six meaningless empty tracks.
function renderBarChart(containerId, rows) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';

  if (rows.every(r => r.width === null)) {
    const p = document.createElement('p');
    p.className = 'bar-chart-empty';
    p.textContent = 'No data entered for this view yet.';
    container.appendChild(p);
    return;
  }

  rows.forEach((row) => {
    const item = document.createElement('div');
    item.className = 'bar-row' + (row.width === null ? ' bar-row-empty' : '');

    const label = document.createElement('span');
    label.className = 'bar-label';
    label.textContent = row.label;

    const track = document.createElement('span');
    track.className = 'bar-track';
    const fill = document.createElement('span');
    fill.className = 'bar-fill';
    if (row.width !== null) {
      fill.style.width = Math.max(0, Math.min(100, row.width)) + '%';
      fill.style.background = STATUS_COLOR[row.band.status] || STATUS_COLOR.neutral;
    }
    track.appendChild(fill);

    const value = document.createElement('span');
    value.className = 'bar-value';
    value.textContent = row.display === null ? '—' : row.display;

    item.appendChild(label);
    item.appendChild(track);
    item.appendChild(value);
    container.appendChild(item);
  });
}

// "Scores" view: the same 6 metrics as the radar, as bars — easier to read
// exact values/ranking than a shape. Priority is NOT radius-inverted here
// (unlike the radar) since each row is read independently, not as part of
// one holistic shape, so there's no "false dent" risk to correct for.
function renderScoreBars(m) {
  const rows = [
    { label: 'Priority',   width: m.overallPriority,      display: m.overallPriority === null ? null : String(Math.round(m.overallPriority)), band: priorityBand(m.overallPriority) },
    { label: 'Risk',       width: m.renewalHealth,        display: m.renewalHealth === null ? null : String(Math.round(m.renewalHealth)), band: riskBand(m.renewalHealth) },
    { label: 'Growth',     width: m.growthScore,          display: m.growthScore === null ? null : String(Math.round(m.growthScore)), band: growthBand(m.growthScore) },
    { label: 'Auto-Renew', width: m.autoRenewScore,       display: m.autoRenewScore === null ? null : String(Math.round(m.autoRenewScore)), band: autoRenewBand(m.autoRenewScore) },
    { label: 'Upsell',     width: m.upsellScore,          display: m.upsellScore === null ? null : String(Math.round(m.upsellScore)), band: upsellBand(m.upsellScore) },
    { label: 'Size',       width: m.sizeScoreForPriority, display: m.sizeShare === null ? null : fmt(m.sizeShare, 1) + '%', band: sizeBand(m.sizeShare) },
  ];
  renderBarChart('bar-chart', rows);
}

// "By Value Range" view: the optional per-bucket renewal-rate fields
// (Step 2, "Renewal Rate by Value Range") are collected but never
// visualized anywhere else in the app — this is the only place they're
// charted. Read straight from the inputs (num()) rather than `i`/`m`,
// since only the aggregated low/high buckets are carried into readInputs().
const VALUE_RANGE_BUCKETS = [
  { id: 'vr_0_1', label: '$0–1k' },
  { id: 'vr_1_5', label: '$1–5k' },
  { id: 'vr_5_10', label: '$5–10k' },
  { id: 'vr_10_25', label: '$10–25k' },
  { id: 'vr_25_50', label: '$25–50k' },
  { id: 'vr_50_plus', label: '$50k+' },
];
function renderValueRangeBars() {
  const rows = VALUE_RANGE_BUCKETS.map((b) => {
    const v = num(b.id);
    return {
      label: b.label,
      width: v,
      display: v === null ? null : fmt(v, 1) + '%',
      band: v === null ? { status: 'neutral' } : riskBand(v),
    };
  });
  renderBarChart('valuerange-chart', rows);
}

// A tile shows one metric exactly once: label, value, status badge, and a
// fill bar sized off the underlying 0-100 score — no separate meter list.
function setTile(id, value, bandInfo, score) {
  const tile = document.getElementById(id);
  tile.querySelector('.tile-value').textContent = value;
  const badgeEl = tile.querySelector('.tile-band');
  badgeEl.textContent = bandInfo.label;
  badgeEl.className = 'tile-band badge ' + bandInfo.status;
  const fillEl = tile.querySelector('.tile-fill');
  fillEl.style.width = (score === null ? 0 : Math.max(0, Math.min(100, score))) + '%';
  fillEl.style.background = STATUS_COLOR[bandInfo.status] || STATUS_COLOR.neutral;
}

// Trend badge for tiles with a genuine current-vs-previous comparison
// backing them (only salesCurrent12m/salesPrevious12m qualifies today —
// every other "Δ" field is a delta typed in directly, with no underlying
// previous value to compare against). Hidden entirely when there's nothing
// honest to show, rather than fabricating a "+0.0%".
function setTrend(id, pct) {
  const el = document.getElementById(id);
  if (pct === null) { el.hidden = true; return; }
  const isFlat = pct === 0;
  const isUp = pct > 0;
  const arrow = isFlat ? '→' : (isUp ? '↑' : '↓');
  const sign = isFlat ? '' : (isUp ? '+' : '');
  el.textContent = `${arrow} ${sign}${fmt(pct, 1)}%`;
  el.title = 'Trailing 12-month sales vs. the previous period';
  el.style.color = isFlat ? STATUS_COLOR.neutral : (isUp ? STATUS_COLOR.good : STATUS_COLOR.critical);
  el.hidden = false;
}

let lastInputs = null;
let lastMetrics = null;

function render(i, m) {
  lastInputs = i;
  lastMetrics = m;
  const rBand = riskBand(m.renewalHealth);
  const gBand = growthBand(m.growthScore);
  const aBand = autoRenewBand(m.autoRenewScore);
  const uBand = upsellBand(m.upsellScore);
  const sBand = sizeBand(m.sizeShare);
  const pBand = priorityBand(m.overallPriority);

  document.getElementById('results-name').textContent = i.resellerName || 'Reseller diagnosis';
  document.getElementById('results-meta').textContent = `${i.quarter} · Overall priority: ${pBand.label}`;

  setTile('tile-priority', m.overallPriority === null ? '—' : Math.round(m.overallPriority), pBand, m.overallPriority);
  setTile('tile-risk', m.renewalHealth === null ? '—' : Math.round(m.renewalHealth), rBand, m.renewalHealth);
  setTile('tile-growth', m.growthScore === null ? '—' : Math.round(m.growthScore), gBand, m.growthScore);
  setTile('tile-autorenew', m.autoRenewScore === null ? '—' : Math.round(m.autoRenewScore), aBand, m.autoRenewScore);
  setTile('tile-upsell', m.upsellScore === null ? '—' : Math.round(m.upsellScore), uBand, m.upsellScore);
  setTile('tile-size', m.sizeShare === null ? '—' : fmt(m.sizeShare,1) + '%', sBand, m.sizeScoreForPriority);
  setTrend('tile-growth-trend', m.salesGrowthPct);
  setTrend('tile-size-trend', m.salesGrowthPct);
  renderRadar(m);
  renderScoreBars(m);
  renderValueRangeBars();

  const list = document.getElementById('diagnostic-list');
  list.innerHTML = '';
  for (const bullet of buildDiagnostic(i, m)) {
    const li = document.createElement('li');
    li.textContent = bullet;
    list.appendChild(li);
  }

  document.getElementById('product-recommendation').textContent = buildProductRecommendation(i, m);
  document.getElementById('next-action').textContent = buildNextAction(i, m);
  renderEmailVariants(buildEmailVariants(i, m));
}

// ---------- email variant tabs ----------

let currentEmailVariants = [];

function renderEmailVariants(variants) {
  currentEmailVariants = variants;
  const tabs = document.getElementById('email-variant-tabs');
  tabs.innerHTML = variants.map((v, idx) =>
    `<button type="button" class="email-tab" role="tab" aria-selected="${idx === 0}" data-index="${idx}">${v.label}</button>`
  ).join('');
  showEmailVariant(0);
}

function showEmailVariant(idx) {
  const variant = currentEmailVariants[idx];
  document.getElementById('email-draft-en').textContent = variant.textEn;
  document.querySelectorAll('#email-variant-tabs .email-tab').forEach(btn => {
    btn.setAttribute('aria-selected', String(Number(btn.dataset.index) === idx));
  });

  const translatedWrap = document.getElementById('email-draft-translated-wrap');
  if (variant.textTranslated) {
    document.getElementById('email-draft-lang-label').textContent = variant.langName;
    document.getElementById('email-draft-translated').textContent = variant.textTranslated;
    translatedWrap.hidden = false;
  } else {
    translatedWrap.hidden = true;
  }
}

document.getElementById('email-variant-tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('.email-tab');
  if (!btn) return;
  showEmailVariant(Number(btn.dataset.index));
});

// ---------- copy email ----------

async function copyEmail(sourceId, btn) {
  const text = document.getElementById(sourceId).textContent;
  try {
    await navigator.clipboard.writeText(text);
    flashCopyButton(btn, 'Copied!');
  } catch (err) {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById(sourceId));
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

// ---------- export report (real .xlsx, via the SheetJS library) ----------

function buildReportRows(i, m) {
  const rBand = riskBand(m.renewalHealth);
  const gBand = growthBand(m.growthScore);
  const aBand = autoRenewBand(m.autoRenewScore);
  const uBand = upsellBand(m.upsellScore);
  const sBand = sizeBand(m.sizeShare);
  const pBand = priorityBand(m.overallPriority);

  const rows = [
    ['Field', 'Value'],
    ['Reseller', i.resellerName || ''],
    ['Contact', i.contactName || ''],
    ['Country', i.country || ''],
    ['Quarter', i.quarter],
    ['Overall Priority (score)', m.overallPriority === null ? '' : Math.round(m.overallPriority)],
    ['Overall Priority (label)', pBand.label],
    ['Renewal Risk (score)', m.renewalHealth === null ? '' : Math.round(m.renewalHealth)],
    ['Renewal Risk (label)', rBand.label],
    ['Growth (score)', m.growthScore === null ? '' : Math.round(m.growthScore)],
    ['Growth (label)', gBand.label],
    ['Auto-Renew (score)', m.autoRenewScore === null ? '' : Math.round(m.autoRenewScore)],
    ['Auto-Renew (label)', aBand.label],
    ['Upsell Opportunity (score)', m.upsellScore === null ? '' : Math.round(m.upsellScore)],
    ['Upsell Opportunity (label)', uBand.label],
    ['Reseller Size (%)', m.sizeShare === null ? '' : fmt(m.sizeShare, 1)],
    ['Reseller Size (label)', sBand.label],
  ];

  buildDiagnostic(i, m).forEach((line, idx) => rows.push([`Diagnosis ${idx + 1}`, line]));
  rows.push(['Product Recommendation', buildProductRecommendation(i, m)]);
  rows.push(['Next Action', buildNextAction(i, m)]);

  return rows;
}

function exportReport() {
  if (!lastInputs || !lastMetrics) return;
  if (typeof XLSX === 'undefined') {
    alert("Couldn't load the Excel export library — check your connection and try again.");
    return;
  }

  const rows = buildReportRows(lastInputs, lastMetrics);
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!cols'] = [{ wch: 28 }, { wch: 90 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Report');

  const slug = (lastInputs.resellerName || 'reseller').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'reseller';
  XLSX.writeFile(workbook, `reseller-insights-${slug}.xlsx`);
}

document.getElementById('export-report').addEventListener('click', exportReport);

// ---------- form field bookkeeping ----------
// (the site intentionally keeps no data between visits — every load starts blank)

const dataFieldIds = Array.from(form.querySelectorAll('input, select'))
  .map(el => el.id)
  .filter(id => Boolean(id) && id !== 'sample-picker');

form.addEventListener('reset', () => {
  resultsBody.hidden = true;
  emptyHint.hidden = false;
  renewalRateError.hidden = true;
  renewalRateInput.removeAttribute('aria-invalid');
  document.getElementById('resellerCountry-error').hidden = true;
  document.getElementById('resellerCountry').removeAttribute('aria-invalid');
  document.getElementById('clmStatus-error').hidden = true;
  document.getElementById('clmStatus').removeAttribute('aria-invalid');
  maxStepReached = 1;
  goToStep(1);
});

// ---------- sample data (10 deliberately different resellers, for demos) ----------
// Each persona is tuned to land on a different combination of score bands and
// a different Next Action rule, so cycling through them shows the range of
// distinct outputs the correlation engine can produce from the same model.

const SAMPLE_RESELLERS = [
  {
    label: 'Meridian Systems Group — large account, critical renewal risk',
    data: {
      resellerName: 'Meridian Systems Group', contactName: 'Dana Whitfield', resellerCountry: 'France', quarter: 'Q3 2026',
      renewalRate: 42, agreementsTotal: 60, agreementsRenewed: 25, agreementsPartial: 5, agreementsNotRenewed: 30,
      clmStatus: 'inactive',
      vr_0_1: 55, vr_1_5: 48, vr_5_10: 30, vr_10_25: 22, vr_25_50: 15, vr_50_plus: 10,
      arrGrowth: -8, salesCurrent12m: 2600000, salesPrevious12m: 3100000, monthlyAverage: 240000, currentMonthExtrap: 210000,
      nsbValue: 180000, nsbDelta: -6, licenses: 4200, licensesDelta: -4, endUsers: 9800, endUsersDelta: -3,
      countrySales12m: 11000000, countryLicenses: 18000,
      arPct: 18, arCountry: 55, arEurope: 58,
      up_studio_lic: 6, up_studio_agr: 2, up_proplus_lic: 2, up_proplus_agr: 1, up_ent4_lic: 0, up_ent4_agr: 0,
    },
  },
  {
    label: 'Brightline Creative Partners — strong renewal, upsell-ready',
    data: {
      resellerName: 'Brightline Creative Partners', contactName: 'Priya Nandakumar', resellerCountry: 'Portugal', quarter: 'Q3 2026',
      renewalRate: 96, agreementsTotal: 50, agreementsRenewed: 48, agreementsPartial: 1, agreementsNotRenewed: 1,
      clmStatus: 'active',
      vr_0_1: 97, vr_1_5: 96, vr_5_10: 95, vr_10_25: 94, vr_25_50: 93, vr_50_plus: 92,
      arrGrowth: 22, salesCurrent12m: 980000, salesPrevious12m: 740000, monthlyAverage: 82000, currentMonthExtrap: 92000,
      nsbValue: 210000, nsbDelta: 24, licenses: 3100, licensesDelta: 19, endUsers: 7200, endUsersDelta: 16,
      countrySales12m: 9500000, countryLicenses: 26000,
      arPct: 68, arCountry: 54, arEurope: 57,
      up_studio_lic: 500, up_studio_agr: 120, up_proplus_lic: 250, up_proplus_agr: 70, up_ent4_lic: 80, up_ent4_agr: 20,
    },
  },
  {
    label: 'Coastal Office Systems — healthy renewal, auto-renew gap',
    data: {
      resellerName: 'Coastal Office Systems', contactName: 'Marcus Delgado', resellerCountry: 'Germany', quarter: 'Q3 2026',
      renewalRate: 83, agreementsTotal: 70, agreementsRenewed: 58, agreementsPartial: 6, agreementsNotRenewed: 6,
      clmStatus: 'active',
      arrGrowth: 3, salesCurrent12m: 510000, salesPrevious12m: 495000, monthlyAverage: 43000, currentMonthExtrap: 42000,
      nsbValue: 60000, nsbDelta: 2, licenses: 1800, licensesDelta: 1, endUsers: 4100, endUsersDelta: 1,
      countrySales12m: 8000000, countryLicenses: 20000,
      arPct: 16, arCountry: 57, arEurope: 59,
      up_studio_lic: 4, up_studio_agr: 2, up_proplus_lic: 0, up_proplus_agr: 0, up_ent4_lic: 0, up_ent4_agr: 0,
    },
  },
  {
    label: 'Union & Wells Marketing — healthy renewal, growth slowing',
    data: {
      resellerName: 'Union & Wells Marketing', contactName: 'Sophie Larkin', resellerCountry: 'Spain', quarter: 'Q3 2026',
      renewalRate: 89, agreementsTotal: 45, agreementsRenewed: 40, agreementsPartial: 3, agreementsNotRenewed: 2,
      clmStatus: 'active',
      arrGrowth: -14, salesCurrent12m: 310000, salesPrevious12m: 430000, monthlyAverage: 28000, currentMonthExtrap: 24000,
      nsbValue: 40000, nsbDelta: -11, licenses: 1200, licensesDelta: -9, endUsers: 2600, endUsersDelta: -6,
      countrySales12m: 7000000, countryLicenses: 16000,
      arPct: 54, arCountry: 55, arEurope: 57,
      up_studio_lic: 3, up_studio_agr: 1, up_proplus_lic: 0, up_proplus_agr: 0, up_ent4_lic: 0, up_ent4_agr: 0,
    },
  },
  {
    label: 'Foundry Nine Studio — small reseller, fast growth',
    data: {
      resellerName: 'Foundry Nine Studio', contactName: 'Alex Reyes', resellerCountry: 'Italy', quarter: 'Q3 2026',
      renewalRate: 86, agreementsTotal: 12, agreementsRenewed: 11, agreementsPartial: 1, agreementsNotRenewed: 0,
      clmStatus: 'active',
      arrGrowth: 34, salesCurrent12m: 85000, salesPrevious12m: 52000, monthlyAverage: 7000, currentMonthExtrap: 9000,
      nsbValue: 22000, nsbDelta: 38, licenses: 140, licensesDelta: 30, endUsers: 210, endUsersDelta: 22,
      countrySales12m: 9000000, countryLicenses: 22000,
      arPct: 54, arCountry: 55, arEurope: 56,
      up_studio_lic: 5, up_studio_agr: 1, up_proplus_lic: 0, up_proplus_agr: 0, up_ent4_lic: 0, up_ent4_agr: 0,
    },
  },
  {
    label: 'Hallmark Business Interiors — steady, no urgent action',
    data: {
      resellerName: 'Hallmark Business Interiors', contactName: 'Renee Ashford', resellerCountry: 'Netherlands', quarter: 'Q3 2026',
      renewalRate: 84, agreementsTotal: 55, agreementsRenewed: 46, agreementsPartial: 5, agreementsNotRenewed: 4,
      clmStatus: 'active',
      arrGrowth: 4, salesCurrent12m: 460000, salesPrevious12m: 440000, monthlyAverage: 38000, currentMonthExtrap: 39000,
      nsbValue: 55000, nsbDelta: 3, licenses: 1500, licensesDelta: 2, endUsers: 3400, endUsersDelta: 2,
      countrySales12m: 9000000, countryLicenses: 19000,
      arPct: 58, arCountry: 55, arEurope: 57,
      up_studio_lic: 6, up_studio_agr: 2, up_proplus_lic: 0, up_proplus_agr: 0, up_ent4_lic: 0, up_ent4_agr: 0,
    },
  },
  {
    label: 'Vantage Point Consulting — renewal risk + upsell opportunity',
    data: {
      resellerName: 'Vantage Point Consulting', contactName: 'Owen McAllister', resellerCountry: 'Poland', quarter: 'Q3 2026',
      renewalRate: 45, agreementsTotal: 48, agreementsRenewed: 22, agreementsPartial: 6, agreementsNotRenewed: 20,
      clmStatus: 'inactive',
      arrGrowth: 2, salesCurrent12m: 400000, salesPrevious12m: 390000, monthlyAverage: 34000, currentMonthExtrap: 33000,
      nsbValue: 50000, nsbDelta: 1, licenses: 1400, licensesDelta: 0, endUsers: 3000, endUsersDelta: 0,
      countrySales12m: 8500000, countryLicenses: 17000,
      arPct: 48, arCountry: 55, arEurope: 57,
      up_studio_lic: 350, up_studio_agr: 80, up_proplus_lic: 150, up_proplus_agr: 40, up_ent4_lic: 40, up_ent4_agr: 10,
    },
  },
  {
    label: 'Silverline Office Group — moderate renewal risk',
    data: {
      resellerName: 'Silverline Office Group', contactName: 'Katrina Voss', resellerCountry: 'United Kingdom', quarter: 'Q3 2026',
      renewalRate: 45, agreementsTotal: 40, agreementsRenewed: 17, agreementsPartial: 5, agreementsNotRenewed: 18,
      clmStatus: 'active',
      arrGrowth: 1, salesCurrent12m: 250000, salesPrevious12m: 245000, monthlyAverage: 21000, currentMonthExtrap: 20000,
      nsbValue: 30000, nsbDelta: 0, licenses: 900, licensesDelta: 0, endUsers: 2000, endUsersDelta: 0,
      countrySales12m: 8000000, countryLicenses: 15000,
      arPct: 55, arCountry: 55, arEurope: 57,
      up_studio_lic: 4, up_studio_agr: 1, up_proplus_lic: 0, up_proplus_agr: 0, up_ent4_lic: 0, up_ent4_agr: 0,
    },
  },
  {
    label: 'Continental Design Alliance — strategic account, upsell headroom',
    data: {
      resellerName: 'Continental Design Alliance', contactName: 'Julia Bergstrom', resellerCountry: 'Czech Republic', quarter: 'Q3 2026',
      renewalRate: 97, agreementsTotal: 90, agreementsRenewed: 88, agreementsPartial: 1, agreementsNotRenewed: 1,
      clmStatus: 'active',
      arrGrowth: 7, salesCurrent12m: 2400000, salesPrevious12m: 2250000, monthlyAverage: 200000, currentMonthExtrap: 205000,
      nsbValue: 260000, nsbDelta: 6, licenses: 6200, licensesDelta: 5, endUsers: 14000, endUsersDelta: 4,
      countrySales12m: 10000000, countryLicenses: 24000,
      arPct: 74, arCountry: 55, arEurope: 57,
      up_studio_lic: 100, up_studio_agr: 25, up_proplus_lic: 300, up_proplus_agr: 70, up_ent4_lic: 1400, up_ent4_agr: 300,
    },
  },
  {
    label: 'Atlas Peak Reseller — minimal data (partial form demo)',
    data: {
      resellerName: 'Atlas Peak Reseller', resellerCountry: 'Finland', quarter: 'Q3 2026',
      renewalRate: 75,
      clmStatus: 'active',
    },
  },
];

function populateSamplePicker() {
  const picker = document.getElementById('sample-picker');
  picker.innerHTML = SAMPLE_RESELLERS.map((s, idx) => `<option value="${idx}">${s.label}</option>`).join('');
}

function fillSample() {
  const picker = document.getElementById('sample-picker');
  const persona = SAMPLE_RESELLERS[picker.selectedIndex] || SAMPLE_RESELLERS[0];

  for (const id of dataFieldIds) {
    const el = document.getElementById(id);
    if (el) el.value = '';
  }
  for (const [key, value] of Object.entries(persona.data)) {
    const el = document.getElementById(key);
    if (!el) continue;
    if (el.hasAttribute('data-thousands')) setThousandsValue(el, value);
    else el.value = value;
  }

  renewalRateError.hidden = true;
  renewalRateInput.removeAttribute('aria-invalid');
  document.getElementById('resellerCountry-error').hidden = true;
  document.getElementById('resellerCountry').removeAttribute('aria-invalid');
  document.getElementById('clmStatus-error').hidden = true;
  document.getElementById('clmStatus').removeAttribute('aria-invalid');

  // Sample data is always complete, so skip straight to the diagnosis
  // instead of making the user click Next through all 7 steps.
  maxStepReached = 7;
  goToStep(7, { skipFocus: true });
  generateDiagnosis();
}

populateSamplePicker();
