"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { Card, CardContent } from "@/src/components/ui/card";
import { buildCashflow, hasCashflowActivity } from "@/src/lib/cashflow";
import { currentMonthISO } from "@/src/lib/utils";

type RangeMonths = 6 | 12;
type View = "net" | "split";

/**
 * Colors are passed to SVG attributes, which accept `var(--token)` directly, so
 * the light/dark toggle repaints the chart without a re-render. Reading the
 * computed values in JS instead would freeze them at the theme present on
 * first paint.
 */
const AXIS_TICK = { fill: "var(--faint)", fontSize: 11 } as const;

const TOOLTIP_STYLE = {
  background: "var(--surface)",
  border: "1px solid var(--line)",
  borderRadius: 12,
  fontSize: 12,
} as const;

const AXIS_PROPS = { axisLine: false, tickLine: false } as const;

export function CashflowChart({
  transactions,
}: {
  transactions: { type: "income" | "expense" | "transfer"; amount: number; date: string }[];
}) {
  const dashboard = useTranslations("dashboard");
  const appLocale = useLocale();
  const locale = appLocale === "id" ? "id-ID" : "en-US";
  const [range, setRange] = useState<RangeMonths>(12);
  const [view, setView] = useState<View>("net");

  const data = buildCashflow(transactions, currentMonthISO().slice(0, 7), range);
  const active = hasCashflowActivity(data);

  const monthLabel = (month: string) =>
    new Intl.DateTimeFormat(locale, { month: "short" }).format(
      new Date(`${month}-01T00:00:00`)
    );
  const money = (value: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "IDR",
      maximumFractionDigits: 0,
    }).format(value);

  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold text-ink">
            {dashboard("cashflow")}
          </h2>
          <div className="flex flex-wrap items-center gap-1">
            <Toggle active={view === "net"} onClick={() => setView("net")}>
              {dashboard("chartNet")}
            </Toggle>
            <Toggle active={view === "split"} onClick={() => setView("split")}>
              {dashboard("chartSplit")}
            </Toggle>
            <span className="mx-1 h-4 w-px bg-line" />
            {([6, 12] as const).map((months) => (
              <Toggle key={months} active={range === months} onClick={() => setRange(months)}>
                {dashboard("chartMonths", { count: months })}
              </Toggle>
            ))}
          </div>
        </div>

        {!active ? (
          <p className="py-16 text-center text-sm text-muted">{dashboard("chartEmpty")}</p>
        ) : (
          <div className="mt-5 h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              {view === "net" ? (
                <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tickFormatter={monthLabel}
                    tick={AXIS_TICK}
                    {...AXIS_PROPS}
                    minTickGap={8}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    {...AXIS_PROPS}
                    width={72}
                    tickFormatter={(value: number) => money(value)}
                  />
                  <Tooltip
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(label) => String(label)}
                    formatter={(value) => money(Number(value ?? 0))}
                  />
                  <Line
                    type="monotone"
                    dataKey="net"
                    name={dashboard("chartNet")}
                    stroke="var(--accent)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 4, fill: "var(--accent)", stroke: "var(--surface)" }}
                  />
                </LineChart>
              ) : (
                <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis
                    dataKey="month"
                    tickFormatter={monthLabel}
                    tick={AXIS_TICK}
                    {...AXIS_PROPS}
                    minTickGap={8}
                  />
                  <YAxis
                    tick={AXIS_TICK}
                    {...AXIS_PROPS}
                    width={72}
                    tickFormatter={(value: number) => money(value)}
                  />
                  <Tooltip
                    cursor={{ fill: "var(--surface2)" }}
                    contentStyle={TOOLTIP_STYLE}
                    labelFormatter={(label) => String(label)}
                    formatter={(value, name) => [
                      money(Number(value ?? 0)),
                      name === "income" ? dashboard("income") : dashboard("expense"),
                    ]}
                  />
                  <Bar dataKey="income" name={dashboard("income")} fill="var(--accent)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="expense" name={dashboard("expense")} fill="var(--danger)" radius={[4, 4, 0, 0]} />
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Toggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
        active
          ? "bg-accent text-bg0"
          : "bg-transparent text-muted hover:bg-surface2 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}
