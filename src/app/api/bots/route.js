export const runtime = "nodejs";

// ── État global partagé entre toutes les connexions ──────────────────────────
let initialized = false;
let botGains = [];
const clients = new Set();

function init() {
  if (initialized) return;
  initialized = true;

  botGains = Array(15)
    .fill(0)
    .map(() => parseFloat(((Math.random() * 0.1) - 0.05).toFixed(3)));

  for (let i = 0; i < 15; i++) {
    if (i !== 9) scheduleBot(i); // index 9 = Smart Rebalance (inactif)
  }
}

function scheduleBot(i) {
  const delay = (Math.random() * 59 + 1) * 1000; // 1s – 60s
  setTimeout(() => {
    const delta = parseFloat(((Math.random() * 0.1) - 0.05).toFixed(3));
    botGains[i] = parseFloat((botGains[i] + delta).toFixed(3));
    broadcast({ type: "update", botIndex: i, gain: botGains[i] });
    scheduleBot(i);
  }, delay);
}

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const send of clients) {
    try {
      send(msg);
    } catch {
      clients.delete(send);
    }
  }
}

// ── Route GET – SSE ───────────────────────────────────────────────────────────
export async function GET() {
  init();

  const encoder = new TextEncoder();
  let send;

  const stream = new ReadableStream({
    start(controller) {
      send = (msg) => controller.enqueue(encoder.encode(msg));
      clients.add(send);

      // Envoyer l'état initial au client qui vient de se connecter
      send(`data: ${JSON.stringify({ type: "init", gains: botGains })}\n\n`);
    },
    cancel() {
      clients.delete(send);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
