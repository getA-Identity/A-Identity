#!/usr/bin/env node
// Re-checks every citation in scan/seeds/*.json against its live source.
//
//   node scan/check-citations.mjs                 all seeds (about 1 minute; longer if the NEAR
//                                                 forum rate-limits, it is paced and waited out)
//   node scan/check-citations.mjs --label suspicious
//   node scan/check-citations.mjs --account nearrewards.near
//   node scan/check-citations.mjs --json          machine-readable report on stdout
//
// For each evidence item it fetches the URL (GitHub permalinks as raw files, NEAR forum posts
// through Discourse's JSON, X posts through the public embed endpoint) and checks that the quote
// is in the page, comparing with whitespace removed and non-ASCII characters dropped (quotes are
// stored that way), and that the row's account id is on the page. Evidence that points at
// NearBlocks is checked against the chain instead, because NearBlocks pages need a browser:
//   txns/<hash>    the quote must be in the transaction as the FastNEAR transactions API returns
//                  it, rendered "signer <id> receiver <id> <method> <decoded args>", and the row's
//                  account must be in it (as signer or in the arguments), so a creation quote
//                  binds both who created and what was created
//   address/<id>   <id> must be the row's account, and the quote must be in its live ft_metadata
//                  (JSON-RPC)
// Read-only throughout. Exit code 1 if any item fails.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NearReader, asciiQuote, sleep } from "./lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const labelArg = args.includes("--label") ? args[args.indexOf("--label") + 1] : null;
const accountArg = args.includes("--account") ? args[args.indexOf("--account") + 1] : null;
const UA = "Mozilla/5.0 (compatible; a-identity-citation-check/0.1; read-only)";
const reader = new NearReader({ rpcGapMs: 200, txGapMs: 700 });

const squash = (s) => asciiQuote(s).replace(/\s+/g, "");
const stripHtml = (s) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&#8217;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

const lastHit = new Map();
async function politeGet(url, gapMs) {
  const host = new URL(url).host;
  const wait = (lastHit.get(host) ?? 0) + gapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastHit.set(host, Date.now());
  // Discourse answers an anonymous burst with 422 "performed this action too many times" and
  // keeps the limit for a few minutes, so the waits grow to several minutes before giving up.
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { headers: { "user-agent": UA }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (res.status === 429 || res.status === 422) {
      if (!JSON_OUT) console.error(`  ${host} rate limited, waiting ${60 * (attempt + 1)} s`);
      await sleep(60_000 * (attempt + 1));
      lastHit.set(host, Date.now());
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  }
  throw new Error("rate limited");
}

const pageCache = new Map();
async function sourceText(url) {
  const u = new URL(url);
  // GitHub permalink -> raw file.
  const gh = u.host === "github.com" && u.pathname.match(/^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  if (gh) return politeGet(`https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/${gh[3]}/${gh[4]}`, 300);
  // NEAR forum post -> Discourse topic JSON, then the one post (text plus its link targets).
  const forum = u.host === "gov.near.org" && u.pathname.match(/^\/t\/[^/]+\/(\d+)\/(\d+)/);
  if (forum) {
    const key = `forum:${forum[1]}`;
    if (!pageCache.has(key)) pageCache.set(key, JSON.parse(await politeGet(`https://gov.near.org/t/${forum[1]}.json`, 8000)));
    const post = pageCache.get(key).post_stream.posts.find((p) => p.post_number === Number(forum[2]));
    if (!post) throw new Error("post not found");
    return stripHtml(post.cooked) + " " + (post.cooked.match(/href="[^"]+"/g) ?? []).join(" ");
  }
  // X post -> public embed endpoint (no login).
  const x = /^(x|twitter)\.com$/.test(u.host) && u.pathname.match(/\/status\/(\d+)/);
  if (x) return JSON.parse(await politeGet(`https://cdn.syndication.twimg.com/tweet-result?id=${x[1]}&token=4`, 1000)).text ?? "";
  if (pageCache.has(url)) return pageCache.get(url);
  const raw = await politeGet(url, 1000);
  const text = /<html|<!doctype/i.test(raw.slice(0, 2000)) ? stripHtml(raw) + " " + (raw.match(/href="[^"]+"/g) ?? []).join(" ") : raw;
  pageCache.set(url, text);
  return text;
}

// NearBlocks links are for humans; the claim behind them is checked on chain. Returns the text
// the quote must be in, and whether the row's account is bound to the link.
async function chainText(url, accountId) {
  const u = new URL(url);
  const tx = u.pathname.match(/^\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})/);
  if (tx) {
    const [t] = await reader.transactions([tx[1]]);
    if (!t) throw new Error("transaction not found in the indexer");
    const actions = (t.transaction.actions ?? []).map((a) => (a.FunctionCall ? `${a.FunctionCall.method_name} ${Buffer.from(a.FunctionCall.args, "base64").toString("utf8")}` : JSON.stringify(a)));
    const text = `signer ${t.transaction.signer_id} receiver ${t.transaction.receiver_id} ${actions.join(" ")}`;
    return { text, idFound: squash(text).includes(squash(accountId)) };
  }
  const addr = u.pathname.match(/^\/address\/([a-z0-9_.-]+)$/);
  if (addr) {
    if (addr[1] !== accountId) return { text: "", idFound: false };
    const ft = await reader.callView(addr[1], "ft_metadata", {});
    if (!ft.ok) throw new Error(`ft_metadata: ${ft.error}`);
    return { text: JSON.stringify({ name: ft.value.name, symbol: ft.value.symbol }), idFound: true };
  }
  throw new Error("unsupported NearBlocks link");
}

async function main() {
  const files = [
    ["known_good", path.join(HERE, "seeds", "known-good.json")],
    ["suspicious", path.join(HERE, "seeds", "suspicious.json")],
  ].filter(([label]) => !labelArg || label === labelArg);
  const results = [];
  for (const [label, file] of files) {
    for (const seed of JSON.parse(fs.readFileSync(file, "utf8")).accounts) {
      if (accountArg && seed.account_id !== accountArg) continue;
      for (const ev of seed.evidence) {
        const row = { label, account_id: seed.account_id, url: ev.url, date: ev.date, ok: false };
        try {
          if (new URL(ev.url).host === "nearblocks.io") {
            const { text, idFound } = await chainText(ev.url, seed.account_id);
            row.quote_found = squash(text).includes(squash(ev.quote));
            row.id_found = idFound;
          } else {
            const hay = squash(await sourceText(ev.url));
            row.quote_found = hay.includes(squash(ev.quote));
            // Most quotes contain the account id; when one does not (an article linking the
            // id), the id must still be on the page.
            row.id_found = hay.includes(squash(seed.account_id));
          }
          row.ok = row.quote_found && row.id_found;
        } catch (err) {
          row.error = err.message;
        }
        results.push(row);
        if (!JSON_OUT) console.log(`${row.ok ? "PASS" : "FAIL"} ${label} ${seed.account_id.slice(0, 40)} <- ${ev.url}${row.error ? ` (${row.error})` : row.ok ? "" : ` (quote ${row.quote_found ? "ok" : "missing"}, id ${row.id_found ? "ok" : "missing"})`}`);
      }
    }
  }
  const failed = results.filter((r) => !r.ok);
  const report = { checked_at: new Date().toISOString(), items: results.length, passed: results.length - failed.length, failed: failed.length, results };
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
  else console.log(`\n${report.passed}/${report.items} citations verified${failed.length ? `, ${failed.length} failed` : ""}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
