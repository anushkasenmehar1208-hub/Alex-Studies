/**
 * Alex 3D Avatar — realistic talking head overlay on top of a target orb.
 * Zero-touch integration with alex_voice.js:
 *   - State:     MutationObserver on #alex-orb className  →  avatar anim state
 *   - Lip-sync:  patched HTMLMediaElement.prototype.play  →  Web Audio analyser  →  jaw/viseme morphs
 *   - Fallback:  if WebGL / GLB unavailable, the original orb animation stays visible underneath.
 *
 * Tech: Three.js r160 + GLTFLoader + Ready Player Me (.glb, ARKit + Oculus Visemes morph targets).
 */
(function () {
  'use strict';

  // One timer-free controller, advanced exclusively by the existing render loop.
  // It owns additive pose/morph deltas; voice owns all recording and playback.
  function createAvatarMotion(rig, random) {
    random = random || Math.random;
    var alive = true, t = 0, state = 'idle', entered = 0;
    var nextBlink = range(3, 7), blinkAt = -10, blinkDuration = 0.14, doublePending = false;
    var breathAt = 0, breathDuration = range(4, 6), breathAmp = range(0.003, 0.006);
    var nextHead = 0, head = {x: 0, y: 0, z: 0}, target = {x: 0, y: 0, z: 0};
    var nextNod = range(4, 8), nodAt = -10, glanceUntil = 0;
    var speechActive = false, nextMouth = 0, mouthAt = -10, mouthDuration = 0.15;
    var mouthShape = 'AH', mouthAmp = 0, mouthPauseUntil = 0, boundaryUntil = 0;
    var morphs = {};
    rig.morphMeshes.forEach(function (mesh) {
      Object.keys(mesh.morphTargetDictionary).forEach(function (name) {
        if (!morphs[name]) morphs[name] = [];
        morphs[name].push({mesh: mesh, index: mesh.morphTargetDictionary[name]});
      });
    });
    function range(a, b) { return a + (b - a) * random(); }
    function smooth(x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); }
    function pulse(at, duration) {
      var phase = (t - at) / duration;
      return phase < 0 || phase > 1 ? 0 : smooth(phase < 0.45 ? phase / 0.45 : (1 - phase) / 0.55);
    }
    function morph(name, value) {
      (morphs[name] || []).forEach(function (binding) { binding.mesh.morphTargetInfluences[binding.index] = value; });
    }
    function clearMouthWeights() {
      ['AH', 'OH', 'CH', 'jawOpen', 'mouthOpen', 'viseme_aa', 'viseme_O', 'viseme_E', 'viseme_U'].forEach(function (name) { morph(name, 0); });
    }
    function closeMouth() { mouthAmp = 0; mouthAt = -10; clearMouthWeights(); }
    function setState(value) {
      if (!alive || state === value) return;
      state = value; entered = t; nextHead = t;
      nextNod = t + range(2, 5);
      glanceUntil = value === 'thinking' && random() < 0.4 ? t + range(0.6, 1.1) : 0;
      if (value !== 'speaking') { speechActive = false; closeMouth(); }
    }
    function speech(event) {
      if (!alive) return;
      if (event.type === 'state') { setState(event.state); return; }
      if (event.type === 'speech-start') {
        setState('speaking'); speechActive = true; nextMouth = t; mouthPauseUntil = 0; return;
      }
      if (event.type === 'speech-boundary' && speechActive) {
        var word = event.word || '';
        mouthShape = /[ou]/i.test(word) ? 'OH' : /[csjt]/i.test(word) ? 'CH' : 'AH';
        nextMouth = t; boundaryUntil = t + 0.3;
        if (/[.!?,;:]$/.test(word)) mouthPauseUntil = t + range(0.18, 0.32);
        // Sparse phrase emphasis, never an animation on every word.
        if (t >= nextNod && random() < 0.25) { nodAt = t; nextNod = t + range(4, 8); }
        return;
      }
      if (event.type === 'speech-end' || event.type === 'speech-cancel') {
        speechActive = false; closeMouth(); setState('idle');
      }
      if (event.type === 'interrupted') { speechActive = false; closeMouth(); setState('interrupted'); }
    }
    function applyBone(key, x, y, z, k) {
      var bone = key === 'head' ? rig.head : rig.bones[key], rest = rig.rest[key];
      if (!bone || !rest) return;
      bone.rotation.x += (rest.x + x - bone.rotation.x) * k;
      bone.rotation.y += (rest.y + y - bone.rotation.y) * k;
      bone.rotation.z += (rest.z + z - bone.rotation.z) * k;
    }
    function update(dt, audioLevel) {
      if (!alive) return;
      dt = Math.min(0.05, Math.max(0, dt)); t += dt;
      if (t >= nextBlink) {
        blinkAt = t; blinkDuration = range(0.10, 0.18);
        if (!doublePending && random() < 0.06) { doublePending = true; nextBlink = t + blinkDuration + 0.12; }
        else { doublePending = false; nextBlink = t + range(3, 7); }
      }
      morph('eye_close', pulse(blinkAt, blinkDuration));
      if (t - breathAt >= breathDuration) { breathAt = t; breathDuration = range(4, 6); breathAmp = range(0.003, 0.006); }
      var breath = Math.sin((t - breathAt) / breathDuration * Math.PI * 2) * breathAmp;
      // No whole-body vertical bob: torso/shoulders carry quiet breathing.
      if (rig.root) rig.root.position.y = rig.restY;
      if (t >= nextHead) {
        var neutral = random() < 0.25;
        target = {x: neutral ? 0 : range(-0.018, 0.018), y: neutral ? 0 : range(-0.025, 0.025), z: neutral ? 0 : range(-0.012, 0.012)};
        nextHead = t + range(2.5, 6);
      }
      var k = 1 - Math.exp(-dt * 2.5);
      ['x', 'y', 'z'].forEach(function (axis) { head[axis] += (target[axis] - head[axis]) * k; });
      if ((state === 'listening' || state === 'speaking') && t >= nextNod) { nodAt = t; nextNod = t + range(5, 10); }
      var nod = pulse(nodAt, 0.85) * 0.018;
      var attention = state === 'listening' ? 0.012 : 0;
      applyBone('head', head.x - nod - attention, head.y, head.z + attention, k);
      applyBone('neck', breath * 0.25, 0, attention * 0.25, k);
      applyBone('spine', breath, 0, 0, k);
      applyBone('spine1', breath * 0.5, 0, 0, k);
      ['leftShoulder', 'rightShoulder'].forEach(function (key) { applyBone(key, breath * 0.4, 0, 0, k); });
      ['leftArm', 'rightArm', 'leftForeArm', 'rightForeArm', 'leftHand', 'rightHand'].forEach(function (key) { applyBone(key, 0, 0, 0, k); });
      morph('eyesLookUp', t < glanceUntil ? Math.sin(Math.PI * (t - entered) / (glanceUntil - entered)) * 0.10 : 0);
      clearMouthWeights();
      if (speechActive) {
        if (t >= nextMouth && t >= mouthPauseUntil) {
          if (t > boundaryUntil) mouthShape = ['AH', 'OH', 'CH'][Math.floor(random() * 3)];
          mouthAt = t; mouthDuration = range(0.10, 0.19); mouthAmp = range(0.10, 0.28);
          nextMouth = t + mouthDuration + range(0.07, 0.20);
          if (random() < 0.18) { mouthPauseUntil = t + range(0.20, 0.40); mouthAmp = 0; }
        }
        var amount = pulse(mouthAt, mouthDuration) * mouthAmp;
        morph(mouthShape, amount);
        // Preserve the optional server-audio path on models with Oculus/ARKit shapes.
      } else if (state === 'speaking') {
        var amount = Math.min(0.28, (audioLevel || 0) * 0.4);
        if (morphs.AH) morph('AH', amount);
        else if (morphs.jawOpen) morph('jawOpen', amount);
        else morph('viseme_aa', amount);
      }
    }
    return {update: update, setState: setState, speech: speech,
      dispose: function () { if (!alive) return; closeMouth(); morph('eye_close', 0); morph('eyesLookUp', 0); alive = false; },
      snapshot: function () { return {state: state, alive: alive, time: t, nextBlink: nextBlink, blinkDuration: blinkDuration, speechActive: speechActive}; }};
  }

  // ── Config ─────────────────────────────────────────────────────────────────
  // Resolve default avatar URL relative to THIS script's location so the same file
  // works both inside the Reflex app (/alex_avatar.js → /models/…) and when the
  // script is served from /assets/ (e.g. static test harness).
  var AVATAR_SCRIPT_SRC =
    (document.currentScript && document.currentScript.src) ||
    (function () {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        var s = scripts[i].src || '';
        if (/alex_avatar\.js(\?|$)/.test(s)) return s;
      }
      return '';
    })();
  var AVATAR_URL_BASE = AVATAR_SCRIPT_SRC.replace(/[^/?#]*(\?.*)?(#.*)?$/, '');
  // Default avatar: use the bundled Alex/student GLB first so every
  // browser gets the same finished character even when Chromium/Brave blocks or
  // fails a third-party model request.
  var LOCAL_AVATAR_URL = AVATAR_URL_BASE + 'models/teacher_naoki.glb';

  // Remote Ready Player Me source kept as a final recovery path.
  // Quality params: ARKit/Oculus visemes for lipsync, atlased 1024 textures, highest mesh LOD,
  // A-pose (more natural than T), full hand bones. These dramatically increase detail vs. the
  // default URL which returns a low-LOD, low-texture stylized variant.
  // NOTE: do NOT use textureAtlas — it merges all materials into a single
  // atlas, destroying the Wolf3D_Outfit_Top / _Hair / _Skin names that our
  // material-override code needs to identify and recolour each body part.
  var RPM_QUALITY_PARAMS =
    '?morphTargets=ARKit,Oculus%20Visemes' +
    '&textureSizeLimit=1024' +
    '&meshLod=0' +
    '&pose=A' +
    '&useHands=true';
  var REALISTIC_AVATAR_URL = 'https://models.readyplayer.me/6185a4acfb622cf1cdc49348.glb' + RPM_QUALITY_PARAMS;
  var LOCAL_AVATAR_FALLBACK_URL = AVATAR_URL_BASE + 'models/alex_body.glb';
  var TEACHER_TEXTURE_URLS = {
    body: AVATAR_URL_BASE + 'models/teacher_naoki_body.png',
    hair: AVATAR_URL_BASE + 'models/teacher_naoki_hair.png',
    skin: AVATAR_URL_BASE + 'models/teacher_naoki_skin.png'
  };
  // Final CDN copy — used only if the preferred avatar and local fallbacks fail.
  var REMOTE_AVATAR_URL =
    'https://raw.githubusercontent.com/wass08/r3f-virtual-girlfriend-frontend/main/public/models/64f1a714fe61576b46f27ca2.glb';
  var AVATAR_URL =
    (window.ALEX_AVATAR_URL && typeof window.ALEX_AVATAR_URL === 'string')
      ? window.ALEX_AVATAR_URL
      : LOCAL_AVATAR_URL;
  var AVATAR_URL_FALLBACK = REMOTE_AVATAR_URL;

  var THREE_CDN = 'https://unpkg.com/three@0.160.0/build/three.module.js';
  var GLTF_CDN  = 'https://unpkg.com/three@0.160.0/examples/jsm/loaders/GLTFLoader.js';

  // Debug switch: window.ALEX_AVATAR_DEBUG = true to enable console logs.
  function log() {
    if (window.ALEX_AVATAR_DEBUG) {
      try { console.log.apply(console, ['[AlexAvatar]'].concat([].slice.call(arguments))); } catch (e) {}
    }
  }
  function warn() {
    try { console.warn.apply(console, ['[AlexAvatar]'].concat([].slice.call(arguments))); } catch (e) {}
  }

  window.__alexAvatarBootedTargets = window.__alexAvatarBootedTargets || {};

  // ── WebGL capability check ────────────────────────────────────────────────
  function hasWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  if (!hasWebGL()) {
    warn('WebGL unavailable — falling back to original orb.');
    return;
  }

  // ── Lip-sync shared analyser (patched once, used by avatar) ───────────────
  var sharedAudioCtx = null;
  var sharedAnalyser = null;
  var sharedData = null;
  var patchedAudios = new WeakSet();

  function ensureAudioCtx() {
    if (sharedAudioCtx) return sharedAudioCtx;
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      sharedAudioCtx = new Ctx();
      sharedAnalyser = sharedAudioCtx.createAnalyser();
      sharedAnalyser.fftSize = 512;
      sharedAnalyser.smoothingTimeConstant = 0.55;
      sharedAnalyser.connect(sharedAudioCtx.destination);
      sharedData = new Uint8Array(sharedAnalyser.frequencyBinCount);
    } catch (e) {
      warn('AudioContext init failed', e);
      sharedAudioCtx = null;
    }
    return sharedAudioCtx;
  }

  function connectAudioElement(audioEl) {
    if (!audioEl || patchedAudios.has(audioEl)) return;
    var ctx = ensureAudioCtx();
    if (!ctx) return;
    try {
      // Resume if suspended (Safari/autoplay policy safety net).
      if (ctx.state === 'suspended') { ctx.resume().catch(function () {}); }
      var src = ctx.createMediaElementSource(audioEl);
      src.connect(sharedAnalyser);
      patchedAudios.add(audioEl);
      log('connected audio element to analyser');
    } catch (e) {
      // createMediaElementSource throws if already connected elsewhere — safe to ignore.
      log('connect skipped:', e && e.message);
    }
  }

  // Patch play() once — every <audio> created anywhere on the page is auto-connected.
  (function patchAudioPlay() {
    try {
      var proto = window.HTMLMediaElement && window.HTMLMediaElement.prototype;
      if (!proto || proto.__alexAvatarPatched) return;
      var origPlay = proto.play;
      proto.play = function () {
        try { connectAudioElement(this); } catch (e) {}
        return origPlay.apply(this, arguments);
      };
      proto.__alexAvatarPatched = true;
      log('HTMLMediaElement.play patched');
    } catch (e) { warn('play patch failed', e); }
  })();

  // Returns 0..1 rough loudness in a voice-ish band (roughly 200Hz–3kHz).
  function sampleLoudness() {
    if (!sharedAnalyser || !sharedData) return 0;
    try {
      sharedAnalyser.getByteFrequencyData(sharedData);
      // AnalyserNode bins cover 0..sampleRate/2 across frequencyBinCount bins.
      // We'll read a middle slice (skip rumble + hiss) and average.
      var start = 4, end = Math.min(sharedData.length, 64);
      var sum = 0, count = 0;
      for (var i = start; i < end; i++) { sum += sharedData[i]; count++; }
      var avg = count ? sum / count : 0;
      return Math.min(1, avg / 180); // 180 picked so normal speech reaches ~0.7–1.0
    } catch (e) { return 0; }
  }

  // ── Dynamic ES module loader for Three.js ─────────────────────────────────
  function loadThreeModules() {
    // Use dynamic import via a Blob so we can pin versions without build step.
    // We return a Promise resolving to { THREE, GLTFLoader }.
    var importMapId = '_alex_avatar_importmap';
    if (!document.getElementById(importMapId)) {
      try {
        var im = document.createElement('script');
        im.type = 'importmap';
        im.id = importMapId;
        im.textContent = JSON.stringify({
          imports: {
            'three': THREE_CDN,
            'three/addons/': 'https://unpkg.com/three@0.160.0/examples/jsm/'
          }
        });
        // Importmaps must be inserted before any module that uses them.
        (document.head || document.documentElement).appendChild(im);
      } catch (e) { warn('importmap insert failed', e); }
    }

    return new Promise(function (resolve, reject) {
      var bootId = '_alex_avatar_bootmod';
      if (document.getElementById(bootId)) {
        // Already loading — wait for the global.
        var check = 0;
        (function wait() {
          if (window.__alexAvatarTHREE) return resolve(window.__alexAvatarTHREE);
          if (++check > 200) return reject(new Error('THREE load timeout'));
          setTimeout(wait, 50);
        })();
        return;
      }
      var boot = document.createElement('script');
      boot.id = bootId;
      boot.type = 'module';
      boot.textContent = [
        "import * as THREE from 'three';",
        "import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';",
        "import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';",
        "import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';",
        "import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';",
        "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';",
        "window.__alexAvatarTHREE = { THREE: THREE, GLTFLoader: GLTFLoader, DRACOLoader: DRACOLoader, KTX2Loader: KTX2Loader, MeshoptDecoder: MeshoptDecoder, OrbitControls: OrbitControls };",
        "window.dispatchEvent(new Event('alex-avatar-three-ready'));"
      ].join('\n');
      boot.onerror = function (e) { reject(new Error('three module load error')); };
      window.addEventListener('alex-avatar-three-ready', function once() {
        window.removeEventListener('alex-avatar-three-ready', once);
        if (window.__alexAvatarTHREE) resolve(window.__alexAvatarTHREE);
        else reject(new Error('THREE global missing after load'));
      });
      (document.head || document.documentElement).appendChild(boot);
      // Safety timeout.
      setTimeout(function () {
        if (!window.__alexAvatarTHREE) reject(new Error('THREE load timeout'));
      }, 15000);
    });
  }

  // ── DOM helpers ───────────────────────────────────────────────────────────
  function waitForOrb(targetId, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var existing = document.getElementById(targetId);
      if (existing) return resolve(existing);
      var obs = new MutationObserver(function () {
        var el = document.getElementById(targetId);
        if (el) { obs.disconnect(); resolve(el); }
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(function () { obs.disconnect(); reject(new Error('orb not found')); }, timeoutMs || 20000);
    });
  }

  function injectStyleOnce(targetId, canvasId) {
    var styleId = 'alex-avatar-styles-' + targetId;
    if (document.getElementById(styleId)) return;
    var st = document.createElement('style');
    st.id = styleId;
    st.textContent = [
      // Let the canvas extend well outside the 220px orb bounds so the full body can show.
      '#' + targetId + ' { overflow: visible !important; }',
      // Portrait-aspect canvas centered on the orb so the avatar reads as a person standing.
      // Bottom ~25% fades to transparent so the character's legs visually merge into the
      // transcript "wall" that sits below the orb.
      '#' + canvasId + ' {',
      '  position: absolute;',
      '  left: 50%;',
      '  top: 50%;',
      '  transform: translate(-50%, -56%);',
      '  width: 360px; height: 580px;',
      '  max-width: 92vw;',
      '  pointer-events: auto;',
      '  cursor: grab;',
      '  opacity: 0;',
      '  transition: opacity .6s ease;',
      '  z-index: 2;',
      '  touch-action: none;',
      // Hard-ish fade at the waist so the bottom half of the body tucks neatly behind
      // the wall below, rather than bleeding onto the transcript text.
      '  -webkit-mask-image: linear-gradient(to bottom, black 0%, black 68%, rgba(0,0,0,0.35) 82%, transparent 92%);',
      '          mask-image: linear-gradient(to bottom, black 0%, black 68%, rgba(0,0,0,0.35) 82%, transparent 92%);',
      '}',
      '#' + canvasId + ':active { cursor: grabbing; }',
      '#' + canvasId + '.alex-avatar-ready { opacity: 1; }',
      // Once avatar is ready, strongly dim the old orb core so only a soft halo remains around the avatar.
      '#' + targetId + '.alex-avatar-active .orb-core { opacity: .15; }',
      '#' + targetId + '.alex-avatar-active .orb-ring { opacity: .08; }',
      '#' + targetId + '.alex-avatar-active.ai-speaking .orb-core,',
      '#' + targetId + '.alex-avatar-active.user-speaking .orb-core { opacity: .30; }',
      '#' + targetId + '.alex-avatar-active.ai-speaking .orb-ring,',
      '#' + targetId + '.alex-avatar-active.user-speaking .orb-ring { opacity: .16; }',
      '@media (max-width: 520px) {',
      '  #' + canvasId + ' { width: 320px; height: 500px; }',
      '}'
    ].join('\n');
    document.head.appendChild(st);
  }

  // ── Main boot ─────────────────────────────────────────────────────────────
  function boot(targetId) {
    targetId = targetId || 'alex-orb';
    var canvasId = targetId + '-avatar-canvas';

    // Re-entrant-safe: if a previous boot ran but the canvas was removed from the
    // DOM (Reflex closes and reopens the voice overlay → destroys the old orb element),
    // clear the stale flag so we re-initialise into the fresh orb.
    if (window.__alexAvatarBootedTargets[targetId]) {
      if (document.getElementById(canvasId)) {
        log('already booted and canvas present for', targetId);
        return;
      }
      log('canvas missing — orb was re-created; re-initialising', targetId);
      window.__alexAvatarBootedTargets[targetId] = false;
    }

    window.__alexAvatarBootedTargets[targetId] = true;
    injectStyleOnce(targetId, canvasId);

    waitForOrb(targetId).then(function (orb) {
      // Guard: canvas might have been injected by a racing call.
      if (document.getElementById(canvasId)) return;
      var canvas = document.createElement('canvas');
      canvas.id = canvasId;
      orb.appendChild(canvas);

      loadThreeModules()
        .then(function (mods) { return initScene(mods, canvas, orb, targetId); })
        .catch(function (err) {
          warn('3D init failed, keeping orb fallback:', err && err.message);
          try { canvas.remove(); } catch (e) {}
          delete window.__alexAvatarBootedTargets[targetId];
        });
    }).catch(function (err) {
      warn('could not find #' + targetId + ':', err && err.message);
      delete window.__alexAvatarBootedTargets[targetId];
    });
  }

  // Watch the whole document for the orb element being (re-)added to the DOM.
  // Reflex's SPA navigation and show_voice_overlay toggling recreates #alex-orb
  // without reloading the page, so this observer ensures the avatar re-mounts.
  (function installPersistentObserver() {
    var obsTargetId = window.ALEX_AVATAR_TARGET_ID || 'alex-orb';
    var docObs = new MutationObserver(function () {
      var orb = document.getElementById(obsTargetId);
      if (!orb || document.hidden) return;
      var canvasId = obsTargetId + '-avatar-canvas';
      // Only act when the orb exists but canvas is absent (fresh mount).
      if (!document.getElementById(canvasId)) {
        log('persistent observer: orb re-appeared, triggering boot');
        boot(obsTargetId);
      }
    });
    docObs.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('pagehide', function () { docObs.disconnect(); });
    window.addEventListener('pageshow', function () {
      docObs.observe(document.documentElement, { childList: true, subtree: true });
      bootDefaultAvatar();
    });
  })();

  function initScene(mods, canvas, orb, targetId) {
    targetId = targetId || 'alex-orb';
    if (!canvas.isConnected) return;
    var THREE = mods.THREE;
    var GLTFLoader = mods.GLTFLoader;
    var DRACOLoader = mods.DRACOLoader;
    var KTX2Loader = mods.KTX2Loader;
    var MeshoptDecoder = mods.MeshoptDecoder;
    var OrbitControls = mods.OrbitControls;

    var scene = new THREE.Scene();
    scene.background = null; // transparent

    var camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50);
    // Head-and-shoulders framing: camera at eye level, ~2.2m back, looking at face height.
    camera.position.set(0, 1.58, 2.4);
    camera.lookAt(0, 1.58, 0);

    var renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'high-performance'
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05; // slightly hot — gives skin a magazine-cover lift
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    sizeToCanvas();

    // Cinematic three-point lighting for an executive-portrait look.
    // Key: warm, strong, high-angle from the right — gives skin warmth & shape.
    var key = new THREE.DirectionalLight(0xfff1e0, 1.55);
    key.position.set(1.2, 2.4, 2.2);
    scene.add(key);
    // Fill: cool, soft, from camera-left — softens shadow side without flattening.
    var fill = new THREE.DirectionalLight(0xc8d8f0, 0.55);
    fill.position.set(-1.7, 1.5, 1.4);
    scene.add(fill);
    // Rim: bright back-light, high & slightly behind — separates head/shoulders from BG.
    var rim = new THREE.DirectionalLight(0xffffff, 0.85);
    rim.position.set(-0.6, 2.2, -1.9);
    scene.add(rim);
    // Subtle hair light from above-back to make the dark hair catch a highlight.
    var hairLight = new THREE.DirectionalLight(0xfff5e8, 0.6);
    hairLight.position.set(0.5, 3.0, -1.2);
    scene.add(hairLight);
    scene.add(new THREE.HemisphereLight(0xcfe2ff, 0x10141c, 0.42));
    scene.add(new THREE.AmbientLight(0xfff3ea, 0.18));

    // State container.
    var rig = {
      root: null,
      head: null,
      hasNativeEyes: false,
      nativeEyeNodes: [],
      bones: {},             // named bones: leftArm, rightArm, leftForeArm, rightForeArm, leftHand, rightHand, spine, spine1, spine2, neck
      rest: {},              // captured rest-pose rotations (Euler copies) per bone key
      morphMeshes: [],       // meshes with morphTargetDictionary
      jawOpenKeys: [],       // preferred morph target names per mesh for jaw
      viseme: {},            // mesh → index of best "aa/open" viseme
      hasPaintedFace: false, // fallback anime model has face/eyes baked into its skin texture
      hasTexturedOutfit: false,
      externalSkinLoaded: false,
      needsFaceFallback: false,
      faceFallbackGroup: null,
      currentState: 'idle',
      targetState: 'idle',
      prevState: 'idle',
      stateEnteredAt: 0,     // rig.t when the current target state began
      loudness: 0,
      t: 0,
      restY: 0               // avatar.position.y after auto-centering; breathing anim adds on top
    };

    var teacherTextureLoader = new THREE.TextureLoader();
    var teacherTextureCache = {};
    function removeFaceFallback() {
      if (!rig.faceFallbackGroup) return;
      try {
        if (rig.faceFallbackGroup.parent) {
          rig.faceFallbackGroup.parent.remove(rig.faceFallbackGroup);
        }
      } catch (e) {}
      rig.faceFallbackGroup = null;
    }
    function teacherTexture(kind) {
      if (!TEACHER_TEXTURE_URLS[kind]) return null;
      if (teacherTextureCache[kind]) return teacherTextureCache[kind];
      var tex = teacherTextureLoader.load(
        TEACHER_TEXTURE_URLS[kind],
        function () {
          if (kind === 'skin') {
            rig.externalSkinLoaded = true;
            removeFaceFallback();
          }
        },
        undefined,
        function () {
          if (kind === 'skin') {
            rig.needsFaceFallback = true;
          }
          warn('teacher texture failed:', kind);
        }
      );
      tex.flipY = false; // glTF UV convention; TextureLoader defaults to true.
      if (tex.colorSpace !== undefined) tex.colorSpace = THREE.SRGBColorSpace;
      teacherTextureCache[kind] = tex;
      return tex;
    }
    function forceTeacherTexture(mat, kind) {
      var tex = teacherTexture(kind);
      if (!tex || !mat) return false;
      mat.map = tex;
      if (mat.color && mat.color.set) mat.color.set(0xffffff);
      mat.needsUpdate = true;
      return true;
    }

    function sizeToCanvas() {
      // Use CSS pixel size — canvas has fixed ratio via CSS, but DPR-aware drawing buffer.
      var rect = canvas.getBoundingClientRect();
      var w = Math.max(64, rect.width | 0);
      var h = Math.max(64, rect.height | 0);
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    var disposed = false, stateObserver = null, motion = null;
    function disposeObject(root) {
      if (!root) return;
      var resources = new Set();
      root.traverse(function (node) {
        if (node.geometry) resources.add(node.geometry);
        var materials = node.material ? (Array.isArray(node.material) ? node.material : [node.material]) : [];
        materials.forEach(function (material) {
          resources.add(material);
          Object.keys(material).forEach(function (key) { if (material[key] && material[key].isTexture) resources.add(material[key]); });
        });
      });
      resources.forEach(function (resource) { resource.dispose(); });
    }
    function onVoiceMotion(event) { if (motion) motion.speech(event.detail || {}); }
    function cleanupScene() {
      if (disposed) return;
      disposed = true;
      renderer.setAnimationLoop(null);
      if (motion) motion.dispose();
      if (stateObserver) stateObserver.disconnect();
      removalObserver.disconnect();
      window.removeEventListener('resize', sizeToCanvas);
      window.removeEventListener('alex-avatar-voice', onVoiceMotion);
      window.removeEventListener('pagehide', cleanupScene);
      if (rig.controls) rig.controls.dispose();
      if (window.AlexAvatar && window.AlexAvatar.__rig === rig) {
        delete window.AlexAvatar.__rig; delete window.AlexAvatar.__camera; delete window.AlexAvatar.__controls;
      }
      disposeObject(scene);
      Object.keys(teacherTextureCache).forEach(function (key) { teacherTextureCache[key].dispose(); });
      renderer.dispose();
      if (typeof draco !== 'undefined' && draco) draco.dispose();
      if (typeof ktx2 !== 'undefined' && ktx2) ktx2.dispose();
      delete window.__alexAvatarBootedTargets[targetId];
      if (canvas.parentNode) canvas.remove();
    }
    var removalObserver = new MutationObserver(function () { if (!canvas.isConnected) cleanupScene(); });
    removalObserver.observe(document.documentElement, {childList: true, subtree: true});
    window.addEventListener('resize', sizeToCanvas);
    window.addEventListener('alex-avatar-voice', onVoiceMotion);
    window.addEventListener('pagehide', cleanupScene);


    // Load avatar — try local GLB first, then remote fallback if local is missing.
    var loader = new GLTFLoader();
    // Some bundled avatars use Draco/KTX2/Meshopt compression; wire the decoders.
    try {
      if (DRACOLoader) {
        var draco = new DRACOLoader()
          .setDecoderPath('https://unpkg.com/three@0.160.0/examples/jsm/libs/draco/');
        loader.setDRACOLoader(draco);
      }
      if (KTX2Loader) {
        var ktx2 = new KTX2Loader()
          .setTranscoderPath(AVATAR_URL_BASE + 'basis/')
          .detectSupport(renderer);
        loader.setKTX2Loader(ktx2);
      }
      if (MeshoptDecoder) {
        loader.setMeshoptDecoder(MeshoptDecoder);
      }
    } catch (e) {
      warn('KTX2/Meshopt setup skipped:', e && e.message);
    }

    function loadWithFallback(urls, idx) {
      if (disposed) return;
      idx = idx || 0;
      if (idx >= urls.length) {
        warn('All GLB sources failed — keeping orb fallback.');
        cleanupScene();
        return;
      }
      var url = urls[idx];
      log('loading GLB:', url);
      loader.load(url, onLoaded, undefined, function onErr(err) {
        warn('GLB load failed (' + url + '):', err && (err.message || err));
        loadWithFallback(urls, idx + 1);
      });
    }

    function onLoaded(gltf) {
      var avatar = gltf.scene;
      if (disposed) { disposeObject(avatar); return; }
      function isEyeNodeName(name) {
        var nm = (name || '').toLowerCase();
        if (!nm) return false;
        return (
          nm === 'eyeleft' ||
          nm === 'eyeright' ||
          nm === 'lefteye' ||
          nm === 'righteye' ||
          nm.indexOf('eyeleft') !== -1 ||
          nm.indexOf('eyeright') !== -1 ||
          nm.indexOf('lefteye') !== -1 ||
          nm.indexOf('righteye') !== -1
        );
      }
      function looksLikeEyeMorphDictionary(dict) {
        if (!dict) return false;
        for (var key in dict) {
          if (!Object.prototype.hasOwnProperty.call(dict, key)) continue;
          var nm = key.toLowerCase();
          if (nm.indexOf('eye') !== -1 || nm.indexOf('eyes') !== -1) return true;
        }
        return false;
      }
      avatar.traverse(function (node) {
        if (node.isMesh) {
          if ((node.name || '').toLowerCase().indexOf('glasses') !== -1) {
            node.visible = false;
            return;
          }
          if (isEyeNodeName(node.name)) {
            rig.hasNativeEyes = true;
            rig.nativeEyeNodes.push(node.name || node.uuid);
          }
          node.castShadow = false;
          node.receiveShadow = false;
          node.frustumCulled = false;
          // ── Material fixes: proper skin tone + dark shirt ──────────────
          try {
            var mats = Array.isArray(node.material) ? node.material : [node.material];
            for (var mi = 0; mi < mats.length; mi++) {
              var mat = mats[mi];
              if (!mat || !mat.name) continue;
              // Debug: dump every material name so we can verify matching.
              log('mesh:', node.name, '→ material:', mat.name);
              var nm = mat.name.toLowerCase();
              var hasTextureMap = !!(mat.map && mat.map.isTexture);
              var isBundledAnimeMat = nm.indexOf('mat-') === 0;
              if (hasTextureMap && mat.map.colorSpace !== undefined) {
                mat.map.colorSpace = THREE.SRGBColorSpace;
              }

              // ── Classify each material so we can override its colour/roughness.
              // Must handle BOTH naming conventions:
              //   RPM (Wolf3D):  Wolf3D_Outfit_Top, Wolf3D_Skin, Wolf3D_Hair, …
              //   teacher_naoki: MAT-Body, MAT-skin, MAT-Hair, MAT-Body/Shoes, …

              // Skin (face/hands) — MUST be checked first so MAT-Body doesn't
              // get misclassified as "body" before we look for "skin".
              var isSkin = nm.indexOf('skin') !== -1 ||
                           nm.indexOf('head') !== -1 || nm.indexOf('face') !== -1 ||
                           mat.name === 'Wolf3D_Skin';

              // Hair
              var isHair = nm.indexOf('hair') !== -1;

              // Footwear / shoes
              var isFootwear = nm.indexOf('shoe') !== -1 ||
                               nm.indexOf('footwear') !== -1;

              // Eyes
              var isEye = (nm.indexOf('eye') !== -1 && nm.indexOf('white') === -1 &&
                           nm.indexOf('brow') === -1);
              var isEyeWhite = nm.indexOf('eyewhite') !== -1 ||
                               nm.indexOf('eye_white') !== -1 ||
                               nm.indexOf('sclera') !== -1;
              // Teeth
              var isTeeth = nm.indexOf('teeth') !== -1 || nm.indexOf('tooth') !== -1;

              // Pants / bottom
              var isPants = nm.indexOf('outfit_bottom') !== -1 ||
                            nm.indexOf('bottom') !== -1;

              // Suit jacket / body / outfit top — CATCH-ALL for anything covering
              // the torso that isn't skin, hair, eyes, teeth, shoes, or pants.
              // This handles RPM "Wolf3D_Outfit_Top" AND teacher_naoki "MAT-Body".
              var isTop = !isSkin && !isHair && !isFootwear && !isEye &&
                          !isEyeWhite && !isTeeth && !isPants && (
                            nm.indexOf('outfit_top') !== -1 ||
                            nm.indexOf('outfittop')  !== -1 ||
                            nm.indexOf('shirt')      !== -1 ||
                            nm.indexOf('body')       !== -1 ||    // MAT-Body
                            mat.name === 'Wolf3D_Outfit_Top' ||
                            mat.name === 'Wolf3D_Body'            // RPM combined body
                          );

              // Apply suit jacket.
              if (isTop) {
                log('  → suit jacket override on:', mat.name);
                if (isBundledAnimeMat) {
                  rig.hasTexturedOutfit = true;
                  forceTeacherTexture(mat, 'body');
                } else {
                  if (mat.color && mat.color.set) mat.color.set(0x1c2230);
                  try { mat.map = null; } catch (e) {}
                  mat.roughness = 0.78;
                  mat.metalness = 0.04;
                  if (mat.emissive && mat.emissive.set) mat.emissive.set(0x05070d);
                  mat.emissiveIntensity = 0.05;
                }
                mat.side = THREE.DoubleSide;
                mat.needsUpdate = true;
              }

              // Apply skin tone.
              if (isSkin && mat.color && mat.color.set) {
                log('  → skin override on:', mat.name);
                if (isBundledAnimeMat) {
                  rig.hasPaintedFace = true;
                  if (!hasTextureMap) rig.needsFaceFallback = true;
                  forceTeacherTexture(mat, 'skin');
                } else {
                  mat.color.set(0xefb892);
                  if ('roughness' in mat) mat.roughness = 0.52;
                  mat.metalness = 0.0;
                  if (mat.emissive && mat.emissive.set) mat.emissive.set(0x2a160c);
                  mat.emissiveIntensity = 0.025;
                }
                mat.needsUpdate = true;
              }

              // Apply hair.
              if (isHair && mat.color && mat.color.set) {
                log('  → hair override on:', mat.name);
                if (isBundledAnimeMat) {
                  forceTeacherTexture(mat, 'hair');
                } else {
                  mat.color.set(0x2a160a);
                  mat.roughness = 0.62;
                  mat.metalness = 0.05;
                }
                mat.needsUpdate = true;
              }

              // Apply pants.
              if (isPants && mat.color && mat.color.set) {
                mat.color.set(0x141926);
                try { mat.map = null; } catch (e) {}
                mat.roughness = 0.82;
                mat.metalness = 0.0;
                mat.needsUpdate = true;
              }

              // Apply shoes.
              if (isFootwear && mat.color && mat.color.set) {
                if (isBundledAnimeMat) {
                  rig.hasTexturedOutfit = true;
                  forceTeacherTexture(mat, 'body');
                } else {
                  mat.color.set(0x0a0a0e);
                  mat.roughness = 0.40;
                  mat.metalness = 0.10;
                }
                mat.needsUpdate = true;
              }

              // Eyes iris/pupil: sharp dark brown iris
              if (isEye && mat.color && mat.color.set) {
                rig.hasNativeEyes = true;
                mat.color.set(0x241208);
                mat.roughness = 0.12;
                mat.metalness = 0.0;
                if (mat.emissive && mat.emissive.set) mat.emissive.set(0x0c0502);
                mat.emissiveIntensity = 0.12;
                mat.needsUpdate = true;
              }

              // Eye whites: bright white sclera
              if (isEyeWhite && mat.color && mat.color.set) {
                mat.color.set(0xf2eee9);
                mat.roughness = 0.18;
                mat.metalness = 0.0;
                mat.needsUpdate = true;
              }

              // Teeth: clean white
              if (isTeeth && mat.color && mat.color.set) {
                mat.color.set(0xeeeae4);
                mat.roughness = 0.30;
                mat.metalness = 0.0;
                mat.needsUpdate = true;
              }
            }
          } catch (e) { warn('material fix failed', e); }
          if (node.morphTargetDictionary && node.morphTargetInfluences) {
            rig.morphMeshes.push(node);
            // Pick best available jaw/open morph by priority.
            var dict = node.morphTargetDictionary;
            // Eye blink/look morphs are facial animation data, not proof that
            // separate visible eye geometry exists. Some fallback anime GLBs
            // have these morph names but no eye meshes, so procedural eyes must
            // still be allowed to attach.
            if (looksLikeEyeMorphDictionary(dict)) {
              rig.nativeEyeNodes.push('eye-morphs:' + (node.name || node.uuid));
            }
            var priorities = [
              'jawOpen',        // ARKit (facecap + RPM ARKit)
              'mouthOpen',
              'viseme_aa',      // Oculus Visemes
              'viseme_O',
              'viseme_E',
              'viseme_U',
              'AH',
              'OH'
            ];
            for (var i = 0; i < priorities.length; i++) {
              if (priorities[i] in dict) {
                rig.viseme[node.uuid] = dict[priorities[i]];
                break;
              }
            }
          }
        }
        if (node.isBone || node.type === 'Bone') {
          var nm = (node.name || '').toLowerCase();
          if (!rig.head && (nm === 'head' || nm.indexOf(':head') !== -1 || nm.endsWith('head'))) {
            rig.head = node;
          }
          // RPM / Mixamo bone map — capture the upper body bones we need for posing
          // and gesture animation. Names vary (`LeftArm`, `mixamorig:LeftArm`, `arm_l`),
          // so we test suffixes.
          function pick(key, tests) {
            if (rig.bones[key]) return;
            for (var ti = 0; ti < tests.length; ti++) {
              if (nm === tests[ti] || nm.indexOf(tests[ti]) !== -1) {
                rig.bones[key] = node;
                return;
              }
            }
          }
          pick('leftShoulder',  ['leftshoulder']);
          pick('rightShoulder', ['rightshoulder']);
          pick('leftArm',       ['leftarm']);
          pick('rightArm',      ['rightarm']);
          pick('leftForeArm',   ['leftforearm']);
          pick('rightForeArm',  ['rightforearm']);
          pick('leftHand',      ['lefthand']);
          pick('rightHand',     ['righthand']);
          pick('neck',          ['neck']);
          pick('spine2',        ['spine2']);
          pick('spine1',        ['spine1']);
          pick('spine',         ['spine']);
          pick('hips',          ['hips']);
        }
      });

      rig.root = avatar;
      scene.add(avatar);

      // Slightly enlarge the head so the face reads better at small on-screen sizes.
      try {
        if (rig.head && rig.head.scale && rig.head.scale.multiplyScalar) {
          rig.head.scale.multiplyScalar(1.08);
        }
      } catch (eHeadScale) {
        warn('head scale tweak failed:', eHeadScale && eHeadScale.message);
      }

      // ── Apply natural rest pose (fix RPM's default T-pose) ──────────────
      // Verified empirically against the Wolf3D/RPM bind pose: the arm bone's
      // local +X axis rotates it from "straight out to the side" down toward
      // the body's side. +1.25 rad ≈ 72° of drop per arm puts hands alongside
      // the thighs; a tiny +Y splay keeps the arms from clipping the hips.
      (function applyRestPose() {
        function setRot(key, x, y, z) {
          var b = rig.bones[key];
          if (!b) return;
          b.rotation.set(x, y, z);
        }
        // Upper arms: the main "bring T-pose arms down" rotation.
        setRot('leftArm',       1.18,  0.08, -0.06);
        setRot('rightArm',      1.18, -0.08,  0.06);
        // Forearms: a subtle relaxed bend so hands sit just in front of the
        // thighs instead of locked flat.
        setRot('leftForeArm',   0.30, -0.04, -0.04);
        setRot('rightForeArm',  0.30,  0.04,  0.04);
        // Hands: neutral (the avatar's bind hand shape is already relaxed).
        setRot('leftHand',      0.08,  0.00, -0.10);
        setRot('rightHand',     0.08,  0.00,  0.10);

        // Record rest rotations so animations can modulate AROUND them rather
        // than overwriting (otherwise the arms snap back to T-pose).
        Object.keys(rig.bones).forEach(function (k) {
          var b = rig.bones[k];
          if (!b) return;
          rig.rest[k] = { x: b.rotation.x, y: b.rotation.y, z: b.rotation.z };
        });
        // Head + neck rest capture — CRITICAL. RPM avatars ship with a small
        // non-zero head bind rotation (chin-down a few degrees) and any
        // absolute overwrite on rig.head.rotation in the render loop would
        // snap the neck to a broken angle. Record the bind values here so
        // all head animation can be applied as a delta on top of them.
        if (rig.head) {
          rig.rest.head = {
            x: rig.head.rotation.x,
            y: rig.head.rotation.y,
            z: rig.head.rotation.z
          };
        }
      })();

      // ── Procedural tie (post-normalization, added after auto-frame) ──────
      // Stored on rig so startLoop() can call it once the avatar is scaled.
      rig._pendingSuitDetails = function () {
        try {
          // The bundled student avatar already has a jacket, shirt and tie baked
          // into its outfit texture. Extra procedural suit pieces are only for
          // generic fallback avatars.
          if (rig.hasTexturedOutfit) return;
          var anchorBone = rig.bones.neck || rig.bones.spine2 || rig.bones.spine1 || rig.bones.spine;
          if (!anchorBone) return;

          // Use a FIXED world-space size (avatar is normalised to 1 unit tall).
          // Neck bone sits at roughly 0.85–0.90 world units in a normalised RPM rig.
          // All geometry is in bone-LOCAL space, so we need bone-to-world scale.
          // Simplest approach: use a tiny fixed local unit = 0.06 (≈ shirt-collar width).
          var u = 0.06;

          var tieMat = new THREE.MeshStandardMaterial({
            color: 0x6e1a22, roughness: 0.30, metalness: 0.10,
            emissive: 0x1a050a, emissiveIntensity: 0.15
          });
          var knotMat = new THREE.MeshStandardMaterial({
            color: 0x50121a, roughness: 0.32, metalness: 0.10
          });
          var shirtMat = new THREE.MeshStandardMaterial({
            color: 0xf0ece4, roughness: 0.55, metalness: 0.0
          });

          // Shirt collar band — thin open cylinder, sits right at neck.
          var collarGeom = new THREE.CylinderGeometry(u * 0.95, u * 1.05, u * 0.55, 20, 1, true);
          var collar = new THREE.Mesh(collarGeom, shirtMat);
          collar.position.set(0, -u * 0.30, u * 0.05);
          collar.renderOrder = 5;

          // Tie knot.
          var knotGeom = new THREE.BoxGeometry(u * 0.70, u * 0.55, u * 0.32);
          var knot = new THREE.Mesh(knotGeom, knotMat);
          knot.position.set(0, -u * 0.88, u * 1.10);
          knot.renderOrder = 6;

          // Tie blade — simple flat box that tapers slightly.
          var tieGeom = new THREE.BoxGeometry(u * 0.52, u * 2.40, u * 0.08);
          var tie = new THREE.Mesh(tieGeom, tieMat);
          tie.position.set(0, -u * 2.30, u * 1.05);
          tie.rotation.x = 0.08;
          tie.renderOrder = 6;

          anchorBone.add(collar);
          anchorBone.add(knot);
          anchorBone.add(tie);
          rig.suit = { collar: collar, knot: knot, tie: tie };
          log('suit details attached (fixed-unit)');
        } catch (e) {
          warn('suit details failed:', e && e.message);
        }
      };

      // ── Procedural eyes ────────────────────────────────────────────────
      // The GLB's eye materials may not be detected by name, OR the eye geometry
      // may not exist at all. Attach two sphere meshes directly to the head bone
      // so the avatar always has visible eyes regardless of GLB structure.
      (function addProceduralEyes() {
        try {
          if (rig.needsFaceFallback && !rig.externalSkinLoaded) {
            addAnimeFaceFallback();
            return;
          }
          if (rig.hasNativeEyes || rig.hasPaintedFace) {
            log('native/painted eyes detected; skipping procedural eyes', rig.nativeEyeNodes);
            return;
          }
          if (!rig.head) {
            warn('no head bone — skipping procedural eyes');
            return;
          }
          // Find the face mesh to scale eyes proportional to head size.
          var headSize = 0.10; // sensible default in unit-scaled avatar space
          if (rig.morphMeshes.length) {
            var bb = new THREE.Box3();
            rig.morphMeshes.forEach(function (m) {
              if (!m.geometry) return;
              if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
              if (m.geometry.boundingBox) bb.union(m.geometry.boundingBox);
            });
            if (!bb.isEmpty()) {
              var s = bb.getSize(new THREE.Vector3());
              headSize = Math.max(s.x, s.y, s.z) * 0.5;
            }
          }
          // Eye dimensions — small relative to head.
          var eyeR = headSize * 0.042;          // sclera radius
          var irisR = eyeR * 0.55;              // iris disc radius
          var pupilR = eyeR * 0.22;             // pupil dot radius
          // Position relative to head bone's local frame. RPM head bones have
          // +Y up, +Z forward (face direction). Eyes sit slightly above origin
          // and forward of the head bone.
          var eyeY = headSize * 0.22;
          var eyeZ = headSize * 0.62;
          var eyeX = headSize * 0.18;

          // Sclera (white) material
          var scleraMat = new THREE.MeshStandardMaterial({
            color: 0xfaf6f0,
            roughness: 0.18,
            metalness: 0.0,
          });
          // Iris (warm light blue/grey for sharp gaze)
          var irisMat = new THREE.MeshStandardMaterial({
            color: 0x6b8ca8,
            roughness: 0.15,
            metalness: 0.0,
            emissive: 0x162028,
            emissiveIntensity: 0.4,
          });
          // Pupil (deep black)
          var pupilMat = new THREE.MeshStandardMaterial({
            color: 0x050505,
            roughness: 0.05,
            metalness: 0.0,
          });

          var sphereGeom = new THREE.SphereGeometry(eyeR, 24, 18);
          var irisGeom = new THREE.CircleGeometry(irisR, 24);
          var pupilGeom = new THREE.CircleGeometry(pupilR, 20);

          function makeEye(side) {
            var group = new THREE.Group();
            var sclera = new THREE.Mesh(sphereGeom, scleraMat);
            group.add(sclera);
            var iris = new THREE.Mesh(irisGeom, irisMat);
            iris.position.z = eyeR * 0.94;
            group.add(iris);
            var pupil = new THREE.Mesh(pupilGeom, pupilMat);
            pupil.position.z = eyeR * 0.96;
            group.add(pupil);
            group.position.set(side * eyeX, eyeY, eyeZ);
            // Make eyes render on top of head mesh so they don't z-fight.
            group.renderOrder = 10;
            sclera.renderOrder = 10;
            iris.renderOrder = 11;
            pupil.renderOrder = 12;
            return group;
          }

          var leftEye = makeEye(-1);
          var rightEye = makeEye(1);
          rig.head.add(leftEye);
          rig.head.add(rightEye);
          rig.eyes = { left: leftEye, right: rightEye };
          log('procedural eyes attached, headSize:', headSize.toFixed(3));
        } catch (e) {
          warn('procedural eyes failed:', e && e.message);
        }
      })();

      function addAnimeFaceFallback() {
        if (!rig.head || rig.faceFallbackGroup) return;
        try {
          var headSize = 0.17;
          if (rig.morphMeshes.length) {
            var bb = new THREE.Box3();
            rig.morphMeshes.forEach(function (m) {
              if (!m.geometry) return;
              if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
              if (m.geometry.boundingBox) bb.union(m.geometry.boundingBox);
            });
            if (!bb.isEmpty()) {
              var s = bb.getSize(new THREE.Vector3());
              headSize = Math.max(s.x, s.y, s.z) * 0.5;
            }
          }

          var group = new THREE.Group();
          group.name = 'AlexChromeSafeFaceFallback';
          group.renderOrder = 30;

          function mat(color, opacity) {
            return new THREE.MeshBasicMaterial({
              color: color,
              transparent: opacity < 1,
              opacity: opacity,
              depthTest: false,
              depthWrite: false,
              side: THREE.DoubleSide
            });
          }
          var whiteMat = mat(0xfaf3ee, 0.98);
          var irisMat = mat(0xc68da6, 1);
          var pupilMat = mat(0x231118, 1);
          var browMat = mat(0x160a08, 1);
          var noseMat = mat(0xd89d78, 0.72);
          var mouthMat = mat(0xf4d5c5, 0.9);

          var circle = new THREE.CircleGeometry(1, 32);
          var bar = new THREE.PlaneGeometry(1, 1);
          var eyeY = headSize * 0.20;
          var eyeZ = headSize * 0.64;
          var eyeX = headSize * 0.19;
          var eyeW = headSize * 0.105;
          var eyeH = headSize * 0.058;

          function ellipse(material, x, y, z, sx, sy) {
            var mesh = new THREE.Mesh(circle, material);
            mesh.position.set(x, y, z);
            mesh.scale.set(sx, sy, 1);
            mesh.renderOrder = 31;
            group.add(mesh);
            return mesh;
          }
          function rect(material, x, y, z, sx, sy, rz) {
            var mesh = new THREE.Mesh(bar, material);
            mesh.position.set(x, y, z);
            mesh.scale.set(sx, sy, 1);
            mesh.rotation.z = rz || 0;
            mesh.renderOrder = 32;
            group.add(mesh);
            return mesh;
          }

          [-1, 1].forEach(function (side) {
            ellipse(whiteMat, side * eyeX, eyeY, eyeZ, eyeW, eyeH);
            ellipse(irisMat, side * eyeX, eyeY - headSize * 0.002, eyeZ + headSize * 0.010, eyeH * 0.58, eyeH * 0.58);
            ellipse(pupilMat, side * eyeX, eyeY - headSize * 0.002, eyeZ + headSize * 0.014, eyeH * 0.25, eyeH * 0.25);
            rect(browMat, side * eyeX, eyeY + headSize * 0.080, eyeZ + headSize * 0.012, eyeW * 1.25, headSize * 0.012, side * -0.18);
          });

          rect(noseMat, 0, eyeY - headSize * 0.135, eyeZ + headSize * 0.016, headSize * 0.018, headSize * 0.050, 0.03);
          rect(mouthMat, 0, eyeY - headSize * 0.250, eyeZ + headSize * 0.018, headSize * 0.150, headSize * 0.012, 0);

          rig.head.add(group);
          rig.faceFallbackGroup = group;
          log('anime face fallback attached');
        } catch (e) {
          warn('anime face fallback failed:', e && e.message);
        }
      }

      // Auto-frame: normalize the avatar to a known scale, then frame the face tightly.
      // Handles full-body rigs (RPM, lots of bones) and head-only scans (facecap, no bones).
      try {
        // Collect visible meshes, ignoring bones/skeletons/helpers. For skinned meshes the
        // geometry's local bbox is more trustworthy than setFromObject (which inflates for
        // bone extents).
        var meshes = [];
        var boneCount = 0;
        avatar.traverse(function (n) {
          if (n.isMesh && n.visible !== false) meshes.push(n);
          if (n.isBone || n.type === 'Bone') boneCount++;
        });

        avatar.updateWorldMatrix(true, true);
        function worldBBoxUnion(list) {
          var b = new THREE.Box3();
          list.forEach(function (m) {
            if (!m.geometry) return;
            if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
            var gbb = m.geometry.boundingBox && m.geometry.boundingBox.clone();
            if (!gbb) return;
            gbb.applyMatrix4(m.matrixWorld);
            b.union(gbb);
          });
          return b;
        }
        var fullBox = worldBBoxUnion(meshes);
        if (fullBox.isEmpty()) fullBox.setFromObject(avatar);
        var size = fullBox.getSize(new THREE.Vector3());
        var center = fullBox.getCenter(new THREE.Vector3());

        // Normalize: scale avatar so its largest axis is 1 unit, center at origin.
        var maxDim = Math.max(size.x, size.y, size.z) || 1;
        var scale = 1.0 / maxDim;
        avatar.scale.multiplyScalar(scale);
        avatar.position.x -= center.x * scale;
        avatar.position.y -= center.y * scale;
        avatar.position.z -= center.z * scale;
        avatar.updateWorldMatrix(true, true);

        // Full-body rigs have many bones (skeleton hierarchy). A T-pose full-body's arm
        // span can be wide (~1.0m) so aspectTall alone is unreliable — bone count is the
        // stronger signal. Head-only scans typically have 0–2 bones.
        var aspectTall = size.y / Math.max(size.x, size.z);
        var isFullBody = boneCount >= 20 || (boneCount > 5 && aspectTall > 1.5);

        // Re-measure the avatar AFTER normalization so framing is based on actual world
        // coordinates (not assumptions about where it landed — the RPM scene root may not
        // re-center exactly to origin depending on its internal transforms).
        var postBox = worldBBoxUnion(meshes);
        if (postBox.isEmpty()) postBox.setFromObject(avatar);
        var postSize = postBox.getSize(new THREE.Vector3());
        var postCenter = postBox.getCenter(new THREE.Vector3());

        // Find the face mesh (one with visemes) and compute its bbox post-normalization.
        var faceMesh = null;
        for (var fi = 0; fi < rig.morphMeshes.length; fi++) {
          if (rig.viseme[rig.morphMeshes[fi].uuid] != null) { faceMesh = rig.morphMeshes[fi]; break; }
        }
        if (!faceMesh && rig.morphMeshes.length) faceMesh = rig.morphMeshes[0];
        var faceBox = faceMesh ? worldBBoxUnion([faceMesh]) : postBox.clone();
        if (faceBox.isEmpty()) faceBox = postBox.clone();
        var faceCenter = faceBox.getCenter(new THREE.Vector3());
        var faceSize = faceBox.getSize(new THREE.Vector3());

        var headY, frameHeight;
        if (isFullBody) {
          // Executive-portrait framing: aim at the face and frame just the
          // upper torso (head + shoulders + tie). This shows off the suit
          // instead of zooming out to the full body where details disappear.
          // faceCenter.y was measured above from the face mesh's world bbox.
          var faceYBias = postBox.min.y + postSize.y * 0.86;
          headY = (faceCenter && isFinite(faceCenter.y))
            ? faceCenter.y
            : faceYBias;
          // Pull the focal point down a touch so the shoulders sit in the
          // lower third of the frame instead of below it.
          headY -= postSize.y * 0.04;
          // Frame about a third of the body's height — head, shoulders, and
          // the top of the chest where the tie + collar will read clearly.
          frameHeight = postSize.y * 0.42;
        } else {
          // Head/face scan — frame the face with a bit of padding.
          headY = faceCenter.y;
          frameHeight = Math.max(faceSize.x * 1.35, faceSize.y * 1.15);
        }

        var fov = camera.fov * Math.PI / 180;
        var dist = (frameHeight / 2) / Math.tan(fov / 2) * 1.06;
        camera.position.set(0, headY, dist);
        camera.lookAt(0, headY, 0);
        camera.near = Math.max(0.001, dist * 0.02);
        camera.far = dist * 20;
        camera.updateProjectionMatrix();

        // Remember the post-normalization Y so the idle breathing anim can modulate
        // around it rather than overwriting the centering back to ~0.
        rig.restY = avatar.position.y;

        // Stash framing info on rig so OrbitControls can use the same focal point.
        rig.focus = new THREE.Vector3(0, headY, 0);
        rig.focusDist = dist;

        log('auto-framed — bones:', boneCount, 'aspectTall:', aspectTall.toFixed(2),
            'isFullBody:', isFullBody, 'headY:', headY.toFixed(3),
            'frameHeight:', frameHeight.toFixed(3), 'dist:', dist.toFixed(3));
      } catch (e) {
        warn('auto-frame failed, using defaults:', e && e.message);
      }

      // ── OrbitControls — let the user rotate the character ─────────────────
      // Constrained: no zoom/pan, limited yaw (±55°) and pitch (near horizontal).
      try {
        if (OrbitControls) {
          var controls = new OrbitControls(camera, canvas);
          controls.target.copy(rig.focus || new THREE.Vector3(0, 1.5, 0));
          controls.enableDamping = true;
          controls.dampingFactor = 0.08;
          controls.enableZoom = false;
          controls.enablePan = false;
          controls.rotateSpeed = 0.6;
          // Vertical limits: ~70°–100° polar (just above & below eye line)
          controls.minPolarAngle = Math.PI * 0.38;
          controls.maxPolarAngle = Math.PI * 0.56;
          // Horizontal limits: ±55° around the front
          controls.minAzimuthAngle = -Math.PI * 0.30;
          controls.maxAzimuthAngle =  Math.PI * 0.30;
          controls.update();
          rig.controls = controls;
          try { window.AlexAvatar.__controls = controls; } catch (e) {}
        }
      } catch (e) {
        warn('OrbitControls init failed:', e && e.message);
      }

      // Attach tie + collar now that the avatar is normalised to 1 unit tall.
      if (rig._pendingSuitDetails) { rig._pendingSuitDetails(); rig._pendingSuitDetails = null; }

      // Expose rig for debugging (window.AlexAvatar.__rig).
      try { window.AlexAvatar = window.AlexAvatar || {}; window.AlexAvatar.__rig = rig; window.AlexAvatar.__camera = camera; } catch (e) {}
      log('avatar loaded — morph meshes:', rig.morphMeshes.length, 'head bone:', !!rig.head,
          'arm bones:', !!(rig.bones.leftArm && rig.bones.rightArm));

      canvas.classList.add('alex-avatar-ready');
      orb.classList.add('alex-avatar-active');

      motion = createAvatarMotion(rig);
      startObservers();
      if (window.__alexAvatarVoiceEvent) motion.speech(window.__alexAvatarVoiceEvent);
      startLoop();
    }

    var urls = [AVATAR_URL];
    if (LOCAL_AVATAR_URL && urls.indexOf(LOCAL_AVATAR_URL) === -1) urls.push(LOCAL_AVATAR_URL);
    if (LOCAL_AVATAR_FALLBACK_URL && urls.indexOf(LOCAL_AVATAR_FALLBACK_URL) === -1) urls.push(LOCAL_AVATAR_FALLBACK_URL);
    if (REALISTIC_AVATAR_URL && urls.indexOf(REALISTIC_AVATAR_URL) === -1) urls.push(REALISTIC_AVATAR_URL);
    if (AVATAR_URL_FALLBACK && urls.indexOf(AVATAR_URL_FALLBACK) === -1) urls.push(AVATAR_URL_FALLBACK);
    loadWithFallback(urls);

    function startObservers() {
      function updateState() {
        // Voice events are authoritative for the call orb, including quiet listening.
        if (targetId === 'alex-orb' && window.__alex_voice_session_active && window.__alexAvatarVoiceEvent) {
          return;
        }
        var classes = (orb.className || '').split(/\s+/);
        var state = classes.indexOf('ai-speaking') !== -1 ? 'speaking' :
          classes.indexOf('user-speaking') !== -1 ? 'listening' :
          classes.indexOf('thinking') !== -1 ? 'thinking' : 'idle';
        motion.setState(state);
      }
      updateState();
      stateObserver = new MutationObserver(updateState);
      stateObserver.observe(orb, {attributes: true, attributeFilter: ['class']});
    }

    var clock = new THREE.Clock();
    function startLoop() {
      renderer.setAnimationLoop(function () {
        if (disposed || !canvas.isConnected) { cleanupScene(); return; }
        var dt = Math.min(0.05, clock.getDelta());
        var rect = canvas.getBoundingClientRect();
        if (document.hidden || rect.width === 0 || rect.height === 0 || orb.getClientRects().length === 0) return;
        motion.update(dt, sampleLoudness());

        if (rig.controls) {
          try { rig.controls.update(); } catch (e) {}
        }
        renderer.render(scene, camera);
      });
    }
  }

  window.AlexAvatarMount = boot;

  function bootDefaultAvatar() {
    boot(window.ALEX_AVATAR_TARGET_ID || 'alex-orb');
  }

  // Kick off when DOM is ready (handles both before/after DOMContentLoaded).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootDefaultAvatar, { once: true });
  } else {
    bootDefaultAvatar();
  }

  // Expose a tiny debug API.
  window.AlexAvatar = window.AlexAvatar || {};
  window.AlexAvatar.version = '0.3.0';
  window.AlexAvatar.isBooted = function (targetId) {
    var key = targetId || window.ALEX_AVATAR_TARGET_ID || 'alex-orb';
    return !!(window.__alexAvatarBootedTargets && window.__alexAvatarBootedTargets[key]);
  };
  // No-op stubs kept so older call sites (AlexAvatar.wave(), .nod()) don't throw.
  window.AlexAvatar.wave = function () {};
  window.AlexAvatar.nod  = function () {};
})();
