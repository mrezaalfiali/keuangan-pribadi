import { notFound } from "next/navigation";
import { CalculatorPage } from "@/src/components/calculator-page";
import { SupabaseFinancePage } from "@/src/components/supabase-finance-page";
import { SupabaseToolsPage } from "@/src/components/supabase-tools-page";

const SECTIONS = [
  "dashboard",
  "transactions",
  "allocation",
  "vaults",
  "budgets",
  "rewards",
  "calculator",
  "about",
  "settings",
];

export default async function LocalSectionPage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!SECTIONS.includes(section)) notFound();

  if (section === "dashboard" || section === "transactions") {
    return <SupabaseFinancePage section={section} />;
  }

  if (section === "calculator") {
    return <CalculatorPage />;
  }

  if (
    section === "allocation" ||
    section === "vaults" ||
    section === "budgets" ||
    section === "rewards" ||
    section === "about" ||
    section === "settings"
  ) {
    return <SupabaseToolsPage section={section} />;
  }

  notFound();
}
