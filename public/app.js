// Katzrin Guide — frontend chat logic
const chat = document.getElementById("chat");
const form = document.getElementById("form");
const input = document.getElementById("input");
const send = document.getElementById("send");
const suggestions = document.getElementById("suggestions");

// Conversation history sent to the server (bounded server-side too).
const history = [];
const MAX_CLIENT_HISTORY = 8;

const hebrew = (s) => /[֐-׿]/.test(s);

// Minimal, safe rendering: escape HTML, then linkify URLs and **bold**.
function render(text) {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return esc
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\n/g, "<br />");
}

function addMessage(text, who) {
  const wrap = document.createElement("div");
  wrap.className = `msg ${who}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble" + (hebrew(text) ? " rtl" : "");
  bubble.innerHTML = render(text);
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
    const data = await res.json().catch(() => ({}));
    typing.remove();

    const reply =
      data.reply ||
      data.message ||
      (hebrew(text) ? "מצטער, משהו השתבש. נסו שוב." : "Sorry, something went wrong. Please try again.");
    addMessage(reply, "bot");
    if (data.reply && !data.offTopic) {
      history.push({ role: "assistant", content: data.reply });
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
