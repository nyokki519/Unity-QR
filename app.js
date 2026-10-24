const $ = (selector) => document.querySelector(selector);
const KEY = "unity-checkin-demo-v2";
const params = new URLSearchParams(location.search);
const state = {
  member: null,
  busy: false,
  event:
    params.get("noevent") === "1"
      ? null
      : {
          id: params.get("event") || "2026-10-18-repeaters-night",
          title: "REPEATER’S NIGHT",
          date: "OCT 18",
          year: "2026",
          time: "19:30",
          location: "GOTANDA",
        },
};
let activeDialog = null;
let returnFocus = null;
let toastTimer;

function load() {
  // Storage access can fail in restricted browsers; callers surface that error.
  const raw = localStorage.getItem(KEY);
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const member = data.member;
  const validMember =
    member &&
    typeof member.name === "string" &&
    member.name.trim() &&
    member.name.length <= 24 &&
    typeof member.memberId === "string" &&
    /^U\d+$/.test(member.memberId) &&
    typeof member.memberSince === "string" &&
    /^\d{4}$/.test(member.memberSince) &&
    member.authMode === "demo";
  const entries =
    data.checkins &&
    typeof data.checkins === "object" &&
    !Array.isArray(data.checkins)
      ? Object.entries(data.checkins)
      : [];
  return {
    ...(validMember ? { member } : {}),
    checkins: Object.assign(
      Object.create(null),
      Object.fromEntries(
        entries.filter(
          ([, iso]) =>
            typeof iso === "string" && Number.isFinite(Date.parse(iso)),
        ),
      ),
    ),
  };
}

function save(data) {
  localStorage.setItem(KEY, JSON.stringify(data));
}
function fmt(iso) {
  return new Date(iso).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}
function visitDate(iso) {
  return new Date(iso)
    .toLocaleDateString("en-US", { month: "short", day: "2-digit" })
    .toUpperCase();
}

function openDialog(dialog, focusTarget) {
  if (!activeDialog) returnFocus = document.activeElement;
  if (activeDialog && activeDialog !== dialog) activeDialog.hidden = true;
  activeDialog = dialog;
  dialog.hidden = false;
  $(".shell").inert = true;
  document.body.classList.add("dialog-open");
  (focusTarget || dialog).focus({ preventScroll: true });
}
function closeDialog() {
  if (!activeDialog) return;
  activeDialog.hidden = true;
  activeDialog = null;
  $(".shell").inert = false;
  document.body.classList.remove("dialog-open");
  const target =
    returnFocus?.isConnected &&
    returnFocus.matches(
      "button:not(:disabled), input:not(:disabled), [tabindex]",
    )
      ? returnFocus
      : $("#profileBtn");
  target.focus({ preventScroll: true });
}
// Also keep keyboard focus inside the dialog on browsers without inert support.
document.addEventListener("keydown", (event) => {
  if (!activeDialog || event.key !== "Tab") return;
  const controls = [
    ...activeDialog.querySelectorAll("input, button:not([disabled])"),
  ];
  if (!controls.length) {
    event.preventDefault();
    return;
  }
  const first = controls[0],
    last = controls[controls.length - 1];
  if (
    !controls.includes(document.activeElement) ||
    (event.shiftKey && document.activeElement === first) ||
    (!event.shiftKey && document.activeElement === last)
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
});

function renderMember(member) {
  state.member = member;
  $("#memberName").textContent = member.name + ".";
  $("#cardName").textContent = member.name;
  $("#memberId").textContent = member.memberId;
  $("#memberSince").textContent = member.memberSince;
  $("#sinceStat").textContent = member.memberSince;
  $("#successName").textContent = member.name + ".";
  $("#successMember").textContent = "MEMBER " + member.memberId;
}
function renderStats(data) {
  const entries = Object.entries(data.checkins || {}).sort(
    (a, b) => Date.parse(b[1]) - Date.parse(a[1]),
  );
  $("#eventCount").textContent = entries.length;
  $("#lastVisit").textContent = entries[0] ? visitDate(entries[0][1]) : "—";
  $("#recentVisits").replaceChildren(
    ...entries.slice(0, 3).map(([id, iso]) => {
      const row = document.createElement("div");
      row.className = "visit";
      const title = document.createElement("span");
      title.textContent = id.includes("repeaters")
        ? "REPEATER’S NIGHT"
        : "UNITY EVENT";
      const date = document.createElement("span");
      date.textContent = visitDate(iso);
      row.append(title, date);
      return row;
    }),
  );
}
function renderChecked(iso, already) {
  const button = $("#checkinBtn");
  button.disabled = true;
  button.querySelector("span").textContent = already
    ? "ALREADY CHECKED IN"
    : "CHECKED IN";
  $("#checkinState").textContent = fmt(iso) + " · Welcome back.";
}
function resetCheckin() {
  $("#checkinBtn").disabled = false;
  $("#checkinBtn span").textContent = "CHECK IN";
  $("#checkinState").textContent = "";
}
function refresh(data) {
  if (data.member) renderMember(data.member);
  else {
    state.member = null;
    openDialog($("#welcomeModal"), $("#nameInput"));
  }
  renderStats(data);
  resetCheckin();
  if (state.event && data.member && data.checkins?.[state.event.id]) {
    renderChecked(data.checkins[state.event.id], true);
  }
}
function boot() {
  $("#eventCard").hidden = !state.event;
  $("#noEvent").hidden = !!state.event;
  try {
    if (params.get("reset") === "1") {
      localStorage.removeItem(KEY);
      params.delete("reset");
      history.replaceState(
        {},
        "",
        location.pathname +
          (params.toString() ? "?" + params : "") +
          location.hash,
      );
    }
    refresh(load());
  } catch {
    refresh({});
    showToast(
      "保存機能を利用できません。ブラウザの設定を確認して、もう一度お試しください。",
    );
  }
}

$("#registrationForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("#nameInput").value.trim();
  if (!name || name.length > 24) {
    $("#nameInput").setAttribute("aria-invalid", "true");
    $("#nameError").hidden = false;
    $("#nameInput").focus();
    return;
  }
  try {
    const data = load();
    data.member = {
      name,
      memberId: "U0001",
      memberSince: "2026",
      authMode: "demo",
    };
    save(data);
    renderMember(data.member);
    renderStats(data);
    closeDialog();
  } catch {
    showToast(
      "登録情報を保存できませんでした。ブラウザの設定を確認して、もう一度お試しください。",
    );
  }
});
$("#nameInput").addEventListener("input", () => {
  $("#nameInput").removeAttribute("aria-invalid");
  $("#nameError").hidden = true;
});

$("#checkinBtn").addEventListener("click", async () => {
  if (state.busy || !state.event) return;
  if (!state.member) {
    openDialog($("#welcomeModal"), $("#nameInput"));
    return;
  }
  state.busy = true;
  $("#checkinBtn").disabled = true;
  openDialog($("#checking"));
  try {
    await new Promise((resolve) => setTimeout(resolve, 900));
    // Re-read inside the transaction: never overwrite a snapshot taken before the wait.
    const checkin = () => {
      const data = load();
      if (!data.member) {
        refresh(data);
        return;
      }
      renderMember(data.member);
      const existing = data.checkins?.[state.event.id];
      if (existing) {
        renderChecked(existing, true);
        renderStats(data);
        closeDialog();
        return;
      }
      if (params.get("error") === "1")
        throw new Error("Demo communication failure");
      const now = new Date().toISOString();
      data.checkins = data.checkins || Object.create(null);
      Object.defineProperty(data.checkins, state.event.id, {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      save(data);
      renderChecked(now, false);
      renderStats(data);
      showSuccess(now);
    };
    // Web Locks serialize demo writes across tabs when supported. Production
    // still requires server-side authentication and unique(memberId,eventId).
    if (navigator.locks) await navigator.locks.request(KEY, checkin);
    else checkin();
  } catch {
    closeDialog();
    resetCheckin();
    showToast();
  } finally {
    state.busy = false;
  }
});
function showSuccess(iso) {
  $("#successDate").textContent = state.event.date + " " + state.event.year;
  $("#successTime").textContent = fmt(iso);
  $("#successEvent").textContent = state.event.title;
  openDialog($("#success"), $("#closeSuccess"));
}
function showToast(message = "Something went wrong. Please try again.") {
  const toast = $("#toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 5000);
}
$("#closeSuccess").addEventListener("click", closeDialog);
$("#profileBtn").addEventListener("click", () => {
  $("#myUnity").scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
    block: "start",
  });
  $("#myUnity").focus({ preventScroll: true });
});
window.addEventListener("storage", (event) => {
  if ((event.key === KEY || event.key === null) && !state.busy) {
    try {
      const data = load();
      if (data.member && activeDialog === $("#welcomeModal")) closeDialog();
      refresh(data);
    } catch {
      showToast();
    }
  }
});
boot();
