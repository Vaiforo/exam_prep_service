let authToken = localStorage.getItem('examPrepToken') || '';
let currentUser = null;

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

const $ = id => document.getElementById(id);
const show = name => {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(name).classList.add('active');
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (window.MathJax) MathJax.typesetPromise();
};
const toast = msg => { const t=$('toast'); t.textContent=msg; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'), 2500); };

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
  await checkAuth();
}

function bindEvents(){
  document.querySelectorAll('.nav').forEach(b => b.onclick = () => { show(b.dataset.view); if(b.dataset.view==='errors') loadErrors(); if(b.dataset.view==='stats') loadStats(); if(b.dataset.view==='flashcards') initFlashcards(); if(b.dataset.view==='theory') renderTheoryTopic(); });
  document.querySelectorAll('.mode').forEach(b => b.onclick = () => startTest({mode:b.dataset.mode, count:20}));
  document.querySelectorAll('.readiness').forEach(b => b.onclick = () => startTest({mode:'readiness', readiness_level:Number(b.dataset.level), count:20}));
  document.querySelectorAll('.difficulty').forEach(b => b.onclick = () => startTest({mode:'difficulty', difficulty:b.dataset.difficulty, count:1000}));
  $('builderStart').onclick = startCustomFlow;
  $('builderAllTopics').onclick = () => setBuilderTopics(true);
  $('builderClearTopics').onclick = () => setBuilderTopics(false);
  $('backHome').onclick = () => { show('dashboard'); loadSummary(); };
  $('prevBtn').onclick = prevQuestion;
  $('checkBtn').onclick = checkCurrent;
  $('nextBtn').onclick = nextQuestion;
  $('exportBtn').onclick = exportProgress;
  $('importBtn').onclick = () => { $('importFile').value = ''; $('importFile').click(); };
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
  $('authView').classList.remove('hidden');
  $('appLayout').classList.add('hidden');
  $('userBox').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
  $('exportBtn').classList.add('hidden');
  $('importBtn').classList.add('hidden');
}

async function showApp(){
  $('authView').classList.add('hidden');
  $('appLayout').classList.remove('hidden');
  $('userBox').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  $('exportBtn').classList.remove('hidden');
  $('importBtn').classList.remove('hidden');
  $('userBox').textContent = `Пользователь: ${currentUser.username}`;
  await loadTopics();
  await loadSummary();
  show('dashboard');
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
  try{ await api('/api/auth/logout', {method:'POST'}); }catch{}
  authToken = '';
  currentUser = null;
  localStorage.removeItem('examPrepToken');
  showAuth();
}

async function loadTopics(){
  topics = await api('/api/topics');
  $('topicsList').innerHTML = topics.map(t => `
    <article class="topic-card">
      <h3>${t.external_id}. ${escapeHtml(t.title)}</h3>
      <p class="muted">Вопросов: ${t.questions_count}</p>
      <div class="topic-buttons">
        <button onclick="startTest({mode:'topic', topic_id:${t.id}, count:20})">Тренировать тему</button>
        <button class="secondary" onclick="openTheory(${t.id})">Открыть теорию</button>
      </div>
    </article>
  `).join('');
  $('theorySelect').innerHTML = topics.map(t => `<option value="${t.id}">${t.external_id}. ${escapeHtml(t.title)}</option>`).join('');
  $('builderTopics').innerHTML = topics.map(t => `
    <label><input class="builder-topic" type="checkbox" value="${t.id}" checked> ${t.external_id}. ${escapeHtml(t.title)}</label>
  `).join('');
  buildFlashcards();
}

function setBuilderTopics(checked){
  document.querySelectorAll('.builder-topic').forEach(input => input.checked = checked);
}

async function startCustomFlow(){
  const topic_ids = [...document.querySelectorAll('.builder-topic:checked')].map(x => Number(x.value));
  const difficulties = [...document.querySelectorAll('.builder-difficulty:checked')].map(x => x.value);
  const count = Math.max(1, Math.min(1000, Number($('builderCount').value || 20)));
  if(!topic_ids.length){ toast('Выберите хотя бы одну тему'); return; }
  if(!difficulties.length){ toast('Выберите хотя бы одну сложность'); return; }
  await startTest({mode:'custom', topic_ids, difficulties, count});
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
    <h3>${topic.external_id}. ${escapeHtml(topic.title)}</h3>
    <div class="theory">${renderTheory(topic.theory || 'Теория для темы пока не заполнена.')}</div>
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
  $('questionText').innerHTML = q.prompt;
  $('progressBar').style.width = `${(currentIndex/currentSession.questions.length)*100}%`;
  $('feedback').className = 'feedback hidden';
  $('feedback').innerHTML = '';
  if(q.kind === 'mcq'){
    $('answerArea').innerHTML = `<div class="options">${q.choices.map(c => {
      const checked = q.user_answer && q.user_answer.selected_index === c.index ? 'checked' : '';
      return `
      <label class="option"><input type="radio" name="answer" value="${c.index}" ${checked}><span class="option-index">${c.index+1}</span><div class="option-text">${c.text}</div></label>`;
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
    <p><b>Почему этот вариант правильный:</b> ${r.explanation || 'Ответ соответствует формуле и условиям метода из темы.'}</p>
    <h4>Краткая теория</h4>
    <div class="theory">${renderTheory(r.theory || 'Теория для темы пока не заполнена.')}</div>
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
  else { api(`/api/sessions/${currentSession.id}/finish`, {method:'POST'}).then(s => { currentSession=s; toast(`Тест завершён: ${s.correct_count}/${s.total}`); show('stats'); loadStats(); }); }
}

function copyPrompt(){
  const text = $('promptBox')?.textContent || '';
  navigator.clipboard.writeText(text).then(()=>toast('Промпт скопирован'));
}

async function loadErrors(){
  const rows = await api('/api/errors');
  if(!rows.length){ $('errorsList').innerHTML = '<p class="muted">Ошибок пока нет.</p>'; return; }
  $('errorsList').innerHTML = rows.map(e => `
    <div class="error-item">
      <div class="muted">${new Date(e.answered_at).toLocaleString()} · ${escapeHtml(e.question.topic_title || '')}</div>
      <b>${e.question.prompt}</b>
      <p><b>Правильный ответ:</b> ${escapeHtml(String(e.question.correct_answer ?? ''))}</p>
      <button onclick="startTest({mode:'errors', count:20})">Повторить ошибки</button>
    </div>`).join('');
  if (window.MathJax) MathJax.typesetPromise();
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
    back: t.theory || 'Теория для этой темы пока не заполнена.'
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
      <div class="muted">Ответ / теория</div>
      <h3>${escapeHtml(card.title)}</h3>
      <div class="theory">${renderTheory(card.back)}</div>
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
  // Старые данные могли содержать Markdown/LaTeX в формате $...$ и $$...$$.
  // Схлопываем многострочные display-формулы в одну строку, чтобы MathJax
  // не показывал отдельные строки формулы как обычный текст.
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

  for(const line of lines){
    if(/^---+$/.test(line)){ closeList(); html += '<hr>'; continue; }
    if(/^\\\[[\s\S]*\\\]$/.test(line)){ closeList(); html += `<div class="math-block">${escapeHtml(line)}</div>`; continue; }
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
function escapeHtml(str){ return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }
function escapeAttribute(str){ return escapeHtml(str).replace(/`/g, '&#096;'); }

init().catch(err => { console.error(err); toast(err.message); });
