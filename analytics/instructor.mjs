import { createSupabase } from './supabase.mjs';
import { cardPlayColumns, cardPlayRows, csv, duration } from './reports.mjs';
import { addSessionToReport, createClassReport, renderClassReport } from './class-report.mjs';

const $ = selector => document.querySelector(selector);
const classes = $('#class-select');
const classForm = $('#class-form');
const fields = classForm.elements;
const status = $('#status');
const summaryPageSize = 100;
const eventPageSize = 200;
const formatTime = value => value ? new Date(value).toLocaleString() : '—';
let client;
let classList = [];
let loaded = 0;
let selectedSession;
let eventAfter = 0;
let busy = false;

function show(message) {
  status.textContent = message;
}

async function run(action) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('input,button,select')].filter(el => !el.disabled);
  controls.forEach(el => { el.disabled = true; });
  try { await action(); }
  catch (error) { show(error.message || 'The request could not be completed.'); }
  finally {
    busy = false;
    controls.forEach(el => { el.disabled = false; });
  }
}

function hideDetail() {
  selectedSession = undefined;
  $('#events').replaceChildren();
  $('#sequences').replaceChildren();
  $('#detail').hidden = true;
}

function hideClassReport() {
  $('#class-report').hidden = true;
  $('#class-report-content').replaceChildren();
  $('#class-report-load').textContent = 'View quantitative report';
  $('#class-report-load').setAttribute('aria-expanded', 'false');
}

function clearDashboard() {
  classList = [];
  classes.replaceChildren(new Option('Select a class', ''));
  $('#sessions').replaceChildren();
  $('#dashboard').hidden = true;
  $('#class-form').hidden = true;
  $('#reports').hidden = true;
  $('#new-code').textContent = '';
  $('#new-code').hidden = true;
  $('#logout').hidden = true;
  hideDetail();
  hideClassReport();
}

function prepareClassForm(row) {
  classForm.hidden = false;
  fields.label.value = row?.label ?? '';
  fields.rounds.value = row?.rounds_required ?? 1;
  fields.open.checked = row?.is_open ?? true;
  $('#rotate').hidden = !row;
}

async function loadClasses(classId = '') {
  classList = await client.rpc('gca_classes');
  classes.replaceChildren(new Option('Select a class', ''), ...classList.map(row => new Option(row.label, row.id)));
  classes.value = classId;
  $('#dashboard').hidden = false;
  $('#login').hidden = true;
  $('#logout').hidden = false;
  if (classList.length === 0) prepareClassForm();
}

function sessionState(row) {
  if (!row.last_recorded) return 'No events saved';
  if (row.latest_event === 'session_pause') return 'Page closed or paused';
  if (row.latest_event === 'level_exit') return 'Left Level 2';
  return Date.now() - Date.parse(row.last_recorded) < 45000 ? 'Recently active' : 'Ending uncertain';
}

function appendCells(parent, values) {
  for (const value of values) {
    const cell = parent.insertCell();
    if (value instanceof Node) cell.append(value);
    else cell.textContent = String(value ?? '—');
  }
}

function displayNames(row) {
  return row.partner_name ? `${row.student_name} + ${row.partner_name} (shared)` : row.student_name;
}

async function loadSessions(reset = true) {
  if (reset) {
    loaded = 0;
    $('#sessions').replaceChildren();
    $('#more-sessions').hidden = true;
    hideDetail();
    hideClassReport();
  }
  if (!classes.value) return;
  const rows = await client.rpc('gca_sessions', { p_class: classes.value, p_offset: loaded, p_limit: summaryPageSize });
  for (const row of rows) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'View';
    button.setAttribute('aria-label', 'View timeline for ' + displayNames(row));
    button.addEventListener('click', () => run(() => openDetail(row)));
    const id = document.createElement('div');
    const label = document.createElement('strong');
    label.textContent = displayNames(row);
    const shortId = document.createElement('div');
    shortId.textContent = 'Session ' + row.session_id.slice(0, 8);
    id.append(label, shortId);
    const timing = row.timing || {};
    appendCells($('#sessions').insertRow(), [
      id, row.completed_at ? formatTime(row.completed_at) : 'Pending',
      `${formatTime(row.first_recorded)} / ${formatTime(row.last_recorded)}`,
      [timing.visible_ms, timing.active_ms, timing.idle_ms, timing.hidden_ms].map(duration).join(' / '),
      `${row.resolved_rounds} / ${row.abandoned_rounds} / ${row.restarts}`,
      `${row.human_moves} / ${row.computer_moves}`, sessionState(row), button,
    ]);
  }
  if (loaded === 0 && rows.length === 0) {
    const cell = $('#sessions').insertRow().insertCell();
    cell.colSpan = 8;
    cell.textContent = 'No classroom sessions yet.';
  }
  loaded += rows.length;
  $('#more-sessions').hidden = rows.length < summaryPageSize;
}

async function openDetail(row) {
  hideDetail();
  selectedSession = row;
  eventAfter = 0;
  $('#detail-title').textContent = displayNames(row);
  $('#detail-id').textContent = `Participant ${row.participant_id} · Session ${row.session_id}`;
  for (const sequence of row.sequences || []) {
    const li = document.createElement('li');
    li.textContent = `${sequence.cards.join(' → ')} · HEADS ${sequence.heads} · TAILS ${sequence.tails}`;
    $('#sequences').append(li);
  }
  if (!row.sequences?.length) {
    const li = document.createElement('li');
    li.textContent = 'No completed sequences.';
    $('#sequences').append(li);
  }
  $('#detail').hidden = false;
  await loadEvents();
  $('#detail-title').scrollIntoView({ block: 'nearest' });
}

async function loadEvents() {
  if (!selectedSession) return;
  const rows = await client.rpc('gca_events', { p_session: selectedSession.session_id, p_after: eventAfter });
  for (const row of rows) {
    const payload = document.createElement('pre');
    payload.textContent = JSON.stringify(row.payload, null, 2);
    appendCells($('#events').insertRow(), [row.seq, duration(row.elapsed_ms), row.event_type.replaceAll('_', ' '), row.round_id, payload]);
  }
  if (rows.length) eventAfter = rows.at(-1).seq;
  $('#more-events').hidden = rows.length < eventPageSize;
}

async function chooseClass() {
  const row = classList.find(option => option.id === classes.value);
  $('#new-code').textContent = '';
  $('#new-code').hidden = true;
  $('#reports').hidden = !row;
  classForm.hidden = !row;
  if (row) prepareClassForm(row);
  await loadSessions();
}

async function saveClass(rotate = false) {
  if (!classForm.reportValidity()) return;
  const result = await client.rpc('gca_save_class', {
    p_class: classes.value || null, p_label: fields.label.value, p_rounds: Number(fields.rounds.value),
    p_open: fields.open.checked, p_rotate: rotate,
  });
  await loadClasses(result.class_id);
  await chooseClass();
  if (result.class_code) {
    $('#new-code').textContent = `Class code: ${result.class_code}. Save it now. Rotate the code to issue a replacement.`;
    $('#new-code').hidden = false;
  }
  show('Class settings saved.');
}

async function* sessionEvents(sessionId) {
  let after = 0;
  for (;;) {
    const events = await client.rpc('gca_events', { p_session: sessionId, p_after: after });
    yield* events;
    if (events.length < eventPageSize) return;
    after = events.at(-1).seq;
  }
}

async function* classSessions(classId) {
  for (let offset = 0; ; offset += summaryPageSize) {
    const sessions = await client.rpc('gca_sessions', { p_class: classId, p_offset: offset, p_limit: summaryPageSize });
    yield* sessions;
    if (sessions.length < summaryPageSize) return;
  }
}

async function loadClassReport() {
  const classId = classes.value;
  if (!classId) return;
  hideClassReport();
  show('Loading the quantitative report…');
  const report = createClassReport();
  for await (const session of classSessions(classId)) {
    const roundEvents = [];
    for await (const event of sessionEvents(session.session_id)) {
      if (['round_start', 'card_played', 'round_resolved'].includes(event.event_type)) roundEvents.push(event);
    }
    addSessionToReport(report, session, roundEvents);
  }
  renderClassReport($('#class-report-content'), report);
  $('#class-report').hidden = false;
  $('#class-report-load').textContent = 'Refresh quantitative report';
  $('#class-report-load').setAttribute('aria-expanded', 'true');
  $('#class-report-title').focus();
  show('Quantitative report ready.');
}

async function exportClass(kind) {
  const classId = classes.value;
  const summary = ['participant_id', 'session_id', 'name', 'partner', 'shared', 'session_started', 'first_saved', 'last_saved', 'completed_at', 'rounds_required_at_completion', 'visible_ms', 'estimated_active_ms', 'visible_idle_ms', 'hidden_ms', 'resolved_rounds', 'abandoned_rounds', 'restarts', 'human_moves', 'computer_moves', 'sequences', 'session_state'];
  const detail = ['session_id', 'seq', 'event_id', 'round_id', 'event_type', 'elapsed_ms', 'client_at', 'received_at', 'payload'];
  const headers = { summary, events: detail, 'card-plays': cardPlayColumns };
  const rows = [headers[kind]];
  show('Preparing CSV…');
  for await (const s of classSessions(classId)) {
    if (kind === 'summary') {
      rows.push([
        s.participant_id, s.session_id, s.student_name, s.partner_name, Boolean(s.partner_name), s.session_started,
        s.first_recorded, s.last_recorded, s.completed_at, s.completion_rounds,
        s.timing?.visible_ms, s.timing?.active_ms, s.timing?.idle_ms, s.timing?.hidden_ms,
        s.resolved_rounds, s.abandoned_rounds, s.restarts, s.human_moves, s.computer_moves,
        JSON.stringify(s.sequences), sessionState(s),
      ]);
      continue;
    }
    const roundEvents = [];
    for await (const e of sessionEvents(s.session_id)) {
      if (kind === 'events') {
        rows.push([s.session_id, e.seq, e.event_id, e.round_id, e.event_type, e.elapsed_ms, e.client_at, e.received_at, JSON.stringify(e.payload)]);
      } else if (e.event_type === 'card_played' || e.event_type === 'round_resolved' || e.event_type === 'round_restart') {
        roundEvents.push(e);
      }
    }
    if (kind === 'card-plays') rows.push(...cardPlayRows(s, roundEvents));
  }
  const url = URL.createObjectURL(new Blob([csv(rows)], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `ghost-coin-${kind}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  show('CSV ready.');
}

async function init() {
  const hash = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  try { client = createSupabase('instructor'); }
  catch (error) { show(error.message); $('#login-form').hidden = true; return; }
  const access = hash.get('access_token');
  const refresh = hash.get('refresh_token');
  if (hash.has('error')) { show('That sign-in link is invalid or has expired. Request another link.'); return; }
  if (access && refresh) {
    const expires = Number(hash.get('expires_at')) || Math.floor(Date.now() / 1000) + Number(hash.get('expires_in'));
    await client.acceptSignInLink(access, refresh, expires);
  }
  if (client.cachedIdentity()) {
    try { await loadClasses(); }
    catch (error) {
      try { await client.signOut(); } catch { /* Local credentials have been cleared. */ }
      throw error;
    }
  }
}

$('#login-form').addEventListener('submit', event => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  const email = data.get('email');
  const byLink = event.submitter?.value === 'link';
  void run(async () => {
    if (!client) return;
    if (byLink) {
      await client.sendSignInLink(email, location.origin + location.pathname);
      show('If the email belongs to a provisioned instructor, check its inbox for a sign-in link.');
      return;
    }
    if (!data.get('password')) {
      show('Enter your instructor password or request an email link.');
      return;
    }
    await client.signInPassword(email, data.get('password'));
    form.reset();
    try { await loadClasses(); }
    catch (error) {
      try { await client.signOut(); } catch { /* Local credentials have been cleared. */ }
      throw error;
    }
    show('Signed in.');
  });
});
$('#logout').addEventListener('click', () => run(async () => {
  clearDashboard();
  $('#login').hidden = false;
  await client.signOut();
  show('Signed out.');
}));
classes.addEventListener('change', () => run(chooseClass));
$('#create-class').addEventListener('click', () => {
  classes.value = '';
  $('#reports').hidden = true;
  $('#new-code').hidden = true;
  hideDetail();
  hideClassReport();
  prepareClassForm();
  fields.label.focus();
});
classForm.addEventListener('submit', event => { event.preventDefault(); void run(() => saveClass()); });
$('#rotate').addEventListener('click', () => {
  if (confirm('Replace the class code? The previous code will stop working for new enrollments.')) void run(() => saveClass(true));
});
$('#refresh').addEventListener('click', () => run(() => loadSessions()));
$('#class-report-load').addEventListener('click', () => run(loadClassReport));
$('#more-sessions').addEventListener('click', () => run(() => loadSessions(false)));
$('#more-events').addEventListener('click', () => run(loadEvents));
$('#summary-export').addEventListener('click', () => run(() => exportClass('summary')));
$('#event-export').addEventListener('click', () => run(() => exportClass('events')));
$('#card-export').addEventListener('click', () => run(() => exportClass('card-plays')));
$('#delete-participant').addEventListener('click', () => {
  if (!selectedSession || !confirm('Permanently delete this participant, all their sessions, events, and completion credit?')) return;
  void run(async () => {
    await client.rpc('gca_delete_participant', { p_participant: selectedSession.participant_id });
    await loadSessions();
    show('Participant and linked activity deleted.');
  });
});
void run(init);
