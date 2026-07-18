export interface AnalyticsTrace {
  phases?: Array<{ step?: string; detail?: string }>;
  verifications?: Array<{ verdict?: string }>;
}

export function computeTraceScore(trace: AnalyticsTrace): number;
export function scoreGrade(score: number): "S" | "A" | "B" | "C" | "D" | "F";
export function traceCompliance(trace: AnalyticsTrace): Array<{ step: string; complete: boolean }>;
export function requiredTraceSteps(): string[];
