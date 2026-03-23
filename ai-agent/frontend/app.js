"use strict";

const INITIAL_GREETING_EN = "Hello, welcome to DataMetricus. I'm the AI assistant. Are you looking for advisory support or training?";
const INITIAL_GREETING_IT = "Ciao, benvenuto in DataMetricus. Sono l'assistente AI. Cerchi supporto di advisory o formazione?";

function queryParam(name) {
  return new URLSearchParams(window.location.search).get(name) || "";
}

const EMBED_MODE    = queryParam("embed")    === "1";
const AUTOSTART     = queryParam("autostart") === "1";
const ASSISTANT_MODE = queryParam("mode")    || "local";
const BACKEND_ORIGIN = (queryParam("backend") || "http://localhost:8000").replace(/\/+$/, "");
const BACKEND_TOKEN  = queryParam("token")   || "";
const ASSISTANT_TEXT_DELAY_MS = 120;
const ASSISTANT_TEXT_STEP_MS  = 24;

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
const speechLanguage = document.getElementById("speechLanguage");

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
const querySpeechLang = queryParam("speech_lang");
let selectedSpeechLanguage = (querySpeechLang === "it" || querySpeechLang === "en") ? querySpeechLang : "";

function isItalianMode() {
  return selectedSpeechLanguage === "it";
}

function hasSpeechLanguageSelection() {
  return selectedSpeechLanguage === "en" || selectedSpeechLanguage === "it";
}

function initialGreeting() {
  return isItalianMode() ? INITIAL_GREETING_IT : INITIAL_GREETING_EN;
}

function localModeUserMessage(message) {
  if (!isItalianMode()) return message;
  return `Rispondi in italiano. Mantieni un tono professionale, chiaro e conciso. Messaggio utente: ${message}`;
}

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
if (speechLanguage) speechLanguage.value = selectedSpeechLanguage;
if (btnStart && !hasSpeechLanguageSelection()) btnStart.disabled = true;
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
  const {
    speak = true,
    delayMs = ASSISTANT_TEXT_DELAY_MS,
    stepMs = ASSISTANT_TEXT_STEP_MS,
  } = options;
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
  let typingDone = false;
  let fallbackStarted = false;

  const finishTyping = () => {
    if (typingDone) return;
    typingDone = true;
    body.textContent = text;
    body.classList.remove("streaming");
    if (actionsEl) actionsEl.hidden = false;
    transcriptBody.scrollTop = transcriptBody.scrollHeight;
  };

  const startFallbackTyping = () => {
    if (typingDone || fallbackStarted) return;
    fallbackStarted = true;

    const chars = Array.from(text);
    let index = 0;

    const tick = () => {
      if (typingDone) return;
      if (index >= chars.length) {
        finishTyping();
        return;
      }
      body.textContent += chars[index];
      index++;
      transcriptBody.scrollTop = transcriptBody.scrollHeight;
      window.setTimeout(tick, stepMs);
    };

    window.setTimeout(tick, delayMs);
  };

  if (!speak) {
    startFallbackTyping();
    return;
  }

  // Use speech boundary events for tighter text/voice sync; fallback to timer typing if unavailable.
  let sawBoundary = false;
  let sawSpeechStart = false;
  const speechGuardId = window.setTimeout(() => {
    if (!typingDone && !sawBoundary && !sawSpeechStart) startFallbackTyping();
  }, delayMs + 700);
  void speakText(text, {
    startDelayMs: delayMs,
    onStart: () => {
      sawSpeechStart = true;
    },
    onBoundary: (event) => {
      if (typingDone) return;
      if (typeof event?.charIndex !== "number") return;
      sawBoundary = true;
      const index = Math.max(0, Math.min(text.length, event.charIndex));
      body.textContent = text.slice(0, index);
      transcriptBody.scrollTop = transcriptBody.scrollHeight;
    },
    onEnd: () => {
      window.clearTimeout(speechGuardId);
      finishTyping();
    },
    onError: () => {
      window.clearTimeout(speechGuardId);
      if (!sawBoundary) startFallbackTyping();
      else finishTyping();
    },
  }).then((spoken) => {
    window.clearTimeout(speechGuardId);
    if (!spoken) startFallbackTyping();
  });
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

function selectedSpeechLocale() {
  return selectedSpeechLanguage === "it" ? "it-IT" : "en-US";
}

function chooseSpeechVoice(language = selectedSpeechLanguage) {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  if (!voices.length) return null;

  const langRegex = language === "it"
    ? /^it(-|_)?(IT)?/i
    : /^en(-|_)?(US|GB)?/i;

  const preferredNames = language === "it"
    ? ["Alice", "Federica", "Luca", "Paola"]
    : ["Samantha", "Daniel", "Karen", "Alex"];

  const preferredByName = preferredNames
    .map((name) => voices.find((voice) => voice.name === name))
    .find(Boolean);

  const languageMatch = voices.find((voice) => langRegex.test(voice.lang));
  if (language === "it") {
    // In Italian mode, avoid silently falling back to English voices.
    return preferredByName || languageMatch || null;
  }

  return (
    preferredByName ||
    languageMatch ||
    voices.find((voice) => /^en(-|_)?(US|GB)?/i.test(voice.lang)) ||
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
  preferredVoice = chooseSpeechVoice(selectedSpeechLanguage);
  setVoiceStatus(EMBED_MODE ? "Embedded voice is ready." : "Voice is ready.", "");
  return true;
}

async function speakText(text, options = {}) {
  const {
    startDelayMs = 120,
    onStart = null,
    onBoundary = null,
    onEnd = null,
    onError = null,
  } = options;
  const speakableText = normaliseSpeechText(text);
  if (!speakableText || !window.speechSynthesis) return false;
  if (!speechEnabled) {
    setVoiceStatus("Voice is not enabled yet.", "blocked");
    return false;
  }
  clearError();
  await waitForVoices();
  preferredVoice = chooseSpeechVoice(selectedSpeechLanguage);

  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(speakableText);
    if (preferredVoice) utterance.voice = preferredVoice;
    utterance.lang   = selectedSpeechLocale();
    utterance.rate   = 1;
    utterance.pitch  = 1;
    utterance.volume = 1;

    utterance.onstart = (event) => {
      setVoiceStatus("Speaking reply...", "speaking");
      if (typeof onStart === "function") onStart(event);
    };
    utterance.onboundary = (event) => {
      if (typeof onBoundary === "function") onBoundary(event);
    };
    utterance.onend = (event) => {
      setVoiceStatus("", "");
      setStatus("idle", "Ready");
      if (typeof onEnd === "function") onEnd(event);
      resolve(true);
    };
    utterance.onerror = (event) => {
      setVoiceStatus(`Speech failed: ${event.error}`, "error");
      if (typeof onError === "function") onError(event);
      resolve(false);
    };

    window.setTimeout(() => window.speechSynthesis.speak(utterance), startDelayMs);
  });
}

async function speakAssistantText(text) {
  if (!text || !window.speechSynthesis) return false;
  return speakText(text);
}

function showVoiceConsent(message = "") {
  setVoiceStatus(
    message || (hasSpeechLanguageSelection()
      ? "Click Start DataMetricus Assistant to enable voice."
      : "Select EN or IT first, then click Start DataMetricus Assistant."),
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
  if (!lastAssistantReply) {
    showError(isItalianMode() ? "Non c'è ancora una risposta dell'assistente da riprodurre." : "There is no assistant reply to replay yet.");
    return;
  }
  void speakAssistantText(lastAssistantReply);
}

// ── Conversation logic ────────────────────────────────────────────────────────
/**
 * Returns { reply: string, actions: [{label, href}] }
 */
function buildAssistantReplyEn(text) {
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

function buildAssistantReplyIt(text) {
  const lower = text.toLowerCase();

  const isTraining  = /\btraining|formazione|corso|corsi|workshop|impar|programma|upskill\b/i.test(lower);
  const isAdvisory  = /\badvisory|consul|progetto|analisi|modello|audit|pipeline|ricerca|assicur|sanit|attuar|regolat\b/i.test(lower);
  const wantsContact = /\bcontatt|email|chiam|parl|ricontatt|get in touch|s[iì]\b|^certo$|^ok$|^okay$|^va bene$/i.test(lower);
  const wantsMore   = /\bpi[uù]|domand|spiega|cosa|come|altro|altra|no\b|^non ancora$/i.test(lower);

  if (convState === "ask_service") {
    if (/\bciao|salve|buongiorno|buonasera|hello|hi|hey\b/i.test(lower)) {
      return { reply: "Ciao! Cerchi supporto di advisory o formazione?", actions: [] };
    }
    if (isTraining) {
      lead.inquiry_type = "training";
      convState = "ask_detail";
      return {
        reply: "Offriamo tre percorsi formativi strutturati: Fondamenti, Modellazione Applicata e Workflow Riproducibili. Quale percorso ti interessa di più?",
        actions: [{ label: "Vedi tutti i programmi formativi →", href: "/training.html" }],
      };
    }
    if (isAdvisory) {
      lead.inquiry_type = "advisory";
      convState = "ask_detail";
      return {
        reply: "Copriamo modellistica attuariale, metriche sanitarie, ricerca riproducibile e analytics regolamentare. Su quale area sei focalizzato?",
        actions: [{ label: "Vedi i nostri servizi →", href: "/services.html" }],
      };
    }
    return {
      reply: "Posso aiutarti con servizi di advisory o programmi di formazione. Quale ti interessa?",
      actions: [],
    };
  }

  if (convState === "ask_detail") {
    convState = "offer_contact";

    if (lead.inquiry_type === "training") {
      let track = "";
      let detail = "";
      if (/fondament|foundation/i.test(lower)) {
        track  = "Foundations";
        detail = "Il percorso Fondamenti copre metodi quantitativi di base e principi di riproducibilità.";
      } else if (/applied|modelling|modeling|modellazione/i.test(lower)) {
        track  = "Applied Modelling";
        detail = "Il percorso Modellazione Applicata copre costruzione pratica di modelli statistici e attuariali.";
      } else if (/reproducible|riproduc|quarto|workflow/i.test(lower)) {
        track  = "Reproducible Workflows";
        detail = "Il percorso Workflow Riproducibili copre Quarto, controllo versione e pipeline verificabili.";
      }
      if (track) lead.training_track = track;

      return {
        reply: `${detail || "La nostra formazione è pensata per analisti che vogliono lavorare con maggiore rigore metodologico."} Vuoi che il nostro team ti contatti con maggiori dettagli?`,
        actions: [{ label: "Vedi il curriculum completo →", href: "/training.html" }],
      };
    }

    if (lead.inquiry_type === "advisory") {
      if (/insurance|assicur|attuar/i.test(lower))                lead.domain = "Assicurazioni vita e salute";
      else if (/public health|epidemiol|health metric|sanit/i.test(lower)) lead.domain = "Sanità pubblica";
      else if (/regolat|governance|risk|rischio/i.test(lower))    lead.domain = "Regolamentazione e rischio";
      else if (/research|academic|ricerca|accademic/i.test(lower)) lead.domain = "Ricerca";

      const area = lead.domain ? lead.domain.toLowerCase() : "la tua area";
      return {
        reply: `Saremo felici di supportarti su ${area}. Il nostro lavoro è completamente documentato e verificabile in modo indipendente. Vuoi che il nostro team ti contatti?`,
        actions: [{ label: "Vedi i nostri servizi →", href: "/services.html" }],
      };
    }

    return {
      reply: "Vuoi che il nostro team specialistico ti contatti?",
      actions: [],
    };
  }

  if (convState === "offer_contact") {
    if (wantsContact && !wantsMore) {
      convState = "done";
      return {
        reply: "Perfetto. Usa il nostro modulo contatti per inviare la richiesta: il team risponde entro un giorno lavorativo. Quando vuoi, clicca Dismiss per chiudere l'assistente. Se vuoi riprendere la chat, aggiorna la pagina.",
        actions: [{ label: "Vai al modulo contatti →", href: "/contact.html" }],
      };
    }
    if (/price|pricing|cost|fee|charge|budget|quote|prezzo|costo|preventivo/i.test(lower)) {
      return {
        reply: "Il prezzo dipende da ambito e livello di complessità tecnica. Possiamo preparare un preventivo su misura. Vuoi che il nostro team ti contatti?",
        actions: [],
      };
    }
    if (/where|location|based|office|remote|dove|sede|remoto/i.test(lower)) {
      return {
        reply: "DataMetricus opera come advisory indipendente, con clienti sia da remoto sia on-site. Vuoi che il nostro team ti ricontatti?",
        actions: [],
      };
    }
    if (/how long|timeline|duration|time|weeks|months|temp|durata|settimane|mesi/i.test(lower)) {
      return {
        reply: "Le tempistiche variano in base allo scope. I progetti più piccoli durano in genere da due a quattro settimane; quelli più ampi vengono pianificati su misura. Vuoi confrontarti sul tuo caso specifico?",
        actions: [],
      };
    }
    if (/no|not now|later|maybe|another time|non ora|pi[uù] tardi|magari/i.test(lower)) {
      convState = "done";
      return {
        reply: "Nessun problema. Puoi sempre contattarci dalla pagina contatti. Clicca Dismiss per chiudere l'assistente, oppure aggiorna la pagina per iniziare una nuova conversazione.",
        actions: [{ label: "Contattaci →", href: "/contact.html" }],
      };
    }
    return {
      reply: "Posso aiutarti soprattutto su servizi e formazione. Per richieste più specifiche, il nostro team può supportarti direttamente. Vuoi essere ricontattato?",
      actions: [{ label: "Vai al modulo contatti →", href: "/contact.html" }],
    };
  }

  return {
    reply: "Spero sia stato utile. Clicca Dismiss per chiudere l'assistente, oppure aggiorna la pagina per iniziare una nuova conversazione.",
    actions: [],
  };
}

function buildAssistantReply(text) {
  return isItalianMode() ? buildAssistantReplyIt(text) : buildAssistantReplyEn(text);
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
    appendAgentTurnProgressive(reply, actions);
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
  if (!hasSpeechLanguageSelection()) {
    setVoiceStatus("Please choose a language first.", "blocked");
    return;
  }
  startInProgress = true;
  clearError();
  setStatus("connecting", ASSISTANT_MODE === "local" ? "Connecting to local model..." : "Starting...");

  try {
    sessionStarted = true;

    if (ASSISTANT_MODE === "local") {
      if (!EMBED_MODE) await unlockSpeech();
      else { requestParentSpeechUnlock(); setVoiceStatus("Homepage voice is ready.", ""); }
      const data = await postJson("/local/session", { language: selectedSpeechLanguage });
      localSessionId = data.session_id || "";
      appendAgentTurnProgressive(data.message || initialGreeting(), [], { delayMs: 180 });
    } else {
      await unlockSpeech();
      appendAgentTurnProgressive(initialGreeting(), [], { speak: true, delayMs: 180 });
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
    const data = await postJson("/local/chat", {
      session_id: localSessionId,
      message: localModeUserMessage(message),
      language: selectedSpeechLanguage,
    });
    appendAgentTurnProgressive(
      data.reply || (isItalianMode() ? "Non sono riuscito a generare una risposta in questo momento." : "I couldn't generate a reply just now."),
    );
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
      void speakAssistantText(lastAssistantReply || initialGreeting());
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

if (speechLanguage) {
  speechLanguage.addEventListener("change", () => {
    selectedSpeechLanguage = speechLanguage.value === "it" ? "it" : (speechLanguage.value === "en" ? "en" : "");
    if (!hasSpeechLanguageSelection()) {
      if (btnStart) btnStart.disabled = true;
      setVoiceStatus("Please select EN or IT.", "blocked");
      return;
    }
    if (btnStart && !sessionStarted) btnStart.disabled = false;
    clearError();
    // Update voice immediately in case user has already unlocked speech, otherwise on next unlock or assistant start.
    try {
      window.speechSynthesis.cancel();
      window.speechSynthesis.resume();
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0.01;
      u.lang = selectedSpeechLocale();
      window.speechSynthesis.speak(u);
    } catch (_) {}
    
    preferredVoice = chooseSpeechVoice(selectedSpeechLanguage);
    if (selectedSpeechLanguage === "it" && !preferredVoice) {
      setVoiceStatus("Italian selected. No Italian voice found in this browser yet.", "blocked");
    } else {
      setVoiceStatus(selectedSpeechLanguage === "it" ? "Voice language set to Italiano." : "Voice language set to English.", "");
    }
    if (!sessionStarted && !startInProgress) void startAssistant();
  });
}

if (window.speechSynthesis) {
  window.speechSynthesis.addEventListener("voiceschanged", () => {
    preferredVoice = chooseSpeechVoice(selectedSpeechLanguage);
  });
  preferredVoice = chooseSpeechVoice(selectedSpeechLanguage);
  registerGreetingUnlockHandlers();
} else {
  if (btnReplay) btnReplay.disabled = true;
  showVoiceConsent("This browser does not support SpeechSynthesis. Text chat is still available.");
  setVoiceStatus("SpeechSynthesis is unavailable in this browser.", "error");
}

if (AUTOSTART) {
  btnStop.hidden = EMBED_MODE;
  window.addEventListener("load", () => {
    if (hasSpeechLanguageSelection()) startAssistant();
  }, { once: true });
}

window.addEventListener("message", (event) => {
  if (event.origin !== window.location.origin) return;
  if (event.data?.type === "dm-start-assistant") startAssistant();
});

updateLeadPanel();
setStatus("idle", "Ready");
setVoiceStatus("");
