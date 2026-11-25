const cardNames = { leave: 'Leave', flip: 'Flip', ghost: 'Ghost' };

export function createClassReport() {
  return {
    sessions: 0,
    enrollments: new Set(),
    credited: new Set(),
    started: 0,
    resolved: 0,
    noVisibleTime: 0,
    choices: { leave: [0, 0], flip: [0, 0], ghost: [0, 0] },
    pacing: { manual: [], automatic: [] },
    sequences: new Map(),
  };
}

export function addSessionToReport(report, session, events) {
  report.sessions++;
  report.enrollments.add(session.participant_id);
  if (session.completed_at) report.credited.add(session.participant_id);

  const rounds = new Map();
  for (const event of events) {
    if (!event.round_id) continue;
    let round = rounds.get(event.round_id);
    if (!round) {
      round = { cards: [] };
      rounds.set(event.round_id, round);
    }
    if (event.event_type === 'round_start') {
      round.start = event;
    } else if (event.event_type === 'card_played') {
      round.cards.push(event);
      const counts = report.choices[event.payload.card];
      counts[event.payload.actor === 'computer' ? 1 : 0]++;
    } else if (event.event_type === 'round_resolved') {
      round.outcome = event;
    }
  }

  for (const { start, cards, outcome } of rounds.values()) {
    if (start) report.started++;
    if (!outcome) continue;
    report.resolved++;
    const result = outcome.payload;
    if (result.timing?.visible_ms === 0 && cards.some(event => event.payload.actor === 'human')) {
      report.noVisibleTime++;
    }
    const label = result.cards.map(card => cardNames[card]).join(' → ');
    const counts = report.sequences.get(label) ?? { heads: 0, tails: 0, probability: result.heads_probability };
    counts[result.outcome === 'H' ? 'heads' : 'tails']++;
    report.sequences.set(label, counts);

    const last = cards.find(event => event.payload.turn === 3);
    if (!start || cards.length !== 3 || !last || start.seq >= last.seq || last.seq >= outcome.seq) continue;
    const before = last.elapsed_ms - start.elapsed_ms;
    const after = outcome.elapsed_ms - last.elapsed_ms;
    if (!Number.isFinite(before) || !Number.isFinite(after) || before < 0 || after < 0) continue;
    const mode = result.options.resolve_together ? 'automatic' : 'manual';
    report.pacing[mode].push([before, after]);
  }
}

function median(values) {
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

function describeTime(ms) {
  if (ms === 0) return '0 s';
  if (ms < 100) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function element(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function chart(heading, labels, rows) {
  const figure = element('figure', undefined, 'report-chart');
  const legend = element('p', undefined, 'report-legend');
  legend.append(...labels.map(label => element('span', label)));
  figure.append(element('figcaption', heading), legend);
  const max = Math.max(1, ...rows.map(([, values]) => values[0] + values[1]));
  for (const [name, values, formatted] of rows) {
    const line = element('div', undefined, 'report-bar-row');
    const track = element('div', undefined, 'report-track');
    track.setAttribute('aria-hidden', 'true');
    track.append(...values.map(value => {
      const segment = element('span');
      segment.style.width = `${100 * value / max}%`;
      return segment;
    }));
    const description = formatted.map((value, i) => `${labels[i]} ${value}`).join(' · ');
    line.append(element('div', name, 'report-bar-label'), track, element('p', description, 'report-bar-value'));
    figure.append(line);
  }
  return figure;
}

export function renderClassReport(root, report) {
  const summary = element('dl', undefined, 'report-totals');
  for (const [label, value] of [
    ['Sessions', report.sessions],
    ['Rounds started', report.started],
    ['Rounds resolved', report.resolved],
    ['Enrollments with credit', `${report.credited.size} / ${report.enrollments.size}`],
  ]) {
    const cell = element('div');
    cell.append(element('dt', label), element('dd', value));
    summary.append(cell);
  }
  const figures = element('div', undefined, 'report-figures');
  figures.append(chart('Card choices', ['Human', 'Computer'], Object.entries(report.choices)
    .map(([card, counts]) => [cardNames[card], counts, counts])));

  const pacing = [];
  for (const [mode, label] of [['manual', 'Manual reveal'], ['automatic', 'Automatic reveal']]) {
    const rounds = report.pacing[mode];
    if (!rounds.length) continue;
    const values = [median(rounds.map(([before]) => before)), median(rounds.map(([, after]) => after))];
    pacing.push([`${label} (${rounds.length})`, values, values.map(describeTime)]);
  }
  if (pacing.length) {
    const timing = chart('Median time by round phase', ['Start to final card', 'Final card to result'], pacing);
    timing.append(element('p', 'Each phase has its own median. Pacing uses rounds with all three saved card choices and a start and result.', 'report-note'));
    figures.append(timing);
  } else {
    const timing = element('div', undefined, 'report-chart');
    timing.append(element('h3', 'Median time by round phase'), element('p', 'No completed rounds with timing data yet.'));
    figures.append(timing);
  }

  const details = [summary, figures];
  if (report.noVisibleTime) {
    const count = report.noVisibleTime;
    const warning = count === 1 ? '1 resolved round has' : `${count} resolved rounds have`;
    details.push(element('p', `${warning} human card choices and 0 seconds of recorded visible time at resolution. Check tab visibility before interpreting active time.`, 'report-note'));
  }
  if (report.sequences.size) {
    const table = element('table');
    table.append(element('caption', 'Completed card sequences'));
    const header = table.createTHead().insertRow();
    for (const name of ['Sequence', 'Heads probability', 'Heads', 'Tails']) {
      const column = element('th', name);
      column.scope = 'col';
      header.append(column);
    }
    const body = table.createTBody();
    const ordered = [...report.sequences].sort(([seqA, a], [seqB, b]) =>
      b.heads + b.tails - a.heads - a.tails || seqA.localeCompare(seqB));
    for (const [sequence, { probability, heads, tails }] of ordered) {
      const row = body.insertRow();
      for (const value of [sequence, `${probability * 100}%`, heads, tails]) row.insertCell().textContent = value;
    }
    const scroll = element('div', undefined, 'scroll');
    scroll.append(table);
    details.push(scroll);
  }
  root.replaceChildren(...details);
}
