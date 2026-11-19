import { BotError } from "../../../shared/bots/contracts.js";
import { isRecord } from "../../../shared/records.js";
import type { BotSchedule } from "../../../shared/bots/integrations.js";

export function botSchedule(value: unknown): BotSchedule {
  if (!isRecord(value)) throw new BotError("invalidSchedule");
  if (
    value.kind === "interval" &&
    Object.keys(value).every((k) => ["kind", "minutes"].includes(k)) &&
    Number.isInteger(value.minutes) &&
    Number(value.minutes) >= 5 &&
    Number(value.minutes) <= 10080
  )
    return { kind: "interval", minutes: Number(value.minutes) };
  if (
    value.kind === "daily" &&
    Object.keys(value).every((k) => ["kind", "time", "timezone"].includes(k)) &&
    typeof value.time === "string" &&
    /^([01]\d|2[0-3]):[0-5]\d$/.test(value.time) &&
    typeof value.timezone === "string" &&
    value.timezone.length <= 80
  ) {
    try {
      const zone = new Intl.DateTimeFormat("en", { timeZone: value.timezone }).resolvedOptions().timeZone;
      return { kind: "daily", time: value.time, timezone: zone };
    } catch {
      throw new BotError("invalidSchedule");
    }
  }
  throw new BotError("invalidSchedule");
}
export function botScheduleDay(schedule: Extract<BotSchedule, { kind: "daily" }>, at: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: schedule.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  return ["year", "month", "day"].map((key) => parts.find((p) => p.type === key)!.value).join("-");
}
/** Coalesce missed periods. A daily wall-clock slot runs once per local date, including DST folds. */
export function nextBotSchedule(schedule: BotSchedule, now: number, lastLocalDay?: string): number {
  if (schedule.kind === "interval") return now + schedule.minutes * 60000;
  const format = new Intl.DateTimeFormat("en-GB", {
    timeZone: schedule.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  let candidate = Math.floor(now / 60000) * 60000 + 60000;
  // A skipped DST time advances to the next valid day. No catch-up burst is generated.
  for (let minute = 0; minute < 3 * 24 * 60; minute++, candidate += 60000) {
    const parts = format.formatToParts(candidate),
      get = (key: string) => parts.find((p) => p.type === key)!.value;
    if (
      get("hour") + ":" + get("minute") === schedule.time &&
      [get("year"), get("month"), get("day")].join("-") !== lastLocalDay
    )
      return candidate;
  }
  throw new BotError("invalidSchedule");
}
