import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { Outbox } from '../analytics/outbox.mjs';
import { cardPlayColumns, cardPlayRows, csv } from '../analytics/reports.mjs';
import { ActivityClock } from '../analytics/timing.mjs';

test('Level 2 timing stops outside the level and separates hidden time and visible idle', () => {
  const clock = new ActivityClock(0, 60_000);
  clock.sample(2000, { tracked: true, visible: true, human: true });
  assert.equal(clock.sample(62_000).idle, true);
  clock.sample(72_000, { visible: false });
  clock.sample(82_000, { visible: true });
  clock.sample(87_000, { human: true });
  clock.sample(97_000, { tracked: false });
  clock.sample(197_000, { tracked: true, human: true });
  assert.deepEqual(clock.sample(202_000).timing, {
    visible_ms: 90_000, active_ms: 75_000, idle_ms: 15_000, hidden_ms: 10_000,
  });
});

test('the outbox retries original IDs in sequence and keeps events for their own identity', async () => {
  const values = new Map();
  const storage = {
    get length() { return values.size; },
    key: index => [...values.keys()][index],
    getItem: key => values.get(key),
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const box = new Outbox('mock', storage, () => assert.fail('Unexpected storage error'));
  box.enqueue('session-A', 'student-A', { event_id: 'second', seq: 2 });
  box.enqueue('session-A', 'student-A', { event_id: 'first', seq: 1 });
  box.enqueue('session-B', 'student-B', { event_id: 'foreign', seq: 1 });
  const calls = [];
  const client = { rpc: async (_, input) => {
    const ids = input.p_events.map(e => e.event_id);
    calls.push(ids);
    if (calls.length === 1) throw new Error('network offline');
    return { acknowledged: ids };
  } };
  await assert.rejects(box.flush(client, 'student-A', () => {}), /network offline/);
  const afterReload = new Outbox('mock', storage, () => {});
  await afterReload.flush(client, 'student-A', () => {});
  assert.deepEqual(calls, [['first', 'second'], ['first', 'second']]);
  assert.equal(afterReload.pendingFor('session-A'), false);
  assert.equal(afterReload.pendingFor('session-B'), true);
});

test('CSV quotes user-entered names and neutralizes spreadsheet formula prefixes', () => {
  assert.equal(csv([['+Name', ' =1+2', 'A"B', 'Ordinary']]), `"'+Name","' =1+2","A""B","Ordinary"\r\n`);
  assert.equal(csv([[-1, '-1']]), `"-1","'-1"\r\n`);
});

test('card plays retain unfinished attempts and use signed numeric states and round outcomes', () => {
  const session = { session_id: 'session', participant_id: 'participant', student_name: 'A', partner_name: 'B' };
  const events = ['resolved', 'abandoned', 'unresolved'].map((round, index) => ({
    event_type: 'card_played', round_id: round, event_id: `event-${index}`, seq: index + 1,
    elapsed_ms: index * 1000, client_at: '2026-11-25T00:00:00Z',
    payload: { card: 'ghost', turn: 3, player: 'A', actor: 'human', before: { H: [], T: [1] }, after: { H: [1], T: [-1] } },
  }));
  events.push(
    { event_type: 'round_resolved', round_id: 'resolved', payload: { heads_probability: 0.5, outcome: 'T' } },
    { event_type: 'round_restart', round_id: 'abandoned', payload: { abandoned: true } },
  );
  const rows = cardPlayRows(session, events);
  assert.ok(rows.every(row => row.length === cardPlayColumns.length));
  assert.deepEqual(rows[0], [
    'participant', 'session', true, 'resolved', 'event-0', 1, 0, '2026-11-25T00:00:00Z',
    3, 'A', 'human', 'ghost', 0, 1, 1, -1, 'resolved', 0.5, 'T',
  ]);
  assert.deepEqual(rows.slice(1).map(row => row.slice(-3)), [
    ['abandoned', undefined, undefined],
    ['unresolved', undefined, undefined],
  ]);
});

const pglite = process.env.GCA_PGLITE_DIR;
test('the database enforces ownership, validates moves and credits a lost round once after an out-of-order retry', { skip: !pglite }, async () => {
  const { PGlite } = await import(pglite + '/index.js');
  const { pgcrypto } = await import(pglite + '/contrib/pgcrypto.js');
  const db = new PGlite({ extensions: { pgcrypto } });
  try {
    await db.exec(`
      create schema extensions;
      create schema auth;
      create role anon;
      create role authenticated;
      create table auth.users(id uuid primary key);
      create function auth.jwt() returns jsonb language sql stable as
        $$select nullif(current_setting('request.jwt.claims', true), '')::jsonb$$;
      create function auth.uid() returns uuid language sql stable as
        $$select (auth.jwt() ->> 'sub')::uuid$$;
    `);
    const migration = await readFile(new URL('../supabase/migrations/202611250001_ghost_coin_level_2.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    const [teacher, otherTeacher, studentA, studentB] = Array.from({ length: 4 }, () => randomUUID());
    await db.query('insert into auth.users select unnest($1::uuid[])', [[teacher, otherTeacher, studentA, studentB]]);
    await db.query('insert into gca_private.instructors select unnest($1::uuid[])', [[teacher, otherTeacher]]);
    await db.exec(`update gca_private.settings set allowed_origins = array['http://localhost:8080']`);

    async function as(id, isAnonymous, sql, args = [], origin = 'http://localhost:8080') {
      return db.transaction(async tx => {
        await tx.exec(id ? 'set local role authenticated' : 'set local role anon');
        await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)`, [
          JSON.stringify({ sub: id, is_anonymous: isAnonymous }), JSON.stringify({ origin }),
        ]);
        return (await tx.query(sql, args)).rows;
      });
    }
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const [classResult] = await as(teacher, false, `select gca_save_class(null, 'Synthetic classroom', 1, true, false) as row`);
    const { class_id: classId, class_code: code } = classResult.row;
    const enroll = (id, session, name, classCode = code, partner = '') => as(id, true, 'select gca_enroll($1,$2,$3,$4) as row', [classCode, name, partner, session]);
    assert.match((await enroll(studentA, sessionA, 'Synthetic A', '0000000000000000'))[0].row.error, /invalid/);
    assert.equal((await enroll(studentA, sessionA, 'Synthetic A'))[0].row.session_id, sessionA);
    assert.equal((await enroll(studentB, sessionB, 'Synthetic B', code, 'Synthetic Partner'))[0].row.session_id, sessionB);
    await assert.rejects(as(null, true, 'select * from gca_classes()'), /permission denied/);
    await assert.rejects(as(studentA, true, 'select * from gca_private.participants'), /permission denied/);
    await assert.rejects(as(studentA, true, 'select * from gca_events($1)', [sessionB]), /Instructor access required/);
    await assert.rejects(as(otherTeacher, false, 'select * from gca_sessions($1)', [classId]), /Class is unavailable/);
    await assert.rejects(as(teacher, false, 'select * from gca_classes()', [], 'https://unlisted.example'), /not authorized/);

    const html = await readFile(new URL('../games/ghost-coin.html', import.meta.url), 'utf8');
    const context = { window: {} };
    vm.runInNewContext(html.match(/<script id="logic">([\s\S]*?)<\/script>/)[1], context);
    const { GC } = context.window;
    const roundId = randomUUID();
    const cards = ['flip', 'leave', 'leave'];
    const timing = { visible_ms: 500, active_ms: 500, idle_ms: 0, hidden_ms: 0 };
    const options = { computer_b: true, show_cards: false, resolve_together: true };
    let sequence = 0;
    const event = (type, payload, round = roundId) => ({
      event_id: randomUUID(), seq: ++sequence, type, round_id: round,
      activity_id: 'ghost-coin', activity_version: 'level2-pilot-1', schema_version: 1,
      level: 2, client_at: new Date().toISOString(), elapsed_ms: 500, payload: { ...payload, timing },
    });
    const events = [event('round_start', { ...options, initial: { H: [1], T: [] } })];
    for (const [index, card] of cards.entries()) {
      events.push(event('card_played', {
        card, player: index === 1 ? 'B' : 'A', actor: index === 1 ? 'computer' : 'human', turn: index + 1,
        before: GC.play(cards.slice(0, index)).state, after: GC.play(cards.slice(0, index + 1)).state,
      }));
    }
    const resolvedState = GC.play(cards).state;
    const resolved = event('round_resolved', {
      cards, before_measurement: resolvedState, final_state: resolvedState,
      heads_probability: 0, tails_probability: 1, outcome: 'T', winner: 'B',
      sampled: false, observed_all_cards: true, options,
    });
    const ingest = async (id, session, batch) => (await as(id, true, 'select gca_ingest($1, $2::jsonb) as row', [session, JSON.stringify(batch)]))[0].row;
    await assert.rejects(ingest(studentB, sessionA, [resolved]), /Session is unavailable/);
    assert.equal((await ingest(studentA, sessionA, [resolved])).completed_at, null);
    await assert.rejects(ingest(studentA, sessionA, [{ ...events[0], payload: { ...events[0].payload, name: 'Unexpected text' } }]), /Invalid event format/);
    const completed = await ingest(studentA, sessionA, events);
    assert.ok(completed.completed_at);
    assert.equal(completed.resolved_rounds, 1);
    const retried = await ingest(studentA, sessionA, [...events, resolved]);
    assert.deepEqual(retried.acknowledged, [...events, resolved].map(row => row.event_id));
    assert.equal(retried.completed_at, completed.completed_at);
    assert.equal(retried.resolved_rounds, 1);

    const accessible = await as(teacher, false, 'select * from gca_sessions($1)', [classId]);
    const row = accessible.find(s => s.session_id === sessionA);
    assert.equal(accessible.length, 2);
    assert.equal(Number(row.resolved_rounds), 1);
    assert.equal(Number(row.human_moves), 2);
    assert.equal(Number(row.computer_moves), 1);
    assert.deepEqual(row.timing, timing);
    assert.deepEqual(row.sequences, [{ cards, heads: 0, tails: 1 }]);
    const eventRows = await as(teacher, false, 'select * from gca_events($1)', [sessionA]);
    assert.deepEqual(eventRows.map(e => e.seq), [1, 2, 3, 4, 5]);
    assert.equal(eventRows[4].payload.outcome, 'T');

    await as(teacher, false, `select gca_save_class($1, 'Synthetic classroom', 1, false, false)`, [classId]);
    assert.match((await enroll(studentB, randomUUID(), 'Synthetic B'))[0].row.error, /closed/);
    await as(teacher, false, 'select gca_delete_participant($1)', [row.participant_id]);
    await assert.rejects(as(teacher, false, 'select * from gca_events($1)', [sessionA]), /Session is unavailable/);
    assert.equal((await as(teacher, false, 'select * from gca_sessions($1)', [classId])).length, 1);
  } finally {
    await db.close();
  }
});
