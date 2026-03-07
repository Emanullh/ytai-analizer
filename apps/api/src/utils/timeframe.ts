import { Timeframe, TimeframeResolved } from "../types.js";

export function resolveTimeframeRange(timeframe: Timeframe, referenceDate = new Date()): TimeframeResolved {
  const publishedBeforeDate = new Date(referenceDate);
  const publishedAfterDate = new Date(referenceDate);

  if (timeframe === "1m") {
    publishedAfterDate.setMonth(publishedAfterDate.getMonth() - 1);
  } else if (timeframe === "6m") {
    publishedAfterDate.setMonth(publishedAfterDate.getMonth() - 6);
  } else if (timeframe === "1y") {
    publishedAfterDate.setFullYear(publishedAfterDate.getFullYear() - 1);
  } else if (timeframe === "2y") {
    publishedAfterDate.setFullYear(publishedAfterDate.getFullYear() - 2);
  } else {
    publishedAfterDate.setFullYear(publishedAfterDate.getFullYear() - 5);
  }

  return {
    publishedAfter: publishedAfterDate.toISOString(),
    publishedBefore: publishedBeforeDate.toISOString()
  };
}

export function getPublishedAfter(timeframe: Timeframe): string {
  return resolveTimeframeRange(timeframe).publishedAfter;
}
