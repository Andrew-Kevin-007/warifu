// Calendar helpers on top of the schemas' epoch-second functions (no Date; whole-second UTC only).
import { epochSecondsFromIso, isoFromEpochSeconds, type ISODate, type ISODateTime } from "@symbolon/schemas";

export const DAY = 86_400n;

export function addSeconds(iso: ISODateTime, seconds: bigint | number): ISODateTime {
  return isoFromEpochSeconds(epochSecondsFromIso(iso) + BigInt(seconds));
}

export function addDays(iso: ISODateTime, days: number): ISODateTime {
  return addSeconds(iso, BigInt(days) * DAY);
}

export function dateOf(iso: ISODateTime): ISODate {
  return iso.slice(0, 10);
}
