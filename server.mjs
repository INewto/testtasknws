import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const TOPICS = new Set(["delivery", "pricing", "other"]);
const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function invalidInput(response) {
  return json(response, 400, { status: "invalid_input" });
}

function manualReview(response) {
  return json(response, 200, { status: "manual_review", topic: null, draft: null });
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function askModel(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    const raw = await classify(text, { signal: controller.signal });
    if (typeof raw !== "string") return null;

    const result = JSON.parse(raw);
    if (!result || typeof result !== "object" || Array.isArray(result)) return null;

    const { topic, draft } = result;
    if (!TOPICS.has(topic)) return null;
    if (typeof draft !== "string" || draft.trim() === "") return null;

    return { topic, draft };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function handleTriage(request, response) {
  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    return invalidInput(response);
  }

  const text = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload.text
    : undefined;
  if (typeof text !== "string" || text.trim() === "") return invalidInput(response);

  const result = await askModel(text);
  if (!result) return manualReview(response);

  return json(response, 200, { status: "ready", ...result });
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
}).listen(Number(process.env.PORT || 3000), "127.0.0.1");
