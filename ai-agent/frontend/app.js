"use strict";

const INITIAL_GREETING = "Hello, welcome to DataMetricus. I'm the AI assistant. Are you looking for advisory support or training?";

function queryParam(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

const EMBED_MODE    = queryParam("embed")    === "1";
const AUTOSTART     = queryParam("autostart") === "1";
const ASSISTANT_MODE = queryParam("mode")    || "local";
const BACKEND_ORIGIN = (queryParam("backend") || "http://localhost:8000").replace(/\/+$/, "");
const BACKEND_TOKEN  = queryParam("token")   || "";

const btnStart       = document.getElementById("btnStart");
const btnStop        = document.getElementById("btnStop");
const btnSend        = document.getElementById("btnSend");
const btnReplay      = document.getElementById("btnReplay");
const btnEnableVoice = document.getElementById("btnEnableVoice");
const chatInput      = document.getElementById("chatInput");
const composer       = document.getElementById("composer");
const statusDot      = document.getElementById("statusDot");
const statusLabel    = document.getElementById("statusLabel");
const transcriptBody = document.getElementById("transcriptBody");
const leadPanel      = document.getElementById("leadPanel");
const leadGrid       = document.getElementById("leadGrid");
const missingNotice  = document.getElementById("missingNotice");
const errorNotice    = document.getElementById("errorNotice");
const backendUrlValue = document.getElementById("backendUrlValue");
const modeNote       = document.getElementById("modeNote");
const voiceStatus    = document.getElementById("voiceStatus");

// ── Lead data ────────────────────────────────────────────────────────────────
const LEAD_FIELDS = [
  ["inquiry_type",   "Interest"],
  ["domain",         "Area"],
  ["training_track", "Track"],
];

const lead = {
  inquiry_type:   "",
  domain:         "",
  training_track: "",
};

// ── Conversation state machine ────────────────────────────────────────────────
// States: ask_service | ask_detail | offer_contact | done
let convState = "ask_service";

function resetConversation() {
  convState = "ask_service";
  lead.inquiry_type   = "";
  lead.domain         = "";
  lead.training_track = "";
}

// ── Runtime state ─────────────────────────────────────────────────────────────
let preferredVoice  = null;
let sessionStarted  = false;
let startInProgress = false;
let localSessionId  = "";
let lastAssistantReply = "";
let speechEnabled   = false;

// ── Init ──────────────────────────────────────────────────────────────────────
if (EMBED_MODE) document.body.classList.add("embed-mode");
if (backendUrlValue) {
  backendUrlValue.textContent = ASSISTANT_MODE === "local"
    ? `Local Ollama via ${BACKEND_ORIGIN}`
    : "Runs entirely in your browser";
}
if (modeNote) {
  modeNote.textContent = ASSISTANT_MODE === "local"
    ? "Mode: Local typed chat with browser-spoken replies"
    : "Mode: Typed chat with spoken replies";
}
if (composer) composer.hidden = false;

// ── Status / error helpers ────────────────────────────────────────────────────
function setStatus(state, label) {
  statusDot.className   = `status-dot ${state}`;
  statusLabel.textContent = label;
}

function showError(message) {
  errorNotice.textContent = message;
  errorNotice.hidden = false;
}

function clearError() {
  errorNotice.textContent = "";
  errorNotice.hidden = true;
}

function setVoiceStatus(message = "", state = "") {
  if (!voiceStatus) return;
  voiceStatus.hidden = !message;
  voiceStatus.textContent = message;
  if (state) voiceStatus.dataset.state = state;
  else delete voiceStatus.dataset.state;
}

// ── Network ───────────────────────────────────────────────────────────────────
function backendHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (BACKEND_TOKEN) headers.Authorization = `Bearer ${BACKEND_TOKEN}`;
  return headers;
}

async function postJson(path, payload) {
  const response = await fetch(`${BACKEND_ORIGIN}${path}`, {
    method: "POST",
    headers: backendHeaders(),
    body: JSON.stringify(payload),
  });
  let data = null;
  try { data = await response.json(); } catch (_) {}
  if (!response.ok) {
    throw new Error(data?.detail || `Request failed with status ${response.status}.`);
  }
  return data;
}

// ── Transcript ────────────────────────────────────────────────────────────────
function clearPlaceholder() {
  const p = transcriptBody.querySelector(".transcript-placeholder");
  if (p) p.remove();
}

/**
 * Append a conversation turn.
 * @param {string} role    - "user" | "agent"
 * @param {string} text    - message body (plain text)
 * @param {Array}  actions - [{label, href}] optional action links shown below agent message
 */
function appendTurn(role, text, actions = []) {
  clearPlaceholder();

  const wrapper = document.createElement("div");
  wrapper.className = `turn ${role}`;

  const label = document.createElement("span");
  label.className   = "turn-label";
  label.textContent = role === "user" ? "You" : "AI Coordinator";

  const body = document.createElement("p");
  body.className   = "turn-text";
  body.textContent = text;

  wrapper.appendChild(label);
  wrapper.appendChild(body);

  // Action links (agent only)
  if (role === "agent" && actions.length > 0) {
    const actionsEl = document.createElement("div");
    actionsEl.className = "turn-actions";
    actions.forEach(({ label: linkLabel, href }) => {
      const a = document.createElement("a");
      a.href        = href;
      a.textContent = linkLabel;
      a.className   = "turn-action-link";
      a.target      = "_blank";
      a.rel         = "noopener noreferrer";
      actionsEl.appendChild(a);
    });
    wrapper.appendChild(actionsEl);
  }

  transcriptBody.appendChild(wrapper);
  transcriptBody.scrollTop = transcriptBody.scrollHeight;

  if (role === "agent") {
    lastAssistantReply = text;
    if (btnReplay) btnReplay.disabled = false;
    void speakAssistantText(text);
  }
}

function appendAgentTurnProgressive(text, actions = [], options = {}) {
  const { speak = true, delayMs = 120, stepMs = 14 } = options;
  clearPlaceholder();

  const wrapper = document.createElement("div");
  wrapper.className = "turn agent";

  const label = document.createElement("span");
  label.className   = "turn-label";
  label.textContent = "AI Coordinator";

  const body = document.createElement("p");
  body.className = "turn-text streaming";

  wrapper.appendChild(label);
  wrapper.appendChild(body);

  // Action links rendered after streaming completes
  let actionsEl = null;
  if (actions.length > 0) {
    actionsEl = document.createElement("div");
    actionsEl.className = "turn-actions";
    actionsEl.hidden = true;
    actions.forEach(({ label: linkLabel, href }) => {
      const a = document.createElement("a");
      a.href        = href;
      a.textContent = linkLabel;
      a.className   = "turn-action-link";
      a.target      = "_blank";
      a.rel         = "noopener noreferrer";
      actionsEl.appendChild(a);
    });
    wrapper.appendChild(actionsEl);
  }

  transcriptBody.appendChild(wrapper);
  transcriptBody.scrollTop = transcriptBody.scrollHeight;

  lastAssistantReply = text;
  if (btnReplay) btnReplay.disabled = false;
  if (speak) void speakAssistantText(text);

  const chars = Array.from(text);
  let index = 0;

  const tick = () => {
    if (index >= chars.length) {
      body.classList.remove("streaming");
      if (actionsEl) actionsEl.hidden = false;
      return;
    }
    body.textContent += chars[index];
    index++;
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
    window.setTimeout(tick, stepMs);
  };

  window.setTimeout(tick, delayMs);
}

// ── Speech ────────────────────────────────────────────────────────────────────
function requestParentSpeechUnlock() {
  if (!EMBED_MODE || !window.parent || window.parent === window) return;
  window.parent.postMessage({ type: "dm-speech-unlock" }, window.location.origin);
}

function normaliseSpeechText(text) {
  if (text == null) return "";
  return String(text).replace(/\s+/g, " ").trim();
}

function waitForVoices(timeoutMs = 2000) {
  if (!window.speechSynthesis) return Promise.resolve([]);
  const existing = window.speechSynthesis.getVoices();
  if (existing.length) return Promise.resolve(existing);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (voices) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timerId);
      window.speechSynthesis.removeEventListener("voiceschanged", onChange);
      resolve(voices);
    };
    const onChange = () => finish(window.speechSynthesis.getVoices());
    const timerId = window.setTimeout(
      () => finish(window.speechSynthesis.getVoices()), timeoutMs);
    window.speechSynthesis.addEventListener("voiceschanged", onChange);
  });
}

function chooseSpeechVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voices.length) return null;
  return (
    voices.find(v => v.name === "Samantha") ||
    voices.find(v => v.name === "Daniel")   ||
    voices.find(v => /^en(-|_)?(US|GB)?/i.test(v.lang)) ||
    voices[0] || null
  );
}

function stopAssistantSpeech() {
  window.speechSynthesis?.cancel?.();
}

async function unlockSpeech() {
  if (!window.speechSynthesis) {
    showError("This browser does not support speech playback. The assistant can still reply in text.");
    setVoiceStatus("SpeechSynthesis is unavailable in this browser.", "error");
    return false;
  }
  speechEnabled = true;
  requestParentSpeechUnlock();
  await waitForVoices();
  preferredVoice = chooseSpeechVoice();
  setVoiceStatus(EMBED_MODE ? "Embedded voice is ready." : "Voice is ready.", "");
  return true;
}

async function speakText(text) {
  const speakableText = normaliseSpeechText(text);
  if (!speakableText || !window.speechSynthesis) return false;
  if (!speechEnabled) {
    setVoiceStatus("Voice is not enabled yet.", "blocked");
    return false;
  }
  clearError();
  await waitForVoices();
  preferredVoice = chooseSpeechVoice();

  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(speakableText);
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.lang   = preferredVoice?.lang || "en-US";
    utterance.rate   = 1;
    utterance.pitch  = 1;
    utterance.volume = 1;

    utterance.onstart = () => setVoiceStatus("Speaking reply...", "speaking");
    utterance.onend   = () => { setVoiceStatus("", ""); setStatus("idle", "Ready"); resolve(true); };
    utterance.onerror = (e) => { setVoiceStatus(`Speech failed: ${e.error}`, "error"); resolve(false); };

    window.setTimeout(() => window.speechSynthesis.speak(utterance), 120);
  });
}

async function speakAssistantText(text) {
  if (!text || !window.speechSynthesis) return false;
  return speakText(text);
}

function showVoiceConsent(message = "") {
  setVoiceStatus(
    message || "Click Start DataMetricus Assistant to enable voice.",
    "blocked"
  );
}

function registerGreetingUnlockHandlers() {
  const unlockOnly = async () => {
    if (ASSISTANT_MODE === "local") return;
    await unlockSpeech();
  };
  window.addEventListener("pointerdown", unlockOnly, { once: true });
  window.addEventListener("keydown",     unlockOnly, { once: true });
  showVoiceConsent();
}

function replayAssistantSpeech() {
  clearError();
  void unlockSpeech();
  if (!lastAssistantReply) { showError("There is no assistant reply to replay yet."); return; }
  void speakAssistantText(lastAssistantReply);
}

// ── Conversation logic ────────────────────────────────────────────────────────
/**
 * Returns { reply: string, actions: [{label, href}] }
 */
function buildAssistantReply(text) {
  const lower = text.toLowerCase();

  const isTraining  = /\btraining|course|workshop|learn|programme|upskill\b/i.test(lower);
  const isAdvisory  = /\badvisory|consult|project|analysis|model|audit|pipeline|research|insurance|health|actuar|regulat\b/i.test(lower);
  const wantsContact = /\bcontact|reach|email|call|speak|talk|follow.?up|get in touch|yes\b|^sure$|^please$|^ok$|^okay$/i.test(lower);
  const wantsMore   = /\bmore|question|tell me|what|how|explain|other|else|no\b|^not yet$/i.test(lower);

  // ── State: ask_service ─────────────────────────────────────────────────────
  if (convState === "ask_service") {
    if (/\bhello|hi|hey|good morning|good afternoon\b/i.test(lower)) {
      return { reply: "Hello! Are you looking for advisory support or training?", actions: [] };
    }
    if (isTraining) {
      lead.inquiry_type = "training";
      convState = "ask_detail";
      return {
        reply: "We offer three structured training tracks: Foundations, Applied Modelling, and Reproducible Workflows. Which track interests you most?",
        actions: [{ label: "View all training programmes →", href: "/training.html" }],
      };
    }
    if (isAdvisory) {
      lead.inquiry_type = "advisory";
      convState = "ask_detail";
      return {
        reply: "We cover actuarial modelling, health metrics, reproducible research, and regulatory analytics. Which area are you focused on?",
        actions: [{ label: "View our services →", href: "/services.html" }],
      };
    }
    return {
      reply: "I can help with advisory services or training programmes. Which are you interested in?",
      actions: [],
    };
  }

  // ── State: ask_detail ──────────────────────────────────────────────────────
  if (convState === "ask_detail") {
    convState = "offer_contact";

    if (lead.inquiry_type === "training") {
      let track = "";
      let detail = "";
      if (/foundation/i.test(lower)) {
        track  = "Foundations";
        detail = "The Foundations track covers core quantitative methods and reproducibility principles.";
      } else if (/applied|modelling|modeling/i.test(lower)) {
        track  = "Applied Modelling";
        detail = "The Applied Modelling track covers hands-on statistical and actuarial model building.";
      } else if (/reproducible|quarto|workflow/i.test(lower)) {
        track  = "Reproducible Workflows";
        detail = "The Reproducible Workflows track covers Quarto, version control, and auditable pipelines.";
      }
      if (track) lead.training_track = track;

      return {
        reply: `${detail || "Our training is designed for working analysts who need to operate at a higher level of rigour."} Would you like our team to get in touch with more details?`,
        actions: [{ label: "View full curriculum →", href: "/training.html" }],
      };
    }

    if (lead.inquiry_type === "advisory") {
      if (/insurance|actuar/i.test(lower))                       lead.domain = "Life and health insurance";
      else if (/public health|epidemiol|health metric/i.test(lower)) lead.domain = "Public health";
      else if (/regulat|governance|risk/i.test(lower))           lead.domain = "Regulatory and risk";
      else if (/research|academic/i.test(lower))                 lead.domain = "Research";

      const area = lead.domain ? lead.domain.toLowerCase() : "your area";
      return {
        reply: `We'd be glad to help with ${area}. Our work is fully documented and independently verifiable. Would you like our team to get in touch?`,
        actions: [{ label: "View our services →", href: "/services.html" }],
      };
    }

    return {
      reply: "Would you like our specialist team to get in touch with you?",
      actions: [],
    };
  }

  // ── State: offer_contact ──────────────────────────────────────────────────
  if (convState === "offer_contact") {
    if (wantsContact && !wantsMore) {
      convState = "done";
      return {
        reply: "Great. Please use our contact form to submit your enquiry — our team will respond within one business day. When you are ready, click Dismiss to close this assistant. If you would like to chat again, simply refresh the page.",
        actions: [{ label: "Go to contact form →", href: "/contact.html" }],
      };
    }
    // Common specific questions
    if (/price|pricing|cost|fee|charge|budget|quote/i.test(lower)) {
      return {
        reply: "Pricing depends on the scope and level of technical effort involved. We are happy to provide a tailored quote. Would you like our team to get in touch?",
        actions: [],
      };
    }
    if (/where|location|based|office|remote/i.test(lower)) {
      return {
        reply: "DataMetricus operates as an independent advisory, working with clients both remotely and on-site. Would you like our team to reach out to you?",
        actions: [],
      };
    }
    if (/how long|timeline|duration|time|weeks|months/i.test(lower)) {
      return {
        reply: "Timelines vary by scope. Smaller engagements typically run two to four weeks; larger projects are scoped individually. Would you like to discuss your specific needs with our team?",
        actions: [],
      };
    }
    if (/no|not now|later|maybe|another time/i.test(lower)) {
      convState = "done";
      return {
        reply: "No problem. You can always reach us through our contact page. Click Dismiss to close the assistant, or refresh the page to start a new conversation.",
        actions: [{ label: "Contact us →", href: "/contact.html" }],
      };
    }
    // Generic fallback — re-offer
    return {
      reply: "I am best placed to help with questions about our services and training. For anything more specific, our team can assist directly. Would you like to be contacted?",
      actions: [{ label: "Go to contact form →", href: "/contact.html" }],
    };
  }

  // ── State: done ───────────────────────────────────────────────────────────
  return {
    reply: "I hope that was helpful! Click Dismiss to close the assistant, or refresh the page to start a new conversation.",
    actions: [],
  };
}

// ── Lead panel ────────────────────────────────────────────────────────────────
function updateLeadPanel() {
  const populated = LEAD_FIELDS.filter(([key]) => lead[key]);
  if (populated.length === 0) { leadPanel.hidden = true; return; }

  leadPanel.hidden = false;
  leadGrid.innerHTML = "";
  populated.forEach(([key, label]) => {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = label;
    dd.textContent = lead[key];
    leadGrid.appendChild(dt);
    leadGrid.appendChild(dd);
  });
  if (missingNotice) missingNotice.hidden = true;
}

function cleanValue(value) {
  return value.replace(/\s+/g, " ").trim().replace(/[.,;!?]+$/, "");
}

// ── Message handling ──────────────────────────────────────────────────────────
function handleUserMessage(text) {
  const message = cleanValue(text);
  if (!message) return;

  clearError();
  appendTurn("user", message);

  setStatus("connecting", "Thinking...");
  window.setTimeout(() => {
    const { reply, actions } = buildAssistantReply(message);
    appendTurn("agent", reply, actions);
    updateLeadPanel();
    setStatus("idle", "Ready");
  }, 300);
}

// ── Session control ───────────────────────────────────────────────────────────
function stopSession() {
  stopAssistantSpeech();
  btnStop.disabled  = true;
  btnStart.disabled = false;
  sessionStarted    = false;
  localSessionId    = "";
  resetConversation();
  setStatus("idle", "Ready");
}

async function startAssistant() {
  if (sessionStarted || startInProgress) return;
  startInProgress = true;
  clearError();
  setStatus("connecting", ASSISTANT_MODE === "local" ? "Connecting to local model..." : "Starting...");

  try {
    sessionStarted = true;

    if (ASSISTANT_MODE === "local") {
      if (!EMBED_MODE) await unlockSpeech();
      else { requestParentSpeechUnlock(); setVoiceStatus("Homepage voice is ready.", ""); }
      const data = await postJson("/local/session", {});
      localSessionId = data.session_id || "";
      appendTurn("agent", data.message || INITIAL_GREETING);
    } else {
      await unlockSpeech();
      appendAgentTurnProgressive(INITIAL_GREETING, [], { speak: true, delayMs: 180, stepMs: 14 });
    }

    btnStart.disabled = true;
    btnStop.disabled  = false;
    setStatus("idle", ASSISTANT_MODE === "local" ? "Local chat ready" : "Ready for text");
    chatInput.focus();
  } catch (error) {
    sessionStarted    = false;
    localSessionId    = "";
    btnStart.disabled = false;
    btnStop.disabled  = true;
    setStatus("error", "Unavailable");
    setVoiceStatus("Assistant startup failed.", "error");
    showError(
      ASSISTANT_MODE === "local"
        ? `${error.message} Make sure the backend is running on ${BACKEND_ORIGIN}.`
        : error.message,
    );
  } finally {
    startInProgress = false;
  }
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  stopAssistantSpeech();
  chatInput.value = "";

  if (ASSISTANT_MODE !== "local") { handleUserMessage(text); return; }

  if (!sessionStarted || !localSessionId) {
    showError("Start DataMetricus Assistant before sending a message.");
    return;
  }

  const message = cleanValue(text);
  clearError();
  appendTurn("user", message);
  setStatus("connecting", "Waiting for local reply...");

  try {
    const data = await postJson("/local/chat", { session_id: localSessionId, message });
    appendTurn("agent", data.reply || "I couldn't generate a reply just now.");
    setStatus("idle", "Local chat ready");
  } catch (error) {
    setVoiceStatus("No spoken reply because chat failed.", "error");
    showError(error.message);
    setStatus("error", "Local reply failed");
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────
btnStart.addEventListener("click", startAssistant);
btnStop.addEventListener("click",  stopSession);
if (btnSend)   btnSend.addEventListener("click", sendMessage);
if (btnReplay) btnReplay.addEventListener("click", replayAssistantSpeech);

if (btnEnableVoice) {
  btnEnableVoice.addEventListener("click", () => {
    void unlockSpeech().then((enabled) => {
      if (!enabled) return;
      void speakAssistantText(lastAssistantReply || INITIAL_GREETING);
    });
  });
}

if (chatInput) {
  chatInput.addEventListener("keydown", (event) => {
    // Enter sends; Shift+Enter inserts a newline
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
}

if (window.speechSynthesis) {
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    preferredVoice = chooseSpeechVoice();
  });
  preferredVoice = chooseSpeechVoice();
  registerGreetingUnlockHandlers();
} else {
  if (btnReplay) btnReplay.disabled = true;
  showVoiceConsent("This browser does not support SpeechSynthesis. Text chat is still available.");
  setVoiceStatus("SpeechSynthesis is unavailable in this browser.", "error");
}

if (AUTOSTART) {
  btnStop.hidden = EMBED_MODE;
  window.addEventListener("load", () => startAssistant(), { once: true });
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === "dm-start-assistant") startAssistant();
});

updateLeadPanel();
setStatus("idle", "Ready");
setVoiceStatus("");
