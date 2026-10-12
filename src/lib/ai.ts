import { WRITE_LANG, type Lang } from "./copy";
import { buildLocalAsset, buildLocalBrief, buildLocalThesis } from "./desk-engine";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { authMiddleware } from "./auth/middleware";
import { AI_LIMITS, consumeQuota } from "./ai-limits";

/**
 * Every free-text field reaching the model is bounded.
 *
 * These endpoints spend a third-party API budget, so an unbounded string is not
 * merely untidy: it is a lever for turning one HTTP request into an expensive
 * one. Numeric fields are bounded too — a NaN or an Infinity would be rendered
 * straight into the prompt.
 */
const shortText = z.string().max(AI_LIMITS.short);
const finiteNumber = z.number().finite();

const holdingSchema = z.object({
  symbol: shortText,
  shares: finiteNumber,
  cost: finiteNumber,
  price: finiteNumber,
  change1d: finiteNumber,
  afterHours: finiteNumber,
  multiplier: shortText,
  sector: shortText,
});

const sessionSchema = z.object({
  kind: shortText,
  label: z.string().max(AI_LIMITS.label),
  nyTime: shortText,
  nyDate: shortText,
  detail: z.string().max(AI_LIMITS.label),
});

const langSchema = z.string().max(8);
const thesisSchema = z.string().max(AI_LIMITS.thesis);

/**
 * Rate-limit key.
 *
 * `authMiddleware` supplies a verified user id when auth is on. When it is off
 * the middleware resolves a shared development user, so every caller collapses
 * onto one bucket — which is the correct conservative behaviour for a public
 * demo: the whole deployment shares one budget instead of each anonymous
 * caller getting their own.
 */
function quotaKey(userId: unknown): string {
  return typeof userId === "string" && userId.length > 0 ? `user:${userId}` : "anonymous";
}

type GrokResult = { ok: true; json: string } | { ok: false; error: string };

function asLang(lang: string): Lang {
  return lang in WRITE_LANG ? (lang as Lang) : "en";
}

function writeLine(lang: string) {
  return WRITE_LANG[asLang(lang)];
}

async function grokJson(system: string, user: string, maxTokens = 1400): Promise<GrokResult> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return { ok: false, error: "NO_KEY" };

  const res = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "grok-4.5",
      temperature: 0.3,
      max_tokens: maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) return { ok: false, error: `xAI API error ${res.status}` };
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = body.choices?.[0]?.message?.content ?? "";
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return { ok: false, error: "Could not parse model output" };
  try {
    JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, error: "Could not parse model output" };
  }
  return { ok: true, json: text.slice(start, end + 1) };
}

const DESK_SYSTEM = `You are the ShareExact desk analyst for Robinhood Chain (Ethereum L2, chain ID 4663).
You advise holders of Robinhood Stock Tokens — tokenized debt securities tracking US equities, tradeable 24/7, unavailable to US/UK/CA persons.
Rules:
- Return ONLY valid JSON matching the schema in the user message. No markdown.
- Be specific to the names and weights you were given. No generic "diversify" filler.
- Always consider: cash-session vs after-hours, weekend oracle staleness (Chainlink is 24/5 not 24/7), ERC-8056 uiMultiplier (CRWD is 4× — sending displayed "1" as raw moves 4 shares), concentration, earnings/calendar, and whether a name still matches the holder's thesis.
- Stance values MUST be one of: hold, trim, add, replace.
- Not financial advice; phrase as desk notes, not orders.
- Prefer AVGO/MSFT/GOOGL as NVDA complements, SPY/QQQ as ballast, CRWD only with the multiplier warning.`;

export const runDeskBrief = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: unknown) =>
      z
        .object({
          kind: z.enum(["daily", "weekly"]),
          lang: langSchema,
          thesis: thesisSchema,
          session: sessionSchema,
          holdings: z.array(holdingSchema).max(AI_LIMITS.holdings),
        })
        .parse(input),
  )
  .handler(async ({ data, context }): Promise<GrokResult> => {
    consumeQuota(quotaKey((context as { userId?: string } | undefined)?.userId));
    const schema =
      data.kind === "weekly"
        ? `{
  "headline": string,
  "sessionNote": string,
  "oneLiner": string,
  "bias": "constructive"|"cautious"|"mixed",
  "holdings": [{"symbol": string, "stance": "hold"|"trim"|"add"|"replace", "note": string, "replaceWith": string|optional}],
  "risks": string[],
  "watchTonight": string,
  "replacements": [{"from": string, "to": string, "why": string}],
  "calendar": [{"when": string, "event": string, "symbols": string}]
}`
        : `{
  "headline": string,
  "sessionNote": string,
  "oneLiner": string,
  "bias": "constructive"|"cautious"|"mixed",
  "holdings": [{"symbol": string, "stance": "hold"|"trim"|"add"|"replace", "note": string, "replaceWith": string|optional}],
  "risks": string[],
  "watchTonight": string
}`;

    const langLine = writeLine(data.lang);

    const live = await grokJson(
      DESK_SYSTEM,
      `${langLine}
Kind: ${data.kind}
Now: ${data.session.nyDate} ${data.session.nyTime} ET — ${data.session.label}. ${data.session.detail}
Holder thesis: ${data.thesis || "(none stated)"}
Book:
${JSON.stringify(data.holdings, null, 2)}

Return JSON: ${schema}`,
      data.kind === "weekly" ? 1800 : 1200,
    );
    if (live.ok) return live;
    const local = buildLocalBrief({
      kind: data.kind,
      lang: asLang(data.lang),
      thesis: data.thesis,
      session: data.session,
      holdings: data.holdings.map((h) => ({ symbol: h.symbol, shares: h.shares, cost: h.cost })),
    });
    return { ok: true, json: JSON.stringify(local) };
  });

export const runAssetAnalysis = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: unknown) =>
      z
        .object({
          lang: langSchema,
          thesis: thesisSchema,
          session: sessionSchema,
          symbol: shortText,
          name: shortText,
          sector: z.string(),
          about: z.string().max(AI_LIMITS.about),
          price: z.number(),
          change1d: z.number(),
          afterHours: z.number(),
          multiplier: z.string(),
          shares: z.number(),
          cost: z.number(),
          bookWeight: z.number(),
        })
        .parse(input),
  )
  .handler(async ({ data, context }): Promise<GrokResult> => {
    consumeQuota(quotaKey((context as { userId?: string } | undefined)?.userId));
    const langLine = writeLine(data.lang);
    const live = await grokJson(
      DESK_SYSTEM,
      `${langLine}
Analyze ONE name in the book. Cover: cash vs after-hours, earnings/regulation/competition, concentration in this book, ERC-8056 multiplier trap if relevant, and whether to hold/trim/add/replace given the thesis.

Name: ${data.symbol} ${data.name} (${data.sector})
${data.about}
Price ${data.price}, session ${data.change1d}%, after-hours ${data.afterHours}%, multiplier ${data.multiplier}
Position: ${data.shares} shares at cost ${data.cost}, book weight ${data.bookWeight}%
Thesis: ${data.thesis || "(none)"}
Session: ${data.session.label} ${data.session.nyDate} ${data.session.nyTime} ET

Return JSON:
{
  "stance": "hold"|"trim"|"add"|"replace",
  "summary": string,
  "angles": [{"title": string, "body": string}, {"title": string, "body": string}, {"title": string, "body": string}],
  "replaceWith": {"symbol": string, "why": string} | null,
  "afterHours": string
}`,
      900,
    );
    if (live.ok) return live;
    const local = buildLocalAsset({
      lang: asLang(data.lang),
      thesis: data.thesis,
      session: data.session,
      symbol: data.symbol,
      holdings: [{ symbol: data.symbol, shares: data.shares, cost: data.cost }],
    });
    return { ok: true, json: JSON.stringify(local) };
  });

export const runThesisBasket = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator(
    (input: unknown) =>
      z
        .object({
          lang: langSchema,
          thesis: z.string().min(8).max(AI_LIMITS.thesis),
          session: sessionSchema,
          available: z.array(shortText).max(AI_LIMITS.symbols),
        })
        .parse(input),
  )
  .handler(async ({ data, context }): Promise<GrokResult> => {
    consumeQuota(quotaKey((context as { userId?: string } | undefined)?.userId));
    const langLine = writeLine(data.lang);
    const live = await grokJson(
      DESK_SYSTEM,
      `${langLine}
Compose a Stock Token basket on Robinhood Chain for this thesis. Use ONLY these tickers: ${data.available.join(", ")}.
Weights must sum to 100. 3–6 names. No single name above 40% unless the thesis demands it, and then say so.
Include an after-hours note (what this book does when NYSE is closed).

Thesis: ${data.thesis}
Session: ${data.session.label} ${data.session.nyDate} ${data.session.nyTime} ET

Return JSON:
{
  "restated": string,
  "basket": [{"symbol": string, "weight": number, "role": string, "reason": string}],
  "afterHoursNote": string,
  "risks": string[]
}`,
      900,
    );
    if (live.ok) return live;
    const local = buildLocalThesis({
      lang: asLang(data.lang),
      thesis: data.thesis,
      available: data.available,
    });
    return { ok: true, json: JSON.stringify(local) };
  });
