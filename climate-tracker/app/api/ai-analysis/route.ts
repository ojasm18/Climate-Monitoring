import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge";

export async function POST(req: NextRequest) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey === "your-openrouter-api-key-here") {
    return NextResponse.json(
      { error: "OPENROUTER_API_KEY is not configured. Add it to .env.local" },
      { status: 500 },
    );
  }

  const body = await req.json();
  const { messages } = body as { messages: { role: string; content: string }[] };

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://env-monitor.local",
      "X-Title": "ENV-MONITOR Climate Tracker",
    },
    body: JSON.stringify({
      model: "meta-llama/llama-3.1-8b-instruct",
      messages,
      stream: true,
      max_tokens: 1024,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    return NextResponse.json({ error: err }, { status: response.status });
  }

  // Stream directly back to the client
  return new Response(response.body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}
