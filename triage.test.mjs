import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

let server;
let baseUrl;

before(async () => {
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore",
  });

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const reply = await fetch(`${baseUrl}/`);
      if (reply.ok) return;
    } catch {
      // сервер ещё не слушает порт
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server did not start");
});

after(() => {
  server?.kill();
});

async function triage(body, alreadyEncoded = false) {
  const reply = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: alreadyEncoded ? body : JSON.stringify(body),
  });
  return { status: reply.status, body: await reply.json() };
}

test("обычный текст даёт тему и непустой черновик", async () => {
  const reply = await triage({ text: "Когда будет доставка?" });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.status, "ready");
  assert.equal(reply.body.topic, "delivery");
  assert.equal(typeof reply.body.draft, "string");
  assert.ok(reply.body.draft.trim().length > 0);
});

for (const marker of ["[timeout]", "[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
  test(`сбой ${marker} уходит на ручной разбор`, async () => {
    const reply = await triage({ text: `Заявка ${marker}` });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body, { status: "manual_review", topic: null, draft: null });
  });
}

test("некорректный ввод получает 400 invalid_input", async () => {
  const bodies = [
    JSON.stringify({}),
    JSON.stringify({ text: "" }),
    JSON.stringify({ text: "   " }),
    JSON.stringify({ text: 42 }),
    JSON.stringify({ text: null }),
    "это не JSON",
  ];
  for (const body of bodies) {
    const reply = await triage(body, true);
    assert.equal(reply.status, 400, body);
    assert.deepEqual(reply.body, { status: "invalid_input" }, body);
  }
});
