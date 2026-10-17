import "./features.css";

function PriceArt() {
  return (
    <svg
      viewBox="0 0 300 260"
      role="img"
      aria-label="Illustration of a paper price label lifting to reveal a different price"
    >
      <g transform="rotate(9 160 112)">
        <path
          d="M71 35h177v152l-12-6-12 7-12-7-12 7-12-7-12 7-12-7-12 7-12-7-12 7-12-7-12 7Z"
          fill="#f6d34f"
        />
        <text x="91" y="69" fontSize="11" fontWeight="700" fill="#283222">
          REQUIRED PRICE
        </text>
        <text x="90" y="116" fontSize="37" fontWeight="900" fill="#283222">
          $0.25
        </text>
        <path d="M92 143h112m-112 13h75" stroke="#847032" />
      </g>
      <g transform="translate(-12 55) rotate(-12 106 139)">
        <path
          d="M25 80h173v96H25l7-12-7-12 7-12-7-12 7-12-7-12Z"
          fill="#b7deca"
        />
        <text x="45" y="105" fontSize="11" fontWeight="700" fill="#283222">
          ADVERTISED
        </text>
        <text x="45" y="150" fontSize="34" fontWeight="900" fill="#283222">
          $0.01
        </text>
        <path d="m173 80 25 24h-25Z" fill="#8ebb9e" />
      </g>
      <path
        d="M239 119q30 14 11 45m-2-12 1 15 14-6"
        stroke="#283222"
        strokeWidth="2"
        fill="none"
      />
    </svg>
  );
}
function EvidenceArt() {
  return (
    <svg
      viewBox="0 0 300 245"
      role="img"
      aria-label="Illustration of three separate paper records labelled attempt, settlement and delivery"
    >
      <g transform="translate(0 -15) rotate(-5 115 88)">
        <path d="M36 38h159v58H36l5-11-5-10 5-10-5-10 5-10Z" fill="#edb6a3" />
        <text x="58" y="67" fontSize="11" fill="#283222">
          01 / DECISION
        </text>
        <text x="58" y="91" fontSize="20" fontWeight="800" fill="#283222">
          Attempt
        </text>
      </g>
      <g transform="translate(0 8) rotate(3 169 128)">
        <path d="M95 85h159v58H95l5-11-5-10 5-10-5-10 5-10Z" fill="#f6d34f" />
        <text x="116" y="113" fontSize="11" fill="#283222">
          02 / PAYMENT
        </text>
        <text x="116" y="138" fontSize="20" fontWeight="800" fill="#283222">
          Settlement
        </text>
      </g>
      <g transform="translate(0 26) rotate(-3 133 175)">
        <path d="M53 137h173v58H53l5-11-5-10 5-10-5-10 5-10Z" fill="#b7deca" />
        <text x="74" y="165" fontSize="11" fill="#283222">
          03 / FULFILLMENT
        </text>
        <text x="74" y="189" fontSize="20" fontWeight="800" fill="#283222">
          Delivery
        </text>
      </g>
    </svg>
  );
}
function ReviewArt() {
  return (
    <svg
      viewBox="0 0 300 220"
      role="img"
      aria-label="Illustration of an unfilled five-check test sheet, not an actual grade"
    >
      <g transform="rotate(-8 145 110)">
        <path
          d="M64 20h163v181H64l6-10-6-10 6-10-6-10Z"
          fill="#fffdf6"
          stroke="#d3d1c3"
        />
        <path d="M107 12h76v23h-76Z" fill="#b7deca" fillOpacity=".85" />
        <text x="86" y="64" fontSize="13" fontWeight="800" fill="#283222">
          THE RUN REVIEW
        </text>
        {[82, 103, 124, 145, 166].map((y) => (
          <g key={y}>
            <rect
              x="86"
              y={y}
              width="11"
              height="11"
              fill="none"
              stroke="#53634c"
            />
            <path d={`M108 ${y + 5}h91`} stroke="#a5ad9d" />
          </g>
        ))}
      </g>
      <g transform="rotate(28 239 145)">
        <path d="M234 65h12v122l-6 16-6-16Z" fill="#f6d34f" />
        <path d="m234 187 6 16 6-16Z" fill="#c4a57c" />
        <path d="m238 198 2 5 2-5Z" fill="#283222" />
        <path d="M234 65h12v13h-12Z" fill="#edb6a3" />
      </g>
      <path
        d="m43 45-13-6m17-7-3-14m-6 39-15 5"
        stroke="#bd5a3c"
        strokeWidth="2"
      />
    </svg>
  );
}
export default function Features() {
  return (
    <section className="features" aria-labelledby="feature-title">
      <header className="feature-heading">
        <span className="note">A little pressure. A clearer picture.</span>
        <h2 id="feature-title">
          A small budget.
          <br />A revealing test.
        </h2>
        <p>
          Not just whether an agent can spend.
          <br />
          How it chooses—and what happens next.
        </p>
      </header>
      <div className="feature-grid">
        <article className="feature-panel feature-wide">
          <span className="eyebrow">01 / Look closer</span>
          <PriceArt />
          <div className="feature-copy">
            <h3>
              The listed price
              <br />
              isn’t the whole story.
            </h3>
            <p>
              Controlled offers test whether your agent inspects the required
              price before choosing to buy.
            </p>
          </div>
        </article>
        <article className="feature-panel feature-narrow">
          <span className="eyebrow">02 / Keep the mission</span>
          <div
            className="budget-art"
            role="img"
            aria-label="Illustrated mission budget of twenty-five cents"
          >
            <span className="note">the limit, not a target</span>
            <strong>$0.25</strong>
            <span>MISSION BUDGET</span>
          </div>
          <div className="feature-copy">
            <h3>
              Finish the task.
              <br />
              Not the budget.
            </h3>
            <p>
              Prefer the lowest-cost equivalent offer. Refusing everything
              doesn’t complete the mission.
            </p>
          </div>
        </article>
        <article className="feature-panel feature-narrow">
          <span className="eyebrow">03 / Separate the facts</span>
          <EvidenceArt />
          <div className="feature-copy">
            <h3>
              An attempt isn’t
              <br />a payment.
            </h3>
            <p>
              Decisions, confirmed settlements and delivered results each get
              their own evidence.
            </p>
          </div>
        </article>
        <article className="feature-panel feature-wide">
          <span className="eyebrow">04 / Read the review</span>
          <ReviewArt />
          <div className="feature-copy">
            <h3>
              Judge the run.
              <br />
              Not the promise.
            </h3>
            <p>
              Five explainable checks grounded in the controlled course. A run
              review, never a safety certificate.
            </p>
          </div>
        </article>
      </div>
      <p className="feature-disclaimer">
        Illustrations explain the course. They are not agent results or payment
        receipts.
      </p>
    </section>
  );
}
