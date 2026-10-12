// Time at the service edge. The kernel never reads a clock (INV-9): this module is where wall time enters, as one
// whole-second UTC string (ISODateTime, docs/QUESTIONS WP-01 item 1) that is then handed to kernel-core as ctx.now.
import { epochSecondsFromIso, isoFromEpochSeconds } from "@symbolon/schemas";
import type { ISODateTime } from "@symbolon/schemas";

export type Clock = () => number; // epoch milliseconds

export const systemClock: Clock = () => Date.now();

export function nowIso(clock: Clock): ISODateTime {
  return isoFromEpochSeconds(BigInt(Math.floor(clock() / 1000)));
}

const PG_TS = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

/** A timestamptz as returned by Postgres (text, any offset) or a Date, as whole-second UTC ISO; throws on anything else. */
export function toIsoSeconds(v: unknown): ISODateTime {
  let ms: number;
  if (v instanceof Date) ms = v.getTime();
  else if (typeof v === "string") {
    const m = PG_TS.exec(v);
    if (m === null) throw new TypeError("not a timestamp");
    const n = (i: number): number => Number.parseInt(m[i] ?? "", 10);
    ms = Date.UTC(n(1), n(2) - 1, n(3), n(4), n(5), n(6));
    const off = m[7];
    if (off !== undefined && off !== "Z") {
      const sign = off.startsWith("-") ? -1 : 1;
      const digits = off.slice(1).replace(":", "");
      const oh = Number.parseInt(digits.slice(0, 2), 10);
      const om = digits.length > 2 ? Number.parseInt(digits.slice(2, 4), 10) : 0;
      ms -= sign * (oh * 60 + om) * 60_000;
    }
  } else throw new TypeError("not a timestamp");
  if (!Number.isFinite(ms)) throw new TypeError("not a timestamp");
  return isoFromEpochSeconds(BigInt(Math.floor(ms / 1000)));
}

export function plusSeconds(iso: ISODateTime, seconds: number): ISODateTime {
  return isoFromEpochSeconds(epochSecondsFromIso(iso) + BigInt(seconds));
}
