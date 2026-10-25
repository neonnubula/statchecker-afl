import Link from "next/link";
import { BrandLogo } from "@/components/BrandLogo";
import type { LandingContent } from "@/content";

export default function NavbarSection({ content }: { content: LandingContent["navbar"] }) {
  return (
    <header className="border-b border-black/10 bg-white/90 backdrop-blur">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link href="/" aria-label={`${content.brand} home`} className="text-gray-900">
          <BrandLogo />
        </Link>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          {content.links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={
                link.emphasis
                  ? "rounded-lg bg-gray-900 px-3 py-1.5 font-semibold text-white hover:bg-gray-800"
                  : "rounded-lg px-3 py-1.5 text-gray-700 hover:bg-gray-100"
              }
            >
              {link.label}
            </Link>
          ))}
        </div>
      </nav>
    </header>
  );
}
