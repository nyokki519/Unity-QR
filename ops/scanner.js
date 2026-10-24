import { decode } from "./decoder.js";

export function createScanner(video, status, onTicket) {
  let stream = null,
    timer = null,
    busy = false,
    alive = true,
    generation = 0,
    last = "",
    lastAt = 0,
    audio = null;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const detector =
    typeof window.BarcodeDetector === "function"
      ? new window.BarcodeDetector({ formats: ["qr_code"] })
      : null;
  function stop() {
    generation++;
    if (timer) clearTimeout(timer);
    timer = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
  }
  async function tick() {
    if (!alive || !stream) return;
    if (!busy && video.readyState >= 2 && video.videoWidth) {
      busy = true;
      try {
        let token = null;
        if (detector) {
          try {
            token = (await detector.detect(video))[0]?.rawValue || null;
          } catch {
            /* Native detector failure falls through to locally bundled decoding. */
          }
        }
        if (!token && context) {
          const scale = Math.min(1, 640 / video.videoWidth);
          canvas.width = Math.floor(video.videoWidth * scale);
          canvas.height = Math.floor(video.videoHeight * scale);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          token = decode(
            context.getImageData(0, 0, canvas.width, canvas.height).data,
            canvas.width,
            canvas.height,
          );
        }
        if (token && (token !== last || Date.now() - lastAt > 3500)) {
          last = token;
          lastAt = Date.now();
          await onTicket(token);
        }
      } catch {
        status.textContent =
          "読取を続けています。QRを枠の中に合わせてください。";
      } finally {
        busy = false;
      }
    }
    if (alive && stream) timer = setTimeout(tick, 220);
  }
  async function start() {
    stop();
    const attempt = generation;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      status.textContent =
        "カメラを利用できません。HTTPSで開くか、参加者検索へ切り替えてください。";
      return;
    }
    status.textContent = "カメラの許可を確認しています。";
    try {
      const next = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      if (!alive || attempt !== generation) {
        next.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = next;
      video.srcObject = stream;
      await video.play();
      status.textContent =
        "QRを枠の中に合わせてください。連続して受付できます。";
      tick();
    } catch (e) {
      stop();
      const messages = {
        NotAllowedError:
          "カメラの許可が必要です。Safariのサイト設定で許可するか、参加者検索へ切り替えてください。",
        NotFoundError: "カメラが見つかりません。参加者検索を利用してください。",
        NotReadableError:
          "カメラを利用できません。他のアプリを閉じて再試行してください。",
      };
      status.textContent =
        messages[e.name] ||
        "カメラを開始できません。再試行するか、参加者検索を利用してください。";
    }
  }
  const hidden = () => {
    if (document.hidden) {
      stop();
      status.textContent =
        "カメラを停止しました。戻ったら「カメラを開始」を押してください。";
    }
  };
  document.addEventListener("visibilitychange", hidden);
  return {
    start,
    stop,
    feedback(sound) {
      if (navigator.vibrate) navigator.vibrate(60);
      if (sound) {
        try {
          audio ||= new (window.AudioContext || window.webkitAudioContext)();
          audio.resume();
          const tone = audio.createOscillator(),
            gain = audio.createGain();
          tone.frequency.value = 880;
          gain.gain.value = 0.035;
          tone.connect(gain).connect(audio.destination);
          tone.start();
          tone.stop(audio.currentTime + 0.12);
        } catch {
          /* Feedback is optional. */
        }
      }
    },
    destroy() {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", hidden);
      if (audio) audio.close();
    },
  };
}
