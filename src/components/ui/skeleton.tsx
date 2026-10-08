import { cn } from "@/src/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-xl bg-surface2",
        className
      )}
    />
  );
}