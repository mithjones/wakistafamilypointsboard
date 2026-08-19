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
    { id: "a1", name: "Basketball practice (extra)", points: 15 },
    { id: "a2", name: "Reading — 30 min", points: 10 },
    { id: "a3", name: "Chores", points: 5 },
    { id: "a4", name: "Dishes", points: 5 },
    { id: "a5", name: "Swim laps (extra)", points: 15 },
    { id: "a6", name: "Helped a sibling", points: 10 },
  ],
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
        parentPin: d?.parentPin || DEFAULTS.parentPin,
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
    b.style.setProperty("--accent", k.accent);
    b.textContent = k.name;
    if (role === "parent") {
      b.onclick = () => { activeKid = k.id; renderAll(); };
    }
    wrap.appendChild(b);
  });
}

function renderScoreboard() {
  const kid = (family?.kids || []).find((k) => k.id === activeKid);
  const bal = activeKid ? balanceFor(activeKid) : 0;
  const accent = kid?.accent || "#D4A039";
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
  const acts = family?.activities || [];
  if (!acts.length) {
    grid.innerHTML = '<div class="fpb-empty">No activities set up yet. A parent can add them in Settings.</div>';
    return;
  }
  if (!activeKid) {
    grid.innerHTML = '<div class="fpb-empty">Add a child in Settings to start logging.</div>';
    return;
  }
  acts.forEach((a) => {
    const b = document.createElement("button");
    b.className = "fpb-card fpb-card--earn";
    b.innerHTML = `<span class="fpb-card-name">${escapeHtml(a.name)}</span><span class="fpb-card-points">+${a.points}</span>`;
    b.onclick = () => submitEarn(a, b);
    grid.appendChild(b);
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
          <div class="fpb-history-name">${escapeHtml(e.name)}</div>
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

/* ---------------- trends ---------------- */

function weeksBack(n) {
  const weeks = [];
  const cursor = startOfWeek(new Date());
  for (let i = 0; i < n; i++) {
    const start = new Date(cursor);
    weeks.unshift({ start, end: endOfWeek(start) });
    cursor.setDate(cursor.getDate() - 7);
  }
  return weeks;
}

function renderTrends() {
  const weeks = weeksBack(8);
  const kid = (family?.kids || []).find((k) => k.id === activeKid);
  const accent = kid?.accent || "#D4A039";

  const inWeek = (e, w) => { const d = entryDate(e); return d >= w.start && d <= w.end; };
  const mine = entries.filter((e) => e.kidId === activeKid && e.status === "approved");
  const totals = weeks.map((w) =>
    mine.filter((e) => e.type === "earn" && inWeek(e, w)).reduce((s, e) => s + e.points, 0)
  );
  const labels = weeks.map((w) => fmtDate(w.start));

  // Chart.js loads from a CDN — degrade gracefully rather than throwing if it's blocked.
  if (typeof Chart === "undefined") {
    $("#trendChart").hidden = true;
    $("#chartFallback").hidden = false;
  } else {
    $("#trendChart").hidden = false;
    $("#chartFallback").hidden = true;
    // Only rebuild when the data actually changed, otherwise it flickers on every sync.
    const key = JSON.stringify([activeKid, accent, totals, labels]);
    if (key !== lastChartKey) {
      lastChartKey = key;
      if (chartInstance) chartInstance.destroy();
      chartInstance = new Chart($("#trendChart").getContext("2d"), {
        type: "line",
        data: {
          labels,
          datasets: [{
            label: kid?.name || "Points",
            data: totals,
            borderColor: accent,
            backgroundColor: accent + "33",
            tension: 0.35,
            fill: true,
            pointRadius: 3,
            pointBackgroundColor: accent,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 300 },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { title: (i) => `Week of ${i[0].label}`, label: (c) => `${c.parsed.y} pts` } },
          },
          scales: {
            x: { ticks: { color: "#9AA6C0", maxRotation: 0, autoSkipPadding: 12 }, grid: { color: "rgba(255,255,255,0.06)" } },
            y: { beginAtZero: true, ticks: { color: "#9AA6C0", precision: 0 }, grid: { color: "rgba(255,255,255,0.06)" } },
          },
        },
      });
    }
  }

  const listEl = $("#weekList");
  listEl.innerHTML = "";
  const thisWeekStart = startOfWeek(new Date()).getTime();
  [...weeks].reverse().forEach((w) => {
    const items = mine.filter((e) => inWeek(e, w));
    const earned = items.filter((e) => e.type === "earn").reduce((s, e) => s + e.points, 0);
    const spent = items.filter((e) => e.type === "redeem").reduce((s, e) => s + e.points, 0);
    const card = document.createElement("div");
    card.className = "fpb-week-card" + (w.start.getTime() === thisWeekStart ? " current" : "");
    const rows = items.length
      ? items.map((e) =>
          `<div class="fpb-week-item"><span>${escapeHtml(e.name)}</span><span>${e.type === "earn" ? "+" : "−"}${e.points}</span></div>`
        ).join("")
      : '<div class="fpb-week-item"><span>Nothing logged</span></div>';
    card.innerHTML = `
      <div class="fpb-week-head">
        <span>${fmtDate(w.start)} – ${fmtDate(w.end)}${w.start.getTime() === thisWeekStart ? " · this week" : ""}</span>
        <span class="fpb-week-total">${earned} pts</span>
      </div>
      ${spent ? `<div class="fpb-week-item" style="margin-top:6px;"><span>Redeemed this week</span><span>−${spent}</span></div>` : ""}
      <div class="fpb-week-items">${rows}</div>`;
    listEl.appendChild(card);
  });
}

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
}

function renderStabList(key, list, valueKey) {
  const panel = $("#stab-" + key);
  const label = key === "activities" ? "activity" : "reward";
  // Preserve whatever the parent had half-typed before a background sync redrew this panel.
  const prevName = panel.querySelector("[data-name]")?.value || "";
  const prevVal = panel.querySelector("[data-val]")?.value || "";
  panel.innerHTML = "";

  const ul = document.createElement("ul");
  ul.className = "fpb-modal-list";
  if (!list.length) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="fpb-modal-list-name" style="color:var(--text-dim)">No ${key} yet — add one below.</span>`;
    ul.appendChild(li);
  }
  list.forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="fpb-modal-list-name">${escapeHtml(item.name)}</span>`;
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
  addRow.innerHTML =
    `<input placeholder="New ${label}" data-name maxlength="60" />` +
    `<input placeholder="pts" type="number" min="1" class="fpb-modal-add-num" data-val />` +
    `<button class="fpb-icon-btn add" data-add aria-label="Add ${label}">+</button>`;
  panel.appendChild(addRow);

  const nameEl = addRow.querySelector("[data-name]");
  const valEl = addRow.querySelector("[data-val]");
  nameEl.value = prevName;
  valEl.value = prevVal;

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
    const next = [...list, { id: uidLocal(), name, [valueKey]: val }];
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
