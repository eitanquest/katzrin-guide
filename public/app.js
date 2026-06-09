// Katzrin Guide — ChatGPT/Gemini-style UI with streaming + Markdown rendering
const app = document.getElementById("app");
const chat = document.getElementById("chat");
const hero = document.getElementById("hero");
const chips = document.getElementById("chips");
const heroForm = document.getElementById("heroForm");
const heroInput = document.getElementById("heroInput");
const bottomForm = document.getElementById("bottomForm");
const bottomInput = document.getElementById("bottomInput");
const ph = document.getElementById("ph");

const history = [];
const MAX_CLIENT_HISTORY = 8;
let started = false;

const hebrew = (s) => /[֐-׿]/.test(s);

// ---- Fading bilingual placeholder ("Ask a question about Katzrin" ⇄ Hebrew) ----
const PLACEHOLDERS = [
  { text: "Ask a question about Katzrin", dir: "ltr" },
  { text: "שאלו שאלה על קצרין", dir: "rtl" },
];
let phIdx = 0;
function paintPh() {
  ph.textContent = PLACEHOLDERS[phIdx].text;
  ph.style.direction = PLACEHOLDERS[phIdx].dir;
  ph.style.textAlign = PLACEHOLDERS[phIdx].dir === "rtl" ? "right" : "left";
}
paintPh();
setInterval(() => {
  if (heroInput.value) return;          // don't cycle while typing
  ph.classList.add("hide");             // fade out
  setTimeout(() => {
    phIdx = (phIdx + 1) % PLACEHOLDERS.length;
    paintPh();
    ph.classList.remove("hide");        // fade in
  }, 450);
}, 2800);
heroInput.addEventListener("input", () => {
  ph.classList.toggle("hide", heroInput.value.length > 0);
});

// ---- Minimal, safe Markdown → HTML (per-line dir="auto" for HE/EN) ----
function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function inlineMd(s) {
  return escapeHtml(s)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}
function renderMd(src) {
  const lines = src.split("\n");
  let html = "";
  let inList = false;
  const closeList = () => { if (inList) { html += "</ul>"; inList = false; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul dir="auto">'; inList = true; }
      html += `<li>${inlineMd(line.replace(/^\s*[-*]\s+/, ""))}</li>`;
      continue;
    }
    closeList();
    if (/^###\s+/.test(line)) { html += `<div class="h3" dir="auto">${inlineMd(line.replace(/^###\s+/, ""))}</div>`; continue; }
    if (/^##\s+/.test(line))  { html += `<div class="h2" dir="auto">${inlineMd(line.replace(/^##\s+/, ""))}</div>`; continue; }
    if (/^#\s+/.test(line))   { html += `<div class="h2" dir="auto">${inlineMd(line.replace(/^#\s+/, ""))}</div>`; continue; }
    if (/^\s*---+\s*$/.test(line)) { html += "<hr/>"; continue; }
    if (line.trim() === "") { html += '<div class="sp"></div>'; continue; }
    html += `<div class="p" dir="auto">${inlineMd(line)}</div>`;
  }
  closeList();
  return html;
}

function addMessage(text, who) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.setAttribute("dir", "auto");
  bubble.innerHTML = text ? renderMd(text) : "";
  wrap.appendChild(bubble);
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return bubble;
}
function showTyping() {
  const wrap = document.createElement("div");
  wrap.className = "msg bot typing";
  wrap.innerHTML = `<div class="bubble"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  chat.appendChild(wrap);
  chat.scrollTop = chat.scrollHeight;
  return wrap;
}

const CURSOR = '<span class="cursor"></span>';
async function streamInto(bubble, res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let acc = "";
  const nearBottom = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight < 120;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const m = frame.match(/^data: (.*)$/m);
      if (!m) continue;
      let evt;
      try { evt = JSON.parse(m[1]); } catch { continue; }
      if (evt.type === "delta") {
        acc += evt.text;
        const stick = nearBottom();
        bubble.innerHTML = renderMd(acc) + CURSOR;
        if (stick) chat.scrollTop = chat.scrollHeight;
      } else if (evt.type === "error") {
        acc += (acc ? "\n\n" : "") + (evt.message || "…");
      }
    }
  }
  bubble.innerHTML = renderMd(acc);
  return acc;
}

function enterChatMode() {
  if (started) return;
  started = true;
  app.classList.remove("state-empty");
  app.classList.add("state-chat");
}

async function sendMessage(text) {
  enterChatMode();
  addMessage(text, "user");
  history.push({ role: "user", content: text });
  heroInput.value = "";
  bottomInput.value = "";
  setBusy(true);
  const typing = showTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, history: history.slice(-MAX_CLIENT_HISTORY) }),
    });
    const ctype = res.headers.get("content-type") || "";
    if (ctype.includes("text/event-stream") && res.body) {
      typing.remove();
      const bubble = addMessage("", "bot");
      const reply = await streamInto(bubble, res);
      if (reply) history.push({ role: "assistant", content: reply });
    } else {
      const data = await res.json().catch(() => ({}));
      typing.remove();
      const reply =
        data.reply || data.message ||
        (hebrew(text) ? "מצטער, משהו השתבש. נסו שוב." : "Sorry, something went wrong. Please try again.");
      addMessage(reply, "bot");
      if (data.reply && !data.offTopic) history.push({ role: "assistant", content: data.reply });
    }
  } catch (e) {
    typing.remove();
    addMessage(hebrew(text) ? "אין חיבור לשרת. נסו שוב." : "Couldn't reach the server. Please try again.", "bot");
  } finally {
    setBusy(false);
    bottomInput.focus();
  }
}

function setBusy(b) {
  document.querySelectorAll(".send").forEach((el) => (el.disabled = b));
  bottomInput.disabled = b;
  heroInput.disabled = b;
}

function handleSubmit(inputEl) {
  return (e) => {
    e.preventDefault();
    const text = inputEl.value.trim();
    if (text) sendMessage(text);
  };
}
heroForm.addEventListener("submit", handleSubmit(heroInput));
bottomForm.addEventListener("submit", handleSubmit(bottomInput));
chips.addEventListener("click", (e) => {
  if (e.target.classList.contains("chip")) sendMessage(e.target.textContent.trim());
});

heroInput.focus();
