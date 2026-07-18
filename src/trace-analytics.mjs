const REQUIRED_STEPS = ["ambiguity", "invariants", "gate", "commit", "summary"];

export function computeTraceScore(trace) {
  const phases = Array.isArray(trace?.phases) ? trace.phases : [];
  const verifications = Array.isArray(trace?.verifications) ? trace.verifications : [];
  const completed = new Set(phases.map((phase) => phase.step));
  const protocol = REQUIRED_STEPS.filter((step) => completed.has(step)).length / REQUIRED_STEPS.length;
  const known = verifications.filter((record) => record.verdict !== "skipped");
  const passes = known.filter((record) => record.verdict === "pass").length;
  const verification = known.length === 0 ? 0 : passes / known.length;
  const evidenced = REQUIRED_STEPS.filter((step) => phases.some((phase) => phase.step === step && phase.detail)).length / REQUIRED_STEPS.length;
  const analyses = Math.min(1, phases.filter((phase) => phase.step === "analysis").length / 2);
  return Math.round(protocol * 35 + verification * 40 + evidenced * 15 + analyses * 10);
}

export function scoreGrade(score) {
  if (score >= 90) return "S";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function traceCompliance(trace) {
  const phases = Array.isArray(trace?.phases) ? trace.phases : [];
  const completed = new Set(phases.map((phase) => phase.step));
  return REQUIRED_STEPS.map((step) => ({ step, complete: completed.has(step) }));
}

export function requiredTraceSteps() {
  return [...REQUIRED_STEPS];
}
