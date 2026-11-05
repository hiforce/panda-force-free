import { isRecord } from "../../src/shared/records.js";
import { verificationPlan } from "../testing/verification-plan.js";

/** Accept only complete runs; a green subset or repeated suite cannot certify a release. */
export function assertCompleteVerification(result: unknown): asserts result is Record<string, unknown> {
  if (
    !isRecord(result) ||
    result.group !== "verify" ||
    result.passed !== true ||
    !Array.isArray(result.planned) ||
    !Array.isArray(result.suites) ||
    !Array.isArray(result.notRun) ||
    result.notRun.length ||
    JSON.stringify(result.planned) !== JSON.stringify(verificationPlan) ||
    result.suites.length !== verificationPlan.length ||
    new Set(result.suites.map((suite: unknown) => (isRecord(suite) ? suite.name : undefined))).size !==
      verificationPlan.length ||
    result.suites.some(
      (suite: unknown) =>
        !isRecord(suite) ||
        !verificationPlan.includes(String(suite.name)) ||
        suite.code !== 0 ||
        suite.timedOut !== false,
    ) ||
    !Number.isFinite(Date.parse(String(result.startedAt))) ||
    !Number.isFinite(Date.parse(String(result.finishedAt))) ||
    Date.parse(String(result.finishedAt)) < Date.parse(String(result.startedAt))
  )
    throw new Error("Incomplete verification cannot certify an image");
}
