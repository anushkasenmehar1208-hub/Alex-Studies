/**
 * Alex Live Voice — OpenAI Whisper STT + OpenRouter LLM + server TTS only (WAV base64)
 * STT: OpenAI Whisper  (MediaRecorder → /api/alex-voice-stt, needs OPENAI_API_KEY)
 * LLM: OpenRouter      (/api/alex-voice, needs OPENROUTER_API_KEY)
 * TTS: Fish Audio if FISH_AUDIO_API_KEY, else OpenAI /v1/audio/speech — no browser / system robot voice
 */
(function () {
  var sessionId = Math.random().toString(36).slice(2); // fallback only
  var voiceStartedAt = 0;
  var limitTimer = null;
  var active = false;
  var processing = false;
  var mediaRecorder = null;
  var micStream = null;
  var audioChunks = [];
  var currentAudio = null;
  /** When using Blob URLs for TTS playback (Safari often fails on long data:audio/wav;base64,...). */
  var currentAudioObjectUrl = null;
  var maxRecordTimeout = null;

  /** Tiny silent WAV — used only to satisfy autoplay policy on a user gesture (muted play). */
  var ALEX_SILENT_WAV_DATA_URL = (
    'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEAIlYAAESsAAACABAAZGF0YQAAAAA='
  );

  function removeTapToPlayFallback() {
    var w = document.getElementById('alex-tap-to-play-audio-wrap');
    if (w && w.parentNode) w.parentNode.removeChild(w);
  }

  /** Call synchronously from click/key handlers so later async TTS play() is more likely allowed. */
  function tryPrimeAudioOnUserGesture() {
    try {
      var a = new Audio(ALEX_SILENT_WAV_DATA_URL);
      a.muted = true;
      var p = a.play();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          try {
            a.pause();
            a.removeAttribute('src');
            a.load();
          } catch (e1) {}
        }).catch(function () {});
      }
    } catch (e2) {}
  }

  function disposeCurrentPlayback() {
    stopAlexPlaybackEngine();
    removeTapToPlayFallback();
    try {
      if (currentAudio) {
        currentAudio.onended = null;
        currentAudio.onerror = null;
        currentAudio.pause();
      }
    } catch (e0) {}
    currentAudio = null;
    if (currentAudioObjectUrl) {
      try {
        URL.revokeObjectURL(currentAudioObjectUrl);
      } catch (e1) {}
      currentAudioObjectUrl = null;
    }
  }
  var introPlayed = false;

  /** Wait before reopening the mic after Alex finishes speaking — reduces speaker→mic echo re-triggering STT. */
  var POST_SPEECH_MIC_DELAY_MS = 250;

  function scheduleListenAfterSpeech() {
    if (!active) return;
    setTimeout(function () {
      if (active) startListening();
    }, POST_SPEECH_MIC_DELAY_MS);
  }

  /**
   * SSE voice segments: sequential HTML5 Audio only.
   * Web Audio decode/play was unreliable on Safari (silent output); this matches JSON fallback playback.
   */
  var alexAudioChain = Promise.resolve();
  /** Active stream clip — stopped when clearing playback. */
  var alexStreamActiveAudio = null;
  /** Segments enqueued but not yet finished playing. */
  var alexPendingSegments = 0;
  /** True once the SSE 'done' event has been received for the current stream. */
  var alexSseDone = false;

  function stopAlexPlaybackEngine() {
    try {
      if (alexStreamActiveAudio) {
        alexStreamActiveAudio.onended = null;
        alexStreamActiveAudio.onerror = null;
        alexStreamActiveAudio.pause();
        alexStreamActiveAudio = null;
      }
    } catch (eSt) {}
    alexAudioChain = Promise.resolve();
    alexPendingSegments = 0;
    alexSseDone = false;
  }

  /**
   * Queue one WAV segment after the previous ends (promise chain).
   * Shows "Preparing..." when a clip ends but more is still incoming.
   * @returns {Promise}
   */
  function enqueueAlexStreamAudioSegment(b64) {
    var raw = (b64 || '').trim();
    if (!raw) return alexAudioChain;
    alexPendingSegments++;
    alexAudioChain = alexAudioChain.then(function () {
      setOrbState('ai-speaking');
      setStatus('Alex is speaking...');
      return new Promise(function (resolve) {
        var url = wavBase64ToObjectUrl(raw);
        if (!url) {
          alexPendingSegments--;
          resolve();
          return;
        }
        var a = new Audio(url);
        alexStreamActiveAudio = a;
        a.onended = function () {
          try {
            URL.revokeObjectURL(url);
          } catch (eR) {}
          if (alexStreamActiveAudio === a) alexStreamActiveAudio = null;
          alexPendingSegments--;
          if (alexPendingSegments === 0 && !alexSseDone) {
            setOrbState('thinking');
          }
          resolve();
        };
        a.onerror = function () {
          try {
            URL.revokeObjectURL(url);
          } catch (eR2) {}
          if (alexStreamActiveAudio === a) alexStreamActiveAudio = null;
          alexPendingSegments--;
          resolve();
        };
        var pr = a.play();
        if (pr && typeof pr.then === 'function') {
          pr.catch(function (ePlay) {
            console.warn('[AlexVoice] stream clip play()', ePlay);
            appendVoiceServerNotice(
              'Could not play Alex\'s voice. Tap once on this page, then try again — Safari often blocks audio until you interact.'
            );
            try {
              URL.revokeObjectURL(url);
            } catch (eRv) {}
            if (alexStreamActiveAudio === a) alexStreamActiveAudio = null;
            alexPendingSegments--;
            resolve();
          });
        }
      });
    });
    return alexAudioChain;
  }

  /**
   * SSE: first audio may arrive while the model is still generating; tail + done follow.
   */
  async function consumeAlexVoiceStream(response, uLine) {
    stopAlexPlaybackEngine();
    var carry = '';
    var decoder = new TextDecoder();
    var heardAudio = false;
    var streamUiDone = false;

    function streamPlaybackFinished() {
      processing = false;
      setOrbState('idle');
      if (active) scheduleListenAfterSpeech();
    }

    function dispatch(obj) {
      if (!obj || !obj.type) return;
      if (obj.type === 'audio') {
        var ab = (obj.audio_b64 || '').trim();
        if (!ab) return;
        heardAudio = true;
        processing = false;
        setOrbState('ai-speaking');
        setStatus('Alex is speaking...');
        if (!streamUiDone) setTranscript('');
        enqueueAlexStreamAudioSegment(ab);
        return;
      }
      if (obj.type === 'audio_tail') {
        var tb = (obj.audio_b64 || '').trim();
        if (tb) enqueueAlexStreamAudioSegment(tb);
        return;
      }
      if (obj.type === 'done') {
        streamUiDone = true;
        alexSseDone = true;
        applyAlexLanguagePrefsFromVoice(obj);
        try {
          window.__voiceLastUserLine = '';
        } catch (eZ) {}
        if (obj.display_html || obj.text) {
          renderVoiceTranscriptBlock(uLine, obj);
        } else if (uLine) {
          setTranscript(uLine);
        }
        if (!heardAudio) {
          streamPlaybackFinished();
        } else {
          alexAudioChain = alexAudioChain
            .then(function () {
              streamPlaybackFinished();
            })
            .catch(function () {
              streamPlaybackFinished();
            });
        }
        return;
      }
      if (obj.type === 'error') {
        appendVoiceServerNotice(obj.message || 'Voice reply failed.');
        try {
          window.__voiceLastUserLine = '';
        } catch (eZ2) {}
        stopAlexPlaybackEngine();
        streamPlaybackFinished();
      }
    }

    try {
      var reader = response.body.getReader();
      while (true) {
        var rd = await reader.read();
        if (rd.done) break;
        carry += decoder.decode(rd.value, { stream: true });
        var parts = carry.split('\n\n');
        carry = parts.pop() || '';
        for (var p = 0; p < parts.length; p++) {
          var block = parts[p];
          var lines = block.split('\n');
          for (var L = 0; L < lines.length; L++) {
            var line = lines[L];
            if (line.indexOf('data:') !== 0) continue;
            var payload = line.slice(5).replace(/^\s+/, '');
            if (!payload || payload === '[DONE]') continue;
            try {
              dispatch(JSON.parse(payload));
            } catch (eJ) {}
          }
        }
      }
    } catch (eRead) {
      console.error('[AlexVoice] stream read error:', eRead);
      stopAlexPlaybackEngine();
      processing = false;
      setOrbState('idle');
      if (active) scheduleListenAfterSpeech();
    }
  }

  // Voice Activity Detection (VAD) state
  var audioContext = null;
  var analyser = null;
  var vadInterval = null;
  var speechDetected = false;
  var silenceStart = 0;
  /** Smoothed mic level (0–~90); updated each VAD tick */
  var vadSmoothedRms = 0;
  /** When current “above start threshold” streak began; 0 = none */
  var vadSustainStart = 0;
  // Raw time-domain RMS is noisy; smooth + require sustained energy before “speech”
  var VAD_EMA_ALPHA = 0.28;
  // Must exceed this (after smoothing) to count toward speech onset — filters keyboard/fan hum
  var VAD_SPEECH_START_RMS = 18;
  // Lower threshold after speech began — keeps natural pauses inside a sentence
  var VAD_SPEECH_END_RMS = 10;
  // Require this many ms of continuous “loud” before we treat it as real speech
  var VAD_SPEECH_SUSTAIN_MS = 140;
  // Still run STT if blob is at least this big, even when VAD never armed (fixes “ok” / whispers)
  var MIN_BLOB_FOR_STT = 80;
  var SILENCE_DURATION = 700;    // ms of silence before auto-stop (ChatGPT/Gemini-like snappiness)
  var MAX_RECORD_MS = 15000;     // absolute max recording time
  /** If user never starts speaking, Alex checks in after this many ms (keep high to avoid nagging / repeat). */
  var NO_SPEECH_NUDGE_MS = 12000;
  var noSpeechNudgeTimer = null;
  var silenceNudgePending = false;

  function apiBase() {
    var base = (window.ALEX_API_BASE || '').replace(/\/$/, '');
    if (base) return base;
    if (location.port === '3000' || location.port === '3001') {
      return location.protocol + '//' + location.hostname + ':8000';
    }
    return '';
  }

  function voiceKey() {
    return window.ALEX_VOICE_KEY || sessionId;
  }

  function authToken() {
    try {
      var k = window.ALEX_AUTH_STORAGE_KEY || '';
      return k ? (localStorage.getItem(k) || '') : '';
    } catch (e) {
      return '';
    }
  }

  function authHeadersJson() {
    var h = { 'Content-Type': 'application/json' };
    var t = authToken();
    if (t) h['X-Auth-Token'] = t;
    return h;
  }

  function authHeadersForStt(audioMime) {
    var h = { 'Content-Type': audioMime || 'audio/webm' };
    var t = authToken();
    if (t) h['X-Auth-Token'] = t;
    return h;
  }

  function authHeadersForGet() {
    var h = {};
    var t = authToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  function applyAlexLanguagePrefsFromVoice(data) {
    if (!data) return;
    try {
      if (data.voice_language_persist) {
        localStorage.setItem('alex_voice_language', String(data.voice_language_persist));
      }
      if (data.reply_language_persist) {
        localStorage.setItem('alex_reply_language', String(data.reply_language_persist));
      }
    } catch (e) {}
  }

  /** @returns {boolean} true if caller should abort normal flow */
  function handleVoiceHttpError(status) {
    if (status === 401 || status === 403) {
      setStatus('Sign-in required');
      setTranscript('Your session expired — sign in again and reload this page.');
      stopAlex(true);
      return true;
    }
    if (status === 410) {
      setStatus('Session expired');
      setTranscript('Reload this page to start a new voice session.');
      stopAlex(true);
      return true;
    }
    return false;
  }

  console.log('[AlexVoice] loaded (orb UI + voice APIs + VAD)');

  function micMuted() {
    try {
      return !!window.__alex_mic_muted;
    } catch (eM) {
      return false;
    }
  }

  function syncMicToggleButton() {
    var b = document.getElementById('alex-mic-toggle');
    if (!b) return;
    var m = micMuted();
    b.textContent = m ? 'Unmute mic' : 'Mute mic';
    if (m) b.classList.add('alex-mic-muted');
    else b.classList.remove('alex-mic-muted');
    b.setAttribute('aria-pressed', m ? 'true' : 'false');
  }

  /** Pause auto-capture / VAD — student can type and listen without mic segments. */
  function setMicMuted(muted) {
    try {
      window.__alex_mic_muted = !!muted;
    } catch (e0) {}
    syncMicToggleButton();
    if (muted && active) {
      abortCurrentListenSegment();
      stopVAD();
      clearNoSpeechNudgeTimer();
      silenceNudgePending = false;
      setOrbState('idle');
      setStatus('Mic muted — type below; tap Unmute mic to speak again');
    } else if (!muted && active && !processing) {
      startListening();
    }
  }

  function attachMicToggle() {
    var b = document.getElementById('alex-mic-toggle');
    if (b && !b._alexMicBound) {
      b._alexMicBound = true;
      b.addEventListener('click', function () {
        if (b.disabled) return;
        tryPrimeAudioOnUserGesture();
        setMicMuted(!micMuted());
      });
    }
  }

  function installPageHideEndVoiceOnce() {
    if (window.__alex_voice_pagehide_installed) return;
    window.__alex_voice_pagehide_installed = true;
    // Only end on actual navigation/close — NOT on tab-switch (visibilitychange).
    window.addEventListener('pagehide', function () {
      try {
        if (window.__alex_voice_session_active && window.stopAlexVoiceSession) {
          window.stopAlexVoiceSession();
        }
      } catch (ePh) {}
    });
    // Tab switch policy:
    //   - Tab hidden  → pause Alex's voice playback so the user doesn't hear
    //     the AI talking in the background while they're working in another
    //     tab. We pause (don't dispose) so the clip can resume seamlessly.
    //   - Tab visible → resume any paused playback and resume a suspended
    //     AudioContext so MediaRecorder/STT keeps working.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) {
        try {
          if (currentAudio && !currentAudio.paused) {
            currentAudio.__alexBgPaused = true;
            currentAudio.pause();
          }
        } catch (eHa) {}
        try {
          if (alexStreamActiveAudio && !alexStreamActiveAudio.paused) {
            alexStreamActiveAudio.__alexBgPaused = true;
            alexStreamActiveAudio.pause();
          }
        } catch (eHb) {}
        try { setStatus('Paused — return to this tab to keep listening'); } catch (eHs) {}
        return;
      }
      try {
        if (audioContext && audioContext.state === 'suspended') {
          audioContext.resume().catch(function () {});
        }
      } catch (eVis) {}
      try {
        if (currentAudio && currentAudio.__alexBgPaused) {
          currentAudio.__alexBgPaused = false;
          var p1 = currentAudio.play();
          if (p1 && p1.catch) p1.catch(function () {});
        }
      } catch (eRa) {}
      try {
        if (alexStreamActiveAudio && alexStreamActiveAudio.__alexBgPaused) {
          alexStreamActiveAudio.__alexBgPaused = false;
          var p2 = alexStreamActiveAudio.play();
          if (p2 && p2.catch) p2.catch(function () {});
        }
      } catch (eRb) {}
      try {
        if (alexStreamActiveAudio || (currentAudio && !currentAudio.paused)) {
          setOrbState('ai-speaking');
          setStatus('Alex is speaking...');
        }
      } catch (eRs) {}
    });
  }
  installPageHideEndVoiceOnce();

  /**
   * Decode server WAV base64 into a blob: URL — more reliable than huge data: URLs (esp. Safari).
   * @returns {string|null}
   */
  function wavBase64ToObjectUrl(b64) {
    try {
      var bin = atob(b64);
      var n = bin.length;
      var bytes = new Uint8Array(n);
      for (var i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'audio/wav' });
      return URL.createObjectURL(blob);
    } catch (e) {
      console.warn('[AlexVoice] invalid audio base64:', e);
      return null;
    }
  }

  // Attach click handler to button (React doesn't support string onclick)
  function attachBtn() {
    var btn = document.getElementById('alex-btn');
    if (btn && !btn._alexBound) {
      btn._alexBound = true;
      btn.addEventListener('click', function () { toggleAlexVoice(); });
      console.log('[AlexVoice] button bound');
    }
  }

  function setTypeUiEnabled(on) {
    var row = document.getElementById('alex-type-row');
    var inp = document.getElementById('alex-type-input');
    var snd = document.getElementById('alex-type-send');
    var mt = document.getElementById('alex-mic-toggle');
    if (inp) inp.disabled = !on;
    if (snd) snd.disabled = !on;
    if (mt) mt.disabled = !on;
    if (row) row.style.opacity = on ? '1' : '0.45';
  }

  function attachTypeUi() {
    var inp = document.getElementById('alex-type-input');
    var snd = document.getElementById('alex-type-send');
    if (inp && !inp._alexBound) {
      inp._alexBound = true;
      inp.addEventListener('focus', function () {
        if (active) abortCurrentListenSegment();
      });
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          sendTypedAlexMessage();
        }
      });
    }
    if (snd && !snd._alexBound) {
      snd._alexBound = true;
      snd.addEventListener('click', function () { sendTypedAlexMessage(); });
    }
  }

  // Try immediately + poll for React render
  attachBtn();
  attachTypeUi();
  attachMicToggle();
  var _bindAttempts = 0;
  var _bindPoll = setInterval(function () {
    attachBtn();
    attachTypeUi();
    attachMicToggle();
    _bindAttempts++;
    var b = document.getElementById('alex-btn');
    var i = document.getElementById('alex-type-input');
    if ((b && b._alexBound && i && i._alexBound) || _bindAttempts > 100) {
      clearInterval(_bindPoll);
    }
  }, 300);

  // ── UI helpers ──────────────────────────────────────────────
  function setStatus(msg) {
    var el = document.getElementById('alex-status');
    if (el) el.textContent = msg;
  }

  function setTranscript(msg) {
    var el = document.getElementById('alex-transcript');
    if (!el) return;
    el.innerHTML = '';
    el.textContent = msg || '';
  }

  /** Rich markdown pane (server-rendered HTML) + optional plain user line above — like main chat. */
  function appendVoiceServerNotice(text) {
    var el = document.getElementById('alex-transcript');
    if (!el || !text) return;
    var n = document.createElement('div');
    n.className = 'alex-voice-server-notice';
    n.textContent = text;
    el.appendChild(n);
  }

  /**
   * When audio.play() is blocked (async fetch broke user-activation), keep the clip and offer
   * a gesture-bound Play button plus skip.
   */
  /**
   * @param {function} onResumeAfterPlay — after a blocked clip plays successfully (onended chains this).
   * @param {function} onSkipAllAudio — user skipped / no clip; clear tail and end without clearing reading pane.
   */
  function appendTapToPlayFallback(onResumeAfterPlay, onSkipAllAudio) {
    removeTapToPlayFallback();
    var el = document.getElementById('alex-transcript');
    if (!el) {
      if (typeof onSkipAllAudio === 'function') onSkipAllAudio();
      return;
    }
    var wrap = document.createElement('div');
    wrap.id = 'alex-tap-to-play-audio-wrap';
    wrap.className = 'alex-tap-to-play-wrap';
    var hint = document.createElement('p');
    hint.className = 'alex-tap-hint';
    hint.textContent = (
      "Your browser blocked automatic playback. Tap Play to hear Alex's voice (the reply stays above)."
    );
    var playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.id = 'alex-tap-to-play-audio';
    playBtn.className = 'alex-tap-to-play-btn';
    playBtn.textContent = "Play Alex's reply";
    playBtn.addEventListener('click', function onTap() {
      playBtn.removeEventListener('click', onTap);
      if (!currentAudio) {
        removeTapToPlayFallback();
        if (typeof onSkipAllAudio === 'function') onSkipAllAudio();
        return;
      }
      tryPrimeAudioOnUserGesture();
      var pr = currentAudio.play();
      if (pr && typeof pr.then === 'function') {
        pr.then(function () {
          removeTapToPlayFallback();
          setOrbState('ai-speaking');
          setStatus('Alex is speaking...');
        }).catch(function () {
          appendVoiceServerNotice(
            'Still could not play audio. Try another browser or check site sound permissions.'
          );
        });
      }
    });
    var skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.className = 'alex-tap-skip-audio';
    skipBtn.textContent = 'Continue without audio';
    skipBtn.addEventListener('click', function () {
      removeTapToPlayFallback();
      disposeCurrentPlayback();
      if (typeof onSkipAllAudio === 'function') onSkipAllAudio();
    });
    wrap.appendChild(hint);
    wrap.appendChild(playBtn);
    wrap.appendChild(document.createTextNode(' '));
    wrap.appendChild(skipBtn);
    el.appendChild(wrap);
  }

  function appendChatBubble(role, html, plain) {
    // Desktop right-side panel (hidden on mobile via CSS)
    var panel = document.getElementById('alex-chat-panel');
    // Mobile transparent chat panel (visible on mobile only via CSS)
    var mobilePanel = document.getElementById('alex-mobile-chat-panel');
    var targetPanel = (mobilePanel && window.innerWidth <= 900) ? mobilePanel : panel;
    if (!targetPanel) return;
    var bubble = document.createElement('div');
    bubble.className = 'alex-chat-bubble alex-chat-' + role;
    if (role === 'alex' && html) {
      bubble.innerHTML = html;
    } else {
      bubble.textContent = plain || '';
    }
    targetPanel.appendChild(bubble);
    targetPanel.scrollTop = targetPanel.scrollHeight;
  }

  function renderVoiceTranscriptBlock(userLinePlain, alexData) {
    var el = document.getElementById('alex-transcript');
    if (el) el.innerHTML = '';
    if (alexData && (alexData.display_html || alexData.text)) {
      appendChatBubble('alex', alexData.display_html || null, alexData.text || '');
    }
  }

  function upsellEnabled() {
    return window.ALEX_VOICE_SHOW_UPSELL !== false;
  }

  function showUpgradeButton() {
    if (!upsellEnabled()) return;
    var existing = document.getElementById('alex-upgrade-btn');
    if (existing) return;
    var btn = document.createElement('a');
    btn.id = 'alex-upgrade-btn';
    btn.textContent = '⭐ Upgrade to Premium';
    btn.href = '/pricing';
    btn.style.cssText = (
      'display:inline-block;margin-top:12px;padding:11px 28px;'
      + 'background:linear-gradient(135deg,#7c3aed,#4f46e5);'
      + 'color:white;border-radius:50px;font-size:.88rem;font-weight:600;'
      + 'text-decoration:none;letter-spacing:.03em;'
      + 'box-shadow:0 4px 15px rgba(124,58,237,.35);'
      + 'transition:opacity .2s;'
    );
    btn.onmouseover = function() { btn.style.opacity = '.85'; };
    btn.onmouseout  = function() { btn.style.opacity = '1'; };
    var transcript = document.getElementById('alex-transcript');
    if (transcript) transcript.after(btn);
  }

  function hideUpgradeButton() {
    var btn = document.getElementById('alex-upgrade-btn');
    if (btn) btn.remove();
  }

  function setOrbState(state) {
    // state: 'idle' | 'ai-speaking' | 'user-speaking' | 'thinking'
    var orb = document.getElementById('alex-orb');
    if (!orb) return;
    orb.className = state;
  }

  // ── Toggle ──────────────────────────────────────────────────
  window.toggleAlexVoice = async function () {
    if (active) { stopAlex(); return; }
    tryPrimeAudioOnUserGesture();

    // Check access before requesting mic
    var allowed = (window.ALEX_VOICE_ALLOWED !== false);
    var btnEarly = document.getElementById('alex-btn');
    if (!allowed && btnEarly && btnEarly.textContent === 'Close' && window.__alex_overlay_mode) {
      var br0 = document.getElementById('alex-voice-overlay-close-bridge');
      if (br0) br0.click();
      return;
    }
    if (!allowed) {
      var reason = window.ALEX_VOICE_BLOCK_REASON || '';
      if (reason === 'home_blocked') {
        setStatus('Premium feature');
        setTranscript('Voice chat on the home page is available for premium users only.');
      } else if (reason === 'limit_reached') {
        setStatus("Daily limit reached");
        setTranscript("You've used your 10 min free voice chat for today. Come back tomorrow or upgrade for unlimited access.");
      } else {
        setStatus('Voice chat not available.');
      }
      if (upsellEnabled()) showUpgradeButton();
      var b0 = document.getElementById('alex-btn');
      if (b0) { b0.textContent = 'Close'; b0.disabled = false; b0.classList.remove('live'); }
      return;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert('Microphone access is required for voice chat.');
      var bMic = document.getElementById('alex-btn');
      if (bMic) { bMic.textContent = 'Try again'; bMic.disabled = false; bMic.classList.remove('live'); }
      setStatus('Microphone blocked');
      return;
    }

    // Setup audio analysis for VAD
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    var source = audioContext.createMediaStreamSource(micStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    active = true;
    try {
      window.__alex_voice_session_active = true;
      window.__alex_mic_muted = true;
    } catch (eSess) {}
    // GA funnel event: voice session truly started after microphone access succeeds; no transcript is sent.
    try {
      if (window.alexTrack) {
        window.alexTrack('voice_session_started', {
          scope: window.ALEX_VOICE_SCOPE || 'home',
          page_path: window.location.pathname
        });
      }
    } catch (eTrack) {}
    syncMicToggleButton();
    voiceStartedAt = Date.now();
    hideUpgradeButton();
    setTypeUiEnabled(true);
    var btn = document.getElementById('alex-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'END CALL'; btn.classList.add('live'); }

    // Set auto-cutoff timer for non-premium users (only when commercial gates + upsell are on)
    var remainingSec = window.ALEX_VOICE_REMAINING_SEC;
    if (upsellEnabled() && typeof remainingSec === 'number' && remainingSec > 0) {
      var minsLeft = Math.ceil(remainingSec / 60);
      setTranscript('Free usage: ' + minsLeft + ' min remaining today.');
      limitTimer = setTimeout(function () {
        setOrbState('idle');
        setStatus("Daily limit reached");
        setTranscript("You've used your 10 min free voice chat for today. Upgrade for unlimited access.");
        showUpgradeButton();
        stopAlex();
      }, remainingSec * 1000);
    }

    if (!introPlayed) {
      introPlayed = true;
      playIntro();
    } else {
      startListening();
    }
  };

  // ── Auto-introduction ────────────────────────────────────────
  async function playIntro() {
    setOrbState('thinking');
    setStatus('Alex is waking up...');
    setTranscript('');
    try {
      var resp = await fetch(
        apiBase() + '/api/alex-voice-intro?voice_key=' + encodeURIComponent(voiceKey()),
        { headers: authHeadersForGet() }
      );
      if (!resp.ok) {
        if (handleVoiceHttpError(resp.status)) return;
        setStatus('Could not load intro');
        setTranscript('Tap END CALL and try again, or reload the page.');
        if (active) startListening();
        return;
      }
      var data = await resp.json();
      playAlexVoiceResponse(data);
    } catch (e) {
      console.error('[AlexVoice] intro error:', e);
      if (active) startListening();
    }
  }

  // ── Listening with silence detection ────────────────────────
  function startListening() {
    if (!active || !micStream) return;
    if (micMuted()) {
      processing = false;
      setOrbState('idle');
      setStatus('Mic muted — type below; tap Unmute mic to speak again');
      return;
    }
    processing = false;
    audioChunks = [];
    speechDetected = false;
    silenceStart = 0;
    vadSmoothedRms = 0;
    vadSustainStart = 0;
    silenceNudgePending = false;
    clearNoSpeechNudgeTimer();
    setOrbState('idle');
    setStatus('Listening to you, bro...');
    setTranscript('');

    // Choose supported mime
    var mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'audio/webm';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = 'audio/mp4';
    if (!MediaRecorder.isTypeSupported(mimeType)) mimeType = '';

    try {
      mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType: mimeType } : {});
    } catch (e) {
      console.error('[AlexVoice] MediaRecorder error (will retry):', e);
      setStatus('Mic recovering...');
      // AudioContext may still be resuming after tab was backgrounded — retry.
      setTimeout(function () { if (active) startListening(); }, 800);
      return;
    }

    mediaRecorder.ondataavailable = function (e) {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = function () {
      stopVAD();
      if (!active) return;
      if (silenceNudgePending) {
        silenceNudgePending = false;
        fetchSilenceNudgeAndPlay();
        return;
      }
      if (audioChunks.length === 0) { startListening(); return; }

      var blob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      console.log('[AlexVoice] recorded', blob.size, 'B, vadSpeech=' + speechDetected);
      if (blob.size < MIN_BLOB_FOR_STT) { startListening(); return; }

      if (!speechDetected) {
        console.log('[AlexVoice] VAD did not flag speech — running STT anyway (short/quiet clips)');
      }

      processing = true;
      setOrbState('thinking');
      setStatus('Processing...');
      setTranscript('');
      transcribeAndRespond(blob);
    };

    mediaRecorder.start(200);

    // Start VAD — monitors audio level and auto-stops on silence
    startVAD();

    // Absolute max recording safety net
    maxRecordTimeout = setTimeout(function () {
      finishRecording();
    }, MAX_RECORD_MS);

    scheduleNoSpeechNudge();

    console.log('[AlexVoice] recording...');
  }

  // ── Voice Activity Detection ────────────────────────────────
  function startVAD() {
    if (!analyser) return;
    var dataArray = new Uint8Array(analyser.fftSize);

    vadInterval = setInterval(function () {
      analyser.getByteTimeDomainData(dataArray);

      var sum = 0;
      for (var i = 0; i < dataArray.length; i++) {
        var v = dataArray[i] - 128;
        sum += v * v;
      }
      var rawRms = Math.sqrt(sum / dataArray.length);
      vadSmoothedRms = vadSmoothedRms * (1 - VAD_EMA_ALPHA) + rawRms * VAD_EMA_ALPHA;

      var now = Date.now();

      if (!speechDetected) {
        // Ignore brief spikes: only arm after sustained energy
        if (vadSmoothedRms >= VAD_SPEECH_START_RMS) {
          if (!vadSustainStart) vadSustainStart = now;
          if (now - vadSustainStart >= VAD_SPEECH_SUSTAIN_MS) {
            speechDetected = true;
            vadSustainStart = 0;
            clearTimeout(noSpeechNudgeTimer);
            noSpeechNudgeTimer = null;
            setOrbState('user-speaking');
            setStatus('Hearing you...');
            silenceStart = 0;
            console.log('[AlexVoice] speech started (sustained)');
          }
        } else {
          vadSustainStart = 0;
        }
      } else {
        // Hysteresis: end only when level drops below lower threshold
        if (vadSmoothedRms >= VAD_SPEECH_END_RMS) {
          silenceStart = 0;
        } else {
          if (!silenceStart) silenceStart = now;
          else if (now - silenceStart > SILENCE_DURATION) {
            console.log('[AlexVoice] silence detected, auto-stopping');
            finishRecording();
          }
        }
      }
    }, 100);
  }

  function stopVAD() {
    if (vadInterval) { clearInterval(vadInterval); vadInterval = null; }
    if (maxRecordTimeout) { clearTimeout(maxRecordTimeout); maxRecordTimeout = null; }
  }

  function clearNoSpeechNudgeTimer() {
    if (noSpeechNudgeTimer) {
      clearTimeout(noSpeechNudgeTimer);
      noSpeechNudgeTimer = null;
    }
  }

  function scheduleNoSpeechNudge() {
    clearNoSpeechNudgeTimer();
    noSpeechNudgeTimer = setTimeout(function () {
      noSpeechNudgeTimer = null;
      if (!active || speechDetected || processing) return;
      if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
      silenceNudgePending = true;
      finishRecording();
    }, NO_SPEECH_NUDGE_MS);
  }

  function finishRecording() {
    stopVAD();
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
  }

  /** Drop the current mic segment without running STT (used when user types instead). */
  function abortCurrentListenSegment() {
    stopVAD();
    clearNoSpeechNudgeTimer();
    silenceNudgePending = false;
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.onstop = null;
      mediaRecorder.stop();
    }
    audioChunks = [];
  }

  async function fetchVoiceReplyAndPlay(transcript) {
    setOrbState('thinking');
    setStatus('Alex is thinking...');
    var uLine = '';
    try {
      uLine = window.__voiceLastUserLine || '';
    } catch (eU) {}
    var payload = JSON.stringify({ transcript: transcript, voice_key: voiceKey() });
    var headers = authHeadersJson();
    try {
      tryPrimeAudioOnUserGesture();
      var streamResp = await fetch(apiBase() + '/api/alex-voice-stream', {
        method: 'POST',
        headers: headers,
        body: payload
      });
      if (streamResp.ok) {
        var ct = (streamResp.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('text/event-stream') >= 0 && streamResp.body && streamResp.body.getReader) {
          await consumeAlexVoiceStream(streamResp, uLine);
          return;
        }
        var jsonResp = await fetch(apiBase() + '/api/alex-voice', {
          method: 'POST',
          headers: headers,
          body: payload
        });
        if (!jsonResp.ok) {
          if (handleVoiceHttpError(jsonResp.status)) return;
          var vErr2 = 'Voice reply failed.';
          try {
            var vBody2 = await jsonResp.json();
            if (vBody2.error) vErr2 = String(vBody2.error);
          } catch (eJ2) {}
          setStatus('Alex could not reply');
          try {
            window.__voiceLastUserLine = '';
          } catch (eClrJ) {}
          setTranscript(vErr2);
          setOrbState('idle');
          processing = false;
          setTimeout(function () { if (active) startListening(); }, 2200);
          return;
        }
        var dataFb = await jsonResp.json();
        processing = false;
        playAlexVoiceResponse(dataFb);
        return;
      }
      if (!streamResp.ok) {
        if (handleVoiceHttpError(streamResp.status)) return;
        var vErr = 'Voice reply failed.';
        try {
          var vBody = await streamResp.json();
          if (vBody.error) vErr = String(vBody.error);
        } catch (e2) {}
        setStatus('Alex could not reply');
        try {
          window.__voiceLastUserLine = '';
        } catch (eClr) {}
        setTranscript(vErr);
        setOrbState('idle');
        processing = false;
        setTimeout(function () { if (active) startListening(); }, 2200);
        return;
      }
    } catch (err) {
      console.error('[AlexVoice] API error:', err);
      try {
        window.__voiceLastUserLine = '';
      } catch (eClr2) {}
      setStatus('Network error — retrying...');
      setOrbState('idle');
      processing = false;
      setTimeout(function () { if (active) startListening(); }, 1500);
    }
  }

  async function sendTypedAlexMessage() {
    tryPrimeAudioOnUserGesture();
    var input = document.getElementById('alex-type-input');
    if (!input || !active) {
      if (!active) setStatus('Start the call first — then type or speak.');
      return;
    }
    var text = (input.value || '').trim();
    if (!text) return;
    if (processing) {
      setStatus('Hang on… still processing.');
      return;
    }
    input.value = '';

    disposeCurrentPlayback();

    abortCurrentListenSegment();

    processing = true;
    setOrbState('thinking');
    setStatus('Alex is thinking...');
    window.__voiceLastUserLine = 'You: ' + text;
    appendChatBubble('user', null, text);
    setTranscript('');

    await fetchVoiceReplyAndPlay(text);
  }

  function playAlexVoiceResponse(data) {
    var uLine = window.__voiceLastUserLine || '';
    window.__voiceLastUserLine = '';
    applyAlexLanguagePrefsFromVoice(data);
    console.log('[AlexVoice] response:', (data.text || '').substring(0, 80), '| audio:', (data.audio_b64 || '').length);
    disposeCurrentPlayback();
    setOrbState('ai-speaking');
    setStatus('Alex is speaking...');
    if (data.display_html || data.text) {
      renderVoiceTranscriptBlock(uLine, data);
    } else if (uLine) {
      setTranscript(uLine);
    }

    function done(opts) {
      opts = opts || {};
      if (!opts.keepReadingPane) setTranscript('');
      setOrbState('idle');
      if (active) scheduleListenAfterSpeech();
    }

    var tailState = { rest: (data.audio_b64_tail || '').trim() };

    function scheduleNextOrDone() {
      if (tailState.rest) {
        var next = tailState.rest;
        tailState.rest = '';
        playWavSegment(next);
        return;
      }
      done({});
    }

    function skipAllVoiceAudio() {
      tailState.rest = '';
      done({ keepReadingPane: true });
    }

    function playWavSegment(b64) {
      if (!b64) {
        scheduleNextOrDone();
        return;
      }
      var objectUrl = wavBase64ToObjectUrl(b64);
      if (!objectUrl) {
        console.warn('[AlexVoice] invalid audio base64 (segment)');
        setStatus('Reply on screen only');
        appendVoiceServerNotice('Voice audio could not be decoded. You can still read the reply above.');
        tailState.rest = '';
        done({ keepReadingPane: true });
        return;
      }

      currentAudioObjectUrl = objectUrl;
      currentAudio = new Audio(objectUrl);
      currentAudio.onended = function () {
        disposeCurrentPlayback();
        scheduleNextOrDone();
      };
      currentAudio.onerror = function () {
        console.warn('[AlexVoice] <audio> element error');
        disposeCurrentPlayback();
        setStatus('Reply on screen only');
        appendVoiceServerNotice('This browser could not play the voice clip. You can still read the reply above.');
        tailState.rest = '';
        done({ keepReadingPane: true });
      };
      currentAudio.play().catch(function (err) {
        console.warn('[AlexVoice] audio.play() failed', err);
        try {
          currentAudio.pause();
        } catch (ePause) {}
        setOrbState('idle');
        setStatus('Tap Play below to hear Alex');
        appendTapToPlayFallback(scheduleNextOrDone, skipAllVoiceAudio);
      });
    }

    if (!data.audio_b64) {
      if (tailState.rest) {
        playWavSegment(tailState.rest);
        tailState.rest = '';
        return;
      }
      console.warn('[AlexVoice] empty server audio — configure Fish or OpenAI TTS (no browser voice)');
      setStatus('Reply on screen only');
      appendVoiceServerNotice(
        'No voice clip from the server. Set OPENAI_API_KEY (for TTS) or FISH_AUDIO_API_KEY, redeploy, and try again.'
      );
      done({ keepReadingPane: true });
      return;
    }

    playWavSegment(data.audio_b64);
  }

  async function fetchSilenceNudgeAndPlay() {
    if (!active) return;
    processing = true;
    setOrbState('thinking');
    setStatus('Alex is checking in...');
    setTranscript('');
    var headers = authHeadersJson();
    var payload = JSON.stringify({ silence_nudge: true, voice_key: voiceKey() });
    try {
      tryPrimeAudioOnUserGesture();
      var streamResp = await fetch(apiBase() + '/api/alex-voice-stream', {
        method: 'POST',
        headers: headers,
        body: payload
      });
      if (streamResp.ok) {
        var ct = (streamResp.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('text/event-stream') >= 0 && streamResp.body && streamResp.body.getReader) {
          await consumeAlexVoiceStream(streamResp, '');
          return;
        }
        var jsonResp = await fetch(apiBase() + '/api/alex-voice', {
          method: 'POST',
          headers: headers,
          body: payload
        });
        if (!jsonResp.ok) {
          if (handleVoiceHttpError(jsonResp.status)) return;
          processing = false;
          setOrbState('idle');
          if (active) scheduleListenAfterSpeech();
          return;
        }
        var data = await jsonResp.json();
        processing = false;
        playAlexVoiceResponse(data);
        return;
      }
      if (!streamResp.ok) {
        if (handleVoiceHttpError(streamResp.status)) return;
        processing = false;
        setOrbState('idle');
        if (active) scheduleListenAfterSpeech();
        return;
      }
    } catch (e) {
      console.error('[AlexVoice] silence nudge error:', e);
      processing = false;
      setOrbState('idle');
      setTimeout(function () { if (active) scheduleListenAfterSpeech(); }, 1200);
    }
  }

  // ── Transcribe → LLM → TTS → Play ──────────────────────────
  async function transcribeAndRespond(audioBlob) {
    clearNoSpeechNudgeTimer();
    // Step 1: STT
    setStatus('Transcribing...');
    var transcript = '';
    try {
      var sttResp = await fetch(apiBase() + '/api/alex-voice-stt', {
        method: 'POST',
        headers: authHeadersForStt(audioBlob.type),
        body: audioBlob
      });
      if (!sttResp.ok) {
        if (handleVoiceHttpError(sttResp.status)) return;
        var sttErr = 'Transcription failed. Try again.';
        try {
          var sttErrBody = await sttResp.json();
          if (sttErrBody.error) sttErr = String(sttErrBody.error);
        } catch (e1) {}
        setOrbState('idle');
        setStatus('Could not transcribe');
        setTranscript(sttErr);
        processing = false;
        setTimeout(function () { if (active) startListening(); }, 2200);
        return;
      }
      var sttData = await sttResp.json();
      transcript = (sttData.text || '').trim();
      console.log('[AlexVoice] transcript:', transcript);
      if (transcript) {
        window.__voiceLastUserLine = 'You: ' + transcript;
        appendChatBubble('user', null, transcript);
      }
      setTranscript('');
    } catch (e) {
      console.error('[AlexVoice] STT error:', e);
      setOrbState('idle');
      setStatus('Transcription error');
      processing = false;
      setTimeout(function () { if (active) startListening(); }, 1500);
      return;
    }

    if (!transcript.length) {
      setOrbState('idle');
      processing = false;
      startListening();
      return;
    }

    await fetchVoiceReplyAndPlay(transcript);
  }

  // ── Stop ────────────────────────────────────────────────────
  function stopAlex(skipSync) {
    // Fire-and-forget: sync voice session back to text chat DB
    var durationSec = voiceStartedAt ? Math.round((Date.now() - voiceStartedAt) / 1000) : 0;
    try {
      window.__alex_voice_session_active = false;
    } catch (eS0) {}
    if (!skipSync) {
      fetch(apiBase() + '/api/alex-voice-sync', {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({ voice_key: voiceKey(), duration_seconds: durationSec })
      })
        .then(function (r) {
          return r.json().then(function (d) {
            if (!r.ok) {
              console.warn('[AlexVoice] sync HTTP', r.status, d);
            } else {
              console.log('[AlexVoice] synced voice session to text chat:', d);
            }
          });
        })
        .catch(function (e) { console.warn('[AlexVoice] sync failed:', e); });
    }
    voiceStartedAt = 0;
    try {
      window.__voiceLastUserLine = '';
    } catch (eVu) {}

    active = false;
    processing = false;
    if (limitTimer) { clearTimeout(limitTimer); limitTimer = null; }
    clearNoSpeechNudgeTimer();
    silenceNudgePending = false;
    stopVAD();
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.onstop = null;
      mediaRecorder.stop();
    }
    mediaRecorder = null;
    if (micStream) { micStream.getTracks().forEach(function (t) { t.stop(); }); micStream = null; }
    if (audioContext) { audioContext.close().catch(function(){}); audioContext = null; analyser = null; }
    disposeCurrentPlayback();
    try {
      window.__alex_mic_muted = false;
    } catch (eM2) {}
    syncMicToggleButton();
    var mtEnd = document.getElementById('alex-mic-toggle');
    if (mtEnd) mtEnd.disabled = true;
    setOrbState('idle');
    setStatus('Tap to start voice chat');
    setTranscript('');
    setTypeUiEnabled(false);
    var tin = document.getElementById('alex-type-input');
    if (tin) tin.value = '';
    var btn = document.getElementById('alex-btn');
    if (btn) { btn.textContent = 'GO LIVE WITH ALEX'; btn.classList.remove('live'); btn.disabled = false; }
    if (window.__alex_overlay_mode) {
      var bridge = document.getElementById('alex-voice-overlay-close-bridge');
      if (bridge) bridge.click();
    }
  }

  window.stopAlexVoiceSession = function () { stopAlex(false); };
})();
