# Domain and hosting

A hackathon judge follows a link before they clone a repository. The link is the
product for the first thirty seconds, so it is worth the forty minutes.

I cannot register a domain or deploy a host for you — that needs a card and an
account. Everything below is the part that can be prepared in advance, plus the
decisions worth making deliberately rather than at 2am before the deadline.

---

## 1. The name

`shareexact` is the right root. It says what the product does, it is one word,
and it survives being read aloud in a demo.

Order of preference:

| Domain | Why |
| --- | --- |
| `shareexact.com` | First choice if free. `.com` still reads as "a company" to everyone over thirty, including investors |
| `shareexact.xyz` | Crypto-native, cheap, nobody in this audience blinks at it |
| `shareexact.dev` | Signals infrastructure rather than app, which matches the actual positioning. Forced HTTPS on the TLD, which is a small bonus |
| `shareexact.io` | Expensive for what it is and the association has faded. Only if the first three are gone |

Avoid hyphens, avoid `getshareexact`, avoid `shareexactapp`. Each one costs a
syllable in a demo and a beat of confusion in a URL read over a call.

Check availability at any registrar's search — Cloudflare Registrar sells at
cost with no first-year bait pricing and no upsell flow, which makes it the
least annoying option. Namecheap and Porkbun are fine alternatives.

Buy the one you want plus nothing else. Defensive registrations are a later
problem.

---

## 2. Hosting

The app is TanStack Start on Vite, which deploys as-is to Vercel, Netlify or
Cloudflare Pages. Vercel has the shortest path from this repository:

```bash
npm i -g vercel
vercel link
vercel --prod
```

Environment variables to set in the dashboard before the first production
deploy — the same names the README documents:

| Variable | Value |
| --- | --- |
| `ROBINHOOD_RPC_URL` | A dedicated endpoint. The public one is a demo fallback and will rate-limit you during a demo, which is the worst possible time |
| `ROBINHOOD_FEEDS` | The JSON feed map from `docs/DEPLOY.md` step 3 |
| `ROBINHOOD_SEQUENCER_FEED` | Chainlink L2 uptime feed, if you registered one |
| `VITE_EXACT_TRANSFER` | The deployed helper, so production runs guarded settlement |
| `XAI_API_KEY` | Only if you want the AI brief live. The desk works without it |

Then point the domain at the deployment and let the certificate issue before you
need it. Do this the day before, not the hour before.

---

## 3. Before it is public

**Geo-restrict.** Stock Tokens are Regulation S instruments not offered to US
persons, and the README says so. A public site with no restriction contradicts
its own documentation, which is precisely the class of gap this project has been
fixing for three review rounds. A front-end block plus a short notice is the
minimum; it is not legal advice and it is not a substitute for counsel.

**Say what it is.** The landing state should make three things obvious inside
five seconds: what breaks without this, that the contracts are live and
verified, and where the code is. The $30,000 overshoot line from the README is
the opening sentence — it does more work than any amount of architecture prose.

**Link the proof.** Contract addresses and the proof transaction, as links, above
the fold. A reviewer who has to search for them assumes they do not exist.

**Check the preview card.** `public/og.jpg` already exists; make sure it says
something useful, because it is what appears when the link is pasted into a
judging channel or a group chat.

---

## 4. What not to do

Do not put the desk behind a waitlist or an email gate. Do not add analytics
that block first paint. Do not launch a marketing page separate from the app —
one URL, the desk opens on Transfer, and the argument is the product working.

---

## Checklist

- [ ] Domain registered
- [ ] DNS pointed at the host, certificate issued and confirmed in a browser
- [ ] All environment variables set in production, including `VITE_EXACT_TRANSFER`
- [ ] Production site loads the registry and shows live Chainlink prices, not
      "indicative"
- [ ] Transfer badge reads "Exact settlement"
- [ ] Contract addresses and proof transaction linked above the fold
- [ ] Geo-restriction in place
- [ ] Open Graph image and title checked by pasting the link into a chat
- [ ] URL added to `SUBMISSION.md` and to the hackathon form
