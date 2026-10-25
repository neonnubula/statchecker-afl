import type { Metadata } from "next";
import AflMatchContext from "@/components/afl/AflMatchContext";
import { loadAflContext } from "@/lib/afl-context";
import { getApiBaseUrl } from "@/lib/api/config";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const metadata: Metadata = { title: "AFL Match Context | StatChecker" };

export default async function AflContextPage() {
  const data = await loadAflContext({ fetch, baseUrl: getApiBaseUrl(), secret: process.env.INTERNAL_API_SECRET });
  return <AflMatchContext data={data} renderedAt={Date.now()} />;
}
