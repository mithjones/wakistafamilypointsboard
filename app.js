import { firebaseConfig, FAMILY_ID } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc,
  collection, addDoc, onSnapshot, query, orderBy, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

const familyRef = doc(db, "families", FAMILY_ID);
const entriesCol = collection(db, "families", FAMILY_ID, "entries");

const PALETTE = ["#D4A039", "#7CA8C9", "#A4C97C", "#C97CA4", "#C9A47C", "#9C8CD6"];

const DEFAULTS = {
  kids: [
    { id: "tesaliya", name: "Tesaliya", accent: "#D4A039" },
    { id: "rian", name: "Rian", accent: "#7CA8C9" },
  ],
  activities: [
    { id: "a1", name: "Basketball practice (extra)", points: 15, category: "Extra effort" },
    { id: "a2", name: "Reading — 30 min", points: 10, category: "Extra effort" },
    { id: "a3", name: "Tidy bedroom", points: 5, category: "Chores" },
    { id: "a4", name: "Dishes", points: 5, category: "Chores" },
    { id: "a5", name: "Swim laps (extra)", points: 15, category: "Extra effort" },
    { id: "a6", name: "Helped a sibling", points: 10, category: "Extra effort" },
  ],
  habits: [],
  rewards: [
    { id: "r1", name: "Restaurant of choice", cost: 100 },
    { id: "r2", name: "30 min YouTube", cost: 20 },
    { id: "r3", name: "1 hr video games", cost: 30 },
    { id: "r4", name: "Pick the movie", cost: 50 },
    { id: "r5", name: "Later bedtime", cost: 25 },
  ],
  parentPin: "1234",
};

let family = null;
let entries = [];
let entriesLoaded = false;
let activeKid = null;
let role = localStorage.getItem("fpb_role");
let deviceKidId = localStorage.getItem("fpb_kidId");
let currentTab = "earn";
let chartInstance = null;
let lastChartKey = "";
let submitting = false;
let confirmResolver = null;

const $ = (sel) => document.querySelector(sel);
const $all = (sel) => Array.from(document.querySelectorAll(sel));

/* ---------------- text size (per device) ---------------- */

const SCALES = ["1", "1.25", "1.5", "2"];

function currentScale() {
  const s = localStorage.getItem("fpb_scale");
  return SCALES.includes(s) ? s : "1.5";
}

function applyScale(v) {
  document.documentElement.style.setProperty("--fs", v);
  localStorage.setItem("fpb_scale", v);
  $all("#sizeRow .fpb-size-btn").forEach((b) => b.classList.toggle("active", b.dataset.scale === v));
  // Chart text is drawn on canvas, so it needs an explicit rebuild to resize.
  lastChartKey = "";
  if (currentTab === "trends") renderTrends();
  if (family) setTimeout(enforceSideRoom, 0);
}

applyScale(currentScale());

$all("#sizeRow .fpb-size-btn").forEach((btn) => {
  btn.onclick = () => applyScale(btn.dataset.scale);
});

/* ---------------- side photo panels ---------------- */

function isSafeImageUrl(u) {
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch { return false; }
}

function renderSidePanels() {
  const cfg = family?.sidePanels || {};
  [["left", "#sideLeft"], ["right", "#sideRight"]].forEach(([side, sel]) => {
    const el = $(sel);
    const url = cfg[side + "Img"];
    const cap = cfg[side + "Cap"];
    if (!isSafeImageUrl(url)) {
      el.innerHTML = "";
      el.classList.remove("visible");
      return;
    }
    el.innerHTML = "";
    const inner = document.createElement("div");
    inner.className = "fpb-side-inner";
    const img = document.createElement("img");
    img.src = url;
    img.alt = cap || "";
    // A broken link shouldn't leave an empty grey box sitting there.
    img.onerror = () => { el.classList.remove("visible"); el.innerHTML = ""; };
    inner.appendChild(img);
    if (cap) {
      const c = document.createElement("div");
      c.className = "fpb-side-cap";
      c.textContent = cap;
      inner.appendChild(c);
    }
    el.appendChild(inner);
    el.classList.add("visible");
  });
  enforceSideRoom();
}

/** Panel width depends on both viewport and text scale, so check the real number
 *  rather than trusting a media query — otherwise Double size on a small laptop
 *  squeezes the panels into slivers. */
function enforceSideRoom() {
  const column = document.querySelector(".fpb-root")?.offsetWidth || 0;
  const room = (window.innerWidth - column) / 2 - 56;
  const enough = room >= 170;
  [$("#sideLeft"), $("#sideRight")].forEach((el) => {
    if (!el) return;
    el.style.visibility = enough ? "visible" : "hidden";
  });
}

let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(enforceSideRoom, 120);
});

/* ---------------- utilities ---------------- */

function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("error", isError);
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), isError ? 4000 : 2200);
}

function banner(msg) {
  const b = $("#connBanner");
  if (!msg) { b.hidden = true; return; }
  b.textContent = msg;
  b.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day; // Monday start
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + diff);
  return date;
}

function endOfWeek(startDate) {
  const e = new Date(startDate);
  e.setDate(e.getDate() + 6);
  e.setHours(23, 59, 59, 999);
  return e;
}

function uidLocal() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/* ---------------- habit dates & streaks ---------------- */

/** Local calendar day key. Deliberately not UTC — a 9pm tick in Melbourne must
 *  belong to that day, not tomorrow. */
function dayKey(d) {
  const x = new Date(d);
  if (isNaN(x.getTime())) return null;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}
function dayFromKey(k) {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const REST_DAY_GAP = 14;   // one rest day per fortnight
const DAILY_BADGES = [3, 7, 14, 30, 60, 100];
const WEEKLY_BADGES = [2, 4, 8, 12, 26];

/** Ticks for one habit, as a Set of day keys. `approvedOnly` drives badges;
 *  including pending drives the on-screen streak so kids get instant feedback. */
function habitTickDays(habitId, approvedOnly) {
  const set = new Set();
  entries.forEach((e) => {
    // Badge bonuses also carry a habitId; they are rewards, not ticks.
    if (e.source !== "habit") return;
    if (e.habitId !== habitId) return;
    if (e.status === "rejected") return;
    if (approvedOnly && e.status !== "approved") return;
    const k = e.dayKey || dayKey(e.date);
    if (k) set.add(k);
  });
  return set;
}

/**
 * Walks forward from the first tick to today, counting consecutive days.
 * A single missed day can be bridged by a "rest day", but only if no other
 * rest day was used in the previous fortnight. Today never breaks a streak,
 * since the day isn't over yet.
 */
function dailyStreak(tickDays) {
  if (!tickDays.size) return { current: 0, best: 0, restUsedOn: null };
  const keys = [...tickDays].sort();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayK = dayKey(today);

  let run = 0, best = 0, lastRest = null, restUsedOn = null;
  for (let d = dayFromKey(keys[0]); dayKey(d) <= todayK; d = addDays(d, 1)) {
    const k = dayKey(d);
    if (tickDays.has(k)) {
      run++;
      if (run > best) best = run;
    } else if (k === todayK) {
      // Day still in progress — neither counts nor breaks.
    } else if (run > 0 && (!lastRest || (d - lastRest) / 86400000 >= REST_DAY_GAP)) {
      lastRest = d;
      restUsedOn = k;
    } else {
      run = 0;
      lastRest = null;
      restUsedOn = null;
    }
  }
  return { current: run, best, restUsedOn };
}

/** Weekly-target habits: a streak is consecutive weeks that met the target.
 *  The current week is never counted as a failure while it's still running. */
function weeklyStreak(tickDays, target) {
  if (!tickDays.size) return { current: 0, best: 0, thisWeek: 0 };
  const keys = [...tickDays].sort();
  const countIn = (ws) => {
    const we = endOfWeek(ws);
    return [...tickDays].filter((k) => {
      const d = dayFromKey(k);
      return d >= ws && d <= we;
    }).length;
  };
  const thisWeekStart = startOfWeek(new Date());
  let run = 0, best = 0;
  for (let ws = startOfWeek(dayFromKey(keys[0])); ws <= thisWeekStart; ws = addDays(ws, 7)) {
    const hit = countIn(ws) >= target;
    const isCurrent = ws.getTime() === thisWeekStart.getTime();
    if (hit) {
      run++;
      if (run > best) best = run;
    } else if (!isCurrent) {
      run = 0;
    }
  }
  return { current: run, best, thisWeek: countIn(thisWeekStart) };
}

function streakFor(habit, approvedOnly = false) {
  const days = habitTickDays(habit.id, approvedOnly);
  return habit.cadence === "weekly"
    ? { ...weeklyStreak(days, habit.target || 3), days, unit: "week" }
    : { ...dailyStreak(days), days, unit: "day" };
}

function badgeLadder(habit) {
  return habit.cadence === "weekly" ? WEEKLY_BADGES : DAILY_BADGES;
}

function entryDate(e) {
  const d = new Date(e.date);
  return isNaN(d.getTime()) ? new Date(0) : d;
}

/** Promise-based confirm dialog (replaces window.confirm, which is blocked in some embeds). */
function confirmDialog(title, body, okLabel = "Delete") {
  $("#confirmTitle").textContent = title;
  $("#confirmBody").textContent = body;
  $("#confirmOk").textContent = okLabel;
  $("#confirmModal").hidden = false;
  return new Promise((resolve) => { confirmResolver = resolve; });
}
function closeConfirm(result) {
  $("#confirmModal").hidden = true;
  if (confirmResolver) { confirmResolver(result); confirmResolver = null; }
}
$("#confirmCancel").onclick = () => closeConfirm(false);
$("#confirmOk").onclick = () => closeConfirm(true);

/** Wraps a Firestore write so a failure surfaces to the user instead of failing silently. */
async function safeWrite(fn, failMsg) {
  try {
    await fn();
    return true;
  } catch (err) {
    console.error(err);
    toast(`${failMsg}: ${err.message || "unknown error"}`, true);
    return false;
  }
}

/* ---------------- auth + data ---------------- */

signInAnonymously(auth).catch((err) => {
  console.error(err);
  banner("Can't connect to the database. Check the Firebase setup (Anonymous sign-in enabled?).");
});

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  try {
    await ensureFamilyDoc();
    banner("");
    listenFamily();
    listenEntries();
    listenProfiles();
    listenMessages();
  } catch (err) {
    console.error(err);
    banner("Can't read your data. Check the Firestore security rules.");
  }
});

async function ensureFamilyDoc() {
  const snap = await getDoc(familyRef);
  if (!snap.exists()) await setDoc(familyRef, DEFAULTS);
}

function listenFamily() {
  onSnapshot(
    familyRef,
    (snap) => {
      const d = snap.data();
      family = {
        kids: d?.kids || [],
        activities: d?.activities || [],
        rewards: d?.rewards || [],
        habits: d?.habits || [],
        parentPin: d?.parentPin || DEFAULTS.parentPin,
        sidePanels: d?.sidePanels || {},
      };
      resolveActiveKid();
      maybeShowWhoAmI();
      renderAll();
      if (!$("#settingsModal").hidden) renderSettings();
    },
    (err) => { console.error(err); banner("Lost connection to the database."); }
  );
}

function listenEntries() {
  onSnapshot(
    query(entriesCol, orderBy("date", "desc")),
    (snap) => {
      entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      entriesLoaded = true;
      renderAll();
      ensureBadges();
      ensureWeeklyBonuses();
    },
    (err) => { console.error(err); banner("Lost connection to the database."); }
  );
}

function resolveActiveKid() {
  const kids = family?.kids || [];
  if (!kids.length) { activeKid = null; return; }
  if (role === "kid" && deviceKidId && kids.some((k) => k.id === deviceKidId)) {
    activeKid = deviceKidId;
  } else if (!activeKid || !kids.some((k) => k.id === activeKid)) {
    activeKid = kids[0].id;
  }
}

/* ---------------- who am I / PIN ---------------- */

function maybeShowWhoAmI() {
  const kids = family?.kids || [];
  const kidStillExists = deviceKidId && kids.some((k) => k.id === deviceKidId);
  if (role === "parent" || (role === "kid" && kidStillExists)) {
    $("#whoami").hidden = true;
    return;
  }
  // Device was set to a kid who has since been removed — reset it.
  if (role === "kid" && !kidStillExists) {
    role = null;
    deviceKidId = null;
    localStorage.removeItem("fpb_role");
    localStorage.removeItem("fpb_kidId");
  }
  renderWhoAmI();
  $("#whoami").hidden = false;
}

function renderWhoAmI() {
  const wrap = $("#whoami-kids");
  wrap.innerHTML = "";
  (family?.kids || []).forEach((k) => {
    const b = document.createElement("button");
    b.className = "fpb-whoami-btn";
    b.textContent = k.name;
    b.onclick = () => {
      role = "kid";
      deviceKidId = k.id;
      activeKid = k.id;
      currentTab = "earn";
      localStorage.setItem("fpb_role", "kid");
      localStorage.setItem("fpb_kidId", k.id);
      $("#whoami").hidden = true;
      switchTab("earn");
      renderAll();
    };
    wrap.appendChild(b);
  });
}

$("#whoami-parent-btn").onclick = openPinModal;

$("#switchUserBtn").onclick = () => {
  role = null;
  deviceKidId = null;
  localStorage.removeItem("fpb_role");
  localStorage.removeItem("fpb_kidId");
  $("#settingsModal").hidden = true;
  switchTab("earn");
  maybeShowWhoAmI();
  renderAll();
};

function openPinModal() {
  $("#pinInput").value = "";
  $("#pinError").hidden = true;
  $("#pinModal").hidden = false;
  setTimeout(() => $("#pinInput").focus(), 30);
}
$("#pinCancel").onclick = () => ($("#pinModal").hidden = true);
$("#pinSubmit").onclick = submitPin;
$("#pinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") submitPin(); });

function submitPin() {
  const val = $("#pinInput").value.trim();
  if (val !== String(family?.parentPin ?? DEFAULTS.parentPin)) {
    $("#pinError").hidden = false;
    $("#pinInput").value = "";
    return;
  }
  $("#pinModal").hidden = true;
  role = "parent";
  localStorage.setItem("fpb_role", "parent");
  localStorage.removeItem("fpb_kidId");
  deviceKidId = null;
  $("#whoami").hidden = true;
  resolveActiveKid();
  renderAll();
}

// Esc closes whichever modal is on top.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#confirmModal").hidden) closeConfirm(false);
  else if (!$("#pinModal").hidden) $("#pinModal").hidden = true;
  else if (!$("#settingsModal").hidden) $("#settingsModal").hidden = true;
});

/* ---------------- tabs ---------------- */

function switchTab(name) {
  currentTab = name;
  $all(".fpb-tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $all(".fpb-view").forEach((v) => (v.hidden = v.id !== "view-" + name));
  renderCurrentView();
}

$all(".fpb-tab").forEach((btn) => btn.addEventListener("click", () => switchTab(btn.dataset.tab)));

function renderCurrentView() {
  if (!family) return;
  ({
    earn: renderEarnGrid,
    habits: renderHabits,
    redeem: renderRedeemGrid,
    history: renderHistory,
    trends: renderTrends,
    approvals: renderApprovals,
  })[currentTab]?.();
}

/* ---------------- balances ---------------- */

function approvedFor(kidId) {
  return entries.filter((e) => e.kidId === kidId && e.status === "approved");
}

function balanceFor(kidId) {
  return approvedFor(kidId).reduce((s, e) => s + (e.type === "earn" ? e.points : -e.points), 0);
}

/** Points already committed to pending redemptions — stops a kid queuing more than they can afford. */
function pendingSpendFor(kidId) {
  return entries
    .filter((e) => e.kidId === kidId && e.status === "pending" && e.type === "redeem")
    .reduce((s, e) => s + e.points, 0);
}

function availableFor(kidId) {
  return balanceFor(kidId) - pendingSpendFor(kidId);
}

/* ---------------- shell rendering ---------------- */

function renderAll() {
  if (!family) return;
  renderRoleBadge();
  renderKidTabs();
  renderScoreboard();
  renderCurrentView();
  renderApprovalBadge();
  renderSidePanels();
  renderHeaderProfile();
  renderMsgBadge();
}

function renderHeaderProfile() {
  const kid = (family?.kids || []).find((k) => k.id === activeKid);
  paintAvatar($("#profileBtn"), kid);
  // A child personalises their own page; a parent can help from their device.
  $("#profileBtn").hidden = !kid;
  $("#profileBtn").title = role === "parent" ? `${kid?.name || ""}'s profile` : "My profile";

  const motto = profileOf(activeKid).motto || "";
  const el = $("#heroMotto");
  if (el) {
    el.textContent = motto ? `“${motto}”` : "";
    el.hidden = !motto;
  }
}

function renderRoleBadge() {
  $("#roleBadge").textContent = role === "parent" ? "Parent mode" : "";
  const isParent = role === "parent";
  $("#settingsBtn").hidden = !isParent;
  $("#approvalsTabBtn").hidden = !isParent;
  // If a parent viewing Approvals switches to kid mode, fall back to a tab that exists.
  if (!isParent && currentTab === "approvals") switchTab("earn");
}

function renderKidTabs() {
  const wrap = $("#kidtabs");
  wrap.innerHTML = "";
  const kids = family?.kids || [];
  const visible = role === "kid" ? kids.filter((k) => k.id === deviceKidId) : kids;
  visible.forEach((k) => {
    const b = document.createElement("button");
    b.className = "fpb-kidtab" + (k.id === activeKid ? " active" : "") + (role === "kid" ? " readonly" : "");
    b.style.setProperty("--accent", accentOf(k));
    const pe = profileOf(k.id).emoji;
    b.textContent = (pe ? pe + " " : "") + k.name;
    if (role === "parent") {
      b.onclick = () => { activeKid = k.id; renderAll(); };
    }
    wrap.appendChild(b);
  });
}

function renderScoreboard() {
  const kid = (family?.kids || []).find((k) => k.id === activeKid);
  const bal = activeKid ? balanceFor(activeKid) : 0;
  const accent = accentOf(kid);
  const box = $("#scoreboard");
  box.innerHTML = "";

  // Show a real minus sign rather than silently clamping a negative balance to zero.
  if (bal < 0) {
    const sign = document.createElement("span");
    sign.className = "fpb-digit sign";
    sign.textContent = "−";
    box.appendChild(sign);
  }
  String(Math.abs(bal)).padStart(3, "0").split("").forEach((d) => {
    const digit = document.createElement("span");
    digit.className = "fpb-digit";
    digit.textContent = d;
    digit.style.color = bal < 0 ? "#E56A6A" : accent;
    box.appendChild(digit);
  });
  box.setAttribute("aria-label", `Current balance ${bal} points`);

  const weekStart = startOfWeek(new Date());
  const weekPts = approvedFor(activeKid)
    .filter((e) => e.type === "earn" && entryDate(e) >= weekStart)
    .reduce((s, e) => s + e.points, 0);
  $("#weekPoints").textContent = `${weekPts} pts earned this week`;

  const pendingSpend = pendingSpendFor(activeKid);
  const pendingEarn = entries
    .filter((e) => e.kidId === activeKid && e.status === "pending" && e.type === "earn")
    .reduce((s, e) => s + e.points, 0);
  const bits = [];
  if (pendingEarn) bits.push(`+${pendingEarn} awaiting approval`);
  if (pendingSpend) bits.push(`${pendingSpend} pts on hold for pending rewards`);
  const hp = $("#heroPending");
  hp.textContent = bits.join(" · ");
  hp.hidden = bits.length === 0;
}

/* ---------------- log activities ---------------- */

function renderEarnGrid() {
  const grid = $("#earnGrid");
  grid.innerHTML = "";
  grid.className = "fpb-grid";
  const acts = family?.activities || [];
  if (!acts.length) {
    grid.innerHTML = '<div class="fpb-empty">No activities set up yet. A parent can add them in Settings.</div>';
    return;
  }
  if (!activeKid) {
    grid.innerHTML = '<div class="fpb-empty">Add a child in Settings to start logging.</div>';
    return;
  }
  const makeCard = (a) => {
    const b = document.createElement("button");
    b.className = "fpb-card fpb-card--earn";
    b.innerHTML = `<span class="fpb-card-name">${escapeHtml(a.name)}</span><span class="fpb-card-points">+${a.points}</span>`;
    b.onclick = () => submitEarn(a, b);
    return b;
  };

  // Only group once categories are actually in use, so an older list that
  // predates this feature still renders as a plain grid.
  const anyCategory = acts.some((a) => a.category && a.category.trim());
  if (!anyCategory) {
    acts.forEach((a) => grid.appendChild(makeCard(a)));
    return;
  }

  grid.classList.remove("fpb-grid");
  grid.classList.add("fpb-grouped");
  const order = [];
  const buckets = new Map();
  acts.forEach((a) => {
    const cat = (a.category || "").trim() || "Other";
    if (!buckets.has(cat)) { buckets.set(cat, []); order.push(cat); }
    buckets.get(cat).push(a);
  });
  order.forEach((cat) => {
    const h = document.createElement("div");
    h.className = "fpb-group-head";
    h.textContent = cat;
    grid.appendChild(h);
    const sub = document.createElement("div");
    sub.className = "fpb-grid";
    buckets.get(cat).forEach((a) => sub.appendChild(makeCard(a)));
    grid.appendChild(sub);
  });
}

async function submitEarn(activity, btn) {
  if (!activeKid || submitting) return;
  submitting = true;
  if (btn) btn.disabled = true;
  const isParent = role === "parent";
  const ok = await safeWrite(
    () => addDoc(entriesCol, {
      kidId: activeKid,
      type: "earn",
      name: activity.name,
      points: activity.points,
      date: new Date().toISOString(),
      status: isParent ? "approved" : "pending",
      submittedBy: isParent ? "parent" : "kid",
    }),
    "Couldn't save that"
  );
  if (ok) {
    toast(isParent ? `+${activity.points} pts — ${activity.name}` : `Sent for approval: ${activity.name}`);
  }
  submitting = false;
  if (btn) btn.disabled = false;
}

/* ---------------- rewards ---------------- */

function renderRedeemGrid() {
  const grid = $("#redeemGrid");
  grid.innerHTML = "";
  const rewards = family?.rewards || [];
  if (!rewards.length) {
    grid.innerHTML = '<div class="fpb-empty">No rewards set up yet. A parent can add them in Settings.</div>';
    return;
  }
  const avail = availableFor(activeKid);
  rewards.forEach((r) => {
    const can = avail >= r.cost;
    const b = document.createElement("button");
    b.className = "fpb-card fpb-card--redeem" + (can ? "" : " locked");
    b.disabled = !can;
    const short = can ? "" : `<span class="fpb-card-short">${r.cost - avail} pts to go</span>`;
    b.innerHTML = `<span class="fpb-card-name">${escapeHtml(r.name)}</span><span class="fpb-card-points">${r.cost} pts</span>${short}`;
    b.onclick = () => submitRedeem(r, b);
    grid.appendChild(b);
  });
}

async function submitRedeem(reward, btn) {
  if (!activeKid || submitting) return;
  // Re-check against available (not just approved) so queued requests can't overdraw the balance.
  const avail = availableFor(activeKid);
  if (avail < reward.cost) {
    toast(`Not enough points — ${reward.cost - avail} more needed`);
    return;
  }
  submitting = true;
  if (btn) btn.disabled = true;
  const isParent = role === "parent";
  const ok = await safeWrite(
    () => addDoc(entriesCol, {
      kidId: activeKid,
      type: "redeem",
      name: reward.name,
      points: reward.cost,
      date: new Date().toISOString(),
      status: isParent ? "approved" : "pending",
      submittedBy: isParent ? "parent" : "kid",
    }),
    "Couldn't save that"
  );
  if (ok) {
    toast(isParent ? `Redeemed: ${reward.name}` : `Requested: ${reward.name} — awaiting approval`);
  }
  submitting = false;
  if (btn) btn.disabled = false;
}

/* ---------------- habits ---------------- */

const BADGE_BONUS = {
  daily:  { 3: 10, 7: 25, 14: 50, 30: 100, 60: 200, 100: 350 },
  weekly: { 2: 20, 4: 50, 8: 100, 12: 150, 26: 300 },
};

function habitsForKid(kidId) {
  return (family?.habits || []).filter((h) => h.kidId === kidId);
}

function habitStatusToday(habitId) {
  const todayK = dayKey(new Date());
  const e = entries.find((x) => x.source === "habit" && x.habitId === habitId && (x.dayKey || dayKey(x.date)) === todayK && x.status !== "rejected");
  return e ? e.status : null; // 'approved' | 'pending' | null
}

function renderHabits() {
  const wrap = $("#habitList");
  wrap.innerHTML = "";
  if (!activeKid) {
    wrap.innerHTML = '<div class="fpb-empty">Add a child in Settings first.</div>';
    return;
  }
  const habits = habitsForKid(activeKid);
  const kidName = (family?.kids || []).find((k) => k.id === activeKid)?.name || "";

  if (!habits.length) {
    wrap.innerHTML = `<div class="fpb-empty">No habits set up for ${escapeHtml(kidName)} yet.${role === "parent" ? " Add some in Settings → Habits." : ""}</div>`;
    $("#habitSummary").hidden = true;
    $("#badgeShelf").hidden = true;
    return;
  }

  // Summary strip
  const doneToday = habits.filter((h) => habitStatusToday(h.id)).length;
  const streaks = habits.map((h) => streakFor(h).current);
  const bestNow = streaks.length ? Math.max(...streaks) : 0;
  const bestHabit = habits[streaks.indexOf(bestNow)];
  $("#habitSummary").hidden = false;
  $("#habitDone").textContent = `${doneToday} of ${habits.length}`;
  $("#habitStreakBig").textContent = bestNow > 0
    ? `${bestNow} ${bestHabit?.cadence === "weekly" ? (bestNow === 1 ? "week" : "weeks") : (bestNow === 1 ? "day" : "days")}`
    : "—";
  $("#habitStreakLabel").textContent = bestNow > 0 ? `Best run — ${bestHabit?.name || ""}` : "No streak running yet";

  habits.forEach((h) => {
    const s = streakFor(h);
    const todayState = habitStatusToday(h.id);
    const card = document.createElement("div");
    card.className = "fpb-habit-card" + (s.current > 0 ? " hot" : "");

    const isWeekly = h.cadence === "weekly";
    const chip = isWeekly
      ? `<span class="fpb-habit-chip">${s.thisWeek} of ${h.target} this week</span>`
      : (s.current > 0
          ? `<span class="fpb-habit-chip hot">🔥 ${s.current} in a row</span>`
          : `<span class="fpb-habit-chip">Not started</span>`);

    const cadenceText = isWeekly
      ? `${h.target} times a week · ${h.points} pts`
      : `Every day · ${h.points} pts`;

    // Last 7 days, oldest to newest
    let dots = "";
    for (let i = 6; i >= 0; i--) {
      const d = addDays(new Date(), -i);
      const k = dayKey(d);
      const letter = ["S", "M", "T", "W", "T", "F", "S"][d.getDay()];
      const ent = entries.find((x) => x.source === "habit" && x.habitId === h.id && (x.dayKey || dayKey(x.date)) === k && x.status !== "rejected");
      let cls = "empty";
      let inner = "";
      if (ent?.status === "approved") cls = "done";
      else if (ent?.status === "pending") cls = "pending";
      else if (k === s.restUsedOn) { cls = "rest"; inner = "🛡"; }
      else if (i === 0) cls = "today";
      dots += `<div class="fpb-dot-col"><div class="fpb-dot ${cls}">${inner}</div><span>${letter}</span></div>`;
    }

    // Next badge
    const ladder = badgeLadder(h);
    const next = ladder.find((m) => m > s.current);
    const nextLine = next
      ? `${next - s.current} more ${isWeekly ? (next - s.current === 1 ? "week" : "weeks") : (next - s.current === 1 ? "day" : "days")} to the ${next}-${isWeekly ? "week" : "day"} badge`
      : "Every badge earned — outstanding";

    // This week's progress toward the completion bonus
    const bonus = Number(h.bonus) || 0;
    const goal = weeklyGoal(h);
    const thisWeekTicks = ticksInWeek(h.id, startOfWeek(new Date()));
    let goalLine = "";
    if (bonus > 0) {
      const hit = thisWeekTicks >= goal;
      const left = goal - thisWeekTicks;
      goalLine = hit
        ? `<div class="fpb-goal-line hit">✓ Weekly goal hit — +${bonus} pts banked</div>`
        : `<div class="fpb-goal-line"><div class="fpb-goal-bar"><span style="width:${Math.min(100, Math.round((thisWeekTicks / goal) * 100))}%"></span></div><div class="fpb-goal-text">${thisWeekTicks} of ${goal} this week · ${left} more for +${bonus} pts</div></div>`;
    }

    let action;
    if (todayState === "approved") {
      action = `<button class="fpb-habit-btn done" disabled>✓ Done today</button>`;
    } else if (todayState === "pending") {
      action = `<div class="fpb-habit-pending">⏳ Ticked — waiting to be approved</div>`;
    } else {
      action = `<button class="fpb-habit-btn" data-tick="${h.id}">Mark done today</button>`;
    }

    card.innerHTML = `
      <div class="fpb-habit-head">
        <div class="fpb-habit-title">
          <div class="fpb-habit-name">${escapeHtml(h.name)}</div>
          <div class="fpb-habit-cadence">${escapeHtml(cadenceText)}</div>
        </div>
        ${chip}
      </div>
      <div class="fpb-dots">${dots}</div>
      ${goalLine}
      ${action}
      <div class="fpb-habit-next">${escapeHtml(nextLine)}</div>`;

    const btn = card.querySelector("[data-tick]");
    if (btn) btn.onclick = () => tickHabit(h, btn);
    wrap.appendChild(card);
  });

  renderBadgeShelf(habits);
}

function renderBadgeShelf(habits) {
  const shelf = $("#badgeGrid");
  shelf.innerHTML = "";
  const earned = [];
  habits.forEach((h) => {
    const best = streakFor(h, true).best;
    badgeLadder(h).forEach((m) => {
      if (best >= m) earned.push({ habit: h, milestone: m });
    });
  });

  // Show what's coming next so the shelf isn't bare early on.
  const upcoming = [];
  habits.forEach((h) => {
    const best = streakFor(h, true).best;
    const next = badgeLadder(h).find((m) => best < m);
    if (next) upcoming.push({ habit: h, milestone: next });
  });

  if (!earned.length && !upcoming.length) { $("#badgeShelf").hidden = true; return; }
  $("#badgeShelf").hidden = false;

  earned.forEach(({ habit, milestone }) => {
    const el = document.createElement("div");
    el.className = "fpb-badge-item";
    el.innerHTML = `<div class="fpb-badge-medal">🔥</div><span>${milestone} ${habit.cadence === "weekly" ? "wk" : "day"}</span><span class="fpb-badge-sub">${escapeHtml(habit.name)}</span>`;
    shelf.appendChild(el);
  });
  upcoming.slice(0, 3).forEach(({ habit, milestone }) => {
    const el = document.createElement("div");
    el.className = "fpb-badge-item locked";
    el.innerHTML = `<div class="fpb-badge-medal">🔒</div><span>${milestone} ${habit.cadence === "weekly" ? "wk" : "day"}</span><span class="fpb-badge-sub">${escapeHtml(habit.name)}</span>`;
    shelf.appendChild(el);
  });
}

async function tickHabit(habit, btn) {
  if (submitting) return;
  if (habitStatusToday(habit.id)) { toast("Already done today"); return; }
  submitting = true;
  if (btn) btn.disabled = true;
  const isParent = role === "parent";
  const now = new Date();
  const ok = await safeWrite(
    () => addDoc(entriesCol, {
      kidId: activeKid,
      type: "earn",
      source: "habit",
      habitId: habit.id,
      name: habit.name,
      points: habit.points,
      date: now.toISOString(),
      dayKey: dayKey(now),
      status: isParent ? "approved" : "pending",
      submittedBy: isParent ? "parent" : "kid",
    }),
    "Couldn't save that"
  );
  if (ok) toast(isParent ? `${habit.name} — done!` : `Ticked: ${habit.name} — waiting for approval`);
  submitting = false;
  if (btn) btn.disabled = false;
}

/**
 * Awards milestone bonuses. Uses a deterministic document id per
 * kid+habit+milestone, so repeated runs (or two devices at once) can never
 * create a duplicate. Driven by approved ticks only.
 */
async function ensureBadges() {
  if (!family || !entriesLoaded) return;
  for (const h of family.habits || []) {
    const best = streakFor(h, true).best;
    const bonusTable = BADGE_BONUS[h.cadence === "weekly" ? "weekly" : "daily"];
    for (const m of badgeLadder(h)) {
      if (best < m) continue;
      const id = `badge_${h.kidId}_${h.id}_${m}`;
      if (entries.some((e) => e.id === id)) continue;
      const bonus = bonusTable[m] || 0;
      if (!bonus) continue;
      try {
        await setDoc(doc(db, "families", FAMILY_ID, "entries", id), {
          kidId: h.kidId,
          type: "earn",
          source: "badge",
          habitId: h.id,
          name: `${m}-${h.cadence === "weekly" ? "week" : "day"} badge — ${h.name}`,
          points: bonus,
          date: new Date().toISOString(),
          dayKey: dayKey(new Date()),
          status: "approved",
          submittedBy: "system",
        });
        toast(`Badge unlocked: ${m} ${h.cadence === "weekly" ? "weeks" : "days"} of ${h.name}! +${bonus} pts`);
      } catch (err) { console.error(err); }
    }
  }
}

function weekKeyOf(d) {
  return dayKey(startOfWeek(d));
}

/** Weeks from a habit's first approved tick through to the current week. */
function habitWeeks(habitId) {
  const days = [...habitTickDays(habitId, true)].sort();
  if (!days.length) return [];
  const out = [];
  const thisWeek = startOfWeek(new Date());
  for (let ws = startOfWeek(dayFromKey(days[0])); ws <= thisWeek; ws = addDays(ws, 7)) {
    out.push(new Date(ws));
  }
  return out;
}

function ticksInWeek(habitId, weekStart) {
  const we = endOfWeek(weekStart);
  return [...habitTickDays(habitId, true)].filter((k) => {
    const d = dayFromKey(k);
    return d >= weekStart && d <= we;
  }).length;
}

/** How many ticks a habit needs in one week to earn its completion bonus.
 *  Daily habits require a perfect week; weekly ones require their target. */
function weeklyGoal(habit) {
  return habit.cadence === "weekly" ? (habit.target || 3) : 7;
}

/**
 * Pays the per-week completion bonus every week the goal is met — not just at
 * milestones. Awarded as soon as the goal is hit, even mid-week. Removed again
 * if an approval is later withdrawn and the week no longer qualifies.
 */
async function ensureWeeklyBonuses() {
  if (!family || !entriesLoaded) return;
  for (const h of family.habits || []) {
    const bonus = Number(h.bonus) || 0;
    const goal = weeklyGoal(h);
    for (const ws of habitWeeks(h.id)) {
      const id = `wbonus_${h.kidId}_${h.id}_${weekKeyOf(ws)}`;
      const existing = entries.find((e) => e.id === id);
      const met = bonus > 0 && ticksInWeek(h.id, ws) >= goal;

      if (met && !existing) {
        try {
          await setDoc(doc(db, "families", FAMILY_ID, "entries", id), {
            kidId: h.kidId,
            type: "earn",
            source: "bonus",
            habitId: h.id,
            name: `Weekly goal — ${h.name}`,
            points: bonus,
            date: new Date().toISOString(),
            dayKey: dayKey(new Date()),
            weekKey: weekKeyOf(ws),
            status: "approved",
            submittedBy: "system",
          });
          if (weekKeyOf(ws) === weekKeyOf(new Date())) {
            toast(`Weekly goal hit: ${h.name}! +${bonus} pts`);
          }
        } catch (err) { console.error(err); }
      } else if (!met && existing) {
        // An approval was pulled back, so the week no longer qualifies.
        try {
          await deleteDoc(doc(db, "families", FAMILY_ID, "entries", id));
        } catch (err) { console.error(err); }
      } else if (met && existing && Number(existing.points) !== bonus) {
        // Bonus value was edited in Settings — bring the current week into line.
        if (weekKeyOf(ws) === weekKeyOf(new Date())) {
          try {
            await updateDoc(doc(db, "families", FAMILY_ID, "entries", id), { points: bonus });
          } catch (err) { console.error(err); }
        }
      }
    }
  }
}

/* ---------------- profiles & messages ---------------- */

const profilesRef = doc(db, "families", FAMILY_ID, "config", "profiles");
const messagesCol = collection(db, "families", FAMILY_ID, "messages");

let profiles = {};
let messages = [];
let msgThreadKid = null;

const EMOJI_CHOICES = ["🏀","🏊","⚡","🦖","🐱","🐶","🦊","🐼","🚀","🌟","🔥","🎸","🍕","🦄","👾","🐉","🍦","⚽"];

function profileOf(kidId) {
  return profiles[kidId] || {};
}

/** Accent comes from the child's own choice when they've made one. */
function accentOf(kid) {
  if (!kid) return "#D4A039";
  return profileOf(kid.id).accent || kid.accent || "#D4A039";
}

function listenProfiles() {
  onSnapshot(profilesRef, (snap) => {
    profiles = snap.exists() ? (snap.data() || {}) : {};
    renderAll();
  }, (err) => console.error(err));
}

function listenMessages() {
  onSnapshot(query(messagesCol, orderBy("date", "asc")), (snap) => {
    messages = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderMsgBadge();
    if (!$("#msgModal").hidden) renderThread();
  }, (err) => console.error(err));
}

/** Paints an avatar into a target element: photo, else emoji, else initial. */
function paintAvatar(el, kid) {
  if (!el) return;
  const p = profileOf(kid?.id);
  el.innerHTML = "";
  el.style.background = "";
  if (p.avatar) {
    const img = document.createElement("img");
    img.src = p.avatar;
    img.alt = kid?.name || "";
    el.appendChild(img);
  } else if (p.emoji) {
    el.textContent = p.emoji;
  } else {
    el.textContent = (kid?.name || "?").charAt(0).toUpperCase();
    el.style.background = accentOf(kid);
  }
}

/**
 * Shrinks a chosen photo to a square thumbnail in the browser before it ever
 * leaves the device. Keeps Firestore documents small and avoids needing
 * Firebase Storage (and the billing account that now comes with it).
 */
function compressImage(file, size = 256) {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) return reject(new Error("Not an image"));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Couldn't read that file"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Couldn't open that image"));
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext("2d");
        // Centre-crop to a square so faces don't get squashed.
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        let q = 0.82;
        let out = canvas.toDataURL("image/jpeg", q);
        while (out.length > 120000 && q > 0.4) {
          q -= 0.12;
          out = canvas.toDataURL("image/jpeg", q);
        }
        resolve(out);
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* --- profile modal --- */

let draftProfile = null;
let draftKidId = null;

function openProfile() {
  const kid = (family?.kids || []).find((k) => k.id === activeKid);
  if (!kid) { toast("No child selected"); return; }
  draftKidId = kid.id;
  draftProfile = { ...profileOf(kid.id) };
  $("#profileTitle").textContent = role === "parent" ? `${kid.name}'s profile` : "My profile";
  $("#mottoInput").value = draftProfile.motto || "";
  renderProfileModal(kid);
  $("#profileModal").hidden = false;
}

function renderProfileModal(kid) {
  const preview = $("#avatarPreview");
  preview.innerHTML = "";
  preview.style.background = "";
  if (draftProfile.avatar) {
    const img = document.createElement("img");
    img.src = draftProfile.avatar;
    img.alt = "";
    preview.appendChild(img);
  } else if (draftProfile.emoji) {
    preview.textContent = draftProfile.emoji;
  } else {
    preview.textContent = (kid?.name || "?").charAt(0).toUpperCase();
    preview.style.background = draftProfile.accent || kid?.accent || "#D4A039";
  }

  const er = $("#emojiRow");
  er.innerHTML = "";
  EMOJI_CHOICES.forEach((em) => {
    const b = document.createElement("button");
    b.className = "fpb-emoji-btn" + (draftProfile.emoji === em && !draftProfile.avatar ? " active" : "");
    b.textContent = em;
    b.onclick = () => {
      draftProfile.emoji = draftProfile.emoji === em ? "" : em;
      if (draftProfile.emoji) draftProfile.avatar = "";
      renderProfileModal(kid);
    };
    er.appendChild(b);
  });

  const cr = $("#colourRow");
  cr.innerHTML = "";
  PALETTE.concat(["#E56A6A", "#6FBF73", "#E5B45A"]).forEach((col) => {
    const b = document.createElement("button");
    b.className = "fpb-colour-btn" + ((draftProfile.accent || kid?.accent) === col ? " active" : "");
    b.style.background = col;
    b.setAttribute("aria-label", `Colour ${col}`);
    b.onclick = () => { draftProfile.accent = col; renderProfileModal(kid); };
    cr.appendChild(b);
  });
}

$("#profileBtn").onclick = openProfile;
$("#profileClose").onclick = () => ($("#profileModal").hidden = true);

$("#avatarInput").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) { toast("That photo is too big — try a smaller one", true); return; }
  try {
    toast("Shrinking your photo…");
    draftProfile.avatar = await compressImage(file);
    draftProfile.emoji = "";
    renderProfileModal((family?.kids || []).find((k) => k.id === draftKidId));
  } catch (err) {
    console.error(err);
    toast(err.message || "Couldn't use that image", true);
  }
});

$("#avatarClear").onclick = () => {
  draftProfile.avatar = "";
  renderProfileModal((family?.kids || []).find((k) => k.id === draftKidId));
};

$("#profileSave").onclick = async () => {
  if (!draftKidId) return;
  draftProfile.motto = $("#mottoInput").value.trim();
  const ok = await safeWrite(
    () => setDoc(profilesRef, { [draftKidId]: draftProfile }, { merge: true }),
    "Couldn't save your profile"
  );
  if (ok) { $("#profileModal").hidden = true; toast("Profile saved"); }
};

/* --- messages --- */

function unreadCount() {
  if (role === "parent") return messages.filter((m) => m.from === "kid" && !m.readByParent).length;
  return messages.filter((m) => m.from === "parent" && m.kidId === deviceKidId && !m.readByKid).length;
}

function renderMsgBadge() {
  const n = unreadCount();
  const b = $("#msgBadge");
  b.textContent = n;
  b.hidden = n === 0;
}

function openMessages() {
  msgThreadKid = role === "parent" ? (msgThreadKid || activeKid) : deviceKidId;
  $("#msgTitle").textContent = role === "parent" ? "Messages" : "Message home";
  renderQuickPicks();
  renderThread();
  $("#msgModal").hidden = false;
  markRead();
}

function renderQuickPicks() {
  const wrap = $("#msgQuick");
  wrap.innerHTML = "";
  const picks = role === "parent"
    ? ["Proud of you 🎉", "Great effort today 💪", "Approved! ✅", "Let's talk tonight 💬"]
    : ["I did it! 🎉", "Can I have a hint? 🤔", "Guess what… 👀", "Love you ❤️"];
  picks.forEach((t) => {
    const b = document.createElement("button");
    b.className = "fpb-quick-btn";
    b.textContent = t;
    b.onclick = () => { $("#msgInput").value = t; $("#msgInput").focus(); };
    wrap.appendChild(b);
  });
}

function renderThread() {
  // Parent-side child switcher
  const kidRow = $("#msgKidRow");
  if (role === "parent" && (family?.kids || []).length > 1) {
    kidRow.hidden = false;
    kidRow.innerHTML = "";
    family.kids.forEach((k) => {
      const b = document.createElement("button");
      const unread = messages.filter((m) => m.kidId === k.id && m.from === "kid" && !m.readByParent).length;
      b.className = "fpb-msg-kidbtn" + (k.id === msgThreadKid ? " active" : "");
      b.textContent = k.name + (unread ? ` (${unread})` : "");
      b.onclick = () => { msgThreadKid = k.id; renderThread(); markRead(); };
      kidRow.appendChild(b);
    });
  } else {
    kidRow.hidden = true;
  }

  const box = $("#msgThread");
  box.innerHTML = "";
  const thread = messages.filter((m) => m.kidId === msgThreadKid);
  if (!thread.length) {
    box.innerHTML = '<div class="fpb-empty">No messages yet — say something silly.</div>';
    return;
  }
  thread.forEach((m) => {
    const mine = (role === "parent" && m.from === "parent") || (role === "kid" && m.from === "kid");
    const el = document.createElement("div");
    el.className = "fpb-msg" + (mine ? " mine" : "");
    el.innerHTML = `<div class="fpb-msg-bubble">${escapeHtml(m.text)}</div><div class="fpb-msg-meta">${escapeHtml(m.fromName || "")} · ${fmtDate(m.date)}</div>`;
    box.appendChild(el);
  });
  box.scrollTop = box.scrollHeight;
}

async function markRead() {
  const field = role === "parent" ? "readByParent" : "readByKid";
  const from = role === "parent" ? "kid" : "parent";
  const todo = messages.filter((m) => m.kidId === msgThreadKid && m.from === from && !m[field]);
  for (const m of todo) {
    try { await updateDoc(doc(db, "families", FAMILY_ID, "messages", m.id), { [field]: true }); }
    catch (err) { console.error(err); }
  }
}

async function sendMessage() {
  const input = $("#msgInput");
  const text = input.value.trim();
  if (!text) return;
  if (!msgThreadKid) { toast("Pick who you're messaging first"); return; }
  const kid = (family?.kids || []).find((k) => k.id === msgThreadKid);
  input.value = "";
  const ok = await safeWrite(
    () => addDoc(messagesCol, {
      kidId: msgThreadKid,
      from: role === "parent" ? "parent" : "kid",
      fromName: role === "parent" ? "Home" : (kid?.name || "Me"),
      text,
      date: new Date().toISOString(),
      readByParent: role === "parent",
      readByKid: role !== "parent",
    }),
    "Couldn't send that"
  );
  if (ok) toast("Sent");
}

$("#msgBtn").onclick = openMessages;
$("#msgClose").onclick = () => ($("#msgModal").hidden = true);
$("#msgSend").onclick = sendMessage;
$("#msgInput").addEventListener("keydown", (e) => { if (e.key === "Enter") sendMessage(); });

/* ---------------- history ---------------- */

function renderHistory() {
  const list = $("#historyList");
  list.innerHTML = "";
  if (!entriesLoaded) {
    list.innerHTML = '<div class="fpb-empty">Loading…</div>';
    return;
  }
  const items = entries.filter((e) => e.kidId === activeKid);
  if (!items.length) {
    list.innerHTML = '<div class="fpb-empty">Nothing logged yet — head to the Log tab to start.</div>';
    return;
  }
  items.forEach((e) => {
    const li = document.createElement("li");
    li.className = "fpb-history-row";
    const dotClass = e.status === "pending" ? "pending" : e.status === "rejected" ? "rejected" : e.type;
    const tag =
      e.status === "pending" ? '<span class="fpb-tag pending">PENDING</span>'
      : e.status === "rejected" ? '<span class="fpb-tag rejected">REJECTED</span>'
      : "";
    // Rejected entries never counted, so don't show them as a live +/- amount.
    const ptsClass = e.status === "rejected" ? "muted" : e.type;
    li.innerHTML = `
      <div class="fpb-history-main">
        <span class="fpb-history-dot ${dotClass}"></span>
        <div>
          <div class="fpb-history-name">${escapeHtml(e.name)}${tag}</div>
          <div class="fpb-history-date">${fmtDate(e.date)}</div>
        </div>
      </div>
      <div class="fpb-history-right">
        <span class="fpb-history-points ${ptsClass}">${e.type === "earn" ? "+" : "−"}${e.points}</span>
      </div>`;
    if (role === "parent") {
      const del = document.createElement("button");
      del.className = "fpb-icon-btn small";
      del.textContent = "🗑";
      del.setAttribute("aria-label", `Delete ${e.name}`);
      del.onclick = async () => {
        const yes = await confirmDialog("Delete this entry?", `"${e.name}" (${e.points} pts) will be removed permanently.`);
        if (!yes) return;
        await safeWrite(
          () => deleteDoc(doc(db, "families", FAMILY_ID, "entries", e.id)),
          "Couldn't delete that"
        );
      };
      li.querySelector(".fpb-history-right").appendChild(del);
    }
    list.appendChild(li);
  });
}

/* ---------------- approvals ---------------- */

function renderApprovals() {
  const list = $("#approvalsList");
  list.innerHTML = "";
  const pending = entries.filter((e) => e.status === "pending");
  if (!pending.length) {
    list.innerHTML = '<div class="fpb-empty">Nothing waiting for approval.</div>';
    return;
  }
  // Oldest first — approve in the order they came in.
  [...pending].reverse().forEach((e) => {
    const kid = (family?.kids || []).find((k) => k.id === e.kidId);
    const li = document.createElement("li");
    li.className = "fpb-history-row";
    // Warn if approving this redemption would take them below zero.
    const wouldOverdraw = e.type === "redeem" && balanceFor(e.kidId) < e.points;
    li.innerHTML = `
      <div class="fpb-history-main">
        <span class="fpb-history-dot pending"></span>
        <div>
          <div class="fpb-history-name">${escapeHtml(e.name)}${e.source === "habit" ? '<span class="fpb-tag habit">HABIT</span>' : ""}</div>
          <div class="fpb-history-sub">${escapeHtml(kid?.name || "Unknown")} · ${e.type === "earn" ? "+" : "−"}${e.points} pts · ${fmtDate(e.date)}</div>
          ${wouldOverdraw ? '<div class="fpb-warn-row">⚠ This would put them below zero</div>' : ""}
        </div>
      </div>
      <div class="fpb-approve-actions">
        <button class="fpb-approve-btn">Approve</button>
        <button class="fpb-reject-btn">Reject</button>
      </div>`;
    const [okBtn, noBtn] = li.querySelectorAll("button");
    okBtn.onclick = () => setStatus(e.id, "approved", [okBtn, noBtn]);
    noBtn.onclick = () => setStatus(e.id, "rejected", [okBtn, noBtn]);
    list.appendChild(li);
  });
}

async function setStatus(id, status, btns = []) {
  btns.forEach((b) => (b.disabled = true));
  const ok = await safeWrite(
    () => updateDoc(doc(db, "families", FAMILY_ID, "entries", id), { status }),
    "Couldn't update that"
  );
  if (ok) toast(status === "approved" ? "Approved" : "Rejected");
  else btns.forEach((b) => (b.disabled = false));
}

function renderApprovalBadge() {
  const n = entries.filter((e) => e.status === "pending").length;
  const badge = $("#pendingCount");
  badge.textContent = n;
  badge.hidden = n === 0;
}

/* ---------------- analytics ---------------- */

let analyticsPeriod = localStorage.getItem("fpb_period") || "month";

function periodBuckets(period) {
  const out = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  if (period === "week") {
    for (let i = 6; i >= 0; i--) {
      const d = addDays(today, -i);
      out.push({ start: d, end: new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999),
                 label: ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()] });
    }
  } else if (period === "month") {
    let ws = startOfWeek(today);
    const weeks = [];
    for (let i = 0; i < 5; i++) { weeks.unshift(new Date(ws)); ws = addDays(ws, -7); }
    weeks.forEach((w) => out.push({ start: w, end: endOfWeek(w), label: fmtDate(w) }));
  } else {
    for (let i = 11; i >= 0; i--) {
      const st = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const en = new Date(today.getFullYear(), today.getMonth() - i + 1, 0, 23, 59, 59, 999);
      out.push({ start: st, end: en, label: st.toLocaleDateString(undefined, { month: "short" }) });
    }
  }
  return out;
}

function periodRange(period) {
  const b = periodBuckets(period);
  return { start: b[0].start, end: b[b.length - 1].end };
}

/** Approved, non-redemption entries for the active child within a range. */
function earnedIn(start, end, kidId = activeKid) {
  return entries.filter((e) => {
    if (e.kidId !== kidId || e.status !== "approved" || e.type !== "earn") return false;
    const d = entryDate(e);
    return d >= start && d <= end;
  });
}

function isHabitish(e) {
  return e.source === "habit" || e.source === "badge" || e.source === "bonus";
}

function renderTrends() {
  $all("#periodRow .fpb-size-btn").forEach((b) => b.classList.toggle("active", b.dataset.period === analyticsPeriod));

  const buckets = periodBuckets(analyticsPeriod);
  const kid = (family?.kids || []).find((k) => k.id === activeKid);
  const accent = accentOf(kid);
  const labels = buckets.map((b) => b.label);

  const habitData = buckets.map((b) => earnedIn(b.start, b.end).filter(isHabitish).reduce((s, e) => s + e.points, 0));
  const otherData = buckets.map((b) => earnedIn(b.start, b.end).filter((e) => !isHabitish(e)).reduce((s, e) => s + e.points, 0));

  if (typeof Chart === "undefined") {
    $("#trendChart").hidden = true;
    $("#chartFallback").hidden = false;
  } else {
    $("#trendChart").hidden = false;
    $("#chartFallback").hidden = true;
    const key = JSON.stringify([activeKid, accent, analyticsPeriod, habitData, otherData, labels]);
    if (key !== lastChartKey) {
      lastChartKey = key;
      if (chartInstance) chartInstance.destroy();
      chartInstance = new Chart($("#trendChart").getContext("2d"), {
        type: "bar",
        data: {
          labels,
          datasets: [
            { label: "Habits", data: habitData, backgroundColor: accent, borderRadius: 4, stack: "s" },
            { label: "Chores & activities", data: otherData, backgroundColor: "#7CA8C9", borderRadius: 4, stack: "s" },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 300 },
          plugins: {
            legend: { display: true, position: "bottom", labels: { color: "#9AA6C0", boxWidth: 12, font: { size: 11 } } },
            tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${c.parsed.y} pts` } },
          },
          scales: {
            x: { stacked: true, ticks: { color: "#9AA6C0", maxRotation: 0, autoSkipPadding: 8 }, grid: { display: false } },
            y: { stacked: true, beginAtZero: true, ticks: { color: "#9AA6C0", precision: 0 }, grid: { color: "rgba(255,255,255,0.06)" } },
          },
        },
      });
    }
  }

  renderAnalyticsSummary();
  renderCategoryBreakdown();
  renderConsistency();
}

function renderAnalyticsSummary() {
  const { start, end } = periodRange(analyticsPeriod);
  const earned = earnedIn(start, end).reduce((s, e) => s + e.points, 0);
  const spent = entries
    .filter((e) => e.kidId === activeKid && e.status === "approved" && e.type === "redeem" &&
                   entryDate(e) >= start && entryDate(e) <= end)
    .reduce((s, e) => s + e.points, 0);
  const label = { week: "in the last 7 days", month: "in the last 5 weeks", year: "in the last 12 months" }[analyticsPeriod];
  $("#anEarned").textContent = earned;
  $("#anSpent").textContent = spent;
  $("#anNet").textContent = earned - spent;
  $("#anPeriodLabel").textContent = label;
}

function renderCategoryBreakdown() {
  const { start, end } = periodRange(analyticsPeriod);
  const rows = new Map();
  earnedIn(start, end).forEach((e) => {
    let cat;
    if (e.source === "habit") cat = "Habits";
    else if (e.source === "badge" || e.source === "bonus") cat = "Streak bonuses";
    else {
      const act = (family?.activities || []).find((a) => a.name === e.name);
      cat = (act?.category || "").trim() || "Other";
    }
    rows.set(cat, (rows.get(cat) || 0) + e.points);
  });

  const box = $("#catBreakdown");
  box.innerHTML = "";
  if (!rows.size) {
    box.innerHTML = '<div class="fpb-empty">Nothing logged in this period yet.</div>';
    return;
  }
  const sorted = [...rows.entries()].sort((a, b) => b[1] - a[1]);
  const max = sorted[0][1] || 1;
  sorted.forEach(([cat, pts]) => {
    const row = document.createElement("div");
    row.className = "fpb-an-row";
    row.innerHTML = `
      <div class="fpb-an-row-head"><span>${escapeHtml(cat)}</span><span class="fpb-an-pts">${pts}</span></div>
      <div class="fpb-an-bar"><span style="width:${Math.round((pts / max) * 100)}%"></span></div>`;
    box.appendChild(row);
  });
}

/** How often each habit actually happened, against how often it was meant to. */
function renderConsistency() {
  const box = $("#consistency");
  box.innerHTML = "";
  const habits = habitsForKid(activeKid);
  if (!habits.length) { $("#consistencyWrap").hidden = true; return; }
  $("#consistencyWrap").hidden = false;

  const { start, end } = periodRange(analyticsPeriod);
  const days = Math.round((end - start) / 86400000) + 1;
  const weeks = Math.max(1, days / 7);

  habits.forEach((h) => {
    const ticks = [...habitTickDays(h.id, true)].filter((k) => {
      const d = dayFromKey(k);
      return d >= start && d <= end;
    }).length;
    const expected = h.cadence === "weekly" ? Math.round(weeks * (h.target || 3)) : days;
    const pct = expected ? Math.min(100, Math.round((ticks / expected) * 100)) : 0;
    const row = document.createElement("div");
    row.className = "fpb-an-row";
    row.innerHTML = `
      <div class="fpb-an-row-head"><span>${escapeHtml(h.name)}</span><span class="fpb-an-pts">${pct}%</span></div>
      <div class="fpb-an-bar"><span class="${pct >= 80 ? "good" : pct >= 50 ? "mid" : "low"}" style="width:${pct}%"></span></div>
      <div class="fpb-an-sub">${ticks} of about ${expected} times</div>`;
    box.appendChild(row);
  });
}

$all("#periodRow .fpb-size-btn").forEach((btn) => {
  btn.onclick = () => {
    analyticsPeriod = btn.dataset.period;
    localStorage.setItem("fpb_period", analyticsPeriod);
    lastChartKey = "";
    renderTrends();
  };
});

/* ---------------- settings ---------------- */

$("#settingsBtn").onclick = () => {
  if (role !== "parent") return;
  renderSettings();
  $("#settingsModal").hidden = false;
};
$("#settingsClose").onclick = () => ($("#settingsModal").hidden = true);
$("#settingsModal").addEventListener("click", (e) => {
  if (e.target.id === "settingsModal") $("#settingsModal").hidden = true;
});

$all(".fpb-modal-tabs button[data-stab]").forEach((btn) => {
  btn.onclick = () => {
    $all(".fpb-modal-tabs button[data-stab]").forEach((b) => b.classList.toggle("active", b === btn));
    $all(".fpb-stab-panel").forEach((p) => (p.hidden = p.id !== "stab-" + btn.dataset.stab));
  };
});

function renderSettings() {
  if (!family) return;
  renderStabList("activities", family.activities, "points");
  renderStabList("rewards", family.rewards, "cost");
  renderKidsStab();
  renderHabitsStab();
  renderDisplayStab();
}

function renderHabitsStab() {
  const panel = $("#stab-habits");
  if (document.activeElement?.closest("#stab-habits")) return;
  panel.innerHTML = "";

  const kids = family.kids || [];
  if (!kids.length) {
    panel.innerHTML = '<p class="fpb-hint">Add a child first, on the Kids tab.</p>';
    return;
  }

  const hint = document.createElement("p");
  hint.className = "fpb-hint";
  hint.textContent = "Each child has their own habits. The bonus is paid every week the goal is met — a full 7 days for daily habits, or the target for weekly ones. Set it to 0 to turn it off.";
  panel.appendChild(hint);

  kids.forEach((kid) => {
    const head = document.createElement("div");
    head.className = "fpb-group-head";
    head.textContent = kid.name;
    panel.appendChild(head);

    const list = habitsForKid(kid.id);
    const ul = document.createElement("ul");
    ul.className = "fpb-modal-list";
    if (!list.length) {
      const li = document.createElement("li");
      li.innerHTML = '<span class="fpb-modal-list-name" style="color:var(--text-dim)">No habits yet</span>';
      ul.appendChild(li);
    }
    list.forEach((h) => {
      const li = document.createElement("li");
      const desc = h.cadence === "weekly" ? `${h.target}×/wk · ${h.points} pts` : `daily · ${h.points} pts`;
      li.innerHTML = `<span class="fpb-modal-list-name">${escapeHtml(h.name)}</span>`;
      const right = document.createElement("span");
      right.className = "fpb-modal-list-right";
      const tag = document.createElement("span");
      tag.className = "fpb-unit";
      tag.textContent = desc;

      // Inline bonus editor
      const bonusIn = document.createElement("input");
      bonusIn.type = "number"; bonusIn.min = "0";
      bonusIn.className = "fpb-inline-num";
      bonusIn.value = Number(h.bonus) || 0;
      bonusIn.title = "Weekly goal bonus";
      bonusIn.setAttribute("aria-label", `Weekly bonus for ${h.name}`);
      const commitBonus = async () => {
        const v = Number(bonusIn.value);
        if (!Number.isFinite(v) || v < 0) { bonusIn.value = Number(h.bonus) || 0; return; }
        if (v === (Number(h.bonus) || 0)) return;
        const next = (family.habits || []).map((x) => (x.id === h.id ? { ...x, bonus: v } : x));
        const ok = await safeWrite(() => updateDoc(familyRef, { habits: next }), "Couldn't save");
        if (ok) toast(v > 0 ? `${h.name} weekly bonus set to ${v} pts` : `${h.name} weekly bonus turned off`);
      };
      bonusIn.onblur = commitBonus;
      bonusIn.onkeydown = (e) => { if (e.key === "Enter") bonusIn.blur(); };
      const bonusLbl = document.createElement("span");
      bonusLbl.className = "fpb-unit";
      bonusLbl.textContent = "bonus";

      const rm = document.createElement("button");
      rm.className = "fpb-icon-btn small";
      rm.textContent = "🗑";
      rm.setAttribute("aria-label", `Remove ${h.name}`);
      rm.onclick = async () => {
        const yes = await confirmDialog("Remove this habit?", `"${h.name}" will be removed. Ticks already logged stay in the history.`, "Remove");
        if (!yes) return;
        const next = (family.habits || []).filter((x) => x.id !== h.id);
        await safeWrite(() => updateDoc(familyRef, { habits: next }), "Couldn't remove");
      };
      right.append(tag, bonusIn, bonusLbl, rm);
      li.appendChild(right);
      ul.appendChild(li);
    });
    panel.appendChild(ul);

    const row = document.createElement("div");
    row.className = "fpb-habit-add";
    row.innerHTML = `
      <input placeholder="New habit for ${escapeHtml(kid.name)}" data-hname maxlength="60" />
      <div class="fpb-habit-add-row">
        <select data-hcadence>
          <option value="daily">Every day</option>
          <option value="weekly">Times a week</option>
        </select>
        <input type="number" min="1" max="7" value="4" class="fpb-modal-add-num" data-htarget hidden />
        <input type="number" min="1" value="10" class="fpb-modal-add-num" data-hpoints aria-label="Points per tick" />
        <span class="fpb-unit">pts</span>
        <input type="number" min="0" value="15" class="fpb-modal-add-num" data-hbonus aria-label="Weekly goal bonus" />
        <span class="fpb-unit">bonus</span>
        <button class="fpb-icon-btn add" data-hadd aria-label="Add habit">+</button>
      </div>`;
    panel.appendChild(row);

    const cad = row.querySelector("[data-hcadence]");
    const tgt = row.querySelector("[data-htarget]");
    cad.onchange = () => { tgt.hidden = cad.value !== "weekly"; };

    row.querySelector("[data-hadd]").onclick = async () => {
      const name = row.querySelector("[data-hname]").value.trim();
      const points = Number(row.querySelector("[data-hpoints]").value);
      const cadence = cad.value;
      const target = Number(tgt.value);
      if (!name) { toast("Give the habit a name first"); return; }
      if (!Number.isFinite(points) || points <= 0) { toast("Enter a point value above zero"); return; }
      if (cadence === "weekly" && (!Number.isFinite(target) || target < 1 || target > 7)) {
        toast("Weekly target must be between 1 and 7"); return;
      }
      if (habitsForKid(kid.id).some((h) => h.name.toLowerCase() === name.toLowerCase())) {
        toast(`${kid.name} already has a habit called that`); return;
      }
      row.querySelector("[data-hname]").value = "";
      const bonusVal = Number(row.querySelector("[data-hbonus]").value);
      const entry = { id: uidLocal(), kidId: kid.id, name, points, cadence, bonus: Number.isFinite(bonusVal) && bonusVal > 0 ? bonusVal : 0 };
      if (cadence === "weekly") entry.target = target;
      const next = [...(family.habits || []), entry];
      const ok = await safeWrite(() => updateDoc(familyRef, { habits: next }), "Couldn't add habit");
      if (ok) toast(`Added ${name} for ${kid.name}`);
    };
  });
}

function renderDisplayStab() {
  const cfg = family?.sidePanels || {};
  // Don't clobber what the parent is mid-way through typing.
  if (document.activeElement?.closest("#stab-display")) return;
  $("#leftImg").value = cfg.leftImg || "";
  $("#leftCap").value = cfg.leftCap || "";
  $("#rightImg").value = cfg.rightImg || "";
  $("#rightCap").value = cfg.rightCap || "";
  $all("#sizeRow .fpb-size-btn").forEach((b) => b.classList.toggle("active", b.dataset.scale === currentScale()));
}

$("#saveSideBtn").onclick = async () => {
  const payload = {
    leftImg: $("#leftImg").value.trim(),
    leftCap: $("#leftCap").value.trim(),
    rightImg: $("#rightImg").value.trim(),
    rightCap: $("#rightCap").value.trim(),
  };
  for (const key of ["leftImg", "rightImg"]) {
    if (payload[key] && !isSafeImageUrl(payload[key])) {
      toast("That doesn't look like a valid image link", true);
      return;
    }
  }
  const ok = await safeWrite(() => updateDoc(familyRef, { sidePanels: payload }), "Couldn't save photos");
  if (ok) toast("Photos updated");
};

function renderStabList(key, list, valueKey) {
  const panel = $("#stab-" + key);
  const label = key === "activities" ? "activity" : "reward";
  // Preserve whatever the parent had half-typed before a background sync redrew this panel.
  const prevName = panel.querySelector("[data-name]")?.value || "";
  const prevVal = panel.querySelector("[data-val]")?.value || "";
  const prevCat = panel.querySelector("[data-cat]")?.value || "";
  panel.innerHTML = "";

  const ul = document.createElement("ul");
  ul.className = "fpb-modal-list";
  if (!list.length) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="fpb-modal-list-name" style="color:var(--text-dim)">No ${key} yet — add one below.</span>`;
    ul.appendChild(li);
  }
  if (key === "activities") {
    const dl = $("#fpb-cats");
    if (dl) {
      const cats = [...new Set(list.map((i) => (i.category || "").trim()).filter(Boolean))];
      if (!cats.includes("Chores")) cats.unshift("Chores");
      if (!cats.includes("Extra effort")) cats.push("Extra effort");
      dl.innerHTML = cats.map((c) => `<option value="${escapeHtml(c)}"></option>`).join("");
    }
  }

  list.forEach((item) => {
    const li = document.createElement("li");
    const catTag = key === "activities" && item.category
      ? `<span class="fpb-cat-tag">${escapeHtml(item.category)}</span>`
      : "";
    li.innerHTML = `<span class="fpb-modal-list-name">${escapeHtml(item.name)}${catTag}</span>`;
    const right = document.createElement("span");
    right.className = "fpb-modal-list-right";

    // Editable point value, so changing a value doesn't mean delete-and-re-add.
    const num = document.createElement("input");
    num.type = "number";
    num.min = "1";
    num.className = "fpb-inline-num";
    num.value = item[valueKey];
    num.setAttribute("aria-label", `Points for ${item.name}`);
    const commit = async () => {
      const v = Number(num.value);
      if (!Number.isFinite(v) || v <= 0) { num.value = item[valueKey]; return; }
      if (v === item[valueKey]) return;
      const next = list.map((i) => (i.id === item.id ? { ...i, [valueKey]: v } : i));
      const ok = await safeWrite(() => updateDoc(familyRef, { [key]: next }), "Couldn't save");
      if (ok) toast(`Updated ${item.name} to ${v} pts`);
    };
    num.onblur = commit;
    num.onkeydown = (e) => { if (e.key === "Enter") num.blur(); };

    const unit = document.createElement("span");
    unit.className = "fpb-unit";
    unit.textContent = "pts";

    const rm = document.createElement("button");
    rm.className = "fpb-icon-btn small";
    rm.textContent = "🗑";
    rm.setAttribute("aria-label", `Remove ${item.name}`);
    rm.onclick = async () => {
      const yes = await confirmDialog(
        `Remove this ${label}?`,
        `"${item.name}" will be removed from the list. Points already logged for it stay in the history.`,
        "Remove"
      );
      if (!yes) return;
      const next = list.filter((i) => i.id !== item.id);
      await safeWrite(() => updateDoc(familyRef, { [key]: next }), "Couldn't remove");
    };

    right.append(num, unit, rm);
    li.appendChild(right);
    ul.appendChild(li);
  });
  panel.appendChild(ul);

  const addRow = document.createElement("div");
  addRow.className = "fpb-modal-add";
  const catField = key === "activities"
    ? `<input placeholder="Group" list="fpb-cats" data-cat maxlength="24" class="fpb-cat-input" />`
    : "";
  addRow.innerHTML =
    `<input placeholder="New ${label}" data-name maxlength="60" />` +
    catField +
    `<input placeholder="pts" type="number" min="1" class="fpb-modal-add-num" data-val />` +
    `<button class="fpb-icon-btn add" data-add aria-label="Add ${label}">+</button>`;
  panel.appendChild(addRow);

  const nameEl = addRow.querySelector("[data-name]");
  const valEl = addRow.querySelector("[data-val]");
  const catEl = addRow.querySelector("[data-cat]");
  nameEl.value = prevName;
  valEl.value = prevVal;
  if (catEl) catEl.value = prevCat;

  const doAdd = async () => {
    const name = nameEl.value.trim();
    const val = Number(valEl.value);
    if (!name) { toast(`Give the ${label} a name first`); nameEl.focus(); return; }
    if (!Number.isFinite(val) || val <= 0) { toast("Enter a point value above zero"); valEl.focus(); return; }
    if (list.some((i) => i.name.toLowerCase() === name.toLowerCase())) {
      toast(`There's already a ${label} called that`);
      return;
    }
    // Clear immediately so a fast second add doesn't duplicate the first.
    nameEl.value = "";
    valEl.value = "";
    const item = { id: uidLocal(), name, [valueKey]: val };
    if (catEl) {
      // Reuse the last group so a run of chores doesn't need retyping.
      item.category = catEl.value.trim() || "Other";
    }
    const next = [...list, item];
    const ok = await safeWrite(() => updateDoc(familyRef, { [key]: next }), "Couldn't add that");
    if (ok) toast(`Added ${name}`);
    nameEl.focus();
  };
  addRow.querySelector("[data-add]").onclick = doAdd;
  [nameEl, valEl].forEach((el) => el.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); }));
}

function renderKidsStab() {
  const panel = $("#stab-kids");
  const prevName = panel.querySelector("[data-kidname]")?.value || "";
  panel.innerHTML = "";

  const hint = document.createElement("p");
  hint.className = "fpb-hint";
  hint.textContent = "Removing a child keeps their logged history in the database but hides them from the board.";
  panel.appendChild(hint);

  const ul = document.createElement("ul");
  ul.className = "fpb-modal-list";
  (family.kids || []).forEach((k) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="fpb-modal-list-name"><span class="fpb-kid-swatch" style="background:${escapeHtml(k.accent)}"></span>${escapeHtml(k.name)}</span>`;
    const right = document.createElement("span");
    right.className = "fpb-modal-list-right";
    const rm = document.createElement("button");
    rm.className = "fpb-icon-btn small";
    rm.textContent = "🗑";
    rm.setAttribute("aria-label", `Remove ${k.name}`);
    rm.onclick = async () => {
      const yes = await confirmDialog("Remove this child?", `${k.name} will no longer appear on the board.`, "Remove");
      if (!yes) return;
      const next = (family.kids || []).filter((x) => x.id !== k.id);
      await safeWrite(() => updateDoc(familyRef, { kids: next }), "Couldn't remove");
    };
    right.appendChild(rm);
    li.appendChild(right);
    ul.appendChild(li);
  });
  panel.appendChild(ul);

  const addRow = document.createElement("div");
  addRow.className = "fpb-modal-add";
  addRow.innerHTML = `<input placeholder="Add a child" data-kidname maxlength="30" /><button class="fpb-icon-btn add" data-addkid aria-label="Add child">+</button>`;
  panel.appendChild(addRow);
  const nameEl = addRow.querySelector("[data-kidname]");
  nameEl.value = prevName;

  const doAdd = async () => {
    const name = nameEl.value.trim();
    if (!name) return;
    const kids = family.kids || [];
    if (kids.some((k) => k.name.toLowerCase() === name.toLowerCase())) {
      toast("There's already a child with that name");
      return;
    }
    nameEl.value = "";
    const next = [...kids, { id: uidLocal(), name, accent: PALETTE[kids.length % PALETTE.length] }];
    const ok = await safeWrite(() => updateDoc(familyRef, { kids: next }), "Couldn't add");
    if (ok) toast(`Added ${name}`);
  };
  addRow.querySelector("[data-addkid]").onclick = doAdd;
  nameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") doAdd(); });
}

$("#savePinBtn").onclick = async () => {
  const val = $("#newPinInput").value.trim();
  if (val.length < 4) { toast("Use at least 4 digits"); return; }
  const ok = await safeWrite(() => updateDoc(familyRef, { parentPin: val }), "Couldn't save the PIN");
  if (ok) { $("#newPinInput").value = ""; toast("PIN updated"); }
};
$("#newPinInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#savePinBtn").click(); });
