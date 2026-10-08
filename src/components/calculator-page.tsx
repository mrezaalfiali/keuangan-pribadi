"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/src/components/ui/card";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import {
  emergencyFund,
  evaluateArithmetic,
  loanPayment,
  salaryAllocation,
  savingsGoal,
  type LoanMethod,
} from "@/src/lib/calculator";
import { formatRupiah, parseAmount } from "@/src/lib/money";
import { cn } from "@/src/lib/utils";

type Tool = "loan" | "emergency" | "goal" | "salary" | "arithmetic";

const TOOLS: { id: Tool; key: string }[] = [
  { id: "loan", key: "loan.title" },
  { id: "emergency", key: "emergency.title" },
  { id: "goal", key: "goal.title" },
  { id: "salary", key: "salary.title" },
  { id: "arithmetic", key: "arithmetic.title" },
];

/** Angka desimal untuk kalkulator aritmetika; maks. 2 desimal, tanpa desimal kosong. */
function formatDecimal(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

function ResultList({ rows }: { rows: { label: string; value: string; strong?: boolean }[] }) {
  return (
    <dl className="space-y-2">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-baseline justify-between gap-4 border-t border-line pt-2 first:border-0 first:pt-0"
        >
          <dt className="text-sm text-muted">{row.label}</dt>
          <dd
            className={cn(
              "num shrink-0 text-right font-semibold",
              row.strong ? "text-lg text-accent" : "text-sm text-ink"
            )}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** null = tidak akan tercapai, 0 = sudah tercapai, selain itu jumlah bulan. */
function MonthsText({ months }: { months: number | null }) {
  const t = useTranslations("calculator");
  if (months === null) return <>{t("unreachable")}</>;
  if (months === 0) return <>{t("reached")}</>;
  if (months < 12) return <>{t("months", { count: months })}</>;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  return (
    <>
      {rest === 0
        ? t("years", { count: years })
        : t("yearsMonths", { years, months: rest })}
    </>
  );
}

export function CalculatorPage() {
  const t = useTranslations("calculator");
  const [tool, setTool] = useState<Tool>("loan");

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          {t("title")}
        </h1>
        <p className="text-sm text-muted">{t("subtitle")}</p>
      </header>

      <div role="tablist" aria-label={t("pick")} className="flex flex-wrap gap-2">
        {TOOLS.map((item) => (
          <Button
            key={item.id}
            role="tab"
            aria-selected={tool === item.id}
            variant={tool === item.id ? "default" : "outline"}
            size="sm"
            onClick={() => setTool(item.id)}
          >
            {t(item.key)}
          </Button>
        ))}
      </div>

      {tool === "loan" && <LoanCalculator />}
      {tool === "emergency" && <EmergencyCalculator />}
      {tool === "goal" && <GoalCalculator />}
      {tool === "salary" && <SalaryAllocationCalculator />}
      {tool === "arithmetic" && <ArithmeticCalculator />}
    </div>
  );
}

function LoanCalculator() {
  const t = useTranslations("calculator");
  const [principal, setPrincipal] = useState("");
  const [rate, setRate] = useState("");
  const [months, setMonths] = useState("");
  const [method, setMethod] = useState<LoanMethod>("flat");

  const result = useMemo(
    () =>
      loanPayment({
        principal: parseAmount(principal),
        annualRate: Number(rate.replace(",", ".")) || 0,
        months: Math.trunc(Number(months) || 0),
        method,
      }),
    [principal, rate, months, method]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("loan.title")}</CardTitle>
        <CardDescription>{t("loan.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label={t("loan.principal")}>
          <Input
            inputMode="numeric"
            placeholder="100000000"
            value={principal}
            onChange={(e) => setPrincipal(e.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("loan.rate")}>
            <Input
              inputMode="decimal"
              placeholder="5"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </Field>
          <Field label={t("loan.months")}>
            <Input
              inputMode="numeric"
              placeholder="24"
              value={months}
              onChange={(e) => setMonths(e.target.value)}
            />
          </Field>
        </div>

        <Field label={t("loan.method")}>
          <div className="flex flex-wrap gap-2">
            {(["flat", "effective"] as const).map((m) => (
              <Button
                key={m}
                variant={method === m ? "default" : "outline"}
                size="sm"
                onClick={() => setMethod(m)}
              >
                {t(`loan.method_${m}`)}
              </Button>
            ))}
          </div>
        </Field>
        <p className="text-xs text-faint">{t(`loan.hint_${method}`)}</p>

        {result ? (
          <ResultList
            rows={[
              { label: t("loan.monthlyPayment"), value: formatRupiah(result.monthlyPayment), strong: true },
              { label: t("loan.totalInterest"), value: formatRupiah(result.totalInterest) },
              { label: t("loan.totalPayment"), value: formatRupiah(result.totalPayment) },
            ]}
          />
        ) : (
          <p className="text-xs text-faint">{t("loan.needInput")}</p>
        )}
      </CardContent>
    </Card>
  );
}

const MULTIPLIERS = [3, 6, 12];

function EmergencyCalculator() {
  const t = useTranslations("calculator");
  const [expense, setExpense] = useState("");
  const [saved, setSaved] = useState("");
  const [contribution, setContribution] = useState("");
  const [multiplier, setMultiplier] = useState(6);

  const result = useMemo(
    () =>
      emergencyFund({
        monthlyExpense: parseAmount(expense),
        multiplier,
        saved: parseAmount(saved),
        monthlyContribution: parseAmount(contribution),
      }),
    [expense, saved, contribution, multiplier]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("emergency.title")}</CardTitle>
        <CardDescription>{t("emergency.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label={t("emergency.expense")}>
          <Input
            inputMode="numeric"
            placeholder="5000000"
            value={expense}
            onChange={(e) => setExpense(e.target.value)}
          />
        </Field>
        <Field label={t("emergency.multiplier")}>
          <div className="flex flex-wrap gap-2">
            {MULTIPLIERS.map((m) => (
              <Button
                key={m}
                variant={multiplier === m ? "default" : "outline"}
                size="sm"
                onClick={() => setMultiplier(m)}
              >
                {t("emergency.monthsOfExpense", { count: m })}
              </Button>
            ))}
          </div>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("emergency.saved")}>
            <Input
              inputMode="numeric"
              placeholder="0"
              value={saved}
              onChange={(e) => setSaved(e.target.value)}
            />
          </Field>
          <Field label={t("emergency.contribution")}>
            <Input
              inputMode="numeric"
              placeholder="1000000"
              value={contribution}
              onChange={(e) => setContribution(e.target.value)}
            />
          </Field>
        </div>

        {result ? (
          <>
            <ResultList
              rows={[
                { label: t("emergency.target"), value: formatRupiah(result.target), strong: true },
                { label: t("emergency.remaining"), value: formatRupiah(result.remaining) },
              ]}
            />
            <p className="text-sm text-muted">
              {t("emergency.time")}{" "}
              <span className="font-semibold text-ink">
                <MonthsText months={result.monthsToGoal} />
              </span>
            </p>
          </>
        ) : (
          <p className="text-xs text-faint">{t("emergency.needInput")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function GoalCalculator() {
  const t = useTranslations("calculator");
  const [current, setCurrent] = useState("");
  const [target, setTarget] = useState("");
  const [contribution, setContribution] = useState("");

  const result = useMemo(
    () =>
      savingsGoal({
        current: parseAmount(current),
        target: parseAmount(target),
        monthlyContribution: parseAmount(contribution),
      }),
    [current, target, contribution]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("goal.title")}</CardTitle>
        <CardDescription>{t("goal.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("goal.current")}>
            <Input
              inputMode="numeric"
              placeholder="2500000"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
          </Field>
          <Field label={t("goal.target")}>
            <Input
              inputMode="numeric"
              placeholder="50000000"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </Field>
        </div>
        <Field label={t("goal.contribution")}>
          <Input
            inputMode="numeric"
            placeholder="2500000"
            value={contribution}
            onChange={(e) => setContribution(e.target.value)}
          />
        </Field>

        {result ? (
          <>
            <ResultList
              rows={[
                { label: t("goal.remaining"), value: formatRupiah(result.remaining), strong: true },
              ]}
            />
            <p className="text-sm text-muted">
              {t("goal.time")}{" "}
              <span className="font-semibold text-ink">
                <MonthsText months={result.monthsToGoal} />
              </span>
            </p>
          </>
        ) : (
          <p className="text-xs text-faint">{t("goal.needInput")}</p>
        )}
      </CardContent>
    </Card>
  );
}

function SalaryAllocationCalculator() {
  const t = useTranslations("calculator");
  const defaultLabels = useMemo(
    () => ({
      needs: t("salary.defaults.needs"),
      wants: t("salary.defaults.wants"),
      savings: t("salary.defaults.savings"),
      goals: t("salary.defaults.goals"),
    }),
    [t]
  );

  const makeCategory = (key: string, label: string, percent: string) => ({ key, label, percent });

  const [income, setIncome] = useState("");
  const [allocations, setAllocations] = useState([
    makeCategory("needs", defaultLabels.needs, "50"),
    makeCategory("wants", defaultLabels.wants, "20"),
    makeCategory("savings", defaultLabels.savings, "20"),
    makeCategory("goals", defaultLabels.goals, "10"),
  ]);

  const result = useMemo(() => {
    const parsedIncome = parseAmount(income);
    if (!parsedIncome || parsedIncome <= 0) return null;

    const items = allocations.map((allocation) => ({
      label: allocation.label || t("salary.newCategory"),
      percent: Number(allocation.percent) || 0,
    }));

    return salaryAllocation({ income: parsedIncome, allocations: items });
  }, [income, allocations, t]);

  const palette = ["#6f6a64", "#9b8b7a", "#b7aa9a", "#806b5a", "#d0c5b8", "#a89f96"];

  const chartData = result?.items.map((item, index) => ({
    name: item.label,
    value: item.amount,
    fill: palette[index % palette.length],
  })) ?? [];

  const applyPreset = (values: string[]) => {
    setAllocations((current) =>
      current.map((item, index) => ({
        ...item,
        percent: values[index] ?? item.percent,
      }))
    );
  };

  const updatePercent = (key: string, value: string) => {
    setAllocations((current) =>
      current.map((item) => (item.key === key ? { ...item, percent: value } : item))
    );
  };

  const updateLabel = (key: string, value: string) => {
    setAllocations((current) =>
      current.map((item) => (item.key === key ? { ...item, label: value } : item))
    );
  };

  const addCategory = () => {
    setAllocations((current) => [
      ...current,
      makeCategory(`custom-${Date.now()}-${current.length}`, t("salary.newCategory"), "10"),
    ]);
  };

  const removeCategory = (key: string) => {
    setAllocations((current) => {
      if (current.length <= 1) return current;
      return current.filter((item) => item.key !== key);
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("salary.title")}</CardTitle>
        <CardDescription>{t("salary.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Field label={t("salary.income")}>
          <Input
            inputMode="numeric"
            placeholder="10000000"
            value={income}
            onChange={(e) => setIncome(e.target.value)}
          />
        </Field>

        <div className="flex flex-wrap gap-2">
          {(["50,20,20,10", "60,15,15,10", "40,25,20,15"] as const).map((preset) => (
            <Button
              key={preset}
              variant="outline"
              size="sm"
              onClick={() => applyPreset(preset.split(","))}
            >
              {preset.replace(/,/g, "/")}
            </Button>
          ))}
        </div>

        <div className="rounded-2xl border border-dashed border-accent/30 bg-accent/5 p-3.5">
          <p className="text-xs uppercase tracking-[0.2em] text-muted">{t("salary.whyTitle")}</p>
          <p className="mt-2 text-sm leading-6 text-muted">{t("salary.whyDescription")}</p>
        </div>

        <div className="space-y-3">
          {allocations.map((item) => (
            <div key={item.key} className="grid gap-3 rounded-2xl border border-line bg-bg1/60 p-3 sm:grid-cols-[1fr_0.7fr_0.6fr]">
              <Field label={t("salary.categoryName")}>
                <Input
                  value={item.label}
                  onChange={(e) => updateLabel(item.key, e.target.value)}
                />
              </Field>
              <Field label={t("salary.percentage")}>
                <Input
                  inputMode="decimal"
                  value={item.percent}
                  onChange={(e) => updatePercent(item.key, e.target.value)}
                />
              </Field>
              <div className="flex items-end gap-2">
                <div className="w-full rounded-xl border border-line bg-surface px-3 py-2.5 text-sm text-muted">
                  {result ? formatRupiah(result.items.find((entry) => entry.label === item.label)?.amount ?? 0) : t("salary.preview")}
                </div>
                {allocations.length > 1 && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeCategory(item.key)}>
                    {t("salary.remove")}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>

        <Button type="button" variant="outline" onClick={addCategory}>
          + {t("salary.addCategory")}
        </Button>

        {result ? (
          <div className="space-y-5">
            <div className="rounded-xl border border-line bg-bg1/60 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-muted">{t("salary.summary")}</p>
              <p className="mt-2 text-sm text-muted">
                {t("salary.totalPercent")} <span className="font-semibold text-ink">{result.totalPercent.toFixed(2)}%</span>
              </p>
              <p className="mt-1 text-sm text-muted">
                {t("salary.remaining")} <span className="font-semibold text-ink">{formatRupiah(result.remaining)}</span>
              </p>
            </div>

            <div className="grid gap-5 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="rounded-2xl border border-line bg-bg1/60 p-3">
                <p className="mb-3 text-sm font-medium text-ink">{t("salary.chart")}</p>
                <div className="h-56 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={chartData} dataKey="value" nameKey="name" innerRadius={42} outerRadius={78} paddingAngle={2}>
                        {chartData.map((entry) => (
                          <Cell key={entry.name} fill={entry.fill} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value, name) => [formatRupiah(Number(value ?? 0)), String(name)]}
                        contentStyle={{
                          borderRadius: 14,
                          border: "1px solid rgba(183, 170, 154, 0.36)",
                          background: "rgba(48, 43, 38, 0.96)",
                          boxShadow: "0 12px 30px rgba(48, 43, 38, 0.2)",
                          color: "#f3eee7",
                          padding: "10px 12px",
                        }}
                        itemStyle={{
                          color: "#f3eee7",
                          fontWeight: 600,
                          fontSize: 12,
                        }}
                        labelStyle={{
                          color: "#c8b9a8",
                          fontSize: 11,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                        }}
                        cursor={{ fill: "rgba(155, 139, 122, 0.12)" }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="space-y-2">
                <ResultList
                  rows={result.items.map((item, index) => ({
                    label: item.label,
                    value: `${formatRupiah(item.amount)} (${item.percent.toFixed(2)}%)`,
                    strong: index === 0,
                  }))}
                />
              </div>
            </div>
          </div>
        ) : (
          <p className="text-xs text-faint">{t("salary.needInput")}</p>
        )}
      </CardContent>
    </Card>
  );
}

/** Baris tombol angka, 3 kolom x 4 baris. */
const DIGIT_ROWS = [
  ["7", "8", "9"],
  ["4", "5", "6"],
  ["1", "2", "3"],
  ["0", ".", "%"],
] as const;

/** Kolom operator, sejajar dengan baris tombol angka. */
const OPERATORS = ["/", "*", "-", "+"] as const;

/** Tombol utilitas di atas keypad. */
const UTILITY_KEYS = [
  { key: "(", label: "(", action: "append" },
  { key: ")", label: ")", action: "append" },
  { key: "clear", label: "arithmetic.clear", action: "clear" },
  { key: "back", label: "arithmetic.back", action: "back" },
] as const;

function ArithmeticCalculator() {
  const t = useTranslations("calculator");
  const [expression, setExpression] = useState("");
  const result = useMemo(() => evaluateArithmetic(expression), [expression]);

  const apply = (
    action: "append" | "clear" | "back",
    key?: string
  ) => {
    if (action === "clear") return setExpression("");
    if (action === "back") return setExpression((p) => p.slice(0, -1));
    setExpression((p) => p + key);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("arithmetic.title")}</CardTitle>
        <CardDescription>{t("arithmetic.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="num flex min-h-16 items-center justify-end truncate rounded-xl bg-bg1 px-4 py-3 text-right text-2xl font-semibold text-ink">
          {expression === "" ? "0" : expression}
        </div>

        {result.error ? (
          <p className="text-right text-xs text-danger">
            {result.error === "divideByZero"
              ? t("arithmetic.divideByZero")
              : t("arithmetic.invalid")}
          </p>
        ) : (
          <p className="num truncate text-right text-sm text-muted">
            {t("arithmetic.result")} {formatDecimal(result.value)}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {UTILITY_KEYS.map((item) => (
            <Button
              key={item.key}
              variant="ghost"
              size="sm"
              onClick={() =>
                apply(item.action, item.action === "append" ? item.key : undefined)
              }
            >
              {item.key === "clear" || item.key === "back" ? t(item.label) : item.label}
            </Button>
          ))}
        </div>

        <div className="grid grid-cols-4 gap-3">
          <div className="col-span-3 grid grid-cols-3 gap-2">
            {DIGIT_ROWS.flat().map((key) => (
              <Button
                key={key}
                variant="outline"
                size="lg"
                className="num text-lg"
                onClick={() => apply("append", key)}
              >
                {key}
              </Button>
            ))}
          </div>
          <div className="grid grid-cols-1 gap-2">
            {OPERATORS.map((key) => (
              <Button
                key={key}
                variant="default"
                size="lg"
                className="num text-lg"
                onClick={() => apply("append", key)}
              >
                {key}
              </Button>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}