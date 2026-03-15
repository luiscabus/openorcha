import { toast, escHtml, escAttr, closeModal } from '../utils.js';

const STORAGE_KEY = 'ssh-manager.ai-agents.todo';
const STORAGE_VERSION = 3;
const UNGROUPED_ID = '__ungrouped__';
const TODO_STATUSES = [
  { id: 'todo', label: 'To Do' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'done', label: 'Done' },
];

let groups = [];
let todos = [];
let currentFilter = 'all';
let pendingBulkTodos = [];
let draggedTodoId = null;
let editingTodoId = null;

function normalizeGroupId(groupId) {
  return !groupId || groupId === UNGROUPED_ID ? null : groupId;
}

function normalizeStatus(status, completed = false) {
  if (TODO_STATUSES.some(item => item.id === status)) return status;
  return completed ? 'done' : 'todo';
}

function syncTodo(todo) {
  const status = normalizeStatus(todo.status, todo.completed);
  return {
    ...todo,
    groupId: normalizeGroupId(todo.groupId),
    status,
    completed: status === 'done',
  };
}

function createId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTodo(text, groupId = null) {
  return syncTodo({
    id: createId('todo'),
    text,
    groupId,
    status: 'todo',
    completed: false,
    createdAt: new Date().toISOString(),
  });
}

function createGroup(name) {
  return {
    id: createId('group'),
    name,
    createdAt: new Date().toISOString(),
  };
}

function readState() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');

    if (Array.isArray(parsed)) {
      return {
        groups: [],
        todos: parsed.map(syncTodo),
      };
    }

    if (parsed && Array.isArray(parsed.todos) && Array.isArray(parsed.groups)) {
      return {
        groups: parsed.groups,
        todos: parsed.todos.map(syncTodo),
      };
    }
  } catch {}

  return { groups: [], todos: [] };
}

function persistState() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
    version: STORAGE_VERSION,
    groups,
    todos,
  }));
}

function getSelectedGroupId() {
  const select = document.getElementById('todo-group-select');
  return normalizeGroupId(select?.value || null);
}

function parsePastedTodos(text) {
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
}

function filteredTodos(items) {
  if (currentFilter === 'open') return items.filter(todo => todo.status !== 'done');
  if (currentFilter === 'done') return items.filter(todo => todo.status === 'done');
  return items;
}

function getGroupName(groupId) {
  if (!groupId) return 'Ungrouped';
  return groups.find(group => group.id === groupId)?.name || 'Ungrouped';
}

function updateCount() {
  const count = document.getElementById('todo-count');
  if (!count) return;
  const open = todos.filter(todo => todo.status !== 'done').length;
  const done = todos.filter(todo => todo.status === 'done').length;
  const grouped = todos.filter(todo => todo.groupId).length;
  count.textContent = `${open} open • ${done} done • ${groups.length} groups • ${grouped} grouped`;
}

function renderFilterState() {
  document.querySelectorAll('.todo-actions [data-filter]').forEach(button => {
    button.classList.toggle('todo-filter-active', button.dataset.filter === currentFilter);
  });
}

function renderGroupSelect() {
  const select = document.getElementById('todo-group-select');
  if (!select) return;

  const selected = select.value || UNGROUPED_ID;
  select.innerHTML = `
    <option value="${UNGROUPED_ID}">Ungrouped</option>
    ${groups.map(group => `<option value="${escAttr(group.id)}">${escHtml(group.name)}</option>`).join('')}
  `;
  select.value = groups.some(group => group.id === selected) ? selected : UNGROUPED_ID;
}

function renderBulkModal() {
  const list = document.getElementById('todo-bulk-list');
  if (!list) return;

  list.innerHTML = pendingBulkTodos.map((text, index) => `
    <label class="todo-bulk-item">
      <input type="checkbox" data-bulk-index="${index}" checked onchange="syncBulkTodoSelection()" />
      <span class="todo-bulk-copy">${escHtml(text)}</span>
    </label>
  `).join('');
  updateBulkSelectAllState();
}

function updateBulkSelectAllState() {
  const toggle = document.getElementById('todo-bulk-select-all');
  if (!toggle) return;
  const checkboxes = Array.from(document.querySelectorAll('.todo-bulk-item input[type="checkbox"]'));
  toggle.checked = checkboxes.length > 0 && checkboxes.every(input => input.checked);
}

function openBulkModal(items) {
  pendingBulkTodos = items;
  renderBulkModal();
  document.getElementById('todo-bulk-modal').style.display = 'flex';
}

function renderAll() {
  renderTodos();
  renderKanban();
}

function addTodoItems(items, groupId = null) {
  if (!items.length) return;
  todos = items.map(text => createTodo(text, groupId)).concat(todos);
  persistState();
  renderAll();
}

function renderEmptyState(message, detail = '') {
  return `<div class="empty-state">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
    <p>${escHtml(message)}</p>
    ${detail ? `<small>${escHtml(detail)}</small>` : ''}
  </div>`;
}

function renderStatusSelect(todo) {
  return `
    <select class="todo-status-select" onchange="setTodoStatus('${escAttr(todo.id)}', this.value)">
      ${TODO_STATUSES.map(status => `<option value="${status.id}" ${status.id === todo.status ? 'selected' : ''}>${status.label}</option>`).join('')}
    </select>
  `;
}

function renderGroupSection(id, name, items, isUngrouped = false) {
  const visible = filteredTodos(items);
  const hasVisible = visible.length > 0;

  return `
    <section class="todo-group-section" data-group-id="${escAttr(id)}" ondragover="handleTodoGroupDragOver(event, '${escAttr(id)}')" ondragleave="handleTodoGroupDragLeave(event)" ondrop="handleTodoGroupDrop(event, '${escAttr(id)}')">
      <div class="todo-group-header">
        <div>
          <div class="todo-group-title">${escHtml(name)}</div>
          <div class="todo-group-meta">${items.length} total • ${items.filter(todo => todo.status !== 'done').length} open</div>
        </div>
        <div class="todo-group-actions">
          ${isUngrouped ? '' : `<button class="btn btn-ghost btn-sm btn-icon todo-group-delete" onclick="deleteTodoGroup('${escAttr(id)}')" title="Delete group">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          </button>`}
        </div>
      </div>
      <div class="todo-group-dropnote">Drag a task here to move it${isUngrouped ? ' out of any group' : ''}.</div>
      <div class="todo-group-items">
        ${hasVisible ? visible.map(todo => `
          <div class="todo-item${todo.completed ? ' is-complete' : ''}" draggable="true" ondragstart="startTodoDrag(event, '${escAttr(todo.id)}')" ondragend="endTodoDrag()">
            <label class="todo-check">
              <input type="checkbox" ${todo.completed ? 'checked' : ''} onchange="toggleTodo('${escAttr(todo.id)}')" />
              <span></span>
            </label>
            <div class="todo-copy">
              ${editingTodoId === todo.id ? `
                <form class="todo-edit-form" onsubmit="saveTodoEdit(event, '${escAttr(todo.id)}')">
                  <input type="text" id="todo-edit-input-${escAttr(todo.id)}" class="todo-edit-input" value="${escAttr(todo.text)}" maxlength="160" />
                  <div class="todo-edit-actions">
                    <button type="submit" class="btn btn-ghost btn-sm">Save</button>
                    <button type="button" class="btn btn-ghost btn-sm" onclick="cancelTodoEdit()">Cancel</button>
                  </div>
                </form>
              ` : `<div class="todo-text">${escHtml(todo.text)}</div>`}
            </div>
            ${renderStatusSelect(todo)}
            ${editingTodoId === todo.id ? '' : `<button class="btn btn-ghost btn-sm btn-icon" onclick="startTodoEdit('${escAttr(todo.id)}')" title="Edit todo">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>
            </button>`}
            <button class="btn btn-ghost btn-sm btn-icon todo-delete" onclick="deleteTodo('${escAttr(todo.id)}')" title="Delete todo">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
            </button>
          </div>
        `).join('') : `<div class="todo-group-empty">${items.length ? 'No tasks match the current filter.' : 'No tasks in this group yet.'}</div>`}
      </div>
    </section>
  `;
}

function renderKanbanColumn(status) {
  const items = todos.filter(todo => todo.status === status.id);
  return `
    <section class="kanban-column" data-status-id="${status.id}" ondragover="handleKanbanStatusDragOver(event, '${status.id}')" ondragleave="handleKanbanStatusDragLeave(event)" ondrop="handleKanbanStatusDrop(event, '${status.id}')">
      <div class="kanban-column-header">
        <div class="kanban-column-title">${status.label}</div>
        <div class="kanban-column-count">${items.length}</div>
      </div>
      <div class="kanban-column-body">
        ${items.length ? items.map(todo => `
          <article class="kanban-card" draggable="true" ondragstart="startTodoDrag(event, '${escAttr(todo.id)}')" ondragend="endTodoDrag()">
            <div class="kanban-card-text">${escHtml(todo.text)}</div>
            <div class="kanban-card-meta">
              <span class="kanban-card-group">${escHtml(getGroupName(todo.groupId))}</span>
              ${renderStatusSelect(todo)}
            </div>
          </article>
        `).join('') : `<div class="kanban-empty">Drop a todo here.</div>`}
      </div>
    </section>
  `;
}

export function renderTodos() {
  const list = document.getElementById('todo-list');
  if (!list) return;

  updateCount();
  renderFilterState();
  renderGroupSelect();

  if (!todos.length && !groups.length) {
    list.innerHTML = renderEmptyState('No todos yet', 'Add a task, create a group, or paste multiple lines.');
    return;
  }

  const sections = [];
  const ungroupedTodos = todos.filter(todo => !todo.groupId);
  sections.push(renderGroupSection(UNGROUPED_ID, 'Ungrouped', ungroupedTodos, true));

  groups.forEach(group => {
    sections.push(renderGroupSection(group.id, group.name, todos.filter(todo => todo.groupId === group.id)));
  });

  list.innerHTML = sections.join('');
}

export function renderKanban() {
  const board = document.getElementById('kanban-board');
  if (!board) return;

  if (!todos.length) {
    board.innerHTML = renderEmptyState('No todos yet', 'Todos added in the Todo view will appear here automatically.');
    return;
  }

  board.innerHTML = TODO_STATUSES.map(renderKanbanColumn).join('');
}

export function loadTodos() {
  const state = readState();
  groups = state.groups;
  todos = state.todos;
  persistState();
  renderAll();
}

export function loadKanban() {
  loadTodos();
}

export function addTodo(event) {
  event.preventDefault();
  const input = document.getElementById('todo-input');
  const text = input.value.trim();
  if (!text) return;

  addTodoItems([text], getSelectedGroupId());
  input.value = '';
  input.focus();
}

export function addTodoGroup(event) {
  event.preventDefault();
  const input = document.getElementById('todo-group-input');
  const name = input.value.trim();
  if (!name) return;

  groups.push(createGroup(name));
  persistState();
  renderAll();
  document.getElementById('todo-group-select').value = groups[groups.length - 1].id;
  input.value = '';
  toast(`Group "${name}" created`);
}

export function deleteTodoGroup(groupId) {
  const group = groups.find(item => item.id === groupId);
  if (!group) return;
  if (!window.confirm(`Delete group "${group.name}"? Tasks will be moved to Ungrouped.`)) return;

  groups = groups.filter(item => item.id !== groupId);
  todos = todos.map(todo => todo.groupId === groupId ? { ...todo, groupId: null } : todo);
  persistState();
  renderAll();
}

export function handleTodoPaste(event) {
  const pastedText = event.clipboardData?.getData('text') || '';
  const parsed = parsePastedTodos(pastedText);
  if (parsed.length <= 1) return;

  event.preventDefault();
  openBulkModal(parsed);
}

export function confirmBulkAddTodos(event) {
  event.preventDefault();
  const selected = Array.from(document.querySelectorAll('.todo-bulk-item input[type="checkbox"]:checked'))
    .map(input => pendingBulkTodos[Number(input.dataset.bulkIndex)])
    .filter(Boolean);

  if (!selected.length) {
    toast('Select at least one todo', 'error');
    return;
  }

  addTodoItems(selected, getSelectedGroupId());
  pendingBulkTodos = [];
  closeModal('todo-bulk-modal');
  document.getElementById('todo-input').value = '';
  toast(`${selected.length} todos added`);
}

export function toggleAllBulkTodos(event) {
  const checked = event.target.checked;
  document.querySelectorAll('.todo-bulk-item input[type="checkbox"]').forEach(input => {
    input.checked = checked;
  });
}

export function syncBulkTodoSelection() {
  updateBulkSelectAllState();
}

export function setTodoStatus(id, status) {
  todos = todos.map(todo => todo.id === id ? syncTodo({ ...todo, status }) : todo);
  persistState();
  renderAll();
}

export function toggleTodo(id) {
  const todo = todos.find(item => item.id === id);
  if (!todo) return;
  setTodoStatus(id, todo.status === 'done' ? 'todo' : 'done');
}

export function startTodoEdit(id) {
  editingTodoId = id;
  renderTodos();
  const input = document.getElementById(`todo-edit-input-${id}`);
  if (input) {
    input.focus();
    input.select();
  }
}

export function cancelTodoEdit() {
  editingTodoId = null;
  renderTodos();
}

export function saveTodoEdit(event, id) {
  event.preventDefault();
  const input = document.getElementById(`todo-edit-input-${id}`);
  const text = input?.value.trim() || '';
  if (!text) {
    toast('Todo text cannot be empty', 'error');
    return;
  }

  todos = todos.map(todo => todo.id === id ? { ...todo, text } : todo);
  editingTodoId = null;
  persistState();
  renderAll();
}

export function deleteTodo(id) {
  const todo = todos.find(item => item.id === id);
  if (!todo) return;
  if (!window.confirm(`Delete todo "${todo.text}"?`)) return;
  if (editingTodoId === id) editingTodoId = null;
  todos = todos.filter(todo => todo.id !== id);
  persistState();
  renderAll();
}

export function clearCompletedTodos() {
  const before = todos.length;
  todos = todos.filter(todo => todo.status !== 'done');
  persistState();
  renderAll();
  if (before !== todos.length) toast('Completed todos cleared');
}

export function setTodoFilter(filter) {
  currentFilter = filter;
  renderTodos();
}

export function startTodoDrag(event, todoId) {
  draggedTodoId = todoId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', todoId);
}

export function endTodoDrag() {
  draggedTodoId = null;
  document.querySelectorAll('.todo-group-section').forEach(section => {
    section.classList.remove('is-drop-target');
  });
  document.querySelectorAll('.kanban-column').forEach(column => {
    column.classList.remove('is-drop-target');
  });
}

export function handleTodoGroupDragOver(event, groupId) {
  if (!draggedTodoId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.todo-group-section').forEach(section => {
    section.classList.toggle('is-drop-target', section.dataset.groupId === groupId);
  });
}

export function handleTodoGroupDragLeave(event) {
  const section = event.currentTarget;
  if (!section.contains(event.relatedTarget)) {
    section.classList.remove('is-drop-target');
  }
}

export function handleTodoGroupDrop(event, groupId) {
  event.preventDefault();
  const todoId = draggedTodoId || event.dataTransfer.getData('text/plain');
  const nextGroupId = normalizeGroupId(groupId);

  todos = todos.map(todo => todo.id === todoId ? { ...todo, groupId: nextGroupId } : todo);
  persistState();
  endTodoDrag();
  renderAll();
}

export function handleKanbanStatusDragOver(event, status) {
  if (!draggedTodoId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.kanban-column').forEach(column => {
    column.classList.toggle('is-drop-target', column.dataset.statusId === status);
  });
}

export function handleKanbanStatusDragLeave(event) {
  const column = event.currentTarget;
  if (!column.contains(event.relatedTarget)) {
    column.classList.remove('is-drop-target');
  }
}

export function handleKanbanStatusDrop(event, status) {
  event.preventDefault();
  const todoId = draggedTodoId || event.dataTransfer.getData('text/plain');
  setTodoStatus(todoId, status);
  endTodoDrag();
}
