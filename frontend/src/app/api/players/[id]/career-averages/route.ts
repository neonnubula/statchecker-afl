import { getApiBaseUrl } from "@/lib/api/config";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!/^\d{1,12}$/.test(id)) {
    return Response.json({ detail: "Invalid player" }, { status: 400 });
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.INTERNAL_API_SECRET) {
    headers["x-internal-secret"] = process.env.INTERNAL_API_SECRET;
  }

  const backendResponse = await fetch(`${getApiBaseUrl()}/players/${id}/career-averages`, {
    method: "GET",
    headers,
  });

  return new Response(await backendResponse.text(), {
    status: backendResponse.status,
    headers: {
      "Content-Type":
        backendResponse.headers.get("content-type") ?? "application/json",
    },
  });
}
