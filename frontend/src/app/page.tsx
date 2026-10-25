import Link from "next/link";
import NavbarSection from "@/components/landing/NavbarSection";
import FooterSection from "@/components/landing/FooterSection";
import { landingContent } from "@/content";

const tools = [
  { href: "/single", title: "Single search", body: "How often a player cleared a line, with filters for opponent, venue, season, rest days and more." },
  { href: "/sgm", title: "Same-game multi", body: "Check how often several legs landed together in the same game." },
  { href: "/multi", title: "Multi builder", body: "Combine saved legs across games and compare their history." },
  { href: "/afl/context", title: "Match context", body: "Travel, rest and venue context for upcoming fixtures." },
];

export default function Home() {
  return (
    <>
      <NavbarSection content={landingContent.navbar} />
      <main className="mx-auto max-w-6xl px-4 py-12">
        <h1 className="font-serif text-4xl text-gray-900 sm:text-5xl">StatChecker AFL</h1>
        <p className="mt-3 max-w-2xl text-gray-600">
          Research AFL player stats from your own database. Load data with the backend scripts, then pick a tool.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {tools.map((tool) => (
            <Link key={tool.href} href={tool.href} className="rounded-2xl border border-black/10 bg-white p-5 shadow-sm transition hover:border-gray-300">
              <h2 className="text-lg font-semibold text-gray-900">{tool.title}</h2>
              <p className="mt-1 text-sm leading-6 text-gray-600">{tool.body}</p>
            </Link>
          ))}
        </div>
      </main>
      <FooterSection />
    </>
  );
}
