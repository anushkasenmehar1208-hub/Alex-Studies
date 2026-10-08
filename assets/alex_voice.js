/**
 * Alex Live Voice — configurable server STT/LLM; browser TTS in free demo mode.
 * STT: Groq in demo mode, OpenAI otherwise (MediaRecorder → /api/alex-voice-stt).
 * LLM: Server-selected Groq or OpenRouter (/api/alex-voice-stream).
 * TTS: Browser speech in demo mode; Fish/OpenAI WAV playback otherwise.
 */
(function () {
  // Reflex can reload this script when the voice panel is reopened.
  if (window.__alexVoiceCleanup) window.__alexVoiceCleanup();
  var sessionId = Math.random().toString(36).slice(2); // fallback only
  var sessionVoiceKey = '';
  var voiceStartedAt = 0;
  var limitTimer = null;
  var active = false;
  var starting = false;
  var voiceDiagnostics = { stage: 'idle' };
  function traceVoice(stage, details) {
    voiceDiagnostics = Object.assign({}, voiceDiagnostics, details || {}, { stage: stage });
    if (window.ALEX_VOICE_DIAGNOSTICS !== false) console.log('[AlexVoice] ' + stage, details || {});
  }
  // Safe temporary troubleshooting: sizes/states only, never tokens, audio or speech text.
  window.getAlexVoiceDiagnostics = function () {
    return Object.assign({}, voiceDiagnostics, {
      active: active, processing: processing, speechDetected: speechDetected,
      contextState: audioContext ? audioContext.state : 'closed',
      recorderState: mediaRecorder ? mediaRecorder.state : 'inactive',
      tracks: micStream ? micStream.getTracks().map(function (track) {
        return { enabled: track.enabled, readyState: track.readyState };
      }) : []
    });
  };
  var callGeneration = 0;
  var callAbort = null;
  var callButton = null;
  var listenTimer = null;
  var audioResumeTimer = null;
  var voiceBindings = [];
  var panelObserver = null;
  var processing = false;
  var mediaRecorder = null;
  var micStream = null;
  var audioChunks = [];
  var currentAudio = null;
  var browserUtterance = null;
  var browserSpeechTimer = null;
  var bargeInInterval = null;
  var BARGE_IN_RMS = 12;
  var BARGE_IN_SUSTAIN_MS = 200;
  var BARGE_IN_GUARD_MS = 250;
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

  function clearListenTimer() {
    if (listenTimer) clearTimeout(listenTimer);
    listenTimer = null;
  }

  function isCurrentCall(generation) {
    return active && generation === callGeneration;
  }

  function setMicTracksEnabled(enabled) {
    if (micStream) micStream.getAudioTracks().forEach(function (track) { track.enabled = enabled; });
  }

  function pauseMicrophone() {
    clearListenTimer();
    stopBargeInMonitor();
    abortCurrentListenSegment();
    setMicTracksEnabled(false);
  }

  function scheduleListenAfterSpeech(delay) {
    clearListenTimer();
    if (!active) return;
    if (micMuted()) {
      if (!processing) setStatus('Muted');
      return;
    }
    var generation = callGeneration;
    listenTimer = setTimeout(function () {
      listenTimer = null;
      if (isCurrentCall(generation)) startListening();
    }, typeof delay === 'number' ? delay : POST_SPEECH_MIC_DELAY_MS);
  }

  /**
   * SSE voice segments: sequential HTML5 Audio only.
   * Web Audio decode/play was unreliable on Safari (silent output); this matches JSON fallback playback.
   */
  var alexAudioChain = Promise.resolve();
  /** Active stream clip — stopped when clearing playback. */
  var alexStreamActiveAudio = null;
  var alexStreamObjectUrl = null;
  var playbackGeneration = 0;
  /** Segments enqueued but not yet finished playing. */
  var alexPendingSegments = 0;
  /** True once the SSE 'done' event has been received for the current stream. */
  var alexSseDone = false;

  function stopAlexPlaybackEngine() {
    stopBargeInMonitor();
    playbackGeneration++;
    if (browserSpeechTimer) clearTimeout(browserSpeechTimer);
    browserSpeechTimer = null;
    if (browserUtterance) {
      browserUtterance.onstart = null;
      browserUtterance.onend = null;
      browserUtterance.onerror = null;
      browserUtterance = null;
    }
    try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (eCancel) {}
    try {
      if (alexStreamActiveAudio) {
        alexStreamActiveAudio.onended = null;
        alexStreamActiveAudio.onerror = null;
        alexStreamActiveAudio.pause();
        alexStreamActiveAudio = null;
      }
    } catch (eSt) {}
    if (alexStreamObjectUrl) {
      try { URL.revokeObjectURL(alexStreamObjectUrl); } catch (eUrl) {}
      alexStreamObjectUrl = null;
    }
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
    var generation = playbackGeneration;
    alexAudioChain = alexAudioChain.then(function () {
      if (!active || generation !== playbackGeneration) return;
      pauseMicrophone();
      processing = true;
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
        alexStreamObjectUrl = url;
        a.onended = function () {
          try {
            URL.revokeObjectURL(url);
          } catch (eR) {}
          if (alexStreamActiveAudio === a) alexStreamActiveAudio = null;
          if (alexStreamObjectUrl === url) alexStreamObjectUrl = null;
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
          if (alexStreamObjectUrl === url) alexStreamObjectUrl = null;
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
            if (alexStreamObjectUrl === url) alexStreamObjectUrl = null;
            alexPendingSegments--;
            resolve();
          });
        }
      });
    });
    return alexAudioChain;
  }

  // Browser speech is selected explicitly by the server; never call paid TTS from here.
  function speakBrowserReply(data, onDone) {
    if (!active) return;
    var generation = callGeneration;
    var playback = playbackGeneration;
    pauseMicrophone();
    processing = true;
    var finished = false;
    function finish(error) {
      if (finished) return;
      finished = true;
      if (!isCurrentCall(generation) || playback !== playbackGeneration) return;
      stopBargeInMonitor();
      setMicTracksEnabled(false);
      if (browserSpeechTimer) clearTimeout(browserSpeechTimer);
      browserSpeechTimer = null;
      if (browserUtterance) {
        browserUtterance.onstart = null;
        browserUtterance.onend = null;
        browserUtterance.onerror = null;
      }
      browserUtterance = null;
      if (error) {
        try { window.speechSynthesis.cancel(); } catch (eCancel) {}
        setStatus('Reply on screen only');
        appendVoiceServerNotice('Browser speech is unavailable. Read the reply above or continue by typing.');
      }
      onDone();
    }
    var text = (data.speech_text || data.text || '').trim();
    if (!text || !window.speechSynthesis || !window.SpeechSynthesisUtterance) {
      finish(true);
      return;
    }
    try {
      var utterance = new window.SpeechSynthesisUtterance(text);
      var languages = { English: 'en-US', Sinhala: 'si-LK', Tamil: 'ta-IN', Hindi: 'hi-IN' };
      utterance.lang = languages[data.voice_language] || document.documentElement.lang || 'en-US';
      var voices = window.speechSynthesis.getVoices();
      var language = utterance.lang.split('-')[0];
      var voice = voices.find(function (v) { return v.lang.split('-')[0] === language && v.localService; })
        || voices.find(function (v) { return v.lang.split('-')[0] === language; });
      if (voice) utterance.voice = voice;
      utterance.onend = function () { finish(false); };
      utterance.onerror = function () { finish(true); };
      browserUtterance = utterance;
      processing = true;
      setOrbState('ai-speaking');
      setStatus('Alex is speaking...');
      // Recover from browsers that never fire an end/error event.
      browserSpeechTimer = setTimeout(function () {
        finish(true);
      }, 60000);
      utterance.onstart = function () {
        if (isCurrentCall(generation) && playback === playbackGeneration && browserUtterance === utterance) startBargeInMonitor();
      };
      window.speechSynthesis.speak(utterance);
      startBargeInMonitor();
    } catch (eSpeech) {
      finish(true);
    }
  }

  /**
   * SSE: first audio may arrive while the model is still generating; tail + done follow.
   */
  async function consumeAlexVoiceStream(response, uLine) {
    var generation = callGeneration;
    pauseMicrophone();
    processing = true;
    stopAlexPlaybackEngine();
    var carry = '';
    var decoder = new TextDecoder();
    var heardAudio = false;
    var streamUiDone = false;

    function streamPlaybackFinished() {
      if (!isCurrentCall(generation)) return;
      processing = false;
      setOrbState('idle');
      if (active) scheduleListenAfterSpeech();
    }

    function dispatch(obj) {
      if (!isCurrentCall(generation)) return;
      if (!obj || !obj.type) return;
      if (obj.type === 'audio') {
        var ab = (obj.audio_b64 || '').trim();
        if (!ab) return;
        heardAudio = true;
        processing = true;
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
        if (!heardAudio && obj.tts_mode === 'browser') {
          speakBrowserReply(obj, streamPlaybackFinished);
        } else if (!heardAudio) {
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
        streamUiDone = true;
        appendVoiceServerNotice(voiceErrorMessage(0, obj.error_code, false));
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
        if (!isCurrentCall(generation)) { await reader.cancel(); return; }
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
      if (!streamUiDone) throw new Error('Voice stream ended before the reply completed');
    } catch (eRead) {
      if (!isCurrentCall(generation)) return;
      appendVoiceServerNotice(voiceErrorMessage(0, 'network', false));
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
  var VAD_SPEECH_START_RMS = 4;
  // Lower threshold after speech began — keeps natural pauses inside a sentence
  var VAD_SPEECH_END_RMS = 2;
  // Require this many ms of continuous “loud” before we treat it as real speech
  var VAD_SPEECH_SUSTAIN_MS = 140;
  // Reject tiny clips after real speech has armed VAD.
  var MIN_BLOB_FOR_STT = 80;
  var END_OF_SPEECH_SILENCE_MS = 425;
  var VAD_POLL_MS = 25;
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
    return sessionVoiceKey || window.ALEX_VOICE_KEY || sessionId;
  }

  function authToken() {
    try {
      var k = window.ALEX_AUTH_STORAGE_KEY || '';
      var raw = k ? (localStorage.getItem(k) || '').trim() : '';
      if (!raw) return '';
      // Reflex stores LocalStorage strings as JSON; Next.js stores plain strings.
      try {
        var decoded = JSON.parse(raw);
        return typeof decoded === 'string' ? decoded.trim() : '';
      } catch (eParse) {
        return raw;
      }
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
    if (t) h['X-Auth-Token'] = t;
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
      pauseMicrophone();
      if (!processing) {
        setOrbState('idle');
        setStatus('Muted');
      }
    } else if (!muted && active && browserUtterance) {
      startBargeInMonitor();
    } else if (!muted && active && !processing) {
      startListening();
    }
  }

  function bindVoiceHandler(element, type, handler) {
    element.addEventListener(type, handler);
    voiceBindings.push({ element: element, type: type, handler: handler });
  }

  function attachMicToggle() {
    var b = document.getElementById('alex-mic-toggle');
    if (b && !b._alexMicBound) {
      b._alexMicBound = true;
      bindVoiceHandler(b, 'click', function () {
        if (b.disabled) return;
        tryPrimeAudioOnUserGesture();
        setMicMuted(!micMuted());
      });
    }
  }

  function installPageHideEndVoiceOnce() {
    // Only end on actual navigation/close — NOT on tab-switch (visibilitychange).
    window.addEventListener('pagehide', endVoiceOnNavigation);
    window.addEventListener('beforeunload', endVoiceOnNavigation);
    // Tab switch policy:
    //   - Tab hidden  → pause Alex's voice playback so the user doesn't hear
    //     the AI talking in the background while they're working in another
    //     tab. We pause (don't dispose) so the clip can resume seamlessly.
    //   - Tab visible → resume any paused playback and resume a suspended
    //     AudioContext so MediaRecorder/STT keeps working.
    document.addEventListener('visibilitychange', handleVoiceVisibility);
  }

  function endVoiceOnNavigation() {
    if (active || starting) stopAlex(false, true);
  }

  function handleVoiceVisibility() {
      if (!active) return;
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
        if (browserUtterance || alexStreamActiveAudio || (currentAudio && !currentAudio.paused)) {
          setOrbState('ai-speaking');
          setStatus('Alex is speaking...');
        } else if (!processing) {
          setStatus(micMuted() ? 'Muted' : 'Listening…');
        }
      } catch (eRs) {}
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
      bindVoiceHandler(btn, 'click', function () { window.toggleAlexVoice(); });
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
      bindVoiceHandler(inp, 'focus', function () {
        if (active) {
          pauseMicrophone();
          if (!processing && !micMuted()) setStatus('Type your message…');
        }
      });
      bindVoiceHandler(inp, 'blur', function () {
        if (active && !processing) scheduleListenAfterSpeech();
      });
      bindVoiceHandler(inp, 'keydown', function (ev) {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          sendTypedAlexMessage();
        }
      });
    }
    if (snd && !snd._alexBound) {
      snd._alexBound = true;
      bindVoiceHandler(snd, 'click', function () { sendTypedAlexMessage(); });
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
      _bindPoll = null;
    }
  }, 300);

  // React can remove the panel without a full page navigation.
  if (window.MutationObserver) {
    panelObserver = new window.MutationObserver(function () {
      if ((active || starting) && callButton && !callButton.isConnected) stopAlex(false, true);
    });
    panelObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

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

  var MAX_VOICE_MESSAGES = 40;

  function voiceErrorMessage(status, code, isStt) {
    if (status === 429 || code === 'rate_limit') return 'Alex is getting a lot of requests right now. Try again in a moment.';
    if (status === 408 || status === 504 || code === 'timeout' || code === 'network') return 'Alex took too long to respond. Please try again.';
    if (code === 'unavailable' || status === 503) return 'Alex is temporarily unavailable. Please try again.';
    if (isStt || code === 'stt') return 'I couldn’t clearly hear that. Please try again.';
    return 'Alex is temporarily unavailable. Please try again.';
  }

  function appendChatBubble(role, html, plain) {
    plain = typeof plain === 'string' ? plain.trim() : '';
    if (!plain && !(role === 'alex' && html)) return;
    // Mirror both responsive panels so resizing never loses half the conversation.
    ['alex-chat-panel', 'alex-mobile-chat-panel'].forEach(function (id) {
      var panel = document.getElementById(id);
      if (!panel) return;
      var bubble = document.createElement('div');
      bubble.className = 'alex-chat-bubble alex-chat-' + role;
      bubble.setAttribute('aria-label', role === 'user' ? 'You' : 'Alex');
      if (role === 'alex' && html) bubble.innerHTML = html;
      else bubble.textContent = plain;
      panel.appendChild(bubble);
      while (panel.children.length > MAX_VOICE_MESSAGES) panel.removeChild(panel.firstElementChild);
      panel.scrollTop = panel.scrollHeight;
    });
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
    if (active || starting) { stopAlex(); return; }
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

    starting = true;
    var generation = ++callGeneration;
    callAbort = new AbortController();
    callButton = document.getElementById('alex-btn');
    sessionVoiceKey = window.ALEX_VOICE_KEY || sessionId;
    window.__alex_voice_session_active = true;
    window.__alex_mic_muted = false;
    syncMicToggleButton();
    setStatus('Starting microphone…');
    if (callButton) { callButton.textContent = 'END CALL'; callButton.disabled = false; }

    try {
      if (!navigator.mediaDevices || !window.MediaRecorder) throw new Error('Microphone recording is unavailable in this browser.');
      // Invoke these before the first await, while Start Call's user gesture is available.
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      var resumed = audioContext.resume().catch(function () {});
      try { if (window.speechSynthesis) window.speechSynthesis.resume(); } catch (eResume) {}
      traceVoice('microphone-requested');
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
      // getUserMedia cannot be aborted: release a permission result that arrived after End Call.
      if (!starting || generation !== callGeneration) {
        stream.getTracks().forEach(function (track) { track.stop(); });
        return;
      }
      micStream = stream;
      traceVoice('microphone-ready', { trackCount: stream.getAudioTracks().length });
      await Promise.race([resumed, new Promise(function (resolve) {
        audioResumeTimer = setTimeout(resolve, 1500);
      })]);
      if (!starting || generation !== callGeneration) return;
      if (audioResumeTimer) clearTimeout(audioResumeTimer);
      audioResumeTimer = null;
      if (audioContext.state === 'suspended') throw new Error('Tap Start Call to enable microphone audio in this browser.');
      var source = audioContext.createMediaStreamSource(micStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      // Keep the input graph processing in Safari without routing mic sound to speakers.
      var silentMonitor = audioContext.createGain();
      silentMonitor.gain.value = 0;
      analyser.connect(silentMonitor);
      silentMonitor.connect(audioContext.destination);
    } catch (e) {
      if (!starting || generation !== callGeneration) return;
      stopAlex(true, true);
      var bMic = document.getElementById('alex-btn');
      if (bMic) { bMic.textContent = 'Start Call'; bMic.disabled = false; }
      setStatus(e.name === 'NotAllowedError' ? 'Microphone permission required' : 'Tap Start Call to try again');
      appendVoiceServerNotice(e.name === 'NotAllowedError'
        ? 'Allow microphone access for this site in Safari, then tap Start Call.'
        : (e.message || 'Could not start the microphone. Tap Start Call to try again.'));
      return;
    }

    starting = false;
    active = true;
    try {
      window.__alex_voice_session_active = true;
      window.__alex_mic_muted = false;
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

    startListening();
    if (!introPlayed) {
      introPlayed = true;
      playIntro();
    }
  };

  // ── Auto-introduction ────────────────────────────────────────
  async function playIntro() {
    var generation = callGeneration;
    var introRecorder = mediaRecorder;
    try {
      var resp = await fetch(
        apiBase() + '/api/alex-voice-intro?voice_key=' + encodeURIComponent(voiceKey()),
        { headers: authHeadersForGet(), signal: callAbort.signal }
      );
      if (!isCurrentCall(generation)) return;
      if (!resp.ok) {
        if (handleVoiceHttpError(resp.status)) return;
        setStatus('Could not load intro');
        setTranscript('Tap END CALL and try again, or reload the page.');
        return;
      }
      var data = await resp.json();
      // Never interrupt a question the student already started while the greeting loaded.
      if (!isCurrentCall(generation) || processing || speechDetected || mediaRecorder !== introRecorder) return;
      playAlexVoiceResponse(data);
    } catch (e) {
      if (!isCurrentCall(generation)) return;
      console.error('[AlexVoice] intro error:', e);
    }
  }

  // ── Listening with silence detection ────────────────────────
  function startListening() {
    if (!active || !micStream || processing) return;
    if (mediaRecorder && mediaRecorder.state !== 'inactive') return;
    clearListenTimer();
    if (micMuted()) {
      setMicTracksEnabled(false);
      setOrbState('idle');
      setStatus('Muted');
      return;
    }
    setMicTracksEnabled(true);
    var generation = callGeneration;
    var chunks = [];
    audioChunks = chunks;
    speechDetected = false;
    silenceStart = 0;
    vadSmoothedRms = 0;
    vadSustainStart = 0;
    silenceNudgePending = false;
    clearNoSpeechNudgeTimer();
    setOrbState('idle');
    setStatus('Listening…');
    setTranscript('');

    // Choose supported mime
    var mimeType = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4',
      'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg']
      .filter(function (type) { return MediaRecorder.isTypeSupported(type); })[0] || '';

    try {
      mediaRecorder = new MediaRecorder(micStream, mimeType ? { mimeType: mimeType } : {});
    } catch (e) {
      console.error('[AlexVoice] MediaRecorder error (will retry):', e);
      setStatus('Mic recovering...');
      setMicTracksEnabled(false);
      // AudioContext may still be resuming after tab was backgrounded — retry.
      scheduleListenAfterSpeech(800);
      return;
    }

    var recorder = mediaRecorder;
    recorder.ondataavailable = function (e) {
      if (isCurrentCall(generation) && mediaRecorder === recorder && e.data && e.data.size > 0) {
        chunks.push(e.data);
        traceVoice('recorder-data', { chunkBytes: e.data.size, mimeType: e.data.type || recorder.mimeType });
      }
    };

    recorder.onstop = function () {
      if (!isCurrentCall(generation) || mediaRecorder !== recorder || micMuted()) return;
      traceVoice('recorder-stopped', { speechDetected: speechDetected, chunkCount: chunks.length });
      stopVAD();
      mediaRecorder = null;
      audioChunks = [];
      if (silenceNudgePending) {
        silenceNudgePending = false;
        fetchSilenceNudgeAndPlay();
        return;
      }
      if (!speechDetected || chunks.length === 0) {
        processing = false;
        traceVoice('recording-rejected', { reason: speechDetected ? 'empty_audio' : 'no_speech' });
        if (speechDetected) {
          setStatus(voiceErrorMessage(0, 'stt', true));
          appendVoiceServerNotice(voiceErrorMessage(0, 'stt', true));
        }
        scheduleListenAfterSpeech(speechDetected ? 1500 : 500);
        return;
      }

      var blob = new Blob(chunks, { type: recorder.mimeType || chunks[0].type || mimeType });
      traceVoice('audio-blob', { blobBytes: blob.size, mimeType: blob.type });
      if (blob.size < MIN_BLOB_FOR_STT) {
        processing = false;
        traceVoice('recording-rejected', { reason: 'tiny_audio' });
        setStatus(voiceErrorMessage(0, 'stt', true));
        scheduleListenAfterSpeech(1500);
        return;
      }

      processing = true;
      setOrbState('thinking');
      setStatus('Thinking…');
      setTranscript('');
      transcribeAndRespond(blob);
    };

    try {
      recorder.start(200);
    } catch (eStart) {
      pauseMicrophone();
      setStatus('Mic recovering...');
      scheduleListenAfterSpeech(800);
      return;
    }

    // Start VAD — monitors audio level and auto-stops on silence
    startVAD();

    // Absolute max recording safety net
    maxRecordTimeout = setTimeout(function () {
      finishRecording();
    }, MAX_RECORD_MS);

    scheduleNoSpeechNudge();

    traceVoice('recorder-started', { mimeType: recorder.mimeType, speechDetected: false });
  }

  // During browser TTS, measure residual mic energy without creating a recorder.
  // Echo cancellation is browser/device dependent: calibrate residual speaker energy
  // at phrase onset, then require substantially louder sustained input.
  function stopBargeInMonitor() {
    if (bargeInInterval) clearInterval(bargeInInterval);
    bargeInInterval = null;
  }

  function startBargeInMonitor() {
    stopBargeInMonitor();
    if (!active || micMuted() || !browserUtterance || !analyser) return;
    setMicTracksEnabled(true);
    var generation = callGeneration, playback = playbackGeneration;
    var began = Date.now(), sustained = 0, echoFloor = 0;
    var useFloat = typeof analyser.getFloatTimeDomainData === 'function';
    var samples = useFloat ? new Float32Array(analyser.fftSize) : new Uint8Array(analyser.fftSize);
    bargeInInterval = setInterval(function () {
      if (!isCurrentCall(generation) || playback !== playbackGeneration || micMuted()) {
        stopBargeInMonitor(); return;
      }
      if (useFloat) analyser.getFloatTimeDomainData(samples);
      else analyser.getByteTimeDomainData(samples);
      var sum = 0;
      for (var i = 0; i < samples.length; i++) {
        var value = useFloat ? samples[i] * 128 : samples[i] - 128;
        sum += value * value;
      }
      var rms = Math.sqrt(sum / samples.length), now = Date.now();
      if (now - began < BARGE_IN_GUARD_MS) {
        echoFloor = Math.max(echoFloor, rms); sustained = 0; return;
      }
      var threshold = Math.max(BARGE_IN_RMS, echoFloor * 2.2);
      if (rms < threshold) { sustained = 0; return; }
      if (!sustained) sustained = now;
      if (now - sustained < BARGE_IN_SUSTAIN_MS) return;
      traceVoice('barge-in', { rms: Number(rms.toFixed(2)), threshold: Number(threshold.toFixed(2)) });
      // Invalidate every old utterance/timer before cancel(), which may fire onerror.
      disposeCurrentPlayback();
      processing = false;
      startListening();
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        speechDetected = true;
        clearNoSpeechNudgeTimer();
        setOrbState('user-speaking');
      }
    }, VAD_POLL_MS);
  }

  // ── Voice Activity Detection ────────────────────────────────
  function startVAD() {
    if (!analyser) return;
    var useFloat = typeof analyser.getFloatTimeDomainData === 'function';
    var dataArray = useFloat ? new Float32Array(analyser.fftSize) : new Uint8Array(analyser.fftSize);
    var lastMeterLog = 0;

    vadInterval = setInterval(function () {
      if (!active || processing || micMuted()) return;
      if (useFloat) analyser.getFloatTimeDomainData(dataArray);
      else analyser.getByteTimeDomainData(dataArray);

      var sum = 0;
      for (var i = 0; i < dataArray.length; i++) {
        var v = useFloat ? dataArray[i] * 128 : dataArray[i] - 128;
        sum += v * v;
      }
      var rawRms = Math.sqrt(sum / dataArray.length);
      vadSmoothedRms = vadSmoothedRms * (1 - VAD_EMA_ALPHA) + rawRms * VAD_EMA_ALPHA;

      var now = Date.now();
      if (now - lastMeterLog >= 1000) {
        lastMeterLog = now;
        traceVoice('vad-level', { rms: Number(rawRms.toFixed(2)),
          startThreshold: VAD_SPEECH_START_RMS, endThreshold: VAD_SPEECH_END_RMS,
          speechDetected: speechDetected, contextState: audioContext.state });
      }

      if (!speechDetected) {
        // Ignore brief spikes: only arm after sustained energy
        if (rawRms >= VAD_SPEECH_START_RMS && vadSmoothedRms >= VAD_SPEECH_START_RMS) {
          if (!vadSustainStart) vadSustainStart = now;
          if (now - vadSustainStart >= VAD_SPEECH_SUSTAIN_MS) {
            speechDetected = true;
            vadSustainStart = 0;
            clearTimeout(noSpeechNudgeTimer);
            noSpeechNudgeTimer = null;
            setOrbState('user-speaking');
            setStatus('Listening…');
            silenceStart = 0;
            traceVoice('speech-detected', { rms: Number(rawRms.toFixed(2)) });
          }
        } else {
          vadSustainStart = 0;
        }
      } else {
        // Hysteresis: end only when level drops below lower threshold
        if (rawRms >= VAD_SPEECH_END_RMS) {
          silenceStart = 0;
        } else {
          if (!silenceStart) { silenceStart = now; traceVoice('silence-started'); }
          else if (now - silenceStart >= END_OF_SPEECH_SILENCE_MS) {
            traceVoice('silence-completed', { silenceMs: now - silenceStart });
            finishRecording();
          }
        }
      }
    }, VAD_POLL_MS);
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
    clearNoSpeechNudgeTimer();
    setMicTracksEnabled(false);
    if (speechDetected) {
      processing = true;
      setStatus('Thinking…');
      setOrbState('thinking');
    }
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      traceVoice('recorder-stop-requested', { speechDetected: speechDetected });
      mediaRecorder.stop();
    }
  }

  /** Drop the current mic segment without running STT (used when user types instead). */
  function abortCurrentListenSegment() {
    stopVAD();
    clearNoSpeechNudgeTimer();
    silenceNudgePending = false;
    var recorder = mediaRecorder;
    mediaRecorder = null;
    if (recorder) {
      // A manual mute can cancel the brief interval between stop() and its onstop event.
      processing = false;
      recorder.onstop = null;
      recorder.ondataavailable = null;
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch (eStop) {}
    }
    audioChunks = [];
  }

  async function fetchVoiceReplyAndPlay(transcript) {
    if (!active) return;
    var generation = callGeneration;
    pauseMicrophone();
    processing = true;
    setOrbState('thinking');
    setStatus('Thinking…');
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
        body: payload,
        signal: callAbort.signal
      });
      if (!isCurrentCall(generation)) return;
      if (streamResp.ok) {
        var ct = (streamResp.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('text/event-stream') >= 0 && streamResp.body && streamResp.body.getReader) {
          await consumeAlexVoiceStream(streamResp, uLine);
          return;
        }
        var jsonResp = await fetch(apiBase() + '/api/alex-voice', {
          method: 'POST',
          headers: headers,
          body: payload,
          signal: callAbort.signal
        });
        if (!isCurrentCall(generation)) return;
        if (!jsonResp.ok) {
          if (handleVoiceHttpError(jsonResp.status)) return;
          var vErr2 = voiceErrorMessage(jsonResp.status, '', false);
          try {
            var vBody2 = await jsonResp.json();
            vErr2 = voiceErrorMessage(jsonResp.status, vBody2.error_code, false);
          } catch (eJ2) {}
          if (!isCurrentCall(generation)) return;
          setStatus('Alex could not reply');
          try {
            window.__voiceLastUserLine = '';
          } catch (eClrJ) {}
          setTranscript(vErr2);
          setOrbState('idle');
          processing = false;
          scheduleListenAfterSpeech(2200);
          return;
        }
        var dataFb = await jsonResp.json();
        if (!isCurrentCall(generation)) return;
        playAlexVoiceResponse(dataFb);
        return;
      }
      if (!streamResp.ok) {
        if (handleVoiceHttpError(streamResp.status)) return;
        var vErr = voiceErrorMessage(streamResp.status, '', false);
        try {
          var vBody = await streamResp.json();
          vErr = voiceErrorMessage(streamResp.status, vBody.error_code, false);
        } catch (e2) {}
        if (!isCurrentCall(generation)) return;
        setStatus('Alex could not reply');
        try {
          window.__voiceLastUserLine = '';
        } catch (eClr) {}
        setTranscript(vErr);
        setOrbState('idle');
        processing = false;
        scheduleListenAfterSpeech(2200);
        return;
      }
    } catch (err) {
      if (!isCurrentCall(generation)) return;
      console.error('[AlexVoice] API error:', err);
      try {
        window.__voiceLastUserLine = '';
      } catch (eClr2) {}
      setStatus(voiceErrorMessage(0, 'network', false));
      appendVoiceServerNotice(voiceErrorMessage(0, 'network', false));
      setOrbState('idle');
      processing = false;
      scheduleListenAfterSpeech(1500);
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

    pauseMicrophone();

    processing = true;
    setOrbState('thinking');
    setStatus('Thinking…');
    window.__voiceLastUserLine = 'You: ' + text;
    appendChatBubble('user', null, text);
    setTranscript('');

    await fetchVoiceReplyAndPlay(text);
  }

  function playAlexVoiceResponse(data) {
    if (!active) return;
    var generation = callGeneration;
    pauseMicrophone();
    processing = true;
    var uLine = window.__voiceLastUserLine || '';
    window.__voiceLastUserLine = '';
    applyAlexLanguagePrefsFromVoice(data);
    traceVoice('reply-received', { replyLength: (data.text || '').length, audioBytesEncoded: (data.audio_b64 || '').length });
    disposeCurrentPlayback();
    setOrbState('ai-speaking');
    setStatus('Alex is speaking...');
    if (data.display_html || data.text) {
      renderVoiceTranscriptBlock(uLine, data);
    } else if (uLine) {
      setTranscript(uLine);
    }

    function done(opts) {
      if (!isCurrentCall(generation)) return;
      opts = opts || {};
      processing = false;
      if (!opts.keepReadingPane) setTranscript('');
      setOrbState('idle');
      if (active) scheduleListenAfterSpeech();
    }

    if (data.tts_mode === 'browser') {
      speakBrowserReply(data, function () { done({ keepReadingPane: true }); });
      return;
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
      if (!isCurrentCall(generation)) return;
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
        if (!isCurrentCall(generation)) return;
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
    var generation = callGeneration;
    pauseMicrophone();
    processing = true;
    setOrbState('thinking');
    setStatus('Thinking…');
    setTranscript('');
    var headers = authHeadersJson();
    var payload = JSON.stringify({ silence_nudge: true, voice_key: voiceKey() });
    try {
      tryPrimeAudioOnUserGesture();
      var streamResp = await fetch(apiBase() + '/api/alex-voice-stream', {
        method: 'POST',
        headers: headers,
        body: payload,
        signal: callAbort.signal
      });
      if (!isCurrentCall(generation)) return;
      if (streamResp.ok) {
        var ct = (streamResp.headers.get('content-type') || '').toLowerCase();
        if (ct.indexOf('text/event-stream') >= 0 && streamResp.body && streamResp.body.getReader) {
          await consumeAlexVoiceStream(streamResp, '');
          return;
        }
        var jsonResp = await fetch(apiBase() + '/api/alex-voice', {
          method: 'POST',
          headers: headers,
          body: payload,
          signal: callAbort.signal
        });
        if (!isCurrentCall(generation)) return;
        if (!jsonResp.ok) {
          if (handleVoiceHttpError(jsonResp.status)) return;
          processing = false;
          setOrbState('idle');
          if (active) scheduleListenAfterSpeech();
          return;
        }
        var data = await jsonResp.json();
        if (!isCurrentCall(generation)) return;
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
      if (!isCurrentCall(generation)) return;
      console.error('[AlexVoice] silence nudge error:', e);
      processing = false;
      setOrbState('idle');
      scheduleListenAfterSpeech(1200);
    }
  }

  // ── Transcribe → LLM → TTS → Play ──────────────────────────
  async function transcribeAndRespond(audioBlob) {
    if (!active) return;
    var generation = callGeneration;
    pauseMicrophone();
    processing = true;
    clearNoSpeechNudgeTimer();
    // Step 1: STT
    setStatus('Thinking…');
    var transcript = '';
    try {
      traceVoice('stt-request-sent', { blobBytes: audioBlob.size, mimeType: audioBlob.type });
      var sttResp = await fetch(apiBase() + '/api/alex-voice-stt', {
        method: 'POST',
        headers: authHeadersForStt(audioBlob.type),
        body: audioBlob,
        signal: callAbort.signal
      });
      if (!isCurrentCall(generation)) return;
      traceVoice('stt-response', { sttStatus: sttResp.status });
      if (!sttResp.ok) {
        if (handleVoiceHttpError(sttResp.status)) return;
        var sttErr = voiceErrorMessage(sttResp.status, '', true);
        try {
          var sttErrBody = await sttResp.json();
          sttErr = voiceErrorMessage(sttResp.status, sttErrBody.error_code, true);
        } catch (e1) {}
        if (!isCurrentCall(generation)) return;
        setOrbState('idle');
        setStatus(sttErr);
        setTranscript(sttErr);
        processing = false;
        scheduleListenAfterSpeech(2200);
        return;
      }
      var sttData = await sttResp.json();
      if (!isCurrentCall(generation)) return;
      transcript = !sttData.error && typeof sttData.text === 'string' ? sttData.text.trim() : '';
      traceVoice(transcript ? 'transcript-accepted' : 'transcript-rejected', { transcriptLength: transcript.length });
      if (transcript) {
        window.__voiceLastUserLine = 'You: ' + transcript;
        appendChatBubble('user', null, transcript);
        setStatus('Thinking…');
      }
      setTranscript('');
    } catch (e) {
      if (!isCurrentCall(generation)) return;
      console.error('[AlexVoice] STT error:', e);
      setOrbState('idle');
      setStatus(voiceErrorMessage(0, 'network', true));
      appendVoiceServerNotice(voiceErrorMessage(0, 'network', true));
      processing = false;
      scheduleListenAfterSpeech(1500);
      return;
    }

    if (!transcript.length) {
      setOrbState('idle');
      processing = false;
      setStatus(voiceErrorMessage(0, 'stt', true));
      appendVoiceServerNotice(voiceErrorMessage(0, 'stt', true));
      scheduleListenAfterSpeech(1500);
      return;
    }

    traceVoice('reply-request-sent');
    await fetchVoiceReplyAndPlay(transcript);
  }

  // ── Stop ────────────────────────────────────────────────────
  function stopAlex(skipSync, keepOverlay) {
    var wasRunning = active || starting;
    var syncKey = voiceKey();
    var durationSec = voiceStartedAt ? Math.round((Date.now() - voiceStartedAt) / 1000) : 0;
    // Invalidate callbacks FIRST, then release hardware before any network/UI work.
    active = false;
    starting = false;
    traceVoice('call-ended');
    processing = false;
    callGeneration++;
    if (callAbort) callAbort.abort();
    callAbort = null;
    clearListenTimer();
    if (audioResumeTimer) clearTimeout(audioResumeTimer);
    audioResumeTimer = null;
    if (limitTimer) clearTimeout(limitTimer);
    limitTimer = null;
    if (_bindPoll) clearInterval(_bindPoll);
    _bindPoll = null;
    abortCurrentListenSegment();
    if (micStream) {
      micStream.getTracks().forEach(function (track) { try { track.stop(); } catch (eTrack) {} });
      micStream = null;
    }
    if (audioContext) {
      var context = audioContext;
      audioContext = null;
      try { context.close().catch(function () {}); } catch (eContext) {}
    }
    analyser = null;
    disposeCurrentPlayback();
    callButton = null;
    sessionVoiceKey = '';
    try {
      window.__alex_voice_session_active = false;
    } catch (eS0) {}
    // Fire-and-forget: preserve the existing session sync after microphone cleanup.
    if (wasRunning && !skipSync) {
      fetch(apiBase() + '/api/alex-voice-sync', {
        method: 'POST',
        headers: authHeadersJson(),
        body: JSON.stringify({ voice_key: syncKey, duration_seconds: durationSec }),
        keepalive: true
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
    if (wasRunning && !keepOverlay && window.__alex_overlay_mode) {
      var bridge = document.getElementById('alex-voice-overlay-close-bridge');
      if (bridge) bridge.click();
    }
  }

  window.stopAlexVoiceSession = function () { stopAlex(false); };
  window.__alexVoiceCleanup = function () {
    stopAlex(false, true);
    if (panelObserver) panelObserver.disconnect();
    window.removeEventListener('pagehide', endVoiceOnNavigation);
    window.removeEventListener('beforeunload', endVoiceOnNavigation);
    document.removeEventListener('visibilitychange', handleVoiceVisibility);
    voiceBindings.forEach(function (binding) {
      binding.element.removeEventListener(binding.type, binding.handler);
      delete binding.element._alexBound;
      delete binding.element._alexMicBound;
    });
    voiceBindings = [];
  };
})();
