let adminToken = sessionStorage.getItem('examAdminToken') || '';
let selectedUserId = null;
let refreshTimer = null;
let currentAdminTab = "users";
let userSearchTimer = null;
let selectedAdminChatKey = "group";
let currentQuestionExternalId = null;

const $ = id => document.getElementById(id);
const toast = msg => {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2600);
};

function typesetMath(root = document.body){
  if(window.MathJax && typeof MathJax.typesetPromise === 'function'){
    MathJax.typesetPromise(root ? [root] : undefined).catch(() => {});
  }
}

function initTheme(){
  const saved = localStorage.getItem('examPrepTheme') || 'light';
  applyTheme(saved);
}

function applyTheme(theme){
  const normalized = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = normalized;
  localStorage.setItem('examPrepTheme', normalized);
  const btn = $('adminThemeToggle');
  if(btn) btn.textContent = normalized === 'dark' ? '☀️ Светлая тема' : '🌙 Тёмная тема';
}

function toggleTheme(){
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
}

async function api(url, options = {}){
  const headers = {...(options.headers || {})};
  if(adminToken) headers.Authorization = `Bearer ${adminToken}`;
  const response = await fetch(url, {...options, headers});
  const text = await response.text();
  let data = null;
  try{ data = text ? JSON.parse(text) : null; }catch{ data = text; }
  if(!response.ok){
    if(response.status === 401) showLogin();
    throw new Error((data && data.detail) || response.statusText || 'Ошибка запроса');
  }
  return data;
}

function showLogin(){
  stopAutoRefresh();
  $('loginView').classList.remove('hidden');
  $('adminView').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
}

function showAdmin(username){
  $('loginView').classList.add('hidden');
  $('adminView').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  $('adminInfo').textContent = `Администратор: ${username || 'admin'}`;
  startAutoRefresh();
}

async function init(){
  initTheme();
  bind();
  if(adminToken){
    try{
      const me = await api('/api/admin/me');
      showAdmin(me.username);
      await loadAdminOverview();
      await loadUsers();
      await loadReports();
      await loadMetrics();
      await loadAdminNotifications();
      await loadAdminChat();
    }catch{
      adminToken = '';
      sessionStorage.removeItem('examAdminToken');
      showLogin();
    }
  }else{
    showLogin();
  }
}

function bind(){
  $('loginBtn').onclick = login;
  $('logoutBtn').onclick = logout;
  $('refreshBtn').onclick = () => { loadUsers(); };
  if($('refreshOverviewBtn')) $('refreshOverviewBtn').onclick = () => loadAdminOverview();
  $('refreshMetricsBtn').onclick = loadMetrics;
  $('sendNotificationBtn').onclick = sendAdminNotification;
  $('clearPatchNotesBtn').onclick = clearPatchNotes;
  $('savePatchNotesBtn').onclick = savePatchNotes;
  if($('refreshAdminChatBtn')) $('refreshAdminChatBtn').onclick = () => loadAdminChat(true);
  $('userStatusFilter').onchange = loadUsers;
  if($('userSort')) $('userSort').onchange = loadUsers;
  $('userSearch').oninput = () => { clearTimeout(userSearchTimer); userSearchTimer = setTimeout(loadUsers, 250); };
  document.querySelectorAll('.admin-tab').forEach(btn => btn.onclick = () => switchAdminTab(btn.dataset.tab));
  $('reportStatusFilter').onchange = loadReports;
  if($('loadQuestionBtn')) $('loadQuestionBtn').onclick = loadQuestionForEdit;
  if($('previewQuestionBtn')) $('previewQuestionBtn').onclick = previewQuestionEdit;
  if($('saveQuestionBtn')) $('saveQuestionBtn').onclick = saveQuestionOverride;
  if($('resetOverrideBtn')) $('resetOverrideBtn').onclick = resetQuestionOverride;
  if($('qKindEdit')) $('qKindEdit').onchange = toggleQuestionKindEditor;
  if($('adminQuestionIdInput')) $('adminQuestionIdInput').addEventListener('keydown', event => { if(event.key === 'Enter') loadQuestionForEdit(); });
  $('adminThemeToggle').onclick = toggleTheme;
  $('adminPassword').addEventListener('keydown', event => {
    if(event.key === 'Enter') login();
  });
}

function startAutoRefresh(){
  stopAutoRefresh();
}

function stopAutoRefresh(){
  if(refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}


function switchAdminTab(tab){
  currentAdminTab = tab || 'users';
  document.querySelectorAll('.admin-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === currentAdminTab));
  ['users','reports','questions','metrics','notifications','chat'].forEach(name => {
    const panel = $(`${name}Tab`);
    if(panel) panel.classList.toggle('hidden', name !== currentAdminTab);
  });
  if(currentAdminTab === 'users') loadUsers().catch(() => {});
  if(currentAdminTab === 'reports') loadReports().catch(() => {});
  if(currentAdminTab === 'questions' && currentQuestionExternalId) loadQuestionForEdit().catch(() => {});
  if(currentAdminTab === 'metrics') loadMetrics().catch(() => {});
  if(currentAdminTab === 'notifications') loadAdminNotifications().catch(() => {});
  if(currentAdminTab === 'chat') loadAdminChat(false).catch(() => {});
}


async function loadAdminOverview(){
  if(!$('adminOverview')) return;
  try{
    const m = await api('/api/admin/metrics');
    $('overviewUsers').textContent = `${m.online_users || 0}/${m.users_total || 0}`;
    $('overviewUsersHint').textContent = `${m.offline_users || 0} оффлайн`;
    $('overviewReports').textContent = m.reports_new || 0;
    $('overviewSessions').textContent = m.active_sessions || 0;
    $('overviewQuestions').textContent = m.questions_total || 0;
    $('overviewQuestionsHint').textContent = `${m.topics_total || 0} тем`;
  }catch(err){
    // Обзор не должен мешать основной работе админки.
  }
}

async function login(){
  const username = $('adminUsername').value.trim();
  const password = $('adminPassword').value;
  $('loginError').classList.add('hidden');
  $('loginBtn').disabled = true;
  $('loginBtn').textContent = 'Вход...';
  try{
    const result = await api('/api/admin/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username, password})
    });
    adminToken = result.token;
    sessionStorage.setItem('examAdminToken', adminToken);
    showAdmin(result.admin.username);
    await loadAdminOverview();
    await loadUsers();
    await loadReports();
    await loadMetrics();
  }catch(err){
    $('loginError').textContent = err.message || 'Не удалось войти';
    $('loginError').classList.remove('hidden');
  }finally{
    $('loginBtn').disabled = false;
    $('loginBtn').textContent = 'Войти';
  }
}

async function logout(){
  try{ await api('/api/admin/logout', {method:'POST'}); }catch{}
  adminToken = '';
  sessionStorage.removeItem('examAdminToken');
  selectedUserId = null;
  showLogin();
}

async function loadUsers(){
  const status = $('userStatusFilter')?.value || 'all';
  const search = $('userSearch')?.value?.trim() || '';
  const sortMode = $('userSort')?.value || 'activity';
  const params = new URLSearchParams();
  if(status && status !== 'all') params.set('status', status);
  if(search) params.set('q', search);
  const query = params.toString() ? `?${params.toString()}` : '';
  $('usersList').innerHTML = '<div class="admin-skeleton">Загружаю пользователей…</div>';
  const users = sortUsers(await api(`/api/admin/users${query}`), sortMode);
  loadAdminOverview().catch(() => {});
  renderUserListSummary(users, status, search);
  $('usersList').innerHTML = users.map(renderUserCard).join('') || '<div class="user-empty-state"><b>Пользователи не найдены</b><span>Измени поиск или фильтр статуса.</span></div>';
}

function sortUsers(users, sortMode){
  const rows = [...(users || [])];
  const lastSeen = user => user.last_seen_at ? new Date(user.last_seen_at).getTime() || 0 : 0;
  const numeric = key => user => Number(user[key] || 0);
  const sorters = {
    activity: (a,b) => Number(b.is_online) - Number(a.is_online) || lastSeen(b) - lastSeen(a) || a.username.localeCompare(b.username),
    readiness: (a,b) => numeric('readiness')(b) - numeric('readiness')(a) || a.username.localeCompare(b.username),
    accuracy: (a,b) => numeric('accuracy')(b) - numeric('accuracy')(a) || a.username.localeCompare(b.username),
    errors: (a,b) => numeric('wrong_answers')(b) - numeric('wrong_answers')(a) || a.username.localeCompare(b.username),
    sessions: (a,b) => numeric('sessions_total')(b) - numeric('sessions_total')(a) || a.username.localeCompare(b.username),
    name: (a,b) => a.username.localeCompare(b.username),
  };
  return rows.sort(sorters[sortMode] || sorters.activity);
}

function renderUserListSummary(users, status, search){
  const el = $('userListSummary');
  if(!el) return;
  const total = users.length;
  const online = users.filter(u => u.is_online).length;
  const parts = [`${total} ${pluralRu(total, 'пользователь', 'пользователя', 'пользователей')}`, `${online} онлайн`];
  if(status !== 'all') parts.push(status === 'online' ? 'фильтр: онлайн' : 'фильтр: оффлайн');
  if(search) parts.push(`поиск: ${escapeHtml(search)}`);
  el.innerHTML = parts.join(' · ');
}

function renderUserCard(u){
  const initial = escapeHtml(String(u.username || '?').slice(0,1).toUpperCase());
  const readiness = clampPercent(u.readiness);
  const accuracy = clampPercent(u.accuracy);
  const coverage = clampPercent(u.coverage);
  return `
    <article class="user-card ${u.id === selectedUserId ? 'active' : ''}" onclick="selectUser(${u.id})">
      <div class="user-card-main">
        <div class="user-avatar ${u.is_online ? 'online' : 'offline'}">${initial}</div>
        <div class="user-card-title">
          <h3>${escapeHtml(u.username)}</h3>
          <div class="user-card-subline">
            <span class="badge">id ${u.id}</span>
            <span class="status-badge ${u.is_online ? 'online' : 'offline'}">${u.is_online ? 'Онлайн' : 'Оффлайн'}</span>
          </div>
        </div>
      </div>
      <div class="user-progress-lines">
        ${miniProgress('Готовность', readiness)}
        ${miniProgress('Точность', accuracy)}
      </div>
      <div class="user-meta user-meta-grid">
        <span><b>${u.answered_unique || 0}</b><small>отвечено</small></span>
        <span><b>${u.correct_answers || 0}</b><small>верно</small></span>
        <span><b>${u.wrong_answers || 0}</b><small>ошибок</small></span>
        <span><b>${u.sessions_total || 0}</b><small>сессий</small></span>
      </div>
      <div class="user-card-foot">
        <span>Покрытие ${coverage}%</span>
        <span>${u.last_seen_at ? `Активность: ${formatOmskDate(u.last_seen_at)}` : `Создан: ${formatOmskDate(u.created_at)}`}</span>
      </div>
    </article>
  `;
}

function miniProgress(label, value){
  const safe = clampPercent(value);
  return `<div class="mini-progress"><div><span>${label}</span><b>${safe}%</b></div><div class="mini-progress-track"><i style="width:${safe}%"></i></div></div>`;
}

function clampPercent(value){
  const n = Number(value || 0);
  return Math.max(0, Math.min(100, Number.isFinite(n) ? Math.round(n * 10) / 10 : 0));
}

function pluralRu(n, one, few, many){
  const abs = Math.abs(Number(n) || 0);
  if(abs % 10 === 1 && abs % 100 !== 11) return one;
  if(abs % 10 >= 2 && abs % 10 <= 4 && (abs % 100 < 10 || abs % 100 >= 20)) return few;
  return many;
}

async function loadReports(){
  if(!$('reportsList')) return;
  const status = $('reportStatusFilter')?.value || 'all';
  const query = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : '';
  $('reportsList').innerHTML = '<div class="admin-skeleton">Загружаю жалобы…</div>';
  const rows = await api(`/api/admin/reports${query}`);
  loadAdminOverview().catch(() => {});
  $('reportsList').innerHTML = rows.map(renderReport).join('') || '<p class="muted">Жалоб пока нет.</p>';
  typesetMath($('reportsList'));
}

function renderReport(r){
  const target = r.target_type === 'question'
    ? `Вопрос ${escapeHtml(r.question?.external_id || String(r.question?.id || ''))}`
    : `Теория ${escapeHtml(String(r.topic?.external_id || ''))}`;
  const topic = r.topic ? `${r.topic.external_id}. ${escapeHtml(r.topic.title)}` : 'Тема не найдена';
  const sender = r.sender ? `${escapeHtml(r.sender.username)} · id ${r.sender.id}` : 'пользователь удалён';
  const questionBlock = renderReportQuestion(r.question);
  const statusText = {new:'Новая', reviewed:'Просмотрена', resolved:'Решена'}[r.status] || r.status;
  return `
    <article class="report-card-admin report-${escapeHtml(r.status)}">
      <div class="report-admin-top">
        <h3>${target} <span class="report-status">${statusText}</span></h3>
        <span class="muted">${formatOmskDate(r.created_at)}</span>
      </div>
      <div class="muted">Отправитель: ${sender}</div>
      <div class="muted">Тема: ${topic}</div>
      ${questionBlock}
      <div class="report-message"><b>Текст жалобы:</b><br>${escapeHtml(r.message)}</div>
      <div class="actions compact-actions">
        <button class="secondary" onclick="setReportStatus(${r.id}, 'reviewed')">Просмотрено</button>
        <button onclick="setReportStatus(${r.id}, 'resolved')">Решено</button>
        <button class="secondary" onclick="setReportStatus(${r.id}, 'new')">Вернуть в новые</button>
        <button class="danger" onclick="deleteReport(${r.id})">Удалить</button>
      </div>
    </article>`;
}

function renderReportQuestion(question){
  if(!question) return '<div class="report-preview report-question-missing">Вопрос не найден в базе. Возможно, банк вопросов был переимпортирован.</div>';
  const choices = Array.isArray(question.choices) ? question.choices : [];
  const meta = [
    question.external_id ? `ID: ${escapeHtml(question.external_id)}` : '',
    question.kind ? `тип: ${escapeHtml(question.kind)}` : '',
    question.difficulty ? `сложность: ${escapeHtml(labelDifficultyAdmin(question.difficulty))}` : '',
    question.source ? `источник: ${escapeHtml(question.source)}` : '',
  ].filter(Boolean).join(' · ');
  const choicesHtml = choices.length
    ? `<ol class="report-choice-list">${choices.map(choice => {
        const marker = choice.is_correct ? '<span class="report-choice-correct">правильный</span>' : '';
        return `<li><div class="report-choice-text">${escapeHtml(choice.text || '')}</div>${marker}</li>`;
      }).join('')}</ol>`
    : renderReportAnswer(question);
  return `
    <section class="report-question-full">
      <div class="report-question-head">
        <b>Полный вопрос</b>
        ${meta ? `<span>${meta}</span>` : ''}
      </div>
      <div class="report-question-prompt">${escapeHtml(question.prompt || 'Текст вопроса отсутствует')}</div>
      <div class="report-question-choices">
        <b>${choices.length ? 'Варианты ответа' : 'Ответ'}</b>
        ${choicesHtml}
      </div>
    </section>`;
}

function renderReportAnswer(question){
  if(question.answer_text) return `<div class="report-answer-text">${escapeHtml(question.answer_text)}</div>`;
  if(question.answer_value !== null && question.answer_value !== undefined){
    const tolerance = question.tolerance !== null && question.tolerance !== undefined ? ` ± ${escapeHtml(String(question.tolerance))}` : '';
    return `<div class="report-answer-text">${escapeHtml(String(question.answer_value))}${tolerance}</div>`;
  }
  return '<div class="report-answer-text muted">Варианты или ответ не указаны.</div>';
}

async function loadQuestionForEdit(){
  const rawId = $('adminQuestionIdInput')?.value?.trim();
  if(!rawId){ toast('Введите ID вопроса'); return; }
  const externalId = rawId.toUpperCase();
  $('questionEditorEmpty').classList.add('hidden');
  $('questionEditor').classList.remove('hidden');
  $('questionPreview').innerHTML = '<div class="admin-skeleton">Загружаю вопрос…</div>';
  const data = await api(`/api/admin/questions/${encodeURIComponent(externalId)}`);
  currentQuestionExternalId = data.question.external_id;
  fillQuestionEditor(data.question);
  renderQuestionPreview(data.question);
  toast(data.question.has_override ? 'Открыта сохранённая правка вопроса' : 'Открыт вопрос из банка');
}

function fillQuestionEditor(q){
  $('adminQuestionIdInput').value = q.external_id || '';
  $('questionMeta').innerHTML = `ID: <b>${escapeHtml(q.external_id)}</b> · тема: ${q.topic ? `${escapeHtml(String(q.topic.external_id))}. ${escapeHtml(q.topic.title)}` : '—'} · ${q.has_override ? '<span class="question-override-badge">есть сохранённая правка</span>' : 'правки нет'}`;
  $('qKindEdit').value = q.kind || 'mcq';
  $('qDifficultyEdit').value = q.difficulty || 'easy';
  $('qSourceEdit').value = q.source || 'manual';
  $('qPromptEdit').value = q.prompt || '';
  $('qChoicesEdit').value = (q.choices || []).map(choice => choice.text || '').join('\n');
  const correct = (q.choices || []).find(choice => choice.is_correct);
  $('qCorrectIndexEdit').value = correct ? String(Number(correct.index || 0) + 1) : (q.correct_choice_index !== null && q.correct_choice_index !== undefined ? String(Number(q.correct_choice_index) + 1) : '');
  $('qAnswerTextEdit').value = q.answer_text || '';
  $('qAnswerValueEdit').value = q.answer_value !== null && q.answer_value !== undefined ? String(q.answer_value) : '';
  $('qToleranceEdit').value = q.tolerance !== null && q.tolerance !== undefined ? String(q.tolerance) : '';
  $('qExplanationEdit').value = q.explanation || '';
  toggleQuestionKindEditor();
}

function toggleQuestionKindEditor(){
  const isInput = $('qKindEdit')?.value === 'input';
  $('mcqEditBlock')?.classList.toggle('hidden', isInput);
  $('inputEditBlock')?.classList.toggle('hidden', !isInput);
}

function collectQuestionEditorPayload(){
  const kind = $('qKindEdit').value;
  const choices = $('qChoicesEdit').value.split(/\n+/).map(x => x.trim()).filter(Boolean);
  const correctRaw = $('qCorrectIndexEdit').value.trim();
  const payload = {
    prompt: $('qPromptEdit').value.trim(),
    kind,
    difficulty: $('qDifficultyEdit').value,
    source: $('qSourceEdit').value.trim() || 'manual',
    choices: kind === 'mcq' ? choices : [],
    correct_choice_index: kind === 'mcq' && correctRaw ? Number(correctRaw) - 1 : null,
    answer_text: kind === 'input' ? ($('qAnswerTextEdit').value.trim() || null) : null,
    answer_value: kind === 'input' ? parseAdminNumber($('qAnswerValueEdit').value) : null,
    tolerance: kind === 'input' ? parseAdminNumber($('qToleranceEdit').value) : null,
    explanation: $('qExplanationEdit').value.trim(),
  };
  return payload;
}

function parseAdminNumber(value){
  const text = String(value || '').trim().replace(',', '.');
  if(!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

function previewQuestionEdit(){
  const payload = collectQuestionEditorPayload();
  const choices = (payload.choices || []).map((text, index) => ({index, text, is_correct:index === payload.correct_choice_index}));
  renderQuestionPreview({
    external_id: currentQuestionExternalId || $('adminQuestionIdInput').value.trim().toUpperCase() || '—',
    kind: payload.kind,
    difficulty: payload.difficulty,
    source: payload.source,
    prompt: payload.prompt,
    choices,
    answer_text: payload.answer_text,
    answer_value: payload.answer_value,
    tolerance: payload.tolerance,
    explanation: payload.explanation,
  });
}

function renderQuestionPreview(q){
  const answerBlock = q.kind === 'mcq'
    ? `<div class="preview-options">${(q.choices || []).map(choice => `<div class="preview-option ${choice.is_correct ? 'correct' : ''}">${escapeHtml(choice.text || '')}${choice.is_correct ? '<span>правильный</span>' : ''}</div>`).join('') || '<p class="muted">Варианты не указаны.</p>'}</div>`
    : `<div class="preview-input-answer"><b>Ответ:</b> ${escapeHtml(q.answer_text || (q.answer_value !== null && q.answer_value !== undefined ? String(q.answer_value) : '—'))}${q.tolerance !== null && q.tolerance !== undefined ? ` <span class="muted">± ${escapeHtml(String(q.tolerance))}</span>` : ''}</div>`;
  $('questionPreview').classList.remove('muted');
  $('questionPreview').innerHTML = `
    <article class="question-preview-card">
      <div class="question-preview-meta">ID: <b>${escapeHtml(q.external_id || '—')}</b> · тип: ${escapeHtml(q.kind || '—')} · сложность: ${escapeHtml(labelDifficultyAdmin(q.difficulty))} · источник: ${escapeHtml(q.source || '—')}</div>
      <div class="question-preview-prompt">${escapeHtml(q.prompt || 'Текст вопроса пустой')}</div>
      ${answerBlock}
      ${q.explanation ? `<details class="question-preview-explanation"><summary>Объяснение</summary><div>${escapeHtml(q.explanation)}</div></details>` : ''}
    </article>`;
  typesetMath($('questionPreview'));
}

async function saveQuestionOverride(){
  const externalId = (currentQuestionExternalId || $('adminQuestionIdInput').value.trim()).toUpperCase();
  if(!externalId){ toast('Сначала откройте вопрос по ID'); return; }
  const payload = collectQuestionEditorPayload();
  const result = await api(`/api/admin/questions/${encodeURIComponent(externalId)}/override`, {
    method:'PUT',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload),
  });
  currentQuestionExternalId = result.question.external_id;
  fillQuestionEditor(result.question);
  renderQuestionPreview(result.question);
  toast('Правка вопроса сохранена и будет перекрывать банк вопросов');
}

async function resetQuestionOverride(){
  const externalId = (currentQuestionExternalId || $('adminQuestionIdInput').value.trim()).toUpperCase();
  if(!externalId){ toast('Сначала откройте вопрос по ID'); return; }
  const ok = await confirmModal('Сбросить правку вопроса?', 'Сохранённое переопределение будет удалено, вопрос вернётся к версии из bundled questions.json.');
  if(!ok) return;
  const result = await api(`/api/admin/questions/${encodeURIComponent(externalId)}/override`, {method:'DELETE'});
  fillQuestionEditor(result.question);
  renderQuestionPreview(result.question);
  toast('Правка сброшена');
}

async function setReportStatus(reportId, status){
  await api(`/api/admin/reports/${reportId}/status`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({status})
  });
  toast('Статус жалобы обновлён');
  await loadReports();
}

async function deleteReport(reportId){
  const ok = await confirmModal('Удалить обращение?', 'Обращение будет удалено из админ-панели. Это удобно для уже обработанных жалоб.');
  if(!ok) return;
  await api(`/api/admin/reports/${reportId}`, {method:'DELETE'});
  toast('Обращение удалено');
  await loadReports();
}


async function selectUser(userId){
  selectedUserId = userId;
  await loadUsers();
  $('userDetails').classList.remove('muted', 'user-details-empty');
  $('userDetails').innerHTML = '<div class="admin-skeleton">Загружаю детали пользователя…</div>';
  const stats = await api(`/api/admin/users/${userId}/progress`);
  $('userDetails').innerHTML = renderUserDetails(stats, userId);
}

function renderUserDetails(stats, userId){
  const readiness = clampPercent(stats.readiness);
  const accuracy = clampPercent(stats.accuracy);
  const coverage = clampPercent(stats.coverage);
  const weakTopics = [...(stats.topics || [])]
    .filter(t => Number(t.answered || 0) > 0 || Number(t.wrong || 0) > 0)
    .sort((a,b) => Number(b.wrong || 0) - Number(a.wrong || 0) || Number(a.external_id || 0) - Number(b.external_id || 0))
    .slice(0, 5);
  const recentSessions = (stats.recent_sessions || []).slice(0, 5);
  return `
    <div class="user-details-hero">
      <div class="user-details-avatar ${stats.is_online ? 'online' : 'offline'}">${escapeHtml(String(stats.user || stats.username || '?').slice(0,1).toUpperCase())}</div>
      <div class="user-details-title">
        <h3>${escapeHtml(stats.user || stats.username || 'Пользователь')}</h3>
        <div class="user-card-subline">
          <span class="badge">id ${stats.user_id || userId}</span>
          <span class="status-badge ${stats.is_online ? 'online' : 'offline'}">${stats.is_online ? 'Онлайн' : 'Оффлайн'}</span>
          <span class="badge">${stats.has_password ? 'пароль задан' : 'без пароля'}</span>
        </div>
        <p class="muted">Создан: ${formatOmskDate(stats.created_at)} · ${stats.last_seen_at ? `последняя активность: ${formatOmskDate(stats.last_seen_at)}` : 'активности ещё не было'}</p>
      </div>
    </div>

    <div class="user-details-progress-card">
      ${largeProgress('Готовность', readiness, 'общая оценка подготовки')}
      ${largeProgress('Точность', accuracy, 'доля верных ответов')}
      ${largeProgress('Покрытие', coverage, 'сколько банка закрыто верными ответами')}
    </div>

    <div class="summary-grid user-details-metrics">
      <div class="metric"><strong>${stats.answered_unique}/${stats.total_questions}</strong><span>уникальных вопросов</span></div>
      <div class="metric"><strong>${stats.correct_answers}</strong><span>верных ответов</span></div>
      <div class="metric"><strong>${stats.wrong_answers}</strong><span>ошибок</span></div>
      <div class="metric"><strong>${stats.sessions_total}</strong><span>сессий</span></div>
    </div>

    ${renderActiveSessionInfo(stats.active_session)}

    <div class="user-details-columns">
      <section class="user-details-card">
        <h4>Сложности</h4>
        ${renderDifficultyBreakdown(stats.difficulties || [])}
      </section>
      <section class="user-details-card">
        <h4>Темы с ошибками</h4>
        ${renderWeakTopics(weakTopics)}
      </section>
    </div>

    <section class="user-details-card">
      <h4>Последние сессии</h4>
      ${renderRecentSessions(recentSessions)}
    </section>

    <div class="actions user-details-actions">
      <button onclick="resetPassword(${userId})">Сбросить пароль</button>
      <button class="danger" onclick="resetProgress(${userId})">Сбросить прогресс</button>
      <button class="danger" onclick="deleteUser(${userId})">Удалить пользователя</button>
    </div>
  `;
}

function largeProgress(label, value, hint){
  const safe = clampPercent(value);
  return `<div class="large-progress"><div><b>${label}</b><strong>${safe}%</strong></div><div class="large-progress-track"><i style="width:${safe}%"></i></div><span>${hint}</span></div>`;
}

function renderDifficultyBreakdown(rows){
  if(!rows.length) return '<p class="muted">Данных по сложностям пока нет.</p>';
  return `<div class="difficulty-breakdown">${rows.map(row => {
    const answered = Number(row.answered || 0);
    const questions = Number(row.questions || 0);
    const percent = questions ? Math.round(answered / questions * 1000) / 10 : 0;
    return `<div class="difficulty-row"><div><b>${labelDifficultyAdmin(row.difficulty)}</b><span>${answered}/${questions} отвечено · ошибок ${row.wrong || 0}</span></div><div class="mini-progress-track"><i style="width:${clampPercent(percent)}%"></i></div></div>`;
  }).join('')}</div>`;
}

function renderWeakTopics(rows){
  if(!rows.length) return '<p class="muted">Ошибок по темам пока нет.</p>';
  return `<div class="weak-topics">${rows.map(t => {
    const answered = Number(t.answered || 0);
    const wrong = Number(t.wrong || 0);
    const correct = Number(t.correct || 0);
    const attempts = correct + wrong;
    const accuracy = attempts ? Math.round(correct / attempts * 1000) / 10 : 0;
    return `<div class="weak-topic"><b>${escapeHtml(String(t.external_id))}. ${escapeHtml(t.title)}</b><span>${wrong} ошибок · точность ${accuracy}% · отвечено ${answered}/${t.questions}</span></div>`;
  }).join('')}</div>`;
}

function renderRecentSessions(rows){
  if(!rows.length) return '<p class="muted">Пользователь ещё не завершал и не запускал тесты.</p>';
  return `<div class="recent-session-list">${rows.map(s => `
    <div class="recent-session-row">
      <div><b>${labelModeAdmin(s)}</b><span>${formatOmskDate(s.started_at)} · ${s.status === 'finished' ? 'завершена' : 'активна'}</span></div>
      <strong>${s.correct_count}/${s.total}</strong>
    </div>`).join('')}</div>`;
}

function renderActiveSessionInfo(session){
  if(!session){
    return `<div class="notification-card"><h4>Активный тест</h4><p class="muted">Сейчас пользователь не проходит тест.</p></div>`;
  }
  const topics = (session.topics || []).map(t => `${escapeHtml(String(t.external_id))}. ${escapeHtml(t.title)}`).join('<br>') || '—';
  const difficulties = (session.difficulties || []).map(labelDifficultyAdmin).join(', ') || '—';
  const current = session.current_question
    ? `<div class="report-preview"><b>Текущий вопрос ${session.current_question.position || ''}:</b> ${escapeHtml(session.current_question.prompt || '')}<br><span class="muted">Тема: ${escapeHtml(String(session.current_question.topic_external_id || '—'))}. ${escapeHtml(session.current_question.topic_title || '')}; сложность: ${labelDifficultyAdmin(session.current_question.difficulty)}</span></div>`
    : '<p class="muted">Текущий вопрос не определён.</p>';
  const customParams = session.mode === 'custom'
    ? `<p><b>Параметры потока:</b><br>Темы:<br>${topics}<br>Сложности: ${difficulties}</p>`
    : '';
  return `<div class="notification-card active-session-card">
    <h4>Активный тест</h4>
    <p><b>Режим:</b> ${labelModeAdmin(session)}</p>
    <p><b>Прогресс:</b> ${session.answered}/${session.total}; <b>начат:</b> ${formatOmskDate(session.started_at)}</p>
    ${customParams}
    ${current}
  </div>`;
}

function labelDifficultyAdmin(value){
  return {very_easy:'самые простые', easy:'простые', medium:'средние', hard:'сложные'}[value] || escapeHtml(String(value || '—'));
}

function labelModeAdmin(session){
  if(!session) return '—';
  if(session.mode === 'custom') return 'Конструктор потока';
  if(session.mode === 'difficulty') return `Все вопросы: ${labelDifficultyAdmin(session.difficulty)}`;
  if(session.mode === 'readiness') return `Готовность ${session.readiness_level}%`;
  if(session.mode === 'topic') return 'Тема';
  if(session.mode === 'official') return 'Образец';
  if(session.mode === 'errors') return 'Ошибки';
  return 'Экзамен';
}

async function resetPassword(userId){
  const newPassword = prompt('Введите новый пароль пользователя (минимум 4 символа):');
  if(!newPassword) return;
  if(newPassword.length < 4){ toast('Пароль слишком короткий'); return; }
  await api(`/api/admin/users/${userId}/reset-password`, {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({new_password:newPassword})
  });
  toast('Пароль сброшен, старые пользовательские токены удалены');
  await loadUsers();
}

async function resetProgress(userId){
  const ok = await confirmModal('Сбросить прогресс?', 'Будут удалены все тесты, ответы, ошибки и активные сессии этого пользователя.');
  if(!ok) return;
  await api(`/api/admin/users/${userId}/reset-progress`, {method:'POST'});
  toast('Прогресс пользователя сброшен');
  await selectUser(userId);
}

async function deleteUser(userId){
  const ok = await confirmModal('Удалить пользователя?', 'Пользователь, его прогресс, сессии и токены будут удалены. Это действие нельзя отменить.');
  if(!ok) return;
  await api(`/api/admin/users/${userId}/delete`, {method:'POST'});
  toast('Пользователь удалён');
  selectedUserId = null;
  $('userDetails').innerHTML = 'Выберите пользователя слева.';
  $('userDetails').classList.add('muted');
  await loadUsers();
}

async function loadAdminNotifications(){
  if(!$('adminNotificationsList')) return;
  const data = await api('/api/admin/notifications');
  const active = data.patch_notes?.active || [];
  const archive = data.patch_notes?.archive || [];
  const notifications = data.notifications || [];
  const currentPatch = active[0] || {};
  if($('patchNoteTitle')) $('patchNoteTitle').value = currentPatch.title || 'Сайт обновился';
  if($('patchNoteChanges')) $('patchNoteChanges').value = (currentPatch.changes || []).join('\n');
  $('adminNotificationsList').innerHTML = `
    <h3>Активный патч-ноут</h3>
    ${active.map(renderAdminPatchNote).join('') || '<p class="muted">Активный патч-ноут пуст.</p>'}
    <h3>Рассылки</h3>
    ${notifications.map(renderAdminNotification).join('') || '<p class="muted">Рассылок пока нет.</p>'}
    <h3>Архив патч-ноутов</h3>
    ${archive.map(renderAdminPatchNote).join('') || '<p class="muted">Архив пока пуст.</p>'}`;
}

function renderAdminPatchNote(item){
  const changes = (item.changes || []).map(x => `<li>${escapeHtml(x)}</li>`).join('');
  return `<article class="notification-card"><h4>${escapeHtml(item.title || 'Сайт обновился')} · ${escapeHtml(item.id || '')}</h4><div class="muted">${formatOmskDate(item.created_at)}${item.cleared_at ? ` · очищено ${formatOmskDate(item.cleared_at)}` : ''}</div><ul>${changes}</ul></article>`;
}

function renderAdminNotification(item){
  const active = !item.archived;
  return `<article class="notification-card">
    <div class="notification-top">
      <h4>${escapeHtml(item.title)}</h4>
      <span class="report-status ${active ? 'status-new' : 'status-resolved'}">${active ? 'Активная' : 'Отключена'}</span>
    </div>
    <div class="muted">${formatOmskDate(item.created_at)}</div>
    <p>${escapeHtml(item.message)}</p>
    <div class="actions compact-actions">
      ${active ? `<button class="secondary" type="button" onclick="disableAdminNotification(${item.id})">Отключить рассылку</button>` : ''}
      <button class="danger" type="button" onclick="deleteAdminNotification(${item.id})">Удалить рассылку</button>
    </div>
  </article>`;
}

async function disableAdminNotification(notificationId){
  const ok = await confirmModal('Отключить рассылку?', 'После отключения это уведомление больше не будет приходить пользователям, которые ещё не закрывали его. В истории оно останется.');
  if(!ok) return;
  await api(`/api/admin/notifications/${notificationId}/disable`, {method:'POST'});
  toast('Рассылка отключена');
  await loadAdminNotifications();
}

async function deleteAdminNotification(notificationId){
  const ok = await confirmModal('Удалить рассылку?', 'Рассылка полностью исчезнет у всех пользователей и из истории уведомлений. Это действие нельзя отменить.');
  if(!ok) return;
  await api(`/api/admin/notifications/${notificationId}/delete`, {method:'POST'});
  toast('Рассылка удалена');
  await loadAdminNotifications();
}

async function sendAdminNotification(){
  const title = $('adminNotificationTitle').value.trim();
  const message = $('adminNotificationMessage').value.trim();
  if(title.length < 3 || message.length < 3){ toast('Заполни заголовок и текст уведомления'); return; }
  await api('/api/admin/notifications', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title, message})});
  $('adminNotificationTitle').value = '';
  $('adminNotificationMessage').value = '';
  toast('Уведомление разослано');
  await loadAdminNotifications();
}

async function savePatchNotes(){
  const title = $('patchNoteTitle').value.trim() || 'Сайт обновился';
  const changes = $('patchNoteChanges').value.split(/\n+/).map(x => x.trim()).filter(Boolean);
  if(!changes.length){ toast('Добавь хотя бы одно изменение в патч-ноут'); return; }
  await api('/api/admin/patch-notes/update', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({title, changes})
  });
  toast('Патч-ноут сохранён');
  await loadAdminNotifications();
}

async function clearPatchNotes(){
  const ok = await confirmModal('Очистить активный патч ноут?', 'Активные записи патч-ноута уйдут в архив. В истории уведомлений они сохранятся.');
  if(!ok) return;
  await api('/api/admin/patch-notes/clear', {method:'POST'});
  toast('Патч ноут очищен и перенесён в архив');
  await loadAdminNotifications();
}


async function loadAdminChat(keepSelection = true){
  if(!$('adminChatConversations')) return;
  const data = await api('/api/admin/chat/conversations');
  const items = data.items || [];
  if(!keepSelection || !items.some(item => item.key === selectedAdminChatKey)){
    selectedAdminChatKey = items[0]?.key || 'group';
  }
  renderAdminChatConversations(items);
  if(selectedAdminChatKey) await loadAdminChatMessages(selectedAdminChatKey);
}

function renderAdminChatConversations(items){
  const box = $('adminChatConversations');
  if(!box) return;
  if(!items.length){ box.innerHTML = '<p class="muted">Чатов пока нет.</p>'; return; }
  box.innerHTML = items.map(item => `
    <button class="admin-chat-dialog ${item.key === selectedAdminChatKey ? 'active' : ''}" type="button" data-key="${escapeAttribute(item.key)}">
      <b>${escapeHtml(item.title || 'Чат')}</b>
      <span>${escapeHtml(item.last_sender ? `${item.last_sender}: ${item.last_message || ''}` : (item.last_message || 'Сообщений пока нет'))}</span>
      <em>${item.count || 0} сообщ.; ${formatOmskDate(item.updated_at)}</em>
    </button>
  `).join('');
  box.querySelectorAll('.admin-chat-dialog').forEach(btn => {
    btn.onclick = () => {
      selectedAdminChatKey = btn.dataset.key || 'group';
      renderAdminChatConversations(items);
      loadAdminChatMessages(selectedAdminChatKey).catch(err => toast(err.message || 'Не удалось загрузить чат'));
    };
  });
}

async function loadAdminChatMessages(chatKey){
  const data = await api(`/api/admin/chat/messages?chat_key=${encodeURIComponent(chatKey)}&limit=300`);
  $('adminChatTitle').textContent = data.title || 'Чат';
  $('adminChatCount').textContent = `${(data.items || []).length} сообщений`;
  renderAdminChatRoomMembers(data);
  renderAdminChatMessages(data.items || []);
}


function renderAdminChatRoomMembers(data){
  const box = $('adminChatRoomMembers');
  if(!box) return;
  const members = data.members || [];
  if(!data.room_id){
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="admin-chat-members-head">
      <div><b>Участники группы</b><span>${members.length} чел.</span></div>
      <button class="danger" type="button" onclick="deleteAdminChatRoom(${Number(data.room_id)})">Удалить группу</button>
    </div>
    <div class="admin-chat-member-list">
      ${members.length ? members.map(member => `
        <div class="admin-chat-member">
          <span>${escapeHtml(member.username || 'user')}</span>
          <button class="secondary small-btn" type="button" onclick="removeAdminChatRoomMember(${Number(data.room_id)}, ${Number(member.id)})">Удалить из группы</button>
        </div>`).join('') : '<p class="muted">Участников нет.</p>'}
    </div>`;
}

function renderAdminChatMessages(items){
  const box = $('adminChatMessages');
  if(!box) return;
  if(!items.length){ box.innerHTML = '<p class="muted">Сообщений нет.</p>'; return; }
  box.classList.remove('muted');
  box.innerHTML = items.map(message => {
    const sender = message.sender?.username || 'user';
    const recipient = message.recipient?.username ? ` → ${message.recipient.username}` : '';
    const text = message.text ? `<div class="admin-chat-text">${escapeHtml(message.text).replace(/\n/g, '<br>')}</div>` : '';
    const attachment = message.attachment ? renderAdminChatAttachment(message) : '';
    return `<article class="admin-chat-message" data-message-id="${message.id}">
      <div class="admin-chat-message-head">
        <div><b>${escapeHtml(sender)}${escapeHtml(recipient)}</b><span>${formatOmskDate(message.created_at)}</span></div>
        <button class="danger" type="button" onclick="deleteAdminChatMessage(${message.id})">Удалить</button>
      </div>
      ${text || '<div class="muted">Без текста</div>'}
      ${attachment}
    </article>`;
  }).join('');
}

function renderAdminChatAttachment(message){
  const attachment = message.attachment;
  if(!attachment) return '';
  const size = formatFileSize(attachment.size || 0);
  const token = encodeURIComponent(adminToken || '');
  const url = `/api/admin/chat/attachments/${message.id}?admin_token=${token}`;
  const preview = `/api/admin/chat/attachments/${message.id}/preview?admin_token=${token}`;
  const image = attachment.kind === 'image' ? `<a href="${url}" target="_blank" rel="noopener"><img class="admin-chat-image" src="${url}" alt="${escapeAttribute(attachment.original_name || 'image')}"></a>` : '';
  return `<div class="admin-chat-attachment">
    ${image}
    <div><b>${escapeHtml(attachment.original_name || 'file')}</b><span>${escapeHtml(attachment.kind || 'file')} · ${size}</span></div>
    <div class="admin-chat-file-actions"><a href="${preview}" target="_blank" rel="noopener">Открыть</a><a href="${url}" target="_blank" rel="noopener">Скачать</a></div>
  </div>`;
}


async function removeAdminChatRoomMember(roomId, userId){
  const ok = await confirmModal('Удалить участника из группы?', 'Пользователь больше не будет видеть эту группу и не сможет писать в неё.');
  if(!ok) return;
  await api(`/api/admin/chat/rooms/${roomId}/members/${userId}`, {method:'DELETE'});
  toast('Участник удалён из группы');
  await loadAdminChatMessages(selectedAdminChatKey);
  await loadAdminChat(true);
}

async function deleteAdminChatRoom(roomId){
  const ok = await confirmModal('Удалить группу?', 'Группа, сообщения и связанные записи будут удалены. Медиафайлы удалятся, если больше нигде не используются.');
  if(!ok) return;
  await api(`/api/admin/chat/rooms/${roomId}`, {method:'DELETE'});
  toast('Группа удалена');
  selectedAdminChatKey = 'group';
  await loadAdminChat(false);
}

async function deleteAdminChatMessage(messageId){
  const ok = await confirmModal('Удалить сообщение?', 'Сообщение исчезнет из чата. Если у него есть медиафайл и он больше нигде не используется, файл будет удалён с диска.');
  if(!ok) return;
  await api(`/api/admin/chat/messages/${messageId}`, {method:'DELETE'});
  toast('Сообщение удалено');
  await loadAdminChat(true);
}

async function loadMetrics(){
  if(!$('metricsList')) return;
  $('metricsList').innerHTML = '<div class="admin-skeleton">Собираю метрики…</div>';
  const m = await api('/api/admin/metrics');
  loadAdminOverview().catch(() => {});
  const uptime = formatDuration(m.uptime_seconds || 0);
  $('metricsList').innerHTML = `
    <div class="summary-grid metrics-grid">
      <div class="metric"><strong>${m.avg_response_ms} мс</strong><span>средний ответ сервера</span></div>
      <div class="metric"><strong>${m.p95_response_ms} мс</strong><span>p95 ответов API/страниц</span></div>
      <div class="metric"><strong>${m.avg_page_load_ms} мс</strong><span>средняя загрузка сайта</span></div>
      <div class="metric"><strong>${m.p95_page_load_ms} мс</strong><span>p95 загрузки сайта</span></div>
      <div class="metric"><strong>${m.requests_total}</strong><span>всего запросов</span></div>
      <div class="metric"><strong>${m.errors_total}</strong><span>ошибок 5xx</span></div>
      <div class="metric"><strong>${m.online_users}/${m.users_total}</strong><span>пользователей онлайн</span></div>
      <div class="metric"><strong>${m.active_sessions}</strong><span>активных тестов</span></div>
      <div class="metric"><strong>${m.reports_new}</strong><span>новых жалоб</span></div>
      <div class="metric"><strong>${m.questions_total}</strong><span>вопросов в базе</span></div>
    </div>
    <div class="metrics-details">
      <p><b>Uptime:</b> ${uptime}</p>
      <p><b>API-запросов:</b> ${m.api_requests_total}; <b>статика/страницы:</b> ${m.static_requests_total}</p>
      <p><b>Последний ответ сервера:</b> ${m.last_response_ms} мс</p>
      <p><b>Последняя загрузка сайта:</b> ${m.last_page_load_ms || 0} мс; <b>замеров:</b> ${m.page_load_count}</p>
      <p><b>Жалобы:</b> всего ${m.reports_total}, новые ${m.reports_new}, просмотренные ${m.reports_reviewed}, решённые ${m.reports_resolved}</p>
      <p><b>Тем:</b> ${m.topics_total}; <b>обновлено:</b> ${formatOmskDate(m.timestamp)}</p>
    </div>`;
}

function formatDuration(seconds){
  seconds = Number(seconds || 0);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if(h) return `${h} ч ${m} мин ${s} сек`;
  if(m) return `${m} мин ${s} сек`;
  return `${s} сек`;
}

function confirmModal(title, text){
  return new Promise(resolve => {
    $('modalTitle').textContent = title;
    $('modalText').textContent = text;
    $('modal').classList.remove('hidden');
    const cleanup = value => {
      $('modal').classList.add('hidden');
      $('modalOk').onclick = null;
      $('modalCancel').onclick = null;
      resolve(value);
    };
    $('modalOk').onclick = () => cleanup(true);
    $('modalCancel').onclick = () => cleanup(false);
  });
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


function escapeAttribute(str){
  return escapeHtml(str).replace(/`/g, '&#096;');
}

function formatFileSize(bytes){
  bytes = Number(bytes || 0);
  if(bytes < 1024) return `${bytes} Б`;
  if(bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

init().catch(err => {
  console.error(err);
  showLogin();
});
