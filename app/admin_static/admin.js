let adminToken = sessionStorage.getItem('examAdminToken') || '';
let selectedUserId = null;
let refreshTimer = null;
let currentAdminTab = "users";
let userSearchTimer = null;

const $ = id => document.getElementById(id);
const toast = msg => {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), 2600);
};

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
      await loadUsers();
      await loadReports();
      await loadMetrics();
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
  $('refreshMetricsBtn').onclick = loadMetrics;
  $('userStatusFilter').onchange = loadUsers;
  $('userSearch').oninput = () => { clearTimeout(userSearchTimer); userSearchTimer = setTimeout(loadUsers, 250); };
  document.querySelectorAll('.admin-tab').forEach(btn => btn.onclick = () => switchAdminTab(btn.dataset.tab));
  $('reportStatusFilter').onchange = loadReports;
  $('adminThemeToggle').onclick = toggleTheme;
  $('adminPassword').addEventListener('keydown', event => {
    if(event.key === 'Enter') login();
  });
}

function startAutoRefresh(){
  if(refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(() => {
    if(adminToken){
      if(currentAdminTab === 'users') loadUsers().catch(() => {});
      if(currentAdminTab === 'reports') loadReports().catch(() => {});
      if(currentAdminTab === 'metrics') loadMetrics().catch(() => {});
    }
  }, 30000);
}

function stopAutoRefresh(){
  if(refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function switchAdminTab(tab){
  currentAdminTab = tab || 'users';
  document.querySelectorAll('.admin-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === currentAdminTab));
  ['users','reports','metrics'].forEach(name => {
    const panel = $(`${name}Tab`);
    if(panel) panel.classList.toggle('hidden', name !== currentAdminTab);
  });
  if(currentAdminTab === 'users') loadUsers().catch(() => {});
  if(currentAdminTab === 'reports') loadReports().catch(() => {});
  if(currentAdminTab === 'metrics') loadMetrics().catch(() => {});
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
  const params = new URLSearchParams();
  if(status && status !== 'all') params.set('status', status);
  if(search) params.set('q', search);
  const query = params.toString() ? `?${params.toString()}` : '';
  const users = await api(`/api/admin/users${query}`);
  $('usersList').innerHTML = users.map(u => `
    <article class="user-card ${u.id === selectedUserId ? 'active' : ''}" onclick="selectUser(${u.id})">
      <h3>
        ${escapeHtml(u.username)}
        <span class="badge">id ${u.id}</span>
        <span class="status-badge ${u.is_online ? 'online' : 'offline'}">${u.is_online ? 'Онлайн' : 'Оффлайн'}</span>
      </h3>
      <div class="user-meta">
        <span>Готовность: <b>${u.readiness}%</b></span>
        <span>Точность: <b>${u.accuracy}%</b></span>
        <span>Отвечено: <b>${u.answered_unique}</b></span>
        <span>Ошибок: <b>${u.wrong_answers}</b></span>
      </div>
      <div class="muted">Создан: ${formatOmskDate(u.created_at)}</div>
      <div class="muted">${u.last_seen_at ? `Последняя активность: ${formatOmskDate(u.last_seen_at)}` : 'Активности ещё не было'}</div>
    </article>
  `).join('') || '<p class="muted">Пользователей пока нет.</p>';
}

async function loadReports(){
  if(!$('reportsList')) return;
  const status = $('reportStatusFilter')?.value || 'all';
  const query = status && status !== 'all' ? `?status=${encodeURIComponent(status)}` : '';
  const rows = await api(`/api/admin/reports${query}`);
  $('reportsList').innerHTML = rows.map(renderReport).join('') || '<p class="muted">Жалоб пока нет.</p>';
}

function renderReport(r){
  const target = r.target_type === 'question'
    ? `Вопрос ${escapeHtml(r.question?.external_id || String(r.question?.id || ''))}`
    : `Теория ${escapeHtml(String(r.topic?.external_id || ''))}`;
  const topic = r.topic ? `${r.topic.external_id}. ${escapeHtml(r.topic.title)}` : 'Тема не найдена';
  const sender = r.sender ? `${escapeHtml(r.sender.username)} · id ${r.sender.id}` : 'пользователь удалён';
  const prompt = r.question?.prompt ? `<div class="report-preview"><b>Вопрос:</b> ${escapeHtml(r.question.prompt)}</div>` : '';
  const statusText = {new:'Новая', reviewed:'Просмотрена', resolved:'Решена'}[r.status] || r.status;
  return `
    <article class="report-card-admin report-${escapeHtml(r.status)}">
      <div class="report-admin-top">
        <h3>${target} <span class="report-status">${statusText}</span></h3>
        <span class="muted">${formatOmskDate(r.created_at)}</span>
      </div>
      <div class="muted">Отправитель: ${sender}</div>
      <div class="muted">Тема: ${topic}</div>
      ${prompt}
      <div class="report-message">${escapeHtml(r.message)}</div>
      <div class="actions compact-actions">
        <button class="secondary" onclick="setReportStatus(${r.id}, 'reviewed')">Просмотрено</button>
        <button onclick="setReportStatus(${r.id}, 'resolved')">Решено</button>
        <button class="secondary" onclick="setReportStatus(${r.id}, 'new')">Вернуть в новые</button>
        <button class="danger" onclick="deleteReport(${r.id})">Удалить</button>
      </div>
    </article>`;
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
  const stats = await api(`/api/admin/users/${userId}/progress`);
  $('userDetails').classList.remove('muted');
  $('userDetails').innerHTML = `
    <h3>${escapeHtml(stats.user)}</h3>
    <div class="summary-grid">
      <div class="metric"><strong>${stats.readiness}%</strong><span>готовность</span></div>
      <div class="metric"><strong>${stats.accuracy}%</strong><span>точность</span></div>
      <div class="metric"><strong>${stats.answered_unique}/${stats.total_questions}</strong><span>уникальных</span></div>
      <div class="metric"><strong>${stats.wrong_answers}</strong><span>ошибок</span></div>
      <div class="metric"><strong>${stats.sessions_total}</strong><span>сессий</span></div>
    </div>
    <div class="actions">
      <button onclick="resetPassword(${userId})">Сбросить пароль</button>
      <button class="danger" onclick="resetProgress(${userId})">Сбросить прогресс</button>
      <button class="danger" onclick="deleteUser(${userId})">Удалить пользователя</button>
    </div>
  `;
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

async function loadMetrics(){
  if(!$('metricsList')) return;
  const m = await api('/api/admin/metrics');
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

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
}

init().catch(err => {
  console.error(err);
  showLogin();
});
