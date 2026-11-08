#!/usr/bin/env node
/**
 * Realtime smoke test through the local proxy.
 *
 * Streams fixtures/test-ru.wav (or SMOKE_AUDIO) as linear16 PCM, then checks:
 *   - a non-empty final transcript arrived
 *   - the final transcript is at least as long as the longest interim (no truncation)
 *   - at least SMOKE_MIN_WORDS words were produced
 *
 * The transcript text is never printed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { HttpsProxyAgent } from "https-proxy-agent";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const caPath = process.env.CA_CRT || join(root, "certs", "ca.crt");

// The WebSocket TLS handshake must trust the local CA. Re-exec once with
// NODE_EXTRA_CA_CERTS so `ws` and https-proxy-agent pick it up.
if (!process.env.NODE_EXTRA_CA_CERTS) {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
    stdio: "inherit",
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caPath },
  });
  process.exit(child.status ?? 1);
}

const proxyHost = process.env.PROXY_HOST || "127.0.0.1";
const proxyPort = process.env.PROXY_PORT || "8443";
const model = process.env.SMOKE_MODEL || "nova-3";
const language = process.env.SMOKE_LANGUAGE || "ru";
const audioPath = process.env.SMOKE_AUDIO || join(root, "fixtures", "test-ru.wav");
const minWords = Number(process.env.SMOKE_MIN_WORDS || 8);
const longMode = process.env.SMOKE_LONG === "1";

function pcmFromWav(path) {
  const wav = readFileSync(path);
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }
  return wav.subarray(44);
}

function normalizedWords(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

// The long fixture is the same phrase twice with a 2 s pause. Requiring a
// repeated normalized n-gram proves the second phrase survived, without
// printing or embedding transcript text.
function hasRepeatedPhrase(words, length = 6) {
  for (let start = 0; start + length * 2 <= words.length; start += 1) {
    const phrase = words.slice(start, start + length).join(" ");
    for (let next = start + length; next + length <= words.length; next += 1) {
      if (words.slice(next, next + length).join(" ") === phrase) return true;
    }
  }
  return false;
}

const basePcm = pcmFromWav(audioPath);

// Optionally insert a 2 second pause and repeat the phrase to exercise Soniox's
// sliding token window (the case that used to truncate text before a pause).
const pcm = longMode
  ? Buffer.concat([basePcm, Buffer.alloc(32000 * 2), basePcm])
  : basePcm;

const agent = new HttpsProxyAgent(`http://${proxyHost}:${proxyPort}`);
const url =
  `wss://api.deepgram.com/v1/listen?encoding=linear16&sample_rate=16000&channels=1` +
  `&model=${encodeURIComponent(model)}&language=${encodeURIComponent(language)}` +
  `&interim_results=true&smart_format=true`;

const ws = new WebSocket(url, { agent });
let finalText = "";
let interimText = "";
let maxInterim = 0;
const finals = [];
let metadata = 0;

const timer = setTimeout(() => {
  console.error("realtime smoke: timeout");
  try {
    ws.close();
  } catch {
    // ignore
  }
  process.exit(1);
}, 60_000);

ws.on("open", async () => {
  for (let i = 0; i < pcm.length; i += 342) {
    ws.send(pcm.subarray(i, Math.min(i + 342, pcm.length)));
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 10));
  }
  ws.send(JSON.stringify({ type: "CloseStream" }));
});

ws.on("message", (data) => {
  let message;
  try {
    message = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (message.type === "Metadata") {
    metadata += 1;
    return;
  }
  if (message.type !== "Results") return;
  const transcript = message.channel?.alternatives?.[0]?.transcript ?? "";
  if (message.is_final) {
    finals.push(transcript.length);
    if (transcript) finalText += `${finalText && transcript ? " " : ""}${transcript}`;
    interimText = "";
  } else {
    interimText = transcript;
    maxInterim = Math.max(maxInterim, transcript.length);
  }
});

ws.on("close", () => {
  clearTimeout(timer);
  const words = finalText.split(/\s+/).filter(Boolean).length;
  const repeatedPhrase = hasRepeatedPhrase(normalizedWords(finalText));
  const ok =
    finalText.length > 0 &&
    finalText.length >= maxInterim &&
    words >= minWords &&
    metadata > 0 &&
    (!longMode || repeatedPhrase);
  console.log(
    JSON.stringify(
      {
        ok,
        final_length: finalText.length,
        final_words: words,
        max_interim_length: maxInterim,
        finals,
        metadata_messages: metadata,
        repeated_phrase: repeatedPhrase,
        mode: longMode ? "long-with-pause" : "short",
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
});

ws.on("error", (error) => {
  clearTimeout(timer);
  console.error(`realtime smoke: ${error.message}`);
  process.exit(1);
});
