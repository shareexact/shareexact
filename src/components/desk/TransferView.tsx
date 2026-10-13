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
  ApprovalPendingError,
  EXACT_TRANSFER_ADDRESS,
  PreflightError,
  ROUTE_LABEL,
  ShortfallError,
  TransactionRevertedError,
  explorerTxUrl,
  preflightTransfer,
  sendExactTransfer,
  type Preflight,
  type SendPhase,
  type SendResult,
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
 * What the send is doing right now.
 *
 * Spelled out rather than reduced to a spinner, because the two waits have
 * different consequences: during the first nothing has been transferred and the
 * transfer has not even been built yet, and a user who closes the tab there has
 * left an allowance behind and nothing else.
 */
const PHASE_TEXT: Record<SendPhase["kind"], string> = {
  approving: "Waiting for you to approve ExactTransfer for exactly this amount…",
  "approval-submitted":
    "Approval submitted. Waiting for it to confirm — the transfer is not built until the allowance exists on chain.",
  "approval-confirmed": "Approval confirmed. Checking the allowance the chain actually holds…",
  signing: "Waiting for you to sign the transfer…",
  submitted: "Transfer submitted. Waiting for the receipt before reporting any numbers.",
  confirmed: "Receipt in hand.",
  "timed-out": "No receipt yet. Nothing is proven either way.",
};

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
   * What the chain said, and where the send currently is.
   *
   * These are separate from `pre` on purpose. `pre` is a prediction; `result` is
   * a receipt. The screen used to print the prediction under the heading "shares
   * that leave" the moment a hash came back, which is the one kind of claim this
   * product exists to refuse.
   */
  const [result, setResult] = useState<SendResult | null>(null);
  const [phase, setPhase] = useState<SendPhase | null>(null);
  /**
   * Explicit consent to floor-rounding loss.
   *
   * A checkbox rather than a warning paragraph, because the send path now
   * rejects any shortfall the caller has not named. Reset whenever the amount
   * or the asset changes, so consent is always to the loss currently on screen
   * and never to a previous one.
   */
  const [acceptShortfall, setAcceptShortfall] = useState(false);

  // Consent, and the receipt on screen, both belong to one specific amount. Edit
  // the amount and the previous settlement is no longer describing what the
  // screen now says, so it goes.
  useEffect(() => {
    setAcceptShortfall(false);
    setResult(null);
    setPhase(null);
    setNote(null);
    setTxHash(null);
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
  const settled = result?.settled ?? null;
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
    setResult(null);
    setPhase(null);
    try {
      const sent = await sendExactTransfer(provider, {
        token: stock.contract,
        from: address,
        to: recipient,
        amount,
        // Consent is passed as a number, not as a boolean: the send path checks
        // the loss it is about to cause against the loss the user saw.
        maxShortfall: acceptShortfall ? pre.shortfall : 0n,
        // The call now waits for two receipts, which takes as long as the chain
        // takes. Phases arrive as they happen so the hash is on screen and
        // clickable while it waits, rather than the button simply hanging.
        onPhase: (next) => {
          setPhase(next);
          if (next.kind === "submitted") setTxHash(next.hash);
        },
      });
      setResult(sent);
      setTxHash(sent.hash);
      setNote(
        sent.status === "pending"
          ? sent.pendingReason === "no-event"
            ? "The transaction confirmed, but its receipt carried no settlement event this desk could read, so no amount is proven here. Open it on the explorer."
            : "Submitted, but no receipt arrived in time. That is neither a failure nor a success — open it on the explorer to see how it ends."
          : sent.settled?.source === "event"
            ? "Confirmed. The numbers below are decoded from the ExactShareTransfer event the contract wrote after re-reading the multiplier inside the transaction."
            : "Confirmed. The receipt proves how many raw units moved; a plain ERC-20 transfer never named a share count, so none can be read back. That gap is what ExactTransfer closes.",
      );
      addActivity({
        symbol: stock.symbol,
        uiShares: formatFixedToDecimalString(sent.settled?.delivered ?? sent.estimate.delivered),
        raw: formatFixedToDecimalString(sent.settled?.raw ?? sent.estimate.raw),
        multiplier: formatMultiplierDisplay(sent.settled?.multiplier ?? sent.estimate.multiplier),
        note: `to ${shortAddr(recipient)} · ${sent.status === "confirmed" ? "confirmed" : "pending"}`,
        // Hash and route travel as their own fields so the activity row can
        // render a real explorer link. A hash printed as plain text is the one
        // number in this product a reviewer cannot check.
        hash: sent.hash,
        route: sent.route,
      });
      void runPreflight();
    } catch (err) {
      // A revert and a stranded approval both produced a transaction the user
      // signed. Keeping the hash means they can go and look at it.
      if (err instanceof TransactionRevertedError || err instanceof ApprovalPendingError) {
        setTxHash(err.hash);
      }
      const message =
        err instanceof ShortfallError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Transaction rejected.";
      setNote(message.length > 240 ? `${message.slice(0, 240)}…` : message);
      void runPreflight();
    } finally {
      setPhase(null);
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
                {settled?.delivered != null
                  ? formatFixedToDecimalString(settled.delivered)
                  : pre
                    ? formatFixedToDecimalString(pre.delivered)
                    : dry
                      ? amount
                      : "—"}
              </p>
              {/* The caption changes tense because the provenance changes. Before
                  the receipt this is arithmetic; after it, it is a fact read out
                  of the chain's own log. */}
              <p className="mt-1 text-[11px] text-muted-foreground">
                {settled?.delivered != null ? "shares that left · from the event" : "shares that leave"}
              </p>
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

          {phase && (
            <p className="mt-4 text-sm text-muted-foreground">{PHASE_TEXT[phase.kind]}</p>
          )}

          {settled && (
            <div className="mt-5 rounded-md border border-border p-3">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {settled.source === "event" ? "Settled · chain event" : "Settled · ERC-20 log"}
              </p>
              <dl className="mt-3 space-y-2 text-sm">
                <Row k="Raw units moved" v={formatFixedToDecimalString(settled.raw)} />
                <Row
                  k="Shares delivered"
                  v={
                    settled.delivered != null
                      ? formatFixedToDecimalString(settled.delivered)
                      : "not provable from this receipt"
                  }
                />
                {settled.multiplier != null && (
                  <Row
                    k="Multiplier at execution"
                    v={formatMultiplierDisplay(settled.multiplier)}
                  />
                )}
                {settled.shortfall != null && settled.shortfall > 0n && (
                  <Row k="Shortfall accepted (wei)" v={String(settled.maxShortfall ?? 0n)} />
                )}
                {settled.blockNumber != null && <Row k="Block" v={String(settled.blockNumber)} />}
                {settled.gasUsed != null && <Row k="Gas used" v={String(settled.gasUsed)} />}
              </dl>
            </div>
          )}

          {/* Normally empty. When it is not, the multiplier moved between the
              preview and the block — the exact race this project is about — and
              the screen says so instead of quietly showing the newer number. */}
          {result?.mismatch.map((line) => (
            <p key={line} className="mt-3 text-sm text-down">
              {line}
            </p>
          ))}

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
