import { useEffect, useState } from "react";
import { COPY, isRtl, type Lang } from "@/lib/copy";
import { loadProfile, profileInitial, saveProfile, type DeskProfile } from "@/lib/profile";
import { APP_VERSION } from "@/lib/version";
import { shortAddr } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { MarketSession } from "@/lib/session";

export interface DeskBarProps {
  lang: Lang;
  session: MarketSession;
  registryCount: number;
  healthLabel: string;
  healthTone: "open" | "night" | "down";
  wallet: { address: string; name: string } | null;
  status: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
}

export function DeskBar({
  lang,
  session,
  registryCount,
  healthLabel,
  healthTone,
  wallet,
  status,
  onConnect,
  onDisconnect,
  onRefresh,
}: DeskBarProps) {
  const t = COPY[lang];
  const rtl = isRtl(lang);
  const [profile, setProfile] = useState<DeskProfile>(() =>
    typeof window === "undefined" ? { name: "", handle: "", motto: "" } : loadProfile(),
  );
  const [open, setOpen] = useState<"profile" | "wallet" | null>(null);
  const [draft, setDraft] = useState<DeskProfile>(profile);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setProfile(loadProfile());
  }, []);

  function persist() {
    const next = saveProfile(draft);
    setProfile(next);
    setOpen(null);
  }

  const display = profile.name || t.defaultDesk;
  const handle = profile.handle ? `@${profile.handle}` : null;

  return (
    <div className="sticky top-0 z-40 border-b border-border bg-bg/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-2.5 md:px-6">
        <img src="/logo.svg" alt="ShareExact" width={32} height={32} className="size-8 shrink-0" />
        <button
          type="button"
          onClick={() => {
            setDraft(profile);
            setOpen(open === "profile" ? null : "profile");
          }}
          className="flex min-w-0 items-center gap-2 text-start"
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-md border border-border bg-card text-[10px] font-semibold text-muted-foreground">
            {profileInitial(profile)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight">
              {display}
              <span className="ms-2 font-mono text-[10px] font-medium text-primary">v{APP_VERSION}</span>
            </p>
            <p className="truncate font-mono text-[10px] text-muted-foreground">
              {handle ? `${handle} · ` : ""}
              {t.chain}
            </p>
          </div>
        </button>

        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <Badge tone={session.isNightDesk ? "night" : "open"}>
            {rtl ? session.labelFa : session.label}
          </Badge>
          <span className="font-mono text-[11px] text-muted-foreground">
            {session.nyTime} ET
          </span>
          {registryCount > 0 && (
            <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">
              {registryCount} {t.registryLive}
            </span>
          )}
          <Badge tone={healthTone}>{healthLabel}</Badge>
        </div>

        <div className="ms-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setDraft(profile);
              setOpen(open === "profile" ? null : "profile");
            }}
            className="hidden h-9 items-center rounded-md border border-border bg-card px-3 text-xs sm:inline-flex"
          >
            {t.profile}
          </button>

          {wallet ? (
            <button
              type="button"
              onClick={() => setOpen(open === "wallet" ? null : "wallet")}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-border bg-card px-3"
            >
              <span className="size-1.5 rounded-full bg-up" />
              <span className="text-xs font-medium">{wallet.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{shortAddr(wallet.address)}</span>
            </button>
          ) : (
            <Button size="sm" onClick={onConnect}>
              {t.connect}
            </Button>
          )}
        </div>
      </div>

      {profile.motto && (
        <p className="mx-auto max-w-6xl truncate px-4 pb-2 text-[11px] text-muted-foreground md:px-6">
          {profile.motto}
        </p>
      )}

      {open === "profile" && (
        <div className="border-t border-border bg-surface">
          <form
            className="mx-auto grid max-w-6xl gap-3 px-4 py-4 md:grid-cols-3 md:px-6"
            onSubmit={(e) => {
              e.preventDefault();
              persist();
            }}
          >
            <label className="block text-xs text-muted-foreground">
              {t.deskName}
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                maxLength={40}
                className="mt-1 h-10 w-full rounded-md border border-border bg-bg px-3 text-sm text-foreground"
              />
            </label>
            <label className="block text-xs text-muted-foreground">
              {t.handle}
              <input
                value={draft.handle}
                onChange={(e) => setDraft({ ...draft, handle: e.target.value })}
                maxLength={24}
                className="mt-1 h-10 w-full rounded-md border border-border bg-bg px-3 text-sm text-foreground"
              />
            </label>
            <label className="block text-xs text-muted-foreground md:col-span-1">
              {t.motto}
              <input
                value={draft.motto}
                onChange={(e) => setDraft({ ...draft, motto: e.target.value })}
                maxLength={80}
                className="mt-1 h-10 w-full rounded-md border border-border bg-bg px-3 text-sm text-foreground"
              />
            </label>
            <div className="flex items-end gap-2 md:col-span-3">
              <Button size="sm" type="submit">
                {t.saveProfile}
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setOpen(null)}>
                {t.close}
              </Button>
            </div>
          </form>
        </div>
      )}

      {open === "wallet" && wallet && (
        <div className="border-t border-border bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3 md:px-6">
            <span className="text-xs text-muted-foreground">{t.connected}</span>
            <span className="font-mono text-xs">{wallet.address}</span>
            {status && <span className="text-xs text-muted-foreground">{status}</span>}
            <div className="ms-auto flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="secondary"
                type="button"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(wallet.address);
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1500);
                  } catch {
                    /* ignore */
                  }
                }}
              >
                {copied ? "✓" : t.copyAddress}
              </Button>
              <Button size="sm" variant="secondary" type="button" onClick={onRefresh}>
                {t.refreshBook}
              </Button>
              <Button size="sm" variant="secondary" type="button" onClick={onDisconnect}>
                {t.disconnect}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
