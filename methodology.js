// Renders the methodology page's tables directly from config.js, so this
// page can never drift out of sync with the actual scoring model.

function pct(w) {
  return Math.round(w * 100) + '%';
}

function table(headers, rows) {
  const thead = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
  const tbody = rows.map(r => `<tr>${r.map(c => `<td class="${c.num ? 'num' : ''}">${c.value}</td>`).join('')}</tr>`).join('');
  return `<div class="table-scroll"><table class="spec-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
}

function cell(value, num) {
  return { value, num: !!num };
}

// ---------- pipeline ----------

const PIPELINE_STEPS = [
  { title: 'Your inputs', desc: 'Whatever you type in the form. Only Renewal Rate (or the Agreements counts) and CLM Status are required.' },
  { title: 'Fill the gaps', desc: 'A few fields, like Renewal Rate, get calculated automatically from related numbers if you leave them blank.' },
  { title: '5 scores', desc: 'Renewal Health, Growth, Auto-Renew, Reseller Size, Upsell Opportunity — each rated 0–100.' },
  { title: '1 priority number', desc: 'The 5 scores blend into one Overall Priority score.' },
  { title: 'Your results', desc: 'Diagnosis, Next Action, product pick, and email — all written from the scores above.' },
];

(function renderPipeline() {
  const el = document.getElementById('pipeline');
  const parts = [];
  PIPELINE_STEPS.forEach((step, idx) => {
    parts.push(`<div class="pipeline-step"><span class="step-num">${idx + 1}</span><span class="step-title">${step.title}</span><span class="step-desc">${step.desc}</span></div>`);
    if (idx < PIPELINE_STEPS.length - 1) parts.push('<div class="pipeline-arrow">→</div>');
  });
  el.innerHTML = parts.join('');
})();

// ---------- weight tables ----------

const RENEWAL_HEALTH_LABELS = {
  renewalRate: 'Renewal Rate',
  clm: 'CLM Status',
  notRenewed: 'Not-Renewed Ratio',
  partial: 'Partial-Renewal Ratio',
  autoRenew: 'Auto-Renew score',
};

const GROWTH_LABELS = {
  arr: 'ARR Growth (this quarter)',
  sales: 'Sales Growth (last 12 months)',
  nsb: 'New Business change (last 12 months)',
  licenses: 'Licenses change (last 12 months)',
  endUsers: 'End Users change (last 12 months)',
};

const PRIORITY_LABELS = {
  upsell: 'Upsell Opportunity score',
  growth: 'Growth score',
  renewalRisk: 'Renewal Risk (opposite of Renewal Health)',
  autoRenewGap: 'Auto-Renew Gap (opposite of Auto-Renew score)',
  size: 'Reseller Size score',
};

function renderWeightTable(containerId, weights, labels) {
  const rows = Object.entries(weights).map(([key, w]) => [
    cell(labels[key] || key),
    cell(pct(w), true),
  ]);
  document.getElementById(containerId).innerHTML = table(['Input', 'Weight'], rows);
}

renderWeightTable('tbl-renewal-health', CONFIG.weights.renewalHealth, RENEWAL_HEALTH_LABELS);
renderWeightTable('tbl-growth', CONFIG.weights.growth, GROWTH_LABELS);
renderWeightTable('tbl-priority', CONFIG.weights.priority, PRIORITY_LABELS);

// ---------- delta scale table ----------

(function renderDeltaScale() {
  const rows = Object.entries(CONFIG.deltaScale).map(([key, scale]) => {
    const swing = (50 / scale).toFixed(1);
    return [cell(GROWTH_LABELS[key] || key), cell(scale.toFixed(1), true), cell(`±${swing}%`, true)];
  });
  document.getElementById('tbl-delta-scale').innerHTML = table(['Metric', 'Points per 1% delta', 'Swing to hit 0 or 100'], rows);
})();

// ---------- size curve ----------

(function renderSizeCurve() {
  const rows = CONFIG.sizeScorePoints.map(([share, score]) => [cell(share + '%', true), cell(Math.round(score), true)]);
  document.getElementById('tbl-size-curve').innerHTML = table(['Country-business share', 'Size score'], rows);
})();

// ---------- score bands ----------

const BAND_TITLES = {
  renewalHealth: 'Renewal Health → Renewal Risk label',
  growth: 'Growth',
  autoRenew: 'Auto-Renew',
  upsell: 'Upsell Opportunity',
  priority: 'Overall Priority',
  size: 'Reseller Size (share %)',
};

function bandRangeText(breakpoints, idx) {
  const [min] = breakpoints[idx];
  if (idx === 0) return `≥ ${min}`;
  if (idx === breakpoints.length - 1) return `< ${breakpoints[idx - 1][0]}`;
  return `${min}–${breakpoints[idx - 1][0] - 1}`;
}

(function renderBands() {
  const container = document.getElementById('tbl-bands');
  const tables = Object.entries(CONFIG.bands).map(([key, breakpoints]) => {
    const rows = breakpoints.map((bp, idx) => [cell(bandRangeText(breakpoints, idx), true), cell(bp[1])]);
    return `<p style="margin:18px 0 4px;font-size:0.8rem;font-weight:600;color:var(--text-primary)">${BAND_TITLES[key] || key}</p>` +
      table(['Score', 'Label'], rows);
  });
  container.innerHTML = tables.join('');
})();

// ---------- next-action rules ----------
// Rendered directly from CONFIG.nextActionRules — the exact same array
// buildNextAction() walks in script.js — so this list can't drift from
// the real decision logic.

const RULE_DIMENSION_LABELS = {
  renewalHealth: 'Renewal Risk',
  growth: 'Growth',
  upsell: 'Upsell Opportunity',
  size: 'Reseller Size',
  autoRenew: 'Auto-Renew',
};

function formatRuleCondition(key, value) {
  const label = RULE_DIMENSION_LABELS[key] || key;
  const valueText = Array.isArray(value)
    ? value.map(v => `<strong>${v}</strong>`).join(' or ')
    : `<strong>${value}</strong>`;
  return `${label} is ${valueText}`;
}

function formatRule(rule) {
  const conditions = Object.entries(rule.when).map(([key, value]) => formatRuleCondition(key, value));
  const conditionText = conditions.length ? conditions.join(' and ') : '<em>None of the above matched</em>';
  return `${conditionText} → ${rule.action}`;
}

(function renderRules() {
  document.getElementById('rule-list').innerHTML = CONFIG.nextActionRules.map(r => `<li>${formatRule(r)}</li>`).join('');
})();

// ---------- diagnosis trigger thresholds ----------

const THRESHOLD_LABELS = {
  renewalRate: 'Renewal Rate (%)',
  notRenewedRatio: 'Not-Renewed Ratio',
  partialRatio: 'Partial-Renewal Ratio',
  arrGrowth: 'ARR Growth (%, this quarter)',
  salesGrowth: 'Sales Growth (%, last 12 months)',
  paceRatio: "This month's pace vs. average",
  nsbDelta: 'New Business change (%, last 12 months)',
  licensesDelta: 'Licenses change (%, last 12 months)',
  endUsersDelta: 'End Users change (%, last 12 months)',
  autoRenewGap: 'Auto-Renew gap vs. benchmark',
  upsellRatio: 'Upsell-eligible licenses (%)',
  valueRangeRisk: 'Value-range risk cutoffs (%)',
};

(function renderThresholds() {
  const rows = Object.entries(CONFIG.diagnosticThresholds).map(([key, t]) => {
    const detail = typeof t === 'number'
      ? String(t)
      : Object.entries(t).map(([k, v]) => `${k}: ${v}`).join(', ');
    return [cell(THRESHOLD_LABELS[key] || key), cell(detail)];
  });
  document.getElementById('tbl-thresholds').innerHTML = table(['Signal', 'Trigger points'], rows);
})();

// ---------- inline numeric mentions ----------

document.getElementById('txt-vr-penalty').textContent =
  `systemic −${CONFIG.valueRangeRiskPenalty.systemic}, high-value −${CONFIG.valueRangeRiskPenalty.high}, low-value −${CONFIG.valueRangeRiskPenalty.low} points`;
