let adminToken = sessionStorage.getItem('examAdminToken') || '';
let selectedUserId = null;

const $ = id => document.getElementById(id);
const toast = msg => { const t=$('toast'); t.textContent=msg; t.classList.remove('hidden'); setTimeout(()=>t.classList.add('hidden'), 2600); };

async function api(url, options = {}){
  const headers = {...(options.headers || {})};
  if(adminToken) headers.Authorization = `Bearer ${adminToken}`;
  const response = await fetch(url, {...options, headers});
  const text = await response.text();
  let data = null;
  try{ data = text ? JSON.parse(text) : null; }catch{ data = text; }
  if(!response.ok){
    if(response.status === 401) showLogin();
    throw new Error((data && data.detail) || response.statusText);
  }
  return data;
}

function showLogin(){
  $('loginView').classList.remove('hidden');
  $('adminView').classList.add('hidden');
  $('logoutBtn').classList.add('hidden');
}

function showAdmin(username){
  $('loginView').classList.add('hidden');
  $('adminView').classList.remove('hidden');
  $('logoutBtn').classList.remove('hidden');
  $('adminInfo').textContent = `Администратор: ${username || 'admin'}`;
}

async function init(){
  bind();
  if(adminToken){
    try{ const me = await api('/api/admin/me'); showAdmin(me.username); await loadUsers(); }
    catch{ adminToken=''; sessionStorage.removeItem('examAdminToken'); showLogin(); }
  }else showLogin();
}

function bind(){
  $('loginBtn').onclick = login;
  $('logoutBtn').onclick = logout;
  $('refreshBtn').onclick = loadUsers;
}

async function login(){
  const username = $('adminUsername').value.trim();
  const password = $('adminPassword').value;
  $('loginError').classList.add('hidden');
  try{
    const result = await api('/api/admin/login', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({username, password})});
    adminToken = result.token;
    sessionStorage.setItem('examAdminToken', adminToken);
    showAdmin(result.admin.username);
    await loadUsers();
  }catch(err){
    $('loginError').textContent = err.message;
    $('loginError').classList.remove('hidden');
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
  const users = await api('/api/admin/users');
  $('usersList').innerHTML = users.map(u => `
    <article class="user-card ${u.id === selectedUserId ? 'active' : ''}" onclick="selectUser(${u.id})">
      <h3>${escapeHtml(u.username)} <span class="badge">id ${u.id}</span></h3>
      <div class="user-meta">
        <span>Готовность: <b>${u.readiness}%</b></span>
        <span>Точность: <b>${u.accuracy}%</b></span>
        <span>Отвечено: <b>${u.answered_unique}</b></span>
        <span>Ошибок: <b>${u.wrong_answers}</b></span>
      </div>
      <div class="muted">Создан: ${new Date(u.created_at).toLocaleString()}</div>
    </article>
  `).join('') || '<p class="muted">Пользователей пока нет.</p>';
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
  await api(`/api/admin/users/${userId}/reset-password`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({new_password:newPassword})});
  toast('Пароль сброшен, старые пользовательские токены удалены');
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

function escapeHtml(str){ return String(str).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m])); }

init().catch(err => { console.error(err); showLogin(); });
