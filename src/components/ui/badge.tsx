import { cn } from "@/src/lib/utils";

type Variant = "default" | "success" | "warn" | "danger" | "vault" | "outline";

const variantClasses: Record<Variant, string> = {
  default: "bg-surface2 text-ink border-line",
  success: "bg-accent/15 text-accent border-accent/20",
  warn: "bg-warn/15 text-warn border-warn/20",
  danger: "bg-danger/15 text-danger border-danger/20",
  vault: "bg-vault/15 text-vault border-vault/20",
  outline: "border-line text-muted",
};

export function Badge({
  className,
  variant = "default",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: Variant }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold",
        variantClasses[variant],
        className
      )}
      {...props}
    />
  );
}