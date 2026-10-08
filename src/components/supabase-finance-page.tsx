"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, CalendarClock, Check, ChevronLeft, ChevronRight, CircleDollarSign, Pause, Pencil, Play, Plus, SkipForward, Trash2 } from "lucide-react";
import { Card, CardContent } from "@/src/components/ui/card";
import { CashflowChart } from "@/src/components/cashflow-chart";
import { Button } from "@/src/components/ui/button";
import { Field, Input } from "@/src/components/ui/input";
import { createClient } from "@/src/lib/supabase/client";
import { logSupabaseError } from "@/src/lib/supabase/errors";
import { addTransaction, deleteTransaction, editTransaction } from "@/src/lib/actions/transactions";
import { createIncomeSource, deleteIncomeSource } from "@/src/lib/actions/categories";
import { availableSources, summarizeSources, type SourceSummary } from "@/src/lib/sources";
import { resolveLabel, humanizeSlug } from "@/src/lib/labels";
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

function formatMoney(amount: number, locale: string) {
  return new Intl.NumberFormat(locale === "id" ? "id-ID" : "en-US", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
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
  const [sourceName, setSourceName] = useState("");
  const [sourceFormError, setSourceFormError] = useState("");
  const [savingSource, setSavingSource] = useState(false);
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
  const [summaryMonth, setSummaryMonth] = useState(todayISO().slice(0, 7));
  const [recurringFormOpen, setRecurringFormOpen] = useState(false);
  const [editingRecurringId, setEditingRecurringId] = useState("");
  const [recurringType, setRecurringType] = useState<"income" | "expense">("expense");
  const [recurringFrequency, setRecurringFrequency] = useState<"weekly" | "monthly">("monthly");
  const [recurringCategoryId, setRecurringCategoryId] = useState("");
  const [recurringFundingSourceId, setRecurringFundingSourceId] = useState("");
  const [recurringVaultId, setRecurringVaultId] = useState("");

  /**
   * Nama kategori dan vault, diseragamkan dengan halaman Alokasi/Anggaran
   * lewat `resolveLabel` supaya `slug` yang hopeful bocor tidak pernah tampil.
   */
  const categoryLabel = useCallback(
    (category: CategoryRef | null | undefined) => resolveLabel(category, categoryName),
    [categoryName]
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
      const [txResult, vaultResult, categoryResult, budgetResult, recurringResult] = await Promise.all([
        supabase.from("transactions")
          .select("*, vault:vaults(id,slug,name,is_locked), category:categories!transactions_category_id_fkey(id,slug,name_key), funding:categories!transactions_funding_source_id_fkey(id,slug,name_key)")
          .eq("user_id", user.id)
          .order("date", { ascending: false })
          .order("created_at", { ascending: false }),
        supabase.from("vaults")
          .select("*")
          .eq("user_id", user.id)
          .order("priority", { ascending: true }),
        supabase.from("categories")
          .select("*")
          .or(`user_id.is.null,user_id.eq.${user.id}`)
          .order("is_system", { ascending: false }),
        supabase.from("budgets")
          .select("*")
          .eq("user_id", user.id),
        supabase.from("recurring_transactions")
          .select("*")
          .eq("user_id", user.id)
          .order("due_on", { ascending: true }),
      ]);
      if (txResult.error) throw txResult.error;
      if (vaultResult.error) throw vaultResult.error;
      if (categoryResult.error) throw categoryResult.error;
      if (budgetResult.error) throw budgetResult.error;
      if (recurringResult.error) throw recurringResult.error;
      setTransactions((txResult.data ?? []) as TxRow[]);
      setVaults((vaultResult.data ?? []) as Vault[]);
      setCategories((categoryResult.data ?? []) as Category[]);
      setBudgets((budgetResult.data ?? []) as Budget[]);
      setRecurringTemplates((recurringResult.data ?? []) as RecurringTransaction[]);
    } catch (loadError) {
      logSupabaseError("finance.load", loadError);
      setError(settings("connectionError"));
    } finally {
      setLoading(false);
    }
  }, [settings]);

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
  const monthLabel = (month: string) =>
    new Intl.DateTimeFormat(locale === "id" ? "id-ID" : "en-US", {
      month: "long",
      year: "numeric",
    }).format(new Date(`${month}-01T00:00:00`));

  const incomeCategories = categories.filter((category) => category.type === "income");
  const expenseCategories = categories.filter((category) => category.type === "expense");
  const sourceSummaries = summarizeSources(transactions, incomeCategories);
  // Zero-balance sources are hidden here; the server re-checks the balance on
  // insert, so this list is a convenience, not the guard.
  const fundableSources = availableSources(sourceSummaries);
  // "Never recorded any income" and "every source is empty" need different
  // guidance: the first means create a source, the second means add income.
  const emptySourceHint = incomeCategories.length === 0 ? txText("noSourceYet") : txText("noSource");

  /**
   * Opsi filter diturunkan dari data yang benar-benar ada, bukan dari daftar
   * master: bulan tanpa transaksi dan vault yang belum pernah dipakai tidak
   * perlu muncul sebagai pilihan.
   */
  const availableMonths = [...new Set(transactions.map((tx) => tx.date.slice(0, 7)))].sort((a, b) =>
    b.localeCompare(a)
  );
  const usedVaultIds = new Set(
    transactions.map((tx) => tx.vault_id).filter((id): id is string => Boolean(id))
  );
  // Tanpa jenis terpilih, kategori income dan expense digabung: "Makanan" dan
  // "Gaji" sama-sama sah untuk disaring. Begitu jenis dipilih, daftar menyempit
  // ke kategori yang relevan supaya tidak ada pilihan yang selalu kosong.
  const categoryOptions = (
    filterType === "expense"
      ? expenseCategories
      : filterType === "income"
        ? incomeCategories
        : [...incomeCategories, ...expenseCategories]
  ).filter((category) => transactions.some((tx) => tx.category_id === category.id));
  const vaultOptions = vaults.filter((vault) => usedVaultIds.has(vault.id));
  const fundingSourceOptions = incomeCategories.filter((category) =>
    transactions.some(
      (tx) => tx.category_id === category.id || tx.funding_source_id === category.id
    )
  );
  const dueRecurringTemplates = recurringTemplates.filter((template) =>
    template.is_active &&
    template.due_on <= todayJakartaISO() &&
    (!template.snoozed_until || template.snoozed_until <= todayJakartaISO())
  );

  const filtersActive = Boolean(
    filterType || filterMonth || filterFromDate || filterToDate || filterMinAmount ||
    filterMaxAmount || filterCategory || filterFundingSource || filterVault || filterSearch
  );

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

  /**
   * `transactions` sudah terurut `date desc` dari query, sehingga tiap grup bulan
   * sudah urut tanpa sort tambahan; grup-nya yang perlu diurutkan.
   */
  const monthGroups: Array<[string, TxRow[]]> = (() => {
    const grouped = new Map<string, TxRow[]>();
    for (const tx of filteredTransactions) {
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
  }

  function recurringErrorMessage(code: string | undefined) {
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
      default: return settings("saveError");
    }
  }

  async function submitRecurringTemplate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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
        vaultId: recurringVaultId || null,
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
      });
      if (!result.ok) {
        setError(recurringErrorMessage(result.error));
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
    setRecurringFormOpen(true);
  }

  function transactionError(code: string | undefined) {
    if (code === "transactions.lockedError") return txText("lockedError");
    if (code === "transactions.noSource") return emptySourceHint;
    if (code === "transactions.insufficientSource") return txText("insufficientSource");
    return settings("saveError");
  }

  function sourceFormErrorMessage(code: string | undefined) {
    if (code === "transactions.sourceExists") return txText("sourceExists");
    if (code === "transactions.sourceNameTakenSystem") {
      return txText("sourceNameTakenSystem", { name: sourceName.trim() });
    }
    return settings("saveError");
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

  async function removeSource(source: SourceSummary) {
    if (!window.confirm(txText("deleteSourceConfirm"))) return;
    setError("");
    try {
      const result = await deleteIncomeSource(locale, source.source.id);
      if (!result.ok) {
        setError(settings("deleteError"));
        return;
      }
      if (filterCategory === source.source.id) setFilterCategory("");
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
    if (type === "expense" && !fundingSourceId) {
      setFormError(emptySourceHint);
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
        note: String(data.get("note") ?? "").trim() || null,
      });
      if (!result.ok) {
        setFormError(transactionError(result.error));
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
      await load();
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
        setEditError(result.error === "transactions.insufficientSource"
          ? txText("insufficientSource")
          : settings("saveError"));
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
      {section === "transactions" && editingTransaction && (
        <Card>
          <CardContent className="p-5">
            <h2 className="font-display text-lg font-semibold text-ink">{txText("editTitle")}</h2>
            <form onSubmit={saveTransactionEdit} className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label={txText("amount")}>
                <Input name="amount" type="number" min="1" max="2147483647" step="1" defaultValue={editingTransaction.amount} required />
              </Field>
              <Field label={txText("date")}>
                <Input name="date" type="date" defaultValue={editingTransaction.date} required />
              </Field>
              <Field label={txText("category")}>
                <select name="categoryId" defaultValue={editingTransaction.category_id ?? ""} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
                  <option value="">{common("none")}</option>
                  {(editingTransaction.type === "income" ? incomeCategories : expenseCategories).map((category) => (
                    <option key={category.id} value={category.id}>{categoryLabel(category) ?? humanizeSlug(category.slug)}</option>
                  ))}
                </select>
              </Field>
              {editingTransaction.type === "expense" && (
                <Field label={txText("fundingSource")}>
                  <select name="fundingSourceId" defaultValue={editingTransaction.funding_source_id ?? ""} required className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
                    <option value="">{common("none")}</option>
                    {incomeCategories.map((category) => (
                      <option key={category.id} value={category.id}>{categoryLabel(category) ?? humanizeSlug(category.slug)}</option>
                    ))}
                  </select>
                </Field>
              )}
              <Field label={txText("sourceVault")}>
                <select name="vaultId" defaultValue={editingTransaction.vault_id ?? ""} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
                  <option value="">{common("none")}</option>
                  {vaults.filter((vault) => editingTransaction.type === "income" || !vault.is_locked || vault.id === editingTransaction.vault_id).map((vault) => (
                    <option key={vault.id} value={vault.id}>{vaultLabel(vault)}</option>
                  ))}
                </select>
              </Field>
              <Field label={txText("note")} className="sm:col-span-2">
                <Input name="note" maxLength={200} defaultValue={editingTransaction.note ?? ""} />
              </Field>
              {editError && <p role="alert" className="text-sm text-danger sm:col-span-2">{editError}</p>}
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" disabled={savingEdit}>{common("save")}</Button>
                <Button type="button" variant="outline" disabled={savingEdit} onClick={() => { setEditingTransaction(null); setEditError(""); }}>{common("cancel")}</Button>
              </div>
            </form>
          </CardContent>
        </Card>
      )}
      {section === "dashboard" && (
        <div className="grid gap-4 sm:grid-cols-3">
          <SummaryCard label={dashboard("totalBalance")} value={formatMoney(totalIncome - totalExpense, locale)} />
          <SummaryCard label={dashboard("income")} value={formatMoney(totalIncome, locale)} icon={<ArrowDownLeft size={17} />} />
          <SummaryCard label={dashboard("expense")} value={formatMoney(totalExpense, locale)} icon={<ArrowUpRight size={17} />} />
        </div>
      )}
      {section === "dashboard" && !loading && !error && (
        <Card>
          <CardContent className="p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="font-display text-lg font-semibold text-ink">{dashboard("onboardingTitle")}</h2>
                <p className="mt-1 text-sm text-muted">
                  {completedOnboardingSteps === onboardingSteps.length
                    ? dashboard("onboardingComplete")
                    : dashboard("onboardingProgress", {
                        complete: completedOnboardingSteps,
                        total: onboardingSteps.length,
                      })}
                </p>
              </div>
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
                {dashboard(alert.status === "exceeded" ? "overBudget" : "nearBudget")}
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
          <CardContent className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface2 text-accent">
                  <CalendarClock size={18} />
                </span>
                <div>
                  <h2 className="font-display text-lg font-semibold text-ink">{txText("recurringTitle")}</h2>
                  <p className="mt-1 max-w-2xl text-sm text-muted">{txText("recurringDescription")}</p>
                </div>
              </div>
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
                    setRecurringFormOpen(true);
                  }
                }}
              >
                <Plus size={16} />{txText("recurringCreate")}
              </Button>
            </div>

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
                <Field label={txText("recurringInterval")}>
                  <Input name="intervalCount" type="number" min="1" max="12" step="1" defaultValue={recurringTemplates.find((item) => item.id === editingRecurringId)?.interval_count ?? 1} required />
                </Field>
                {recurringFrequency === "monthly" && (
                  <p className="self-end pb-2 text-xs text-faint">{txText("recurringMonthEndRule")}</p>
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
                {recurringType === "expense" && (
                  <Field label={txText("fundingSource")}>
                    <select
                      value={recurringFundingSourceId}
                      onChange={(event) => setRecurringFundingSourceId(event.target.value)}
                      required
                      className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
                    >
                      <option value="">{common("none")}</option>
                      {incomeCategories.map((category) => (
                        <option key={category.id} value={category.id}>{categoryLabel(category)}</option>
                      ))}
                    </select>
                  </Field>
                )}
                <Field label={txText("sourceVault")}>
                  <select
                    value={recurringVaultId}
                    onChange={(event) => setRecurringVaultId(event.target.value)}
                    className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"
                  >
                    <option value="">{settings("noVault")}</option>
                    {vaults.map((vault) => <option key={vault.id} value={vault.id}>{vaultLabel(vault)}</option>)}
                  </select>
                </Field>
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
                      <form onSubmit={(event) => void submitRecurringOccurrence(event, template)} className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                        <p className="text-xs text-muted sm:col-span-2 lg:col-span-3">{txText("recurringOccurrenceEditHint")}</p>
                        <Field label={txText("amount")}>
                          <Input name="amount" type="number" min="1" step="1" defaultValue={template.amount} required />
                        </Field>
                        <Field label={txText("date")}>
                          <Input name="transactionDate" type="date" defaultValue={todayJakartaISO()} max={todayJakartaISO()} required />
                        </Field>
                        <Field label={txText("category")}>
                          <select name="categoryId" defaultValue={template.category_id ?? ""} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
                            <option value="">{common("none")}</option>
                            {(template.type === "income" ? incomeCategories : expenseCategories).map((category) => (
                              <option key={category.id} value={category.id}>{categoryLabel(category)}</option>
                            ))}
                          </select>
                        </Field>
                        {template.type === "expense" && (
                          <Field label={txText("fundingSource")}>
                            <select name="fundingSourceId" defaultValue={template.funding_source_id ?? ""} required className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
                              <option value="">{common("none")}</option>
                              {incomeCategories.map((category) => (
                                <option key={category.id} value={category.id}>{categoryLabel(category)}</option>
                              ))}
                            </select>
                          </Field>
                        )}
                        <Field label={txText("sourceVault")}>
                          <select name="vaultId" defaultValue={template.vault_id ?? ""} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
                            <option value="">{settings("noVault")}</option>
                            {vaults.map((vault) => <option key={vault.id} value={vault.id} disabled={template.type === "expense" && vault.is_locked}>{vaultLabel(vault)}</option>)}
                          </select>
                        </Field>
                        <Field label={txText("note")}>
                          <Input name="note" maxLength={240} defaultValue={template.note ?? template.name} />
                        </Field>
                        <div className="flex flex-wrap gap-2 sm:col-span-2 lg:col-span-3">
                          <Button type="submit" disabled={saving}>{txText("recurringRecord")}</Button>
                          <Button type="button" variant="outline" disabled={saving} onClick={() => void runRecurringAction(
                            () => snoozeRecurringOccurrence(locale, template.id, template.due_on),
                            txText("recurringSnoozed")
                          )}>{txText("recurringRemindTomorrow")}</Button>
                          <Button type="button" variant="ghost" disabled={saving} onClick={() => void runRecurringAction(
                            () => skipRecurringOccurrence(locale, template.id, template.due_on),
                            txText("recurringSkipped")
                          )}><SkipForward size={15} />{txText("recurringSkip")}</Button>
                        </div>
                      </form>
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
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">{sourceLabel(summary)}</p>
                        <p className="text-xs text-faint">
                          {txText("sourceIncome")} {formatMoney(summary.income, locale)} · {txText("sourceExpense")} {formatMoney(summary.expense, locale)}
                        </p>
                      </div>
                      {!summary.source.is_system && (
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
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card><CardContent className="p-5">
          <h2 className="font-display text-lg font-semibold text-ink">{txText("addTitle")}</h2>
          <form onSubmit={submitTransaction} className="mt-5 flex flex-col gap-4">
            <Field label={txText("type")}>
              <select name="type" value={type} onChange={(event) => setType(event.target.value as "income" | "expense")} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
                <option value="income">{txText("income")}</option>
                <option value="expense">{txText("expense")}</option>
              </select>
            </Field>
            <Field label={txText("amount")}><Input name="amount" type="number" min="1" step="1" required /></Field>
            <Field label={txText("date")}><Input name="date" type="date" defaultValue={todayISO()} required /></Field>
            <Field label={txText("sourceVault")}>
              <select name="vaultId" defaultValue="" className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink">
                <option value="">{settings("noVault")}</option>
                {vaults.map((vault) => <option key={vault.id} value={vault.id} disabled={type === "expense" && vault.is_locked}>{vaultLabel(vault)}{vault.is_locked ? ` · ${txText("lockedError")}` : ""}</option>)}
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
              <Field label={txText("fundingSource")} hint={fundableSources.length === 0 ? emptySourceHint : undefined}>
                <select
                  key={`funding-${fundableSources.length}`}
                  name="fundingSourceId"
                  defaultValue=""
                  required
                  disabled={fundableSources.length === 0}
                  className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink disabled:opacity-60"
                >
                  <option value="">{common("none")}</option>
                  {fundableSources.map((summary) => (
                    <option key={summary.source.id} value={summary.source.id}>
                      {sourceLabel(summary)} · {formatMoney(summary.balance, locale)}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={txText("note")}><Input name="note" maxLength={200} /></Field>
            {formError && <p role="alert" className="text-sm text-danger">{formError}</p>}
            <Button type="submit" disabled={saving}>{saving ? common("loading") : common("save")}</Button>
          </form>
        </CardContent></Card>
          <Card><CardContent className="p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
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
              <div className="mt-4 space-y-3 rounded-2xl border border-line bg-surface2/40 p-3">
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
                  {filtersActive && (
                    <button
                      type="button"
                      onClick={resetFilters}
                      className="ml-auto rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted hover:bg-surface2 hover:text-ink"
                    >
                      {txText("filterReset")}
                    </button>
                  )}
                </div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
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
                  <Field label={txText("filterSearch")} className="sm:col-span-2 lg:col-span-2">
                    <Input
                      value={filterSearch}
                      onChange={(event) => setFilterSearch(event.target.value)}
                      placeholder={txText("filterSearch")}
                    />
                  </Field>
                </div>
              </div>
            )}
            {loading ? (
              <p className="py-10 text-center text-sm text-muted">{common("loading")}</p>
            ) : section === "transactions" ? (
              monthGroups.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted">
                  {transactions.length === 0 ? txText("empty") : txText("filterNoneMatch")}
                </p>
              ) : (
                <div className="mt-4 space-y-6">
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
                          {monthTxs.map((transaction) => (
                            <li key={transaction.id} className="flex items-center gap-3 py-3">
                              <span
                                className={
                                  transaction.type === "income" ||
                                  (transaction.type === "transfer" && transaction.transfer_direction !== "out")
                                    ? "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent"
                                    : "grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface2 text-muted"
                                }
                              >
                                {transaction.type === "income" ||
                                (transaction.type === "transfer" && transaction.transfer_direction !== "out") ? (
                                  <ArrowDownLeft size={17} />
                                ) : (
                                  <ArrowUpRight size={17} />
                                )}
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-ink">
                                  {transaction.note || txText(transaction.type)}
                                </p>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                  {categoryLabel(transaction.category) && (
                                    <span className="inline-flex items-center rounded-full border border-line bg-bg1 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                                      {categoryLabel(transaction.category)}
                                    </span>
                                  )}
                                  {transaction.type === "expense" && transaction.funding && (
                                    <span className="inline-flex items-center rounded-full border border-accent/30 bg-accent/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-accent">
                                      {txText("fundedBy")}: {categoryLabel(transaction.funding)}
                                    </span>
                                  )}
                                  {vaultLabel(transaction.vault) && (
                                    <span className="inline-flex items-center rounded-full border border-line bg-bg1 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                                      {vaultLabel(transaction.vault)}
                                    </span>
                                  )}
                                  <span className="inline-flex items-center rounded-full border border-line bg-bg1 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">
                                    {new Date(`${transaction.date}T00:00:00`).toLocaleDateString(
                                      locale === "id" ? "id-ID" : "en-US"
                                    )}
                                  </span>
                                </div>
                              </div>
                              <span
                                className={
                                  transaction.type === "income" ||
                                  (transaction.type === "transfer" && transaction.transfer_direction !== "out")
                                    ? "num text-sm font-semibold text-accent"
                                    : "num text-sm font-semibold text-ink"
                                }
                              >
                                {transaction.type === "income" ||
                                (transaction.type === "transfer" && transaction.transfer_direction !== "out") ? "+" : "−"}
                                {formatMoney(transaction.amount, locale)}
                              </span>
                              {transaction.type !== "transfer" && !transaction.group_id && (
                                <button
                                  type="button"
                                  disabled={savingEdit}
                                  onClick={() => { setEditError(""); setEditingTransaction(transaction); }}
                                  aria-label={txText("editTitle")}
                                  className="rounded-lg p-2 text-faint hover:bg-surface2 hover:text-ink"
                                >
                                  <Pencil size={16} />
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => void removeTransaction(transaction.id)}
                                aria-label={common("delete")}
                                className="rounded-lg p-2 text-faint hover:bg-surface2 hover:text-danger"
                              >
                                <Trash2 size={16} />
                              </button>
                            </li>
                          ))}
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
                ))}
              </ul>
            )}
          </CardContent></Card>
      </div>
    </div>
  );
}

function SummaryCard({ label, value, icon }: { label: string; value: string; icon?: React.ReactNode }) {
  return <Card><CardContent className="p-5"><div className="flex items-center justify-between text-sm text-muted"><span>{label}</span>{icon && <span className="text-accent">{icon}</span>}</div><p className="num mt-3 text-xl font-semibold tracking-tight text-ink">{value}</p></CardContent></Card>;
}
