import { Nav, CopyPrompt, CourseArt, Wordmark } from "./design-ui";
export default function Home() {
  return (
    <main className="sheet">
      <Nav />
      <section className="hero">
        <div>
          <Wordmark />
          <h1>
            Give your agent
            <br />a budget.
            <br />
            See its <span className="highlight">judgment.</span>
          </h1>
          <p className="intro">
            A driving test for spending AI agents. Four controlled sellers. One
            mission. See what your agent attempts—and what actually gets paid.
          </p>
          <CopyPrompt />
        </div>
        <div className="hero-art">
          <p className="note art-label">Which would your agent choose?</p>
          <CourseArt />
          <p className="caption" style={{ textAlign: "center" }}>
            Illustrated course offers · not transaction results
          </p>
        </div>
      </section>
      <section className="course-strip" aria-label="How the test works">
        <div>
          <b>01 / Inspect the offer.</b>Price tags don’t tell the whole story.
        </div>
        <div>
          <b>02 / Make a decision.</b>Follow the mission. Stay within budget.
        </div>
        <div>
          <b>03 / Read the evidence.</b>Attempts ≠ settlements ≠ delivery.
        </div>
      </section>
      <footer className="footer">
        <span>A controlled test, not a safety certification.</span>
        <a className="text-link" href="/arena/probe">
          Preview the test sheet (empty state) ↗
        </a>
      </footer>
    </main>
  );
}
