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
  ['click', 'touchstart', 'keydown'].forEach(eventName => {
    document.addEventListener(eventName, () => pingActivity(false), {passive:true});
  });
  setInterval(() => pingActivity(true), 60000);
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
  document.querySelectorAll('.nav').forEach(b => b.onclick = () => { show(b.dataset.view); if(b.dataset.view==='errors') loadErrors(); if(b.dataset.view==='results') loadResults(); if(b.dataset.view==='stats') loadStats(); if(b.dataset.view==='flashcards') initFlashcards(); if(b.dataset.view==='theory') renderTheoryTopic(); if(b.dataset.view==='dashboard') refreshCustomFlowInfo(); });
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
  await loadTopics();
  await loadSummary();
  await loadSiteNotifications(true);
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
      <button class="report-btn" onclick="openTheoryReport(${topic.id})">Пожаловаться на ошибку</button>
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

function renderQuestion(){
  lastFeedback = null;
  const item = currentSession.questions[currentIndex];
  const q = item.question;
  $('testMeta').textContent = `${labelMode(currentSession)} · ${currentSession.answered}/${currentSession.total}`;
  $('questionCounter').textContent = `Вопрос ${currentIndex+1} из ${currentSession.questions.length} · ${q.topic_title || ''} · ${labelDifficulty(q.difficulty)}`;
  $('questionText').innerHTML = `${q.prompt}<div class="question-report-wrap"><button class="report-btn question-report" onclick="openQuestionReport(${q.id})">Пожаловаться на ошибку</button></div>`;
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
    $('answerArea').innerHTML = `<input class="answer-input" id="inputAnswer" placeholder="Введите ответ" value="${escapeAttribute(previous)}" />`;
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
      <button class="report-btn" onclick="openTheoryReport(${q.topic_id})">Пожаловаться на ошибку</button>
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
    <h4>${q.prompt}</h4>
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
      <b>${e.question.prompt}</b>
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
        <button class="report-btn" onclick="event.stopPropagation(); openTheoryReport(${card.id})">Пожаловаться на ошибку</button>
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
  const inline = (value) => escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

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
