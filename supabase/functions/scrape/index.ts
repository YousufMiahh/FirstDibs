// @ts-nocheck
// First Dibs scraper. Runs on a schedule (pg_cron) and from the "Check now" button.
// 1. Reads every user's criteria  2. Fetches the matching pages  3. Saves new vacancies
// 4. Records a match per user     5. Emails each user their new matches
import { createClient } from "npm:@supabase/supabase-js@2";

const FAA = "https://www.findapprenticeship.service.gov.uk";
const UA = "FirstDibsBot/1.0 (personal apprenticeship alerts)";
const PAGES_PER_SEARCH = 2;   // 10 vacancies a page, newest first
const MAX_SEARCHES = 40;      // per run
const MAX_DETAILS = 20;       // job descriptions fetched per run
const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

/* ---------- text helpers ---------- */
function decode(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "’").replace(/&pound;|&#163;/g, "£")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
function toLines(html) {
  return decode(String(html || "")
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, "\n"))
    .split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
}
function isoDate(text) {
  const m = /(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/.exec(text || "");
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (!mo) return null;
  return m[3] + "-" + String(mo).padStart(2, "0") + "-" + String(m[1]).padStart(2, "0");
}
function dayOffset(n) { return new Date(Date.now() + n * 86400000).toISOString().slice(0, 10); }
async function sha(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 20);
}
async function getPage(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html" }, signal: ctl.signal, redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally { clearTimeout(t); }
}
async function pool(items, size, fn) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) { const it = queue.shift(); try { await fn(it); } catch (_) { /* one bad page shouldn't stop the run */ } }
  }));
}

/* ---------- Find an apprenticeship (England) ---------- */
function faaUrl(route, location, distance, page) {
  let u = FAA + "/apprenticeships?sort=AgeAsc&searchTerm=&routeIds=" + route;
  if (location) u += "&location=" + encodeURIComponent(location) + "&distance=" + (distance || 20);
  if (page > 1) u += "&pageNumber=" + page;
  return u;
}
export function parseFaa(html) {
  const re = /<a\b[^>]*href=["']([^"']*\/apprenticeship\/(VAC\d+))[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi;
  const hits = [];
  let m;
  while ((m = re.exec(html))) hits.push({ ref: m[2], title: toLines(m[3]).join(" "), end: re.lastIndex, start: m.index });
  const out = [], seen = {};
  hits.forEach((h, i) => {
    if (!h.title || seen[h.ref]) return;
    seen[h.ref] = 1;
    const seg = html.slice(h.end, i + 1 < hits.length ? hits[i + 1].start : h.end + 5000);
    const lines = toLines(seg).filter((l) => !/^(new|closing soon|disability confident)$/i.test(l));
    const text = lines.join("\n");
    const labels = /^(start date|training course|wage|closes|posted)\b/i;
    const head = [];
    for (const l of lines) { if (labels.test(l)) break; head.push(l); }
    const course = /Training course\s+([\s\S]+?)\s*\(level\s*(\d)\)/i.exec(text);
    const wage = /Wage\s+([^\n]+)/i.exec(text);
    const closesLine = /Closes[^\n]*/i.exec(text);
    let closes = closesLine ? isoDate(closesLine[0]) : null;
    if (!closes && closesLine) closes = /today/i.test(closesLine[0]) ? dayOffset(0) : /tomorrow/i.test(closesLine[0]) ? dayOffset(1) : null;
    const posted = /Posted\s+([^\n]+)/i.exec(text);
    out.push({
      id: "faa:" + h.ref, source: "Find an apprenticeship", title: h.title.slice(0, 200),
      employer: (head[0] || "").slice(0, 150), location: (head[1] || "").slice(0, 150),
      course: course ? course[1].replace(/\s+/g, " ").slice(0, 200) : "", level: course ? Number(course[2]) : null,
      wage: wage ? wage[1].slice(0, 80) : "", closes, posted: posted ? isoDate(posted[1]) : null,
      url: FAA + "/apprenticeship/" + h.ref,
    });
  });
  return out;
}
export function parseDescription(html) {
  const main = /<main\b[\s\S]*?<\/main>/i.exec(html);
  const lines = toLines(main ? main[0] : html);
  const stop = lines.findIndex((l) => /^(report this vacancy|support links|company benefits disclaimer)/i.test(l));
  return (stop > 0 ? lines.slice(0, stop) : lines).join("\n").slice(0, 7000);
}

/* ---------- any other site: watch a page for new links ---------- */
const JUNK = /^(home|about|contact|log ?in|sign ?in|sign out|register|privacy|cookie|change (your )?cookie|terms|accessibility|skip to|next|previous|back|map view|list view|email me|how to|help|faq|search|filter|sort|view all|show more|load more|menu|share|print|feedback|report)\b/i;
export function parseLinks(html, base) {
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const host = new URL(base).hostname, out = [], seen = {};
  let m;
  while ((m = re.exec(html))) {
    let u;
    try { u = new URL(decode(m[1]), base); } catch (_) { continue; }
    if (!/^https?:$/.test(u.protocol) || u.hostname !== host) continue;
    u.hash = "";
    const text = toLines(m[2]).join(" ").slice(0, 180);
    if (text.length < 8 || seen[u.href] || u.href === base) continue;
    if (JUNK.test(text) || /\/(cookies?|privacy|terms|accessibility|login|sign-?in|register|form)[\/-]?/i.test(u.pathname)) continue;
    seen[u.href] = 1;
    out.push({ url: u.href, text });
  }
  return out;
}

/* ---------- matching ---------- */
// Words that place a vacancy from an added site into one of the job categories.
const SECTOR_WORDS = {
  1: ["agricultur", "farm", "animal", "horticultur", "garden", "landscap", "forestry", "environment", "veterinar", "groundskeep", "equine"],
  2: ["business admin", "administrat", "admin ", "office", "receptionist", "hr ", "human resources", "project", "customer service", "operations", "team leader", "data entry"],
  3: ["care ", "carer", "care worker", "support worker", "residential", "social care", "health and social", "health & social", "wellbeing", "domiciliary", "nursing home"],
  4: ["chef", "catering", "hospitality", "kitchen", "commis", "hotel", "restaurant", "barista", "food", "front of house"],
  5: ["construction", "bricklay", "carpent", "joiner", "plumb", "electrician", "electrical install", "plaster", "roofer", "scaffold", "groundwork", "surveyor", "civil engineer", "site manager", "painter", "decorat", "heating", "gas engineer"],
  6: ["creative", "design", "media", "content", "video", "photograph", "graphic", "broadcast", "journalis", "games art", "animation"],
  7: ["digital", "ict", "it ", "it-", "software", "developer", "programm", "coding", "data", "cyber", "network", "infrastructure", "technician", "technology", "tech ", "computing", "cloud", "devops", "web ", "systems", "1st line", "2nd line", "service desk", "help desk", "helpdesk"],
  8: ["teaching", "teacher", "classroom", "school", "childcare", "early years", "nursery", "education", "learning support", "play worker"],
  9: ["engineer", "manufactur", "mechanic", "mechanical", "electrical", "maintenance", "fabricat", "welder", "welding", "machinist", "cnc", "toolmak", "production", "automotive", "motor vehicle", "aerospace"],
  10: [" hair", "barber", "beauty", "nail", "salon", "spa ", "cosmetolog"],
  11: ["health", "nhs", "clinical", "pharmacy", "dental", "laborator", "science", "scientist", "nursing", "healthcare", "physiotherap", "optical"],
  12: ["legal", "law", "solicitor", "paralegal", "finance", "accounting", "accounts", "accountant", "payroll", "bookkeep", "audit", "tax", "banking", "insurance"],
  13: ["police", " fire", "security", "armed forces", "army", "navy", "raf", "prison", "custodial", "emergency"],
  14: ["sales", "marketing", "retail", "social media", "business development", "advertis", "seo", "pr ", "public relations", "account executive", "merchandis"],
  15: ["transport", "logistics", "warehouse", "driver", "driving", "hgv", "lgv", "supply chain", " rail", "aviation", "freight", "courier", "fleet", " port "],
};
export function sectorFits(text, sectors) {
  if (!sectors || !sectors.length) return true;
  const hay = " " + String(text || "").toLowerCase().replace(/[^a-z0-9&]+/g, " ") + " ";
  const pattern = (w) => (w.length <= 3 && !w.includes(" ")) ? " " + w + " " : (w.endsWith(" ") && !w.startsWith(" ")) ? " " + w : w;
  return sectors.some((id) => (SECTOR_WORDS[id] || []).some((w) => hay.includes(pattern(w))));
}
export function fits(listing, profile) {
  const levels = profile.levels || [];
  if (levels.length && listing.level && !levels.includes(listing.level)) return false;
  const words = String(profile.keywords || "").toLowerCase().split(",").map((w) => w.trim()).filter(Boolean);
  if (!words.length) return true;
  const hay = (listing.title + " " + listing.course + " " + listing.employer).toLowerCase();
  return words.some((w) => hay.includes(w));
}

/* ---------- email ---------- */
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function niceDate(iso) { return iso ? new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" }) : ""; }
async function sendEmail(to, subject, html, text) {
  const from = Deno.env.get("MAIL_FROM") || "";
  const resend = Deno.env.get("RESEND_API_KEY"), brevo = Deno.env.get("BREVO_API_KEY");
  if (!from || (!resend && !brevo)) throw new Error("Email isn't set up: add MAIL_FROM and BREVO_API_KEY or RESEND_API_KEY");
  let res;
  if (brevo) {
    const m = /^(.*?)<([^>]+)>\s*$/.exec(from);
    const sender = m ? { name: m[1].trim() || "First Dibs", email: m[2].trim() } : { name: "First Dibs", email: from.trim() };
    res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST", headers: { "api-key": brevo, "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
    });
  } else {
    res = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { "Authorization": "Bearer " + resend, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text }),
    });
  }
  if (!res.ok) throw new Error("Email provider said " + res.status + ": " + (await res.text()).slice(0, 200));
}
function buildEmail(rows) {
  const site = Deno.env.get("SITE_URL") || "";
  const n = rows.length;
  const subject = n === 1 ? "New apprenticeship: " + rows[0].title : n + " new apprenticeships for you";
  const items = rows.map((l) => {
    const facts = [l.employer, l.location, l.level ? "Level " + l.level : "", l.wage, l.closes ? "closes " + niceDate(l.closes) : ""].filter(Boolean);
    return { l, facts };
  });
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#0F1B3D;max-width:560px">' +
    "<p>" + (n === 1 ? "One new apprenticeship matches" : n + " new apprenticeships match") + " what you’re after.</p>" +
    items.map((x) => '<p style="margin:0 0 16px"><a href="' + esc(x.l.url) + '" style="color:#2440E6;font-weight:bold">' + esc(x.l.title) + "</a><br>" + esc(x.facts.join(", ")) + "</p>").join("") +
    (site ? '<p><a href="' + esc(site) + '" style="color:#2440E6">Open First Dibs</a> to apply with Claude.</p>' : "") +
    '<p style="color:#56617F;font-size:13px">You’re getting this because email alerts are on in your First Dibs settings.</p></div>';
  const text = items.map((x) => x.l.title + "\n" + x.facts.join(", ") + "\n" + x.l.url).join("\n\n") + (site ? "\n\nOpen First Dibs: " + site : "");
  return { subject, html, text };
}

/* ---------- the run ---------- */
async function run(db, onlyUser) {
  let q = db.from("profiles").select("*");
  if (onlyUser) q = q.eq("id", onlyUser);
  const { data: profiles, error: pErr } = await q;
  if (pErr) throw pErr;

  const listings = new Map();          // id -> listing
  const wanted = [];                   // {user_id, listing_id, sector}
  const problems = [];

  // 1. Find an apprenticeship: one search per distinct (category, place, distance)
  const searches = new Map();
  for (const p of profiles || []) {
    for (const route of p.sectors || []) {
      const loc = String(p.location || "").trim();
      const key = route + "|" + loc.toLowerCase() + "|" + (loc ? p.distance || 20 : 0);
      if (!searches.has(key)) searches.set(key, { route, loc, distance: p.distance || 20, users: [], ids: [] });
      searches.get(key).users.push(p);
    }
  }
  const jobs = [];
  for (const s of Array.from(searches.values()).slice(0, MAX_SEARCHES)) for (let pg = 1; pg <= PAGES_PER_SEARCH; pg++) jobs.push({ s, pg });
  let faaFailed = 0;
  await pool(jobs, 4, async (job) => {
    try {
      const found = parseFaa(await getPage(faaUrl(job.s.route, job.s.loc, job.s.distance, job.pg)));
      for (const l of found) { listings.set(l.id, l); job.s.ids.push(l.id); }
    } catch (e) { faaFailed++; throw e; }
  });
  if (jobs.length && faaFailed === jobs.length) problems.push("Find an apprenticeship couldn't be read");
  for (const s of searches.values()) {
    for (const p of s.users) for (const id of s.ids) {
      if (fits(listings.get(id), p)) wanted.push({ user_id: p.id, listing_id: id, sector: s.route });
    }
  }

  // 2. Sites users added themselves: report links that weren't on the page before
  let sq = db.from("sites").select("*").eq("enabled", true);
  if (onlyUser) sq = sq.eq("user_id", onlyUser);
  const { data: sites } = await sq;
  await pool(sites || [], 3, async (site) => {
    const patch = { last_checked: new Date().toISOString(), last_error: null, last_count: 0 };
    try {
      const links = parseLinks(await getPage(site.url), site.url);
      patch.last_count = links.length;
      const { data: known } = await db.from("site_links").select("url").eq("site_id", site.id);
      const have = new Set((known || []).map((k) => k.url));
      const fresh = links.filter((l) => !have.has(l.url));
      if (fresh.length) await db.from("site_links").upsert(fresh.map((l) => ({ site_id: site.id, url: l.url })), { onConflict: "site_id,url", ignoreDuplicates: true });
      // First visit: only surface links that plainly are apprenticeships. After that: anything new.
      const owner = (profiles || []).find((p) => p.id === site.user_id) || {};
      const pathOf = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/[-_/]+/g, " "); } catch (_) { return ""; } };
      const looksLikeVacancy = (l) => /apprentic|trainee|vacanc|job|role|position/i.test(l.text + " " + pathOf(l.url));
      const report = fresh
        .filter((l) => site.baselined || looksLikeVacancy(l))
        .filter((l) => sectorFits(l.text + " " + pathOf(l.url), owner.sectors || []))
        .filter((l) => fits({ title: l.text, course: pathOf(l.url), employer: "", level: null }, { levels: [], keywords: owner.keywords || "" }));
      for (const l of report.slice(0, 25)) {
        const id = "web:" + (await sha(l.url));
        listings.set(id, { id, source: site.name, title: l.text, employer: site.name, location: "", course: "", level: null, wage: "", closes: null, posted: null, url: l.url });
        wanted.push({ user_id: site.user_id, listing_id: id, sector: null });
      }
      patch.baselined = true;
      if (!links.length) patch.last_error = "No links found. The page may load its vacancies with JavaScript, which can't be read.";
    } catch (e) { patch.last_error = "Couldn't open the page (" + String(e.message || e).slice(0, 80) + ")"; }
    await db.from("sites").update(patch).eq("id", site.id);
  });

  // 3. Save vacancies we haven't seen, with their job descriptions
  const ids = Array.from(listings.keys());
  const existing = new Set();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from("listings").select("id").in("id", ids.slice(i, i + 200));
    (data || []).forEach((r) => existing.add(r.id));
  }
  const fresh = ids.filter((id) => !existing.has(id)).map((id) => listings.get(id));
  await pool(fresh.filter((l) => l.id.startsWith("faa:")).slice(0, MAX_DETAILS), 4, async (l) => { l.description = parseDescription(await getPage(l.url)); });
  for (let i = 0; i < fresh.length; i += 100) {
    const { error } = await db.from("listings").upsert(fresh.slice(i, i + 100), { onConflict: "id", ignoreDuplicates: true });
    if (error) throw error;
  }

  // 4. Record matches (one per user per vacancy; repeats are ignored)
  const uniq = new Map();
  for (const w of wanted) uniq.set(w.user_id + "|" + w.listing_id, w);
  const rows = Array.from(uniq.values());
  let added = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const { data, error } = await db.from("matches").upsert(rows.slice(i, i + 200), { onConflict: "user_id,listing_id", ignoreDuplicates: true }).select("listing_id");
    if (error) throw error;
    added += (data || []).length;
  }

  // 5. Email anything not yet sent
  let emailed = 0;
  for (const p of profiles || []) {
    const { data: due } = await db.from("matches").select("listing_id, listing:listings(*)").eq("user_id", p.id).is("notified_at", null).eq("status", "new").order("created_at", { ascending: false }).limit(25);
    if (!due || !due.length) continue;
    const stamp = () => db.from("matches").update({ notified_at: new Date().toISOString() }).eq("user_id", p.id).is("notified_at", null);
    if (!p.email_alerts || !p.email) { await stamp(); continue; }
    try {
      const mail = buildEmail(due.map((d) => d.listing).filter(Boolean));
      await sendEmail(p.email, mail.subject, mail.html, mail.text);
      await stamp(); emailed++;
    } catch (e) { problems.push(String(e.message || e).slice(0, 160)); }
  }

  const summary = { last_run: new Date().toISOString(), found: ids.length, fresh: added, error: problems.length ? problems.join("; ") : null };
  if (!onlyUser) await db.from("status").upsert({ id: 1, ...summary });
  return { ...summary, emailed };
}

/* ---------- HTTP entry ---------- */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret", "Access-Control-Allow-Methods": "POST, OPTIONS" };
function reply(body, status) { return new Response(JSON.stringify(body), { status: status || 200, headers: { ...CORS, "Content-Type": "application/json" } }); }

if (typeof Deno !== "undefined" && Deno.serve) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    const db = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
    let onlyUser = null;
    const secret = req.headers.get("x-cron-secret"), want = Deno.env.get("CRON_SECRET");
    if (!(secret && want && secret === want)) {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data, error } = await db.auth.getUser(token);
      if (error || !data || !data.user) return reply({ error: "Sign in first" }, 401);
      onlyUser = data.user.id;
    }
    try { return reply(await run(db, onlyUser)); }
    catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      if (!onlyUser) await db.from("status").upsert({ id: 1, last_run: new Date().toISOString(), error: msg });
      return reply({ error: msg }, 500);
    }
  });
}
