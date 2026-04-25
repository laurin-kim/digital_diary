// ═══════════════════════════════════════════════════════════
//  DAILY — main app logic
//  Firebase config is filled in by the user (see SETUP below)
// ═══════════════════════════════════════════════════════════

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  onAuthStateChanged,
  signOut
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  collection,
  getDocs,
  deleteDoc,
  onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

// ═══════════════════════════════════════════════════════════
//  !! SETUP: paste your Firebase config here !!
//  (You will get this from the Firebase console — instructions below)
// ═══════════════════════════════════════════════════════════
const firebaseConfig = {
   apiKey:            "AIzaSyBfaN4pG5kgjzaraIb-KCszfXorvK_Jm8",
  authDomain:        "habit-tracker-16050.firebaseapp.com",
  projectId:         "habit-tracker-16050",
  storageBucket:     "habit-tracker-16050.firebasestorage.app",
  messagingSenderId: "974989090611",
  appId:             "1:974989090611:web:fae27507a60dc2a6c92846",
  measurementId:     "G-1H50W9PS94"
};

// ═══════════════════════════════════════════════════════════
//  FIREBASE INIT
// ═══════════════════════════════════════════════════════════
const firebaseApp = initializeApp(firebaseConfig);
const auth        = getAuth(firebaseApp);
const db          = getFirestore(firebaseApp);
const provider    = new GoogleAuthProvider();

// ═══════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════
let currentUser  = null;
let habits       = [];   // [{id, name, color, days:[0-6]}]
let completions  = {};   // {"YYYY-MM-DD": {habitId: bool}}
let tasks        = [];   // [{id, title, date, done, reminderTime}]
let journal      = {};   // {"YYYY-MM-DD": string}

let currentWeekStart = getWeekStart(new Date());
let selectedDate     = toDateStr(new Date());
let editingHabitId   = null;
let editingTaskId    = null;
let journalTimer     = null;

// ═══════════════════════════════════════════════════════════
//  HELPERS — dates
// ═══════════════════════════════════════════════════════════
function toDateStr(d) {
  if (typeof d === 'string') return d;
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function parseDateStr(s) {
  const [y,m,d] = s.split('-').map(Number);
  return new Date(y, m-1, d);
}

function getWeekStart(d) {
  const dt = new Date(d);
  const day = dt.getDay(); // 0=Sun
  dt.setDate(dt.getDate() - day);
  dt.setHours(0,0,0,0);
  return dt;
}

function addDays(d, n) {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + n);
  return dt;
}

function formatWeekLabel(weekStart) {
  const end = addDays(weekStart, 6);
  const opts = { month: 'short', day: 'numeric' };
  return `${weekStart.toLocaleDateString('en-US', opts)} – ${end.toLocaleDateString('en-US', opts)}`;
}

function todayStr() { return toDateStr(new Date()); }

const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const DAY_SHORT = ['Su','Mo','Tu','We','Th','Fr','Sa'];

// ═══════════════════════════════════════════════════════════
//  HELPERS — IDs
// ═══════════════════════════════════════════════════════════
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

// ═══════════════════════════════════════════════════════════
//  FIREBASE — data paths
// ═══════════════════════════════════════════════════════════
function userCol(path) { return `users/${currentUser.uid}/${path}`; }

// ── Read all data on login ──
async function loadAllData() {
  // habits
  const hSnap = await getDocs(collection(db, `users/${currentUser.uid}/habits`));
  habits = hSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // completions (stored as one doc per date for efficiency)
  const cSnap = await getDocs(collection(db, `users/${currentUser.uid}/completions`));
  completions = {};
  cSnap.docs.forEach(d => { completions[d.id] = d.data(); });

  // tasks
  const tSnap = await getDocs(collection(db, `users/${currentUser.uid}/tasks`));
  tasks = tSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  // journal
  const jSnap = await getDocs(collection(db, `users/${currentUser.uid}/journal`));
  journal = {};
  jSnap.docs.forEach(d => { journal[d.id] = d.data().text || ''; });

  // also cache locally
  cacheLocally();
}

function cacheLocally() {
  try {
    localStorage.setItem('daily_habits',      JSON.stringify(habits));
    localStorage.setItem('daily_completions', JSON.stringify(completions));
    localStorage.setItem('daily_tasks',       JSON.stringify(tasks));
    localStorage.setItem('daily_journal',     JSON.stringify(journal));
  } catch(e) {}
}

function loadFromCache() {
  try {
    habits      = JSON.parse(localStorage.getItem('daily_habits')      || '[]');
    completions = JSON.parse(localStorage.getItem('daily_completions') || '{}');
    tasks       = JSON.parse(localStorage.getItem('daily_tasks')       || '[]');
    journal     = JSON.parse(localStorage.getItem('daily_journal')     || '{}');
  } catch(e) {}
}

// ── Firestore writes ──
async function saveHabit(habit) {
  await setDoc(doc(db, `users/${currentUser.uid}/habits`, habit.id), habit);
  cacheLocally();
}

async function deleteHabit(id) {
  await deleteDoc(doc(db, `users/${currentUser.uid}/habits`, id));
  // remove completions for this habit
  for (const date in completions) {
    if (completions[date][id] !== undefined) {
      delete completions[date][id];
      await setDoc(doc(db, `users/${currentUser.uid}/completions`, date), completions[date]);
    }
  }
  cacheLocally();
}

async function saveCompletion(date, habitId, done) {
  if (!completions[date]) completions[date] = {};
  completions[date][habitId] = done;
  await setDoc(doc(db, `users/${currentUser.uid}/completions`, date), completions[date]);
  cacheLocally();
}

async function saveTask(task) {
  await setDoc(doc(db, `users/${currentUser.uid}/tasks`, task.id), task);
  cacheLocally();
}

async function deleteTask(id) {
  await deleteDoc(doc(db, `users/${currentUser.uid}/tasks`, id));
  tasks = tasks.filter(t => t.id !== id);
  cacheLocally();
}

async function saveJournal(date, text) {
  journal[date] = text;
  await setDoc(doc(db, `users/${currentUser.uid}/journal`, date), { text });
  cacheLocally();
}

// ═══════════════════════════════════════════════════════════
//  THEME
// ═══════════════════════════════════════════════════════════
function applyTheme(theme) {
  document.body.classList.remove('dark','light');
  document.body.classList.add(theme);
  document.getElementById('btn-theme').textContent = theme === 'dark' ? '🌙' : '☀️';
  localStorage.setItem('daily_theme', theme);
}

function toggleTheme() {
  const current = document.body.classList.contains('dark') ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ═══════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════
const SCREEN_TITLES = { today:'Today', calendar:'Calendar', habits:'Habits', stats:'Stats' };

function showScreen(name) {
  document.querySelectorAll('#app .screen').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  const screen = document.getElementById(`screen-${name}`);
  if (screen) screen.classList.remove('hidden');

  const navBtn = document.querySelector(`.nav-btn[data-screen="${name}"]`);
  if (navBtn) navBtn.classList.add('active');

  document.getElementById('header-title').textContent = SCREEN_TITLES[name] || 'Daily';

  if (name === 'today')    renderToday();
  if (name === 'calendar') renderCalendar();
  if (name === 'habits')   renderHabitManager();
  if (name === 'stats')    renderStats();
}

// ═══════════════════════════════════════════════════════════
//  TODAY SCREEN
// ═══════════════════════════════════════════════════════════
function renderToday() {
  const today = todayStr();
  const dayOfWeek = new Date().getDay();

  // ── Habits ──
  const todayHabits = habits.filter(h => h.days && h.days.includes(dayOfWeek));
  const list = document.getElementById('habits-list');
  const empty = document.getElementById('habits-empty');
  list.innerHTML = '';

  if (todayHabits.length === 0) {
    empty.classList.remove('hidden');
  } else {
    empty.classList.add('hidden');
    todayHabits.forEach(h => {
      const done = !!(completions[today] && completions[today][h.id]);
      list.appendChild(makeHabitItem(h, today, done, true));
    });
  }

  // ── Tasks ──
  renderTasksForDate(today, true);

  // ── Journal ──
  const journalInput = document.getElementById('journal-input');
  journalInput.value = journal[today] || '';
  journalInput.disabled = false;
}

function makeHabitItem(habit, date, done, editable) {
  const li = document.createElement('li');
  li.className = `checklist-item${done ? ' done' : ''}`;

  const dot = document.createElement('span');
  dot.className = 'habit-dot';
  dot.style.background = habit.color || '#6c63ff';

  const box = document.createElement('span');
  box.className = 'check-box';
  if (done) box.textContent = '✓';

  const label = document.createElement('span');
  label.className = 'item-label';
  label.textContent = habit.name;

  li.append(dot, box, label);

  if (editable) {
    li.addEventListener('click', async () => {
      const nowDone = li.classList.contains('done');
      li.classList.toggle('done', !nowDone);
      box.textContent = nowDone ? '' : '✓';
      await saveCompletion(date, habit.id, !nowDone);
      // refresh dots on calendar if visible
      if (!document.getElementById('screen-calendar').classList.contains('hidden')) {
        renderWeekStrip();
      }
    });
  }

  return li;
}

function renderTasksForDate(date, editable) {
  const dayTasks = tasks.filter(t => t.date === date);
  const list = document.getElementById('tasks-list');
  const empty = document.getElementById('tasks-empty');

  if (!list) return;
  list.innerHTML = '';

  if (dayTasks.length === 0) {
    empty && empty.classList.remove('hidden');
  } else {
    empty && empty.classList.add('hidden');
    dayTasks.forEach(t => {
      list.appendChild(makeTaskItem(t, editable));
    });
  }
}

function makeTaskItem(task, editable) {
  const li = document.createElement('li');
  li.className = `checklist-item${task.done ? ' done' : ''}`;

  const box = document.createElement('span');
  box.className = 'check-box';
  if (task.done) box.textContent = '✓';

  const label = document.createElement('span');
  label.className = 'item-label';
  label.textContent = task.title + (task.reminderTime ? ` ⏰ ${task.reminderTime}` : '');

  li.append(box, label);

  if (editable) {
    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'item-btn';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', e => { e.stopPropagation(); openTaskModal(task); });

    const delBtn = document.createElement('button');
    delBtn.className = 'item-btn';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', async e => {
      e.stopPropagation();
      await deleteTask(task.id);
      renderTasksForDate(task.date, true);
    });

    actions.append(editBtn, delBtn);
    li.append(actions);

    li.addEventListener('click', async () => {
      const nowDone = li.classList.contains('done');
      task.done = !nowDone;
      li.classList.toggle('done', !nowDone);
      box.textContent = nowDone ? '' : '✓';
      await saveTask(task);
    });
  }

  return li;
}

// ═══════════════════════════════════════════════════════════
//  CALENDAR SCREEN
// ═══════════════════════════════════════════════════════════
function renderCalendar() {
  document.getElementById('week-label').textContent = formatWeekLabel(currentWeekStart);
  renderWeekStrip();
}

function renderWeekStrip() {
  const strip = document.getElementById('week-strip');
  strip.innerHTML = '';
  const today = todayStr();

  for (let i = 0; i < 7; i++) {
    const date = addDays(currentWeekStart, i);
    const dateStr = toDateStr(date);
    const isToday = dateStr === today;
    const isSelected = dateStr === selectedDate;

    const cell = document.createElement('div');
    cell.className = `week-day${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`;

    const nameEl = document.createElement('div');
    nameEl.className = 'day-name';
    nameEl.textContent = DAY_SHORT[date.getDay()];

    const numEl = document.createElement('div');
    numEl.className = 'day-num';
    numEl.textContent = date.getDate();

    // dots = one dot per completed habit
    const dots = document.createElement('div');
    dots.className = 'day-dots';
    const dayHabits = habits.filter(h => h.days && h.days.includes(date.getDay()));
    dayHabits.forEach(h => {
      const done = !!(completions[dateStr] && completions[dateStr][h.id]);
      if (done) {
        const dot = document.createElement('div');
        dot.className = 'day-dot';
        dot.style.background = h.color || '#6c63ff';
        dots.appendChild(dot);
      }
    });

    cell.append(nameEl, numEl, dots);
    cell.addEventListener('click', () => {
      selectedDate = dateStr;
      renderWeekStrip();
      renderDayDetail(dateStr);
    });
    strip.appendChild(cell);
  }
}

function renderDayDetail(dateStr) {
  const panel = document.getElementById('day-detail-panel');
  panel.classList.remove('hidden');
  panel.innerHTML = '';

  const date = parseDateStr(dateStr);
  const isToday = dateStr === todayStr();
  const isFuture = date > new Date();
  const label = date.toLocaleDateString('en-US', { weekday:'long', month:'long', day:'numeric' });

  const title = document.createElement('h3');
  title.textContent = label;
  panel.appendChild(title);

  // Habits section
  const dayOfWeek = date.getDay();
  const dayHabits = habits.filter(h => h.days && h.days.includes(dayOfWeek));

  if (dayHabits.length > 0) {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    const hdr = document.createElement('h4');
    hdr.textContent = 'Habits';
    sec.appendChild(hdr);
    const ul = document.createElement('ul');
    ul.className = 'checklist';
    dayHabits.forEach(h => {
      const done = !!(completions[dateStr] && completions[dateStr][h.id]);
      ul.appendChild(makeHabitItem(h, dateStr, done, isToday));
    });
    sec.appendChild(ul);
    panel.appendChild(sec);
  }

  // Tasks section
  const dayTasks = tasks.filter(t => t.date === dateStr);
  if (dayTasks.length > 0 || isToday) {
    const sec = document.createElement('div');
    sec.className = 'detail-section';
    const hdr = document.createElement('h4');
    hdr.textContent = 'Tasks';
    sec.appendChild(hdr);
    const ul = document.createElement('ul');
    ul.className = 'checklist';
    if (dayTasks.length === 0) {
      const li = document.createElement('li');
      li.className = 'no-entry';
      li.textContent = 'No tasks.';
      ul.appendChild(li);
    } else {
      dayTasks.forEach(t => ul.appendChild(makeTaskItem(t, isToday)));
    }
    sec.appendChild(ul);
    panel.appendChild(sec);
  }

  // Journal section
  const sec = document.createElement('div');
  sec.className = 'detail-section';
  const hdr = document.createElement('h4');
  hdr.textContent = 'Journal';
  sec.appendChild(hdr);

  if (isToday) {
    // redirect to today screen journal
    const btn = document.createElement('button');
    btn.className = 'btn-secondary';
    btn.style.cssText = 'width:100%;margin-top:4px;padding:0.6rem;border-radius:10px;cursor:pointer;font-size:0.9rem;';
    btn.textContent = 'Write in today\'s journal →';
    btn.addEventListener('click', () => showScreen('today'));
    sec.appendChild(btn);
  } else {
    const text = journal[dateStr];
    const p = document.createElement('p');
    p.className = text ? 'readonly-journal' : 'no-entry';
    p.textContent = text || 'No journal entry.';
    sec.appendChild(p);
  }

  panel.appendChild(sec);
}

// ═══════════════════════════════════════════════════════════
//  HABITS MANAGER SCREEN
// ═══════════════════════════════════════════════════════════
function renderHabitManager() {
  const list  = document.getElementById('habit-manager-list');
  const empty = document.getElementById('habit-manager-empty');
  list.innerHTML = '';

  if (habits.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  habits.forEach(h => {
    const li = document.createElement('li');
    li.className = 'habit-manager-item';

    const dot = document.createElement('span');
    dot.className = 'habit-dot';
    dot.style.cssText = `background:${h.color||'#6c63ff'};width:14px;height:14px;flex-shrink:0;`;

    const info = document.createElement('div');
    info.className = 'habit-manager-info';

    const name = document.createElement('div');
    name.className = 'habit-manager-name';
    name.textContent = h.name;

    const days = document.createElement('div');
    days.className = 'habit-manager-days';
    days.textContent = h.days && h.days.length === 7
      ? 'Every day'
      : (h.days || []).map(d => DAY_NAMES[d]).join(', ') || 'No days selected';

    info.append(name, days);

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'item-btn';
    editBtn.textContent = '✏️';
    editBtn.addEventListener('click', () => openHabitModal(h));

    const delBtn = document.createElement('button');
    delBtn.className = 'item-btn';
    delBtn.textContent = '🗑';
    delBtn.addEventListener('click', async () => {
      if (confirm(`Delete "${h.name}"?`)) {
        habits = habits.filter(x => x.id !== h.id);
        await deleteHabit(h.id);
        renderHabitManager();
      }
    });

    actions.append(editBtn, delBtn);
    li.append(dot, info, actions);
    list.appendChild(li);
  });
}

// ═══════════════════════════════════════════════════════════
//  STATS SCREEN
// ═══════════════════════════════════════════════════════════
function renderStats() {
  const container = document.getElementById('stats-container');
  container.innerHTML = '';

  if (habits.length === 0) {
    const p = document.createElement('p');
    p.className = 'empty-msg';
    p.style.marginTop = '2rem';
    p.textContent = 'Add some habits to see stats here.';
    container.appendChild(p);
    return;
  }

  habits.forEach(h => {
    const card = document.createElement('div');
    card.className = 'stat-card';

    const nameRow = document.createElement('div');
    nameRow.className = 'stat-habit-name';
    const dot = document.createElement('span');
    dot.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;background:${h.color||'#6c63ff'}`;
    nameRow.append(dot, h.name);
    card.appendChild(nameRow);

    const { streak, bestStreak, monthPct } = calcStats(h);

    const rows = [
      ['Current streak', `${streak} day${streak !== 1 ? 's' : ''} 🔥`],
      ['Best streak',    `${bestStreak} day${bestStreak !== 1 ? 's' : ''}`],
      ['This month',     `${monthPct}%`],
    ];

    rows.forEach(([label, value]) => {
      const row = document.createElement('div');
      row.className = 'stat-row';
      const l = document.createElement('span'); l.className = 'stat-label'; l.textContent = label;
      const v = document.createElement('span'); v.className = 'stat-value'; v.textContent = value;
      row.append(l, v);
      card.appendChild(row);
    });

    // progress bar for this month
    const wrap = document.createElement('div');
    wrap.className = 'progress-bar-wrap';
    const fill = document.createElement('div');
    fill.className = 'progress-bar-fill';
    fill.style.background = h.color || '#6c63ff';
    fill.style.width = '0%';
    wrap.appendChild(fill);
    card.appendChild(wrap);
    setTimeout(() => { fill.style.width = `${monthPct}%`; }, 50);

    container.appendChild(card);
  });
}

function calcStats(habit) {
  const today = new Date();
  today.setHours(0,0,0,0);

  // Collect all dates where this habit was scheduled
  const scheduledDates = [];
  const start = new Date(habit.createdAt || today);
  start.setHours(0,0,0,0);

  for (let d = new Date(start); d <= today; d = addDays(d, 1)) {
    if (habit.days && habit.days.includes(d.getDay())) {
      scheduledDates.push(toDateStr(d));
    }
  }

  // current streak — walk backwards from today
  let streak = 0;
  for (let i = scheduledDates.length - 1; i >= 0; i--) {
    if (completions[scheduledDates[i]] && completions[scheduledDates[i]][habit.id]) {
      streak++;
    } else {
      break;
    }
  }

  // best streak
  let best = 0, cur = 0;
  scheduledDates.forEach(d => {
    if (completions[d] && completions[d][habit.id]) {
      cur++;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  });

  // this month %
  const now = new Date();
  const monthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const monthDates = scheduledDates.filter(d => d.startsWith(monthStr));
  const doneDates  = monthDates.filter(d => completions[d] && completions[d][habit.id]);
  const monthPct   = monthDates.length === 0 ? 0 : Math.round(doneDates.length / monthDates.length * 100);

  return { streak, bestStreak: best, monthPct };
}

// ═══════════════════════════════════════════════════════════
//  TASK MODAL
// ═══════════════════════════════════════════════════════════
function openTaskModal(existing = null, defaultDate = null) {
  editingTaskId = existing ? existing.id : null;
  document.getElementById('modal-task-title').textContent = existing ? 'Edit Task' : 'Add Task';
  document.getElementById('task-title-input').value    = existing ? existing.title : '';
  document.getElementById('task-date-input').value     = existing ? existing.date  : (defaultDate || todayStr());
  document.getElementById('task-reminder-input').value = existing ? (existing.reminderTime || '') : '';
  document.getElementById('modal-task').classList.remove('hidden');
}

function closeTaskModal() {
  document.getElementById('modal-task').classList.add('hidden');
  editingTaskId = null;
}

async function saveTaskFromModal() {
  const title = document.getElementById('task-title-input').value.trim();
  const date  = document.getElementById('task-date-input').value;
  const reminder = document.getElementById('task-reminder-input').value;

  if (!title || !date) return;

  const task = {
    id:           editingTaskId || uid(),
    title,
    date,
    done:         editingTaskId ? (tasks.find(t=>t.id===editingTaskId)?.done || false) : false,
    reminderTime: reminder || null
  };

  if (editingTaskId) {
    tasks = tasks.map(t => t.id === editingTaskId ? task : t);
  } else {
    tasks.push(task);
  }

  await saveTask(task);

  if (reminder) scheduleReminder(task);

  closeTaskModal();
  renderTasksForDate(date, date === todayStr());
}

// ═══════════════════════════════════════════════════════════
//  HABIT MODAL
// ═══════════════════════════════════════════════════════════
function openHabitModal(existing = null) {
  editingHabitId = existing ? existing.id : null;
  document.getElementById('modal-habit-title').textContent = existing ? 'Edit Habit' : 'Add Habit';
  document.getElementById('habit-name-input').value  = existing ? existing.name  : '';
  document.getElementById('habit-color-input').value = existing ? existing.color : '#6c63ff';

  // reset day buttons
  document.querySelectorAll('.day-btn').forEach(btn => {
    const day = Number(btn.dataset.day);
    const active = existing ? existing.days.includes(day) : true;
    btn.classList.toggle('active', active);
  });

  document.getElementById('modal-habit').classList.remove('hidden');
}

function closeHabitModal() {
  document.getElementById('modal-habit').classList.add('hidden');
  editingHabitId = null;
}

async function saveHabitFromModal() {
  const name  = document.getElementById('habit-name-input').value.trim();
  const color = document.getElementById('habit-color-input').value;
  const days  = [...document.querySelectorAll('.day-btn.active')].map(b => Number(b.dataset.day));

  if (!name || days.length === 0) return;

  const habit = {
    id:        editingHabitId || uid(),
    name,
    color,
    days,
    createdAt: editingHabitId
      ? (habits.find(h=>h.id===editingHabitId)?.createdAt || Date.now())
      : Date.now()
  };

  if (editingHabitId) {
    habits = habits.map(h => h.id === editingHabitId ? habit : h);
  } else {
    habits.push(habit);
  }

  await saveHabit(habit);
  closeHabitModal();
  renderHabitManager();
}

// ═══════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ═══════════════════════════════════════════════════════════
function scheduleReminder(task) {
  if (!task.reminderTime || !task.date) return;
  if (Notification.permission !== 'granted') {
    Notification.requestPermission();
    return;
  }
  const [h, m] = task.reminderTime.split(':').map(Number);
  const fireAt  = parseDateStr(task.date);
  fireAt.setHours(h, m, 0, 0);
  const delay = fireAt - Date.now();
  if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) { // only within 7 days
    setTimeout(() => {
      new Notification('Daily reminder', { body: task.title, icon: '/icons/icon-192.png' });
    }, delay);
  }
}

async function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
}

// ═══════════════════════════════════════════════════════════
//  INSTALL BANNER (iOS Safari hint)
// ═══════════════════════════════════════════════════════════
function maybeShowInstallBanner() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const isInStandalone = window.navigator.standalone;
  const dismissed = localStorage.getItem('daily_install_dismissed');
  if (isIos && !isInStandalone && !dismissed) {
    const banner = document.createElement('div');
    banner.id = 'install-banner';
    banner.innerHTML = `
      <span>📲 <strong>Install this app:</strong> tap the Share button in Safari, then "Add to Home Screen".</span>
      <button id="btn-dismiss-banner">✕</button>
    `;
    const scroll = document.querySelector('#screen-today .screen-scroll');
    if (scroll) scroll.prepend(banner);
    document.getElementById('btn-dismiss-banner').addEventListener('click', () => {
      banner.remove();
      localStorage.setItem('daily_install_dismissed', '1');
    });
  }
}

// ═══════════════════════════════════════════════════════════
//  AUTH FLOW
// ═══════════════════════════════════════════════════════════
function showApp() {
  document.getElementById('screen-signin').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  showScreen('today');
  maybeShowInstallBanner();
  requestNotificationPermission();
}

function showSignIn() {
  document.getElementById('screen-signin').classList.remove('hidden');
  document.getElementById('screen-signin').classList.add('active');
  document.getElementById('app').classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════
function bindEvents() {
  // Sign in
  document.getElementById('btn-google-signin').addEventListener('click', async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch(e) {
      alert('Sign-in failed. Please try again.\n\n' + e.message);
    }
  });

  // Theme toggle
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);

  // Nav
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.screen));
  });

  // Today screen
  document.getElementById('btn-go-habits').addEventListener('click', () => showScreen('habits'));
  document.getElementById('btn-add-task').addEventListener('click', () => openTaskModal());

  // Journal autosave
  document.getElementById('journal-input').addEventListener('input', e => {
    const status = document.getElementById('journal-save-status');
    status.textContent = 'Saving…';
    status.classList.add('visible');
    clearTimeout(journalTimer);
    journalTimer = setTimeout(async () => {
      await saveJournal(todayStr(), e.target.value);
      status.textContent = 'Saved ✓';
      setTimeout(() => status.classList.remove('visible'), 1500);
    }, 800);
  });

  // Calendar week nav
  document.getElementById('btn-week-prev').addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, -7);
    document.getElementById('day-detail-panel').classList.add('hidden');
    renderCalendar();
  });
  document.getElementById('btn-week-next').addEventListener('click', () => {
    currentWeekStart = addDays(currentWeekStart, 7);
    document.getElementById('day-detail-panel').classList.add('hidden');
    renderCalendar();
  });

  // Swipe on week strip
  let touchStartX = 0;
  const strip = document.getElementById('week-strip');
  strip.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, {passive:true});
  strip.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 50) {
      currentWeekStart = addDays(currentWeekStart, dx < 0 ? 7 : -7);
      document.getElementById('day-detail-panel').classList.add('hidden');
      renderCalendar();
    }
  }, {passive:true});

  // Habit modal
  document.getElementById('btn-add-habit').addEventListener('click', () => openHabitModal());
  document.getElementById('btn-habit-cancel').addEventListener('click', closeHabitModal);
  document.getElementById('btn-habit-save').addEventListener('click', saveHabitFromModal);
  document.querySelectorAll('.day-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  // Task modal
  document.getElementById('btn-task-cancel').addEventListener('click', closeTaskModal);
  document.getElementById('btn-task-save').addEventListener('click', saveTaskFromModal);

  // Close modals on backdrop tap
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) {
        backdrop.classList.add('hidden');
        editingHabitId = null;
        editingTaskId  = null;
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════

// Apply saved theme before anything renders
const savedTheme = localStorage.getItem('daily_theme') || 'dark';
applyTheme(savedTheme);

// Register service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Watch auth state
onAuthStateChanged(auth, async user => {
  if (user) {
    currentUser = user;
    loadFromCache();    // show cached data immediately
    showApp();
    await loadAllData(); // then fetch fresh from Firestore
    renderToday();       // re-render with fresh data
  } else {
    currentUser = null;
    showSignIn();
  }
});

// Bind all UI events
bindEvents();
