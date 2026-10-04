/**
 * Household payroll + income tax estimate (approximate, for planning only).
 *
 * Federal (MFJ or single) and an optional state, plus Social Security, Medicare,
 * Additional Medicare, and a flat state disability rate. Parameters live in the
 * profile (`tax`), so a new year or another state is a config change, not code.
 *
 * Pre-tax deductions per earner:
 *   - type "401k" / "457b" / "403b": reduce federal + state wages, NOT FICA wages
 *   - type "pension": 414(h) pickup, same treatment as above
 *   - type "section125": health/dental premiums, reduce federal, state AND FICA wages
 */
function bracketTax(income, brackets) {
  let tax = 0, prev = 0;
  for (const [upTo, rate] of brackets) {
    const top = upTo == null ? Infinity : upTo;
    if (income > prev) tax += (Math.min(income, top) - prev) * rate;
    prev = top;
    if (income <= top) break;
  }
  return tax;
}

function estimateHousehold(earners, t) {
  const rows = earners.map(e => {
    const deds = e.preTax || [];
    const incomeTaxPreTax = deds.reduce((a, d) => a + d.annual, 0);
    const ficaPreTax = deds.filter(d => d.type === 'section125').reduce((a, d) => a + d.annual, 0);
    return {
      member: e.member, gross: e.gross, preTax: deds, incomeTaxPreTax,
      taxableWages: e.gross - incomeTaxPreTax, ficaWages: e.gross - ficaPreTax,
    };
  });
  const totalTaxable = rows.reduce((a, r) => a + r.taxableWages, 0);

  // Federal income tax on the joint return
  const fedTaxable = Math.max(0, totalTaxable - t.federal.standardDeduction);
  let fed = bracketTax(fedTaxable, t.federal.brackets);
  const ctc = (t.federal.childTaxCredit || 0) * (t.dependentsUnder17 || 0);
  fed = Math.max(0, fed - ctc);

  // State income tax
  let state = 0;
  if (t.state) {
    const stTaxable = Math.max(0, totalTaxable - t.state.standardDeduction);
    state = Math.max(0, bracketTax(stTaxable, t.state.brackets) - (t.state.exemptionCredits || 0));
  }

  // Payroll taxes (per earner)
  const totalFicaWages = rows.reduce((a, r) => a + r.ficaWages, 0);
  for (const r of rows) {
    r.socialSecurity = Math.min(r.ficaWages, t.fica.ssWageBase) * t.fica.ssRate;
    r.medicare = r.ficaWages * t.fica.medicareRate;
    r.sdi = t.state && t.state.sdiRate ? r.gross * t.state.sdiRate : 0;
  }
  const addlMedicare = Math.max(0, totalFicaWages - t.fica.addlMedicareThreshold) * t.fica.addlMedicareRate;

  // Allocate joint income taxes by share of taxable wages
  for (const r of rows) {
    const share = totalTaxable ? r.taxableWages / totalTaxable : 0;
    r.federal = fed * share;
    r.state = state * share;
    r.addlMedicare = addlMedicare * (totalFicaWages ? r.ficaWages / totalFicaWages : 0);
    r.totalTax = r.federal + r.state + r.socialSecurity + r.medicare + r.sdi + r.addlMedicare;
    r.takeHome = r.gross - r.incomeTaxPreTax - r.totalTax;
    r.effectiveRate = r.gross ? r.totalTax / r.gross : 0;
  }
  const total = k => rows.reduce((a, r) => a + r[k], 0);
  return {
    rows, fedTaxable, federal: fed, childTaxCredit: ctc, state, addlMedicare,
    totalTax: total('totalTax'), takeHome: total('takeHome'), gross: total('gross'),
    effectiveRate: total('gross') ? total('totalTax') / total('gross') : 0,
  };
}

module.exports = { estimateHousehold, bracketTax };
