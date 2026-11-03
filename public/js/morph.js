// Patches a live element to match freshly rendered markup, keeping the nodes
// that are already there.
//
// Replacing innerHTML throws away everything the browser was holding for you:
// focus, the caret, text typed but not yet saved, and the scroll position,
// because the content collapses for a frame. Morphing reuses every element
// that still has a counterpart, so a re-render only touches what changed.
//
// Children are matched by `data-key` where they carry one, otherwise by
// position and tag. The field you are typing in keeps its value.

export function morphInner(target, html) {
  const template = document.createElement('template');
  template.innerHTML = html;

  const active = document.activeElement;
  let selection = null;
  try {
    if (active && typeof active.selectionStart === 'number') selection = [active.selectionStart, active.selectionEnd];
  } catch {
    // Not a text field.
  }

  morphChildren(target, template.content);

  // Moving a node detaches it for a moment, which blurs it.
  if (active && active !== document.activeElement && active.isConnected && target.contains(active)) {
    active.focus({ preventScroll: true });
    if (selection) {
      try { active.setSelectionRange(...selection); } catch { /* not a text field */ }
    }
  }
}

function keyOf(node) {
  return node.nodeType === Node.ELEMENT_NODE ? node.getAttribute('data-key') : null;
}

function morphChildren(fromParent, toParent) {
  const keyed = new Map();
  for (const child of fromParent.children) {
    const key = keyOf(child);
    if (key) keyed.set(key, child);
  }

  // Everything before the cursor is settled; whatever is left from it onward
  // once the new children are placed has no counterpart and goes.
  let cursor = fromParent.firstChild;
  for (const next of [...toParent.childNodes]) {
    const key = keyOf(next);
    let match = null;
    if (key) {
      match = keyed.get(key) || null;
      keyed.delete(key);
    } else if (cursor && !keyOf(cursor) && cursor.nodeName === next.nodeName) {
      match = cursor;
    }

    if (!match) {
      fromParent.insertBefore(next, cursor);
      continue;
    }
    if (match === cursor) cursor = cursor.nextSibling;
    else fromParent.insertBefore(match, cursor);
    morphNode(match, next);
  }

  while (cursor) {
    const after = cursor.nextSibling;
    cursor.remove();
    cursor = after;
  }
}

function morphNode(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) {
    from.replaceWith(to);
    return;
  }
  if (from.nodeType !== Node.ELEMENT_NODE) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }

  syncAttributes(from, to);
  if (from.tagName === 'TEXTAREA') {
    syncValue(from, to.textContent);
    return;
  }
  if (from.tagName === 'INPUT') syncValue(from, to.getAttribute('value') ?? '');
  morphChildren(from, to);
}

function syncAttributes(from, to) {
  for (const { name } of [...from.attributes]) {
    // An inline style the markup never set is runtime state, like the height
    // a textarea was grown to, not content.
    if (!to.hasAttribute(name) && name !== 'style') from.removeAttribute(name);
  }
  for (const { name, value } of to.attributes) {
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
}

function syncValue(field, value) {
  if (field !== document.activeElement && field.value !== value) field.value = value;
}
