let adminToken = sessionStorage.getItem('examAdminToken') || '';
let selectedUserId = null;
let refreshTimer = null;
let currentAdminTab = "users";
let userSearchTimer = null;
let selectedAdminChatKey = "group";

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
  $('refreshMetricsBtn').onclick = loadMetrics;
  $('sendNotificationBtn').onclick = sendAdminNotification;
  $('clearPatchNotesBtn').onclick = clearPatchNotes;
  $('savePatchNotesBtn').onclick = savePatchNotes;
  if($('refreshAdminChatBtn')) $('refreshAdminChatBtn').onclick = () => loadAdminChat(true);
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
      loadAdminOverview().catch(() => {});
      if(currentAdminTab === 'users') loadUsers().catch(() => {});
      if(currentAdminTab === 'reports') loadReports().catch(() => {});
      if(currentAdminTab === 'metrics') loadMetrics().catch(() => {});
      if(currentAdminTab === 'notifications') loadAdminNotifications().catch(() => {});
      if(currentAdminTab === 'chat') loadAdminChat(false).catch(() => {});
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
  ['users','reports','metrics','notifications','chat'].forEach(name => {
    const panel = $(`${name}Tab`);
    if(panel) panel.classList.toggle('hidden', name !== currentAdminTab);
  });
  if(currentAdminTab === 'users') loadUsers().catch(() => {});
  if(currentAdminTab === 'reports') loadReports().catch(() => {});
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
  const params = new URLSearchParams();
  if(status && status !== 'all') params.set('status', status);
  if(search) params.set('q', search);
  const query = params.toString() ? `?${params.toString()}` : '';
  $('usersList').innerHTML = '<div class="admin-skeleton">Загружаю пользователей…</div>';
  const users = await api(`/api/admin/users${query}`);
  loadAdminOverview().catch(() => {});
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
  $('reportsList').innerHTML = '<div class="admin-skeleton">Загружаю жалобы…</div>';
  const rows = await api(`/api/admin/reports${query}`);
  loadAdminOverview().catch(() => {});
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
    ${renderActiveSessionInfo(stats.active_session)}
    <div class="actions">
      <button onclick="resetPassword(${userId})">Сбросить пароль</button>
      <button class="danger" onclick="resetProgress(${userId})">Сбросить прогресс</button>
      <button class="danger" onclick="deleteUser(${userId})">Удалить пользователя</button>
    </div>
  `;
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
