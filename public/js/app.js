(() => {
  // Server-supplied ICE config (STUN + TURN). Without TURN, players behind
  // symmetric NATs can never establish a direct path and stay on the relay.
  let ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ]
  };
  const rtcConfigPromise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch('/api/rtc-config', { cache: 'no-store', signal: controller.signal });
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data.iceServers) && data.iceServers.length) {
        ICE_CONFIG = { iceServers: data.iceServers };
      }
    } catch {
      // Keep the built-in STUN list if the endpoint is unavailable.
    } finally {
      clearTimeout(timeout);
    }
  })();

  const LS_KEYS = {
    NOISE_GATE: 'feria_noise_gate_pct',
    PEER_VOLUMES: 'feria_peer_volumes_v1',
    DM_BACKUP: 'feria_dm_backup_v1'
  };

  const audioEngine = new window.PolyglotAudioEngine();

  const state = {
    ws: null,
    clientId: null,
    role: null,
    character: null,
    activeLanguageId: 'common',
    languages: [],
    characters: [],
    peers: new Map(), // clientId -> peer object
    peerConnections: new Map(), // clientId -> RTCPeerConnection
    peerSenders: new Map(), // clientId -> RTCRtpSender
    peerConnStates: new Map(), // clientId -> 'connecting' | 'connected' | 'relay' | 'reconnecting'
    peerConnTimers: new Map(), // clientId -> timeout id (unused legacy hook)
    pendingIceCandidates: new Map(), // clientId -> RTCIceCandidateInit[]
    relayTargetIds: new Set(),
    relaySequence: 0,
    serverBuildId: null, // changes when a new deploy takes over
    joinPayload: null,
    reconnectAttempt: 0,
    reconnectTimer: null,
    transports: new Map(), // clientId -> TransportStateMachine
    negotiators: new Map(), // clientId -> PerfectNegotiator
    pcGenerations: new Map(), // clientId -> number (guards stale async work)
    maxIceCandidates: 64,
    peerPrefs: loadPeerPrefs(), // charKey -> { volume, muted }
    messages: [],
    localStream: null,
    outgoingStream: null,
    micMuted: false,
    micEnabled: false,
    hoveredLanguageId: null,
    replyPromptLang: null,
    replyPromptTimer: null,
    whisperTarget: null, // { clientId, characterId, name }
    latestSnapshot: null,
    pendingBackupSnapshot: null,
    dmLastRevealedTarget: 'ALL',
    activeHandoutMsgId: null,
    isBuilderPreviewing: false
  };

  function loadPeerPrefs() {
    try {
      const raw = localStorage.getItem(LS_KEYS.PEER_VOLUMES);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function savePeerPrefs() {
    try {
      localStorage.setItem(LS_KEYS.PEER_VOLUMES, JSON.stringify(state.peerPrefs));
    } catch {}
  }

  function getPeerPrefKey(peer) {
    return peer?.characterId || (peer?.role === 'dm' ? 'dm' : peer?.clientId);
  }

  function getPeerAudioPref(peer) {
    const key = getPeerPrefKey(peer);
    const p = state.peerPrefs[key];
    return {
      volume: typeof p?.volume === 'number' ? p.volume : 1.0,
      muted: !!p?.muted
    };
  }

  function setPeerAudioPref(peer, patch) {
    const key = getPeerPrefKey(peer);
    const cur = getPeerAudioPref(peer);
    state.peerPrefs[key] = { ...cur, ...patch };
    savePeerPrefs();
  }

  // DOM helpers
  const $ = (id) => document.getElementById(id);

  function showToast(text, duration = 4200) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = text;
    $('toastContainer').appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  function wsSend(payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(payload));
    }
  }

  function wsSendBinary(buffer) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(buffer);
    }
  }

  function setSessionStatus(status, text) {
    const el = $('sessionStatus');
    if (!el) return;
    el.dataset.state = status;
    const label = $('sessionStatusText');
    if (label) label.textContent = text;
  }

  const DEFAULT_GLYPHS = {
    common: '◈',
    elvish: '❧',
    dwarvish: 'ᛏ',
    draconic: 'Δ',
    infernal: 'Ψ',
    abyssal: '⸸',
    druidic: 'ᛉ',
    primordial: '≈',
    deep_speech: '◉',
    celestial: '✦',
    thieves_cant: '‡',
    undercommon: '⊘',
    kiros_ancient: 'Ѫ',
    niman_cipher: '⌬',
    steppe_turs: 'ᚱ',
    amenemhet: '☽',
    adrian: '†',
    liora: 'ᛉ',
    jagatai: 'ᚱ'
  };

  function sanitizeGlyph(icon, id, fallback = '✦') {
    const str = String(icon || '').trim();
    if (!str || /[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u.test(str)) {
      return DEFAULT_GLYPHS[id] || fallback;
    }
    return str;
  }

  function sanitizeSnapshotIcons(snap) {
    if (!snap) return snap;
    if (Array.isArray(snap.languages)) {
      snap.languages.forEach((l) => {
        if (l) l.icon = sanitizeGlyph(l.icon, l.id, '✦');
      });
    }
    if (Array.isArray(snap.characters)) {
      snap.characters.forEach((c) => {
        if (c) c.icon = sanitizeGlyph(c.icon, c.id, '❖');
      });
    }
    if (Array.isArray(snap.messages)) {
      snap.messages.forEach((m) => {
        if (m) m.senderIcon = sanitizeGlyph(m.senderIcon, m.senderCharacterId, m.senderCharacterId ? '❖' : '♔');
      });
    }
    return snap;
  }

  function getLanguage(langId) {
    return state.languages.find((l) => l.id === langId) || null;
  }

  // -------------------- LOBBY --------------------
  async function loadLobby(attempt = 0) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      let res;
      try {
        res = await fetch('/api/lobby', { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.buildId) state.serverBuildId = data.buildId;
      $('lobbyError').classList.add('hidden');

      const grid = $('lobbyCharacters');
      grid.innerHTML = '';

      data.characters.forEach((char) => {
        const btn = document.createElement('button');
        btn.className = 'lobby-char-card';
        btn.innerHTML = `
          <div class="char-avatar-badge" style="background:${char.avatarColor}22;border:1px solid ${char.avatarColor}">
            ${char.icon}
          </div>
          <div>
            <div class="lobby-char-name">${escapeHtml(char.name)}</div>
            <div class="lobby-char-title">${escapeHtml(char.title)}</div>
            ${char.online ? '<span class="online-pill">● У кімнаті</span>' : ''}
          </div>
        `;
        btn.addEventListener('click', () => connectAndJoin({ role: 'player', characterId: char.id }));
        grid.appendChild(btn);
      });

      const params = new URLSearchParams(window.location.search);
      const preselectChar = params.get('char');
      if (preselectChar && data.characters.some((c) => c.id === preselectChar)) {
        connectAndJoin({ role: 'player', characterId: preselectChar });
      }
    } catch (err) {
      if (attempt < 3) {
        showLobbyError('Сервер прокидається... зачекайте кілька секунд.');
        setTimeout(() => loadLobby(attempt + 1), 2500 * (attempt + 1));
      } else {
        showLobbyError('Не вдалося завантажити список персонажів із сервера.');
      }
    }
  }

  function showLobbyError(msg) {
    const el = $('lobbyError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  // Render may switch traffic to a new instance up to a minute before it stops
  // the old one. Move clients immediately so they do not keep mutating a stale
  // in-memory state that would later be flushed over the new instance's data.
  function watchServerBuild() {
    setInterval(async () => {
      if (!state.clientId || !state.joinPayload || state.intentionalLeave) return;
      try {
        const res = await fetch('/api/lobby', { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!state.serverBuildId) {
          state.serverBuildId = data.buildId;
        } else if (data.buildId && data.buildId !== state.serverBuildId) {
          state.serverBuildId = data.buildId;
          // A new deploy may ship new browser assets. Reconnecting the socket
          // alone would keep running the old JS, so do a full reload — the
          // campaign state comes back from the server on JOIN_SUCCESS.
          window.location.reload();
        }
      } catch {}
    }, 10000);
  }
  watchServerBuild();

  $('dmLoginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = $('dmPinInput').value.trim();
    connectAndJoin({ role: 'dm', pin });
  });

  // -------------------- WEBSOCKET CONNECTION --------------------
  async function connectAndJoin(joinPayload, attempt = 0) {
    await rtcConfigPromise;
    audioEngine.ensureInitialized().catch(() => {});
    state.intentionalLeave = false;
    state.joinPayload = joinPayload;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.ws) {
      try { state.ws.close(); } catch {}
    }
    setSessionStatus(state.clientId ? 'reconnecting' : 'connecting',
      state.clientId ? 'Відновлення з’єднання...' : 'Підключення...');

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}`);
    ws.binaryType = 'arraybuffer';
    state.ws = ws;

    ws.onopen = () => {
      if (state.ws !== ws) return;
      setSessionStatus('syncing', 'Синхронізація...');
      wsSend({ type: 'JOIN', relayProtocol: 2, ...joinPayload });
    };

    ws.onmessage = async (event) => {
      if (state.ws !== ws) return;
      if (event.data instanceof ArrayBuffer) {
        try {
          const frame = RelayProtocol.decodeRelayFrame(event.data);
          const peerState = state.peers.get(frame.senderId);
          if (!shouldPlayRelay(frame.senderId)) return;
          noteRelayFrame(frame.senderId);
          await audioEngine.playRelayedAudioChunk(frame.senderId, frame, peerState);
        } catch (err) {
          console.warn('Dropped malformed relay frame:', err.message);
        }
        return;
      }
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      // handleServerMessage is async; never leave a rejected negotiation unhandled.
      handleServerMessage(msg).catch((err) => {
        console.error('[ws] message handler failed:', err);
      });
    };

    ws.onclose = () => {
      if (state.ws !== ws || state.intentionalLeave) return;
      if (!state.clientId) {
        if (attempt < 3) {
          showLobbyError('Сервер прокидається... повторюємо підключення.');
          state.reconnectTimer = setTimeout(() => connectAndJoin(joinPayload, attempt + 1), 2500 * (attempt + 1));
        }
        return;
      }
      state.reconnectAttempt++;
      if (state.reconnectAttempt > 8) {
        setSessionStatus('offline', 'З’єднання втрачено');
        showToast('Не вдалося відновити з’єднання. Оновіть сторінку.');
        return;
      }
      const delay = Math.min(30000, 1000 * (2 ** Math.max(0, state.reconnectAttempt - 1)));
      setSessionStatus('reconnecting', `Відновлення з’єднання... (спроба ${state.reconnectAttempt})`);
      state.reconnectTimer = setTimeout(() => connectAndJoin(joinPayload, state.reconnectAttempt), delay);
    };
  }

  function sendCleanLeave() {
    state.intentionalLeave = true;
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    wsSend({ type: 'LEAVE' });
    if (state.ws) {
      try { state.ws.close(1000, 'User left'); } catch {}
    }
    setSessionStatus('offline', 'Ви вийшли');
  }

  window.addEventListener('beforeunload', () => {
    if (state.clientId) sendCleanLeave();
  });

  async function handleServerMessage(msg) {
    switch (msg.type) {
      case 'JOIN_ERROR':
        showLobbyError(msg.error);
        break;

      case 'JOIN_SUCCESS':
        state.clientId = msg.clientId;
        state.role = msg.role;
        state.character = msg.character;
        state.activeLanguageId = msg.activeLanguageId || 'common';
        state.languages = msg.languages || [];
        state.characters = msg.characters || [];
        state.messages = msg.messages || [];

        // A new clientId means every existing PC was negotiated under the old
        // identity; rebuild them from the authoritative snapshot below.
        resetPeerSessions();
        state.reconnectAttempt = 0;
        setSessionStatus('online', 'З’єднано');
        const joinedPeers = msg.peers || [];

        $('lobbyOverlay').classList.add('hidden');
        $('appShell').classList.remove('hidden');

        if (state.role === 'dm') {
          $('dmDashboard').classList.remove('hidden');
          $('dmHandoutControls').classList.remove('hidden');
          $('clearChatBtn').classList.remove('hidden');
          $('dmHearGibberishWrap').classList.remove('hidden');
          if (msg.fullStateSnapshot) {
            state.latestSnapshot = msg.fullStateSnapshot;
            checkAndOfferDmBackup(msg.fullStateSnapshot);
          }
        }

        initNoiseGateFromStorage();

        // Initialize microphone first so new peer connections get the outgoing
        // track; reconcile the peer list before rendering so cards are current.
        await initLocalAudio();
        applyPeerSnapshot(joinedPeers);

        renderIdentityHeader();
        renderLanguagePanel();
        renderPeersGrid();
        renderDmDashboard();
        renderChatMessages();
        updateActiveLanguageVisuals();
        break;

      case 'STATE_SYNC':
        state.character = msg.character;
        state.activeLanguageId = msg.activeLanguageId || state.activeLanguageId;
        state.languages = msg.languages || [];
        state.characters = msg.characters || [];
        if (Array.isArray(msg.messages)) state.messages = msg.messages;

        if (state.role === 'dm' && msg.fullStateSnapshot) {
          state.latestSnapshot = msg.fullStateSnapshot;
          saveDmBackup(msg.fullStateSnapshot);
        }

        applyPeerSnapshot(msg.peers || []);

        renderIdentityHeader();
        renderLanguagePanel();
        renderPeersGrid();
        renderDmDashboard();
        renderChatMessages();
        updateActiveLanguageVisuals();
        break;

      case 'IMPORT_SUCCESS':
        $('dmBackupRestoreBanner').classList.add('hidden');
        showToast('Кампанію та хроніку відновлено з резервної копії.');
        break;

      case 'SELF_WHISPER_UPDATED':
        if (msg.targetClientId || msg.targetCharacterId) {
          state.whisperTarget = {
            clientId: msg.targetClientId,
            characterId: msg.targetCharacterId,
            name: msg.targetName || 'Співрозмовник'
          };
          $('whisperTargetLabel').textContent = state.whisperTarget.name;
          $('whisperActiveBanner').classList.remove('hidden');
          $('chatInput').placeholder = `Телепатичний шепіт для ${state.whisperTarget.name}...`;
        } else {
          state.whisperTarget = null;
          $('whisperActiveBanner').classList.add('hidden');
          $('chatInput').placeholder = 'Записати фразу обраною мовою або текст напису...';
        }
        renderPeersGrid();
        break;

      case 'AUDIO_RELAY_CHUNK': {
        // Legacy base64 form, kept so an older server deployment still works.
        const peerState = state.peers.get(msg.fromClientId);
        if (!shouldPlayRelay(msg.fromClientId)) break;
        noteRelayFrame(msg.fromClientId);
        const binary = atob(msg.pcmBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        await audioEngine.playRelayedAudioChunk(msg.fromClientId, {
          pcm: new Int16Array(bytes.buffer),
          sampleRate: msg.sampleRate
        }, peerState);
        break;
      }

      case 'SELF_LANGUAGE_UPDATED':
        state.activeLanguageId = msg.languageId;
        renderLanguagePanel();
        renderPeersGrid();
        updateActiveLanguageVisuals();
        break;

      case 'PEER_JOINED':
        state.peers.set(msg.peer.clientId, msg.peer);
        setupPeerConnection(msg.peer.clientId).catch((err) => {
          console.warn('[webrtc] peer setup failed:', msg.peer.clientId, err.message);
        });
        renderPeersGrid();
        break;

      case 'PEER_LEFT':
        state.peers.delete(msg.clientId);
        cleanupPeerConnection(msg.clientId);
        renderPeersGrid();
        break;

      case 'PEER_LANGUAGE_UPDATE': {
        const peer = state.peers.get(msg.clientId);
        if (peer) {
          Object.assign(peer, msg);
          audioEngine.updatePeerLanguage(msg.clientId, peer);
          renderPeersGrid();
          checkReplyPromptForPeer(peer);
        }
        break;
      }

      case 'PEER_SPEAKING_UPDATE': {
        const peer = state.peers.get(msg.clientId);
        if (peer) {
          peer.isSpeaking = msg.isSpeaking;
          peer.speakingLevel = msg.speakingLevel;
          updatePeerSpeakingDom(peer);
          if (peer.isSpeaking) {
            checkReplyPromptForPeer(peer);
          }
        }
        break;
      }

      case 'FORCED_LANGUAGE_NOTICE':
        if (msg.active) {
          showToast(`Майстер увімкнув Режим Діалогу: ви зараз говорите мовою «${msg.languageName}».`);
        } else {
          showToast('Режим Діалогу завершено — ви повернулися на Загальну мову.');
        }
        break;

      case 'CHAT_MESSAGE_NEW':
        state.messages.push(msg.message);
        renderChatMessages();
        if (msg.message.isHandout) {
          openHandoutModal(msg.message);
        }
        break;

      case 'CHAT_MESSAGE_UPDATED': {
        const idx = state.messages.findIndex((m) => m.id === msg.message.id);
        if (idx >= 0) {
          state.messages[idx] = msg.message;
          renderChatMessages();
          if (state.activeHandoutMsgId === msg.message.id) {
            openHandoutModal(msg.message);
          }
        }
        break;
      }

      case 'CHAT_MESSAGE_DELETED':
        state.messages = state.messages.filter((m) => m.id !== msg.messageId);
        if (state.activeHandoutMsgId === msg.messageId) {
          state.activeHandoutMsgId = null;
          $('handoutModal').classList.add('hidden');
        }
        renderChatMessages();
        break;

      case 'CHAT_CLEARED':
        state.messages = [];
        state.activeHandoutMsgId = null;
        $('handoutModal').classList.add('hidden');
        renderChatMessages();
        break;

      case 'WEBRTC_OFFER':
        if (!isFreshSignaling(msg)) break;
        await handleWebRtcOffer(msg.fromClientId, msg.payload);
        break;

      case 'WEBRTC_ANSWER':
        if (!isFreshSignaling(msg)) break;
        await handleWebRtcAnswer(msg.fromClientId, msg.payload);
        break;

      case 'WEBRTC_ICE':
        if (!isFreshSignaling(msg)) break;
        await handleWebRtcIce(msg.fromClientId, msg.payload);
        break;

      case 'ERROR':
        showToast(msg.error);
        break;
    }
  }

  // -------------------- AUDIO & WEBRTC --------------------
  async function initLocalAudio(deviceId = null) {
    try {
      const constraints = {
        audio: deviceId
          // AGC pumps room noise and keyboard clicks up between words, which
          // defeats a noise gate. Keep browser NS/EC but fix the mic gain.
          ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: false }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
        video: false
      };

      const newStream = await navigator.mediaDevices.getUserMedia(constraints);
      if (state.localStream) {
        state.localStream.getTracks().forEach((t) => t.stop());
      }
      state.localStream = newStream;
      state.micEnabled = true;

      const track = newStream.getAudioTracks()[0];
      if (track) track.enabled = !state.micMuted;

      const gatedStream = await audioEngine.setLocalStream(newStream);
      state.outgoingStream = gatedStream || newStream;

      audioEngine.onLocalSpeakingChange = (isSpeaking, level) => {
        $('micLevelBar').style.width = `${Math.round(level * 100)}%`;
        wsSend({ type: 'SPEAKING_STATE', isSpeaking, level });
        const selfCard = document.querySelector('.peer-card.self-card');
        if (selfCard) selfCard.classList.toggle('speaking', isSpeaking);
      };

      audioEngine.onAudioRelayChunk = (pcmInt16, sampleRate) => {
        if (state.relayTargetIds.size === 0 || !state.clientId) return;
        try {
          const frame = RelayProtocol.encodeRelayFrame({
            senderId: state.clientId,
            targetIds: [...state.relayTargetIds],
            sampleRate,
            sequence: state.relaySequence++,
            pcm: pcmInt16
          });
          wsSendBinary(frame);
        } catch (err) {
          console.warn('Dropped relay chunk:', err.message);
        }
      };

      const outgoingTrack = state.outgoingStream.getAudioTracks()[0] || track;
      // Update any existing peer connections with the gated audio track
      for (const [peerId, sender] of state.peerSenders.entries()) {
        if (outgoingTrack && sender) {
          await sender.replaceTrack(outgoingTrack);
        }
      }

      await populateMicDevices();
      updateMicButtonUi();
    } catch (err) {
      state.micEnabled = false;
      updateMicButtonUi();
      showToast('Мікрофон недоступний (режим слухача). Натисніть «Мікрофон», щоб надати доступ або перевірте HTTPS.');
    }
  }

  async function populateMicDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === 'audioinput');
      const select = $('micSelect');
      const prev = select.value;
      select.innerHTML = '';
      mics.forEach((m, i) => {
        const opt = document.createElement('option');
        opt.value = m.deviceId;
        opt.textContent = m.label || `Мікрофон ${i + 1}`;
        select.appendChild(opt);
      });
      if (prev && mics.some((m) => m.deviceId === prev)) {
        select.value = prev;
      }
    } catch {}
  }

  function updateMicButtonUi() {
    const btn = $('micToggleBtn');
    const icon = $('micBtnIcon');
    const label = $('micBtnLabel');
    icon.textContent = '';
    if (!state.micEnabled) {
      btn.classList.add('muted');
      label.textContent = 'Увімкнути мік';
      return;
    }
    btn.classList.toggle('muted', state.micMuted);
    label.textContent = state.micMuted ? 'Вимкнено' : 'Мікрофон';
  }

  $('micToggleBtn').addEventListener('click', async () => {
    if (!state.micEnabled) {
      await initLocalAudio($('micSelect').value || null);
      return;
    }
    state.micMuted = !state.micMuted;
    const track = state.localStream?.getAudioTracks()[0];
    if (track) track.enabled = !state.micMuted;
    updateMicButtonUi();
  });

  $('micSelect').addEventListener('change', async (e) => {
    if (e.target.value) {
      await initLocalAudio(e.target.value);
    }
  });

  $('atmosphericToggle').addEventListener('change', (e) => {
    audioEngine.setAtmosphericEnabled(e.target.checked);
  });

  $('dmHearGibberishToggle').addEventListener('change', (e) => {
    audioEngine.setDmHearAsGibberish(e.target.checked);
  });

  function applyNoiseGatePct(pct) {
    const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
    $('noiseGateSlider').value = String(clamped);
    $('noiseGateLabel').textContent = `${clamped}%`;
    $('micGateMarker').style.left = `${clamped}%`;
    // The meter shows level = min(1, rms * 8). Put the marker at the same
    // RMS value it points to, so 15% really means "close below 0.019 RMS"
    // instead of the previous ~0.001 that left the gate permanently open.
    const threshold = clamped === 0 ? 0.0003 : Math.min(0.15, clamped / 800);
    audioEngine.setNoiseGateThreshold(threshold);
    try { localStorage.setItem(LS_KEYS.NOISE_GATE, String(clamped)); } catch {}
  }

  function initNoiseGateFromStorage() {
    let saved = 15;
    try {
      const raw = localStorage.getItem(LS_KEYS.NOISE_GATE);
      if (raw !== null) saved = Number(raw);
    } catch {}
    applyNoiseGatePct(saved);
  }

  $('noiseGateSlider').addEventListener('input', (e) => {
    applyNoiseGatePct(e.target.value);
  });

  $('stopWhisperBtn').addEventListener('click', () => {
    wsSend({ type: 'SET_WHISPER_TARGET', targetClientId: null, targetCharacterId: null });
  });

  $('selfMonitorBtn').addEventListener('click', async () => {
    const next = !audioEngine.selfMonitorEnabled;
    if (next && !state.micEnabled) {
      await initLocalAudio($('micSelect').value || null);
    }
    await audioEngine.enableSelfMonitor(next);
    $('selfMonitorBtn').classList.toggle('btn-active', next);
    $('selfMonitorMode').classList.toggle('hidden', !next);
    if (next) {
      audioEngine.updateSelfLanguagePreset(getLanguage(state.activeLanguageId));
    }
  });

  $('selfMonitorMode').addEventListener('change', (e) => {
    audioEngine.setSelfMonitorMode(e.target.value);
  });

  $('switchCharBtn').addEventListener('click', () => {
    sendCleanLeave();
    setTimeout(() => {
      window.location.href = window.location.pathname;
    }, 80);
  });

  function formatConnStateLabel(connState) {
    if (connState === 'connected') return '<span class="conn-dot connected"></span><span>Прямий зв’язок</span>';
    if (connState === 'relay') return '<span class="conn-dot relay"></span><span>Ретранслятор</span>';
    if (connState === 'reconnecting') return '<span class="conn-dot reconnecting"></span><span>Перепідключення...</span>';
    if (connState === 'failed') return '<span class="conn-dot failed"></span><span>Немає зв’язку</span>';
    return '<span class="conn-dot connecting"></span><span>З’єднання...</span>';
  }

  function setPeerConnState(peerId, connState) {
    if (state.peerConnStates.get(peerId) === connState) return;
    state.peerConnStates.set(peerId, connState);
    // Keep the relay tap armed for every state except a confirmed direct
    // connection. Otherwise a peer that never establishes WebRTC (common
    // across restrictive NATs) is never a relay target, so no relay audio is
    // ever sent, relay availability is never detected, and the UI is stuck on
    // "Перепідключення..." forever.
    if (window.PeerSession.shouldSendRelay(connState)) state.relayTargetIds.add(peerId);
    else {
      state.relayTargetIds.delete(peerId);
      // Drop relay audio that was already scheduled for playback; otherwise it
      // overlaps the fresh WebRTC stream and sounds like a loop.
      audioEngine.stopRelayPlayback(peerId);
    }
    audioEngine.setRelayTargetsCount(state.relayTargetIds.size);

    const card = document.querySelector(`.peer-card[data-client-id="${peerId}"]`);
    if (card) card.dataset.connState = connState;
    const badge = document.querySelector(`.peer-card[data-client-id="${peerId}"] .peer-conn-label`);
    if (badge) {
      badge.innerHTML = formatConnStateLabel(connState);
      badge.dataset.connState = connState;
    }
  }

  function getTransport(peerId) {
    let transport = state.transports.get(peerId);
    if (!transport) {
      transport = new window.PeerSession.TransportStateMachine({
        fallbackMs: 12000, baseBackoffMs: 1000, maxBackoffMs: 30000
      });
      transport.reset(Date.now());
      state.transports.set(peerId, transport);
    }
    return transport;
  }

  function noteRelayFrame(peerId) {
    const action = getTransport(peerId).noteRelayAvailable(Date.now());
    if (action === 'use-relay') setPeerConnState(peerId, 'relay');
  }

  function shouldPlayRelay(peerId) {
    return window.PeerSession.shouldPlayRelay(peerId, state.peers, state.transports);
  }

  function isFreshSignaling(msg) {
    // The server stamps fromClientId from the authenticated socket. Sessions get
    // a new id on every join, so stale signaling drops out naturally when the
    // peer snapshot is reconciled — no client-controlled epoch comparison.
    return typeof msg.fromClientId === 'string' && state.peers.has(msg.fromClientId);
  }

  function plainDescription(value) {
    if (!value) return value;
    const plain = typeof value.toJSON === 'function' ? value.toJSON() : { ...value };
    if (plain.type === undefined && value.type !== undefined) plain.type = value.type;
    if (plain.sdp === undefined && value.sdp !== undefined) plain.sdp = value.sdp;
    return plain;
  }

  function plainCandidate(value) {
    return value && typeof value.toJSON === 'function' ? value.toJSON() : value;
  }

  function getNegotiator(peerId) {
    let negotiator = state.negotiators.get(peerId);
    if (!negotiator) {
      negotiator = new window.PeerSession.PerfectNegotiator({
        polite: state.clientId > peerId,
        send: (description) => {
          wsSend({
            type: description.type === 'offer' ? 'WEBRTC_OFFER' : 'WEBRTC_ANSWER',
            targetClientId: peerId,
            payload: plainDescription(description)
          });
        }
      });
      state.negotiators.set(peerId, negotiator);
    }
    // clientId changes on every WS reconnect; politeness must follow it or both
    // sides can end up impolite and deadlock on glare.
    negotiator.polite = state.clientId > peerId;
    return negotiator;
  }

  /** Drops all WebRTC state built under a previous local clientId. */
  function resetPeerSessions() {
    for (const peerId of [...state.peers.keys()]) cleanupPeerConnection(peerId);
    state.peers = new Map();
    state.peerConnections.clear();
    state.peerSenders.clear();
    state.peerConnStates.clear();
    state.peerConnTimers.clear();
    state.pendingIceCandidates.clear();
    state.relayTargetIds.clear();
    state.transports.clear();
    state.negotiators.clear();
    state.pcGenerations.clear();
    audioEngine.setRelayTargetsCount(0);
  }

  function applyPeerSnapshot(snapshotPeers) {
    const snapshot = new Map((snapshotPeers || []).map((p) => [p.clientId, p]));
    const diff = window.PeerSession.reconcilePeers(state.peers, snapshot);
    for (const id of diff.removed) cleanupPeerConnection(id);
    state.peers = snapshot;
    for (const peer of diff.added) {
      setupPeerConnection(peer.clientId).catch((err) => {
        console.error('[webrtc] setup failed:', peer.clientId, err.message);
      });
    }
    for (const peer of diff.updated) {
      audioEngine.updatePeerLanguage(peer.clientId, peer);
    }
  }

  async function setupPeerConnection(peerId, forceInitiator = false) {
    cleanupPeerConnection(peerId, { keepTransport: true });
    const transport = getTransport(peerId);
    transport.reset(Date.now());
    setPeerConnState(peerId, 'connecting');

    const generation = (state.pcGenerations.get(peerId) || 0) + 1;
    state.pcGenerations.set(peerId, generation);
    const isCurrent = (pc) =>
      state.pcGenerations.get(peerId) === generation &&
      state.peerConnections.get(peerId) === pc &&
      pc.signalingState !== 'closed';

    let pc;
    try {
      pc = new RTCPeerConnection(ICE_CONFIG);
    } catch (err) {
      setPeerConnState(peerId, 'failed');
      throw err;
    }
    state.peerConnections.set(peerId, pc);
    const negotiator = getNegotiator(peerId);

    const peer = state.peers.get(peerId);
    if (peer) audioEngine.setPeerAudioPref(peerId, getPeerAudioPref(peer));

    const streamForSend = state.outgoingStream || state.localStream;
    const track = streamForSend?.getAudioTracks()[0];
    let sender;
    if (track) {
      sender = pc.addTrack(track, streamForSend);
    } else {
      sender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
    }
    state.peerSenders.set(peerId, sender);

    const checkConnection = () => {
      if (!isCurrent(pc)) return;
      const cState = pc.connectionState;
      const iState = pc.iceConnectionState;
      if (cState === 'connected' || iState === 'connected' || iState === 'completed') {
        transport.noteDirectConnected(Date.now());
        setPeerConnState(peerId, 'connected');
      } else if (cState === 'failed' || iState === 'failed' || cState === 'disconnected' || cState === 'closed') {
        transport.noteDirectFailure(Date.now());
        setPeerConnState(peerId, transport.canSendRelay ? 'relay' : 'reconnecting');
      }
    };
    pc.onconnectionstatechange = checkConnection;
    pc.oniceconnectionstatechange = checkConnection;

    // Perfect negotiation: onnegotiationneeded is the only offer source, so the
    // answerer never auto-offers after receiving a remote offer.
    pc.onnegotiationneeded = () => {
      if (!isCurrent(pc)) return;
      negotiator.onNegotiationNeeded(pc).catch((err) => {
        console.warn('[webrtc] negotiation failed:', peerId, err.message);
      });
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate || !isCurrent(pc)) return;
      const candidate = event.candidate.toJSON ? event.candidate.toJSON() : event.candidate;
      wsSend({ type: 'WEBRTC_ICE', targetClientId: peerId, payload: plainCandidate(candidate) });
    };

    pc.ontrack = async (event) => {
      if (!isCurrent(pc)) return;
      const stream = event.streams[0] || new MediaStream([event.track]);
      try {
        audioEngine.stopRelayPlayback(peerId);
        await audioEngine.attachPeerStream(peerId, stream, state.peers.get(peerId));
      } catch (err) {
        console.warn('[webrtc] attach stream failed:', peerId, err.message);
        return;
      }
      if (!isCurrent(pc)) return;
      const pref = getPeerAudioPref(state.peers.get(peerId));
      audioEngine.setPeerVolume(peerId, pref.volume);
      audioEngine.setPeerMuted(peerId, pref.muted);
    };

    if (forceInitiator) {
      try {
        await negotiator.onNegotiationNeeded(pc);
      } catch (err) {
        console.warn('[webrtc] initial offer failed:', peerId, err.message);
      }
    }
  }

  async function flushPendingIce(peerId, pc) {
    const queued = state.pendingIceCandidates.get(peerId);
    state.pendingIceCandidates.delete(peerId);
    if (!queued || queued.length === 0) return;
    for (const cand of queued) {
      try { await pc.addIceCandidate(new RTCIceCandidate(cand)); } catch {}
    }
  }

  async function handleWebRtcOffer(fromPeerId, offer) {
    let pc = state.peerConnections.get(fromPeerId);
    if (!pc || pc.signalingState === 'closed') {
      await setupPeerConnection(fromPeerId);
      pc = state.peerConnections.get(fromPeerId);
    }
    if (!pc) return;
    const negotiator = getNegotiator(fromPeerId);
    if (!await negotiator.onRemoteDescription(pc, offer)) return;
    if (negotiator.shouldAcceptCandidate()) await flushPendingIce(fromPeerId, pc);
  }

  async function handleWebRtcAnswer(fromPeerId, answer) {
    const pc = state.peerConnections.get(fromPeerId);
    if (!pc || pc.signalingState === 'closed') return;
    const negotiator = getNegotiator(fromPeerId);
    if (await negotiator.onRemoteDescription(pc, answer)) {
      await flushPendingIce(fromPeerId, pc);
    }
  }

  async function handleWebRtcIce(fromPeerId, candidate) {
    const negotiator = getNegotiator(fromPeerId);
    if (!negotiator.shouldAcceptCandidate()) return;
    const pc = state.peerConnections.get(fromPeerId);
    if (!pc || pc.signalingState === 'closed' || !pc.remoteDescription || !pc.remoteDescription.type) {
      const queued = state.pendingIceCandidates.get(fromPeerId) || [];
      queued.push(candidate);
      state.pendingIceCandidates.set(fromPeerId, window.PeerSession.capIceQueue(queued, state.maxIceCandidates));
      return;
    }
    try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch {}
  }

  function cleanupPeerConnection(peerId, options = {}) {
    clearTimeout(state.peerConnTimers.get(peerId));
    state.peerConnTimers.delete(peerId);
    state.peerConnStates.delete(peerId);
    state.pendingIceCandidates.delete(peerId);
    state.relayTargetIds.delete(peerId);
    state.negotiators.delete(peerId);
    if (!options.keepTransport) state.transports.delete(peerId);
    state.pcGenerations.set(peerId, (state.pcGenerations.get(peerId) || 0) + 1);
    audioEngine.setRelayTargetsCount(state.relayTargetIds.size);
    audioEngine.detachPeerStream(peerId);

    const pc = state.peerConnections.get(peerId);
    if (pc) {
      pc.onnegotiationneeded = null;
      pc.onicecandidate = null;
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try { pc.close(); } catch {}
    }
    state.peerConnections.delete(peerId);
    state.peerSenders.delete(peerId);
  }

  async function restartIce(peerId) {
    const pc = state.peerConnections.get(peerId);
    if (pc && pc.signalingState !== 'closed') {
      try {
        pc.restartIce();
        await getNegotiator(peerId).onNegotiationNeeded(pc);
        return;
      } catch (err) {
        console.warn('[webrtc] ICE restart failed:', peerId, err.message);
      }
    }
    await setupPeerConnection(peerId, true);
  }

  async function reconnectPeer(peerId) {
    showToast('Перепідключення аудіо-з’єднання...');
    getTransport(peerId).manualReconnect(Date.now());
    try {
      await restartIce(peerId);
    } catch (err) {
      console.error('[webrtc] manual reconnect failed:', err);
      setPeerConnState(peerId, 'failed');
    }
  }

  // Periodic transport ticks recover direct audio after a relay fallback.
  setInterval(() => {
    if (!state.clientId) return;
    const now = Date.now();
    for (const [peerId, transport] of state.transports) {
      if (!state.peers.has(peerId)) continue;
      const action = transport.tick(now);
      if (action === 'use-relay') {
        setPeerConnState(peerId, 'relay');
      } else if (action === 'restart-ice') {
        // Keep sending relay audio while probing if a relay path is known.
        if (!transport.relayAvailable) setPeerConnState(peerId, 'reconnecting');
        restartIce(peerId).catch((err) => {
          console.warn('[webrtc] scheduled restart failed:', peerId, err.message);
        });
      }
    }
  }, 1000);

  // -------------------- UI RENDERING --------------------
  function renderIdentityHeader() {
    if (state.role === 'dm') {
      $('myAvatarIcon').textContent = '♔';
      $('myDisplayName').textContent = 'Майстер (ГМ)';
      $('myRoleTitle').textContent = 'Володіє всіма мовами світу';
      $('myBuffsBar').innerHTML = '';
      return;
    }
    const c = state.character;
    if (!c) return;
    $('myAvatarIcon').textContent = c.icon;
    $('myAvatarIcon').style.borderColor = c.avatarColor;
    $('myDisplayName').textContent = c.name;
    $('myRoleTitle').textContent = c.title;

    const buffs = [];
    if (c.comprehendLanguages) buffs.push('<span class="buff-badge">Comprehend Languages</span>');
    if (c.tongues) buffs.push('<span class="buff-badge">Tongues</span>');
    $('myBuffsBar').innerHTML = buffs.join('');
  }

  function selectActiveLanguage(languageId) {
    if (state.activeLanguageId === languageId) return;
    wsSend({ type: 'ACTIVE_LANGUAGE_CHANGE', languageId });
    state.activeLanguageId = languageId;
    if (state.replyPromptLang && state.replyPromptLang.languageId === languageId) {
      $('replyPromptBanner').classList.add('hidden');
      state.replyPromptLang = null;
    }
    renderLanguagePanel();
    renderPeersGrid();
    updateActiveLanguageVisuals();
  }

  const ALTAR_RUNE_SAMPLES = {
    common: '',
    elvish: 'αεληθ ωλψ',
    runic: 'ᚠᚢᚦᚨ ᚱᚲᚷᚹ',
    infernal: 'ΨΩ∆ ‡ѮѲ',
    draconic: 'ΔΛΣ ᚠᚲᛉ',
    druidic: 'ᚠᚦ❧ ᛉᛟ',
    alien: '⊗⊕◈ ⌖⌗',
    ancient: 'ΑΒΓѢ ѦѮѰ',
    imperial: '⌬⌖⌸ §0F',
    steppe: 'ҚҒҢ ӨӘҖ',
    cipher: '†‡§ ◊※'
  };

  function updateActiveLanguageVisuals() {
    const lang = getLanguage(state.activeLanguageId) || { id: 'common', name: 'Загальна', icon: '◈', color: '#c89d54', scriptStyle: 'common' };
    const shell = $('appShell');
    const isForeign = lang.id !== 'common';
    const accentColor = isForeign ? lang.color : '#c89d54';

    shell.style.setProperty('--active-lang-color', accentColor);
    shell.classList.toggle('foreign-lang-active', isForeign);

    $('altarSealIcon').textContent = lang.icon;
    $('altarLangName').textContent = lang.name;
    $('altarRuneSample').textContent = ALTAR_RUNE_SAMPLES[lang.scriptStyle] || '';
    $('altarStatusText').textContent = isForeign
      ? 'Непосвячені чують лише тарабарщину та бачать рунічний шифр'
      : 'Голос звучить вільно — вас розуміють усі присутні';
    $('altarResetBtn').classList.toggle('hidden', !isForeign);

    const banner = $('activeLangBanner');
    banner.classList.toggle('hidden', !isForeign);
    $('activeLangBannerIcon').textContent = lang.icon;
    $('activeLangBannerName').textContent = lang.name;

    $('chatWritingLangBadge').textContent = `${lang.icon} ${lang.name}`;
    $('chatWritingLangBadge').style.borderColor = accentColor;

    if (!state.isBuilderPreviewing) {
      audioEngine.updateSelfLanguagePreset(lang);
    }
  }

  $('resetToCommonBtn').addEventListener('click', () => selectActiveLanguage('common'));
  $('altarResetBtn').addEventListener('click', () => selectActiveLanguage('common'));

  function renderLanguagePanel() {
    const container = $('languageButtonsContainer');
    container.innerHTML = '';

    const categories = [
      { key: 'standard', label: 'Стандартні мови' },
      { key: 'exotic', label: 'Екзотичні та таємні' },
      { key: 'feria', label: 'Мови та шифри Ферії' }
    ];

    categories.forEach((cat) => {
      const groupLangs = state.languages.filter((l) => l.category === cat.key);
      if (groupLangs.length === 0) return;

      const wrap = document.createElement('div');
      wrap.innerHTML = `<div class="lang-cat-label">${cat.label}</div>`;
      const grid = document.createElement('div');
      grid.className = 'lang-btn-grid';

      groupLangs.forEach((lang) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `lang-btn ${state.activeLanguageId === lang.id ? 'active' : ''}`;
        btn.style.setProperty('--lang-color', lang.color);
        btn.innerHTML = `<span class="lang-btn-icon">${lang.icon}</span><span class="lang-btn-name">${escapeHtml(lang.name)}</span>`;

        if (state.role === 'dm' && lang.id !== 'common') {
          const editSpan = document.createElement('span');
          editSpan.className = 'lang-edit-trigger';
          editSpan.title = 'Налаштувати звук і руни';
          editSpan.textContent = '❖';
          editSpan.addEventListener('click', (e) => {
            e.stopPropagation();
            openLangBuilder(lang);
          });
          btn.appendChild(editSpan);
        }

        btn.addEventListener('click', () => selectActiveLanguage(lang.id));

        if (state.role === 'dm') {
          btn.addEventListener('mouseenter', () => highlightUnderstanders(lang.id));
          btn.addEventListener('mouseleave', () => highlightUnderstanders(null));
        }

        grid.appendChild(btn);
      });

      wrap.appendChild(grid);
      container.appendChild(wrap);
    });
  }

  function highlightUnderstanders(langId) {
    state.hoveredLanguageId = langId;
    if (!langId) {
      $('hoverUnderstandHint').textContent = '';
      document.querySelectorAll('.peer-card').forEach((el) => el.classList.remove('understand-highlight'));
      return;
    }

    const lang = getLanguage(langId);
    const matchingChars = state.characters.filter(
      (c) => langId === 'common' || c.comprehendLanguages || c.tongues || (c.languages || []).includes(langId)
    );
    const names = matchingChars.map((c) => c.name);
    $('hoverUnderstandHint').textContent = names.length
      ? `Розуміють (${lang?.name}): ${names.join(', ')}`
      : `Розуміють (${lang?.name}): ніхто з гравців!`;

    document.querySelectorAll('.peer-card').forEach((card) => {
      const charId = card.dataset.characterId;
      const understands = charId && matchingChars.some((c) => c.id === charId);
      card.classList.toggle('understand-highlight', !!understands);
    });
  }

  function checkReplyPromptForPeer(peer) {
    if (!peer || peer.languageId === 'common' || !peer.understood || !peer.canReplyInLanguage) {
      if (state.replyPromptLang && peer && state.replyPromptLang.clientId === peer.clientId) {
        clearTimeout(state.replyPromptTimer);
        state.replyPromptLang = null;
        $('replyPromptBanner').classList.add('hidden');
      }
      return;
    }
    if (state.activeLanguageId === peer.languageId) return;

    state.replyPromptLang = peer;
    $('replyPromptText').innerHTML = `<strong>${escapeHtml(peer.displayName)}</strong> говорить мовою <strong>${peer.languageIcon} ${escapeHtml(peer.languageName)}</strong>`;
    $('replyPromptBanner').classList.remove('hidden');

    clearTimeout(state.replyPromptTimer);
    state.replyPromptTimer = setTimeout(() => {
      $('replyPromptBanner').classList.add('hidden');
      state.replyPromptLang = null;
    }, 10000);
  }

  $('replyPromptAcceptBtn').addEventListener('click', () => {
    if (state.replyPromptLang) {
      selectActiveLanguage(state.replyPromptLang.languageId);
    }
  });

  $('replyPromptDismissBtn').addEventListener('click', () => {
    $('replyPromptBanner').classList.add('hidden');
  });

  function renderPeersGrid() {
    const grid = $('peersGrid');
    grid.innerHTML = '';

    const selfLang = getLanguage(state.activeLanguageId) || { id: 'common', name: 'Загальна', icon: '◈', color: '#e2e8f0' };
    const selfCard = document.createElement('div');
    selfCard.className = 'peer-card self-card';
    selfCard.dataset.characterId = state.character?.id || '';
    selfCard.innerHTML = `
      <div class="peer-top">
        <div class="peer-avatar" style="background:${state.role === 'dm' ? '#c89d5422' : (state.character?.avatarColor + '22')};border:1px solid ${state.role === 'dm' ? '#c89d54' : state.character?.avatarColor}">
          ${state.role === 'dm' ? '♔' : (state.character?.icon || '❖')}
        </div>
        <div>
          <div class="peer-name">${escapeHtml(state.role === 'dm' ? 'Майстер (ГМ)' : state.character?.name)} (Ви)</div>
          <div class="peer-title">${escapeHtml(state.role === 'dm' ? 'Game Master' : state.character?.title || '')}</div>
        </div>
      </div>
      <div class="peer-lang-status" style="border-left: 3px solid ${selfLang.color}">
        <span>${selfLang.icon} ${escapeHtml(selfLang.name)}</span>
      </div>
    `;
    grid.appendChild(selfCard);

    for (const peer of state.peers.values()) {
      const card = document.createElement('div');
      card.className = `peer-card ${peer.isSpeaking ? 'speaking' : ''}`;
      card.dataset.clientId = peer.clientId;
      card.dataset.characterId = peer.characterId || '';

      const pref = getPeerAudioPref(peer);
      const volPct = Math.round(pref.volume * 100);
      const connState = state.peerConnStates.get(peer.clientId) || 'connecting';
      card.dataset.connState = connState;
      const isWhisperingToThis = state.whisperTarget &&
        (state.whisperTarget.clientId === peer.clientId ||
          (peer.characterId && state.whisperTarget.characterId === peer.characterId));

      let statusHtml;
      if (peer.mutedByWhisper) {
        statusHtml = `<div class="peer-lang-status unknown">
             <span>Таємний шепіт (не вам)</span>
           </div>`;
      } else if (peer.understood) {
        statusHtml = `<div class="peer-lang-status" style="border-left:3px solid ${peer.languageColor}">
             <span>${peer.languageIcon} ${escapeHtml(peer.languageName)}${peer.isWhisperToMe ? ' (Шепіт вам)' : ''}</span>
           </div>`;
      } else {
        statusHtml = `<div class="peer-lang-status unknown">
             <span>? Невідома мова${peer.isWhisperToMe ? ' (Шепіт вам)' : ''}</span>
             <span class="mystic-runes-anim">ᚠᚦᚱ</span>
           </div>`;
      }

      card.innerHTML = `
        <div class="peer-top">
          <div class="peer-avatar" style="background:${peer.avatarColor}22;border:1px solid ${peer.avatarColor}">
            ${peer.icon}
          </div>
          <div>
            <div class="peer-name">${escapeHtml(peer.displayName)}</div>
            <div class="peer-title">${escapeHtml(peer.title || '')}</div>
          </div>
        </div>
        ${statusHtml}
        <div class="peer-conn-row">
          <span class="peer-conn-label">${formatConnStateLabel(connState)}</span>
          <div class="peer-actions-row">
            <button type="button" class="btn btn-sm btn-ghost peer-whisper-btn ${isWhisperingToThis ? 'btn-active' : ''}" title="Телепатичний шепіт лише цьому гравцю" aria-label="Телепатичний шепіт для ${escapeHtml(peer.displayName)}" aria-pressed="${isWhisperingToThis ? 'true' : 'false'}">
              Шепіт
            </button>
            <button type="button" class="btn btn-sm btn-ghost peer-reconnect-btn" title="Перепідключити звук" aria-label="Перепідключити звук для ${escapeHtml(peer.displayName)}">↻</button>
          </div>
        </div>
        <div class="peer-volume-row">
          <button type="button" class="btn btn-sm btn-ghost peer-mute-btn" title="Вимкнути або увімкнути звук учасника" aria-label="Звук ${escapeHtml(peer.displayName)}" aria-pressed="${pref.muted ? 'true' : 'false'}">
            ${pref.muted ? 'Тихо' : 'Звук'}
          </button>
          <input type="range" min="0" max="2" step="0.05" value="${pref.volume}" aria-label="Гучність: ${escapeHtml(peer.displayName)}" />
          <span class="peer-vol-pct">${volPct}%</span>
        </div>
      `;

      const muteBtn = card.querySelector('.peer-mute-btn');
      muteBtn.addEventListener('click', () => {
        const cur = getPeerAudioPref(peer);
        const nextMuted = !cur.muted;
        setPeerAudioPref(peer, { muted: nextMuted });
        audioEngine.setPeerMuted(peer.clientId, nextMuted);
        muteBtn.textContent = nextMuted ? 'Тихо' : 'Звук';
      });

      const slider = card.querySelector('input[type="range"]');
      const pctLabel = card.querySelector('.peer-vol-pct');
      slider.addEventListener('input', (e) => {
        const v = Number(e.target.value);
        setPeerAudioPref(peer, { volume: v });
        audioEngine.setPeerVolume(peer.clientId, v);
        pctLabel.textContent = `${Math.round(v * 100)}%`;
      });

      card.querySelector('.peer-reconnect-btn').addEventListener('click', () => {
        reconnectPeer(peer.clientId);
      });

      card.querySelector('.peer-whisper-btn').addEventListener('click', () => {
        if (isWhisperingToThis) {
          wsSend({ type: 'SET_WHISPER_TARGET', targetClientId: null, targetCharacterId: null });
        } else {
          wsSend({
            type: 'SET_WHISPER_TARGET',
            targetClientId: peer.clientId,
            targetCharacterId: peer.characterId || null
          });
        }
      });

      // Audio prefs are seeded when the peer chain is created (see
      // setupPeerConnection) and applied by the mute/volume handlers — never
      // as a side effect of re-rendering the grid.
      grid.appendChild(card);
    }

    $('onlineCount').textContent = String(1 + state.peers.size);
  }

  function updatePeerSpeakingDom(peer) {
    const card = document.querySelector(`.peer-card[data-client-id="${peer.clientId}"]`);
    if (card) {
      card.classList.toggle('speaking', !!peer.isSpeaking);
    }
  }

  // -------------------- DM DASHBOARD --------------------
  function renderDmDashboard() {
    if (state.role !== 'dm') return;
    const container = $('dmCharactersMatrix');
    container.innerHTML = '';

    state.characters.forEach((char) => {
      const row = document.createElement('div');
      row.className = 'dm-char-row';

      const activeLang = getLanguage(state.activeLanguageId);
      const isForced = !!char.forcedLanguage;
      const forcedLangObj = isForced ? getLanguage(char.forcedLanguage) : null;

      row.innerHTML = `
        <div class="dm-char-header">
          <div class="peer-top">
            <div class="peer-avatar" style="background:${char.avatarColor}22;border:1px solid ${char.avatarColor};width:32px;height:32px;font-size:1rem">
              ${char.icon}
            </div>
            <div>
              <div class="peer-name">${escapeHtml(char.name)}</div>
              <div class="peer-title">${escapeHtml(char.title)}</div>
            </div>
          </div>
          <div class="dm-char-actions">
            <button class="btn btn-sm ${isForced ? 'btn-active' : ''}" data-action="dialogue">
              ${isForced ? `Діалог: ${escapeHtml(forcedLangObj?.name || '')}` : `Діалог (${escapeHtml(activeLang?.name || 'Загальна')})`}
            </button>
            <button class="btn btn-sm ${char.comprehendLanguages ? 'btn-active' : ''}" data-action="comprehend">
              Comprehend Languages
            </button>
            <button class="btn btn-sm ${char.tongues ? 'btn-active' : ''}" data-action="tongues">
              Tongues
            </button>
            <button class="btn btn-sm btn-danger" data-action="delete" title="Видалити персонажа">Видалити</button>
          </div>
        </div>
        <div class="dm-lang-chips"></div>
      `;

      row.querySelector('[data-action="dialogue"]').addEventListener('click', () => {
        wsSend({
          type: 'DM_FORCE_DIALOGUE',
          characterId: char.id,
          languageId: isForced ? null : state.activeLanguageId
        });
      });

      row.querySelector('[data-action="comprehend"]').addEventListener('click', () => {
        wsSend({
          type: 'DM_SET_MAGIC_BUFF',
          characterId: char.id,
          buff: 'comprehendLanguages',
          value: !char.comprehendLanguages
        });
      });

      row.querySelector('[data-action="tongues"]').addEventListener('click', () => {
        wsSend({
          type: 'DM_SET_MAGIC_BUFF',
          characterId: char.id,
          buff: 'tongues',
          value: !char.tongues
        });
      });

      row.querySelector('[data-action="delete"]').addEventListener('click', () => {
        if (confirm(`Видалити персонажа «${char.name}»?`)) {
          wsSend({ type: 'DM_DELETE_CHARACTER', characterId: char.id });
        }
      });

      const chipsBox = row.querySelector('.dm-lang-chips');
      state.languages.forEach((lang) => {
        if (lang.id === 'common') return;
        const isKnown = (char.languages || []).includes(lang.id);
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `dm-chip ${isKnown ? 'known' : ''}`;
        chip.style.setProperty('--chip-color', lang.color);
        chip.textContent = `${lang.icon} ${lang.name}`;
        chip.addEventListener('click', () => {
          wsSend({ type: 'DM_TOGGLE_CHAR_LANGUAGE', characterId: char.id, languageId: lang.id });
        });
        chipsBox.appendChild(chip);
      });

      container.appendChild(row);
    });
  }

  function saveDmBackup(snapshot) {
    if (!snapshot) return;
    try {
      localStorage.setItem(LS_KEYS.DM_BACKUP, JSON.stringify(snapshot));
    } catch {}
  }

  function checkAndOfferDmBackup(serverSnap) {
    try {
      const raw = localStorage.getItem(LS_KEYS.DM_BACKUP);
      if (!raw) {
        saveDmBackup(serverSnap);
        return;
      }
      const cached = JSON.parse(raw);
      const cachedCount = (cached.messages?.length || 0) + (cached.languages?.length || 0) + (cached.characters?.length || 0);
      const serverCount = (serverSnap.messages?.length || 0) + (serverSnap.languages?.length || 0) + (serverSnap.characters?.length || 0);

      if (cachedCount > serverCount && Array.isArray(cached.languages) && Array.isArray(cached.characters)) {
        state.pendingBackupSnapshot = sanitizeSnapshotIcons(cached);
        $('dmBackupRestoreText').textContent =
          `У браузері є резервна копія кампанії (повідомлень: ${cached.messages?.length || 0}, мов: ${cached.languages?.length || 0}, героїв: ${cached.characters?.length || 0}). Відновити її на сервері?`;
        $('dmBackupRestoreBanner').classList.remove('hidden');
      } else {
        saveDmBackup(serverSnap);
      }
    } catch {
      saveDmBackup(serverSnap);
    }
  }

  $('restoreBackupBtn').addEventListener('click', () => {
    if (state.pendingBackupSnapshot) {
      wsSend({ type: 'DM_IMPORT_STATE', snapshot: state.pendingBackupSnapshot });
      state.pendingBackupSnapshot = null;
    }
  });

  $('dismissBackupBtn').addEventListener('click', () => {
    $('dmBackupRestoreBanner').classList.add('hidden');
    if (state.latestSnapshot) saveDmBackup(state.latestSnapshot);
  });

  $('exportStateBtn').addEventListener('click', () => {
    const snap = state.latestSnapshot || {
      version: 1,
      exportedAt: Date.now(),
      languages: state.languages,
      characters: state.characters,
      messages: state.messages
    };
    const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `feria-campaign-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $('importStateBtn').addEventListener('click', () => {
    $('importStateFile').click();
  });

  $('importStateFile').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const snapshot = sanitizeSnapshotIcons(JSON.parse(reader.result));
        wsSend({ type: 'DM_IMPORT_STATE', snapshot });
      } catch {
        showToast('Не вдалося прочитати JSON-файл резервної копії.');
      }
      e.target.value = '';
    };
    reader.readAsText(file, 'utf8');
  });

  $('resetAllDialoguesBtn').addEventListener('click', () => {
    wsSend({ type: 'DM_RESET_FORCED_LANGUAGES' });
  });

  $('dmAddCharForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('newCharName').value.trim();
    if (!name) return;
    wsSend({
      type: 'DM_CREATE_CHARACTER',
      character: {
        name,
        title: $('newCharTitle').value.trim() || 'Авантюрист',
        icon: sanitizeGlyph($('newCharIcon').value.trim(), null, '❖'),
        avatarColor: $('newCharColor').value || '#c89d54',
        languages: ['common']
      }
    });
    $('newCharName').value = '';
    $('newCharTitle').value = '';
  });

  // -------------------- LANGUAGE BUILDER --------------------
  function readBuilderDspPreset() {
    return {
      grainSizeMs: Number($('lbGrain').value),
      pitchRatio: Number($('lbPitch').value),
      formantShiftHz: Number($('lbFormant').value),
      subOctaveMix: Number($('lbSub').value),
      ringModHz: Number($('lbRingHz').value),
      ringModMix: Number($('lbRingMix').value),
      reverbMix: Number($('lbReverb').value),
      chorusMix: Number($('lbChorus').value),
      filterType: $('lbFilterType').value,
      filterFreq: Number($('lbFilterFreq').value),
      atmosphereMix: 0.22
    };
  }

  function syncBuilderLabels() {
    $('valGrain').textContent = $('lbGrain').value;
    $('valPitch').textContent = Number($('lbPitch').value).toFixed(2);
    $('valFormant').textContent = $('lbFormant').value;
    $('valSub').textContent = Number($('lbSub').value).toFixed(2);
    $('valRingHz').textContent = $('lbRingHz').value;
    $('valRingMix').textContent = Number($('lbRingMix').value).toFixed(2);
    $('valReverb').textContent = Number($('lbReverb').value).toFixed(2);
    $('valChorus').textContent = Number($('lbChorus').value).toFixed(2);
    $('valFilterFreq').textContent = $('lbFilterFreq').value;

    if (state.isBuilderPreviewing) {
      audioEngine.updateSelfLanguagePreset({
        id: 'preview',
        dspPreset: readBuilderDspPreset()
      });
    }
  }

  ['lbGrain', 'lbPitch', 'lbFormant', 'lbSub', 'lbRingHz', 'lbRingMix', 'lbReverb', 'lbChorus', 'lbFilterType', 'lbFilterFreq'].forEach((id) => {
    $(id).addEventListener('input', syncBuilderLabels);
  });

  function openLangBuilder(lang = null) {
    $('langBuilderModal').classList.remove('hidden');
    if (lang) {
      $('langBuilderHeading').textContent = `Редагування мови: ${lang.name}`;
      $('lbId').value = lang.id;
      $('lbName').value = lang.name;
      $('lbCategory').value = lang.category || 'feria';
      $('lbIcon').value = lang.icon || '✦';
      $('lbColor').value = lang.color || '#c084fc';
      $('lbScriptStyle').value = lang.scriptStyle || 'ancient';

      const p = lang.dspPreset || {};
      $('lbGrain').value = p.grainSizeMs ?? 150;
      $('lbPitch').value = p.pitchRatio ?? 1.0;
      $('lbFormant').value = p.formantShiftHz ?? 0;
      $('lbSub').value = p.subOctaveMix ?? 0;
      $('lbRingHz').value = p.ringModHz ?? 0;
      $('lbRingMix').value = p.ringModMix ?? 0;
      $('lbReverb').value = p.reverbMix ?? 0.35;
      $('lbChorus').value = p.chorusMix ?? 0.2;
      $('lbFilterType').value = p.filterType || 'bandpass';
      $('lbFilterFreq').value = p.filterFreq ?? 1200;
      $('lbDeleteBtn').classList.remove('hidden');
    } else {
      $('langBuilderHeading').textContent = 'Конструктор мови чи шифру Ферії';
      $('lbId').value = '';
      $('lbName').value = '';
      $('lbCategory').value = 'feria';
      $('lbIcon').value = '✦';
      $('lbColor').value = '#c084fc';
      $('lbScriptStyle').value = 'ancient';
      $('lbGrain').value = 150;
      $('lbPitch').value = 0.92;
      $('lbFormant').value = -160;
      $('lbSub').value = 0.2;
      $('lbRingHz').value = 40;
      $('lbRingMix').value = 0.12;
      $('lbReverb').value = 0.45;
      $('lbChorus').value = 0.25;
      $('lbFilterType').value = 'bandpass';
      $('lbFilterFreq').value = 1100;
      $('lbDeleteBtn').classList.add('hidden');
    }
    syncBuilderLabels();
  }

  async function closeLangBuilder() {
    if (state.isBuilderPreviewing) {
      state.isBuilderPreviewing = false;
      $('lbTestVoiceBtn').classList.remove('btn-active');
      await audioEngine.enableSelfMonitor(false);
      $('selfMonitorBtn').classList.remove('btn-active');
      $('selfMonitorMode').classList.add('hidden');
      audioEngine.updateSelfLanguagePreset(getLanguage(state.activeLanguageId));
    }
    $('langBuilderModal').classList.add('hidden');
  }

  $('openLangBuilderBtn').addEventListener('click', () => openLangBuilder(null));
  $('closeLangBuilder').addEventListener('click', closeLangBuilder);
  $('lbCancelBtn').addEventListener('click', closeLangBuilder);

  $('lbTestVoiceBtn').addEventListener('click', async () => {
    state.isBuilderPreviewing = !state.isBuilderPreviewing;
    $('lbTestVoiceBtn').classList.toggle('btn-active', state.isBuilderPreviewing);

    if (state.isBuilderPreviewing) {
      if (!state.micEnabled) {
        await initLocalAudio($('micSelect').value || null);
      }
      audioEngine.setSelfMonitorMode('gibberish');
      audioEngine.updateSelfLanguagePreset({ id: 'preview', dspPreset: readBuilderDspPreset() });
      await audioEngine.enableSelfMonitor(true);
    } else {
      await audioEngine.enableSelfMonitor(false);
      audioEngine.updateSelfLanguagePreset(getLanguage(state.activeLanguageId));
    }
  });

  $('lbDeleteBtn').addEventListener('click', () => {
    const id = $('lbId').value;
    if (id && confirm('Видалити цю мову з кампанії?')) {
      wsSend({ type: 'DM_DELETE_LANGUAGE', languageId: id });
      closeLangBuilder();
    }
  });

  $('langBuilderForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = $('lbId').value.trim();
    const payload = {
      id: id || undefined,
      name: $('lbName').value.trim(),
      category: $('lbCategory').value,
      icon: sanitizeGlyph($('lbIcon').value.trim(), id, '✦'),
      color: $('lbColor').value,
      scriptStyle: $('lbScriptStyle').value,
      dspPreset: readBuilderDspPreset()
    };
    wsSend({
      type: id ? 'DM_UPDATE_LANGUAGE' : 'DM_CREATE_LANGUAGE',
      language: payload
    });
    closeLangBuilder();
  });

  // -------------------- RUNIC CHAT & HANDOUTS --------------------
  $('clearChatBtn').addEventListener('click', () => {
    if (confirm('Очистити всю хроніку повідомлень?')) {
      wsSend({ type: 'CLEAR_CHAT' });
    }
  });

  $('isHandoutCheck').addEventListener('change', (e) => {
    $('handoutTitleInput').classList.toggle('hidden', !e.target.checked);
  });

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (!text) return;

    const isHandout = state.role === 'dm' && $('isHandoutCheck').checked;
    const title = isHandout ? $('handoutTitleInput').value.trim() : '';

    // Omit an empty title entirely: validation treats '' as absent too, but
    // sending nothing keeps the wire format unambiguous for older servers.
    wsSend({
      type: 'CHAT_MESSAGE',
      text,
      isHandout,
      ...(title ? { title } : {}),
      languageId: state.activeLanguageId
    });

    $('chatInput').value = '';
    if (isHandout) {
      $('handoutTitleInput').value = '';
      $('isHandoutCheck').checked = false;
      $('handoutTitleInput').classList.add('hidden');
    }
  });

  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('chatForm').requestSubmit();
    }
  });

  function renderChatMessages() {
    const box = $('chatMessages');
    if (!state.messages.length) {
      box.innerHTML = '<div class="chat-empty-state">Повідомлення та древні написи з\'являться тут. Текст шифрується на сервері залежно від мови мовця!</div>';
      return;
    }

    const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = '';

    state.messages.forEach((msg) => {
      const card = document.createElement('div');
      card.className = `chat-msg ${msg.isHandout ? 'handout' : ''}`;

      const timeStr = new Date(msg.timestamp).toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
      const langDisplay = state.role === 'dm' && msg.originalLanguageName && msg.languageId !== msg.originalLanguageId
        ? `${msg.languageIcon} ${msg.originalLanguageName}`
        : `${msg.languageIcon} ${msg.languageName}`;

      const badges = [];
      if (msg.isWhisper) {
        badges.push(`<span class="whisper-badge">Телепатія${msg.whisperTargetName ? ` → ${escapeHtml(msg.whisperTargetName)}` : ''}</span>`);
      }
      if (msg.partiallyDeciphered) {
        badges.push(`<span class="decipher-badge">Розшифровано на ${msg.revealPercent}%</span>`);
      }
      if (msg.translatedForParty) {
        badges.push(`<span class="translated-badge">Переклав: ${escapeHtml(msg.translatedBy || 'Гравець')}</span>`);
      }
      if (state.role === 'dm' && msg.revealMap) {
        Object.entries(msg.revealMap).forEach(([charId, pct]) => {
          if (pct > 0) {
            const label = charId === 'ALL'
              ? 'Усі'
              : (state.characters.find((c) => c.id === charId)?.name || charId);
            badges.push(`<span class="decipher-badge">${escapeHtml(label)}: ${pct}%</span>`);
          }
        });
      }

      card.innerHTML = `
        <div class="chat-msg-head">
          <div class="chat-msg-sender">
            <span>${msg.senderIcon}</span>
            <span style="color:${msg.senderColor}">${escapeHtml(msg.senderName)}</span>
            <span class="sub-hint">${timeStr}</span>
          </div>
          <span class="lang-badge" style="border-color:${msg.languageColor}">
            ${escapeHtml(langDisplay)}
          </span>
        </div>
        ${msg.isHandout ? `<strong>${escapeHtml(msg.title || 'Древній Свиток / Напис')}</strong>` : ''}
        <div class="chat-msg-body ${msg.understood ? '' : 'runic-text'}">${escapeHtml(msg.text)}</div>
        ${badges.length ? `<div class="chat-msg-badges">${badges.join('')}</div>` : ''}
        <div class="chat-msg-controls"></div>
      `;

      const controls = card.querySelector('.chat-msg-controls');
      let hasControls = false;

      if (msg.isHandout) {
        hasControls = true;
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn btn-sm btn-brass';
        openBtn.textContent = 'Відкрити Свиток';
        openBtn.addEventListener('click', () => openHandoutModal(msg));
        controls.appendChild(openBtn);
      }

      // Player "Translate for party" button if they understand a foreign message
      const canTranslate = msg.understood && !msg.translatedForParty && msg.languageId !== 'common';
      if (canTranslate) {
        hasControls = true;
        const transBtn = document.createElement('button');
        transBtn.type = 'button';
        transBtn.className = 'btn btn-sm btn-arcane';
        transBtn.textContent = 'Перекласти групі';
        transBtn.addEventListener('click', () => {
          wsSend({ type: 'TRANSLATE_FOR_PARTY', messageId: msg.id });
        });
        controls.appendChild(transBtn);
      }

      // DM partial/full decipher controls
      if (state.role === 'dm' && msg.originalLanguageId !== 'common') {
        hasControls = true;
        const targetSel = document.createElement('select');
        targetSel.className = 'select-compact';
        const optAll = document.createElement('option');
        optAll.value = 'ALL';
        optAll.textContent = 'Усі гравці';
        targetSel.appendChild(optAll);
        state.characters.forEach((c) => {
          const opt = document.createElement('option');
          opt.value = c.id;
          opt.textContent = c.name;
          targetSel.appendChild(opt);
        });
        targetSel.value = state.dmLastRevealedTarget;
        targetSel.addEventListener('change', (e) => {
          state.dmLastRevealedTarget = e.target.value;
        });
        controls.appendChild(targetSel);

        [0, 25, 50, 100].forEach((pct) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'btn btn-sm btn-ghost';
          b.textContent = `${pct}%`;
          b.title = `Розшифрувати на ${pct}%`;
          b.addEventListener('click', () => {
            wsSend({
              type: 'REVEAL_MESSAGE',
              messageId: msg.id,
              characterId: targetSel.value,
              percent: pct
            });
          });
          controls.appendChild(b);
        });
      }

      if (state.role === 'dm') {
        hasControls = true;
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'btn btn-sm btn-danger chat-msg-delete-btn';
        delBtn.textContent = 'Видалити';
        delBtn.title = 'Видалити повідомлення з хроніки для всіх';
        delBtn.addEventListener('click', () => {
          wsSend({ type: 'DELETE_MESSAGE', messageId: msg.id });
        });
        controls.appendChild(delBtn);
      }

      if (!hasControls) {
        controls.remove();
      }

      box.appendChild(card);
    });

    if (wasAtBottom) {
      box.scrollTop = box.scrollHeight;
    }
  }

  function openHandoutModal(msg) {
    state.activeHandoutMsgId = msg.id;
    $('handoutModal').classList.remove('hidden');
    $('handoutModalTitle').textContent = msg.title || 'Древній Свиток / Напис';

    const badge = $('handoutModalLangBadge');
    badge.textContent = `${msg.languageIcon} ${msg.languageName}`;
    badge.style.borderColor = msg.languageColor;

    const body = $('handoutModalBody');
    body.textContent = msg.text;
    body.classList.toggle('runic-text', !msg.understood);

    const metaParts = [];
    if (msg.partiallyDeciphered) metaParts.push(`Розшифровано слів: ${msg.revealPercent}%`);
    if (msg.translatedForParty) metaParts.push(`Переклав: ${msg.translatedBy}`);
    $('handoutModalMeta').textContent = metaParts.join(' • ');

    const actions = $('handoutModalActions');
    actions.innerHTML = '';
    if (msg.understood && !msg.translatedForParty && msg.languageId !== 'common') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-arcane';
      btn.textContent = 'Поділитися перекладом з групою';
      btn.addEventListener('click', () => {
        wsSend({ type: 'TRANSLATE_FOR_PARTY', messageId: msg.id });
      });
      actions.appendChild(btn);
    }
    if (state.role === 'dm') {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger';
      delBtn.textContent = 'Видалити напис';
      delBtn.addEventListener('click', () => {
        wsSend({ type: 'DELETE_MESSAGE', messageId: msg.id });
      });
      actions.appendChild(delBtn);
    }
  }

  $('closeHandoutModal').addEventListener('click', () => {
    state.activeHandoutMsgId = null;
    $('handoutModal').classList.add('hidden');
  });

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Boot
  loadLobby();
})();
