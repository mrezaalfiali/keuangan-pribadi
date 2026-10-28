"use client";

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, CalendarClock, Check, ChevronDown, ChevronLeft, ChevronRight, CircleDollarSign, Pause, Pencil, Play, Plus, SkipForward, Trash2, X } from "lucide-react";
import { Card, CardContent } from "@/src/components/ui/card";
import { CashflowChart } from "@/src/components/cashflow-chart";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { createClient } from "@/src/lib/supabase/client";
import { logSupabaseError } from "@/src/lib/supabase/errors";
import { ensureDefaultCategories } from "@/src/lib/system-categories";
import { addTransaction, deleteTransaction, editTransaction } from "@/src/lib/actions/transactions";
import { createIncomeSource, deleteIncomeSource, updateIncomeSource } from "@/src/lib/actions/categories";
import {
  applySourceOverrides,
  computeSourceVaultBalances,
  sourceVaultBalance,
  summarizeSources,
  type SourceOverride,
  type SourceSummary,
} from "@/src/lib/sources";
import { resolveLabel, humanizeSlug, sortByLabel } from "@/src/lib/labels";
import { todayISO } from "@/src/lib/utils";
import { buildMonthlySummary, shiftMonth } from "@/src/lib/monthly-summary";
import { budgetSpend, budgetState, budgetStatus } from "@/src/lib/budget";
import { filterTransactions } from "@/src/lib/transaction-filters";
import { todayJakartaISO } from "@/src/lib/recurring";
import { getOnboardingSteps } from "@/src/lib/onboarding-checklist";
import { Link } from "@/src/i18n/navigation";
import {
  deleteRecurringTemplate,
  recordRecurringTransaction,
  saveRecurringTemplate,
  setRecurringTemplateActive,
  skipRecurringOccurrence,
  snoozeRecurringOccurrence,
} from "@/src/lib/actions/recurring";
import type { Budget, Category, RecurringTransaction, Transaction, Vault } from "@/src/lib/types";

type CategoryRef = Pick<Category, "id" | "slug" | "name_key">;

type TxRow = Transaction & {
  vault: Pick<Vault, "id" | "slug" | "name" | "is_locked"> | null;
  category: CategoryRef | null;
  funding: CategoryRef | null;
};

/**
 * Status "sembunyikan panduan langkah dasar" disimpan di luar React (localStorage)
 * dan dibaca lewat `useSyncExternalStore` agar tidak memicu setState di effect.
 */
const ONBOARDING_DISMISSED_KEY = "nexora:onboarding-dismissed";
let onboardingDismissedValue = false;
let onboardingDismissedLoaded = false;
const onboardingDismissedListeners = new Set<() => void>();

function getOnboardingDismissedSnapshot() {
  if (!onboardingDismissedLoaded) {
    try {
      onboardingDismissedValue = localStorage.getItem(ONBOARDING_DISMISSED_KEY) === "1";
    } catch {
      onboardingDismissedValue = false;
    }
    onboardingDismissedLoaded = true;
  }
  return onboardingDismissedValue;
}

function subscribeOnboardingDismissed(listener: () => void) {
  onboardingDismissedListeners.add(listener);
  return () => {
    onboardingDismissedListeners.delete(listener);
  };
}

function dismissOnboardingStore() {
  onboardingDismissedValue = true;
  onboardingDismissedLoaded = true;
  try {
    localStorage.setItem(ONBOARDING_DISMISSED_KEY, "1");
  } catch {
    // localStorage bisa tidak tersedia (mode privat); abaikan.
  }
  onboardingDismissedListeners.forEach((listener) => listener());
}

function formatMoney(amount: number, locale: string) {
  return new Intl.NumberFormat(locale === "id" ? "id-ID" : "en-US", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

interface OccurrenceCopy {
  amount: string;
  date: string;
  category: string;
  sourceVault: string;
  fundingSource: string;
  selectVault: string;
  selectVaultFirst: string;
  noSourceInVault: string;
  note: string;
  none: string;
  noVault: string;
  recurringRecord: string;
  recurringRemindTomorrow: string;
  recurringSkip: string;
  occurrenceHint: string;
  allocationMode: string;
  allocationAuto: string;
  allocationSingle: string;
  allocationAutoHint: string;
  allocationSingleHint: string;
  vaultRequired: string;
  vaultNone: string;
}

/**
 * Form pencatatan satu kemunculan jadwal. Dipisah jadi komponen sendiri
 * supaya punya state vault/sumber sendiri per baris: daftar sumber pendana
 * difilter oleh vault yang dipilih, sama seperti form tambah.
 */
function RecurringOccurrenceForm({
  template,
  vaults,
  incomeCategories,
  expenseCategories,
  sourceVaultBalances,
  locale,
  categoryLabel,
  vaultLabel,
  copy,
  onSubmit,
  onSnooze,
  onSkip,
  saving,
}: {
  template: RecurringTransaction;
  vaults: Vault[];
  incomeCategories: Category[];
  expenseCategories: Category[];
  sourceVaultBalances: Map<string, number>;
  locale: string;
  categoryLabel: (category: CategoryRef | null | undefined) => string | null;
  vaultLabel: (vault: Pick<Vault, "id" | "slug" | "name"> | null | undefined) => string | null;
  copy: OccurrenceCopy;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onSnooze: () => void;
  onSkip: () => void;
  saving: boolean;
}) {
  const [vaultId, setVaultId] = useState(template.vault_id ?? "");
  const [fundingSourceId, setFundingSourceId] = useState(template.funding_source_id ?? "");
  const [allocationMode, setAllocationMode] = useState<"auto" | "single">(template.vault_id ? "single" : "auto");
  const isExpense = template.type === "expense";
  const sources = vaultId
    ? incomeCategories
        .map((source) => ({
          source,
          balance: sourceVaultBalance(sourceVaultBalances, source.id, vaultId),
        }))
        .filter((row) => row.balance > 0 || row.source.id === fundingSourceId)
        .sort((a, b) => b.balance - a.balance)
    : [];

  return (
    <form onSubmit={onSubmit} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{copy.occurrenceHint}</p>
      <input type="hidden" name="allocationMode" value={isExpense ? "single" : allocationMode} />
      <Field label={copy.amount}>
        <Input name="amount" type="number" min="1" step="1" defaultValue={template.amount} required />
      </Field>
      <Field label={copy.date}>
        <Input name="transactionDate" type="date" defaultValue={todayJakartaISO()} max={todayJakartaISO()} required />
      </Field>
      <Field label={copy.category}>
        <select name="categoryId" defaultValue={template.category_id ?? ""} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
          <option value="">{copy.none}</option>
          {(isExpense ? expenseCategories : incomeCategories).map((category) => (
            <option key={category.id} value={category.id}>{categoryLabel(category)}</option>
          ))}
        </select>
      </Field>
      {!isExpense && (
        <Field label={copy.allocationMode} hint={allocationMode === "auto" ? copy.allocationAutoHint : copy.allocationSingleHint}>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setAllocationMode("auto")}
              className={`h-10 rounded-xl px-3 text-sm font-semibold transition-colors ${allocationMode === "auto" ? "bg-accent text-bg0" : "border border-line bg-bg1 text-muted hover:text-ink"}`}
            >
              {copy.allocationAuto}
            </button>
            <button
              type="button"
              onClick={() => setAllocationMode("single")}
              className={`h-10 rounded-xl px-3 text-sm font-semibold transition-colors ${allocationMode === "single" ? "bg-accent text-bg0" : "border border-line bg-bg1 text-muted hover:text-ink"}`}
            >
              {copy.allocationSingle}
            </button>
          </div>
        </Field>
      )}
      <Field
        label={copy.sourceVault}
        hint={
          !isExpense && allocationMode === "single" && vaults.length === 0
            ? copy.vaultNone
            : !isExpense && allocationMode === "single" && !vaultId
              ? copy.vaultRequired
              : undefined
        }
      >
        <select
          name="vaultId"
          value={!isExpense && allocationMode === "auto" ? "" : vaultId}
          onChange={(event) => {
            setVaultId(event.target.value);
            setFundingSourceId("");
          }}
          required={isExpense || (!isExpense && allocationMode === "single")}
          disabled={!isExpense && allocationMode === "auto"}
          className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink disabled:opacity-60"
        >
          <option value="" disabled={isExpense}>{isExpense || (!isExpense && allocationMode === "single") ? copy.selectVault : copy.noVault}</option>
          {vaults.map((vault) => <option key={vault.id} value={vault.id} disabled={isExpense && vault.is_locked}>{vaultLabel(vault)}</option>)}
        </select>
      </Field>
      {isExpense && (
        <Field
          label={copy.fundingSource}
          hint={!vaultId ? copy.selectVaultFirst : sources.length === 0 ? copy.noSourceInVault : undefined}
        >
          <select
            name="fundingSourceId"
            value={fundingSourceId}
            onChange={(event) => setFundingSourceId(event.target.value)}
            required
            disabled={sources.length === 0}
            className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink disabled:opacity-60"
          >
            <option value="">{copy.none}</option>
            {sources.map((row) => (
              <option key={row.source.id} value={row.source.id}>{categoryLabel(row.source)} · {formatMoney(row.balance, locale)}</option>
            ))}
          </select>
        </Field>
      )}
      <Field label={copy.note}>
        <Input name="note" maxLength={240} defaultValue={template.note ?? template.name} />
      </Field>
      <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
        <Button type="submit" disabled={saving}>{copy.recurringRecord}</Button>
        <Button type="button" variant="outline" disabled={saving} onClick={onSnooze}>{copy.recurringRemindTomorrow}</Button>
        <Button type="button" variant="ghost" disabled={saving} onClick={onSkip}><SkipForward size={15} />{copy.recurringSkip}</Button>
      </div>
    </form>
  );
}

export function SupabaseFinancePage({ section }: { section: "dashboard" | "transactions" }) {
  const locale = useLocale();
  const dashboard = useTranslations("dashboard");
  const txText = useTranslations("transactions");
  const common = useTranslations("common");
  const settings = useTranslations("settings");
  const pointsText = useTranslations("points");
  const messages = useTranslations();
  const categoryName = useTranslations("cat");
  const [transactions, setTransactions] = useState<TxRow[]>([]);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [sourceOverrides, setSourceOverrides] = useState<SourceOverride[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [recurringTemplates, setRecurringTemplates] = useState<RecurringTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [editError, setEditError] = useState("");
  const [notice, setNotice] = useState("");
  const [rewardNotice, setRewardNotice] = useState("");
  const [rewardFailed, setRewardFailed] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<TxRow | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [type, setType] = useState<"income" | "expense">("expense");
  const [allocationMode, setAllocationMode] = useState<"auto" | "single">("auto");
  const [formVaultId, setFormVaultId] = useState("");
  const [formFundingSourceId, setFormFundingSourceId] = useState("");
  const [addFormOpen, setAddFormOpen] = useState(false);
  const [expandedTxId, setExpandedTxId] = useState<number | null>(null);
  const onboardingDismissed = useSyncExternalStore(
    subscribeOnboardingDismissed,
    getOnboardingDismissedSnapshot,
    () => false
  );
  const [sourceName, setSourceName] = useState("");
  const [sourceFormError, setSourceFormError] = useState("");
  const [savingSource, setSavingSource] = useState(false);
  const [editingSourceId, setEditingSourceId] = useState("");
  const [editingSourceName, setEditingSourceName] = useState("");
  const [sourceEditError, setSourceEditError] = useState("");
  const [filterType, setFilterType] = useState<"" | "income" | "expense">("");
  const [filterMonth, setFilterMonth] = useState("");
  const [filterFromDate, setFilterFromDate] = useState("");
  const [filterToDate, setFilterToDate] = useState("");
  const [filterMinAmount, setFilterMinAmount] = useState("");
  const [filterMaxAmount, setFilterMaxAmount] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterFundingSource, setFilterFundingSource] = useState("");
  const [filterVault, setFilterVault] = useState("");
  const [filterSearch, setFilterSearch] = useState("");
  const [sortOrder, setSortOrder] = useState<"date_desc" | "amount_desc" | "amount_asc">("date_desc");
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [summaryMonth, setSummaryMonth] = useState(todayISO().slice(0, 7));
  const [recurringFormOpen, setRecurringFormOpen] = useState(false);
  const [recurringSectionOpen, setRecurringSectionOpen] = useState(false);
  const [isLargeScreen, setIsLargeScreen] = useState(false);
  const [editingRecurringId, setEditingRecurringId] = useState("");
  const [recurringType, setRecurringType] = useState<"income" | "expense">("expense");
  const [recurringFrequency, setRecurringFrequency] = useState<"weekly" | "monthly">("monthly");
  const [recurringCategoryId, setRecurringCategoryId] = useState("");
  const [recurringFundingSourceId, setRecurringFundingSourceId] = useState("");
  const [recurringVaultId, setRecurringVaultId] = useState("");
  const [recurringAllocationMode, setRecurringAllocationMode] = useState<"auto" | "single">("auto");
  const [recurringIntervalCount, setRecurringIntervalCount] = useState(1);
  const [editVaultId, setEditVaultId] = useState("");
  const [editFundingSourceId, setEditFundingSourceId] = useState("");

  useEffect(() => {
    const mediaQuery = window.matchMedia("(min-width: 1024px)");
    const updateScreenSize = () => setIsLargeScreen(mediaQuery.matches);
    updateScreenSize();
    mediaQuery.addEventListener("change", updateScreenSize);
    return () => mediaQuery.removeEventListener("change", updateScreenSize);
  }, []);

  /**
   * Nama kategori dan vault, diseragamkan dengan halaman Alokasi/Anggaran
   * lewat `resolveLabel` supaya `slug` yang hopeful bocor tidak pernah tampil.
   * Override sumber menang atas nama katalog agar transaksi lama ikut berubah
   * label setelah sumber di-rename, termasuk sumber yang sudah disembunyikan.
   */
  const sourceOverridesById = useMemo(
    () => new Map(sourceOverrides.map((row) => [row.category_id, row])),
    [sourceOverrides]
  );
  const categoryLabel = useCallback(
    (category: CategoryRef | null | undefined) => {
      const custom = category ? sourceOverridesById.get(category.id)?.custom_name?.trim() : "";
      return custom || resolveLabel(category, categoryName);
    },
    [categoryName, sourceOverridesById]
  );

  const vaultLabel = useCallback(
    (vault: Pick<Vault, "id" | "slug" | "name"> | null | undefined) =>
      resolveLabel(vault, categoryName),
    [categoryName]
  );

  function sourceLabel(summary: SourceSummary) {
    return categoryLabel(summary.source) ?? summary.source.slug;
  }

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const supabase = createClient();
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!user) throw new Error("Session Supabase tidak ditemukan.");
      const categories = await ensureDefaultCategories(supabase, user.id);
      const [txResult, vaultResult, budgetResult, recurringResult, overrideResult] = await Promise.all([
        supabase.from("transactions")
          .select("*, vault:vaults(id,slug,name,is_locked), category:categories!transactions_category_id_fkey(id,slug,name_key), funding:categories!transactions_funding_source_id_fkey(id,slug,name_key)")
          .eq("user_id", user.id)
          .order("date", { ascending: false })
          .order("created_at", { ascending: false }),
        supabase.from("vaults")
          .select("*")
          .eq("user_id", user.id)
          .order("priority", { ascending: true }),
        supabase.from("budgets")
          .select("*")
          .eq("user_id", user.id),
        supabase.from("recurring_transactions")
          .select("*")
          .eq("user_id", user.id)
          .order("due_on", { ascending: true }),
        supabase.from("category_overrides")
          .select("category_id, custom_name, hidden")
          .eq("user_id", user.id),
      ]);
      if (txResult.error) throw txResult.error;
      if (vaultResult.error) throw vaultResult.error;
      if (budgetResult.error) throw budgetResult.error;
      if (recurringResult.error) throw recurringResult.error;
      if (overrideResult.error) {
        // Migrasi 0022 dijalankan manual. Jangan kunci seluruh dashboard hanya
        // karena tabel override belum ada; sumber tetap tampil dengan nama asli.
        logSupabaseError("finance.loadSourceOverrides", overrideResult.error);
      }
      const overrides = (overrideResult.data ?? []) as SourceOverride[];
      setTransactions((txResult.data ?? []) as TxRow[]);
      setVaults((vaultResult.data ?? []) as Vault[]);
      setSourceOverrides(overrides);
      setCategories(sortByLabel(applySourceOverrides(categories, overrides), categoryName, locale));
      setBudgets((budgetResult.data ?? []) as Budget[]);
      setRecurringTemplates((recurringResult.data ?? []) as RecurringTransaction[]);
    } catch (loadError) {
      logSupabaseError("finance.load", loadError);
      setError(settings("connectionError"));
    } finally {
      setLoading(false);
    }
  }, [categoryName, locale, settings]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (active) void load();
    });
    return () => { active = false; };
  }, [load]);

  const totalIncome = transactions
    .filter((tx) => tx.type === "income")
    .reduce((sum, tx) => sum + tx.amount, 0);
  const totalExpense = transactions
    .filter((tx) => tx.type === "expense")
    .reduce((sum, tx) => sum + tx.amount, 0);
  const title = section === "dashboard" ? dashboard("subtitle") : txText("title");
  const previousSummaryMonth = shiftMonth(summaryMonth, -1);
  const monthlySummary = buildMonthlySummary(transactions, summaryMonth);
  const previousMonthlySummary = buildMonthlySummary(transactions, previousSummaryMonth);
  const budgetAlerts = budgets.flatMap((budget) => {
    if (budgetState(budget, todayISO()) !== "active") return [];
    const spent = budgetSpend(transactions, budget);
    const status = budgetStatus(spent, budget.limit_amount, Number(budget.alert_threshold));
    if (status === "ok") return [];
    const targetLabel = budget.scope === "vault"
      ? vaultLabel(vaults.find((vault) => vault.id === budget.scope_id))
      : categoryLabel(categories.find((category) => category.id === budget.scope_id));
    return [{
      id: budget.id,
      status,
      label: targetLabel ?? dashboard(budget.scope === "vault" ? "budgetVault" : "budgetCategory"),
      spent,
      limit: budget.limit_amount,
    }];
  });
  const onboardingSteps = getOnboardingSteps(transactions, vaults, budgets, todayJakartaISO());
  const completedOnboardingSteps = onboardingSteps.filter((step) => step.complete).length;
  const onboardingAllComplete = completedOnboardingSteps === onboardingSteps.length;
  const dismissOnboarding = () => dismissOnboardingStore();
  const monthLabel = (month: string) =>
    new Intl.DateTimeFormat(locale === "id" ? "id-ID" : "en-US", {
      month: "long",
      year: "numeric",
    }).format(new Date(`${month}-01T00:00:00`));

  const incomeCategories = categories.filter((category) => category.type === "income");
  const expenseCategories = categories.filter((category) => category.type === "expense");
  const sourceSummaries = summarizeSources(transactions, incomeCategories);
  // Saldo per pasangan (sumber, vault), bukan per sumber: sebuah sumber hanya
  // boleh membiayai pengeluaran dari vault tempat uangnya benar-benar tersimpan.
  const sourceVaultBalances = useMemo(
    () => computeSourceVaultBalances(transactions),
    [transactions]
  );
  // Vault dulu, baru sumber: daftar sumber pendana mengikuti vault yang dipilih.
  const vaultSources = formVaultId
    ? incomeCategories
        .map((source) => ({
          source,
          balance: sourceVaultBalance(sourceVaultBalances, source.id, formVaultId),
        }))
        .filter((row) => row.balance > 0)
        .sort((a, b) => b.balance - a.balance)
    : [];
  // "Never recorded any income" and "every source is empty" need different
  // guidance: the first means create a source, the second means add income.
  const emptySourceHint = incomeCategories.length === 0 ? txText("noSourceYet") : txText("noSource");

  /**
   * Sumber pendana untuk satu vault, dipakai form edit dan form jadwal
   * berulang. Sumber yang sedang terpilih selalu ikut ditampilkan meski
   * saldonya di vault itu nol, supaya nilai lama tidak hilang dari dropdown
   * saat baris dibuka.
   */
  const sourcesInVault = (vaultId: string, keepSourceId?: string | null) =>
    vaultId
      ? incomeCategories
          .map((source) => ({
            source,
            balance: sourceVaultBalance(sourceVaultBalances, source.id, vaultId),
          }))
          .filter((row) => row.balance > 0 || (keepSourceId && row.source.id === keepSourceId))
          .sort((a, b) => b.balance - a.balance)
      : [];

  /**
   * Bulan dan vault memang diturunkan dari data yang benar-benar ada, tetapi
   * kategori/sumber tidak boleh ikut disaring ke data historis: kategori baru
   * yang belum pernah dipakai masih perlu muncul agar tidak terasa "hilang".
   */
  const availableMonths = [...new Set(transactions.map((tx) => tx.date.slice(0, 7)))].sort((a, b) =>
    b.localeCompare(a)
  );
  const usedVaultIds = new Set(
    transactions.map((tx) => tx.vault_id).filter((id): id is string => Boolean(id))
  );
  const categoryOptions = (
    filterType === "expense"
      ? expenseCategories
      : filterType === "income"
        ? incomeCategories
        : [...incomeCategories, ...expenseCategories]
  );
  const vaultOptions = vaults.filter((vault) => usedVaultIds.has(vault.id));
  const fundingSourceOptions = incomeCategories;
  const dueRecurringTemplates = recurringTemplates.filter((template) =>
    template.is_active &&
    template.due_on <= todayJakartaISO() &&
    (!template.snoozed_until || template.snoozed_until <= todayJakartaISO())
  );

  const filtersActive = Boolean(
    filterType || filterMonth || filterFromDate || filterToDate || filterMinAmount ||
    filterMaxAmount || filterCategory || filterFundingSource || filterVault || filterSearch
  );
  const advancedFiltersCount = [
    filterMonth,
    filterFromDate,
    filterToDate,
    filterMinAmount,
    filterMaxAmount,
    filterCategory,
    filterFundingSource,
    filterVault,
  ].filter(Boolean).length;

  /**
   * Pencarian sengaja mencocokkan label kategori dan vault, bukan hanya
   * `note`, karena user mengetik "makan" atau "gaji" untuk menemukan transaksi
   * yang catatannya hanya berisi nominal.
   */
  const filteredTransactions = filterTransactions(
    transactions,
    {
      type: filterType,
      fromDate: filterFromDate,
      toDate: filterToDate,
      minAmount: filterMinAmount,
      maxAmount: filterMaxAmount,
      categoryId: filterCategory,
      fundingSourceId: filterFundingSource,
      vaultId: filterVault,
      search: filterSearch,
    },
    (tx) =>
      [
        tx.note,
        categoryLabel(tx.category),
        categoryLabel(tx.funding),
        vaultLabel(tx.vault),
        tx.date,
        tx.amount,
        formatMoney(tx.amount, locale),
      ].filter(Boolean).join(" ")
  ).filter((tx) => !filterMonth || tx.date.startsWith(filterMonth));

  const sortedTransactions = useMemo(() => {
    const list = [...filteredTransactions];
    if (sortOrder === "amount_desc") {
      return list.sort((a, b) => b.amount - a.amount);
    }
    if (sortOrder === "amount_asc") {
      return list.sort((a, b) => a.amount - b.amount);
    }
    return list;
  }, [filteredTransactions, sortOrder]);

  /**
   * `transactions` sudah terurut `date desc` dari query, sehingga tiap grup bulan
   * sudah urut tanpa sort tambahan; grup-nya yang perlu diurutkan.
   */
  const monthGroups: Array<[string, TxRow[]]> = (() => {
    const grouped = new Map<string, TxRow[]>();
    for (const tx of sortedTransactions) {
      const key = tx.date.slice(0, 7);
      const bucket = grouped.get(key);
      if (bucket) bucket.push(tx);
      else grouped.set(key, [tx]);
    }
    return [...grouped.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  })();

  /**
   * Ganti jenis juga membersihkan pilihan kategori: kategori expense tidak ada
   * di daftar income, jadi membiarkannya terpilih hanya menghasilkan daftar
   * kosong tanpa sebab yang jelas. Dilakukan di event, bukan effect, supaya
   * tidak memicu render kedua.
   */
  function changeFilterType(next: "" | "income" | "expense") {
    if (next === filterType) return;
    setFilterType(next);
    setFilterCategory("");
  }

  function resetFilters() {
    setFilterType("");
    setFilterMonth("");
    setFilterFromDate("");
    setFilterToDate("");
    setFilterMinAmount("");
    setFilterMaxAmount("");
    setFilterCategory("");
    setFilterFundingSource("");
    setFilterVault("");
    setFilterSearch("");
    setSortOrder("date_desc");
  }

  function budgetExceededText(
    code: string | undefined,
    remaining: number | undefined
  ): string | null {
    if (code === "transactions.budgetExceededCategory") {
      return txText("budgetExceededCategory", { amount: formatMoney(remaining ?? 0, locale) });
    }
    if (code === "transactions.budgetExceededVault") {
      return txText("budgetExceededVault", { amount: formatMoney(remaining ?? 0, locale) });
    }
    return null;
  }

  function recurringErrorMessage(
    code: string | undefined,
    budget?: { scope: "category" | "vault"; remaining: number }
  ) {
    const budgetText = budgetExceededText(code, budget?.remaining);
    if (budgetText) return budgetText;
    switch (code) {
      case "err.auth": return txText("recurringAuthError");
      case "err.amount": return txText("recurringAmountError");
      case "err.name": return txText("recurringNameError");
      case "err.period":
      case "err.interval": return txText("recurringScheduleError");
      case "err.source":
      case "err.category":
      case "err.vault": return txText("recurringDetailsError");
      case "err.occurrence":
      case "err.snoozed": return txText("recurringStaleError");
      case "transactions.insufficientSource": return txText("insufficientSource");
      case "transactions.sourceNotInVault": return txText("sourceNotInVault");
      case "transactions.noSource": return emptySourceHint;
      case "transactions.insufficient": return txText("insufficient");
      case "transactions.lockedError": return txText("lockedError");
      case "transactions.allocationRuleRequired": return txText("allocationRuleRequired");
      case "transactions.expenseVaultRequired": return txText("expenseVaultRequired");
      default: return settings("saveError");
    }
  }

  async function submitRecurringTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (recurringType === "expense" && !recurringVaultId) {
      setError(txText("expenseVaultRequired"));
      return;
    }
    if (recurringType === "income" && recurringAllocationMode === "single" && !recurringVaultId) {
      setError(txText("vaultRequired"));
      return;
    }
    const form = event.currentTarget;
    const data = new FormData(form);
    setSaving(true);
    setError("");
    try {
      const result = await saveRecurringTemplate(locale, {
        id: editingRecurringId || undefined,
        name: String(data.get("recurringName") ?? ""),
        note: String(data.get("recurringNote") ?? ""),
        type: recurringType,
        amount: Number(data.get("recurringAmount")),
        categoryId: recurringCategoryId || null,
        fundingSourceId: recurringType === "expense" ? recurringFundingSourceId || null : null,
        vaultId: recurringType === "income" && recurringAllocationMode === "auto" ? null : recurringVaultId || null,
        frequency: recurringFrequency,
        intervalCount: Number(data.get("intervalCount")),
        dueOn: String(data.get("dueOn") ?? ""),
        endsOn: String(data.get("endsOn") ?? "") || null,
      });
      if (!result.ok) {
        setError(recurringErrorMessage(result.error));
        return;
      }
      setEditingRecurringId("");
      setRecurringFormOpen(false);
      form.reset();
      setNotice(txText("recurringSaved"));
      await load();
    } catch (saveError) {
      console.error("Supabase recurring template save failed.", saveError);
      setError(settings("saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function submitRecurringOccurrence(
    event: FormEvent<HTMLFormElement>,
    template: RecurringTransaction
  ) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const allocationMode = String(data.get("allocationMode") ?? "auto");
    const vaultId = String(data.get("vaultId") ?? "") || null;
    if (template.type === "income" && allocationMode === "single" && !vaultId) {
      setError(txText("vaultRequired"));
      return;
    }
    setSaving(true);
    setError("");
    setRewardNotice("");
    setRewardFailed(false);
    try {
      const result = await recordRecurringTransaction(locale, {
        templateId: template.id,
        dueOn: template.due_on,
        transactionDate: String(data.get("transactionDate") ?? ""),
        amount: Number(data.get("amount")),
        categoryId: String(data.get("categoryId") ?? "") || null,
        fundingSourceId: template.type === "expense"
          ? String(data.get("fundingSourceId") ?? "") || null
          : null,
        vaultId: String(data.get("vaultId") ?? "") || null,
        note: String(data.get("note") ?? ""),
        allocationMode: allocationMode === "single" ? "single" : "auto",
      });
      if (!result.ok) {
        setError(recurringErrorMessage(result.error, result.budget));
        return;
      }
      setNotice(txText("recurringRecorded"));
      if (result.rewardError) {
        setRewardNotice(settings("rewardSaveError"));
        setRewardFailed(true);
      } else {
        const rewardMessages: string[] = [];
        if (result.points && result.points > 0) {
          rewardMessages.push(pointsText("earned", {
            amount: result.points.toLocaleString(locale === "id" ? "id-ID" : "en-US"),
          }));
        }
        for (const achievement of result.unlockedAchievements ?? []) {
          rewardMessages.push(pointsText("achievementUnlocked", {
            name: messages(achievement.nameKey),
            points: achievement.points.toLocaleString(locale === "id" ? "id-ID" : "en-US"),
          }));
        }
        setRewardNotice(rewardMessages.join(" · "));
      }
      await load();
    } catch (recordError) {
      console.error("Supabase recurring transaction review failed.", recordError);
      setError(settings("saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function runRecurringAction(
    action: () => Promise<{ ok: boolean; error?: string }>,
    successMessage: string
  ) {
    setSaving(true);
    setError("");
    try {
      const result = await action();
      if (!result.ok) {
        setError(recurringErrorMessage(result.error));
        return;
      }
      setNotice(successMessage);
      await load();
    } catch (actionError) {
      console.error("Supabase recurring transaction action failed.", actionError);
      setError(settings("saveError"));
    } finally {
      setSaving(false);
    }
  }

  function editRecurringTemplate(template: RecurringTransaction) {
    setEditingRecurringId(template.id);
    setRecurringType(template.type);
    setRecurringFrequency(template.frequency);
    setRecurringCategoryId(template.category_id ?? "");
    setRecurringFundingSourceId(template.funding_source_id ?? "");
    setRecurringVaultId(template.vault_id ?? "");
    setRecurringAllocationMode(template.vault_id ? "single" : "auto");
    setRecurringIntervalCount(template.interval_count);
    setRecurringFormOpen(true);
    setRecurringSectionOpen(true);
  }

  function transactionError(
    code: string | undefined,
    budget?: { scope: "category" | "vault"; remaining: number }
  ) {
    const budgetText = budgetExceededText(code, budget?.remaining);
    if (budgetText) return budgetText;
    if (code === "transactions.lockedError") return txText("lockedError");
    if (code === "transactions.noSource") return emptySourceHint;
    if (code === "transactions.sourceNotInVault") return txText("sourceNotInVault");
    if (code === "transactions.insufficientSource") return txText("insufficientSource");
    if (code === "transactions.vaultRequired") return txText("vaultRequired");
    if (code === "transactions.allocationRuleRequired") return txText("allocationRuleRequired");
    if (code === "transactions.expenseVaultRequired") return txText("expenseVaultRequired");
    return settings("saveError");
  }

  function sourceFormErrorMessage(code: string | undefined, name: string = sourceName) {
    if (code === "transactions.sourceExists") return txText("sourceExists");
    if (code === "transactions.sourceNameTakenSystem") {
      return txText("sourceNameTakenSystem", { name: name.trim() });
    }
    if (code === "transactions.sourceHasBalance") return txText("sourceHasBalance");
    if (code === "transactions.sourceUsedByRecurring") return txText("sourceUsedByRecurring");
    if (code === "transactions.sourceFallbackProtected") return txText("sourceFallbackProtected");
    if (code === "transactions.sourceNotFound") return txText("sourceNotFound");
    return settings("saveError");
  }

  function sourceDeleteErrorMessage(code: string | undefined) {
    if (code === "transactions.sourceHasBalance") return txText("sourceHasBalance");
    if (code === "transactions.sourceUsedByRecurring") return txText("sourceUsedByRecurring");
    if (code === "transactions.sourceFallbackProtected") return txText("sourceFallbackProtected");
    if (code === "transactions.sourceNotFound") return txText("sourceNotFound");
    return settings("deleteError");
  }

  async function submitSource(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sourceName.trim()) return;
    setSavingSource(true);
    setSourceFormError("");
    try {
      const result = await createIncomeSource(locale, { name: sourceName });
      if (!result.ok) {
        setSourceFormError(sourceFormErrorMessage(result.error));
        return;
      }
      setSourceName("");
      await load();
    } catch (saveError) {
      console.error("Supabase income source insert failed.", saveError);
      setSourceFormError(settings("saveError"));
    } finally {
      setSavingSource(false);
    }
  }

  async function saveSourceEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = editingSourceName.trim();
    if (!editingSourceId || !name) return;
    setSavingSource(true);
    setSourceEditError("");
    try {
      const result = await updateIncomeSource(locale, editingSourceId, name);
      if (!result.ok) {
        setSourceEditError(sourceFormErrorMessage(result.error, name));
        return;
      }
      setEditingSourceId("");
      setEditingSourceName("");
      await load();
      setNotice(txText("sourceUpdated"));
    } catch (saveError) {
      console.error("Supabase income source rename failed.", saveError);
      setSourceEditError(settings("saveError"));
    } finally {
      setSavingSource(false);
    }
  }

  async function removeSource(source: SourceSummary) {
    if (!window.confirm(txText("deleteSourceConfirm"))) return;
    setError("");
    try {
      const result = await deleteIncomeSource(locale, source.source.id);
      if (!result.ok) {
        setError(sourceDeleteErrorMessage(result.error));
        return;
      }
      if (editingSourceId === source.source.id) setEditingSourceId("");
      if (filterCategory === source.source.id) setFilterCategory("");
      if (filterFundingSource === source.source.id) setFilterFundingSource("");
      if (formFundingSourceId === source.source.id) setFormFundingSourceId("");
      if (editFundingSourceId === source.source.id) setEditFundingSourceId("");
      await load();
    } catch (deleteError) {
      console.error("Supabase income source delete failed.", deleteError);
      setError(settings("deleteError"));
    }
  }

  async function submitTransaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const amount = Number(data.get("amount"));
    const date = String(data.get("date") ?? "");
    const vaultId = String(data.get("vaultId") ?? "") || null;
    const categoryId = String(data.get("categoryId") ?? "") || null;
    const fundingSourceId = String(data.get("fundingSourceId") ?? "") || null;
    // Blocked before the request goes out; the server repeats the check.
    if (type === "expense" && !vaultId) {
      setFormError(txText("expenseVaultRequired"));
      return;
    }
    if (type === "expense" && !fundingSourceId) {
      setFormError(vaultSources.length === 0 ? txText("noSourceInVault") : emptySourceHint);
      return;
    }
    if (type === "income" && allocationMode === "single" && !vaultId) {
      setFormError(txText("vaultRequired"));
      return;
    }
    setSaving(true);
    setFormError("");
    setRewardNotice("");
    setRewardFailed(false);
    try {
      const result = await addTransaction(locale, {
        type,
        amount,
        date,
        categoryId,
        fundingSourceId: type === "expense" ? fundingSourceId : null,
        vaultId,
        allocationMode: type === "income" ? allocationMode : null,
        note: String(data.get("note") ?? "").trim() || null,
      });
      if (!result.ok) {
        setFormError(transactionError(result.error, result.budget));
        return;
      }
      if (result.rewardError) {
        setRewardNotice(settings("rewardSaveError"));
        setRewardFailed(true);
      } else {
        const rewardMessages: string[] = [];
        if (result.points && result.points > 0) {
          rewardMessages.push(
            pointsText("earned", {
              amount: result.points.toLocaleString(locale === "id" ? "id-ID" : "en-US"),
            })
          );
        }
        for (const achievement of result.unlockedAchievements ?? []) {
          rewardMessages.push(
            pointsText("achievementUnlocked", {
              name: messages(achievement.nameKey),
              points: achievement.points.toLocaleString(locale === "id" ? "id-ID" : "en-US"),
            })
          );
        }
        setRewardNotice(rewardMessages.join(" · "));
      }
      form.reset();
      setFormVaultId("");
      setFormFundingSourceId("");
      await load();
      if (section === "dashboard") setAddFormOpen(false);
    } catch (saveError) {
      console.error("Supabase transaction insert failed.", saveError);
      setFormError(settings("saveError"));
    } finally {
      setSaving(false);
    }
  }

  async function removeTransaction(id: number) {
    if (!window.confirm(txText("deleteConfirm"))) return;
    setError("");
    try {
      const result = await deleteTransaction(locale, id);
      if (!result.ok) {
        setError(settings("deleteError"));
        return;
      }
      await load();
    } catch (deleteError) {
      console.error("Supabase transaction delete failed.", deleteError);
      setError(settings("deleteError"));
    }
  }

  async function saveTransactionEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingTransaction) return;
    setSavingEdit(true);
    setEditError("");
    setError("");
    const formData = new FormData(event.currentTarget);
    const rawAmount = Number(formData.get("amount"));
    const amount = Math.trunc(rawAmount);
    if (!Number.isSafeInteger(rawAmount) || amount <= 0 || amount > 2_147_483_647) {
      setEditError(txText("invalidEditAmount"));
      setSavingEdit(false);
      return;
    }
    try {
      const result = await editTransaction(locale, {
        id: editingTransaction.id,
        amount,
        date: String(formData.get("date") ?? ""),
        categoryId: String(formData.get("categoryId") ?? "") || null,
        fundingSourceId: editingTransaction.type === "expense"
          ? String(formData.get("fundingSourceId") ?? "") || null
          : null,
        vaultId: String(formData.get("vaultId") ?? "") || null,
        note: String(formData.get("note") ?? "") || null,
      });
      if (!result.ok) {
        const budgetText = budgetExceededText(result.error, result.budget?.remaining);
        if (budgetText) setEditError(budgetText);
        else if (result.error === "transactions.insufficientSource") setEditError(txText("insufficientSource"));
        else if (result.error === "transactions.sourceNotInVault") setEditError(txText("sourceNotInVault"));
        else if (result.error === "transactions.noSource") setEditError(emptySourceHint);
        else if (result.error === "transactions.insufficient") setEditError(txText("insufficient"));
        else if (result.error === "transactions.lockedError") setEditError(txText("lockedError"));
        else if (result.error === "transactions.expenseVaultRequired") setEditError(txText("expenseVaultRequired"));
        else setEditError(settings("saveError"));
        return;
      }
      setEditingTransaction(null);
      setNotice(txText("editSaved"));
      await load();
    } catch (editError) {
      console.error("Supabase transaction edit failed.", editError);
      setEditError(settings("saveError"));
    } finally {
      setSavingEdit(false);
    }
  }

  function transactionEditForm(transaction: TxRow) {
    return (
      <form onSubmit={saveTransactionEdit} className="mb-2 grid gap-4 rounded-2xl border border-line bg-bg1/60 p-4 sm:grid-cols-2">
        <h3 className="font-display text-sm font-semibold text-ink sm:col-span-2">{txText("editTitle")}</h3>
        <Field label={txText("amount")}>
          <Input name="amount" type="number" min="1" max="2147483647" step="1" defaultValue={transaction.amount} required />
        </Field>
        <Field label={txText("date")}>
          <Input name="date" type="date" defaultValue={transaction.date} required />
        </Field>
        <Field label={txText("category")}>
          <select name="categoryId" defaultValue={transaction.category_id ?? ""} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
            <option value="">{common("none")}</option>
            {(transaction.type === "income" ? incomeCategories : expenseCategories).map((category) => (
              <option key={category.id} value={category.id}>{categoryLabel(category) ?? humanizeSlug(category.slug)}</option>
            ))}
          </select>
        </Field>
        {transaction.type === "expense" && (
          <Field
            label={txText("fundingSource")}
            hint={!editVaultId ? txText("selectVaultFirst") : sourcesInVault(editVaultId, editFundingSourceId).length === 0 ? txText("noSourceInVault") : undefined}
          >
            <select
              name="fundingSourceId"
              value={editFundingSourceId}
              onChange={(event) => setEditFundingSourceId(event.target.value)}
              required
              disabled={sourcesInVault(editVaultId, editFundingSourceId).length === 0}
              className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink disabled:opacity-60"
            >
              <option value="">{common("none")}</option>
              {sourcesInVault(editVaultId, editFundingSourceId).map((row) => (
                <option key={row.source.id} value={row.source.id}>{categoryLabel(row.source) ?? humanizeSlug(row.source.slug)} · {formatMoney(row.balance, locale)}</option>
              ))}
            </select>
          </Field>
        )}
        <Field
          label={txText("sourceVault")}
          hint={
            transaction.type === "expense"
              ? vaults.length === 0
                ? txText("recurringVaultNone")
                : editVaultId
                  ? undefined
                  : txText("expenseVaultRequired")
              : undefined
          }
        >
          <select
            name="vaultId"
            value={editVaultId}
            onChange={(event) => {
              setEditVaultId(event.target.value);
              setEditFundingSourceId("");
            }}
            required={transaction.type === "expense"}
            className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
          >
            <option value="" disabled={transaction.type === "expense"}>{transaction.type === "expense" ? txText("selectVault") : settings("noVault")}</option>
            {vaults.filter((vault) => transaction.type === "income" || !vault.is_locked || vault.id === transaction.vault_id).map((vault) => (
              <option key={vault.id} value={vault.id}>{vaultLabel(vault)}</option>
            ))}
          </select>
        </Field>
        <Field label={txText("note")} className="sm:col-span-2">
          <Input name="note" maxLength={200} defaultValue={transaction.note ?? ""} />
        </Field>
        {editError && <p role="alert" className="text-sm text-danger sm:col-span-2">{editError}</p>}
        <div className="flex gap-2 sm:col-span-2">
          <Button type="submit" disabled={savingEdit}>{common("save")}</Button>
          <Button type="button" variant="outline" disabled={savingEdit} onClick={() => { setEditingTransaction(null); setEditError(""); }}>{common("cancel")}</Button>
        </div>
      </form>
    );
  }

  return (
    <div className="rise-in space-y-6">
      <div>
        <p className="text-sm text-muted">Nexora · Budgeting</p>
        <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        <p className="mt-2 text-sm text-muted">{settings("cloudStorage")}</p>
      </div>
      {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-accent/30 bg-accent/10 p-3 text-sm text-accent">{notice}</p>}
      {rewardNotice && <p role={rewardFailed ? "alert" : "status"} className={`rounded-xl border p-3 text-sm ${rewardFailed ? "border-danger/30 bg-danger/10 text-danger" : "border-accent/30 bg-accent/10 text-accent"}`}>{rewardNotice}</p>}
      {section === "dashboard" && (
        <div className="grid gap-4 sm:grid-cols-3">
          <SummaryCard label={dashboard("totalBalance")} value={formatMoney(totalIncome - totalExpense, locale)} />
          <SummaryCard label={dashboard("income")} value={formatMoney(totalIncome, locale)} icon={<ArrowDownLeft size={17} />} />
          <SummaryCard label={dashboard("expense")} value={formatMoney(totalExpense, locale)} icon={<ArrowUpRight size={17} />} />
        </div>
      )}
      {section === "dashboard" && !loading && !error && !(onboardingDismissed && onboardingAllComplete) && (
        <Card>
          <CardContent className="p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-ink">{dashboard("onboardingTitle")}</h2>
                <p className="mt-1 text-sm text-muted">
                  {onboardingAllComplete
                    ? dashboard("onboardingComplete")
                    : dashboard("onboardingProgress", {
                        complete: completedOnboardingSteps,
                        total: onboardingSteps.length,
                      })}
                </p>
              </div>
              <div className="flex w-full items-center gap-3 sm:w-auto">
                <div
                  role="progressbar"
                  aria-label={dashboard("onboardingTitle")}
                  aria-valuemin={0}
                  aria-valuemax={onboardingSteps.length}
                  aria-valuenow={completedOnboardingSteps}
                  className="h-2 w-full overflow-hidden rounded-full bg-bg1 sm:w-36"
                >
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-500"
                    style={{ width: `${(completedOnboardingSteps / onboardingSteps.length) * 100}%` }}
                  />
                </div>
                {onboardingAllComplete && (
                  <button
                    type="button"
                    onClick={dismissOnboarding}
                    aria-label={dashboard("onboardingDismiss")}
                    title={dashboard("onboardingDismiss")}
                    className="shrink-0 rounded-lg p-2 text-faint hover:bg-surface2 hover:text-ink"
                  >
                    <X size={16} />
                  </button>
                )}
              </div>
            </div>
            <ol className="mt-4 grid gap-2 sm:grid-cols-3">
              {onboardingSteps.map((step) => (
                <li key={step.id}>
                  <Link
                    href={step.href}
                    className={`flex h-full items-center gap-3 rounded-xl border p-3 transition-colors ${
                      step.complete
                        ? "border-accent/20 bg-accent/5 text-muted"
                        : "border-line bg-bg1/60 text-ink hover:border-accent/40 hover:bg-surface2"
                    }`}
                  >
                    <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${
                      step.complete ? "bg-accent/15 text-accent" : "border border-line text-faint"
                    }`}>
                      {step.complete ? <Check size={16} aria-hidden="true" /> : <span className="text-xs">{onboardingSteps.indexOf(step) + 1}</span>}
                    </span>
                    <span className={`min-w-0 flex-1 text-sm ${step.complete ? "line-through decoration-accent/60" : "font-medium"}`}>
                      {dashboard(`onboarding${step.id[0].toUpperCase()}${step.id.slice(1)}`)}
                    </span>
                    {!step.complete && <ArrowRight size={15} aria-hidden="true" className="shrink-0 text-muted" />}
                  </Link>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
      {section === "dashboard" && budgetAlerts.length > 0 && (
        <section
          role={budgetAlerts.some((alert) => alert.status === "exceeded") ? "alert" : "status"}
          aria-live={budgetAlerts.some((alert) => alert.status === "exceeded") ? "assertive" : "polite"}
          className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-danger"
        >
          <h2 className="font-semibold">{dashboard("budgetAlertsTitle")}</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {budgetAlerts.map((alert) => (
              <li key={alert.id}>
                <span className="font-medium">{alert.label}</span>
                {" · "}
                {dashboard(
                  alert.status === "exceeded"
                    ? "overBudget"
                    : alert.status === "full"
                      ? "fullBudget"
                      : "nearBudget"
                )}
                {" — "}
                {dashboard("budgetUsed", {
                  used: formatMoney(alert.spent, locale),
                  limit: formatMoney(alert.limit, locale),
                })}
              </li>
            ))}
          </ul>
        </section>
      )}
      {section === "dashboard" && (
        <Card>
          <CardContent className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-ink">
                  {dashboard("monthlySummary")}
                </h2>
                <p className="mt-0.5 text-sm capitalize text-muted">{monthLabel(summaryMonth)}</p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setSummaryMonth((month) => shiftMonth(month, -1))}
                  aria-label={dashboard("previousMonth")}
                  className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted transition-colors hover:bg-surface2 hover:text-ink"
                >
                  <ChevronLeft size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => setSummaryMonth((month) => shiftMonth(month, 1))}
                  disabled={summaryMonth >= todayISO().slice(0, 7)}
                  aria-label={dashboard("nextMonth")}
                  className="grid h-9 w-9 place-items-center rounded-lg border border-line text-muted transition-colors hover:bg-surface2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <ChevronRight size={18} />
                </button>
              </div>
            </div>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {([
                ["income", dashboard("income"), monthlySummary.income, previousMonthlySummary.income],
                ["expense", dashboard("expense"), monthlySummary.expense, previousMonthlySummary.expense],
                ["balanceChange", dashboard("balanceChange"), monthlySummary.balanceChange, previousMonthlySummary.balanceChange],
              ] as const).map(([key, label, amount, previousAmount]) => {
                const difference = amount - previousAmount;
                return (
                  <div key={key} className="rounded-xl border border-line bg-bg1/60 p-3">
                    <p className="text-xs text-muted">{label}</p>
                    <p className="num mt-1 text-lg font-semibold text-ink">
                      {formatMoney(amount, locale)}
                    </p>
                    <p className="mt-1 text-xs text-faint">
                      {dashboard("vsPreviousMonth", {
                        direction:
                          difference > 0
                            ? dashboard("increased")
                            : difference < 0
                              ? dashboard("decreased")
                              : dashboard("unchanged"),
                        amount: formatMoney(Math.abs(difference), locale),
                      })}
                    </p>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-faint">{dashboard("balanceChangeHelp")}</p>

            <div className="mt-5 border-t border-line pt-4">
              <h3 className="text-sm font-semibold text-ink">{dashboard("topExpenses")}</h3>
              {monthlySummary.expensesByCategory.length === 0 ? (
                <p className="mt-2 text-sm text-muted">{dashboard("noMonthlyExpenses")}</p>
              ) : (
                <ol className="mt-2 space-y-2">
                  {monthlySummary.expensesByCategory.slice(0, 3).map((item, index) => (
                    <li key={item.id ?? "uncategorized"} className="flex items-center gap-3 text-sm">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface2 text-xs font-medium text-muted">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted">
                        {item.category
                          ? categoryLabel(item.category) ?? item.category.slug
                          : dashboard("uncategorized")}
                      </span>
                      <span className="num font-medium text-ink">{formatMoney(item.amount, locale)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      {section === "dashboard" && <CashflowChart transactions={transactions} />}
      {section === "transactions" && (
        <Card>
          <CardContent className={`p-5 ${recurringSectionOpen ? "pb-0" : "pb-5"} lg:pb-0`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <button
                type="button"
                aria-expanded={isLargeScreen || recurringSectionOpen}
                onClick={() => {
                  if (!isLargeScreen) setRecurringSectionOpen((open) => !open);
                }}
                className="flex min-w-0 flex-1 items-start gap-3 text-left lg:cursor-default"
              >
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface2 text-accent">
                  <CalendarClock size={18} />
                </span>
                <span className="min-w-0 flex-1">
                  <h2 className="font-display text-lg font-semibold text-ink">{txText("recurringTitle")}</h2>
                  <span className={`mt-1 max-w-2xl text-sm text-muted ${recurringSectionOpen ? "block" : "hidden"} lg:block`}>{txText("recurringDescription")}</span>
                </span>
                <ChevronDown
                  size={18}
                  aria-hidden="true"
                  className={`mt-1 shrink-0 text-muted transition-transform lg:hidden ${recurringSectionOpen ? "rotate-180" : ""}`}
                />
              </button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  if (recurringFormOpen) {
                    setEditingRecurringId("");
                    setRecurringFormOpen(false);
                  } else {
                    setEditingRecurringId("");
                    setRecurringType("expense");
                    setRecurringFrequency("monthly");
                    setRecurringCategoryId("");
                    setRecurringFundingSourceId("");
                    setRecurringVaultId("");
                    setRecurringAllocationMode("auto");
                    setRecurringIntervalCount(1);
                    setRecurringFormOpen(true);
                    setRecurringSectionOpen(true);
                  }
                }}
              >
                <Plus size={16} />{txText("recurringCreate")}
              </Button>
            </div>
          </CardContent>

          <div className={`${recurringSectionOpen ? "block" : "hidden"} lg:block`}>
          <CardContent className="p-5 pt-0">
            {recurringFormOpen && (
              <form key={editingRecurringId || "new-recurring"} onSubmit={submitRecurringTemplate} className="mt-5 grid gap-3 rounded-2xl border border-line bg-surface2/40 p-4 sm:grid-cols-2 lg:grid-cols-3">
                <Field label={txText("recurringName")}>
                  <Input name="recurringName" maxLength={80} defaultValue={recurringTemplates.find((item) => item.id === editingRecurringId)?.name ?? ""} required />
                </Field>
                <Field label={txText("type")}>
                  <select
                    value={recurringType}
                    onChange={(event) => {
                      setRecurringType(event.target.value as "income" | "expense");
                      setRecurringCategoryId("");
                      setRecurringFundingSourceId("");
                    }}
                    className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
                  >
                    <option value="expense">{txText("expense")}</option>
                    <option value="income">{txText("income")}</option>
                  </select>
                </Field>
                <Field label={txText("amount")}>
                  <Input name="recurringAmount" type="number" min="1" step="1" defaultValue={recurringTemplates.find((item) => item.id === editingRecurringId)?.amount ?? ""} required />
                </Field>
                <Field label={txText("recurringFrequency")}>
                  <select
                    value={recurringFrequency}
                    onChange={(event) => setRecurringFrequency(event.target.value as "weekly" | "monthly")}
                    className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
                  >
                    <option value="weekly">{txText("recurringWeekly")}</option>
                    <option value="monthly">{txText("recurringMonthly")}</option>
                  </select>
                </Field>
                <Field
                  label={txText("recurringInterval")}
                  hint={recurringFrequency === "weekly" ? txText("recurringIntervalHintWeekly") : txText("recurringIntervalHintMonthly")}
                >
                  <Input
                    name="intervalCount"
                    type="number"
                    min="1"
                    max="12"
                    step="1"
                    value={recurringIntervalCount}
                    onChange={(event) => setRecurringIntervalCount(Number(event.target.value) || 1)}
                    required
                  />
                </Field>
                <p className="self-end pb-2 text-xs text-muted">
                  {txText(recurringFrequency === "weekly" ? "recurringEveryWeeks" : "recurringEveryMonths", { count: recurringIntervalCount })}
                </p>
                {recurringFrequency === "monthly" && (
                  <p className="text-xs text-faint sm:col-span-2 lg:col-span-3">{txText("recurringMonthEndRule")}</p>
                )}
                <Field label={txText("recurringNextDate")}>
                  <Input name="dueOn" type="date" defaultValue={recurringTemplates.find((item) => item.id === editingRecurringId)?.due_on ?? todayJakartaISO()} required />
                </Field>
                <Field label={txText("recurringEndDate")}>
                  <Input name="endsOn" type="date" defaultValue={recurringTemplates.find((item) => item.id === editingRecurringId)?.ends_on ?? ""} />
                </Field>
                <Field label={txText("category")}>
                  <select
                    value={recurringCategoryId}
                    onChange={(event) => setRecurringCategoryId(event.target.value)}
                    className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
                  >
                    <option value="">{common("none")}</option>
                    {(recurringType === "income" ? incomeCategories : expenseCategories).map((category) => (
                      <option key={category.id} value={category.id}>{categoryLabel(category)}</option>
                    ))}
                  </select>
                </Field>
                {recurringType === "income" && (
                  <Field label={txText("allocationMode")} hint={recurringAllocationMode === "auto" ? txText("allocationAutoHint") : txText("allocationSingleHint")}>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          setRecurringAllocationMode("auto");
                          setRecurringVaultId("");
                        }}
                        className={`h-10 rounded-xl px-3 text-sm font-semibold transition-colors ${recurringAllocationMode === "auto" ? "bg-accent text-bg0" : "border border-line bg-bg1 text-muted hover:text-ink"}`}
                      >
                        {txText("allocationAuto")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setRecurringAllocationMode("single")}
                        className={`h-10 rounded-xl px-3 text-sm font-semibold transition-colors ${recurringAllocationMode === "single" ? "bg-accent text-bg0" : "border border-line bg-bg1 text-muted hover:text-ink"}`}
                      >
                        {txText("allocationSingle")}
                      </button>
                    </div>
                  </Field>
                )}
                <Field
                  label={txText("sourceVault")}
                  hint={
                    recurringType === "income" && recurringAllocationMode === "single" && vaults.length === 0
                      ? txText("recurringVaultNone")
                      : recurringType === "income" && recurringAllocationMode === "single" && !recurringVaultId
                        ? txText("vaultRequired")
                        : undefined
                  }
                >
                  <select
                    value={recurringType === "income" && recurringAllocationMode === "auto" ? "" : recurringVaultId}
                    onChange={(event) => {
                      setRecurringVaultId(event.target.value);
                      setRecurringFundingSourceId("");
                    }}
                    required={recurringType === "expense" || (recurringType === "income" && recurringAllocationMode === "single")}
                    disabled={recurringType === "income" && recurringAllocationMode === "auto"}
                    className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink disabled:opacity-60"
                  >
                    <option value="" disabled={recurringType === "expense"}>{recurringType === "expense" || (recurringType === "income" && recurringAllocationMode === "single") ? txText("selectVault") : settings("noVault")}</option>
                    {vaults.map((vault) => <option key={vault.id} value={vault.id} disabled={recurringType === "expense" && vault.is_locked}>{vaultLabel(vault)}</option>)}
                  </select>
                </Field>
                {recurringType === "expense" && (
                  <Field
                    label={txText("fundingSource")}
                    hint={!recurringVaultId ? txText("selectVaultFirst") : sourcesInVault(recurringVaultId, recurringFundingSourceId).length === 0 ? txText("noSourceInVault") : undefined}
                  >
                    <select
                      value={recurringFundingSourceId}
                      onChange={(event) => setRecurringFundingSourceId(event.target.value)}
                      required
                      disabled={sourcesInVault(recurringVaultId, recurringFundingSourceId).length === 0}
                      className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink disabled:opacity-60"
                    >
                      <option value="">{common("none")}</option>
                      {sourcesInVault(recurringVaultId, recurringFundingSourceId).map((row) => (
                        <option key={row.source.id} value={row.source.id}>{categoryLabel(row.source)} · {formatMoney(row.balance, locale)}</option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label={txText("note")} className="sm:col-span-2 lg:col-span-3">
                  <Input name="recurringNote" maxLength={240} defaultValue={recurringTemplates.find((item) => item.id === editingRecurringId)?.note ?? ""} />
                </Field>
                <div className="flex gap-2 sm:col-span-2 lg:col-span-3">
                  <Button type="submit" disabled={saving}>{common("save")}</Button>
                  <Button type="button" variant="ghost" onClick={() => { setEditingRecurringId(""); setRecurringFormOpen(false); }}>{common("cancel")}</Button>
                </div>
              </form>
            )}

            {dueRecurringTemplates.length > 0 && (
              <section className="mt-5" aria-labelledby="recurring-due-title">
                <h3 id="recurring-due-title" className="font-semibold text-ink">{txText("recurringDueTitle", { count: dueRecurringTemplates.length })}</h3>
                <p className="mt-1 text-sm text-muted">{txText("recurringReviewHint")}</p>
                <ul className="mt-3 space-y-3">
                  {dueRecurringTemplates.map((template) => (
                    <li key={template.id} className="rounded-2xl border border-accent/30 bg-accent/5 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <p className="font-medium text-ink">{template.name}</p>
                          <p className="mt-1 text-xs text-muted">
                            {txText(template.type)} · {txText("recurringDueDate", { date: template.due_on })}
                          </p>
                        </div>
                        <p className="num font-semibold text-ink">{formatMoney(template.amount, locale)}</p>
                      </div>
                      <RecurringOccurrenceForm
                        template={template}
                        vaults={vaults}
                        incomeCategories={incomeCategories}
                        expenseCategories={expenseCategories}
                        sourceVaultBalances={sourceVaultBalances}
                        locale={locale}
                        categoryLabel={categoryLabel}
                        vaultLabel={vaultLabel}
                        copy={{
                          amount: txText("amount"),
                          date: txText("date"),
                          category: txText("category"),
                          sourceVault: txText("sourceVault"),
                          fundingSource: txText("fundingSource"),
                          selectVault: txText("selectVault"),
                          selectVaultFirst: txText("selectVaultFirst"),
                          noSourceInVault: txText("noSourceInVault"),
                          note: txText("note"),
                          none: common("none"),
                          noVault: settings("noVault"),
                          recurringRecord: txText("recurringRecord"),
                          recurringRemindTomorrow: txText("recurringRemindTomorrow"),
                          recurringSkip: txText("recurringSkip"),
                          occurrenceHint: txText("recurringOccurrenceEditHint"),
                          allocationMode: txText("allocationMode"),
                          allocationAuto: txText("allocationAuto"),
                          allocationSingle: txText("allocationSingle"),
                          allocationAutoHint: txText("allocationAutoHint"),
                          allocationSingleHint: txText("allocationSingleHint"),
                          vaultRequired: txText("vaultRequired"),
                          vaultNone: txText("recurringVaultNone"),
                        }}
                        onSubmit={(event) => void submitRecurringOccurrence(event, template)}
                        onSnooze={() => void runRecurringAction(
                          () => snoozeRecurringOccurrence(locale, template.id, template.due_on),
                          txText("recurringSnoozed")
                        )}
                        onSkip={() => void runRecurringAction(
                          () => skipRecurringOccurrence(locale, template.id, template.due_on),
                          txText("recurringSkipped")
                        )}
                        saving={saving}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div className="mt-5 border-t border-line pt-4">
              <h3 className="font-semibold text-ink">{txText("recurringSchedules")}</h3>
              {recurringTemplates.length === 0 ? (
                <p className="mt-2 text-sm text-muted">{txText("recurringEmpty")}</p>
              ) : (
                <ul className="mt-2 divide-y divide-line">
                  {recurringTemplates.map((template) => (
                    <li key={template.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                      <div className="min-w-0">
                        <p className={`font-medium ${template.is_active ? "text-ink" : "text-muted"}`}>{template.name}</p>
                        <p className="mt-1 text-xs text-muted">
                          {template.is_active
                            ? txText("recurringNextDateLabel", { date: template.due_on })
                            : template.ends_on && template.due_on > template.ends_on
                              ? txText("recurringEnded")
                              : txText("recurringPaused")}
                          {" · "}{txText(template.frequency === "weekly" ? "recurringWeekly" : "recurringMonthly")}
                          {template.interval_count > 1 ? ` · ${template.interval_count}×` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button type="button" disabled={saving} onClick={() => editRecurringTemplate(template)} aria-label={txText("recurringEdit")} className="rounded-lg p-2 text-muted hover:bg-surface2 hover:text-ink"><Pencil size={16} /></button>
                        {!(template.ends_on && template.due_on > template.ends_on) && (
                          <button type="button" disabled={saving} onClick={() => void runRecurringAction(
                            () => setRecurringTemplateActive(locale, template.id, !template.is_active),
                            txText(template.is_active ? "recurringPausedNotice" : "recurringResumed")
                          )} aria-label={txText(template.is_active ? "recurringPause" : "recurringResume")} className="rounded-lg p-2 text-muted hover:bg-surface2 hover:text-ink">{template.is_active ? <Pause size={16} /> : <Play size={16} />}</button>
                        )}
                        <button type="button" disabled={saving} onClick={() => {
                          if (window.confirm(txText("recurringDeleteConfirm"))) {
                            void runRecurringAction(() => deleteRecurringTemplate(locale, template.id), txText("recurringDeleted"));
                          }
                        }} aria-label={common("delete")} className="rounded-lg p-2 text-muted hover:bg-surface2 hover:text-danger"><Trash2 size={16} /></button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
          </div>
        </Card>
      )}
      {section === "dashboard" && (
        <Card>
          <CardContent className="p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="font-display text-lg font-semibold text-ink">{dashboard("sourcesTitle")}</h2>
              {sourceSummaries.length > 0 && (
                <p className="text-xs text-faint">
                  {txText("sourceCount", { count: sourceSummaries.length })}
                </p>
              )}
            </div>
            <form
              onSubmit={submitSource}
              className="mt-4 flex flex-col gap-2 rounded-2xl border border-line bg-surface2/40 p-3 sm:flex-row sm:items-end sm:gap-3"
            >
              <div className="min-w-0 flex-1">
                <Field label={txText("sourceName")} error={sourceFormError || null}>
                  <Input
                    name="sourceName"
                    value={sourceName}
                    maxLength={80}
                    onChange={(event) => {
                      setSourceName(event.target.value);
                      if (sourceFormError) setSourceFormError("");
                    }}
                    placeholder={txText("sourceHint")}
                  />
                </Field>
              </div>
              <Button
                type="submit"
                disabled={savingSource || !sourceName.trim()}
                className="w-full shrink-0 sm:w-auto"
              >
                <Plus size={16} />
                {savingSource ? common("loading") : txText("addSource")}
              </Button>
            </form>
            {loading ? (
              <p className="py-8 text-center text-sm text-muted">{common("loading")}</p>
            ) : sourceSummaries.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted">{dashboard("sourcesEmpty")}</p>
            ) : (
              <ul className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {sourceSummaries.map((summary) => (
                  <li key={summary.source.id} className="rounded-2xl border border-line bg-bg1 p-4">
                    {editingSourceId === summary.source.id ? (
                      <form onSubmit={saveSourceEdit} className="grid gap-2">
                        <div className="flex items-center gap-1">
                          <div className="min-w-0 flex-1">
                            <Input
                              value={editingSourceName}
                              maxLength={80}
                              autoFocus
                              aria-label={txText("sourceName")}
                              onChange={(event) => {
                                setEditingSourceName(event.target.value);
                                if (sourceEditError) setSourceEditError("");
                              }}
                            />
                          </div>
                          <button
                            type="submit"
                            disabled={savingSource || !editingSourceName.trim()}
                            aria-label={common("save")}
                            className="shrink-0 rounded-lg p-2 text-faint hover:bg-surface2 hover:text-ink disabled:opacity-50"
                          >
                            <Check size={15} />
                          </button>
                          <button
                            type="button"
                            disabled={savingSource}
                            onClick={() => {
                              setEditingSourceId("");
                              setEditingSourceName("");
                              setSourceEditError("");
                            }}
                            aria-label={common("cancel")}
                            className="shrink-0 rounded-lg p-2 text-faint hover:bg-surface2 hover:text-ink disabled:opacity-50"
                          >
                            <X size={15} />
                          </button>
                        </div>
                        {sourceEditError && <p className="text-xs text-danger">{sourceEditError}</p>}
                      </form>
                    ) : (
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-ink">{sourceLabel(summary)}</p>
                          <p className="text-xs text-faint">
                            {txText("sourceIncome")} {formatMoney(summary.income, locale)} · {txText("sourceExpense")} {formatMoney(summary.expense, locale)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setEditingSourceId(summary.source.id);
                              setEditingSourceName(sourceLabel(summary));
                              setSourceEditError("");
                            }}
                            aria-label={txText("editSource")}
                            className="rounded-lg p-1.5 text-faint hover:bg-surface2 hover:text-ink"
                          >
                            <Pencil size={15} />
                          </button>
                          {summary.source.slug !== "lainnya-in" && summary.source.slug !== "lainnya" && (
                            <button
                              type="button"
                              onClick={() => void removeSource(summary)}
                              aria-label={txText("deleteSource")}
                              className="rounded-lg p-1.5 text-faint hover:bg-surface2 hover:text-danger"
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    <p
                      className={`num mt-3 text-lg font-semibold tracking-tight ${
                        summary.balance > 0 ? "text-ink" : summary.balance < 0 ? "text-danger" : "text-faint"
                      }`}
                    >
                      {formatMoney(summary.balance, locale)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}
      <div className={`grid grid-cols-1 items-stretch gap-5 lg:h-[calc(100vh-200px)] lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] overflow-x-hidden`}>
        <Card className="w-full max-w-full h-full"><CardContent className="w-full max-w-full p-4 sm:p-5 h-full flex flex-col min-h-0">
          <div className="flex items-center justify-between gap-2 shrink-0">
            <h2 className="font-display text-lg font-semibold text-ink">{txText("addTitle")}</h2>
            {section === "dashboard" && addFormOpen && (
              <button
                type="button"
                onClick={() => setAddFormOpen(false)}
                className="text-xs font-medium text-muted transition-colors hover:text-ink"
              >
                {common("close")}
              </button>
            )}
          </div>
            {section === "dashboard" && !addFormOpen ? (
              <button
                type="button"
                onClick={() => setAddFormOpen(true)}
                className="mt-4 flex flex-1 items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-bg1/60 px-4 py-6 text-sm font-medium text-muted transition-colors hover:border-accent/40 hover:text-ink"
              >
              <Plus size={16} />
              {txText("addTitle")}
            </button>
          ) : (
            <form onSubmit={submitTransaction} className="mt-5 flex flex-col gap-4 w-full max-w-full flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
            <Field label={txText("type")}>
              <select name="type" value={type} onChange={(event) => {
                setType(event.target.value as "income" | "expense");
                setFormFundingSourceId("");
              }} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
                <option value="income">{txText("income")}</option>
                <option value="expense">{txText("expense")}</option>
              </select>
            </Field>
            <Field label={txText("amount")}><Input name="amount" type="number" min="1" step="1" required /></Field>
            <Field label={txText("date")}><Input name="date" type="date" defaultValue={todayISO()} required /></Field>
            {type === "income" && (
              <Field label={txText("allocationMode")} hint={txText(allocationMode === "auto" ? "allocationAutoHint" : "allocationSingleHint")}>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setAllocationMode("auto");
                      setFormVaultId("");
                    }}
                    className={`h-10 rounded-xl px-3 text-sm font-semibold transition-colors ${allocationMode === "auto" ? "bg-accent text-bg0" : "border border-line bg-bg1 text-muted hover:text-ink"}`}
                  >
                    {txText("allocationAuto")}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAllocationMode("single")}
                    className={`h-10 rounded-xl px-3 text-sm font-semibold transition-colors ${allocationMode === "single" ? "bg-accent text-bg0" : "border border-line bg-bg1 text-muted hover:text-ink"}`}
                  >
                    {txText("allocationSingle")}
                  </button>
                </div>
              </Field>
            )}
            <Field
              label={txText("sourceVault")}
              hint={
                type === "expense" || (type === "income" && allocationMode === "single")
                  ? vaults.length === 0
                    ? txText("recurringVaultNone")
                    : formVaultId
                      ? undefined
                      : type === "expense"
                        ? txText("expenseVaultRequired")
                        : txText("vaultRequired")
                  : undefined
              }
            >
              <select
                name="vaultId"
                value={type === "income" && allocationMode === "auto" ? "" : formVaultId}
                onChange={(event) => {
                  setFormVaultId(event.target.value);
                  setFormFundingSourceId("");
                }}
                required={type === "expense" || (type === "income" && allocationMode === "single")}
                disabled={type === "income" && allocationMode === "auto"}
                className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink disabled:opacity-60"
              >
                <option value="" disabled={type === "expense"}>{type === "expense" || (type === "income" && allocationMode === "single") ? txText("selectVault") : settings("noVault")}</option>
                {vaults.map((vault) => <option key={vault.id} value={vault.id} disabled={type === "expense" && vault.is_locked}>{vaultLabel(vault)}</option>)}
              </select>
            </Field>
            <Field label={txText("category")}>
              <select key={type} name="categoryId" defaultValue="" required={categories.some((category) => category.type === type)} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
                <option value="">{common("none")}</option>
                {categories.filter((category) => category.type === type).map((category) => (
                  <option key={category.id} value={category.id}>
                    {categoryLabel(category)}
                  </option>
                ))}
              </select>
            </Field>
            {type === "expense" && (
              <Field
                label={txText("fundingSource")}
                hint={
                  !formVaultId
                    ? txText("selectVaultFirst")
                    : vaultSources.length === 0
                      ? incomeCategories.length === 0
                        ? txText("noSourceYet")
                        : txText("noSourceInVault")
                      : undefined
                }
              >
                <select
                  name="fundingSourceId"
                  value={formFundingSourceId}
                  onChange={(event) => setFormFundingSourceId(event.target.value)}
                  required
                  disabled={vaultSources.length === 0}
                  className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink disabled:opacity-60"
                >
                  <option value="">{common("none")}</option>
                  {vaultSources.map((row) => (
                    <option key={row.source.id} value={row.source.id}>
                      {categoryLabel(row.source)} · {formatMoney(row.balance, locale)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={txText("note")}><Input name="note" maxLength={200} /></Field>
            {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
            <Button type="submit" disabled={saving}>{saving ? common("loading") : common("save")}</Button>
            </form>
          )}
        </CardContent></Card>
        <Card className="w-full max-w-full h-full overflow-hidden"><CardContent className="w-full max-w-full p-4 sm:p-5 h-full flex flex-col min-h-0 overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-2 shrink-0">
              <h2 className="font-display text-lg font-semibold text-ink">
                {section === "dashboard" ? dashboard("recentTx") : txText("title")}
              </h2>
              {section === "transactions" && filteredTransactions.length > 0 && (
                <p className="text-xs text-faint">
                  {txText("filterCount", {
                    count: filteredTransactions.length.toLocaleString(
                      locale === "id" ? "id-ID" : "en-US"
                    ),
                  })}
                </p>
              )}
            </div>
            {section === "transactions" && (
              <div className="mt-4 space-y-3 rounded-2xl border border-line bg-surface2/40 p-2 pb-4 sm:p-3 sm:pb-3 w-full max-w-full shrink-0">
                <Field label={txText("filterSearch")}>
                  <Input
                    value={filterSearch}
                    onChange={(event) => setFilterSearch(event.target.value)}
                    placeholder={txText("filterSearchPlaceholder")}
                  />
                </Field>
                <div className="flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => changeFilterType("")}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${filterType === "" ? "bg-accent text-bg0" : "bg-transparent text-muted hover:bg-surface2 hover:text-ink"}`}
                  >
                    {txText("filterAll")}
                  </button>
                  <button
                    type="button"
                    onClick={() => changeFilterType("income")}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${filterType === "income" ? "bg-accent text-bg0" : "bg-transparent text-muted hover:bg-surface2 hover:text-ink"}`}
                  >
                    {txText("filterIncome")}
                  </button>
                  <button
                    type="button"
                    onClick={() => changeFilterType("expense")}
                    className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${filterType === "expense" ? "bg-accent text-bg0" : "bg-transparent text-muted hover:bg-surface2 hover:text-ink"}`}
                  >
                    {txText("filterExpense")}
                  </button>
                  <div className="ml-auto flex flex-wrap items-center gap-1 mb-2 sm:mb-0">
                    <select
                      value={sortOrder}
                      onChange={(event) => setSortOrder(event.target.value as "date_desc" | "amount_desc" | "amount_asc")}
                      aria-label={txText("filterSort")}
                      className="h-8 rounded-lg border border-line bg-bg1 px-2 text-xs text-ink mb-1 sm:mb-0"
                    >
                      <option value="date_desc">{txText("sortDateDesc")}</option>
                      <option value="amount_desc">{txText("sortAmountDesc")}</option>
                      <option value="amount_asc">{txText("sortAmountAsc")}</option>
                    </select>
                    <button
                      type="button"
                      onClick={() => setFiltersExpanded((expanded) => !expanded)}
                      aria-expanded={filtersExpanded}
                      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface2 hover:text-ink"
                    >
                      {filtersExpanded ? txText("filterLess") : txText("filterMore")}
                      {advancedFiltersCount > 0 && (
                        <span className="rounded-full bg-accent/15 px-1.5 text-accent">
                          {advancedFiltersCount}
                        </span>
                      )}
                      <ChevronDown
                        size={14}
                        aria-hidden="true"
                        className={`transition-transform ${filtersExpanded ? "rotate-180" : ""}`}
                      />
                    </button>
                  </div>
                  {filtersActive && (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface2 hover:text-ink"
                    >
                      {txText("filterReset")}
                    </button>
                  )}
                </div>
                {filtersExpanded && (
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 mb-1 sm:mb-0">
                  <Field label={txText("filterMonth")}>
                    <select
                      value={filterMonth}
                      onChange={(event) => setFilterMonth(event.target.value)}
                      className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
                    >
                      <option value="">{txText("filterAllMonths")}</option>
                      {availableMonths.map((month) => (
                        <option key={month} value={month}>
                          {month}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field
                    label={txText("filterCategory")}
                  >
                    <select
                      value={filterCategory}
                      onChange={(event) => setFilterCategory(event.target.value)}
                      className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
                    >
                      <option value="">{txText("filterAllCategories")}</option>
                      {categoryOptions.map((category) => {
                        const label = categoryLabel(category);
                        return (
                          <option key={category.id} value={category.id}>
                            {label ?? humanizeSlug(category.slug)}
                          </option>
                        );
                      })}
                    </select>
                  </Field>
                  <Field label={txText("filterSource")}>
                    <select
                      value={filterFundingSource}
                      onChange={(event) => setFilterFundingSource(event.target.value)}
                      className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
                    >
                      <option value="">{txText("filterAllSources")}</option>
                      {fundingSourceOptions.map((source) => (
                        <option key={source.id} value={source.id}>
                          {categoryLabel(source) ?? humanizeSlug(source.slug)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={txText("filterVault")}>
                    <select
                      value={filterVault}
                      onChange={(event) => setFilterVault(event.target.value)}
                      className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
                    >
                      <option value="">{txText("filterAllVaults")}</option>
                      {vaultOptions.map((vault) => (
                        <option key={vault.id} value={vault.id}>
                          {vaultLabel(vault)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={txText("filterFromDate")}>
                    <Input
                      type="date"
                      value={filterFromDate}
                      max={filterToDate || undefined}
                      onChange={(event) => setFilterFromDate(event.target.value)}
                    />
                  </Field>
                  <Field label={txText("filterToDate")}>
                    <Input
                      type="date"
                      value={filterToDate}
                      min={filterFromDate || undefined}
                      onChange={(event) => setFilterToDate(event.target.value)}
                    />
                  </Field>
                  <Field label={txText("filterMinAmount")}>
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      value={filterMinAmount}
                      onChange={(event) => setFilterMinAmount(event.target.value)}
                    />
                  </Field>
                  <Field label={txText("filterMaxAmount")}>
                    <Input
                      type="number"
                      min="0"
                      step="1"
                      value={filterMaxAmount}
                      onChange={(event) => setFilterMaxAmount(event.target.value)}
                    />
                  </Field>
                </div>
                )}
              </div>
            )}
            <div className="mt-4 min-h-0 flex-1 overflow-y-auto overflow-x-hidden touch-pan-y pr-1">
            {loading ? (
              <p className="py-10 text-center text-sm text-muted">{common("loading")}</p>
            ) : section === "transactions" ? (
              monthGroups.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted">
                  {transactions.length === 0 ? txText("empty") : txText("filterNoneMatch")}
                </p>
              ) : (
                <div className="space-y-6">
                  {monthGroups.map(([monthKey, monthTxs]) => {
                    const monthIncome = monthTxs
                      .filter((tx) => tx.type === "income")
                      .reduce((sum, tx) => sum + tx.amount, 0);
                    const monthExpense = monthTxs
                      .filter((tx) => tx.type === "expense")
                      .reduce((sum, tx) => sum + tx.amount, 0);
                    const monthNet = monthIncome - monthExpense;
                    return (
                      <section key={monthKey}>
                        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-line bg-bg1/60 px-3 py-2">
                          <p className="text-sm font-medium text-ink">{monthKey}</p>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
                            <span
                              className="inline-flex items-center gap-1"
                              aria-label={`${txText("income")}: ${formatMoney(monthIncome, locale)}`}
                              title={txText("income")}
                            >
                              <ArrowDownLeft size={14} aria-hidden="true" className="text-accent" />
                              <span>{formatMoney(monthIncome, locale)}</span>
                            </span>
                            <span
                              className="inline-flex items-center gap-1"
                              aria-label={`${txText("expense")}: ${formatMoney(monthExpense, locale)}`}
                              title={txText("expense")}
                            >
                              <ArrowUpRight size={14} aria-hidden="true" className="text-danger" />
                              <span>{formatMoney(monthExpense, locale)}</span>
                            </span>
                            <span
                              className="inline-flex items-center gap-1"
                              aria-label={`${txText("monthNet")}: ${formatMoney(monthNet, locale)}`}
                              title={txText("monthNet")}
                            >
                              <CircleDollarSign size={14} aria-hidden="true" />
                              <span>{formatMoney(monthNet, locale)}</span>
                            </span>
                          </div>
                        </div>
                        <ul className="divide-y divide-line">
                          {monthTxs.map((transaction) => {
                            const incoming =
                              transaction.type === "income" ||
                              (transaction.type === "transfer" && transaction.transfer_direction !== "out");
                            const isExpanded = expandedTxId === transaction.id;
                            const formattedDate = new Date(`${transaction.date}T00:00:00`).toLocaleDateString(
                              locale === "id" ? "id-ID" : "en-US"
                            );
                            const isEditing = editingTransaction?.id === transaction.id;
                            return (
                              <li key={transaction.id} className="py-1">
                                <div className="flex items-center gap-2 sm:gap-3 py-2 min-w-0">
                                  <span
                                    className={
                                      incoming
                                        ? "grid h-8 w-8 sm:h-9 sm:w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"
                                        : "grid h-8 w-8 sm:h-9 sm:w-9 shrink-0 place-items-center rounded-xl bg-surface2 text-muted"
                                    }
                                  >
                                    {incoming ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm font-medium text-ink">
                                      {transaction.note || txText(transaction.type)}
                                    </p>
                                    <p className="mt-0.5 text-xs text-faint">
                                      {formattedDate}
                                      {categoryLabel(transaction.category) ? ` · ${categoryLabel(transaction.category)}` : ""}
                                    </p>
                                  </div>
                                  <span
                                    className={
                                      transaction.type === "income"
                                        ? "num min-w-[5.5rem] sm:w-32 shrink-0 text-right text-xs sm:text-sm font-semibold text-accent"
                                        : transaction.type === "expense"
                                          ? "num min-w-[5.5rem] sm:w-32 shrink-0 text-right text-xs sm:text-sm font-semibold text-danger"
                                          : "num min-w-[5.5rem] sm:w-32 shrink-0 text-right text-xs sm:text-sm font-semibold text-ink"
                                    }
                                  >
                                    {incoming ? "+" : "−"}
                                    {formatMoney(transaction.amount, locale)}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => setExpandedTxId(isExpanded ? null : transaction.id)}
                                    aria-expanded={isExpanded}
                                    aria-label={txText("details")}
                                    className="rounded-lg p-1.5 sm:p-2 text-faint hover:bg-surface2 hover:text-ink shrink-0"
                                  >
                                    <ChevronDown size={16} className={`transition-transform ${isExpanded ? "rotate-180" : ""}`} />
                                  </button>
                                  {transaction.type !== "transfer" && !transaction.group_id ? (
                                    <button
                                      type="button"
                                      disabled={savingEdit}
                                      onClick={() => { if (isEditing) { setEditingTransaction(null); setEditError(""); return; } setEditError(""); setEditingTransaction(transaction); setEditVaultId(transaction.vault_id ?? ""); setEditFundingSourceId(transaction.funding_source_id ?? ""); }}
                                      aria-label={txText("editTitle")}
                                      className="rounded-lg p-1.5 sm:p-2 text-faint hover:bg-surface2 hover:text-ink shrink-0"
                                    >
                                      <Pencil size={16} />
                                    </button>
                                  ) : (
                                    <span aria-hidden="true" className="h-7 w-7 sm:h-8 sm:w-8 shrink-0" />
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => void removeTransaction(transaction.id)}
                                    aria-label={common("delete")}
                                    className="rounded-lg p-1.5 sm:p-2 text-faint hover:bg-surface2 hover:text-danger shrink-0"
                                  >
                                    <Trash2 size={16} />
                                  </button>
                                </div>
                                {isEditing && transactionEditForm(transaction)}
                                {isExpanded && !isEditing && (
                                  <dl className="mb-2 grid gap-x-6 gap-y-2 rounded-xl border border-line bg-bg1/60 p-3 text-xs sm:grid-cols-2">
                                    <div>
                                      <dt className="text-faint">{txText("type")}</dt>
                                      <dd className="mt-0.5 text-ink">{txText(transaction.type)}</dd>
                                    </div>
                                    <div>
                                      <dt className="text-faint">{txText("date")}</dt>
                                      <dd className="mt-0.5 text-ink">{formattedDate}</dd>
                                    </div>
                                    {categoryLabel(transaction.category) && (
                                      <div>
                                        <dt className="text-faint">{txText("category")}</dt>
                                        <dd className="mt-0.5 text-ink">{categoryLabel(transaction.category)}</dd>
                                      </div>
                                    )}
                                    {transaction.type === "expense" && transaction.funding && (
                                      <div>
                                        <dt className="text-faint">{txText("fundingSource")}</dt>
                                        <dd className="mt-0.5 text-ink">{categoryLabel(transaction.funding)}</dd>
                                      </div>
                                    )}
                                    {vaultLabel(transaction.vault) && (
                                      <div>
                                        <dt className="text-faint">{txText("sourceVault")}</dt>
                                        <dd className="mt-0.5 text-ink">{vaultLabel(transaction.vault)}</dd>
                                      </div>
                                    )}
                                    {transaction.note && (
                                      <div className="sm:col-span-2">
                                        <dt className="text-faint">{txText("note")}</dt>
                                        <dd className="mt-0.5 text-ink">{transaction.note}</dd>
                                      </div>
                                    )}
                                  </dl>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </section>
                    );
                  })}
                </div>
              )
            ) : transactions.slice(0, 5).length === 0 ? (
              <p className="py-10 text-center text-sm text-muted">{txText("empty")}</p>
            ) : (
              <ul className="mt-4 divide-y divide-line">
                {transactions.slice(0, 5).map((transaction) => (
                  <li key={transaction.id} className="flex items-center gap-3 py-3">
                    <span
                      className={
                        transaction.type === "income"
                          ? "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"
                          : "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface2 text-muted"
                      }
                    >
                      {transaction.type === "income" ? <ArrowDownLeft size={17} /> : <ArrowUpRight size={17} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">
                        {transaction.note || txText(transaction.type)}
                      </p>
                      <p className="text-xs text-faint">
                        {new Date(`${transaction.date}T00:00:00`).toLocaleDateString(locale === "id" ? "id-ID" : "en-US")}
                        {transaction.vault?.name ? ` · ${transaction.vault.name}` : ""}
                      </p>
                    </div>
                    <span
                      className={
                        transaction.type === "income"
                          ? "num text-sm font-semibold text-accent"
                          : transaction.type === "expense"
                            ? "num text-sm font-semibold text-danger"
                            : "num text-sm font-semibold text-ink"
                      }
                    >
                      {transaction.type === "income" ? "+" : "−"}
                      {formatMoney(transaction.amount, locale)}
                    </span>
                    <button
                      type="button"
                      onClick={() => void removeTransaction(transaction.id)}
                      aria-label={common("delete")}
                      className="rounded-lg p-2 text-faint hover:bg-surface2 hover:text-danger"
                    >
                      <Trash2 size={16} />
                    </button>
                  </li>
                )                )}
              </ul>
            )}
            </div>
          </CardContent></Card>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return <Card><CardContent className="p-5"><div className="flex items-center justify-between text-sm text-muted"><span>{label}</span>{icon && <span className="text-accent">{icon}</span>}</div><p className="num mt-3 text-xl font-semibold tracking-tight text-ink">{value}</p></CardContent></Card>;
}
