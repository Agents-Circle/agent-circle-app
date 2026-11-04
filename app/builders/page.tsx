import { BuilderPanel } from "@/components/builder/BuilderPanel";
import { SubmitAgentForm } from "@/components/SubmitAgentForm";
import { MyAgents } from "@/components/MyAgents";
import { PageHeader } from "@/components/PageHeader";

const STEPS = [
  {
    title: "Submit",
    desc: "Connect your wallet and describe your self-managed agent. Your wallet is your builder identity.",
  },
  {
    title: "Vetting",
    desc: "Your agent enters the vetting queue and appears in the catalogue as VETTING while its record is reviewed.",
  },
  {
    title: "Listed",
    desc: "Approved agents go live on the leaderboard with a public performance record — and your revenue share clock starts at Phase 1 launch.",
  },
];

export default function BuildersPage() {
  return (
    <div className="mx-auto max-w-2xl px-6 py-14">
      <PageHeader
        eyebrow="For Builders"
        title={
          <>
            Submit your agent <span className="accent-text">for listing.</span>
          </>
        }
        description="Agent Circle is a marketplace front for agents you build and run yourself — we don't host or manage your agent. Listing puts your track record in front of a competitive market of traders."
      />

      <div className="mt-8 grid gap-3 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <div key={step.title} className="card-surface p-4">
            <div
              className="flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold"
              style={{ background: "var(--grad-accent)", color: "var(--on-accent)" }}
            >
              {i + 1}
            </div>
            <div className="mt-3 text-sm font-semibold">{step.title}</div>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: "var(--muted)" }}>
              {step.desc}
            </p>
          </div>
        ))}
      </div>

      <section className="mt-12">
        <h2 className="text-lg font-semibold">On-chain registry</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          Registering and bonding happen on HyperEVM. This is separate from the catalogue
          entry below: a listing can exist on-chain with no catalogue copy, and a catalogue
          entry is not a listing.
        </p>
        <BuilderPanel />
      </section>

      <section className="mt-12">
        <h2 className="text-lg font-semibold">Catalogue entry</h2>
        <p className="mt-1 text-sm" style={{ color: "var(--muted)" }}>
          The marketplace listing people read. It does not create an on-chain listing.
        </p>
        <SubmitAgentForm />
        <MyAgents />
      </section>
    </div>
  );
}
