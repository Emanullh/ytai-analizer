import { Timeframe } from "../types.js";

export function getPublishedAfter(timeframe: Timeframe): string {
  const now = new Date();
  const targetDate = new Date(now);

  if (timeframe === "1m") {
    targetDate.setMonth(targetDate.getMonth() - 1);
  } else if (timeframe === "6m") {
    targetDate.setMonth(targetDate.getMonth() - 6);
  } else {
    targetDate.setFullYear(targetDate.getFullYear() - 1);
  }

  return targetDate.toISOString();
}
