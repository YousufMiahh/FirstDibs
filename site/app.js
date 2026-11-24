(function () {
"use strict";

/* ---------- reference data ---------- */
// Job categories on Find an apprenticeship; the number is the site's own category id.
var SECTORS = [[1,"Agriculture, environment & animal care"],[2,"Business & administration"],[3,"Care services"],[4,"Catering & hospitality"],
  [5,"Construction & building"],[6,"Creative & design"],[7,"Digital"],[8,"Education & early years"],[9,"Engineering & manufacturing"],
  [10,"Hair & beauty"],[11,"Health & science"],[12,"Legal, finance & accounting"],[13,"Protective services"],[14,"Sales & marketing"],[15,"Transport & logistics"]];
var LEVELS = [[2,"Level 2 (GCSE)"],[3,"Level 3 (A level)"],[4,"Level 4"],[5,"Level 5"],[6,"Level 6 (degree)"],[7,"Level 7 (master’s)"]];
var STATUSES = [["shortlisted","Shortlisted"],["applied","Applied"],["interview","Interview"],["offer","Offer"],["closed","Didn’t work out"]];
// One-tap sites for Settings. Each address was checked to be readable by the scraper.
var WATCHLIST = [
  ["nhs", "NHS Jobs", "https://www.jobs.nhs.uk/candidate/search/results?keyword=apprentice&sort=publicationDateDesc"],
  ["gmfj", "GetMyFirstJob", "https://www.getmyfirstjob.co.uk/search"],
  ["reed", "Reed apprenticeships", "https://www.reed.co.uk/jobs/apprenticeship-jobs"],
  ["wales", "Wales (government)", "https://findanapprenticeship.service.gov.wales/find-apprenticeship"],
  ["rail", "Network Rail", "https://www.networkrail.co.uk/careers/early-careers/apprenticeships/"],
  ["sky", "Sky", "https://careers.sky.com/earlycareers/apprenticeships/"],
  ["bt", "BT Group", "https://jobs.bt.com/content/Apprentices/"],
  ["kpmg", "KPMG", "https://www.kpmgcareers.co.uk/apprentice/"],
  ["gchq", "GCHQ", "https://www.gchq-careers.co.uk/early-careers/apprenticeships.html"]
];
var PROMPT_LIMIT = 13000; // Claude Desktop cuts prefilled prompts at roughly 14,000 characters

var CFG = window.FIRST_DIBS || {};
var sb = null, user = null;
var S = { profile: null, matches: [], sites: [], status: null };
var ui = { tab: "board", view: "new", checking: false, authMode: "in", sort: "posted", level: "", within: "", q: "", recover: false, openNotes: {} };
var GEO = {}; // postcode -> [lat, lon], or null when it can’t be found

/* ---------- helpers ---------- */
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
function label(list, id) { for (var i = 0; i < list.length; i++) if (String(list[i][0]) === String(id)) return list[i][1]; return ""; }
function ago(t) {
  var m = Math.round((Date.now() - new Date(t).getTime()) / 60000);
  if (m < 1) return "just now"; if (m < 60) return m + " min ago";
  var h = Math.round(m / 60); if (h < 24) return h + (h === 1 ? " hour ago" : " hours ago");
  var d = Math.round(h / 24); return d + (d === 1 ? " day ago" : " days ago");
}
function closing(iso) {
  if (!iso) return null;
  var n = Math.ceil((Date.parse(iso + "T23:59:59") - Date.now()) / 86400000);
  var nice = new Date(iso + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  if (n < 0) return { text: "Closed " + nice, soon: true };
  if (n === 0) return { text: "Closes today", soon: true };
  if (n <= 7) return { text: "Closes in " + n + (n === 1 ? " day" : " days") + " (" + nice + ")", soon: true };
  return { text: "Closes " + nice, soon: false };
}
var toastT;
function toast(msg) { var t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(function () { t.hidden = true; }, 3800); }
function show(id, on) { $(id).hidden = !on; }

/* ---------- postcodes, distance and pay ---------- */
var PC = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/i;
function postcodeOf(text) { var m = PC.exec(String(text || "")); return m ? (m[1] + m[2]).toUpperCase() : ""; }
function validPostcode(text) { return /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(String(text || "").trim()); }
function milesBetween(a, b) {
  var R = 3958.8, rad = Math.PI / 180, dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
function distanceTo(l) {
  var home = GEO[postcodeOf(S.profile && S.profile.postcode)], there = GEO[postcodeOf(l.location)];
  return home && there ? milesBetween(home, there) : null;
}
// Yearly pay as a number, from text like "£24,000 a year", "£15,600 to £18,000 a year" or "£7.55 an hour".
function payOf(text) {
  var m = /£\s*([\d,]+(?:\.\d+)?)/.exec(String(text || "")); if (!m) return null;
  var v = parseFloat(m[1].replace(/,/g, "")); if (!isFinite(v)) return null;
  if (/hour/i.test(text)) v *= 37.5 * 52; else if (/week/i.test(text)) v *= 52; else if (/month/i.test(text)) v *= 12;
  return v;
}
// Look up any postcodes we haven't seen yet (free postcodes.io service), then redraw.
async function loadGeo() {
  try { var saved = JSON.parse(localStorage.getItem("fd-geo") || "{}"); Object.keys(saved).forEach(function (k) { if (!(k in GEO)) GEO[k] = saved[k]; }); } catch (e) {}
  var want = {}; var home = postcodeOf(S.profile && S.profile.postcode); if (home) want[home] = 1;
  S.matches.forEach(function (m) { var pc = postcodeOf(m.listing.location); if (pc) want[pc] = 1; });
  var need = Object.keys(want).filter(function (k) { return !(k in GEO); });
  for (var i = 0; i < need.length; i += 100) {
    try {
      var res = await fetch("https://api.postcodes.io/postcodes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ postcodes: need.slice(i, i + 100) }) });
      var data = await res.json();
      (data.result || []).forEach(function (r) { GEO[String(r.query).replace(/\s+/g, "").toUpperCase()] = r.result ? [r.result.latitude, r.result.longitude] : null; });
    } catch (e) { break; }
  }
  try { localStorage.setItem("fd-geo", JSON.stringify(GEO)); } catch (e) {}
  if (need.length) renderBoard();
}

/* ---------- auth ---------- */
async function boot() {
  if (!window.supabase || !CFG.url || /YOUR-/.test(CFG.url) || !CFG.key || /YOUR-/.test(CFG.key)) {
    show("setup", true); return;
  }
  ui.recover = /type=recovery/.test(location.hash);
  sb = window.supabase.createClient(CFG.url, CFG.key);
  var got = await sb.auth.getSession();
  await enter(got.data && got.data.session ? got.data.session.user : null);
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === "PASSWORD_RECOVERY") { ui.recover = true; show("app", false); show("auth", true); setAuthMode("reset"); return; }
    var next = session ? session.user : null;
    if ((next && next.id) !== (user && user.id)) setTimeout(function () { enter(next); }, 0);
  });
}
async function enter(u) {
  user = u;
  show("auth", !u); show("app", !!u);
  if (u && ui.recover) { show("app", false); show("auth", true); setAuthMode("reset"); return; }
  if (!u) { setAuthMode(ui.authMode === "reset" ? "in" : ui.authMode); return; }
  $("whoami").textContent = u.email || "";
  await loadAll();
  var p = S.profile;
  if (p && !(p.sectors || []).length) { setTab("settings"); toast("Pick what you’re after to get started"); }
}
function setAuthMode(mode) {
  ui.authMode = mode;
  var T = { "in": ["Sign in", "Sign in"], up: ["Create your account", "Create account"], forgot: ["Reset your password", "Email me a reset link"], reset: ["Choose a new password", "Save new password"] }[mode];
  $("authTitle").textContent = T[0]; $("authBtn").textContent = T[1];
  $("nameField").hidden = mode !== "up"; $("postcodeField").hidden = mode !== "up";
  $("emailField").hidden = mode === "reset"; $("passField").hidden = mode === "forgot";
  $("passHint").hidden = !(mode === "up" || mode === "reset");
  $("authPass").setAttribute("autocomplete", mode === "in" ? "current-password" : "new-password");
  $("authSwitch").innerHTML = mode === "in"
    ? 'New here? <button type="button" data-act="authMode" data-id="up">Create an account</button><br><button type="button" data-act="authMode" data-id="forgot">Forgot your password?</button>'
    : mode === "reset" ? "" : 'Already have an account? <button type="button" data-act="authMode" data-id="in">Sign in</button>';
  $("authMsg").className = "state"; $("authMsg").textContent = "";
  (mode === "up" ? $("authName") : mode === "reset" ? $("authPass") : $("authEmail")).focus();
}
async function authGo() {
  var mode = ui.authMode, up = mode === "up";
  var name = $("authName").value.trim().replace(/\s+/g, " ");
  var postcode = $("authPostcode").value.trim().toUpperCase().replace(/\s+/g, " ");
  var email = $("authEmail").value.trim(), pass = $("authPass").value, msg = $("authMsg");
  msg.className = "state"; msg.textContent = "";
  function bad(t) { msg.className = "state bad"; msg.textContent = t; }
  if (up && name.length < 2) return bad("Enter your full name.");
  if (up && !validPostcode(postcode)) return bad("Enter a full UK postcode, like SW1A 1AA.");
  if (mode !== "reset" && !/^\S+@\S+\.\S+$/.test(email)) return bad("Enter your email address.");
  if (mode !== "forgot" && pass.length < 8) return bad("Use a password of at least 8 characters.");
  if (mode === "forgot") {
    msg.textContent = "Sending…";
    var fr = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + "/" });
    if (fr.error) return bad(fr.error.message);
    msg.textContent = "If that address has an account, a reset link is on its way. Check your inbox and spam folder.";
    return;
  }
  if (mode === "reset") {
    msg.textContent = "Saving…";
    var rr = await sb.auth.updateUser({ password: pass });
    if (rr.error) return bad(rr.error.message);
    ui.recover = false; $("authPass").value = "";
    try { history.replaceState(null, "", location.pathname); } catch (e) {}
    var cur = await sb.auth.getSession();
    user = null; await enter(cur.data && cur.data.session ? cur.data.session.user : null);
    toast("Password changed"); return;
  }
  msg.textContent = up ? "Creating your account…" : "Signing in…";
  var res = up
    ? await sb.auth.signUp({ email: email, password: pass, options: { data: { full_name: name, postcode: postcode } } })
    : await sb.auth.signInWithPassword({ email: email, password: pass });
  if (res.error) return bad(res.error.message);
  if (up && !res.data.session) { msg.textContent = "Account created. Confirm it from the email we sent, then sign in."; setAuthMode("in"); return; }
  msg.textContent = "";
}
function firstName() { return String((S.profile && S.profile.full_name) || "").trim().split(/\s+/)[0] || ""; }

/* ---------- data ---------- */
async function loadAll() {
  var uid = user.id;
  var p = await sb.from("profiles").select("*").eq("id", uid).maybeSingle();
  if (!p.data) { await sb.from("profiles").insert({ id: uid, email: user.email }); p = await sb.from("profiles").select("*").eq("id", uid).maybeSingle(); }
  if (p.error || !p.data) { toast("Couldn’t load your profile. Has the database setup script been run?"); return; }
  S.profile = p.data;
  var meta = user.user_metadata || {}, fill = {};
  if (!S.profile.full_name && meta.full_name) fill.full_name = String(meta.full_name).slice(0, 120);
  if (!S.profile.postcode && meta.postcode && "postcode" in S.profile) fill.postcode = String(meta.postcode).slice(0, 10);
  if (Object.keys(fill).length) { Object.keys(fill).forEach(function (k) { S.profile[k] = fill[k]; }); await sb.from("profiles").update(fill).eq("id", uid); }
  var r = await Promise.all([
    sb.from("matches").select("*, listing:listings(*)").eq("user_id", uid).order("created_at", { ascending: false }).limit(400),
    sb.from("sites").select("*").order("created_at"),
    sb.from("status").select("*").eq("id", 1).maybeSingle()
  ]);
  S.matches = (r[0].data || []).filter(function (m) { return m.listing; });
  S.sites = r[1].data || [];
  S.status = r[2].data || null;
  fillForms(); render();
  loadGeo();
}
var saveT = {};
function saveProfile(patch, note) {
  Object.keys(patch).forEach(function (k) { S.profile[k] = patch[k]; });
  var key = Object.keys(patch).join(",");
  clearTimeout(saveT[key]);
  saveT[key] = setTimeout(async function () {
    var res = await sb.from("profiles").update(patch).eq("id", user.id);
    if (note) { $(note).className = res.error ? "state bad" : "state"; $(note).textContent = res.error ? "Couldn’t save: " + res.error.message : "Saved."; }
  }, 500);
}
async function setStatus(listingId, status) {
  var patch = { status: status };
  S.matches.forEach(function (m) {
    if (m.listing_id !== listingId) return;
    if (status === "applied" && !m.applied_at) patch.applied_at = new Date().toISOString().slice(0, 10);
    Object.keys(patch).forEach(function (k) { m[k] = patch[k]; });
  });
  render();
  var res = await sb.from("matches").update(patch).eq("user_id", user.id).eq("listing_id", listingId);
  if (res.error) toast("Couldn’t save that change");
}
var matchT = {};
function saveMatch(listingId, field, value) {
  S.matches.forEach(function (m) { if (m.listing_id === listingId) m[field] = value; });
  var key = listingId + "|" + field;
  clearTimeout(matchT[key]);
  matchT[key] = setTimeout(async function () {
    var patch = {}; patch[field] = value;
    var res = await sb.from("matches").update(patch).eq("user_id", user.id).eq("listing_id", listingId);
    if (res.error) toast("Couldn’t save that");
  }, 600);
}
async function deleteAccount(btn) {
  if (btn.dataset.sure !== "1") { btn.dataset.sure = "1"; btn.textContent = "Press again to delete everything"; setTimeout(function () { btn.dataset.sure = ""; btn.textContent = "Delete my account"; }, 5000); return; }
  btn.disabled = true; btn.textContent = "Deleting…";
  var res = await sb.functions.invoke("scrape", { body: { action: "delete_account" } });
  if (res.error || !(res.data && res.data.deleted)) { btn.disabled = false; btn.textContent = "Delete my account"; btn.dataset.sure = ""; toast("Couldn’t delete the account. Try again."); return; }
  try { localStorage.removeItem("fd-geo"); } catch (e) {}
  await sb.auth.signOut();
  toast("Your account and data have been deleted");
}
async function testSite(url) {
  var res = await sb.functions.invoke("scrape", { body: { action: "probe", url: url } });
  var d = res.data || {};
  if (res.error || !d.ok) return toast("Added, but " + (d.error ? d.error.charAt(0).toLowerCase() + d.error.slice(1) : "the page couldn’t be checked."));
  if (!d.count) return toast("Added, but no links were found. That page probably loads its vacancies with JavaScript, which can’t be read.");
  toast("Added. The page can be read: " + d.count + " links found.");
}
async function checkNow() {
  if (ui.checking) return;
  if (!(S.profile.sectors || []).length && !S.sites.length) { setTab("settings"); toast("Pick at least one category first"); return; }
  ui.checking = true; renderChrome();
  var res = await sb.functions.invoke("scrape", { body: {} });
  ui.checking = false;
  var why = res.data && res.data.error;
  if (res.error && !why) {
    why = res.error.message || "";
    try { var b = await res.error.context.json(); if (b && b.error) why = b.error; } catch (e) {}
  }
  if (res.error || (res.data && res.data.error)) {
    $("progress").textContent = "The check didn’t run: " + String(why || "unknown error").slice(0, 160);
  } else {
    var d = res.data || {};
    $("progress").textContent = (d.fresh ? d.fresh + " new for you." : "Nothing new since the last check.") + " " + (d.found || 0) + " vacancies read." + (d.error ? " Note: " + d.error : "");
    await loadAll();
    if (d.fresh) { ui.view = "new"; }
  }
  render();
}

/* ---------- Apply with Claude ---------- */
function buildPrompt(l) {
  var p = S.profile;
  var head = [
    "I’m applying for the apprenticeship below. Please do all of this in one reply.",
    "Rules: use only facts from my CV and notes. Never invent a qualification, grade, employer, date or experience; if the job asks for something I don’t have, leave it out. Write in UK English, in my voice, plain and confident.",
    "1. My CV tailored to this role, as a downloadable PDF file. Keep its DNA: the same sections in the same order, my way of phrasing things, every fact unchanged. Rewrite the opening profile for this job, put the most relevant points first, mirror the job description’s wording where my experience really matches, and cut what’s irrelevant. Lay the PDF out on A4 in a clean single column, my name and contact details at the top, no photo or graphics, two pages at most, and name the file with my name and the employer. If you can’t create files, give the CV as plain text instead.",
    "2. My answer to “What are your skills and strengths?” (130 to 170 words).",
    "3. My answer to “What interests you about this apprenticeship?” (130 to 170 words).",
    "4. A cover letter (180 to 230 words).",
    "5. Three things I should double-check or add before I send it.",
    "",
    "THE APPRENTICESHIP",
    "Title: " + l.title,
    "Employer: " + (l.employer || "not stated"),
    "Location: " + (l.location || "not stated"),
    l.course ? "Training course: " + l.course + (l.level ? " (level " + l.level + ")" : "") : "",
    l.wage ? "Wage: " + l.wage : "",
    "Listing: " + l.url
  ].filter(function (x) { return x !== ""; }).join("\n");
  var cv = "\n\nMY CV\n" + (p.cv_text || "(I haven’t added my CV yet. Ask me for it before you start.)").slice(0, 7000);
  var notes = p.notes ? "\n\nOTHER TRUE FACTS ABOUT ME\n" + p.notes.slice(0, 1200) : "";
  var name = p.full_name ? "\n\nMy name: " + p.full_name : "";
  var room = PROMPT_LIMIT - head.length - cv.length - notes.length - name.length - 40;
  var jd = l.description && room > 300 ? "\n\nJOB DESCRIPTION\n" + l.description.slice(0, room) : "\n\nI couldn’t include the job description. Read it from the listing link if you can, or ask me to paste it.";
  return head + name + cv + notes + jd;
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) {
    var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
    var ok = false; try { ok = document.execCommand("copy"); } catch (e2) {}
    ta.remove(); return ok;
  }
}
async function applyWithClaude(id, how) {
  var m = S.matches.filter(function (x) { return x.listing_id === id; })[0]; if (!m) return;
  if (!(S.profile.cv_text || "").trim()) { setTab("profile"); toast("Add your CV first so Claude has something to tailor"); return; }
  var prompt = buildPrompt(m.listing);
  var copied = await copyText(prompt);
  if (how === "copy") { toast(copied ? "Prompt copied. Paste it into Claude." : "Couldn’t copy on this device"); }
  else {
    toast(copied ? "Opening Claude. Press send when it appears. The prompt is copied too, in case." : "Opening Claude. Press send when it appears.");
    window.location.href = (how === "web" ? "https://claude.ai/new?q=" : "claude://claude.ai/new?q=") + encodeURIComponent(prompt);
  }
  if (m.status === "new" || m.status === "seen") setStatus(id, "shortlisted");
}

/* ---------- CV upload ---------- */
function loadScript(src) { return new Promise(function (ok, no) { var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = no; document.head.appendChild(s); }); }
async function readCV(file) {
  var name = file.name || "CV", ext = (name.split(".").pop() || "").toLowerCase(), st = $("cvState");
  st.className = "state"; st.textContent = "Reading " + name + "…";
  try {
    var text = "";
    if (ext === "txt" || ext === "md" || file.type === "text/plain") text = await file.text();
    else if (ext === "docx") {
      if (!window.mammoth) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js");
      text = (await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
    } else if (ext === "pdf" || file.type === "application/pdf") {
      if (!window.pdfjsLib) await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      var pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      for (var i = 1; i <= pdf.numPages; i++) {
        var content = await (await pdf.getPage(i)).getTextContent();
        text += content.items.map(function (it) { return it.str + (it.hasEOL ? "\n" : ""); }).join("") + "\n\n";
      }
    } else throw new Error("type");
    text = String(text || "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (text.length < 40) throw new Error("empty");
    $("cvText").value = text;
    saveProfile({ cv_text: text, cv_name: name });
    st.textContent = "Read " + name + ": " + text.split(/\s+/).length + " words. Check it over below.";
  } catch (e) {
    st.className = "state bad";
    st.textContent = e.message === "type" ? "Use a PDF, .docx or text file. Older .doc files need saving as PDF first."
      : e.message === "empty" ? "No text found in " + name + ". If it’s a scanned image, paste the text below instead."
      : "Couldn’t read " + name + ". Paste the text below instead.";
  }
}

/* ---------- rendering ---------- */
function chipRow(el, items, isOn, act) {
  el.innerHTML = items.map(function (it) {
    return '<button type="button" class="chip" data-act="' + act + '" data-id="' + esc(it[0]) + '" aria-pressed="' + (isOn(it[0]) ? "true" : "false") + '">' + esc(it[1]) + "</button>";
  }).join("");
}
function fillForms() {
  var p = S.profile; if (!p) return;
  document.querySelectorAll("[data-p]").forEach(function (el) {
    var v = p[el.dataset.p];
    if (el.type === "checkbox") el.checked = !!v; else el.value = (v == null || (el.dataset.p === "min_salary" && !Number(v))) ? "" : v;
  });
  if (p.cv_name && p.cv_text) $("cvState").textContent = "Using " + p.cv_name + ".";
}
function renderChrome() {
  var st = S.status, btn = $("checkBtn");
  $("pulse").className = "pulse" + (ui.checking ? " live" : "");
  $("pulseText").textContent = ui.checking ? "Checking now" : (st && st.last_run ? "Sites last checked " + ago(st.last_run) : "No scheduled check has run yet");
  btn.disabled = ui.checking; btn.textContent = ui.checking ? "Checking…" : "Check now";
}
function visible() {
  var q = ui.q.trim().toLowerCase(), within = Number(ui.within) || 0, level = Number(ui.level) || 0;
  var rows = S.matches.filter(function (m) {
    var l = m.listing;
    if (ui.view === "hidden") { if (m.status !== "hidden") return false; }
    else if (m.status === "hidden") return false;
    if (ui.view === "new" && m.status !== "new") return false;
    if (ui.view === "short" && ["shortlisted", "applied", "interview", "offer"].indexOf(m.status) < 0) return false;
    if (level && l.level !== level) return false;
    if (q && (l.title + " " + l.employer + " " + l.location + " " + l.course).toLowerCase().indexOf(q) < 0) return false;
    if (within) { var d = distanceTo(l); if (d === null || d > within) return false; }
    return true;
  });
  // Unknown values (no pay stated, no postcode) always go to the bottom.
  function by(get, dir) { return function (a, b) { var x = get(a), y = get(b); if (x === null && y === null) return 0; if (x === null) return 1; if (y === null) return -1; return x < y ? -dir : x > y ? dir : 0; }; }
  var spotted = by(function (m) { return m.created_at; }, -1);
  var sorters = {
    posted: by(function (m) { return m.listing.posted || null; }, -1),
    salary: by(function (m) { return payOf(m.listing.wage); }, -1),
    distance: by(function (m) { return distanceTo(m.listing); }, 1),
    closing: by(function (m) { return m.listing.closes || null; }, 1),
    spotted: spotted
  };
  var main = sorters[ui.sort] || spotted;
  return rows.sort(function (a, b) { return main(a, b) || spotted(a, b); });
}
function renderBoard() {
  var p = S.profile || {};
  var newCount = S.matches.filter(function (m) { return m.status === "new"; }).length;
  $("cBoard").textContent = newCount ? newCount + " new" : "";
  var tracked = S.matches.filter(function (m) { return label(STATUSES, m.status); });
  $("cApps").textContent = tracked.length || "";
  var put = function (id, v) { var e = $(id); if (e) e.textContent = v; };
  var live = S.matches.filter(function (m) { return m.status !== "hidden"; });
  put("stNew", newCount);
  put("stShort", live.filter(function (m) { return m.status === "shortlisted"; }).length);
  put("stApplied", live.filter(function (m) { return ["applied", "interview", "offer"].indexOf(m.status) > -1; }).length);
  put("stClosing", live.filter(function (m) { var c = closing(m.listing.closes); return c && c.soon && !/^Closed/.test(c.text); }).length);
  var hello = $("hello"); if (hello) { var fn = firstName(); hello.textContent = fn ? "Hello, " + fn : ""; hello.hidden = !fn; }
  put("heroLine", newCount ? newCount + " new apprenticeship" + (newCount > 1 ? "s" : "") + " found for you" : (S.matches.length ? "You’re up to date" : "Let’s find your first match"));
  chipRow($("viewChips"), [["new", "New"], ["all", "Everything"], ["short", "Shortlist"], ["hidden", "Hidden"]], function (id) { return ui.view === id; }, "view");
  var names = (p.sectors || []).map(function (s) { return label(SECTORS, s); }).filter(Boolean);
  $("searchSum").textContent = names.length ? names.join(", ") + (p.location ? " within " + p.distance + " miles of " + p.location : " across England") : "You haven’t picked any categories yet.";
  var ls = visible(), el = $("list");
  var hasHome = !!postcodeOf(p.postcode), usesDistance = ui.sort === "distance" || !!ui.within;
  var note = usesDistance && !hasHome ? "Add your postcode in Profile to sort and filter by distance."
    : usesDistance && hasHome && GEO[postcodeOf(p.postcode)] === null ? "We couldn’t find your postcode. Check it in Profile."
    : (ui.q || ui.level || ui.within) ? ls.length + (ls.length === 1 ? " vacancy matches" : " vacancies match") + " your filters." : "";
  var tn = $("toolNote"); if (tn) tn.textContent = note;
  if (!ls.length) {
    el.innerHTML = '<div class="empty"><strong>' + (S.matches.length ? "Nothing in this view" : "No matches yet") + "</strong>" +
      (S.matches.length ? ((ui.q || ui.level || ui.within) ? "Clear the search and filters, or switch to Everything." : "Switch to Everything to see the rest.") : (names.length ? "Press Check now, or wait for the next scheduled check." : "Pick your categories in Settings, then press Check now.")) + "</div>";
    return;
  }
  el.innerHTML = ls.map(function (m) {
    var l = m.listing, c = closing(l.closes), fresh = m.status === "new", st = label(STATUSES, m.status);
    var d = distanceTo(l), far = d === null ? "" : (d < 1 ? "Under a mile away" : Math.round(d) + (Math.round(d) === 1 ? " mile away" : " miles away"));
    return '<article class="card' + (fresh ? " fresh" : "") + '">' +
      '<p class="spot"><b><i></i>' + (fresh ? "New, spotted " : "Spotted ") + esc(ago(m.created_at)) + "</b><span>" + esc(l.source || "") + "</span></p>" +
      "<h3>" + esc(l.title) + "</h3>" +
      '<p class="who"><strong>' + esc(l.employer || "") + "</strong>" + (l.location ? ", " + esc(l.location) : "") + "</p>" +
      '<ul class="facts">' + (m.sector && label(SECTORS, m.sector) ? '<li class="tag" style="--h:' + ((m.sector * 47 + 215) % 360) + '">' + esc(label(SECTORS, m.sector)) + "</li>" : "") + (l.level ? "<li>Level " + l.level + "</li>" : "") + (l.course ? "<li>" + esc(l.course) + "</li>" : "") + (l.wage ? "<li>" + esc(l.wage) + "</li>" : "") + (far ? '<li class="far">' + far + "</li>" : "") +
      (c ? '<li class="' + (c.soon ? "soon" : "") + '">' + esc(c.text) + "</li>" : "") + (l.posted ? "<li>Posted " + esc(new Date(l.posted + "T12:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" })) + "</li>" : "") +
      (st ? '<li class="st">' + esc(st) + "</li>" : "") + "</ul>" +
      '<div class="row"><button class="btn go" data-act="apply" data-id="' + esc(l.id) + '">Apply with Claude</button>' +
      '<a class="btn" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer" data-act="seen" data-id="' + esc(l.id) + '">Open listing</a>' +
      '<button class="btn star" data-act="star" data-id="' + esc(l.id) + '" aria-pressed="' + (m.status === "shortlisted" ? "true" : "false") + '">' + (m.status === "shortlisted" ? "Shortlisted" : "Shortlist") + "</button>" +
      (m.status === "hidden" ? '<button class="btn" data-act="restore" data-id="' + esc(l.id) + '">Restore</button></div>'
        : '<button class="btn quiet" data-act="hide" data-id="' + esc(l.id) + '">Not for me</button></div>') +
      '<div class="row" style="margin-top:4px"><button class="btn quiet" data-act="applyCopy" data-id="' + esc(l.id) + '">Copy the prompt instead</button>' +
      '<button class="btn quiet" data-act="applyWeb" data-id="' + esc(l.id) + '">Open in claude.ai</button></div></article>';
  }).join("");
}
function renderApps() {
  var ms = S.matches.filter(function (m) { return label(STATUSES, m.status); });
  $("tally").innerHTML = STATUSES.map(function (s) {
    var n = ms.filter(function (m) { return m.status === s[0]; }).length;
    return n ? "<li><b>" + n + "</b>" + esc(s[1]) + "</li>" : "";
  }).join("");
  if (!ms.length) { $("appList").innerHTML = '<div class="empty" style="border:0"><strong>Nothing here yet</strong>Shortlist a vacancy or apply with Claude and it shows up here.</div>'; return; }
  ms.sort(function (a, b) { return String(a.listing.closes || "9999").localeCompare(String(b.listing.closes || "9999")); });
  $("appList").innerHTML = ms.map(function (m) {
    var l = m.listing, c = closing(l.closes);
    return '<div class="app"><div><h3>' + esc(l.title) + "</h3><p>" + esc(l.employer || "") + (c ? ". " + esc(c.text) + "." : "") + "</p>" +
      '<div class="row" style="margin-top:8px"><button class="btn" data-act="apply" data-id="' + esc(l.id) + '">Apply with Claude</button>' +
      '<a class="btn quiet" href="' + esc(l.url) + '" target="_blank" rel="noopener noreferrer">Listing</a></div>' +
      '<details class="more" data-notes="' + esc(l.id) + '"' + (ui.openNotes[l.id] ? " open" : "") + '><summary>Notes and dates' + ((m.notes || m.interview_at) ? " (saved)" : "") + '</summary>' +
      '<div class="two"><label class="field"><span>Applied on</span><input type="date" data-m="applied_at" data-id="' + esc(l.id) + '" value="' + esc(m.applied_at || "") + '"></label>' +
      '<label class="field"><span>Interview date</span><input type="date" data-m="interview_at" data-id="' + esc(l.id) + '" value="' + esc(m.interview_at || "") + '"></label></div>' +
      '<label class="field"><span>Notes</span><textarea data-m="notes" data-id="' + esc(l.id) + '" placeholder="Who you spoke to, what you sent, what to chase…">' + esc(m.notes || "") + "</textarea></label></details></div>" +
      '<select data-status="' + esc(l.id) + '" aria-label="Status">' + STATUSES.map(function (s) { return '<option value="' + s[0] + '"' + (m.status === s[0] ? " selected" : "") + ">" + esc(s[1]) + "</option>"; }).join("") +
      '<option value="seen">Remove from list</option></select></div>';
  }).join("");
}
function renderSettings() {
  var p = S.profile || {};
  chipRow($("sectorChips"), SECTORS, function (id) { return (p.sectors || []).indexOf(Number(id)) > -1; }, "sector");
  chipRow($("levelChips"), LEVELS, function (id) { return (p.levels || []).indexOf(Number(id)) > -1; }, "level");
  var wc = $("watchChips");
  if (wc) chipRow(wc, WATCHLIST, function (id) { var w = WATCHLIST.filter(function (x) { return x[0] === id; })[0]; return S.sites.some(function (s) { return s.url === w[2]; }); }, "watch");
  var st = S.status;
  var faa = '<div class="switch"><div style="min-width:0"><h3>Find an apprenticeship (England)</h3><p class="url">findapprenticeship.service.gov.uk</p><p>' +
    (st && st.last_run ? "Checked " + esc(ago(st.last_run)) + ". " + (st.found || 0) + " vacancies read across everyone’s searches." + (st.error ? " Problem: " + esc(st.error) : "") : "Not checked yet.") +
    "</p><p>Always on. Searched by your categories and location, newest first.</p></div></div>";
  $("siteList").innerHTML = faa + S.sites.map(function (s) {
    var line = !s.last_checked ? "Not checked yet. It’s included from the next check." :
      s.last_error ? esc(s.last_error) : "Checked " + esc(ago(s.last_checked)) + ". " + (s.last_count || 0) + " links on the page; you’re told when a new one appears.";
    return '<div class="switch"><div style="min-width:0"><h3>' + esc(s.name) + '</h3><p class="url">' + esc(s.url) + "</p><p>" + line + "</p>" +
      '<div class="row" style="margin-top:6px"><button class="btn" data-act="siteRemove" data-id="' + esc(s.id) + '">Remove</button></div></div>' +
      '<input type="checkbox" data-site="' + esc(s.id) + '"' + (s.enabled ? " checked" : "") + ' aria-label="Check ' + esc(s.name) + '"></div>';
  }).join("");
}
function render() { if (!S.profile) return; renderChrome(); renderBoard(); renderApps(); renderSettings(); }
function setTab(t) {
  ui.tab = t;
  ["board", "apps", "profile", "settings"].forEach(function (x) { $("tab-" + x).hidden = x !== t; });
  document.querySelectorAll("nav.tabs button").forEach(function (b) { b.setAttribute("aria-selected", b.dataset.tab === t ? "true" : "false"); });
  window.scrollTo(0, 0);
}

/* ---------- events ---------- */
function toggleNum(arr, id) { var a = (arr || []).slice(), n = Number(id), i = a.indexOf(n); if (i > -1) a.splice(i, 1); else a.push(n); return a.sort(function (x, y) { return x - y; }); }
document.addEventListener("click", async function (ev) {
  var tab = ev.target.closest("nav.tabs button"); if (tab) { setTab(tab.dataset.tab); return; }
  var el = ev.target.closest("[data-act]"); if (!el) return;
  var act = el.dataset.act, id = el.dataset.id, p = S.profile;
  if (act === "authGo") authGo();
  else if (act === "authMode") setAuthMode(id || "in");
  else if (act === "signout") { await sb.auth.signOut(); }
  else if (act === "check") checkNow();
  else if (act === "goSettings") setTab("settings");
  else if (act === "view") { ui.view = id; renderBoard(); }
  else if (act === "sector") { saveProfile({ sectors: toggleNum(p.sectors, id) }, "critState"); render(); }
  else if (act === "level") { saveProfile({ levels: toggleNum(p.levels, id) }, "critState"); render(); }
  else if (act === "apply") applyWithClaude(id, "app");
  else if (act === "applyCopy") applyWithClaude(id, "copy");
  else if (act === "applyWeb") applyWithClaude(id, "web");
  else if (act === "seen") { var m = S.matches.filter(function (x) { return x.listing_id === id; })[0]; if (m && m.status === "new") setTimeout(function () { setStatus(id, "seen"); }, 300); }
  else if (act === "star") { var m2 = S.matches.filter(function (x) { return x.listing_id === id; })[0]; if (m2) setStatus(id, m2.status === "shortlisted" ? "seen" : "shortlisted"); }
  else if (act === "hide") { setStatus(id, "hidden"); toast("Hidden. You can restore it from the Hidden view."); }
  else if (act === "restore") { setStatus(id, "seen"); toast("Restored to your board"); }
  else if (act === "deleteAccount") deleteAccount(el);
  else if (act === "usePostcode") {
    if (!postcodeOf(p.postcode)) { toast("Add your postcode in Profile first"); return; }
    var loc = document.querySelector('[data-p="location"]'); loc.value = p.postcode; saveProfile({ location: p.postcode }, "critState"); renderBoard();
  }
  else if (act === "watch") {
    var w = WATCHLIST.filter(function (x) { return x[0] === id; })[0]; if (!w) return;
    var have = S.sites.filter(function (x) { return x.url === w[2]; })[0];
    if (have) { await sb.from("sites").delete().eq("id", have.id); S.sites = S.sites.filter(function (x) { return x.id !== have.id; }); }
    else { var ins = await sb.from("sites").insert({ name: w[1], url: w[2] }).select().single(); if (ins.error) { toast("Couldn’t add that site"); return; } S.sites.push(ins.data); toast("Added. It’s included from the next check."); }
    renderSettings();
  }
  else if (act === "siteAdd") {
    var raw = $("siteUrl").value.trim(), u = null;
    if (raw && !/^https?:\/\//i.test(raw)) raw = "https://" + raw;
    try { u = new URL(raw); } catch (e) {}
    if (!u || !/\./.test(u.hostname)) { toast("Paste the full address of the vacancies page"); return; }
    var res = await sb.from("sites").insert({ name: ($("siteName").value.trim() || u.hostname.replace(/^www\./, "")).slice(0, 60), url: u.href }).select().single();
    if (res.error) { toast("Couldn’t add that site"); return; }
    S.sites.push(res.data); $("siteName").value = ""; $("siteUrl").value = ""; renderSettings(); toast("Added. Checking the page can be read…"); testSite(res.data.url);
  }
  else if (act === "siteRemove") { await sb.from("sites").delete().eq("id", id); S.sites = S.sites.filter(function (s) { return s.id !== id; }); renderSettings(); }
});
document.addEventListener("toggle", function (ev) {
  var el = ev.target; if (el.dataset && el.dataset.notes) ui.openNotes[el.dataset.notes] = el.open;
}, true);
document.addEventListener("input", function (ev) {
  var el = ev.target;
  if (el.dataset && el.dataset.m) { saveMatch(el.dataset.id, el.dataset.m, el.type === "date" ? (el.value || null) : el.value); return; }
  if (el.id === "q") { ui.q = el.value; renderBoard(); return; }
  if (!el.dataset || !el.dataset.p || !S.profile) return;
  var patch = {}; patch[el.dataset.p] = el.type === "checkbox" ? el.checked : (el.dataset.num ? (Math.round(Number(String(el.value).replace(/[^\d.]/g, ""))) || 0) : el.value);
  saveProfile(patch, el.dataset.note || "saveState");
  if (el.dataset.p === "full_name") renderBoard();
  if (el.dataset.p === "postcode") { clearTimeout(saveT.geo); saveT.geo = setTimeout(function () { loadGeo(); renderBoard(); }, 900); }
  if (el.dataset.note === "critState") renderBoard();
});
document.addEventListener("change", async function (ev) {
  var el = ev.target;
  if (el.id === "cvFile") { if (el.files && el.files[0]) readCV(el.files[0]); el.value = ""; return; }
  if (el.id === "sortSel") { ui.sort = el.value; renderBoard(); return; }
  if (el.id === "levelSel") { ui.level = el.value; renderBoard(); return; }
  if (el.id === "withinSel") { ui.within = el.value; renderBoard(); return; }
  if (el.dataset && el.dataset.status) { setStatus(el.dataset.status, el.value); return; }
  if (el.dataset && el.dataset.site) {
    S.sites.forEach(function (s) { if (s.id === el.dataset.site) s.enabled = el.checked; });
    await sb.from("sites").update({ enabled: el.checked }).eq("id", el.dataset.site);
  }
});
document.addEventListener("keydown", function (ev) { if (ev.key === "Enter" && /^auth(Name|Postcode|Email|Pass)$/.test(ev.target.id)) authGo(); });
setInterval(function () { if (user && S.profile) renderChrome(); }, 60000);
boot();
})();
