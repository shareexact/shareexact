import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function Badge({
  className,
  tone = "neutral",
  children,
}: {
  className?: string;
  tone?: "neutral" | "up" | "down" | "night" | "open";
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium tracking-wide uppercase",
        tone === "neutral" && "bg-muted/40 text-muted-foreground",
        tone === "up" && "bg-up/15 text-up",
        tone === "down" && "bg-down/15 text-down",
        tone === "night" && "bg-primary/15 text-primary",
        tone === "open" && "bg-up/15 text-up",
        className,
      )}
    >
      {children}
    </span>
  );
}
