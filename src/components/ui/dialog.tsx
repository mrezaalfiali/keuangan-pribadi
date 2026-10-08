import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/src/lib/utils";

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [rendered, setRendered] = useState(open);

  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
      const raf = requestAnimationFrame(() => setRendered(true));
      return () => cancelAnimationFrame(raf);
    }
    document.body.style.overflow = "";
    const t = setTimeout(() => setRendered(false), 200);
    return () => clearTimeout(t);
  }, [open]);

  if (!rendered) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      aria-modal="true"
      role="dialog"
    >
      <div
        className={cn(
          "absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-200",
          open ? "opacity-100" : "opacity-0"
        )}
        onClick={onClose}
      />
      <div
        className={cn(
          "relative z-10 w-full max-w-lg rounded-t-3xl border border-line bg-surface p-6 shadow-2xl transition-all duration-200 sm:rounded-3xl rise-in",
          open ? "translate-y-0 opacity-100" : "translate-y-6 opacity-0",
          className
        )}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="font-display text-lg font-semibold text-ink">{title}</h2>}
            {description && <p className="mt-1 text-sm text-muted">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-faint hover:bg-surface2 hover:text-ink"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}