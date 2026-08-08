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
let activeKid = null;
let role = localStorage.getItem("fpb_role"); // 'parent' | 'kid'
let deviceKidId = localStorage.getItem("fpb_kidId");
let currentTab = "earn";
let chartInstance = null;

const $ = (sel) => document.querySelector(sel);
const $all = (sel) => document.querySelectorAll(sel);

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), 2200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function startOfWeek(d) {
  const date = new Date(d);
  const day = date.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + diff);
  return date;
}
function uidLocal() {
  return Math.random().toString(36).slice(2, 10);
}

// ---------- Auth + init ----------
signInAnonymously(auth).catch((err) => toast("Sign-in failed: " + err.message));

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  await ensureFamilyDoc();
  listenFamily();
  listenEntries();
});

async function ensureFamilyDoc() {
  const snap = await getDoc(familyRef);
  if (!snap.exists()) await setDoc(familyRef, DEFAULTS);
}

function listenFamily() {
  onSnapshot(familyRef, (snap) => {
    family = snap.data() || DEFAULTS;
    if (family.kids?.length) {
      if (role === "kid" && deviceKidId && family.kids.find((k) => k.id === deviceKidId)) {
        activeKid = deviceKidId;
      } else if (!activeKid || !family.kids.find((k) => k.id === activeKid)) {
        activeKid = family.kids[0].id;
      }
    }
    maybeShowWhoAmI();
    renderAll();
  });
}

function listenEntries() {
  const q = query(entriesCol, orderBy("date", "desc"));
  onSnapshot(q, (snap) => {
    entries = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderAll();
  });
}

// ---------- Who am I ----------
function maybeShowWhoAmI() {
  if (role === "parent" || (role === "kid" && deviceKidId)) {
    $("#whoami").hidden = true;
    return;
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
      localStorage.setItem("fpb_role", "kid");
      localStorage.setItem("fpb_kidId", k.id);
      $("#whoami").hidden = true;
      renderAll();
    };
    wrap.appendChild(b);
  });
}

$("#whoami-parent-btn").onclick = () => openPinModal();
$("#switchUserBtn").onclick = () => {
  role = null;
  deviceKidId = null;
  localStorage.removeItem("fpb_role");
  localStorage.removeItem("fpb_kidId");
  maybeShowWhoAmI();
};

// ---------- PIN ----------
function openPinModal() {
  $("#pinTitle").textContent = "Enter parent PIN";
  $("#pinInput").value = "";
  $("#pinError").hidden = true;
  $("#pinModal").hidden = false;
  $("#pinInput").focus();
}
$("#pinCancel").onclick = () => ($("#pinModal").hidden = true);
$("#pinSubmit").onclick = submitPin;
$("#pinInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitPin();
});

function submitPin() {
  const val = $("#pinInput").value.trim();
  if (val !== (family?.parentPin || DEFAULTS.parentPin)) {
    $("#pinError").hidden = false;
    return;
  }
  $("#pinModal").hidden = true;
  role = "parent";
  localStorage.setItem("fpb_role", "parent");
  localStorage.removeItem("fpb_kidId");
  $("#whoami").hidden = true;
  renderAll();
}

// ---------- Tabs ----------
$all(".fpb-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentTab = btn.dataset.tab;
    $all(".fpb-tab").forEach((b) => b.classList.toggle("active", b === btn));
    $all(".fpb-view").forEach((v) => (v.hidden = true));
    $("#view-" + currentTab).hidden = false;
    renderCurrentView();
  });
});

function renderCurrentView() {
  if (currentTab === "earn") renderEarnGrid();
  else if (currentTab === "redeem") renderRedeemGrid();
  else if (currentTab === "history") renderHistory();
  else if (currentTab === "trends") renderTrends();
  else if (currentTab === "approvals") renderApprovals();
}

// ---------- Render: shell ----------
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
  $("#settingsBtn").hidden = role !== "parent";
  $("#approvalsTabBtn").hidden = role !== "parent";
}

function renderKidTabs() {
  const wrap = $("#kidtabs");
  wrap.innerHTML = "";
  const kids = family?.kids || [];
  const visible = role === "kid" ? kids.filter((k) => k.id === deviceKidId) : kids;
  visible.forEach((k) => {
    const b = document.createElement("button");
    b.className = "fpb-kidtab" + (k.id === activeKid ? " active" : "");
    b.style.setProperty("--accent", k.accent);
    b.textContent = k.name;
    b.onclick = () => {
      if (role === "parent") {
        activeKid = k.id;
        renderAll();
      }
    };
    wrap.appendChild(b);
  });
}

function approvedEntriesFor(kidId) {
  return entries.filter((e) => e.kidId === kidId && e.status === "approved");
}
function balanceFor(kidId) {
  return approvedEntriesFor(kidId).reduce((s, e) => s + (e.type === "earn" ? e.points : -e.points), 0);
}

function renderScoreboard() {
  const kid = (family?.kids || []).find((k) => k.id === activeKid);
  const bal = activeKid ? balanceFor(activeKid) : 0;
  const accent = kid?.accent || "#D4A039";
  const str = String(Math.max(0, bal)).padStart(3, "0").split("");
  const box = $("#scoreboard");
  box.innerHTML = "";
  str.forEach((d) => {
    const digit = document.createElement("span");
    digit.className = "fpb-digit";
    const s = document.createElement("span");
    s.textContent = d;
    s.style.color = accent;
    digit.appendChild(s);
    box.appendChild(digit);
  });
  const weekStart = startOfWeek(new Date());
  const weekPts = approvedEntriesFor(activeKid)
    .filter((e) => e.type === "earn" && new Date(e.date) >= weekStart)
    .reduce((s, e) => s + e.points, 0);
  $("#weekPoints").textContent = `${weekPts} pts earned this week`;
}

// ---------- Log / Rewards ----------
function renderEarnGrid() {
  const grid = $("#earnGrid");
  grid.innerHTML = "";
  const acts = family?.activities || [];
  if (!acts.length) {
    grid.innerHTML = '<div class="fpb-empty">No activities yet. Ask a parent to add some in Settings.</div>';
    return;
  }
  acts.forEach((a) => {
    const b = document.createElement("button");
    b.className = "fpb-card fpb-card--earn";
    b.innerHTML = `<span class="fpb-card-name">${escapeHtml(a.name)}</span><span class="fpb-card-points">+${a.points}</span>`;
    b.onclick = () => submitEarn(a);
    grid.appendChild(b);
  });
}

async function submitEarn(activity) {
  if (!activeKid) return;
  const isParent = role === "parent";
  await addDoc(entriesCol, {
    kidId: activeKid,
    type: "earn",
    name: activity.name,
    points: activity.points,
    date: new Date().toISOString(),
    status: isParent ? "approved" : "pending",
    submittedBy: isParent ? "parent" : "kid",
  });
  toast(isParent ? `+${activity.points} pts — ${activity.name}` : `Submitted for approval: ${activity.name}`);
}

function renderRedeemGrid() {
  const grid = $("#redeemGrid");
  grid.innerHTML = "";
  const rewards = family?.rewards || [];
  const bal = balanceFor(activeKid);
  if (!rewards.length) {
    grid.innerHTML = '<div class="fpb-empty">No rewards yet.</div>';
    return;
  }
  rewards.forEach((r) => {
    const can = bal >= r.cost;
    const b = document.createElement("button");
    b.className = "fpb-card fpb-card--redeem" + (can ? "" : " locked");
    b.disabled = !can;
    b.innerHTML = `<span class="fpb-card-name">${escapeHtml(r.name)}</span><span class="fpb-card-points">${r.cost} pts</span>`;
    b.onclick = () => submitRedeem(r);
    grid.appendChild(b);
  });
}

async function submitRedeem(reward) {
  const bal = balanceFor(activeKid);
  if (bal < reward.cost) {
    toast(`Not enough points — need ${reward.cost - bal} more`);
    return;
  }
  const isParent = role === "parent";
  await addDoc(entriesCol, {
    kidId: activeKid,
    type: "redeem",
    name: reward.name,
    points: reward.cost,
    date: new Date().toISOString(),
    status: isParent ? "approved" : "pending",
    submittedBy: isParent ? "parent" : "kid",
  });
  toast(isParent ? `Redeemed: ${reward.name}` : `Requested: ${reward.name} (awaiting approval)`);
}

// ---------- History ----------
function renderHistory() {
  const list = $("#historyList");
  list.innerHTML = "";
  const items = entries.filter((e) => e.kidId === activeKid);
  if (!items.length) {
    list.innerHTML = '<div class="fpb-empty">No activity yet.</div>';
    return;
  }
  items.forEach((e) => {
    const li = document.createElement("li");
    li.className = "fpb-history-row";
    const dotClass = e.status === "pending" ? "pending" : e.type;
    const tag =
      e.status === "pending"
        ? '<span class="fpb-pending-tag">PENDING</span>'
        : e.status === "rejected"
        ? '<span class="fpb-pending-tag" style="background:#E56A6A;color:#2a0808;">REJECTED</span>'
        : "";
    li.innerHTML = `
      <div class="fpb-history-main">
        <span class="fpb-history-dot ${dotClass}"></span>
        <div>
          <div class="fpb-history-name">${escapeHtml(e.name)} ${tag}</div>
          <div class="fpb-history-date">${fmtDate(e.date)}</div>
        </div>
      </div>
      <div class="fpb-history-right">
        <span class="fpb-history-points ${e.type}">${e.type === "earn" ? "+" : "−"}${e.points}</span>
        ${role === "parent" ? `<button class="fpb-icon-btn small" data-del="${e.id}">🗑</button>` : ""}
      </div>`;
    list.appendChild(li);
  });
  list.querySelectorAll("[data-del]").forEach((btn) => {
    btn.onclick = () => deleteDoc(doc(db, "families", FAMILY_ID, "entries", btn.dataset.del));
  });
}

// ---------- Approvals ----------
function renderApprovals() {
  const list = $("#approvalsList");
  list.innerHTML = "";
  const pending = entries.filter((e) => e.status === "pending");
  if (!pending.length) {
    list.innerHTML = '<div class="fpb-empty">No pending approvals 🎉</div>';
    return;
  }
  pending.forEach((e) => {
    const kid = (family?.kids || []).find((k) => k.id === e.kidId);
    const li = document.createElement("li");
    li.className = "fpb-history-row";
    li.innerHTML = `
      <div class="fpb-history-main">
        <span class="fpb-history-dot pending"></span>
        <div>
          <div class="fpb-history-name">${escapeHtml(e.name)}</div>
          <div class="fpb-history-sub">${kid?.name || "?"} · ${e.type === "earn" ? "+" : "−"}${e.points} pts · ${fmtDate(e.date)}</div>
        </div>
      </div>
      <div class="fpb-approve-actions">
        <button class="fpb-approve-btn" data-approve="${e.id}">Approve</button>
        <button class="fpb-reject-btn" data-reject="${e.id}">Reject</button>
      </div>`;
    list.appendChild(li);
  });
  list.querySelectorAll("[data-approve]").forEach((b) => (b.onclick = () => setStatus(b.dataset.approve, "approved")));
  list.querySelectorAll("[data-reject]").forEach((b) => (b.onclick = () => setStatus(b.dataset.reject, "rejected")));
}

async function setStatus(id, status) {
  await updateDoc(doc(db, "families", FAMILY_ID, "entries", id), { status });
  toast(status === "approved" ? "Approved" : "Rejected");
}

function renderApprovalBadge() {
  const n = entries.filter((e) => e.status === "pending").length;
  const badge = $("#pendingCount");
  if (n > 0) {
    badge.hidden = false;
    badge.textContent = n;
  } else badge.hidden = true;
}

// ---------- Trends ----------
function weeksBack(n) {
  const weeks = [];
  const cursor = startOfWeek(new Date());
  for (let i = 0; i < n; i++) {
    const start = new Date(cursor);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    weeks.unshift({ start, end, label: fmtDate(start.toISOString()) });
    cursor.setDate(cursor.getDate() - 7);
  }
  return weeks;
}

function renderTrends() {
  if (!activeKid) return;
  const weeks = weeksBack(8);
  const approvedEarn = approvedEntriesFor(activeKid).filter((e) => e.type === "earn");
  const totals = weeks.map((w) =>
    approvedEarn
      .filter((e) => {
        const d = new Date(e.date);
        return d >= w.start && d <= new Date(w.end.getTime() + 86399999);
      })
      .reduce((s, e) => s + e.points, 0)
  );

  const kid = (family?.kids || []).find((k) => k.id === activeKid);
  const accent = kid?.accent || "#D4A039";

  const ctx = $("#trendChart").getContext("2d");
  if (chartInstance) chartInstance.destroy();
  chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: weeks.map((w) => w.label),
      datasets: [
        {
          label: kid?.name || "Points",
          data: totals,
          borderColor: accent,
          backgroundColor: accent + "33",
          tension: 0.35,
          fill: true,
          pointRadius: 3,
          pointBackgroundColor: accent,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#9AA6C0" }, grid: { color: "rgba(255,255,255,0.06)" } },
        y: { beginAtZero: true, ticks: { color: "#9AA6C0" }, grid: { color: "rgba(255,255,255,0.06)" } },
      },
    },
  });

  const listEl = $("#weekList");
  listEl.innerHTML = "";
  [...weeks].reverse().forEach((w) => {
    const items = entries.filter((e) => {
      if (e.kidId !== activeKid || e.status !== "approved") return false;
      const d = new Date(e.date);
      return d >= w.start && d <= new Date(w.end.getTime() + 86399999);
    });
    const total = items.filter((e) => e.type === "earn").reduce((s, e) => s + e.points, 0);
    const card = document.createElement("div");
    card.className = "fpb-week-card";
    const rangeLabel = `${fmtDate(w.start.toISOString())} – ${fmtDate(w.end.toISOString())}`;
    card.innerHTML = `
      <div class="fpb-week-head">
        <span>${rangeLabel}</span>
        <span class="fpb-week-total">${total} pts</span>
      </div>
      <div class="fpb-week-items">
        ${
          items.length
            ? items.map((e) => `<div class="fpb-week-item"><span>${escapeHtml(e.name)}</span><span>${e.type === "earn" ? "+" : "−"}${e.points}</span></div>`).join("")
            : '<div class="fpb-week-item"><span>No activity logged</span></div>'
        }
      </div>`;
    listEl.appendChild(card);
  });
}

// ---------- Settings ----------
$("#settingsBtn").onclick = () => {
  renderSettings();
  $("#settingsModal").hidden = false;
};
$("#settingsClose").onclick = () => ($("#settingsModal").hidden = true);

$all(".fpb-modal-tabs button[data-stab]").forEach((btn) => {
  btn.onclick = () => {
    $all(".fpb-modal-tabs button[data-stab]").forEach((b) => b.classList.toggle("active", b === btn));
    $all(".fpb-stab-panel").forEach((p) => (p.hidden = true));
    $("#stab-" + btn.dataset.stab).hidden = false;
  };
});

function renderSettings() {
  renderStabList("activities", family.activities || [], "points");
  renderStabList("rewards", family.rewards || [], "cost");
  renderKidsStab();
}

function renderStabList(key, list, valueKey) {
  const panel = $("#stab-" + key);
  panel.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "fpb-modal-list";
  list.forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>${escapeHtml(item.name)}</span><span class="fpb-modal-list-right">${item[valueKey]} pts <button class="fpb-icon-btn small" data-rm="${item.id}">🗑</button></span>`;
    ul.appendChild(li);
  });
  panel.appendChild(ul);

  const addRow = document.createElement("div");
  addRow.className = "fpb-modal-add";
  addRow.innerHTML = `<input placeholder="New ${key === "activities" ? "activity" : "reward"}" data-name /><input placeholder="pts" type="number" min="1" class="fpb-modal-add-num" data-val /><button class="fpb-icon-btn add" data-add>+</button>`;
  panel.appendChild(addRow);

  ul.querySelectorAll("[data-rm]").forEach((b) => {
    b.onclick = async () => {
      const next = list.filter((i) => i.id !== b.dataset.rm);
      await updateDoc(familyRef, { [key]: next });
    };
  });
  addRow.querySelector("[data-add]").onclick = async () => {
    const name = addRow.querySelector("[data-name]").value.trim();
    const val = Number(addRow.querySelector("[data-val]").value);
    if (!name || !val || val <= 0) return;
    const next = [...list, { id: uidLocal(), name, [valueKey]: val }];
    await updateDoc(familyRef, { [key]: next });
  };
}

function renderKidsStab() {
  const panel = $("#stab-kids");
  panel.innerHTML = "";
  const ul = document.createElement("ul");
  ul.className = "fpb-modal-list";
  (family.kids || []).forEach((k) => {
    const li = document.createElement("li");
    li.innerHTML = `<span><span class="fpb-kid-swatch" style="background:${k.accent}"></span>${escapeHtml(k.name)}</span>`;
    ul.appendChild(li);
  });
  panel.appendChild(ul);
  const addRow = document.createElement("div");
  addRow.className = "fpb-modal-add";
  addRow.innerHTML = `<input placeholder="Add a child" data-kidname /><button class="fpb-icon-btn add" data-addkid>+</button>`;
  panel.appendChild(addRow);
  addRow.querySelector("[data-addkid]").onclick = async () => {
    const name = addRow.querySelector("[data-kidname]").value.trim();
    if (!name) return;
    const palette = ["#D4A039", "#7CA8C9", "#A4C97C", "#C97CA4", "#C9A47C"];
    const accent = palette[(family.kids || []).length % palette.length];
    const next = [...(family.kids || []), { id: uidLocal(), name, accent }];
    await updateDoc(familyRef, { kids: next });
  };
}

$("#savePinBtn").onclick = async () => {
  const val = $("#newPinInput").value.trim();
  if (!val) return;
  await updateDoc(familyRef, { parentPin: val });
  $("#newPinInput").value = "";
  toast("PIN updated");
};
