import { api, toast, escHtml, escAttr } from '../utils.js';

let initiatives = [];
let templates = [];
let selectedTemplate = 'ticket-to-pr';
let pendingCriteria = null;
let selectedId = null;
let refreshTimer = null;

const STATUS_LABELS = {
  draft: 'Draft',
  running: 'Running',
  blocked: 'Needs you',
  paused: 'Paused',
  cancelled: 'Stopped',
  done: 'Done',
  failed: 'Failed',
};

// ─── Loading ─────────────────────────────────────────────────────────────────

export async function loadInitiatives() {
  const list = document.getElementById('initiatives-list');
  try {
    const data = await api('GET', '/api/initiatives');
    initiatives = data.initiatives || [];
    templates = data.templates || templates;
    if (!initiatives.some(i => i.id === selectedId)) {
      selectedId = initiatives.find(i => i.status === 'blocked')?.id || initiatives[0]?.id || null;
    }
    renderList(list);
    renderDetail();
    renderNeedsYou();
  } catch (err) {
    list.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

export function startInitiativesAutoRefresh() {
  clearInitiativesAutoRefresh();
  refreshTimer = setInterval(loadInitiatives, 8000);
}

export function clearInitiativesAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

// ─── List ────────────────────────────────────────────────────────────────────

function renderList(container) {
  if (!initiatives.length) {
    container.innerHTML = `<div class="drawer-empty">
      No initiatives yet.<br><small>An initiative is a piece of work the supervisor drives on its own — it approves safe prompts, keeps the agent moving through stages, and only stops you for decisions that matter.</small>
    </div>`;
    return;
  }

  container.innerHTML = initiatives.map(i => {
    const done = i.stages.filter(s => s.status === 'done').length;
    const gates = (i.openGates || []).length;
    const stage = i.currentStage;
    return `<div class="initiative-item${i.id === selectedId ? ' is-selected' : ''}" onclick="selectInitiative('${escAttr(i.id)}')">
      <div class="initiative-item-top">
        <span class="initiative-status initiative-status-${escAttr(i.status)}">${escHtml(STATUS_LABELS[i.status] || i.status)}</span>
        <span class="initiative-item-name">${escHtml(i.name)}</span>
        ${gates ? `<span class="initiative-gate-count">${gates}</span>` : ''}
      </div>
      <div class="initiative-item-meta">
        <span>${escHtml(stage?.name || '—')}</span>
        <span class="initiative-progress"><span style="width:${Math.round((done / i.stages.length) * 100)}%"></span></span>
        <span>${done}/${i.stages.length}</span>
        ${i.liveWorkers ? `<span class="initiative-worker-count" title="agents working in parallel">${i.liveWorkers}×</span>` : ''}
      </div>
      <div class="initiative-item-path">${escHtml(tildefy(i.cwd))}</div>
    </div>`;
  }).join('');
}

function renderNeedsYou() {
  const el = document.getElementById('initiatives-needs-you');
  const gates = initiatives.flatMap(i => (i.openGates || []).map(g => ({ ...g, initiative: i })));
  if (!gates.length) {
    el.innerHTML = '<span class="initiatives-clear">Nothing waiting on you</span>';
    return;
  }
  el.innerHTML = `<button class="btn btn-sm initiatives-needs-btn" onclick="selectInitiative('${escAttr(gates[0].initiative.id)}')">
    ${gates.length} decision${gates.length === 1 ? '' : 's'} waiting
  </button>`;
}

// ─── Detail ──────────────────────────────────────────────────────────────────

function renderDetail() {
  const el = document.getElementById('initiative-detail');
  const i = initiatives.find(x => x.id === selectedId);
  if (!i) {
    el.innerHTML = '<div class="drawer-empty">Select an initiative.</div>';
    return;
  }

  const live = i.liveWorkers
    ? `<span class="initiative-live initiative-live-${escAttr(i.live.status)}">${i.liveWorkers} agent${i.liveWorkers === 1 ? '' : 's'} working</span>`
    : '<span class="initiative-live initiative-live-none">no live agent</span>';

  el.innerHTML = `
    <div class="initiative-detail-header">
      <div>
        <h3>${escHtml(i.name)}</h3>
        <div class="initiative-detail-sub">
          <span class="initiative-status initiative-status-${escAttr(i.status)}">${escHtml(STATUS_LABELS[i.status] || i.status)}</span>
          ${live}
          <span class="initiative-detail-path">${escHtml(tildefy(i.cwd))}</span>
          <span class="badge badge-sm">${escHtml(i.profile)}</span>
          ${i.template ? `<span class="badge badge-sm">${escHtml(i.template)}</span>` : ''}
        </div>
      </div>
      <div class="initiative-detail-actions">
        ${['running', 'blocked'].includes(i.status)
          ? `<button class="btn btn-ghost btn-sm" onclick="pauseInitiative('${escAttr(i.id)}')" title="Stop supervising, leave the agents running">Pause</button>`
          : `<button class="btn btn-primary btn-sm" onclick="startInitiative('${escAttr(i.id)}')">${(i.workers || []).length ? 'Resume' : 'Start'}</button>`}
        ${i.liveWorkers || ['running', 'blocked', 'paused'].includes(i.status)
          ? `<button class="btn btn-ghost btn-sm" onclick="stopInitiative('${escAttr(i.id)}')" title="End the run and kill its agents">Stop</button>`
          : ''}
        <button class="btn btn-ghost btn-sm" onclick="openSplitStage('${escAttr(i.id)}')">Split stage</button>
        <button class="btn btn-ghost btn-sm" onclick="runInitiativeCheck('${escAttr(i.id)}')">Run check</button>
        <button class="btn btn-ghost btn-sm" onclick="advanceInitiative('${escAttr(i.id)}')">Skip stage</button>
        <button class="btn btn-ghost btn-sm" onclick="deleteInitiative('${escAttr(i.id)}')">Delete</button>
      </div>
    </div>

    ${i.goal ? `<p class="initiative-goal">${escHtml(i.goal)}</p>` : ''}

    ${renderGates(i)}
    ${renderAcceptance(i)}
    ${renderWorkers(i)}
    ${renderStages(i)}
    ${renderStats(i)}

    <form class="initiative-say" onsubmit="sendInitiativeMessage(event, '${escAttr(i.id)}')">
      <input type="text" id="initiative-say-input" placeholder="Say something to this agent…" />
      <button type="submit" class="btn btn-ghost btn-sm">Send</button>
    </form>

    <h4 class="initiative-section-title">Activity</h4>
    <div class="initiative-timeline">
      ${[...(i.events || [])].reverse().slice(0, 60).map(renderEvent).join('') || '<div class="drawer-empty">Nothing yet.</div>'}
    </div>
  `;
}

function renderGates(i) {
  const gates = i.openGates || [];
  if (!gates.length) return '';
  return `<div class="initiative-gates">
    ${gates.map(g => `<div class="initiative-gate">
      <div class="initiative-gate-head">
        <span class="initiative-gate-kind">${escHtml(g.kind)}</span>
        <span class="initiative-gate-age">${escHtml(timeAgo(g.createdAt))}</span>
      </div>
      <div class="initiative-gate-question">${escHtml(g.question)}</div>
      ${g.reason ? `<div class="initiative-gate-reason">${escHtml(g.reason)}</div>` : ''}
      ${g.command ? `<pre class="initiative-gate-command">${escHtml(g.command)}</pre>` : ''}
      ${g.context ? `<div class="initiative-gate-context">${escHtml(g.context)}</div>` : ''}
      <div class="initiative-gate-options">
        ${(g.options || []).map(o => `<button class="btn btn-sm${o === g.defaultOption ? ' btn-primary' : ''}" onclick="answerGate('${escAttr(i.id)}','${escAttr(g.id)}','${escAttr(o)}')">${escHtml(o)}</button>`).join('')}
      </div>
      <form class="initiative-gate-free" onsubmit="answerGateFree(event, '${escAttr(i.id)}','${escAttr(g.id)}')">
        <input type="text" placeholder="…or answer in your own words" />
        <button type="submit" class="btn btn-ghost btn-sm">Answer</button>
      </form>
      ${g.defaultOption ? `<div class="initiative-gate-default">If you don't answer, it takes "${escHtml(g.defaultOption)}" automatically.</div>` : ''}
    </div>`).join('')}
  </div>`;
}

function renderAcceptance(i) {
  const criteria = i.acceptance || [];
  if (!criteria.length) {
    return `<div class="initiative-dod initiative-dod-empty">
      <div class="initiative-dod-head">Definition of done <span>not set</span></div>
      <p>Without one, the supervisor has nothing to verify against and will stop to ask you instead.</p>
      <button class="btn btn-sm" onclick="frameInitiative('${escAttr(i.id)}')">Work one out</button>
    </div>`;
  }
  const met = criteria.filter(c => c.status === 'met' || c.status === 'waived').length;
  return `<div class="initiative-dod">
    <div class="initiative-dod-head">
      Definition of done <span>${met}/${criteria.length} met</span>
      <button class="btn btn-ghost btn-sm" onclick="checkAcceptance('${escAttr(i.id)}')">Check now</button>
    </div>
    ${criteria.map(c => `<div class="initiative-criterion initiative-criterion-${escAttr(c.status)}">
      <button class="initiative-criterion-box" onclick="toggleCriterion('${escAttr(i.id)}','${escAttr(c.id)}','${c.status === 'met' ? 'unmet' : 'met'}')"
        title="${c.status === 'met' ? 'Mark as not met' : 'Mark as met'}">${c.status === 'met' ? '✓' : c.status === 'waived' ? '–' : ''}</button>
      <div class="initiative-criterion-body">
        <div class="initiative-criterion-text">${escHtml(c.text)}</div>
        <div class="initiative-criterion-check">
          ${c.check?.type === 'human'
            ? `<span class="initiative-criterion-human">your call</span>`
            : `<code>${escHtml(describeCheck(c.check))}</code>`}
          ${c.detail ? `<span class="initiative-criterion-detail">${escHtml(c.detail)}</span>` : ''}
        </div>
      </div>
    </div>`).join('')}
  </div>`;
}

function describeCheck(check) {
  if (!check) return '';
  switch (check.type) {
    case 'command': return check.command;
    case 'file-exists': return `${check.path} exists`;
    case 'file-contains': return `${check.path} covers ${(check.patterns || []).join(', ')}`;
    case 'git-dirty': return 'there are changes';
    case 'commits-ahead': return 'commits exist';
    case 'pushed': return 'branch is pushed';
    case 'pr-exists': return 'a PR exists';
    case 'branch-created': return 'off master';
    default: return check.type;
  }
}

function renderWorkers(i) {
  const workers = (i.workers || []).filter(w => w.status !== 'gone' && w.status !== 'done');
  if (!workers.length) return '';
  return `<div class="initiative-workers">
    <div class="initiative-workers-head">Workers <span>${workers.length} of ${i.maxParallel} slots</span></div>
    ${workers.map(w => `<div class="initiative-worker">
      <span class="initiative-worker-dot initiative-worker-${escAttr(w.live ? w.live.status : 'starting')}"></span>
      <span class="initiative-worker-name">${escHtml(w.name)}</span>
      ${w.worktree ? `<span class="initiative-worker-branch" title="${escAttr(w.worktree.path)}">${escHtml(w.worktree.branch)}</span>` : ''}
      <span class="initiative-worker-status${w.live ? '' : ' initiative-worker-stale'}">${escHtml(w.live ? w.live.status : (w.status === 'working' ? 'no agent' : w.status))}</span>
      ${w.live ? `<span class="initiative-worker-pid">pid ${escHtml(w.live.pid)}</span>` : ''}
    </div>`).join('')}
  </div>`;
}

function renderTasks(stage) {
  const tasks = stage.tasks || [];
  if (!tasks.length) return '';
  return `<div class="initiative-tasks">
    ${tasks.map(t => `<div class="initiative-task initiative-task-${escAttr(t.status)}">
      <span class="initiative-task-dot"></span>
      <span class="initiative-task-name">${escHtml(t.name)}</span>
      ${t.branch ? `<span class="initiative-worker-branch">${escHtml(t.branch)}</span>` : ''}
      <span class="initiative-task-status">${escHtml(t.status)}</span>
    </div>`).join('')}
  </div>`;
}

function renderStages(i) {
  return `<div class="initiative-stages">
    ${i.stages.map((s, idx) => {
      const state = idx === i.stageIndex && !['done', 'skipped'].includes(s.status) ? 'active' : s.status;
      const parallel = (s.tasks || []).length;
      return `<div class="initiative-stage initiative-stage-${escAttr(state)}">
        <div class="initiative-stage-dot"></div>
        <div class="initiative-stage-body">
          <div class="initiative-stage-name">${escHtml(s.name)}${parallel ? `<span class="initiative-stage-parallel">${parallel} in parallel</span>` : ''}${s.nudges ? `<span class="initiative-stage-nudges">${s.nudges} nudge${s.nudges === 1 ? '' : 's'}</span>` : ''}</div>
          <div class="initiative-stage-instruction">${escHtml(s.instruction)}</div>
          ${renderTasks(s)}
        </div>
      </div>`;
    }).join('')}
    ${i.integration?.branches?.length ? `<div class="initiative-integration">Parallel branches ready to merge: ${i.integration.branches.map(b => `<code>${escHtml(b)}</code>`).join(' ')}</div>` : ''}
  </div>`;
}

function renderStats(i) {
  const s = i.stats || {};
  const saved = (s.autoApprovals || 0) + (s.nudges || 0) + (s.autoDecided || 0);
  return `<div class="initiative-stats">
    <span title="Permission prompts answered without you"><strong>${s.autoApprovals || 0}</strong> auto-approved</span>
    <span title="Times the agent was kept moving instead of idling"><strong>${s.nudges || 0}</strong> nudges</span>
    <span title="Judgement calls made by the supervisor's LLM pass"><strong>${s.llmDecisions || 0}</strong> judgements</span>
    <span title="Questions parked for you"><strong>${s.gates || 0}</strong> gates</span>
    <span class="initiative-stats-saved" title="Handoffs that would have waited for you">${saved} handoff${saved === 1 ? '' : 's'} you didn't have to make</span>
  </div>`;
}

const EVENT_ICONS = {
  'auto-approved': '✓',
  nudge: '→',
  'llm-continue': '→',
  'stage-done': '●',
  'stage-start': '○',
  'gate-opened': '!',
  'gate-resolved': '✓',
  'run-started': '▶',
  completed: '★',
  error: '✕',
};

function renderEvent(e) {
  return `<div class="initiative-event initiative-event-${escAttr(e.type)}">
    <span class="initiative-event-icon">${escHtml(EVENT_ICONS[e.type] || '·')}</span>
    <span class="initiative-event-time">${escHtml(shortTime(e.ts))}</span>
    ${e.stageName ? `<span class="initiative-event-stage">${escHtml(e.stageName)}</span>` : ''}
    <span class="initiative-event-detail">${escHtml(e.detail)}</span>
  </div>`;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export function selectInitiative(id) {
  selectedId = id;
  renderList(document.getElementById('initiatives-list'));
  renderDetail();
}

export async function startInitiative(id) {
  try {
    await api('POST', `/api/initiatives/${id}/start`);
    toast('Supervisor is driving this initiative');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function pauseInitiative(id) {
  try {
    await api('POST', `/api/initiatives/${id}/pause`);
    toast('Paused');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function advanceInitiative(id) {
  if (!window.confirm('Skip the current stage and move to the next one?')) return;
  try {
    const data = await api('POST', `/api/initiatives/${id}/advance`);
    toast(data.next ? `Now on ${data.next}` : 'Initiative complete');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function runInitiativeCheck(id) {
  try {
    const data = await api('POST', `/api/initiatives/${id}/check`);
    const r = data.result || {};
    const verdict = r.passed === true ? 'passes' : r.passed === false ? 'fails' : 'is inconclusive';
    toast(`${data.stage || 'Stage'} ${verdict}: ${r.detail || ''}`, r.passed === false ? 'error' : 'success');
  } catch (err) { toast(err.message, 'error'); }
}

export async function stopInitiative(id) {
  const i = initiatives.find(x => x.id === id);
  const live = i?.liveWorkers || 0;
  const message = live
    ? `Stop "${i.name}" and kill ${live} running agent${live === 1 ? '' : 's'}?\n\nCommits, branches and worktrees are left exactly as they are.`
    : `Stop "${i?.name || id}"?`;
  if (!window.confirm(message)) return;
  try {
    const data = await api('POST', `/api/initiatives/${id}/stop`);
    toast(data.stopped.length ? `Stopped — killed ${data.stopped.length} agent session(s)` : 'Stopped');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function deleteInitiative(id) {
  const i = initiatives.find(x => x.id === id);
  const live = i?.liveWorkers || 0;
  const worktrees = (i?.workers || []).filter(w => w.worktree).length;

  if (!window.confirm(
    `Remove "${i?.name || id}"?\n\n`
    + `This deletes the initiative record only.\n`
    + (live ? `• ${live} running agent${live === 1 ? '' : 's'} will be killed\n` : '')
    + `• Commits and branches are kept\n`
    + (worktrees ? `• ${worktrees} worktree${worktrees === 1 ? '' : 's'} stay on disk unless you choose to clean them next\n` : ''),
  )) return;

  const prune = worktrees
    ? window.confirm('Also remove the worktree directories?\n\nOnly clean ones are removed — anything with uncommitted changes is left alone, and every branch survives.')
    : false;

  try {
    const data = await api('DELETE', `/api/initiatives/${id}?pruneWorktrees=${prune}`);
    const bits = [];
    if (data.stopped?.length) bits.push(`${data.stopped.length} agent(s) stopped`);
    if (data.removedWorktrees?.length) bits.push(`${data.removedWorktrees.length} worktree(s) removed`);
    if (data.keptWorktrees?.length) bits.push(`${data.keptWorktrees.length} kept (uncommitted work)`);
    toast(bits.length ? `Removed — ${bits.join(', ')}` : 'Removed');
    selectedId = null;
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function answerGate(id, gateId, answer) {
  try {
    await api('POST', `/api/initiatives/${id}/gates/${gateId}`, { answer });
    toast('Answered — the run continues');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function answerGateFree(event, id, gateId) {
  event.preventDefault();
  const input = event.target.querySelector('input');
  const answer = input.value.trim();
  if (!answer) return;
  input.value = '';
  await answerGate(id, gateId, answer);
}

export async function sendInitiativeMessage(event, id) {
  event.preventDefault();
  const input = document.getElementById('initiative-say-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  try {
    await api('POST', `/api/initiatives/${id}/message`, { message });
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function openSplitStage(id) {
  const i = initiatives.find(x => x.id === id);
  const stage = i?.currentStage;
  if (!stage) return;
  const raw = window.prompt(
    `Split "${stage.name}" into parallel tasks — one per line.\n`
    + 'Each gets its own agent and its own git worktree.\n'
    + 'Use "name: instruction" to say what each one should do.',
    (stage.tasks || []).map(t => (t.instruction ? `${t.name}: ${t.instruction}` : t.name)).join('\n'),
  );
  if (raw === null) return;

  const tasks = raw.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const idx = line.indexOf(':');
    return idx === -1
      ? { name: line, instruction: '' }
      : { name: line.slice(0, idx).trim(), instruction: line.slice(idx + 1).trim() };
  });
  if (!tasks.length) return;

  try {
    await api('POST', `/api/initiatives/${id}/split`, { stageId: stage.id, tasks });
    toast(`${stage.name} split into ${tasks.length} parallel task${tasks.length === 1 ? '' : 's'}`);
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function checkAcceptance(id) {
  try {
    const data = await api('POST', `/api/initiatives/${id}/acceptance/check`);
    const met = data.results.filter(r => r.passed === true).length;
    const open = data.results.filter(r => r.passed === false);
    toast(open.length ? `${met} met — still open: ${open[0].text}` : `All ${met} checkable criteria met`, open.length ? 'error' : 'success');
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

export async function toggleCriterion(id, criterionId, status) {
  try {
    await api('POST', `/api/initiatives/${id}/acceptance/${criterionId}`, { status });
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

/** Work out a definition of done for an initiative that has none. */
export async function frameInitiative(id) {
  const i = initiatives.find(x => x.id === id);
  if (!i) return;
  toast('Working out what done means — about a minute…');
  try {
    const { proposal } = await api('POST', '/api/initiatives/frame', {
      goal: i.goal || i.name, cwd: i.cwd, template: i.template,
    });
    if (!confirmProposal(proposal)) return;
    await api('PUT', `/api/initiatives/${id}/acceptance`, { criteria: proposal.criteria });
    toast(`Definition of done set — ${proposal.criteria.length} criteria`);
    loadInitiatives();
  } catch (err) { toast(err.message, 'error'); }
}

function confirmProposal(proposal) {
  const lines = proposal.criteria.map((c, n) => `${n + 1}. ${c.text}\n     checked by: ${c.check.type === 'human' ? 'you' : describeCheck(c.check)}`);
  const questions = proposal.openQuestions?.length
    ? `\n\nWorth settling first:\n${proposal.openQuestions.map(q => `• ${q}`).join('\n')}`
    : '';
  return window.confirm(`${proposal.summary}\n\n${lines.join('\n')}${questions}\n\nUse this as the definition of done?`);
}

// ─── Create ──────────────────────────────────────────────────────────────────

export async function openNewInitiativeModal() {
  document.getElementById('new-initiative-modal').style.display = 'flex';
  if (!templates.length) {
    try { templates = (await api('GET', '/api/initiatives/templates')).templates || []; } catch {}
  }
  renderTemplatePicker();
  document.getElementById('new-initiative-name').focus();
}

function renderTemplatePicker() {
  const el = document.getElementById('new-initiative-templates');
  if (!el) return;
  el.innerHTML = templates.map(t => `<button type="button"
      class="template-card${t.id === selectedTemplate ? ' is-selected' : ''}"
      onclick="pickInitiativeTemplate('${escAttr(t.id)}')">
    <div class="template-card-name">${escHtml(t.name)}</div>
    <div class="template-card-summary">${escHtml(t.summary)}</div>
    <div class="template-card-stages">${t.stages.map(s => escHtml(s.name)).join(' → ')}</div>
    <div class="template-card-meta">
      <span>${escHtml(t.profile)}</span>
      <span>up to ${t.maxParallel} in parallel</span>
    </div>
  </button>`).join('');

  const chosen = templates.find(t => t.id === selectedTemplate);
  const hint = document.getElementById('new-initiative-when');
  if (hint) hint.textContent = chosen?.when || '';
  const profile = document.getElementById('new-initiative-profile');
  if (profile && chosen) profile.value = chosen.profile;
  const parallel = document.getElementById('new-initiative-parallel');
  if (parallel && chosen) parallel.value = chosen.maxParallel;
}

export function pickInitiativeTemplate(id) {
  selectedTemplate = id;
  renderTemplatePicker();
}

export async function createInitiative(event) {
  event.preventDefault();
  const body = {
    template: selectedTemplate,
    maxParallel: parseInt(document.getElementById('new-initiative-parallel').value, 10) || 3,
    name: document.getElementById('new-initiative-name').value.trim(),
    goal: document.getElementById('new-initiative-goal').value.trim(),
    cwd: document.getElementById('new-initiative-cwd').value.trim(),
    agentId: document.getElementById('new-initiative-agent').value,
    profile: document.getElementById('new-initiative-profile').value,
    verifyCommand: document.getElementById('new-initiative-verify').value.trim(),
    autoDecideAfterMs: parseInt(document.getElementById('new-initiative-autodecide').value, 10) * 60000,
  };
  if (!body.name || !body.cwd) return toast('Name and directory are required', 'error');
  if (pendingCriteria) body.acceptance = pendingCriteria;

  try {
    const data = await api('POST', '/api/initiatives', body);
    document.getElementById('new-initiative-modal').style.display = 'none';
    event.target.reset();
    pendingCriteria = null;
    document.getElementById('new-initiative-dod').innerHTML = '';
    selectedId = data.initiative.id;
    await loadInitiatives();
    toast('Initiative created — press Start when you want it driven');
  } catch (err) { toast(err.message, 'error'); }
}

/**
 * The one interactive step worth taking before the work starts: turn the goal
 * into criteria the supervisor can check, so the run does not have to keep
 * coming back to you.
 */
export async function frameNewInitiative() {
  const goal = document.getElementById('new-initiative-goal').value.trim()
    || document.getElementById('new-initiative-name').value.trim();
  const cwd = document.getElementById('new-initiative-cwd').value.trim();
  const el = document.getElementById('new-initiative-dod');
  if (!goal || !cwd) return toast('Give it a goal and a directory first', 'error');

  el.innerHTML = '<div class="drawer-loading">Working out what done means — about a minute…</div>';
  try {
    const { proposal } = await api('POST', '/api/initiatives/frame', { goal, cwd, template: selectedTemplate });
    pendingCriteria = proposal.criteria;
    if (proposal.suggestedTemplate && proposal.suggestedTemplate !== selectedTemplate) {
      pickInitiativeTemplate(proposal.suggestedTemplate);
      toast(`Looks more like ${proposal.suggestedTemplate} — switched`);
    }
    if (proposal.verifyCommand) document.getElementById('new-initiative-verify').value = proposal.verifyCommand;

    el.innerHTML = `
      <div class="dod-proposal-summary">${escHtml(proposal.summary)}</div>
      ${proposal.criteria.map(c => `<label class="dod-proposal-item">
        <input type="checkbox" checked data-dod="${escAttr(c.id)}" onchange="window.__dodToggle && window.__dodToggle()" />
        <span>
          <span class="dod-proposal-text">${escHtml(c.text)}</span>
          <span class="dod-proposal-check">${c.check.type === 'human' ? 'your call' : escHtml(describeCheck(c.check))}</span>
        </span>
      </label>`).join('')}
      ${proposal.openQuestions?.length ? `<div class="dod-proposal-questions">
        <strong>Worth settling now:</strong>
        ${proposal.openQuestions.map(q => `<div>• ${escHtml(q)}</div>`).join('')}
      </div>` : ''}`;

    // Unticking a criterion drops it from what gets saved.
    window.__dodToggle = () => {
      const keep = [...el.querySelectorAll('input[data-dod]')].filter(b => b.checked).map(b => b.dataset.dod);
      pendingCriteria = proposal.criteria.filter(c => keep.includes(c.id));
    };
  } catch (err) {
    el.innerHTML = `<div class="dod-proposal-error">${escHtml(err.message)}</div>`;
  }
}

// ─── Digest ──────────────────────────────────────────────────────────────────

export async function openInitiativeDigest() {
  const modal = document.getElementById('initiative-digest-modal');
  const body = document.getElementById('initiative-digest-body');
  modal.style.display = 'flex';
  body.innerHTML = '<div class="drawer-loading">Building digest…</div>';

  try {
    const since = new Date(Date.now() - 16 * 3600 * 1000).toISOString();
    const data = await api('GET', `/api/initiatives/digest?since=${encodeURIComponent(since)}`);
    if (!data.items.length) {
      body.innerHTML = '<div class="drawer-empty">Nothing moved since last night.</div>';
      return;
    }
    body.innerHTML = `
      <div class="digest-totals">
        <span><strong>${data.totals.stages}</strong> stages completed</span>
        <span><strong>${data.totals.autoApprovals}</strong> prompts auto-approved</span>
        <span><strong>${data.totals.nudges}</strong> nudges</span>
        <span><strong>${data.totals.openGates}</strong> waiting on you</span>
      </div>
      ${data.items.map(item => `<div class="digest-item">
        <div class="digest-item-head">
          <span class="initiative-status initiative-status-${escAttr(item.status)}">${escHtml(STATUS_LABELS[item.status] || item.status)}</span>
          <strong>${escHtml(item.name)}</strong>
          <span class="digest-stage">${escHtml(item.stage || '')}</span>
        </div>
        ${item.stagesCompleted.length ? `<div class="digest-line">Completed: ${escHtml(item.stagesCompleted.join(', '))}</div>` : ''}
        ${item.repo ? `<div class="digest-line">${escHtml(item.repo.branch)} · ${item.repo.commitsAhead} commit(s) ahead · ${item.repo.changedFiles} uncommitted file(s)${item.repo.lastCommit ? ` · last: ${escHtml(item.repo.lastCommit)}` : ''}</div>` : ''}
        <div class="digest-line digest-muted">${item.autoApprovals} auto-approved · ${item.nudges} nudges · ${item.autoDecided} auto-decided</div>
        ${item.openGates.map(g => `<div class="digest-gate">Waiting: ${escHtml(g.question)}</div>`).join('')}
      </div>`).join('')}
    `;
  } catch (err) {
    body.innerHTML = `<div class="drawer-empty" style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tildefy(p) {
  return String(p || '').replace(/^\/Users\/[^/]+/, '~');
}

function shortTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}
