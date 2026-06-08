// Katzrin Guide — frontend chat logic (streaming + Markdown rendering)
const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const suggestions = document.getElementById("suggestions");

const history = [];
const MAX_CLIENT_HISTORY = 8;

const hebrew = (s) => /[֐-׿]/.test(s);

// --- Minimal, safe Markdown → HTML for chat bubbles -----------------------
// Handles: # / ## / ### headings, "- "/"* " bullets, --- rules, **bold**,
// *italics*, links, and paragraphs. Every block gets dir="auto" so Hebrew
// lines align RTL and English lines LTR within the same bubble.
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
  const closeList = () => {
    if (inList) { html += "</ul>"; inList = false; }
  };
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
      // "done" → fall through; cursor removed after the loop
    }
  }
  bubble.innerHTML = renderMd(acc); // final render, no cursor
  return acc;
}

async function sendMessage(text) {
  addMessage(text, "user");
  history.push({ role: "user", content: text });
  input.value = "";
  send.disabled = true;
  input.disabled = true;
  suggestions.style.display = "none";
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
      // JSON path: validation errors, rate limits, or off-topic refusals
      const data = await res.json().catch(() => ({}));
      typing.remove();
      const reply =
        data.reply ||
        data.message ||
        (hebrew(text) ? "מצטער, משהו השתבש. נסו שוב." : "Sorry, something went wrong. Please try again.");
      addMessage(reply, "bot");
      if (data.reply && !data.offTopic) history.push({ role: "assistant", content: data.reply });
    }
  } catch (e) {
    typing.remove();
    addMessage(
      hebrew(text) ? "אין חיבור לשרת. נסו שוב." : "Couldn't reach the server. Please try again.",
      "bot"
    );
  } finally {
    send.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (text) sendMessage(text);
});

suggestions.addEventListener("click", (e) => {
  if (e.target.classList.contains("chip")) sendMessage(e.target.textContent.trim());
});

input.focus();
