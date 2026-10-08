"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "@/src/i18n/navigation";
import { Calculator, Download, Flame, LockKeyhole, LockKeyholeOpen, Plus, Sparkles, Target, Trash2, Trophy, Upload, Wallet } from "lucide-react";
import { Button } from "@/src/components/ui/button";
import { Card, CardContent } from "@/src/components/ui/card";
import { Field, Input } from "@/src/components/ui/input";
import { Progress } from "@/src/components/ui/progress";
import { createVault, deleteVault, toggleVaultLock } from "@/src/lib/actions/vaults";
import { carryOverBudget, copyBudgetPeriod, deleteBudget, saveBudget } from "@/src/lib/actions/budgets";
import { deleteAllocationRule, saveAllocationRule, setActiveRule } from "@/src/lib/actions/allocation";
import { saveDisplayName } from "@/src/lib/actions/profile";
import { exportJson } from "@/src/lib/actions/export";
import { restoreFinancialBackup } from "@/src/lib/actions/backup";
import { createClient } from "@/src/lib/supabase/client";
import { logSupabaseError } from "@/src/lib/supabase/errors";
import { previewAllocation, sumPercent, validateSlots } from "@/src/lib/allocation";
import {
  budgetLeftover,
  budgetRatio,
  budgetSpend,
  budgetState,
  budgetStatus,
  defaultBudgetPeriod,
  nextPeriod,
  paydayLabel,
  periodRange,
} from "@/src/lib/budget";
import { currentMonthISO, todayISO } from "@/src/lib/utils";
import { resolveLabel } from "@/src/lib/labels";
import { vaultBalanceDelta } from "@/src/lib/vault-ledger";
import { getLevelInfo } from "@/src/lib/levels";
import { nextStreakReward } from "@/src/lib/gamification";
import type { AllocMethod, AllocationRule, AllocationSlot, Budget, BudgetScope, Category, GamificationState, Profile, Transaction, Vault } from "@/src/lib/types";

type Props = { section: "allocation" | "vaults" | "budgets" | "rewards" | "about" | "settings" };
type RuleWithSlots = AllocationRule & { slots: (AllocationSlot & { vault: Vault | null })[] };

/** Baris builder slot di form, sebelum disimpan sebagai `allocation_slots`. */
type SlotDraft = { key: string; vaultId: string; method: AllocMethod; value: string };

function money(amount: number, locale: string) {
  return new Intl.NumberFormat(locale === "id" ? "id-ID" : "en-US", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Rentang default form: satu bulan penuh mulai hari ini.
 *
 * Dua tanggal tetap boleh dikoreksi supaya sesuai tanggal gajian; yang dijaga di
 * sini hanya panjangnya satu bulan, bukan tanggal gaji-hardcode.
 */
function defaultPeriod() {
  return defaultBudgetPeriod() ?? { startsOn: todayISO(), endsOn: todayISO() };
}

/** Nonce sederhana agar draft slot punya key unik tanpa library tambahan. */
let slotKeyCounter = 0;
function newSlotKey() {
  slotKeyCounter += 1;
  return `slot-${slotKeyCounter}`;
}

export function SupabaseToolsPage({ section }: Props) {
  const locale = useLocale();
  const router = useRouter();
  const common = useTranslations("common");
  const t = useTranslations(section);
  const settings = useTranslations("settings");
  const rewards = useTranslations("rewards");
  const local = useTranslations("local");
  const auth = useTranslations("auth");
  const nav = useTranslations("nav");
  const categoryName = useTranslations("cat");
  const vaultText = useTranslations("vaults");
  const messages = useTranslations();
  const [userId, setUserId] = useState("");
  const [email, setEmail] = useState("");
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [rules, setRules] = useState<RuleWithSlots[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [gamification, setGamification] = useState<GamificationState | null>(null);
  const [achievements, setAchievements] = useState<AchievementRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const backupInputRef = useRef<HTMLInputElement>(null);
  // Form alokasi
  const [ruleName, setRuleName] = useState("");
  const [slotDrafts, setSlotDrafts] = useState<SlotDraft[]>([
    { key: newSlotKey(), vaultId: "", method: "percent", value: "" },
    { key: newSlotKey(), vaultId: "", method: "remainder", value: "" },
  ]);
  // Form anggaran
  const [budgetScope, setBudgetScope] = useState<BudgetScope>("category");
  const [budgetScopeId, setBudgetScopeId] = useState("");
  const [budgetNotice, setBudgetNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const supabase = createClient();
      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError) throw authError;
      if (!user) throw new Error("Session Supabase tidak ditemukan.");
      setUserId(user.id);
      setEmail(user.email ?? "");
      const [vaultResult, txResult, budgetResult, categoryResult, ruleResult, profileResult, gameResult, achievementResult, userAchievementResult] = await Promise.all([
        supabase.from("vaults").select("*").eq("user_id", user.id).order("priority"),
        supabase.from("transactions").select("*").eq("user_id", user.id).order("date", { ascending: false }),
        supabase.from("budgets").select("*").eq("user_id", user.id).order("starts_on", { ascending: false }),
        supabase.from("categories").select("*").or(`user_id.is.null,user_id.eq.${user.id}`).order("is_system", { ascending: false }),
        supabase.from("allocation_rules").select("*, slots:allocation_slots(*, vault:vaults(*))").eq("user_id", user.id).order("created_at", { ascending: false }),
        supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
        supabase.from("gamification_state").select("*").eq("user_id", user.id).maybeSingle(),
        supabase.from("achievements").select("*"),
        supabase.from("user_achievements").select("achievement_id,unlocked_at").eq("user_id", user.id),
      ]);
      const results = [vaultResult, txResult, budgetResult, categoryResult, ruleResult, profileResult, gameResult, achievementResult, userAchievementResult];
      const failed = results.find((result) => result.error);
      if (failed?.error) throw failed.error;
      setVaults((vaultResult.data ?? []) as Vault[]);
      setTransactions((txResult.data ?? []) as Transaction[]);
      setBudgets((budgetResult.data ?? []) as Budget[]);
      setCategories((categoryResult.data ?? []) as Category[]);
      setRules((ruleResult.data ?? []) as RuleWithSlots[]);
      setProfile(profileResult.data as Profile | null);
      setGamification(gameResult.data as GamificationState | null);
      const unlocks = new Map((userAchievementResult.data ?? []).map((item) => [item.achievement_id, item.unlocked_at]));
      setAchievements(((achievementResult.data ?? []) as AchievementRow[]).map((item) => ({ ...item, unlockedAt: unlocks.get(item.id) ?? null })));
    } catch (loadError) {
      logSupabaseError("tools.load", loadError);
      setError(settings("connectionError"));
    } finally {
      setLoading(false);
    }
  }, [settings]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => { if (active) void load(); });
    return () => { active = false; };
  }, [load]);

  const month = currentMonthISO();
  const today = todayISO();
  const expenseCategories = categories.filter((category) => category.type === "expense");
  const monthIncome = transactions.filter((tx) => tx.type === "income" && tx.date.startsWith(month.slice(0, 7))).reduce((sum, tx) => sum + tx.amount, 0);

  // Anggaran tidak lagi dikunci ke bulan kalender, jadi yang dikelompokkan adalah
  // posisinya terhadap hari ini: periode aktif di atas, periode yang sudah
  // berakhir (satu-satunya yang punya sisa) di bawahnya.
  const scopedBudgets = budgets.map((budget) => ({ budget, spent: budgetSpend(transactions, budget) }));
  const activeBudgets = scopedBudgets.filter((row) => budgetState(row.budget, today) === "active");
  const endedBudgets = scopedBudgets.filter((row) => budgetState(row.budget, today) === "ended");
  const upcomingBudgets = scopedBudgets.filter((row) => budgetState(row.budget, today) === "upcoming");
  const carriedOverIds = new Set(budgets.map((budget) => budget.rolled_over_from).filter((id): id is string => id !== null));
  const vaultBalances = useMemo(() => new Map(vaults.map((vault) => [vault.id, transactions.filter((tx) => tx.vault_id === vault.id).reduce((sum, tx) => sum + vaultBalanceDelta(tx.type, tx.amount, tx.transfer_direction), 0)])), [transactions, vaults]);
  const pageTitle = nav(section);

  /** Label untuk <option> anggaran; sama dengan yang dipakai halaman Transaksi. */
  function scopeOptionLabel(item: Vault | Category) {
    return resolveLabel(item, categoryName) ?? item.slug;
  }

  /**
 * Memetakan kode error dari action ke pesan yang bisa dibaca.
 *
 * Tanpa ini semua kegagalan jadi `settings.saveError`, termasuk
 * "sudah pernah dibawa" - yang membuat tombol yang salah diklik terlihat seperti
 * bug, bukan aturan yang sebenarnya sudah bekerja dengan benar.
 */
function budgetErrorMessage(code: unknown) {
  switch (code) {
    case "err.auth":
      return t("errAuth");
    case "err.period":
    case "err.periodRange":
      return t("errPeriodRange");
    case "err.amount":
      return t("errAmount");
    case "err.noLeftover":
      return t("errNoLeftover");
    case "err.alreadyRolledOver":
      return t("errAlreadyRolledOver");
    case "err.rolloverTargetTaken":
      return t("errRolloverTargetTaken");
    default:
      return settings("saveError");
  }
}

/** Kode error yang bukan budgets punya pesan sendiri di namespace-nya. */
function actionErrorMessage(code: unknown) {
  if (code === "vaults.nameTaken") return vaultText("nameTaken");
  if (code === "settings.displayNameInvalid") return settings("displayNameInvalid");
  return settings("saveError");
}

async function completeAction(action: () => Promise<unknown>): Promise<boolean> {
    setSaving(true);
    setError("");
    setNotice("");
    setBudgetNotice("");
    try {
      await action();
      await load();
      return true;
    } catch (actionError) {
      console.error(`Supabase ${section} mutation failed.`, actionError);
      const code = actionError instanceof Error ? actionError.message : undefined;
      setError(
        section === "budgets" ? budgetErrorMessage(code) : actionErrorMessage(code)
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function submitVault(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const target = Math.trunc(Number(data.get("target") ?? 0));
    if (!name || !Number.isFinite(target) || target < 0) return;
    await completeAction(async () => {
      const result = await createVault(locale, {
        name,
        target_amount: target || null,
      });
      if (!result.ok) throw new Error(result.error);
    });
    form.reset();
  }

  async function submitBudget(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const limit = Math.trunc(Number(data.get("limit")));
    const startsOn = String(data.get("startsOn") ?? "");
    const endsOn = String(data.get("endsOn") ?? "");
    if (!budgetScopeId || !Number.isFinite(limit) || limit <= 0) return;
    await completeAction(async () => {
      const result = await saveBudget(locale, {
        scope: budgetScope,
        scopeId: budgetScopeId,
        startsOn,
        endsOn,
        limit,
      });
      if (!result.ok) throw new Error(result.error);
      setBudgetNotice(t("budgetSaved"));
      form.reset();
    });
  }

  /** Sisa periode yang berakhir; 0 kalau sudah habis atau sudah dibawa. */
  function leftoverOf(row: { budget: Budget; spent: number }) {
    return budgetLeftover(row.budget.limit_amount, row.spent);
  }

  /**
   * "Buat periode berikutnya": menyalin batas ke periode gaji berikutnya.
   *
   * Konfirmasi menyebut bulan tujuan supaya yang terjadi jelas - tombolnya
   * terlihat seperti membuat sesuatu, bukan sekadar menyalin di belakang layar.
   */
  async function makeNextPeriod(budget: Budget, following: { startsOn: string; endsOn: string }) {
    if (!window.confirm(t("makeNextPeriodConfirm", {
      month: paydayLabel(following, locale),
      range: periodRange(following, locale, Number(today.slice(0, 4))),
      limit: money(budget.limit_amount, locale),
    }))) {
      return;
    }
    await completeAction(async () => {
      const result = await copyBudgetPeriod(locale, budget.id, following);
      if (!result.ok) throw new Error(result.error);
      setBudgetNotice(t("nextPeriodMade", { month: paydayLabel(following, locale) }));
    });
  }

  async function carryOver(row: { budget: Budget; spent: number }) {
    const leftover = leftoverOf(row);
    if (leftover <= 0) return;
    const target = nextPeriod({ startsOn: row.budget.starts_on, endsOn: row.budget.ends_on });
    if (!target) return;
    setNotice("");
    if (!window.confirm(t("budgetCarryOverConfirm", { leftover: money(leftover, locale), from: row.budget.ends_on, to: target.endsOn }))) {
      return;
    }
    await completeAction(async () => {
      const result = await carryOverBudget(locale, row.budget.id);
      if (!result.ok) throw new Error(result.error);
      setBudgetNotice(t("budgetCarriedOver", { leftover: money(leftover, locale) }));
    });
  }

  function updateSlot(key: string, patch: Partial<SlotDraft>) {
    setSlotDrafts((drafts) => drafts.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  }

  function addSlot() {
    setSlotDrafts((drafts) => [...drafts, { key: newSlotKey(), vaultId: "", method: "percent", value: "" }]);
  }

  function removeSlot(key: string) {
    setSlotDrafts((drafts) => drafts.filter((draft) => draft.key !== key));
  }

  /** Draft -> bentuk yang dipahami validateSlots; slot remainder mengabaikan nilai. */
  const draftSlots = slotDrafts.map((draft) => ({
    vault_id: draft.vaultId,
    method: draft.method,
    value: draft.method === "remainder" ? 0 : Number(draft.value || 0),
  }));
  const draftValid = validateSlots(draftSlots);
  const draftPercent = sumPercent(draftSlots);
  const draftPreview = previewAllocation(
    monthIncome,
    draftSlots.map((draft, index) => ({ ...draft, priority: index }))
  );

  async function submitRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftValid.ok) {
      setError(t(draftValid.error));
      return;
    }
    setError("");
    await completeAction(async () => {
      const result = await saveAllocationRule(locale, {
        name: ruleName.trim() || t("title"),
        sourceCategoryId: null,
        isActive: true,
        slots: draftSlots.map((draft, index) => ({
          vaultId: draft.vault_id,
          method: draft.method,
          value: draft.value,
          priority: index,
        })),
      });
      if (!result.ok) throw new Error(result.error);
    });
    setRuleName("");
    setSlotDrafts([
      { key: newSlotKey(), vaultId: "", method: "percent", value: "" },
      { key: newSlotKey(), vaultId: "", method: "remainder", value: "" },
    ]);
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const displayName = String(new FormData(event.currentTarget).get("displayName") ?? "").trim();
    if (!displayName) {
      setError(settings("displayNameInvalid"));
      return;
    }
    if (!userId) {
      setError(settings("saveError"));
      return;
    }
    const saved = await completeAction(async () => {
      const result = await saveDisplayName(locale, displayName);
      if (!result.ok) throw new Error(result.error);
    });
    if (saved) {
      setNotice(settings("profileSaved"));
      router.refresh();
    }
  }

  async function exportData() {
    setSaving(true);
    setError("");
    try {
      const backup = await exportJson();
      const blob = new Blob([backup.data], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = backup.filename;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (exportError) {
      console.error("Supabase export failed.", exportError);
      setError(settings("exportError"));
    } finally {
      setSaving(false);
    }
  }

  async function restoreData(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      if (file.size > 10 * 1024 * 1024) {
        setError(settings("backupFormatError"));
        return;
      }
      const backup: unknown = JSON.parse(await file.text());
      if (!backup || typeof backup !== "object" || Array.isArray(backup)) {
        setError(settings("backupFormatError"));
        return;
      }
      const record = backup as Record<string, unknown>;
      const account = record.account;
      const rowCount = ["categories", "vaults", "transactions", "budgets", "allocation_rules", "allocation_slots", "recurring_transactions"]
        .reduce((total, key) => total + (Array.isArray(record[key]) ? (record[key] as unknown[]).length : 0), 0);
      if (record.schema_version !== 1 || record.app !== "nexora" || !account || typeof account !== "object" || Array.isArray(account)) {
        setError(settings("backupFormatError"));
        return;
      }
      const accountId = (account as Record<string, unknown>).id;
      if (typeof accountId !== "string" || accountId !== userId) {
        setError(settings("backupOwnerError"));
        return;
      }
      if (!window.confirm(settings("restoreConfirm", { rows: rowCount }))) return;
      const result = await restoreFinancialBackup(backup);
      if (!result.ok) {
        const errorMessage = result.error === "backup.owner"
          ? settings("backupOwnerError")
          : result.error === "backup.format"
            ? settings("backupFormatError")
            : settings("restoreError");
        setError(errorMessage);
        return;
      }
      setNotice(settings("restoreSuccess", { rows: result.restoredRows }));
      await load();
    } catch (restoreError) {
      console.error("Supabase backup restore failed.", restoreError);
      setError(settings("restoreError"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rise-in space-y-6">
      <div>
        <p className="text-sm text-muted">Nexora · Budgeting</p>
        <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">{pageTitle}</h1>
        <p className="mt-2 text-sm text-muted">{settings("cloudStorage")}</p>
      </div>
      {error && <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">{error}</p>}
      {notice && <p role="status" className="rounded-xl border border-accent/30 bg-accent/10 p-3 text-sm text-accent">{notice}</p>}
      {loading ? <Card><CardContent className="p-8 text-center text-sm text-muted">{common("loading")}</CardContent></Card> : <>
        {section === "vaults" && <section className="grid items-start gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <Card><CardContent className="p-5"><h2 className="font-display text-lg font-semibold text-ink">{t("createTitle")}</h2><form onSubmit={submitVault} className="mt-5 flex flex-col gap-4"><Field label={t("name")}><Input name="name" maxLength={48} required /></Field><Field label={t("targetAmount")}><Input name="target" type="number" min="0" step="1" defaultValue="0" /></Field><Button type="submit" disabled={saving}><Plus size={16} />{common("add")}</Button></form></CardContent></Card>
          <div className="space-y-3">{vaults.length === 0 ? <Empty text={local("emptyVaults")} /> : vaults.map((vault) => {
            const balance = vaultBalances.get(vault.id) ?? 0;
            const target = vault.target_amount ?? 0;
            return <Card key={vault.id}><CardContent className="p-5"><div className="flex items-start justify-between gap-4"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-surface2 text-accent"><Wallet size={18} /></span><div><h3 className="font-semibold text-ink">{scopeOptionLabel(vault)}</h3><p className="text-xs text-muted">{vault.is_locked ? t("locked") : t("unlocked")}</p></div></div><div className="flex gap-1"><button type="button" disabled={saving} onClick={() => void completeAction(async () => { const result = await toggleVaultLock(locale, vault.id, !vault.is_locked); if (!result.ok) throw new Error(result.error); })} aria-label={vault.is_locked ? t("unlock") : t("lock")} className="rounded-lg p-2 text-muted hover:bg-surface2 hover:text-ink">{vault.is_locked ? <LockKeyholeOpen size={17} /> : <LockKeyhole size={17} />}</button><button type="button" disabled={saving} onClick={() => { if (window.confirm(t("deleteConfirm"))) void completeAction(async () => { const result = await deleteVault(locale, vault.id); if (!result.ok) throw new Error(result.error); }); }} aria-label={common("delete")} className="rounded-lg p-2 text-muted hover:bg-surface2 hover:text-danger"><Trash2 size={17} /></button></div></div><div className="mt-4 flex justify-between text-sm"><span className="text-muted">{t("balance")}</span><span className="num font-semibold text-ink">{money(balance, locale)}</span></div>{target > 0 && <><Progress value={balance / target * 100} className="mt-3" /><p className="mt-2 text-xs text-muted">{t("target")}: {money(target, locale)} · {Math.round(Math.min(balance / target * 100, 100))}%</p></>}</CardContent></Card>;
          })}</div>
        </section>}

        {section === "budgets" && <section className="grid items-start gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <Card><CardContent className="p-5"><h2 className="font-display text-lg font-semibold text-ink">{t("createTitle")}</h2><p className="mt-2 text-sm text-muted">{t("subtitle")}</p><form onSubmit={submitBudget} className="mt-5 flex flex-col gap-4"><Field label={t("scope")}><select name="scope" value={budgetScope} onChange={(event) => { setBudgetScope(event.target.value as BudgetScope); setBudgetScopeId(""); }} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"><option value="category">{t("scopeCategory")}</option><option value="vault">{t("scopeVault")}</option></select></Field><Field label={budgetScope === "vault" ? t("vault") : t("category")}><select name="scopeId" value={budgetScopeId} onChange={(event) => setBudgetScopeId(event.target.value)} required className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"><option value="">{common("none")}</option>{(budgetScope === "vault" ? vaults : expenseCategories).map((item) => <option key={item.id} value={item.id}>{scopeOptionLabel(item)}</option>)}</select></Field>
            <div className="grid gap-3 sm:grid-cols-2"><Field label={t("periodStart")}><Input key={`start-${budgetScopeId}`} name="startsOn" type="date" defaultValue={defaultPeriod().startsOn} required /></Field><Field label={t("periodEnd")}><Input key={`end-${budgetScopeId}`} name="endsOn" type="date" defaultValue={defaultPeriod().endsOn} required /></Field></div>
            <p className="-mt-2 text-xs text-muted">{t("periodHint")}</p>
            <p className="-mt-2 text-xs text-faint">{t("periodWillBe", { month: paydayLabel(defaultPeriod(), locale) })}</p>
            <Field label={t("limit")}><Input name="limit" type="number" min="1" step="1" required /></Field><Button type="submit" disabled={saving}>{common("save")}</Button></form>{budgetNotice && <p className="mt-3 text-xs text-accent">{budgetNotice}</p>}</CardContent></Card>
          <div className="space-y-5">
            <Card><CardContent className="p-5"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-surface2 text-accent"><Target size={18} /></span><div><h2 className="font-display text-lg font-semibold text-ink">{t("title")}</h2><p className="text-xs text-muted">{t("activePeriods")}</p></div></div>{activeBudgets.length === 0 ? <p className="mt-6 text-sm text-muted">{t("noActive")}</p> : <ul className="mt-4 divide-y divide-line">{activeBudgets.map((row) => {
            const { budget, spent } = row;
            const status = budgetStatus(spent, budget.limit_amount, Number(budget.alert_threshold));
            const target = budget.scope === "vault"
              ? vaults.find((vault) => vault.id === budget.scope_id)
              : categories.find((category) => category.id === budget.scope_id);
            const label = target ? scopeOptionLabel(target) : t(budget.scope === "vault" ? "scopeVault" : "scopeCategory");
            const following = nextPeriod({ startsOn: budget.starts_on, endsOn: budget.ends_on });
            const canCreateNext = Boolean(following) && !budgets.some(
              (other) => other.id !== budget.id
                && other.scope === budget.scope
                && other.scope_id === budget.scope_id
                && other.starts_on === following?.startsOn
            );
            return <li key={budget.id} className="py-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-ink">{label}</p><p className="mt-1 text-xs text-muted">{t("paydayOf", { month: paydayLabel({ startsOn: budget.starts_on, endsOn: budget.ends_on }, locale) })}</p><p className="mt-0.5 text-xs text-faint">{periodRange({ startsOn: budget.starts_on, endsOn: budget.ends_on }, locale, Number(today.slice(0, 4)))}</p><p className="mt-1 text-xs text-muted">{money(spent, locale)} / {money(budget.limit_amount, locale)}</p></div><div className="flex shrink-0 items-center gap-1">{canCreateNext && following && <button type="button" disabled={saving} onClick={() => makeNextPeriod(budget, following)} title={t("makeNextPeriodTitle", { month: paydayLabel(following, locale) })} className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-ink hover:bg-surface2 disabled:opacity-40"><Plus size={14} />{t("makeNextPeriod")}</button>}<button type="button" disabled={saving} onClick={() => void completeAction(async () => { const result = await deleteBudget(locale, budget.id); if (!result.ok) throw new Error(result.error); })} aria-label={common("delete")} className="rounded-lg p-2 text-muted hover:text-danger"><Trash2 size={16} /></button></div></div><Progress value={budgetRatio(spent, budget.limit_amount) * 100} className="mt-3" indicatorClassName={status === "ok" ? undefined : "bg-danger"} /><p className={`mt-2 text-xs font-medium ${status === "exceeded" || status === "warning" ? "text-danger" : "text-muted"}`}>{t(status)}</p>{budget.rolled_over_from && <p className="mt-1 text-xs text-faint">{t("includesLeftover")}</p>}</li>;
          })}</ul>}</CardContent></Card>

            {upcomingBudgets.length > 0 && <Card><CardContent className="p-5"><h2 className="font-display text-base font-semibold text-ink">{t("upcomingPeriods")}</h2><ul className="mt-3 divide-y divide-line">{upcomingBudgets.map((row) => {
              const target = row.budget.scope === "vault"
                ? vaults.find((vault) => vault.id === row.budget.scope_id)
                : categories.find((category) => category.id === row.budget.scope_id);
              const label = target ? scopeOptionLabel(target) : t(row.budget.scope === "vault" ? "scopeVault" : "scopeCategory");
              return <li key={row.budget.id} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="font-medium text-ink">{label}</p><p className="mt-1 text-xs text-muted">{t("paydayOf", { month: paydayLabel({ startsOn: row.budget.starts_on, endsOn: row.budget.ends_on }, locale) })}</p><p className="mt-0.5 text-xs text-faint">{periodRange({ startsOn: row.budget.starts_on, endsOn: row.budget.ends_on }, locale, Number(today.slice(0, 4)))} · {money(row.budget.limit_amount, locale)}</p></div><button type="button" disabled={saving} onClick={() => void completeAction(async () => { const result = await deleteBudget(locale, row.budget.id); if (!result.ok) throw new Error(result.error); })} aria-label={common("delete")} className="shrink-0 rounded-lg p-2 text-muted hover:bg-surface2 hover:text-danger"><Trash2 size={16} /></button></li>;
            })}</ul></CardContent></Card>}

            <Card><CardContent className="p-5"><h2 className="font-display text-base font-semibold text-ink">{t("endedPeriods")}</h2><p className="mt-1 text-xs text-muted">{t("leftoverHint")}</p>{endedBudgets.length === 0 ? <p className="mt-4 text-sm text-muted">{t("noEnded")}</p> : <ul className="mt-3 divide-y divide-line">{endedBudgets.map((row) => {
              const { budget, spent } = row;
              const leftover = leftoverOf(row);
              const alreadyCarried = carriedOverIds.has(budget.id);
              const target = budget.scope === "vault"
                ? vaults.find((vault) => vault.id === budget.scope_id)
                : categories.find((category) => category.id === budget.scope_id);
              const label = target ? scopeOptionLabel(target) : t(budget.scope === "vault" ? "scopeVault" : "scopeCategory");
              const following = nextPeriod({ startsOn: budget.starts_on, endsOn: budget.ends_on });
              return <li key={budget.id} className="py-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium text-ink">{label}</p><p className="mt-1 text-xs text-muted">{t("paydayOf", { month: paydayLabel({ startsOn: budget.starts_on, endsOn: budget.ends_on }, locale) })}</p><p className="mt-0.5 text-xs text-faint">{periodRange({ startsOn: budget.starts_on, endsOn: budget.ends_on }, locale, Number(today.slice(0, 4)))}</p><p className="mt-1 text-xs text-muted">{money(spent, locale)} / {money(budget.limit_amount, locale)}</p><p className={`mt-1 text-xs ${leftover > 0 ? "text-accent" : "text-faint"}`}>{leftover > 0 ? t("leftover", { amount: money(leftover, locale) }) : t("noLeftover")}</p>{alreadyCarried && <p className="mt-1 text-xs text-faint">{t("alreadyRolledOver")}</p>}</div><button type="button" disabled={saving || leftover <= 0 || alreadyCarried || !following} onClick={() => void carryOver(row)} title={leftover <= 0 || alreadyCarried ? t("cannotCarryOver") : t("carryOver")} className="shrink-0 rounded-lg border border-line px-3 py-1.5 text-xs text-ink hover:bg-surface2 disabled:opacity-40">{t("carryOver")}</button></div></li>;
            })}</ul>}</CardContent></Card>
          </div>
        </section>}

        {section === "allocation" && <section className="space-y-5">
          <Card><CardContent className="p-5"><h2 className="font-display text-lg font-semibold text-ink">{t("newRule")}</h2><p className="mt-2 text-sm text-muted">{t("subtitle")}</p>{vaults.length === 0 ? <p className="mt-4 text-sm text-muted">{local("createVaultFirst")}</p> : <form onSubmit={submitRule} className="mt-5 flex flex-col gap-4">
            <Field label={t("ruleName")}><Input name="name" value={ruleName} onChange={(event) => setRuleName(event.target.value)} maxLength={64} /></Field>
            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between"><span className="text-xs font-medium text-muted">{t("slots")}</span><button type="button" onClick={addSlot} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-accent hover:bg-accent/10"><Plus size={14} />{t("slotAdd")}</button></div>
              <ul className="flex flex-col gap-2">
                {slotDrafts.map((draft, index) => {
                  const share = draftPreview.find((row) => row.slot.vault_id === draft.vaultId && row.slot.priority === index);
                  return <li key={draft.key} className="flex flex-wrap items-end gap-2 rounded-xl border border-line p-3">
                    <div className="min-w-40 flex-1"><Field label={t("slotVault")}><select value={draft.vaultId} onChange={(event) => updateSlot(draft.key, { vaultId: event.target.value })} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"><option value="">{common("none")}</option>{vaults.map((vault) => <option key={vault.id} value={vault.id}>{scopeOptionLabel(vault)}</option>)}</select></Field></div>
                    <div className="w-36"><Field label={t("method")}><select value={draft.method} onChange={(event) => updateSlot(draft.key, { method: event.target.value as AllocMethod })} className="h-10 w-full rounded-xl border border-line bg-bg1 px-3 text-sm text-ink"><option value="percent">{t("percent")}</option><option value="amount">{t("amount")}</option><option value="remainder">{t("remainder")}</option></select></Field></div>
                    <div className="w-32"><Field label={t("value")}><Input type="number" min="0" step="1" value={draft.value} disabled={draft.method === "remainder"} onChange={(event) => updateSlot(draft.key, { value: event.target.value })} /></Field></div>
                    <p className="num w-24 text-right text-xs text-faint">{share ? money(share.amount, locale) : "—"}</p>
                    <button type="button" onClick={() => removeSlot(draft.key)} disabled={slotDrafts.length === 1} aria-label={t("removeSlot")} className="rounded-lg p-2 text-muted hover:bg-surface2 hover:text-danger disabled:opacity-40"><Trash2 size={16} /></button>
                  </li>;
                })}
              </ul>
              <p className="text-xs text-faint">{t("totalPercent")}: {draftPercent}%{draftValid.ok ? "" : ` · ${t(draftValid.error)}`}</p>
            </div>
            <Button type="submit" disabled={saving || !draftValid.ok}><Plus size={16} />{t("newRule")}</Button>
          </form>}</CardContent></Card>
          <Card><CardContent className="p-5"><h2 className="font-display text-lg font-semibold text-ink">{t("previewTitle")}</h2><p className="mt-1 text-sm text-muted">{local("thisMonthIncome")}: {money(monthIncome, locale)}</p>{rules.length === 0 ? <p className="mt-6 text-sm text-muted">{t("noRules")}</p> : <ul className="mt-4 divide-y divide-line">{rules.map((rule) => {
            const shares = previewAllocation(monthIncome, rule.slots);
            return <li key={rule.id} className="flex items-start gap-4 py-3"><div className="min-w-0 flex-1"><p className="font-medium text-ink">{rule.name || t("title")}</p>{shares.map((share) => <p key={share.slot.id ?? share.slot.vault_id} className="text-xs text-muted">{share.slot.vault?.id
                      ? scopeOptionLabel(share.slot.vault)
                      : vaults.find((vault) => vault.id === share.slot.vault_id)
                        ? scopeOptionLabel(vaults.find((vault) => vault.id === share.slot.vault_id)!)
                        : share.slot.vault_id} · {share.slot.method === "percent" ? `${share.slot.value}%` : share.slot.method === "amount" ? money(share.slot.value, locale) : t("remainder")} · <span className="num">{money(share.amount, locale)}</span></p>)}</div><label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={rule.is_active} onChange={(event) => void completeAction(async () => { const result = await setActiveRule(locale, rule.id, event.target.checked); if (!result.ok) throw new Error(result.error); })} />{t("setDefault")}</label><button type="button" onClick={() => void completeAction(async () => { const result = await deleteAllocationRule(locale, rule.id); if (!result.ok) throw new Error(result.error); })} aria-label={common("delete")} className="rounded-lg p-2 text-muted hover:text-danger"><Trash2 size={16} /></button></li>;
          })}</ul>}</CardContent></Card>
        </section>}

        {section === "rewards" && (() => {
          const points = gamification?.points ?? 0;
          const streak = gamification?.streak_current ?? 0;
          const level = getLevelInfo(points);
          const nextReward = nextStreakReward(streak);
          const pointsToNextRank =
            level.nextThreshold === null ? null : level.nextThreshold - points;

          return <section className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <Metric title={rewards("points")} value={points.toLocaleString(locale === "id" ? "id-ID" : "en-US")} />
              <Metric title={rewards("streakTitle")} value={`${streak} ${rewards("days")}`} />
              <Metric title={rewards("achievements")} value={`${achievements.filter((achievement) => achievement.unlockedAt).length} / ${achievements.length}`} />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Card><CardContent className="p-5">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-surface2"><Trophy size={18} style={{ color: level.color }} /></span>
                  <div>
                    <p className="text-xs text-muted">{rewards("currentRank")}</p>
                    <h2 className="font-display text-lg font-semibold text-ink">{messages(level.titleKey)}</h2>
                  </div>
                </div>
                {pointsToNextRank === null ? (
                  <p className="mt-4 text-sm text-muted">{rewards("maxRank")}</p>
                ) : (
                  <>
                    <Progress value={level.progress * 100} className="mt-5" />
                    <p className="mt-2 text-xs text-muted">
                      {rewards("nextRankHint", { points: pointsToNextRank.toLocaleString(locale === "id" ? "id-ID" : "en-US") })}
                    </p>
                  </>
                )}
              </CardContent></Card>
              <Card><CardContent className="p-5">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-accent/10 text-accent"><Flame size={18} /></span>
                  <div>
                    <p className="text-xs text-muted">{rewards("streakTitle")}</p>
                    <h2 className="font-display text-lg font-semibold text-ink">
                      {rewards("nextStreakReward", {
                        days: nextReward.day - streak,
                        points: nextReward.bonus,
                      })}
                    </h2>
                  </div>
                </div>
                <p className="mt-4 flex items-center gap-2 text-sm text-muted">
                  <Sparkles size={15} className="text-accent" />
                  {gamification?.last_log_date === today ? rewards("streakLoggedToday") : rewards("logToday")}
                </p>
              </CardContent></Card>
            </div>
            <Card><CardContent className="p-5"><div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-surface2 text-accent"><Trophy size={18} /></span><div><h2 className="font-display text-lg font-semibold text-ink">{rewards("achievements")}</h2><p className="text-sm text-muted">{rewards("subtitle")}</p></div></div>{achievements.length === 0 ? <p className="mt-5 text-sm text-muted">{rewards("achievementsEmpty")}</p> : <ul className="mt-4 divide-y divide-line">{achievements.map((achievement) => <li key={achievement.id} className="flex items-center gap-3 py-3"><span className={achievement.unlockedAt ? "grid h-8 w-8 place-items-center rounded-full bg-accent/15 text-accent" : "grid h-8 w-8 place-items-center rounded-full bg-surface2 text-faint"}><Trophy size={15} /></span><span className="min-w-0 flex-1"><span className="block text-sm text-ink">{messages(achievement.name_key)}</span><span className="mt-0.5 block text-xs text-muted">{messages(achievement.description_key)}</span></span><span className="shrink-0 text-right text-xs text-muted"><span className="block">{achievement.unlockedAt ? rewards("unlocked") : rewards("locked")}</span><span className="mt-0.5 block text-accent">+{achievement.points_reward} pts</span></span></li>)}</ul>}</CardContent></Card>
          </section>;
        })()}

        {section === "about" && <section className="space-y-5">
          <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,0.9fr)]">
            <Card className="overflow-hidden border-0 bg-gradient-to-br from-surface via-surface to-bg1 shadow-[0_12px_30px_rgba(17,24,39,0.06)]">
              <CardContent className="p-0">
                <div className="border-b border-line bg-gradient-to-r from-accent/6 via-transparent to-surface p-5 sm:p-6">
                  <div className="flex items-center gap-3">
                    <div className="brand-mark grid h-12 w-12 place-items-center rounded-2xl">
                      <Wallet size={22} />
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-[0.28em] text-muted">{t("appLabel")}</p>
                      <h2 className="font-display text-2xl font-semibold tracking-tight text-ink">{t("appTitle")}</h2>
                    </div>
                  </div>
                </div>

                <div className="p-5 sm:p-6">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1">
                      <Sparkles size={12} className="text-accent" />
                      Personal Finance
                    </span>
                    <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-1">
                      <Trophy size={12} className="text-accent" />
                      Habit Builder
                    </span>
                  </div>

                  <p className="mt-5 max-w-2xl text-sm leading-7 text-muted">{t("appDescription")}</p>

                  <div className="mt-6 grid gap-3 sm:grid-cols-2">
                    {[
                      { key: "featureTransactions", icon: Wallet },
                      { key: "featureVaults", icon: Target },
                      { key: "featureBudgets", icon: Sparkles },
                      { key: "featureRewards", icon: Trophy },
                      { key: "featureCalculator", icon: Calculator },
                    ].map(({ key, icon: Icon }) => (
                      <div key={key} className="flex gap-3 rounded-2xl border border-line bg-bg1/60 p-3.5">
                        <span className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent">
                          <Icon size={16} />
                        </span>
                        <p className="text-sm leading-6 text-muted">{t(key)}</p>
                      </div>
                    ))}
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="overflow-hidden border-0 bg-surface shadow-[0_10px_26px_rgba(15,23,42,0.05)]">
              <CardContent className="p-5 sm:p-6">
                <div className="flex items-center justify-between gap-3">
                  <h2 className="font-display text-xl font-semibold text-ink">{t("profileTitle")}</h2>
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-accent/10 text-accent">
                    <Sparkles size={18} />
                  </span>
                </div>

                <div className="mt-5 rounded-3xl border border-line bg-gradient-to-br from-bg1 to-surface p-4">
                  <div className="flex items-center gap-3">
                    <div className="grid h-14 w-14 place-items-center rounded-2xl bg-surface2 text-lg font-bold text-ink">
                      M
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-muted">{t("developer")}</p>
                      <p className="mt-1 text-lg font-semibold text-ink">Moh. Reza Alfi Ali</p>
                    </div>
                  </div>
                </div>

                <div className="mt-5 space-y-3">
                  <div className="rounded-2xl border border-line bg-bg1/60 p-3.5">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-muted">{t("profileName")}</p>
                    <p className="mt-2 text-base font-semibold text-ink">{profile?.display_name || "Nexora User"}</p>
                  </div>
                  <div className="rounded-2xl border border-line bg-bg1/60 p-3.5">
                    <p className="text-[11px] uppercase tracking-[0.2em] text-muted">{t("profileEmail")}</p>
                    <p className="mt-2 break-all text-base font-semibold text-ink">{email || "-"}</p>
                  </div>
                </div>

                <div className="mt-5 rounded-2xl border border-dashed border-accent/30 bg-accent/5 p-3.5">
                  <p className="text-xs uppercase tracking-[0.2em] text-muted">Focus</p>
                  <p className="mt-2 text-sm leading-6 text-muted">Membantu Anda membangun kebiasaan finansial yang lebih sehat, terukur, dan konsisten.</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>}

        {section === "settings" && <section className="space-y-5">
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <Card><CardContent className="p-5"><h2 className="font-display text-lg font-semibold text-ink">{t("profile")}</h2><form onSubmit={saveProfile} className="mt-5 flex flex-col gap-4"><Field label={t("displayName")}><Input name="displayName" defaultValue={profile?.display_name ?? ""} maxLength={64} required /></Field><Field label={auth("email")}><Input value={email} readOnly /></Field><Button type="submit" disabled={saving}>{common("save")}</Button></form></CardContent></Card>
            <Card><CardContent className="p-5">
              <h2 className="font-display text-lg font-semibold text-ink">{t("exportTitle")}</h2>
              <p className="mt-2 text-sm text-muted">{settings("backupDesc")}</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={saving} onClick={() => void exportData()}><Download size={16} />{settings("downloadBackup")}</Button>
                <Button type="button" variant="outline" disabled={saving} onClick={() => backupInputRef.current?.click()}><Upload size={16} />{settings("restoreBackup")}</Button>
                <input ref={backupInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => void restoreData(event)} />
              </div>
              <p className="mt-3 text-xs text-muted">{settings("backupMergeNote")}</p>
              <div className="mt-8 border-t border-line pt-5"><h3 className="font-semibold text-ink">{t("danger")}</h3><p className="mt-1 text-sm text-muted">{settings("cloudDeleteWarning")}</p></div>
            </CardContent></Card>
          </div>
          <Card><CardContent className="p-5 sm:p-6">
            <div>
              <h2 className="font-display text-lg font-semibold text-ink">{t("guideTitle")}</h2>
              <p className="mt-1 text-sm text-muted">{t("guideDesc")}</p>
            </div>
            <ol className="mt-5 grid gap-3 sm:grid-cols-3">
              {(["guideStep1", "guideStep2", "guideStep3"] as const).map((key, index) => (
                <li key={key} className="flex gap-3 rounded-xl border border-line bg-bg1/60 p-3">
                  <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-accent/10 text-xs font-semibold text-accent">{index + 1}</span>
                  <p className="text-sm leading-relaxed text-muted">{t(key)}</p>
                </li>
              ))}
            </ol>
            <div className="mt-6 grid gap-x-6 gap-y-4 sm:grid-cols-2">
              {([
                ["guideDashboardTitle", "guideDashboard"],
                ["guideTransactionsTitle", "guideTransactions"],
                ["guideVaultsTitle", "guideVaults"],
                ["guideBudgetsTitle", "guideBudgets"],
                ["guideAllocationTitle", "guideAllocation"],
                ["guideRewardsTitle", "guideRewards"],
                ["guideCalculatorTitle", "guideCalculator"],
              ] as const).map(([titleKey, descriptionKey]) => (
                <div key={titleKey} className="border-t border-line pt-3">
                  <h3 className="text-sm font-semibold text-ink">{t(titleKey)}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-muted">{t(descriptionKey)}</p>
                </div>
              ))}
            </div>
          </CardContent></Card>
        </section>}
      </>}
    </div>
  );
}

type AchievementRow = { id: string; name_key: string; description_key: string; points_reward: number; unlockedAt: string | null };

function Empty({ text }: { text: string }) {
  return <Card><CardContent className="p-8 text-center text-sm text-muted">{text}</CardContent></Card>;
}

function Metric({ title, value }: { title: string; value: string }) {
  return <Card><CardContent className="p-5"><p className="text-sm text-muted">{title}</p><p className="num mt-3 text-2xl font-semibold text-ink">{value}</p></CardContent></Card>;
}
