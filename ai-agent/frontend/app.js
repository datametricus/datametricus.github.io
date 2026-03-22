"use strict";

const INITIAL_GREETING = "Hello, welcome to DataMetricus. I'm the DataMetricus assistant. Please type your reply in the chat. Are you looking for advisory support or training?";
const VOICE_WELCOME_GREETING = "Hello! I'm your AI assistant. How can I help you today?";
const GREETING_STORAGE_KEY = "dm-voice-greeted";
const MAX_SPEECH_CHUNK_LENGTH = 220;

function queryParam(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

const EMBED_MODE = queryParam("embed") === "1";
const AUTOSTART = queryParam("autostart") === "1";
const ASSISTANT_MODE = queryParam("mode") || "local";
const BACKEND_ORIGIN = (queryParam("backend") || "http://localhost:8000").replace(/\/+$/, "");
const BACKEND_TOKEN = queryParam("token") || "";

const btnStart = document.getElementById("btnStart");
const btnStop = document.getElementById("btnStop");
const btnSend = document.getElementById("btnSend");
const btnReplay = document.getElementById("btnReplay");
const chatInput = document.getElementById("chatInput");
const composer = document.getElementById("composer");
const statusDot = document.getElementById("statusDot");
const statusLabel = document.getElementById("statusLabel");
const transcriptBody = document.getElementById("transcriptBody");
const leadPanel = document.getElementById("leadPanel");
const leadGrid = document.getElementById("leadGrid");
const missingNotice = document.getElementById("missingNotice");
const errorNotice = document.getElementById("errorNotice");
const backendUrlValue = document.getElementById("backendUrlValue");
const modeNote = document.getElementById("modeNote");
const voiceStatus = document.getElementById("voiceStatus");

const LEAD_FIELDS = [
  ["name", "Name"],
  ["organisation", "Organisation"],
  ["email", "Email"],
  ["phone", "Phone"],
  ["inquiry_type", "Inquiry Type"],
  ["domain", "Domain"],
  ["training_track", "Training Track"],
  ["timeline", "Timeline"],
];

const lead = {
  name: "",
  organisation: "",
  email: "",
  phone: "",
  inquiry_type: "",
  domain: "",
  training_track: "",
  timeline: "",
};

let preferredVoice = null;
let sessionStarted = false;
let localSessionId = "";
let lastAssistantReply = "";
let pendingParentSpeechId = null;
let speechEnabled = false;
let speechToken = 0;
let speechQueue = Promise.resolve();

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

function setStatus(state, label) {
  statusDot.className = `status-dot ${state}`;
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
  if (state) {
    voiceStatus.dataset.state = state;
  } else {
    delete voiceStatus.dataset.state;
  }
}

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
  try {
    data = await response.json();
  } catch (_error) {
    data = null;
  }

  if (!response.ok) {
    const detail = data?.detail || `Request failed with status ${response.status}.`;
    throw new Error(detail);
  }

  return data;
}

function clearPlaceholder() {
  const placeholder = transcriptBody.querySelector(".transcript-placeholder");
  if (placeholder) placeholder.remove();
}

function requestParentSpeechUnlock() {
  if (!EMBED_MODE || !window.parent || window.parent === window) return;
  window.parent.postMessage({ type: "dm-speech-unlock" }, window.location.origin);
}

function hasGreetedThisSession() {
  return window.sessionStorage?.getItem(GREETING_STORAGE_KEY) === "1";
}

function markGreetingDone() {
  window.sessionStorage?.setItem?.(GREETING_STORAGE_KEY, "1");
}

function normaliseSpeechText(text) {
  if (typeof text !== "string") {
    if (text == null) return "";
    text = String(text);
  }

  return text.replace(/\s+/g, " ").trim();
}

function splitIntoSpeechChunks(text) {
  const cleaned = normaliseSpeechText(text);
  if (!cleaned) return [];

  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  const chunks = [];
  let current = "";

  sentences.forEach((sentence) => {
    const trimmed = sentence.trim();
    if (!trimmed) return;

    if (!current) {
      current = trimmed;
      return;
    }

    if (`${current} ${trimmed}`.length <= MAX_SPEECH_CHUNK_LENGTH) {
      current = `${current} ${trimmed}`;
      return;
    }

    chunks.push(current);
    if (trimmed.length <= MAX_SPEECH_CHUNK_LENGTH) {
      current = trimmed;
      return;
    }

    const words = trimmed.split(/\s+/);
    current = "";
    words.forEach((word) => {
      if (!current) {
        current = word;
        return;
      }

      if (`${current} ${word}`.length <= MAX_SPEECH_CHUNK_LENGTH) {
        current = `${current} ${word}`;
      } else {
        chunks.push(current);
        current = word;
      }
    });
  });

  if (current) chunks.push(current);
  return chunks;
}

function waitForVoices(timeoutMs = 2000) {
  if (!window.speechSynthesis) return Promise.resolve([]);

  const existingVoices = window.speechSynthesis.getVoices();
  if (existingVoices.length) return Promise.resolve(existingVoices);

  // Chromium can report zero voices on first load, so wait briefly for the async voice list.
  return new Promise((resolve) => {
    let settled = false;
    const finish = (voices) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timerId);
      window.speechSynthesis.removeEventListener("voiceschanged", onVoicesChanged);
      resolve(voices);
    };

    const onVoicesChanged = () => finish(window.speechSynthesis.getVoices());
    const timerId = window.setTimeout(
      () => finish(window.speechSynthesis.getVoices()),
      timeoutMs,
    );

    window.speechSynthesis.addEventListener("voiceschanged", onVoicesChanged);
  });
}

function appendTurn(role, text) {
  clearPlaceholder();
  const wrapper = document.createElement("div");
  wrapper.className = `turn ${role}`;

  const label = document.createElement("span");
  label.className = "turn-label";
  label.textContent = role === "user" ? "You" : "AI Coordinator";

  const body = document.createElement("p");
  body.className = "turn-text";
  body.textContent = text;

  wrapper.appendChild(label);
  wrapper.appendChild(body);
  transcriptBody.appendChild(wrapper);
  transcriptBody.scrollTop = transcriptBody.scrollHeight;

  if (role === "agent") {
    lastAssistantReply = text;
    if (btnReplay) btnReplay.disabled = false;
    void speakAssistantText(text);
  }
}

function appendAgentTurnProgressive(text, options = {}) {
  const { speak = true, delayMs = 120, stepMs = 16 } = options;

  clearPlaceholder();

  const wrapper = document.createElement("div");
  wrapper.className = "turn agent";

  const label = document.createElement("span");
  label.className = "turn-label";
  label.textContent = "AI Coordinator";

  const body = document.createElement("p");
  body.className = "turn-text streaming";

  wrapper.appendChild(label);
  wrapper.appendChild(body);
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
      return;
    }
    body.textContent += chars[index];
    index += 1;
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
    window.setTimeout(tick, stepMs);
  };

  window.setTimeout(tick, delayMs);
}

function chooseSpeechVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voices.length) return null;
  return voices[0];
}

function stopAssistantSpeech() {
  speechToken += 1;
  window.speechSynthesis?.cancel?.();
}

async function unlockSpeech() {
  if (!window.speechSynthesis) {
    showError("This browser does not support speech playback. The assistant can still reply in text.");
    setVoiceStatus("SpeechSynthesis is unavailable in this browser.", "error");
    return false;
  }

  // This runs from a user gesture so later speech calls are much less likely to hit autoplay blocks.
  speechEnabled = true;
  requestParentSpeechUnlock();
  await waitForVoices();
  preferredVoice = chooseSpeechVoice();
  window.speechSynthesis.cancel();
  window.speechSynthesis.resume();
  setVoiceStatus(EMBED_MODE ? "Embedded voice is ready." : "Voice is ready.", "");
  return true;
}

async function speakText(text) {
  const speakableText = normaliseSpeechText(text);
  if (!speakableText || !window.speechSynthesis) return false;
  if (!speechEnabled) {
    setVoiceStatus("Voice will start after you click Start DataMetricus Assistant.", "blocked");
    return false;
  }

  // Incrementing the token cancels any earlier queued or active utterances.
  const token = ++speechToken;
  const runSpeech = async () => {
    try {
      clearError();
      await waitForVoices();
      preferredVoice = chooseSpeechVoice();
      setVoiceStatus("Speaking reply...", "speaking");

      // Chunk long replies so Chrome is less likely to cut speech off mid-response.
      const chunks = splitIntoSpeechChunks(speakableText);
      if (!chunks.length) return false;

      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();

      for (const chunk of chunks) {
        if (token !== speechToken) return false;

        await new Promise((resolve, reject) => {
          const utterance = new SpeechSynthesisUtterance(chunk);
          if (preferredVoice) utterance.voice = preferredVoice;
          utterance.lang = preferredVoice?.lang || "en-US";
          utterance.rate = 1;
          utterance.pitch = 1;
          utterance.volume = 1;
          utterance.onend = () => resolve();
          utterance.onerror = (event) => reject(event.error || new Error("Speech playback failed."));
          window.speechSynthesis.speak(utterance);
        });
      }

      setVoiceStatus("Voice playback complete.", "");
      setStatus("idle", "Ready");
      return true;
    } catch (_error) {
      showError("Browser speech could not play that reply. Close and reopen the assistant, then click Start again.");
      setVoiceStatus("Browser speech was blocked. Reopen the assistant and click Start again.", "blocked");
      setStatus("error", "Speech blocked");
      return false;
    }
  };

  speechQueue = speechQueue.catch(() => {}).then(runSpeech);
  return speechQueue;
}

async function speakAssistantText(text) {
  if (!text || !window.speechSynthesis) return false;

  if (EMBED_MODE && window.parent && window.parent !== window) {
    const speechId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pendingParentSpeechId = speechId;
    setVoiceStatus("Requesting homepage voice playback...", "speaking");
    window.parent.postMessage({ type: "dm-speak-request", text, speechId }, window.location.origin);
    return true;
  }

  return speakText(text);
}

async function maybeSpeakWelcomeGreeting() {
  if (ASSISTANT_MODE === "local") return;
  if (hasGreetedThisSession()) return;
  const unlocked = await unlockSpeech();
  if (!unlocked) return;
  // Persist the greeting flag for the current browser session only.
  markGreetingDone();
  await speakText(VOICE_WELCOME_GREETING);
}

function registerGreetingUnlockHandlers() {
  const tryGreeting = () => {
    void maybeSpeakWelcomeGreeting();
  };

  // First pointer or keyboard interaction unlocks voice without forcing an immediate modal.
  window.addEventListener("pointerdown", tryGreeting, { once: true });
  window.addEventListener("keydown", tryGreeting, { once: true });

  if (!hasGreetedThisSession()) {
    showVoiceConsent();
  }
}

function replayAssistantSpeech() {
  clearError();
  void unlockSpeech();
  if (!lastAssistantReply) {
    showError("There is no assistant reply to replay yet.");
    return;
  }
  void speakAssistantText(lastAssistantReply);
}

function requiredFields() {
  if (lead.inquiry_type === "training") {
    return ["name", "training_track", "email"];
  }

  if (lead.inquiry_type === "advisory") {
    return ["name", "domain", "email"];
  }

  return [];
}

function missingFields() {
  return requiredFields().filter((field) => !lead[field]);
}

function updateLeadPanel() {
  const populated = LEAD_FIELDS.filter(([key]) => lead[key]);
  if (populated.length === 0) {
    leadPanel.hidden = true;
    return;
  }

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

  const missing = missingFields();
  if (missing.length) {
    missingNotice.hidden = false;
    missingNotice.textContent = `Still needed: ${missing.join(", ")}`;
  } else {
    missingNotice.hidden = false;
    missingNotice.textContent = "Enough detail captured for a follow-up conversation.";
  }
}

function cleanValue(value) {
  return value.replace(/\s+/g, " ").trim().replace(/[.,;!?]+$/, "");
}

function captureLeadDetails(text) {
  const lowered = text.toLowerCase();

  const emailMatch = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  if (emailMatch) lead.email = emailMatch[0];

  const phoneMatch = text.match(/(\+?\d[\d\s().-]{7,}\d)/);
  if (phoneMatch) lead.phone = cleanValue(phoneMatch[1]);

  const nameMatch = text.match(/\b(?:i am|i'm|my name is|this is)\s+([A-Za-z][A-Za-z' -]{1,60})/i);
  if (nameMatch && !lead.name) lead.name = cleanValue(nameMatch[1]);

  const orgMatch = text.match(/\b(?:from|at|with)\s+([A-Z][A-Za-z0-9&.,' -]{1,60})/);
  if (orgMatch && !lead.organisation) lead.organisation = cleanValue(orgMatch[1]);

  if (!lead.inquiry_type) {
    if (/\btraining|course|workshop|upskill|learn|programme\b/i.test(lowered)) {
      lead.inquiry_type = "training";
    } else if (/\badvisory|consult|project|analysis|model|audit|pipeline|research\b/i.test(lowered)) {
      lead.inquiry_type = "advisory";
    }
  }

  if (!lead.training_track) {
    if (/foundation/i.test(lowered)) lead.training_track = "Foundations";
    if (/applied modelling|applied modeling|modelling|modeling/i.test(lowered)) lead.training_track = "Applied Modelling";
    if (/reproducible|quarto|workflow/i.test(lowered)) lead.training_track = "Reproducible Workflows";
  }

  if (!lead.domain) {
    if (/insurance|actuar/i.test(lowered)) lead.domain = "Life and health insurance";
    if (/public health|epidemiolog|health metric/i.test(lowered)) lead.domain = "Public health";
    if (/regulator|regulatory|governance|risk/i.test(lowered)) lead.domain = "Regulatory and risk";
    if (/research|academic|study/i.test(lowered)) lead.domain = "Research";
  }

  if (!lead.timeline) {
    const timelineMatch = text.match(/\b(?:this month|next month|this quarter|next quarter|asap|soon|immediately|[\w\s-]+weeks?|[\w\s-]+months?)\b/i);
    if (timelineMatch) lead.timeline = cleanValue(timelineMatch[0]);
  }
}

function nextQuestion() {
  if (!lead.inquiry_type) {
    return "Are you looking for advisory support or training?";
  }

  if (lead.inquiry_type === "training" && !lead.training_track) {
    return "Which training track matters most: Foundations, Applied Modelling, or Reproducible Workflows?";
  }

  if (lead.inquiry_type === "advisory" && !lead.domain) {
    return "Which area is this for: insurance, public health, regulatory work, or research?";
  }

  if (!lead.name) {
    return "What name should I note for the follow-up?";
  }

  if (!lead.email && !lead.phone) {
    return "What is the best email or phone number for follow-up?";
  }

  if (!lead.timeline) {
    return "What timeline are you working toward?";
  }

  if (!lead.organisation) {
    return "Which organisation are you with?";
  }

  return "";
}

function buildAssistantReply(text) {
  const lowered = text.toLowerCase();

  if (/\b(price|pricing|cost|quote|budget)\b/i.test(lowered)) {
    const question = nextQuestion() || "Are you looking for advisory support or training?";
    return `Pricing depends on scope and level of technical effort. ${question}`;
  }

  if (/\bhello|hi|hey|good morning|good afternoon\b/i.test(lowered) && !lead.inquiry_type) {
    return "Hello, welcome to DataMetricus. Please type your reply in the chat. Are you looking for advisory support or training?";
  }

  if (/\bwhat do you do|services|help with\b/i.test(lowered) && !lead.inquiry_type) {
    return "We support actuarial modelling, health metrics, reproducible research, and quantitative training. Are you looking for advisory support or training?";
  }

  const question = nextQuestion();
  if (question) {
    if (lead.inquiry_type === "training" && !lead.training_track) {
      return `We run structured analyst training for individuals and teams. ${question}`;
    }

    if (lead.inquiry_type === "advisory" && !lead.domain) {
      return `We handle scoped analytical work with a documented audit trail. ${question}`;
    }

    return question;
  }

  return "Thank you. That gives us enough to follow up within one business day.";
}

function handleUserMessage(text) {
  const message = cleanValue(text);
  if (!message) return;

  clearError();
  appendTurn("user", message);
  captureLeadDetails(message);
  updateLeadPanel();

  setStatus("connecting", "Thinking...");
  window.setTimeout(() => {
    const reply = buildAssistantReply(message);
    appendTurn("agent", reply);
    updateLeadPanel();
    setStatus("idle", "Ready");
  }, 250);
}

function stopSession() {
  stopAssistantSpeech();
  btnStop.disabled = true;
  btnStart.disabled = false;
  sessionStarted = false;
  localSessionId = "";
  setStatus("idle", "Ready");
}

async function startAssistant() {
  clearError();
  stopAssistantSpeech();

  if (sessionStarted) {
    btnStart.disabled = true;
    btnStop.disabled = false;
    setStatus("idle", ASSISTANT_MODE === "local" ? "Local chat ready" : "Ready for text");
    chatInput.focus();
    return;
  }

  setStatus("connecting", ASSISTANT_MODE === "local" ? "Connecting to local model..." : "Starting...");

  try {
    sessionStarted = true;

    if (ASSISTANT_MODE === "local") {
      if (!EMBED_MODE) {
        await unlockSpeech();
      } else {
        requestParentSpeechUnlock();
        setVoiceStatus("Homepage voice is ready.", "");
      }
      const data = await postJson("/local/session", {});
      localSessionId = data.session_id || "";
      appendTurn("agent", data.message || INITIAL_GREETING);
    } else {
      void maybeSpeakWelcomeGreeting();
      appendAgentTurnProgressive(INITIAL_GREETING, {
        speak: true,
        delayMs: 180,
        stepMs: 14,
      });
    }

    btnStart.disabled = true;
    btnStop.disabled = false;
    setStatus("idle", ASSISTANT_MODE === "local" ? "Local chat ready" : "Ready for text");
    chatInput.focus();
  } catch (error) {
    sessionStarted = false;
    localSessionId = "";
    btnStart.disabled = false;
    btnStop.disabled = true;
    setStatus("error", "Unavailable");
    setVoiceStatus("Assistant startup failed.", "error");
    showError(
      ASSISTANT_MODE === "local"
        ? `${error.message} Make sure the backend is running on ${BACKEND_ORIGIN} and Ollama is installed with the configured model.`
        : error.message,
    );
  }
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text) return;
  stopAssistantSpeech();
  chatInput.value = "";

  if (ASSISTANT_MODE !== "local") {
    handleUserMessage(text);
    return;
  }

  if (!sessionStarted || !localSessionId) {
    showError("Start DataMetricus Assistant before sending a message.");
    return;
  }

  const message = cleanValue(text);
  clearError();
  appendTurn("user", message);
  captureLeadDetails(message);
  updateLeadPanel();

  setStatus("connecting", "Waiting for local reply...");

  try {
    const data = await postJson("/local/chat", {
      session_id: localSessionId,
      message,
    });
    appendTurn("agent", data.reply || "I couldn't generate a reply just now.");
    updateLeadPanel();
    setStatus("idle", "Local chat ready");
  } catch (error) {
    setVoiceStatus("No spoken reply because chat failed.", "error");
    showError(error.message);
    setStatus("error", "Local reply failed");
  }
}

btnStart.addEventListener("click", startAssistant);
btnStop.addEventListener("click", stopSession);
if (btnSend) btnSend.addEventListener("click", sendMessage);
if (btnReplay) btnReplay.addEventListener("click", replayAssistantSpeech);
if (btnEnableVoice) {
  btnEnableVoice.addEventListener("click", () => {
    if (ASSISTANT_MODE === "local") {
      void unlockSpeech().then((enabled) => {
        if (enabled && lastAssistantReply) {
          void speakAssistantText(lastAssistantReply);
        }
      });
      return;
    }
    void maybeSpeakWelcomeGreeting();
  });
}

if (chatInput) {
  chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
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
  window.addEventListener("load", () => {
    startAssistant();
  }, { once: true });
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === "dm-start-assistant") {
    startAssistant();
    return;
  }

  if (event.data?.type === "dm-speak-status" && event.data?.speechId === pendingParentSpeechId) {
    pendingParentSpeechId = null;
    if (event.data.status === "started") {
      setVoiceStatus("Homepage voice is speaking...", "speaking");
      return;
    }

    if (event.data.status === "done") {
      setVoiceStatus("Homepage voice playback complete.", "");
      return;
    }

    if (event.data.status === "blocked") {
      setVoiceStatus("Homepage voice was blocked. Close and reopen the assistant, then click Start again.", "blocked");
      return;
    }

    if (event.data.status === "error") {
      setVoiceStatus("Homepage voice playback failed. Close and reopen the assistant, then click Start again.", "error");
    }
  }
});

updateLeadPanel();
setStatus("idle", "Ready");
setVoiceStatus("");
