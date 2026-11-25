export function duration(ms) {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function csv(rows) {
  return rows.map(row => row.map(value => {
    let field = String(value ?? '');
    if (typeof value !== 'number' && /^[\t\r\n]|^\s*[=+@\-]/u.test(field)) field = "'" + field;
    return '"' + field.replaceAll('"', '""') + '"';
  }).join(',')).join('\r\n') + '\r\n';
}

export const cardPlayColumns = [
  'participant_id', 'session_id', 'shared', 'round_id', 'event_id', 'seq', 'elapsed_ms', 'client_at',
  'turn', 'player', 'actor', 'card', 'before_heads', 'before_tails', 'after_heads', 'after_tails',
  'round_status', 'heads_probability', 'outcome',
];

export function cardPlayRows(session, events) {
  const resolved = new Map();
  const abandoned = new Set();
  for (const event of events) {
    if (event.event_type === 'round_resolved') resolved.set(event.round_id, event.payload);
    if (event.event_type === 'round_restart' && event.payload.abandoned) abandoned.add(event.round_id);
  }

  return events.filter(event => event.event_type === 'card_played').map(event => {
    const { turn, player, actor, card, before, after } = event.payload;
    const result = resolved.get(event.round_id);
    let status = 'unresolved';
    if (result) status = 'resolved';
    else if (abandoned.has(event.round_id)) status = 'abandoned';

    return [
      session.participant_id, session.session_id, Boolean(session.partner_name), event.round_id,
      event.event_id, event.seq, event.elapsed_ms, event.client_at, turn, player, actor, card,
      before.H[0] ?? 0, before.T[0] ?? 0, after.H[0] ?? 0, after.T[0] ?? 0,
      status, result?.heads_probability, result?.outcome,
    ];
  });
}
