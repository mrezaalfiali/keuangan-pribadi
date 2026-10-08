export type RecurrenceFrequency = "weekly" | "monthly";

export interface RecurrenceSchedule {
  frequency: RecurrenceFrequency;
  intervalCount: number;
  anchorDay: number;
}

export function todayJakartaISO(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: "year" | "month" | "day") =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseISODate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error("err.period");
  }
  return date;
}

function formatISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function nextRecurringDate(
  currentDueOn: string,
  schedule: RecurrenceSchedule
): string {
  const current = parseISODate(currentDueOn);
  if (!Number.isInteger(schedule.intervalCount) || schedule.intervalCount < 1 || schedule.intervalCount > 12) {
    throw new Error("err.interval");
  }

  let next: Date;
  if (schedule.frequency === "weekly") {
    next = new Date(current.getTime() + schedule.intervalCount * 7 * 86_400_000);
  } else {
    if (!Number.isInteger(schedule.anchorDay) || schedule.anchorDay < 1 || schedule.anchorDay > 31) {
      throw new Error("err.interval");
    }
    const monthIncrement = (date: Date) =>
      new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + schedule.intervalCount, 1));
    const forMonth = (month: Date) => {
      const lastDay = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0)).getUTCDate();
      return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), Math.min(schedule.anchorDay, lastDay)));
    };
    const month = monthIncrement(current);
    next = forMonth(month);
  }
  return formatISODate(next);
}
