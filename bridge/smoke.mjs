// Fake plugin: connects to a running bridge, starts a one-turn session and answers the tool call it triggers.
// Costs a couple of cents. Run with the bridge up: `FIGMA_REVIEW_MODEL=haiku npm run bridge` then `npm run smoke -w bridge`.
const ws = new WebSocket("ws://127.0.0.1:3055");
const seen = [];
const done = why => { console.log(`\n${why}`); for (const s of seen) console.log(" ", s); process.exit(why === "ok" ? 0 : 1); };
setTimeout(() => done("timeout"), 120_000);

ws.addEventListener("open", () => {
  ws.send(JSON.stringify({ kind: "hello", fileId: "smoke", fileName: "Smoke file" }));
  setTimeout(() => ws.send(JSON.stringify({
    kind: "start", fileId: "smoke", fileName: "Smoke file", pageId: "0:1", pageName: "Page 1", anchor: { type: "page", nodeIds: [] },
    text: "Call the focus tool with nodeId 1:2, then reply with the single word OK.", selection: [{ id: "1:2", name: "Login", type: "FRAME" }],
  })), 3000);
});
ws.addEventListener("message", e => {
  const m = JSON.parse(e.data);
  if (m.kind === "tool") {
    seen.push(`tool call ${m.tool} ${JSON.stringify(m.args)}`);
    ws.send(JSON.stringify({ kind: "reply", id: m.id, result: { content: [{ type: "text", text: 'Focused "Login" (FRAME 1:2)' }] } }));
  }
  if (m.kind === "health") seen.push(`health claude=${m.health.claude ?? "-"} figmaMcp=${m.health.figmaMcp} ${(m.health.servers ?? []).map(s => `${s.name}:${s.status}`).join(" ")}`);
  if (m.kind === "session" && m.session.turns) seen.push(`session $${m.session.costUsd.toFixed(4)} ${JSON.stringify(m.session.usage)}`);
  if (m.kind === "sdk" && m.msg.type === "assistant") for (const b of m.msg.message.content) if (b.type === "text") seen.push(`assistant: ${b.text}`);
  if (m.kind === "sdk" && m.msg.type === "result") setTimeout(() => done(m.msg.is_error || !seen.some(s => s.startsWith("tool call focus")) ? "failed" : "ok"), 300);
  if (m.kind === "error") seen.push(`error: ${m.message}`);
});
