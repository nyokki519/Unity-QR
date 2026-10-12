import { createScanner } from "./scanner.js";

const root = document.querySelector("#app"),
  toast = document.querySelector("#toast"),
  modal = document.querySelector("#modal");
const state = {
  actor: null,
  events: [],
  eventId: "",
  view: "dashboard",
  people: [],
  history: [],
  settings: null,
  search: "",
  status: "all",
  sort: "name",
};
const pending = new Map();
let scanner = null,
  toastTimer = null,
  refreshing = false,
  navigating = false,
  lastRefresh = 0,
  revision = 0;
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (value) =>
  value
    ? new Intl.DateTimeFormat("ja-JP", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "—";
const event = () => state.events.find((e) => e.id === state.eventId);
const admin = () => state.actor?.role === "Admin",
  write = () => state.actor?.role !== "Viewer";
const errors = {
  unauthorized: "ログインが必要です。",
  forbidden: "この操作の権限がありません。",
  too_many_attempts: "ログイン試行が多いため、15分後に再試行してください。",
  invalid_qr:
    "QRが正しくありません。このイベントの参加者QRを使用してください。",
  qr_expired: "QRの有効期限が切れています。再発行してください。",
  event_closed: "このイベントは受付時間外です。",
  capacity_reached: "定員に達しています。運営責任者に確認してください。",
  registration_cancelled: "参加登録がキャンセルされています。",
  participant_not_found: "このイベントに登録された参加者が見つかりません。",
  pass_disconnected:
    "Unity PASSは未接続です。通常の参加者受付を利用してください。",
  analytics_disconnected: "Analyticsは未接続です。設定済みの連携先が必要です。",
  integration_failed: "連携先に接続できません。受付記録は保存されています。",
  invalid_snapshot: "取込ファイルの形式が正しくありません。",
  invalid_input: "入力内容を確認してください。",
  invalid_event: "開催日時・受付時間・定員を確認してください。",
  reason_required: "変更理由を入力してください。",
  password_length: "パスワードは16〜128文字にしてください。",
  idempotency_conflict: "別の操作としてやり直してください。",
  undo_required: "先に受付を取り消してください。",
};
function notify(message, error = false) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.hidden = false;
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 10000);
}
async function api(path, body, method = body === undefined ? "GET" : "POST") {
  const identity = method + path + JSON.stringify(body);
  let id;
  if (method !== "GET") {
    id = pending.get(identity) || crypto.randomUUID();
    pending.set(identity, id);
  }
  let response;
  try {
    response = await fetch("/api/v2/" + path, {
      method,
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        ...(id ? { "Idempotency-Key": id } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "通信できませんでした。記録は未確認です。同じ操作を再試行してください。",
    );
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(
      "このURLには受付サーバーが接続されていません。運営用サーバーのURLを確認してください。",
    );
  }
  if (!response.ok) {
    if (response.status === 401 && path !== "login") {
      loggedOut();
    }
    const e = new Error(
      errors[data.error] ||
        "操作を完了できませんでした。入力内容や接続を確認してください。",
    );
    e.code = data.error;
    throw e;
  }
  pending.delete(identity);
  return data;
}
function destroyScanner() {
  scanner?.destroy();
  scanner = null;
}
function loggedOut() {
  revision++;
  navigating = false;
  destroyScanner();
  Object.assign(state, {
    actor: null,
    events: [],
    eventId: "",
    people: [],
    history: [],
    settings: null,
    view: "dashboard",
  });
  pending.clear();
  modal.close();
  document.querySelector("#modalContent").replaceChildren();
  renderLogin();
}
const brand =
  '<div class="brand"><span class="seal">U</span><div><strong>UNITY</strong><small>COMMUNITY OPERATIONS</small></div></div>';
function renderLogin() {
  root.innerHTML = `<main class="login"><section class="loginStory">${brand}<div><p class="eyebrow">UNITY QR / 2.0</p><h1>A quieter<br>welcome.</h1><p>出会いのはじまりを、心地よく。<br>Unityの時間をつなぐ、イベント受付。</p></div><footer>ONE COMMUNITY. MANY SHARED MOMENTS.</footer></section><section class="loginForm"><div><p class="eyebrow">OPERATIONS ACCESS</p><h2>運営ログイン</h2><form id="loginForm"><label>ユーザー名<input name="username" autocomplete="username" required maxlength="60"></label><label>パスワード<input name="password" type="password" autocomplete="current-password" required maxlength="128"></label><p class="errorNote" id="loginError" role="alert"></p><button class="primary full" type="submit">ログイン</button></form><p class="loginNote muted">許可されたイベントの受付・参加者管理にアクセスします。<br>参加者向けの会員証・受付は<a href="../">こちら</a>。</p></div></section></main>`;
}
const views = [
  ["dashboard", "ダッシュボード", "▦"],
  ["scanner", "スキャン", "⌗"],
  ["participants", "参加者", "♧"],
  ["events", "イベント", "◇"],
  ["history", "履歴", "≡"],
  ["settings", "設定", "⚙"],
];
function renderShell() {
  root.innerHTML = `<div class="frame"><aside class="sidebar">${brand}<nav class="nav" aria-label="運営ナビゲーション">${views
    .filter(([v]) => v !== "settings" || admin())
    .filter(([v]) => v !== "scanner" || write())
    .map(
      ([v, label, symbol]) =>
        `<button data-view="${v}" aria-current="${state.view === v ? "page" : "false"}"><span class="navSymbol" aria-hidden="true">${symbol}</span><span>${label}</span></button>`,
    )
    .join(
      "",
    )}</nav><div class="sidebarFoot">Quietly connected.<br>UNITY COMMUNITY / QR 2.0</div></aside><div class="workspace"><header class="topbar"><p class="eyebrow">COMMUNITY OPERATIONS</p><label class="eventSelect" for="eventSelect">イベント<select id="eventSelect">${state.events.length ? state.events.map((e) => `<option value="${esc(e.id)}" ${e.id === state.eventId ? "selected" : ""}>${esc(e.title)}</option>`).join("") : '<option value="">イベントなし</option>'}</select></label><button class="textButton" data-action="logout">ログアウト</button></header><main class="main" id="main"></main></div></div>`;
  renderView();
}
function pageHead(title, description, action = "") {
  return `<div class="pageHead"><div><p class="eyebrow">UNITY QR / ${esc(state.view.toUpperCase())}</p><h1 tabindex="-1">${title}</h1><p>${description}</p></div>${action || `<span class="roleBadge">${esc(state.actor.role)}</span>`}</div>`;
}
function metrics(e) {
  return `<div class="metrics">${[
    ["参加予定", e.total, "キャンセルを含む"],
    ["受付済み", e.checkedIn, "サーバーで確定"],
    ["未受付", e.waiting, "来場をお待ちしています"],
    ["キャンセル", e.cancelled, "受付対象外"],
  ]
    .map(
      ([label, count, hint]) =>
        `<div class="metric"><span>${label}</span><strong data-count="${esc(label)}">${count}</strong><small>${hint}</small></div>`,
    )
    .join("")}</div>`;
}
function empty(message) {
  return `<div class="panel empty"><p>${message}</p>${admin() ? '<button class="primary" data-action="newEvent">イベントを作成</button>' : ""}</div>`;
}
function dashboard() {
  const e = event();
  return (
    pageHead("受付ダッシュボード", "今日の出会いを、気持ちよく迎えましょう。") +
    (e
      ? `<section class="heroCard"><div><p class="eyebrow">SELECTED EVENT</p><h2>${esc(e.title)}</h2><p>${date(e.startsAt)} · ${esc(e.venue)}</p></div>${write() ? '<button class="primary" data-view="scanner">QR受付をはじめる →</button>' : ""}</section>${metrics(e)}<div class="grid"><section class="panel"><div class="panelHead"><h2>受付の状況</h2><span class="eyebrow">LIVE</span></div><p class="muted">${e.checkedIn} / ${e.capacity} 名が来場</p><progress value="${e.checkedIn}" max="${e.capacity}" aria-label="定員に対する受付人数"></progress><p class="hint">受付時間：${date(e.opensAt)} — ${date(e.closesAt)}<br>画面は約8秒ごとに更新されます。</p><button class="secondary" data-view="participants">参加者を確認する</button></section><section class="panel"><div class="panelHead"><h2>最近の受付</h2><button class="textButton" data-view="history">すべて見る →</button></div>${recentHistory(5)}</section></div>`
      : empty(
          "閲覧できるイベントがありません。管理者にイベントの作成・割当を確認してください。",
        ))
  );
}
function recentHistory(limit = 500) {
  const names = {
    checkin: "受付確定",
    undo: "受付取消",
    register: "参加登録",
    rename: "名前変更",
    cancel: "参加取消",
    event_create: "イベント作成",
    event_update: "イベント変更",
    restore: "参加取消の解除",
  };
  return state.history.length
    ? `<ol class="timeline">${state.history
        .slice(0, limit)
        .map(
          (h) =>
            `<li><div>${date(h.created_at)}<small>${esc(names[h.action] || h.action)}</small></div><div><strong>${esc(h.name || "イベント操作")}</strong>${h.reason ? `<p>${esc(h.reason)}</p>` : ""}<small>操作ID ${h.id} · ${esc(h.actor_id.slice(0, 8))}</small></div></li>`,
        )
        .join("")}</ol>`
    : '<p class="empty">まだ受付・変更の記録はありません。</p>';
}
function peopleHTML() {
  let list = state.people.filter(
    (p) =>
      (!state.search ||
        p.name
          .toLocaleLowerCase()
          .includes(state.search.toLocaleLowerCase())) &&
      (state.status === "all" || p.status === state.status),
  );
  list.sort((a, b) =>
    state.sort === "arrival"
      ? (b.checkedInAt || "").localeCompare(a.checkedInAt || "")
      : a.name.localeCompare(b.name, "ja"),
  );
  return list.length
    ? list
        .map(
          (p) =>
            `<article class="person" data-event="${esc(state.eventId)}"><div class="personInfo"><span class="pill ${esc(p.status)}">${{ checkedIn: "受付済み", waiting: "未受付", cancelled: "キャンセル" }[p.status]}</span><h3>${esc(p.name)}</h3><small>ID ${esc(p.id.slice(0, 8))}${p.memberId ? ` · PASS ${esc(p.memberId)}` : ""}${p.status === "checkedIn" ? ` · ${date(p.checkedInAt)}` : ""}</small>${p.nameMatches > 1 ? '<span class="duplicate">同名の参加者がいます。IDで確認してください。</span>' : ""}</div><div class="actions">${write() && p.status === "waiting" ? `<button class="primary" data-action="checkin" data-person="${esc(p.id)}">受付する</button>` : ""}${write() && p.status !== "cancelled" ? `<button class="secondary" data-action="ticket" data-person="${esc(p.id)}">QRを表示</button>` : ""}${admin() ? `<button class="textButton" data-action="rename" data-person="${esc(p.id)}">編集</button>${p.status === "checkedIn" ? `<button class="danger" data-action="undo" data-person="${esc(p.id)}">受付取消</button>` : p.status === "waiting" ? `<button class="textButton" data-action="cancel" data-person="${esc(p.id)}">参加取消</button>` : `<button class="secondary" data-action="restore" data-person="${esc(p.id)}">取消を解除</button>`}` : ""}</div></article>`,
        )
        .join("")
    : '<div class="empty">条件に一致する参加者はいません。</div>';
}
function participants() {
  return (
    pageHead(
      "参加者",
      "同姓同名は参加者IDで区別してください。",
      write() && event()
        ? '<div class="actions"><button class="primary" data-action="walkin">当日参加を登録</button></div>'
        : "",
    ) +
    (event()
      ? `${metrics(event())}<div class="filters"><label>名前で検索<input id="search" type="search" placeholder="参加者名を入力" value="${esc(state.search)}"></label><label>受付状態<select id="status"><option value="all">すべて</option><option value="waiting">未受付</option><option value="checkedIn">受付済み</option><option value="cancelled">キャンセル</option></select></label><label>並び替え<select id="sort"><option value="name">名前順</option><option value="arrival">来場日時順</option></select></label></div><div class="people" id="people">${peopleHTML()}</div>`
      : empty("イベントを選択してください。"))
  );
}
function scannerHTML() {
  return (
    pageHead(
      "QRスキャナー",
      "参加者QRを読み取り、サーバーで受付を確定します。",
    ) +
    (event()
      ? `<div class="grid"><section class="panel"><div class="cameraBox"><span class="cameraPlaceholder">U</span><video id="camera" autoplay muted playsinline></video><div class="scanFrame"></div></div><p class="cameraHint" id="cameraStatus" aria-live="polite">背面カメラを優先します。HTTPSとカメラの許可が必要です。</p><div class="scannerControls"><button class="primary" data-action="cameraStart">カメラを開始</button><button class="secondary" data-action="cameraStop">停止</button></div><label class="hint checkboxes"><span><input id="sound" type="checkbox">確認音を使う（対応端末のみ）</span></label></section><section class="panel"><div class="panelHead"><h2>読取結果</h2><span class="eyebrow">SERVER VERIFIED</span></div><div id="scanResult" class="scanResult"><strong>読取を待っています。</strong><span>受付確定後、ここに参加者名が表示されます。</span></div><form id="ticketForm" data-event="${esc(state.eventId)}"><label>QRの文字列<textarea name="ticket" maxlength="2048" required placeholder="カメラを使えない場合は文字列を貼り付け"></textarea></label><button class="primary full" type="submit">QRを確認して受付</button></form><p class="hint">通信できない場合、受付完了にはなりません。再試行するか、接続のあるスタッフ端末を使用してください。</p><button class="secondary full" data-view="participants">参加者検索へ</button></section></div>`
      : empty("受付するイベントを選択してください。"))
  );
}
function eventsHTML() {
  return (
    pageHead(
      "イベント管理",
      "開催日時・受付時間・会場と来場状況を確認できます。",
      admin()
        ? '<div class="actions"><button class="primary" data-action="newEvent">イベントを作成</button></div>'
        : "",
    ) +
    `<div class="eventList">${state.events.map((e) => `<article class="eventCard"><p class="eyebrow">${Date.parse(e.closesAt) < Date.now() ? "PAST EVENT" : "UPCOMING EVENT"}</p><h2>${esc(e.title)}</h2><span class="pill">${e.checkedIn}名 受付済み</span><div class="eventMeta"><span>開催<strong>${date(e.startsAt)}</strong></span><span>会場<strong>${esc(e.venue)}</strong></span><span>受付開始<strong>${date(e.opensAt)}</strong></span><span>受付終了<strong>${date(e.closesAt)}</strong></span><span>定員<strong>${e.capacity}名</strong></span>${e.externalId ? `<span>外部ID<strong>${esc(e.externalId)}</strong></span>` : ""}</div><div class="actions"><button class="primary" data-action="selectEvent" data-event="${esc(e.id)}">このイベントを選択</button>${admin() ? `<button class="secondary" data-action="editEvent" data-event="${esc(e.id)}">編集</button>` : ""}</div></article>`).join("") || empty("イベントがありません。")}</div>`
  );
}
function settingsHTML() {
  const s = state.settings;
  return (
    pageHead("設定・管理", "運営アクセスと連携状態を管理します。") +
    (s
      ? `<div class="settingsGrid"><section class="panel"><h2>サービス連携</h2>${[
          ["Unity PASS", "会員証QRのサーバー検証", s.passConnected],
          [
            "Analytics 取込",
            "イベント・参加予定者の取込",
            s.analyticsImportConnected,
          ],
          [
            "Analytics 来場同期",
            "受付・取消を冪等に送信",
            s.analyticsDeliveryConnected,
          ],
        ]
          .map(
            ([name, hint, connected]) =>
              `<div class="connection"><div><strong>${name}</strong><small>${hint}</small></div><span>${connected ? "設定あり・要接続確認" : "未接続"}</span></div>`,
          )
          .join(
            "",
          )}<p class="hint">未接続でも通常のQR受付は利用できます。接続情報・秘密鍵はサーバー環境設定で管理します。</p><div class="actions"><button class="secondary" data-action="importFile">JSONを確認して取込</button>${s.analyticsImportConnected ? '<button class="secondary" data-action="importRemote">Analyticsから取込</button>' : ""}<button class="secondary" data-action="sync">同期を再試行</button></div><p class="hint">未送信 ${s.sync.pending}件 / 失敗 ${s.sync.failed}件。未接続の記録は保持されます。</p><ul class="syncLog">${s.sync.runs.map((r) => `<li>${date(r.created_at)} · ${esc(r.kind)} · ${esc(r.status)} · ${esc(r.detail)}</li>`).join("") || "<li>まだ同期の記録はありません。</li>"}</ul></section><section class="panel"><div class="panelHead"><h2>スタッフ・権限</h2><button class="secondary" data-action="newUser">ユーザーを追加</button></div>${s.users.map((u) => `<div class="userRow"><div><strong>${esc(u.username)}</strong><small>${esc(u.role)} · ${u.enabled ? "有効" : "無効"} · ${u.eventIds.length}イベント割当</small></div>${u.enabled ? `<button class="textButton" data-action="disableUser" data-user="${esc(u.id)}">無効化</button>` : ""}</div>`).join("")}<p class="hint">Admin：全機能。Staff：割当イベントの受付・参加者確認。Viewer：割当イベントの閲覧のみ。</p></section><section class="panel"><h2>データ保護</h2><p class="hint">受付は永続DBに保存します。バックアップと復元確認はサーバーの専用コマンドで実施してください。旧デモの履歴やAnalyticsの申込・PV集計は書き換えません。</p><a href="../" class="secondary">既存の会員デモを見る</a></section></div>`
      : '<p class="empty">設定を読み込んでいます。</p>')
  );
}
function renderView() {
  destroyScanner();
  const target = document.querySelector("#main");
  if (!target) return;
  const content = {
    dashboard,
    participants,
    scanner: scannerHTML,
    events: eventsHTML,
    history: () =>
      pageHead(
        "チェックイン履歴",
        "受付・取消・登録・変更を、操作IDと理由で追跡します。",
      ) +
      `<section class="panel">${event() ? recentHistory() : empty("イベントを選択してください。")}</section>`,
    settings: settingsHTML,
  }[state.view];
  target.innerHTML =
    content() +
    `<footer class="quietFooter"><span>UNITY / COMMUNITY OPERATIONS</span><span>SERVER VERIFIED · QR 2.0</span></footer>`;
  document
    .querySelectorAll("[data-view]")
    .forEach((b) =>
      b.setAttribute(
        "aria-current",
        b.dataset.view === state.view ? "page" : "false",
      ),
    );
  if (state.view === "participants") {
    document.querySelector("#status")?.setAttribute("value", state.status);
    if (document.querySelector("#status"))
      document.querySelector("#status").value = state.status;
    if (document.querySelector("#sort"))
      document.querySelector("#sort").value = state.sort;
  }
  if (state.view === "scanner" && event())
    scanner = createScanner(
      document.querySelector("#camera"),
      document.querySelector("#cameraStatus"),
      (ticket) => checkTicket(ticket),
    );
}
async function load() {
  const generation = revision;
  const { events } = await api("events");
  if (generation !== revision) return;
  state.events = events;
  if (!events.some((e) => e.id === state.eventId))
    state.eventId = events[0]?.id || "";
  if (state.eventId) {
    const selected = state.eventId;
    const [people, history] = await Promise.all([
      api("participants?event=" + selected),
      api("history?event=" + selected),
    ]);
    if (generation !== revision || selected !== state.eventId) return;
    state.people = people.participants;
    state.history = history.history;
  } else {
    state.people = [];
    state.history = [];
  }
  if (admin() && state.view === "settings")
    state.settings = await api("settings");
}
async function navigate(view, selected = state.eventId) {
  if (!state.actor) return;
  const previous = state.eventId,
    generation = ++revision;
  navigating = true;
  state.view = view;
  state.eventId = selected;
  state.people = [];
  state.history = [];
  destroyScanner();
  modal.close();
  document.querySelector("#modalContent").replaceChildren();
  const main = document.querySelector("#main"),
    select = document.querySelector("#eventSelect");
  if (main)
    main.innerHTML =
      '<section class="panel" aria-busy="true">イベントを読み込んでいます。</section>';
  if (select) select.disabled = true;
  try {
    await load();
    if (generation !== revision) return;
    renderShell();
    document.querySelector("h1")?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  } catch (e) {
    if (generation === revision && state.actor) {
      state.eventId = previous;
      if (select) {
        select.disabled = false;
        select.value = previous;
      }
      if (main)
        main.innerHTML =
          '<section class="panel"><h1>読み込めませんでした。</h1><p>接続を確認して、イベントまたは画面を選び直してください。</p></section>';
    }
    notify(e.message, true);
  } finally {
    if (generation === revision) navigating = false;
  }
}
function dialog(title, html) {
  document.querySelector("#modalContent").innerHTML =
    `<h2 id="modalTitle">${esc(title)}</h2>${html}`;
  modal.showModal();
}
const localDate = (value) => {
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
function eventForm(id) {
  const e = id ? state.events.find((e) => e.id === id) : null;
  dialog(
    e ? "イベントを編集" : "イベントを作成",
    `<form id="eventForm" data-event="${esc(id || "")}"><div class="formGrid"><label class="span2">イベント名<input name="title" required maxlength="80" value="${esc(e?.title || "")}"></label><label>開催日時<input name="startsAt" type="datetime-local" required value="${localDate(e?.startsAt || Date.now())}"></label><label>定員<input name="capacity" type="number" min="1" max="10000" required value="${e?.capacity || 50}"></label><label>受付開始<input name="opensAt" type="datetime-local" required value="${localDate(e?.opensAt || Date.now())}"></label><label>受付終了<input name="closesAt" type="datetime-local" required value="${localDate(e?.closesAt || Date.now() + 3 * 3600_000)}"></label><label class="span2">会場<input name="venue" required maxlength="80" value="${esc(e?.venue || "")}"></label></div><p class="hint">受付時間は最長7日です。端末のタイムゾーンで入力します。</p><button class="primary full">保存する</button></form>`,
  );
}
function changeForm(action, id) {
  const p = state.people.find((p) => p.id === id);
  dialog(
    {
      undo: "受付を取り消す",
      cancel: "参加登録を取り消す",
      rename: "参加者名を変更",
      restore: "参加取消を解除",
    }[action],
    `<p>${esc(p?.name)} · ID ${esc(id.slice(0, 8))}</p><form id="changeForm" data-event="${esc(state.eventId)}" data-action="${action}" data-person="${esc(id)}">${action === "rename" ? `<label>参加者名<input name="name" value="${esc(p?.name)}" required maxlength="60"></label>` : ""}<label>変更理由<textarea name="reason" required maxlength="240"></textarea></label><button class="danger full">変更を確定</button></form>`,
  );
}
async function checkTicket(ticket, selected = state.eventId) {
  const result = document.querySelector("#scanResult");
  if (result) result.textContent = "サーバーで確認しています。";
  try {
    const receipt = await api("checkins", { eventId: selected, ticket });
    if (selected !== state.eventId) return;
    if (result)
      result.innerHTML = `<strong>${esc(receipt.name)}</strong><span>${receipt.duplicate ? "このイベントは受付済みです。" : "受付を確定しました。"} ${date(receipt.checkedInAt)}</span>`;
    notify(
      receipt.duplicate
        ? "このイベントは受付済みです。"
        : "受付を確定しました。",
    );
    scanner?.feedback(document.querySelector("#sound")?.checked);
    await load();
  } catch (e) {
    if (result) result.textContent = e.message;
    notify(e.message, true);
  }
}
async function afterMutation(message) {
  if (!state.actor) return;
  modal.close();
  document.querySelector("#modalContent").replaceChildren();
  await load();
  renderShell();
  notify(message);
}
document.addEventListener("submit", async (e) => {
  const form = e.target;
  if (!(form instanceof HTMLFormElement)) return;
  e.preventDefault();
  const button = form.querySelector('button[type="submit"],button:not([type])');
  if (button) button.disabled = true;
  const values = Object.fromEntries(new FormData(form));
  try {
    if (form.id === "loginForm") {
      await api("login", values);
      state.actor = await api("session");
      await load();
      renderShell();
    }
    if (form.id === "walkinForm") {
      await api("participants", { eventId: form.dataset.event, ...values });
      await afterMutation("参加者を登録しました。");
    }
    if (form.id === "eventForm") {
      const data = {
        ...values,
        capacity: Number(values.capacity),
        startsAt: new Date(values.startsAt).toISOString(),
        opensAt: new Date(values.opensAt).toISOString(),
        closesAt: new Date(values.closesAt).toISOString(),
      };
      const saved = await api(
        "events",
        {
          ...data,
          ...(form.dataset.event ? { eventId: form.dataset.event } : {}),
        },
        form.dataset.event ? "PATCH" : "POST",
      );
      state.eventId = saved.id;
      await afterMutation("イベントを保存しました。");
    }
    if (form.id === "changeForm") {
      const action = form.dataset.action,
        id = form.dataset.person;
      await api(
        action === "rename" ? "participants" : action,
        { eventId: form.dataset.event, participantId: id, ...values },
        action === "rename" ? "PATCH" : "POST",
      );
      await afterMutation("変更を保存しました。");
    }
    if (form.id === "ticketForm")
      await checkTicket(values.ticket.trim(), form.dataset.event);
    if (form.id === "userForm") {
      await api("users", {
        ...values,
        eventIds: new FormData(form).getAll("eventIds"),
      });
      await afterMutation("ユーザーを追加しました。");
    }
    if (form.id === "importForm") {
      const snapshot = JSON.parse(values.snapshot);
      const preview = await api("import", { snapshot, preview: true });
      dialog(
        "取込内容を確認",
        `<p>イベント ${preview.events}件 / 参加者 ${preview.participants}件 / 参加登録 ${preview.registrations}件</p><p class="hint">既存の受付状態・取消・参加者名は上書きしません。</p><button class="primary full" id="confirmImport">取込を確定</button>`,
      );
      document.querySelector("#confirmImport").onclick = async () => {
        try {
          await api("import", { snapshot });
          await afterMutation("取込を完了しました。");
        } catch (e) {
          notify(e.message, true);
        }
      };
    }
  } catch (error) {
    if (form.id === "loginForm") {
      document.querySelector("#loginError").textContent = error.message;
    } else notify(error.message, true);
  } finally {
    if (button) button.disabled = false;
  }
});
document.addEventListener("click", async (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.id === "closeModal") {
    modal.close();
    document.querySelector("#modalContent").replaceChildren();
    return;
  }
  if (button.dataset.view) {
    await navigate(button.dataset.view);
    return;
  }
  const action = button.dataset.action,
    id = button.dataset.person,
    renderedEvent =
      button.closest("[data-event]")?.dataset.event || state.eventId,
    actionRevision = revision;
  if (!action) return;
  try {
    if (action === "logout") {
      await api("logout", {});
      loggedOut();
    }
    if (action === "walkin")
      dialog(
        "当日参加を登録",
        `<form id="walkinForm" data-event="${esc(state.eventId)}"><label>参加者名<input name="name" required maxlength="60" autocomplete="name"></label>${admin() ? '<label>共通会員ID（確認済みの場合のみ）<input name="memberId" maxlength="100" autocomplete="off"></label>' : ""}<p class="hint">同じ名前でも別の参加者として登録します。本人確認後に受付してください。</p><button class="primary full">登録する</button></form>`,
      );
    if (action === "newEvent" || action === "editEvent")
      eventForm(button.dataset.event);
    if (action === "selectEvent") {
      await navigate("dashboard", button.dataset.event);
    }
    if (["undo", "cancel", "rename", "restore"].includes(action))
      changeForm(action, id);
    if (action === "checkin") {
      button.disabled = true;
      const receipt = await api("checkins", {
        eventId: renderedEvent,
        participantId: id,
      });
      await load();
      renderShell();
      notify(
        receipt.duplicate
          ? "このイベントは受付済みです。"
          : "受付を確定しました。",
      );
    }
    if (action === "ticket") {
      const ticket = await api(
        `ticket?event=${renderedEvent}&participant=${id}`,
      );
      if (
        renderedEvent !== state.eventId ||
        actionRevision !== revision ||
        !state.actor
      )
        return;
      dialog(
        "参加者QR",
        `<img id="ticketImage" src="/api/v2/ticket?event=${esc(renderedEvent)}&participant=${esc(id)}&format=svg" alt="この参加者の受付用QR"><p class="hint">有効期限 ${date(ticket.expiresAt)}。このイベント専用のQRです。</p><label>QR文字列<textarea id="ticketToken" readonly>${esc(ticket.token)}</textarea></label><a class="secondary" download="unity-ticket.svg" href="/api/v2/ticket?event=${esc(renderedEvent)}&participant=${esc(id)}&format=svg">QRを保存</a>`,
      );
    }
    if (action === "cameraStart") await scanner?.start();
    if (action === "cameraStop") {
      scanner?.stop();
      document.querySelector("#cameraStatus").textContent =
        "カメラを停止しました。";
    }
    if (action === "sync") {
      const result = await api("sync", {});
      await afterMutation(
        result.connected
          ? `同期：送信 ${result.sent}件 / 失敗 ${result.failed}件`
          : "Analyticsは未接続です。記録は保持されています。",
      );
    }
    if (action === "importFile")
      dialog(
        "Analyticsデータを取込",
        '<form id="importForm"><label>連携仕様v1のJSON<textarea name="snapshot" required maxlength="1000000"></textarea></label><p class="hint">先に件数を確認し、確定後に取込します。</p><button class="primary full">取込内容を確認</button></form>',
      );
    if (action === "importRemote") {
      const preview = await api("import", { remote: true, preview: true });
      dialog(
        "Analytics取込を確認",
        `<p>イベント ${preview.events}件 / 参加者 ${preview.participants}件 / 参加登録 ${preview.registrations}件</p><button class="primary full" id="confirmRemoteImport">取込を確定</button>`,
      );
      document.querySelector("#confirmRemoteImport").onclick = async () => {
        try {
          await api("import", { snapshot: preview.snapshot });
          await afterMutation("取込を完了しました。");
        } catch (e) {
          notify(e.message, true);
        }
      };
    }
    if (action === "newUser")
      dialog(
        "ユーザーを追加",
        `<form id="userForm"><label>ユーザー名<input name="username" required maxlength="60" autocomplete="off"></label><label>パスワード<input name="password" type="password" required minlength="16" maxlength="128" autocomplete="new-password"></label><label>権限<select name="role"><option>Staff</option><option>Viewer</option><option>Admin</option></select></label><p class="hint">Staff・Viewerに許可するイベント</p><div class="checkboxes">${state.events.map((e) => `<label><input type="checkbox" name="eventIds" value="${esc(e.id)}">${esc(e.title)}</label>`).join("")}</div><button class="primary full">ユーザーを追加</button></form>`,
      );
    if (action === "disableUser") {
      if (!window.confirm("このユーザーのアクセスを無効にしますか？")) return;
      await api("users", { userId: button.dataset.user }, "PATCH");
      await afterMutation("ユーザーを無効にしました。");
    }
  } catch (error) {
    notify(error.message, true);
  } finally {
    button.disabled = false;
  }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "search") {
    state.search = e.target.value;
    document.querySelector("#people").innerHTML = peopleHTML();
  }
});
document.addEventListener("change", async (e) => {
  if (e.target.id === "eventSelect") {
    await navigate(state.view, e.target.value);
  }
  if (e.target.id === "status" || e.target.id === "sort") {
    state[e.target.id] = e.target.value;
    document.querySelector("#people").innerHTML = peopleHTML();
  }
});
setInterval(async () => {
  if (
    !state.actor ||
    document.hidden ||
    refreshing ||
    navigating ||
    modal.open ||
    ["settings", "events"].includes(state.view) ||
    Date.now() - lastRefresh < (state.actor.pollIntervalMs || 8000)
  )
    return;
  refreshing = true;
  lastRefresh = Date.now();
  try {
    await load();
    if (!state.actor || navigating) return;
    if (state.view === "dashboard" || state.view === "history") renderView();
    else if (state.view === "participants") {
      document.querySelector("#people").innerHTML = peopleHTML();
      const selected = event();
      if (selected)
        document.querySelectorAll("[data-count]").forEach((el) => {
          el.textContent = {
            参加予定: selected.total,
            受付済み: selected.checkedIn,
            未受付: selected.waiting,
            キャンセル: selected.cancelled,
          }[el.dataset.count];
        });
    }
  } catch (error) {
    notify(error.message, true);
  } finally {
    refreshing = false;
  }
}, 8000);
try {
  state.actor = await api("session");
  await load();
  renderShell();
} catch (e) {
  renderLogin();
  if (e.code !== "unauthorized")
    document.querySelector("#loginError").textContent = e.message;
}
