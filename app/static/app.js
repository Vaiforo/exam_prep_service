let authToken = localStorage.getItem('examPrepToken') || '';
let currentUser = null;
let lastActivityPingAt = 0;
let activityTrackingBound = false;

const api = async (url, options = {}) => {
  const headers = {...(options.headers || {})};
  if(authToken) headers.Authorization = `Bearer ${authToken}`;
  const response = await fetch(url, {...options, headers});
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if(!response.ok){
    if(response.status === 401 && !url.startsWith('/api/auth/')) showAuth();
    throw new Error((data && data.detail) || response.statusText);
  }
  return data;
};

let topics = [];
let currentSession = null;
let currentIndex = 0;
let lastFeedback = null;
let flashcards = [];
let flashIndex = 0;
let flashFlipped = false;
let reportContext = null;
let theoryMode = localStorage.getItem('examPrepTheoryMode') || 'standard';
let pendingNoticeItems = [];
let currentNoticeItem = null;
let noticePollTimer = null;
let chatSocket = null;
let chatReconnectTimer = null;
let chatMode = 'saved';
let chatPeer = '';
let chatRoomId = null;
let chatRenderedIds = new Set();
let chatConversations = [];
let pendingChatFile = null;
let chatMessageCache = new Map();
let chatReplyTarget = null;
let chatEditingMessage = null;
let chatUnreadTotal = 0;
let chatPeerSuggestTimer = null;

const $ = id => document.getElementById(id);
const show = name => {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(name).classList.add('active');
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  updateReturnToTestButton(name);
  if (window.MathJax) MathJax.typesetPromise();
};
const toast = msg => { const t=$('toast'); t.textContent=msg; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'), 2500); };

async function pingActivity(force = false){
  if(!authToken) return;
  const now = Date.now();
  if(!force && now - lastActivityPingAt < 15000) return;
  lastActivityPingAt = now;
  try{ await api('/api/auth/ping', {method:'POST'}); }catch{}
}

function bindActivityTracking(){
  if(activityTrackingBound) return;
  activityTrackingBound = true;
  ['click', 'touchstart', 'keydown', 'mousemove', 'scroll'].forEach(eventName => {
    document.addEventListener(eventName, () => pingActivity(false), {passive:true});
  });
  document.addEventListener('visibilitychange', () => { if(!document.hidden) pingActivity(true); });
}

function initTheme(){
  const saved = localStorage.getItem('examPrepTheme') || 'light';
  applyTheme(saved);
}

function applyTheme(theme){
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = normalized;
  localStorage.setItem('examPrepTheme', normalized);
  const btn = $('themeToggle');
  if(btn) btn.textContent = normalized === 'dark' ? '☀️ Светлая тема' : '🌙 Тёмная тема';
}

function toggleTheme(){
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
}

async function init(){
  initTheme();
  bindEvents();
  bindActivityTracking();
  await checkAuth();
}

function bindEvents(){
  document.querySelectorAll('.nav').forEach(b => b.onclick = () => { show(b.dataset.view); if(b.dataset.view==='errors') loadErrors(); if(b.dataset.view==='results') loadResults(); if(b.dataset.view==='stats') loadStats(); if(b.dataset.view==='flashcards') initFlashcards(); if(b.dataset.view==='theory') renderTheoryTopic(); if(b.dataset.view==='dashboard') refreshCustomFlowInfo(); if(b.dataset.view==='chat') openChatPage(); });
  document.querySelectorAll('.mode').forEach(b => b.onclick = () => {
    const mode = b.dataset.mode;
    startTest({mode, count: mode === 'errors' ? 1000 : 20});
  });
  document.querySelectorAll('.readiness').forEach(b => b.onclick = () => startTest({mode:'readiness', readiness_level:Number(b.dataset.level), count:20}));
  document.querySelectorAll('.difficulty').forEach(b => b.onclick = () => startTest({mode:'difficulty', difficulty:b.dataset.difficulty, count:1000}));
  $('builderStart').onclick = startCustomFlow;
  $('builderContinue').onclick = continueCustomFlow;
  $('builderAllCount').onchange = updateBuilderCountMode;
  $('returnToTestBtn').onclick = returnToCurrentTest;
  $('builderAllTopics').onclick = () => setBuilderTopics(true);
  $('builderClearTopics').onclick = () => setBuilderTopics(false);
  document.querySelectorAll('.builder-difficulty').forEach(input => input.onchange = refreshCustomFlowInfo);
  $('backHome').onclick = () => { show('dashboard'); loadSummary(); };
  $('prevBtn').onclick = prevQuestion;
  $('checkBtn').onclick = checkCurrent;
  $('nextBtn').onclick = nextQuestion;
  $('exportBtn').onclick = exportProgress;
  $('importBtn').onclick = () => { $('importFile').value = ''; $('importFile').click(); };
  $('notificationsBtn').onclick = () => { show('notifications'); loadNotificationHistory(); };
  $('clearUserNotificationsBtn').onclick = clearUserNotifications;

  if($('chatSavedBtn')) $('chatSavedBtn').onclick = openSavedChat;
  if($('chatGroupBtn')) $('chatGroupBtn').onclick = openGroupChat;
  $('chatOpenDirectBtn').onclick = openDirectChatFromInput;
  $('chatPeerInput').addEventListener('input', handleChatPeerInput);
  $('chatPeerInput').addEventListener('keydown', event => { if(event.key === 'Enter'){ event.preventDefault(); openDirectChatFromInput(); } });
  document.addEventListener('click', event => {
    if(!event.target.closest('.chat-peer-row')) hideChatPeerSuggestions();
    if(!event.target.closest('.chat-dialog-menu-wrap')) document.querySelectorAll('.chat-dialog-menu').forEach(menu => menu.classList.add('hidden'));
    if(!event.target.closest('.chat-menu-btn') && !event.target.closest('.chat-message-menu')) closeChatMessageMenus();
  });
  $('chatRefreshDialogsBtn').onclick = () => loadChatConversations(true);
  $('chatCreateGroupBtn').onclick = showCreateChatRoomModal;
  $('chatSendBtn').onclick = sendChatText;
  $('chatAttachBtn').onclick = () => { $('chatFileInput').value = ''; $('chatFileInput').click(); };
  $('chatFileInput').onchange = event => { const file = event.target.files?.[0]; if(file) setPendingChatFile(file); event.target.value = ''; };
  $('chatInput').addEventListener('keydown', event => { if(event.key === 'Enter' && !event.shiftKey){ event.preventDefault(); sendChatText(); } });
  $('chatInput').addEventListener('paste', handleChatPaste);
  bindChatDragAndDrop();
  $('importFile').onchange = importProgress;
  $('themeToggle').onclick = toggleTheme;
  $('loginBtn').onclick = () => authSubmit('login');
  $('registerBtn').onclick = () => authSubmit('register');
  $('logoutBtn').onclick = logout;
  $('openTheoryBtn').onclick = renderTheoryTopic;
  $('theorySelect').onchange = renderTheoryTopic;
  $('flashPrev').onclick = prevFlashcard;
  $('flashNext').onclick = nextFlashcard;
  $('flashFlip').onclick = flipFlashcard;
  $('flashShuffle').onclick = shuffleFlashcards;
  $('flashcard').onclick = flipFlashcard;
  $('flashcard').onkeydown = (event) => { if(event.key === 'Enter' || event.key === ' '){ event.preventDefault(); flipFlashcard(); } };
  $('reportSubmit').onclick = submitReport;
  $('reportCancel').onclick = closeReportPanel;
  $('repeatErrorsTopBtn').onclick = () => startTest({mode:'errors', count:1000});
  $('refreshResultsBtn').onclick = loadResults;
  $('backToResultsBtn').onclick = () => { show('results'); loadResults(); };
}

async function checkAuth(){
  if(!authToken){ showAuth(); return; }
  try{
    currentUser = await api('/api/auth/me');
    await showApp();
  }catch{
    authToken = '';
    localStorage.removeItem('examPrepToken');
    showAuth();
  }
}

function showAuth(){
  stopNotificationPolling();
  disconnectChatSocket();
  pendingNoticeItems = [];
  currentNoticeItem = null;
  $('siteNotice')?.classList.add('hidden');
  $('noticeOverlay')?.classList.add('hidden');
  document.body.classList.remove('notice-open');
  $('authView').classList.remove('hidden');
  $('appLayout').classList.add('hidden');
  $('userBox').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
  $('exportBtn').classList.add('hidden');
  $('importBtn').classList.add('hidden');
  $('notificationsBtn').classList.add('hidden');
}

async function showApp(){
  reportPageLoadMetric();
  $('authView').classList.add('hidden');
  $('appLayout').classList.remove('hidden');
  $('userBox').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  $('exportBtn').classList.remove('hidden');
  $('importBtn').classList.remove('hidden');
  $('notificationsBtn').classList.remove('hidden');
  $('userBox').textContent = `Пользователь: ${currentUser.username}`;
  await pingActivity(true);
  await loadTopics();
  await loadSummary();
  await loadSiteNotifications(true);
  await loadChatUnreadCount();
  connectChatSocket();
  startNotificationPolling();
  show('dashboard');
  updateBuilderCountMode();
  await refreshCustomFlowInfo();
}


async function authSubmit(mode){
  const username = $('authUsername').value.trim();
  const password = $('authPassword').value;
  if(username.length < 3 || password.length < 4){ toast('Логин от 3 символов, пароль от 4 символов'); return; }
  const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
  try{
    const result = await api(endpoint, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username, password})});
    authToken = result.token;
    currentUser = result.user;
    localStorage.setItem('examPrepToken', authToken);
    toast(mode === 'register' ? 'Аккаунт создан' : 'Вход выполнен');
    await showApp();
  }catch(err){
    toast(err.message || 'Ошибка входа');
  }
}

async function logout(){
  stopNotificationPolling();
  disconnectChatSocket();
  try{ await api('/api/auth/logout', {method:'POST'}); }catch{}
  authToken = '';
  currentUser = null;
  localStorage.removeItem('examPrepToken');
  showAuth();
}

function reportPageLoadMetric(){
  try{
    if(!authToken || sessionStorage.getItem('pageLoadMetricSent') === '1') return;
    const nav = performance.getEntriesByType('navigation')[0];
    const duration = nav ? nav.duration : performance.now();
    if(!duration || duration < 0) return;
    sessionStorage.setItem('pageLoadMetricSent', '1');
    api('/api/metrics/page-load', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({duration_ms:duration, page:'main', route:location.pathname})
    }).catch(() => {});
  }catch{}
}

async function loadTopics(){
  topics = await api('/api/topics');
  $('topicsList').innerHTML = topics.map(t => `
    <article class="topic-card">
      <h3>${t.external_id}. ${escapeHtml(t.title)}</h3>
      <p class="muted">Вопросов: ${t.questions_count}</p>
      <div class="topic-buttons">
        <button onclick="startTest({mode:'topic', topic_id:${t.id}, count:${t.questions_count || 1500}})">Тренировать тему</button>
        <button class="secondary" onclick="openTheory(${t.id})">Открыть теорию</button>
      </div>
    </article>
  `).join('');
  $('theorySelect').innerHTML = topics.map(t => `<option value="${t.id}">${t.external_id}. ${escapeHtml(t.title)}</option>`).join('');
  $('builderTopics').innerHTML = topics.map(t => `
    <label><input class="builder-topic" type="checkbox" value="${t.id}" checked> ${t.external_id}. ${escapeHtml(t.title)}</label>
  `).join('');
  document.querySelectorAll('.builder-topic').forEach(input => input.onchange = refreshCustomFlowInfo);
  buildFlashcards();
  await refreshCustomFlowInfo();
}


function setBuilderTopics(checked){
  document.querySelectorAll('.builder-topic').forEach(input => input.checked = checked);
  refreshCustomFlowInfo();
}

function updateBuilderCountMode(){
  const all = $('builderAllCount')?.checked;
  if($('builderCount')) $('builderCount').disabled = !!all;
  refreshCustomFlowInfo();
}

function selectedBuilderSummary(){
  const selectedTopics = [...document.querySelectorAll('.builder-topic:checked')].map(x => {
    const topic = topics.find(t => t.id === Number(x.value));
    return topic ? topic.external_id : Number(x.value);
  });
  const selectedDifficulties = [...document.querySelectorAll('.builder-difficulty:checked')].map(x => labelDifficulty(x.value));
  return {selectedTopics, selectedDifficulties};
}

function customSessionSummary(session){
  const items = session?.questions || [];
  const topicNums = [...new Set(items.map(item => item.question.topic_external_id).filter(x => x !== null && x !== undefined))].sort((a,b)=>Number(a)-Number(b));
  const diffs = [...new Set(items.map(item => item.question.difficulty).filter(Boolean))].map(labelDifficulty);
  return {topicNums, diffs};
}

async function refreshCustomFlowInfo(){
  const info = $('builderResumeInfo');
  const btn = $('builderContinue');
  if(!info || !btn || !authToken) return;
  try{
    const active = await api('/api/sessions/active?mode=custom');
    if(active.session && active.session.questions?.length){
      const {topicNums, diffs} = customSessionSummary(active.session);
      btn.classList.remove('hidden');
      info.innerHTML = `<b>Активный поток:</b> отвечено ${active.session.answered}/${active.session.total}.<br>Темы: ${topicNums.join(', ') || '—'}. Сложности: ${diffs.join(', ') || '—'}.`;
    }else{
      btn.classList.add('hidden');
      info.innerHTML = '';
    }
  }catch{
    btn.classList.add('hidden');
  }
}

async function continueCustomFlow(){
  const active = await api('/api/sessions/active?mode=custom');
  if(!active.session){ toast('Нет незавершённого потока'); await refreshCustomFlowInfo(); return; }
  currentSession = active.session;
  currentIndex = firstUnansweredIndex(currentSession);
  show('test');
  renderQuestion();
  updateReturnToTestButton('test');
}


async function startCustomFlow(){
  const topic_ids = [...document.querySelectorAll('.builder-topic:checked')].map(x => Number(x.value));
  const difficulties = [...document.querySelectorAll('.builder-difficulty:checked')].map(x => x.value);
  const allCount = $('builderAllCount')?.checked;
  const count = allCount ? 1500 : Math.max(1, Math.min(1000, Number($('builderCount').value || 20)));
  if(!topic_ids.length){ toast('Выберите хотя бы одну тему'); return; }
  if(!difficulties.length){ toast('Выберите хотя бы одну сложность'); return; }
  await startTest({mode:'custom', topic_ids, difficulties, count, restart:true});
  await refreshCustomFlowInfo();
}

function theoryModeToggleHtml(){
  return `<div class="theory-mode-toggle" role="group" aria-label="Режим теории">
    <span>Теория:</span>
    <button type="button" class="secondary ${theoryMode === 'simple' ? 'active' : ''}" onclick="setTheoryMode('simple')">Простая</button>
    <button type="button" class="secondary ${theoryMode === 'standard' ? 'active' : ''}" onclick="setTheoryMode('standard')">Стандартная</button>
  </div>`;
}

function setTheoryMode(mode){
  theoryMode = mode === 'simple' ? 'simple' : 'standard';
  localStorage.setItem('examPrepTheoryMode', theoryMode);
  if(document.getElementById('theory')?.classList.contains('active')) renderTheoryTopic();
  if(document.getElementById('test')?.classList.contains('active') && currentSession) renderQuestion();
  if(document.getElementById('flashcards')?.classList.contains('active')) renderFlashcard();
}

function pickTheory(standard, simple){
  return theoryMode === 'simple' && simple ? simple : (standard || simple || 'Теория для темы пока не заполнена.');
}

function openTheory(topicId){
  $('theorySelect').value = String(topicId);
  show('theory');
  renderTheoryTopic();
}

function renderTheoryTopic(){
  if(!topics.length){
    $('theoryPanel').innerHTML = '<h3>Темы ещё не загружены</h3>';
    return;
  }
  const selectedId = Number($('theorySelect').value || topics[0].id);
  const topic = topics.find(t => t.id === selectedId) || topics[0];
  $('theorySelect').value = String(topic.id);
  $('theoryPanel').innerHTML = `
    <div class="theory-title-row">
      <h3>${topic.external_id}. ${escapeHtml(topic.title)}</h3>
      <button class="report-btn" onclick="openTheoryReport(${topic.id})">Пожаловаться на ошибку в теории</button>
    </div>
    ${theoryModeToggleHtml()}
    <div class="theory">${renderTheory(pickTheory(topic.theory, topic.simple_theory))}</div>
  `;
  if (window.MathJax) MathJax.typesetPromise();
}

async function loadSummary(){
  const s = await api('/api/stats');
  $('summaryCard').innerHTML = `
    <h2>Текущий прогресс</h2>
    <div class="summary-grid">
      <div class="metric"><strong>${s.readiness}%</strong><span>готовность</span></div>
      <div class="metric"><strong>${s.accuracy}%</strong><span>точность</span></div>
      <div class="metric"><strong>${s.coverage}%</strong><span>покрытие банка</span></div>
      <div class="metric"><strong>${s.wrong_answers}</strong><span>ошибок</span></div>
    </div>`;
}

async function startTest(payload){
  lastFeedback = null;

  if(!payload.restart && payload.mode !== 'custom'){
    const active = await findActiveSession(payload);
    if(active.session && active.session.questions?.length){
      const continueSession = await showModal({
        title: 'Продолжить незавершённый тест?',
        message: `В этом разделе уже есть незавершённая попытка: отвечено ${active.session.answered}/${active.session.total}.`,
        extraHtml: `<div class="resume-box"><b>${escapeHtml(labelMode(active.session))}</b><span>Можно продолжить с первого неотвеченного вопроса или начать этот раздел заново.</span></div>`,
        confirmText: 'Продолжить',
        cancelText: 'Начать заново'
      });
      if(continueSession){
        currentSession = active.session;
        currentIndex = firstUnansweredIndex(currentSession);
        show('test');
        renderQuestion();
        return;
      }
      payload = {...payload, restart:true};
    }
  }

  currentIndex = 0;
  currentSession = await api('/api/tests/start', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
  if (!currentSession.questions.length){ toast('Нет вопросов для этого режима'); return; }
  show('test');
  renderQuestion();
}

async function findActiveSession(payload){
  const params = new URLSearchParams();
  params.set('mode', payload.mode || 'exam');
  if(payload.topic_id !== undefined && payload.topic_id !== null) params.set('topic_id', payload.topic_id);
  if(payload.readiness_level !== undefined && payload.readiness_level !== null) params.set('readiness_level', payload.readiness_level);
  if(payload.difficulty) params.set('difficulty', payload.difficulty);
  return api(`/api/sessions/active?${params.toString()}`);
}

function firstUnansweredIndex(session){
  const idx = session.questions.findIndex(item => !item.question.user_answer);
  return idx === -1 ? Math.max(0, session.questions.length - 1) : idx;
}

function formatQuestionPrompt(prompt){
  const text = escapeHtml(String(prompt || ''));
  return text.replace(/(^|\n)(Точность ответа:[^\n]*)/g, '$1<span class="answer-precision-note">$2</span>');
}

function renderQuestion(){
  lastFeedback = null;
  const item = currentSession.questions[currentIndex];
  const q = item.question;
  $('testMeta').textContent = `${labelMode(currentSession)} · ${currentSession.answered}/${currentSession.total}`;
  $('questionCounter').textContent = `Вопрос ${currentIndex+1} из ${currentSession.questions.length} · ${q.topic_title || ''} · ${labelDifficulty(q.difficulty)}`;
  $('questionText').innerHTML = `${formatQuestionPrompt(q.prompt)}<div class="question-report-wrap"><button class="report-btn question-report" onclick="openQuestionReport(${q.id})">Пожаловаться на ошибку в вопросе</button></div>`;
  $('progressBar').style.width = `${(currentIndex/currentSession.questions.length)*100}%`;
  $('feedback').className = 'feedback hidden';
  $('feedback').innerHTML = '';
  if(q.kind === 'mcq'){
    $('answerArea').innerHTML = `<div class="options">${q.choices.map(c => {
      const checked = q.user_answer && q.user_answer.selected_index === c.index ? 'checked' : '';
      return `
      <label class="option"><input type="radio" name="answer" value="${c.index}" ${checked}><div class="option-text">${c.text}</div></label>`;
    }).join('')}</div>`;
  } else {
    const previous = q.user_answer?.input_answer || '';
    $('answerArea').innerHTML = `<input class="answer-input" id="inputAnswer" placeholder="Введите ответ: точка или запятая допустимы" value="${escapeAttribute(previous)}" />`;
  }
  if(q.user_answer && q.correct_answer !== undefined){
    renderFeedback(q, {
      is_correct: q.user_answer.is_correct,
      correct_answer: q.correct_answer,
      explanation: q.explanation,
      theory: q.theory,
      simple_theory: q.simple_theory,
      ai_prompt: q.ai_prompt
    });
  }
  $('prevBtn').disabled = currentIndex === 0;
  if (window.MathJax) MathJax.typesetPromise();
}

async function checkCurrent(){
  const q = currentSession.questions[currentIndex].question;
  let payload = {question_id:q.id};
  if(q.kind === 'mcq'){
    const checked = document.querySelector('input[name="answer"]:checked');
    if(!checked){ toast('Выберите вариант ответа'); return; }
    payload.selected_index = Number(checked.value);
  } else {
    const val = $('inputAnswer').value.trim();
    if(!val){ toast('Введите ответ'); return; }
    payload.input_answer = val;
  }
  const result = await api(`/api/sessions/${currentSession.id}/answer`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
  lastFeedback = result;
  currentSession = await api(`/api/sessions/${currentSession.id}`);
  renderFeedback(q, result);
}

function renderFeedback(q, r){
  const fb = $('feedback');
  fb.className = 'feedback ' + (r.is_correct ? 'good' : 'bad');
  fb.innerHTML = `
    <h3>${r.is_correct ? 'Верно' : 'Ошибка'}</h3>
    <p><b>Правильный ответ:</b> ${r.correct_answer ?? '—'}</p>
    <p><b>Краткое объяснение:</b> ${r.explanation || '—'}</p>
    <div class="theory-title-row compact">
      <h4>Краткая теория</h4>
      <button class="report-btn" onclick="openTheoryReport(${q.topic_id})">Пожаловаться на ошибку в теории</button>
    </div>
    ${theoryModeToggleHtml()}
    <div class="theory">${renderTheory(pickTheory(r.theory, r.simple_theory))}</div>
    <h4>Промпт для нейросети</h4>
    <div class="prompt-box" id="promptBox">${escapeHtml(r.ai_prompt || '')}</div>
    <button class="secondary" onclick="copyPrompt()">Скопировать промпт</button>
  `;
  $('progressBar').style.width = `${((currentIndex+1)/currentSession.questions.length)*100}%`;
  if (window.MathJax) MathJax.typesetPromise();
}


function prevQuestion(){
  if(currentIndex > 0){
    currentIndex--;
    renderQuestion();
  } else {
    toast('Это первый вопрос');
  }
}

function nextQuestion(){
  if(currentIndex < currentSession.questions.length - 1){ currentIndex++; renderQuestion(); }
  else { finishCurrentTest(); }
}


async function finishCurrentTest(){
  const finished = await api(`/api/sessions/${currentSession.id}/finish`, {method:'POST'});
  currentSession = finished;
  toast(`Тест завершён: ${finished.correct_count}/${finished.total}`);
  show('results');
  await loadResults();
  await openResult(finished.id);
  updateReturnToTestButton('results');
  refreshCustomFlowInfo();
}

async function loadResults(){
  const data = await api('/api/results');
  const rows = data.items || [];
  $('resultsList').innerHTML = rows.map(renderResultCard).join('') || '<p class="muted">Завершённых тестов пока нет.</p>';

}

function renderResultCard(item){
  const wrong = Math.max(0, item.total - item.correct_count);
  return `<article class="notification-card result-card">
    <div class="notification-top"><h3>${escapeHtml(item.title)}</h3><span class="badge">${item.correct_count}/${item.total}</span></div>
    <div class="muted">Завершён: ${formatOmskDate(item.finished_at)} · начат: ${formatOmskDate(item.started_at)}</div>
    <p><b>Верно:</b> ${item.correct_count}; <b>ошибок:</b> ${wrong}; <b>точность:</b> ${item.accuracy}%</p>
    <div class="actions compact-actions">
      <button class="secondary" onclick="openResult(${item.id})">Открыть результат</button>
      <button onclick="retakeResult(${item.id})">Перепройти</button>
    </div>
  </article>`;
}


async function retakeResult(sessionId){
  const session = await api(`/api/results/${sessionId}`);
  const payload = session.restart_payload || {mode: session.mode, count: session.total, restart: true};
  await startTest({...payload, restart: true});
}

async function openResult(sessionId){
  const session = await api(`/api/results/${sessionId}`);
  $('resultDetailContent').innerHTML = renderResultDetails(session);
  show('resultDetail');
  if(window.MathJax) MathJax.typesetPromise();
  window.scrollTo({top: 0, behavior: 'smooth'});
}

function renderResultDetails(session){
  const wrong = Math.max(0, session.total - session.correct_count);
  const rows = (session.questions || []).map((item, idx) => renderResultQuestion(item.question, idx)).join('');
  return `<h2>Результат теста</h2>
    <p class="muted">${escapeHtml(session.title || labelMode(session))} · ${formatOmskDate(session.finished_at || session.started_at)}</p>
    <div class="summary-grid">
      <div class="metric"><strong>${session.correct_count}/${session.total}</strong><span>верно</span></div>
      <div class="metric"><strong>${wrong}</strong><span>ошибок</span></div>
      <div class="metric"><strong>${Math.round((session.correct_count / Math.max(1, session.total)) * 100)}%</strong><span>точность</span></div>
    </div>
    <div class="actions compact-actions">
      <button onclick="retakeResult(${session.id})">Перепройти</button>
    </div>
    <h3>Ответы</h3>
    <div class="result-answers">${rows}</div>`;
}

function renderResultQuestion(q, idx){
  const answer = q.user_answer || {};
  const hasAnswer = !!q.user_answer;
  const isCorrect = hasAnswer && !!answer.is_correct;
  const choices = q.kind === 'mcq'
    ? `<div class="result-choices">${(q.choices || []).map(choice => {
        const cls = choice.index === q.correct_choice_index ? 'correct-choice' : (choice.index === answer.selected_index ? 'wrong-choice' : '');
        return `<div class="result-choice ${cls}">${choice.text}</div>`;
      }).join('')}</div>`
    : `<div class="result-choices">
        <div class="result-choice ${hasAnswer ? 'wrong-choice' : ''}">${getAnswerText(q, answer)}</div>
        <div class="result-choice correct-choice">${getCorrectAnswerText(q)}</div>
      </div>`;
  return `<article class="result-question ${isCorrect ? 'good' : 'bad'}">
    <div class="muted">Вопрос ${idx + 1} · ${escapeHtml(q.topic_title || '')} · ${labelDifficulty(q.difficulty)}${hasAnswer ? '' : ' · пропущено'}</div>
    <h4>${formatQuestionPrompt(q.prompt)}</h4>
    ${choices}
    <p><b>Пояснение:</b> ${escapeHtml(q.explanation || q.theory || '—')}</p>
  </article>`;
}

function getAnswerText(q, answer = {}){
  if(answer.answer_text) return escapeHtml(String(answer.answer_text));
  if(q.kind === 'mcq'){
    const choice = (q.choices || []).find(item => item.index === answer.selected_index);
    return choice ? escapeHtml(choice.text) : '—';
  }
  if(answer.input_answer) return escapeHtml(answer.input_answer);
  return '<span class="muted">Пропущено</span>';
}

function getCorrectAnswerText(q){
  if(q.kind === 'mcq'){
    const choice = (q.choices || []).find(item => item.index === q.correct_choice_index);
    return escapeHtml(String(q.correct_answer || choice?.text || '—'));
  }
  return escapeHtml(String(q.correct_answer || '—'));
}

function hasActiveCurrentTest(){
  return currentSession && currentSession.status === 'active' && currentSession.questions && currentSession.questions.length;
}

function updateReturnToTestButton(currentView = null){
  const btn = $('returnToTestBtn');
  if(!btn) return;
  const activeView = currentView || [...document.querySelectorAll('.view')].find(v => v.classList.contains('active'))?.id;
  btn.classList.toggle('hidden', !(hasActiveCurrentTest() && activeView !== 'test'));
}

function returnToCurrentTest(){
  if(!hasActiveCurrentTest()){ toast('Активного теста нет'); updateReturnToTestButton(); return; }
  show('test');
  renderQuestion();
}

function copyPrompt(){
  const text = $('promptBox')?.textContent || '';
  navigator.clipboard.writeText(text).then(()=>toast('Промпт скопирован'));
}

function noticeKey(item){
  return `${item.type}:${String(item.key)}`;
}

function startNotificationPolling(){
  stopNotificationPolling();
  noticePollTimer = setInterval(() => loadSiteNotifications(false), 5000);
}

function stopNotificationPolling(){
  if(noticePollTimer) clearInterval(noticePollTimer);
  noticePollTimer = null;
}

function enqueueNoticeItems(items){
  const known = new Set(pendingNoticeItems.map(noticeKey));
  if(currentNoticeItem) known.add(noticeKey(currentNoticeItem));
  for(const item of items || []){
    const key = noticeKey(item);
    if(!known.has(key)){
      pendingNoticeItems.push(item);
      known.add(key);
    }
  }
}

async function loadSiteNotifications(showImmediately = true){
  try{
    const data = await api('/api/notifications');
    enqueueNoticeItems(data.items || []);
    if(showImmediately || !currentNoticeItem) renderNextSiteNotice();
  }catch{}
}

function renderNextSiteNotice(){
  const box = $('siteNotice');
  const overlay = $('noticeOverlay');
  if(!box || currentNoticeItem || !pendingNoticeItems.length) return;
  currentNoticeItem = pendingNoticeItems.shift();
  const item = currentNoticeItem;
  const changes = item.changes?.length ? `<ul>${item.changes.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : `<p>${escapeHtml(item.message || '')}</p>`;
  box.innerHTML = `
    <div class="site-notice-card">
      <div class="site-notice-head">
        <div>
          <h3>${escapeHtml(item.title || 'Сайт обновился')}</h3>
          ${pendingNoticeItems.length ? `<p class="muted">После закрытия появится ещё: ${pendingNoticeItems.length}</p>` : ''}
        </div>
      </div>
      <div class="site-notice-body">${changes}</div>
      <button class="notice-close-btn" onclick="closeSiteNotice(event)">Закрыть</button>
    </div>`;
  overlay?.classList.remove('hidden');
  box.classList.remove('hidden');
  document.body.classList.add('notice-open');
  setTimeout(() => {
    document.addEventListener('click', closeSiteNoticeOnOutside, {once:true});
  }, 80);
}

function closeSiteNoticeOnOutside(event){
  const card = document.querySelector('.site-notice-card');
  if(card && card.contains(event.target)){
    document.addEventListener('click', closeSiteNoticeOnOutside, {once:true});
    return;
  }
  closeSiteNotice();
}

function closeSiteNotice(event){
  if(event) event.stopPropagation();
  const item = currentNoticeItem;
  currentNoticeItem = null;
  $('siteNotice')?.classList.add('hidden');
  $('noticeOverlay')?.classList.add('hidden');
  document.body.classList.remove('notice-open');
  if(item){
    api('/api/notifications/dismiss', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({item_type:item.type, item_key:String(item.key)})}).catch(()=>{});
  }
  if(pendingNoticeItems.length){
    setTimeout(renderNextSiteNotice, 180);
  }
}

async function loadNotificationHistory(){
  const data = await api('/api/notifications/history');
  const rows = data.items || [];
  $('notificationsList').innerHTML = rows.map(renderNotificationCard).join('') || '<p class="muted">Уведомлений пока нет.</p>';
}

async function clearUserNotifications(){
  const ok = await showModal({
    title: 'Очистить уведомления?',
    message: 'Уведомления и патч-ноуты будут скрыты из твоего списка. Новые уведомления после этого всё равно будут приходить.',
    confirmText: 'Очистить',
    cancelText: 'Отмена',
    danger: true
  });
  if(!ok) return;
  await api('/api/notifications/clear-all', {method:'POST'});
  toast('Уведомления очищены');
  await loadNotificationHistory();
}

function renderNotificationCard(item){
  const changes = item.changes?.length ? `<ul>${item.changes.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : `<p>${escapeHtml(item.message || '')}</p>`;
  const kind = item.type === 'patch' ? 'Патч-ноут' : 'Уведомление';
  return `<article class="notification-card ${item.dismissed ? 'dismissed' : ''}">
    <div class="notification-top"><h3>${escapeHtml(item.title || kind)}</h3><span class="badge">${kind}</span></div>
    <div class="muted">${formatOmskDate(item.created_at)}${item.archived ? ' · архив' : ''}${item.dismissed ? ' · закрыто' : ''}</div>
    ${changes}
  </article>`;
}


async function openChatPage(){
  connectChatSocket();
  await loadChatConversations(false);
  loadChatHistory();
}

function disconnectChatSocket(){
  if(chatReconnectTimer) clearTimeout(chatReconnectTimer);
  chatReconnectTimer = null;
  if(chatSocket){
    try{ chatSocket.close(); }catch{}
  }
  chatSocket = null;
}

function connectChatSocket(){
  if(!authToken) return;
  if(chatSocket && (chatSocket.readyState === WebSocket.OPEN || chatSocket.readyState === WebSocket.CONNECTING)) return;
  const status = $('chatStatus');
  if(status) status.textContent = 'Подключение...';
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  chatSocket = new WebSocket(`${protocol}://${location.host}/ws/chat?token=${encodeURIComponent(authToken)}`);
  chatSocket.onopen = () => { if($('chatStatus')) $('chatStatus').textContent = 'Онлайн'; };
  chatSocket.onmessage = event => {
    let payload = null;
    try{ payload = JSON.parse(event.data); }catch{return;}
    if(payload.type === 'connected'){
      if($('chatStatus')) $('chatStatus').textContent = 'Онлайн';
      return;
    }
    if(payload.type === 'error'){
      toast(payload.message || 'Ошибка чата');
      return;
    }
    if(['message','message_updated','message_deleted'].includes(payload.type) && payload.message){
      loadChatConversations(false);
      loadChatUnreadCount();
      if(chatMessageBelongsToCurrent(payload.message)){
        if(payload.type === 'message') appendChatMessage(payload.message);
        else if(payload.type === 'message_deleted') removeChatMessage(payload.message.id);
        else replaceChatMessage(payload.message);
        markCurrentChatReadSoon();
      }
    }
    if(payload.type === 'read_state'){
      loadChatConversations(false);
      loadChatUnreadCount();
      updateVisibleReadIndicators(payload);
    }
  };
  chatSocket.onclose = () => {
    if($('chatStatus')) $('chatStatus').textContent = 'Нет соединения, переподключение...';
    chatSocket = null;
    if(authToken && document.getElementById('chat')?.classList.contains('active')){
      if(chatReconnectTimer) clearTimeout(chatReconnectTimer);
      chatReconnectTimer = setTimeout(connectChatSocket, 2500);
    }
  };
}


async function loadChatConversations(showToast = false){
  const box = $('chatConversationList');
  if(!box) return;
  try{
    const data = await api('/api/chat/conversations');
    chatConversations = data.items || [];
    chatUnreadTotal = Number(data.unread_total || 0);
    updateChatUnreadBadge();
    renderChatConversations();
    if(showToast) toast('Диалоги обновлены');
  }catch(err){
    box.innerHTML = `<p class="muted chat-dialog-empty">${escapeHtml(err.message || 'Не удалось загрузить диалоги')}</p>`;
  }
}

function renderChatConversations(){
  const box = $('chatConversationList');
  if(!box) return;
  const items = chatConversations.length ? chatConversations : [{type:'saved', title:'Избранное', last_message:'Сообщений пока нет'}, {type:'group', title:'Общий чат', last_message:'Сообщений пока нет'}];
  box.innerHTML = items.map(item => renderConversationButton(item)).join('');
  box.querySelectorAll('.chat-dialog').forEach(dialog => {
    dialog.onclick = event => {
      if(event.target.closest('.chat-dialog-menu-btn') || event.target.closest('.chat-dialog-menu')) return;
      if(dialog.dataset.chatType === 'saved') openSavedChat();
      else if(dialog.dataset.chatType === 'group') openGroupChat();
      else if(dialog.dataset.chatType === 'room') openRoomChat(Number(dialog.dataset.roomId || 0));
      else openDirectChat(dialog.dataset.peer || '');
    };
    dialog.onkeydown = event => {
      if(event.key === 'Enter' || event.key === ' '){ event.preventDefault(); dialog.click(); }
    };
  });
}

function renderConversationButton(item){
  const itemRoomId = Number(item.room_id || 0) || null;
  const active = item.type === chatMode && (item.type === 'saved' || item.type === 'group' || item.peer === chatPeer || (item.type === 'room' && itemRoomId === chatRoomId));
  const title = item.type === 'saved' ? 'Избранное' : (item.type === 'group' ? 'Общий чат' : (item.type === 'room' ? (item.title || 'Группа') : (item.title || `ЛС с ${item.peer}`)));
  const rawPreview = item.last_message || 'Сообщений пока нет';
  const statusPreview = item.type === 'direct' && !item.is_online && item.last_seen_at ? `был(а) онлайн ${formatLastSeen(item.last_seen_at)}` : '';
  const preview = statusPreview || rawPreview;
  const time = item.updated_at ? formatChatTime(item.updated_at) : '';
  const avatar = item.type === 'saved' ? '★' : (item.type === 'group' ? 'О' : (item.type === 'room' ? 'Г' : escapeHtml((item.peer || '?').slice(0,1).toUpperCase())));
  const menu = renderChatDialogMenu(item);
  return `<div class="chat-dialog ${active ? 'active' : ''}" role="button" tabindex="0" data-chat-type="${escapeAttribute(item.type || 'group')}" data-peer="${escapeAttribute(item.peer || '')}" data-room-id="${escapeAttribute(item.room_id || '')}">
    <span class="chat-avatar ${item.type === 'direct' && item.is_online ? 'online' : ''} ${item.type === 'room' ? 'room' : ''} ${item.type === 'saved' ? 'saved' : ''}">${avatar}</span>
    <span class="chat-dialog-body">
      <span class="chat-dialog-top"><b>${escapeHtml(title)}</b>${item.unread_count ? `<mark>${item.unread_count}</mark>` : ''}${menu}</span>
      <span class="chat-dialog-preview">${item.has_attachment ? '📎 ' : ''}${escapeHtml(preview)}</span>
      <span class="chat-dialog-bottom">${time ? `<em>${time}</em>` : '<em></em>'}</span>
    </span>
  </div>`;
}

function renderChatDialogMenu(item){
  if(item.type === 'direct' && item.peer){
    return `<span class="chat-dialog-menu-wrap"><button class="chat-dialog-menu-btn" type="button" onclick="toggleChatDialogMenu(event)">⋯</button><span class="chat-dialog-menu hidden"><button type="button" onclick="deleteDirectDialog(event, '${escapeAttribute(item.peer)}')">Удалить чат</button></span></span>`;
  }
  if(item.type === 'room' && item.room_id){
    return `<span class="chat-dialog-menu-wrap"><button class="chat-dialog-menu-btn" type="button" onclick="toggleChatDialogMenu(event)">⋯</button><span class="chat-dialog-menu hidden"><button type="button" onclick="showChatRoomMembers(event, ${Number(item.room_id)})">Участники</button><button type="button" onclick="leaveChatRoom(event, ${Number(item.room_id)})">Выйти из группы</button></span></span>`;
  }
  return '';
}

function toggleChatDialogMenu(event){
  event.preventDefault();
  event.stopPropagation();
  const wrap = event.currentTarget.closest('.chat-dialog-menu-wrap');
  const menu = wrap?.querySelector('.chat-dialog-menu');
  const wasHidden = menu?.classList.contains('hidden');
  document.querySelectorAll('.chat-dialog-menu').forEach(item => item.classList.add('hidden'));
  if(menu && wasHidden) menu.classList.remove('hidden');
}


async function showChatRoomMembers(event, roomId){
  event.preventDefault();
  event.stopPropagation();
  document.querySelectorAll('.chat-dialog-menu').forEach(item => item.classList.add('hidden'));
  try{
    const data = await api(`/api/chat/rooms/${roomId}`);
    const members = data.members || [];
    const html = `<div class="room-members-modal">
      <div class="room-members-head"><span class="chat-avatar room">Г</span><div><b>${escapeHtml(data.room?.title || 'Группа')}</b><small>${members.length} участн.</small></div></div>
      <div class="room-members-list">
        ${members.map(member => `<div class="room-member-row"><span class="chat-avatar ${member.is_online ? 'online' : ''}">${escapeHtml((member.username || '?').slice(0,1).toUpperCase())}</span><div><b>${escapeHtml(member.username || 'user')}</b><small>${member.is_online ? 'онлайн' : (member.last_seen_at ? `был(а) онлайн ${formatLastSeen(member.last_seen_at)}` : 'оффлайн')}</small></div></div>`).join('') || '<p class="muted">Участников нет.</p>'}
      </div>
    </div>`;
    await showModal({title:'Участники группы', message:'', extraHtml:html, confirmText:'Закрыть', cancelText:'Отмена'});
  }catch(err){ toast(err.message || 'Не удалось открыть участников'); }
}

async function deleteDirectDialog(event, peer){
  event.preventDefault();
  event.stopPropagation();
  document.querySelectorAll('.chat-dialog-menu').forEach(item => item.classList.add('hidden'));
  const ok = await showModal({title:'Удалить чат?', message:`Диалог с ${peer} исчезнет из твоего списка. Если собеседник напишет снова, чат появится обратно.`, confirmText:'Удалить', cancelText:'Отмена', danger:true});
  if(!ok) return;
  try{
    await api(`/api/chat/dialogs/direct/${encodeURIComponent(peer)}`, {method:'DELETE'});
    if(chatMode === 'direct' && chatPeer === peer) openSavedChat();
    await loadChatConversations(false);
    toast('Чат удалён из списка');
  }catch(err){ toast(err.message || 'Не удалось удалить чат'); }
}

async function leaveChatRoom(event, roomId){
  event.preventDefault();
  event.stopPropagation();
  document.querySelectorAll('.chat-dialog-menu').forEach(item => item.classList.add('hidden'));
  const ok = await showModal({title:'Выйти из группы?', message:'Группа исчезнет из списка твоих диалогов. Старые сообщения останутся у других участников.', confirmText:'Выйти', cancelText:'Отмена', danger:true});
  if(!ok) return;
  try{
    await api(`/api/chat/rooms/${roomId}/leave`, {method:'DELETE'});
    if(chatMode === 'room' && Number(chatRoomId) === Number(roomId)) openSavedChat();
    await loadChatConversations(false);
    toast('Ты вышел из группы');
  }catch(err){ toast(err.message || 'Не удалось выйти из группы'); }
}

function formatChatTime(value){
  if(!value) return '';
  const raw = String(value);
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(normalized);
  if(Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ru-RU', {timeZone:'Asia/Omsk', hour:'2-digit', minute:'2-digit'}).format(date);
}

function formatLastSeen(value){
  if(!value) return 'давно';
  const raw = String(value);
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(normalized);
  if(Number.isNaN(date.getTime())) return 'давно';
  const now = Date.now();
  const diff = Math.max(0, now - date.getTime());
  if(diff < 60 * 1000) return 'только что';
  if(diff < 60 * 60 * 1000){
    const minutes = Math.max(1, Math.floor(diff / 60000));
    return `${minutes} мин. назад`;
  }
  const today = new Intl.DateTimeFormat('ru-RU', {timeZone:'Asia/Omsk', day:'2-digit', month:'2-digit', year:'numeric'}).format(new Date());
  const seenDay = new Intl.DateTimeFormat('ru-RU', {timeZone:'Asia/Omsk', day:'2-digit', month:'2-digit', year:'numeric'}).format(date);
  const time = new Intl.DateTimeFormat('ru-RU', {timeZone:'Asia/Omsk', hour:'2-digit', minute:'2-digit'}).format(date);
  return today === seenDay ? `сегодня в ${time}` : new Intl.DateTimeFormat('ru-RU', {timeZone:'Asia/Omsk', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit'}).format(date);
}

function directChatStatusText(peer){
  const item = chatConversations.find(x => x.type === 'direct' && x.peer === peer);
  if(!item) return 'Личные сообщения видите только вы и собеседник.';
  if(item.is_online) return 'Собеседник онлайн';
  return item.last_seen_at ? `Был(а) онлайн: ${formatLastSeen(item.last_seen_at)}` : 'Собеседник оффлайн';
}


async function loadChatUnreadCount(){
  if(!authToken) return;
  try{
    const data = await api('/api/chat/unread-count');
    chatUnreadTotal = Number(data.unread_total || 0);
    updateChatUnreadBadge();
  }catch{}
}

function updateChatUnreadBadge(){
  const badge = $('chatUnreadBadge');
  if(!badge) return;
  if(chatUnreadTotal > 0){
    badge.textContent = chatUnreadTotal > 99 ? '99+' : String(chatUnreadTotal);
    badge.classList.remove('hidden');
  }else{
    badge.classList.add('hidden');
  }
}


function updateVisibleReadIndicators(payload){
  if(!payload || payload.reader?.username === currentUser?.username) return;
  const lastRead = Number(payload.last_read_message_id || 0);
  if(!lastRead) return;
  for(const [id, message] of chatMessageCache.entries()){
    if(Number(id) > lastRead) continue;
    if(!currentUser || message.sender?.id !== currentUser.id) continue;
    if(payload.chat_type === 'direct' && message.chat_type === 'direct'){
      const reader = payload.reader?.username || '';
      const peer = chatPeer || '';
      if(reader !== peer) continue;
      message.read_info = {kind:'direct', read:true};
      replaceChatMessage(message);
    }
  }
}

let chatReadTimer = null;
function markCurrentChatReadSoon(){
  if(chatReadTimer) clearTimeout(chatReadTimer);
  chatReadTimer = setTimeout(markCurrentChatRead, 250);
}

async function markCurrentChatRead(){
  if(!document.getElementById('chat')?.classList.contains('active')) return;
  const ids = [...chatMessageCache.keys()].map(Number).filter(Boolean);
  const last = ids.length ? Math.max(...ids) : 0;
  try{
    await api('/api/chat/read', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({chat_type:chatMode, peer:chatPeer, room_id:chatRoomId, last_message_id:last})});
    await loadChatConversations(false);
    await loadChatUnreadCount();
  }catch{}
}

function currentChatQuery(){
  const params = new URLSearchParams();
  params.set('chat_type', chatMode);
  if(chatMode === 'direct') params.set('peer', chatPeer);
  if(chatMode === 'room' && chatRoomId) params.set('room_id', chatRoomId);
  params.set('limit', '100');
  return params.toString();
}

async function loadChatHistory(markRead = true){
  const list = $('chatMessages');
  if(!list) return;
  list.innerHTML = '<p class="muted chat-empty">Загрузка сообщений...</p>';
  chatRenderedIds = new Set();
  try{
    const data = await api(`/api/chat/history?${currentChatQuery()}`);
    $('chatTitle').textContent = data.title || (chatMode === 'direct' ? `ЛС с ${chatPeer}` : 'Общий чат');
    $('chatSubtitle').textContent = chatMode === 'saved' ? 'Личный чат с самим собой для заметок, файлов и материалов.' : (chatMode === 'direct' ? directChatStatusText(chatPeer) : (chatMode === 'room' ? 'Групповой чат только для выбранных участников.' : 'Групповой чат между всеми пользователями.'));
    list.innerHTML = '';
    chatMessageCache = new Map();
    (data.items || []).forEach(appendChatMessage);
    if(!(data.items || []).length) list.innerHTML = '<p class="muted chat-empty">Сообщений пока нет. Напиши первым.</p>';
    scrollChatToBottom();
    if(markRead) markCurrentChatReadSoon();
  }catch(err){
    list.innerHTML = `<p class="muted chat-empty">${escapeHtml(err.message || 'Не удалось загрузить чат')}</p>`;
  }
}

function handleChatPeerInput(event){
  const query = event.target.value.trim();
  if(chatPeerSuggestTimer) clearTimeout(chatPeerSuggestTimer);
  if(query.length < 1){ hideChatPeerSuggestions(); return; }
  chatPeerSuggestTimer = setTimeout(() => loadChatPeerSuggestions(query), 180);
}

async function loadChatPeerSuggestions(query){
  const box = $('chatPeerSuggestions');
  if(!box) return;
  try{
    const data = await api(`/api/chat/users/search?q=${encodeURIComponent(query)}`);
    const items = data.items || [];
    if(!items.length){ hideChatPeerSuggestions(); return; }
    box.innerHTML = items.map(item => `
      <button type="button" class="chat-peer-suggest" data-username="${escapeAttribute(item.username)}">
        <span class="chat-avatar ${item.is_online ? 'online' : ''}">${escapeHtml((item.username || '?').slice(0,1).toUpperCase())}</span>
        <span><b>${escapeHtml(item.username)}</b><em>${item.is_online ? 'онлайн' : 'пользователь'}</em></span>
      </button>
    `).join('');
    box.classList.remove('hidden');
    box.querySelectorAll('.chat-peer-suggest').forEach(btn => {
      btn.onclick = () => openDirectChat(btn.dataset.username || '');
    });
  }catch(err){ hideChatPeerSuggestions(); }
}

function hideChatPeerSuggestions(){
  const box = $('chatPeerSuggestions');
  if(!box) return;
  box.classList.add('hidden');
  box.innerHTML = '';
}

function openSavedChat(){
  hideChatPeerSuggestions();
  clearChatEdit();
  clearChatReply();
  chatMode = 'saved';
  chatPeer = '';
  chatRoomId = null;
  $('chatPeerInput').value = '';
  renderChatConversations();
  loadChatHistory();
}

function openGroupChat(){
  hideChatPeerSuggestions();
  clearChatEdit();
  clearChatReply();
  chatMode = 'group';
  chatPeer = '';
  chatRoomId = null;
  $('chatPeerInput').value = '';
  renderChatConversations();
  loadChatHistory();
}

function openDirectChatFromInput(){
  const peer = $('chatPeerInput').value.trim().toLowerCase();
  if(peer.length < 3){ toast('Укажи логин собеседника'); return; }
  openDirectChat(peer);
}

function openDirectChat(peer){
  hideChatPeerSuggestions();
  clearChatEdit();
  clearChatReply();
  chatMode = 'direct';
  chatPeer = String(peer || '').trim().toLowerCase();
  chatRoomId = null;
  $('chatPeerInput').value = chatPeer;
  renderChatConversations();
  loadChatHistory();
}

function openRoomChat(roomId){
  if(!roomId){ toast('Группа не найдена'); return; }
  hideChatPeerSuggestions();
  clearChatEdit();
  clearChatReply();
  chatMode = 'room';
  chatPeer = '';
  chatRoomId = Number(roomId);
  $('chatPeerInput').value = '';
  renderChatConversations();
  loadChatHistory();
}

async function showCreateChatRoomModal(){
  await loadChatConversations(false);
  const directPeers = [...new Set(chatConversations.filter(item => item.type === 'direct' && item.peer).map(item => item.peer))].sort((a,b)=>a.localeCompare(b,'ru'));
  const peerCards = directPeers.length ? directPeers.map(peer => `
    <label class="room-peer-card" data-peer="${escapeAttribute(peer)}">
      <input type="checkbox" class="roomPeerCheck" value="${escapeAttribute(peer)}">
      <span class="chat-avatar">${escapeHtml(peer[0] || '?').toUpperCase()}</span>
      <span class="room-peer-card-text">
        <b>${escapeHtml(peer)}</b>
        <small>Личный диалог</small>
      </span>
      <span class="room-peer-card-tick">✓</span>
    </label>`).join('') : '<div class="room-empty-state">Личных диалогов пока нет. Добавь участников по логину ниже.</div>';

  const modalPromise = showModal({
    title:'Создать групповой чат',
    message:'',
    extraHtml:`
      <div class="room-create-modal">
        <div class="room-create-hero">
          <div class="room-create-icon">👥</div>
          <div>
            <h4>Новая группа</h4>
            <p>Выбери участников из диалогов или добавь новых по логину.</p>
          </div>
        </div>
        <label class="modal-field room-title-field">
          <span>Название группы</span>
          <input id="roomTitleInput" maxlength="120" placeholder="Например: Подготовка к экзамену">
        </label>
        <div class="room-create-section">
          <div class="room-section-head">
            <b>Выбранные участники</b>
            <span id="roomSelectedCount">0</span>
          </div>
          <div id="roomSelectedChips" class="room-selected-chips"><span class="muted">Пока никто не выбран.</span></div>
        </div>
        <div class="room-create-section">
          <div class="room-section-head">
            <b>Добавить по логину</b>
            <span>поиск</span>
          </div>
          <div class="room-add-row">
            <input id="roomUserAddInput" autocomplete="off" placeholder="Начни писать логин">
            <button id="roomUserAddBtn" class="secondary" type="button">Добавить</button>
            <div id="roomUserSuggestions" class="room-suggestions hidden"></div>
          </div>
          <small class="room-help">Можно добавить несколько участников по одному. Себя добавлять не нужно — ты уже в группе.</small>
        </div>
        <div class="room-create-section">
          <div class="room-section-head">
            <b>Из истории диалогов</b>
            <span>${directPeers.length}</span>
          </div>
          <div class="room-peer-list pretty">${peerCards}</div>
        </div>
        <input id="roomUsersInput" type="hidden" value="">
      </div>`,
    confirmText:'Создать группу',
    cancelText:'Отмена'
  });

  setupCreateChatRoomModal();
  const ok = await modalPromise;
  if(!ok) return;
  const title = (document.getElementById('roomTitleInput')?.value || '').trim() || 'Групповой чат';
  const usernames = (document.getElementById('roomUsersInput')?.value || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if(!usernames.length){ toast('Добавь хотя бы одного участника'); return; }
  try{
    const result = await api('/api/chat/rooms', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title, usernames})});
    await loadChatConversations(false);
    openRoomChat(result.room?.id);
    toast('Группа создана');
  }catch(err){ toast(err.message || 'Не удалось создать группу'); }
}

function setupCreateChatRoomModal(){
  const selected = new Set();
  const hidden = document.getElementById('roomUsersInput');
  const chips = document.getElementById('roomSelectedChips');
  const count = document.getElementById('roomSelectedCount');
  const addInput = document.getElementById('roomUserAddInput');
  const addBtn = document.getElementById('roomUserAddBtn');
  const suggestions = document.getElementById('roomUserSuggestions');
  let searchTimer = null;

  const normalize = value => String(value || '').trim().toLowerCase();
  const syncHidden = () => { if(hidden) hidden.value = [...selected].join(','); };
  const updateCards = () => {
    document.querySelectorAll('.room-peer-card').forEach(card => {
      const peer = normalize(card.dataset.peer || '');
      const active = selected.has(peer);
      card.classList.toggle('selected', active);
      const input = card.querySelector('input');
      if(input) input.checked = active;
    });
  };
  const renderSelected = () => {
    if(!chips || !count) return;
    count.textContent = String(selected.size);
    if(!selected.size){
      chips.innerHTML = '<span class="muted">Пока никто не выбран.</span>';
    }else{
      chips.innerHTML = [...selected].sort((a,b)=>a.localeCompare(b,'ru')).map(username => `
        <button type="button" class="room-chip" data-username="${escapeAttribute(username)}">
          <span>${escapeHtml(username)}</span>
          <b>×</b>
        </button>`).join('');
    }
    syncHidden();
    updateCards();
  };
  const addUser = username => {
    const clean = normalize(username);
    if(!clean) return;
    if(currentUser?.username && clean === currentUser.username){
      toast('Себя добавлять не нужно');
      return;
    }
    selected.add(clean);
    if(addInput) addInput.value = '';
    if(suggestions) suggestions.classList.add('hidden');
    renderSelected();
  };

  document.querySelectorAll('.roomPeerCheck').forEach(input => {
    input.addEventListener('change', () => {
      const peer = normalize(input.value);
      if(input.checked) selected.add(peer); else selected.delete(peer);
      renderSelected();
    });
  });
  chips?.addEventListener('click', event => {
    const btn = event.target.closest('.room-chip');
    if(!btn) return;
    selected.delete(normalize(btn.dataset.username || ''));
    renderSelected();
  });
  addBtn?.addEventListener('click', () => addUser(addInput?.value));
  addInput?.addEventListener('keydown', event => {
    if(event.key === 'Enter'){
      event.preventDefault();
      addUser(addInput.value);
    }
  });
  addInput?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = normalize(addInput.value);
    if(!suggestions || q.length < 2){
      suggestions?.classList.add('hidden');
      return;
    }
    searchTimer = setTimeout(async () => {
      try{
        const result = await api(`/api/chat/users/search?q=${encodeURIComponent(q)}`);
        const items = (result.items || []).filter(item => item.username !== currentUser?.username && !selected.has(item.username));
        if(!items.length){
          suggestions.innerHTML = '<div class="room-suggestion-empty">Ничего не найдено</div>';
        }else{
          suggestions.innerHTML = items.map(item => `
            <button type="button" class="room-suggestion" data-username="${escapeAttribute(item.username)}">
              <span class="chat-avatar ${item.is_online ? 'online' : ''}">${escapeHtml(item.username[0] || '?').toUpperCase()}</span>
              <span><b>${escapeHtml(item.username)}</b><small>${item.is_online ? 'Онлайн' : 'Пользователь'}</small></span>
            </button>`).join('');
        }
        suggestions.classList.remove('hidden');
      }catch(err){
        suggestions.classList.add('hidden');
      }
    }, 220);
  });
  suggestions?.addEventListener('click', event => {
    const btn = event.target.closest('.room-suggestion');
    if(!btn) return;
    addUser(btn.dataset.username || '');
  });
  renderSelected();
}

function chatMessageBelongsToCurrent(message){
  if(!message) return false;
  if(chatMode === 'saved') return message.chat_type === 'saved' && message.sender?.id === currentUser?.id;
  if(chatMode === 'group') return message.chat_type === 'group';
  if(chatMode === 'room') return message.chat_type === 'room' && Number(message.room_id || message.room?.id || 0) === Number(chatRoomId || 0);
  if(message.chat_type !== 'direct') return false;
  const sender = message.sender?.username || '';
  const recipient = message.recipient?.username || '';
  const me = currentUser?.username || '';
  return (sender === chatPeer && recipient === me) || (sender === me && recipient === chatPeer);
}

function scrollChatToBottom(){
  const list = $('chatMessages');
  if(!list) return;
  const doScroll = () => { list.scrollTop = list.scrollHeight; };
  doScroll();
  requestAnimationFrame(doScroll);
  setTimeout(doScroll, 60);
  setTimeout(doScroll, 180);
  setTimeout(doScroll, 420);
  list.querySelectorAll('img').forEach(img => {
    if(!img.complete) img.addEventListener('load', doScroll, {once:true});
  });
}

function appendChatMessage(message){
  const list = $('chatMessages');
  if(!list) return;
  if(chatRenderedIds.has(message.id)) return;
  const empty = list.querySelector('.chat-empty');
  if(empty) empty.remove();
  chatRenderedIds.add(message.id);
  chatMessageCache.set(Number(message.id), message);
  list.insertAdjacentHTML('beforeend', renderChatMessage(message));
  scrollChatToBottom();
}

function removeChatMessage(messageId){
  const list = $('chatMessages');
  if(!list) return;
  const old = list.querySelector(`[data-message-id="${messageId}"]`);
  if(old) old.remove();
  chatRenderedIds.delete(Number(messageId));
  chatMessageCache.delete(Number(messageId));
  if(!list.querySelector('.chat-message')){
    list.innerHTML = '<div class="chat-empty muted">Сообщений пока нет.</div>';
  }
}

function replaceChatMessage(message){
  if(message?.is_deleted){ removeChatMessage(message.id); return; }
  const list = $('chatMessages');
  if(!list) return;
  const old = list.querySelector(`[data-message-id="${message.id}"]`);
  chatMessageCache.set(Number(message.id), message);
  if(old) old.outerHTML = renderChatMessage(message);
  else appendChatMessage(message);
}

function chatAttachmentUrl(attachment){
  if(!attachment?.url) return '#';
  return `${attachment.url}?token=${encodeURIComponent(authToken)}`;
}

function chatPreviewUrl(attachment){
  if(!attachment?.preview_url) return chatAttachmentUrl(attachment);
  return `${attachment.preview_url}?token=${encodeURIComponent(authToken)}`;
}

function formatFileSize(bytes){
  const value = Number(bytes || 0);
  if(value < 1024) return `${value} Б`;
  if(value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  return `${(value / 1024 / 1024).toFixed(1)} МБ`;
}

function renderChatAttachment(attachment){
  if(!attachment) return '';
  const name = escapeHtml(attachment.original_name || 'Файл');
  const size = formatFileSize(attachment.size);
  const url = chatAttachmentUrl(attachment);
  const preview = chatPreviewUrl(attachment);
  if(attachment.kind === 'image'){
    return `<div class="chat-image-wrap">
      <a class="chat-image-link" href="${url}" target="_blank" rel="noopener"><img class="chat-image" src="${url}" alt="${name}"></a>
      <a class="chat-image-download" href="${url}" download="${escapeAttribute(attachment.original_name || 'image')}" target="_blank" rel="noopener">Скачать</a>
    </div>`;
  }
  const labels = {text:'TXT', markdown:'MD', notebook:'IPYNB', docx:'DOCX', pdf:'PDF'};
  const label = labels[attachment.kind] || 'FILE';
  return `<div class="chat-file-card">
    <div class="chat-file-icon">${label}</div>
    <div class="chat-file-info">
      <b>${name}</b>
      <span>${size}</span>
      <div class="chat-file-actions">
        <a href="${preview}" target="_blank" rel="noopener">Открыть онлайн</a>
        <a href="${url}" target="_blank" rel="noopener">Скачать</a>
      </div>
    </div>
  </div>`;
}

function renderChatMessage(message){
  const own = message.is_own || (currentUser && message.sender?.id === currentUser.id);
  const sender = own ? 'Вы' : (message.sender?.username || 'user');
  const directLabel = message.chat_type === 'direct' ? '<span class="chat-direct-label">ЛС</span>' : '';
  if(message.is_deleted) return '';
  const text = message.text ? `<div class="chat-text">${escapeHtml(message.text).replace(/\n/g, '<br>')}</div>` : '';
  const attachment = renderChatAttachment(message.attachment);
  const edited = message.edited_at ? '<span class="chat-edited">изменено</span>' : '';
  const readInfo = own ? renderReadInfo(message) : '';
  const menu = renderMessageMenu(message, own);
  return `<article class="chat-message ${own ? 'own' : 'other'}" data-message-id="${message.id}" data-message-text="${escapeAttribute(message.text || '')}">
    <div class="chat-bubble">
      <button class="chat-menu-btn" type="button" onclick="toggleChatMessageMenu(${message.id})">⋯</button>
      ${menu}
      <div class="chat-message-meta"><b>${escapeHtml(sender)}</b>${directLabel}<span>${formatOmskDate(message.created_at)}</span>${edited}${readInfo}</div>
      ${text}
      ${attachment}
    </div>
  </article>`;
}

function renderReadInfo(message){
  const info = message.read_info || {};
  if(info.kind === 'direct') return `<span class="chat-read-indicator ${info.read ? 'read' : ''}">${info.read ? '✓✓ прочитано' : '✓ отправлено'}</span>`;
  if(info.kind === 'group') return `<span class="chat-read-indicator">👁 ${Number(info.read_count || 0)}</span>`;
  return `<span class="chat-read-indicator">✓</span>`;
}

function renderMessageMenu(message, own){
  const canModify = own && canModifyChatMessage(message);
  return `<div id="chatMenu${message.id}" class="chat-message-menu hidden">
    <button type="button" onclick="replyToChatMessage(${message.id})">Ответить</button>
    <button type="button" onclick="forwardChatMessage(${message.id})">Переслать</button>
    ${canModify ? `<button type="button" onclick="editChatMessage(${message.id})">Редактировать</button><button type="button" class="danger-text" onclick="deleteChatMessage(${message.id})">Удалить</button>` : ''}
  </div>`;
}


function closeChatMessageMenus(){
  document.querySelectorAll('.chat-message-menu').forEach(menu => menu.classList.add('hidden'));
  document.querySelectorAll('.chat-message.menu-open').forEach(item => item.classList.remove('menu-open'));
}

function toggleChatMessageMenu(messageId){
  document.querySelectorAll('.chat-message-menu').forEach(menu => {
    if(menu.id !== `chatMenu${messageId}`) {
      menu.classList.add('hidden');
      menu.closest('.chat-message')?.classList.remove('menu-open');
    }
  });
  const menu = $(`chatMenu${messageId}`);
  if(!menu) return;
  const article = menu.closest('.chat-message');
  const willOpen = menu.classList.contains('hidden');
  menu.classList.toggle('hidden');
  if(article) article.classList.toggle('menu-open', willOpen);
}

function replyToChatMessage(messageId){
  const message = chatMessageCache.get(Number(messageId));
  if(!message) return;
  chatReplyTarget = message;
  renderChatReplyPreview();
  const input = $('chatInput');
  if(input) input.focus();
  closeChatMessageMenus();
}

function renderChatReplyPreview(){
  const box = $('chatReplyPreview');
  if(!box) return;
  if(!chatReplyTarget){ box.classList.add('hidden'); box.innerHTML = ''; return; }
  const sender = chatReplyTarget.sender?.username || 'пользователь';
  const text = (chatReplyTarget.text || chatReplyTarget.attachment?.original_name || 'сообщение').slice(0, 140);
  box.innerHTML = `<div class="chat-reply-card"><div><b>Ответ ${escapeHtml(sender)}</b><span>${escapeHtml(text)}</span></div><button class="secondary small-btn" type="button" onclick="clearChatReply()">×</button></div>`;
  box.classList.remove('hidden');
}

function clearChatReply(){
  chatReplyTarget = null;
  renderChatReplyPreview();
}

function renderChatEditPreview(){
  const box = $('chatEditPreview');
  const sendBtn = $('chatSendBtn');
  if(!box) return;
  if(!chatEditingMessage){
    box.classList.add('hidden');
    box.innerHTML = '';
    if(sendBtn) sendBtn.textContent = 'Отправить';
    return;
  }
  box.innerHTML = `<div class="chat-reply-card chat-edit-card"><div><b>Редактирование сообщения</b><span>Измени текст в строке ввода и нажми «Сохранить».</span></div><button class="secondary small-btn" type="button" onclick="clearChatEdit()">×</button></div>`;
  box.classList.remove('hidden');
  if(sendBtn) sendBtn.textContent = 'Сохранить';
}

function clearChatEdit(){
  chatEditingMessage = null;
  renderChatEditPreview();
  const input = $('chatInput');
  if(input) input.value = '';
}

function applyReplyPrefix(text){
  if(!chatReplyTarget) return text;
  const sender = chatReplyTarget.sender?.username || 'пользователя';
  const preview = (chatReplyTarget.text || chatReplyTarget.attachment?.original_name || 'сообщение').slice(0, 180);
  clearChatReply();
  return `Ответ на сообщение от ${sender}:\n${preview}\n\n${text || ''}`.trim();
}

async function forwardChatMessage(messageId){
  closeChatMessageMenus();
  await loadChatConversations(false);
  const selected = await showForwardTargetModal();
  if(!selected) return;
  const payload = selected.type === 'saved' ? {chat_type:'saved'} : (selected.type === 'direct' ? {chat_type:'direct', peer:selected.peer} : (selected.type === 'room' ? {chat_type:'room', room_id:selected.room_id} : {chat_type:'group'}));
  try{
    const result = await api(`/api/chat/messages/${messageId}/forward`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    if(result.message && chatMessageBelongsToCurrent(result.message)) appendChatMessage(result.message);
    await loadChatConversations(false);
    toast(selected.type === 'saved' ? 'Сообщение переслано в Избранное' : (selected.type === 'direct' ? `Сообщение переслано в ЛС с ${selected.peer}` : (selected.type === 'room' ? 'Сообщение переслано в группу' : 'Сообщение переслано в общий чат')));
  }catch(err){ toast(err.message || 'Не удалось переслать сообщение'); }
}

async function showForwardTargetModal(){
  const dialogs = chatConversations.length ? chatConversations : [{type:'group', title:'Общий чат'}];
  const options = dialogs.map(item => {
    const value = item.type === 'saved' ? 'saved' : (item.type === 'direct' ? `direct:${item.peer}` : (item.type === 'room' ? `room:${item.room_id}` : 'group'));
    const title = item.type === 'saved' ? 'Избранное' : (item.type === 'direct' ? (item.title || `ЛС с ${item.peer}`) : (item.type === 'room' ? (item.title || 'Группа') : 'Общий чат'));
    const preview = item.last_message && item.last_message !== 'Сообщений пока нет' ? ` — ${item.last_message.slice(0, 60)}` : '';
    return `<option value="${escapeAttribute(value)}">${escapeHtml(title + preview)}</option>`;
  }).join('');
  const ok = await showModal({
    title:'Переслать сообщение',
    message:'Выбери чат из истории диалогов.',
    extraHtml:`<label class="modal-field">Куда переслать?<select id="forwardTargetSelect">${options}</select></label>`,
    confirmText:'Переслать',
    cancelText:'Отмена'
  });
  if(!ok) return null;
  const value = document.getElementById('forwardTargetSelect')?.value || 'group';
  if(value === 'saved') return {type:'saved'};
  if(value.startsWith('direct:')) return {type:'direct', peer:value.slice('direct:'.length)};
  if(value.startsWith('room:')) return {type:'room', room_id:Number(value.slice('room:'.length))};
  return {type:'group', peer:''};
}

function canModifyChatMessage(message){
  if(!message || message.is_deleted || !currentUser || message.sender?.id !== currentUser.id) return false;
  const raw = String(message.created_at || '');
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const created = new Date(normalized).getTime();
  if(Number.isNaN(created)) return false;
  return Date.now() - created <= 24 * 60 * 60 * 1000;
}

async function editChatMessage(messageId){
  closeChatMessageMenus();
  const message = chatMessageCache.get(Number(messageId));
  const article = document.querySelector(`[data-message-id="${messageId}"]`);
  const currentText = message?.text || article?.dataset.messageText || '';
  if(!currentText.trim()){ toast('Можно редактировать только текст сообщения'); return; }
  if(pendingChatFile){ clearPendingChatFile(); }
  clearChatReply();
  chatEditingMessage = {id:Number(messageId), text:currentText};
  const input = $('chatInput');
  if(input){ input.value = currentText; input.focus(); }
  renderChatEditPreview();
}

async function deleteChatMessage(messageId){
  const ok = await showModal({title:'Удалить сообщение?', message:'Сообщение можно удалить только в течение суток после отправки.', confirmText:'Удалить', cancelText:'Отмена', danger:true});
  if(!ok) return;
  try{
    const result = await api(`/api/chat/messages/${messageId}`, {method:'DELETE'});
    if(result.message) removeChatMessage(result.message.id);
    await loadChatConversations(false);
  }catch(err){ toast(err.message || 'Не удалось удалить сообщение'); }
}

async function sendChatText(){
  const input = $('chatInput');
  let text = input.value.trim();
  if(chatMode === 'direct' && !chatPeer){ toast('Сначала открой ЛС по логину'); return; }
  if(chatMode === 'room' && !chatRoomId){ toast('Сначала открой групповой чат'); return; }
  if(chatEditingMessage){
    if(pendingChatFile){ toast('Во время редактирования нельзя прикреплять файл'); return; }
    if(!text){ toast('Текст не может быть пустым'); return; }
    try{
      const result = await api(`/api/chat/messages/${chatEditingMessage.id}`, {method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({text})});
      if(result.message) replaceChatMessage(result.message);
      await loadChatConversations(false);
      chatEditingMessage = null;
      renderChatEditPreview();
      input.value = '';
    }catch(err){ toast(err.message || 'Не удалось изменить сообщение'); }
    return;
  }
  if(pendingChatFile){
    text = applyReplyPrefix(text);
    await uploadChatFileNow(pendingChatFile, text);
    pendingChatFile = null;
    renderPendingChatFile();
    input.value = '';
    return;
  }
  if(!text && !chatReplyTarget){ return; }
  text = applyReplyPrefix(text);
  connectChatSocket();
  if(!chatSocket || chatSocket.readyState !== WebSocket.OPEN){ toast('Чат ещё подключается'); return; }
  chatSocket.send(JSON.stringify({type:'message', chat_type:chatMode, recipient_username:chatPeer, room_id:chatRoomId, text}));
  input.value = '';
}

function isChatFileAllowed(file){
  if(!file) return false;
  const allowedExt = ['.png','.jpg','.jpeg','.webp','.gif','.txt','.md','.ipynb','.docx','.pdf'];
  const lower = String(file.name || '').toLowerCase();
  const type = String(file.type || '').toLowerCase();
  return type.startsWith('image/') || type === 'application/pdf' || allowedExt.some(ext => lower.endsWith(ext));
}

function supportedChatFileHint(){
  return 'Можно прикреплять только изображения, PDF, TXT, MD, IPYNB и DOCX';
}

function setPendingChatFile(file){
  if(!isChatFileAllowed(file)){
    toast(supportedChatFileHint());
    return false;
  }
  if(chatEditingMessage){ clearChatEdit(); }
  pendingChatFile = file;
  renderPendingChatFile();
  toast('Файл прикреплён. Нажми «Отправить», чтобы отправить сообщение');
  return true;
}

function clearPendingChatFile(){
  pendingChatFile = null;
  renderPendingChatFile();
}

function renderPendingChatFile(){
  const box = $('chatPendingFile');
  if(!box) return;
  if(!pendingChatFile){ box.classList.add('hidden'); box.innerHTML = ''; return; }
  const isImage = pendingChatFile.type.startsWith('image/');
  const preview = isImage ? `<img src="${URL.createObjectURL(pendingChatFile)}" alt="preview">` : `<span class="chat-pending-icon">📎</span>`;
  box.innerHTML = `<div class="chat-pending-card">
    ${preview}
    <div class="chat-pending-info"><b>${escapeHtml(pendingChatFile.name || 'Файл')}</b><span>${formatFileSize(pendingChatFile.size)}</span><em>Файл ещё не отправлен</em></div>
    <button class="secondary small-btn" type="button" onclick="clearPendingChatFile()">Убрать</button>
  </div>`;
  box.classList.remove('hidden');
}

async function uploadChatFile(file, text = ''){
  setPendingChatFile(file);
}

async function uploadChatFileNow(file, text = ''){
  if(chatMode === 'direct' && !chatPeer){ toast('Сначала открой ЛС по логину'); return; }
  if(chatMode === 'room' && !chatRoomId){ toast('Сначала открой групповой чат'); return; }
  if(!isChatFileAllowed(file)){ toast(supportedChatFileHint()); return; }
  const form = new FormData();
  form.append('chat_type', chatMode);
  form.append('recipient_username', chatPeer);
  if(chatRoomId) form.append('room_id', chatRoomId);
  form.append('text', text || '');
  form.append('file', file, file.name || `clipboard-${Date.now()}.png`);
  try{
    const result = await api('/api/chat/upload', {method:'POST', body:form});
    await loadChatConversations(false);
    if(result.message && chatMessageBelongsToCurrent(result.message)) appendChatMessage(result.message);
  }catch(err){
    toast(err.message || 'Не удалось отправить файл');
  }
}


function bindChatDragAndDrop(){
  const zone = $('chatMessages');
  if(!zone || zone.dataset.dropBound === '1') return;
  zone.dataset.dropBound = '1';
  ['dragenter', 'dragover'].forEach(eventName => {
    zone.addEventListener(eventName, event => {
      if(!event.dataTransfer?.types?.includes('Files')) return;
      event.preventDefault();
      zone.classList.add('drag-over');
    });
  });
  ['dragleave', 'dragend'].forEach(eventName => {
    zone.addEventListener(eventName, event => {
      if(eventName === 'dragleave' && zone.contains(event.relatedTarget)) return;
      zone.classList.remove('drag-over');
    });
  });
  zone.addEventListener('drop', async event => {
    if(!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    zone.classList.remove('drag-over');
    const files = [...event.dataTransfer.files];
    if(files.length > 1) toast('Сейчас прикрепляется первый файл из списка');
    setPendingChatFile(files[0]);
  });
}

function handleChatPaste(event){
  const items = [...(event.clipboardData?.items || [])];
  const fileItem = items.find(item => item.kind === 'file' && (item.type.startsWith('image/') || item.type.includes('text') || item.type.includes('wordprocessingml') || item.type.includes('json') || item.type === 'application/pdf'));
  if(!fileItem) return;
  const file = fileItem.getAsFile();
  if(!file) return;
  event.preventDefault();
  const name = file.name || (file.type.startsWith('image/') ? `screenshot-${Date.now()}.png` : `file-${Date.now()}`);
  const renamed = new File([file], name, {type:file.type || 'application/octet-stream'});
  setPendingChatFile(renamed);
}

async function loadErrors(){
  const rows = await api('/api/errors');
  const repeatBtn = $('repeatErrorsTopBtn');
  if(!rows.length){
    if(repeatBtn) repeatBtn.classList.add('hidden');
    $('errorsList').innerHTML = '<p class="muted">Ошибок пока нет.</p>';
    return;
  }
  if(repeatBtn){
    repeatBtn.classList.remove('hidden');
    repeatBtn.textContent = `Повторить ошибки (${rows.length})`;
  }
  $('errorsList').innerHTML = rows.map(e => `
    <div class="error-item">
      <div class="muted">${formatOmskDate(e.answered_at)} · ${escapeHtml(e.question.topic_title || '')}</div>
      <b class="error-question-prompt">${formatQuestionPrompt(e.question.prompt)}</b>
      <p><b>Правильный ответ:</b> ${renderCorrectAnswerForError(e.question)}</p>
    </div>`).join('');
  if (window.MathJax) MathJax.typesetPromise();
}


function renderCorrectAnswerForError(question){
  if(!question) return '—';
  if(question.kind === 'mcq'){
    const byIndex = (question.choices || []).find(choice => choice.index === question.correct_choice_index);
    const text = byIndex?.text ?? question.correct_answer ?? '—';
    return renderInlineRichText(String(text));
  }
  return renderInlineRichText(String(question.correct_answer ?? '—'));
}

function renderInlineRichText(value){
  return escapeHtml(value);
}
async function loadStats(){
  const s = await api('/api/stats');
  $('statsPanel').innerHTML = `
    <div class="summary-grid">
      <div class="metric"><strong>${s.readiness}%</strong><span>общая готовность</span></div>
      <div class="metric"><strong>${s.accuracy}%</strong><span>точность ответов</span></div>
      <div class="metric"><strong>${s.answered_unique}/${s.total_questions}</strong><span>уникальных вопросов</span></div>
      <div class="metric"><strong>${s.sessions_total}</strong><span>сессий</span></div>
    </div>
    <h3>По сложностям</h3>
    ${table(['Сложность','Вопросов','Отвечено','Верно','Ошибок'], s.difficulties.map(d=>[labelDifficulty(d.difficulty), d.questions, d.answered, d.correct, d.wrong]))}
    <h3>По темам</h3>
    ${table(['Тема','Вопросов','Отвечено','Верно','Ошибок'], s.topics.map(t=>[`${t.external_id}. ${escapeHtml(t.title)}`, t.questions, t.answered, t.correct, t.wrong]))}
  `;
}



function buildFlashcards(){
  flashcards = topics.map(t => ({
    id: t.id,
    title: `${t.external_id}. ${t.title}`,
    front: `Вспомни краткую теорию по теме: ${t.title}`,
    back: t.theory || 'Теория для этой темы пока не заполнена.',
    simpleBack: t.simple_theory || ''
  }));
}

function initFlashcards(){
  if(!flashcards.length) buildFlashcards();
  flashIndex = Math.min(flashIndex, Math.max(0, flashcards.length - 1));
  flashFlipped = false;
  renderFlashcard();
}

function renderFlashcard(){
  if(!flashcards.length){
    $('flashcard').innerHTML = '<div class="flash-face"><h3>Карточек пока нет</h3><p>Сначала загрузите темы.</p></div>';
    $('flashProgress').textContent = '0/0';
    return;
  }
  const card = flashcards[flashIndex];
  $('flashProgress').textContent = `Карточка ${flashIndex + 1} из ${flashcards.length}`;
  $('flashcard').classList.toggle('flipped', flashFlipped);
  $('flashcard').innerHTML = flashFlipped ? `
    <div class="flash-face flash-back">
      <div class="theory-title-row compact">
        <div class="muted">Ответ / теория</div>
        <button class="report-btn" onclick="event.stopPropagation(); openTheoryReport(${card.id})">Пожаловаться на ошибку в теории</button>
      </div>
      <h3>${escapeHtml(card.title)}</h3>
      ${theoryModeToggleHtml()}
      <div class="theory">${renderTheory(pickTheory(card.back, card.simpleBack))}</div>
    </div>` : `
    <div class="flash-face flash-front">
      <div class="muted">Вопрос</div>
      <h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.front)}</p>
      <span class="flip-hint">Нажми на карточку или кнопку «Перевернуть»</span>
    </div>`;
  if (window.MathJax) MathJax.typesetPromise();
}

function flipFlashcard(){
  flashFlipped = !flashFlipped;
  renderFlashcard();
}

function nextFlashcard(){
  if(!flashcards.length) return;
  flashIndex = (flashIndex + 1) % flashcards.length;
  flashFlipped = false;
  renderFlashcard();
}

function prevFlashcard(){
  if(!flashcards.length) return;
  flashIndex = (flashIndex - 1 + flashcards.length) % flashcards.length;
  flashFlipped = false;
  renderFlashcard();
}

function shuffleFlashcards(){
  for(let i = flashcards.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i + 1));
    [flashcards[i], flashcards[j]] = [flashcards[j], flashcards[i]];
  }
  flashIndex = 0;
  flashFlipped = false;
  renderFlashcard();
  toast('Карточки перемешаны');
}

async function resetProgress(){
  const confirmed = await showModal({
    title: 'Сбросить весь прогресс?',
    message: 'Это действие удалит историю прохождений, ошибки, правильные ответы, активные тесты и всю статистику. Отменить сброс будет нельзя.',
    extraHtml: '<div class="confirm-warning">Для подтверждения нажмите красную кнопку ниже.</div>',
    confirmText: 'Да, сбросить прогресс',
    cancelText: 'Отмена',
    danger: true
  });
  if(!confirmed) return;
  const result = await api('/api/progress/reset', {method:'POST'});
  currentSession = null;
  currentIndex = 0;
  toast(`Прогресс сброшен. Удалено сессий: ${result.sessions_deleted}`);
  await loadSummary();
  await loadStats();
}

async function exportProgress(){
  const data = await api('/api/export');
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'exam-progress.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importProgress(e){
  const file = e.target.files[0];
  if(!file) return;
  try{
    const text = await file.text();
    const payload = JSON.parse(text);
    if(payload.format !== 'exam-prep-progress-v1'){
      throw new Error('Это не файл экспорта прогресса exam-prep-progress-v1');
    }
    const confirmed = await showModal({
      title: 'Импортировать прогресс?',
      message: 'Данные из файла полностью заменят текущий прогресс этого аккаунта. Перед импортом текущая история, ошибки и активные тесты будут удалены.',
      confirmText: 'Импортировать',
      cancelText: 'Отмена'
    });
    if(!confirmed) return;
    const result = await api('/api/import/progress', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload)});
    toast(`Импортировано: ${result.restored_answers} ответов`);
    await loadSummary();
    if(document.getElementById('stats')?.classList.contains('active')) await loadStats();
  }catch(err){
    toast(err.message || 'Не удалось импортировать прогресс');
  }finally{
    e.target.value = '';
  }
}



function openQuestionReport(questionId){
  const item = currentSession?.questions?.find(x => x.question.id === questionId) || currentSession?.questions?.[currentIndex];
  const q = item?.question;
  if(!q){ toast('Вопрос не найден'); return; }
  openReportPanel({
    target_type: 'question',
    question_id: q.id,
    topic_id: q.topic_id,
    title: `Вопрос ${currentIndex + 1}: ${q.topic_title || 'без темы'}`,
    page_context: {
      session_id: currentSession?.id || '',
      question_external_id: q.external_id || '',
      topic: q.topic_title || '',
      prompt_preview: String(q.prompt || '').replace(/<[^>]*>/g, '').slice(0, 300)
    }
  });
}

function openTheoryReport(topicId){
  const topic = topics.find(t => Number(t.id) === Number(topicId));
  if(!topic){ toast('Тема не найдена'); return; }
  openReportPanel({
    target_type: 'theory',
    topic_id: topic.id,
    title: `Теория ${topic.external_id}. ${topic.title}`,
    page_context: {
      topic_external_id: topic.external_id,
      topic: topic.title
    }
  });
}

function openReportPanel(context){
  reportContext = context;
  const titleNode = $('reportTitle');
  if(titleNode) titleNode.textContent = context.target_type === 'question' ? 'Пожаловаться на ошибку в вопросе' : 'Пожаловаться на ошибку в теории';
  $('reportTarget').textContent = context.title || 'Ошибка в материале';
  $('reportMessage').value = '';
  $('reportPanel').classList.remove('hidden');
  setTimeout(() => {
    $('reportPanel').scrollIntoView({behavior:'smooth', block:'end'});
    $('reportMessage').focus({preventScroll:true});
  }, 60);
}

function closeReportPanel(){
  reportContext = null;
  $('reportPanel').classList.add('hidden');
  $('reportMessage').value = '';
}

async function submitReport(){
  if(!reportContext){ toast('Не выбран объект жалобы'); return; }
  const message = $('reportMessage').value.trim();
  if(message.length < 5){ toast('Опишите ошибку чуть подробнее'); return; }
  $('reportSubmit').disabled = true;
  try{
    await api('/api/reports', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({...reportContext, message})
    });
    toast('Жалоба отправлена администратору');
    closeReportPanel();
  }catch(err){
    toast(err.message || 'Не удалось отправить жалобу');
  }finally{
    $('reportSubmit').disabled = false;
  }
}

function showModal({title, message, extraHtml = '', confirmText = 'ОК', cancelText = 'Отмена', danger = false}){
  return new Promise(resolve => {
    const backdrop = $('appModal');
    const titleEl = $('modalTitle');
    const messageEl = $('modalMessage');
    const extraEl = $('modalExtra');
    const confirmBtn = $('modalConfirm');
    const cancelBtn = $('modalCancel');

    titleEl.textContent = title || '';
    messageEl.textContent = message || '';
    extraEl.innerHTML = extraHtml || '';
    confirmBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    confirmBtn.className = danger ? 'danger' : '';
    backdrop.classList.remove('hidden');

    const cleanup = (value) => {
      backdrop.classList.add('hidden');
      confirmBtn.onclick = null;
      cancelBtn.onclick = null;
      backdrop.onclick = null;
      document.onkeydown = null;
      resolve(value);
    };

    confirmBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    backdrop.onclick = (event) => { if(event.target === backdrop) cleanup(false); };
    document.onkeydown = (event) => { if(event.key === 'Escape') cleanup(false); };
  });
}

function table(headers, rows){
  return `<table class="table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderTheory(raw){
  let text = String(raw || '').trim();
  if(!text) return '<p>Теория для темы пока не заполнена.</p>';
  const compactMath = value => value.trim().replace(/\s+/g, ' ');
  text = text.replace(/\$\$([\s\S]*?)\$\$/g, (_, m) => `\\[${compactMath(m)}\\]`);
  text = text.replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => `\\[${compactMath(m)}\\]`);
  text = text.replace(/(^|[^\\])\$([^$\n]+?)\$/g, (_, prefix, m) => `${prefix}\\(${m.trim()}\\)`);

  const lines = text.split(/\n+/).map(x => x.trim()).filter(Boolean);
  let html = '';
  let list = null;

  const closeList = () => { if(list){ html += `</${list}>`; list = null; } };
  const openList = (tag) => { if(list !== tag){ closeList(); html += `<${tag}>`; list = tag; } };
  const inline = (value) => {
    const mathParts = [];
    const protectedValue = String(value).replace(/\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g, (match) => {
      const token = `@@MATH_${mathParts.length}@@`;
      mathParts.push(escapeHtml(match));
      return token;
    });
    let html = escapeHtml(protectedValue)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    mathParts.forEach((math, index) => {
      html = html.replace(`@@MATH_${index}@@`, math);
    });
    return html;
  };

  const calloutMap = {
    'Пример': 'example',
    'Наглядный пример': 'example',
    'Верная цифра': 'example',
    'Значащие цифры': 'example',
    'Сумма погрешностей': 'example',
    'Вычитание близких чисел': 'warning',
    'Произведение': 'example',
    'Контрпример': 'contrast',
    'Сравнение': 'contrast',
    'Контрастные ситуации': 'contrast',
    'Интуиция': 'intuition',
    'Как применять': 'steps',
    'Типичные ошибки': 'mistakes',
    'Памятка': 'memory',
    'Практический смысл': 'memory',
    'Как отвечать на тесте': 'steps'
  };

  const renderCallout = (label, body, variant = 'note') => {
    closeList();
    html += `<div class="theory-callout theory-${variant}"><div class="theory-label">${inline(label)}</div><div class="theory-body">${inline(body)}</div></div>`;
  };

  const renderMiniTask = (line) => {
    closeList();
    const body = line.replace(/^Мини-задача:\s*/i, '').trim();
    const parts = body.split(/\s+Ответ:\s*/i);
    const task = parts[0] || body;
    const answer = parts.slice(1).join(' Ответ: ');
    html += `<div class="theory-callout theory-task"><div class="theory-label">Мини-задача</div><div class="theory-body">${inline(task)}</div>`;
    if(answer){
      html += `<details class="theory-answer"><summary>Показать ответ</summary><div>${inline(answer)}</div></details>`;
    } else {
      html += `<details class="theory-answer"><summary>Показать ответ</summary><div>Ответ для этой мини-задачи пока не указан.</div></details>`;
    }
    html += `</div>`;
  };

  for(const line of lines){
    if(/^---+$/.test(line)){ closeList(); html += '<hr>'; continue; }
    if(/^\\\[[\s\S]*\\\]$/.test(line)){ closeList(); html += `<div class="math-block">${escapeHtml(line)}</div>`; continue; }
    if(/^Мини-задача:/i.test(line)){ renderMiniTask(line); continue; }

    const labeled = line.match(/^([А-ЯЁA-Z][А-Яа-яЁёA-Za-z\s\-]+):\s*(.+)$/);
    if(labeled && calloutMap[labeled[1]]){
      renderCallout(labeled[1], labeled[2], calloutMap[labeled[1]]);
      continue;
    }

    const ordered = line.match(/^(\d+)\.\s+(.+)$/);
    if(ordered){ openList('ol'); html += `<li>${inline(ordered[2])}</li>`; continue; }
    const unordered = line.match(/^[-*]\s+(.+)$/);
    if(unordered){ openList('ul'); html += `<li>${inline(unordered[1])}</li>`; continue; }
    if(line.endsWith(':') && line.length <= 90){ closeList(); html += `<h5>${inline(line.slice(0, -1))}</h5>`; continue; }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return html;
}
function labelDifficulty(d){ return {very_easy:'самый простой', easy:'простой', medium:'средний', hard:'сложный'}[d] || d; }
function labelMode(s){
  if(s.mode === 'custom') return 'Конструктор потока';
  if(s.mode === 'difficulty') return `Все вопросы: ${labelDifficulty(s.difficulty)}`;
  if(s.mode === 'readiness') return `Готовность ${s.readiness_level}%`;
  if(s.mode === 'topic') return 'Тема';
  if(s.mode === 'official') return 'Образец';
  if(s.mode === 'errors') return 'Ошибки';
  return 'Экзамен';
}

function formatOmskDate(value){
  if(!value) return '—';
  const raw = String(value);
  const normalized = /Z$|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw}Z`;
  const date = new Date(normalized);
  if(Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Omsk',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date) + ' (Омск)';
}
function escapeHtml(str){ return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
function escapeAttribute(str){ return escapeHtml(str).replace(/`/g, '&#096;'); }

init().catch(err => { console.error(err); toast(err.message); });
