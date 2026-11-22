# AGENTS.md — Контекст проєкту Feria Polyglot для ШІ-агентів

Цей файл — єдина точка швидкого входу в контекст репозиторію **Feria Polyglot** (`Feria-Voice`). Перед редагуванням коду прочитай розділи **Карта файлів**, **Критичні інваріанти** та **Протокол перевірки**.

---

## 1. Огляд проєкту та стек

- **Призначення:** веб-застосунок голосового зв’язку та рунічного чату для D&D-партій (світ Ферії). Замінює Discord на мовно-орієнтовану маршрутизацію: невідомі мови спотворюються наживо через Web Audio (`AudioWorklet`) і шифруються в детерміновані руни на сервері; підтримує телепатичний шепіт, заклинання (`Comprehend Languages`, `Tongues`), сувої (Handouts), часткову розшифровку та live-конструктор мов.
- **Стек:**
  - **Backend:** Node.js (`>=18`, на Render зафіксовано Node `22`), CommonJS (`server.js`), Express `^4.21.2`, `ws` `^8.18.0`. Інших npm-залежностей немає і додавати без потреби не варто.
  - **Frontend:** Vanilla JS без збирача/бандлера — класичні IIFE-модулі (`public/js/*.js`), `AudioWorklet` (`scrambler-worklet.js`), WebRTC P2P + бінарний WebSocket PCM-релей.
  - **Збереження стану:** Upstash Redis REST API (у production/Render без persistent disk) із локальним fallback/кешем (`data/runtime-state.json` у KV-режимі, `data/campaign-state.json` як seed).
  - **Тести:** вбудований `node --test` (`npm test` — 83 тести у `test/*.test.js`).

---

## 2. Повна карта файлів

### Кореневі модулі (Node.js)
| Файл | Призначення |
| --- | --- |
| `server.js` | HTTP/Express + WebSocket сервер: авторизація ГМ (PIN), проекція мов і повідомлень для кожного слухача, детермінована транслітерація в руни, шепіт-ізоляція (чат, WebRTC сигналінг, аудіо-релей), `/api/health`, `/api/lobby`, `/api/rtc-config` (Cloudflare TURN + fallback OpenRelay), `POST /api/export-state`, 20s WS heartbeat, graceful `SIGTERM`/`SIGINT` flush. |
| `state-store.js` | `CampaignStore` (Upstash Redis REST із дебаунсом 300 мс, коалесценцією записів і distributed lock `feria:campaign-state:owner`), `normalizeState()`, `sanitizeGlyph()`, алфавіти `SCRIPT_ALPHABETS`, дефолтні гліфи `DEFAULT_GLYPHS`. |
| `validation.js` | `validateWsMessage()` для всіх 23 WS-типів, перевірки payload-лімітів, `RateLimiter` (token bucket для `chat`, `mutation`, `speaking`, `relay`, `signaling`, `pin`). |
| `dsp-presets.js` | `LEGACY_DSP_PRESETS` і `NATURAL_DSP_PRESETS`: автоматичний апгрейд старих агресивних мовних пресетів при завантаженні без перезапису кастомних налаштувань ГМа. |
| `render.yaml` | Render Blueprint: 1 web-інстанс (`numInstances: 1`), `region: frankfurt`, `npm ci && npm test`, `/api/health`, env-змінні (`FERIA_DM_PIN`, `UPSTASH_REDIS_*`, `CF_TURN_*`). |
| `data/campaign-state.json` | Git-відстежуваний seed кампанії (15 мов, 4 персонажі: `amenemhet`, `adrian`, `liora`, `jagatai`). У режимі Upstash **не перезаписується**. |
| `data/runtime-state.json` | Локальний кеш стану у KV-режимі (у `.gitignore`). |

### Клієнт (`public/`)
| Файл | Призначення |
| --- | --- |
| `public/index.html` | Розмітка лобі, голосової зали, конструктора мов, DM-панелі, рунічного чату, модалки сувоїв і підключення скриптів у чіткому порядку: `audio-protocol.js` → `dsp-bus-registry.js` → `peer-session.js` → `audio-engine.js` → `app.js`. |
| `public/css/styles.css` | Темно-фентезійна стилістика (гримуар, гравіровані таблички, унціальні/small-caps шрифти, індикатори `.conn-dot`, `.session-status`). |
| `public/js/audio-protocol.js` | UMD-модуль (браузер + `AudioWorklet` + Node): бінарний фрейм релею `v1` (`encodeRelayFrame`, `decodeRelayFrame`), `RelayPcmEncoder` (даунсемплінг у `24000 Hz`, чанки по `480` семплів = 20 мс, hold `800 ms`), `chunkRelayTargets` (макс. 8 ID у фреймі). |
| `public/js/dsp-bus-registry.js` | UMD-модуль: `DspBusRegistry` із ref-counting — спільні DSP-шини на пару `mode|preset`, щоб не дублювати важкі `AudioWorkletNode` і `ConvolverNode` для кожного гравця. |
| `public/js/peer-session.js` | UMD-модуль чистої WebRTC/сесійної логіки: `reconcilePeers`, `TransportStateMachine`, `PerfectNegotiator`, `shouldSendRelay`, `shouldPlayRelay`, `shouldSendSpeakingUpdate`, `capIceQueue`. |
| `public/js/scrambler-worklet.js` | Два `AudioWorkletProcessor`: `PolyglotScramblerProcessor` (рандомізовані гранули, формантний синтез голосних, м’який подих приголосних `burstEnv = 0.4`, обхід шумодаву поза тарабарщиною) та `PolyglotRelayTapProcessor` (zero-copy перенесення Int16 PCM із аудіо-потоку). |
| `public/js/audio-engine.js` | `PolyglotAudioEngine`: мікрофонний ланцюг (`HP 75Hz → LP 12kHz → DynamicsCompressorNode → 1.25x makeup → AnalyserNode → localGateGain → localDest` + `relayTap`), `DspBusRegistry`, перенесення `relaySources` при `attachPeerStream`, адаптивний `noiseFloor` (кап `0.0045`), анти-Edge `ensureKeepAliveAudio()` + `ensureRunning()`. |
| `public/js/app.js` | UI-рендеринг, WebSocket-клієнт + авто-реконект, завантаження `/api/rtc-config` перед з’єднанням, `watchServerBuild()` (авто-reload при новому `buildId`), керування `RTCPeerConnection` через `TransportStateMachine` і `PerfectNegotiator`, локальне збереження в `localStorage`. |

### Тести (`test/`)
- `test/deployment-config.test.js` — перевіряє `render.yaml`, `package.json`, наявність ключових слів у `README.md`, `.gitignore` та `<script>`-теги в `public/index.html`.
- `test/security-hardening.test.js` — `NODE_ENV=production` без PIN, експорт лише через `POST`, rate-limit за IP, Origin-перевірка WS, `/api/rtc-config` (OpenRelay / custom TURN / Cloudflare TURN кеш), 503 health при збої KV, захист історії шепоту між сесіями, lock-захист від старого інстансу, graceful shutdown.
- `test/integration.test.js` — повний життєвий цикл: руни/приховування мов, шепіт, відхилення великих фреймів, рестарт із відновленням зі fake-KV, бінарний та legacy-JSON PCM-релей.
- `test/peer-session.test.js` — `reconcilePeers`, `TransportStateMachine`, `PerfectNegotiator` (включно з glare + відновленням ICE після `answer`).
- `test/audio-engine-bus.test.js`, `test/audio-protocol.test.js`, `test/dsp-bus-registry.test.js`, `test/relay-worklet.test.js` — DSP-шини, гейтинг, імпульсні кліки, бінарний кодек/декодер, worklet.
- `test/state-store.test.js`, `test/validation.test.js`, `test/rules.test.js` — нормалізація, Upstash `kvCommand`, валідація WS і правила доступу до мов.

---

## 3. Ключові архітектурні потоки

### А. Живий аудіопотік (Вихідний + Вхідний)
1. **Захоплення мікрофона (`initLocalAudio` → `audioEngine.setLocalStream`):**
   - `getUserMedia` запускається з `echoCancellation: true`, `noiseSuppression: true`, `autoGainControl: false` (AGC вимкнено, бо він підсилює фоновий шум у паузах).
   - Ланцюг: `MediaStreamSource → HP (75 Hz) → LP (12 kHz) → DynamicsCompressor (-28 dB, ratio 3.5) → MakeupGain (1.25) → Analyser (fftSize 2048) + localGateGain → localDest (для WebRTC) → relayTap (AudioWorklet 24 kHz Int16)`.
   - Пороги шумодаву в `localVadTimer` (кожні 20 мс): адаптивний `noiseFloor` (обмежений зверху `0.0045`), гістерезис open/close, відсікання коротких кліків клавіатури/миші за crest-фактором (`crest > 12`), утримання `420 мс`.
2. **Транспорт («Прямий зв’язок» vs «Ретранслятор»):**
   - Клієнт перед входом завантажує `GET /api/rtc-config` (Google/Cloudflare STUN + Cloudflare TURN або fallback OpenRelay).
   - Усі WebRTC PC створюються синхронно в `setupPeerConnection` під керуванням `PerfectNegotiator` (ввічливість за порівнянням рядків `state.clientId > peerId`).
   - Поки з’єднання не в стані `connected`, клієнт тримає `relayTargetIds` відкритим (`shouldSendRelay(connState)`).
   - За відкритого WebSocket `transport.relayAvailable = true`; якщо пряме з’єднання не встановилось за `fallbackMs = 5000` мс, `TransportStateMachine` переходить у `RELAY` (`Ретранслятор`) і кожні `6s..30s` робить фонові `restartIce()`-проби без розриву аудіо-релею.
3. **Програвання та DSP на приймачі (`PolyglotAudioEngine`):**
   - Режими `resolveModeForPeer`: `GIBBERISH` (невідома мова або DM toggle), `ATMOSPHERIC` (відома не-Загальна мова при увімкненому тумблері), `CLEAN` (`common` або вимкнений тембр).
   - Всі піри з однаковим `(mode, dspPreset)` підключаються через індивідуальні `sendGain` (гучність/mute/whisper) до однієї спільної шини `DspBusRegistry`.

### Б. Протокол стану, шепіт і реплікація
- Сервер ніколи не довіряє клієнтському `senderId` / `fromClientId` — підставляє `client.id` з авторизованого сокета.
- Шепіт (`SET_WHISPER_TARGET`) фільтрується на рівні сервера у **трьох місцях**: `CHAT_MESSAGE`, `forwardRelayFrame` / `AUDIO_RELAY_CHUNK` та `WEBRTC_OFFER/ANSWER/ICE`. Майстер (ГМ) чує і бачить усі шепоти.
- Повторний `JOIN` тим самим персонажем (або DM) витісняє стару примарну сесію (`disconnectClient(other, true)`).

---

## 4. Критичні інваріанти (не зламати при змінах!)

1. **`pc.ontrack` не означає, що ICE з’єднався.**
   `ontrack` спрацьовує одразу після застосування SDP. Тому `state.remoteTrackPeers` відслідковує наявність треку, а `state.directAudioPeers` і `audioEngine.stopRelayPlayback(peerId)` викликаються **тільки** коли `isPcConnected(pc)` (`connected` / `completed`). Інакше гравець за NAT без прямого маршруту не почує і ретранслятор.
2. **Скидання `ignoreOffer` після WebRTC glare.**
   У `PerfectNegotiator.onRemoteDescription` при отриманні `answer` **обов’язково** скидати `this.ignoreOffer = false`. Без цього `impolite`-сторона після колізії оферів вічно відкидає ICE-кандидати співрозмовника.
3. **`RECONNECTING` не повинен блокувати релей.**
   У `TransportStateMachine` стан `RECONNECTING` тримає `probing = false`, а за відкритого WS `relayAvailable` має бути `true`, щоб співрозмовники не застрягали в «Перепідключення...».
4. **Плавне перенесення `relaySources` при `attachPeerStream`.**
   Перестворення `RTCPeerConnection` не повинно знищувати активні релейні буфери (`cleanupPeerConnection(..., { keepTransport: true })`, перенос `relaySources` і `nextRelayTime` у `attachPeerStream`).
5. **Фонові вкладки і Microsoft Edge (`SilentSinkSuspender` / `Sleeping Tabs`).**
   - `ensureKeepAliveAudio()` генерує інфразвуковий пілот (`18 Hz`, `gain = 0.00035`, `-69 dBFS`) у `MediaStreamDestination` і `ctx.destination`, вішає `<audio>` елементи в `document.body` і бере Web Lock `'feria-polyglot-audio-active'`.
   - У `localVadTimer` при `document.hidden === true || tickDelta > 150` поріг утримується відкритим (`gateHoldUntil = now + 2500`), щоб браузерний тротлінг `setInterval` (≥ 1000 мс) не закрив шумодав (420 мс).
   - `ensureRunning()` викликається на `visibilitychange`, `focus`, `blur`, `PEER_SPEAKING_UPDATE` та у 1-секундному тіку.
6. **Темно-фентезійна естетика без кольорових емодзі.**
   `sanitizeGlyph()` у `state-store.js` блокує `\p{Extended_Pictographic}`. Використовуйте лише монохромні рунічні/символьні гліфи (`◈❧ᛏΔΨ⸸ᛉ≈◉✦‡⊘Ѫ⌬ᚱ☽†♔❖`).
7. **Upstash REST API та Render single-instance.**
   - `CampaignStore.kvCommand` надсилає плоский JSON-масив `["SET", key, value]` (не вкладений `[[...]]`, бо Upstash повертає HTTP 400).
   - Сервер розрахований суворо на **1 інстанс** (реєстр `clients` і WebRTC-сигналінг живуть у RAM).
8. **Ізоляція тестів під середовищем Render.**
   Під час білду на Render встановлені `NODE_ENV=production` та `CF_TURN_*`. Тому `localEnv()` у `test/security-hardening.test.js` явно виставляє `NODE_ENV: 'test'` і скидає `CF_TURN_*` в `''` (інакше тести локального лобі й дефолтного OpenRelay падають).
9. **Пов’язані перевірки тестів при зміні конфігу.**
   `test/deployment-config.test.js` перевіряє структуру `render.yaml` (зокрема `branch: render-hardening`), наявність ключових слів у `README.md` та `<script>`-теги в `public/index.html`. Змінюючи їх — оновлюйте тест.
10. **Windows Git push обмеження для агентів.**
    У неінтерактивній оболонці агента `git push` зависає або падає через Git Credential Manager. Агент робить `git commit` локально, а користувач виконує `git push origin main` зі свого термінала.

---

## 5. Змінні оточення (Environment)

| Змінна | Де задається | Призначення |
| --- | --- | --- |
| `PORT` / `HOST` | Render / Env | Порт (`3456`) і хост слухання. |
| `FERIA_DM_PIN` | Render Secret | PIN-код Майстра. **Обов’язковий** при `NODE_ENV=production` (без нього сервер не стартує). |
| `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` | Render Secret | REST-доступ до Upstash Redis для збереження кампанії. |
| `STATE_KEY` | Render Env | Ключ кампанії у Redis (за замовчуванням `feria:campaign-state`). |
| `CF_TURN_KEY_ID` / `CF_TURN_API_TOKEN` | Render Secret | Автогенерація й кешування на 6 год (з `ttl: 86400`) токенів Cloudflare Realtime TURN. |
| `TURN_URL` / `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Опційно | Явний кастомний TURN (має вищий пріоритет над Cloudflare та OpenRelay). |
| `STUN_URLS`, `TURN_SHARED_SECRET`, `CF_TURN_API_URL` | Опційно | Перевизначення STUN / дефолтного OpenRelay / URL API Cloudflare (для тестів). |

---

## 6. Команди розробки та перевірки

```powershell
# Перевірка синтаксису перед запуском тестів
node --check server.js
node --check public/js/app.js
node --check public/js/audio-engine.js
node --check public/js/peer-session.js
node --check public/js/scrambler-worklet.js

# Повний набір тестів (імітація середовища Render)
$env:NODE_ENV='production'; npm test

# Локальний запуск
npm start
```

Очікуваний результат після змін: **усі 83/83 тестів** у `npm test` мають проходити (`fail 0`).

---

## 7. Протокол оновлення цього контексту (`AGENTS.md`)

Будь-який агент (або розробник) після значущої зміни має перевірити й за потреби оновити цей файл у тому ж коміті:
1. **Додали/перейменували файл чи `<script>`** → оновити розділ 2 (*Карта файлів*) і перевірити `test/deployment-config.test.js`.
2. **Додали WS-повідомлення або HTTP-ендпоінт** → зафіксувати у `validation.js`, `server.js` та розділі 2/3.
3. **Змінили логіку аудіо-графу, WebRTC state machine або фонового keep-alive** → оновити розділ 3 (*Ключові архітектурні потоки*) та розділ 4 (*Критичні інваріанти*).
4. **Додали змінну оточення або змінили Render Blueprint** → оновити розділ 5 (*Змінні оточення*) та кількість тестів у розділі 6.
