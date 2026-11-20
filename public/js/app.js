(() => {
  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]
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
    peerVolumes: new Map(), // clientId -> 0..2
    messages: [],
    localStream: null,
    micMuted: false,
    micEnabled: false,
    hoveredLanguageId: null,
    replyPromptLang: null,
    dmLastRevealedTarget: 'ALL',
    activeHandoutMsgId: null,
    isBuilderPreviewing: false
  };

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

  function getLanguage(langId) {
    return state.languages.find((l) => l.id === langId) || null;
  }

  // -------------------- LOBBY --------------------
  async function loadLobby() {
    try {
      const res = await fetch('/api/lobby');
      const data = await res.json();
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
      showLobbyError('Не вдалося завантажити список персонажів із сервера.');
    }
  }

  function showLobbyError(msg) {
    const el = $('lobbyError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  $('dmLoginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const pin = $('dmPinInput').value.trim();
    connectAndJoin({ role: 'dm', pin });
  });

  // -------------------- WEBSOCKET CONNECTION --------------------
  function connectAndJoin(joinPayload) {
    if (state.ws) {
      try { state.ws.close(); } catch {}
    }

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}`);
    state.ws = ws;

    ws.onopen = () => {
      wsSend({ type: 'JOIN', ...joinPayload });
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      if (state.clientId) {
        showToast('З’єднання з сервером розірвано. Оновіть сторінку для повторного входу.');
      }
    };
  }

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

        state.peers.clear();
        (msg.peers || []).forEach((p) => state.peers.set(p.clientId, p));

        $('lobbyOverlay').classList.add('hidden');
        $('appShell').classList.remove('hidden');

        if (state.role === 'dm') {
          $('dmDashboard').classList.remove('hidden');
          $('dmHandoutControls').classList.remove('hidden');
          $('clearChatBtn').classList.remove('hidden');
        }

        renderIdentityHeader();
        renderLanguagePanel();
        renderPeersGrid();
        renderDmDashboard();
        renderChatMessages();
        updateActiveLanguageVisuals();

        // Initialize microphone & WebRTC connections
        await initLocalAudio();
        for (const peer of state.peers.values()) {
          setupPeerConnection(peer.clientId);
        }
        break;

      case 'STATE_SYNC':
        state.character = msg.character;
        state.activeLanguageId = msg.activeLanguageId || state.activeLanguageId;
        state.languages = msg.languages || [];
        state.characters = msg.characters || [];
        state.messages = msg.messages || [];

        (msg.peers || []).forEach((p) => {
          state.peers.set(p.clientId, p);
          audioEngine.updatePeerLanguage(p.clientId, p);
        });

        renderIdentityHeader();
        renderLanguagePanel();
        renderPeersGrid();
        renderDmDashboard();
        renderChatMessages();
        updateActiveLanguageVisuals();
        break;

      case 'SELF_LANGUAGE_UPDATED':
        state.activeLanguageId = msg.languageId;
        renderLanguagePanel();
        renderPeersGrid();
        updateActiveLanguageVisuals();
        break;

      case 'PEER_JOINED':
        state.peers.set(msg.peer.clientId, msg.peer);
        renderPeersGrid();
        setupPeerConnection(msg.peer.clientId);
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
          showToast(`👑 Майстер увімкнув Режим Діалогу: ви зараз говорите мовою «${msg.languageName}».`);
        } else {
          showToast('🗣️ Режим Діалогу завершено — ви повернулися на Загальну мову.');
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
        await handleWebRtcOffer(msg.fromClientId, msg.payload);
        break;

      case 'WEBRTC_ANSWER':
        await handleWebRtcAnswer(msg.fromClientId, msg.payload);
        break;

      case 'WEBRTC_ICE':
        await handleWebRtcIce(msg.fromClientId, msg.payload);
        break;

      case 'ERROR':
        showToast(`⚠️ ${msg.error}`);
        break;
    }
  }

  // -------------------- AUDIO & WEBRTC --------------------
  async function initLocalAudio(deviceId = null) {
    try {
      const constraints = {
        audio: deviceId
          ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
          : { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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

      await audioEngine.setLocalStream(newStream);
      audioEngine.onLocalSpeakingChange = (isSpeaking, level) => {
        $('micLevelBar').style.width = `${Math.round(level * 100)}%`;
        wsSend({ type: 'SPEAKING_STATE', isSpeaking, level });
        const selfCard = document.querySelector('.peer-card.self-card');
        if (selfCard) selfCard.classList.toggle('speaking', isSpeaking);
      };

      // Update any existing peer connections with the new audio track
      for (const [peerId, sender] of state.peerSenders.entries()) {
        if (track && sender) {
          await sender.replaceTrack(track);
        }
      }

      await populateMicDevices();
      updateMicButtonUi();
    } catch (err) {
      state.micEnabled = false;
      updateMicButtonUi();
      showToast('🎙️ Мікрофон недоступний (режим слухача). Натисніть «Мікрофон», щоб надати доступ або перевірте HTTPS.');
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
    if (!state.micEnabled) {
      btn.classList.add('muted');
      icon.textContent = '🔇';
      label.textContent = 'Увімкнути мік';
      return;
    }
    btn.classList.toggle('muted', state.micMuted);
    icon.textContent = state.micMuted ? '🔇' : '🎙️';
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
    window.location.href = window.location.pathname;
  });

  async function setupPeerConnection(peerId) {
    cleanupPeerConnection(peerId);
    const pc = new RTCPeerConnection(ICE_CONFIG);
    state.peerConnections.set(peerId, pc);

    const track = state.localStream?.getAudioTracks()[0];
    let sender;
    if (track) {
      sender = pc.addTrack(track, state.localStream);
    } else {
      const transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
      sender = transceiver.sender;
    }
    state.peerSenders.set(peerId, sender);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        wsSend({ type: 'WEBRTC_ICE', targetClientId: peerId, payload: event.candidate });
      }
    };

    pc.ontrack = async (event) => {
      const stream = event.streams[0] || new MediaStream([event.track]);
      const peerState = state.peers.get(peerId);
      await audioEngine.attachPeerStream(peerId, stream, peerState);
      const vol = state.peerVolumes.get(peerId);
      if (vol !== undefined) audioEngine.setPeerVolume(peerId, vol);
    };

    // Deterministic initiator to prevent WebRTC offer glare
    if (state.clientId < peerId) {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ type: 'WEBRTC_OFFER', targetClientId: peerId, payload: offer });
    }
  }

  async function handleWebRtcOffer(fromPeerId, offer) {
    let pc = state.peerConnections.get(fromPeerId);
    if (!pc) {
      await setupPeerConnection(fromPeerId);
      pc = state.peerConnections.get(fromPeerId);
    }
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({ type: 'WEBRTC_ANSWER', targetClientId: fromPeerId, payload: answer });
  }

  async function handleWebRtcAnswer(fromPeerId, answer) {
    const pc = state.peerConnections.get(fromPeerId);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(answer));
  }

  async function handleWebRtcIce(fromPeerId, candidate) {
    const pc = state.peerConnections.get(fromPeerId);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch {}
  }

  function cleanupPeerConnection(peerId) {
    audioEngine.detachPeerStream(peerId);
    const pc = state.peerConnections.get(peerId);
    if (pc) {
      try { pc.close(); } catch {}
    }
    state.peerConnections.delete(peerId);
    state.peerSenders.delete(peerId);
  }

  // -------------------- UI RENDERING --------------------
  function renderIdentityHeader() {
    if (state.role === 'dm') {
      $('myAvatarIcon').textContent = '👑';
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
    if (c.comprehendLanguages) buffs.push('<span class="buff-badge">🔮 Comprehend Languages</span>');
    if (c.tongues) buffs.push('<span class="buff-badge">🗣️ Tongues</span>');
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
    druidic: 'ᚠᚦ❦ ✿ᛟ',
    alien: '⊗⊕◈ ⌖⌗',
    ancient: 'ΑΒΓѢ ѦѮѰ',
    imperial: '⚙⌖⌬ §0F',
    steppe: 'ҚҒҢ ӨӘҖ',
    cipher: '†‡§ ◊※'
  };

  function updateActiveLanguageVisuals() {
    const lang = getLanguage(state.activeLanguageId) || { id: 'common', name: 'Загальна', icon: '🗣️', color: '#c89d54', scriptStyle: 'common' };
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
        btn.innerHTML = `<span>${lang.icon}</span><span>${escapeHtml(lang.name)}</span>`;

        if (state.role === 'dm' && lang.id !== 'common') {
          const editSpan = document.createElement('span');
          editSpan.className = 'lang-edit-trigger';
          editSpan.title = 'Налаштувати звук і руни';
          editSpan.textContent = '⚙️';
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
    if (!peer || peer.languageId === 'common') return;
    if (!peer.understood || !peer.canReplyInLanguage) return;
    if (state.activeLanguageId === peer.languageId) return;

    state.replyPromptLang = peer;
    $('replyPromptText').innerHTML = `🔔 <strong>${escapeHtml(peer.displayName)}</strong> говорить мовою <strong>${peer.languageIcon} ${escapeHtml(peer.languageName)}</strong>!`;
    $('replyPromptBanner').classList.remove('hidden');
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

    const selfLang = getLanguage(state.activeLanguageId) || { id: 'common', name: 'Загальна', icon: '🗣️', color: '#e2e8f0' };
    const selfCard = document.createElement('div');
    selfCard.className = 'peer-card self-card';
    selfCard.dataset.characterId = state.character?.id || '';
    selfCard.innerHTML = `
      <div class="peer-top">
        <div class="peer-avatar" style="background:${state.role === 'dm' ? '#eab30822' : (state.character?.avatarColor + '22')};border:1px solid ${state.role === 'dm' ? '#eab308' : state.character?.avatarColor}">
          ${state.role === 'dm' ? '👑' : (state.character?.icon || '🛡️')}
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

      const vol = state.peerVolumes.get(peer.clientId) ?? 1;
      const statusHtml = peer.understood
        ? `<div class="peer-lang-status" style="border-left:3px solid ${peer.languageColor}">
             <span>${peer.languageIcon} ${escapeHtml(peer.languageName)}</span>
           </div>`
        : `<div class="peer-lang-status unknown">
             <span>❓ Невідома мова</span>
             <span class="mystic-runes-anim">ᚠᚦᚱ</span>
           </div>`;

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
        <div class="peer-volume-row">
          <span>🔊</span>
          <input type="range" min="0" max="2" step="0.05" value="${vol}" />
        </div>
      `;

      const slider = card.querySelector('input[type="range"]');
      slider.addEventListener('input', (e) => {
        const v = Number(e.target.value);
        state.peerVolumes.set(peer.clientId, v);
        audioEngine.setPeerVolume(peer.clientId, v);
      });

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
              🔗 ${isForced ? `Діалог: ${escapeHtml(forcedLangObj?.name || '')}` : `Діалог (${escapeHtml(activeLang?.name || 'Загальна')})`}
            </button>
            <button class="btn btn-sm ${char.comprehendLanguages ? 'btn-active' : ''}" data-action="comprehend">
              🔮 Comprehend Languages
            </button>
            <button class="btn btn-sm ${char.tongues ? 'btn-active' : ''}" data-action="tongues">
              🗣️ Tongues
            </button>
            <button class="btn btn-sm btn-danger" data-action="delete" title="Видалити персонажа">🗑️</button>
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
        icon: $('newCharIcon').value.trim() || '🛡️',
        avatarColor: $('newCharColor').value || '#38bdf8',
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
      $('langBuilderHeading').textContent = `⚙️ Редагування мови: ${lang.name}`;
      $('lbId').value = lang.id;
      $('lbName').value = lang.name;
      $('lbCategory').value = lang.category || 'feria';
      $('lbIcon').value = lang.icon || '✨';
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
      $('langBuilderHeading').textContent = '✨ Конструктор мови / шифру Ферії';
      $('lbId').value = '';
      $('lbName').value = '';
      $('lbCategory').value = 'feria';
      $('lbIcon').value = '🕯️';
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
      icon: $('lbIcon').value.trim() || '✨',
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

    wsSend({
      type: 'CHAT_MESSAGE',
      text,
      isHandout,
      title,
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
      if (msg.partiallyDeciphered) {
        badges.push(`<span class="decipher-badge">🔍 Розшифровано на ${msg.revealPercent}%</span>`);
      }
      if (msg.translatedForParty) {
        badges.push(`<span class="translated-badge">🗣️ Переклав: ${escapeHtml(msg.translatedBy || 'Гравець')}</span>`);
      }
      if (state.role === 'dm' && msg.revealMap) {
        Object.entries(msg.revealMap).forEach(([charId, pct]) => {
          if (pct > 0) {
            const label = charId === 'ALL'
              ? 'Усі'
              : (state.characters.find((c) => c.id === charId)?.name || charId);
            badges.push(`<span class="decipher-badge">👁️ ${escapeHtml(label)}: ${pct}%</span>`);
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
        ${msg.isHandout ? `<strong>📜 ${escapeHtml(msg.title || 'Древній Свиток / Напис')}</strong>` : ''}
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
        openBtn.textContent = '📜 Відкрити Свиток';
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
        transBtn.textContent = '🗣️ Перекласти групі';
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
        delBtn.textContent = '🗑️ Видалити';
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
    if (msg.partiallyDeciphered) metaParts.push(`🔍 Розшифровано слів: ${msg.revealPercent}%`);
    if (msg.translatedForParty) metaParts.push(`🗣️ Переклав: ${msg.translatedBy}`);
    $('handoutModalMeta').textContent = metaParts.join(' • ');

    const actions = $('handoutModalActions');
    actions.innerHTML = '';
    if (msg.understood && !msg.translatedForParty && msg.languageId !== 'common') {
      const btn = document.createElement('button');
      btn.className = 'btn btn-arcane';
      btn.textContent = '🗣️ Поділитися перекладом з групою';
      btn.addEventListener('click', () => {
        wsSend({ type: 'TRANSLATE_FOR_PARTY', messageId: msg.id });
      });
      actions.appendChild(btn);
    }
    if (state.role === 'dm') {
      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-danger';
      delBtn.textContent = '🗑️ Видалити напис';
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
