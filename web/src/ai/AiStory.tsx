import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * "Follow one sentence": a scroll story that traces a single spoken Hinglish request through the
 * AI pipeline, page by page. Shown on the landing page and inside the seller's Voice screen.
 * Nothing here is a performance claim; live measured numbers are passed in by the app variant.
 */

export type MeasuredLatency = { p50: number | null; p95: number | null; turns: number };

const SPOKEN = [
  ["Aaj ke pending orders batao", "Hinglish"],
  ["ऑर्डर 1042 का रिटर्न शुरू करो", "Hindi"],
  ["1053 customer-ku Tamil-la message anuppu", "Tanglish"],
  ["Mark 1051 packed", "English"],
  ["Tote ka stock paanch badha do", "Hinglish"],
  ["1052… nahi nahi, 1053 ko ship karo", "Self-correction"],
  ["இன்னைக்கு எத்தனை ஆர்டர்?", "Tamil"],
  ["Low stock wale items dikhao", "Hinglish"],
] as const;

type Page = { n: string; tag: string; title: string; body: ReactNode; art: ReactNode };

/** Reveals children once they scroll into view (final state at once when motion is reduced). */
function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, seen];
}

function Wave() {
  // A hand-drawn feeling waveform that draws itself.
  return (
    <svg className="ai-wave" viewBox="0 0 320 90" aria-hidden="true">
      <path pathLength={1} d="M4 46 C 20 46, 22 30, 34 30 S 46 62, 58 62 S 70 18, 84 18 S 98 74, 112 74 S 126 8, 142 8 S 158 82, 172 82 S 186 22, 200 22 S 214 66, 228 66 S 240 36, 252 36 S 266 52, 278 52 S 296 46, 316 46" />
    </svg>
  );
}

function Bubble({ who, children, cut }: { who: "seller" | "agent"; children: ReactNode; cut?: boolean }) {
  return (
    <p className={`ai-bubble is-${who}${cut ? " is-cut" : ""}`}>
      <span className="ai-bubble-who">{who === "seller" ? "Seller" : "AI agent"}</span>
      {children}
    </p>
  );
}

function Tool({ name, arg, result, tone }: { name: string; arg: string; result: string; tone?: "ok" | "blocked" | "wait" }) {
  return (
    <div className={`ai-tool is-${tone ?? "ok"}`}>
      <code>{name}<span>({arg})</span></code>
      <span className="ai-tool-arrow" aria-hidden="true">→</span>
      <span className="ai-tool-result">{result}</span>
    </div>
  );
}

const PAGES: Page[] = [
  {
    n: "01",
    tag: "You speak",
    title: "Hands full. One sentence.",
    body: <>Meera is packing parcels with a fan running. She doesn't open a screen. She says what she wants, in the words she uses all day.</>,
    art: (
      <>
        <Wave />
        <Bubble who="seller">“Order 1050 cancel kar do.”</Bubble>
      </>
    ),
  },
  {
    n: "02",
    tag: "Gemini hears",
    title: "Audio in, meaning out.",
    body: <>Gemini Live takes the raw audio, not typed text. It understands Hindi and English mixed in one sentence, regional names and a noisy room, and it starts replying while it works.</>,
    art: (
      <div className="ai-lang">
        <p className="ai-lang-line">
          <span className="ai-word is-en">Order</span> <span className="ai-word is-num">1050</span> <span className="ai-word is-en">cancel</span> <span className="ai-word is-hi">kar do</span>
        </p>
        <p className="ai-lang-key"><span className="is-en">English</span><span className="is-hi">Hindi</span><span className="is-num">order number</span></p>
        <p className="ai-noise" aria-hidden="true">~ fan ~ traffic ~ tape gun ~</p>
      </div>
    ),
  },
  {
    n: "03",
    tag: "It decides",
    title: "The AI picks the next step.",
    body: <>Before acting, the agent looks things up. It calls the shop's own tools, reads the real order and learns something important: this parcel has already left.</>,
    art: (
      <div className="ai-tools">
        <Tool name="get_order" arg="1050" result="shipped · Asha Rao" />
        <Tool name="cancel_order" arg="1050" result="checking policy…" tone="wait" />
      </div>
    ),
  },
  {
    n: "04",
    tag: "Guardrails",
    title: "The AI proposes. The server decides.",
    body: <>Gemini never writes to the database. Every change goes through a server that checks ownership, shop policy and duplicates. A shipped order can't be cancelled, so the request is blocked, and the AI explains why.</>,
    art: (
      <div className="ai-guard">
        <Tool name="cancel_order" arg="1050" result="blocked: already dispatched" tone="blocked" />
        <ul className="ai-checks">
          <li>Your order?</li><li>Allowed by policy?</li><li>Not a duplicate?</li><li>Approved by you?</li><li>Written to the audit log</li>
        </ul>
      </div>
    ),
  },
  {
    n: "05",
    tag: "You interrupt",
    title: "Change your mind mid-sentence.",
    body: <>While the agent is still explaining, Meera cuts in. It stops talking at once, drops the old plan and follows the new instruction, the way a good assistant would.</>,
    art: (
      <>
        <Bubble who="agent" cut>“Order 1050 is already shipped, so I can't cancel it. Would you like me to—”</Bubble>
        <Bubble who="seller">“Wait! Cancel nahi. Customer ko delay ka message bhejo.”</Bubble>
      </>
    ),
  },
  {
    n: "06",
    tag: "It asks first",
    title: "Read back. Then your yes.",
    body: <>Nothing changes until the seller agrees. The agent reads the exact action aloud. A spoken “haan” is checked against what the server itself heard, not what the model claims, or the seller can simply tap. Critical actions (refunds, cancellations, price offers, purchases of ₹25,000 or more, stock changes of 100+ units, messages to 10+ customers) need a tap: a spoken yes is refused.</>,
    art: (
      <div className="ai-approval">
        <p className="ai-approval-k">Waiting for your OK</p>
        <p className="ai-approval-text">Send Asha Rao (order 1050): “Your order is delayed by a day. Sorry for the wait.”</p>
        <div className="ai-approval-row"><span className="ai-pill is-yes">“Haan, bhej do”</span><span className="ai-pill">or tap Approve</span></div>
      </div>
    ),
  },
  {
    n: "07",
    tag: "Done, and said aloud",
    title: "Every step on the record.",
    body: <>The message goes to the customer's order chat, the agent confirms by voice, and the seller can see each step, how long it took, where a human stepped in, and undo what can be undone.</>,
    art: (
      <ol className="ai-log">
        <li><span>Look up order 1050</span><em>AI</em></li>
        <li className="is-blocked"><span>Cancel order: blocked by policy</span><em>Guardrail</em></li>
        <li><span>Draft delay message</span><em>AI</em></li>
        <li className="is-human"><span>Approved by seller</span><em>Human</em></li>
        <li><span>Message sent · “Ho gaya, message bhej diya.”</span><em>AI</em></li>
      </ol>
    ),
  },
];

function StoryPage({ page, index }: { page: Page; index: number }) {
  const [ref, seen] = useInView<HTMLElement>();
  return (
    <article ref={ref} className={`ai-page${seen ? " is-in" : ""}${index % 2 ? " is-flip" : ""}`} aria-labelledby={`ai-p${page.n}`}>
      <div className="ai-copy">
        <p className="ai-cap">p. {page.n} / {String(PAGES.length).padStart(2, "0")} · {page.tag}</p>
        <h3 id={`ai-p${page.n}`} className="ai-title">{page.title}</h3>
        <p className="ai-body">{page.body}</p>
      </div>
      <div className="ai-art">{page.art}</div>
    </article>
  );
}

export function AiStory({ variant, onTry, measured }: { variant: "landing" | "app"; onTry?: () => void; measured?: MeasuredLatency }) {
  return (
    <section className={`ai-story is-${variant}`} id="how-ai" aria-labelledby="ai-story-title">
      <div className="ai-sky" aria-hidden="true" />
      <header className="ai-intro">
        <p className="ai-cap">How the AI works · follow one sentence</p>
        <h2 id="ai-story-title" className="ai-intro-title">One sentence, spoken in a busy godown. Here is what the AI does with it.</h2>
      </header>

      <div className="ai-marquee" aria-label="Things sellers say to the agent">
        <ul className="ai-marquee-track">
          {[...SPOKEN, ...SPOKEN].map(([line, lang], i) => (
            <li key={i} aria-hidden={i >= SPOKEN.length || undefined}>
              <span className="ai-marquee-line">{line}</span>
              <span className="ai-marquee-lang">· {lang}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="ai-pages">
        {PAGES.map((page, i) => <StoryPage key={page.n} page={page} index={i} />)}
      </div>

      <div className="ai-split">
        <div className="ai-split-col">
          <p className="ai-cap">What the AI does</p>
          <ul>
            <li>Listens to speech directly and understands mixed languages</li>
            <li>Chooses the next step and calls the shop's tools</li>
            <li>Explains blocks and suggests the alternative</li>
            <li>Drafts customer messages in the customer's language</li>
            <li>Runs as a team: a Supervisor plans and hands tasks to comms, inventory and triage agents</li>
            <li>Explains every decision: the facts, the rules checked and why it was allowed or blocked</li>
            <li>Briefs the seller on what needs attention when a session opens</li>
            <li>Sends one delay update to every late customer with a single yes</li>
            <li>Offers special prices, within a discount limit</li>
            <li>Triages support cases: summary, urgency, buyer mood, suggested resolution</li>
            <li>Suggests chat replies and drafts product listings from a photo</li>
            <li>Turns the day's work into a summary for the owner, team or customers</li>
          </ul>
        </div>
        <div className="ai-split-col is-never">
          <p className="ai-cap">What the AI never does</p>
          <ul>
            <li>Write to the database itself</li>
            <li>Act without the seller's yes</li>
            <li>Guess an unclear order number or amount: it asks again</li>
            <li>Issue refunds or deep discounts: a person handles money</li>
            <li>See the API key: it stays on the server</li>
          </ul>
        </div>
      </div>

      <footer className="ai-outro">
        <p className="ai-chain" aria-label="Pipeline">
          <span>Voice</span><i aria-hidden="true">→</i><span>Gemini Live</span><i aria-hidden="true">→</i><span>Guarded tools</span><i aria-hidden="true">→</i><span>Orders · stock · returns · chat</span><i aria-hidden="true">→</i><span>Spoken reply</span>
        </p>
        {variant === "app" && measured ? (
          <p className="ai-measured">
            {measured.turns
              ? <>Measured on this shop: reply in <strong>{measured.p50} ms</strong> (median), <strong>{measured.p95} ms</strong> (95th percentile) over {measured.turns} turns.</>
              : <>Start a voice session and your measured reply time appears here.</>}
          </p>
        ) : null}
        {onTry ? <button type="button" className="ai-try" onClick={onTry}>{variant === "landing" ? "Try it as the demo seller" : "Talk to the agent"} <span aria-hidden="true">→</span></button> : null}
      </footer>
    </section>
  );
}
