# ShopBridge: Hackathon Winning Strategy and Audit

**Event:** Nexconn Build Challenge 2026, Marketplace & Support track
**Audit date:** 2026-11-06
**Scope:** Whole repository, production Neon data (read-only), the installed Nexconn SDK typings, and the official Nexconn docs
**Status:** Audit only. No application code, data, dependencies or deployments were changed.

---

## 0. How this audit was done (evidence base)

| Check | Result |
|---|---|
| `tsc --noEmit` | ✅ Pass, 0 errors |
| `vite build` (built to a scratch directory so `dist/` stayed untouched) | ✅ Pass. One JS chunk of **1.45 MB (346 KB gzip)** |
| `npm audit --omit=dev` | ✅ 0 vulnerabilities |
| Secrets in bundle / tracked files / git history (values compared, never printed) | ✅ `NEXCONN_APP_SECRET`, `NEXCONN_APP_KEY` and `DATABASE_URL` were not found in any of them |
| Production Neon, using a **read-only transaction** (counts, latency, demo rows) | 3 users, 6 sessions, 8 products, 3 orders, 2 support requests. Round trip from this machine ≈ **74 ms** |
| Prior acceptance evidence `backups/phase41/acceptance-api.json` (2026-11-05, **JSON backend**) | 25/25 PASS. Translation and pre-join history were confirmed manually in `REPORT.md` |
| Prior Postgres evidence `backups/phase43/pg-smoke-results.json` | Neon: **"NOT CONNECTED"**. Live messaging and translation on Postgres: **"NOT RUN"** |
| Installed SDK typings `node_modules/@nexconn/chat/index.d.ts` (v26.2.1) | Read directly to confirm which APIs exist (§6) |
| Official docs `docs.nexconn.ai` (Call SDK Web, group create) | Read. Findings in §6 and §7 |
| Competition page `reskilll.com/hack/nexconn` | ⚠️ The page is a JavaScript app and its rules could not be read. **The judging weights in this document come from your brief.** One public listing gives a deadline of **22 Nov 2026**. Please confirm it |

**Not run, on purpose:** the e2e and acceptance scripts. The local `.env` points at the **production Neon database**, and those scripts create users and orders. In addition, every API call rewrites every table (see C1), so running them would change production data.

---

## 1. Executive assessment

**Bottom line:** ShopBridge has a strong idea and a good-looking UI. Its data layer, its leftover code from the earlier app, and its demo data are weak enough that judges could stop trusting it within two minutes.

**What is already competitive:**
- The thesis is clear and on-track: *"Every order has a conversation."* Each order gets one persistent Nexconn group channel, and buyer, seller and support all work in it.
- Nexconn is used for real, not as a wrapper. The server API creates channels, adds members and posts messages. The client SDK sends messages, loads history, and uses **Nexconn's built-in translation module** (`translateModule.translateMessages`). The **pre-join history** console setting is used deliberately so an agent sees what happened before they joined. Few entrants will use translation and pre-join history this well.
- The original message is always kept next to its translation.
- The visual design is a cut above typical hackathon work (editorial type, real product photography, reduced-motion support, skip link, labelled controls).
- Security basics are good: the App Secret stays on the server, sessions use HttpOnly cookies, passwords are hashed with bcrypt, input is validated on the server, roles are assigned only by the server, the reseed endpoint is blocked in production, and the git history has no secrets.

**What would lose first place today:**
1. **The production data layer rewrites the whole database on every request, including reads** (C1). Signing in, browsing the catalogue, and the support queue's poll every 4 seconds each delete and re-insert every row in every table, one after another, behind one global lock. It works for one demo user. It slows down linearly as data grows, puts every judge in one queue, and is a data-loss risk.
2. **Code from the earlier "Saathi" volunteer app shows up in the product** (C3). Sellers see order support requests labelled **"Companion visit"**. The support queue has filters for **"Groceries / Medical transport / Companion visit"** and an **"Assign a seller"** form. Buyers see **"Contact general support"**, described as *"groceries, transport, or a companion visit"*. A judge will read this as a reused project.
3. **The showcase data is test debris** (C4). The production support notes are `P393-order-support-1793873263136` and `P41-demo-order-support-…`. The chat contains `P393-support-after-join visible to all`. All three orders are the same sari, all orders are stuck at "Placed", and both cases are stuck at "assigned".
4. **The story has no ending.** A seller cannot move an order forward, and support has no resolution: no outcome, no buyer confirmation, nothing that says "resolved". The marketplace-support loop never closes.
5. **The demo accounts break under several judges at once** (C2). Each user keeps only 8 sessions, so the 9th sign-in to "Demo Buyer" signs out the oldest browser. The demo endpoint also allows only 20 sign-ins per IP per 15 minutes. Judges sharing an office network can lock each other out.
6. **The GitHub repo root has no README and contains an unrelated project** (`yousr/`, package name "masar") next to `chat app/`.

**The most memorable Nexconn moment available:** a Hindi-speaking buyer sends a **photo of the defect and a Hindi voice note or message**. The English-speaking seller reads it in English, with the original one tap away. When they cannot agree, a support agent joins **the same channel**, sees the **whole earlier history translated**, and gets a case brief built from real data. The agent proposes a resolution, the buyer confirms it in Hindi, and the order timeline in the chat shows it closed. Everything in that story is a real Nexconn feature (§6).

**Recommendation:** Spend roughly the first 40% of the remaining time on reliability and coherence (P0), 40% on closing the buyer, seller and support loop with evidence and resolution (P1), and the rest on **one** headline differentiator (voice notes with speech-to-text, or a video consult) that passes a feasibility spike first. Do not add breadth.

---

## 2. Capability verification matrix

Legend: ✅ Verified · 🟡 Partially working · ❌ Broken / missing · ❔ Unverified

| # | Capability | Status | Evidence and notes |
|---|---|---|---|
| 1 | Buyer marketplace and discovery | ✅ | Server-side search, category, price, stock and sort in `listCatalog` ([server/store-pg.ts:680](../server/store-pg.ts#L680)). Acceptance `buyer.products` passed. Every catalogue read also triggers a full DB rewrite (C1). |
| 2 | Product details, cart, checkout | ✅ | Stock is checked and decremented inside the transaction, and orders are split by seller. Payment is honestly labelled "simulated". No cancel or return flow. |
| 3 | Buyer orders and seller order management | 🟡 | Orders can be listed and viewed. **There is no endpoint to change order status.** Every order stays "Placed" (the schema allows `placed/packed/completed`, [001_init.sql](../server/db/migrations/001_init.sql)). The seller "Orders" page also shows a leftover "Requests for you" section with "Companion visit" labels ([SellerOrders.tsx:127-159](../web/src/pages/SellerOrders.tsx#L127-L159)). |
| 4 | Order-specific persistent conversations | ✅ | Channel `order{orderId}` is created at checkout, stored in `orders.channel_id`, and reused on retry. History comes from Nexconn. Access control at the channel level is weak (H1). |
| 5 | Real Nexconn messaging | ✅ | Client `GroupChannel.sendMessage` and `createMessagesQuery`. Server `/v4/group-channel/create`, `/join` and `/message/send` with a signed request. **Text only.** Unread counts come from polling, not SDK events. |
| 6 | Hindi ↔ English translation | ✅ (Console-dependent) | Uses Nexconn's `translateModule.translateMessages` and `TranslateHandler`, in batches of 10, with a 20-second timeout and a retry. Confirmed manually in phase 3.9.3. Gaps: the language preference is only in **localStorage**, so each viewer must pick a language by hand on every device. System events are not translated. The rest of the UI is English only. |
| 7 | Original kept next to translation | ✅ | Original shown with a Show/Hide toggle ([MessageItem.tsx:88-103](../web/src/conversation/MessageItem.tsx#L88-L103)). The original paragraph has no `lang` attribute, so screen readers mispronounce Hindi. |
| 8 | Order-support escalation | 🟡 | The API works (`POST /api/orders/:id/support`). Problems: the record's `kind` is stored as `"companion"`; the buyer's status ("waiting for an agent") never refreshes live; there is **no resolution workflow**; and **the seller can mark the buyer's support case "completed"** (H3). |
| 9 | Agent joins the existing order conversation | ✅ | Claim, then server `joinGroupMembers`, then a "Support joined" announcement. Concurrent claims are guarded. |
| 10 | Agent sees history from before joining | ✅ (Console-dependent) | Confirmed manually on 2026-11-05 (`hasPrejoin: true`). Depends on the Console setting "pre-join history access" for **the App Key used in production**. Re-check before submission. |
| 11 | Role-based access for buyer, seller, support | 🟡 | Server-side role checks on each route, and foreign orders return 404 (acceptance passed). Gaps: H3 (seller can close support), H1 (channel `joinPerm: 1`), and leftover endpoints still live (`/api/requests`, `/assign`, `/room`, `/api/volunteers`). |
| 12 | Neon PostgreSQL persistence on Render | 🟡 | Data is present in Neon, and three orders with channels show checkout worked there. **But** the access pattern deletes and re-inserts everything on every call (C1). Phase 4.3 evidence says the Neon end-to-end run was "NOT RUN". |

---

## 3. Critical and high-priority gaps

### Critical

**C1. Every API call deletes and rewrites the whole database.** *(Critical: reliability, performance, data integrity)*
- `update()` in [server/store-pg.ts:287](../server/store-pg.ts#L287) loads all 7 tables, runs the mutation in memory, then calls `replaceDatabase()` ([server/db/snapshot.ts:136](../server/db/snapshot.ts#L136)). That function runs `DELETE FROM` on every table and re-inserts **every row with a separate INSERT**.
- **Pure reads also go through `update()`:** `listCatalog`, `getProduct`, `getCart`, `listOrders`, `getOrder`, `listConversations`, `listRequests`, `listVolunteers`, `listSellerProducts`.
- With today's 25 rows that is about 42 round trips per request. At the 74 ms measured here that is about 3 seconds. On Render it depends on whether Render and Neon are in the same region (❔ check this). The cost grows linearly with every order, session and judge-created account.
- One `pg_advisory_xact_lock(742301)` plus an in-process queue means **all users are served one at a time**.
- The support desk polls every 4 seconds and the inbox every 10 seconds, each with two calls. **One idle agent tab rewrites the production database about 30 times a minute.**
- Data integrity: any column or row the in-memory model does not carry is silently dropped on the next write. `withCatalog()` and `remapCatalogImages()` also change product data (images, timestamps) on every write, and can **overwrite a seller's chosen images**.
- Ironically, your constraint "no destructive operations against Neon" is already being broken by the app itself, all the time.

**C2. Shared demo accounts break when several judges use them.** *(Critical: judges are locked out)*
- Each user keeps at most 8 sessions (`user.sessions.slice(-8)`, [store-pg.ts:322](../server/store-pg.ts#L322)). The 9th person to sign in as "Demo Buyer" **silently signs out** whoever signed in first, mid-demo.
- `/api/demo` shares a limit of 20 attempts per 15 minutes per IP ([server/auth.ts:8](../server/auth.ts#L8)). A judging panel behind one network address switches roles about 6 times each and can hit HTTP 429. Meanwhile the IP is read from the first `X-Forwarded-For` value, which the client controls, so the limit stops no real attacker.
- ❔ Nexconn's policy for several devices on one account: if the Console allows only one web connection per user, two judges on "Demo Buyer" will disconnect each other's chat. There is no `ConnectionStatusHandler`, so the UI would not even show it.

**C3. The earlier "Saathi" volunteer app is visible in the product.** *(Critical for the 50% completeness and UX score)*
- The support queue has a "Kind" filter with Groceries, Medical transport and Companion visit, plus an "Assign a seller" form for general help ([CoordinatorDesk.tsx:170-284](../web/src/pages/CoordinatorDesk.tsx#L170-L284)).
- The buyer inbox has "Contact general support", and its dialog describes "groceries, transport, or a companion visit" ([copy.ts](../web/src/copy.ts)).
- On the seller "Orders" page, order support requests appear as **"Companion visit"**, because `kind: "companion"` is hard-coded in `createOrderSupport`.
- Inbox has a "Community help" section. Fallback empty-state copy (probably unreachable today) still says *"The salon opens next"* and *"Listings arrive in the next phase"* ([nav.ts:163-196](../web/src/ui/nav.ts#L163-L196)).
- In code: the cookie is `saathi_session`, functions are named `connectSaathi`, the package is named `saathi`, the role names are `member`, `volunteer` and `coordinator`, and the static 404 says *"Saathi is not built yet"*.

**C4. The production demo data is test debris.** *(Critical: the first 30 seconds)*
- The Neon support notes are `P393-order-support-1793873263136` and `P41-demo-order-support-1793874406906`. The Nexconn channels contain test messages such as "P393-support-after-join visible to all".
- All 3 orders are the same product, every order is "placed", and both cases are "assigned" with no history of progress.
- A judge clicking **Seller → Inbox** sees this first.

### High

**H1. Anyone can join a channel without approval.** Channels are created with `permissions: { joinPerm: 1 }`, which the [official docs](https://docs.nexconn.ai/platform-chat-api/group-channel/managing-channels/create-group) define as **"No approval needed"**. The browser calls `group.join()` before every history load or snapshot ([web/src/chat/nexconn.ts:113](../web/src/chat/nexconn.ts#L113)), and pre-join history is turned on. So any authenticated Nexconn user who knows `order<id>` can join and read the whole conversation. Order IDs have 48 random bits, so this is not trivially exploitable, but authorization rests on a secret ID. A security-minded judge would spot it. Fix: `joinPerm: 3` ("No one can join") on new channels, only the server adds members, and remove the client-side `join()`. ❔ Check that the server-side `/join` still works when `joinPerm` is 3.

**H2. Server announcements can be spoofed and are sent as the buyer.** System events are ordinary text messages sent **from the buyer's user ID** (or the agent's), and the UI treats any text starting with `"Update ·"` as a system event ([format.ts](../web/src/conversation/format.ts)). Anyone can type "Update · Refund approved." and it will render as a system notice. These events are also never translated for the Hindi buyer.

**H3. The seller can close the buyer's support case.** `createOrderSupport` sets `volunteerId = order.sellerId`, and `changeStatus` lets the `volunteer` on the record move it to `completed`. A seller in a dispute should not be able to close it.

**H4. The order lifecycle is missing.** No seller actions (pack, ship, deliver), and no status events in the conversation. The thesis "every order has a conversation" needs the order's life to show up *in* the conversation.

**H5. Support has no resolution.** There is no outcome (refund, replacement, return, information), no agent note, no buyer confirmation, and no time-to-resolve. The queue shows only buyer name, order ID and time: no product, no seller, no languages, no waiting time.

**H6. The repo is not ready for judges.** The GitHub root (`sunidhi-chouhan/ShopBridge`) has no README. It contains `chat app/` (a folder name with a space) and an unrelated project `yousr/` (173 files). Render must use `chat app` as its root directory.

**H7. The UI misses live state.** The buyer's support banner keeps saying "waiting for an agent" after the agent joins, until the page is opened again. Unread counts come from polling every 10 seconds, with N history queries plus N `join()` calls. Nothing reports when the Nexconn connection is lost.

**H8. Render Free cold starts.** ❔ The free service sleeps after 15 minutes idle, so a judge's first visit can wait 30–60 seconds on a blank tab. This needs a keep-warm plan, and a check that the deployed URL is healthy.

### Medium

- **M1. No URL routing.** A refresh loses your place, and nobody can deep-link to a conversation (useful for judges and the video).
- **M2. The chat panel is cramped.** The support card, language bar, order label and composer leave about 200 px for messages ([screenshot](../backups/phase41/seller-inbox-translation.png)). Enter does not send. Only the latest 40 messages load, with no "load older".
- **M3. Language preference is per device** (localStorage). Each person must set "Read messages in" by hand before the demo works. The buyer's Hindi is never used to localise the interface.
- **M4. No automated tests.** There is no test runner. The scripts need a live server and write data. Nothing protects you from regressions during the coming phases.
- **M5. Bundle size.** 346 KB gzip in one chunk. The Nexconn SDK could load only on chat screens.
- **M6. Hard to tell whether checkout opened the chat room.** When room creation fails at checkout, the error is swallowed. There is a recovery button ("Open conversation"), which is good, but the failure is never logged on the server.

### Low

- No CSP header, and no long-term cache headers for hashed assets.
- No `lang` attribute on original messages.
- Leftover endpoints are still exposed.
- Support agents stay in the channel forever after resolving a case.

---

## 4. UX and accessibility audit

### Journey walk-through (as a judge)

| Step | What works | What hurts |
|---|---|---|
| Landing / sign-in | Elegant hall, three demo buttons, no passwords shown | Does not **show** the value (Hindi ↔ English in one thread) before sign-in. "Indore" is the only hint of place |
| Buyer shop | Beautiful catalogue, filters, honest "simulated payment" | Generic. Nothing marks this out as a conversation-first marketplace |
| Checkout → order | Order split by seller, room created | The success screen does not invite the buyer to "Message the seller" in their own language |
| Buyer inbox | One list, search, filters for unread and support | "Contact general support" (leftover). The language bar must be set by hand |
| Seller | Product management works | Orders are read-only. "Requests for you" shows "Companion visit". No actions |
| Support | Queue, claim, join the same channel | Leftover filters and assign form. No case context, no brief, no resolution. Polls every 4 seconds |
| Chat | Original and translation, retry, status chips | Small message area. Text only. No proof of the problem (photo). System events are English only |

### Accessibility

- ✅ The skip link, labelled form fields, `aria-live` on the message list, `useReducedMotion`, a CSS `prefers-reduced-motion` rule, and a motion on/off toggle on the sign-in page all exist.
- ⚠️ Original-language messages need `lang` (`hi` or detected). Translated text already sets `lang`.
- ⚠️ `aria-live="polite"` on the **whole** `<ol>` re-announces history when a room loads. Use `role="log"`, or announce only new peer messages.
- ⚠️ The composer is a textarea with no Enter-to-send and no hint. Add Enter to send and Shift+Enter for a new line, with visible help text.
- ⚠️ Status shown as colour-only badges needs a text equivalent. Most badges have text, so check the contrast of the "accent" and "warning" tones.
- ⚠️ Limited digital literacy (your target buyer): an English-only interface, dense forms, and no voice input. This is the biggest gap in *scenario value*.

---

## 5. Technical and security audit

| Area | Finding | Severity |
|---|---|---|
| Secrets | App Secret only on the server; nothing in the bundle or git history; `.env`, `data/` and `backups/` are gitignored | ✅ |
| Auth | bcrypt (10 rounds), timing-safe dummy hash, HttpOnly + SameSite=Lax + Secure (in production) cookie, 7-day sessions | ✅ |
| CSRF | SameSite=Lax blocks cross-site POSTs carrying the cookie. `readJson` ignores Content-Type, which is acceptable with Lax | Low |
| Rate limiting | Kept in memory, keyed on a client-controlled XFF value, and shared across demo sign-ins (C2) | High (availability) |
| Authorization | Route role checks are good. Problems: seller can close support (H3); channel `joinPerm: 1` (H1) | High |
| Message integrity | Spoofable "Update ·" system events (H2) | High |
| Persistence | Full-table rewrite on every request (C1); readers can see an inconsistent snapshot across 7 non-transactional SELECTs | Critical |
| Migrations | One additive migration, `CREATE ... IF NOT EXISTS`. Good base. The next changes must be additive too (`ADD COLUMN`, new tables) | ✅ |
| Static serving | Path normalisation plus a `startsWith(webRoot)` check; nosniff, DENY framing. No CSP | Low |
| Error handling | Typed `HttpError`; DB errors mapped to 503 without leaking details | ✅ |
| Nexconn server calls | Correct signature scheme. `createOrderRoom` falls back to `join` when create fails (idempotent). Errors are swallowed at checkout | Medium |
| Observability | `console.error` only. No request log or timing for Nexconn and DB calls | Medium |
| Tests | No unit or integration tests; only scripts that write data | Medium |
| Repo | Monorepo root with no README and an unrelated project (H6) | High |
| Dependencies | `npm audit` clean, small dependency footprint | ✅ |

---

## 6. Nexconn SDK capability assessment

Checked against the **installed typings for `@nexconn/chat` 26.2.1** and **docs.nexconn.ai**. The SDK contains more than ShopBridge uses today.

| SDK capability | Exists? (evidence) | Used now? | Value for ShopBridge |
|---|---|---|---|
| Group channels, server create, join and send | ✅ docs + code | ✅ | Core |
| `translateModule.translateMessages` / `TranslateHandler` | ✅ typings | ✅ | Core differentiator |
| `translateModule.translateTexts` (translate any text) | ✅ typings | ❌ | **Preview "the seller will read: …"** before sending; translate system events and the support note |
| `setTranslationLanguage` / `setAutoTranslateEnabled` / `setTranslateStrategy(channel, AUTO)` | ✅ typings | Partly | Store the language per user and apply it automatically, with no manual toggle |
| Image and file messages (`SendImageMessageParams`, `SendFileMessageParams`, `sendMediaMessage`, upload progress callbacks) | ✅ typings | ❌ | **Photo evidence** for disputes. High value |
| HD voice messages + `message.requestSpeechToText()` + `AppSettings.isSpeechToTextEnabled` | ✅ typings | ❌ | **Hindi voice note → text → translation.** Helps buyers with limited literacy. ❔ Hindi speech-to-text support unconfirmed |
| Message metadata (`message.setMetadata`) | ✅ typings | ❌ | Mark a message as "evidence" or "resolution proposal"; acknowledgements |
| Custom message types (`NCEngine.registerCustomMessages`) | ✅ typings | ❌ | Structured **order event**, **resolution proposal** and **call log** cards instead of "Update ·" text (fixes H2) |
| Read receipts (`sendReadReceiptResponse`, `getMessageReadReceiptInfo`) | ✅ typings | ❌ | "Seen by seller" or "Seen by support". Builds trust |
| Typing status | ✅ only on `DirectChannel` in typings | ❌ | Not available for group channels in this typing set. Skip |
| Reference (reply) messages | ✅ typings | ❌ | The agent quotes the buyer's original complaint |
| Stream messages (`requestStreamMessage`) | ✅ typings | ❌ | Built for AI bot replies that stream in. Only relevant if an AI assistant posts into the channel |
| `ConnectionStatusHandler` | ✅ typings | ❌ | Show "Reconnecting…". Needed because of C2 |
| Online status subscription (`subscribeEvent`) | ✅ typings | ❌ | "Seller is online" in the order header |
| Webhooks (server-side message events) | ✅ docs index | ❌ | Not needed for the hackathon |
| **Call SDK** `@nexconn/call` | ✅ npm 26.2.1 + docs | ❌ | See §7 |

**Console dependencies to re-check on the production App Key before submission:** Translation enabled; pre-join history set to Allowed; speech-to-text (if used); audio and video calling (if used); and the policy for several devices per user.

---

## 7. AI, voice and video feasibility

### A. Nexconn Call SDK: "Show me the problem" consultation from the order chat

- **What exists (official docs):** `NCCallEngine.install()`, then `NCEngine.initialize`, then `NCCallEngine.initialize({})`. Calls start with `startCall({ calleeIds, callType: SINGLE|MULTI, mediaType })`. Events: `onCallReceived` (answer with `acceptCall({ callId })`), `onCallConnected`, `onRemoteUserStateChanged` and `onCallEnded(reason)`. Video is bound with `setLocalVideoView` and `setRemoteVideoView`. Group calls hold up to 16 people with video. Inviting someone into a 1:1 call turns it into a group call. HTTPS is required (Render provides it). The service must be **enabled in Console**. **Group-call billing starts when the call is created**, and the docs do not describe a free tier.
- **Risks:** the peer dependencies pin `@nexconn/chat@26.2.0` and `engine@26.2.0`, while you have 26.2.1 installed (❔ compatibility). Quota and billing are unknown. Both parties must be online. Browser permissions can fail on stage. A live call is hard to show reliably to asynchronous judges, but it works well in a recorded video.
- **Suggested shape if a spike succeeds:** a "Video consult" button in the order header. The callee sees an accept or decline sheet, with an explicit consent line and camera and microphone shown as off by default. Support can be invited, which turns it into a group call. When the call ends, a **call-log card** (duration, participants) is posted into the order channel, so the order record stays complete.
- **Verdict:** **P2, behind a half-day spike.** Only proceed if (1) Console enablement and quota are confirmed, (2) a 1:1 call works between two browsers on Render, and (3) the peer-dependency mismatch causes no runtime errors. Otherwise use voice notes (C below), which give most of the value with much less risk.

### B. AI-assisted support

- MandiLink, an entrant in the **same track**, already ships an "AI case brief for agents". A support agent without context will look weaker than theirs.
- **Recommended two-step approach:**
  1. **Case brief built from data, with no AI (P1).** Made only from records: order facts (items, amount, dates, status), parties and their reading languages, the buyer's escalation note, its translation, the evidence count, time waiting, and a timeline of key events from the channel history. It cannot invent anything and costs nothing.
  2. **Suggested reply drafted by an LLM (P2, optional).** Only if a free-tier key is available (for example a small model with grounded prompting). The model gets *only* the brief and the translated messages. Output is labelled "Draft · AI", appears in the composer **only after the agent clicks "Draft reply"**, and is **never sent automatically**. It must cite only facts present in the brief. No refund or policy promises: the system prompt forbids them, and the UI shows "Policy decisions are yours". It writes in the agent's language, and Nexconn translation does the rest.
- **Do not:** let AI decide resolutions, post into the channel by itself, or work as a hidden auto-responder.

### C. Smarter multilingual commerce (the highest return per hour)

1. **Language-first onboarding.** The first screen asks "आप किस भाषा में पढ़ना चाहेंगे? / Which language do you read?". The answer is stored **per user on the server** (additive `users.language` column) and applied through `setTranslationLanguage` at connect time. **No manual toggles in the demo.**
2. **Hindi interface for the buyer's chat and support flow.** Localise only the buyer's critical path (chat chrome, "Get help", status, system events), not the whole app.
3. **"How they'll read it" preview.** Show the seller-language rendering under the composer using `translateTexts`. It shows translation working *before* the message is sent.
4. **Source-language badge** on each message ("Hindi → English"), and `lang` set on originals.
5. **System and order events rendered in the viewer's language**, as structured custom messages localised on the client (fixes H2 as well).
6. **Voice note → speech-to-text → translation** for buyers with limited literacy. ❔ Spike: check `AppSettings.isSpeechToTextEnabled` and whether Hindi is supported.

### D. Trust and transaction confidence

- **Order timeline inside the conversation:** placed → packed → shipped → delivered → issue raised → support joined → resolution proposed → buyer confirmed. These are structured event cards posted by the server from a **dedicated ShopBridge system user**.
- **Evidence:** image messages tagged as evidence through message metadata, and counted in the case brief.
- **Resolution protocol:** the agent proposes one of Replacement, Refund, Return or Information. The seller acknowledges, the buyer confirms or rejects, and the case closes only after the buyer confirms (or a timeout, which is not needed for the demo).
- **Clear responsibilities** shown on the support card: "Seller: ship replacement by …", "Buyer: confirm receipt".
- **Read receipts** ("Seen by Meera").

---

## 8. Ranked feature roadmap

Effort: S ≈ under half a day · M ≈ half a day to 1.5 days · L ≈ 2–3 days. Judging impact weights: C/UX 50%, Innovation 30%, Business 20%.

### P0: Critical fixes before submission

| # | Feature / fix | User problem | Judging impact | Effort | Risk | Priority |
|---|---|---|---|---|---|---|
| P0-1 | **Postgres store: move reads to a read-only path, then turn writes into targeted SQL** (no schema change) | Slow, serialized, risk of data loss | C/UX ★★★ (judges feel the speed) | M | Medium. Develop against a **Neon branch**, never production | P0 |
| P0-2 | **Make demo sessions robust:** no 8-session eviction for sample accounts, a separate higher limit for `/api/demo`, use the proxy's IP, and add `ConnectionStatusHandler` | Judges signed out or locked out | C/UX ★★★ | S | Low | P0 |
| P0-3 | **Remove "Saathi" from the UI and API surface:** general help, the kind filter, assign seller, community rooms, leftover empty-state copy; show order support as "Order support" (DB values unchanged) | Looks like a reused project | C/UX ★★★ | S–M | Low | P0 |
| P0-4 | **Seller cannot close support** (authorization rule) | Fairness in disputes | C ★★, trust | S | Low | P0 |
| P0-5 | **Clean showcase story, added alongside the old data:** fresh coherent orders and messages made through normal app flows; demo accounts hide test-tagged records. *Needs your approval for any data change* | Test debris in the first 30 seconds | C/UX ★★★ | S | Low (additive) | P0 |
| P0-6 | **Repo hygiene:** root README, remove `yousr/` from this repo (your decision), check Render root directory, architecture diagram, screenshots | Judges read the repo | C ★★, business ★ | S | Low | P0 |
| P0-7 | **Production checks:** confirm Render and Neon are in the same region, keep-warm plan for cold starts, Console settings on the production key (translation, pre-join, multi-device) | Demo fails on judging day | C/UX ★★★ | S | Low | P0 |
| P0-8 | **Minimal test harness** using the built-in `node:test`, no new dependencies: authorization, status transitions, store operations on JSON and on a Neon branch | Regressions during the next phases | Indirect ★★ | M | Low | P0 |

### P1: High-impact improvements that strengthen the demo

| # | Feature | User problem | Judging impact | Effort | Risk | Priority |
|---|---|---|---|---|---|---|
| P1-1 | **Order lifecycle:** seller actions Packed → Shipped → Delivered, each posted as an event card in the order chat (map onto the existing `placed/packed/completed`, or add statuses with an additive migration) | Orders never move | C/UX ★★★ | M | Low | P1 |
| P1-2 | **Structured support resolution:** propose a resolution, seller acknowledges, buyer confirms, case closes with time-to-resolve; additive columns `resolution`, `resolved_at` | The story has no ending | C/UX ★★★, Innov ★★ | M | Low | P1 |
| P1-3 | **System user and structured event messages** (custom message type, localised per viewer) | Spoofing; English-only events | C ★★, Innov ★ | S–M | Medium (registering custom messages) | P1 |
| P1-4 | **Photo evidence** using Nexconn image messages, tagged as evidence | "Show me the damage" | C ★★, Innov ★★ | M | Medium (❔ check upload service) | P1 |
| P1-5 | **Language-first onboarding and server-side language preference, applied automatically** | Manual toggles; Hindi user lost | C/UX ★★★, Innov ★★ | M | Low | P1 |
| P1-6 | **Hindi interface for the buyer's critical path** | Limited-literacy users | Innov ★★, business ★★ | M | Low | P1 |
| P1-7 | **"How they'll read it" outgoing translation preview** (`translateTexts`) | Sender cannot trust the translation | Innov ★★ (very memorable) | S | Low | P1 |
| P1-8 | **Case brief from real data for agents** (no AI) | Agent lacks context | C ★★, Innov ★★ | M | Low | P1 |
| P1-9 | **Live state:** refresh support status on events, unread from `MessageHandler`, connection banner; less polling | Stale UI | C/UX ★★ | M | Low | P1 |
| P1-10 | **Close channel access:** `joinPerm: 3` for new channels, no client `join()` | Security | C ★, judges reviewing code | S | Medium (❔ server join still works) | P1 |
| P1-11 | **Chat ergonomics:** bigger timeline, Enter to send, load older messages, `lang` on originals, `role="log"` | Cramped chat | C/UX ★★ | S | Low | P1 |
| P1-12 | **Hash routes and deep links** (`#/orders/:id`) and "switch role and stay on this order" | Refresh loses place; role switching is slow | C/UX ★★ | S–M | Low | P1 |

### P2: Differentiators if time allows (each needs a spike first)

| # | Feature | User problem | Judging impact | Effort | Risk | Priority |
|---|---|---|---|---|---|---|
| P2-1 | **Hindi voice note → speech-to-text → translated text** (HD voice + `requestSpeechToText`) | Buyers who cannot type | Innov ★★★, business ★★ | M–L | High (❔ Hindi speech-to-text, Console) | P2 (P1 if the spike passes) |
| P2-2 | **Video consult** (Call SDK, 1:1 that can become a group call with support) with a call-log card | "Show me" disputes | Innov ★★★ | L | High (billing, peer dependencies, permissions) | P2 |
| P2-3 | **AI reply draft** grounded in the case brief, approved by the agent | Agent speed | Innov ★★ | M | Medium (key, quality) | P2 |
| P2-4 | **Insights panel** for seller and support: median time-to-resolve, % resolved without escalation, messages translated (real data only) | Business story | Business ★★★ | S–M | Low | P2 |
| P2-5 | Read receipts ("Seen by seller") and online presence | Trust | C ★ | S | Low | P2 |
| P2-6 | Load the chat SDK only on chat screens | First load | C ★ | S | Low | P2 |

### P3: Defer

Real payments, logistics and courier integration, ONDC integration, ratings and reviews, push notifications, native apps, more interface languages, multi-seller onboarding, Nexconn webhooks, typing indicators (not available for group channels in these typings).

---

## 9. Recommended winning demo scenario

**Title: "One order, two languages, one conversation, resolved."** It must work as a 3-minute video and as a 5-minute live session with judges.

**Cast:** Asha Rao, a buyer in Indore who reads Hindi. Meera Joshi, the weaver and seller, who writes English. Kabir Shah, a support agent who writes English.

| Time | Screen | What the judge understands |
|---|---|---|
| 0:00–0:20 | Landing hall shows a looping, **real** two-pane snippet: Asha's Hindi bubble on the left, Meera's English rendering on the right, with "Powered by Nexconn Chat + Translation". Three demo buttons and "Start guided demo" | *The whole product in 20 seconds* |
| 0:20–0:45 | Asha (Hindi onboarding chosen once) buys the Maheshwari sari. The success screen says "Meera ko sandesh bhejein / Message Meera" | Real marketplace, honest simulated payment |
| 0:45–1:15 | Meera marks it **Packed → Shipped**. Event cards appear **in the order chat**, rendered in Hindi for Asha | The order's life *is* the conversation |
| 1:15–1:45 | Delivered. Asha sends a **photo** of the frayed zari border and writes (or **says**, if P2-1 lands) "किनारा खराब है". The composer preview shows "Meera will read: *The border is damaged*" | Nexconn media plus translation, trust before sending |
| 1:45–2:05 | Meera reads it in English (original one tap away) and offers a 10% discount. Asha refuses and taps **"मदद चाहिए / Get help"** | Translation in both directions; escalation in context |
| 2:05–2:35 | Kabir claims the case and **joins the same channel**. Everything from before he joined is visible. The **case brief** shows order facts, languages, evidence (1 photo), and 4 minutes waiting. Optional: "Draft reply · AI", which he edits and sends himself | Pre-join history, human in control |
| 2:35–2:55 | Kabir proposes **Replacement**. Meera acknowledges ("Replacement ships by Fri"). Asha confirms in Hindi. The case closes with a "Resolved in 12 min" card | A closed loop: completeness |
| 2:55–3:00 | Insights strip: time to resolve and messages translated. Closing line: *"Every order has a conversation, in every language."* | Business value |

Optional (P2-2): between 2:05 and 2:35, Kabir starts a **video consult** to see the border. The call-log card lands in the chat.

**Demo operations:** use three browser profiles (or "Switch role and stay on this order"). Pre-warm Render. Create the showcase order on the day through real flows. Keep a backup screen recording.

---

## 10. Submission readiness checklist

- [ ] Confirm the **deadline** and required items on reskilll.com (the old spec lists: live URL, public repo, demo video, PDF write-up). Confirm whether **the App Key must be entered on the form** (`.env.example` suggests it must)
- [ ] Production Render URL reachable; `/api/health` returns `ok: true, backend: "postgres"`; same region as Neon; keep-warm configured
- [ ] Production App Key: Translation **Enabled**; pre-join history **Allowed**; multi-device policy checked; speech-to-text and calls enabled only if used
- [ ] P0-1 deployed and tested on a Neon branch, then production checked with a read-only smoke test
- [ ] No "Saathi", groceries or companion copy anywhere (`grep -ri "saathi\|groceries\|companion\|volunteer" web/src` shows only internal role identifiers)
- [ ] Showcase data is clean and coherent, with no `P3xx`/`P4x` test strings visible from any demo role
- [ ] Root README: problem, demo link, 3 demo roles, a "Nexconn features used" table (with file links), architecture diagram, screenshots, setup, security notes
- [ ] `yousr/` removed from the ShopBridge repo (your decision); `.gitleaksignore` reviewed
- [ ] Tests: `npm test` passes; typecheck and build pass
- [ ] Accessibility check: keyboard-only walkthrough, screen-reader spot check on chat, reduced motion, 390 px mobile layout
- [ ] Demo video (≤ 3 minutes) following §9, with backup recording; no secrets, emails or passwords on screen
- [ ] Write-up PDF: problem, users, Nexconn usage, impact metrics, business model, roadmap
- [ ] Business section: target segment (Indic-language buyers and small artisan sellers), model (per-resolved-conversation or per-seller SaaS for marketplaces), growth (embeddable "order conversation" layer for marketplaces and social commerce sellers)

---

## 11. Recommended implementation sequence

Each phase ends with: what changed, files modified, test results, remaining risks, regression confirmation, and **a wait for your approval**.

| Phase | Contents | Exit criteria |
|---|---|---|
| **1. Reliability and blockers** | P0-8 test harness first. Then P0-1 (reads via read-only path, then targeted writes; tested on a **Neon branch**). Then P0-2, P0-4, P0-7 checks | All tests green; zero `DELETE FROM` on any request path; one API call costs a few queries; production smoke test read-only |
| **2. Core marketplace and support UX** | P0-3 remove leftover code, P1-1 order lifecycle, P1-2 resolution, P1-3 system user and event cards, P1-9 live state, P1-11 chat ergonomics, P1-12 deep links, P0-5 clean showcase story (with your approval) | §9 runs end to end (text-only version) without manual workarounds |
| **3. Nexconn differentiation and multilingual** | P1-5 language onboarding, P1-6 Hindi buyer path, P1-7 send preview, P1-4 photo evidence, P1-10 channel lock-down. **Spike** P2-1 voice speech-to-text | Hindi buyer needs zero toggles; photos work on production key |
| **4. AI-assisted support** | P1-8 case brief from data; optional P2-3 AI draft if a free key exists and grounding passes review | Brief contains only facts from records; AI never sends by itself |
| **5. Voice and video** | P2-1 (if the spike passed); P2-2 Call SDK **only if** its spike passes (Console, quota, peer dependencies) | Works between two browsers on Render 3 times in a row |
| **6. Security, accessibility, regression** | CSP, rate-limit review, accessibility pass, mobile pass, full regression of the 25 acceptance checks on a Neon branch | Checklist §10 security and accessibility items ticked |
| **7. Demo and submission** | README, diagram, screenshots, video, write-up, P2-4 insights strip, final production check | Submission items complete |

**Open decisions for you:**
1. May I create a **Neon branch** (free) for development and testing? (Recommended. It keeps production untouched.)
2. Showcase data: add a clean story **alongside** the existing records and hide the test-tagged ones from demo views, or archive them? Nothing will be deleted without your explicit approval.
3. Repo layout: remove `yousr/` from the ShopBridge repo, and move the app out of `chat app/` to the root? (This affects the Render root-directory setting.)
4. Headline differentiator: **voice notes with speech-to-text** (lower risk) or **video consult** (higher wow factor, higher risk)? I recommend spiking voice first.
5. Is an LLM API key on a free tier available for P2-3, or should support AI stay with the data-built brief only?
