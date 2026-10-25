export const landingContent = {
  navbar: {
    brand: "StatChecker",
    links: [
      { label: "Single", href: "/single", emphasis: false },
      { label: "SGM", href: "/sgm", emphasis: false },
      { label: "Multi", href: "/multi", emphasis: false },
      { label: "Match context", href: "/afl/context", emphasis: false },
      { label: "Vault", href: "/vault", emphasis: true },
    ],
  },
};

export type LandingContent = typeof landingContent;
