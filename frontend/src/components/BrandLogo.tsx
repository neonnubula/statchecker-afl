import { cn } from "@/lib/utils";

/** Text wordmark. Swap in your own logo for your fork. */
export function BrandLogo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-2 align-middle font-serif text-2xl leading-none", className)}>
      StatChecker
    </span>
  );
}
