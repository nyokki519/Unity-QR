(() => {
  let token = location.hash.slice(1),
    valid = /^[a-f0-9]{64}$/i.test(token);
  const el = (id) => document.getElementById(id);
  let controller,
    timer,
    generation = 0,
    status;
  const messages = {
    planned: "参加登録済みです。受付でQRをご提示ください。",
    checkedIn: "受付済みです。Unityの時間をお楽しみください。",
    cancelled: "参加登録はキャンセルされています。",
    upcoming: "参加登録済みです。QRは当日の受付時間に表示されます。",
    closed: "このイベントの受付は終了しました。",
  };
  const format = (value) =>
    value && Number.isFinite(Date.parse(value))
      ? new Intl.DateTimeFormat("ja-JP", {
          month: "long",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(value))
      : "";
  function clearQr() {
    el("qrArea").hidden = true;
    el("qr").removeAttribute("src");
  }
  async function load() {
    clearTimeout(timer);
    controller?.abort();
    const current = ++generation;
    if (!valid) {
      clearQr();
      el("status").textContent =
        "参加者リンクが正しくありません。LINEで「QR再発行」と送ってください。";
      el("retry").hidden = true;
      return;
    }
    controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    el("retry").disabled = true;
    clearQr();
    el("status").textContent = "参加登録を確認しています。";
    try {
      const response = await fetch("/api/v2/line/ticket", {
        headers: { Authorization: "Bearer " + token },
        cache: "no-store",
        credentials: "omit",
        signal: controller.signal,
        referrerPolicy: "no-referrer",
      });
      if (current !== generation) return;
      if (!response.ok)
        throw new Error(
          response.status === 401 ||
          response.status === 404 ||
          response.status === 410
            ? "このリンクは無効または期限切れです。LINEで「QR再発行」と送ってください。"
            : "確認できませんでした。少し待って再試行してください。",
        );
      const data = await response.json();
      if (current !== generation) return;
      status = data.status;
      el("title").textContent = data.event?.title || "参加者QR";
      el("name").textContent = data.name || "";
      el("details").textContent = [
        format(data.event?.startsAt),
        data.event?.venue,
        data.event?.opensAt
          ? "受付：" +
            format(data.event.opensAt) +
            " — " +
            format(data.event.closesAt)
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      el("status").textContent =
        messages[status] ||
        "参加状況を確認できません。運営にお問い合わせください。";
      if (
        status === "planned" &&
        typeof data.qr === "string" &&
        data.qr.trim().startsWith("<svg") &&
        data.qr.length < 200000
      ) {
        el("qr").src =
          "data:image/svg+xml;charset=utf-8," + encodeURIComponent(data.qr);
        el("qrArea").hidden = false;
        el("expiry").textContent = data.expiresAt
          ? "QR有効期限：" + format(new Date(data.expiresAt).toISOString())
          : "";
        if (!document.hidden) timer = setTimeout(load, 240000);
      }
    } catch (error) {
      if (current === generation) {
        clearQr();
        el("status").textContent =
          error.name === "AbortError"
            ? "通信がタイムアウトしました。接続を確認して再試行してください。"
            : error.message || "通信できませんでした。再試行してください。";
      }
    } finally {
      clearTimeout(timeout);
      if (current === generation) el("retry").disabled = false;
    }
  }
  el("qr").addEventListener("error", () => {
    clearQr();
    el("status").textContent =
      "QRを表示できませんでした。もう一度確認してください。";
  });
  el("retry").addEventListener("click", load);
  window.addEventListener("hashchange", () => {
    token = location.hash.slice(1);
    valid = /^[a-f0-9]{64}$/i.test(token);
    el("retry").hidden = false;
    el("title").textContent = "参加者QR";
    el("name").textContent = "";
    el("details").textContent = "";
    load();
  });
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (document.hidden) {
      generation++;
      controller?.abort();
      clearQr();
      el("retry").disabled = false;
    } else if (valid) load();
  });
  window.addEventListener("pagehide", () => {
    generation++;
    clearTimeout(timer);
    controller?.abort();
    clearQr();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) load();
  });
  load();
})();
