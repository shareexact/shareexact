import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { COPY } from "@/lib/copy";
import {
  formatFixedToDecimalString,
  formatMultiplierDisplay,
  maxUiFromRaw,
  parseMultiplier,
} from "@/lib/conversion";
import {
  EXACT_TRANSFER_ADDRESS,
  PreflightError,
  ROUTE_LABEL,
  ShortfallError,
  explorerTxUrl,
  preflightTransfer,
  sendExactTransfer,
  type Preflight,
} from "@/lib/exact-transfer";
import { displayedShares, STOCKS, getStock } from "@/lib/stocks";
import { useDesk } from "@/lib/store";
import { shortAddr } from "@/lib/utils";
import type { EthereumProvider } from "@/lib/wallet";

interface Props {
  provider?: EthereumProvider | null;
  address?: string | null;
}

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const WAD = 10n ** 18n;

/**
 * The one screen where ShareExact stops describing the problem and does
 * something about it.
 *
 * Connected, it reads the multiplier, the pending multiplier and the raw
 * balance straight from the token through the user's own wallet, shows exactly
 * what will move, and signs it. Disconnected, it falls back to a dry preview
 * against the registry multiplier and says so rather than pretending.
 */
export function TransferView({ provider, address }: Props) {
  const lang = useDesk((s) => s.lang);
  const t = COPY[lang];
  const holdings = useDesk((s) => s.holdings);
  const addActivity = useDesk((s) => s.addActivity);

  const [symbol, setSymbol] = useState("CRWD");
  const [amount, setAmount] = useState("1");
  const [to, setTo] = useState("");
  const [pre, setPre] = useState<Preflight | null>(null);
  const [preError, setPreError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  /**
   * Explicit consent to floor-rounding loss.
   *
   * A checkbox rather than a warning paragraph, because the send path now
   * rejects any shortfall the caller has not named. Reset whenever the amount
   * or the asset changes, so consent is always to the loss currently on screen
   * and never to a previous one.
   */
  const [acceptShortfall, setAcceptShortfall] = useState(false);

  useEffect(() => {
    setAcceptShortfall(false);
  }, [amount, symbol]);

  const stock = getStock(symbol) ?? STOCKS[0];
  const connected = Boolean(provider && address);
  const registryMultiplier = parseMultiplier(stock.multiplier);

  const runPreflight = useCallback(async () => {
    if (!provider || !address) {
      setPre(null);
      setPreError(null);
      return;
    }
    try {
      setPreError(null);
      const result = await preflightTransfer(provider, {
        token: stock.contract,
        holder: address,
        amount,
      });
      setPre(result);
    } catch (err) {
      setPre(null);
      setPreError(err instanceof PreflightError ? err.message : "Could not read the token on chain.");
    }
  }, [provider, address, stock.contract, amount]);

  useEffect(() => {
    const id = window.setTimeout(() => void runPreflight(), 250);
    return () => window.clearTimeout(id);
  }, [runPreflight]);

  /** Offline mirror of the on-chain math, used only when no wallet is connected. */
  const dry = useMemo(() => {
    const parsed = amount.trim();
    if (!/^\d*\.?\d*$/.test(parsed) || parsed === "" || parsed === ".") return null;
    try {
      const [w, f = ""] = parsed.split(".");
      const uiShares = BigInt(`${w || "0"}${(f + "0".repeat(18)).slice(0, 18)}`);
      return {
        uiShares,
        raw: (uiShares * WAD) / registryMultiplier,
        naiveShares: (uiShares * registryMultiplier) / WAD,
      };
    } catch {
      return null;
    }
  }, [amount, registryMultiplier]);

  const multiplierInUse = pre?.multiplier ?? registryMultiplier;
  const isTrap = multiplierInUse !== WAD;
  const toTrimmed = to.trim();
  const sendingToSelf = toTrimmed.length === 0;
  const recipientValid = sendingToSelf || ADDRESS.test(toTrimmed);
  const recipient = sendingToSelf ? address ?? "" : toTrimmed;
  const shortfall = pre?.shortfall ?? 0n;
  const shortfallCleared = shortfall === 0n || acceptShortfall;
  const canSend =
    connected &&
    Boolean(recipient) &&
    pre !== null &&
    pre.fits &&
    pre.blockers.length === 0 &&
    recipientValid &&
    shortfallCleared &&
    !busy;

  const blockedWhy = !connected
    ? null
    : !pre
      ? t.readingToken
      : pre.blockers[0]
        ? pre.blockers[0]
        : !pre.fits
          ? t.insufficientRaw
          : !recipientValid
            ? t.badRecipient
            : !shortfallCleared
              ? t.acceptLoss
              : null;

  function fillMax() {
    if (pre) {
      setAmount(maxUiFromRaw(pre.rawBalance, pre.multiplier));
      return;
    }
    const shares = displayedShares(holdings.find((h) => h.symbol === symbol) ?? { symbol, shares: 1, cost: 0 });
    setAmount(String(shares));
  }

  async function send() {
    if (!provider || !address || !pre) return;
    setBusy(true);
    setNote(null);
    setTxHash(null);
    try {
      const result = await sendExactTransfer(provider, {
        token: stock.contract,
        from: address,
        to: recipient,
        amount,
        // Consent is passed as a number, not as a boolean: the send path checks
        // the loss it is about to cause against the loss the user saw.
        maxShortfall: acceptShortfall ? pre.shortfall : 0n,
      });
      setTxHash(result.hash);
      setNote(
        result.route === "guarded"
          ? "Signed through ExactTransfer: the multiplier was re-read inside the transaction, so the share count is exact by construction."
          : "Signed as a direct ERC-20 transfer of a raw amount computed from a multiplier read seconds earlier. Exact settlement needs ExactTransfer deployed.",
      );
      addActivity({
        symbol: stock.symbol,
        uiShares: formatFixedToDecimalString(pre.delivered),
        raw: formatFixedToDecimalString(result.raw),
        multiplier: formatMultiplierDisplay(pre.multiplier),
        note: `to ${shortAddr(recipient)}`,
        // Hash and route travel as their own fields so the activity row can
        // render a real explorer link. A hash printed as plain text is the one
        // number in this product a reviewer cannot check.
        hash: result.hash,
        route: result.route,
      });
      void runPreflight();
    } catch (err) {
      const message =
        err instanceof ShortfallError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Transaction rejected.";
      setNote(message.length > 200 ? `${message.slice(0, 200)}…` : message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">{t.transferIntro}</p>

      <div className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-xl bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">{t.instruction}</p>
            <Badge tone={connected ? (EXACT_TRANSFER_ADDRESS ? "open" : "night") : "neutral"}>
              {connected
                ? ROUTE_LABEL[EXACT_TRANSFER_ADDRESS ? "guarded" : "preflight"].title
                : "preview only"}
            </Badge>
          </div>

          <label className="mb-4 block">
            <span className="mb-1 block text-xs text-muted-foreground">Asset</span>
            <select
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              className="h-11 w-full rounded-md border border-border bg-bg px-3 text-sm"
            >
              {STOCKS.map((s) => (
                <option key={s.symbol} value={s.symbol}>
                  {s.symbol} · {s.name}
                </option>
              ))}
            </select>
          </label>

          <p className="mb-4 font-mono text-xs text-muted-foreground">{shortAddr(stock.contract)}</p>

          {connected && (
            <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
              {ROUTE_LABEL[EXACT_TRANSFER_ADDRESS ? "guarded" : "preflight"].detail}
            </p>
          )}

          <label className="mb-4 block">
            <span className="mb-1 block text-xs text-muted-foreground">{t.amount}</span>
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              className="tabular h-11 w-full rounded-md border border-border bg-bg px-3 font-mono text-sm"
            />
          </label>

          <label className="mb-4 block">
            <span className="mb-1 block text-xs text-muted-foreground">{t.recipient}</span>
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="0x…"
              className="h-11 w-full rounded-md border border-border bg-bg px-3 font-mono text-sm"
            />
            {to.length > 0 && !recipientValid && (
              <span className="mt-1 block text-xs text-down">Not a valid 20-byte address.</span>
            )}
            {sendingToSelf && address && (
              <span className="mt-1 block font-mono text-[11px] text-muted-foreground">
                {t.blankSelf} {shortAddr(address)}
              </span>
            )}
          </label>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" type="button" onClick={fillMax}>
              {t.max}
            </Button>
            <Button type="button" onClick={() => void send()} disabled={!canSend}>
              {busy ? "…" : connected ? t.sendExact : t.sendDemo}
            </Button>
          </div>
          {connected && !canSend && blockedWhy && (
            <p className="mt-3 text-xs text-muted-foreground">{blockedWhy}</p>
          )}

          {!connected && <p className="mt-4 text-sm text-muted-foreground">{t.pickWalletBody}</p>}

          {preError && <p className="mt-4 text-sm text-down">{preError}</p>}

          {pre?.blockers.map((blocker) => (
            <p key={blocker} className="mt-3 text-sm text-down">
              {blocker}
            </p>
          ))}
          {shortfall > 0n && (
            <label className="mt-4 flex items-start gap-2 rounded-md border border-down/40 bg-down/5 p-3 text-sm">
              <input
                type="checkbox"
                checked={acceptShortfall}
                onChange={(e) => setAcceptShortfall(e.target.checked)}
                className="mt-0.5"
              />
              <span>{t.acceptShortfall.replace("{n}", shortfall.toString())}</span>
            </label>
          )}

          {pre?.warnings.map((warning) => (
            <p key={warning} className="mt-3 text-sm text-muted-foreground">
              {warning}
            </p>
          ))}
        </article>

        <article className="rounded-xl border border-border p-5">
          <p className="mb-4 text-xs uppercase tracking-wide text-muted-foreground">{t.whatWillMove}</p>

          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <div>
              <p className="text-xs text-muted-foreground">{t.trapTitle}</p>
              <p className="tabular mt-1 font-mono text-lg">
                {pre
                  ? formatFixedToDecimalString(pre.naiveShares)
                  : dry
                    ? formatFixedToDecimalString(dry.naiveShares)
                    : "—"}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">shares that would leave</p>
            </div>
            <span className="text-muted-foreground">→</span>
            <div>
              <p className="text-xs text-muted-foreground">{t.exactTitle}</p>
              <p className="tabular mt-1 font-mono text-lg text-primary">
                {pre ? formatFixedToDecimalString(pre.delivered) : dry ? amount : "—"}
              </p>
              <p className="mt-1 text-[11px] text-muted-foreground">shares that leave</p>
            </div>
          </div>

          <dl className="mt-5 space-y-2 text-sm">
            <Row k="Shares requested" v={amount || "—"} />
            <Row
              k="Raw units to move"
              v={
                pre
                  ? formatFixedToDecimalString(pre.raw)
                  : dry
                    ? formatFixedToDecimalString(dry.raw)
                    : "—"
              }
            />
            <Row k={t.multiplier} v={formatMultiplierDisplay(multiplierInUse)} />
            <Row k="Multiplier source" v={pre ? "live · token contract" : "registry snapshot"} />
            {pre && <Row k="Wallet raw balance" v={formatFixedToDecimalString(pre.rawBalance)} />}
            {pre && <Row k="Fits balance" v={pre.fits ? "PASS" : "REJECT"} />}
            {pre && pre.shortfall > 0n && <Row k="Rounding shortfall (wei)" v={String(pre.shortfall)} />}
            {pre?.pendingMultiplier != null && pre.pendingMultiplier !== pre.multiplier && (
              <Row
                k="Pending multiplier"
                v={`${formatMultiplierDisplay(pre.pendingMultiplier)} @ ${
                  pre.effectiveAt ? new Date(pre.effectiveAt * 1000).toISOString().slice(0, 16) : "—"
                }`}
              />
            )}
          </dl>

          {isTrap && (
            <p className="mt-4 text-sm text-down">
              {`This token's multiplier is ${formatFixedToDecimalString(multiplierInUse)}. Sending a typed "1" as raw units moves ${formatFixedToDecimalString(multiplierInUse)} shares, not one.`}
            </p>
          )}

          {note && <p className="mt-4 text-sm text-muted-foreground">{note}</p>}
          {txHash && (
            <a
              href={explorerTxUrl(txHash)}
              target="_blank"
              rel="noreferrer"
              className="mt-2 block font-mono text-xs text-primary underline"
            >
              {shortAddr(txHash)} ↗
            </a>
          )}
        </article>
      </div>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="tabular font-mono text-xs">{v}</dd>
    </div>
  );
}
